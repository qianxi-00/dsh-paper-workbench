import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../assets/app/app.js', import.meta.url), 'utf8')
const origin = 'http://paper.test'
const paper = { id: 'paper-a', title: 'Paper A', pageCount: 6, status: 'reading', topics: [], tags: [] }
const other = { ...paper, id: 'paper-b', title: 'Paper B' }
const doc = {
  revision: 'revision-a',
  sections: [{ id: 's1', title: 'Introduction', page: 1 }, { id: 's2', title: 'Methods', page: 3 }],
  paragraphs: [
    { id: 'p1', blockId: 'b-one', section: 's1', page: 1, kind: 'body', hash: 'hash-one', text: 'First paragraph with $x^2 + y^2 = z^2$ inline formula.' },
    { id: 'p2', blockId: 'b-two', section: 's2', page: 3, kind: 'body', hash: 'hash-two', text: 'Second paragraph.' },
  ],
}

// Only platform boundaries are doubled: the unmodified application script runs its real boot/render/handlers.
class Element {
  constructor(tag = 'div', text = '') {
    this.tagName = tag.toUpperCase(); this.nodeType = tag === '#text' ? 3 : 1
    this.children = []; this.attributes = {}; this.listeners = {}; this.style = {}; this.dataset = {}
    this._text = text; this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100
    this.value = ''; this.hidden = false
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' ') },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' ') },
      toggle: (name, on) => { const next = on === undefined ? !this.classList.contains(name) : on; this.classList[next ? 'add' : 'remove'](name); return next },
    }
  }
  get className() { return this.attributes.class || '' }
  set className(value) { this.attributes.class = value }
  get id() { return this.attributes.id || '' }
  set id(value) { this.attributes.id = value }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set textContent(value) { this._text = String(value); this.children = [] }
  set innerHTML(value) { this.textContent = value }
  get parentNode() { return this.parentElement }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'disabled') this.disabled = true }
  getAttribute(key) { return this.attributes[key] ?? null }
  removeAttribute(key) { delete this.attributes[key] }
  append(...nodes) { for (let node of nodes.flat()) { if (!(node instanceof Element)) node = new Element('#text', String(node)); node.parentElement = this; this.children.push(node) } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes) }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this) }
  insertBefore(node, next) { const index = this.children.indexOf(next); if (index < 0) return this.append(node); node.parentElement = this; this.children.splice(index, 0, node) }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn) }
  async emit(type, extra = {}) { const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra }; for (const fn of this.listeners[type] || []) await fn(event) }
  matches(selector) {
    const attrs = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)]
    selector = selector.replace(/\[[^\]]+\]/g, '')
    if (attrs.some(([, key, value]) => !Object.hasOwn(this.attributes, key) || (value !== undefined && this.getAttribute(key) !== value))) return false
    const tag = /^[\w-]+/.exec(selector)?.[0]
    if (tag && this.tagName !== tag.toUpperCase()) return false
    const id = /#([\w-]+)/.exec(selector)?.[1]
    if (id && this.id !== id) return false
    return [...selector.matchAll(/\.([\w-]+)/g)].every(([, name]) => this.classList.contains(name))
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (selector.split(',').some(part => node.matches(part.trim()))) return node; return null }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(part => part.trim().split(/\s+/))
    const out = []
    const visit = node => { for (const child of node.children) { if (selectors.some(parts => {
      if (!child.matches(parts.at(-1))) return false
      let ancestor = child.parentElement
      for (let index = parts.length - 2; index >= 0; index--) { while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentElement; if (!ancestor) return false; ancestor = ancestor.parentElement }
      return true
    })) out.push(child); visit(child) } }
    visit(this); return out
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  contains(node) { return node === this || this.children.some(child => child.contains(node)) }
  scrollIntoView() { this.scrolled = true }
  focus() {}
  getBoundingClientRect() { return { left: 30, top: 80 } }
}

