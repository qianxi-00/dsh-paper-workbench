/**
 * 本地数据库（v3 契约 §1）：逐段译文、任务日志、翻译自检结果。
 *
 * 设计要点：
 *   - 主引擎是 Node 自带的 `node:sqlite`（Node 22.5+ 有，24 稳定），不引第三方依赖；
 *   - 宿主 Node 太老、import 失败时，退化成**同一套接口**的 JSON 文件实现（workbench.json），
 *     两种引擎行为一致，`dbInfo().engine` 如实报告 `'sqlite'` / `'json'`；
 *   - 懒打开：第一次真正用到才建目录/建文件/建表，进程里只留一个连接；
 *   - 所有写操作都在事务里（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`；JSON 引擎是
 *     「先改副本、落盘成功再换上去」），中途失败不会留下半条数据；
 *   - 报错文案中文，不把绝对路径拼进用户可见文案；需要细节时挂 `cause` 给日志看。
 *
 * 环境变量：
 *   PB_DB_PATH                覆盖数据库文件路径（测试用）
 *   PB_DB_ENGINE              强制引擎 `sqlite` | `json`（测试退化实现用；默认自动探测）
 *   DSH_PAPER_WORKBENCH_DATA  数据根，与 store.js 的 DATA_ROOT 保持一致
 *
 * 数据形状与 store.js 的关系：db 里每种译文只存**纯文本**（`translations.text`），
 * 条目级的 `at`/`model` 不落库（契约 §1 的 `transAll` 只给整篇的 `model`/`updatedAt`）；
 * 老的 `trans.json` 条目是 `{ zh, at, model }` 对象，`migrateTransJson` 会取其中的 `zh`。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCHEMA_VERSION = '1'
const DEFAULT_TARGET = 'zh'
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS translations (
  paper_id TEXT NOT NULL, target TEXT NOT NULL, key TEXT NOT NULL,
  text TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY (paper_id, target, key));
CREATE TABLE IF NOT EXISTS job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, paper_id TEXT NOT NULL, at TEXT NOT NULL,
  level TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, extra TEXT);
CREATE TABLE IF NOT EXISTS reviews (
  paper_id TEXT PRIMARY KEY, at TEXT NOT NULL, mode TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

/* ------------------------------------------------------------------ 引擎探测 */

const FORCED_ENGINE = (() => {
  const raw = String(process.env.PB_DB_ENGINE || '').trim().toLowerCase()
  return raw === 'sqlite' || raw === 'json' ? raw : ''
})()

let SqliteDatabase = null
if (FORCED_ENGINE !== 'json') {
  try {
    const mod = await import('node:sqlite')
    if (mod && typeof mod.DatabaseSync === 'function') SqliteDatabase = mod.DatabaseSync
  } catch {
    // 宿主 Node 没有 node:sqlite：走 JSON 退化实现，不是错误。
    SqliteDatabase = null
  }
}

/** 实际生效的引擎；`PB_DB_ENGINE=sqlite` 但宿主没有 node:sqlite 时仍是 json。 */
const ENGINE = SqliteDatabase ? 'sqlite' : 'json'

/* ------------------------------------------------------------------ 路径 */

/** 数据根：与 store.js 的 DATA_ROOT 同一套规则（每次调用现算，测试可以中途改环境变量）。 */
function dataRoot() {
  const fromEnv = process.env.DSH_PAPER_WORKBENCH_DATA
  if (fromEnv && String(fromEnv).trim() !== '') return path.resolve(String(fromEnv))
  return path.join(os.homedir(), '.dsh', 'paper-workbench')
}

/** 库文件路径：`PB_DB_PATH` 优先，否则数据根下的 workbench.db（JSON 引擎是 workbench.json）。 */
export function dbPath() {
  const override = process.env.PB_DB_PATH
  if (override && String(override).trim() !== '') return path.resolve(String(override).trim())
  return path.join(dataRoot(), ENGINE === 'sqlite' ? 'workbench.db' : 'workbench.json')
}

