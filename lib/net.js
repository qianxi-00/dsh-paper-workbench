/**
 * 零依赖代理感知网络客户端（直连 / HTTP(S) CONNECT / SOCKS5(h)）。
 *
 * 设计约束：
 *   - 仅使用 Node 20+ 内置模块（http / https / tls / net / zlib / child_process / url）；
 *   - 支持 auto（配置优先 → 环境变量 + NO_PROXY → Windows 注册表系统代理 30s 缓存）
 *     / custom / direct 三种代理模式；
 *   - 对压缩响应（gzip / deflate / br）透明流式解压，对无编码二进制流（如大体积 PDF）
 *     直接按块异步迭代，不整包缓冲进内存；
 *   - 全链路支持 AbortSignal 与 timeoutMs 取消，销毁底层套接字且不泄漏未捕获 error 事件。
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { URL } from 'node:url'

const DEFAULT_UA = 'dsh-paper-workbench/1.1 (+https://github.com/qianxi-00/dsh-paper-workbench)'
const SUPPORTED_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const WIN_PROXY_TTL_MS = 30 * 1000
const WIN_INET_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const HOST_PORT_NO_SCHEME_RE = /^(?:[^@/\s]+@)?(?:\[[^\]]+\]|[a-zA-Z0-9.-]+):\d+\/?$/
const HAS_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

const ARXIV_PROBE_URL = 'https://export.arxiv.org/api/query?search_query=cat:cs.AI&max_results=1'
const OPENALEX_PROBE_URL = 'https://api.openalex.org/works?per-page=1'

// 跨动态重载（index.js 的 ?load=<tag>）共享默认配置读取器与注册表代理缓存
const SHARED = (globalThis.__pbNetShared ||= {
  networkConfigGetter: null,
  winProxyCache: { at: 0, enabled: false, server: '' },
})

/** 注册默认网络配置读取函数（支持同步或异步返回 networkConfig）。 */
export function setDefaultNetworkConfigGetter(fn) {
  SHARED.networkConfigGetter = typeof fn === 'function' ? fn : null
}

function formatProxyUrl(parsed) {
  const auth = parsed.username
    ? parsed.password
      ? `${parsed.username}:${parsed.password}@`
      : `${parsed.username}@`
    : ''
  const hostPart = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  return `${parsed.protocol}//${auth}${hostPart}`
}

function parseProxyUrl(rawProxy, { strict = false } = {}) {
  const text = typeof rawProxy === 'string' ? rawProxy.trim() : ''
  if (text === '') {
    if (strict) {
      throw new Error('代理配置无效：自定义代理模式下请填写代理地址（例如 http://127.0.0.1:7897 或 socks5://127.0.0.1:1080）')
    }
    return ''
  }

  let candidate = text
  if (!HAS_SCHEME_RE.test(text)) {
    if (HOST_PORT_NO_SCHEME_RE.test(text)) {
      candidate = 'http://' + text.replace(/\/+$/, '')
    } else if (strict) {
      throw new Error(
        '代理地址格式无效：请填写完整地址，例如 http://127.0.0.1:7897 或 socks5://127.0.0.1:1080',
      )
    } else {
      return ''
    }
  }

  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    if (strict) {
      throw new Error(
        '代理地址无法解析：请检查主机名与端口号是否正确（示例：http://127.0.0.1:7897）',
      )
    }
    return ''
  }

  const protocol = String(parsed.protocol || '').toLowerCase()
  if (!SUPPORTED_PROXY_SCHEMES.has(protocol)) {
    if (strict) {
      throw new Error(
        '不支持的代理协议（' + protocol.replace(/:$/, '') + '）：仅支持 http、https、socks5、socks5h',
      )
    }
    return ''
  }

  if (!parsed.hostname) {
    if (strict) {
      throw new Error('代理地址缺少主机名：请填写如 http://127.0.0.1:7897')
    }
    return ''
  }

  if (parsed.port !== '') {
    const portNum = Number(parsed.port)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      if (strict) {
        throw new Error('代理端口无效（' + parsed.port + '）：端口号必须在 1–65535 之间')
      }
      return ''
    }
  }

  return formatProxyUrl(parsed)
}

/**
 * 归一化网络代理配置。
 * 支持简写字符串（'auto' / 'direct' / '127.0.0.1:7897' / 'socks5://...'）或对象 { mode, proxyUrl, proxy }。
 */
