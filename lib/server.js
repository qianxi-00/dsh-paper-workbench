/**
 * HTTP 层：把 /paper-workbench/* 的路由与请求处理从插件入口里拆出来。
 *
 * 为什么拆：宿主插件模块只有重启 DSH 才会重新加载，但 SPA 和接口需要能单独调试。
 * scripts/dev-server.mjs 用同一个 handler 起一个本地端口，行为和宿主里完全一致。
 */
import { createReadStream, promises as fsp } from 'node:fs'
import path from 'node:path'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
}

/** 取出 host 里的主机名：'127.0.0.1:57571' → '127.0.0.1'，'[::1]:80' → '[::1]'。 */
function hostName(value) {
  const text = String(value || '').toLowerCase().trim()
  if (text === '') return ''
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    return end > 0 ? text.slice(0, end + 1) : text
  }
  const colon = text.lastIndexOf(':')
  return colon > 0 ? text.slice(0, colon) : text
}

function isLoopbackName(name) {
  if (name === '') return false
  if (name === 'localhost' || name === '127.0.0.1' || name === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/**
 * 只接受本机发起的请求。
 *
 * 只看 Host 不够：任意网页都能用 `fetch(..., {mode:'no-cors'})` 向 127.0.0.1 发
 * `text/plain` POST，而浏览器带的 Host 正是 127.0.0.1 —— 那等于给了跨站页面
 * 删库 / 改设置 / 调模型 / 往真实会话注入 prompt 的能力。所以：
 *   - Host 必须是 loopback（缺 Host 直接拒，浏览器一定会带）；
 *   - `Sec-Fetch-Site` 只允许 same-origin / none（老浏览器没有这个头就跳过）；
 *   - 有 `Origin` 时必须也是 loopback 的 http。
 */
export function isTrusted(req) {
  const headers = (req && req.headers) || {}
  if (!isLoopbackName(hostName(headers.host))) return false
  const site = String(headers['sec-fetch-site'] || '').toLowerCase()
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false
  const origin = String(headers.origin || '').trim()
  if (origin === '') return true
  if (origin.toLowerCase() === 'null') return false
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && isLoopbackName(hostName(url.host))
  } catch {
    return false
  }
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

export function json(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' })
}

export async function readBody(req, limitBytes = 512 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('上传内容超过上限')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export const JSON_BODY_LIMIT = 8 * 1024 * 1024
export const ATTACH_BODY_LIMIT = 64 * 1024 * 1024

export async function readJsonBody(req, limitBytes = JSON_BODY_LIMIT) {
  const buffer = await readBody(req, limitBytes)
  if (buffer.length === 0) return {}
  const text = buffer.toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

export async function serveAsset(res, appDir, relative) {
  const clean = String(relative || '').replace(/^\/+/, '')
  const target = path.resolve(appDir, clean === '' ? 'index.html' : clean)
  // 防目录穿越：解析后必须仍在 appDir 内
  if (target !== appDir && !target.startsWith(appDir + path.sep)) {
    json(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  let stat
  try {
    stat = await fsp.stat(target)
  } catch {
    json(res, 404, { ok: false, error: 'not found: ' + clean })
    return
  }
  if (!stat.isFile()) {
    json(res, 404, { ok: false, error: 'not a file: ' + clean })
    return
  }
  const body = await fsp.readFile(target)
  send(res, 200, body, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(body.length),
  })
}

/** 把文件塞进响应；source 的 'error' 必须自己收，否则 Node 会当未捕获异常把整个进程带走。 */
function pipeFile(filePath, res, options) {
  const stream = createReadStream(filePath, options)
  stream.on('error', (error) => {
    const message = error && error.message ? error.message : String(error)
    if (!res.headersSent) json(res, 500, { ok: false, error: '读取文件失败：' + message })
    else res.destroy(new Error('读取文件失败：' + message))
  })
  stream.pipe(res)
}

async function serveRaw(filePath, req, res) {
  const stat = await fsp.stat(filePath)
  // 浏览器原生 PDF 查看器会发 Range；只支持单段，够用且实现简单
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
  if (match) {
    const start = match[1] === '' ? Math.max(0, stat.size - Number(match[2] || 0)) : Number(match[1])
    const end = match[1] !== '' && match[2] !== '' ? Number(match[2]) : stat.size - 1
    const safeEnd = Math.min(end, stat.size - 1)
    if (start > safeEnd) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size })
      res.end()
      return
    }
    res.writeHead(206, {
      'Content-Type': 'application/pdf',
      'Content-Range': 'bytes ' + start + '-' + safeEnd + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(safeEnd - start + 1),
      'Cache-Control': 'no-store',
    })
    pipeFile(filePath, res, { start, end: safeEnd })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': String(stat.size),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline; filename="paper.pdf"',
    'Cache-Control': 'no-store',
  })
  pipeFile(filePath, res)
}

/**
 * 生成请求处理器。
 * api 里除了普通 RPC 方法，还可选提供二进制钩子：
 *   pageImage({ id, page, scale }) -> { path, mime }
 *   rawPdf({ id }) -> { path }
 *   upload({ req, url }) -> { value }
 * streams 是 v2 的流式 AI（SSE）：
 *   translate(body, { signal }) -> AsyncIterable<{ event, data }>
 *   chat(body, { signal })      -> AsyncIterable<{ event, data }>
 */
export function createHandler({ api, appDir, prefix, streams }) {
  /** reqId -> AbortController：让前端能用 /ai/cancel 主动停掉一次流。 */
  const inflight = new Map()

  async function handleStream(kind, req, res, presetBody) {
    const target = streams && typeof streams[kind] === 'function' ? streams[kind] : null
    if (target === null) {
      json(res, 503, { ok: false, error: 'AI 服务还没就绪：插件没有接入 DSH 的模型服务' })
      return
    }
    let sse
    try {
      sse = await import('./sse.js')
    } catch (error) {
      json(res, 503, { ok: false, error: '流式模块不可用：' + (error && error.message ? error.message : String(error)) })
      return
    }
    let body
    if (presetBody !== undefined) {
      body = presetBody
    } else {
      try {
        body = await readJsonBody(req)
      } catch (error) {
        json(res, 400, { ok: false, error: '请求体不是合法 JSON：' + (error && error.message ? error.message : String(error)) })
        return
      }
    }
    const controller = new AbortController()
    const streamBody = body && typeof body === 'object' ? body : {}
    const reqId = typeof streamBody.reqId === 'string' ? streamBody.reqId.slice(0, 120) : ''
    if (reqId) inflight.set(reqId, controller)
    const onClose = () => {
      if (reqId) inflight.delete(reqId)
      // 只写到一半就断了才算用户取消；正常 end() 之后 close 不该再 abort
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', onClose)
    try {
      // 工厂形式：客户端断开时 pipeSse 的 signal 会 abort，模型流才真正停下（省 token）；
      // 我们的 controller 用于 /ai/cancel，作为外部信号一起并进来。
      await sse.pipeSse(req, res, (signal) => target(streamBody, { signal }), { signal: controller.signal })
    } finally {
      res.off('close', onClose)
      if (reqId) inflight.delete(reqId)
      if (!res.writableEnded) {
        try {
          res.end()
        } catch {
          /* 连接已断，忽略 */
        }
      }
    }
  }

  return async function handler(req, res) {
    try {
      if (!isTrusted(req)) {
        json(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const url = new URL(req.url, 'http://localhost')
      const restPath = url.pathname.slice(prefix.length) || '/'

      // 静态页：/app 与 /app/*
      if (restPath === '/app' || restPath.startsWith('/app/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const relative = restPath.slice('/app'.length)
        await serveAsset(res, appDir, relative)
        return
      }

      // v3：原生会话（SSE，GET + query 参数；没有请求体）
      if (restPath === '/session/follow') {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        await handleStream('session', req, res, {
          id: String(url.searchParams.get('id') || ''),
          conversationId: String(url.searchParams.get('conv') || ''),
        })
        return
      }

      // v2：流式 AI（SSE）—— 必须在 JSON RPC 分支之前拦截
      if (restPath === '/ai/translate' || restPath === '/ai/chat') {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        await handleStream(restPath === '/ai/translate' ? 'translate' : 'chat', req, res)
        return
      }
      if (restPath === '/ai/cancel') {        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        let body = {}
        try {
          body = await readJsonBody(req)
        } catch {
          body = {}
        }
        const reqId = String((body && body.reqId) || '')
        const controller = inflight.get(reqId)
        if (controller === undefined) {
          json(res, 200, { ok: false, error: '没有进行中的请求：' + (reqId || '(空 reqId)') })
          return
        }
        controller.abort()
        inflight.delete(reqId)
        json(res, 200, { ok: true })
        return
      }

      if (!restPath.startsWith('/api')) {
        json(res, 404, { ok: false, error: 'not found: ' + restPath })
        return
      }
      const method = restPath.replace(/^\/api\/?/, '').replace(/\/+$/, '')

      if (method === 'page' && (req.method === 'GET' || req.method === 'HEAD')) {
        const image = await api.pageImage({
          id: String(url.searchParams.get('id') || ''),
          page: Number(url.searchParams.get('page') || 1),
          scale: Number(url.searchParams.get('scale') || 2),
          source: String(url.searchParams.get('source') || ''),
        })
        const body = await fsp.readFile(image.path)
        send(res, 200, body, { 'Content-Type': image.mime || 'image/png', 'Content-Length': String(body.length) })
        return
      }
      if (method === 'figure' && (req.method === 'GET' || req.method === 'HEAD')) {
        const image = await api.figureImage({
          id: String(url.searchParams.get('id') || ''),
          index: Number(url.searchParams.get('index') || 0),
        })
        const body = await fsp.readFile(image.path)
        send(res, 200, body, { 'Content-Type': image.mime || 'image/png', 'Content-Length': String(body.length) })
        return
      }
      if (method === 'raw' && (req.method === 'GET' || req.method === 'HEAD')) {
        const target = await api.rawPdf({ id: String(url.searchParams.get('id') || '') })
        await serveRaw(target.path, req, res)
        return
      }
      if (method === 'upload' && req.method === 'POST') {
        const value = await api.upload({ req, url })
        json(res, 200, { ok: true, value })
        return
      }

      // 二进制钩子只走上面各自的 GET 路由：不能被通用 JSON-RPC 调（否则 POST rawPdf
      // 会把 PDF 的绝对路径当 JSON 吐出来）。
      const BINARY_HOOKS = new Set(['pageImage', 'rawPdf', 'figureImage', 'upload'])
      const fn = BINARY_HOOKS.has(method)
        ? null
        : Object.prototype.hasOwnProperty.call(api, method)
          ? api[method]
          : null
      if (typeof fn !== 'function') {
        json(res, 404, { ok: false, error: 'no such method: ' + method })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const limit = method === 'conv.attach' ? ATTACH_BODY_LIMIT : JSON_BODY_LIMIT
      const args = await readJsonBody(req, limit)
      const value = await fn(args || {})
      json(res, 200, { ok: true, value })
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      console.error('[paper-workbench] 请求失败：' + message)
      json(res, 200, { ok: false, error: message })
    }
  }
}
