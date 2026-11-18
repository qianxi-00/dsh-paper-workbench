/**
 * MySQL Wire Protocol v10 纯 Node.js 客户端（零第三方依赖）。
 *
 * 协议覆盖：
 *   - Initial Handshake v10 解析（capability flags、plugin name、20 字节 scramble）
 *   - 可选 TLS 升级（CLIENT_SSL）
 *   - 认证插件：mysql_native_password（SHA1 双重摘要）与
 *     caching_sha2_password（fast_auth 0x03、TLS 明文发送、非 TLS 下 request_public_key(2) + RSA-OAEP-SHA1 加密）
 *   - AuthSwitchRequest (0xfe) 切换兼容
 *   - COM_PING / COM_QUERY / COM_QUIT / COM_STMT_PREPARE + COM_STMT_EXECUTE + COM_STMT_CLOSE
 *   - 完整解析 length-encoded integer/string、OK、ERR（中文错误映射）、EOF、ColumnDefinition41、Text/Binary ResultSetRow
 *   - 连接级串行互斥 + 轻量连接池 + 嵌套安全事务（BEGIN / SAVEPOINT / COMMIT / ROLLBACK）
 */
import crypto from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

const DEFAULT_PORT = 3306
const DEFAULT_CONNECT_TIMEOUT_MS = 8000
const DEFAULT_QUERY_TIMEOUT_MS = 30000
const DEFAULT_MAX_POOL_SIZE = 4
const MYSQL_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

// Capability flags
const CLIENT_LONG_PASSWORD = 0x00000001
const CLIENT_FOUND_ROWS = 0x00000002
const CLIENT_LONG_FLAG = 0x00000004
const CLIENT_CONNECT_WITH_DB = 0x00000008
const CLIENT_PROTOCOL_41 = 0x00000200
const CLIENT_SSL = 0x00000800
const CLIENT_TRANSACTIONS = 0x00002000
const CLIENT_SECURE_CONNECTION = 0x00008000
const CLIENT_MULTI_STATEMENTS = 0x00010000
const CLIENT_MULTI_RESULTS = 0x00020000
const CLIENT_PLUGIN_AUTH = 0x00080000
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000

// Charset 45 = utf8mb4_general_ci（MySQL 5.5+ / 8.0+ / MariaDB 通用）
const CHARSET_UTF8MB4 = 45

// MySQL column types
const TYPE_DECIMAL = 0x00
const TYPE_TINY = 0x01
const TYPE_SHORT = 0x02
const TYPE_LONG = 0x03
const TYPE_FLOAT = 0x04
const TYPE_DOUBLE = 0x05
const TYPE_NULL = 0x06
const TYPE_TIMESTAMP = 0x07
const TYPE_LONGLONG = 0x08
const TYPE_INT24 = 0x09
const TYPE_DATE = 0x0a
const TYPE_TIME = 0x0b
const TYPE_DATETIME = 0x0c
const TYPE_YEAR = 0x0d
const TYPE_VARCHAR = 0x0f
const TYPE_JSON = 0xf5
const TYPE_NEWDECIMAL = 0xf6
const TYPE_TINY_BLOB = 0xf9
const TYPE_MEDIUM_BLOB = 0xfa
const TYPE_LONG_BLOB = 0xfb
const TYPE_BLOB = 0xfc
const TYPE_VAR_STRING = 0xfd
const TYPE_STRING = 0xfe

const UNSIGNED_FLAG = 0x20

/** 安全引用 MySQL 标识符（表名/列名/savepoint 等）。 */
export function quoteMysqlIdent(name) {
  const raw = String(name ?? '')
  if (!MYSQL_IDENT_RE.test(raw)) {
    throw new Error('MySQL 标识符不合法：' + raw)
  }
  return '`' + raw.replace(/`/g, '``') + '`'
}

/** 严格的 SQL 字面量转义（供手工拼装诊断 SQL 时使用；主查询路径默认走 Prepared Statement）。 */
export function escapeMysqlValue(val) {
  if (val === null || val === undefined) return 'NULL'
  if (typeof val === 'boolean') return val ? '1' : '0'
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) throw new Error('SQL 参数包含非法数值（NaN 或 Infinity）')
    return String(val)
  }
  if (typeof val === 'bigint') return val.toString()
  if (val instanceof Date) return "'" + val.toISOString().slice(0, 23).replace('T', ' ') + "'"
  if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    return "X'" + Buffer.from(val).toString('hex') + "'"
  }
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val)
  let out = "'"
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i]
    if (ch === '\0') out += '\\0'
    else if (ch === '\b') out += '\\b'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\x1a') out += '\\Z'
    else if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "\\'"
    else if (ch === '"') out += '\\"'
    else out += ch
  }
  return out + "'"
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest()
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest()
}

function xorBuffers(a, b) {
  const out = Buffer.allocUnsafe(a.length)
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i % b.length]
  return out
}

function mysqlNativeAuth(password, scramble) {
  if (!password) return Buffer.alloc(0)
  const pwd = Buffer.from(password, 'utf8')
  const stage1 = sha1(pwd)
  const stage2 = sha1(stage1)
  const challenge = sha1(Buffer.concat([scramble, stage2]))
  return xorBuffers(stage1, challenge)
}

function cachingSha2Auth(password, scramble) {
  if (!password) return Buffer.alloc(0)
  const pwd = Buffer.from(password, 'utf8')
  const stage1 = sha256(pwd)
  const stage2 = sha256(stage1)
  const dig = sha256(Buffer.concat([stage2, scramble]))
  return xorBuffers(stage1, dig)
}