/* ------------------------------------------------------------------ 小工具 */

function assertPaperId(paperId) {
  if (typeof paperId !== 'string' || paperId.trim() === '') throw new Error('论文 id 不能为空')
  return paperId
}

function nowIso() {
  return new Date().toISOString()
}

function toCount(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.floor(n))
}

/** 一条译文的正规化文本：字符串原样；老的 `{ zh }` / `{ text }` 取字段；其它抛错。 */
function entryText(key, value, strict) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if (typeof value.zh === 'string') return value.zh
    if (typeof value.text === 'string') return value.text
  }
  if (!strict) return null
  throw new Error('译文条目必须是字符串（或以 zh 为字段的对象）：' + key)
}

/** entries → [[key, text]]；strict=false 时跳过读不出文本的条目（迁移老文件用）。 */
function entriesToPairs(entries, strict) {
  if (entries === null || entries === undefined) return []
  if (typeof entries !== 'object' || Array.isArray(entries)) {
    if (!strict) return []
    throw new Error('entries 必须是 { key: text } 形式的对象')
  }
  const pairs = []
  for (const [key, value] of Object.entries(entries)) {
    if (key === '') throw new Error('entries 里有空的 key')
    const text = entryText(key, value, strict)
    if (text === null) continue
    pairs.push([key, text])
  }
  return pairs
}

/** model 以 TEXT 存：字符串原样，对象（老 trans.json 的 {provider, model}）序列化成 JSON 文本。 */
function modelText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (error) {
    throw new Error('模型信息不是可序列化的数据', { cause: error })
  }
}

/** 读回时把「看起来像 JSON 对象」的 model 文本还原成对象，保证与老 trans.json 往返一致。 */
function parseModel(text) {
  if (typeof text !== 'string' || text === '') return ''
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? parsed : text
  } catch {
    return text
  }
}

