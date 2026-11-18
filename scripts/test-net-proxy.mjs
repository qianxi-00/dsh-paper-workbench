/**
 * lib/net.js 代理感知网络层隔离自测脚本。
 *
 * 覆盖：
 *   1. normalizeNetworkConfig / resolveEffectiveProxy（direct / custom / auto / 环境变量 / NO_PROXY / PB_DISABLE_SYSTEM_PROXY=1 / 非法协议报错）
 *   2. 本地真实 HTTP 代理服务器（HTTP 完整 URI 转发 + Basic 代理认证 + HTTPS CONNECT 隧道升级 TLS）
 *   3. 本地真实 SOCKS5 代理服务器（RFC 1928 无认证 0x00 + RFC 1929 账号密码 0x02 + IPv4 0x01 / 域名 0x03 + TLS 升级）
 *   4. 301/302 重定向（更新最终 res.url）、gzip/deflate/br 流式解压、无编码大块流式读取、AbortSignal 与 timeoutMs 取消销毁
 *   5. setDefaultNetworkConfigGetter 与 lib/arxiv.js 默认 proxyFetch 贯通验证
 *
 * 安全铁律：使用 os.tmpdir() 下的临时目录作为 DSH_PAPER_WORKBENCH_DATA 并在 finally 清理。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const TMP_DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-test-net-proxy-'))
process.env.DSH_PAPER_WORKBENCH_DATA = TMP_DATA_DIR
process.env.PB_DISABLE_SYSTEM_PROXY = '1'

const {
  normalizeNetworkConfig,
  redactProxyUrl,
  setDefaultNetworkConfigGetter,
  resolveEffectiveProxy,
  proxyFetch,
  testNetworkConnectivity,
} = await import('../lib/net.js')
const { downloadPdf } = await import('../lib/arxiv.js')

const stats = { pass: 0, fail: 0 }

function messageOf(err) {
  return err && err.message ? err.message : String(err)
}

async function check(name, fn) {
  try {
    await fn()
    stats.pass += 1
    console.log('PASS  ' + name)
  } catch (error) {
    stats.fail += 1
    console.log('FAIL  ' + name)
    console.log('      ' + messageOf(error))
  }
}

// --- 纯内置 ASN.1 DER X.509 自签名证书生成（零外部 openssl 依赖） ------------

function derLen(len) {
  if (len < 0x80) return Buffer.from([len])
  const bytes = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derTlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content])
}

function derSeq(...items) {
  return derTlv(0x30, Buffer.concat(items))
}

function generateSelfSignedCert() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' })
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })

  // sha256WithRSAEncryption (1.2.840.113549.1.1.11)
  const sha256RsaOid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])
  const sigAlg = derSeq(sha256RsaOid, Buffer.from([0x05, 0x00]))

  // CN=mock-origin.test (2.5.4.3)
  const cnAttr = derSeq(
    Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]),
    derTlv(0x0c, Buffer.from('mock-origin.test', 'utf8')),
  )
  const nameDer = derSeq(derTlv(0x31, cnAttr))

  const validity = derSeq(
    derTlv(0x17, Buffer.from('240101000000Z', 'ascii')),
    derTlv(0x17, Buffer.from('351231235959Z', 'ascii')),
  )

  const serial = derTlv(0x02, Buffer.from([0x01]))
  const tbs = derSeq(serial, sigAlg, nameDer, validity, nameDer, spkiDer)

  const signature = crypto.sign('sha256', tbs, privateKey)
  const sigBitString = derTlv(0x03, Buffer.concat([Buffer.from([0x00]), signature]))
  const certDer = derSeq(tbs, sigAlg, sigBitString)
  const b64 = certDer.toString('base64').replace(/(.{64})/g, '$1\n').trim()
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`

  return { key: keyPem, cert: certPem }
}

function listenServer(server) {
  const sockets = new Set()
  server.on('connection', (sock) => {
    sockets.add(sock)
    sock.once('close', () => sockets.delete(sock))
  })
  server.__sockets = sockets
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(addr.port)
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      if (server.__sockets) {
        for (const sock of server.__sockets) sock.destroy()
        server.__sockets.clear()
      }
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

// --- 启动本地测试源站、HTTP 代理与 SOCKS5 代理 ------------------------------

const servers = []

/** 创建本地 HTTP 与 HTTPS 源站，支持重定向、压缩、流式慢响应与 PDF 载荷。 */
async function startOriginServers() {
  const { key, cert } = generateSelfSignedCert()
  let httpsPort = 0
  let httpPort = 0

  const handler = (proto) => (req, res) => {
    const u = new URL(req.url, `${proto}://127.0.0.1`)
    if (u.pathname === '/json') {
      const payload = JSON.stringify({ proto, path: u.pathname, query: u.searchParams.get('q') || '', host: req.headers.host })
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(payload)
      return
    }
    if (u.pathname === '/gzip') {
      const body = zlib.gzipSync(Buffer.from('压缩文本：学术代理测试 GZIP OK', 'utf8'))
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      res.end(body)
      return
    }
    if (u.pathname === '/deflate') {
      const body = zlib.deflateSync(Buffer.from('Deflate 解压正常', 'utf8'))
      res.writeHead(200, { 'Content-Encoding': 'deflate', 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      res.end(body)
      return
    }
    if (u.pathname === '/br') {
      const body = zlib.brotliCompressSync(Buffer.from('Brotli 解压正常', 'utf8'))
      res.writeHead(200, { 'Content-Encoding': 'br', 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      res.end(body)
      return
    }
    if (u.pathname === '/redirect-1') {
      res.writeHead(302, { Location: '/redirect-2', Connection: 'close' })
      res.end()
      return
    }
    if (u.pathname === '/redirect-2') {
      res.writeHead(301, { Location: '/json?q=redirected', Connection: 'close' })
      res.end()
      return
    }
    if (u.pathname === '/downgrade-to-http') {
      res.writeHead(302, { Location: `http://127.0.0.1:${httpPort}/sample.pdf`, Connection: 'close' })
      res.end()
      return
    }
    if (u.pathname === '/sample.pdf') {
      const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.5\n', 'latin1'), Buffer.alloc(4096, 0x41), Buffer.from('\n%%EOF\n', 'latin1')])
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdfBytes.length),
        Connection: 'close',
      })
      res.end(pdfBytes)
      return
    }
    if (u.pathname === '/slow-stream') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', Connection: 'close' })
      res.write(Buffer.from('chunk-1:'))
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer)
          return
        }
        res.write(Buffer.from('tick:'))
      }, 60)
      req.on('close', () => clearInterval(timer))
      return
    }
    res.writeHead(404, { Connection: 'close' })
    res.end('not found')
  }

  const httpSrv = http.createServer(handler('http'))
  const httpsSrv = https.createServer({ key, cert }, handler('https'))
  servers.push(httpSrv, httpsSrv)

  httpPort = await listenServer(httpSrv)
  httpsPort = await listenServer(httpsSrv)
  return { httpPort, httpsPort, cert }
}