function writeLenEncInt(n) {
  const num = Number(n)
  if (num < 251) return Buffer.from([num])
  if (num < 65536) {
    const b = Buffer.allocUnsafe(3)
    b[0] = 0xfc
    b.writeUInt16LE(num, 1)
    return b
  }
  if (num < 16777216) {
    const b = Buffer.allocUnsafe(4)
    b[0] = 0xfd
    b[1] = num & 0xff
    b[2] = (num >> 8) & 0xff
    b[3] = (num >> 16) & 0xff
    return b
  }
  const b = Buffer.allocUnsafe(9)
  b[0] = 0xfe
  b.writeBigUInt64LE(BigInt(num), 1)
  return b
}

function readLenEncInt(buf, offset) {
  if (offset >= buf.length) return { value: 0, isNull: false, next: offset }
  const first = buf[offset]
  if (first < 0xfb) return { value: first, isNull: false, next: offset + 1 }
  if (first === 0xfb) return { value: null, isNull: true, next: offset + 1 }
  if (first === 0xfc) return { value: buf.readUInt16LE(offset + 1), isNull: false, next: offset + 3 }
  if (first === 0xfd) {
    const val = buf[offset + 1] | (buf[offset + 2] << 8) | (buf[offset + 3] << 16)
    return { value: val, isNull: false, next: offset + 4 }
  }
  const big = buf.readBigUInt64LE(offset + 1)
  return { value: Number(big), isNull: false, next: offset + 9 }
}

function readLenEncStr(buf, offset) {
  const lenInfo = readLenEncInt(buf, offset)
  if (lenInfo.isNull) return { value: null, next: lenInfo.next }
  const start = lenInfo.next
  const end = start + lenInfo.value
  return { value: buf.subarray(start, end).toString('utf8'), next: end }
}

function readCString(buf, offset) {
  const end = buf.indexOf(0, offset)
  if (end === -1) return { value: buf.subarray(offset).toString('utf8'), next: buf.length }
  return { value: buf.subarray(offset, end).toString('utf8'), next: end + 1 }
}

function parseOkPacket(payload) {
  let pos = 1
  const aff = readLenEncInt(payload, pos)
  pos = aff.next
  const ins = readLenEncInt(payload, pos)
  pos = ins.next
  const statusFlags = pos + 2 <= payload.length ? payload.readUInt16LE(pos) : 0
  pos += 2
  const warnings = pos + 2 <= payload.length ? payload.readUInt16LE(pos) : 0
  return {
    affectedRows: Number(aff.value) || 0,
    insertId: Number(ins.value) || 0,
    statusFlags,
    warnings,
  }
}

function parseErrPacket(payload) {
  const errno = payload.length >= 3 ? payload.readUInt16LE(1) : 0
  let pos = 3
  let sqlState = ''
  if (pos < payload.length && payload[pos] === 0x23 /* '#' */) {
    sqlState = payload.subarray(pos + 1, pos + 6).toString('ascii')
    pos += 6
  }
  const rawMsg = payload.subarray(pos).toString('utf8')
  let msg = rawMsg || 'MySQL 执行失败'
  if (errno === 1045 || sqlState === '28000') {
    msg = 'MySQL 认证失败：用户名或密码错误，或无权访问目标数据库'
  } else if (errno === 1049) {
    msg = 'MySQL 目标数据库不存在：' + rawMsg
  } else if (errno === 1044 || errno === 1142 || errno === 1227) {
    msg = 'MySQL 权限不足：' + rawMsg
  } else if (errno === 1146) {
    msg = 'MySQL 数据表不存在：' + rawMsg
  } else if (errno === 1062) {
    msg = 'MySQL 主键或唯一约束冲突：' + rawMsg
  } else {
    msg = `MySQL 错误 [${errno}${sqlState ? '/' + sqlState : ''}]：${rawMsg}`
  }
  const err = new Error(msg)
  err.errno = errno
  if (sqlState) err.sqlState = sqlState
  return err
}

function isEofPacket(payload) {
  return payload.length > 0 && payload[0] === 0xfe && payload.length < 9
}

function parseColumnDefinition(payload) {
  let pos = 0
  const catalog = readLenEncStr(payload, pos); pos = catalog.next
  const schema = readLenEncStr(payload, pos); pos = schema.next
  const table = readLenEncStr(payload, pos); pos = table.next
  const orgTable = readLenEncStr(payload, pos); pos = orgTable.next
  const name = readLenEncStr(payload, pos); pos = name.next
  const orgName = readLenEncStr(payload, pos); pos = orgName.next
  pos += 1 // length of fixed-length fields (0x0c)
  const charset = payload.readUInt16LE(pos); pos += 2
  const columnLength = payload.readUInt32LE(pos); pos += 4
  const columnType = payload[pos]; pos += 1
  const flags = payload.readUInt16LE(pos); pos += 2
  const decimals = payload[pos]
  return {
    catalog: catalog.value,
    schema: schema.value,
    table: table.value,
    orgTable: orgTable.value,
    name: name.value,
    orgName: orgName.value,
    charset,
    columnLength,
    columnType,
    flags,
    decimals,
  }
}

function convertTextCell(str, col) {
  if (str === null) return null
  switch (col.columnType) {
    case TYPE_TINY:
    case TYPE_SHORT:
    case TYPE_LONG:
    case TYPE_INT24:
    case TYPE_YEAR:
      if (/^-?\d+$/.test(str)) return Number.parseInt(str, 10)
      return str
    case TYPE_LONGLONG:
      if (/^-?\d+$/.test(str)) {
        const n = Number(str)
        return Number.isSafeInteger(n) ? n : str
      }
      return str
    case TYPE_FLOAT:
    case TYPE_DOUBLE: {
      const n = Number(str)
      return Number.isFinite(n) ? n : str
    }
    default:
      return str
  }
}

