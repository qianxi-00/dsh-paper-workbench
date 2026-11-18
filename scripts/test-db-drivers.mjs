/**
 * lib/db-pg.js / lib/db-mysql.js / lib/db-backend.js 独立协议级自动化测试。
 *
 * 特点：
 *   - 全部在 %TEMP%\pb-db-drivers-* 下运行，绝不触碰 ~/.dsh/paper-workbench。
 *   - 使用 node:net 在 127.0.0.1:0 上构建真实协议级 Mock Server：
 *       1. Mock PostgreSQL v3（SSLRequest 'N' + StartupMessage + Trust/Cleartext/MD5/SCRAM-SHA-256 + Simple & Extended Query）
 *       2. Mock MySQL v10（Handshake v10 + mysql_native_password & caching_sha2_password fast/RSA公钥全认证 + COM_QUERY & COM_STMT_PREPARE/EXECUTE 二进制协议）
 *   - 覆盖：tablePrefix 注入拦截、各认证成功与错密码不泄密、SQL 注入往返、事务回滚、5 张表 CRUD、
 *           testConnection 成功/失败/超时分支、exportSnapshot/importSnapshot、
 *           SQLite <-> Mock PG <-> Mock MySQL <-> 新 SQLite 全量跨库 migrateTo 一致性。
 *
 * 运行：node scripts/test-db-drivers.mjs
 */
import crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// 必须在 import ./db.js / ./db-backend.js 前设置隔离数据目录
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-db-drivers-'))
process.env.DSH_PAPER_WORKBENCH_DATA = path.join(tmpRoot, 'data')
process.env.PB_DB_PATH = path.join(tmpRoot, 'source.db')

const dbMod = await import('../lib/db.js')
const { createPgClient } = await import('../lib/db-pg.js')
const { createMysqlClient } = await import('../lib/db-mysql.js')
const { createDbBackend, validateTablePrefix } = await import('../lib/db-backend.js')

let passed = 0
let failed = 0

function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
}

function eq(actual, expected, msg) {
  if (!deepEqual(actual, expected)) {
    throw new Error((msg ? msg + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
  }
}

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + (error && error.stack ? error.stack : String(error)))
  }
}

/* ================================================================== 轻量 SQL 内存引擎（供 PG/MySQL Mock 共用） */

class InMemorySqlEngine {
  constructor({ allowCreateTable = true } = {}) {
    this.tables = new Map()
    this.txSnapshot = null
    this.allowCreateTable = allowCreateTable
  }

  _cloneTables() {
    const copy = new Map()
    for (const [k, tbl] of this.tables.entries()) {
      copy.set(k, {
        nextSeq: tbl.nextSeq,
        rows: tbl.rows.map((r) => ({ ...r })),
      })
    }
    return copy
  }