async function fixture(search = '?embed=1&native=1') {
  const body = new Element('body'); const html = new Element('html'); html.append(body)
  const app = new Element(); app.id = 'app'; const toast = new Element(); toast.id = 'toast'; body.append(app, toast)
  const document = Object.assign(new Element('document'), { body, documentElement: html, createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text), getElementById: id => html.querySelector('#' + id) })
  document.append(html)
  const messages = [], requests = [], errors = [], observers = []
  const parent = { postMessage(data, targetOrigin) { messages.push({ data: structuredClone(data), origin: targetOrigin }) } }
  const location = new URL('/paper-workbench/app' + search, origin)
  let selection = null
  const window = Object.assign(new Element('window'), { parent, location, innerWidth: 1200, crypto: { randomUUID: () => 'request-' + (messages.length + 1) }, getSelection: () => selection, confirm: () => true })
  const values = new Map()
  const fetch = async (url, init = {}) => {
    const args = init.body ? JSON.parse(init.body) : {}; requests.push({ url, args })
    if (url === '/paper-workbench/ai/translate') return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }
    const method = url.split('/api/')[1]
    const data = {
      health: { phase: 'p3', session: { available: true }, ai: { adhoc: true } },
      'ai.models': { ready: true, models: [] }, 'ai.settings.get': { config: {} },
      'library.list': { items: [paper, other], topics: [] }, 'ui.get': { state: {} }, 'ui.set': {},
      'conv.list': { items: [], activeId: '' }, 'chat.get': { messages: [] },
      'library.get': { meta: { ...(args.id === other.id ? other : paper) }, notes: { highlights: [] } },
      'pdf.text': { pages: [{ w: 600, h: 800, blocks: [] }] }, 'pdf.info': { pages: 6 }, 'library.update': {},
      'doc.get': { doc: structuredClone(doc), trans: { entries: { 'hash-one': { zh: '缓存译文' } } } },
      'figures.list': { figures: [] }, 'layout.status': {},
    }
    if (!Object.hasOwn(data, method)) throw new Error('Unexpected request: ' + url)
    return { ok: true, json: async () => ({ ok: true, value: data[method] }) }
  }
  const context = vm.createContext({ window, document, location, Node: Element, Element, URL, URLSearchParams, AbortController, TextDecoder,
    crypto: window.crypto, navigator: { clipboard: { writeText: async () => {} } }, fetch,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    console: { ...console, error: (...args) => errors.push(args) },
    IntersectionObserver: class { constructor(callback, options) { this.callback = callback; this.options = options; this.nodes = []; observers.push(this) } observe(node) { this.nodes.push(node) } disconnect() {} },
  })
  vm.runInContext(source, context, { filename: 'assets/app/app.js' })
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(errors, [], 'application boot should succeed') }
  await settle()
  return { window, document, app, toast, messages, requests, observers, api: window.__pb, settle,
    async receive(data, extra = {}) { await window.emit('message', { data: { __pb: true, v: 2, ...data }, source: parent, origin, ...extra }); await settle() },
    async open(id = paper.id) { await window.__pb.openPaper(id); await settle() },
    button(text) { const node = document.querySelectorAll('button').find(node => node.textContent === text); assert.ok(node, 'button: ' + text); return node },
    select(text, ids = ['para-p1', 'para-p2']) { const nodes = ids.map(id => document.getElementById(id)); selection = { rangeCount: 1, anchorNode: nodes[0], toString: () => text, getRangeAt: () => ({ intersectsNode: node => nodes.includes(node), getBoundingClientRect: () => ({ left: 30, top: 80 }) }) } },
    clearSelection() { selection = null },
  }
}

let passed = 0
async function check(name, run) { await run(); console.log('PASS  ' + name); passed++ }

await check('native boot emits reader state without mounting or loading legacy conversations', async () => {
  const f = await fixture()
  assert.equal(f.document.querySelector('.chat'), null)
  assert.equal(f.document.getElementById('split-chat'), null)
  assert.equal(f.requests.some(request => /conv\.|chat\.|session\/follow/.test(request.url)), false)
  assert.deepEqual(f.messages.filter(item => item.data.type === 'reader-state'), [{ origin, data: { __pb: true, v: 2, type: 'reader-state', paper: null } }])
})