/** 启动本地 HTTP 代理（支持普通 HTTP 转发、HTTPS CONNECT 隧道与可选 Basic 认证）。 */
async function startMockHttpProxy({ expectedAuth = '' } = {}) {
  const statsLog = { httpRequests: 0, connectTunnels: 0, lastAuth: '' }

  const checkAuth = (authHeader) => {
    statsLog.lastAuth = String(authHeader || '')
    if (!expectedAuth) return true
    const expected = 'Basic ' + Buffer.from(expectedAuth, 'utf8').toString('base64')
    return statsLog.lastAuth === expected
  }

  const proxySrv = http.createServer((req, res) => {
    if (!checkAuth(req.headers['proxy-authorization'])) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="mock"', Connection: 'close' })
      res.end('Proxy Auth Required')
      return
    }
    statsLog.httpRequests += 1
    const target = new URL(req.url)
    const targetHost = target.hostname === 'mock-origin.test' ? '127.0.0.1' : target.hostname
    const targetPort = Number(target.port) || 80
    const upstream = http.request(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: target.pathname + target.search,
        headers: { ...req.headers, host: target.host, connection: 'close' },
        agent: false,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      res.writeHead(502, { Connection: 'close' })
      res.end(err.message)
    })
    req.pipe(upstream)
  })

  proxySrv.on('connect', (req, clientSocket, head) => {
    if (!checkAuth(req.headers['proxy-authorization'])) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n')
      clientSocket.destroy()
      return
    }
    statsLog.connectTunnels += 1
    const [rawHost, rawPort] = String(req.url || '').split(':')
    const destHost = rawHost === 'mock-origin.test' ? '127.0.0.1' : rawHost
    const destPort = Number(rawPort) || 443

    const upstreamSocket = net.connect({ host: destHost, port: destPort }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
    })
    const destroyBoth = () => {
      clientSocket.destroy()
      upstreamSocket.destroy()
    }
    upstreamSocket.on('error', destroyBoth)
    clientSocket.on('error', destroyBoth)
  })

  servers.push(proxySrv)
  const port = await listenServer(proxySrv)
  return { port, statsLog }
}

