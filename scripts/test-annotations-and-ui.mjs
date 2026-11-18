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
      builtAt: new Date().toISOString(),
      revision: 'rev-1',
      sections: [
        { id: 's1', title: '1 Introduction', page: 1, hash: '1111222233334444' },
        { id: 's2', title: '2 Method', page: 2, hash: '5555666677778888' },
      ],
      paragraphs,
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

    await check('设置页：并发度 1-8、Obsidian 开关与 publicConfig 密码掩码', async () => {
      const s0 = await rpcCall(baseUrl, 'settings.get')
      assert.equal(s0.config.obsidian.enabled, false, '新用户默认关闭 Obsidian 联动')
      const saved = await rpcCall(baseUrl, 'settings.set', {
        patch: {
          ai: { concurrency: 6 },
          obsidian: { enabled: false },
          database: { driver: 'postgres', password: 'secret-pg-password', host: '127.0.0.1', port: 5432, database: 'pb', user: 'u' },
        },
      })
      assert.equal(saved.config.ai.concurrency, 6)
      assert.equal(saved.config.database.password, '', '密码绝不能回传明文')
      assert.equal(saved.config.database.passwordConfigured, true)
      // 恢复默认 sqlite 供后续 UI 沙箱测试
      await rpcCall(baseUrl, 'settings.set', { patch: { database: { driver: 'sqlite' } } })
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
    const rpcUrls = []
    const uiFetch = async (url, init = {}) => {
      const target = String(url).startsWith('http') ? url : baseUrl + url
      rpcUrls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null })
      if (String(url).includes('/api/translate.pause') || String(url).includes('/ai/cancel')) pausedByClient = true
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

    await check('UI：切走论文仅 detach 流而不调 pause，在线页正确加载订阅主题与最新 Feed', async () => {
      pb.state.translateBusy = true
      pb.state.translateJob = { paperId, status: 'running', completed: 2, total: 8, concurrency: 2 }
      pb.state.translateAbort = new AbortController()
      pausedByClient = false
      // 模拟切论文
      await pb.openPaper(paperId)
      await settle()
      assert.equal(pausedByClient, false, '切论文绝对不能调用 pause 或 ai/cancel')

      // 打开在线检索页并加载最新 Feed
      const onlineBtn = document.querySelectorAll('button').find((b) => b.textContent === '在线检索')
      assert.ok(onlineBtn)
      await onlineBtn.emit('click')
      await settle()
      const pageText = document.body.textContent
      assert.match(pageText, /Latest Agent Paper/)
      assert.match(pageText, /大模型与智能体/)
      assert.match(pageText, /问文献库/)
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