  _stripQuotes(ident) {
    return String(ident || '').trim().replace(/^["`]|["`]$/g, '')
  }

  _splitTopLevel(str, delim = ',') {
    const out = []
    let cur = ''
    let depth = 0
    let inSingle = false
    for (let i = 0; i < str.length; i += 1) {
      const ch = str[i]
      if (inSingle) {
        cur += ch
        if (ch === "'" && str[i + 1] === "'") { cur += "'"; i += 1 }
        else if (ch === "'") inSingle = false
        continue
      }
      if (ch === "'") { inSingle = true; cur += ch; continue }
      if (ch === '(') { depth += 1; cur += ch; continue }
      if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue }
      if (depth === 0 && ch === delim) {
        out.push(cur.trim())
        cur = ''
        continue
      }
      cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }

  _splitTopLevelKeywords(str) {
    const out = []
    let cur = ''
    let depth = 0
    let inSingle = false
    for (let i = 0; i < str.length; i += 1) {
      const ch = str[i]
      if (inSingle) {
        cur += ch
        if (ch === "'" && str[i + 1] === "'") { cur += "'"; i += 1 }
        else if (ch === "'") inSingle = false
        continue
      }
      if (ch === "'") { inSingle = true; cur += ch; continue }
      if (ch === '(') { depth += 1; cur += ch; continue }
      if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue }
      if (depth === 0 && ch === ';') {
        if (cur.trim()) out.push(cur.trim())
        cur = ''
        continue
      }
      cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }

  execute(sqlRaw, params = []) {
    const statements = this._splitTopLevelKeywords(sqlRaw)
    let lastResult = { columns: [], rows: [], rowCount: 0, insertId: 0, command: 'OK' }
    for (const stmt of statements) {
      lastResult = this._execSingle(stmt, params)
    }
    return lastResult
  }

  _execSingle(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    const upper = normalized.toUpperCase()

    if (upper === 'BEGIN' || upper === 'START TRANSACTION') {
      this.txSnapshot = this._cloneTables()
      return { columns: [], rows: [], rowCount: 0, insertId: 0, command: 'BEGIN' }
    }
    if (upper === 'COMMIT') {
      this.txSnapshot = null
      return { columns: [], rows: [], rowCount: 0, insertId: 0, command: 'COMMIT' }
    }
    if (upper === 'ROLLBACK') {
      if (this.txSnapshot) {
        this.tables = this.txSnapshot
        this.txSnapshot = null
      }
      return { columns: [], rows: [], rowCount: 0, insertId: 0, command: 'ROLLBACK' }
    }
    if (/^SAVEPOINT\b/i.test(normalized) || /^RELEASE SAVEPOINT\b/i.test(normalized) || /^ROLLBACK TO SAVEPOINT\b/i.test(normalized)) {
      return { columns: [], rows: [], rowCount: 0, insertId: 0, command: 'SAVEPOINT' }
    }
    if (/^SELECT 1(\s+AS\s+\w+)?$/i.test(normalized)) {
      return { columns: [{ name: 'ok', type: 'int' }], rows: [{ ok: 1 }], rowCount: 1, insertId: 0, command: 'SELECT' }
    }

    // CREATE TABLE
    const createMatch = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i.exec(normalized)
    if (createMatch) {
      if (!this.allowCreateTable) {
        const err = new Error('permission denied for schema public')
        err.pgCode = '42501'
        err.mysqlErrno = 1142
        throw err
      }
      const tblName = this._stripQuotes(createMatch[1])
      if (!this.tables.has(tblName)) {
        this.tables.set(tblName, { nextSeq: 1, rows: [] })
      }
      return { columns: [], rows: [], rowCount: 0, insertId: 0, command: 'CREATE' }
    }
    if (/^CREATE\s+INDEX\b/i.test(normalized)) {
      return { columns: [], rows: [], rowCount: 0, insertId: 0, command: 'CREATE' }
    }
    const dropMatch = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i.exec(normalized)
    if (dropMatch) {
      const tblName = this._stripQuotes(dropMatch[1])
      this.tables.delete(tblName)
      return { columns: [], rows: [], rowCount: 0, insertId: 0, command: 'DROP' }
    }

    // information_schema.tables
    if (/FROM\s+information_schema\.tables/i.test(normalized)) {
      const inMatch = /table_name\s+IN\s*\(([^)]+)\)/i.exec(normalized)
      let pIdx = 0
      const wanted = new Set()
      if (inMatch) {
        for (const tok of inMatch[1].split(',')) {
          const t = tok.trim()
          if (t === '?' || t.startsWith('$')) {
            const idx = t === '?' ? pIdx++ : Number(t.slice(1)) - 1
            wanted.add(String(params[idx]))
          } else {
            wanted.add(t.replace(/^'|'$/g, ''))
          }
        }
      }
      const rows = [...this.tables.keys()]
        .filter((name) => wanted.size === 0 || wanted.has(name))
        .map((name) => ({ table_name: name }))
      return { columns: [{ name: 'table_name', type: 'text' }], rows, rowCount: rows.length, insertId: 0, command: 'SELECT' }
    }

    // SELECT COUNT(*) AS n FROM <table> [WHERE paper_id = ?]
    const countMatch = /^SELECT\s+COUNT\(\*\)\s+AS\s+(\w+)\s+FROM\s+([^\s]+)(?:\s+WHERE\s+paper_id\s*=\s*(\?|\$\d+))?$/i.exec(normalized)
    if (countMatch) {
      const alias = countMatch[1]
      const tblName = this._stripQuotes(countMatch[2])
      const tbl = this.tables.get(tblName)
      if (!tbl) {
        const err = new Error(`relation "${tblName}" does not exist`)
        err.pgCode = '42P01'
        err.mysqlErrno = 1146
        throw err
      }
      let cnt = tbl.rows.length
      if (countMatch[3]) {
        const pid = params[0]
        cnt = tbl.rows.filter((r) => r.paper_id === pid).length
      }
      return { columns: [{ name: alias, type: 'int8' }], rows: [{ [alias]: cnt }], rowCount: 1, insertId: 0, command: 'SELECT' }
    }

    // SELECT DISTINCT paper_id FROM (... UNION ...)
    if (/SELECT\s+DISTINCT\s+paper_id\s+FROM\s*\(/i.test(normalized)) {
      const set = new Set()
      const unionRe = /SELECT\s+paper_id\s+FROM\s+([^\s)]+)/gi
      let m
      while ((m = unionRe.exec(normalized)) !== null) {
        const tblName = this._stripQuotes(m[1])
        const tbl = this.tables.get(tblName)
        if (!tbl) continue
        for (const r of tbl.rows) {
          if (r.paper_id) set.add(r.paper_id)
        }
      }
      const rows = [...set].map((paper_id) => ({ paper_id }))
      return { columns: [{ name: 'paper_id', type: 'text' }], rows, rowCount: rows.length, insertId: 0, command: 'SELECT' }
    }

    // INSERT INTO <table> (<cols>) VALUES ...
    const insMatch = /^INSERT\s+INTO\s+([^\s(]+)\s*\(([^)]+)\)\s*VALUES\s*(.+)$/i.exec(normalized)
    if (insMatch) {
      const tblName = this._stripQuotes(insMatch[1])
      const tbl = this.tables.get(tblName)
      if (!tbl) {
        const err = new Error(`table "${tblName}" does not exist`)
        err.pgCode = '42P01'
        err.mysqlErrno = 1146
        throw err
      }
      const cols = insMatch[2].split(',').map((c) => this._stripQuotes(c))
      let rest = insMatch[3]
      const hasReturningSeq = /\bRETURNING\s+seq$/i.test(rest)
      rest = rest.replace(/\bRETURNING\s+seq$/i, '').trim()
      const onConflictIdx = rest.search(/\bON\s+(?:CONFLICT|DUPLICATE\s+KEY\s+UPDATE)\b/i)
      const valuesPart = (onConflictIdx >= 0 ? rest.slice(0, onConflictIdx) : rest).trim()
      const isUpsert = onConflictIdx >= 0

      // 解析每组 (...) 值占位符
      const tuples = this._splitTopLevel(valuesPart, ',')
      let pCursor = 0
      let affected = 0
      let lastInsertId = 0
      const returnedRows = []

      for (const tup of tuples) {
        const inner = tup.replace(/^\(/, '').replace(/\)$/, '')
        const tokens = this._splitTopLevel(inner, ',')
        const rowObj = {}
        for (let i = 0; i < cols.length; i += 1) {
          const tok = tokens[i]
          let val
          if (tok === '?') {
            val = params[pCursor++]
          } else if (/^\$\d+$/.test(tok)) {
            val = params[Number(tok.slice(1)) - 1]
          } else if (tok === 'NULL') {
            val = null
          } else {
            val = tok.replace(/^'|'$/g, '')
          }
          rowObj[cols[i]] = val
        }

        const baseName = this._baseTableName(tblName)
        if (baseName === 'job_events') {
          rowObj.seq = tbl.nextSeq++
          tbl.rows.push(rowObj)
          lastInsertId = rowObj.seq
          affected += 1
          if (hasReturningSeq) returnedRows.push({ seq: rowObj.seq })
        } else if (baseName === 'translations') {
          const idx = tbl.rows.findIndex(
            (r) => r.paper_id === rowObj.paper_id && r.target === rowObj.target && r.key === rowObj.key,
          )
          if (idx >= 0) {
            if (!isUpsert) throw Object.assign(new Error('duplicate key'), { pgCode: '23505', mysqlErrno: 1062 })
            tbl.rows[idx] = { ...tbl.rows[idx], ...rowObj }
          } else {
            tbl.rows.push(rowObj)
          }
          affected += 1
        } else if (baseName === 'reviews') {
          const idx = tbl.rows.findIndex((r) => r.paper_id === rowObj.paper_id)
          if (idx >= 0) {
            if (!isUpsert) throw Object.assign(new Error('duplicate key'), { pgCode: '23505', mysqlErrno: 1062 })
            tbl.rows[idx] = { ...tbl.rows[idx], ...rowObj }
          } else {
            tbl.rows.push(rowObj)
          }
          affected += 1
        } else if (baseName === 'annotations' || baseName === 'study_notes') {
          const idx = tbl.rows.findIndex((r) => r.paper_id === rowObj.paper_id && r.id === rowObj.id)
          if (idx >= 0) {
            if (!isUpsert) throw Object.assign(new Error('duplicate key'), { pgCode: '23505', mysqlErrno: 1062 })
            // 注意：与真库一致，ON CONFLICT DO UPDATE 不覆盖 created_at
            const keepCreatedAt = tbl.rows[idx].created_at
            tbl.rows[idx] = { ...tbl.rows[idx], ...rowObj, created_at: keepCreatedAt }
          } else {
            tbl.rows.push(rowObj)
          }
          affected += 1
        }
      }

      return {
        columns: hasReturningSeq ? [{ name: 'seq', type: 'int8' }] : [],
        rows: returnedRows,
        rowCount: affected,
        insertId: lastInsertId,
        command: 'INSERT',
      }
    }

    // SELECT <cols> FROM <table> WHERE ...
    const selMatch = /^SELECT\s+(.+?)\s+FROM\s+([^\s]+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\?|\$\d+|\d+))?$/i.exec(normalized)
    if (selMatch) {
      const selCols = selMatch[1].split(',').map((c) => this._stripQuotes(c))
      const tblName = this._stripQuotes(selMatch[2])
      const tbl = this.tables.get(tblName)
      if (!tbl) {
        const err = new Error(`relation "${tblName}" does not exist`)
        err.pgCode = '42P01'
        err.mysqlErrno = 1146
        throw err
      }
      let pIdx = 0
      let rows = tbl.rows.slice()
      const wherePart = selMatch[3] || ''
      if (wherePart) {
        const conds = wherePart.split(/\s+AND\s+/i)
        for (const cond of conds) {
          const mEq = /^([^\s=]+)\s*=\s*(\?|\$\d+)$/i.exec(cond.trim())
          const mGt = /^([^\s>]+)\s*>\s*(\?|\$\d+)$/i.exec(cond.trim())
          if (mEq) {
            const col = this._stripQuotes(mEq[1])
            const val = mEq[2] === '?' ? params[pIdx++] : params[Number(mEq[2].slice(1)) - 1]
            rows = rows.filter((r) => r[col] === val)
          } else if (mGt) {
            const col = this._stripQuotes(mGt[1])
            const val = mGt[2] === '?' ? params[pIdx++] : params[Number(mGt[2].slice(1)) - 1]
            rows = rows.filter((r) => Number(r[col]) > Number(val))
          }
        }
      }
      if (selMatch[4]) {
        const orders = selMatch[4].split(',').map((o) => {
          const parts = o.trim().split(/\s+/)
          return { col: this._stripQuotes(parts[0]), desc: (parts[1] || '').toUpperCase() === 'DESC' }
        })
        rows.sort((a, b) => {
          for (const { col, desc } of orders) {
            const va = a[col]
            const vb = b[col]
            let cmp = 0
            if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
            else cmp = String(va ?? '') < String(vb ?? '') ? -1 : String(va ?? '') > String(vb ?? '') ? 1 : 0
            if (cmp !== 0) return desc ? -cmp : cmp
          }
          return 0
        })
      }
      if (selMatch[5]) {
        const tok = selMatch[5]
        const lim = tok === '?' ? Number(params[pIdx++]) : tok.startsWith('$') ? Number(params[Number(tok.slice(1)) - 1]) : Number(tok)
        rows = rows.slice(0, Math.max(0, lim))
      }

      const projected = rows.map((r) => {
        const out = {}
        for (const col of selCols) out[col] = r[col] ?? null
        return out
      })
      const columns = selCols.map((name) => ({
        name,
        type: (name === 'seq' || name === 'start_offset' || name === 'end_offset' || name === 'page') ? 'int' : 'text',
      }))
      return { columns, rows: projected, rowCount: projected.length, insertId: 0, command: 'SELECT' }
    }

    // DELETE FROM <table> WHERE ...
    const delMatch = /^DELETE\s+FROM\s+([^\s]+)\s+WHERE\s+(.+)$/i.exec(normalized)
    if (delMatch) {
      const tblName = this._stripQuotes(delMatch[1])
      const tbl = this.tables.get(tblName)
      if (!tbl) {
        const err = new Error(`relation "${tblName}" does not exist`)
        err.pgCode = '42P01'
        err.mysqlErrno = 1146
        throw err
      }
      const wherePart = delMatch[2]
      const conds = wherePart.split(/\s+AND\s+/i)
      let pIdx = 0
      const filters = []
      for (const cond of conds) {
        const mEq = /^([^\s=]+)\s*=\s*(\?|\$\d+)$/i.exec(cond.trim())
        const mIn = /^([^\s]+)\s+IN\s*\(([^)]+)\)$/i.exec(cond.trim())
        if (mEq) {
          const col = this._stripQuotes(mEq[1])
          const val = mEq[2] === '?' ? params[pIdx++] : params[Number(mEq[2].slice(1)) - 1]
          filters.push((r) => r[col] === val)
        } else if (mIn) {
          const col = this._stripQuotes(mIn[1])
          const set = new Set()
          for (const tok of mIn[2].split(',')) {
            const t = tok.trim()
            set.add(t === '?' ? params[pIdx++] : params[Number(t.slice(1)) - 1])
          }
          filters.push((r) => set.has(r[col]))
        }
      }
      const before = tbl.rows.length
      tbl.rows = tbl.rows.filter((r) => !filters.every((fn) => fn(r)))
      const deleted = before - tbl.rows.length
      return { columns: [], rows: [], rowCount: deleted, insertId: 0, command: 'DELETE' }
    }

    throw new Error('Mock SQL 引擎暂不支持的语句：' + normalized)
  }

  _baseTableName(tblName) {
    for (const base of ['translations', 'job_events', 'reviews', 'annotations', 'study_notes']) {
      if (tblName.endsWith(base)) return base
    }
    return tblName
  }
}

/* ================================================================== Mock PostgreSQL v3 Server */

function pgMsg(typeChar, body) {
  const out = Buffer.allocUnsafe(5 + body.length)
  out[0] = typeChar.charCodeAt(0)
  out.writeInt32BE(4 + body.length, 1)
  body.copy(out, 5)
  return out
}

function pgErrorPacket(code, msg) {
  const body = Buffer.concat([
    Buffer.from('SERROR\0', 'utf8'),
    Buffer.from('C' + code + '\0', 'utf8'),
    Buffer.from('M' + msg + '\0', 'utf8'),
    Buffer.from([0]),
  ])
  return pgMsg('E', body)
}

function pgAuthInt(code, extra = Buffer.alloc(0)) {
  const b = Buffer.allocUnsafe(4 + extra.length)
  b.writeInt32BE(code, 0)
  extra.copy(b, 4)
  return pgMsg('R', b)
}

function pgRowDesc(columns) {
  const parts = [Buffer.allocUnsafe(2)]
  parts[0].writeInt16BE(columns.length, 0)
  for (const col of columns) {
    const oid = col.type === 'int8' ? 20 : col.type === 'int' ? 23 : 25
    const fixed = Buffer.allocUnsafe(18)
    fixed.writeInt32BE(0, 0)
    fixed.writeInt16BE(0, 4)
    fixed.writeInt32BE(oid, 6)
    fixed.writeInt16BE(oid === 25 ? -1 : 8, 10)
    fixed.writeInt32BE(-1, 12)
    fixed.writeInt16BE(0, 16)
    parts.push(Buffer.from(col.name + '\0', 'utf8'), fixed)
  }
  return pgMsg('T', Buffer.concat(parts))
}

function pgDataRow(row, columns) {
  const parts = [Buffer.allocUnsafe(2)]
  parts[0].writeInt16BE(columns.length, 0)
  for (const col of columns) {
    const v = row[col.name]
    if (v === null || v === undefined) {
      const b = Buffer.allocUnsafe(4)
      b.writeInt32BE(-1, 0)
      parts.push(b)
    } else {
      const data = Buffer.from(String(v), 'utf8')
      const b = Buffer.allocUnsafe(4)
      b.writeInt32BE(data.length, 0)
      parts.push(b, data)
    }
  }
  return pgMsg('D', Buffer.concat(parts))
}

function startMockPgServer({
  user = 'postgres',
  password = 'secret-pg-password',
  authMode = 'scram-sha-256',
  allowCreateTable = true,
  hangHandshake = false,
} = {}) {
  const engine = new InMemorySqlEngine({ allowCreateTable })
  const sockets = new Set()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    if (hangHandshake) return

    let rx = Buffer.alloc(0)
    let phase = 'startup' // startup | auth | ready
    let md5Salt = null
    let scramCtx = null
    let preparedSql = ''
    let boundParams = []
    let inTx = false

    const readyByte = () => Buffer.from(inTx ? 'T' : 'I')

    const sendQueryResult = (res) => {
      const frames = []
      if (res.columns.length > 0) {
        frames.push(pgRowDesc(res.columns))
        for (const r of res.rows) frames.push(pgDataRow(r, res.columns))
      }
      const tag = res.command === 'INSERT'
        ? `INSERT 0 ${res.rowCount}`
        : (res.command === 'SELECT' || res.command === 'DELETE' || res.command === 'UPDATE')
          ? `${res.command} ${res.rowCount}`
          : res.command || 'OK'
      frames.push(pgMsg('C', Buffer.from(tag + '\0', 'utf8')))
      return Buffer.concat(frames)
    }

    socket.on('data', (chunk) => {
      rx = Buffer.concat([rx, chunk])
      while (true) {
        if (phase === 'startup') {
          if (rx.length < 4) return
          const len = rx.readInt32BE(0)
          if (rx.length < len) return
          const body = rx.subarray(4, len)
          rx = rx.subarray(len)
          const code = body.readInt32BE(0)
          if (code === 80877103) {
            socket.write('N')
            continue
          }
          if (code === 196608) {
            // 读取启动参数
            phase = 'auth'
            if (authMode === 'trust') {
              socket.write(Buffer.concat([
                pgAuthInt(0),
                pgMsg('S', Buffer.from('server_version\u000016.4-mock\u0000', 'utf8')),
                pgMsg('K', Buffer.from([0, 0, 0, 1, 0, 0, 0, 2])),
                pgMsg('Z', readyByte()),
              ]))
              phase = 'ready'
            } else if (authMode === 'cleartext') {
              socket.write(pgAuthInt(3))
            } else if (authMode === 'md5') {
              md5Salt = crypto.randomBytes(4)
              socket.write(pgAuthInt(5, md5Salt))
            } else {
              socket.write(pgAuthInt(10, Buffer.from('SCRAM-SHA-256\0\0', 'utf8')))
            }
          }
          continue
        }

        if (rx.length < 5) return
        const type = String.fromCharCode(rx[0])
        const len = rx.readInt32BE(1)
        if (rx.length < 1 + len) return
        const payload = rx.subarray(5, 1 + len)
        rx = rx.subarray(1 + len)

        if (phase === 'auth') {
          if (type !== 'p') continue
          if (authMode === 'cleartext') {
            const got = payload.toString('utf8').replace(/\0+$/, '')
            if (got !== password) {
              socket.write(pgErrorPacket('28P01', 'password authentication failed'))
              socket.end()
              return
            }
          } else if (authMode === 'md5') {
            const got = payload.toString('utf8').replace(/\0+$/, '')
            const inner = crypto.createHash('md5').update(password + user).digest('hex')
            const exp = 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), md5Salt])).digest('hex')
            if (got !== exp) {
              socket.write(pgErrorPacket('28P01', 'md5 password authentication failed'))
              socket.end()
              return
            }
          } else {
            // SCRAM-SHA-256
            if (!scramCtx) {
              const nul = payload.indexOf(0)
              const msgLen = payload.readInt32BE(nul + 1)
              const clientFirst = payload.subarray(nul + 5, nul + 5 + msgLen).toString('utf8')
              const clientFirstBare = clientFirst.replace(/^n,,/, '')
              const cNonce = clientFirstBare.split(',').find((x) => x.startsWith('r=')).slice(2)
              const sNonce = cNonce + crypto.randomBytes(12).toString('hex')
              const salt = crypto.randomBytes(16)
              const saltB64 = salt.toString('base64')
              const iterations = 4096
              const serverFirst = `r=${sNonce},s=${saltB64},i=${iterations}`
              scramCtx = { clientFirstBare, serverFirst, sNonce, salt, iterations }
              socket.write(pgAuthInt(11, Buffer.from(serverFirst, 'utf8')))
              continue
            } else {
              const clientFinal = payload.toString('utf8')
              const attrs = new Map(clientFinal.split(',').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
              const cFinalNoProof = `c=${attrs.get('c')},r=${attrs.get('r')}`
              const authMsg = `${scramCtx.clientFirstBare},${scramCtx.serverFirst},${cFinalNoProof}`
              const salted = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), scramCtx.salt, scramCtx.iterations, 32, 'sha256')
              const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest()
              const storedKey = crypto.createHash('sha256').update(clientKey).digest()
              const clientSig = crypto.createHmac('sha256', storedKey).update(authMsg).digest()
              const expectedProof = Buffer.allocUnsafe(32)
              for (let i = 0; i < 32; i += 1) expectedProof[i] = clientKey[i] ^ clientSig[i]
              const gotProof = Buffer.from(attrs.get('p') || '', 'base64')
              if (gotProof.length !== 32 || !crypto.timingSafeEqual(gotProof, expectedProof)) {
                socket.write(pgErrorPacket('28P01', 'scram authentication failed'))
                socket.end()
                return
              }
              const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest()
              const serverSig = crypto.createHmac('sha256', serverKey).update(authMsg).digest().toString('base64')
              socket.write(pgAuthInt(12, Buffer.from(`v=${serverSig}`, 'utf8')))
            }
          }
          phase = 'ready'
          socket.write(Buffer.concat([
            pgAuthInt(0),
            pgMsg('S', Buffer.from('server_version\u000016.4-mock\u0000', 'utf8')),
            pgMsg('K', Buffer.from([0, 0, 0, 1, 0, 0, 0, 2])),
            pgMsg('Z', readyByte()),
          ]))
          continue
        }

        // Ready phase
        if (type === 'X') {
          socket.end()
          return
        }
        if (type === 'Q') {
          const sql = payload.toString('utf8').replace(/\0+$/, '')
          try {
            const res = engine.execute(sql, [])
            if (res.command === 'BEGIN') inTx = true
            if (res.command === 'COMMIT' || res.command === 'ROLLBACK') inTx = false
            socket.write(Buffer.concat([sendQueryResult(res), pgMsg('Z', readyByte())]))
          } catch (err) {
            socket.write(Buffer.concat([pgErrorPacket(err.pgCode || '42000', err.message), pgMsg('Z', readyByte())]))
          }
          continue
        }
        if (type === 'P') {
          const sEnd = payload.indexOf(0)
          const qStart = sEnd + 1
          const qEnd = payload.indexOf(0, qStart)
          preparedSql = payload.subarray(qStart, qEnd).toString('utf8')
          socket.write(pgMsg('1', Buffer.alloc(0)))
          continue
        }
        if (type === 'B') {
          let pos = payload.indexOf(0) + 1
          pos = payload.indexOf(0, pos) + 1
          const fmtCount = payload.readInt16BE(pos); pos += 2
          const fmts = []
          for (let i = 0; i < fmtCount; i += 1) { fmts.push(payload.readInt16BE(pos)); pos += 2 }
          const valCount = payload.readInt16BE(pos); pos += 2
          boundParams = []
          for (let i = 0; i < valCount; i += 1) {
            const pLen = payload.readInt32BE(pos); pos += 4
            if (pLen === -1) {
              boundParams.push(null)
            } else {
              const bytes = payload.subarray(pos, pos + pLen)
              pos += pLen
              boundParams.push(fmts[i] === 1 ? Buffer.from(bytes) : bytes.toString('utf8'))
            }
          }
          socket.write(pgMsg('2', Buffer.alloc(0)))
          continue
        }
        if (type === 'E') {
          try {
            const res = engine.execute(preparedSql, boundParams)
            if (res.command === 'BEGIN') inTx = true
            if (res.command === 'COMMIT' || res.command === 'ROLLBACK') inTx = false
            socket.write(sendQueryResult(res))
          } catch (err) {
            socket.write(pgErrorPacket(err.pgCode || '42000', err.message))
          }
          continue
        }
        if (type === 'S') {
          socket.write(pgMsg('Z', readyByte()))
          continue
        }
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        port: addr.port,
        engine,
        async close() {
          for (const s of sockets) s.destroy()
          await new Promise((r) => server.close(r))
        },
      })
    })
  })
}

/* ================================================================== Mock MySQL v10 Server */

function mysqlFrame(payload, seqId) {
  const out = Buffer.allocUnsafe(4 + payload.length)
  out[0] = payload.length & 0xff
  out[1] = (payload.length >> 8) & 0xff
  out[2] = (payload.length >> 16) & 0xff
  out[3] = seqId & 0xff
  payload.copy(out, 4)
  return out
}

function mysqlLenEncInt(n) {
  if (n < 251) return Buffer.from([n])
  if (n < 65536) {
    const b = Buffer.allocUnsafe(3)
    b[0] = 0xfc; b.writeUInt16LE(n, 1); return b
  }
  const b = Buffer.allocUnsafe(4)
  b[0] = 0xfd; b[1] = n & 0xff; b[2] = (n >> 8) & 0xff; b[3] = (n >> 16) & 0xff
  return b
}

function mysqlLenEncStr(str) {
  const buf = Buffer.from(String(str), 'utf8')
  return Buffer.concat([mysqlLenEncInt(buf.length), buf])
}

function mysqlOk(affectedRows = 0, insertId = 0, seqId = 1) {
  const payload = Buffer.concat([
    Buffer.from([0x00]),
    mysqlLenEncInt(affectedRows),
    mysqlLenEncInt(insertId),
    Buffer.from([0x02, 0x00, 0x00, 0x00]),
  ])
  return mysqlFrame(payload, seqId)
}

function mysqlErr(errno, sqlState, message, seqId = 1) {
  const head = Buffer.allocUnsafe(3)
  head[0] = 0xff
  head.writeUInt16LE(errno, 1)
  const payload = Buffer.concat([
    head,
    Buffer.from('#' + sqlState.slice(0, 5).padEnd(5, '0'), 'ascii'),
    Buffer.from(message, 'utf8'),
  ])
  return mysqlFrame(payload, seqId)
}

function mysqlEof(seqId) {
  return mysqlFrame(Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]), seqId)
}

function mysqlColDef(name, typeCode, seqId) {
  const fixed = Buffer.allocUnsafe(13)
  fixed[0] = 0x0c
  fixed.writeUInt16LE(45, 1) // utf8mb4
  fixed.writeUInt32LE(255, 3)
  fixed[7] = typeCode
  fixed.writeUInt16LE(0, 8)
  fixed[10] = 0
  fixed[11] = 0
  fixed[12] = 0
  const payload = Buffer.concat([
    mysqlLenEncStr('def'),
    mysqlLenEncStr('paper_workbench'),
    mysqlLenEncStr('tbl'),
    mysqlLenEncStr('tbl'),
    mysqlLenEncStr(name),
    mysqlLenEncStr(name),
    fixed,
  ])
  return mysqlFrame(payload, seqId)
}

function readMysqlLenInt(buf, pos) {
  const f = buf[pos]
  if (f < 0xfb) return { v: f, next: pos + 1 }
  if (f === 0xfc) return { v: buf.readUInt16LE(pos + 1), next: pos + 3 }
  if (f === 0xfd) return { v: buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16), next: pos + 4 }
  return { v: Number(buf.readBigUInt64LE(pos + 1)), next: pos + 9 }
}

function startMockMysqlServer({
  password = 'secret-mysql-password',
  authPlugin = 'caching_sha2_password', // 'mysql_native_password' | 'caching_sha2_password'
  cachingSha2Mode = 'full', // 'fast' | 'full'
  allowCreateTable = true,
} = {}) {
  const engine = new InMemorySqlEngine({ allowCreateTable })
  const rsa = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const sockets = new Set()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))

    const scramble = crypto.randomBytes(20)
    const part1 = scramble.subarray(0, 8)
    const part2 = Buffer.concat([scramble.subarray(8, 20), Buffer.from([0])])
    const caps = 0x00000001 | 0x00000002 | 0x00000008 | 0x00000200 | 0x00002000 | 0x00008000 | 0x00020000 | 0x00080000 | 0x00200000
    const hsHead = Buffer.from([10])
    const hsVer = Buffer.from('8.0.36-mock\0', 'utf8')
    const hsMid = Buffer.alloc(18)
    hsMid.writeUInt32LE(1, 0)
    part1.copy(hsMid, 4)
    hsMid[12] = 0
    hsMid.writeUInt16LE(caps & 0xffff, 13)
    hsMid[15] = 45
    hsMid.writeUInt16LE(0x0002, 16)
    const hsMid2 = Buffer.alloc(13)
    hsMid2.writeUInt16LE((caps >>> 16) & 0xffff, 0)
    hsMid2[2] = 21
    // 10 zero bytes at offset 3..12
    const hsPayload = Buffer.concat([hsHead, hsVer, hsMid, hsMid2, part2, Buffer.from(authPlugin + '\0', 'utf8')])
    socket.write(mysqlFrame(hsPayload, 0))

    let rx = Buffer.alloc(0)
    let state = 'handshake' // handshake | wait_rsa_req | wait_rsa_cipher | ready
    let nextStmtId = 1
    const stmts = new Map()

    const verifyNative = (resp) => {
      const s1 = crypto.createHash('sha1').update(Buffer.from(password, 'utf8')).digest()
      const s2 = crypto.createHash('sha1').update(s1).digest()
      const ch = crypto.createHash('sha1').update(Buffer.concat([scramble, s2])).digest()
      const exp = Buffer.allocUnsafe(20)
      for (let i = 0; i < 20; i += 1) exp[i] = s1[i] ^ ch[i]
      return resp.length === exp.length && crypto.timingSafeEqual(resp, exp)
    }

    const verifyCachingSha2 = (resp) => {
      const s1 = crypto.createHash('sha256').update(Buffer.from(password, 'utf8')).digest()
      const s2 = crypto.createHash('sha256').update(s1).digest()
      const dig = crypto.createHash('sha256').update(Buffer.concat([s2, scramble])).digest()
      const exp = Buffer.allocUnsafe(32)
      for (let i = 0; i < 32; i += 1) exp[i] = s1[i] ^ dig[i]
      return resp.length === exp.length && crypto.timingSafeEqual(resp, exp)
    }

    const sendResultSet = (res, binary, seqStart = 1) => {
      let seq = seqStart
      if (res.columns.length === 0) {
        socket.write(mysqlOk(res.rowCount, res.insertId, seq))
        return
      }
      const frames = [mysqlFrame(mysqlLenEncInt(res.columns.length), seq++)]
      for (const col of res.columns) {
        const tc = col.type === 'int8' ? 0x08 : col.type === 'int' ? 0x03 : 0xfd
        frames.push(mysqlColDef(col.name, tc, seq++))
      }
      frames.push(mysqlEof(seq++))
      for (const row of res.rows) {
        if (!binary) {
          const cells = res.columns.map((c) => {
            const v = row[c.name]
            return v === null || v === undefined ? Buffer.from([0xfb]) : mysqlLenEncStr(String(v))
          })
          frames.push(mysqlFrame(Buffer.concat(cells), seq++))
        } else {
          const nullBitmapLen = Math.floor((res.columns.length + 9) / 8)
          const nullBitmap = Buffer.alloc(nullBitmapLen)
          const valParts = []
          for (let i = 0; i < res.columns.length; i += 1) {
            const c = res.columns[i]
            const v = row[c.name]
            if (v === null || v === undefined) {
              const bit = i + 2
              nullBitmap[bit >> 3] |= (1 << (bit & 7))
            } else if (c.type === 'int8') {
              const b = Buffer.allocUnsafe(8); b.writeBigInt64LE(BigInt(v), 0); valParts.push(b)
            } else if (c.type === 'int') {
              const b = Buffer.allocUnsafe(4); b.writeInt32LE(Number(v), 0); valParts.push(b)
            } else {
              valParts.push(mysqlLenEncStr(String(v)))
            }
          }
          frames.push(mysqlFrame(Buffer.concat([Buffer.from([0x00]), nullBitmap, ...valParts]), seq++))
        }
      }
      frames.push(mysqlEof(seq++))
      socket.write(Buffer.concat(frames))
    }

    socket.on('data', (chunk) => {
      if (state === 'closed' || socket.writableEnded) return
      rx = Buffer.concat([rx, chunk])
      while (rx.length >= 4) {
        if (state === 'closed' || socket.writableEnded) return
        const len = rx[0] | (rx[1] << 8) | (rx[2] << 16)
        const seq = rx[3]
        if (rx.length < 4 + len) return
        const payload = rx.subarray(4, 4 + len)
        rx = rx.subarray(4 + len)

        if (state === 'handshake') {
          let pos = 32
          const uEnd = payload.indexOf(0, pos)
          pos = uEnd + 1
          const authLenInfo = readMysqlLenInt(payload, pos)
          const authResp = payload.subarray(authLenInfo.next, authLenInfo.next + authLenInfo.v)

          if (authPlugin === 'mysql_native_password') {
            if (!verifyNative(authResp)) {
              state = 'closed'
              socket.write(mysqlErr(1045, '28000', 'Access denied', seq + 1))
              socket.end()
              return
            }
            state = 'ready'
            socket.write(mysqlOk(0, 0, seq + 1))
          } else {
            // caching_sha2_password
            if (!verifyCachingSha2(authResp)) {
              if (cachingSha2Mode === 'fast') {
                state = 'closed'
                socket.write(mysqlErr(1045, '28000', 'Access denied', seq + 1))
                socket.end()
                return
              }
            }
            if (cachingSha2Mode === 'fast') {
              state = 'ready'
              socket.write(Buffer.concat([
                mysqlFrame(Buffer.from([0x01, 0x03]), seq + 1),
                mysqlOk(0, 0, seq + 2),
              ]))
            } else {
              state = 'wait_rsa_req'
              socket.write(mysqlFrame(Buffer.from([0x01, 0x04]), seq + 1))
            }
          }
          continue
        }

        if (state === 'wait_rsa_req') {
          if (payload[0] !== 0x02) {
            state = 'closed'
            socket.write(mysqlErr(1045, '28000', 'Expected public key request', seq + 1))
            socket.end()
            return
          }
          state = 'wait_rsa_cipher'
          socket.write(mysqlFrame(Buffer.concat([Buffer.from([0x01]), Buffer.from(rsa.publicKey, 'utf8')]), seq + 1))
          continue
        }

        if (state === 'wait_rsa_cipher') {
          try {
            const decrypted = crypto.privateDecrypt(
              { key: rsa.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
              payload,
            )
            const plain = Buffer.allocUnsafe(decrypted.length)
            for (let i = 0; i < decrypted.length; i += 1) plain[i] = decrypted[i] ^ scramble[i % scramble.length]
            const gotPwd = plain.toString('utf8').replace(/\0+$/, '')
            if (gotPwd !== password) {
              state = 'closed'
              socket.write(mysqlErr(1045, '28000', 'Access denied', seq + 1))
              socket.end()
              return
            }
            state = 'ready'
            socket.write(mysqlOk(0, 0, seq + 1))
          } catch {
            state = 'closed'
            socket.write(mysqlErr(1045, '28000', 'Decrypt failed', seq + 1))
            socket.end()
          }
          continue
        }

        // Ready state commands
        const cmd = payload[0]
        if (cmd === 0x01) { // COM_QUIT
          socket.end()
          return
        }
        if (cmd === 0x0e) { // COM_PING
          socket.write(mysqlOk(0, 0, 1))
          continue
        }
        if (cmd === 0x03) { // COM_QUERY
          const sql = payload.subarray(1).toString('utf8')
          try {
            const res = engine.execute(sql, [])
            sendResultSet(res, false, 1)
          } catch (err) {
            socket.write(mysqlErr(err.mysqlErrno || 1064, '42000', err.message, 1))
          }
          continue
        }
        if (cmd === 0x16) { // COM_STMT_PREPARE
          const sql = payload.subarray(1).toString('utf8')
          const numParams = (sql.match(/\?/g) || []).length
          const isSelect = /^\s*SELECT\b/i.test(sql)
          const stmtId = nextStmtId++
          stmts.set(stmtId, { sql, numParams })
          const okPkt = Buffer.alloc(12)
          okPkt[0] = 0x00
          okPkt.writeUInt32LE(stmtId, 1)
          okPkt.writeUInt16LE(isSelect ? 1 : 0, 5)
          okPkt.writeUInt16LE(numParams, 7)
          let outSeq = 1
          const frames = [mysqlFrame(okPkt, outSeq++)]
          if (numParams > 0) {
            for (let i = 0; i < numParams; i += 1) frames.push(mysqlColDef('?', 0xfd, outSeq++))
            frames.push(mysqlEof(outSeq++))
          }
          if (isSelect) {
            frames.push(mysqlColDef('col', 0xfd, outSeq++))
            frames.push(mysqlEof(outSeq++))
          }
          socket.write(Buffer.concat(frames))
          continue
        }
        if (cmd === 0x17) { // COM_STMT_EXECUTE
          const stmtId = payload.readUInt32LE(1)
          const stmt = stmts.get(stmtId)
          if (!stmt) {
            socket.write(mysqlErr(1243, 'HY000', 'Unknown prepared statement', 1))
            continue
          }
          const params = []
          if (stmt.numParams > 0) {
            const nullBitmapLen = Math.floor((stmt.numParams + 7) / 8)
            const nullBitmap = payload.subarray(10, 10 + nullBitmapLen)
            let pos = 10 + nullBitmapLen + 1 // skip newParamsBoundFlag
            const types = []
            for (let i = 0; i < stmt.numParams; i += 1) {
              types.push(payload[pos])
              pos += 2
            }
            for (let i = 0; i < stmt.numParams; i += 1) {
              const isNull = (nullBitmap[i >> 3] & (1 << (i & 7))) !== 0
              if (isNull) {
                params.push(null)
              } else {
                const t = types[i]
                if (t === 0x01) { params.push(payload.readInt8(pos)); pos += 1 }
                else if (t === 0x08) { params.push(Number(payload.readBigInt64LE(pos))); pos += 8 }
                else if (t === 0x05) { params.push(payload.readDoubleLE(pos)); pos += 8 }
                else {
                  const li = readMysqlLenInt(payload, pos)
                  params.push(payload.subarray(li.next, li.next + li.v).toString('utf8'))
                  pos = li.next + li.v
                }
              }
            }
          }
          try {
            const res = engine.execute(stmt.sql, params)
            sendResultSet(res, true, 1)
          } catch (err) {
            socket.write(mysqlErr(err.mysqlErrno || 1064, '42000', err.message, 1))
          }
          continue
        }
        if (cmd === 0x19) { // COM_STMT_CLOSE
          const stmtId = payload.readUInt32LE(1)
          stmts.delete(stmtId)
          continue
        }
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        port: addr.port,
        engine,
        async close() {
          for (const s of sockets) s.destroy()
          await new Promise((r) => server.close(r))
        },
      })
    })
  })
}

/* ================================================================== 测试套件 */

async function main() {
  const pgSecret = 'pg_S3cr3t_P@ss!'
  const mySecret = 'my_S3cr3t_P@ss!'

  const pgServer = await startMockPgServer({ password: pgSecret, authMode: 'scram-sha-256' })
  const pgNoPermServer = await startMockPgServer({ password: pgSecret, authMode: 'scram-sha-256', allowCreateTable: false })
  const pgHangServer = await startMockPgServer({ hangHandshake: true })
  const mysqlNativeServer = await startMockMysqlServer({ password: mySecret, authPlugin: 'mysql_native_password' })
  const mysqlSha2FastServer = await startMockMysqlServer({ password: mySecret, authPlugin: 'caching_sha2_password', cachingSha2Mode: 'fast' })
  const mysqlSha2FullServer = await startMockMysqlServer({ password: mySecret, authPlugin: 'caching_sha2_password', cachingSha2Mode: 'full' })

  try {
    // 1. tablePrefix 安全校验
    await check('tablePrefix 校验：合法前缀放行，注入/非法字符全部报错拦截', async () => {
      eq(validateTablePrefix(undefined), 'pb_')
      eq(validateTablePrefix(''), 'pb_')
      eq(validateTablePrefix('custom_2_'), 'custom_2_')
      eq(validateTablePrefix('A123456789012345'), 'A123456789012345')

      const badPrefixes = ['pb_; DROP TABLE x', '1digit', 'has-dash', 'has space', 'too_long_prefix_17', 'pb`x', 'pb"x']
      const backend = createDbBackend()
      for (const bad of badPrefixes) {
        let msg1 = ''
        try { validateTablePrefix(bad) } catch (e) { msg1 = e.message }
        ok(/表前缀不合法/.test(msg1), 'validateTablePrefix 应拦截：' + bad)

        let msg2 = ''
        try { await backend.ensureSchema({ driver: 'postgres', tablePrefix: bad, port: pgServer.port, password: pgSecret }) } catch (e) { msg2 = e.message }
        ok(/表前缀不合法/.test(msg2), 'ensureSchema 应拦截：' + bad)

        let msg3 = ''
        try { await backend.testConnection({ driver: 'mysql', tablePrefix: bad, port: mysqlSha2FullServer.port, password: mySecret }) } catch (e) { msg3 = e.message }
        ok(/表前缀不合法/.test(msg3), 'testConnection 应拦截：' + bad)
      }
    })

    // 2. PostgreSQL SCRAM-SHA-256 / MD5 / Cleartext / Trust 与 SSL 回退 / 错密码脱敏
    await check('PostgreSQL v3：SCRAM-SHA-256 认证、错密码不泄露密码、SSL 回退与拒绝', async () => {
      const client = createPgClient({
        host: '127.0.0.1',
        port: pgServer.port,
        user: 'postgres',
        database: 'paper_workbench',
        password: pgSecret,
        ssl: 'prefer',
      })
      await client.connect()
      const ping = await client.ping()
      ok(ping.ok && ping.serverVersion === '16.4-mock', 'PG ping 与版本应正常')
      await client.close()

      // ssl: 'require' 遇到 'N' 应报错
      const strictSslClient = createPgClient({
        host: '127.0.0.1',
        port: pgServer.port,
        password: pgSecret,
        ssl: 'require',
      })
      let sslErr = ''
      try { await strictSslClient.connect() } catch (e) { sslErr = e.message }
      ok(/SSL\/TLS/.test(sslErr), 'ssl: require 遇到 N 应拒绝：' + sslErr)

      // 错密码报错，绝不能含密码明文
      const badClient = createPgClient({
        host: '127.0.0.1',
        port: pgServer.port,
        password: 'WRONG_' + pgSecret,
      })
      let authErr = ''
      try { await badClient.connect() } catch (e) { authErr = e.message }
      ok(/认证失败/.test(authErr), 'PG 错密码应给出中文认证失败提示：' + authErr)
      ok(!authErr.includes(pgSecret) && !authErr.includes('WRONG_'), '错误消息严禁泄露密码')

      // MD5 / Cleartext / Trust 也应工作
      for (const mode of ['md5', 'cleartext', 'trust']) {
        const srv = await startMockPgServer({ password: pgSecret, authMode: mode })
        try {
          const c = createPgClient({ host: '127.0.0.1', port: srv.port, password: pgSecret })
          await c.connect()
          ok((await c.ping()).ok, `PG ${mode} ping 应成功`)
          await c.close()
        } finally {
          await srv.close()
        }
      }
    })

    // 3. MySQL v10：mysql_native_password & caching_sha2_password (fast + RSA公钥全认证)
    await check('MySQL v10：mysql_native_password 与 caching_sha2_password 双路径认证与错密码脱敏', async () => {
      for (const [label, srv] of [
        ['mysql_native_password', mysqlNativeServer],
        ['caching_sha2_password(fast)', mysqlSha2FastServer],
        ['caching_sha2_password(full+RSA)', mysqlSha2FullServer],
      ]) {
        const c = createMysqlClient({ host: '127.0.0.1', port: srv.port, user: 'root', database: 'paper_workbench', password: mySecret })
        await c.connect()
        const ping = await c.ping()
        ok(ping.ok && ping.serverVersion === '8.0.36-mock', `${label} ping 应成功`)
        await c.close()

        const bad = createMysqlClient({ host: '127.0.0.1', port: srv.port, password: 'BAD_' + mySecret })
        let errMsg = ''
        try { await bad.connect() } catch (e) { errMsg = e.message }
        ok(/认证失败/.test(errMsg), `${label} 错密码应报中文认证失败：${errMsg}`)
        ok(!errMsg.includes(mySecret) && !errMsg.includes('BAD_'), `${label} 报错不能包含密码`)
      }
    })

    // 4. testConnection 成功 / 建表权限不足 / 不可达 / 超时分支
    await check('testConnection：未建表->已建表状态检测、无建表权限、不可达端口、超时分支', async () => {
      const backend = createDbBackend()
      const pgCfg = { driver: 'postgres', host: '127.0.0.1', port: pgServer.port, database: 'paper_workbench', user: 'postgres', password: pgSecret, tablePrefix: 't1_' }
      const myCfg = { driver: 'mysql', host: '127.0.0.1', port: mysqlSha2FullServer.port, database: 'paper_workbench', user: 'root', password: mySecret, tablePrefix: 't1_' }

      const r1 = await backend.testConnection(pgCfg)
      ok(r1.ok && r1.tablesReady === false && r1.serverVersion === '16.4-mock', 'PG 初次检测 tablesReady 应为 false：' + JSON.stringify(r1))

      await backend.ensureSchema(pgCfg)
      const r2 = await backend.testConnection(pgCfg)
      ok(r2.ok && r2.tablesReady === true, 'PG 建表后 tablesReady 应为 true：' + JSON.stringify(r2))

      const m1 = await backend.testConnection(myCfg)
      ok(m1.ok && m1.tablesReady === false, 'MySQL 初次检测 tablesReady 应为 false')
      await backend.ensureSchema(myCfg)
      const m2 = await backend.testConnection(myCfg)
      ok(m2.ok && m2.tablesReady === true, 'MySQL 建表后 tablesReady 应为 true')

      // 无建表权限
      const noPerm = await backend.testConnection({ driver: 'postgres', port: pgNoPermServer.port, password: pgSecret })
      ok(noPerm.ok === false && /权限/.test(noPerm.error), '无建表权限应明确报错：' + JSON.stringify(noPerm))

      // 不可达端口
      const unusedPort = await new Promise((resolve) => {
        const s = net.createServer()
        s.listen(0, '127.0.0.1', () => {
          const p = s.address().port
          s.close(() => resolve(p))
        })
      })
      const unreach = await backend.testConnection({ driver: 'mysql', host: '127.0.0.1', port: unusedPort, password: mySecret, connectTimeoutMs: 500 })
      ok(unreach.ok === false && !unreach.error.includes(mySecret), '不可达端口应返回 ok:false 且不泄密')

      // 握手超时
      const timeoutRes = await backend.testConnection({ driver: 'postgres', host: '127.0.0.1', port: pgHangServer.port, password: pgSecret, connectTimeoutMs: 250 })
      ok(timeoutRes.ok === false && /超时/.test(timeoutRes.error) && !timeoutRes.error.includes(pgSecret), '超时分支应报错超时：' + JSON.stringify(timeoutRes))
    })

    // 5. SQL 注入无害往返 & 5 张表完整 CRUD（覆盖 PG Extended Query 与 MySQL Prepared Statement）
    await check('PG & MySQL：SQL 注入字符无害往返 + 5 张表完整 CRUD + 事务回滚', async () => {
      const configs = [
        { driver: 'postgres', tablePrefix: 'crud_', postgres: { host: '127.0.0.1', port: pgServer.port, database: 'paper_workbench', user: 'postgres', password: pgSecret } },
        { driver: 'mysql', tablePrefix: 'crud_', mysql: { host: '127.0.0.1', port: mysqlSha2FullServer.port, database: 'paper_workbench', user: 'root', password: mySecret } },
      ]

      for (const dbCfg of configs) {
        const backend = createDbBackend({ getConfig: () => ({ database: dbCfg }) })
        try {
          const evilText = "'; DROP TABLE crud_translations; -- $1 \\0 🚀 $\\alpha + \\beta$"
          const longMd = '# 深度研读\n\n' + '内容段落。'.repeat(120) + '\n' + evilText

          // translations
          eq(await backend.transPut('p-inj', { k1: evilText, k2: '第二段' }, { model: { provider: 'mock', model: 'm1' } }), 2)
          const tAll = await backend.transAll('p-inj')
          eq(tAll.entries, { k1: evilText, k2: '第二段' }, dbCfg.driver + ' 注入文本应原样往返')
          eq(tAll.model, { provider: 'mock', model: 'm1' })
          eq(await backend.transMerge('p-inj', { k3: '第三段' }), 1)
          eq(await backend.transReplace('p-inj', { k1: '替换后', k4: '新键' }), 2)
          eq(await backend.transAll('p-inj').then((x) => x.entries), { k1: '替换后', k4: '新键' })
          eq(await backend.transDelete('p-inj', ['k4']), 1)

          // job_events
          const s1 = await backend.jobAppend('p-inj', { level: 'info', kind: 'start', message: evilText, extra: { step: 1 } })
          const s2 = await backend.jobAppend('p-inj', { level: 'warn', kind: 'step', message: '完成', extra: [1, 2] })
          ok(s2 > s1, 'seq 应递增')
          const j1 = await backend.jobList('p-inj', { after: s1 })
          eq(j1.events.length, 1)
          eq(j1.events[0].extra, [1, 2])
          const jAll = await backend.jobList('p-inj', { after: 0 })
          eq(jAll.events[0].message, evilText)

          // reviews
          await backend.reviewPut('p-inj', { mode: 'both', issues: [{ key: 'k1', message: evilText }], stats: { total: 2 }, llmError: '无' })
          const rev = await backend.reviewGet('p-inj')
          eq(rev.issues[0].message, evilText)
          eq(rev.llmError, '无')

          // annotations（含二次 upsert 不改 createdAt、只改 updatedAt）
          const insertedAnns = await backend.annUpsert('p-inj', [
            { id: 'a1', paragraphKey: 'k1', quote: evilText, note: '初稿', page: 2, startOffset: 5, endOffset: 15 },
            { id: 'a2', paragraphKey: 'k2', quote: '高亮', page: 1, startOffset: 0, endOffset: 2 },
          ])
          const origCreatedAt = insertedAnns[0].createdAt
          await new Promise((r) => setTimeout(r, 15))
          await backend.annUpsert('p-inj', { id: 'a1', paragraphKey: 'k1', quote: evilText, note: '修改后', page: 2, startOffset: 5, endOffset: 15 })
          const anns = await backend.annList('p-inj')
          eq(anns.length, 2)
          eq(anns[0].id, 'a2', 'annList 应按 page ASC 排序')
          eq(anns[1].note, '修改后')
          eq(anns[1].createdAt, origCreatedAt, '更新标注不应覆盖 createdAt')

          // study_notes
          const sn = await backend.studyNoteUpsert('p-inj', { id: 'n1', title: '核心推导', scope: 'formula', markdown: longMd, payload: { eq: 3 } })
          eq(sn.id, 'n1')
          const notes = await backend.studyNoteList('p-inj')
          eq(notes.length, 1)
          eq(notes[0].markdown, longMd)
          eq(notes[0].payload, { eq: 3 })

          // listPaperIds & info
          eq(await backend.listPaperIds(), ['p-inj'])
          const info = await backend.info()
          ok(info.healthy && info.driver === dbCfg.driver)
          eq(info.counts, { translations: 1, job_events: 2, reviews: 1, annotations: 2, study_notes: 1 })

          // 事务回滚测试：使用独立底层客户端直接验证失败回滚
          const rawClient = dbCfg.driver === 'postgres'
            ? createPgClient(dbCfg.postgres)
            : createMysqlClient(dbCfg.mysql)
          await rawClient.connect()
          try {
            let caught = false
            try {
              await rawClient.tx(async (conn) => {
                const ph = dbCfg.driver === 'postgres' ? ['$1', '$2', '$3', '$4', '$5', '$6'] : ['?', '?', '?', '?', '?', '?']
                const tbl = dbCfg.driver === 'postgres' ? '"crud_translations"' : '`crud_translations`'
                const keyCol = dbCfg.driver === 'postgres' ? 'key' : '`key`'
                await conn.query(
                  `INSERT INTO ${tbl} (paper_id, target, ${keyCol}, text, model, updated_at) VALUES (${ph.join(', ')})`,
                  ['p-tx-rollback', 'zh', 'k-rb', '应被回滚', '', new Date().toISOString()],
                )
                throw new Error('人为触发回滚')
              })
            } catch (e) {
              caught = /人为触发回滚/.test(e.message)
            }
            ok(caught, 'tx 内异常应透传')
            eq((await backend.transAll('p-tx-rollback')).entries, {}, '回滚后不应残留数据')
          } finally {
            await rawClient.close()
          }

          // deletePaperData
          const del = await backend.deletePaperData('p-inj')
          eq(del.deleted, { translations: 1, job_events: 2, reviews: 1, annotations: 2, study_notes: 1 })
          eq(await backend.listPaperIds(), [])
        } finally {
          await backend.close()
        }
      }
    })

    // 6. exportSnapshot / importSnapshot 往返一致 & merge vs replace
    await check('exportSnapshot / importSnapshot：往返一致、merge 与 replace 语义正确', async () => {
      const b1 = createDbBackend({
        getConfig: () => ({
          database: { driver: 'postgres', tablePrefix: 'snap_', postgres: { host: '127.0.0.1', port: pgServer.port, password: pgSecret } },
        }),
      })
      const b2 = createDbBackend({
        getConfig: () => ({
          database: { driver: 'mysql', tablePrefix: 'snap_', mysql: { host: '127.0.0.1', port: mysqlSha2FullServer.port, password: mySecret } },
        }),
      })
      try {
        await b1.transPut('p-s1', { a: '甲', b: '乙' }, { model: 'm-snap' })
        await b1.annUpsert('p-s1', { id: 'a1', paragraphKey: 'a', quote: '甲', note: '注1', page: 1 })
        await b1.studyNoteUpsert('p-s1', { id: 'sn1', title: '笔记1', markdown: '# 标题\n正文' })
        await b1.reviewPut('p-s1', { mode: 'static', issues: [], stats: { paragraphs: 2 } })

        const snap = await b1.exportSnapshot()
        eq(snap.format, 'dsh-paper-workbench-db')
        eq(snap.version, 1)
        eq(snap.sourceDriver, 'postgres')
        ok(Boolean(snap.papers['p-s1']))

        // b2 先有一条额外数据，测试 merge 保留、replace 覆盖
        await b2.transPut('p-s1', { c: '目标原有' })
        const statMerge = await b2.importSnapshot(snap, { mode: 'merge' })
        eq(statMerge, { papers: 1, translations: 2, annotations: 1, studyNotes: 1, reviews: 1 })
        eq((await b2.transAll('p-s1')).entries, { a: '甲', b: '乙', c: '目标原有' })

        const statReplace = await b2.importSnapshot(snap, { mode: 'replace' })
        eq(statReplace, { papers: 1, translations: 2, annotations: 1, studyNotes: 1, reviews: 1 })
        eq((await b2.transAll('p-s1')).entries, { a: '甲', b: '乙' })
        eq((await b2.annList('p-s1')).length, 1)
        eq((await b2.studyNoteList('p-s1')).length, 1)
        eq((await b2.reviewGet('p-s1')).stats, { paragraphs: 2 })
      } finally {
        await b1.close()
        await b2.close()
      }
    })

    // 7. 全量跨库迁移：SQLite -> Mock PG -> Mock MySQL -> 新 SQLite
    await check('跨库全量迁移：SQLite -> Mock PG -> Mock MySQL -> 新 SQLite 一致性且源库零破坏', async () => {
      const sqliteBackend = createDbBackend({ getConfig: () => ({ database: { driver: 'sqlite' } }) })
      const pgTarget = {
        driver: 'postgres',
        tablePrefix: 'mig_',
        host: '127.0.0.1',
        port: pgServer.port,
        database: 'paper_workbench',
        user: 'postgres',
        password: pgSecret,
      }
      const mysqlTarget = {
        driver: 'mysql',
        tablePrefix: 'mig_',
        host: '127.0.0.1',
        port: mysqlSha2FullServer.port,
        database: 'paper_workbench',
        user: 'root',
        password: mySecret,
      }
      const finalSqlitePath = path.join(tmpRoot, 'migrated-roundtrip.db')

      // 在隔离临时 SQLite 里写入 2 篇论文完整 5 张表数据
      await sqliteBackend.transPut('p-mig-1', { h1: '摘要译文', h2: '方法译文 $\\sum x_i$' }, { model: { provider: 'openai', model: 'gpt-4o' } })
      await sqliteBackend.transPut('p-mig-2', { h3: "特殊字符'; -- 结束" })
      await sqliteBackend.jobAppend('p-mig-1', { level: 'info', kind: 'translate', message: '开始翻译' })
      await sqliteBackend.jobAppend('p-mig-1', { level: 'info', kind: 'done', message: '翻译完成', extra: { n: 2 } })
      await sqliteBackend.jobAppend('p-mig-2', { level: 'warn', kind: 'ocr', message: '低分辨率' })
      await sqliteBackend.reviewPut('p-mig-1', { mode: 'both', issues: [{ key: 'h1', code: 'term' }], stats: { checked: 2 } })
      await sqliteBackend.annUpsert('p-mig-1', [
        { id: 'ann-1', paragraphKey: 'h1', quote: 'Abstract', note: '重点', page: 1, startOffset: 0, endOffset: 8 },
        { id: 'ann-2', paragraphKey: 'h2', quote: 'Method', note: '公式', page: 3, startOffset: 10, endOffset: 16 },
      ])
      await sqliteBackend.studyNoteUpsert('p-mig-1', { id: 'sn-1', title: '精读笔记', scope: 'section', markdown: '## 总结\n清晰', payload: { tags: ['rl'] } })

      const srcInfoBefore = await sqliteBackend.info()
      eq(srcInfoBefore.counts, { translations: 3, job_events: 3, reviews: 1, annotations: 2, study_notes: 1 })
      const srcSnapBefore = await sqliteBackend.exportSnapshot()

      // Step A: SQLite -> Mock PG
      const progressPhases = []
      const rep1 = await sqliteBackend.migrateTo(pgTarget, {
        mode: 'replace',
        onProgress: (ev) => progressPhases.push(ev.phase),
      })
      ok(rep1.ok && rep1.verified && rep1.sourceDriver === 'sqlite' && rep1.targetDriver === 'postgres')
      eq(rep1.sourceCounts, srcInfoBefore.counts)
      eq(rep1.targetCounts, srcInfoBefore.counts)
      ok(progressPhases.includes('prepare') && progressPhases.includes('paper') && progressPhases.includes('verify') && progressPhases.includes('done'))

      // 验证源 SQLite 数据毫发无损
      eq((await sqliteBackend.info()).counts, srcInfoBefore.counts, '迁移后源 SQLite 计数必须不变')
      eq((await sqliteBackend.exportSnapshot()).papers, srcSnapBefore.papers, '迁移后源 SQLite 内容必须不变')

      // 再次以 merge 模式迁移，不应重复写入 job_events
      const pgBackend = createDbBackend({ getConfig: () => ({ database: pgTarget }) })
      const repIdem = await sqliteBackend.migrateTo(pgTarget, { mode: 'merge' })
      eq(repIdem.migrated.job_events, 0, '幂等 merge 迁移不应重复插入已有 job_events')
      eq((await pgBackend.info()).counts, srcInfoBefore.counts)

      // Step B: Mock PG -> Mock MySQL
      const rep2 = await pgBackend.migrateTo(mysqlTarget, { mode: 'replace' })
      ok(rep2.ok && rep2.verified && rep2.sourceDriver === 'postgres' && rep2.targetDriver === 'mysql')
      eq(rep2.targetCounts, srcInfoBefore.counts)

      // Step C: Mock MySQL -> 新 SQLite 文件
      const myBackend = createDbBackend({ getConfig: () => ({ database: mysqlTarget }) })
      const rep3 = await myBackend.migrateTo({ driver: 'sqlite', path: finalSqlitePath }, { mode: 'replace' })
      ok(rep3.ok && rep3.verified && rep3.sourceDriver === 'mysql' && rep3.targetDriver === 'sqlite')
      eq(rep3.targetCounts, srcInfoBefore.counts)

      // 用独立 backend 读取新 SQLite 文件确认往返数据完全一致
      await sqliteBackend.close()
      await pgBackend.close()
      await myBackend.close()

      // 切 PB_DB_PATH 到新 SQLite 文件读出并对比
      const savedPath = process.env.PB_DB_PATH
      process.env.PB_DB_PATH = finalSqlitePath
      try {
        const finalBackend = createDbBackend({ getConfig: () => ({ database: { driver: 'sqlite' } }) })
        const finalInfo = await finalBackend.info()
        eq(finalInfo.counts, srcInfoBefore.counts, '回迁 SQLite 后 5 张表行数应与源库一致')
        const finalSnap = await finalBackend.exportSnapshot()
        for (const pid of Object.keys(srcSnapBefore.papers)) {
          eq(finalSnap.papers[pid].translations.entries, srcSnapBefore.papers[pid].translations.entries)
          eq(finalSnap.papers[pid].translations.model, srcSnapBefore.papers[pid].translations.model)
          eq(finalSnap.papers[pid].annotations.map((a) => ({ id: a.id, quote: a.quote, note: a.note })), srcSnapBefore.papers[pid].annotations.map((a) => ({ id: a.id, quote: a.quote, note: a.note })))
          eq(finalSnap.papers[pid].studyNotes.map((n) => ({ id: n.id, markdown: n.markdown, payload: n.payload })), srcSnapBefore.papers[pid].studyNotes.map((n) => ({ id: n.id, markdown: n.markdown, payload: n.payload })))
          eq(finalSnap.papers[pid].review, srcSnapBefore.papers[pid].review)
        }
        eq((await finalBackend.jobList('p-mig-1')).events.map((e) => e.message), ['开始翻译', '翻译完成'])
        await finalBackend.close()
      } finally {
        process.env.PB_DB_PATH = savedPath
      }
    })

    // 8. 并发池请求、latest 分页、migrateTransJson 幂等、动态配置切换与单表清理
    await check('并发池、jobList(latest)、migrateTransJson、动态切换驱动与明细删除', async () => {
      let currentCfg = {
        database: {
          driver: 'postgres',
          tablePrefix: 'adv_',
          postgres: { host: '127.0.0.1', port: pgServer.port, password: pgSecret, maxPoolSize: 3 },
        },
      }
      const backend = createDbBackend({ getConfig: () => currentCfg })
      try {
        // 未建表前 info() 应安全报告 healthy: false 且不抛出未捕获异常
        const preInfo = await backend.info()
        eq(preInfo.healthy, false)
        eq(preInfo.driver, 'postgres')

        await backend.ensureSchema()
        const postInfo = await backend.info()
        eq(postInfo.healthy, true)

        // 并发写入测试连接池多连接复用
        await Promise.all([
          backend.transPut('p-conc-1', { k1: '译文1' }),
          backend.transPut('p-conc-2', { k2: '译文2' }),
          backend.jobAppend('p-conc-1', { message: 'e1' }),
          backend.jobAppend('p-conc-1', { message: 'e2' }),
          backend.jobAppend('p-conc-1', { message: 'e3' }),
          backend.jobAppend('p-conc-1', { message: 'e4' }),
        ])
        const latest2 = await backend.jobList('p-conc-1', { latest: true, limit: 2 })
        eq(latest2.events.length, 2)
        ok(latest2.events[0].seq < latest2.events[1].seq, 'latest: true 应按升序返回末尾 N 条')
        eq(latest2.lastSeq, latest2.events[1].seq)

        // migrateTransJson 幂等测试
        eq(await backend.migrateTransJson('p-mig-json', { target: 'zh', model: 'legacy-m', entries: { a: { zh: '老译文' }, b: '' } }), 1)
        eq(await backend.migrateTransJson('p-mig-json', { target: 'zh', entries: { c: { zh: '不应再导' } } }), 0)
        eq((await backend.transAll('p-mig-json')).entries, { a: '老译文' })

        // 动态切换配置到 MySQL（自动释放 PG 连接池并启用 MySQL）
        currentCfg = {
          database: {
            driver: 'mysql',
            tablePrefix: 'adv_',
            mysql: { host: '127.0.0.1', port: mysqlSha2FullServer.port, password: mySecret, maxPoolSize: 3 },
          },
        }
        await backend.annUpsert('p-my-del', [
          { id: 'x1', paragraphKey: 'k', quote: 'q1' },
          { id: 'x2', paragraphKey: 'k', quote: 'q2' },
        ])
        eq(await backend.annDelete('p-my-del', ['x1']), 1)
        eq((await backend.annList('p-my-del')).map((x) => x.id), ['x2'])
        eq(await backend.annClear('p-my-del'), 1)

        await backend.studyNoteUpsert('p-my-del', [
          { id: 's1', title: 't1', markdown: 'm1' },
          { id: 's2', title: 't2', markdown: 'm2' },
        ])
        eq(await backend.studyNoteDelete('p-my-del', ['s1']), 1)
        eq(await backend.studyNoteClear('p-my-del'), 1)
        await backend.reviewPut('p-my-del', { mode: 'static', issues: [] })
        eq(await backend.reviewDelete('p-my-del'), 1)
        eq(await backend.reviewGet('p-my-del'), null)
        await backend.jobAppend('p-my-del', { message: 'j1' })
        eq(await backend.jobClear('p-my-del'), 1)
        await backend.transPut('p-my-del', { t: 'v' })
        eq(await backend.transClear('p-my-del'), 1)
      } finally {
        await backend.close()
      }
    })
  } finally {
    try { dbMod.closeDb() } catch { /* ignore */ }
    await Promise.all([
      pgServer.close(),
      pgNoPermServer.close(),
      pgHangServer.close(),
      mysqlNativeServer.close(),
      mysqlSha2FastServer.close(),
      mysqlSha2FullServer.close(),
    ])
    try {
      await fsp.rm(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore Windows cleanup race */
    }
  }
}

try {
  await main()
} catch (error) {
  failed += 1
  console.log('FAIL  测试脚本异常终止 -> ' + (error && error.stack ? error.stack : String(error)))
}

console.log('')
console.log('PASS ' + passed + ' / FAIL ' + failed)
process.exitCode = failed ? 1 : 0
