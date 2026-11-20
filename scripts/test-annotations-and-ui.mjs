#!/usr/bin/env node
/**
 * v1.0.0 富标注、持久化后台翻译、目录批量导入、Markdown 导出与前端 UI 综合自测。
 * 全程隔离在 os.tmpdir() 临时目录，不触碰真实 ~/.dsh/paper-workbench。
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const stamp = Date.now() + '-' + process.pid
const dataRoot = path.join(os.tmpdir(), 'pb-ui-v1-' + stamp)
process.env.DSH_PAPER_WORKBENCH_DATA = dataRoot

const { createApi, createStreams, PREFIX, setAiRuntime } = await import('../lib/index.js')
const { createHandler } = await import('../lib/server.js')
const store = await import('../lib/store.js')

const samplePdfBytes = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n',
  'latin1',
)

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log('PASS  ' + name)
}

async function rpcCall(baseUrl, method, args = {}) {
  const res = await fetch(baseUrl + PREFIX + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(method + ': ' + data.error)
  return data.value
}

// 构造轻量隔离 DOM 以运行真实 assets/app/app.js
class Element {
  constructor(tag = 'div', text = '') {
    this.tagName = tag.toUpperCase()
    this.nodeType = tag === '#text' ? 3 : 1
    this.children = []
    this.attributes = {}
    this.listeners = {}
    this.style = {}
    this.dataset = {}
    this._text = text
    this.scrollTop = 0
    this.scrollHeight = 100
    this.clientHeight = 100
    this.value = ''
    this.hidden = false
    this.classList = {
      contains: (n) => this.className.split(/\s+/).includes(n),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' ') },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((n) => !names.includes(n)).join(' ') },
      toggle: (n, on) => { const next = on === undefined ? !this.classList.contains(n) : on; this.classList[next ? 'add' : 'remove'](n); return next },
    }
  }
  get childNodes() { return this.children }
  get firstChild() { return this.children[0] || null }
  get nextSibling() {
    if (!this.parentElement) return null
    const i = this.parentElement.children.indexOf(this)
    return i >= 0 ? this.parentElement.children[i + 1] || null : null
  }
  get className() { return this.attributes.class || '' }
  set className(v) { this.attributes.class = v }
  get id() { return this.attributes.id || '' }
  set id(v) { this.attributes.id = v }
  get textContent() { return this.nodeType === 3 ? this._text : this._text + this.children.map((c) => c.textContent).join('') }
  set textContent(v) { this._text = String(v); this.children = [] }
  set innerHTML(v) { this.textContent = v }
  get parentNode() { return this.parentElement }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'disabled') this.disabled = true }
  getAttribute(k) { return this.attributes[k] ?? null }
  removeAttribute(k) { delete this.attributes[k] }
  append(...nodes) { for (let n of nodes.flat()) { if (!(n instanceof Element)) n = new Element('#text', String(n)); if (n.parentElement) n.remove(); n.parentElement = this; this.children.push(n) } }
  prepend(...nodes) { const list = nodes.flat().map((n) => { if (!(n instanceof Element)) n = new Element('#text', String(n)); if (n.parentElement) n.remove(); n.parentElement = this; return n }); this.children.unshift(...list) }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes) }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter((n) => n !== this); this.parentElement = null } }
  insertBefore(node, next) {
    if (!(node instanceof Element)) node = new Element('#text', String(node))
    if (node.parentElement) node.remove()
    const i = next ? this.children.indexOf(next) : -1
    node.parentElement = this
    if (i < 0) this.children.push(node)
    else this.children.splice(i, 0, node)
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn) }
  async emit(type, extra = {}) { const ev = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra }; for (const fn of this.listeners[type] || []) await fn(ev) }
  matches(selector) {
    const attrs = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)]
    selector = selector.replace(/\[[^\]]+\]/g, '')
    if (attrs.some(([, k, v]) => !Object.hasOwn(this.attributes, k) || (v !== undefined && this.getAttribute(k) !== v))) return false
    const tag = /^[\w-]+/.exec(selector)?.[0]
    if (tag && this.tagName !== tag.toUpperCase()) return false
    const id = /#([\w-]+)/.exec(selector)?.[1]
    if (id && this.id !== id) return false
    return [...selector.matchAll(/\.([\w-]+)/g)].every(([, name]) => this.classList.contains(name))
  }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (selector.split(',').some((p) => n.matches(p.trim()))) return n; return null }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map((p) => p.trim().split(/\s+/))
    const out = []
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((parts) => {
          if (!child.matches(parts.at(-1))) return false
          let anc = child.parentElement
          for (let i = parts.length - 2; i >= 0; i--) {
            while (anc && !anc.matches(parts[i])) anc = anc.parentElement
            if (!anc) return false
            anc = anc.parentElement
          }
          return true
        })) out.push(child)
        visit(child)
      }
    }
    visit(this)
    return out
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  contains(node) { return node === this || this.children.some((c) => c.contains(node)) }
  scrollIntoView() { this.scrolled = true }
  focus() {}
  getBoundingClientRect() { return { left: 40, top: 100 } }
}

async function main() {
  // 假 LLM 服务（按 DSH 原生 messages / text-delta 协议），供持久化后台翻译接口测试
  let translateCalls = 0
  setAiRuntime({
    llm: {
      listProviders: () => [{ id: 'mock', name: 'MockLLM' }],
      listModels: async () => [{ id: 'mock-m', name: 'Mock Model' }],
      async *stream(options) {
        translateCalls += 1
        const msgText = (options && options.messages && options.messages[0] && options.messages[0].content && options.messages[0].content[0] && options.messages[0].content[0].text) || ''
        const ids = [...String(msgText).matchAll(/"id":"([^"]+)"/g)].map((m) => m[1])
        await new Promise((r) => setTimeout(r, 40))
        yield { type: 'text-delta', index: 0, text: JSON.stringify(ids.map((id) => ({ id, zh: '中文翻译_' + id }))) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-m' }) },
  })

  const api = createApi()
  const streams = createStreams()
  const appDir = path.resolve(new URL('../assets/app', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const handler = createHandler({ api, appDir, prefix: PREFIX, streams })
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const baseUrl = 'http://127.0.0.1:' + port

  try {
    // 1. 准备带 6 段内容的测试论文目录与文档模型
    const importDir = path.join(dataRoot, 'seed-dir')
    await fsp.mkdir(path.join(importDir, 'Agents'), { recursive: true })
    await fsp.writeFile(path.join(importDir, 'Agents', 'DemoPaper.pdf'), samplePdfBytes)
    await fsp.writeFile(path.join(importDir, 'Agents', 'ignore.url'), 'https://example.com')

    await check('library.importDir 递归扫描 .pdf 并忽略非 PDF 与重复', async () => {
      const first = await rpcCall(baseUrl, 'library.importDir', { dir: importDir })
      assert.equal(first.scanned, 1)
      assert.equal(first.imported.length, 1)
      assert.deepEqual(first.imported[0].topics, ['Agents'])
      const second = await rpcCall(baseUrl, 'library.importDir', { dir: importDir })
      assert.equal(second.imported.length, 0)
      assert.equal(second.skipped.length, 1)
    })

    const list = await rpcCall(baseUrl, 'library.list')
    const paperId = list.items[0].id
    const baseDocRes = await rpcCall(baseUrl, 'doc.get', { id: paperId })
    const paragraphs = []
    for (let i = 1; i <= 8; i += 1) {
      paragraphs.push({
        id: 'p' + i,
        blockId: 'b' + i,
        section: i <= 4 ? 's1' : 's2',
        page: i <= 4 ? 1 : 2,
        kind: 'body',
        hash: String(i).repeat(16).slice(0, 16).replace(/./g, (c, idx) => ((i + idx) % 16).toString(16)),
        text: 'Paragraph ' + i + ' discusses $x^2 + y^2 = z^2$ with attention scaling.',
      })
    }
    await store.writeDoc(paperId, {
      ...(baseDocRes && baseDocRes.doc ? baseDocRes.doc : {}),
      version: 1,
      source: 'pdf-text',
      parserBuild: 'ir-4',
      builtAt: new Date().toISOString(),
      revision: 'rev-1',
      sections: [
        { id: 's1', title: '1 Introduction', page: 1, hash: '1111222233334444' },
        { id: 's2', title: '2 Method', page: 2, hash: '5555666677778888' },
      ],
      paragraphs,
    })

    await check('pdf.pageLines 与 pdf.cropRegion：返回精确页面尺寸、行坐标缓存与高清局部裁剪 PNG', async () => {
      const health = await rpcCall(baseUrl, 'health')
      if (!health.pdf || !health.pdf.ok) return
      const pl = await rpcCall(baseUrl, 'pdf.pageLines', { id: paperId, page: 1 })
      assert.equal(pl.page, 1)
      assert.equal(pl.width, 612)
      assert.equal(pl.height, 792)
      assert.ok(Array.isArray(pl.lines))

      const cropped = await rpcCall(baseUrl, 'pdf.cropRegion', {
        id: paperId,
        page: 1,
        rect: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.4 },
      })
      assert.equal(cropped.page, 1)
      assert.equal(cropped.mime, 'image/png')
      // 612 × 792 pt 页面，按 2.2 倍渲染；允许裁剪边界对齐到整数像素。
      assert.ok(Math.abs(cropped.width - 539) <= 2, `裁剪宽度异常：${cropped.width}`)
      assert.ok(Math.abs(cropped.height - 523) <= 2, `裁剪高度异常：${cropped.height}`)
      assert.match(cropped.imageBase64, /^iVBORw0KGgo/, '必须返回合法的 PNG base64')
    })

    await check('annotations / studyNotes CRUD 与 paper.exportMarkdown', async () => {
      const pKey = paragraphs[0].hash
      await rpcCall(baseUrl, 'annotations.save', {
        id: paperId,
        annotation: [
          { id: 'a1', paragraphKey: pKey, target: 'orig', kind: 'highlight', color: 'green', startOffset: 0, endOffset: 11, quote: 'Paragraph 1', page: 1 },
          { id: 'a2', paragraphKey: pKey, target: 'orig', kind: 'comment', color: 'yellow', startOffset: 12, endOffset: 21, quote: 'discusses', note: '关键术语说明', page: 1 },
        ],
      })
      const listed = await rpcCall(baseUrl, 'annotations.list', { id: paperId })
      assert.equal(listed.annotations.length, 2)
      const notesFile = await store.readNotes(paperId)
      assert.equal(notesFile.annotations.length, 2, 'annotations 必须镜像到 notes.json')

      await rpcCall(baseUrl, 'studyNotes.save', {
        id: paperId,
        note: { id: 'sn1', title: '§1 核心总结', scope: 'section', page: 1, markdown: '- 核心直觉：$x^2+y^2=z^2$' },
      })
      const exp = await rpcCall(baseUrl, 'paper.exportMarkdown', { id: paperId, includeTrans: true })
      assert.match(exp.markdown, /§1 核心总结/)
      assert.match(exp.markdown, /关键术语说明/)
      assert.match(exp.markdown, /Paragraph 1/)
    })

    await check('持久后台翻译：SSE 客户端中途断开不中断任务，显式暂停后可继续完成', async () => {
      const started = await rpcCall(baseUrl, 'translate.start', { id: paperId, concurrency: 2 })
      assert.equal(started.job.status, 'running')
      // 模拟客户端通过 /translate/follow 连上后立刻断连
      const ac = new AbortController()
      const followRes = await fetch(baseUrl + PREFIX + '/translate/follow?id=' + encodeURIComponent(paperId), { signal: ac.signal })
      assert.equal(followRes.status, 200)
      ac.abort()
      // 等待后台任务自然完成
      let st = null
      for (let t = 0; t < 60; t += 1) {
        await new Promise((r) => setTimeout(r, 30))
        st = (await rpcCall(baseUrl, 'translate.status', { id: paperId })).job
        if (st && st.status === 'done') break
      }
      assert.equal(st?.status, 'done', 'HTTP 断连后后台翻译仍须运行完成')
      assert.ok(translateCalls >= 1)
      const docGot = await rpcCall(baseUrl, 'doc.get', { id: paperId })
      assert.equal(Object.keys(docGot.trans.entries).length, 8)
      assert.equal(docGot.annotations.length, 2)
      assert.equal(docGot.studyNotes.length, 1)

      // 再加一组显式 暂停 -> 继续 验证（重译场景）
      const slowStarted = await rpcCall(baseUrl, 'translate.start', { id: paperId, concurrency: 1, retranslate: true })
      assert.equal(slowStarted.job.status, 'running')
      await new Promise((r) => setTimeout(r, 15))
      const paused = await rpcCall(baseUrl, 'translate.pause', { id: paperId })
      assert.equal(paused.job.status, 'paused')
      const resumed = await rpcCall(baseUrl, 'translate.resume', { id: paperId })
      assert.equal(resumed.job.status, 'running')
      for (let t = 0; t < 60; t += 1) {
        await new Promise((r) => setTimeout(r, 30))
        st = (await rpcCall(baseUrl, 'translate.status', { id: paperId })).job
        if (st && st.status === 'done') break
      }
      assert.equal(st?.status, 'done', '显式暂停后应可通过 translate.resume 继续完成')
    })

    await check('设置页：并发度 1-100、网络代理配置、全学科自定义主题与密码掩码', async () => {
      const s0 = await rpcCall(baseUrl, 'settings.get')
      assert.equal(s0.config.obsidian.enabled, false, '新用户默认关闭 Obsidian 联动')
      assert.equal(s0.config.ai.concurrency, 10, '默认翻译并发应为 10')
      assert.equal(s0.config.network.mode, 'auto', '默认代理模式应为 auto')
      const topicMeta = await rpcCall(baseUrl, 'search.topics')
      assert.equal(topicMeta.domains.length, 8, 'search.topics 应返回官方 8 大 arXiv 学科领域')

      const saved = await rpcCall(baseUrl, 'settings.set', {
        patch: {
          ai: { concurrency: 28 },
          obsidian: { enabled: false },
          network: { mode: 'custom', proxyUrl: 'http://proxy-user:proxy-test-secret@127.0.0.1:7897' },
          topics: {
            items: [
              { id: 'llm-agents', label: '大模型与智能体', domain: 'cs', categories: ['cs.AI'], keywords: ['agent'], enabled: true },
              { id: 'quantum-ec', label: '量子纠错与表面码', domain: 'physics', categories: ['quant-ph'], keywords: ['surface code'], enabled: true },
            ],
            feedSource: 'arxiv',
          },
          database: { driver: 'postgres', password: 'secret-pg-password', host: '127.0.0.1', port: 5432, database: 'pb', user: 'u' },
        },
      })
      assert.equal(saved.config.ai.concurrency, 28, '应支持超过 8 的高并发设置（如 28）')
      assert.equal(saved.config.network.mode, 'custom')
      assert.equal(saved.config.network.proxyUrl, 'http://127.0.0.1:7897')
      assert.equal(saved.config.network.proxyAuthConfigured, true)
      assert.ok(!JSON.stringify(saved.config.network).includes('proxy-test-secret'))
      assert.deepEqual(saved.config.topics.subscribed, ['llm-agents', 'quantum-ec'])
      assert.equal(saved.config.database.password, '', '密码绝不能回传明文')
      assert.equal(saved.config.database.passwordConfigured, true)

      const publicNetwork = saved.config.network
      const roundTripped = await rpcCall(baseUrl, 'settings.set', {
        patch: {
          network: { mode: 'custom', proxyUrl: publicNetwork.proxyUrl },
          topics: { items: [] },
          database: { driver: 'sqlite', clearPassword: true },
        },
      })
      assert.equal(roundTripped.config.network.proxyAuthConfigured, true, '保存脱敏代理地址时应保留既有认证信息')
      assert.ok(!JSON.stringify(await rpcCall(baseUrl, 'settings.get')).includes('proxy-test-secret'), 'settings.get 不得泄漏代理密码')
      assert.deepEqual((await rpcCall(baseUrl, 'settings.get')).config.topics.items, [], '显式空方向列表应在重新读取后保持为空')
      assert.equal((await store.getConfig()).network.proxyUrl, 'http://proxy-user:proxy-test-secret@127.0.0.1:7897')
      if (process.platform !== 'win32') {
        const configStat = await fsp.stat(path.join(dataRoot, 'config.json'))
        assert.equal(configStat.mode & 0o077, 0, '代理认证配置文件应限制为仅当前用户可读写')
      }

      const changedEndpoint = await rpcCall(baseUrl, 'settings.set', {
        patch: { network: { mode: 'custom', proxyUrl: 'http://127.0.0.1:8888' } },
      })
      assert.equal(changedEndpoint.config.network.proxyAuthConfigured, false, '换代理端点不得继承旧凭据')
      await rpcCall(baseUrl, 'settings.set', {
        patch: { network: { mode: 'custom', proxyUrl: 'http://proxy-user:proxy-test-secret@127.0.0.1:7897' } },
      })
      const clearedAuth = await rpcCall(baseUrl, 'settings.set', {
        patch: { network: { mode: 'custom', proxyUrl: publicNetwork.proxyUrl, clearProxyAuth: true } },
      })
      assert.equal(clearedAuth.config.network.proxyAuthConfigured, false, '显式清除认证应删除已存凭据')
      assert.equal((await store.getConfig()).network.proxyUrl, publicNetwork.proxyUrl)

      await store.setConfig({ network: { mode: 'custom', proxyUrl: null, proxy: 'http://legacy-user:legacy-secret@127.0.0.1:7897' } })
      const legacyCleared = await rpcCall(baseUrl, 'settings.set', {
        patch: { network: { mode: 'custom', proxyUrl: publicNetwork.proxyUrl, clearProxyAuth: true } },
      })
      assert.equal(legacyCleared.config.network.proxyAuthConfigured, false)
      const legacyNetwork = (await store.getConfig()).network
      assert.ok(!Object.hasOwn(legacyNetwork, 'proxy'), '清除认证时也必须移除旧 proxy 别名')
      assert.ok(!JSON.stringify(legacyNetwork).includes('legacy-secret'))
      for (const legacyProxy of [
        { mode: 'custom', proxy: 'http://legacy-user:legacy-secret@127.0.0.1:7897' },
        { mode: 'custom', proxyUrl: 'http://legacy-user:legacy-secret@127.0.0.1:7897', proxy: 'http://legacy-user:legacy-secret@127.0.0.1:7897' },
      ]) {
        const config = await store.getConfig()
        await fsp.writeFile(store.CONFIG_FILE, JSON.stringify({ ...config, network: legacyProxy }))
        globalThis.__pbStoreShared.config = null
        const migrated = await rpcCall(baseUrl, 'settings.get')
        assert.equal(migrated.config.network.proxyAuthConfigured, true, '旧代理配置应在真实装载后可用且脱敏')
        assert.ok(!JSON.stringify(migrated).includes('legacy-secret'))
        await rpcCall(baseUrl, 'settings.set', { patch: { network: { mode: 'custom', proxyUrl: publicNetwork.proxyUrl, clearProxyAuth: true } } })
        const disk = JSON.parse(await fsp.readFile(store.CONFIG_FILE, 'utf8'))
        assert.ok(!Object.hasOwn(disk.network, 'proxy'))
        assert.ok(!JSON.stringify(disk.network).includes('legacy-secret'))
      }

      const clamped = await rpcCall(baseUrl, 'ai.settings.set', { patch: { concurrency: 250 } })
      assert.equal(clamped.config.ai.concurrency, 100, '并发度上限收敛到 100')
      // 恢复默认 sqlite + auto 代理供后续 UI 沙箱测试
      await rpcCall(baseUrl, 'settings.set', { patch: { database: { driver: 'sqlite' }, network: { mode: 'auto', proxyUrl: '' }, topics: { resetDefaults: true } } })
    })

    // 2. 在隔离 DOM 中加载真实 app.js 并验证富标注渲染 / 选区清洁 / Obsidian 开关 UI / 在线 Feed
    const appSource = await fsp.readFile(new URL('../assets/app/app.js', import.meta.url), 'utf8')
    const body = new Element('body')
    const html = new Element('html')
    html.append(body)
    const appEl = new Element()
    appEl.id = 'app'
    const toastEl = new Element()
    toastEl.id = 'toast'
    body.append(appEl, toastEl)
    const document = Object.assign(new Element('document'), {
      body,
      documentElement: html,
      createElement: (t) => new Element(t),
      createTextNode: (t) => new Element('#text', t),
      getElementById: (id) => html.querySelector('#' + id),
    })
    document.append(html)

    let pausedByClient = false
    let onlineCalls = 0
    let zhTest = null
    const openedUrls = []
    const rpcUrls = []
    const uiFetch = async (url, init = {}) => {
      const target = String(url).startsWith('http') ? url : baseUrl + url
      rpcUrls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null })
      if (String(url).includes('/api/translate.pause') || String(url).includes('/ai/cancel')) pausedByClient = true
      if (zhTest && String(url).includes('/api/zhpdf.')) {
        let value
        if (String(url).endsWith('/zhpdf.status')) value = { exists: zhTest.built, stale: false, blocks: 1, job: zhTest.built ? { status: 'done' } : null }
        if (String(url).endsWith('/zhpdf.inspect')) {
          if (zhTest.hold) await zhTest.hold
          const entries = (await store.readTrans(paperId)).entries
          const missingKeys = zhTest.keys.filter(key => !entries[key]?.zh)
          value = { readyBlocks: zhTest.keys.length - missingKeys.length, missingKeys, crossPage: 0, unlocated: 0 }
        }
        if (String(url).endsWith('/zhpdf.prepare')) {
          zhTest.built = true
          zhTest.calls++
          value = { job: { status: 'running' } }
        }
        return { ok: true, json: async () => ({ ok: true, value }) }
      }
      if (String(url).includes('/api/search.online')) {
        onlineCalls++
        const args = JSON.parse(init.body || '{}')
        const offset = args.cursor ? 100 : 0
        return { ok: true, json: async () => ({ ok: true, value: {
          items: Array.from({ length: 100 }, (_, i) => ({ title: 'Search Paper ' + (offset + i + 1), arxivId: '2611.' + String(offset + i + 1).padStart(5, '0'), url: 'https://arxiv.org/abs/2611.' + String(offset + i + 1).padStart(5, '0'), source: 'arxiv' })),
          nextCursor: offset ? null : 'batch-2', hasMore: !offset, warnings: [],
        } }) }
      }
      if (String(url).includes('/api/search.latest')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            value: {
              topics: [{ id: 'llm-agents', label: '大模型与智能体' }],
              items: [
                { id: '2611.99999', title: 'Latest Agent Paper', authors: ['Alice'], publishedAt: '2026-11-18T00:00:00Z', source: 'arxiv', topicIds: ['llm-agents'], categories: ['cs.AI'], abstract: 'Fresh abstract', pdfUrl: 'https://arxiv.org/pdf/2611.99999.pdf' },
              ],
            },
          }),
        }
      }
      return fetch(target, init)
    }

    const windowObj = Object.assign(new Element('window'), {
      parent: { postMessage() {} },
      location: new URL('/paper-workbench/app?embed=1&native=1', baseUrl),
      innerWidth: 1280,
      innerHeight: 800,
      crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
      getSelection: () => null,
      confirm: () => true,
      prompt: () => '',
      open: (url) => { openedUrls.push(url); return {} },
    })
    const ls = new Map()
    const uiErrors = []
    const ctx = vm.createContext({
      window: windowObj,
      document,
      location: windowObj.location,
      Node: Element,
      Element,
      URL,
      URLSearchParams,
      AbortController,
      TextDecoder,
      Blob,
      crypto: windowObj.crypto,
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: uiFetch,
      localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v) },
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
      console: { ...console, error: (...a) => uiErrors.push(a) },
      IntersectionObserver: class { observe() {} disconnect() {} },
    })
    vm.runInContext(appSource, ctx, { filename: 'assets/app/app.js' })
    const settle = async () => {
      for (let i = 0; i < 15; i += 1) await new Promise((r) => setTimeout(r, 10))
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r))
    }
    await settle()
    for (let i = 0; i < 40 && !windowObj.__pb?.state?.health; i += 1) {
      await new Promise((r) => setTimeout(r, 15))
    }
    await settle()
    assert.deepEqual(uiErrors, [], '真实后端下前端启动零 console.error')

    const pb = windowObj.__pb
    await check('UI：Obsidian 关闭时隐藏「卡片」页签与「从笔记库导入」，显示「批量导入目录」与 DB 状态', async () => {
      assert.equal(document.querySelector('[data-tab="card"]'), null, '关闭 Obsidian 时应隐藏卡片页签')
      const buttons = document.querySelectorAll('button').map((b) => b.textContent)
      assert.equal(buttons.includes('从笔记库导入'), false)
      assert.equal(buttons.includes('批量导入目录'), true)
      assert.match(document.querySelector('.statusbar')?.textContent || '', /DB SQLITE/)
    })

    await check('UI：打开论文后恢复高亮/下划线/加粗/批注气泡/插入标签且选区提取保持整洁并保留 TeX', async () => {
      const pKey = paragraphs[0].hash
      await rpcCall(baseUrl, 'annotations.save', {
        id: paperId,
        annotation: [
          { id: 'a3', paragraphKey: pKey, target: 'orig', kind: 'underline', color: 'blue', startOffset: 0, endOffset: 9, quote: 'Paragraph', page: 1 },
          { id: 'a4', paragraphKey: pKey, target: 'orig', kind: 'bold', color: 'yellow', startOffset: 10, endOffset: 11, quote: '1', page: 1 },
          { id: 'a5', paragraphKey: pKey, target: 'orig', kind: 'insert', color: 'purple', startOffset: 22, endOffset: 22, quote: '', note: '行内补充：此处引用二次项', page: 1 },
        ],
      })
      // 模拟带有 .inline-math 的真实段落渲染
      await pb.openPaper(paperId)
      await settle()
      const paraEl = document.getElementById('para-p1')
      const origEl = paraEl.querySelector('.para-orig')
      // 确保 DOM 中同时包含 .ann-mark、.ann-bubble(💬) 与 .ann-insert-chip
      assert.ok(origEl.querySelector('.ann-mark'), '应渲染 .ann-mark')
      assert.ok(origEl.querySelector('.ann-bubble')?.textContent === '💬', '应渲染折叠 💬 批注气泡')
      assert.match(origEl.querySelector('.ann-insert-chip')?.textContent || '', /行内补充/, '应渲染插入标记')
      assert.ok(paraEl.querySelector('.para-tools')?.textContent.includes('清除标注'), '有标注段落应显示清除标注按钮')

      // 插入伪 .inline-math 验证 extractCleanSelection 剥离气泡和插入标签而保留原始内容
      origEl.append(Object.assign(new Element('span'), { className: 'inline-math', attributes: { class: 'inline-math', 'data-tex': '$E=mc^2$' }, _text: 'rendered' }))
      const clean = pb.extractCleanSelection(
        { rangeCount: 1, toString: () => 'dirty 💬 ‹+ 行内补充›', getRangeAt: () => ({ commonAncestorContainer: document.querySelector('.compare'), cloneContents: () => origEl }) },
        origEl,
      )
      assert.equal(clean.includes('💬'), false, 'extractCleanSelection 必须剥离批注气泡')
      assert.equal(clean.includes('行内补充'), false, 'extractCleanSelection 必须剥离插入标注标签')
      assert.match(clean, /\$E=mc\^2\$/, 'extractCleanSelection 必须保留 data-tex 公式')
    })

    await check('UI：逐段原文/译文独立收起展开、数字版原文页不误报扫描件且支持框选讲解与 8 大学科导航', async () => {
      const pKey = paragraphs[0].hash
      pb.toggleParaCollapse(pKey, 'orig')
      let pEl = document.getElementById('para-p1')
      assert.equal(pEl.classList.contains('collapsed-orig'), true, '应能单独收起原文')
      assert.ok(pEl.querySelector('.para-collapse-bar[data-collapse-part="orig"]'), '应展示原文收起提示条')

      pb.toggleParaCollapse(pKey, 'zh')
      pEl = document.getElementById('para-p1')
      assert.equal(pEl.classList.contains('collapsed-zh'), true, '应能同时收起译文')

      pb.toggleParaCollapse(pKey, 'all')
      pEl = document.getElementById('para-p1')
      assert.equal(pEl.classList.contains('collapsed-all'), true, '应能整段折叠为单行')
      pb.toggleParaCollapse(pKey, 'all')
      pEl = document.getElementById('para-p1')
      assert.equal(pEl.classList.contains('collapsed-all'), false, '再次点击应恢复展开')

      // 切到数字版 PDF 的「原文页」（meta.hasText = true），验证绝不误报「扫描件」且具备透明文本层与框选讲解入口
      await store.updateMeta(paperId, { hasText: true })
      pb.state.current.meta.hasText = true
      pb.state.blocks = []
      const pageTabBtn = document.querySelector('[data-tab="page"]')
      assert.ok(pageTabBtn)
      await pageTabBtn.emit('click')
      await settle()
      assert.equal(document.querySelector('.ocr-bar'), null, '数字版 PDF 即使当前 blocks 为空也绝不能误报扫描件')
      assert.ok(document.querySelector('.pdf-text-layer'), '原文页应挂载透明可交互文本层容器 .pdf-text-layer')
      assert.equal(document.querySelector('.page-wrap')?.textContent.includes('null'), false, '.page-wrap 绝不能渲染多余的 null 文本节点')
      // 验证 pdf_tool.py 真实返回的 { x, y, x2, y2, size, text } 行坐标可被渲染成 .pdf-line
      pb.state.pageLinesByPage[1] = {
        page: 1,
        width: 595,
        height: 842,
        lines: [{ x: 72, y: 96, x2: 420, y2: 112, size: 14, text: 'Improving Language Models' }],
      }
      await pb.ensurePageTextLayer(paperId, 1, document.querySelector('.page-wrap[data-page="1"]'))
      assert.equal(document.querySelectorAll('.pdf-line').length, 1, '应把 {x,y,x2,y2} 行坐标渲染为 .pdf-line span')
      const cropBtn = document.getElementById('page-crop-explain')
      assert.ok(cropBtn && cropBtn.textContent.includes('框选讲解'), '原文页应提供框选讲解按钮')
      await cropBtn.emit('click')
      assert.ok(document.querySelector('.crop-overlay'), '开启框选模式后应在页图上方渲染 .crop-overlay')
      await cropBtn.emit('click')
    })

    await check('UI：切走论文仅 detach 流而不调 pause，在线页正确加载 8 大学科、自定义订阅与最新 Feed', async () => {
      pb.state.translateBusy = true
      pb.state.translateJob = { paperId, status: 'running', completed: 2, total: 8, concurrency: 10 }
      pb.state.translateAbort = new AbortController()
      pausedByClient = false
      // 模拟切论文
      await pb.openPaper(paperId)
      await settle()
      assert.equal(pausedByClient, false, '切论文绝对不能调用 pause 或 ai/cancel')

      // 打开在线检索页并加载最新 Feed + 8 大学科导航
      const onlineBtn = document.querySelectorAll('button').find((b) => b.textContent === '在线检索')
      assert.ok(onlineBtn)
      await onlineBtn.emit('click')
      await settle()
      const pageText = document.body.textContent
      assert.match(pageText, /Latest Agent Paper/)
      assert.match(pageText, /大模型与智能体/)
      assert.match(pageText, /物理学/)
      assert.match(pageText, /定量金融/)
      assert.match(pageText, /问文献库/)
    })

    await check('UI：学科可折叠，检索100条按10篇翻页，跨批才请求并能从历史找回', async () => {
      const navToggle = document.getElementById('domain-nav-toggle')
      assert.ok(navToggle, '应提供可访问的学科折叠入口')
      await navToggle.emit('click')
      assert.equal(document.querySelector('.domain-row'), null)
      assert.equal(document.getElementById('domain-nav-toggle').getAttribute('aria-expanded'), 'false')
      await document.getElementById('domain-nav-toggle').emit('click')
      assert.ok(document.querySelector('.domain-row'))
      const input = document.querySelector('.online-bar input')
      input.value = 'attention'
      await input.emit('input')
      onlineCalls = 0
      await document.querySelectorAll('button').find(button => button.textContent === '检索').emit('click')
      await settle()
      assert.equal(onlineCalls, 1)
      assert.equal(rpcUrls.filter(row => row.url.includes('/api/search.online')).at(-1).body.limit, 100)
      assert.equal(document.querySelectorAll('.online-results .result').length, 10)
      assert.match(document.querySelector('.online-results').textContent, /Search Paper 1/)
      for (let i = 0; i < 9; i++) await document.querySelector('[data-page-next="online"]').emit('click')
      assert.equal(onlineCalls, 1, '批次内翻页不发远端请求')
      assert.match(document.querySelector('.online-results').textContent, /Search Paper 100/)
      await document.querySelector('[data-page-next="online"]').emit('click')
      await settle()
      assert.equal(onlineCalls, 2)
      assert.match(document.querySelector('.online-results').textContent, /Search Paper 101/)
      await document.querySelector('[data-page-prev="online"]').emit('click')
      assert.equal(onlineCalls, 2)
      const openOriginal = document.querySelector('.online-results').querySelectorAll('button').find(button => button.textContent === '打开原文页')
      await openOriginal.emit('click')
      await settle()
      assert.ok(openedUrls.at(-1).startsWith('https://arxiv.org/abs/'))
      await document.getElementById('browse-history-toggle').emit('click')
      await settle()
      assert.match(document.querySelector('.browse-history').textContent, /Search Paper 91/)
      assert.ok(document.querySelector('.library-state-legend'), '文库应说明阅读圆点含义')
    })

    await check('UI：目录批译常驻、合成正文无小操作、目录条目逐行且支持手动分类', async () => {
      await pb.openPaper(paperId)
      pb.state.expanded.add(pb.state.current.meta.topics?.[0] || '未分类')
      pb.state.doc.sections.push({ id: 'synthetic-body', title: '正文', synthetic: true, page: 1 })
      pb.state.doc.paragraphs.push({ id: 'toc-test', kind: 'list', role: 'toc-entry', tocLevel: 2, tocTargetPage: 2, page: 1, text: '2 Method ........ 2', hash: 'abcdefabcdefabcd' })
      pb.render()
      const titleButton = document.getElementById('translate-titles')
      assert.ok(titleButton && !titleButton.closest('details'), '一键翻译全部目录必须常驻可见')
      assert.equal(document.querySelector('[data-section="synthetic-body"] .outline-actions'), null)
      assert.ok(document.getElementById('para-toc-test').classList.contains('toc-entry'))
      const classify = document.querySelector('[data-classify-paper="' + paperId + '"]')
      assert.ok(classify, '每篇论文应提供分类入口')
      await classify.emit('click', { stopPropagation() {} })
      let input = document.getElementById('paper-category-input')
      input.value = 'New Research'
      await input.emit('input')
      await document.getElementById('paper-category-save').emit('click')
      await settle()
      assert.deepEqual((await rpcCall(baseUrl, 'library.get', { id: paperId })).meta.topics, ['New Research'])
      assert.ok(document.querySelector('.topic-title')?.textContent.includes('New Research'))
      await document.querySelector('[data-classify-paper="' + paperId + '"]').emit('click', { stopPropagation() {} })
      assert.ok(document.getElementById('paper-category-existing').textContent.includes('New Research'), '应能选择已有分类')
      await document.getElementById('paper-category-clear').emit('click')
      await settle()
      assert.deepEqual((await rpcCall(baseUrl, 'library.get', { id: paperId })).meta.topics, [])
      assert.ok(document.querySelector('.topic-title')?.textContent.includes('未分类'))
      assert.match(document.querySelector('.paper-row .dot')?.getAttribute('title') || '', /阅读中|未读|已读/)
    })

    await check('UI：中文 PDF 通过 prepare 启动，完成后切换，取消与旧代次保留原视图', async () => {
      await pb.openPaper(paperId)
      pb.state.tab = 'page'
      pb.render()
      const key = paragraphs[0].hash
      await store.deleteTransKeys(paperId, [key])
      zhTest = { keys: [key], built: false, calls: 0 }
      windowObj.confirm = () => false
      await document.getElementById('page-zhpdf').emit('click')
      assert.equal(zhTest.calls, 0)
      assert.equal(pb.state.zhMode, false)
      windowObj.confirm = () => true
      await document.getElementById('page-zhpdf').emit('click')
      await settle()
      assert.equal(zhTest.calls, 1)
      assert.equal(pb.state.zhMode, true)
      assert.equal(pb.state.zhBusy, false)
      // 相同论文重开也属于新代次，旧的确认/检查结果不得切换新界面。
      let release
      zhTest = { keys: [key], built: false, calls: 0, hold: new Promise(resolve => { release = resolve }) }
      pb.state.zhMode = false
      pb.render()
      const old = document.getElementById('page-zhpdf').emit('click')
      await settle()
      await pb.openPaper(paperId)
      assert.equal(pb.state.zhBusy, false)
      release()
      await old
      assert.equal(zhTest.calls, 0)
      assert.equal(pb.state.zhMode, false)
      zhTest = null
    })

    console.log('\nPASS ' + passed + ' / FAIL 0')
  } finally {
    server.close()
    await store.closeDb().catch(() => {})
    await fsp.rm(dataRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
