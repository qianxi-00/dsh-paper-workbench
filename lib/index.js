/**
 * dsh-paper-workbench 宿主端。
 *
 * 职责：
 *   - 静态页：/paper-workbench/app  —— 工作台 SPA（vanilla JS，无构建）
 *   - 接口：  /paper-workbench/api/* —— 文献库、PDF 取文/渲页、检索、Obsidian 读写
 *   - 工具：  ctx.tools.register(...) —— 供原生会话里的 agent 调用
 *
 * 约定：外置插件不能用 @deepseek-ai/dsh-tools 的 defineTool（profile 里没有该包），
 * 因此工具一律用裸 JSON-Schema 定义注册（同 dsh-git-forge 的做法）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-paper-workbench'
export const inject = ['webServer', 'tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const APP_DIR = path.join(ROOT, 'assets', 'app')
export const PREFIX = '/paper-workbench'

const MIME = {
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
function isTrusted(req) {
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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' })
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

async function serveAsset(res, relative) {
  const clean = String(relative || '').replace(/^\/+/, '')
  const target = path.resolve(APP_DIR, clean === '' ? 'index.html' : clean)
  // 防目录穿越：解析后必须仍在 APP_DIR 内
  if (target !== APP_DIR && !target.startsWith(APP_DIR + path.sep)) {
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
  const ext = path.extname(target).toLowerCase()
  send(res, 200, body, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': String(body.length),
  })
}

/**
 * 宿主侧能力集合。P0 阶段只有 health；后续阶段逐个挂上真实实现。
 * 每个方法签名：async (args) => object。
 */
function createApi() {
  return {
    health: async () => ({
      ok: true,
      plugin: 'dsh-paper-workbench',
      phase: 'skeleton',
      root: ROOT,
      time: new Date().toISOString(),
    }),
  }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-paper-workbench] webServer 服务不可用，插件未加载')
    return
  }

  const api = createApi()
  console.log('[dsh-paper-workbench] 宿主已加载，静态目录：' + APP_DIR)

  // 工作台 SPA：单条 prefix 路由同时覆盖 /app 与 /app/*
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: PREFIX + '/app',
      handler: async (req, res) => {
        if (!isTrusted(req)) {
          json(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const rest = url.pathname.slice((PREFIX + '/app').length)
        await serveAsset(res, rest)
      },
    }),
  )

  // 客户端 RPC：POST + JSON
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: PREFIX + '/api',
      handler: async (req, res) => {
        if (!isTrusted(req)) {
          json(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const method = (url.pathname.replace(new RegExp('^' + PREFIX + '/api/?'), '') || '').replace(/\/+$/, '')
        const fn = Object.prototype.hasOwnProperty.call(api, method) ? api[method] : null
        if (fn === null) {
          json(res, 404, { ok: false, error: 'no such method: ' + method })
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const args = await readJsonBody(req)
          const value = await fn(args || {})
          json(res, 200, { ok: true, value })
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          console.error('[dsh-paper-workbench] api/' + method + ' 失败：' + message)
          json(res, 200, { ok: false, error: message })
        }
      },
    }),
  )
}