export function normalizeNetworkConfig(raw) {
  if (raw === null || raw === undefined) {
    return { mode: 'auto', proxyUrl: '' }
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const lower = trimmed.toLowerCase()
    if (trimmed === '' || lower === 'auto') return { mode: 'auto', proxyUrl: '' }
    if (lower === 'direct' || lower === 'none' || lower === 'off') return { mode: 'direct', proxyUrl: '' }
    return {
      mode: 'custom',
      proxyUrl: parseProxyUrl(trimmed, { strict: true }),
    }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { mode: 'auto', proxyUrl: '' }
  }

  const rawMode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : ''
  const mode = rawMode === 'custom' || rawMode === 'direct' || rawMode === 'auto' ? rawMode : 'auto'
  const rawProxy = raw.proxyUrl !== undefined && raw.proxyUrl !== null && raw.proxyUrl !== '' ? raw.proxyUrl : raw.proxy
  const proxyUrl = parseProxyUrl(rawProxy, { strict: mode === 'custom' })

  return { mode, proxyUrl }
}

export function redactProxyUrl(rawProxy) {
  const proxyUrl = parseProxyUrl(rawProxy)
  if (!proxyUrl) return { url: '', authenticated: false }
  const parsed = new URL(proxyUrl)
  const authenticated = Boolean(parsed.username || parsed.password)
  parsed.username = ''
  parsed.password = ''
  return { url: formatProxyUrl(parsed), authenticated }
}

function stripBrackets(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '')
}

function isLoopbackHost(hostname) {
  const host = stripBrackets(hostname).toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1') return true
  if (host.endsWith('.localhost')) return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

function effectivePort(urlObj) {
  if (urlObj.port) return String(urlObj.port)
  return urlObj.protocol === 'https:' ? '443' : '80'
}

function matchesNoProxy(targetUrlObj, noProxyValue) {
  const raw = typeof noProxyValue === 'string' ? noProxyValue.trim() : ''
  if (raw === '') return false

  const targetHost = stripBrackets(targetUrlObj.hostname).toLowerCase()
  const targetPort = effectivePort(targetUrlObj)

  for (const part of raw.split(',')) {
    const token = part.trim()
    if (!token) continue
    if (token === '*') return true

    let ruleHost = token
    let rulePort = ''
    if (token.startsWith('[')) {
      const closeIdx = token.indexOf(']')
      if (closeIdx !== -1) {
        ruleHost = token.slice(1, closeIdx)
        if (token[closeIdx + 1] === ':') rulePort = token.slice(closeIdx + 2)
      }
    } else {
      const colonIdx = token.lastIndexOf(':')
      if (colonIdx !== -1 && /^\d+$/.test(token.slice(colonIdx + 1))) {
        ruleHost = token.slice(0, colonIdx)
        rulePort = token.slice(colonIdx + 1)
      }
    }

    if (rulePort && rulePort !== targetPort) continue

    const normalizedRule = ruleHost.replace(/^\*\./, '.').toLowerCase()
    if (!normalizedRule) continue
    if (normalizedRule.startsWith('.')) {
      if (targetHost === normalizedRule.slice(1) || targetHost.endsWith(normalizedRule)) return true
    } else if (targetHost === normalizedRule || targetHost.endsWith('.' + normalizedRule)) {
      return true
    }
  }
  return false
}

/** 解析 Windows 注册表 ProxyServer 字符串（支持单地址或 http=...;https=...;socks=...）。 */
function selectWindowsProxyServer(proxyServerRaw, targetProtocol) {
  const raw = typeof proxyServerRaw === 'string' ? proxyServerRaw.trim() : ''
  if (!raw) return ''

  if (!raw.includes('=')) {
    return parseProxyUrl(raw, { strict: false })
  }

  const map = {}
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=')
    if (eq <= 0) continue
    const k = segment.slice(0, eq).trim().toLowerCase()
    const v = segment.slice(eq + 1).trim()
    if (k && v) map[k] = v
  }

  const withSocksScheme = (val) => (HAS_SCHEME_RE.test(val) ? val : 'socks5://' + val.replace(/\/+$/, ''))

  const candidates =
    targetProtocol === 'https:'
      ? [
          map.https,
          map.http,
          map.socks5 ? withSocksScheme(map.socks5) : '',
          map.socks ? withSocksScheme(map.socks) : '',
        ]
      : [
          map.http,
          map.socks5 ? withSocksScheme(map.socks5) : '',
          map.socks ? withSocksScheme(map.socks) : '',
        ]

  for (const cand of candidates) {
    if (!cand) continue
    const normalized = parseProxyUrl(cand, { strict: false })
    if (normalized) return normalized
  }
  return ''
}