function jsonText(value, label) {
  if (value === null || value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch (error) {
    throw new Error(label + '不是可序列化的数据', { cause: error })
  }
}

function parseJsonValue(text) {
  if (text === null || text === undefined || text === '') return null
  if (typeof text !== 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/* ------------------------------------------------------------------ SQLite 实现 */

function openSqliteHandle(file) {
  let db
  try {
    db = new SqliteDatabase(file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(SCHEMA_SQL)
    db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run('schema', SCHEMA_VERSION)
  } catch (error) {
    try {
      if (db) db.close()
    } catch {
      /* 关不上就算了，反正要抛错 */
    }
    throw new Error('打不开本地数据库，文件可能已损坏或没有写权限', { cause: error })
  }

  const cache = new Map()
  const stmt = (sql) => {
    let prepared = cache.get(sql)
    if (!prepared) {
      prepared = db.prepare(sql)
      cache.set(sql, prepared)
    }
    return prepared
  }
  let depth = 0

  return {
    engine: 'sqlite',
    path: file,

    close() {
      cache.clear()
      db.close()
    },

    tx(fn) {
      // 嵌套调用不再开新事务（SQLite 不支持嵌套 BEGIN）。
      if (depth > 0) return fn()
      db.exec('BEGIN IMMEDIATE')
      depth += 1
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 回滚失败时保留原始错误 */
        }
        throw error
      } finally {
        depth -= 1
      }
    },

    transRows(paperId) {
      return stmt(
        'SELECT target, key, text, model, updated_at FROM translations WHERE paper_id = ? ORDER BY updated_at ASC, rowid ASC'
      ).all(paperId)
    },

    transCount(paperId) {
      return Number(stmt('SELECT COUNT(*) AS n FROM translations WHERE paper_id = ?').get(paperId).n)
    },

    transUpsert(paperId, target, model, pairs) {
      const at = nowIso()
      const insert = stmt(
        `INSERT INTO translations (paper_id, target, key, text, model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(paper_id, target, key) DO UPDATE SET
           text = excluded.text, model = excluded.model, updated_at = excluded.updated_at`
      )
      for (const [key, text] of pairs) insert.run(paperId, target, key, text, model, at)
      return pairs.length
    },

    transDelete(paperId, keys) {
      const holes = keys.map(() => '?').join(', ')
      const result = stmt(
        'DELETE FROM translations WHERE paper_id = ? AND key IN (' + holes + ')'
      ).run(paperId, ...keys)
      return Number(result.changes)
    },

    transDeleteAll(paperId) {
      return Number(stmt('DELETE FROM translations WHERE paper_id = ?').run(paperId).changes)
    },

    jobInsert(paperId, event) {
      const result = stmt(
        'INSERT INTO job_events (paper_id, at, level, kind, message, extra) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(paperId, event.at, event.level, event.kind, event.message, event.extra)
      return Number(result.lastInsertRowid)
    },

    jobRows(paperId, after, limit) {
      return stmt(
        'SELECT seq, at, level, kind, message, extra FROM job_events WHERE paper_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
      ).all(paperId, after, limit)
    },

    jobDeleteAll(paperId) {
      return Number(stmt('DELETE FROM job_events WHERE paper_id = ?').run(paperId).changes)
    },

    reviewUpsert(paperId, at, mode, payload) {
      stmt(
        `INSERT INTO reviews (paper_id, at, mode, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT(paper_id) DO UPDATE SET at = excluded.at, mode = excluded.mode, payload = excluded.payload`
      ).run(paperId, at, mode, payload)
    },

    reviewRow(paperId) {
      return stmt('SELECT at, mode, payload FROM reviews WHERE paper_id = ?').get(paperId) || null
    },

    counts() {
      return {
        translations: Number(stmt('SELECT COUNT(*) AS n FROM translations').get().n),
        job_events: Number(stmt('SELECT COUNT(*) AS n FROM job_events').get().n),
        reviews: Number(stmt('SELECT COUNT(*) AS n FROM reviews').get().n),
      }
    },
  }
}

/* ------------------------------------------------------------------ JSON 退化实现 */

function emptyJsonDb() {
  return {
    version: 1,
    schema: Number(SCHEMA_VERSION),
    seq: 0,
    translations: [],
    job_events: [],
    reviews: [],
    meta: { schema: SCHEMA_VERSION },
  }
}

function readJsonDb(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyJsonDb()
    throw new Error('打不开本地存储文件，请检查数据目录的写权限', { cause: error })
  }
  if (raw.trim() === '') return emptyJsonDb()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('本地存储文件已损坏（不是合法 JSON）', { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('本地存储文件已损坏（结构不对）')
  }
  const db = emptyJsonDb()
  if (Array.isArray(parsed.translations)) db.translations = parsed.translations.filter((row) => row && typeof row === 'object')
  if (Array.isArray(parsed.job_events)) db.job_events = parsed.job_events.filter((row) => row && typeof row === 'object')
  if (Array.isArray(parsed.reviews)) db.reviews = parsed.reviews.filter((row) => row && typeof row === 'object')
  const rowsMax = db.job_events.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0)
  const savedSeq = Number(parsed.seq)
  db.seq = Number.isFinite(savedSeq) ? Math.max(savedSeq, rowsMax) : rowsMax
  return db
}

function writeJsonDb(file, data) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  renameSync(tmp, file)
}

function openJsonHandle(file) {
  const handle = {
    engine: 'json',
    path: file,
    data: readJsonDb(file),
    pending: null,

    close() {
      this.pending = null
    },

    /** 事务期间所有读写都落在 pending 副本上，落盘成功才替换正式数据。 */
    view() {
      return this.pending || this.data
    },

    tx(fn) {
      if (this.pending) return fn()
      this.pending = JSON.parse(JSON.stringify(this.data))
      try {
        const out = fn()
        const next = this.pending
        this.pending = null
        this.data = next
        writeJsonDb(file, next)
        return out
      } catch (error) {
        this.pending = null
        throw error
      }
    },

    transRows(paperId) {
      const rows = this.view().translations.filter((row) => row.paper_id === paperId)
      rows.sort((a, b) => {
        const left = String(a.updated_at || '')
        const right = String(b.updated_at || '')
        if (left < right) return -1
        if (left > right) return 1
        return 0
      })
      return rows.map((row) => ({ target: row.target, key: row.key, text: row.text, model: row.model, updated_at: row.updated_at }))
    },

    transCount(paperId) {
      return this.view().translations.filter((row) => row.paper_id === paperId).length
    },

    transUpsert(paperId, target, model, pairs) {
      const db = this.view()
      const at = nowIso()
      const index = new Map()
      for (const row of db.translations) {
        if (row.paper_id === paperId) index.set(row.target + '\u0000' + row.key, row)
      }
      for (const [key, text] of pairs) {
        const found = index.get(target + '\u0000' + key)
        if (found) {
          found.text = text
          found.model = model
          found.updated_at = at
        } else {
          const row = { paper_id: paperId, target, key, text, model, updated_at: at }
          db.translations.push(row)
          index.set(target + '\u0000' + key, row)
        }
      }
      return pairs.length
    },

    transDelete(paperId, keys) {
      const db = this.view()
      const drop = new Set(keys)
      const before = db.translations.length
      db.translations = db.translations.filter((row) => !(row.paper_id === paperId && drop.has(row.key)))
      return before - db.translations.length
    },

    transDeleteAll(paperId) {
      const db = this.view()
      const before = db.translations.length
      db.translations = db.translations.filter((row) => row.paper_id !== paperId)
      return before - db.translations.length
    },

    jobInsert(paperId, event) {
      const db = this.view()
      db.seq = (Number(db.seq) || 0) + 1
      db.job_events.push({
        seq: db.seq,
        paper_id: paperId,
        at: event.at,
        level: event.level,
        kind: event.kind,
        message: event.message,
        extra: event.extra,
      })
      return db.seq
    },

    jobRows(paperId, after, limit) {
      return this.view()
        .job_events.filter((row) => row.paper_id === paperId && Number(row.seq) > after)
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .slice(0, limit)
        .map((row) => ({ seq: row.seq, at: row.at, level: row.level, kind: row.kind, message: row.message, extra: row.extra }))
    },

    jobDeleteAll(paperId) {
      const db = this.view()
      const before = db.job_events.length
      db.job_events = db.job_events.filter((row) => row.paper_id !== paperId)
      return before - db.job_events.length
    },

    reviewUpsert(paperId, at, mode, payload) {
      const db = this.view()
      const row = db.reviews.find((item) => item.paper_id === paperId)
      if (row) {
        row.at = at
        row.mode = mode
        row.payload = payload
      } else {
        db.reviews.push({ paper_id: paperId, at, mode, payload })
      }
    },

    reviewRow(paperId) {
      const row = this.view().reviews.find((item) => item.paper_id === paperId)
      return row ? { at: row.at, mode: row.mode, payload: row.payload } : null
    },

    counts() {
      const db = this.view()
      return {
        translations: db.translations.length,
        job_events: db.job_events.length,
        reviews: db.reviews.length,
      }
    },
  }
  // 与 SQLite 对齐：打开就落一个空库文件（否则「库存在吗」在两种引擎下答案不同）。
  if (!existsSync(file)) writeJsonDb(file, handle.data)
  return handle
}

/* ------------------------------------------------------------------ 打开 / 关闭 */

function openHandle(file) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
  } catch (error) {
    throw new Error('建不了数据目录，请检查磁盘权限', { cause: error })
  }
  return ENGINE === 'sqlite' ? openSqliteHandle(file) : openJsonHandle(file)
}