function parseTextRow(payload, fields) {
  let pos = 0
  const row = {}
  for (let i = 0; i < fields.length; i += 1) {
    const cell = readLenEncStr(payload, pos)
    pos = cell.next
    row[fields[i].name] = convertTextCell(cell.value, fields[i])
  }
  return row
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function parseBinaryRow(payload, fields) {
  const colCount = fields.length
  const nullBitmapLen = Math.floor((colCount + 9) / 8)
  let pos = 1 + nullBitmapLen
  const row = {}

  for (let i = 0; i < colCount; i += 1) {
    const col = fields[i]
    const bitIndex = i + 2
    const isNull = (payload[1 + (bitIndex >> 3)] & (1 << (bitIndex & 7))) !== 0
    if (isNull) {
      row[col.name] = null
      continue
    }
    const isUnsigned = (col.flags & UNSIGNED_FLAG) !== 0
    switch (col.columnType) {
      case TYPE_TINY:
        row[col.name] = isUnsigned ? payload.readUInt8(pos) : payload.readInt8(pos)
        pos += 1
        break
      case TYPE_SHORT:
      case TYPE_YEAR:
        row[col.name] = isUnsigned ? payload.readUInt16LE(pos) : payload.readInt16LE(pos)
        pos += 2
        break
      case TYPE_LONG:
      case TYPE_INT24:
        row[col.name] = isUnsigned ? payload.readUInt32LE(pos) : payload.readInt32LE(pos)
        pos += 4
        break
      case TYPE_LONGLONG: {
        const big = isUnsigned ? payload.readBigUInt64LE(pos) : payload.readBigInt64LE(pos)
        pos += 8
        const num = Number(big)
        row[col.name] = Number.isSafeInteger(num) ? num : big.toString()
        break
      }
      case TYPE_FLOAT:
        row[col.name] = payload.readFloatLE(pos)
        pos += 4
        break
      case TYPE_DOUBLE:
        row[col.name] = payload.readDoubleLE(pos)
        pos += 8
        break
      case TYPE_DATE:
      case TYPE_DATETIME:
      case TYPE_TIMESTAMP: {
        const len = payload[pos]; pos += 1
        if (len === 0) {
          row[col.name] = '0000-00-00'
        } else {
          const year = payload.readUInt16LE(pos)
          const month = payload[pos + 2]
          const day = payload[pos + 3]
          let s = `${year}-${pad2(month)}-${pad2(day)}`
          if (len >= 7) {
            s += ` ${pad2(payload[pos + 4])}:${pad2(payload[pos + 5])}:${pad2(payload[pos + 6])}`
          }
          if (len >= 11) {
            const us = payload.readUInt32LE(pos + 7)
            s += '.' + String(us).padStart(6, '0')
          }
          pos += len
          row[col.name] = s
        }
        break
      }
      case TYPE_TIME: {
        const len = payload[pos]; pos += 1
        if (len === 0) {
          row[col.name] = '00:00:00'
        } else {
          const neg = payload[pos] === 1
          const days = payload.readUInt32LE(pos + 1)
          const hours = days * 24 + payload[pos + 5]
          const mins = payload[pos + 6]
          const secs = payload[pos + 7]
          pos += len
          row[col.name] = `${neg ? '-' : ''}${pad2(hours)}:${pad2(mins)}:${pad2(secs)}`
        }
        break
      }
      case TYPE_DECIMAL:
      case TYPE_NEWDECIMAL:
      case TYPE_VARCHAR:
      case TYPE_VAR_STRING:
      case TYPE_STRING:
      case TYPE_JSON:
      case TYPE_TINY_BLOB:
      case TYPE_MEDIUM_BLOB:
      case TYPE_LONG_BLOB:
      case TYPE_BLOB:
      default: {
        const lenInfo = readLenEncInt(payload, pos)
        const start = lenInfo.next
        const end = start + lenInfo.value
        const raw = payload.subarray(start, end)
        pos = end
        const isBinaryCol = col.charset === 63 && (
          col.columnType === TYPE_BLOB ||
          col.columnType === TYPE_TINY_BLOB ||
          col.columnType === TYPE_MEDIUM_BLOB ||
          col.columnType === TYPE_LONG_BLOB
        )
        row[col.name] = isBinaryCol ? Buffer.from(raw) : raw.toString('utf8')
        break
      }
    }
  }
  return row
}

function encodeStmtParam(value) {
  if (value === null || value === undefined) {
    return { isNull: true, type: TYPE_NULL, flag: 0x00, bytes: Buffer.alloc(0) }
  }
  if (typeof value === 'boolean') {
    return { isNull: false, type: TYPE_TINY, flag: 0x00, bytes: Buffer.from([value ? 1 : 0]) }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQL 参数包含非法数值（NaN 或 Infinity）')
    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      const b = Buffer.allocUnsafe(8)
      b.writeBigInt64LE(BigInt(value), 0)
      return { isNull: false, type: TYPE_LONGLONG, flag: 0x00, bytes: b }
    }
    const b = Buffer.allocUnsafe(8)
    b.writeDoubleLE(value, 0)
    return { isNull: false, type: TYPE_DOUBLE, flag: 0x00, bytes: b }
  }
  if (typeof value === 'bigint') {
    const b = Buffer.allocUnsafe(8)
    b.writeBigInt64LE(value, 0)
    return { isNull: false, type: TYPE_LONGLONG, flag: 0x00, bytes: b }
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.from(value)
    return { isNull: false, type: TYPE_LONG_BLOB, flag: 0x00, bytes: Buffer.concat([writeLenEncInt(buf.length), buf]) }
  }
  if (value instanceof Date) {
    const buf = Buffer.from(value.toISOString(), 'utf8')
    return { isNull: false, type: TYPE_VAR_STRING, flag: 0x00, bytes: Buffer.concat([writeLenEncInt(buf.length), buf]) }
  }
  if (typeof value === 'object') {
    let json
    try {
      json = JSON.stringify(value)
    } catch (error) {
      throw new Error('SQL 参数对象无法序列化为 JSON', { cause: error })
    }
    const buf = Buffer.from(json, 'utf8')
    return { isNull: false, type: TYPE_VAR_STRING, flag: 0x00, bytes: Buffer.concat([writeLenEncInt(buf.length), buf]) }
  }
  const buf = Buffer.from(String(value), 'utf8')
  return { isNull: false, type: TYPE_VAR_STRING, flag: 0x00, bytes: Buffer.concat([writeLenEncInt(buf.length), buf]) }
}