function readWindowsSystemProxy() {
  const now = Date.now()
  if (SHARED.winProxyCache.at > 0 && now - SHARED.winProxyCache.at < WIN_PROXY_TTL_MS) {
    return SHARED.winProxyCache
  }
  let enabled = false
  let server = ''
  try {
    const stdout = execFileSync('reg.exe', ['query', WIN_INET_REG_KEY], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const enableMatch = /^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/m.exec(stdout)
    const serverMatch = /^\s*ProxyServer\s+REG_SZ\s+([^\r\n]+)/m.exec(stdout)
    if (enableMatch && Number(enableMatch[1]) === 1) {
      enabled = true
      server = serverMatch ? serverMatch[1].trim() : ''
    }
  } catch {
    enabled = false
    server = ''
  }
  SHARED.winProxyCache = { at: now, enabled, server }
  return SHARED.winProxyCache
}

/**
 * 解析面向特定目标 URL 实际生效的代理与来源。
 *
 * @param {string|URL} targetUrl
 * @param {object|string} [networkConfig]
 * @param {{ allowLoopbackProxy?: boolean, env?: Record<string, string|undefined> }} [options]
 * @returns {{ proxyUrl: string, source: 'direct' | 'custom' | 'config' | 'env' | 'system' | 'none' | 'bypass' }}
 */
export function resolveEffectiveProxy(targetUrl, networkConfig, options = {}) {
  const target = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl))
  const norm = normalizeNetworkConfig(networkConfig)
  const allowLoopback = Boolean(
    (options && options.allowLoopbackProxy) ||
      (networkConfig && typeof networkConfig === 'object' && networkConfig.allowLoopbackProxy),
  )

  if (norm.mode === 'direct') {
    return { proxyUrl: '', source: 'direct' }
  }

  if (!allowLoopback && isLoopbackHost(target.hostname)) {
    return { proxyUrl: '', source: 'none' }
  }

  if (norm.mode === 'custom') {
    return { proxyUrl: norm.proxyUrl, source: 'custom' }
  }

  // mode === 'auto'
  if (norm.proxyUrl) {
    return { proxyUrl: norm.proxyUrl, source: 'config' }
  }

  const env = (options && options.env) || process.env
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? ''
  if (matchesNoProxy(target, noProxy)) {
    return { proxyUrl: '', source: 'none' }
  }

  const rawEnvProxy =
    target.protocol === 'https:'
      ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || ''
      : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || ''

  if (rawEnvProxy) {
    const normalizedEnv = parseProxyUrl(rawEnvProxy, { strict: false })
    if (normalizedEnv) {
      return { proxyUrl: normalizedEnv, source: 'env' }
    }
  }

  const disableSys = env.PB_DISABLE_SYSTEM_PROXY === '1' || process.env.PB_DISABLE_SYSTEM_PROXY === '1'
  if (process.platform === 'win32' && !disableSys) {
    const sys = readWindowsSystemProxy()
    if (sys.enabled && sys.server) {
      const sysUrl = selectWindowsProxyServer(sys.server, target.protocol)
      if (sysUrl) {
        return { proxyUrl: sysUrl, source: 'system' }
      }
    }
  }

  return { proxyUrl: '', source: 'none' }
}

// --- 底层隧道与协议实现 -----------------------------------------------------

function silenceAndDestroy(stream, err) {
  if (!stream) return
  try {
    stream.on('error', () => {})
    if (!stream.destroyed) {
      if (err) stream.destroy(err)
      else stream.destroy()
    }
  } catch {
    /* 忽略销毁阶段异常 */
  }
}

function makeAbortError(reason) {
  if (reason instanceof Error) return reason
  const msg = reason ? String(reason) : '请求已取消'
  const err = new Error(msg)
  err.name = 'AbortError'
  return err
}

/** 将 IPv6 文本解析为 16 字节大端 Buffer（用于 SOCKS5 ATYP=0x04）。 */
function ipv6ToBuffer(ipv6) {
  let addr = stripBrackets(ipv6).split('%')[0]
  // 处理内嵌 IPv4（如 ::ffff:127.0.0.1）
  const lastColon = addr.lastIndexOf(':')
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4Parts = addr.slice(lastColon + 1).split('.').map(Number)
    const hi = ((v4Parts[0] << 8) | v4Parts[1]).toString(16)
    const lo = ((v4Parts[2] << 8) | v4Parts[3]).toString(16)
    addr = addr.slice(0, lastColon + 1) + hi + ':' + lo
  }

  let groups
  if (addr.includes('::')) {
    const [leftRaw, rightRaw] = addr.split('::')
    const left = leftRaw ? leftRaw.split(':') : []
    const right = rightRaw ? rightRaw.split(':') : []
    const fillCount = 8 - left.length - right.length
    groups = [...left, ...new Array(Math.max(0, fillCount)).fill('0'), ...right]
  } else {
    groups = addr.split(':')
  }

  const buf = Buffer.alloc(16)
  for (let i = 0; i < 8; i += 1) {
    const word = parseInt(groups[i] || '0', 16)
    buf.writeUInt16BE(Number.isFinite(word) ? word & 0xffff : 0, i * 2)
  }
  return buf
}

