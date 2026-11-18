/**
 * PostgreSQL Wire Protocol v3 纯 Node.js 客户端（零第三方依赖）。
 *
 * 协议覆盖：
 *   - SSLRequest（'S' 升级 node:tls；'prefer' 模式下 'N' 回退明文 TCP）
 *   - StartupMessage (protocol 3.0)
 *   - 认证：Trust (0)、CleartextPassword (3)、MD5Password (5)、SASL SCRAM-SHA-256 (10/11/12)
 *   - Simple Query ('Q') 与 Extended Query ('P' + 'B' + 'E' + 'S'，参数化 $1, $2, ...)
 *   - 完整解码 RowDescription / DataRow / CommandComplete / ReadyForQuery / ErrorResponse / ParameterStatus / NoticeResponse
 *   - 连接级串行互斥 + 轻量连接池 + 嵌套安全事务（BEGIN / SAVEPOINT / COMMIT / ROLLBACK）
 */
import crypto from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

const DEFAULT_PORT = 5432
const DEFAULT_CONNECT_TIMEOUT_MS = 8000
const DEFAULT_QUERY_TIMEOUT_MS = 30000
const DEFAULT_MAX_POOL_SIZE = 4
const PG_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** 安全引用 PostgreSQL 标识符（表名/列名/savepoint 等）。 */
export function quotePgIdent(name) {
  const raw = String(name ?? '')
  if (!PG_IDENT_RE.test(raw)) {
    throw new Error('PostgreSQL 标识符不合法：' + raw)
  }
  return '"' + raw.replace(/"/g, '""') + '"'
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest()
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}

function md5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex')
}

function xorBuffers(a, b) {
  const out = Buffer.allocUnsafe(a.length)
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i]
  return out
}

function cString(text) {
  return Buffer.from(String(text) + '\0', 'utf8')
}

function frameMessage(typeChar, bodyBuffers) {
  const body = bodyBuffers.length === 1 ? bodyBuffers[0] : Buffer.concat(bodyBuffers)
  const out = Buffer.allocUnsafe(5 + body.length)
  out[0] = typeChar.charCodeAt(0)
  out.writeInt32BE(4 + body.length, 1)
  body.copy(out, 5)
  return out
}

function parseCString(buf, offset) {
  const end = buf.indexOf(0, offset)
  if (end === -1) return { value: buf.subarray(offset).toString('utf8'), next: buf.length }
  return { value: buf.subarray(offset, end).toString('utf8'), next: end + 1 }
}

function parsePgFields(payload) {
  const fields = {}
  let pos = 0
  while (pos < payload.length) {
    const code = payload[pos]
    if (code === 0) break
    pos += 1
    const { value, next } = parseCString(payload, pos)
    fields[String.fromCharCode(code)] = value
    pos = next
  }
  return fields
}

function toChinesePgError(fields) {
  const code = fields.C || ''
  const detail = fields.D ? '（' + fields.D + '）' : ''
  const rawMsg = fields.M || 'PostgreSQL 执行失败'
  let msg = rawMsg
  if (code === '28P01' || code === '28000') {
    msg = 'PostgreSQL 认证失败：用户名或密码错误，或无权访问目标数据库'
  } else if (code === '3D000') {
    msg = 'PostgreSQL 目标数据库不存在：' + rawMsg
  } else if (code === '42501') {
    msg = 'PostgreSQL 权限不足：' + rawMsg
  } else if (code === '42P01') {
    msg = 'PostgreSQL 数据表不存在：' + rawMsg
  } else if (code === '23505') {
    msg = 'PostgreSQL 主键或唯一约束冲突：' + rawMsg
  } else {
    msg = 'PostgreSQL 错误' + (code ? ' [' + code + ']' : '') + '：' + rawMsg + detail
  }
  const err = new Error(msg)
  if (code) err.code = code
  if (fields.S) err.severity = fields.S
  if (fields.D) err.detail = fields.D
  if (fields.H) err.hint = fields.H
  return err
}