function parseMysqlSslOption(ssl) {
  if (!ssl || ssl === 'disable') return { enabled: false, fallback: false, tlsOptions: {} }
  if (ssl === true || ssl === 'require') {
    return { enabled: true, fallback: false, tlsOptions: { rejectUnauthorized: false } }
  }
  if (ssl === 'prefer') {
    return { enabled: true, fallback: true, tlsOptions: { rejectUnauthorized: false } }
  }
  if (ssl === 'verify-ca' || ssl === 'verify-full') {
    return { enabled: true, fallback: false, tlsOptions: { rejectUnauthorized: true } }
  }
  if (typeof ssl === 'object') {
    const mode = String(ssl.mode || '').toLowerCase()
    const enabled = ssl.enabled !== false && mode !== 'disable'
    const fallback = mode === 'prefer' || ssl.fallback === true
    const tlsOptions = { ...ssl }
    delete tlsOptions.enabled
    delete tlsOptions.fallback
    delete tlsOptions.mode
    if (tlsOptions.rejectUnauthorized === undefined) tlsOptions.rejectUnauthorized = false
    return { enabled, fallback, tlsOptions }
  }
  return { enabled: false, fallback: false, tlsOptions: {} }
}

export class MysqlClient {
  #host
  #port
  #database
  #user
  #password
  #ssl
  #connectTimeoutMs
  #queryTimeoutMs
  #socket = null
  #isSecure = false
  #rxBuf = Buffer.alloc(0)
  #multiPacketParts = []
  #packets = []
  #waiter = null
  #fatalError = null
  #connected = false
  #closed = false
  #queue = Promise.resolve()
  #txDepth = 0
  #serverVersion = null
  #serverCaps = 0
  #connectionId = 0