/** 建立 HTTP/HTTPS CONNECT 隧道，返回已连通目标的原始双工 Socket。 */
function openHttpConnectTunnel({ proxyUrlObj, targetHost, targetPort, tracker }) {
  return new Promise((resolve, reject) => {
    if (tracker.aborted()) {
      reject(tracker.error())
      return
    }

    const proxyHost = stripBrackets(proxyUrlObj.hostname)
    const proxyPort = Number(proxyUrlObj.port) || (proxyUrlObj.protocol === 'https:' ? 443 : 80)
    const authorityHost = targetHost.includes(':') ? `[${targetHost}]` : targetHost
    const authority = `${authorityHost}:${targetPort}`

    const headers = {
      Host: authority,
      'User-Agent': DEFAULT_UA,
      'Proxy-Connection': 'keep-alive',
    }
    if (proxyUrlObj.username || proxyUrlObj.password) {
      const user = decodeURIComponent(proxyUrlObj.username || '')
      const pass = decodeURIComponent(proxyUrlObj.password || '')
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
    }

    const transport = proxyUrlObj.protocol === 'https:' ? https : http
    const connectReq = transport.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
    })
    tracker.track(connectReq)

    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      silenceAndDestroy(connectReq)
      reject(err)
    }

    connectReq.once('error', (err) => {
      fail(tracker.aborted() ? tracker.error() : new Error('连接 HTTP 代理失败：' + (err.message || String(err))))
    })

    connectReq.once('response', (res) => {
      res.resume()
      silenceAndDestroy(res)
      fail(new Error('HTTP 代理未建立隧道：HTTP ' + (res.statusCode || 0)))
    })

    connectReq.once('connect', (res, socket, head) => {
      if (settled) {
        silenceAndDestroy(socket)
        return
      }
      settled = true
      tracker.untrack(connectReq)
      tracker.track(socket)

      if (res.statusCode !== 200) {
        silenceAndDestroy(socket)
        reject(new Error('HTTP 代理 CONNECT 隧道失败：HTTP ' + (res.statusCode || 0)))
        return
      }

      if (head && head.length > 0) {
        socket.unshift(head)
      }
      resolve(socket)
    })

    connectReq.end()
  })
}

/** 建立 SOCKS5 / SOCKS5H（RFC 1928 + RFC 1929）隧道，返回已连通目标的原始 Socket。 */
function openSocks5Tunnel({ proxyUrlObj, targetHost, targetPort, tracker }) {
  return new Promise((resolve, reject) => {
    if (tracker.aborted()) {
      reject(tracker.error())
      return
    }

    const proxyHost = stripBrackets(proxyUrlObj.hostname)
    const proxyPort = Number(proxyUrlObj.port) || 1080
    const hasAuth = Boolean(proxyUrlObj.username || proxyUrlObj.password)

    const socket = net.connect({ host: proxyHost, port: proxyPort })
    tracker.track(socket)

    let buf = Buffer.alloc(0)
    const waiters = []
    let closedErr = null

    const pump = () => {
      while (waiters.length > 0) {
        if (closedErr) {
          const w = waiters.shift()
          w.reject(closedErr)
          continue
        }
        if (buf.length < waiters[0].need) break
        const w = waiters.shift()
        const slice = buf.subarray(0, w.need)
        buf = buf.subarray(w.need)
        w.resolve(slice)
      }
    }

    const onData = (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      pump()
    }
    const onError = (err) => {
      closedErr = tracker.aborted()
        ? tracker.error()
        : new Error('SOCKS5 代理连接错误：' + (err && err.message ? err.message : String(err)))
      pump()
    }
    const onClose = () => {
      if (!closedErr) {
        closedErr = tracker.aborted() ? tracker.error() : new Error('SOCKS5 代理连接在握手期间提前关闭')
      }
      pump()
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('end', onClose)
    socket.on('close', onClose)

    const detachHandshakeListeners = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('end', onClose)
      socket.removeListener('close', onClose)
    }

    const readExact = (need) =>
      new Promise((res, rej) => {
        waiters.push({ need, resolve: res, reject: rej })
        pump()
      })

    const writeBuf = (data) =>
      new Promise((res, rej) => {
        socket.write(data, (err) => (err ? rej(err) : res()))
      })

    socket.once('connect', async () => {
      try {
        // 1. 认证方法协商（0x00 无认证 / 0x02 用户名密码）
        await writeBuf(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]))
        const greetReply = await readExact(2)
        if (greetReply[0] !== 0x05) {
          throw new Error('SOCKS5 代理握手失败：协议版本无效（' + greetReply[0] + '）')
        }
        const chosenMethod = greetReply[1]
        if (chosenMethod === 0xff) {
          throw new Error('SOCKS5 代理握手失败：代理拒绝客户端支持的认证方式')
        }

        // 2. RFC 1929 用户名密码子协商
        if (chosenMethod === 0x02) {
          const userBuf = Buffer.from(decodeURIComponent(proxyUrlObj.username || ''), 'utf8')
          const passBuf = Buffer.from(decodeURIComponent(proxyUrlObj.password || ''), 'utf8')
          if (userBuf.length > 255 || passBuf.length > 255) {
            throw new Error('SOCKS5 代理认证失败：用户名或密码超过 255 字节上限')
          }
          await writeBuf(
            Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]),
          )
          const authReply = await readExact(2)
          if (authReply[1] !== 0x00) {
            throw new Error('SOCKS5 代理认证失败：用户名或密码不正确（状态码 ' + authReply[1] + '）')
          }
        } else if (chosenMethod !== 0x00) {
          throw new Error('SOCKS5 代理握手失败：不支持的认证方法（' + chosenMethod + '）')
        }

        // 3. CONNECT 目标主机与端口
        const ipKind = net.isIP(targetHost)
        let addrPart
        if (ipKind === 4) {
          addrPart = Buffer.from([0x01, ...targetHost.split('.').map(Number)])
        } else if (ipKind === 6) {
          addrPart = Buffer.concat([Buffer.from([0x04]), ipv6ToBuffer(targetHost)])
        } else {
          const domainBuf = Buffer.from(targetHost, 'utf8')
          if (domainBuf.length === 0 || domainBuf.length > 255) {
            throw new Error('SOCKS5 目标域名长度无效：' + targetHost)
          }
          addrPart = Buffer.concat([Buffer.from([0x03, domainBuf.length]), domainBuf])
        }
        const portBuf = Buffer.alloc(2)
        portBuf.writeUInt16BE(targetPort, 0)
        await writeBuf(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]))

        const connHead = await readExact(4)
        if (connHead[0] !== 0x05) {
          throw new Error('SOCKS5 CONNECT 响应版本无效（' + connHead[0] + '）')
        }
        if (connHead[1] !== 0x00) {
          throw new Error('SOCKS5 代理连接目标失败（错误码 0x' + connHead[1].toString(16).padStart(2, '0') + '）')
        }

        const atyp = connHead[3]
        if (atyp === 0x01) {
          await readExact(4 + 2)
        } else if (atyp === 0x04) {
          await readExact(16 + 2)
        } else if (atyp === 0x03) {
          const lenBuf = await readExact(1)
          await readExact(lenBuf[0] + 2)
        } else {
          throw new Error('SOCKS5 响应地址类型未知（' + atyp + '）')
        }

        detachHandshakeListeners()
        if (buf.length > 0) {
          socket.unshift(buf)
          buf = Buffer.alloc(0)
        }
        resolve(socket)
      } catch (err) {
        detachHandshakeListeners()
        silenceAndDestroy(socket)
        reject(tracker.aborted() ? tracker.error() : err)
      }
    })
  })
}