function parsePgSslOption(ssl) {
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

function parsePgValue(str, typeOid) {
  if (str === null) return null
  switch (typeOid) {
    case 16: // bool
      return str === 't' || str === 'true' || str === '1'
    case 21: // int2
    case 23: // int4
    case 26: // oid
      if (/^-?\d+$/.test(str)) return Number.parseInt(str, 10)
      return str
    case 20: // int8
      if (/^-?\d+$/.test(str)) {
        const n = Number(str)
        return Number.isSafeInteger(n) ? n : str
      }
      return str
    case 700: // float4
    case 701: // float8
    {
      const n = Number(str)
      return Number.isFinite(n) ? n : str
    }
    case 17: // bytea
      if (str.startsWith('\\x')) return Buffer.from(str.slice(2), 'hex')
      return Buffer.from(str, 'utf8')
    default:
      return str
  }
}

function encodePgParam(value) {
  if (value === null || value === undefined) return { format: 0, bytes: null }
  if (Buffer.isBuffer(value)) return { format: 1, bytes: value }
  if (value instanceof Uint8Array) return { format: 1, bytes: Buffer.from(value) }
  if (typeof value === 'boolean') return { format: 0, bytes: Buffer.from(value ? 't' : 'f', 'utf8') }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQL 参数包含非法数值（NaN 或 Infinity）')
    return { format: 0, bytes: Buffer.from(String(value), 'utf8') }
  }
  if (typeof value === 'bigint') return { format: 0, bytes: Buffer.from(value.toString(), 'utf8') }
  if (value instanceof Date) return { format: 0, bytes: Buffer.from(value.toISOString(), 'utf8') }
  if (typeof value === 'object') {
    try {
      return { format: 0, bytes: Buffer.from(JSON.stringify(value), 'utf8') }
    } catch (error) {
      throw new Error('SQL 参数对象无法序列化为 JSON', { cause: error })
    }
  }
  return { format: 0, bytes: Buffer.from(String(value), 'utf8') }
}

function parseCommandComplete(tag) {
  const parts = String(tag || '').trim().split(/\s+/)
  const command = (parts[0] || '').toUpperCase()
  const last = parts[parts.length - 1]
  const rowCount = /^\d+$/.test(last) ? Number.parseInt(last, 10) : 0
  return { command, rowCount }
}

function parseScramAttributes(text) {
  const map = new Map()
  for (const part of String(text || '').split(',')) {
    const eqIdx = part.indexOf('=')
    if (eqIdx <= 0) continue
    map.set(part.slice(0, eqIdx), part.slice(eqIdx + 1))
  }
  return map
}

export class PgClient {
  #host
  #port
  #database
  #user
  #password
  #ssl
  #connectTimeoutMs
  #queryTimeoutMs
  #onNotice
  #socket = null
  #rxBuf = Buffer.alloc(0)
  #connected = false
  #closed = false
  #sslWaiter = null
  #packetHandler = null
  #queue = Promise.resolve()
  #txDepth = 0
  #txStatus = 'I'
  #parameters = {}
  #backendKey = null

