#!/usr/bin/env node
/**
 * 独立调试服务器：不重启 DSH 就能调试 SPA 与全部接口。
 *
 *   node scripts/dev-server.mjs [端口]
 *   然后浏览器打开 http://127.0.0.1:57571/paper-workbench/app
 *
 * 它和宿主里跑的是同一份 lib/server.js + createApi()，所以这里调通的行为
 * 装进 DSH 后一致（差别只有认证/Host 检查与真实数据目录）。
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApi } from '../lib/index.js'
import { createHandler } from '../lib/server.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PORT = Number(process.argv[2] || 57571)
const handler = createHandler({ api: createApi(), appDir: path.join(ROOT, 'assets', 'app'), prefix: '/paper-workbench' })

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error('[dev] 未捕获异常：' + error.stack)
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: String(error && error.message) }))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[dev] http://127.0.0.1:' + PORT + '/paper-workbench/app')
})