/** 将已建立隧道的原始 Socket 升级为 TLS 连接。 */
function upgradeSocketToTls(rawSocket, { targetHost, rejectUnauthorized, ca, tracker }) {
  return new Promise((resolve, reject) => {
    if (tracker.aborted()) {
      silenceAndDestroy(rawSocket)
      reject(tracker.error())
      return
    }

    const tlsSocket = tls.connect({
      socket: rawSocket,
      ...(net.isIP(targetHost) === 0 ? { servername: targetHost } : {}),
      rejectUnauthorized: rejectUnauthorized !== false,
      ...(ca ? { ca } : {}),
    })
    tracker.track(tlsSocket)

    let settled = false
    tlsSocket.once('error', (err) => {
      if (settled) return
      settled = true
      silenceAndDestroy(tlsSocket)
      reject(tracker.aborted() ? tracker.error() : new Error('TLS 握手失败：' + (err.message || String(err))))
    })

    tlsSocket.once('secureConnect', () => {
      if (settled) return
      settled = true
      resolve(tlsSocket)
    })
  })
}

function normalizeRequestHeaders(rawHeaders) {
  const out = {}
  if (!rawHeaders) return out
  if (typeof rawHeaders.entries === 'function') {
    for (const [k, v] of rawHeaders.entries()) {
      out[String(k)] = String(v)
    }
    return out
  }
  if (typeof rawHeaders === 'object') {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (v === undefined || v === null) continue
      out[String(k)] = Array.isArray(v) ? v.join(', ') : String(v)
    }
  }
  return out
}

function findHeaderKey(headers, lowerName) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return key
  }
  return null
}

function toBodyBuffer(body) {
  if (body === null || body === undefined) return null
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  return Buffer.from(String(body), 'utf8')
}

function createResponseHeaders(rawHeaders) {
  const map = new Map()
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    if (v === undefined) continue
    map.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v))
  }
  return {
    get(name) {
      const key = String(name || '').toLowerCase()
      return map.has(key) ? map.get(key) : null
    },
    has(name) {
      return map.has(String(name || '').toLowerCase())
    },
    entries() {
      return map.entries()
    },
    [Symbol.iterator]() {
      return map.entries()
    },
  }
}