let opened = null // { path, handle }

/** 懒打开（同一路径只开一次）。换路径（改 PB_DB_PATH）会自动重开，避免测试串库。 */
export function getDb() {
  const file = dbPath()
  if (opened && opened.path === file) return opened.handle
  if (opened) closeDb()
  opened = { path: file, handle: openHandle(file) }
  return opened.handle
}

/** 关闭连接；没打开过时是安全的空操作。之后 getDb() 会重新打开，数据仍在。 */
export function closeDb() {
  if (!opened) return false
  const { handle } = opened
  opened = null
  try {
    handle.close()
  } catch {
    // 关不上不影响下次重开，也不该把「关闭」变成用户可见的失败。
  }
  return true
}

/** 引擎、库路径与三张表的行数（会真的打开库，可能创建文件）。 */
export function dbInfo() {
  const handle = getDb()
  const rows = handle.counts()
  return {
    engine: handle.engine,
    path: handle.path,
    rows: {
      translations: rows.translations,
      job_events: rows.job_events,
      reviews: rows.reviews,
    },
  }
}

/* ------------------------------------------------------------------ 译文 */

/**
 * 读整篇译文：`{ version:1, target, model, updatedAt, entries:{ [key]: 纯文本 } }`。
 * 空库返回契约里的默认形状（`updatedAt` 为 null，与 store.js 的 readTrans 一致）。
 * 同一篇里理论上只有一个 target；若混写了多个，entries 合并、target/model/updatedAt 取最新一行。
 */