await check('standalone boot keeps its existing chat and conversation loading', async () => {
  const f = await fixture('')
  assert.ok(f.document.querySelector('.chat'))
  assert.ok(f.requests.some(request => request.url.endsWith('/conv.list')))
  assert.equal(f.messages.length, 0)
})

await check('selection over 800 characters reaches the parent verbatim, with stable source identity', async () => {
  const f = await fixture()
  await f.open()
  await f.receive({ type: 'native-state', available: true, open: true, conversationId: 'c-one' })
  const text = '选中的正文 $x^2$。\n'.repeat(350)
  f.select(text)
  await f.document.getElementById('para-p1').emit('dblclick')
  const request = f.messages.findLast(item => item.data.type === 'paper-ask').data
  assert.equal(request.text, '讲解这段选中的原文：\n> ' + text)
  assert.equal(request.paperId, paper.id)
  assert.equal(request.blockId, 'b-one')
  assert.equal(request.revision, 'revision-a')
  assert.equal(request.scope, 'selection')
  assert.equal(f.requests.some(r => /chat.get|chat.save|session.ask|session\/follow/.test(r.url)), false)
  await f.receive({ type: 'paper-result', requestId: request.requestId, ok: true, message: '已发送一次' })
  assert.equal(f.toast.textContent, '已发送一次')
})

await check('bridge rejects unrelated windows and origins and switches only to the cited revision', async () => {
  const f = await fixture()
  await f.open()
  const target = { type: 'reader-navigate', paperId: paper.id, page: 3, blockId: 'b-two', revision: 'revision-a' }
  await f.receive(target, { source: {} })
  await f.receive(target, { origin: 'https://foreign.example' })
  assert.equal(f.api.state.page, 1)
  await f.receive(target)
  assert.equal(f.api.state.page, 3)
  assert.equal(f.api.state.tab, 'compare')
  assert.equal(f.document.getElementById('para-p2').scrolled, true)
  await f.receive({ ...target, revision: 'old-revision', page: 4 })
  assert.equal(f.api.state.page, 4)
  assert.equal(f.api.state.tab, 'page')
  assert.match(f.toast.textContent, /版本已变化/)
})

await check('native toggle goes to the parent, and translation remains a separate model request', async () => {
  const f = await fixture()
  await f.open()
  await f.document.querySelector('[data-pane="chat"]').emit('click')
  assert.equal(f.messages.at(-1).data.type, 'native-toggle')
  const count = f.messages.filter(item => item.data.type === 'paper-ask').length
  f.select('First paragraph.', ['para-p1'])
  f.api.translateSelection('First paragraph.')
  await f.settle()
  assert.equal(f.requests.filter(r => r.url === '/paper-workbench/ai/translate').length, 1)
  assert.equal(f.messages.filter(item => item.data.type === 'paper-ask').length, count)
  assert.equal(f.api.state.trans['hash-one'].zh, '缓存译文')
})

await check('an explicit chapter question is not redirected to a leftover selection', async () => {
  const f = await fixture()
  await f.open()
  await f.receive({ type: 'native-state', available: true, open: true, conversationId: 'c-one' })
  f.select('First paragraph.', ['para-p1'])
  const buttons = f.document.querySelectorAll('button').filter(node => node.getAttribute('title') === '让对话讲解本节')
  await buttons[1].emit('click')
  const request = f.messages.findLast(item => item.data.type === 'paper-ask').data
  assert.equal(request.sectionId, 's2')
  assert.equal(request.page, 3)
  assert.equal(request.blockId, null)
  assert.equal(request.scope, 'section')
})

await check('the floating native action preserves full text and its source after selection collapses', async () => {
  const f = await fixture()
  await f.open()
  await f.receive({ type: 'native-state', available: true, open: true, conversationId: 'c-one' })
  const text = 'Selected source with equation $x^2$.\n'.repeat(150)
  f.select(text, ['para-p2'])
  await f.document.emit('selectionchange')
  await f.document.emit('mouseup', { target: f.document.getElementById('para-p2') })
  f.clearSelection()
  await f.button('发送到会话').emit('click')
  const request = f.messages.findLast(item => item.data.type === 'paper-ask').data
  assert.ok(request.text.includes(text), 'full selected text must be retained')
  assert.equal(request.scope, 'selection')
  assert.equal(request.page, 3)
  assert.equal(request.blockId, 'b-two')
})