  constructor(options = {}) {
    this.#host = String(options.host || '127.0.0.1').trim() || '127.0.0.1'
    const portNum = Number(options.port ?? DEFAULT_PORT)
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      throw new Error('PostgreSQL 端口号不合法：' + String(options.port))
    }
    this.#port = portNum
    this.#database = String(options.database || 'postgres')
    this.#user = String(options.user || 'postgres')
    // 密码保存在私有字段中，严禁拼入任何错误文案或对外日志
    this.#password = options.password === undefined || options.password === null ? '' : String(options.password)
    this.#ssl = parsePgSslOption(options.ssl)
    this.#connectTimeoutMs = Math.max(200, Number(options.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS)
    this.#queryTimeoutMs = Math.max(500, Number(options.queryTimeoutMs) || DEFAULT_QUERY_TIMEOUT_MS)
    this.#onNotice = typeof options.onNotice === 'function' ? options.onNotice : null
  }

  get connected() {
    return this.#connected && !this.#closed && this.#socket && !this.#socket.destroyed
  }

  get parameters() {
    return { ...this.#parameters }
  }

  get serverVersion() {
    return this.#parameters.server_version || null
  }

  get transactionStatus() {
    return this.#txStatus
  }

  get backendKey() {
    return this.#backendKey ? { ...this.#backendKey } : null
  }

  async connect() {
    if (this.connected) return this
    if (this.#closed) throw new Error('PostgreSQL 连接已关闭，不能重复打开')

    const tcpSocket = await new Promise((resolve, reject) => {
      let settled = false
      const sock = net.createConnection({ host: this.#host, port: this.#port })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        sock.destroy()
        reject(new Error(`连接 PostgreSQL 超时（${this.#host}:${this.#port}，超过 ${this.#connectTimeoutMs}ms）`))
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
        reject(new Error(`无法连接 PostgreSQL（${this.#host}:${this.#port}）：${err.message}`))
      })
    })

    this.#bindSocket(tcpSocket)

    try {
      if (this.#ssl.enabled) {
        const sslReply = await this.#sendSslRequest()
        if (sslReply === 'S') {
          await this.#upgradeTls(tcpSocket)
        } else if (sslReply === 'N') {
          if (!this.#ssl.fallback) {
            throw new Error('PostgreSQL 服务器不支持 SSL/TLS 加密连接，请关闭 ssl 选项或使用 ssl: "prefer"')
          }
        } else {
          throw new Error('PostgreSQL SSL 握手收到未知响应字节：' + String(sslReply))
        }
      }

      await this.#startupAndAuthenticate()
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
      const wrapped = new Error(`PostgreSQL 连接异常（${this.#host}:${this.#port}）：${err.message}`)
      this.#failInFlight(wrapped)
    })
    socket.on('close', () => {
      this.#connected = false
      this.#failInFlight(new Error(`PostgreSQL 连接已断开（${this.#host}:${this.#port}）`))
    })
  }

  #failInFlight(error) {
    if (this.#sslWaiter) {
      const w = this.#sslWaiter
      this.#sslWaiter = null
      w.reject(error)
    }
    if (this.#packetHandler) {
      const h = this.#packetHandler
      this.#packetHandler = null
      h.onFatal(error)
    }
  }

  #onData(chunk) {
    if (!chunk || chunk.length === 0) return
    this.#rxBuf = this.#rxBuf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#rxBuf, chunk])

    if (this.#sslWaiter) {
      const byte = String.fromCharCode(this.#rxBuf[0])
      this.#rxBuf = this.#rxBuf.length > 1 ? this.#rxBuf.subarray(1) : Buffer.alloc(0)
      const waiter = this.#sslWaiter
      this.#sslWaiter = null
      waiter.resolve(byte)
      if (this.#rxBuf.length === 0) return
    }

    while (this.#rxBuf.length >= 5) {
      const type = String.fromCharCode(this.#rxBuf[0])
      const len = this.#rxBuf.readInt32BE(1)
      if (len < 4) {
        this.#failInFlight(new Error('PostgreSQL 协议帧长度非法：' + len))
        this.#socket?.destroy()
        return
      }
      const total = 1 + len
      if (this.#rxBuf.length < total) break
      const payload = this.#rxBuf.subarray(5, total)
      this.#rxBuf = this.#rxBuf.length === total ? Buffer.alloc(0) : this.#rxBuf.subarray(total)

      if (type === 'S') {
        const k = parseCString(payload, 0)
        const v = parseCString(payload, k.next)
        this.#parameters[k.value] = v.value
        continue
      }
      if (type === 'K') {
        if (payload.length >= 8) {
          this.#backendKey = { pid: payload.readInt32BE(0), secret: payload.readInt32BE(4) }
        }
        continue
      }
      if (type === 'N') {
        if (this.#onNotice) {
          try { this.#onNotice(parsePgFields(payload)) } catch { /* 忽略通知回调错误 */ }
        }
        continue
      }
      if (this.#packetHandler) {
        this.#packetHandler.onMessage(type, payload)
      }
    }
  }

  #sendSslRequest() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#sslWaiter) {
          this.#sslWaiter = null
          reject(new Error('PostgreSQL SSL 协商超时'))
        }
      }, this.#connectTimeoutMs)
      timer.unref?.()

      this.#sslWaiter = {
        resolve: (b) => { clearTimeout(timer); resolve(b) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
      const pkt = Buffer.allocUnsafe(8)
      pkt.writeInt32BE(8, 0)
      pkt.writeInt32BE(80877103, 4)
      this.#socket.write(pkt)
    })
  }

  async #upgradeTls(plainSocket) {
    plainSocket.removeAllListeners('data')
    plainSocket.removeAllListeners('error')
    plainSocket.removeAllListeners('close')

    const tlsSocket = await new Promise((resolve, reject) => {
      let settled = false
      const secure = tls.connect({
        socket: plainSocket,
        servername: net.isIP(this.#host) ? undefined : this.#host,
        ...this.#ssl.tlsOptions,
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        secure.destroy()
        reject(new Error('PostgreSQL TLS 握手超时'))
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
        reject(new Error('PostgreSQL TLS 握手失败：' + err.message))
      })
    })
    this.#bindSocket(tlsSocket)
  }

  #buildStartupPacket() {
    const parts = [
      cString('user'), cString(this.#user),
      cString('database'), cString(this.#database),
      cString('client_encoding'), cString('UTF8'),
      cString('application_name'), cString('dsh-paper-workbench'),
      Buffer.from([0]),
    ]
    const body = Buffer.concat(parts)
    const out = Buffer.allocUnsafe(8 + body.length)
    out.writeInt32BE(8 + body.length, 0)
    out.writeInt32BE(196608, 4) // protocol 3.0
    body.copy(out, 8)
    return out
  }

  #startupAndAuthenticate() {
    return new Promise((resolve, reject) => {
      let settled = false
      let scramState = null

      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#packetHandler = null
        if (err) reject(err)
        else resolve()
      }

      const timer = setTimeout(() => {
        finish(new Error(`PostgreSQL 启动与认证超时（超过 ${this.#connectTimeoutMs}ms）`))
      }, this.#connectTimeoutMs)
      timer.unref?.()

      this.#packetHandler = {
        onFatal: (err) => finish(err),
        onMessage: (type, payload) => {
          try {
            if (type === 'E') {
              finish(toChinesePgError(parsePgFields(payload)))
              return
            }
            if (type === 'Z') {
              this.#txStatus = payload.length > 0 ? String.fromCharCode(payload[0]) : 'I'
              finish()
              return
            }
            if (type !== 'R') return

            const authType = payload.readInt32BE(0)
            if (authType === 0) {
              // AuthenticationOk：继续等到 ReadyForQuery ('Z')
              return
            }
            if (authType === 3) {
              // CleartextPassword
              const pwd = Buffer.from(this.#password, 'utf8')
              this.#socket.write(frameMessage('p', [pwd, Buffer.from([0])]))
              return
            }
            if (authType === 5) {
              // MD5Password
              if (payload.length < 8) {
                finish(new Error('PostgreSQL MD5 认证盐值长度不足'))
                return
              }
              const salt = payload.subarray(4, 8)
              const inner = md5Hex(this.#password + this.#user)
              const digest = 'md5' + md5Hex(Buffer.concat([Buffer.from(inner, 'utf8'), salt]))
              this.#socket.write(frameMessage('p', [Buffer.from(digest, 'utf8'), Buffer.from([0])]))
              return
            }
            if (authType === 10) {
              // AuthenticationSASL：检查机制列表
              const mechs = []
              let pos = 4
              while (pos < payload.length) {
                const { value, next } = parseCString(payload, pos)
                pos = next
                if (value === '') break
                mechs.push(value)
              }
              if (!mechs.includes('SCRAM-SHA-256')) {
                finish(new Error('PostgreSQL 服务器仅支持未实现的 SASL 认证机制：' + mechs.join(', ')))
                return
              }
              const clientNonce = crypto.randomBytes(18).toString('base64')
              const gs2Header = 'n,,'
              const clientFirstBare = `n=,r=${clientNonce}`
              const clientFirst = gs2Header + clientFirstBare
              const clientFirstBytes = Buffer.from(clientFirst, 'utf8')
              const lenBuf = Buffer.allocUnsafe(4)
              lenBuf.writeInt32BE(clientFirstBytes.length, 0)
              scramState = { clientNonce, gs2Header, clientFirstBare, expectedServerSignature: null }
              this.#socket.write(frameMessage('p', [cString('SCRAM-SHA-256'), lenBuf, clientFirstBytes]))
              return
            }
            if (authType === 11) {
              // AuthenticationSASLContinue
              if (!scramState) {
                finish(new Error('PostgreSQL SCRAM 认证状态异常：未发送 ClientFirst'))
                return
              }
              const serverFirst = payload.subarray(4).toString('utf8')
              const attrs = parseScramAttributes(serverFirst)
              const serverNonce = attrs.get('r') || ''
              const saltB64 = attrs.get('s') || ''
              const iterRaw = Number(attrs.get('i'))
              if (!serverNonce.startsWith(scramState.clientNonce) || serverNonce.length <= scramState.clientNonce.length) {
                finish(new Error('PostgreSQL SCRAM-SHA-256 服务端随机数校验失败'))
                return
              }
              if (!saltB64 || !Number.isInteger(iterRaw) || iterRaw < 1 || iterRaw > 10000000) {
                finish(new Error('PostgreSQL SCRAM-SHA-256 服务端参数不合法'))
                return
              }
              const salt = Buffer.from(saltB64, 'base64')
              const saltedPassword = crypto.pbkdf2Sync(Buffer.from(this.#password, 'utf8'), salt, iterRaw, 32, 'sha256')
              const clientKey = hmacSha256(saltedPassword, 'Client Key')
              const storedKey = sha256(clientKey)
              const channelBinding = Buffer.from(scramState.gs2Header, 'utf8').toString('base64')
              const clientFinalWithoutProof = `c=${channelBinding},r=${serverNonce}`
              const authMessage = `${scramState.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`
              const clientSignature = hmacSha256(storedKey, authMessage)
              const clientProof = xorBuffers(clientKey, clientSignature)
              const serverKey = hmacSha256(saltedPassword, 'Server Key')
              scramState.expectedServerSignature = hmacSha256(serverKey, authMessage)
              const clientFinal = `${clientFinalWithoutProof},p=${clientProof.toString('base64')}`
              this.#socket.write(frameMessage('p', [Buffer.from(clientFinal, 'utf8')]))
              return
            }
            if (authType === 12) {
              // AuthenticationSASLFinal
              if (!scramState || !scramState.expectedServerSignature) {
                finish(new Error('PostgreSQL SCRAM 认证状态异常：未完成 ClientFinal'))
                return
              }
              const serverFinal = payload.subarray(4).toString('utf8')
              const attrs = parseScramAttributes(serverFinal)
              if (attrs.has('e')) {
                finish(new Error('PostgreSQL SCRAM-SHA-256 认证失败：' + attrs.get('e')))
                return
              }
              const sigB64 = attrs.get('v') || ''
              const actualSig = Buffer.from(sigB64, 'base64')
              if (
                actualSig.length !== scramState.expectedServerSignature.length ||
                !crypto.timingSafeEqual(actualSig, scramState.expectedServerSignature)
              ) {
                finish(new Error('PostgreSQL SCRAM-SHA-256 服务端签名验证失败'))
                return
              }
              return
            }

            finish(new Error(`PostgreSQL 认证方式暂不支持（authType=${authType}），请改用 SCRAM-SHA-256 / MD5 / Trust`))
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        },
      }

      this.#socket.write(this.#buildStartupPacket())
    })
  }

  #enqueue(task) {
    const run = this.#queue.then(task, task)
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  #runWireRoundTrip(wireBytes) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('PostgreSQL 连接未就绪或已关闭'))
        return
      }
      let settled = false
      let currentFields = []
      let currentRows = []
      let lastCommand = ''
      let totalRowCount = 0
      let pendingError = null

      const finish = (err, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#packetHandler = null
        if (err) reject(err)
        else resolve(result)
      }

      const timer = setTimeout(() => {
        this.#socket?.destroy()
        finish(new Error(`PostgreSQL 查询超时（超过 ${this.#queryTimeoutMs}ms）`))
      }, this.#queryTimeoutMs)
      timer.unref?.()

      this.#packetHandler = {
        onFatal: (err) => finish(pendingError || err),
        onMessage: (type, payload) => {
          try {
            if (type === 'E') {
              pendingError = toChinesePgError(parsePgFields(payload))
              return
            }
            if (type === '1' || type === '2' || type === '3' || type === 'n' || type === 't' || type === 'I') {
              return
            }
            if (type === 'T') {
              const count = payload.readInt16BE(0)
              let pos = 2
              currentFields = []
              for (let i = 0; i < count; i += 1) {
                const namePart = parseCString(payload, pos)
                pos = namePart.next
                const tableOid = payload.readInt32BE(pos)
                const columnAttrNumber = payload.readInt16BE(pos + 4)
                const typeOid = payload.readInt32BE(pos + 6)
                const typeSize = payload.readInt16BE(pos + 10)
                const typeModifier = payload.readInt32BE(pos + 12)
                const formatCode = payload.readInt16BE(pos + 16)
                pos += 18
                currentFields.push({
                  name: namePart.value,
                  tableOid,
                  columnAttrNumber,
                  typeOid,
                  typeSize,
                  typeModifier,
                  formatCode,
                })
              }
              currentRows = []
              return
            }
            if (type === 'D') {
              const count = payload.readInt16BE(0)
              let pos = 2
              const row = {}
              for (let i = 0; i < count; i += 1) {
                const len = payload.readInt32BE(pos)
                pos += 4
                const field = currentFields[i]
                const colName = field ? field.name : `col_${i}`
                if (len === -1) {
                  row[colName] = null
                } else {
                  const rawBytes = payload.subarray(pos, pos + len)
                  pos += len
                  const str = rawBytes.toString('utf8')
                  row[colName] = parsePgValue(str, field ? field.typeOid : 25)
                }
              }
              currentRows.push(row)
              return
            }
            if (type === 'C') {
              const { value } = parseCString(payload, 0)
              const parsed = parseCommandComplete(value)
              lastCommand = parsed.command
              totalRowCount = parsed.rowCount
              return
            }
            if (type === 'Z') {
              this.#txStatus = payload.length > 0 ? String.fromCharCode(payload[0]) : 'I'
              if (pendingError) {
                finish(pendingError)
              } else {
                finish(null, {
                  rows: currentRows,
                  fields: currentFields,
                  rowCount: lastCommand === 'SELECT' ? currentRows.length : totalRowCount,
                  command: lastCommand,
                })
              }
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        },
      }

      this.#socket.write(wireBytes)
    })
  }

  /** Simple Query 协议（适合无参数的单句/多句 DDL 与事务控制）。 */
  async simpleQuery(sql) {
    const sqlText = String(sql ?? '')
    return this.#enqueue(async () => {
      if (!this.connected) await this.connect()
      const pkt = frameMessage('Q', [Buffer.from(sqlText, 'utf8'), Buffer.from([0])])
      return this.#runWireRoundTrip(pkt)
    })
  }

  /**
   * Extended Query 协议（Parse + Bind + Execute + Sync，$1/$2 参数化防注入）。
   * 未传参数或参数为空时若包含多条 SQL 语句自动回退 Simple Query，单句也可用 Extended Query。
   */
  async query(sql, params = []) {
    const sqlText = String(sql ?? '')
    const list = Array.isArray(params) ? params : []
    if (list.length === 0) {
      return this.simpleQuery(sqlText)
    }
    return this.#enqueue(async () => {
      if (!this.connected) await this.connect()
      const encoded = list.map(encodePgParam)

      // 1. Parse ('P'): unnamed statement, unnamed type OIDs (let PG infer)
      const parseParamCount = Buffer.allocUnsafe(2)
      parseParamCount.writeInt16BE(0, 0)
      const parsePkt = frameMessage('P', [Buffer.from([0]), cString(sqlText), parseParamCount])

      // 2. Bind ('B'): portal="", stmt="", per-param format codes, values, all text result format
      const bindParts = [Buffer.from([0]), Buffer.from([0])]
      const fmtCountBuf = Buffer.allocUnsafe(2)
      fmtCountBuf.writeInt16BE(encoded.length, 0)
      bindParts.push(fmtCountBuf)
      for (const p of encoded) {
        const b = Buffer.allocUnsafe(2)
        b.writeInt16BE(p.format, 0)
        bindParts.push(b)
      }
      const valCountBuf = Buffer.allocUnsafe(2)
      valCountBuf.writeInt16BE(encoded.length, 0)
      bindParts.push(valCountBuf)
      for (const p of encoded) {
        const lenBuf = Buffer.allocUnsafe(4)
        if (p.bytes === null) {
          lenBuf.writeInt32BE(-1, 0)
          bindParts.push(lenBuf)
        } else {
          lenBuf.writeInt32BE(p.bytes.length, 0)
          bindParts.push(lenBuf, p.bytes)
        }
      }
      const resFmtBuf = Buffer.allocUnsafe(4)
      resFmtBuf.writeInt16BE(1, 0)
      resFmtBuf.writeInt16BE(0, 2) // 0 = text result columns
      bindParts.push(resFmtBuf)
      const bindPkt = frameMessage('B', bindParts)

      // 3. Execute ('E'): portal="", maxRows=0 (unlimited)
      const execMax = Buffer.allocUnsafe(4)
      execMax.writeInt32BE(0, 0)
      const execPkt = frameMessage('E', [Buffer.from([0]), execMax])

      // 4. Sync ('S')
      const syncPkt = frameMessage('S', [])

      return this.#runWireRoundTrip(Buffer.concat([parsePkt, bindPkt, execPkt, syncPkt]))
    })
  }

  async execute(sql, params = []) {
    return this.query(sql, params)
  }

  async ping() {
    const start = Date.now()
    await this.simpleQuery('SELECT 1 AS ok')
    return { ok: true, latencyMs: Date.now() - start, serverVersion: this.serverVersion }
  }

  async tx(fn) {
    if (typeof fn !== 'function') throw new Error('tx(fn) 需要传入异步回调函数')
    if (this.#txDepth > 0) {
      const sp = 'pb_sp_' + this.#txDepth
      await this.simpleQuery('SAVEPOINT ' + quotePgIdent(sp))
      this.#txDepth += 1
      try {
        const out = await fn(this)
        await this.simpleQuery('RELEASE SAVEPOINT ' + quotePgIdent(sp))
        return out
      } catch (error) {
        await this.simpleQuery('ROLLBACK TO SAVEPOINT ' + quotePgIdent(sp)).catch(() => {})
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
        sock.write(frameMessage('X', [])) // Terminate
      } catch {
        /* 忽略写关闭包失败 */
      }
    }
    sock.destroy()
    return true
  }
}

export class PgPool {
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
    if (this.#closed) throw new Error('PostgreSQL 连接池已关闭')

    while (this.#idle.length > 0) {
      const client = this.#idle.pop()
      if (client.connected) {
        this.#inUse.add(client)
        return client
      }
      await client.close().catch(() => {})
    }

    if (this.#inUse.size < this.#maxSize) {
      const client = new PgClient(this.#options)
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

    const shouldDiscard = broken || this.#closed || !client.connected || client.transactionStatus !== 'I'
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
      if (!client.connected || client.transactionStatus === 'E') broken = true
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
      w.reject(new Error('PostgreSQL 连接池正在关闭'))
    }
    const all = [...this.#idle, ...this.#inUse]
    this.#idle = []
    this.#inUse.clear()
    await Promise.all(all.map((c) => c.close().catch(() => {})))
    return true
  }
}

export function createPgClient(options) {
  return new PgClient(options)
}

export function createPgPool(options) {
  return new PgPool(options)
}