export function transAll(paperId) {
  assertPaperId(paperId)
  const rows = getDb().transRows(paperId)
  const out = { version: 1, target: DEFAULT_TARGET, model: '', updatedAt: null, entries: {} }
  for (const row of rows) {
    out.entries[row.key] = row.text
    out.target = row.target || DEFAULT_TARGET
    out.model = parseModel(row.model)
    out.updatedAt = row.updated_at || null
  }
  return out
}

/**
 * 写译文（同一 key 覆盖）。`opts { target='zh', model='' }`，model 可以是对象（老的
 * `{ provider, model }`），会以 JSON 文本存库并在 transAll 里还原。返回写入条数。
 */
export function transPut(paperId, entries, opts = {}) {
  assertPaperId(paperId)
  const pairs = entriesToPairs(entries, true)
  if (pairs.length === 0) return 0
  const target = typeof opts.target === 'string' && opts.target.trim() !== '' ? opts.target.trim() : DEFAULT_TARGET
  const model = modelText(opts.model)
  const handle = getDb()
  return handle.tx(() => handle.transUpsert(paperId, target, model, pairs))
}

/** 按 key 删（跨 target），返回真正删掉的行数。 */
export function transDelete(paperId, keys) {
  assertPaperId(paperId)
  const list = (Array.isArray(keys) ? keys : keys === null || keys === undefined ? [] : [keys])
    .map((key) => String(key))
    .filter((key) => key !== '')
  if (list.length === 0) return 0
  const handle = getDb()
  return handle.tx(() => handle.transDelete(paperId, list))
}

/** 清空一篇论文的全部译文，返回删除行数。 */
export function transClear(paperId) {
  assertPaperId(paperId)
  const handle = getDb()
  return handle.tx(() => handle.transDeleteAll(paperId))
}

/* ------------------------------------------------------------------ 任务日志 */

/** 追加一条任务日志，返回自增 seq（单调递增，clear 之后也不复用）。 */
export function jobAppend(paperId, event) {
  assertPaperId(paperId)
  const src = event && typeof event === 'object' ? event : {}
  const level = src.level === 'warn' || src.level === 'error' ? src.level : 'info'
  const kind = src.kind === null || src.kind === undefined || src.kind === '' ? 'log' : String(src.kind)
  const message = src.message === null || src.message === undefined ? '' : String(src.message)
  const extra = jsonText(src.extra, '日志的 extra ')
  const handle = getDb()
  return handle.tx(() => handle.jobInsert(paperId, { at: nowIso(), level, kind, message, extra }))
}

