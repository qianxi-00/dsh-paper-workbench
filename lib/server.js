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

/** 只接受本机 Host：DSH 的 web 服务绑在 localhost，跨站请求带的是别的 Host。 */
export function isTrusted(req) {
  const host = String(req.headers?.host || '').toLowerCase()
  if (host === '') return true
  return (
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host.startsWith('127.0.0.1:') ||
    host.startsWith('[::1]')
  )
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

export async function readJsonBody(req) {
  const buffer = await readBody(req, 8 * 1024 * 1024)
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
    createReadStream(filePath, { start, end: safeEnd }).pipe(res)
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': String(stat.size),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline; filename="paper.pdf"',
    'Cache-Control': 'no-store',
  })
  createReadStream(filePath).pipe(res)
}

/**
 * 生成请求处理器。
 * api 里除了普通 RPC 方法，还可选提供二进制钩子：
 *   pageImage({ id, page, scale }) -> { path, mime }
 *   rawPdf({ id }) -> { path }
 *   upload({ req, url }) -> { value }
 */
export function createHandler({ api, appDir, prefix }) {
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

      const fn = Object.prototype.hasOwnProperty.call(api, method) ? api[method] : null
      if (typeof fn !== 'function') {
        json(res, 404, { ok: false, error: 'no such method: ' + method })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const args = await readJsonBody(req)
      const value = await fn(args || {})
      json(res, 200, { ok: true, value })
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      console.error('[paper-workbench] 请求失败：' + message)
      json(res, 200, { ok: false, error: message })
    }
  }
}