  constructor(options = {}) {
    this.#host = String(options.host || '127.0.0.1').trim() || '127.0.0.1'
    const portNum = Number(options.port ?? DEFAULT_PORT)
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      throw new Error('MySQL 端口号不合法：' + String(options.port))
    }
    this.#port = portNum
    this.#database = options.database ? String(options.database) : ''
    this.#user = String(options.user || 'root')
    // 密码保存在私有字段中，严禁拼入任何错误文案或对外日志
    this.#password = options.password === undefined || options.password === null ? '' : String(options.password)
    this.#ssl = parseMysqlSslOption(options.ssl)
    this.#connectTimeoutMs = Math.max(200, Number(options.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS)
    this.#queryTimeoutMs = Math.max(500, Number(options.queryTimeoutMs) || DEFAULT_QUERY_TIMEOUT_MS)
  }

  get connected() {
    return this.#connected && !this.#closed && this.#socket && !this.#socket.destroyed
  }

  get serverVersion() {
    return this.#serverVersion
  }

  get connectionId() {
    return this.#connectionId
  }

  async connect() {
    if (this.connected) return this
    if (this.#closed) throw new Error('MySQL 连接已关闭，不能重复打开')

    const tcpSocket = await new Promise((resolve, reject) => {
      let settled = false
      const sock = net.createConnection({ host: this.#host, port: this.#port })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        sock.destroy()
        reject(new Error(`连接 MySQL 超时（${this.#host}:${this.#port}，超过 ${this.#connectTimeoutMs}ms）`))
      }, this.#connectTimeoutMs)
      timer.unref?.()

      sock.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(sock)
      })
      sock.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        sock.destroy()
        reject(new Error(`无法连接 MySQL（${this.#host}:${this.#port}）：${err.message}`))
      })
    })

    this.#bindSocket(tcpSocket)

    try {
      await this.#handshakeAndAuthenticate()
      this.#connected = true
      return this
    } catch (error) {
      await this.close().catch(() => {})
      throw error
    }
  }

  #bindSocket(socket) {
    this.#socket = socket
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('error', (err) => {
      this.#failAll(new Error(`MySQL 连接异常（${this.#host}:${this.#port}）：${err.message}`))
    })
    socket.on('close', () => {
      this.#connected = false
      this.#failAll(new Error(`MySQL 连接已断开（${this.#host}:${this.#port}）`))
    })
  }

  #failAll(err) {
    if (!this.#fatalError) this.#fatalError = err
    if (this.#waiter) {
      const w = this.#waiter
      this.#waiter = null
      clearTimeout(w.timer)
      w.reject(err)
    }
  }

  #onData(chunk) {
    if (!chunk || chunk.length === 0) return
    this.#rxBuf = this.#rxBuf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#rxBuf, chunk])

    while (this.#rxBuf.length >= 4) {
      const payloadLen = this.#rxBuf[0] | (this.#rxBuf[1] << 8) | (this.#rxBuf[2] << 16)
      const seqId = this.#rxBuf[3]
      const total = 4 + payloadLen
      if (this.#rxBuf.length < total) break
      const part = Buffer.from(this.#rxBuf.subarray(4, total))
      this.#rxBuf = this.#rxBuf.length === total ? Buffer.alloc(0) : this.#rxBuf.subarray(total)

      if (payloadLen === 0xffffff) {
        this.#multiPacketParts.push(part)
        continue
      }
      const payload = this.#multiPacketParts.length > 0
        ? Buffer.concat([...this.#multiPacketParts, part])
        : part
      this.#multiPacketParts = []

      const pkt = { seqId, payload }
      if (this.#waiter) {
        const w = this.#waiter
        this.#waiter = null
        clearTimeout(w.timer)
        w.resolve(pkt)
      } else {
        this.#packets.push(pkt)
      }
    }
  }

  #readPacket(timeoutMs) {
    if (this.#packets.length > 0) {
      return Promise.resolve(this.#packets.shift())
    }
    if (this.#fatalError) {
      return Promise.reject(this.#fatalError)
    }
    if (!this.#socket || this.#socket.destroyed) {
      return Promise.reject(new Error('MySQL 连接已关闭'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#waiter && this.#waiter.resolve === resolve) {
          this.#waiter = null
          this.#socket?.destroy()
          reject(new Error(`MySQL 响应超时（超过 ${timeoutMs}ms）`))
        }
      }, timeoutMs)
      timer.unref?.()
      this.#waiter = { resolve, reject, timer }
    })
  }

  #writePacket(payload, seqId = 0) {
    let offset = 0
    let seq = seqId & 0xff
    do {
      const sliceLen = Math.min(0xffffff, payload.length - offset)
      const frame = Buffer.allocUnsafe(4 + sliceLen)
      frame[0] = sliceLen & 0xff
      frame[1] = (sliceLen >> 8) & 0xff
      frame[2] = (sliceLen >> 16) & 0xff
      frame[3] = seq
      if (sliceLen > 0) payload.copy(frame, 4, offset, offset + sliceLen)
      this.#socket.write(frame)
      offset += sliceLen
      seq = (seq + 1) & 0xff
    } while (offset < payload.length)
    return seq
  }

  #parseHandshakeV10(payload) {
    if (payload.length < 1) throw new Error('MySQL 握手包为空')
    if (payload[0] === 0xff) throw parseErrPacket(payload)
    const protocolVersion = payload[0]
    if (protocolVersion !== 10) {
      throw new Error('不支持的 MySQL 握手协议版本：' + protocolVersion)
    }
    let pos = 1
    const ver = readCString(payload, pos)
    pos = ver.next
    const connectionId = payload.readUInt32LE(pos)
    pos += 4
    const authPart1 = payload.subarray(pos, pos + 8)
    pos += 8
    pos += 1 // filler 0x00
    const capLow = payload.readUInt16LE(pos)
    pos += 2
    pos += 1 // server charset
    pos += 2 // status flags
    const capHigh = payload.readUInt16LE(pos)
    pos += 2
    const serverCaps = ((capHigh << 16) | capLow) >>> 0
    const authPluginDataLen = payload[pos]
    pos += 1
    pos += 10 // reserved

    let authPart2 = Buffer.alloc(0)
    if (serverCaps & CLIENT_SECURE_CONNECTION) {
      const part2Len = Math.max(13, authPluginDataLen - 8)
      const slice = payload.subarray(pos, Math.min(payload.length, pos + part2Len))
      pos += slice.length
      // 第 13 字节通常是结尾 0x00
      authPart2 = slice.length > 0 && slice[slice.length - 1] === 0 ? slice.subarray(0, slice.length - 1) : slice
    }
    const scramble = Buffer.concat([authPart1, authPart2]).subarray(0, 20)

    let authPluginName = 'mysql_native_password'
    if ((serverCaps & CLIENT_PLUGIN_AUTH) && pos < payload.length) {
      const p = readCString(payload, pos)
      if (p.value) authPluginName = p.value
    }

    return { serverVersion: ver.value, connectionId, serverCaps, scramble, authPluginName }
  }

  #computeAuthResponse(pluginName, scramble) {
    if (pluginName === 'caching_sha2_password') {
      return cachingSha2Auth(this.#password, scramble)
    }
    if (pluginName === 'mysql_native_password' || !pluginName) {
      return mysqlNativeAuth(this.#password, scramble)
    }
    // 未知插件时先按 caching_sha2_password 或空字节发送，交由服务端 AuthSwitchRequest 切换
    return cachingSha2Auth(this.#password, scramble)
  }

  async #upgradeTls() {
    const plain = this.#socket
    plain.removeAllListeners('data')
    plain.removeAllListeners('error')
    plain.removeAllListeners('close')

    const tlsSocket = await new Promise((resolve, reject) => {
      let settled = false
      const secure = tls.connect({
        socket: plain,
        servername: net.isIP(this.#host) ? undefined : this.#host,
        ...this.#ssl.tlsOptions,
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        secure.destroy()
        reject(new Error('MySQL TLS 握手超时'))
      }, this.#connectTimeoutMs)
      timer.unref?.()

      secure.once('secureConnect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(secure)
      })
      secure.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        secure.destroy()
        reject(new Error('MySQL TLS 握手失败：' + err.message))
      })
    })
    this.#isSecure = true
    this.#bindSocket(tlsSocket)
  }

  async #handshakeAndAuthenticate() {
    const initPkt = await this.#readPacket(this.#connectTimeoutMs)
    const hs = this.#parseHandshakeV10(initPkt.payload)
    this.#serverVersion = hs.serverVersion
    this.#connectionId = hs.connectionId
    this.#serverCaps = hs.serverCaps

    let clientCaps =
      CLIENT_LONG_PASSWORD |
      CLIENT_FOUND_ROWS |
      CLIENT_LONG_FLAG |
      CLIENT_PROTOCOL_41 |
      CLIENT_TRANSACTIONS |
      CLIENT_SECURE_CONNECTION |
      CLIENT_MULTI_RESULTS |
      CLIENT_PLUGIN_AUTH |
      CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA
    if (this.#database) clientCaps |= CLIENT_CONNECT_WITH_DB
    if (hs.serverCaps & CLIENT_MULTI_STATEMENTS) clientCaps |= CLIENT_MULTI_STATEMENTS

    let seqId = (initPkt.seqId + 1) & 0xff
    if (this.#ssl.enabled) {
      if (hs.serverCaps & CLIENT_SSL) {
        const sslReq = Buffer.alloc(32)
        sslReq.writeUInt32LE((clientCaps | CLIENT_SSL) >>> 0, 0)
        sslReq.writeUInt32LE(0x01000000, 4)
        sslReq[8] = CHARSET_UTF8MB4
        seqId = this.#writePacket(sslReq, seqId)
        await this.#upgradeTls()
      } else if (!this.#ssl.fallback) {
        throw new Error('MySQL 服务器未启用 SSL/TLS 加密连接，请关闭 ssl 选项或启用服务端 TLS')
      }
    }

    let activePlugin = hs.authPluginName
    let activeScramble = hs.scramble
    const authResp = this.#computeAuthResponse(activePlugin, activeScramble)

    const userBuf = Buffer.from(this.#user + '\0', 'utf8')
    const dbBuf = this.#database ? Buffer.from(this.#database + '\0', 'utf8') : Buffer.alloc(0)
    const pluginBuf = Buffer.from(activePlugin + '\0', 'utf8')

    let authField
    if (hs.serverCaps & CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA) {
      authField = Buffer.concat([writeLenEncInt(authResp.length), authResp])
    } else if (hs.serverCaps & CLIENT_SECURE_CONNECTION) {
      authField = Buffer.concat([Buffer.from([authResp.length]), authResp])
    } else {
      authField = Buffer.concat([authResp, Buffer.from([0])])
    }

    const fixedHeader = Buffer.alloc(32)
    fixedHeader.writeUInt32LE(clientCaps >>> 0, 0)
    fixedHeader.writeUInt32LE(0x01000000, 4)
    fixedHeader[8] = CHARSET_UTF8MB4

    const handshakeResp = Buffer.concat([fixedHeader, userBuf, authField, dbBuf, pluginBuf])
    this.#writePacket(handshakeResp, seqId)

    // 认证往返循环（支持 OK / ERR / AuthSwitchRequest / caching_sha2_password）
    while (true) {
      const pkt = await this.#readPacket(this.#connectTimeoutMs)
      const payload = pkt.payload
      if (payload.length === 0) throw new Error('MySQL 认证阶段收到空数据包')
      const head = payload[0]

      if (head === 0x00) {
        return
      }
      if (head === 0xff) {
        throw parseErrPacket(payload)
      }
      if (head === 0xfe) {
        // AuthSwitchRequest
        const pluginInfo = readCString(payload, 1)
        activePlugin = pluginInfo.value
        const rawScramble = payload.subarray(pluginInfo.next)
        activeScramble = rawScramble.length > 20 && rawScramble[rawScramble.length - 1] === 0
          ? rawScramble.subarray(0, 20)
          : rawScramble.subarray(0, 20)
        const nextResp = this.#computeAuthResponse(activePlugin, activeScramble)
        this.#writePacket(nextResp, (pkt.seqId + 1) & 0xff)
        continue
      }
      if (head === 0x01) {
        // AuthMoreData (caching_sha2_password)
        const status = payload[1]
        if (status === 0x03) {
          // fast_auth_success，继续读后续 OK 包
          continue
        }
        if (status === 0x04) {
          // perform_full_authentication
          const pwdWithNul = Buffer.concat([Buffer.from(this.#password, 'utf8'), Buffer.from([0])])
          if (this.#isSecure) {
            this.#writePacket(pwdWithNul, (pkt.seqId + 1) & 0xff)
            continue
          }
          // 非 TLS 连接：发 0x02 请求服务端公钥，并用 RSA-OAEP-SHA1 加密 (password\0 XOR scramble)
          this.#writePacket(Buffer.from([0x02]), (pkt.seqId + 1) & 0xff)
          const pubPkt = await this.#readPacket(this.#connectTimeoutMs)
          if (pubPkt.payload[0] === 0xff) throw parseErrPacket(pubPkt.payload)
          if (pubPkt.payload[0] !== 0x01) {
            throw new Error('MySQL caching_sha2_password 请求公钥返回异常包类型：0x' + pubPkt.payload[0].toString(16))
          }
          const pem = pubPkt.payload.subarray(1).toString('utf8').replace(/\0+$/, '')
          const xored = xorBuffers(pwdWithNul, activeScramble)
          let encrypted
          try {
            encrypted = crypto.publicEncrypt(
              { key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
              xored,
            )
          } catch (error) {
            throw new Error('MySQL caching_sha2_password 公钥加密失败', { cause: error })
          }
          this.#writePacket(encrypted, (pubPkt.seqId + 1) & 0xff)
          continue
        }
        throw new Error('MySQL 认证收到未知 AuthMoreData 状态：0x' + Number(status).toString(16))
      }
      throw new Error('MySQL 认证收到未知响应包类型：0x' + head.toString(16))
    }
  }

  #enqueue(task) {
    const run = this.#queue.then(task, task)
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  async #readResultSet(firstPacket, binary) {
    const first = firstPacket.payload
    if (first[0] === 0x00) {
      const ok = parseOkPacket(first)
      return { rows: [], fields: [], affectedRows: ok.affectedRows, insertId: ok.insertId }
    }
    if (first[0] === 0xff) {
      throw parseErrPacket(first)
    }
    if (first[0] === 0xfb) {
      throw new Error('出于安全限制，MySQL 客户端禁止 LOCAL INFILE 请求')
    }

    const colCountInfo = readLenEncInt(first, 0)
    const colCount = colCountInfo.value
    const fields = []
    for (let i = 0; i < colCount; i += 1) {
      const colPkt = await this.#readPacket(this.#queryTimeoutMs)
      if (colPkt.payload[0] === 0xff) throw parseErrPacket(colPkt.payload)
      fields.push(parseColumnDefinition(colPkt.payload))
    }

    const eofAfterCols = await this.#readPacket(this.#queryTimeoutMs)
    if (eofAfterCols.payload[0] === 0xff) throw parseErrPacket(eofAfterCols.payload)

    const rows = []
    while (true) {
      const rowPkt = await this.#readPacket(this.#queryTimeoutMs)
      const p = rowPkt.payload
      if (p[0] === 0xff) throw parseErrPacket(p)
      if (isEofPacket(p)) break
      if (binary) {
        if (p[0] !== 0x00) throw new Error('MySQL Binary ResultSet 行包头非法：0x' + p[0].toString(16))
        rows.push(parseBinaryRow(p, fields))
      } else {
        rows.push(parseTextRow(p, fields))
      }
    }

    return { rows, fields, affectedRows: 0, insertId: 0 }
  }

  async simpleQuery(sql) {
    const sqlText = String(sql ?? '')
    return this.#enqueue(async () => {
      if (!this.connected) await this.connect()
      const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(sqlText, 'utf8')])
      this.#writePacket(payload, 0)
      const first = await this.#readPacket(this.#queryTimeoutMs)
      return this.#readResultSet(first, false)
    })
  }

  /**
   * 参数化安全执行（COM_STMT_PREPARE + COM_STMT_EXECUTE + COM_STMT_CLOSE）。
   * 无参数时直走 COM_QUERY（兼容多句 DDL 与非预处理语句）。
   */
  async query(sql, params = []) {
    const sqlText = String(sql ?? '')
    const list = Array.isArray(params) ? params : []
    if (list.length === 0) {
      return this.simpleQuery(sqlText)
    }

    return this.#enqueue(async () => {
      if (!this.connected) await this.connect()

      // 1. COM_STMT_PREPARE (0x16)
      const prepPayload = Buffer.concat([Buffer.from([0x16]), Buffer.from(sqlText, 'utf8')])
      this.#writePacket(prepPayload, 0)

      const prepResp = await this.#readPacket(this.#queryTimeoutMs)
      const pp = prepResp.payload
      if (pp[0] === 0xff) throw parseErrPacket(pp)
      if (pp[0] !== 0x00 || pp.length < 12) {
        throw new Error('MySQL COM_STMT_PREPARE 响应格式非法')
      }

      const stmtId = pp.readUInt32LE(1)
      const numColumns = pp.readUInt16LE(5)
      const numParams = pp.readUInt16LE(7)

      try {
        if (numParams > 0) {
          for (let i = 0; i < numParams; i += 1) {
            const pDef = await this.#readPacket(this.#queryTimeoutMs)
            if (pDef.payload[0] === 0xff) throw parseErrPacket(pDef.payload)
          }
          const eofParams = await this.#readPacket(this.#queryTimeoutMs)
          if (eofParams.payload[0] === 0xff) throw parseErrPacket(eofParams.payload)
        }
        if (numColumns > 0) {
          for (let i = 0; i < numColumns; i += 1) {
            const cDef = await this.#readPacket(this.#queryTimeoutMs)
            if (cDef.payload[0] === 0xff) throw parseErrPacket(cDef.payload)
          }
          const eofCols = await this.#readPacket(this.#queryTimeoutMs)
          if (eofCols.payload[0] === 0xff) throw parseErrPacket(eofCols.payload)
        }

        // 2. COM_STMT_EXECUTE (0x17)
        const header = Buffer.allocUnsafe(10)
        header[0] = 0x17
        header.writeUInt32LE(stmtId, 1)
        header[5] = 0x00 // CURSOR_TYPE_NO_CURSOR
        header.writeUInt32LE(1, 6) // iteration_count = 1

        const parts = [header]
        if (numParams > 0) {
          if (list.length < numParams) {
            throw new Error(`MySQL 预处理参数数量不足：需要 ${numParams} 个，实际传入 ${list.length} 个`)
          }
          const encoded = list.slice(0, numParams).map(encodeStmtParam)
          const nullBitmap = Buffer.alloc(Math.floor((numParams + 7) / 8))
          const typesBuf = Buffer.allocUnsafe(numParams * 2)
          const valuesParts = []

          for (let i = 0; i < numParams; i += 1) {
            const item = encoded[i]
            if (item.isNull) {
              nullBitmap[i >> 3] |= (1 << (i & 7))
            } else {
              valuesParts.push(item.bytes)
            }
            typesBuf[i * 2] = item.type
            typesBuf[i * 2 + 1] = item.flag
          }

          parts.push(nullBitmap, Buffer.from([0x01]), typesBuf, ...valuesParts)
        }

        this.#writePacket(Buffer.concat(parts), 0)
        const execResp = await this.#readPacket(this.#queryTimeoutMs)
        return await this.#readResultSet(execResp, true)
      } finally {
        if (this.connected) {
          const closeBuf = Buffer.allocUnsafe(5)
          closeBuf[0] = 0x19
          closeBuf.writeUInt32LE(stmtId, 1)
          try { this.#writePacket(closeBuf, 0) } catch { /* 关闭预处理语句失败不影响结果 */ }
        }
      }
    })
  }

  async execute(sql, params = []) {
    return this.query(sql, params)
  }

  async ping() {
    const start = Date.now()
    await this.#enqueue(async () => {
      if (!this.connected) await this.connect()
      this.#writePacket(Buffer.from([0x0e]), 0) // COM_PING
      const pkt = await this.#readPacket(this.#queryTimeoutMs)
      if (pkt.payload[0] === 0xff) throw parseErrPacket(pkt.payload)
    })
    return { ok: true, latencyMs: Date.now() - start, serverVersion: this.#serverVersion }
  }

  async tx(fn) {
    if (typeof fn !== 'function') throw new Error('tx(fn) 需要传入异步回调函数')
    if (this.#txDepth > 0) {
      const sp = 'pb_sp_' + this.#txDepth
      await this.simpleQuery('SAVEPOINT ' + quoteMysqlIdent(sp))
      this.#txDepth += 1
      try {
        const out = await fn(this)
        await this.simpleQuery('RELEASE SAVEPOINT ' + quoteMysqlIdent(sp))
        return out
      } catch (error) {
        await this.simpleQuery('ROLLBACK TO SAVEPOINT ' + quoteMysqlIdent(sp)).catch(() => {})
        throw error
      } finally {
        this.#txDepth -= 1
      }
    }

    await this.simpleQuery('BEGIN')
    this.#txDepth = 1
    try {
      const out = await fn(this)
      await this.simpleQuery('COMMIT')
      return out
    } catch (error) {
      await this.simpleQuery('ROLLBACK').catch(() => {})
      throw error
    } finally {
      this.#txDepth = 0
    }
  }

  async close() {
    const wasConnected = this.#connected
    this.#closed = true
    this.#connected = false
    const sock = this.#socket
    this.#socket = null
    if (!sock || sock.destroyed) return false
    if (wasConnected && sock.writable) {
      try {
        // COM_QUIT (0x01)
        const frame = Buffer.from([1, 0, 0, 0, 0x01])
        sock.write(frame)
      } catch {
        /* 忽略写退出包失败 */
      }
    }
    sock.destroy()
    return true
  }
}