await check('native reading actions expose whole-paper scope and connection status without repainting selections', async () => {
  const f = await fixture()
  await f.open()
  const original = f.document.getElementById('para-p1')
  assert.match(f.document.getElementById('native-reader-status')?.textContent || '', /尚未连接/)
  await f.receive({ type: 'native-state', available: true, open: false, conversationId: 'c-one' })
  assert.equal(f.document.getElementById('para-p1'), original, 'connection status must not replace reader nodes')
  assert.equal(f.document.getElementById('native-reader-status').textContent, '')
  f.select('leftover selected paragraph', ['para-p1'])
  await f.button('总结全文').emit('click')
  const request = f.messages.findLast(item => item.data.type === 'paper-ask').data
  assert.equal(request.scope, 'paper')
  assert.equal(request.paperId, paper.id)
  assert.equal(request.blockId, null)
  await f.receive({ type: 'native-state', available: false, open: false })
  assert.match(f.document.getElementById('native-reader-status').textContent, /尚未连接/)
  assert.equal(f.button('总结全文').disabled, true)
})

await check('library comparison keeps both selected papers without requiring one to be open', async () => {
  const f = await fixture()
  await f.receive({ type: 'native-state', available: true, open: true, conversationId: 'c-one' })
  f.api.state.picked.add(paper.id)
  f.api.state.picked.add(other.id)
  f.api.render()
  await f.button('对比综述 (2)').emit('click')
  const request = f.messages.findLast(item => item.data.type === 'paper-ask')?.data
  assert.ok(request, 'comparison should reach the same native bridge')
  assert.equal(request.scope, 'papers')
  assert.deepEqual(request.paperIds, [paper.id, other.id])
  assert.ok(request.text.includes(paper.id) && request.text.includes(other.id))
})

await check('double-clicking a paragraph when browser auto-selects one word asks about the whole paragraph', async () => {
  const f = await fixture()
  await f.open()
  await f.receive({ type: 'native-state', available: true, open: true, conversationId: 'c-one' })
  f.select('First', ['para-p1'])
  await f.document.getElementById('para-p1').emit('dblclick')
  const request = f.messages.findLast(item => item.data.type === 'paper-ask').data
  assert.equal(request.text, '讲解这段选中的原文：\n> ' + doc.paragraphs[0].text)
  assert.equal(request.blockId, 'b-one')
  assert.equal(request.page, 1)
  assert.equal(request.sectionId, 's1')
  assert.equal(f.document.querySelector('#para-p1 .inline-math')?.getAttribute('data-tex'), '$x^2 + y^2 = z^2$')
})

await check('section citation jump, reading display modes, guide action, and general vault ask without open paper', async () => {
  const f = await fixture()
  await f.receive({ type: 'native-state', available: true, open: true, conversationId: 'c-one' })
  await f.button('在线检索').emit('click')
  await f.button('问笔记库').emit('click')
  const vaultAsk = f.messages.findLast(item => item.data.type === 'paper-ask')?.data
  assert.equal(vaultAsk?.scope, 'general')
  assert.equal(vaultAsk?.paperId, null)

  await f.open()
  await f.receive({ type: 'reader-navigate', paperId: paper.id, page: 3, sectionId: 's2', revision: 'revision-a' })
  assert.equal(f.api.state.tab, 'compare')
  assert.equal(f.api.state.sectionId, 's2')
  assert.equal(f.document.getElementById('sec-s2').scrolled, true)
  assert.equal(f.document.getElementById('sec-s2').classList.contains('flash'), true)

  await f.button('并排').emit('click')
  assert.equal(f.document.querySelector('.compare').classList.contains('side-by-side'), true)
  await f.button('原文').emit('click')
  assert.equal(f.document.querySelector('.compare').classList.contains('show-zh'), false)
  await f.button('只看译文').emit('click')
  assert.equal(f.document.querySelector('.compare').classList.contains('only-zh'), true)
  await f.button('双语').emit('click')
  assert.equal(f.document.querySelector('.compare').classList.contains('show-zh'), true)

  await f.button('导读').emit('click')
  const guideAsk = f.messages.findLast(item => item.data.type === 'paper-ask')?.data
  assert.equal(guideAsk?.scope, 'paper')
  assert.match(guideAsk?.text || '', /3 分钟阅读导览/)
})