function createBodyPipeline(rawRes, method, status, tracker) {
  const noBody = method === 'HEAD' || status === 204 || status === 304
  const encoding = String((rawRes.headers && rawRes.headers['content-encoding']) || '')
    .trim()
    .toLowerCase()

  let decoder = null
  if (!noBody) {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      decoder = zlib.createGunzip()
    } else if (encoding === 'deflate') {
      decoder = zlib.createInflate()
    } else if (encoding === 'br') {
      decoder = zlib.createBrotliDecompress()
    }
  }

  if (!decoder) {
    rawRes.once('end', () => tracker.finish())
    rawRes.once('close', () => tracker.finish())
    return rawRes
  }

  tracker.track(decoder)
  rawRes.on('error', (err) => {
    silenceAndDestroy(decoder, tracker.aborted() ? tracker.error() : err)
  })
  rawRes.on('close', () => {
    if (!rawRes.complete && !decoder.destroyed) {
      silenceAndDestroy(decoder, tracker.aborted() ? tracker.error() : new Error('响应流在传输完成前中断'))
    }
  })
  decoder.once('end', () => tracker.finish())
  decoder.once('close', () => {
    if (!rawRes.destroyed) silenceAndDestroy(rawRes)
    tracker.finish()
  })
  rawRes.pipe(decoder)
  return decoder
}

/** 发送单跳 HTTP(S) 请求（直连 / HTTP 代理 / SOCKS5 代理）。 */
async function sendSingleHop({
  urlObj,
  method,
  headers,
  bodyBuf,
  proxyUrl,
  rejectUnauthorized,
  ca,
  tracker,
}) {
  if (tracker.aborted()) throw tracker.error()

  const targetHost = stripBrackets(urlObj.hostname)
  const targetPort = Number(urlObj.port) || (urlObj.protocol === 'https:' ? 443 : 80)
  const pathWithQuery = (urlObj.pathname || '/') + (urlObj.search || '')

  const reqHeaders = { ...headers }
  if (!findHeaderKey(reqHeaders, 'user-agent')) reqHeaders['User-Agent'] = DEFAULT_UA
  if (!findHeaderKey(reqHeaders, 'accept-encoding')) reqHeaders['Accept-Encoding'] = 'gzip, deflate, br'
  if (!findHeaderKey(reqHeaders, 'connection')) reqHeaders.Connection = 'close'
  if (!findHeaderKey(reqHeaders, 'host')) reqHeaders.Host = urlObj.host
  if (bodyBuf !== null && !findHeaderKey(reqHeaders, 'content-length')) {
    reqHeaders['Content-Length'] = String(bodyBuf.length)
  }

  let requestFactory
  if (!proxyUrl) {
    // 1. 直连 http: / https:
    if (urlObj.protocol === 'https:') {
      requestFactory = (cb) =>
        https.request(
          {
            host: targetHost,
            port: targetPort,
            method,
            path: pathWithQuery,
            headers: reqHeaders,
            agent: false,
            rejectUnauthorized: rejectUnauthorized !== false,
            ...(ca ? { ca } : {}),
            ...(net.isIP(targetHost) === 0 ? { servername: targetHost } : {}),
          },
          cb,
        )
    } else {
      requestFactory = (cb) =>
        http.request(
          {
            host: targetHost,
            port: targetPort,
            method,
            path: pathWithQuery,
            headers: reqHeaders,
            agent: false,
          },
          cb,
        )
    }
  } else {
    const proxyObj = new URL(proxyUrl)
    const proxyProto = proxyObj.protocol.toLowerCase()

    if ((proxyProto === 'http:' || proxyProto === 'https:') && urlObj.protocol === 'http:') {
      // 2a. HTTP 目标走 HTTP/HTTPS 代理：发送完整 URI 请求
      const proxyHost = stripBrackets(proxyObj.hostname)
      const proxyPort = Number(proxyObj.port) || (proxyProto === 'https:' ? 443 : 80)
      const proxyHeaders = { ...reqHeaders, 'Proxy-Connection': 'close' }
      if (proxyObj.username || proxyObj.password) {
        const user = decodeURIComponent(proxyObj.username || '')
        const pass = decodeURIComponent(proxyObj.password || '')
        proxyHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
      }
      const mod = proxyProto === 'https:' ? https : http
      requestFactory = (cb) =>
        mod.request(
          {
            host: proxyHost,
            port: proxyPort,
            method,
            path: urlObj.href,
            headers: proxyHeaders,
            agent: false,
          },
          cb,
        )
    } else {
      // 2b / 3. HTTP CONNECT 隧道（https 目标）或 SOCKS5(h) 隧道（http / https 目标）
      const rawSocket =
        proxyProto === 'socks5:' || proxyProto === 'socks5h:'
          ? await openSocks5Tunnel({ proxyUrlObj: proxyObj, targetHost, targetPort, tracker })
          : await openHttpConnectTunnel({ proxyUrlObj: proxyObj, targetHost, targetPort, tracker })

      const streamSocket =
        urlObj.protocol === 'https:'
          ? await upgradeSocketToTls(rawSocket, { targetHost, rejectUnauthorized, ca, tracker })
          : rawSocket

      requestFactory = (cb) =>
        http.request(
          {
            host: targetHost,
            port: targetPort,
            method,
            path: pathWithQuery,
            headers: reqHeaders,
            // 不可传 agent: false（Node 会新建默认 Agent 并忽略 options.createConnection 而走本地 DNS 直连）
            createConnection: () => streamSocket,
          },
          cb,
        )
    }
  }

  return new Promise((resolve, reject) => {
    if (tracker.aborted()) {
      reject(tracker.error())
      return
    }
    let settled = false
    const req = requestFactory((res) => {
      if (settled) {
        silenceAndDestroy(res)
        return
      }
      settled = true
      tracker.track(res)
      resolve(res)
    })
    tracker.track(req)

    req.once('error', (err) => {
      if (settled) return
      settled = true
      silenceAndDestroy(req)
      reject(tracker.aborted() ? tracker.error() : err)
    })

    if (bodyBuf !== null && bodyBuf.length > 0) {
      req.write(bodyBuf)
    }
    req.end()
  })
}

