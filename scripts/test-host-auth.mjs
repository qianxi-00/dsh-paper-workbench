/** 宿主真实 apply → webServer.register 入口的鉴权回归；仅使用临时文库。 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-host-auth-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root
const { createHandler, isTrusted } = await import('../lib/server.js')
const host = await import('../lib/index.js')
const store = await import('../lib/store.js')
await store.setConfig({ workspace: { title: '鉴权测试', path: path.join(root, 'workspace') } })
let connection
let lookupThrows = false
let route
const cleanups = []
const ctx = {
  get(name) {
    if (name === 'webServer') return { register(value) { route = value; return () => {} } }
    if (name === 'connection') {
      if (lookupThrows) throw new Error('测试：服务查询失败')
      return connection
    }
  },
  tools: { register: () => () => {} },
  inject: () => {},
  effect(run) { cleanups.push(run()) },
}
host.apply(ctx)
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/paper-workbench')
const server = http.createServer((req, res) => {
  Promise.resolve(route.handler(req, res)).catch(error => {
    res.writeHead(500)
    res.end(error.message)
  })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const paths = [
  ['/app'], ['/app/app.js'], ['/api/page?id=private&page=1'],
  ['/api/figure?id=private&figure=1'], ['/api/raw?id=private'],
  ['/api/library.list', 'POST'], ['/api/upload?name=private.pdf', 'POST'],
  ['/session/follow'], ['/translate/follow'],
  ['/ai/translate', 'POST'], ['/ai/chat', 'POST'], ['/ai/cancel', 'POST'],
]
function request(endpoint, method = 'GET', headers = {}) {
  return fetch(origin + '/paper-workbench' + endpoint, { method, headers, redirect: 'manual' })
}
try {
  await test('HTTP 回环 Host / Origin 准入', async t => {
    let businessCalls = 0
    const handler = createHandler({
      prefix: '/paper-workbench', appDir: path.resolve('assets/app'),
      api: { probe: async () => { businessCalls++; return { reached: true } } },
    })
    const cases = [
      ...[
        ['localhost', true], ['LOCALHOST:43127', true],
        ['127.0.0.0', true], ['127.0.0.1:43127', true],
        ['127.42.8.9:43127', true], ['127.255.255.255:43127', true],
        ['[::1]', true], ['[::1]:43127', true],
        ['127.256.0.1', false], ['127.0.256.1:43127', false], ['127.0.0.256', false],
        ['127.999.999.999:43127', false], ['127.0.0', false],
        ['127.0.0.1.example', false], ['128.0.0.1:43127', false],
      ].map(([host, trusted]) => [host, { host }, trusted]),
      ['缺少 Host', {}, false],
      ['HTTP 回环 Origin', { host: '127.0.0.1:43127', origin: 'http://127.0.0.1:43127', 'sec-fetch-site': 'same-origin' }, true],
      ['localhost Origin', { host: 'localhost', origin: 'http://localhost:43127', 'sec-fetch-site': 'none' }, true],
      ['IPv6 Origin', { host: '[::1]:43127', origin: 'http://[::1]:43127' }, true],
      ['null Origin', { host: '127.0.0.1', origin: 'null' }, false],
      ['越界数字 Origin', { host: '127.0.0.1', origin: 'http://127.999.999.999:43127' }, false],
      ['HTTPS Origin', { host: '127.0.0.1', origin: 'https://127.0.0.1' }, false],
      ['外部 Origin', { host: '127.0.0.1', origin: 'http://foreign.example' }, false],
      ['cross-site', { host: '127.0.0.1', origin: 'http://127.0.0.1', 'sec-fetch-site': 'cross-site' }, false],
      ['same-site', { host: '127.0.0.1', 'sec-fetch-site': 'same-site' }, false],
    ]
    for (const [name, headers, trusted] of cases) {
      await t.test((trusted ? '允许 ' : '拒绝 ') + name, async () => {
        let reads = 0
        let status
        let body
        const before = businessCalls
        const req = {
          method: 'POST', url: '/paper-workbench/api/probe', headers,
          async *[Symbol.asyncIterator]() { reads++; yield Buffer.from('{}') },
        }
        await handler(req, {
          writeHead(value) { status = value },
          end(value) { body = JSON.parse(value) },
        })
        assert.equal(isTrusted(req), trusted)
        assert.equal(status, trusted ? 200 : 403)
        assert.equal(reads, trusted ? 1 : 0)
        assert.equal(businessCalls - before, trusted ? 1 : 0)
        assert.deepEqual(body, trusted ? { ok: true, value: { reached: true } } : { ok: false, error: 'forbidden' })
      })
    }
  })
  await test('宿主 HTTP 准入', async t => {
    await t.test('声明 connection 为必需宿主服务', () => {
      assert.ok(host.inject.includes('connection'))
    })
    await t.test('可信回环地址的未认证请求在所有路由返回 401', async () => {
      connection = { requestRejection(req) { assert.equal(this, connection); return req.headers.cookie === 'fixture=authenticated' ? undefined : 401 } }
      for (const [endpoint, method] of paths) {
        const response = await request(endpoint, method)
        assert.equal(response.status, 401, endpoint)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        await response.text()
      }
    })
    await t.test('宿主拒绝 403 原样保留且不进入 RPC', async () => {
      connection = { requestRejection: () => 403 }
      const response = await request('/api/library.list', 'POST')
      assert.equal(response.status, 403)
      await response.text()
    })
    for (const [name, value] of [['服务缺失', undefined], ['方法缺失', {}], ['方法抛错', { requestRejection() { throw new Error('secret-must-not-escape') } }], ['返回 null', { requestRejection: () => null }], ['返回 false', { requestRejection: () => false }], ['返回无效状态', { requestRejection: () => 200 }]]) {
      await t.test(name + ' 时拒绝访问', async () => {
        connection = value
        const response = await request('/app')
        assert.equal(response.status, 503)
        assert.ok(!(await response.text()).includes('secret-must-not-escape'))
      })
    }
    await t.test('服务查询异常时拒绝访问', async () => {
      lookupThrows = true
      try {
        const response = await request('/api/library.list', 'POST')
        assert.equal(response.status, 503)
        await response.text()
      } finally { lookupThrows = false }
    })
    await t.test('拒绝发生在读取请求体或上传文件之前', async () => {
      connection = { requestRejection: () => 401 }
      let reads = 0
      let status
      const req = {
        method: 'POST', url: '/paper-workbench/api/upload?name=denied.pdf',
        headers: { host: '127.0.0.1' },
        async *[Symbol.asyncIterator]() { reads++; yield Buffer.from('secret-upload') },
      }
      await route.handler(req, { writeHead(value) { status = value }, end() {} })
      assert.equal(status, 401)
      assert.equal(reads, 0)
    })
    await t.test('仅明确通过认证才继续提供静态资源和 RPC', async () => {
      connection = { requestRejection(req) { assert.equal(this, connection); return req.headers.cookie === 'fixture=authenticated' ? undefined : 401 } }
      const headers = { cookie: 'fixture=authenticated' }
      const app = await request('/app', 'GET', headers)
      assert.equal(app.status, 200)
      assert.match(await app.text(), /<!doctype html>/i)
      const api = await request('/api/library.list', 'POST', headers)
      assert.equal(api.status, 200)
      const body = await api.json()
      assert.equal(body.ok, true)
      assert.deepEqual(body.value.items, [])
      const head = await request('/app', 'HEAD', headers)
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')
    })
  })
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  for (const cleanup of cleanups.reverse()) if (typeof cleanup === 'function') await cleanup()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