await check('floating translate button works after selection collapses, clamps negative top, and extractCleanSelection preserves TeX while stripping translations', async () => {
  const f = await fixture()
  await f.open()
  await f.receive({ type: 'native-state', available: true, open: true, conversationId: 'c-one' })
  f.select('Second paragraph.', ['para-p2'])
  // Simulate selection starting scrolled above viewport (top: -300)
  const p2 = f.document.getElementById('para-p2')
  f.window.innerHeight = 800
  const customRange = {
    intersectsNode: node => node === p2,
    getBoundingClientRect: () => ({ left: 40, top: -300 }),
  }
  const prevGetSel = f.window.getSelection
  f.window.getSelection = () => ({ rangeCount: 1, anchorNode: p2, toString: () => 'Second paragraph.', getRangeAt: () => customRange })
  await f.document.emit('selectionchange')
  await f.document.emit('mouseup', { target: p2 })
  const menu = f.document.querySelector('.floating-menu')
  assert.ok(menu, 'floating menu should render')
  assert.ok(parseFloat(menu.style.top) >= 8, 'menu top must never be negative: ' + menu.style.top)
  // Collapse selection before clicking 翻译 (real browser mousedown behavior)
  f.window.getSelection = () => null
  const beforeTrans = f.requests.filter(r => r.url === '/paper-workbench/ai/translate').length
  await f.button('翻译').emit('click')
  await f.settle()
  const transReq = f.requests.filter(r => r.url === '/paper-workbench/ai/translate').at(-1)
  assert.equal(f.requests.filter(r => r.url === '/paper-workbench/ai/translate').length, beforeTrans + 1)
  assert.deepEqual(transReq.args.keys, ['hash-two'], 'must translate paragraph key rather than ad-hoc fallback')

  // Real cloneContents() test: bilingual selection strips .para-zh and keeps [data-tex]; interior math selection returns data-tex
  const compare = f.document.querySelector('.compare')
  const cloneNode = node => {
    const copy = new Element(node.tagName.toLowerCase(), node._text)
    copy.attributes = { ...node.attributes }
    for (const child of node.children) copy.append(cloneNode(child))
    return copy
  }
  const p1 = f.document.getElementById('para-p1')
  f.window.getSelection = () => ({
    rangeCount: 1,
    anchorNode: p1,
    toString: () => 'dirty selection including 缓存译文 and katex spans',
    getRangeAt: () => ({
      commonAncestorContainer: compare,
      cloneContents: () => {
        const frag = new Element('fragment')
        frag.append(cloneNode(p1), cloneNode(p2))
        return frag
      },
    }),
  })
  await f.document.emit('selectionchange')
  await f.button('讲解选中').emit('click')
  const cleanAsk = f.messages.findLast(item => item.data.type === 'paper-ask').data
  assert.match(cleanAsk.text, /\$x\^2 \+ y\^2 = z\^2\$/)
  assert.equal(cleanAsk.text.includes('缓存译文'), false, 'bilingual selection must strip .para-zh')

  const inlineMath = f.document.querySelector('#para-p1 .inline-math')
  f.window.getSelection = () => ({
    rangeCount: 1,
    anchorNode: inlineMath,
    toString: () => 'x2+y2=z2',
    getRangeAt: () => ({
      commonAncestorContainer: inlineMath,
      cloneContents: () => new Element('fragment', 'x2+y2=z2'),
    }),
  })
  await f.document.emit('selectionchange')
  await f.button('讲解选中').emit('click')
  const mathAsk = f.messages.findLast(item => item.data.type === 'paper-ask').data
  assert.equal(mathAsk.text, '讲解这段选中的原文：\n> $x^2 + y^2 = z^2$')
  f.window.getSelection = prevGetSel
})

console.log(`\nPASS ${passed} / FAIL 0`)