function createAbortTracker({ signal, timeoutMs }) {
  const tracked = new Set()
  let abortErr = null
  let done = false
  let timer = null

  const trigger = (err) => {
    if (done || abortErr) return
    abortErr = err
    for (const resource of tracked) {
      silenceAndDestroy(resource, err)
    }
    tracked.clear()
  }

  const onSignalAbort = () => {
    trigger(makeAbortError(signal && signal.reason))
  }

  if (signal) {
    if (signal.aborted) {
      abortErr = makeAbortError(signal.reason)
    } else if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onSignalAbort, { once: true })
    }
  }

  const timeoutNum = Number(timeoutMs)
  if (!abortErr && Number.isFinite(timeoutNum) && timeoutNum > 0) {
    timer = setTimeout(() => {
      trigger(new Error('请求超时（' + Math.trunc(timeoutNum) + 'ms）'))
    }, timeoutNum)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const finish = () => {
    if (done) return
    done = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onSignalAbort)
    }
    tracked.clear()
  }

  return {
    aborted: () => abortErr !== null,
    error: () => abortErr || new Error('请求已取消'),
    track(resource) {
      if (!resource) return
      if (abortErr) {
        silenceAndDestroy(resource, abortErr)
        return
      }
      tracked.add(resource)
    },
    untrack(resource) {
      tracked.delete(resource)
    },
    finish,
  }
}

/**
 * 代理感知的轻量 Fetch 客户端。
 */