/** 启动本地 SOCKS5 代理（支持 0x00 无认证与 0x02 用户名密码认证，支持 IPv4 0x01 与域名 0x03）。 */
async function startMockSocks5Proxy({ username = '', password = '' } = {}) {
  const statsLog = { connections: 0, domainLookups: [] }
  const requireAuth = Boolean(username || password)

  const socksSrv = net.createServer((client) => {
    client.on('error', () => {})
    let buf = Buffer.alloc(0)
    let stage = 'greeting'

    const processBuffer = () => {
      if (stage === 'greeting') {
        if (buf.length < 2) return
        const ver = buf[0]
        const nmethods = buf[1]
        if (buf.length < 2 + nmethods) return
        const methods = buf.subarray(2, 2 + nmethods)
        buf = buf.subarray(2 + nmethods)
        if (ver !== 0x05) {
          client.destroy()
          return
        }
        if (requireAuth) {
          if (!methods.includes(0x02)) {
            client.write(Buffer.from([0x05, 0xff]))
            client.destroy()
            return
          }
          stage = 'auth'
          client.write(Buffer.from([0x05, 0x02]))
        } else {
          stage = 'request'
          client.write(Buffer.from([0x05, 0x00]))
        }
      }

      if (stage === 'auth') {
        if (buf.length < 2) return
        const ulen = buf[1]
        if (buf.length < 2 + ulen + 1) return
        const plen = buf[2 + ulen]
        if (buf.length < 2 + ulen + 1 + plen) return
        const gotUser = buf.subarray(2, 2 + ulen).toString('utf8')
        const gotPass = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8')
        buf = buf.subarray(3 + ulen + plen)

        if (gotUser !== username || gotPass !== password) {
          client.write(Buffer.from([0x01, 0x01]))
          client.destroy()
          return
        }
        stage = 'request'
        client.write(Buffer.from([0x01, 0x00]))
      }

      if (stage === 'request') {
        if (buf.length < 4) return
        const cmd = buf[1]
        const atyp = buf[3]
        if (cmd !== 0x01) {
          client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          client.destroy()
          return
        }

        let targetHost = ''
        let offset = 4
        if (atyp === 0x01) {
          if (buf.length < 4 + 4 + 2) return
          targetHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          if (buf.length < 5) return
          const dlen = buf[4]
          if (buf.length < 5 + dlen + 2) return
          const domain = buf.subarray(5, 5 + dlen).toString('utf8')
          statsLog.domainLookups.push(domain)
          targetHost = domain === 'mock-origin.test' ? '127.0.0.1' : domain
          offset = 5 + dlen
        } else {
          client.destroy()
          return
        }

        const targetPort = buf.readUInt16BE(offset)
        const rest = buf.subarray(offset + 2)
        buf = Buffer.alloc(0)
        stage = 'tunnel'
        client.removeListener('data', onData)

        statsLog.connections += 1
        const upstream = net.connect({ host: targetHost, port: targetPort }, () => {
          // 返回 BND.ADDR = 127.0.0.1:0
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
          if (rest.length > 0) upstream.write(rest)
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on('error', () => {
          client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          client.destroy()
        })
        client.on('close', () => upstream.destroy())
      }
    }

    const onData = (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      processBuffer()
    }
    client.on('data', onData)
  })

  servers.push(socksSrv)
  const port = await listenServer(socksSrv)
  return { port, statsLog }
}

// --- 执行测试套件 -----------------------------------------------------------

try {
  await check('normalizeNetworkConfig：默认 auto、无协议补全 http://、合法协议通过、非法协议抛中文错', () => {
    assert.deepEqual(normalizeNetworkConfig(), { mode: 'auto', proxyUrl: '' })
    assert.deepEqual(normalizeNetworkConfig(null), { mode: 'auto', proxyUrl: '' })
    assert.deepEqual(redactProxyUrl('http://alice:secret123@127.0.0.1:7897'), {
      url: 'http://127.0.0.1:7897',
      authenticated: true,
    })
    assert.throws(
      () => normalizeNetworkConfig({ mode: 'custom', proxyUrl: 'http://alice:secret123@bad host' }),
      (error) => !error.message.includes('alice') && !error.message.includes('secret123'),
      '代理解析错误不能回显认证信息',
    )

    assert.deepEqual(normalizeNetworkConfig('direct'), { mode: 'direct', proxyUrl: '' })
    assert.deepEqual(normalizeNetworkConfig('127.0.0.1:7897'), {
      mode: 'custom',
      proxyUrl: 'http://127.0.0.1:7897',
    })
    assert.deepEqual(normalizeNetworkConfig({ mode: 'custom', proxyUrl: '127.0.0.1:7897' }), {
      mode: 'custom',
      proxyUrl: 'http://127.0.0.1:7897',
    })
    assert.deepEqual(normalizeNetworkConfig({ mode: 'custom', proxy: 'socks5://u:p@127.0.0.1:1080' }), {
      mode: 'custom',
      proxyUrl: 'socks5://u:p@127.0.0.1:1080',
    })
    assert.deepEqual(normalizeNetworkConfig({ mode: 'custom', proxyUrl: 'socks5h://127.0.0.1:1081' }), {
      mode: 'custom',
      proxyUrl: 'socks5h://127.0.0.1:1081',
    })

    // auto 模式下残留坏地址不崩，降级为空
    assert.deepEqual(normalizeNetworkConfig({ mode: 'auto', proxyUrl: 'ftp://127.0.0.1:21' }), {
      mode: 'auto',
      proxyUrl: '',
    })

    // custom 模式下非法协议或空地址抛出清晰中文错误
    assert.throws(() => normalizeNetworkConfig({ mode: 'custom', proxyUrl: 'ftp://127.0.0.1:21' }), /不支持的代理协议/)
    assert.throws(
      () => normalizeNetworkConfig({ mode: 'custom', proxyUrl: 'socks4://127.0.0.1:1080' }),
      /不支持的代理协议/,
    )
    assert.throws(() => normalizeNetworkConfig({ mode: 'custom', proxyUrl: 'not-a-valid-proxy' }), /代理地址/)
    assert.throws(() => normalizeNetworkConfig({ mode: 'custom', proxyUrl: '' }), /自定义代理模式/)
  })

  await check('resolveEffectiveProxy：回环绕过、direct / custom / auto、环境变量 + NO_PROXY 与 PB_DISABLE_SYSTEM_PROXY', () => {
    const cleanEnv = { PB_DISABLE_SYSTEM_PROXY: '1' }

    // 1. 回环目标默认绕过代理
    assert.deepEqual(
      resolveEffectiveProxy('http://127.0.0.1:8080/api', { mode: 'custom', proxyUrl: '127.0.0.1:7897' }, { env: cleanEnv }),
      { proxyUrl: '', source: 'none' },
    )
    assert.deepEqual(
      resolveEffectiveProxy('http://localhost:3000/api', { mode: 'auto' }, {
        env: { HTTPS_PROXY: 'http://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897', PB_DISABLE_SYSTEM_PROXY: '1' },
      }),
      { proxyUrl: '', source: 'none' },
    )
    assert.deepEqual(
      resolveEffectiveProxy('http://[::1]:3000/api', { mode: 'custom', proxyUrl: '127.0.0.1:7897' }, { env: cleanEnv }),
      { proxyUrl: '', source: 'none' },
    )

    // 2. direct 与 custom
    assert.deepEqual(
      resolveEffectiveProxy('https://export.arxiv.org/api/query', { mode: 'direct' }, { env: cleanEnv }),
      { proxyUrl: '', source: 'direct' },
    )
    assert.deepEqual(
      resolveEffectiveProxy('https://export.arxiv.org/api/query', { mode: 'custom', proxyUrl: '127.0.0.1:7897' }, { env: cleanEnv }),
      { proxyUrl: 'http://127.0.0.1:7897', source: 'custom' },
    )

    // 3. auto：配置项优先于环境变量
    assert.deepEqual(
      resolveEffectiveProxy(
        'https://export.arxiv.org/api/query',
        { mode: 'auto', proxyUrl: 'socks5://127.0.0.1:1080' },
        { env: { HTTPS_PROXY: 'http://127.0.0.1:7897', PB_DISABLE_SYSTEM_PROXY: '1' } },
      ),
      { proxyUrl: 'socks5://127.0.0.1:1080', source: 'config' },
    )

    // 4. auto：环境变量识别 + NO_PROXY 后缀匹配
    const mockEnv = {
      HTTPS_PROXY: '127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'internal.corp, .openalex.org, cnki.net:8080',
      PB_DISABLE_SYSTEM_PROXY: '1',
    }
    assert.deepEqual(resolveEffectiveProxy('https://export.arxiv.org/api/query', { mode: 'auto' }, { env: mockEnv }), {
      proxyUrl: 'http://127.0.0.1:7897',
      source: 'env',
    })
    assert.deepEqual(resolveEffectiveProxy('http://example.com/test', { mode: 'auto' }, { env: mockEnv }), {
      proxyUrl: 'http://127.0.0.1:7890',
      source: 'env',
    })
    assert.deepEqual(resolveEffectiveProxy('https://api.openalex.org/works', { mode: 'auto' }, { env: mockEnv }), {
      proxyUrl: '',
      source: 'none',
    })
    assert.deepEqual(resolveEffectiveProxy('https://sub.internal.corp/doc', { mode: 'auto' }, { env: mockEnv }), {
      proxyUrl: '',
      source: 'none',
    })
    assert.deepEqual(resolveEffectiveProxy('http://cnki.net:8080/paper', { mode: 'auto' }, { env: mockEnv }), {
      proxyUrl: '',
      source: 'none',
    })
    assert.deepEqual(resolveEffectiveProxy('http://cnki.net:9090/paper', { mode: 'auto' }, { env: mockEnv }), {
      proxyUrl: 'http://127.0.0.1:7890',
      source: 'env',
    })

    // 5. auto：无环境变量且 PB_DISABLE_SYSTEM_PROXY=1 时确定性返回 none
    assert.deepEqual(resolveEffectiveProxy('https://export.arxiv.org/api/query', { mode: 'auto' }, { env: cleanEnv }), {
      proxyUrl: '',
      source: 'none',
    })
  })

  const origin = await startOriginServers()
  const httpProxy = await startMockHttpProxy({ expectedAuth: 'alice:secret123' })
  const socksNoAuth = await startMockSocks5Proxy()
  const socksWithAuth = await startMockSocks5Proxy({ username: 'scholar', password: 'pw-42' })

  await check('HTTP 代理：普通 HTTP 转发 + HTTPS CONNECT 隧道 + Basic 代理认证 + 重定向与压缩解压', async () => {
    const proxyCfg = { mode: 'custom', proxyUrl: `http://alice:secret123@127.0.0.1:${httpProxy.port}` }

    // 1. 普通 HTTP 目标走 HTTP 代理 + 2 跳重定向后更新 res.url
    const redirRes = await proxyFetch(`http://127.0.0.1:${origin.httpPort}/redirect-1`, {
      proxyConfig: proxyCfg,
      allowLoopbackProxy: true,
    })
    assert.equal(redirRes.ok, true)
    assert.equal(redirRes.url, `http://127.0.0.1:${origin.httpPort}/json?q=redirected`)
    const data = await redirRes.json()
    assert.equal(data.proto, 'http')
    assert.equal(data.query, 'redirected')
    assert.ok(httpProxy.statsLog.httpRequests >= 3, '重定向每一跳均应经过 HTTP 代理')

    // 2. HTTPS 目标走 HTTP CONNECT 隧道升级 TLS（使用自签名 CA 验证 + 域名 mock-origin.test 免 allowLoopbackProxy）
    const httpsRes = await proxyFetch(`https://mock-origin.test:${origin.httpsPort}/gzip`, {
      proxyConfig: proxyCfg,
      ca: origin.cert,
    })
    assert.equal(httpsRes.ok, true)
    assert.equal(await httpsRes.text(), '压缩文本：学术代理测试 GZIP OK')
    assert.ok(httpProxy.statsLog.connectTunnels >= 1, 'HTTPS 请求应建立 CONNECT 隧道')

    // 3. deflate 与 br 压缩透明解压
    const deflateRes = await proxyFetch(`https://mock-origin.test:${origin.httpsPort}/deflate`, {
      proxyConfig: proxyCfg,
      ca: origin.cert,
    })
    assert.equal(await deflateRes.text(), 'Deflate 解压正常')

    const brRes = await proxyFetch(`https://mock-origin.test:${origin.httpsPort}/br`, {
      proxyConfig: proxyCfg,
      ca: origin.cert,
    })
    assert.equal(await brRes.text(), 'Brotli 解压正常')

    // 4. 错误的代理认证返回 407 并抛中文错
    await assert.rejects(
      proxyFetch(`https://mock-origin.test:${origin.httpsPort}/json`, {
        proxyConfig: { mode: 'custom', proxyUrl: `http://wrong:pass@127.0.0.1:${httpProxy.port}` },
        ca: origin.cert,
      }),
      /HTTP 407/,
    )
  })

  await check('SOCKS5 / SOCKS5H 代理：无认证 IPv4 (0x01) + 账号密码认证 (0x02) + 域名模式 (0x03) + HTTPS TLS 隧道', async () => {
    // 1. 无认证 SOCKS5 连接本地 IPv4 HTTP 目标
    const r1 = await proxyFetch(`http://127.0.0.1:${origin.httpPort}/json?q=socks-v4`, {
      proxyConfig: `socks5://127.0.0.1:${socksNoAuth.port}`,
      allowLoopbackProxy: true,
    })
    assert.equal(r1.ok, true)
    const j1 = await r1.json()
    assert.equal(j1.query, 'socks-v4')
    assert.equal(socksNoAuth.statsLog.connections, 1)

    // 2. 带用户名密码认证的 SOCKS5H + 域名 ATYP=0x03 + HTTPS TLS 隧道升级
    const r2 = await proxyFetch(`https://mock-origin.test:${origin.httpsPort}/json?q=socks-tls`, {
      proxyConfig: {
        mode: 'custom',
        proxyUrl: `socks5h://scholar:pw-42@127.0.0.1:${socksWithAuth.port}`,
      },
      ca: origin.cert,
    })
    assert.equal(r2.ok, true)
    const j2 = await r2.json()
    assert.equal(j2.proto, 'https')
    assert.equal(j2.query, 'socks-tls')
    assert.ok(socksWithAuth.statsLog.domainLookups.includes('mock-origin.test'))

    // 3. 错误密码在 SOCKS5 子协商阶段立即抛中文错
    await assert.rejects(
      proxyFetch(`https://mock-origin.test:${origin.httpsPort}/json`, {
        proxyConfig: `socks5://scholar:bad-pw@127.0.0.1:${socksWithAuth.port}`,
        ca: origin.cert,
      }),
      /SOCKS5 代理认证失败/,
    )
  })

  await check('流式二进制读取、HTTPS->HTTP 降级拦截、AbortSignal 与 timeoutMs 取消销毁', async () => {
    // 1. 流式下载 PDF 走默认网络配置 Getter（通过 SOCKS5 代理）
    setDefaultNetworkConfigGetter(async () => ({
      mode: 'custom',
      proxyUrl: `socks5://127.0.0.1:${socksNoAuth.port}`,
      allowLoopbackProxy: true,
    }))
    const destPdf = path.join(TMP_DATA_DIR, 'downloaded.pdf')
    try {
      const dl = await downloadPdf(`http://127.0.0.1:${origin.httpPort}/sample.pdf`, destPdf)
      assert.ok(dl.bytes > 4000)
      const head = (await fsp.readFile(destPdf)).subarray(0, 5).toString('latin1')
      assert.equal(head, '%PDF-')
    } finally {
      setDefaultNetworkConfigGetter(null)
    }

    // 2. HTTPS 重定向降级到明文 HTTP 时 res.url 更新为 http:// 并被 downloadPdf 拒绝
    const downgradeRes = await proxyFetch(`https://mock-origin.test:${origin.httpsPort}/downgrade-to-http`, {
      proxyConfig: `socks5://127.0.0.1:${socksNoAuth.port}`,
      ca: origin.cert,
    })
    assert.ok(downgradeRes.url.startsWith('http://'), '重定向后 res.url 应更新为明文 http 地址')
    downgradeRes.body.cancel()

    // 3. AbortSignal 流读取中途主动取消
    const ac = new AbortController()
    const streamRes = await proxyFetch(`http://127.0.0.1:${origin.httpPort}/slow-stream`, {
      proxyConfig: `socks5://127.0.0.1:${socksNoAuth.port}`,
      allowLoopbackProxy: true,
      signal: ac.signal,
    })
    let seenChunks = 0
    await assert.rejects(async () => {
      for await (const chunk of streamRes.body) {
        assert.ok(Buffer.isBuffer(chunk))
        seenChunks += 1
        if (seenChunks >= 2) ac.abort(new Error('用户主动中止流'))
      }
    }, /用户主动中止流/)

    // 4. timeoutMs 自动中止慢响应流
    await assert.rejects(async () => {
      const slowRes = await proxyFetch(`http://127.0.0.1:${origin.httpPort}/slow-stream`, {
        proxyConfig: { mode: 'direct' },
        timeoutMs: 140,
      })
      await slowRes.text()
    }, /请求超时/)

    // 5. testNetworkConnectivity 返回完整结构（指向已关闭的本地端口时快速返回失败详情）
    const closedSrv = net.createServer()
    const closedPort = await listenServer(closedSrv)
    await closeServer(closedSrv)
    const connReport = await testNetworkConnectivity({
      mode: 'custom',
      proxyUrl: `http://probe-user:probe-secret@127.0.0.1:${closedPort}`,
    })
    assert.equal(connReport.ok, false)
    assert.equal(connReport.effectiveProxy, `http://127.0.0.1:${closedPort}`)
    assert.equal(connReport.proxyAuthConfigured, true)
    assert.ok(!JSON.stringify(connReport).includes('probe-secret'))
    assert.equal(connReport.source, 'custom')
    assert.equal(typeof connReport.latencyMs, 'number')
    assert.equal(connReport.arxiv.ok, false)
    assert.ok(connReport.arxiv.error.length > 0)
    assert.equal(connReport.openalex.ok, false)
    assert.ok(connReport.openalex.error.length > 0)
  })
} finally {
  setDefaultNetworkConfigGetter(null)
  await Promise.all(servers.map(closeServer))
  await fsp.rm(TMP_DATA_DIR, { recursive: true, force: true }).catch(() => {})
}

console.log('\n结果：PASS ' + stats.pass + ' / FAIL ' + stats.fail)
if (stats.fail > 0) {
  process.exitCode = 1
} else {
  console.log('ALL PASS')
}