export class MysqlPool {
  #options
  #maxSize
  #idle = []
  #inUse = new Set()
  #waiters = []
  #closed = false
  #serverVersion = null

  constructor(options = {}) {
    this.#options = { ...options }
    this.#maxSize = Math.max(1, Math.min(32, Number(options.maxPoolSize) || DEFAULT_MAX_POOL_SIZE))
  }

  get serverVersion() {
    return this.#serverVersion
  }

  async #acquire() {
    if (this.#closed) throw new Error('MySQL 连接池已关闭')

    while (this.#idle.length > 0) {
      const client = this.#idle.pop()
      if (client.connected) {
        this.#inUse.add(client)
        return client
      }
      await client.close().catch(() => {})
    }

    if (this.#inUse.size < this.#maxSize) {
      const client = new MysqlClient(this.#options)
      await client.connect()
      if (client.serverVersion) this.#serverVersion = client.serverVersion
      this.#inUse.add(client)
      return client
    }

    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  #release(client, broken = false) {
    this.#inUse.delete(client)

    const shouldDiscard = broken || this.#closed || !client.connected
    if (shouldDiscard) {
      client.close().catch(() => {})
      if (!this.#closed && this.#waiters.length > 0) {
        const next = this.#waiters.shift()
        this.#acquire().then(next.resolve, next.reject)
      }
      return
    }

    if (this.#waiters.length > 0) {
      const next = this.#waiters.shift()
      this.#inUse.add(client)
      next.resolve(client)
      return
    }

    this.#idle.push(client)
  }

  async withConnection(fn) {
    const client = await this.#acquire()
    let broken = false
    try {
      return await fn(client)
    } catch (error) {
      if (!client.connected) broken = true
      throw error
    } finally {
      this.#release(client, broken)
    }
  }

  async query(sql, params = []) {
    return this.withConnection((conn) => conn.query(sql, params))
  }

  async simpleQuery(sql) {
    return this.withConnection((conn) => conn.simpleQuery(sql))
  }

  async execute(sql, params = []) {
    return this.withConnection((conn) => conn.execute(sql, params))
  }

  async ping() {
    return this.withConnection((conn) => conn.ping())
  }

  async tx(fn) {
    return this.withConnection((conn) => conn.tx(fn))
  }

  async close() {
    this.#closed = true
    while (this.#waiters.length > 0) {
      const w = this.#waiters.shift()
      w.reject(new Error('MySQL 连接池正在关闭'))
    }
    const all = [...this.#idle, ...this.#inUse]
    this.#idle = []
    this.#inUse.clear()
    await Promise.all(all.map((c) => c.close().catch(() => {})))
    return true
  }
}

export function createMysqlClient(options) {
  return new MysqlClient(options)
}

export function createMysqlPool(options) {
  return new MysqlPool(options)
}