export async function proxyFetch(targetUrl, options = {}) {
  const {
    method: rawMethod = 'GET',
    headers: rawHeaders = {},
    body = null,
    redirect = 'follow',
    maxRedirects = 5,
    signal = null,
    timeoutMs = 30000,
    proxyConfig = undefined,
    allowLoopbackProxy = false,
    rejectUnauthorized = true,
    ca = undefined,
    env = undefined,
  } = options || {}

  let currentUrl
  try {
    currentUrl = targetUrl instanceof URL ? new URL(targetUrl.href) : new URL(String(targetUrl))
  } catch {
    throw new Error('无效的目标 URL：' + String(targetUrl))
  }
  if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
    throw new Error('仅支持 http/https 目标协议：' + currentUrl.protocol)
  }

  let effectiveNetCfg = proxyConfig
  if (effectiveNetCfg === undefined && SHARED.networkConfigGetter) {
    try {
      effectiveNetCfg = await SHARED.networkConfigGetter()
    } catch {
      effectiveNetCfg = undefined
    }
  }
  // 若显式配置为 custom 且 URL 非法，提前在此处抛出清晰中文错误
  const normalizedNetCfg = normalizeNetworkConfig(effectiveNetCfg)

  const tracker = createAbortTracker({ signal, timeoutMs })
  if (tracker.aborted()) {
    tracker.finish()
    throw tracker.error()
  }

  let currentMethod = String(rawMethod || 'GET').toUpperCase()
  let currentHeaders = normalizeRequestHeaders(rawHeaders)
  let currentBody = toBodyBuffer(body)
  let redirects = 0

  try {
    while (true) {
      const { proxyUrl } = resolveEffectiveProxy(currentUrl, normalizedNetCfg, {
        allowLoopbackProxy:
          allowLoopbackProxy ||
          Boolean(effectiveNetCfg && typeof effectiveNetCfg === 'object' && effectiveNetCfg.allowLoopbackProxy),
        env,
      })

      const rawRes = await sendSingleHop({
        urlObj: currentUrl,
        method: currentMethod,
        headers: currentHeaders,
        bodyBuf: currentBody,
        proxyUrl,
        rejectUnauthorized,
        ca,
        tracker,
      })

      const status = rawRes.statusCode || 0
      const location = rawRes.headers && rawRes.headers.location ? String(rawRes.headers.location).trim() : ''

      if (redirect === 'follow' && REDIRECT_STATUSES.has(status) && location !== '') {
        rawRes.resume()
        silenceAndDestroy(rawRes)
        tracker.untrack(rawRes)

        redirects += 1
        if (redirects > maxRedirects) {
          throw new Error('请求重定向次数超过上限（' + maxRedirects + ' 次）')
        }

        const nextUrl = new URL(location, currentUrl)
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          throw new Error('重定向目标协议不受支持：' + nextUrl.protocol)
        }

        if (status === 303 || ((status === 301 || status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET'
          currentBody = null
          for (const h of ['content-length', 'content-type', 'transfer-encoding']) {
            const key = findHeaderKey(currentHeaders, h)
            if (key) delete currentHeaders[key]
          }
        }

        if (nextUrl.origin !== currentUrl.origin) {
          for (const h of ['authorization', 'cookie']) {
            const key = findHeaderKey(currentHeaders, h)
            if (key) delete currentHeaders[key]
          }
        }

        const hostKey = findHeaderKey(currentHeaders, 'host')
        if (hostKey) delete currentHeaders[hostKey]

        currentUrl = nextUrl
        continue
      }

      const finalUrl = currentUrl.href
      const statusText = rawRes.statusMessage || ''
      const responseHeaders = createResponseHeaders(rawRes.headers)
      const stream = createBodyPipeline(rawRes, currentMethod, status, tracker)

      let bodyConsumed = false
      const bodyIterable = {
        async *[Symbol.asyncIterator]() {
          if (bodyConsumed) throw new Error('响应流已被读取，不能重复消费')
          bodyConsumed = true
          try {
            for await (const chunk of stream) {
              if (tracker.aborted()) throw tracker.error()
              yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            }
          } catch (err) {
            if (tracker.aborted()) throw tracker.error()
            throw err
          } finally {
            tracker.finish()
          }
        },
        cancel() {
          silenceAndDestroy(stream)
          silenceAndDestroy(rawRes)
          tracker.finish()
        },
      }

      const readAllBuffer = async () => {
        const chunks = []
        for await (const chunk of bodyIterable) {
          chunks.push(chunk)
        }
        return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks)
      }

      return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        url: finalUrl,
        headers: responseHeaders,
        body: bodyIterable,
        async arrayBuffer() {
          const buf = await readAllBuffer()
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        },
        async text() {
          const buf = await readAllBuffer()
          return buf.toString('utf8')
        },
        async json() {
          const txt = await this.text()
          return JSON.parse(txt)
        },
      }
    }
  } catch (err) {
    tracker.finish()
    throw err
  }
}

/**
 * 探测 arXiv 与 OpenAlex 网络连通性（用于设置页测试按钮与自检）。
 */
export async function testNetworkConnectivity(proxyConfig) {
  let cfg = proxyConfig
  if (cfg === undefined && SHARED.networkConfigGetter) {
    try {
      cfg = await SHARED.networkConfigGetter()
    } catch {
      cfg = undefined
    }
  }

  const resolved = resolveEffectiveProxy(ARXIV_PROBE_URL, cfg)

  const probeOne = async (url) => {
    const t0 = Date.now()
    try {
      const res = await proxyFetch(url, {
        timeoutMs: 8000,
        proxyConfig: cfg,
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: '*/*',
        },
      })
      // 读完探测小响应体，确保完整链路（含 TLS + 响应传输）通畅并及时释放连接
      await res.arrayBuffer().catch(() => {})
      const ms = Date.now() - t0
      return {
        ok: res.ok,
        status: res.status,
        ms,
        error: res.ok ? '' : 'HTTP ' + res.status,
      }
    } catch (error) {
      const ms = Date.now() - t0
      return {
        ok: false,
        status: 0,
        ms,
        error: error && error.message ? error.message : String(error),
      }
    }
  }

  const startedAt = Date.now()
  const [arxiv, openalex] = await Promise.all([probeOne(ARXIV_PROBE_URL), probeOne(OPENALEX_PROBE_URL)])
  const okProbes = [arxiv, openalex].filter((item) => item.ok)
  const latencyMs =
    okProbes.length > 0 ? Math.min(...okProbes.map((item) => item.ms)) : Date.now() - startedAt

  const effectiveProxy = redactProxyUrl(resolved.proxyUrl)
  return {
    ok: Boolean(arxiv.ok || openalex.ok),
    effectiveProxy: effectiveProxy.url,
    proxyAuthConfigured: effectiveProxy.authenticated,
    source: resolved.source,
    latencyMs,
    arxiv,
    openalex,
  }
}