/**
 * 读日志：`{ events:[{seq, at, level, kind, message, extra}], lastSeq }`。
 * `after` 是 seq 游标（`seq > after`），`limit` 默认 200、夹在 1..1000。
 * `lastSeq` 是**最后一条返回事件的 seq**（没有新事件时回显 after），这样分页时下一次
 * `after=lastSeq` 不会跳过被 limit 截掉的部分。
 */
export function jobList(paperId, opts = {}) {
  assertPaperId(paperId)
  const after = toCount(opts.after, 0)
  const limit = Math.min(MAX_LIMIT, Math.max(1, toCount(opts.limit, DEFAULT_LIMIT)))
  const rows = getDb().jobRows(paperId, after, limit)
  const events = rows.map((row) => ({
    seq: Number(row.seq),
    at: row.at,
    level: row.level,
    kind: row.kind,
    message: row.message,
    extra: parseJsonValue(row.extra),
  }))
  return { events, lastSeq: events.length > 0 ? events[events.length - 1].seq : after }
}

/** 清空一篇论文的日志，返回删除条数。 */
export function jobClear(paperId) {
  assertPaperId(paperId)
  const handle = getDb()
  return handle.tx(() => handle.jobDeleteAll(paperId))
}

/* ------------------------------------------------------------------ 翻译自检 */

/**
 * 落一次自检结果（一篇论文只留最新一次）。`review` 形如
 * `{ at, mode, issues:[...], stats:{...} }`；返回落盘后的正规化对象。
 */
export function reviewPut(paperId, review) {
  assertPaperId(paperId)
  const src = review && typeof review === 'object' ? review : {}
  const at = typeof src.at === 'string' && src.at !== '' ? src.at : nowIso()
  const mode = typeof src.mode === 'string' && src.mode !== '' ? src.mode : 'both'
  const payload = {
    issues: Array.isArray(src.issues) ? src.issues : [],
    stats: src.stats && typeof src.stats === 'object' && !Array.isArray(src.stats) ? src.stats : {},
  }
  for (const [key, value] of Object.entries(src)) {
    if (key === 'at' || key === 'mode' || key === 'issues' || key === 'stats') continue
    payload[key] = value
  }
  const text = jsonText(payload, '自检结果') || '{}'
  const handle = getDb()
  handle.tx(() => handle.reviewUpsert(paperId, at, mode, text))
  return { ...payload, at, mode }
}

/** 读最新一次自检结果；没有时返回 null。 */
export function reviewGet(paperId) {
  assertPaperId(paperId)
  const row = getDb().reviewRow(paperId)
  if (!row) return null
  const parsed = parseJsonValue(row.payload)
  const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  return { ...payload, at: row.at, mode: row.mode }
}

/* ------------------------------------------------------------------ 迁移老文件 */

/**
 * 把老的 `papers/<id>/trans.json` 导进库里，**只在库里该论文一条译文都没有时才导**，
 * 所以重复调用是幂等的。`legacy` 就是 trans.json 的内容：条目可能是纯文本，也可能是
 * `{ zh, at, model }` 对象（取 zh）。返回导入条数。
 */
export function migrateTransJson(paperId, legacy) {
  assertPaperId(paperId)
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return 0
  // 老文件里可能有空译文/读不出文本的条目，迁移时跳过（app 里「没有条目」就等于没翻译）。
  const pairs = entriesToPairs(legacy.entries, false).filter(([, text]) => text !== '')
  if (pairs.length === 0) return 0
  const target = typeof legacy.target === 'string' && legacy.target.trim() !== '' ? legacy.target.trim() : DEFAULT_TARGET
  const model = modelText(legacy.model)
  const handle = getDb()
  return handle.tx(() => {
    // 检查放进事务里（SQLite 是 BEGIN IMMEDIATE），并发调用也只会导一次。
    if (handle.transCount(paperId) > 0) return 0
    return handle.transUpsert(paperId, target, model, pairs)
  })
}
