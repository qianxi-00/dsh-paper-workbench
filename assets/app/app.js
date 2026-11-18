/**
 * 论文工作台 SPA（vanilla JS，无构建）v2。
 *
 * 三块职责：
 *   1. 文献库：本地论文列表、按专题分组、搜索、导入（路径 / 上传 / Obsidian 卡片）。
 *   2. 阅读：默认「对照」连续视图（doc.sections/paragraphs + 中文译文），「原文页」保留页图，
 *      「笔记」「卡片」保留；目录只负责跳转，不再过滤内容。
 *   3. AI 面板内完成：翻译走 /ai/translate 的 SSE 逐段出字，对话走 /ai/chat 的 SSE 气泡；
 *      insertPrompt 只作为「插入到会话」的次要通道。
 *
 * 布局状态与展开状态存 localStorage（pb.layout.v1 / pb.tree.v1 / pb.ai.v1），刷新后保持。
 */

const API = '/paper-workbench/api/'
const TRANSLATE_URL = '/paper-workbench/ai/translate'
const FOLLOW_TRANSLATE_URL = '/paper-workbench/translate/follow'
const CHAT_URL = '/paper-workbench/ai/chat'
const NATIVE_READER = new URLSearchParams(window.location.search).get('native') === '1'
const app = document.getElementById('app')
const toastEl = document.getElementById('toast')

const LAYOUT_KEY = 'pb.layout.v1'
const TREE_KEY = 'pb.tree.v1'
const AI_KEY = 'pb.ai.v1'
// 面板每次重新挂载（关掉再打开 / 切走切回）都等于重开一个页面：
// 当前论文、页签、页码、滚动位置都记在这儿，回来时还原成离开时的样子。
const SESSION_KEY = 'pb.session.v1'
const LAYOUT_DEFAULT = { side: 272, outline: 200, chat: 340, sideOpen: true, outlineOpen: true, chatOpen: true }
// 三条分隔条：min/max 与默认值（与 CSS 的视觉宽度一致，拖到 <120 松手即收起）
const LAYOUT_LIMITS = {
  side: { min: 200, max: 520, def: 272, label: '文献库' },
  outline: { min: 160, max: 420, def: 200, label: '目录' },
  chat: { min: 280, max: 560, def: 340, label: '对话' },
}
const COLLAPSE_THRESHOLD = 120

const state = {
  papers: [],
  topics: [],
  filter: '',
  picked: new Set(),
  expanded: loadTree(), // 已展开的专题（默认空 = 全部收起）
  tempCollapsed: new Set(), // 搜索期间的临时收起，不写 localStorage
  current: null, // library.get: { meta, outline, notes, zhChars, ocr }
  openSeq: 0, // 打开论文的代次：快速切换时旧请求回来对不上就整段丢弃，防止串台
  doc: null, // doc.get 的 doc（sections/paragraphs）
  docError: '',
  docBusy: false,
  trans: {}, // hash(小写) -> { zh, model, at }；目录标题键是 t:<titleHash>
  tab: 'compare', // compare | page | notes | card | online
  page: 1,
  pageInfo: null,
  pageDims: {}, // 每页的 pt 尺寸（用于占位比例，避免滚动时页面高度乱跳）
  pageScrollTop: 0, // 原文连续滚动的位置（重绘后还原）
  pendingPage: 0, // 重绘后要滚到的页码（跳转/缩放时用）
  pageObserver: null,
  pageSpy: null,
  blocks: [],
  zoom: 1,
  fitScale: 2,
  layout: loadLayout(),
  ai: loadAiState(), // { translateOn, onlyZh }
  aiModels: null,
  aiConfig: null,
  sectionId: null,
  sectionObserver: null,
  streams: new Map(), // 翻译中的 key -> { status: pending|streaming|error, text, message }
  job: null, // { mode, keysBySection, totalParagraphs, totalSections, done:Set, failed:Set }
  translateAbort: null,
  translateBusy: false,
  translateError: '',
  translateReqId: '',
  translateTask: 0, // 翻译任务令牌：切论文后旧流的 finally 不能再动新论文的 state
  translateJob: null,
  translateDetached: false,
  chat: { messages: [], busy: false, abort: null, error: '', draft: '' },
  card: null,
  settings: null,
  fullConfig: null,
  settingsDraft: null,
  aiDraft: null,
  showSettings: false,
  selection: null,
  health: null,
  // 环境自检（设置页）：旧宿主没有 doctor.run，静默降级成一行提示
  doctor: { loading: false, report: null, error: '', unsupported: false },
  busy: '',
  online: { q: '', source: 'both', items: [], warnings: [], loading: false, error: '' },
  latestFeed: { loading: false, loaded: false, mode: 'subs', topicFilter: 'all', domainId: '', category: '', items: [], topics: [], domains: [], error: '', partialErrors: [] },
  dbTestResult: null,
  dbBusy: '',
  netTestResult: null,
  netBusy: '',
  topicEditor: null,
  collapsed: { orig: new Set(), zh: new Set(), all: new Set() },
  pageLinesByPage: {},
  pageLinesPending: new Set(),
  cropMode: false,
  annotations: [],
  studyNotes: [],
  annFilter: 'all',
  annPopover: null,
  ocr: null,
  ocrBusy: '',
  ocrToken: '',
  ocrClear: false,
  // v3：文内搜索 / PDF 深色 / 回收站 / 任务日志 / 自检 / 配图 / 原生会话
  search: { open: false, q: '', hits: [], active: 0, busy: false, error: '' },
  dark: loadDark(),
  trash: { open: false, items: [], busy: false, error: '' },
  logs: { open: false, events: [], lastSeq: 0, timer: null },
  review: null,
  reviewBusy: false,
  layoutBusy: false,
  zhMode: false,
  zhStatus: null,
  zhBusy: false,
  layoutJob: null,
  layoutResumable: false,
  layoutSavedPages: 0,
  layoutApplied: false,
  layoutQuality: null,
  layoutSchemaVersion: 0,
  layoutBadPages: 0,
  layoutReport: null,
  figures: [],
  figuresByKey: {},
  chatMode: 'session', // session = 落进真正的 DSH 会话；local = 插件自绘（老宿主兜底）
  session: { available: false, frames: [], streaming: false, abort: null, error: '', started: '' },
  // v3.1：一个「对话」= 一条 DSH 会话，可挂多篇论文 + 附件，多轮持久
  chats: { items: [], activeId: '', loading: false, error: '', available: true },
  convMenu: false,
  convPicker: { open: false, q: '' },
  attachBusy: false,
  native: { available: null, open: false, conversationId: '', blockId: '', pending: new Set() },
}

let pendingScrollReset = false
let readerStateKey = ''

function postNative(type, fields = {}) {
  if (NATIVE_READER && window.parent !== window) window.parent.postMessage({ __pb: true, v: 2, type, ...fields }, location.origin)
}

function notifyReaderState() {
  if (!NATIVE_READER) return
  const meta = state.current && state.current.meta
  const paper = meta ? {
    id: meta.id,
    title: String(meta.title || ''),
    revision: String((state.doc && state.doc.revision) || ''),
    page: state.page,
    sectionId: state.sectionId || (sectionsOf()[0] && sectionsOf()[0].id) || null,
    ...(state.native.blockId ? { blockId: state.native.blockId } : {}),
  } : null
  const key = JSON.stringify(paper)
  if (key === readerStateKey) return
  readerStateKey = key
  postNative('reader-state', { paper })
}

// 阅读器只负责论文定位和快捷提问；消息、附件、草稿由宿主原生会话管理。
function askNative(text, context = {}) {
  const comparing = context.scope === 'papers' && Array.isArray(context.paperIds) && context.paperIds.length > 1
  const general = context.scope === 'general'
  if (!state.current && !comparing && !general) { toast('先打开一篇论文'); return }
  if (state.native.available !== true) { toast('原生会话尚未连接，请在右侧选择或新建对话'); return }
  const paper = state.current?.meta || {}
  const isSelection = Boolean(context.selection) || context.scope === 'selection'
  const remembered = selectionMemory.text === context.selection && selectionMemory.paperId === paper.id && Date.now() - selectionMemory.at < SELECTION_MEMORY_MS
  const source = isSelection ? (context.explicitSource || (remembered ? selectionMemory.source : readerSelectionSource())) : null
  const requestId = crypto.randomUUID()
  state.native.pending.add(requestId)
  if (state.native.pending.size > 200) state.native.pending.delete(state.native.pending.values().next().value)
  postNative('paper-ask', {
    requestId,
    text: String(text),
    scope: isSelection ? 'selection' : context.scope || 'section',
    paperId: comparing || general ? null : paper.id,
    ...(comparing ? { paperIds: context.paperIds } : {}),
    page: general ? null : (source?.page || context.page || state.page),
    sectionId: general ? null : (source?.sectionId || context.sectionId || state.sectionId || null),
    blockId: general ? null : (source?.blockId || null),
    revision: general ? null : (source?.revision || state.doc?.revision || null),
    ...(context.attachment ? { attachment: context.attachment } : {}),
  })
  toast('正在发送到当前论文对话…')
}

function draftSelection(text, explicitSource = null) {
  if (!state.current) { toast('先打开一篇论文'); return }
  const clean = String(text || '').trim()
  if (clean.length < 2) { toast('请先选中一段正文'); return }
  const paper = state.current.meta || {}
  const remembered = selectionMemory.text === clean && selectionMemory.paperId === paper.id && Date.now() - selectionMemory.at < SELECTION_MEMORY_MS
  const source = explicitSource || (remembered ? selectionMemory.source : readerSelectionSource())
  const page = source?.page || state.page || 1
  const quoted = '> ' + clean.replace(/\n/g, '\n> ')
  if (NATIVE_READER) {
    if (state.native.available !== true) { toast('原生会话尚未连接，请在右侧选择或新建对话'); return }
    const params = new URLSearchParams({ paper: paper.id, page: String(page) })
    if (source?.sectionId) params.set('section', String(source.sectionId))
    if (source?.blockId) params.set('block', String(source.blockId))
    if (source?.revision) params.set('revision', String(source.revision))
    const citeLink = '[p.' + page + '](/paper-workbench/app?' + params.toString() + ')'
    const requestId = crypto.randomUUID()
    state.native.pending.add(requestId)
    postNative('paper-draft', {
      requestId,
      text: quoted + '\n\n出处：' + citeLink + '\n\n',
    })
    return
  }
  if (!state.layout.chatOpen) {
    state.layout.chatOpen = true
    saveLayout()
  }
  state.chat.draft = quoted + ' [p.' + page + ']\n\n'
  render(true)
  const input = document.getElementById('chat-input')
  if (input && typeof input.focus === 'function') input.focus()
  toast('已填入右侧输入框，继续输入追问即可')
}

function flashNode(node) {
  if (!node) return
  node.classList.add('flash')
  setTimeout(() => node.classList.remove('flash'), 1800)
}

let readerNavigation = 0
async function navigateReader(target) {
  if (!target || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(target.paperId || '') || !Number.isSafeInteger(target.page) || target.page < 1) return
  const epoch = ++readerNavigation
  const changing = state.current?.meta.id !== target.paperId
  const openSeq = state.openSeq + (changing ? 1 : 0)
  if (changing) await openPaper(target.paperId)
  if (epoch !== readerNavigation || openSeq !== state.openSeq || state.current?.meta.id !== target.paperId) return
  const revisionMatch = !target.revision || target.revision === state.doc?.revision
  const paragraph = target.revision && target.revision === state.doc?.revision && target.blockId
    ? state.doc.paragraphs.find(item => item.blockId === target.blockId) : null
  if (paragraph) {
    state.tab = 'compare'
    state.page = paragraph.page
    state.sectionId = paragraph.section
    state.native.blockId = paragraph.blockId
    render(true)
    const node = document.getElementById('para-' + paragraph.id) || (paragraph.section ? document.getElementById('sec-' + paragraph.section) : null)
    node?.scrollIntoView({ block: 'center' })
    flashNode(node)
    saveSession()
  } else if (!target.blockId && target.sectionId && revisionMatch && sectionsOf().some(item => item.id === target.sectionId)) {
    const section = sectionsOf().find(item => item.id === target.sectionId)
    state.tab = 'compare'
    state.page = section?.page || target.page
    state.sectionId = target.sectionId
    state.native.blockId = ''
    render(true)
    const heading = document.getElementById('sec-' + target.sectionId)
    heading?.scrollIntoView({ block: 'start' })
    flashNode(heading)
    saveSession()
  } else {
    state.native.blockId = ''
    jumpToPage(target.page)
    if (target.blockId || (target.revision && !revisionMatch)) toast('这条引用的段落版本已变化，已定位到原文页')
  }
  notifyReaderState()
}

window.addEventListener('message', event => {
  if (!NATIVE_READER || event.source !== window.parent || event.origin !== location.origin) return
  const message = event.data
  if (!message || message.__pb !== true || message.v !== 2) return
  if (message.type === 'native-state') {
    state.native.available = message.available === true
    state.native.open = message.open === true
    state.native.conversationId = String(message.conversationId || '')
    const button = document.querySelector('[data-pane="chat"]')
    if (button) button.classList.toggle('active', state.native.open)
    const status = document.getElementById('native-reader-status')
    if (status) status.textContent = nativeReaderStatus()
    for (const action of document.querySelectorAll('[data-native-ask]')) action.disabled = !state.native.available
  } else if (message.type === 'paper-result' && state.native.pending.delete(message.requestId)) {
    toast(message.message || (message.ok ? '已发送' : '发送失败，请查看右侧状态'))
  } else if (message.type === 'reader-navigate') {
    navigateReader(message).catch(error => toast(error.message))
  }
})

// ---------------------------------------------------------------- 小工具

function obsidianEnabled() {
  const obs = state.fullConfig && state.fullConfig.obsidian
  if (obs && typeof obs.enabled === 'boolean') return obs.enabled
  const hObs = state.health && state.health.obsidian
  if (hObs && typeof hObs.enabled === 'boolean') return hObs.enabled
  return true
}

function h(tag, props, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'style') Object.assign(node.style, value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'html') node.innerHTML = value
    else if (key === 'value') node.value = value
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

async function rpc(method, args = {}) {
  const response = await fetch(API + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const data = await response.json().catch(() => ({ ok: false, error: 'HTTP ' + response.status }))
  if (!data.ok) throw new Error(data.error || '请求失败（HTTP ' + response.status + '）')
  return data.value
}

let toastTimer = null
function toast(message, ms = 3200) {
  const duration = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 3200
  toastEl.textContent = message
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastEl.hidden = true
  }, duration)
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/** 够用的 Markdown 渲染：标题 / 引用 / 代码 / 粗体 / 列表 / 表格分隔线（卡片、OCR 用）。 */
function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inCode = false
  let inQuote = false
  let inList = false
  const closeList = () => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }
  const closeQuote = () => {
    if (inQuote) {
      out.push('</blockquote>')
      inQuote = false
    }
  }
  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList()
      closeQuote()
      out.push(inCode ? '</code></pre>' : '<pre><code>')
      inCode = !inCode
      continue
    }
    if (inCode) {
      out.push(escapeHtml(line) + '\n')
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      closeQuote()
      const level = Math.min(4, heading[1].length)
      out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>')
      continue
    }
    if (/^>\s?/.test(line)) {
      closeList()
      if (!inQuote) {
        out.push('<blockquote>')
        inQuote = true
      }
      out.push(inline(line.replace(/^>\s?/, '')) + '\n')
      continue
    }
    closeQuote()
    if (/^[-*+]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push('<li>' + inline(line.replace(/^[-*+]\s+/, '')) + '</li>')
      continue
    }
    closeList()
    if (/^\s*$/.test(line)) {
      out.push('')
      continue
    }
    out.push('<p>' + inline(line) + '</p>')
  }
  closeList()
  closeQuote()
  if (inCode) out.push('</code></pre>')
  return out.join('\n')
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function fmtAuthors(authors) {
  if (!Array.isArray(authors) || authors.length === 0) return ''
  return authors.length > 3 ? authors.slice(0, 3).join(', ') + ' 等' : authors.join(', ')
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('已复制'),
    () => toast('复制失败'),
  )
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function genId() {
  return (window.crypto && crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2)
}

function extractCleanSelection(selection, anchorElement) {
  const raw = selection ? String(selection) : ''
  if (!raw || !selection || selection.rangeCount === 0) return raw
  const range = typeof selection.getRangeAt === 'function' ? selection.getRangeAt(0) : null
  if (!range || typeof range.cloneContents !== 'function') return raw
  const inCompare = anchorElement?.closest?.('.compare')
  if (!inCompare) return raw
  const ancestor = range.commonAncestorContainer
  const ancestorEl = ancestor && (ancestor.nodeType === 1 ? ancestor : ancestor.parentElement)
  const texOwner = ancestorEl?.closest?.('[data-tex]')
  if (texOwner && typeof texOwner.getAttribute === 'function') {
    const directTex = texOwner.getAttribute('data-tex')
    if (directTex) return directTex
  }
  const onlyZh = Boolean(inCompare.classList?.contains('only-zh'))
  const startedInZh = Boolean(anchorElement?.closest?.('.para-zh'))
  const fragment = range.cloneContents()
  const chunks = []
  const visit = (node) => {
    if (!node) return
    if (node.nodeType === 3) {
      chunks.push(node.textContent || '')
      return
    }
    if (node.nodeType !== 1) return
    if (!startedInZh && !onlyZh && node.classList?.contains('para-zh')) return
    if ((startedInZh || onlyZh) && node.classList?.contains('para-orig')) return
    const cls = node.classList
    if (
      cls &&
      (cls.contains('formula-link') ||
        cls.contains('para-tools') ||
        cls.contains('para-collapse-bar') ||
        cls.contains('sel-trans') ||
        cls.contains('page-divider') ||
        cls.contains('formula-meta') ||
        cls.contains('algo-ln') ||
        cls.contains('footnote-tag') ||
        cls.contains('ann-bubble') ||
        cls.contains('ann-insert-chip') ||
        cls.contains('ann-popover'))
    ) {
      return
    }
    const tex = typeof node.getAttribute === 'function' ? node.getAttribute('data-tex') : null
    if (tex) {
      chunks.push(tex)
      return
    }
    const children = node.childNodes || node.children || []
    for (const child of children) visit(child)
    if (cls?.contains('para') || cls?.contains('sec-head') || cls?.contains('algo-line') || /^(P|DIV|H[1-4]|FIGURE|BLOCKQUOTE)$/.test(node.tagName || '')) {
      if (chunks.length > 0 && !/\n$/.test(chunks[chunks.length - 1])) chunks.push('\n')
    }
  }
  visit(fragment)
  const cleaned = chunks.join('').replace(/\n{3,}/g, '\n\n').trim()
  return cleaned || raw
}

function selectionText() {
  const selection = window.getSelection()
  if (!selection) return ''
  const anchor = selection.anchorNode
  const element = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
  return extractCleanSelection(selection, element)
}

/**
 * 划词取文不能只信「此刻」的选择区：
 * - 点按钮会把选择区塌成光标（鼠标按下处），String(selection) 变成空串或残余一两个字符；
 * - 重渲染换掉正文节点时，Chrome 会把选择区挪到新节点上，留下一段「不是用户选的东西」。
 * 所以拖选过程中（selectionchange）持续记住最后一次像样的选区文本，取文时优先用它。
 */
let selectionMemory = { text: '', at: 0, keys: [], host: null, pageRects: null }
const SELECTION_MEMORY_MS = 5 * 60 * 1000

function selectionHostNode() {
  const selection = window.getSelection()
  const anchor = selection && selection.anchorNode
  const start = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
  return start && start.closest ? start.closest('.blocks > *, .page-pane .page-wrap, .page-pane p, .markdown p, .para') : null
}

function capturePageSelectionRects() {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || typeof selection.getRangeAt !== 'function') return null
  const range = selection.getRangeAt(0)
  const anchor = range?.startContainer || selection.anchorNode
  const start = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
  const wrap = start?.closest?.('.page-wrap')
  if (!wrap || typeof wrap.getBoundingClientRect !== 'function' || typeof range.getClientRects !== 'function') return null
  const wb = wrap.getBoundingClientRect()
  if (!wb || !(wb.width > 0 && wb.height > 0)) return null
  const page = Number(wrap.getAttribute('data-page')) || state.page || 1
  const out = []
  for (const r of range.getClientRects() || []) {
    if (!r || !(r.width > 0.5 && r.height > 0.5)) continue
    const x = Math.max(0, Math.min(1, (r.left - wb.left) / wb.width))
    const y = Math.max(0, Math.min(1, (r.top - wb.top) / wb.height))
    const w = Math.max(0.002, Math.min(1 - x, r.width / wb.width))
    const h = Math.max(0.002, Math.min(1 - y, r.height / wb.height))
    out.push({ x, y, w, h })
  }
  return out.length > 0 ? { page, rects: out } : null
}

function readerSelectionSource() {
  const selection = window.getSelection()
  const range = selection && selection.rangeCount > 0 && typeof selection.getRangeAt === 'function' ? selection.getRangeAt(0) : null
  const node = range?.startContainer || selection?.anchorNode
  const startEl = node?.nodeType === 1 ? node : node?.parentElement
  const element = startEl?.closest?.('.para')
  const pageWrap = startEl?.closest?.('.page-wrap')
  const pageFromWrap = pageWrap ? Number(pageWrap.getAttribute('data-page')) || 0 : 0
  const paragraph = state.doc?.paragraphs?.find(item => 'para-' + item.id === element?.id)
  return { page: paragraph?.page || pageFromWrap || state.page, sectionId: paragraph?.section || state.sectionId || null,
    blockId: paragraph?.blockId || null, revision: state.doc?.revision || null }
}

function rememberReaderSelection(text) {
  if (text.trim().length < 2 || !state.current) return
  selectionMemory = {
    text,
    at: Date.now(),
    paperId: state.current.meta.id,
    source: readerSelectionSource(),
    keys: selectionParagraphKeys(),
    host: selectionHostNode(),
    pageRects: capturePageSelectionRects(),
  }
}

/** 用户此刻选中的正文（只在阅读区里算数，输入框/按钮里的选择不算）。 */
function liveReaderSelection() {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return ''
  const anchor = selection.anchorNode
  const element = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
  if (!element || !element.closest) return ''
  if (!element.closest('.compare, .page-pane, .markdown, .blocks')) return ''
  const text = extractCleanSelection(selection, element)
  return text.trim() ? text : ''
}

/** 取「用户想讲解的那段」：优先当前选区，选区被塌掉/换掉时退回刚才记住的那段。 */
function pickedText() {
  const live = liveReaderSelection()
  if (live.length >= 2) return live
  const remembered = selectionMemory.text
  const fresh = Date.now() - selectionMemory.at < SELECTION_MEMORY_MS
  if (fresh && remembered.length >= 2) return remembered
  return live
}

// ---------------------------------------------------------------- 持久化

function loadLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}')
    return {
      side: clampNumber(raw.side, LAYOUT_LIMITS.side.min, LAYOUT_LIMITS.side.max, LAYOUT_DEFAULT.side),
      outline: clampNumber(raw.outline, LAYOUT_LIMITS.outline.min, LAYOUT_LIMITS.outline.max, LAYOUT_DEFAULT.outline),
      chat: clampNumber(raw.chat, LAYOUT_LIMITS.chat.min, LAYOUT_LIMITS.chat.max, LAYOUT_DEFAULT.chat),
      sideOpen: raw.sideOpen !== false,
      outlineOpen: raw.outlineOpen !== false,
      chatOpen: raw.chatOpen !== false,
    }
  } catch {
    return { ...LAYOUT_DEFAULT }
  }
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout))
  } catch {
    /* 隐私模式禁用 localStorage 时忽略：只影响刷新后的宽度记忆 */
  }
  saveSessionSoon({ layout: state.layout })
}

function loadTree() {
  try {
    const raw = JSON.parse(localStorage.getItem(TREE_KEY) || '[]')
    return new Set(Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveTree() {
  try {
    localStorage.setItem(TREE_KEY, JSON.stringify([...state.expanded]))
  } catch {
    /* 同上 */
  }
  saveSessionSoon({ expanded: [...state.expanded] })
}

// ---------------------------------------------------------------- 会话（界面状态）记忆

let sessionRestoring = false

function loadSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

let sessionSaveTimer = 0
function saveSession(patch = {}, opts = {}) {
  if (sessionRestoring) return
  const meta = state.current && state.current.meta
  const scroller = document.querySelector('.compare-scroll')
  const existing = loadSession()
  const hasExplicitPaper = Object.hasOwn(patch, 'paperId')
  // 没打开论文时（刚启动）不要把上次的 paperId 抹成 null，除非显式传了 paperId: null
  const next = {
    paperId: hasExplicitPaper ? patch.paperId : (meta && meta.id) || existing.paperId || null,
    tab: state.tab,
    page: state.page,
    sectionId: state.sectionId || null,
    scrollTop: scroller ? scroller.scrollTop : existing.scrollTop,
    layout: { ...state.layout },
    expanded: [...state.expanded],
    readerAi: { ...state.ai },
    dark: state.dark,
    ...patch,
  }
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...existing, ...next, at: new Date().toISOString() }))
  } catch {
    /* 隐私模式下忽略 */
  }
  // 同时写一份到插件自己的数据目录：桌面端重启后端口会变，localStorage 按站点隔离会丢，
  // 服务端这份能让「退出再进」跨重启也回到原处。
  const hasPrefPatch = ['paperId', 'layout', 'expanded', 'readerAi', 'dark'].some((k) => Object.hasOwn(patch, k))
  if (state.current || hasPrefPatch) {
    const remoteState = {
      paperId: next.paperId,
      tab: next.tab,
      page: next.page,
      scrollTop: next.scrollTop,
      sectionId: next.sectionId,
      layout: next.layout,
      expanded: next.expanded,
      readerAi: next.readerAi,
      dark: next.dark,
    }
    if (opts && opts.keepalive && typeof fetch === 'function') {
      fetch(API + 'ui.set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: remoteState }),
        keepalive: true,
      }).catch(() => {})
    } else {
      rpc('ui.set', { state: remoteState }).catch(() => {})
    }
  }
}

/** 服务端记的界面状态（跨端口/重启有效），拿不到就当没有。 */
async function loadSessionRemote() {
  try {
    const value = await rpc('ui.get')
    const remote = value && value.state
    return remote && typeof remote === 'object' ? remote : {}
  } catch {
    return {}
  }
}

function pickSession(local, remote) {
  const remoteTime = String((remote && (remote.updatedAt || remote.at)) || '')
  const localTime = String((local && (local.updatedAt || local.at)) || '')
  const hasRemote = Boolean(
    remote && (remote.paperId || remoteTime || remote.layout || remote.readerAi || typeof remote.dark === 'number' || Array.isArray(remote.expanded)),
  )
  const hasLocal = Boolean(local && (local.paperId || localTime))
  if (!hasRemote) return local || {}
  if (!hasLocal) return remote
  if (Object.hasOwn(remote, 'paperId') && remote.paperId === null && remoteTime > localTime) return remote
  if (!remote.paperId && local.paperId) return local
  return remoteTime > localTime ? remote : local
}

/** 滚动很密，别每帧写 localStorage。 */
function saveSessionSoon(extra) {
  if (sessionSaveTimer) return
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = 0
    saveSession(extra)
  }, 400)
}

function loadAiState() {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_KEY) || '{}')
    return {
      translateOn: raw.translateOn === true,
      onlyZh: raw.onlyZh === true,
      hideZh: raw.hideZh === true,
      sideBySide: raw.sideBySide === true,
    }
  } catch {
    return { translateOn: false, onlyZh: false, hideZh: false, sideBySide: false }
  }
}

function saveAiState() {
  try {
    localStorage.setItem(AI_KEY, JSON.stringify(state.ai))
  } catch {
    /* 同上 */
  }
  saveSessionSoon({ readerAi: { ...state.ai } })
}

// ---------------------------------------------------------------- 布局（三栏 + 目录列）

const shellColumns = (layout) => {
  const tracks = []
  if (layout.sideOpen) tracks.push(layout.side + 'px', '6px')
  tracks.push('minmax(0,1fr)')
  if (!NATIVE_READER && layout.chatOpen) tracks.push('6px', layout.chat + 'px')
  return tracks.join(' ')
}

const outlineColumns = (layout) => (layout.outlineOpen ? layout.outline + 'px 6px minmax(0,1fr)' : 'minmax(0,1fr)')

/** 拖拽过程中直接改 inline grid，避免每次 pointermove 都整页重渲染。 */
function applyLayoutWidth(kind, width) {
  const draft = { ...state.layout, [kind]: width }
  if (kind === 'outline') {
    const reader = document.querySelector('.reader')
    if (reader) reader.style.gridTemplateColumns = outlineColumns(draft)
  } else {
    const shell = document.querySelector('.shell')
    if (shell) shell.style.gridTemplateColumns = shellColumns(draft)
  }
  state.layout[kind] = width
}

function closePane(kind) {
  const cfg = LAYOUT_LIMITS[kind]
  state.layout[kind] = Math.max(cfg.min, Math.min(cfg.max, state.layout[kind] || cfg.def))
  state.layout[kind + 'Open'] = false
  saveLayout()
  render()
}

function togglePane(kind) {
  if (NATIVE_READER && kind === 'chat') { postNative('native-toggle'); return }
  state.layout[kind + 'Open'] = !state.layout[kind + 'Open']
  saveLayout()
  render()
}

/**
 * 分隔条：pointer 拖动（setPointerCapture）、双击恢复默认、键盘可调。
 * 三条分隔条方向不同：文献库/目录在左，右方向变宽；对话在右，左方向变宽。
 */
function makeSplitter(kind) {
  const cfg = LAYOUT_LIMITS[kind]
  const element = h('div', {
    class: 'splitter',
    id: 'split-' + kind,
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': cfg.label + '宽度（拖动调整，双击恢复默认）',
    'aria-valuemin': cfg.min,
    'aria-valuemax': cfg.max,
    'aria-valuenow': Math.round(state.layout[kind]),
    tabindex: '0',
  })
  let drag = null
  const syncAria = () => element.setAttribute('aria-valuenow', String(Math.round(state.layout[kind])))
  // 兜底收尾：元素在拖动途中被 replaceChildren 摘掉时收不到 pointerup，
  // 靠 lostpointercapture / window blur 也得把 drag 状态和 body.dragging 清掉，
  // 否则整页一直处于「拖拽中」：不能选字、光标也不恢复。
  // 推到下一拍再收尾，避免在 render 换树的过程中同步再触发一次 render。
  const settleDrag = () => setTimeout(() => finishDrag(true), 0)
  const onWindowBlur = () => settleDrag()
  // 兜底之二：元素被整页重绘换掉后，浏览器可能不再把 pointerup 派给旧节点
  // （capture 已经释放，鼠标落在新节点上），事件会经由新节点冒泡到 document。
  // 所以拖拽期间在 document 上也收一份 pointerup/pointercancel，保证一定收尾。
  const onDocPointerEnd = () => finishDrag(true)
  const setWidth = (raw) => {
    applyLayoutWidth(kind, Math.max(0, Math.min(cfg.max, raw)))
    syncAria()
  }
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    try {
      element.setPointerCapture(event.pointerId)
    } catch {
      /* 某些浏览器在元素将销毁时会抛，忽略即可 */
    }
    drag = { startX: event.clientX, start: state.layout[kind] }
    element.classList.add('dragging')
    document.body.classList.add('dragging')
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('pointerup', onDocPointerEnd)
    document.addEventListener('pointercancel', onDocPointerEnd)
  })
  element.addEventListener('pointermove', (event) => {
    if (!drag) return
    // 对话列在右侧：分隔条往左拖才是变宽，方向和左列相反
    const delta = event.clientX - drag.startX
    setWidth(drag.start + (kind === 'chat' ? -delta : delta))
  })
  element.addEventListener('pointerup', () => finishDrag(true))
  element.addEventListener('pointercancel', () => finishDrag(true))
  element.addEventListener('lostpointercapture', () => settleDrag())
  element.addEventListener('dblclick', (event) => {
    event.preventDefault()
    state.layout[kind] = cfg.def
    state.layout[kind + 'Open'] = true
    saveLayout()
    render()
  })
  element.addEventListener('keydown', (event) => {
    const step = 16
    let next = null
    if (event.key === 'ArrowRight') next = state.layout[kind] + (kind === 'chat' ? -step : step)
    else if (event.key === 'ArrowLeft') next = state.layout[kind] + (kind === 'chat' ? step : -step)
    else if (event.key === 'Home') next = cfg.min
    else if (event.key === 'End') next = cfg.max
    else return
    event.preventDefault()
    state.layout[kind] = Math.max(cfg.min, Math.min(cfg.max, next))
    state.layout[kind + 'Open'] = true
    saveLayout()
    render()
    const again = document.getElementById('split-' + kind)
    if (again) again.focus()
  })
  return element

  function finishDrag(allowCollapse) {
    // 幂等：pointerup / pointercancel / lostpointercapture / blur 可能先后都来一遍
    window.removeEventListener('blur', onWindowBlur)
    document.removeEventListener('pointerup', onDocPointerEnd)
    document.removeEventListener('pointercancel', onDocPointerEnd)
    if (!drag) return
    const width = state.layout[kind]
    drag = null
    element.classList.remove('dragging')
    document.body.classList.remove('dragging')
    if (allowCollapse && width < COLLAPSE_THRESHOLD) {
      closePane(kind)
      return
    }
    state.layout[kind] = Math.max(cfg.min, Math.min(cfg.max, width))
    state.layout[kind + 'Open'] = true
    saveLayout()
    render()
  }
}

// ---------------------------------------------------------------- SSE（fetch + getReader，EventSource 不支持 POST）

async function streamSse(url, body, handlers, signal) {
  return streamSseRequest(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    handlers,
    signal,
  )
}

/** 原生会话的 SSE 是 GET（事件流里带 query 参数），和 POST 版共用同一套解析。 */
async function streamSseGet(url, handlers, signal) {
  return streamSseRequest(url, { method: 'GET' }, handlers, signal)
}

async function streamSseRequest(url, init, handlers, signal) {
  const response = await fetch(url, { ...init, signal })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error((data && data.error) || '接口返回 HTTP ' + response.status)
  }
  const contentType = response.headers.get('content-type') || ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    // sseError 的兜底响应是普通 JSON：把它当错误抛出，而不是静默当成空流
    const data = await response.json().catch(() => null)
    throw new Error((data && data.error) || '服务端没有返回事件流（HTTP ' + response.status + '）')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let match = /\r?\n\r?\n/.exec(buffer)
    while (match) {
      const rawEvent = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      dispatchSseEvent(rawEvent, handlers)
      match = /\r?\n\r?\n/.exec(buffer)
    }
  }
  if (buffer.trim() !== '') dispatchSseEvent(buffer, handlers)
}

function dispatchSseEvent(rawEvent, handlers) {
  let event = 'message'
  const dataLines = []
  for (const line of String(rawEvent || '').split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (dataLines.length === 0) return
  let payload = null
  try {
    payload = JSON.parse(dataLines.join('\n'))
  } catch {
    return
  }
  const handler = handlers[event]
  if (typeof handler === 'function') handler(payload)
}

// ---------------------------------------------------------------- AI 模型 / 设置

const modelValue = (model) => (model && model.provider && model.model ? model.provider + '::' + model.model : '')
function parseModelValue(value) {
  if (!value) return null
  const index = String(value).indexOf('::')
  if (index <= 0) return null
  return { provider: value.slice(0, index), model: value.slice(index + 2) }
}

function modelOptions(selected) {
  const options = [h('option', { value: '', selected: !selected }, '跟随当前模型')]
  const models = (state.aiModels && state.aiModels.models) || []
  for (const model of models) {
    const id = model.id || model.model || ''
    if (!id) continue
    const isSelected = !!selected && selected.provider === model.provider && (selected.model === id || selected.model === model.model)
    options.push(h('option', { value: model.provider + '::' + id, selected: isSelected }, (model.name || id) + ' · ' + model.provider))
  }
  return options
}

async function loadAi(force = false) {
  if (state.aiModels && !force) return
  try {
    state.aiModels = await rpc('ai.models')
  } catch (error) {
    state.aiModels = { ready: false, reason: 'AI 接口不可用：' + error.message, providers: [], models: [], follow: null, translateModel: null, chatModel: null }
  }
  try {
    const value = await rpc('ai.settings.get')
    const config = value.config || {}
    state.aiConfig = config.ai || config // 兼容 {ai:{…}} 与直接返回 AI 配置两种宿主实现
    if (config && (config.obsidian || config.topics || config.database)) state.fullConfig = config
  } catch {
    try {
      const legacy = await rpc('settings.get')
      state.aiConfig = (legacy.config && legacy.config.ai) || {}
    } catch {
      state.aiConfig = {}
    }
  }
}

/** 契约没写死 ai.settings.set 的 patch 形状，按常见三种形状依次尝试，最后退回 settings.set。 */
async function saveAiPatch(patch) {
  const attempts = [
    () => rpc('ai.settings.set', { patch: { ai: patch } }),
    () => rpc('ai.settings.set', { patch }),
    () => rpc('settings.set', { patch: { ai: patch } }),
  ]
  let lastError = null
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('AI 设置保存失败')
}

async function saveModel(kind, value) {
  const model = parseModelValue(value)
  try {
    await saveAiPatch({ [kind]: model })
    state.aiConfig = { ...(state.aiConfig || {}), [kind]: model }
    toast('已切换' + (kind === 'chatModel' ? '对话' : '翻译') + '模型')
    render()
  } catch (error) {
    toast('保存模型失败：' + error.message)
  }
}

// ---------------------------------------------------------------- 翻译（SSE 逐段）

function normalizeKey(key) {
  return String(key || '').trim().toLowerCase()
}

function paragraphKey(paragraph) {
  return paragraph && paragraph.hash ? String(paragraph.hash).toLowerCase() : ''
}

function translatableParagraphs(sectionIds) {
  const doc = state.doc
  if (!doc || !Array.isArray(doc.paragraphs)) return []
  const sections = sectionsOf()
  const allowed = sectionIds && sectionIds.length > 0 ? new Set(sectionIds) : null
  return doc.paragraphs.filter((paragraph) => {
    if (!paragraph.hash) return false
    // 与 lib/ai.js 的 SKIP_TRANSLATE_KINDS 保持一致：公式/图/表不送翻译，
    // 否则进度条会一直差这几段、章节永远不满、重试也发不出去
    if (paragraph.kind === 'formula' || paragraph.kind === 'figure' || paragraph.kind === 'table') return false
    if (!allowed) return true
    const sectionId = paragraph.section && sections.some((section) => section.id === paragraph.section) ? paragraph.section : sections[0] && sections[0].id
    return allowed.has(sectionId)
  })
}

function buildJob(sectionIds, mode) {
  const paragraphs = translatableParagraphs(sectionIds)
  const keysBySection = new Map()
  const done = new Set()
  for (const paragraph of paragraphs) {
    const key = paragraphKey(paragraph)
    const sid = paragraph.section || (sectionsOf()[0] && sectionsOf()[0].id) || '__all'
    if (!keysBySection.has(sid)) keysBySection.set(sid, new Set())
    keysBySection.get(sid).add(key)
  }
  const sections = sectionsOf()
  return {
    mode,
    sections: sectionIds || sections.map((section) => section.id),
    keysBySection,
    totalParagraphs: paragraphs.length,
    totalSections: mode === 'section' ? 1 : (sectionIds ? sectionIds.length : sections.length),
    done,
    failed: new Set(),
  }
}

function markPending(job) {
  for (const keys of job.keysBySection.values()) {
    for (const key of keys) {
      if (state.trans[key]) continue
      state.streams.set(key, { status: 'pending', text: '', message: '' })
    }
  }
}

function translateHandlers(job) {
  const live = () => job.token === state.translateTask
  const applyDoneKey = (data) => {
    const key = normalizeKey(data && data.key)
    if (!key) return
    job.done.add(key)
    const text = String((data && data.text) || '').trim()
    if (text !== '') {
      state.trans[key] = { zh: text, model: (data && data.model) || '', at: new Date().toISOString() }
    }
    state.streams.delete(key)
    paintTranslation(key)
    paintTranslateChrome()
  }
  const applySkippedKey = (data) => {
    const key = normalizeKey(data && data.key)
    if (!key) return
    state.streams.set(key, { status: 'skipped', text: '', message: String((data && data.reason) || '无需翻译') })
    paintTranslation(key)
    paintTranslateChrome()
  }
  const applyTerminalEnd = (data) => {
    state.translateBusy = false
    const pid = state.current?.meta?.id || state.translateJob?.paperId || ''
    if (state.translateJob) {
      const nextStatus = data && data.aborted ? 'paused' : data && data.ok === false ? 'error' : 'done'
      state.translateJob = {
        ...state.translateJob,
        status: nextStatus,
        ...(nextStatus === 'done' && Number(state.translateJob.total) > 0 ? { completed: Number(state.translateJob.total) } : {}),
      }
    }
    if (pid && state.health && Array.isArray(state.health.activeTranslations)) {
      state.health.activeTranslations = state.health.activeTranslations.filter((j) => j.paperId !== pid)
    }
    paintTranslateChrome()
    if (job.mode === 'titles' && job.done.size === 0 && !state.translateError) {
      const skipped = (data && data.skipped) || 0
      toast(
        skipped > 0
          ? '目录里 ' + skipped + ' 个标题和原文一样，没有可翻的内容'
          : '没有翻到任何标题：先确认「版面/文档模型」已经建好，再点一次目录翻译',
        6000,
      )
    }
    if (data && data.ok === false) {
      state.translateError =
        job.mode === 'titles'
          ? '目录翻译没有全部成功，失败的标题可以点「重试」'
          : '翻译没有全部成功，失败的段落可以点「重试」'
      paintTranslateChrome()
    }
  }
  return {
    start(data) {
      if (!live()) return
      if (data && data.total !== undefined && !data.key) {
        state.translateJob = {
          ...(state.translateJob || {}),
          paperId: data.paperId || state.current?.meta?.id || '',
          status: 'running',
          completed: Number(data.already) || 0,
          total: Number(data.total) || 0,
          concurrency: Number(data.concurrency) || Number(state.aiConfig?.concurrency) || 1,
        }
        paintTranslateChrome()
        return
      }
      const key = normalizeKey(data && data.key)
      if (!key) return
      const item = state.streams.get(key) || { status: 'streaming', text: '', message: '' }
      item.status = 'streaming'
      state.streams.set(key, item)
      paintTranslation(key)
    },
    delta(data) {
      if (!live()) return
      const key = normalizeKey(data && data.key)
      if (!key) return
      const item = state.streams.get(key) || { status: 'streaming', text: '', message: '' }
      item.status = 'streaming'
      item.text = (item.text || '') + String((data && data.text) || '')
      state.streams.set(key, item)
      paintTranslation(key)
    },
    progress(data) {
      if (!live() || !data) return
      state.translateJob = { ...(state.translateJob || {}), ...data }
      state.translateBusy = state.translateJob.status === 'running'
      paintTranslateChrome()
    },
    chunk(data) {
      if (!live() || !data) return
      if (data.skipped) applySkippedKey(data)
      else applyDoneKey(data)
    },
    paused(data) {
      if (!live()) return
      state.translateJob = { ...(state.translateJob || {}), ...(data || {}), status: 'paused' }
      state.translateBusy = false
      if (state.job) state.job.stopped = true
      for (const [k, item] of [...state.streams]) {
        if (item.status === 'pending' || item.status === 'streaming') state.streams.delete(k)
      }
      paintAllTranslations()
      paintTranslateChrome()
    },
    done(data) {
      if (!live()) return
      if (data && data.key) {
        if (job.done.has(normalizeKey(data.key))) return
        applyDoneKey(data)
        return
      }
      applyTerminalEnd({ ...(data || {}), ok: true })
    },
    skipped(data) {
      if (!live()) return
      applySkippedKey(data)
    },
    error(data) {
      if (!live()) return
      const key = normalizeKey(data && data.key)
      if (key) {
        job.failed.add(key)
        state.streams.set(key, { status: 'error', text: '', message: String((data && data.message) || '翻译失败') })
        paintTranslation(key)
        paintTranslateChrome()
        return
      }
      state.translateError = String((data && data.message) || '翻译失败')
      if (data && data.fatal) {
        state.translateBusy = false
        state.translateJob = { ...(state.translateJob || {}), status: 'error', error: state.translateError }
      }
      paintTranslateChrome()
    },
    end(data) {
      if (!live()) return
      applyTerminalEnd(data)
    },
  }
}

async function runTranslate(body, job) {
  if (state.translateBusy) {
    toast('已有翻译任务在进行，点「⏸ 暂停翻译」后可暂停或等它结束')
    return
  }
  if (!state.current) return
  const task = ++state.translateTask
  job.token = task
  state.translateDetached = false
  state.translateBusy = true
  state.translateError = ''
  state.job = job
  const concurrency = Math.min(100, Math.max(1, Math.trunc(Number(state.aiConfig && state.aiConfig.concurrency) || 10)))
  const pid = state.current.meta.id
  const prevDone = state.translateJob && state.translateJob.paperId === pid ? Number(state.translateJob.completed) || 0 : 0
  state.translateJob = {
    paperId: pid,
    status: 'running',
    concurrency,
    completed: Math.max(prevDone, job.done ? job.done.size : 0),
    total: job.totalParagraphs || 0,
  }
  state.translateReqId = genId()
  markPending(job)
  render()
  const controller = new AbortController()
  state.translateAbort = controller
  try {
    await streamSse(
      TRANSLATE_URL,
      { ...body, persistent: true, concurrency, reqId: state.translateReqId },
      translateHandlers(job),
      controller.signal,
    )
  } catch (error) {
    if (error.name !== 'AbortError') {
      state.translateError = '翻译失败：' + error.message
      toast(state.translateError, 5000)
    }
  } finally {
    if (task === state.translateTask) {
      if (state.translateAbort === controller) state.translateAbort = null
      state.translateBusy = false
      if (state.translateDetached) {
        state.translateDetached = false
        return
      }
      const isPaused = Boolean(state.translateJob && state.translateJob.status === 'paused')
      for (const [key, item] of [...state.streams]) {
        if (item.status !== 'pending' && item.status !== 'streaming') continue
        if (state.trans[key] || isPaused) {
          state.streams.delete(key)
          continue
        }
        const message = state.translateError ? '翻译失败，可重试' : '翻译已暂停，可继续'
        state.streams.set(key, { status: 'error', text: '', message })
      }
      paintAllTranslations()
      paintTranslateChrome()
      if (state.tab === 'compare') {
        const status = document.getElementById('translate-status')
        if (status) status.textContent = state.translateError || progressText()
      }
    }
  }
}

async function attachTranslateFollow(paperId, initialJob) {
  if (!paperId || !state.current || state.current.meta.id !== paperId) return
  if (state.translateAbort) {
    state.translateDetached = true
    try {
      state.translateAbort.abort()
    } catch {
      /* ignore */
    }
  }
  const task = ++state.translateTask
  const scopeIds = Array.isArray(initialJob?.sectionIds) ? initialJob.sectionIds : null
  const job = buildJob(scopeIds, initialJob?.titles ? 'titles' : scopeIds ? 'section' : 'paper')
  job.token = task
  state.translateDetached = false
  state.translateJob = initialJob || { paperId, status: 'running', completed: 0, total: job.totalParagraphs || 0 }
  state.translateBusy = Boolean(state.translateJob && state.translateJob.status === 'running')
  state.job = job
  const controller = new AbortController()
  state.translateAbort = controller
  try {
    await streamSseGet(FOLLOW_TRANSLATE_URL + '?id=' + encodeURIComponent(paperId) + '&replay=1', translateHandlers(job), controller.signal)
  } catch (error) {
    if (error.name !== 'AbortError') state.translateError = '重连翻译流失败：' + error.message
  } finally {
    if (task === state.translateTask) {
      if (state.translateAbort === controller) state.translateAbort = null
      state.translateBusy = false
      if (!state.translateDetached) paintTranslateChrome()
      state.translateDetached = false
    }
  }
}

async function pauseTranslate() {
  if (!state.current) return
  const paperId = state.current.meta.id
  state.translateDetached = false
  let pausedResp = null
  try {
    pausedResp = await rpc('translate.pause', { id: paperId })
  } catch {
    const reqId = state.translateReqId
    await fetch(API + 'ai/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reqId, paperId }),
    }).catch(() => {})
  }
  const controller = state.translateAbort
  if (controller) {
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
  }
  state.translateBusy = false
  state.translateJob = (pausedResp && pausedResp.job) || {
    ...(state.translateJob || {}),
    paperId,
    status: 'paused',
  }
  if (state.job) state.job.stopped = true
  for (const [k, item] of [...state.streams]) {
    if (item.status === 'pending' || item.status === 'streaming') state.streams.delete(k)
  }
  toast('已暂停翻译，可随时点「继续翻译」接着翻')
  paintAllTranslations()
  paintTranslateChrome()
  render()
}

function stopTranslate() {
  return pauseTranslate()
}

function resumeTranslate() {
  if (!state.current) return
  const prev = state.translateJob || {}
  const sectionIds = Array.isArray(prev.sectionIds) && prev.sectionIds.length ? prev.sectionIds : null
  const job = buildJob(sectionIds, prev.titles ? 'titles' : sectionIds ? 'section' : 'paper')
  runTranslate({ id: state.current.meta.id, resume: true, ...(sectionIds ? { sectionIds } : {}) }, job)
}

function translateSection(sectionId, retranslate = false) {
  if (!state.doc || !Array.isArray(state.doc.paragraphs) || state.doc.paragraphs.length === 0) {
    toast('还没有文档模型：先在对照页点「重建文档模型」')
    return
  }
  if (sectionId) {
    const job = buildJob([sectionId], 'section')
    if (job.totalParagraphs === 0) {
      toast('这一节没有可翻译的段落')
      return
    }
    runTranslate({ id: state.current.meta.id, sectionIds: [sectionId], retranslate: retranslate || undefined }, job)
    return
  }
  translateAll()
}

function translateAll() {
  const sections = sectionsOf()
  if (!state.doc || sections.length === 0) {
    toast('还没有文档模型：先在对照页点「重建文档模型」')
    return
  }
  const ids = sections.map((section) => section.id)
  const job = buildJob(ids, 'paper')
  if (job.totalParagraphs === 0) {
    toast('没有可翻译的段落')
    return
  }
  runTranslate({ id: state.current.meta.id, sectionIds: ids }, job)
}

function confirmTranslateAll() {
  const paragraphs = translatableParagraphs(null)
  const sections = sectionsOf()
  if (paragraphs.length === 0) {
    toast('没有可翻译的段落')
    return
  }
  const cc = Math.min(100, Math.max(1, Math.trunc(Number(state.aiConfig && state.aiConfig.concurrency) || 10)))
  const ok = window.confirm(
    '整篇翻译：' +
      sections.length +
      ' 节 · ' +
      paragraphs.length +
      ' 段。\n\n将按文档顺序以 ' +
      cc +
      ' 并发在后台持久推进（切走界面或切换会话不会中断，点「⏸ 暂停翻译」才暂停）。继续？',
  )
  if (ok) translateAll()
}

function translateTitles() {
  const sections = sectionsOf().filter((section) => section.hash)
  if (!state.doc || sections.length === 0) {
    toast('没有可翻译的目录标题（需要文档模型）')
    return
  }
  const job = {
    mode: 'titles',
    sections: sections.map((section) => section.id),
    keysBySection: new Map(),
    totalParagraphs: sections.length,
    totalSections: 0,
    done: new Set(),
    failed: new Set(),
  }
  runTranslate({ id: state.current.meta.id, titles: true }, job)
}

function translateKeys(keys) {
  const list = keys.filter(Boolean)
  if (list.length === 0) return
  const titles = list.every((key) => key.startsWith('t:'))
  const job = {
    mode: titles ? 'titles' : 'keys',
    sections: [],
    keysBySection: new Map([['__keys', new Set(list)]]),
    totalParagraphs: list.length,
    totalSections: 0,
    done: new Set(),
    failed: new Set(),
  }
  for (const key of list) state.streams.set(key, { status: 'pending', text: '', message: '' })
  runTranslate({ id: state.current.meta.id, keys: list, retranslate: true, ...(titles ? { titles: true } : {}) }, job)
}

function retryKey(key) {
  translateKeys([key])
}

function sectionDoneCount(job) {
  let done = 0
  for (const keys of job.keysBySection.values()) {
    let all = true
    for (const key of keys) {
      if (!job.done.has(key)) {
        all = false
        break
      }
    }
    if (all && keys.size > 0) done += 1
  }
  return done
}

function progressText() {
  const tj = state.translateJob
  const job = state.job
  const cc = Number((tj && tj.concurrency) || (state.aiConfig && state.aiConfig.concurrency) || 1)
  const ccTag = cc > 1 ? ' · ' + cc + ' 并发' : ''
  if (tj && Number(tj.total) > 0) {
    const doneCount = Math.min(Math.max(Number(tj.completed) || 0, job ? job.done.size : 0), Number(tj.total))
    const suffix =
      tj.status === 'running'
        ? ccTag
        : tj.status === 'paused'
          ? '（已暂停）'
          : tj.status === 'error'
            ? '（有失败）'
            : '（已完成）'
    return '翻译 ' + doneCount + '/' + tj.total + ' 段' + suffix
  }
  if (!job) return state.translateBusy ? '翻译中…' + ccTag : ''
  const suffix = state.translateBusy ? ccTag : job.stopped ? '（已暂停）' : '（已结束）'
  if (job.mode === 'titles') return '目录翻译 ' + Math.min(job.done.size, job.totalParagraphs) + '/' + job.totalParagraphs + suffix
  const sections = job.totalSections || JobSectionCount(job)
  const sectionText = sections > 0 ? sectionDoneCount(job) + '/' + sections + ' 节 · ' : ''
  return '翻译 ' + sectionText + Math.min(job.done.size, job.totalParagraphs) + '/' + job.totalParagraphs + ' 段' + suffix
  function JobSectionCount(current) {
    return current.keysBySection.size
  }
}

function currentReadMode() {
  if (state.ai.onlyZh) return 'zh'
  if (state.ai.hideZh) return 'orig'
  if (state.ai.sideBySide) return 'side'
  return 'bilingual'
}

function setReadMode(mode) {
  state.ai.onlyZh = mode === 'zh'
  state.ai.hideZh = mode === 'orig'
  state.ai.sideBySide = mode === 'side'
  saveAiState()
  render()
}

function toggleOnlyZh() {
  setReadMode(state.ai.onlyZh ? 'bilingual' : 'zh')
}

function paintTranslation(key, nodes) {
  const list = nodes || document.querySelectorAll('[data-zh="' + key + '"]')
  if (list.length === 0) return
  const text = state.trans[key] && state.trans[key].zh
  const stream = state.streams.get(key)
  const zhAnns = annotationsFor(key, 'zh')
  for (const node of list) {
    node.replaceChildren(...zhContent(key, text, stream))
    if (text && zhAnns.length > 0) {
      const box = node.querySelector ? node.querySelector('.zh-text') : null
      if (box) applyParagraphAnnotations(box, zhAnns)
    }
  }
  if (text || stream) ensureShowZh()
}

/** 译文是在 render 之后才到的：.compare 的 show-zh 是渲染时算的，
 * 不补这一步，划词/单段翻译完成后段落下面的中文会被 display:none 藏起来。 */
function ensureShowZh() {
  if (state.ai.hideZh) return
  const compare = document.querySelector('.compare')
  if (compare && !compare.classList.contains('show-zh')) compare.classList.add('show-zh')
}

/** 和 lib/ai.js 的 sameText 同义：去空白/标点/大小写后比较，用来识别「译文就是原文」。 */
function sameTextLoose(a, b) {
  const flat = (value) => String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[.,;:!?、，。；：！？"'“”‘’()（）\[\]【】—-]/g, '')
  const left = flat(a)
  const right = flat(b)
  return Boolean(left) && left === right
}

function zhContent(key, text, stream) {
  if (text) return [h('div', { class: 'zh-text' }, text)]
  if (stream && stream.status === 'streaming') {
    return [h('div', { class: 'zh-text' }, stream.text || ''), h('span', { class: 'caret' })]
  }
  if (stream && stream.status === 'pending') return [h('span', { class: 'muted' }, '翻译中…')]
  if (stream && stream.status === 'skipped') {
    return [h('span', { class: 'muted' }, stream.message)]
  }
  if (stream && stream.status === 'error') {
    return [h('span', { class: 'error' }, stream.message), h('button', { class: 'link', onclick: () => retryKey(key) }, '重试')]
  }
  return []
}

function paintAllTranslations() {
  // 一次全树扫描建好 key -> 节点 的索引，再按 key 回填；
  // 以前每个 key 都 querySelectorAll 一遍，整篇 800 个 key 就是 800 次全文档扫描。
  const byKey = new Map()
  for (const node of document.querySelectorAll('[data-zh]')) {
    const key = node.getAttribute('data-zh')
    if (!key) continue
    let list = byKey.get(key)
    if (!list) byKey.set(key, (list = []))
    list.push(node)
  }
  let painted = false
  for (const [key, list] of byKey) {
    const text = state.trans[key] && state.trans[key].zh
    const stream = state.streams.get(key)
    if (!text && !stream) continue
    const zhAnns = text ? annotationsFor(key, 'zh') : []
    for (const node of list) {
      node.replaceChildren(...zhContent(key, text, stream))
      if (zhAnns.length > 0) {
        const box = node.querySelector ? node.querySelector('.zh-text') : null
        if (box) applyParagraphAnnotations(box, zhAnns)
      }
    }
    painted = true
  }
  if (painted) ensureShowZh()
}

function paintTranslateChrome() {
  const docReady = !!(state.doc && Array.isArray(state.doc.paragraphs) && state.doc.paragraphs.length > 0)
  const tj = state.translateJob
  const running = Boolean(state.translateBusy || (tj && tj.status === 'running'))
  const paused = Boolean(!running && tj && tj.status === 'paused')
  const countSuffix = tj && Number(tj.total) > 0 ? ' (' + Math.min(Number(tj.completed) || 0, Number(tj.total)) + '/' + tj.total + ')' : ''
  const status = document.getElementById('translate-status')
  if (status) {
    status.textContent = state.translateError || progressText()
    status.classList.toggle('error', state.translateError !== '')
  }
  const stop = document.getElementById('translate-stop')
  if (stop) {
    stop.hidden = !running
    stop.disabled = !running
    stop.textContent = '⏸ 暂停翻译' + countSuffix
  }
  const resume = document.getElementById('translate-resume')
  if (resume) {
    resume.hidden = !paused
    resume.disabled = !docReady || running
    resume.textContent = '▶ 继续翻译' + countSuffix
  }
  const retryable = failedSegmentKeys()
  const retry = document.getElementById('retry-failed')
  if (retry) {
    retry.hidden = retryable.length === 0
    retry.textContent = '重试失败 ' + retryable.length
  }
  for (const id of ['translate-all', 'translate-section', 'translate-titles']) {
    const button = document.getElementById(id)
    if (button) button.disabled = !docReady || running
  }
  const activePid = (tj && tj.paperId) || state.current?.meta?.id || ''
  if (activePid && typeof document.querySelectorAll === 'function') {
    for (const badge of document.querySelectorAll('[data-paper-trans-badge]')) {
      if (badge.getAttribute('data-paper-trans-badge') !== activePid) continue
      if (tj && (tj.status === 'running' || tj.status === 'paused')) {
        badge.className = 'paper-trans-badge' + (tj.status === 'paused' ? ' paused' : '')
        badge.title = tj.status === 'running' ? '后台翻译中' : '翻译已暂停，待继续'
        badge.textContent = (tj.status === 'paused' ? '⏸ ' : '译 ') + (tj.completed || 0) + '/' + (tj.total || '?')
      } else {
        badge.className = 'paper-meta'
        badge.title = ''
        badge.textContent = state.current?.meta?.status === 'read' ? '✓' : ''
      }
    }
  }
}

// ---------------------------------------------------------------- 右侧对话（SSE）

function renderAssistantHtml(text) {
  return escapeHtml(String(text || ''))
    .replace(/\[p\.(\d+)\]/g, '<a class="cite" data-page="$1" title="跳到原文页第 $1 页">[p.$1]</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
}

function chatContext(extra = {}) {
  const sections = sectionsOf()
  return {
    sectionId: state.sectionId || (sections[0] && sections[0].id) || undefined,
    page: state.page || undefined,
    ...extra,
  }
}

async function sendChat(content, context = {}) {
  if (NATIVE_READER) return askNative(content, context)
  const text = String(content || '').trim()
  if (!text) return
  if (!state.current) {
    toast('先打开一篇论文再对话')
    return
  }
  if (state.chat.busy) {
    toast('上一条回答还在生成，先停止或等它结束')
    return
  }
  const history = state.chat.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }))
  history.push({ role: 'user', content: text })
  state.chat.messages.push({ role: 'user', content: text, context })
  const assistant = { role: 'assistant', content: '', model: '', streaming: true }
  state.chat.messages.push(assistant)
  state.chat.busy = true
  state.chat.error = ''
  state.chat.draft = ''
  render()
  const controller = new AbortController()
  state.chat.abort = controller
  const body = {
    id: state.current.meta.id,
    messages: history,
    context,
    scope: context.scope === 'paper' ? 'paper' : 'section',
  }
  const model = (state.aiConfig && state.aiConfig.chatModel) || null
  if (model && model.provider && model.model) body.model = model
  try {
    await streamSse(
      CHAT_URL,
      body,
      {
        delta(data) {
          assistant.content += String((data && data.text) || '')
          paintLiveChat(assistant)
        },
        done(data) {
          if (data && typeof data.text === 'string') assistant.content = data.text
          assistant.model = (data && data.model) || ''
          assistant.streaming = false
          paintLiveChat(assistant)
        },
        error(data) {
          assistant.error = String((data && data.message) || '回答失败')
          assistant.streaming = false
          paintLiveChat(assistant)
        },
        end() {
          /* done/error 已经收尾；end 只用于服务端宣告结束 */
        },
      },
      controller.signal,
    )
  } catch (error) {
    if (error.name === 'AbortError') assistant.error = assistant.error || '已停止'
    else assistant.error = '对话失败：' + error.message
  } finally {
    assistant.streaming = false
    if (state.chat.abort === controller) state.chat.abort = null
    state.chat.busy = false
    render()
  }
}

function paintLiveChat(message) {
  const body = document.getElementById('chat-live-body')
  if (!body) return
  body.innerHTML = renderAssistantHtml(message.content) + (message.streaming ? '<span class="caret"></span>' : '')
  if (message.error) body.append(h('div', { class: 'error' }, message.error))
  const list = document.querySelector('.chat-messages')
  if (list) list.scrollTop = list.scrollHeight
}

function sendChatDraft() {
  const text = String(state.chat.draft || '').trim()
  if (!text) return
  state.chat.draft = ''
  sendChat(text, chatContext())
}

function sendQuick(text, extra) {
  if (NATIVE_READER) return askNative(text, chatContext(extra))
  if (!state.current) {
    toast('先打开一篇论文')
    return
  }
  if (!state.layout.chatOpen) {
    state.layout.chatOpen = true
    saveLayout()
  }
  sendChat(text, chatContext(extra))
}

function stopChat() {
  if (state.chat.abort) {
    try {
      state.chat.abort.abort()
    } catch {
      /* 已结束 */
    }
  }
  state.chat.busy = false
  toast('已停止回答')
  render()
}

async function clearChat() {
  if (!state.current) return
  if (!window.confirm('清空这篇论文的对话历史？')) return
  try {
    await rpc('chat.clear', { id: state.current.meta.id })
    state.chat.messages = []
    state.chat.error = ''
    render()
  } catch (error) {
    toast('清空失败：' + error.message)
  }
}

/** 从第 fromIndex 条回答重新生成：丢掉这条回答及其之前的用户提问，再重发。 */
async function regenerate(fromIndex) {
  const messages = state.chat.messages
  if (state.chat.busy) return
  const start = Number.isInteger(fromIndex) ? Math.min(fromIndex, messages.length - 1) : messages.length - 1
  let lastUser = -1
  for (let index = start; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      lastUser = index
      break
    }
  }
  if (lastUser < 0) return
  const previous = messages[lastUser]
  state.chat.messages = messages.slice(0, lastUser)
  sendChat(previous.content, previous.context || chatContext())
}

function aiReadyHint() {
  const models = state.aiModels
  if (models && models.ready === false) return 'AI 暂不可用：' + (models.reason || '宿主没有提供可用模型') + '。去「设置 → AI」检查模型选择。'
  return '问关于这篇论文的任何问题；也可以点上面的快捷指令。'
}

// ---------------------------------------------------------------- 数据加载

async function loadLibrary() {
  try {
    const value = await rpc('library.list')
    state.papers = value.items || []
    state.topics = value.topics || []
    if (state.current) {
      const fresh = state.papers.find((paper) => paper.id === state.current.meta.id)
      if (fresh) state.current.meta = fresh
    }
  } catch (error) {
    toast('读取文献库失败：' + error.message)
  }
}

async function loadHealth() {
  try {
    state.health = await rpc('health')
  } catch {
    state.health = null
  }
}

/** 切论文前只摘除旧界面的 SSE 观察监听（绝不取消后台持续翻译），旧结果不再写当前 state。 */
function abortPaperWork() {
  state.translateTask += 1
  state.translateDetached = true
  if (state.translateAbort) {
    try {
      state.translateAbort.abort()
    } catch {
      /* 已结束 */
    }
  }
  state.translateAbort = null
  state.translateBusy = false
  state.translateJob = null
  // 对话：旧回答不能写进新论文的气泡
  if (state.chat.abort) {
    try {
      state.chat.abort.abort()
    } catch {
      /* 已结束 */
    }
  }
  state.chat.abort = null
  state.chat.busy = false
}

async function openPaper(id, options = {}) {
  // 从会话记忆恢复时：页签、页码、当前节都按离开时的样子来，不重置成「对照 / 上次阅读页」
  const restore = options.session && options.session.paperId === id ? options.session : null
  // 请求代次：快速切论文时，旧请求（library.get / pdf.text / doc.get / chat.get）可能后回来，
  // 每个 await 之后都对一次代次，对不上就整段丢弃（不写 state、不 render、不 saveSession）。
  const seq = ++state.openSeq
  let loaded = false
  abortPaperWork()
  stopLayoutPoll()
  stopLogPoll()
  hideFloating()
  try {
    state.busy = 'open'
    render()
    const value = await rpc('library.get', { id })
    if (seq !== state.openSeq) return
    state.current = value
    loaded = true
    const wantedPage = restore && Number(restore.page) > 0 ? Number(restore.page) : value.meta.lastReadPage || 1
    state.page = Math.max(1, Math.min(wantedPage, value.meta.pageCount || 1))
    state.pageInfo = null
    state.blocks = []
    state.card = null
    state.ocr = value.ocr || null
    state.ocrBusy = ''
    state.tab = (restore && restore.tab) || 'compare'
    state.doc = null
    state.docError = ''
    state.trans = {}
    state.streams = new Map()
    state.job = null
    state.translateJob = null
    state.translateError = ''
    state.annotations = []
    state.studyNotes = []
    state.annPopover = null
    state.sectionId = (restore && restore.sectionId) || null
    state.chat.messages = []
    state.chat.error = ''
    state.chat.busy = false
    pendingScrollReset = !restore
    state.figures = []
    state.figuresByKey = {}
    state.review = null
    state.search = { open: false, q: '', hits: [], active: 0, busy: false, error: '' }
    state.logs.events = []
    state.logs.lastSeq = 0
    // 上一篇的页尺寸与「刚才选中的那段」不能带进新论文：页尺寸会让占位比例用错页，
    // 选区记忆会让划词菜单在没有选区时翻出上一篇的原文。
    state.pageDims = {}
    state.pageLinesByPage = {}
    state.pageLinesPending = new Set()
    state.cropMode = false
    state.collapsed = { orig: new Set(), zh: new Set(), all: new Set() }
    selectionMemory = { text: '', at: 0, keys: [], host: null, pageRects: null }
    state.native.blockId = ''
    stopLayoutPoll()
    state.layoutJob = null
    state.layoutResumable = false
    state.layoutSavedPages = 0
    state.layoutApplied = false
    state.layoutQuality = null
    state.layoutBadPages = 0
    state.layoutReport = null
    state.layoutBusy = false
    state.zhMode = false
    state.zhStatus = null
    await Promise.all([loadPage(state.page, seq), loadDoc(id, seq), loadChat(id, seq), loadAi(), loadFigures(seq)])
    if (seq !== state.openSeq) return
    buildFiguresByKey()
    // 版面任务可能是在上次打开面板时开的（后台还在跑）：回来要接上进度，
    // 有断点就显示「续跑」，别让人以为要重来一遍。
    rpc('layout.status', { id })
      .then((status) => {
        if (seq !== state.openSeq || !status) return
        state.layoutJob = status.job || null
        state.layoutResumable = Boolean(status.resumable)
        state.layoutSavedPages = status.savedPages || 0
        state.layoutApplied = Boolean(status.layout && status.layout.applied)
        setLayoutQuality(status.layout)
        const running = status.job && status.job.state === 'running'
        state.layoutBusy = Boolean(running)
        render()
        if (running) pollLayoutJob(id).catch(() => {})
      })
      .catch(() => {})
    if (value.meta.status === 'unread') {
      await rpc('library.update', { id, patch: { status: 'reading' } }).catch(() => {})
      if (seq !== state.openSeq) return
      await loadLibrary()
      if (seq !== state.openSeq) return
    }
  } catch (error) {
    if (seq === state.openSeq) toast('打开失败：' + error.message)
  } finally {
    // 旧代次的 finally 一律不碰界面：新论文的 busy / render / 会话都归新那一次管
    if (seq === state.openSeq) {
      state.busy = ''
      render()
      if (loaded) {
        if (restore && Number.isFinite(Number(restore.scrollTop))) {
          const scroller = document.querySelector('.compare-scroll')
          if (scroller) scroller.scrollTop = Number(restore.scrollTop)
        }
        saveSession({ paperId: id, tab: state.tab, page: state.page, sectionId: state.sectionId })
        if (state.session.available && state.layout.chatOpen) startSessionStream(true)
      }
    }
  }
}

/** 取一页页图/文本块；不负责 render，调用方决定何时重绘（避免打开论文时闪屏多次）。 */
async function loadPage(page, seq) {
  if (!state.current) return
  const meta = state.current.meta
  // seq 由 openPaper 传入：await 回来时论文已经换掉，就别再往新论文上写旧页的数据
  const stale = () => (seq !== undefined && seq !== state.openSeq) || !state.current || state.current.meta.id !== meta.id
  const total = meta.pageCount || 0
  state.page = Math.max(1, Math.min(Number(page) || 1, total || Number(page) || 1))
  try {
    const text = await rpc('pdf.text', { id: meta.id, pages: [state.page] })
    if (stale()) return
    const pageData = (text.pages || [])[0]
    if (pageData) {
      state.pageInfo = { w: pageData.w, h: pageData.h }
      state.pageDims[state.page] = { w: pageData.w, h: pageData.h }
      state.blocks = pageData.blocks || []
    } else {
      state.pageInfo = null
      state.blocks = []
    }
    const info = await rpc('pdf.info', { id: meta.id }).catch(() => null)
    if (stale()) return
    if (info && info.pages) {
      meta.pageCount = info.pages
      state.page = Math.min(state.page, info.pages)
    }
    await rpc('library.update', { id: meta.id, patch: { lastReadPage: state.page } }).catch(() => {})
    if (stale()) return
    saveSessionSoon({ page: state.page })
    // 连续滚动视图：重绘后滚到这一页（打开论文、跳转、搜索命中都靠它定位）
    state.pendingPage = state.page
  } catch (error) {
    if (stale()) return
    state.blocks = []
    state.pageInfo = null
    toast('取文本层失败：' + error.message)
  }
}

async function loadDoc(id, seq) {
  state.docBusy = true
  // 论文换了 / 代次对不上：doc.get 的旧结果不能覆盖新论文的文档模型
  const stale = () => (seq !== undefined && seq !== state.openSeq) || !state.current || state.current.meta.id !== id
  try {
    const value = await rpc('doc.get', { id })
    if (stale()) return
    state.doc = (value && value.doc) || null
    state.docError = state.doc ? '' : 'doc.get 没有返回文档模型'
    state.trans = {}
    const entries = (value && value.trans && value.trans.entries) || {}
    // 老版本可能把「模型原样返回英文」的名单段存成了译文：这里藏掉，免得原文下面再贴一遍英文
    const byHash = new Map()
    for (const paragraph of (state.doc && state.doc.paragraphs) || []) {
      if (paragraph && paragraph.hash) byHash.set(String(paragraph.hash).toLowerCase(), paragraph.text)
    }
    let hidden = 0
    for (const [key, entry] of Object.entries(entries)) {
      const lower = String(key).toLowerCase()
      const source = byHash.get(lower)
      if (source && entry && entry.zh && sameTextLoose(entry.zh, source)) {
        hidden += 1
        continue
      }
      state.trans[lower] = entry
    }
    if (hidden > 0) console.info('[paper-workbench] 隐藏了 ' + hidden + ' 条与原文相同的译文')
    state.annotations = Array.isArray(value && value.annotations) ? value.annotations : []
    state.studyNotes = Array.isArray(value && value.studyNotes) ? value.studyNotes : []
    state.translateJob = (value && value.translateJob) || null
    if (state.translateJob && state.translateJob.status === 'running' && !state.translateBusy) {
      attachTranslateFollow(id, state.translateJob).catch(() => {})
    }
  } catch (error) {
    if (stale()) return
    state.doc = null
    state.docError = error.message
    state.trans = {}
  } finally {
    if (seq !== undefined ? seq === state.openSeq : Boolean(state.current && state.current.meta.id === id)) {
      state.docBusy = false
    }
  }
}

async function rebuildDoc() {
  if (!state.current || state.docBusy) return
  const id = state.current.meta.id
  const seq = state.openSeq
  const stale = () => seq !== state.openSeq || !state.current || state.current.meta.id !== id
  state.docBusy = true
  render()
  try {
    await rpc('doc.build', { id })
    if (stale()) return
    await loadDoc(id, seq)
    if (stale()) return
    toast('文档模型已重建')
  } catch (error) {
    if (stale()) return
    state.docError = '重建失败：' + error.message
    toast('重建失败：' + error.message)
  } finally {
    if (!stale()) {
      state.docBusy = false
      render()
    }
  }
}

async function loadCard() {
  if (!state.current) return
  const id = state.current.meta.id
  const seq = state.openSeq
  try {
    const card = await rpc('vault.read', { id })
    if (seq === state.openSeq && state.current && state.current.meta.id === id) state.card = card
  } catch {
    if (seq === state.openSeq && state.current && state.current.meta.id === id) state.card = null
  }
}

async function loadChat(id, seq) {
  if (NATIVE_READER) return
  const stale = () => (seq !== undefined && seq !== state.openSeq) || !state.current || state.current.meta.id !== id
  try {
    const value = await rpc('chat.get', { id })
    if (stale()) return
    state.chat.messages = (value.messages || []).map((message) => ({
      role: message.role,
      content: message.content,
      model: message.model || '',
      context: message.context,
    }))
  } catch (error) {
    if (stale()) return
    state.chat.messages = []
    if (!/no such method/i.test(error.message)) state.chat.error = '对话历史读取失败：' + error.message
  }
}

async function saveNotes(highlights) {
  if (!state.current) return
  try {
    await rpc('notes.save', { id: state.current.meta.id, highlights })
    state.current.notes = { highlights }
    render()
  } catch (error) {
    toast('保存笔记失败：' + error.message)
  }
}

// ---------------------------------------------------------------- OCR（扫描件，保留原文页入口）

async function runOcr() {
  if (!state.current || state.ocrBusy) return
  const id = state.current.meta.id
  // OCR 轮询要跟着论文走：切了论文（或 id 变了）就停，旧任务的结果不能再写 state.doc
  const seq = state.openSeq
  const stale = () => seq !== state.openSeq || !state.current || state.current.meta.id !== id
  const model = (state.settings && state.settings.config && state.settings.config.ocr && state.settings.config.ocr.model) || ''
  const began = Date.now()
  state.ocrBusy = '正在提交 OCR 任务…'
  render()
  try {
    let status = await rpc('ocr.start', model ? { id, model } : { id })
    if (stale()) return
    state.ocr = status
    while ((status.state === 'pending' || status.state === 'running') && Date.now() - began < 40 * 60 * 1000) {
      if (stale()) return
      state.ocrBusy = 'OCR 进行中：' + (status.extractedPages || 0) + ' / ' + (status.totalPages || '?') + ' 页（已等 ' + Math.round((Date.now() - began) / 1000) + ' 秒）'
      render()
      await new Promise((resolve) => setTimeout(resolve, 2500))
      if (stale()) return
      status = await rpc('ocr.status', { id })
      if (stale()) return
      state.ocr = status
    }
    if (status.state === 'pending' || status.state === 'running') {
      throw new Error('等了 40 分钟还没完成，任务可能仍在云端跑；稍后回到这篇按「OCR 识别」查状态。')
    }
    if (status.state === 'failed') throw new Error(status.error || 'OCR 任务失败')
    // 扫描件 OCR 完成后，对照视图用新的 ocr → doc；但绝不能把这篇的 doc 写到别的论文上
    if (!state.current || state.current.meta.id !== id) return
    await loadDoc(id)
    if (stale()) return
    toast('OCR 完成：' + (status.pages || status.extractedPages || 0) + ' 页')
  } catch (error) {
    if (!stale()) toast('OCR 失败：' + error.message)
  } finally {
    if (!stale()) {
      state.ocrBusy = ''
      render()
    }
  }
}

// ---------------------------------------------------------------- 渲染入口

let deferredRender = false
let deferredSince = 0
let deferredTimer = 0
const RENDER_DEFER_MAX_MS = 1200
// 选区一直不消失时最多拖这么久也要补绘一次：否则搜索框 / 弹层会被选区卡住永不出现
const RENDER_DEFER_FALLBACK_MS = 600

/** 选区消失（或等太久 / 兜底定时器到点）后补做被推迟的整页重绘。 */
function flushDeferredRender(force = false) {
  if (deferredTimer) {
    clearTimeout(deferredTimer)
    deferredTimer = 0
  }
  if (!deferredRender) return
  if (!force && liveReaderSelection().length >= 2 && Date.now() - deferredSince < RENDER_DEFER_MAX_MS) return
  deferredRender = false
  deferredSince = 0
  render(true)
}

function render(force = false) {
  // 用户正在正文里选字时别整页重绘：app.replaceChildren() 会把选区所在的节点一起换掉，
  // 拖选到一半节点被换掉，Chrome 会把选区挪到新节点上，mouseup 时取到的就不是用户选的那段。
  // 这里先记账，等选区空了（或最多等 RENDER_DEFER_MAX_MS）再补绘。
  if (!force && liveReaderSelection().length >= 2) {
    if (!deferredSince) deferredSince = Date.now()
    if (Date.now() - deferredSince < RENDER_DEFER_MAX_MS) {
      deferredRender = true
      if (!deferredTimer) {
        deferredTimer = setTimeout(() => {
          deferredTimer = 0
          flushDeferredRender(true)
        }, RENDER_DEFER_FALLBACK_MS)
      }
      return
    }
  }
  deferredRender = false
  deferredSince = 0
  if (deferredTimer) {
    clearTimeout(deferredTimer)
    deferredTimer = 0
  }
  const previousScroll = pendingScrollReset ? 0 : (document.querySelector('.compare-scroll') || {}).scrollTop || 0
  const previousPageScroll = (document.querySelector('.page-scroll') || {}).scrollTop || state.pageScrollTop || 0
  const previousOutline = (document.querySelector('.outline') || {}).scrollTop || 0
  // 重绘会换掉输入框节点：正在对话里打字时把焦点与光标还回去
  const focusChat = !!(document.activeElement && document.activeElement.id === 'chat-input')
  pendingScrollReset = false
  app.replaceChildren(renderShell())
  if (focusChat) {
    const input = document.getElementById('chat-input')
    if (input) {
      input.focus({ preventScroll: true })
      const end = input.value.length
      try {
        input.setSelectionRange(end, end)
      } catch {
        /* 非文本输入控件时忽略 */
      }
    }
  }
  // 目录标题/节标题的译文节点渲染时是空的（只能按 data-zh 后填），这里统一补一遍缓存译文
  paintAllTranslations()
  const scroller = document.querySelector('.compare-scroll')
  if (scroller) {
    if (previousScroll) scroller.scrollTop = previousScroll
    // 位置变化就记一下，退出再进来能回到同一处
    scroller.addEventListener('scroll', () => saveSessionSoon(), { passive: true })
  }
  const outline = document.querySelector('.outline')
  if (outline && previousOutline) outline.scrollTop = previousOutline
  const pageScroller = document.querySelector('.page-scroll')
  if (pageScroller) {
    // 跳转/缩放：滚到目标页顶部；普通重绘：回到原来的滚动位置
    if (state.pendingPage) {
      const target = pageScroller.querySelector('[data-page="' + state.pendingPage + '"]')
      if (target) pageScroller.scrollTop = target.offsetTop
      state.pageScrollTop = pageScroller.scrollTop
      state.pendingPage = 0
    } else if (previousPageScroll) {
      pageScroller.scrollTop = previousPageScroll
    }
    setupPageScroll(pageScroller)
  }
  const chatList = document.querySelector('.chat-messages')
  if (chatList) chatList.scrollTop = chatList.scrollHeight
  setupSectionObserver()
  notifyReaderState()
}

function renderShell() {
  const layout = state.layout
  const children = []
  if (layout.sideOpen) children.push(renderSide(), makeSplitter('side'))
  children.push(renderMain())
  if (!NATIVE_READER && layout.chatOpen) children.push(makeSplitter('chat'), renderChat())
  return h('div', { class: 'shell', style: { gridTemplateColumns: shellColumns(layout) } }, ...children)
}

function renderSide() {
  const filtered = state.papers.filter((paper) => {
    if (!state.filter) return true
    const haystack = [paper.title, paper.year, (paper.tags || []).join(' '), (paper.topics || []).join(' '), paper.arxivId].join(' ').toLowerCase()
    return haystack.includes(state.filter.toLowerCase())
  })
  const groups = new Map()
  for (const paper of filtered) {
    const key = (paper.topics && paper.topics[0]) || '未分类'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(paper)
  }
  const searching = state.filter.trim() !== ''
  const isOpen = (topic) => (searching ? !state.tempCollapsed.has(topic) : state.expanded.has(topic))
  const topicKeys = [...groups.keys()]

  return h(
    'aside',
    { class: 'side' },
    h(
      'div',
      { class: 'side-head' },
      h('div', { class: 'brand' }, h('span', {}, '论文工作台'), h('small', {}, state.papers.length + ' 篇')),
      h(
        'div',
        { class: 'side-search' },
        h('input', {
          type: 'search',
          placeholder: '搜标题 / 标签 / arXiv 号',
          value: state.filter,
          oninput: (event) => {
            state.filter = event.target.value
            state.tempCollapsed.clear()
            render()
            // 整页重渲染会换掉输入框节点；不补焦点的话每敲一个字就失焦
            const next = document.querySelector('.side-search input')
            if (next) {
              next.focus()
              const end = next.value.length
              next.setSelectionRange(end, end)
            }
          },
        }),
      ),
      h(
        'div',
        { class: 'side-actions' },
        h('button', { onclick: importByPath }, '＋ 按路径导入'),
        h('button', { onclick: uploadPdf }, '上传 PDF'),
        obsidianEnabled()
          ? h('button', { onclick: importFromVault, title: '扫描 Obsidian 卡片里记录的原始 PDF 并入库' }, '从笔记库导入')
          : null,
        h('button', { onclick: importFromDir, title: '扫描本地目录（及子文件夹）里的全部 PDF 批量入库' }, '批量导入目录'),
        h('button', { onclick: () => toggleOnline() }, state.tab === 'online' ? '返回阅读' : '在线检索'),
        state.picked.size > 0
          ? h('button', { class: 'primary', onclick: comparePicked, title: '让 agent 对比这些论文并写一篇方向综述' }, '对比综述 (' + state.picked.size + ')')
          : null,
        state.picked.size > 0 ? h('button', { class: 'ghost', onclick: () => { state.picked.clear(); render() } }, '取消选择') : null,
      ),
      h(
        'div',
        { class: 'tree-toolbar' },
        h('span', { class: 'hint' }, searching ? '搜索：命中分组临时展开' : '展开 ' + topicKeys.filter((topic) => state.expanded.has(topic)).length + ' / ' + topicKeys.length + ' 组'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', title: '展开所有分组', onclick: () => expandAllGroups(topicKeys, searching) }, '全部展开'),
        h('button', { class: 'ghost', title: '收起所有分组', onclick: () => collapseAllGroups(topicKeys, searching) }, '全部收起'),
      ),
    ),
    h(
      'div',
      { class: 'tree' },
      filtered.length === 0
        ? h('div', { class: 'hint', style: { padding: '10px 6px' } }, state.filter ? '没有命中；换个关键词试试。' : '还没有论文。用上面的按钮导入，或先去在线检索。')
        : [...groups.entries()].map(([topic, items]) => {
            const open = isOpen(topic)
            return h(
              'div',
              { class: 'topic' },
              h(
                'div',
                {
                  class: 'topic-title',
                  role: 'button',
                  tabindex: '0',
                  'aria-expanded': open ? 'true' : 'false',
                  onclick: () => toggleGroup(topic, searching),
                  onkeydown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      toggleGroup(topic, searching)
                    }
                  },
                },
                h('span', {}, (open ? '▾ ' : '▸ ') + topic),
                h('span', {}, items.length),
              ),
              open
                ? items.map((paper) =>
                    h(
                      'div',
                      {
                        class: 'paper-row' + (state.current && state.current.meta.id === paper.id ? ' active' : ''),
                        role: 'button',
                        tabindex: '0',
                        onclick: () => openPaper(paper.id),
                        // 行内还有复选框：键盘事件从复选框冒上来时交给它自己处理
                        onkeydown: (event) => {
                          if (event.target !== event.currentTarget) return
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            openPaper(paper.id)
                          }
                        },
                        title: paper.title,
                      },
                      h(
                        'span',
                        {},
                        h('input', {
                          type: 'checkbox',
                          checked: state.picked.has(paper.id),
                          title: '选中用于多篇对比',
                          onclick: (event) => {
                            event.stopPropagation()
                            if (event.target.checked) state.picked.add(paper.id)
                            else state.picked.delete(paper.id)
                            render()
                          },
                        }),
                      ),
                      h('span', { class: ['dot', paper.status || '', paper.notesCount ? 'note' : ''].filter(Boolean).join(' ') }),
                      h(
                        'span',
                        {},
                        h('div', { class: 'paper-title' }, paper.title),
                        h('div', { class: 'paper-meta' }, [paper.year, fmtAuthors(paper.authors), paper.pageCount ? paper.pageCount + ' 页' : ''].filter(Boolean).join(' · ')),
                      ),
                      (() => {
                        const liveJob =
                          state.current && state.current.meta.id === paper.id && state.translateJob
                            ? state.translateJob
                            : ((state.health && state.health.activeTranslations) || []).find((j) => j.paperId === paper.id)
                        if (liveJob && (liveJob.status === 'running' || liveJob.status === 'paused')) {
                          return h(
                            'span',
                            {
                              class: 'paper-trans-badge' + (liveJob.status === 'paused' ? ' paused' : ''),
                              'data-paper-trans-badge': paper.id,
                              title: liveJob.status === 'running' ? '后台翻译中' : '翻译已暂停，待继续',
                            },
                            (liveJob.status === 'paused' ? '⏸ ' : '译 ') + (liveJob.completed || 0) + '/' + (liveJob.total || '?'),
                          )
                        }
                        return h('span', { class: 'paper-meta', 'data-paper-trans-badge': paper.id }, paper.status === 'read' ? '✓' : '')
                      })(),
                    ),
                  )
                : null,
            )
          }),
    ),
    h(
      'div',
      { class: 'statusbar' },
      h('span', {}, state.health && state.health.pdf && state.health.pdf.ok ? 'PDF ✓' : 'PDF ✗'),
      obsidianEnabled()
        ? h('span', {}, state.health && state.health.vault && state.health.vault.ok ? 'Obsidian ✓' : 'Obsidian ✗')
        : h(
            'span',
            { title: '当前存储后端' },
            'DB ' + ((state.health && state.health.db && (state.health.db.driver || state.health.db.engine)) || 'sqlite').toUpperCase() + (state.health && state.health.db && state.health.db.healthy === false ? ' ✗' : ' ✓'),
          ),
      h('span', { title: 'PaddleOCR 云端接口（扫描件）' }, 'OCR ' + (state.health && state.health.ocr && state.health.ocr.configured ? '✓' : '✗')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'ghost', onclick: openSettings, title: '设置' }, '⚙'),
    ),
  )
}

function toggleGroup(topic, searching) {
  if (searching) {
    if (state.tempCollapsed.has(topic)) state.tempCollapsed.delete(topic)
    else state.tempCollapsed.add(topic)
  } else {
    if (state.expanded.has(topic)) state.expanded.delete(topic)
    else state.expanded.add(topic)
    saveTree()
  }
  render()
}

function expandAllGroups(topicKeys, searching) {
  if (searching) state.tempCollapsed.clear()
  else {
    state.expanded = new Set(topicKeys)
    saveTree()
  }
  render()
}

function collapseAllGroups(topicKeys, searching) {
  if (searching) state.tempCollapsed = new Set(topicKeys)
  else {
    state.expanded.clear()
    saveTree()
  }
  render()
}

function toggleOnline() {
  state.tab = state.tab === 'online' ? (state.current ? 'compare' : 'online') : 'online'
  if (state.tab === 'online' && !state.latestFeed.loaded && !state.latestFeed.loading && (state.fullConfig?.topics || state.health?.obsidian !== undefined)) {
    loadLatestFeed().catch(() => {})
  }
  render()
}

function renderMain() {
  const overlays = []
  if (state.search.open) overlays.push(renderSearchOverlay())
  if (state.trash.open) overlays.push(renderTrashModal())
  if (state.convPicker.open) overlays.push(renderConvPicker())
  if (state.layoutReport) overlays.push(renderLayoutReport())
  if (state.showSettings) return h('section', { class: 'main' }, renderTopbar(), h('div', { class: 'content' }, renderSettings()), ...overlays)
  const isOnline = state.tab === 'online' || (!state.current && state.online.items.length > 0)
  const content = isOnline ? renderOnline() : !state.current ? renderEmpty() : renderReader()
  const showNativeSubbar = NATIVE_READER && state.current && !isOnline && state.tab !== 'compare'
  return h('section', { class: 'main' }, renderTopbar(), showNativeSubbar ? renderNativeActions() : null, content, ...overlays)
}

function nativeReaderStatus() {
  if (!state.native.available) return '原生会话尚未连接'
  return state.native.conversationId ? '' : '右侧可新建对话'
}

function nativeQuickGroup() {
  const meta = state.current && state.current.meta
  const action = (label, title, onclick) =>
    h('button', { class: 'ai-chip', 'data-native-ask': '', disabled: !state.native.available, title, onclick }, label)
  return h(
    'div',
    { class: 'toolbar-group ai-quick-group', role: 'group', 'aria-label': 'AI 导读与提问' },
    action('全文导读', '快速把握研究问题、核心直觉、关键结论与阅读路线（附原文引用）', () => sendQuick(meta ? P.guide(meta) : '请给我一份这篇论文的全文导读与核心总结。', { scope: 'paper' })),
    action('讲解本节', '自适应拆解当前章节的核心思路、公式推导、算法设计与实验论证', () => explainSection(state.sectionId || sectionsOf()[0]?.id)),
  )
}

function renderNativeActions() {
  return h(
    'div',
    { class: 'toolbar sub-ai-toolbar' },
    nativeQuickGroup(),
    h('span', { id: 'native-reader-status', class: 'hint', role: 'status', 'aria-live': 'polite' }, nativeReaderStatus()),
  )
}

function paneButton(kind, label) {
  const open = NATIVE_READER && kind === 'chat' ? state.native.open : state.layout[kind + 'Open']
  return h(
    'button',
    {
      class: 'ghost' + (open ? ' active' : ''),
      'data-pane': kind,
      title: (open ? '收起' : '打开') + (kind === 'side' ? '文献库' : kind === 'outline' ? '目录' : '对话') + (kind === 'outline' ? '（拖动目录右侧分隔条调宽）' : ''),
      onclick: () => togglePane(kind),
    },
    label,
  )
}

function renderTopbar() {
  const meta = state.current && state.current.meta
  const sections = sectionsOf()
  const tabs = [
    ['compare', '对照'],
    ['page', '原文页'],
    ['notes', '笔记'],
    ...(obsidianEnabled() ? [['card', '卡片']] : []),
  ]
  const notesBadge =
    ((state.annotations && state.annotations.length) || 0) +
    ((state.studyNotes && state.studyNotes.length) || 0) +
    ((state.current && state.current.notes && state.current.notes.highlights && state.current.notes.highlights.length) || 0)
  return h(
    'div',
    { class: 'topbar' },
    meta ? h('span', { class: 'title', title: meta.title }, meta.title) : h('span', { class: 'title' }, '论文工作台'),
    meta
      ? h(
          'div',
          { class: 'tabs' },
          tabs.map(([key, label]) =>
            h(
              'button',
              {
                class: 'tab' + (state.tab === key ? ' active' : ''),
                'data-tab': key,
                onclick: () => switchTab(key),
              },
              label + (key === 'notes' ? ' ' + notesBadge : ''),
            ),
          ),
        )
      : null,
    h('span', { class: 'spacer' }),
    // 把栏开关收进一个 flex 分组：窄屏时整组换行，不会被拆成一列单按钮
    h(
      'div',
      { class: 'topbar-actions' },
      paneButton('side', '文献库'),
      h('button', { class: 'ghost' + (state.layout.outlineOpen ? ' active' : ''), disabled: sections.length === 0, 'data-pane': 'outline', onclick: () => togglePane('outline'), title: '目录（与拖动目录分隔条是同一个开关）' }, '目录'),
      paneButton('chat', '对话'),
      h('span', { class: 'topbar-sep', 'aria-hidden': 'true' }),
      meta ? h('button', { class: 'ghost', 'data-act': 'search', disabled: !hostReady(), title: hostReady() ? '文内搜索（Ctrl+F）' : '重启桌面端后可用', onclick: openSearch }, '🔍') : null,
      h('button', { class: 'ghost', 'data-act': 'dark', title: 'PDF 深色（三档：关/柔和/强）', onclick: cycleDark }, state.dark === 0 ? '◐' : state.dark === 1 ? '◑' : '◒'),
      h('button', { class: 'ghost', 'data-act': 'trash', disabled: !hostReady(), title: hostReady() ? '回收站' : '重启桌面端后可用', onclick: openTrash }, '🗑'),
      meta
        ? h(
            'button',
            {
              class: 'ghost danger-subtle',
              title: '将当前论文移入回收站（原 PDF 文件不会删除）',
              onclick: async () => {
                if (!window.confirm('把这篇文章移出文献库？（PDF 不会删除，只会移入 .trash）')) return
                try {
                  await rpc('library.remove', { id: meta.id })
                } catch (error) {
                  toast('移出失败：' + error.message)
                  return
                }
                state.openSeq += 1
                abortPaperWork()
                stopLayoutPoll()
                stopLogPoll()
                hideFloating()
                state.current = null
                state.doc = null
                await loadLibrary()
                saveSession({ paperId: null })
                render(true)
              },
            },
            '移出',
          )
        : null,
      h('button', { class: 'ghost', onclick: openSettings, title: '设置与环境自检' }, '⚙'),
    ),
  )
}

function switchTab(key) {
  state.tab = key
  if (key === 'card') {
    loadCard().then(() => render())
  }
  if (key === 'page' && state.current && !state.pageInfo) {
    loadPage(state.page).then(() => render())
  }
  render()
  saveSession({ tab: key, page: state.page })
}

function renderEmpty() {
  return h(
    'div',
    { class: 'content' },
    h(
      'div',
      { class: 'empty' },
      h('h2', {}, '论文工作台：对照阅读 + 原生会话'),
      h(
        'ol',
        {},
        h('li', {}, '左侧导入本地 PDF，或点「在线检索」按关键词 / arXiv 号 / DOI 找开放获取论文；'),
        h('li', {}, '打开论文后默认进入「对照」：节标题 + 原文段 + 中文译文连续滚动，目录点击只跳转；'),
        h('li', {}, '工具栏点「译本节」翻译当前节，「整篇翻译」按文档顺序后台并发推进，「⏸ 暂停翻译」随时暂停；'),
        h('li', {}, NATIVE_READER ? '右侧是原生 DSH 会话：模型、附件和工具由原生输入框管理；翻译在论文段落下方独立显示。' : '右侧对话流式回答，回答里的页码引用可点开原文页；翻译与对话分别选择模型。'),
      ),
    ),
  )
}

function renderReader() {
  const sections = sectionsOf()
  const outlineOpen = state.layout.outlineOpen && sections.length > 0
  const children = []
  if (outlineOpen) children.push(renderOutline(sections), makeSplitter('outline'))
  children.push(renderTabBody())
  return h(
    'div',
    { class: 'content' },
    h('div', { class: 'reader', style: { gridTemplateColumns: outlineColumns({ ...state.layout, outlineOpen }) } }, ...children),
    renderLogDrawer(),
  )
}

function renderTabBody() {
  if (state.tab === 'page') return renderPagePane()
  if (state.tab === 'notes') return renderNotesPane()
  if (state.tab === 'card') return renderCardPane()
  return renderCompare()
}

// ---------------------------------------------------------------- 目录（只跳转，不过滤）

/** 文档模型优先；没有 doc 时退化成 v1 的 outline，保证目录仍可翻页。 */
function sectionsOf() {
  if (state.doc && Array.isArray(state.doc.sections) && state.doc.sections.length > 0) return state.doc.sections
  const outline = (state.current && state.current.outline) || []
  return outline.map((item, index) => ({
    id: 'v1-' + index,
    title: item.title,
    level: item.level || 1,
    page: item.page || 1,
    hash: null,
    fallback: true,
  }))
}

function renderOutline(sections) {
  return h(
    'div',
    { class: 'outline', 'aria-label': '论文目录' },
    sections.map((section) => {
      const level = Math.min(3, section.level || 1)
      const titleKey = section.hash ? 't:' + String(section.hash).toLowerCase() : ''
      const active = section.id === state.sectionId
      return h(
        'div',
        { class: 'outline-item lv' + level + (active ? ' active' : ''), 'data-section': section.id, title: section.title },
        h(
          'div',
          {
            class: 'outline-jump',
            onclick: () => jumpToSection(section),
            role: 'button',
            tabindex: '0',
            onkeydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                jumpToSection(section)
              }
            },
          },
          h('div', { class: 'outline-title' }, section.title),
          titleKey ? h('div', { class: 'outline-zh', 'data-zh': titleKey }) : null,
        ),
        h(
          'div',
          { class: 'outline-actions' },
          h('button', { class: 'link', title: '翻译本节', onclick: (event) => { event.stopPropagation(); translateSection(section.id) } }, '译'),
          h('button', { class: 'link', title: '让对话讲解本节', onclick: (event) => { event.stopPropagation(); explainSection(section.id) } }, '讲'),
        ),
      )
    }),
  )
}

/** 目录点击：对照视图滚到节锚点；原文页只翻到该节起始页；其它视图不切换、不过滤。 */
function jumpToSection(section) {
  if (!section) return
  if (state.tab === 'compare') {
    const target = document.getElementById('sec-' + section.id)
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' })
    state.sectionId = section.id
    state.page = section.page || state.page
    state.native.blockId = ''
    notifyReaderState()
    saveSessionSoon()
    paintOutlineActive()
  } else if (state.tab === 'page') {
    loadPage(section.page || 1).then(() => render())
  }
}

function explainSection(sectionId) {
  const section = sectionsOf().find((item) => item.id === sectionId)
  if (!NATIVE_READER && !state.layout.chatOpen) {
    state.layout.chatOpen = true
    saveLayout()
  }
  const targetPage = section?.page || state.page || 1
  const prompt = section
    ? '请深入讲解本节《' + section.title + '》：梳理核心思路、关键公式或架构设计细节、与前后文的逻辑衔接，并标注原文引用。'
    : '请讲解当前阅读页（第 ' + targetPage + ' 页）的核心内容与关键细节，并标注原文引用。'
  sendChat(prompt, chatContext({ sectionId: section ? section.id : sectionId || null, page: targetPage, scope: 'section' }))
}

function setupSectionObserver() {
  if (state.sectionObserver) {
    state.sectionObserver.disconnect()
    state.sectionObserver = null
  }
  if (state.tab !== 'compare' || typeof IntersectionObserver === 'undefined') return
  const root = document.querySelector('.compare-scroll')
  if (!root) return
  const headings = [...root.querySelectorAll('.sec-title[data-section]')]
  if (headings.length === 0) return
  state.sectionObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
      if (visible.length === 0) return
      const top = visible.reduce((best, entry) => (entry.boundingClientRect.top <= best.boundingClientRect.top ? entry : best))
      const sectionId = top.target.getAttribute('data-section')
      if (sectionId && sectionId !== state.sectionId) {
        state.sectionId = sectionId
        state.page = sectionsOf().find(item => item.id === sectionId)?.page || state.page
        state.native.blockId = ''
        notifyReaderState()
        saveSessionSoon()
        paintOutlineActive()
      }
    },
    { root, rootMargin: '-8% 0px -78% 0px', threshold: 0 },
  )
  for (const heading of headings) state.sectionObserver.observe(heading)
}

function paintOutlineActive() {
  const items = document.querySelectorAll('.outline-item')
  for (const item of items) item.classList.toggle('active', item.getAttribute('data-section') === state.sectionId)
  const active = document.querySelector('.outline-item.active')
  if (active) active.scrollIntoView({ block: 'nearest' })
}

// ---------------------------------------------------------------- 对照视图

function renderCompare() {
  const pane = h('div', { class: 'compare-pane' })
  pane.append(renderCompareToolbar())
  if (state.review) pane.append(renderReviewPanel())
  if (!state.doc || !Array.isArray(state.doc.paragraphs) || state.doc.paragraphs.length === 0) {
    pane.append(renderDocMissing())
    return pane
  }
  const sections = sectionsOf().length > 0 ? sectionsOf() : [{ id: 's0', title: '全文', level: 1, page: (state.doc.paragraphs[0] || {}).page || 1 }]
  const bySection = new Map(sections.map((section) => [section.id, []]))
  const fallback = sections[0].id
  for (const paragraph of state.doc.paragraphs) {
    let sid = paragraph.section && bySection.has(paragraph.section) ? paragraph.section : fallback
    if (!bySection.has(sid)) bySection.set(sid, [])
    bySection.get(sid).push(paragraph)
  }
  // 只要已有译文或正在翻译就展示译文层（除非用户切到了「原文」模式）
  const hasZh = !state.ai.hideZh && (state.ai.translateOn || state.ai.onlyZh || Object.keys(state.trans).length > 0 || state.streams.size > 0)
  const sideMode = state.ai.sideBySide && !state.ai.onlyZh && !state.ai.hideZh
  const compare = h('div', {
    class: 'compare' + (hasZh ? ' show-zh' : '') + (state.ai.onlyZh ? ' only-zh' : '') + (sideMode ? ' side-by-side' : ''),
  })
  for (const section of sections) {
    const titleKey = section.hash ? 't:' + String(section.hash).toLowerCase() : ''
    compare.append(
      h(
        'div',
        { class: 'sec-head' },
        h(
          'h2',
          { class: 'sec-title', id: 'sec-' + section.id, 'data-section': section.id, tabindex: '-1' },
          h('span', { class: 'sec-title-text' }, section.title),
          section.page ? h('small', { class: 'muted sec-page' }, 'p.' + section.page) : null,
        ),
        titleKey ? h('div', { class: 'sec-title-zh', 'data-zh': titleKey }) : null,
      ),
    )
    let prevPage = Number(section.page) || 0
    for (const paragraph of bySection.get(section.id) || []) {
      if (paragraph.kind === 'heading' && sameHeading(paragraph.text, section.title)) continue
      const pPage = Number(paragraph.page) || 0
      if (pPage && prevPage && pPage !== prevPage) {
        compare.append(
          h(
            'div',
            { class: 'page-divider', 'data-page': pPage },
            h(
              'button',
              {
                type: 'button',
                class: 'page-divider-btn',
                title: '跳转到原文第 ' + pPage + ' 页',
                onclick: () => jumpToPage(pPage),
              },
              'p.' + pPage,
            ),
          ),
        )
      }
      if (pPage) prevPage = pPage
      compare.append(renderParagraph(paragraph))
    }
  }
  pane.append(h('div', { class: 'compare-scroll' }, compare))
  return pane
}

function normHeading(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^\s*\d+(?:\.\d+)*\.?\s+/, '')
    .replace(/[\s:：.。·\-—_]+/g, '')
}

function sameHeading(text, title) {
  const a = normHeading(text)
  const b = normHeading(title)
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}

function figureUrl(position) {
  return API + 'figure?id=' + encodeURIComponent(state.current.meta.id) + '&index=' + position
}

/** 版面模型给的图/表块：图就显示在自己那一格，表格默认显示裁剪图，可展开文字。 */
function renderFigureParagraph(paragraph) {
  const kind = paragraph.kind || 'figure'
  const position = Number(paragraph.figureIndex)
  if (!Number.isFinite(position) || position < 0) {
    return h('div', { class: 'para kind-body', id: 'para-' + paragraph.id }, paragraph.text || '')
  }
  const src = figureUrl(position)
  const figure = h(
    'figure',
    { class: 'inline-fig block-fig kind-' + kind, id: 'para-' + paragraph.id, 'data-page': paragraph.page || 1 },
    h('img', {
      src,
      alt: (kind === 'table' ? '表 ' : '图 ') + (position + 1),
      loading: 'lazy',
      title: '点击看大图',
      onclick: () => window.open(src, '_blank', 'noopener'),
    }),
  )
  if (kind === 'table') {
    const grid = renderTableGrid(paragraph)
    if (grid !== null) figure.append(grid)
    if (paragraph.text) {
      figure.append(
        h('details', { class: 'table-text' }, h('summary', {}, '表格纯文本'),
          h('pre', {}, paragraph.text)),
      )
    }
  }
  return figure
}

/**
 * 表格块的表格结构（可选中、可复制）。
 *
 * 服务端/PDF 抽出来的格子并不可靠（合并单元格、整列并进一格都会被画错列），
 * 所以默认显示的是「裁剪图」——那是原文；结构放在折叠块里，用户自己决定要不要用。
 * 单元格一律用 h() 建，不 innerHTML：结构在宿主侧已经转成纯数据。
 */
function renderTableGrid(paragraph) {
  const model = paragraph.table
  const rows = model && Array.isArray(model.rows) ? model.rows : []
  if (rows.length === 0) return null
  const table = h('table', { class: 'lit-table' })
  const headerRows = Math.max(0, Math.min(rows.length, Number(model.headerRows) || 0))
  let body = null
  rows.forEach((row, index) => {
    const cells = Array.isArray(row.cells) ? row.cells : []
    if (cells.length === 0) return
    const tr = h('tr')
    for (const cell of cells) {
      if (cell.placeholder === true) continue
      const tag = cell.header ? 'th' : 'td'
      const attrs = {}
      if (Number(cell.colspan) > 1) attrs.colspan = Number(cell.colspan)
      if (Number(cell.rowspan) > 1) attrs.rowspan = Number(cell.rowspan)
      if (cell.text) attrs.title = cell.text
      tr.append(h(tag, attrs, cell.text || ''))
    }
    if (index < headerRows) {
      if (!table.querySelector('thead')) table.append(h('thead'))
      table.querySelector('thead').append(tr)
    } else {
      if (body === null) {
        body = h('tbody')
        table.append(body)
      }
      body.append(tr)
    }
  })
  if (!table.querySelector('tbody')) table.append(h('tbody'))
  return h(
    'details',
    { class: 'table-grid' },
    h('summary', {}, '表格结构（可选中、复制；识别可能有错，以左侧原图为准）'),
    h('div', { class: 'table-scroll' }, table),
    h('div', { class: 'table-note' }, model.source === 'pdf' ? '格子来自 PDF 的格线' : '格子来自版面模型'),
  )
}

/**
 * 公式：有 KaTeX 就按数学排版渲染，没有就退回源码（KaTeX 打包在插件里，正常不会缺）。
 *
 * 用 katex.render 直接往节点里排，不走 innerHTML —— 走库自己的 DOM 构造路径，
 * 也就没有「把模型输出的字符串当 HTML 塞进页面」这条风险。
 */
/**
 * 行内公式：图注/表注里模型给的是 `$n=12$` 这类 LaTeX，直接显示会是源码。
 * 只切 `$…$`（不含跨行），渲染失败退回原文，绝不拼 HTML。
 */
function appendInlineMath(box, text) {
  const value = String(text || '')
  const pattern = /\$(?!\s)([^$\n]{1,240}?)(?<!\s)\$/g
  let last = 0
  let match = null
  while ((match = pattern.exec(value)) !== null) {
    if (/^\d+(?:[.,]\d+)?(?:\s|\)|,|\b\s+(?:and|or|to|vs\.?)\b)/i.test(match[1])) continue
    if (match.index > last) box.append(document.createTextNode(value.slice(last, match.index)))
    const span = h('span', { class: 'inline-math', 'data-tex': '$' + match[1] + '$' })
    const katex = typeof window !== 'undefined' ? window.katex : null
    let ok = false
    if (katex && typeof katex.render === 'function') {
      try {
        katex.render(match[1], span, { displayMode: false, throwOnError: false, strict: false, trust: false, output: 'html' })
        ok = true
      } catch {
        ok = false
      }
    }
    if (!ok) span.textContent = match[1]
    box.append(span)
    last = match.index + match[0].length
  }
  if (last === 0) {
    if (value) box.append(document.createTextNode(value))
    return false
  }
  if (last < value.length) box.append(document.createTextNode(value.slice(last)))
  return true
}

function renderInlineMath(text) {
  const box = h('div', { class: 'para-orig' })
  appendInlineMath(box, text)
  return box
}

function renderCaptionOrig(textValue) {
  const match = /^((?:Figure|Fig\.?|Table|Algorithm|Alg\.?|图|表|算法)\s*(?:\d+(?:\.\d+)*|[IVXLC]+)\s*[:：.]?\s*)/i.exec(textValue)
  if (!match) return renderInlineMath(textValue)
  const box = h('div', { class: 'para-orig' }, h('span', { class: 'caption-prefix' }, match[1]))
  appendInlineMath(box, textValue.slice(match[1].length))
  return box
}

const ANN_COLOR_HEX = { yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', pink: '#ec4899', purple: '#a855f7', note: '#eab308' }
const ANN_KIND_LABELS = { highlight: '高亮', underline: '下划线', bold: '加粗', comment: '批注', insert: '插入' }

function annotationsFor(key, target = '') {
  if (!key || !Array.isArray(state.annotations)) return []
  const k = String(key).toLowerCase()
  return state.annotations.filter((item) => item && item.paragraphKey === k && (!target || (item.target || 'orig') === target))
}

function collectTextUnits(root) {
  const units = []
  let offset = 0
  const walk = (node) => {
    if (!node) return
    if (node.nodeType === 3) {
      const txt = node.textContent || ''
      if (txt.length > 0) {
        units.push({ kind: 'text', node, text: txt, start: offset, end: offset + txt.length })
        offset += txt.length
      }
      return
    }
    if (node.nodeType !== 1) return
    const cls = node.classList
    if (cls && (cls.contains('footnote-tag') || cls.contains('para-collapse-bar') || cls.contains('ann-bubble') || cls.contains('ann-insert-chip') || cls.contains('ann-popover'))) return
    const tex = typeof node.getAttribute === 'function' ? node.getAttribute('data-tex') : null
    if (tex) {
      units.push({ kind: 'atomic', node, text: tex, start: offset, end: offset + tex.length })
      offset += tex.length
      return
    }
    const kids = node.childNodes || node.children || []
    for (const child of [...kids]) walk(child)
  }
  walk(root)
  return { units, fullText: units.map((u) => u.text).join('') }
}

function resolveOffsetInUnits(units, targetNode, targetOffset) {
  if (!targetNode) return null
  if (targetNode.nodeType === 3) {
    const u = units.find((item) => item.node === targetNode)
    if (u) return u.start + Math.max(0, Math.min(targetOffset || 0, u.text.length))
  }
  if (targetNode.nodeType === 1) {
    const texOwner = targetNode.closest ? targetNode.closest('[data-tex]') : null
    const owner = texOwner || targetNode
    const atomic = units.find((item) => item.node === owner)
    if (atomic) return atomic.start + (targetOffset > 0 ? atomic.text.length : 0)
    const kids = targetNode.childNodes || targetNode.children || []
    if (targetOffset < kids.length) {
      const first = kids[targetOffset]
      const hit = units.find((u) => u.node === first || (first.contains && first.contains(u.node)))
      if (hit) return hit.start
    }
  }
  return null
}

function captureRichSelectionSnapshot(selection, fallbackText) {
  if (!state.current || !selection || selection.rangeCount === 0) return null
  const range = typeof selection.getRangeAt === 'function' ? selection.getRangeAt(0) : null
  const anchor = range?.startContainer || selection.anchorNode
  const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
  if (!el || !el.closest) return null
  const paraEl = el.closest('.para[data-key]')
  if (!paraEl) return null
  const paragraphKey = String(paraEl.getAttribute('data-key') || '').trim().toLowerCase()
  if (!paragraphKey) return null
  const inZh = Boolean(el.closest('.para-zh'))
  const target = inZh ? 'zh' : 'orig'
  const container = inZh ? paraEl.querySelector('.zh-text') || paraEl.querySelector('.para-zh') : paraEl.querySelector('.para-orig')
  if (!container) return null
  const { units, fullText } = collectTextUnits(container)
  if (!fullText) return null

  let startOffset = range ? resolveOffsetInUnits(units, range.startContainer, range.startOffset) : null
  let endOffset = range ? resolveOffsetInUnits(units, range.endContainer, range.endOffset) : null
  const cleanQuote = String(fallbackText || '').trim()
  if (startOffset === null || endOffset === null || endOffset < startOffset) {
    const idx = cleanQuote ? fullText.indexOf(cleanQuote) : -1
    if (idx >= 0) {
      startOffset = idx
      endOffset = idx + cleanQuote.length
    } else {
      startOffset = 0
      endOffset = Math.min(fullText.length, cleanQuote.length || fullText.length)
    }
  }
  if (endOffset < startOffset) [startOffset, endOffset] = [endOffset, startOffset]
  const quote = fullText.slice(startOffset, endOffset) || cleanQuote
  const prefix = fullText.slice(Math.max(0, startOffset - 40), startOffset)
  const suffix = fullText.slice(endOffset, Math.min(fullText.length, endOffset + 40))
  const paraObj = state.doc?.paragraphs?.find((p) => 'para-' + p.id === paraEl.id)
  return {
    paragraphKey,
    target,
    startOffset,
    endOffset,
    quote,
    prefix,
    suffix,
    page: Number(paraEl.getAttribute('data-page') || paraObj?.page || state.page || 1),
    sectionId: paraEl.getAttribute('data-section') || paraObj?.section || state.sectionId || null,
    blockId: paraObj?.blockId || null,
  }
}

function resolveAnnotationSpan(ann, fullText) {
  let start = Math.max(0, Math.min(Number(ann.startOffset) || 0, fullText.length))
  let end = Math.max(start, Math.min(Number(ann.endOffset) || start, fullText.length))
  const quote = String(ann.quote || '')
  if (quote && fullText.slice(start, end) !== quote) {
    const composite = String(ann.prefix || '') + quote + String(ann.suffix || '')
    const compIdx = composite.length > quote.length ? fullText.indexOf(composite) : -1
    if (compIdx >= 0) {
      start = compIdx + String(ann.prefix || '').length
      end = start + quote.length
    } else {
      const idx = fullText.indexOf(quote)
      if (idx >= 0) {
        start = idx
        end = idx + quote.length
      }
    }
  }
  return { start, end }
}

function buildAnnotationWrapper(activeAnns, children) {
  const classes = ['ann-mark']
  let bgAnn = null
  for (const ann of activeAnns) {
    if (ann.kind === 'highlight') {
      bgAnn = ann
      classes.push('ann-hl-' + (ann.color || 'yellow'))
    } else if (ann.kind === 'underline') {
      classes.push('ann-underline')
    } else if (ann.kind === 'bold') {
      classes.push('ann-bold')
    } else if (ann.kind === 'comment') {
      classes.push('ann-has-comment')
    }
  }
  const primary = bgAnn || activeAnns[0]
  return h(
    'span',
    {
      class: classes.join(' '),
      'data-ann-id': primary.id,
      'data-ann-ids': activeAnns.map((a) => a.id).join(','),
      title: activeAnns.map((a) => (ANN_KIND_LABELS[a.kind] || a.kind) + (a.note ? ': ' + a.note : '')).join(' | '),
      onclick: (event) => {
        event.stopPropagation()
        const rect = event.currentTarget?.getBoundingClientRect ? event.currentTarget.getBoundingClientRect() : { left: 80, top: 120 }
        openAnnotationPopover(primary, rect)
      },
    },
    children,
  )
}

function applyParagraphAnnotations(container, anns) {
  if (!container || !Array.isArray(anns) || anns.length === 0) return
  const { units, fullText } = collectTextUnits(container)
  if (!fullText && anns.every((a) => a.kind !== 'insert')) return

  const resolved = anns.map((ann) => {
    const span = resolveAnnotationSpan(ann, fullText)
    return { ann, start: span.start, end: span.end }
  })

  const pointSet = new Set([0, fullText.length])
  const styled = []
  const insertsAt = new Map()
  const commentsAt = new Map()

  for (const item of resolved) {
    const { ann, start, end } = item
    if (ann.kind === 'insert') {
      const at = Math.max(0, Math.min(end, fullText.length))
      pointSet.add(at)
      const list = insertsAt.get(at) || []
      list.push(ann)
      insertsAt.set(at, list)
      continue
    }
    if (end > start) {
      pointSet.add(start)
      pointSet.add(end)
      styled.push(item)
    }
    if (ann.kind === 'comment') {
      const at = Math.max(0, Math.min(end, fullText.length))
      pointSet.add(at)
      const list = commentsAt.get(at) || []
      list.push(ann)
      commentsAt.set(at, list)
    }
  }

  for (const unit of units) {
    if (unit.kind === 'atomic') {
      const covering = styled.filter((s) => s.start < unit.end && s.end > unit.start).map((s) => s.ann)
      const afterComments = commentsAt.get(unit.end) || []
      const afterInserts = insertsAt.get(unit.end) || []
      if (covering.length > 0 && unit.node.parentElement) {
        const wrap = buildAnnotationWrapper(covering, [])
        unit.node.parentElement.insertBefore(wrap, unit.node)
        wrap.append(unit.node)
        for (const cAnn of afterComments) wrap.parentElement.insertBefore(renderAnnBubble(cAnn), wrap.nextSibling)
        for (const iAnn of afterInserts) wrap.parentElement.insertBefore(renderAnnInsertChip(iAnn), wrap.nextSibling)
      } else if (unit.node.parentElement && (afterComments.length > 0 || afterInserts.length > 0)) {
        for (const cAnn of afterComments) unit.node.parentElement.insertBefore(renderAnnBubble(cAnn), unit.node.nextSibling)
        for (const iAnn of afterInserts) unit.node.parentElement.insertBefore(renderAnnInsertChip(iAnn), unit.node.nextSibling)
      }
      continue
    }

    const parent = unit.node.parentElement
    if (!parent) continue
    const localCuts = [...pointSet].filter((pt) => pt >= unit.start && pt <= unit.end).sort((a, b) => a - b)
    const needsTouch =
      localCuts.length > 2 ||
      styled.some((s) => s.start < unit.end && s.end > unit.start) ||
      localCuts.some((pt) => pt > unit.start && (commentsAt.has(pt) || insertsAt.has(pt))) ||
      (unit.start === 0 && (commentsAt.has(0) || insertsAt.has(0)))
    if (!needsTouch) continue

    const nodesToInsert = []
    if (unit.start === 0) {
      for (const cAnn of commentsAt.get(0) || []) nodesToInsert.push(renderAnnBubble(cAnn))
      for (const iAnn of insertsAt.get(0) || []) nodesToInsert.push(renderAnnInsertChip(iAnn))
    }
    const pts = [unit.start, ...localCuts.filter((pt) => pt > unit.start && pt < unit.end), unit.end]
    for (let i = 0; i < pts.length - 1; i += 1) {
      const segStart = pts[i]
      const segEnd = pts[i + 1]
      const sliceText = unit.text.slice(segStart - unit.start, segEnd - unit.start)
      if (sliceText.length > 0) {
        const textNode = document.createTextNode(sliceText)
        const activeAnns = styled.filter((s) => s.start <= segStart && s.end >= segEnd).map((s) => s.ann)
        nodesToInsert.push(activeAnns.length > 0 ? buildAnnotationWrapper(activeAnns, textNode) : textNode)
      }
      if (segEnd > 0) {
        for (const cAnn of commentsAt.get(segEnd) || []) {
          nodesToInsert.push(renderAnnBubble(cAnn))
          commentsAt.delete(segEnd)
        }
        for (const iAnn of insertsAt.get(segEnd) || []) {
          nodesToInsert.push(renderAnnInsertChip(iAnn))
          insertsAt.delete(segEnd)
        }
      }
    }
    for (const replacement of nodesToInsert) parent.insertBefore(replacement, unit.node)
    if (typeof unit.node.remove === 'function') unit.node.remove()
  }
}

function renderAnnBubble(ann) {
  return h(
    'button',
    {
      type: 'button',
      class: 'ann-bubble',
      'data-ann-id': ann.id,
      title: ann.note ? '批注：' + ann.note : '点击编辑批注',
      onclick: (event) => {
        event.stopPropagation()
        const rect = event.currentTarget?.getBoundingClientRect ? event.currentTarget.getBoundingClientRect() : { left: 80, top: 120 }
        openAnnotationPopover(ann, rect)
      },
    },
    '💬',
  )
}

function renderAnnInsertChip(ann) {
  const preview = String(ann.note || '').trim().replace(/\s+/g, ' ').slice(0, 22)
  return h(
    'button',
    {
      type: 'button',
      class: 'ann-insert-chip',
      'data-ann-id': ann.id,
      title: ann.note ? '插入：' + ann.note : '点击编辑插入内容',
      onclick: (event) => {
        event.stopPropagation()
        const rect = event.currentTarget?.getBoundingClientRect ? event.currentTarget.getBoundingClientRect() : { left: 80, top: 120 }
        openAnnotationPopover(ann, rect)
      },
    },
    '‹+ ' + (preview || '插入笔记') + (String(ann.note || '').length > 22 ? '…' : '') + '›',
  )
}

function closeAnnotationPopover() {
  if (state.annPopover && state.annPopover.el) {
    state.annPopover.el.remove()
  }
  state.annPopover = null
}

function openAnnotationPopover(annOrDraft, rect = { left: 80, top: 120 }) {
  closeAnnotationPopover()
  const isNew = !annOrDraft.id
  const draft = { ...annOrDraft }
  const vw = Number(window.innerWidth) || 1200
  const vh = Number(window.innerHeight) || 800
  const left = Math.max(12, Math.min(Math.max(12, vw - 376), Number(rect.left) || 80))
  const top = Math.max(12, Math.min(Math.max(12, vh - 240), (Number(rect.top) || 100) + 28))

  let noteText = String(draft.note || '')
  let color = String(draft.color || (draft.kind === 'insert' ? 'purple' : 'yellow'))
  const kind = String(draft.kind || 'comment')
  const titleMap = { comment: isNew ? '添加批注' : '编辑批注', insert: isNew ? '插入批注' : '编辑插入内容', highlight: '高亮标注', underline: '下划线标注', bold: '加粗标注' }

  const textarea = h('textarea', {
    placeholder: kind === 'insert' ? '输入要插入并折叠展示的内容…' : '输入批注或笔记内容（留空也可只保留标记）…',
    value: noteText,
    oninput: (event) => {
      noteText = event.target.value
    },
  })

  const pop = h(
    'div',
    {
      class: 'ann-popover',
      style: { left: left + 'px', top: top + 'px' },
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => e.stopPropagation(),
    },
    h(
      'div',
      { class: 'ann-popover-head' },
      h('span', {}, titleMap[kind] || '标注'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'ghost', onclick: closeAnnotationPopover }, '✕'),
    ),
    draft.quote ? h('div', { class: 'ann-popover-quote' }, draft.quote.slice(0, 180)) : null,
    h(
      'div',
      { class: 'ann-popover-actions' },
      ['yellow', 'green', 'blue', 'pink', 'purple'].map((c) =>
        h('button', {
          type: 'button',
          class: 'floating-dot c-' + c + (color === c ? ' active' : ''),
          title: '颜色：' + c,
          onclick: () => {
            color = c
            toast('已选颜色：' + c)
          },
        }),
      ),
    ),
    textarea,
    h(
      'div',
      { class: 'ann-popover-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'primary',
          onclick: async () => {
            const payload = { ...draft, kind, color, note: noteText.trim() }
            closeAnnotationPopover()
            await saveRichAnnotation(payload)
          },
        },
        '保存',
      ),
      !isNew
        ? h(
            'button',
            {
              type: 'button',
              class: 'danger',
              onclick: async () => {
                closeAnnotationPopover()
                await deleteAnnotationById(draft.id)
              },
            },
            '删除',
          )
        : null,
      h('button', { type: 'button', class: 'ghost', onclick: closeAnnotationPopover }, '取消'),
    ),
  )

  document.body.append(pop)
  state.annPopover = { el: pop, id: draft.id || '', openedAt: Date.now() }
  setTimeout(() => textarea.focus && textarea.focus(), 10)
}

async function saveRichAnnotation(annotation) {
  if (!state.current) return
  try {
    const value = await rpc('annotations.save', { id: state.current.meta.id, annotation })
    if (Array.isArray(value && value.annotations)) state.annotations = value.annotations
    toast('已保存标注')
    render(true)
  } catch (error) {
    toast('保存标注失败：' + error.message)
  }
}

async function createRichAnnotation(kind, color = 'yellow', note = '', explicitSnapshot = null) {
  if (!state.current) return null
  const snap = explicitSnapshot || (state.selection && state.selection.rich) || captureRichSelectionSnapshot(window.getSelection(), pickedText())
  if (!snap) {
    toast('请先在对照正文里选中一段文字')
    return null
  }
  const annotation = {
    paragraphKey: snap.paragraphKey,
    target: snap.target || 'orig',
    kind,
    color: color || 'yellow',
    startOffset: snap.startOffset,
    endOffset: snap.endOffset,
    quote: snap.quote || '',
    prefix: snap.prefix || '',
    suffix: snap.suffix || '',
    note: String(note || ''),
    page: snap.page || state.page || 1,
    sectionId: snap.sectionId || null,
    blockId: snap.blockId || null,
  }
  await saveRichAnnotation(annotation)
  return annotation
}

async function deleteAnnotationById(annId) {
  if (!state.current || !annId) return
  try {
    const value = await rpc('annotations.delete', { id: state.current.meta.id, ids: [annId] })
    if (Array.isArray(value && value.annotations)) state.annotations = value.annotations
    toast('已删除标注')
    render(true)
  } catch (error) {
    toast('删除标注失败：' + error.message)
  }
}

async function clearParagraphAnnotations(paragraphKey, rangeFilter = null) {
  if (!state.current || !paragraphKey) return
  const anns = annotationsFor(paragraphKey)
  if (anns.length === 0) return
  let targetIds = anns.map((a) => a.id)
  if (rangeFilter && Number.isFinite(rangeFilter.startOffset) && Number.isFinite(rangeFilter.endOffset)) {
    const overlapped = anns.filter(
      (a) => (a.target || 'orig') === (rangeFilter.target || 'orig') && !(a.endOffset <= rangeFilter.startOffset || a.startOffset >= rangeFilter.endOffset),
    )
    if (overlapped.length > 0) targetIds = overlapped.map((a) => a.id)
  }
  try {
    const value = await rpc('annotations.delete', { id: state.current.meta.id, ids: targetIds })
    if (Array.isArray(value && value.annotations)) state.annotations = value.annotations
    toast('已清除该段 ' + targetIds.length + ' 条标注')
    render(true)
  } catch (error) {
    toast('清除标注失败：' + error.message)
  }
}

async function clearAllAnnotations() {
  if (!state.current) return
  if (!window.confirm('清空这篇论文的原文标注？AI 研读笔记与译文不会受到影响。')) return
  try {
    await rpc('annotations.clear', { id: state.current.meta.id })
    state.annotations = []
    toast('已清空原文标注')
    render(true)
  } catch (error) {
    toast('清空标注失败：' + error.message)
  }
}

function toggleParaCollapse(collapseId, part = 'all') {
  if (!collapseId) return
  if (part === 'all') {
    if (state.collapsed.all.has(collapseId)) {
      state.collapsed.all.delete(collapseId)
    } else {
      state.collapsed.all.add(collapseId)
      state.collapsed.orig.delete(collapseId)
      state.collapsed.zh.delete(collapseId)
    }
  } else if (part === 'orig' || part === 'zh') {
    state.collapsed.all.delete(collapseId)
    const set = state.collapsed[part]
    if (set.has(collapseId)) set.delete(collapseId)
    else set.add(collapseId)
  }
  render(true)
}

function renderParaCollapseBar(collapseId, part, label, previewText) {
  const snippet = String(previewText || '').replace(/\s+/g, ' ').trim().slice(0, 68)
  return h(
    'div',
    {
      class: 'para-collapse-bar',
      'data-collapse-part': part,
      role: 'button',
      tabindex: '0',
      title: '点击展开' + label,
      onclick: (e) => {
        e.stopPropagation()
        toggleParaCollapse(collapseId, part)
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          toggleParaCollapse(collapseId, part)
        }
      },
    },
    h('span', {}, '▸ ' + label + '已收起'),
    snippet ? h('span', { class: 'para-collapse-preview' }, snippet) : null,
  )
}

function renderParaTools(paragraph, key, textValue) {
  const hasAnns = key ? annotationsFor(key).length > 0 : false
  const collapseId = key || ('para-' + paragraph.id)
  const hasZh = Boolean(key && ((state.trans[key] && state.trans[key].zh) || state.streams.has(key)))
  const isAll = state.collapsed.all.has(collapseId)
  const isOrig = !isAll && state.collapsed.orig.has(collapseId)
  const isZh = !isAll && state.collapsed.zh.has(collapseId)
  return h(
    'div',
    {
      class: 'para-tools',
      onmousedown: (e) => e.stopPropagation(),
      ondblclick: (e) => e.stopPropagation(),
    },
    key
      ? h(
          'button',
          {
            type: 'button',
            class: 'para-tool-btn',
            title: '翻译或重译这一整段',
            onclick: (e) => {
              e.stopPropagation()
              retryKey(key)
            },
          },
          '译本段',
        )
      : null,
    h(
      'button',
      {
        type: 'button',
        class: 'para-tool-btn',
        title: '让右侧 Agent 自适应讲解这一段（自动识别公式/伪代码/实验/概念）',
        onclick: (e) => {
          e.stopPropagation()
          askSelection(textValue, {
            blockId: paragraph.blockId || null,
            page: paragraph.page || state.page,
            sectionId: paragraph.section || state.sectionId || null,
            revision: state.doc?.revision || null,
          })
        },
      },
      '讲解本段',
    ),
    paragraph.kind !== 'formula'
      ? h(
          'button',
          {
            type: 'button',
            class: 'para-tool-btn',
            title: isOrig ? '展开英文原文' : '收起英文原文，节省阅读空间',
            onclick: (e) => {
              e.stopPropagation()
              toggleParaCollapse(collapseId, 'orig')
            },
          },
          isOrig ? '展开原文' : '收起原文',
        )
      : null,
    hasZh
      ? h(
          'button',
          {
            type: 'button',
            class: 'para-tool-btn',
            title: isZh ? '展开中文译文' : '收起中文译文，节省阅读空间',
            onclick: (e) => {
              e.stopPropagation()
              toggleParaCollapse(collapseId, 'zh')
            },
          },
          isZh ? '展开译文' : '收起译文',
        )
      : null,
    h(
      'button',
      {
        type: 'button',
        class: 'para-tool-btn',
        title: isAll ? '展开整段' : '将整段折叠为单行摘要条',
        onclick: (e) => {
          e.stopPropagation()
          toggleParaCollapse(collapseId, 'all')
        },
      },
      isAll ? '展开' : '折叠',
    ),
    hasAnns
      ? h(
          'button',
          {
            type: 'button',
            class: 'para-tool-btn',
            title: '清除本段所有高亮与批注',
            onclick: (e) => {
              e.stopPropagation()
              clearParagraphAnnotations(key)
            },
          },
          '清除标注',
        )
      : null,
    paragraph.page
      ? h(
          'button',
          {
            type: 'button',
            class: 'para-tool-btn para-tool-page',
            title: '跳转到原文第 ' + paragraph.page + ' 页',
            onclick: (e) => {
              e.stopPropagation()
              jumpToPage(paragraph.page)
            },
          },
          'p.' + paragraph.page,
        )
      : null,
  )
}

const ALGO_LEAD_KW_RE = /^((?:Hyperparam|Inputs?|Outputs?|Require|Ensure):)\s*/i
const ALGO_CTRL_KW_RE = /\b(?:for|while|repeat|until|if|then|else|elif|end\s+for|end\s+if|end\s+while|do|return|def|function|procedure|in|to)\b/g

function appendAlgoPlainTokens(box, segment, isStart) {
  let rest = String(segment || '')
  if (!rest) return
  if (isStart) {
    const lead = ALGO_LEAD_KW_RE.exec(rest)
    if (lead) {
      box.append(h('span', { class: 'algo-kw' }, lead[1]), document.createTextNode(rest.slice(lead[1].length) ? ' ' : ''))
      rest = rest.slice(lead[0].length)
    }
  }
  if (!rest) return
  ALGO_CTRL_KW_RE.lastIndex = 0
  let last = 0
  let match = null
  while ((match = ALGO_CTRL_KW_RE.exec(rest)) !== null) {
    if (match.index > last) box.append(document.createTextNode(rest.slice(last, match.index)))
    box.append(h('span', { class: 'algo-kw' }, match[0]))
    last = match.index + match[0].length
  }
  if (last === 0) box.append(document.createTextNode(rest))
  else if (last < rest.length) box.append(document.createTextNode(rest.slice(last)))
}

function appendAlgoCodeContent(box, lineText) {
  const commentMatch = /(^|\s)(\/\/.*)$/.exec(lineText)
  const codePart = commentMatch ? lineText.slice(0, commentMatch.index + commentMatch[1].length) : lineText
  const commentPart = commentMatch ? commentMatch[2] : ''
  const mathPattern = /\$(?!\s)([^$\n]{1,240}?)(?<!\s)\$/g
  let last = 0
  let match = null
  let isStart = true
  while ((match = mathPattern.exec(codePart)) !== null) {
    if (/^\d+(?:[.,]\d+)?(?:\s|\)|,|\b\s+(?:and|or|to|vs\.?)\b)/i.test(match[1])) continue
    if (match.index > last) {
      appendAlgoPlainTokens(box, codePart.slice(last, match.index), isStart)
      isStart = false
    }
    appendInlineMath(box, match[0])
    isStart = false
    last = match.index + match[0].length
  }
  if (last < codePart.length) appendAlgoPlainTokens(box, codePart.slice(last), isStart)
  if (commentPart) box.append(h('span', { class: 'algo-comment' }, commentPart))
}

function renderAlgorithmOrig(textValue) {
  const lines = String(textValue || '').split(/\r?\n/)
  const box = h('div', { class: 'para-orig algo-box' })
  let startIdx = 0
  if (lines.length >= 2 && /^Algorithm\s+\d+(?:[:.\s]|$)/i.test(lines[0].trim())) {
    const head = h('div', { class: 'algo-head' })
    appendInlineMath(head, lines[0].trim())
    box.append(head)
    startIdx = 1
  }
  let lineNo = 1
  for (let idx = startIdx; idx < lines.length; idx += 1) {
    const rawLine = lines[idx]
    if (!rawLine.trim()) continue
    const m = /^(\s*)(.*)$/.exec(rawLine)
    const leadCols = m ? m[1].length : 0
    const content = m ? m[2] : rawLine
    const indentSteps = Math.min(10, leadCols / 2)
    const codeSpan = h('span', {
      class: 'algo-code',
      ...(indentSteps > 0 ? { style: { paddingLeft: (indentSteps * 1.15).toFixed(2) + 'em' } } : {}),
    })
    appendAlgoCodeContent(codeSpan, content)
    box.append(
      h(
        'div',
        { class: 'algo-line' },
        h('span', { class: 'algo-ln' }, String(lineNo)),
        codeSpan,
      ),
    )
    lineNo += 1
  }
  return box
}

function renderFormula(tex) {
  const box = h('div', { class: 'para-latex', 'data-tex': '$$' + tex + '$$' })
  const katex = typeof window !== 'undefined' ? window.katex : null
  if (tex === '') return box
  if (katex && typeof katex.render === 'function') {
    try {
      katex.render(tex, box, {
        displayMode: true,
        throwOnError: false,
        strict: false,
        trust: false,
        output: 'html',
      })
      return box
    } catch {
      /* 落回源码 */
    }
  }
  box.classList.add('plain')
  box.textContent = tex
  return box
}

function renderParagraph(paragraph) {
  const kind = paragraph.kind || 'body'
  const id = 'para-' + paragraph.id
  if (kind === 'figure' || kind === 'table') return renderFigureParagraph(paragraph)
  if (kind === 'heading') {
    const level = Math.min(4, Math.max(2, (paragraph.level || 2) + 1))
    return h('h' + level, { class: 'para kind-heading level-' + level, id }, paragraph.text)
  }
  const key = paragraphKey(paragraph)
  const entry = key ? state.trans[key] : null
  const textValue = String(kind === 'formula' ? (paragraph.latex || paragraph.text || '') : (paragraph.text || ''))
  let origNode = null
  if (kind === 'algorithm') {
    origNode = renderAlgorithmOrig(textValue)
  } else if (kind === 'caption') {
    origNode = renderCaptionOrig(textValue)
  } else if ((kind === 'body' || kind === 'list' || kind === 'footnote') && textValue.includes('$')) {
    origNode = renderInlineMath(textValue)
  } else {
    origNode = h('div', { class: 'para-orig' }, textValue)
  }
  if (kind === 'footnote' && origNode) {
    origNode.prepend(h('span', { class: 'footnote-tag' }, '注'))
  }
  const origAnns = annotationsFor(key, 'orig')
  if (origNode && origAnns.length > 0) applyParagraphAnnotations(origNode, origAnns)
  const collapseId = key || id
  const isAllCollapsed = state.collapsed.all.has(collapseId)
  const isOrigCollapsed = !isAllCollapsed && state.collapsed.orig.has(collapseId)
  const isZhCollapsed = !isAllCollapsed && state.collapsed.zh.has(collapseId)
  const collapseClasses = [
    isAllCollapsed ? 'collapsed-all' : '',
    isOrigCollapsed ? 'collapsed-orig' : '',
    isZhCollapsed ? 'collapsed-zh' : '',
  ].filter(Boolean).join(' ')
  const para = h(
    'div',
    {
      class: 'para kind-' + kind + (entry ? ' has-zh' : '') + (collapseClasses ? ' ' + collapseClasses : ''),
      id,
      'data-key': key,
      'data-section': paragraph.section || '',
      'data-page': paragraph.page || 1,
      ondblclick: () => {
        hideFloating()
        const selected = liveReaderSelection()
        const singleWord = selected && !/\s/.test(selected.trim()) && selected.trim().length < 36 && textValue.length > selected.trim().length
        if (selected && !singleWord) {
          askSelection(selected)
        } else {
          askSelection(textValue, {
            blockId: paragraph.blockId || null,
            page: paragraph.page || state.page,
            sectionId: paragraph.section || state.sectionId || null,
            revision: state.doc?.revision || null,
          })
        }
      },
    },
    isAllCollapsed ? renderParaCollapseBar(collapseId, 'all', '本段', textValue) : null,
    isOrigCollapsed ? renderParaCollapseBar(collapseId, 'orig', '原文', textValue) : null,
    origNode,
  )
  if (kind === 'formula') {
    para.classList.add('kind-formula')
    const tex = textValue.trim()
    const eqNo = typeof paragraph.equationNumber === 'string' ? paragraph.equationNumber.trim() : ''
    para.replaceChildren(
      isAllCollapsed
        ? renderParaCollapseBar(collapseId, 'all', '公式', tex)
        : h(
            'div',
            { class: 'formula-row' },
            h('span', { class: 'formula-spacer', 'aria-hidden': 'true' }),
            h('div', { class: 'formula-main' }, renderFormula(tex)),
            h(
              'div',
              { class: 'formula-meta' },
              eqNo ? h('span', { class: 'formula-eqno' }, eqNo) : null,
              h(
                'button',
                {
                  type: 'button',
                  class: 'link formula-link',
                  title: '跳转到原文第 ' + (paragraph.page || 1) + ' 页',
                  onclick: () => jumpToPage(paragraph.page || 1),
                },
                'p.' + (paragraph.page || '?'),
              ),
            ),
          ),
      renderParaTools(paragraph, '', textValue),
    )
    return para
  }
  if (key) {
    if (isZhCollapsed && ((entry && entry.zh) || state.streams.has(key))) {
      para.append(renderParaCollapseBar(collapseId, 'zh', '译文', entry && entry.zh))
    }
    const zhWrap = h('div', { class: 'para-zh', 'data-zh': key }, ...zhContent(key, entry && entry.zh, state.streams.get(key)))
    const zhAnns = entry && entry.zh ? annotationsFor(key, 'zh') : []
    if (zhAnns.length > 0) {
      const box = zhWrap.querySelector ? zhWrap.querySelector('.zh-text') : null
      if (box) applyParagraphAnnotations(box, zhAnns)
    }
    para.append(zhWrap)
  }
  para.append(renderParaTools(paragraph, key, textValue))
  const figures = key && state.figuresByKey ? state.figuresByKey[key] : null
  // 图挂在自己的图注段落上时，段落正文就是图注，图里不必再重复一遍
  const ownCaption = kind === 'caption'
  if (Array.isArray(figures)) for (const figure of figures) para.append(renderInlineFigure(figure, ownCaption))
  return para
}

function jumpToPage(page) {
  // 引用 [p.N]、目录跳转、搜索命中都走这里：切到原文页并滚到那一页
  const total = (state.current && state.current.meta && state.current.meta.pageCount) || 0
  const target = Math.max(1, Math.min(Number(page) || 1, total || Number(page) || 1))
  state.tab = 'page'
  state.page = target
  state.pendingPage = target
  loadPage(target).then(() => render(true))
}

function renderDocMissing() {
  // 打开论文 / 重建时后端要抽 PDF 文本层（几十页要几秒），别在这期间说「没有文档模型」
  const working = state.docBusy || state.busy === 'open'
  return h(
    'div',
    { class: 'empty doc-missing' },
    h('h2', {}, working ? '正在解析文档模型…' : '还没有可对照的文档模型'),
    h('p', {}, working ? '首次打开会从 PDF 文本层抽出段落，之后有缓存。' : state.docError ? '原因：' + state.docError : '后端没有返回 doc（sections / paragraphs）。'),
    h('p', { class: 'hint' }, '对照阅读需要 doc.json（每篇论文的节与段落结构）。旧版宿主只提供页图与文本块，所以这里先给你原文页。'),
    h(
      'div',
      { class: 'empty-actions' },
      h('button', { class: 'primary', disabled: state.docBusy, onclick: rebuildDoc }, state.docBusy ? '正在重建…' : '重建文档模型'),
      h('button', { onclick: () => { state.tab = 'page'; render() } }, '先看原文页'),
    ),
  )
}

function renderCompareToolbar() {
  const docReady = !!(state.doc && Array.isArray(state.doc.paragraphs) && state.doc.paragraphs.length > 0)
  const status = state.translateError || progressText()
  // 重试入口不能只看 job.failed：整篇在开流前就失败时 failed 是空的，但段落停在 error 状态
  const retryable = failedSegmentKeys()
  const mode = currentReadMode()
  const modeBtn = (key, label, title, id) =>
    h(
      'button',
      {
        ...(id ? { id } : {}),
        class: 'seg-btn' + (mode === key ? ' active' : ''),
        role: 'radio',
        'aria-checked': mode === key ? 'true' : 'false',
        title,
        onclick: () => setReadMode(key),
      },
      label,
    )
  const moreDirty = Boolean(
    state.layoutBusy ||
      state.layoutResumable ||
      state.reviewBusy ||
      state.logs.open ||
      (state.layoutApplied && state.layoutSchemaVersion >= 2 && state.layoutQuality !== 'passed'),
  )
  const running = Boolean(state.translateBusy || (state.translateJob && state.translateJob.status === 'running'))
  const paused = Boolean(!running && state.translateJob && state.translateJob.status === 'paused')
  const countSuffix =
    state.translateJob && Number(state.translateJob.total) > 0
      ? ' (' + Math.min(Number(state.translateJob.completed) || 0, Number(state.translateJob.total)) + '/' + state.translateJob.total + ')'
      : ''
  return h(
    'div',
    { class: 'toolbar compare-toolbar' },
    h(
      'div',
      { class: 'toolbar-group trans-group', role: 'group', 'aria-label': '全文与章节翻译' },
      h('button', { id: 'translate-section', disabled: !docReady || running, title: '翻译当前阅读章节的全部未译段落（存入存储后端，不进对话历史）', onclick: () => translateSection(state.sectionId || (sectionsOf()[0] && sectionsOf()[0].id)) }, '译本节'),
      h('button', { id: 'translate-all', class: 'primary-soft', disabled: !docReady || running, onclick: confirmTranslateAll }, '整篇翻译'),
      h('button', { id: 'translate-stop', class: 'btn-pause-trans', hidden: !running, disabled: !running, title: '显式暂停当前后台翻译（切走界面不会中断翻译）', onclick: pauseTranslate }, '⏸ 暂停翻译' + countSuffix),
      h('button', { id: 'translate-resume', class: 'btn-resume-trans', hidden: !paused, disabled: !docReady || running, title: '从上次暂停断点继续翻译剩余未译段落', onclick: resumeTranslate }, '▶ 继续翻译' + countSuffix),
      h('button', { id: 'retry-failed', hidden: retryable.length === 0, title: '重新请求这些翻译失败的段落', onclick: retryFailedSegments }, '重试失败 ' + retryable.length),
      status ? h('span', { class: 'translate-status' + (status === state.translateError ? ' error' : ''), id: 'translate-status' }, status) : h('span', { class: 'translate-status', id: 'translate-status' }, ''),
    ),
    h(
      'div',
      { class: 'seg-group', role: 'radiogroup', 'aria-label': '阅读排版模式' },
      modeBtn('bilingual', '双语', '上英下中学术对照'),
      modeBtn('side', '并排', '宽屏左右双栏对照'),
      modeBtn('orig', '原文', '暂时隐藏译文，专注英文原文'),
      modeBtn('zh', '只看译文', '隐藏英文原文，只看中文译文', 'only-zh-toggle'),
    ),
    NATIVE_READER ? nativeQuickGroup() : null,
    NATIVE_READER
      ? h('span', { id: 'native-reader-status', class: 'hint native-inline-status', role: 'status', 'aria-live': 'polite' }, nativeReaderStatus())
      : null,
    h('span', { class: 'spacer' }),
    h(
      'details',
      { class: 'more-tools' + (moreDirty ? ' has-badge' : '') },
      h('summary', { title: '目录翻译、译文自检、版面重排与任务日志' }, state.layoutBusy ? '解析中…' : '工具 ▾'),
      h(
        'div',
        { class: 'more-tools-menu' },
        h('button', { id: 'translate-titles', disabled: !docReady || state.translateBusy, title: '批量翻译节标题，目录显示英文/中文两行', onclick: translateTitles }, '目录翻译'),
        h('button', { id: 'review-run', disabled: !docReady || !hostReady() || state.reviewBusy, title: hostReady() ? '检查空译文、截断、残留英文、公式残留等可疑段落' : '重启桌面端后可用', onclick: () => runReview('static') }, state.reviewBusy ? '自检中…' : '译文自检'),
        h('button', {
          id: 'layout-run',
          class: 'ghost' + (state.layoutResumable && !state.layoutBusy ? ' dirty' : ''),
          disabled: !docReady || !hostReady(),
          title: hostReady()
            ? '用 PaddleOCR 的 PP-StructureV3 版面模型切段：会上传 PDF、按页计费；结果存 layout.json，下次不用重跑'
            : '重启桌面端后可用',
          onclick: state.layoutBusy ? cancelLayoutParse : runLayoutParse,
        }, state.layoutBusy
          ? '解析中… ' + ((state.layoutJob && state.layoutJob.pages) || 0) + '/' + ((state.layoutJob && state.layoutJob.totalPages) || '?')
          : state.layoutResumable ? '续跑版面 ' + state.layoutSavedPages + ' 页' : '版面解析'),
        state.layoutApplied
          ? h('button', {
            id: 'layout-refill',
            class: 'ghost',
            disabled: !docReady || !hostReady() || state.layoutBusy,
            title: '用 PDF 文本层重新回填文字（比如摘要段被服务端 OCR 认错时用），不上传、不花配额',
            onclick: refillLayoutText,
          }, '重填文字')
          : null,
        state.layoutApplied && state.layoutSchemaVersion >= 2
          ? h('button', {
            id: 'layout-quality',
            class: 'ghost' + (state.layoutQuality === 'passed' ? '' : ' dirty'),
            disabled: !hostReady(),
            title: '查看版面质量报告：哪些页需要看原页',
            onclick: openLayoutReport,
          }, state.layoutQuality === 'passed' ? '版面质量 ✓' : '版面质量 ' + state.layoutBadPages)
          : null,
        h('button', { id: 'logs-toggle', class: 'ghost' + (state.logs.open ? ' active' : ''), disabled: !hostReady(), title: hostReady() ? '任务日志（翻译 / OCR / 自检）' : '重启桌面端后可用', onclick: toggleLogs }, state.logs.open ? '收起日志' : '任务日志'),
      ),
    ),
  )
}

// ---------------------------------------------------------------- 原文页（页图 / 缩放 / 高亮）

// ---------------------------------------------------------------- 原文：上下滚动连续阅读
const PAGE_DEFAULT_RATIO = '0.7727' // Letter 8.5×11；A4 是 0.7071，只影响首屏占位高度

function pageRatio(page) {
  const dims = state.pageDims && state.pageDims[page]
  if (dims && dims.w > 0 && dims.h > 0) return dims.w + ' / ' + dims.h
  if (state.pageInfo && state.pageInfo.w > 0 && state.pageInfo.h > 0) return state.pageInfo.w + ' / ' + state.pageInfo.h
  return PAGE_DEFAULT_RATIO
}

/** 中文版：只替换有译文的段落，其余保留原文（所以是「部分中文」的页面）。 */
async function toggleZhPdf() {
  const meta = state.current && state.current.meta
  if (!meta) return
  if (state.zhBusy) return
  if (state.zhMode) {
    state.zhMode = false
    render()
    return
  }
  if (!hostReady()) {
    needRestart()
    return
  }
  const id = meta.id
  const stillHere = () => Boolean(state.current && state.current.meta.id === id)
  state.zhBusy = true
  try {
    let status = state.zhStatus
    if (!status) status = await rpc('zhpdf.status', { id })
    if (!stillHere()) return
    if (!status.exists) {
      const ok = window.confirm('生成中文版 PDF：把已翻译的段落写回原来的版面，和原文逐页对齐。\n纯本地处理，不上传、不花钱；没翻译的段落保留原文。继续？')
      if (!ok) return
      const result = await rpc('zhpdf.build', { id })
      if (!stillHere()) return
      toast('中文版已生成：' + result.blocks + ' 段，' + (result.skipped ? result.skipped + ' 段没对上原文（保留英文）' : '全部替换'))
      status = await rpc('zhpdf.status', { id })
      if (!stillHere()) return
    } else if (status.stale) {
      const again = window.confirm('有新的译文，中文版还是上次的。要重新生成吗？（纯本地，很快）')
      if (again) {
        const result = await rpc('zhpdf.build', { id })
        if (!stillHere()) return
        toast('中文版已更新：' + result.blocks + ' 段')
        status = await rpc('zhpdf.status', { id })
        if (!stillHere()) return
      }
    }
    state.zhStatus = status
    state.zhMode = true
    render()
  } catch (error) {
    toast(error.message)
  } finally {
    // 切走了就别动新论文的 busy 标记
    if (stillHere()) state.zhBusy = false
  }
}

function pageImageSrc(meta, page) {
  const scale = Math.max(1, Math.round(state.fitScale * state.zoom * 10) / 10)
  const zh = state.zhMode ? '&source=zh' : ''
  return API + 'page?id=' + encodeURIComponent(meta.id) + '&page=' + page + '&scale=' + scale + zh
}

function populatePdfTextLayer(layerEl, pageData) {
  if (!layerEl || !pageData || !Array.isArray(pageData.lines)) return
  const wPt = Math.max(1, Number(pageData.width) || 612)
  const hPt = Math.max(1, Number(pageData.height) || 792)
  const spans = []
  for (const line of pageData.lines) {
    if (!line) continue
    const txt = String(line.text || '')
    if (!txt.trim()) continue
    let x0
    let y0
    let x1
    let y1
    if (Array.isArray(line.bbox) && line.bbox.length >= 4) {
      ;[x0, y0, x1, y1] = line.bbox.map(Number)
    } else if (line.x !== undefined && line.y !== undefined && line.x2 !== undefined && line.y2 !== undefined) {
      x0 = Number(line.x)
      y0 = Number(line.y)
      x1 = Number(line.x2)
      y1 = Number(line.y2)
    } else {
      continue
    }
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue
    const left = Math.max(0, Math.min(99.5, (x0 / wPt) * 100)).toFixed(3) + '%'
    const top = Math.max(0, Math.min(99.5, (y0 / hPt) * 100)).toFixed(3) + '%'
    const width = Math.max(0.2, Math.min(100, ((x1 - x0) / wPt) * 100)).toFixed(3) + '%'
    const height = Math.max(0.5, Math.min(25, ((y1 - y0) / hPt) * 100)).toFixed(3) + '%'
    const fontSize = Math.max(0.55, Math.min(8, ((Number(line.size) || 10) / wPt) * 100)).toFixed(3) + 'cqw'
    spans.push(
      h(
        'span',
        {
          class: 'pdf-line',
          style: { left, top, width, height, fontSize },
        },
        txt + ' ',
      ),
    )
  }
  layerEl.replaceChildren(...spans)
  layerEl.setAttribute('data-loaded', '1')
}

async function ensurePageTextLayer(paperId, page, wrap) {
  if (!paperId || !page || !wrap) return
  if (state.zhMode) return
  const meta = state.current && state.current.meta
  if (!meta || meta.id !== paperId || meta.hasText === false) return
  const layerEl = wrap.querySelector ? wrap.querySelector('.pdf-text-layer') : null
  if (!layerEl || layerEl.getAttribute('data-loaded') === '1') return
  if (state.pageLinesByPage[page]) {
    populatePdfTextLayer(layerEl, state.pageLinesByPage[page])
    return
  }
  const lockKey = paperId + ':' + page
  if (state.pageLinesPending.has(lockKey)) return
  state.pageLinesPending.add(lockKey)
  const seq = state.openSeq
  try {
    const res = await rpc('pdf.pageLines', { id: paperId, page })
    if (seq !== state.openSeq || !state.current || state.current.meta.id !== paperId) return
    state.pageLinesByPage[page] = res
    if (res && res.width > 0 && res.height > 0) {
      state.pageDims[page] = { w: res.width, h: res.height }
    }
    const liveWrap = document.querySelector('.page-wrap[data-page="' + page + '"]') || wrap
    const liveLayer = liveWrap && liveWrap.querySelector ? liveWrap.querySelector('.pdf-text-layer') : null
    if (liveLayer) populatePdfTextLayer(liveLayer, res)
  } catch {
    /* 取不到行坐标时静默退回纯页图展示 */
  } finally {
    state.pageLinesPending.delete(lockKey)
  }
}

function renderCropOverlay(meta, page, wrap) {
  const overlay = h('div', { class: 'crop-overlay', title: '按住左键拖动框选任意区域，松手即截图发往右侧会话讲解' })
  let drag = null
  let boxEl = null

  const toNorm = (clientX, clientY) => {
    const r = wrap.getBoundingClientRect()
    const w = Math.max(1, r.width || 1)
    const hgt = Math.max(1, r.height || 1)
    return {
      x: Math.max(0, Math.min(1, (clientX - r.left) / w)),
      y: Math.max(0, Math.min(1, (clientY - r.top) / hgt)),
    }
  }

  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    try {
      overlay.setPointerCapture && overlay.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    const pt = toNorm(e.clientX, e.clientY)
    drag = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y }
    if (boxEl) boxEl.remove()
    boxEl = h('div', { class: 'crop-box', style: { left: (pt.x * 100) + '%', top: (pt.y * 100) + '%', width: '0%', height: '0%' } })
    overlay.append(boxEl)
  })

  overlay.addEventListener('pointermove', (e) => {
    if (!drag || !boxEl) return
    const pt = toNorm(e.clientX, e.clientY)
    drag.x1 = pt.x
    drag.y1 = pt.y
    const xMin = Math.min(drag.x0, drag.x1)
    const yMin = Math.min(drag.y0, drag.y1)
    const w = Math.abs(drag.x1 - drag.x0)
    const hgt = Math.abs(drag.y1 - drag.y0)
    boxEl.style.left = (xMin * 100).toFixed(2) + '%'
    boxEl.style.top = (yMin * 100).toFixed(2) + '%'
    boxEl.style.width = (w * 100).toFixed(2) + '%'
    boxEl.style.height = (hgt * 100).toFixed(2) + '%'
  })

  const finishCrop = async (e) => {
    if (!drag) return
    if (e && e.clientX !== undefined && e.clientY !== undefined) {
      const pt = toNorm(e.clientX, e.clientY)
      drag.x1 = pt.x
      drag.y1 = pt.y
    }
    const rect = {
      x0: Math.min(drag.x0, drag.x1),
      y0: Math.min(drag.y0, drag.y1),
      x1: Math.max(drag.x0, drag.x1),
      y1: Math.max(drag.y0, drag.y1),
    }
    drag = null
    if (boxEl) {
      boxEl.remove()
      boxEl = null
    }
    if (rect.x1 - rect.x0 < 0.015 || rect.y1 - rect.y0 < 0.015) return
    state.cropMode = false
    render(true)
    toast('正在截取选中区域并发送到会话…')
    try {
      const res = await rpc('pdf.cropRegion', { id: meta.id, page, rect })
      const cleanTxt = String((res && res.text) || '').trim()
      const promptLines = [
        '请结合附带的论文第 ' + page + ' 页局部截图，深入讲解该框选区域的内容（若是架构图/实验表请拆解模块数据流与关键指标结论；若是公式/伪代码请逐项解释符号与核心直觉，并标注 [p.' + page + '] 引用）：',
      ]
      if (cleanTxt) {
        promptLines.push('> 框选区提取文本：\n> ' + cleanTxt.replace(/\n+/g, '\n> '))
      }
      if (NATIVE_READER) {
        askNative(promptLines.join('\n\n'), {
          scope: 'selection',
          selection: cleanTxt || ('[第 ' + page + ' 页框选截图]'),
          explicitSource: { page, sectionId: state.sectionId || null, blockId: null, revision: state.doc?.revision || null },
          attachment: res && res.imageBase64
            ? { name: res.fileName || (meta.id + '-p' + page + '-crop.png'), mime: res.mime || 'image/png', dataBase64: res.imageBase64 }
            : undefined,
        })
      } else {
        sendChat(promptLines.join('\n\n'), chatContext({ page, scope: 'selection', selection: cleanTxt || ('[p.' + page + ' 框选区域]') }))
      }
    } catch (error) {
      toast('框选截图失败：' + error.message)
    }
  }

  overlay.addEventListener('pointerup', finishCrop)
  overlay.addEventListener('pointercancel', () => {
    drag = null
    if (boxEl) {
      boxEl.remove()
      boxEl = null
    }
  })
  return overlay
}

function renderPageBlock(meta, page) {
  const wrap = h('div', { class: 'page-wrap' + (state.cropMode ? ' crop-mode' : ''), 'data-page': String(page) })
  const image = h('img', { 'data-src': pageImageSrc(meta, page), alt: 'p.' + page, draggable: false })
  image.style.aspectRatio = pageRatio(page)
  image.addEventListener('load', () => {
    image.style.aspectRatio = ''
    wrap.classList.add('loaded')
  })
  image.addEventListener('error', () => {
    image.remove()
    wrap.append(
      h('div', { class: 'page-missing' }, '第 ' + page + ' 页渲染失败。若 PDF 未复制进库且原路径已移动，请重新导入；也可能是本机 Python/PyMuPDF 不可用（看左下角 PDF 状态）。'),
    )
  })
  const layer = h('div', { class: 'hl-layer' })
  const highlights = ((state.current && state.current.notes && state.current.notes.highlights) || []).filter(
    (item) => Number(item.page) === page,
  )
  for (const highlight of highlights) {
    const colorCls = highlight.color && highlight.color !== 'note' ? ' c-' + highlight.color : highlight.color === 'note' ? ' note' : ''
    for (const rect of highlight.rects || []) {
      layer.append(
        h('div', {
          class: 'hl' + colorCls,
          style: { left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.w * 100 + '%', height: rect.h * 100 + '%' },
          title: highlight.text,
        }),
      )
    }
  }
  const textLayer = h('div', { class: 'pdf-text-layer', 'data-text-page': String(page) })
  if (!state.zhMode && meta.hasText !== false && state.pageLinesByPage[page]) {
    populatePdfTextLayer(textLayer, state.pageLinesByPage[page])
  }
  wrap.append(image, layer, textLayer)
  if (state.cropMode) wrap.append(renderCropOverlay(meta, page, wrap))
  wrap.append(h('span', { class: 'page-no' }, String(page)))
  return wrap
}

/** 只给视口附近的页发图片与透明文本层请求；同时用「中间那条线」判断当前在读第几页。 */
function setupPageScroll(stage) {
  if (!stage) return
  if (state.pageObserver) state.pageObserver.disconnect()
  if (state.pageSpy) state.pageSpy.disconnect()
  if (typeof IntersectionObserver !== 'function') return
  const meta = state.current && state.current.meta
  const loader = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const img = entry.target.querySelector('img[data-src]')
        if (img) {
          img.src = img.getAttribute('data-src')
          img.removeAttribute('data-src')
        }
        const pNum = Number(entry.target.getAttribute('data-page'))
        if (meta && pNum > 0 && meta.hasText !== false && !state.zhMode) {
          ensurePageTextLayer(meta.id, pNum, entry.target)
        }
      }
    },
    { root: stage, rootMargin: '900px 0px' },
  )
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const page = Number(entry.target.getAttribute('data-page'))
        if (!page || page === state.page) continue
        state.page = page
        const input = document.querySelector('.pager input')
        if (input) input.value = String(page)
        const label = document.querySelector('.statusbar .cur-page')
        if (label) label.textContent = '第 ' + page + ' 页'
        state.native.blockId = ''
        notifyReaderState()
        saveSessionSoon({ page })
      }
    },
    { root: stage, rootMargin: '-45% 0px -45% 0px' },
  )
  for (const wrap of stage.querySelectorAll('.page-wrap')) {
    loader.observe(wrap)
    spy.observe(wrap)
  }
  state.pageObserver = loader
  state.pageSpy = spy
  stage.addEventListener(
    'scroll',
    () => {
      state.pageScrollTop = stage.scrollTop
      saveSessionSoon()
    },
    { passive: true },
  )
}

function renderPagePane() {
  const meta = state.current.meta
  const total = meta.pageCount || 0
  const stage = h('div', { class: 'stage page-scroll' })
  // 连续滚动：所有页一次排好（占位用页面比例），只给视口附近的页真正发图片请求，
  // 否则 70 页论文一打开就会一次拉 20MB 图。
  const totalPages = total > 0 ? total : 1
  for (let page = 1; page <= totalPages; page += 1) stage.append(renderPageBlock(meta, page))

  return h(
    'div',
    { class: 'page-pane' },
    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'pager' },
        h('button', { onclick: () => jumpToPage(state.page - 1), disabled: state.page <= 1, title: '上一页' }, '‹'),
        h('input', {
          type: 'text',
          value: state.page,
          title: '输入页码跳到该页',
          onchange: (event) => jumpToPage(Number(event.target.value) || 1),
        }),
        h('span', { class: 'muted' }, '/ ' + (total || '?')),
        h('button', { onclick: () => jumpToPage(state.page + 1), disabled: total > 0 && state.page >= total, title: '下一页' }, '›'),
      ),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => setZoom(state.zoom - 0.15) }, '－'),
      h('button', { onclick: () => setZoom(1), title: '适合宽度' }, Math.round(state.zoom * 100) + '%'),
      h('button', { onclick: () => setZoom(state.zoom + 0.15) }, '＋'),
      h('span', { class: 'sep' }),
      h('button', { onclick: runPageSearch, title: '全文检索（Ctrl+F）' }, '🔍 检索'),
      h('button', { onclick: () => explainPage() }, '讲解本页'),
      h(
        'button',
        {
          id: 'page-crop-explain',
          class: state.cropMode ? 'primary' : '',
          title: '在 PDF 页面上拖动框选图表、公式或段落，松手即高清截图发往右侧会话深入讲解',
          onclick: () => {
            state.cropMode = !state.cropMode
            render(true)
          },
        },
        state.cropMode ? '✕ 退出框选' : '⬚ 框选讲解',
      ),
      h('button', {
        class: state.zhMode ? 'on' : 'ghost',
        title: state.zhStatus && state.zhStatus.exists
          ? '中文版 PDF（译文写回原版面，和原文逐页对齐）' + (state.zhStatus.stale ? ' —— 有新的译文，点右键菜单重新生成' : '')
          : '把已有译文写回原版面，生成一份中文版 PDF（纯本地，不上传）',
        onclick: toggleZhPdf,
      }, state.zhMode ? '中文版 ✓' : '中文版'),
      h('span', { class: 'spacer' }),
      state.current.meta.hasText === false || (state.ocr && state.ocr.pages > 0)
        ? h('button', { class: 'ghost', onclick: runOcr, disabled: !!state.ocrBusy, title: '扫描件：调用 PaddleOCR 识别全文' }, state.ocrBusy ? 'OCR 中…' : state.ocr && state.ocr.pages > 0 ? '重新 OCR' : 'OCR 识别')
        : null,
      h('button', { onclick: () => window.open(API + 'raw?id=' + encodeURIComponent(meta.id), '_blank', 'noopener') }, '浏览器打开 PDF'),
    ),
    state.cropMode
      ? h(
          'div',
          { class: 'crop-banner' },
          h('span', {}, '⬚ 框选讲解模式：在任意 PDF 页面上按住左键框选图表、公式或段落，松手即截图发送右侧会话（按 Esc 退出）'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'ghost', onclick: () => { state.cropMode = false; render(true) } }, '退出'),
        )
      : null,
    ocrBar(),
    stage,
    h(
      'div',
      { class: 'statusbar' },
      h('span', { class: 'cur-page' }, '第 ' + state.page + ' 页'),
      h('span', {}, meta.hasText === false ? '扫描件模式' : '支持直接划选文字复制 / 翻译 / 讲解，或点「⬚ 框选讲解」截取图表'),
      h('span', { class: 'spacer' }),
      h('span', {}, '共 ' + (total || '?') + ' 页 · 上下滚动连续阅读'),
    ),
  )

  function setZoom(value) {
    state.zoom = Math.max(0.4, Math.min(3, value))
    // 缩放后每页高度都变了，用「当前页」重新锚定滚动位置，别让读者飘到别处
    state.pendingPage = state.page
    render()
  }
  function runPageSearch() {
    if (hostReady()) {
      openSearch()
      return
    }
    const query = window.prompt('全文检索关键词：')
    if (!query) return
    rpc('pdf.search', { id: meta.id, query })
      .then((value) => {
        if (!value.hits || value.hits.length === 0) {
          toast('没有命中')
          return
        }
        state.page = value.hits[0].page
        loadPage(value.hits[0].page).then(() => render())
        toast('共 ' + value.hits.length + ' 处命中，已跳到第 ' + value.hits[0].page + ' 页')
      })
      .catch((error) => toast(error.message))
  }
}

function ocrBar() {
  const ocrState = state.ocr || {}
  const ocrConfig = (state.health && state.health.ocr) || {}
  const configured = ocrConfig.configured !== false && ocrState.configured !== false
  const isScannedPdf = Boolean(state.current && state.current.meta && state.current.meta.hasText === false)
  if (state.ocrBusy) return h('div', { class: 'ocr-bar' }, h('span', {}, state.ocrBusy))
  if (ocrState.pages > 0) return h('div', { class: 'ocr-bar' }, h('span', { class: 'hint' }, '已 OCR ' + ocrState.pages + ' 页，可用于对照阅读与问答'))
  if (isScannedPdf) {
    const failed = ocrState.state === 'failed'
    return h(
      'div',
      { class: 'ocr-bar' },
      h(
        'span',
        {},
        failed
          ? 'OCR 失败：' + (ocrState.error || '未知错误')
          : configured
            ? '扫描件 PDF：未检测到内嵌文本层，可调用 PaddleOCR 识别整篇'
            : '扫描件 PDF：尚未配置 PaddleOCR API Key（设置 → 扫描件 OCR）',
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: runOcr, disabled: !configured }, 'OCR 识别整篇'),
    )
  }
  return null
}

function explainPage() {
  if (!NATIVE_READER && !state.layout.chatOpen) {
    state.layout.chatOpen = true
    saveLayout()
  }
  sendChat('请详细讲解第 ' + state.page + ' 页的核心内容、图表/公式含义与上下文逻辑，并附原文引用。', chatContext({ page: state.page, scope: 'section' }))
}

// ---------------------------------------------------------------- 笔记 / 卡片

function triggerDownload(filename, content, mime = 'text/plain;charset=utf-8') {
  try {
    const blob = new Blob([String(content || '')], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'export.txt'
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    copyText(String(content || ''))
    toast('已复制到剪贴板（当前环境不支持直接下载）')
  }
}

async function exportPaperMarkdown(includeTrans = true) {
  if (!state.current) return
  try {
    const res = await rpc('paper.exportMarkdown', { id: state.current.meta.id, includeTrans })
    triggerDownload(res.filename || state.current.meta.id + '-notes.md', res.markdown || '', 'text/markdown;charset=utf-8')
    toast('已导出研读归档：' + (res.filename || 'notes.md'))
  } catch (error) {
    toast('导出失败：' + error.message)
  }
}

async function exportDbSnapshot(paperIds = null) {
  try {
    const res = await rpc('db.export', paperIds ? { paperIds } : {})
    const file =
      (Array.isArray(paperIds) && paperIds.length === 1 ? paperIds[0] : 'paper-workbench') +
      '-backup-' +
      new Date().toISOString().slice(0, 10) +
      '.json'
    triggerDownload(file, JSON.stringify(res.snapshot, null, 2), 'application/json;charset=utf-8')
    toast('已导出数据备份：' + file)
  } catch (error) {
    toast('导出备份失败：' + error.message)
  }
}

function importDbSnapshot() {
  const input = h('input', { type: 'file', accept: '.json,application/json' })
  input.onchange = async () => {
    const file = input.files && input.files[0]
    if (!file) return
    try {
      const text = await file.text()
      const snapshot = JSON.parse(text)
      const res = await rpc('db.import', { snapshot, mode: 'merge' })
      toast('已导入：' + res.papers + ' 篇 · ' + res.translations + ' 译文 · ' + res.annotations + ' 标注 · ' + res.studyNotes + ' 笔记')
      if (state.current) await loadDoc(state.current.meta.id)
      render(true)
    } catch (error) {
      toast('导入备份失败：' + error.message)
    }
  }
  input.click()
}

function jumpToAnnotationTarget(ann) {
  if (!ann) return
  if (ann.paragraphKey && state.doc && Array.isArray(state.doc.paragraphs)) {
    const p = state.doc.paragraphs.find((item) => item.hash && String(item.hash).toLowerCase() === ann.paragraphKey)
    if (p) {
      state.tab = 'compare'
      render(true)
      const node = document.getElementById('para-' + p.id)
      if (node) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' })
        node.classList.add('flash')
        setTimeout(() => node.classList.remove('flash'), 1600)
        return
      }
    }
  }
  jumpToPage(ann.page || 1)
}

function renderNotesPane() {
  const notes = state.current.notes || { highlights: [] }
  const highlights = notes.highlights || []
  const anns = Array.isArray(state.annotations) ? state.annotations : []
  const studyNotes = Array.isArray(state.studyNotes) ? state.studyNotes : []
  const filter = state.annFilter || 'all'
  const filteredAnns = anns.filter((ann) => {
    if (filter === 'all') return true
    if (filter === 'highlight') return ann.kind === 'highlight'
    if (filter === 'style') return ann.kind === 'underline' || ann.kind === 'bold'
    if (filter === 'comment') return ann.kind === 'comment' || ann.kind === 'insert'
    return true
  })

  const pane = h('div', { class: 'pane' })
  pane.append(
    h(
      'div',
      { class: 'toolbar', style: { borderBottom: 'none', padding: '0 0 10px' } },
      h('span', { class: 'muted' }, studyNotes.length + ' 篇研读笔记 · ' + (anns.length + highlights.length) + ' 条标注'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => exportPaperMarkdown(true), title: '导出包含研读笔记、标注与双语对照的 Markdown 文档' }, '导出 Markdown'),
      h('button', { onclick: () => exportDbSnapshot([state.current.meta.id]), title: '导出本篇译文/标注/研读笔记便携备份 JSON' }, '导出数据包'),
      anns.length > 0
        ? h('button', { class: 'ghost', onclick: clearAllAnnotations, title: '清除这篇论文的所有原文标注（不影响研读笔记）' }, '清空标注')
        : null,
      h(
        'button',
        {
          onclick: () =>
            obsidianEnabled()
              ? insertPrompt(P.deepRead(state.current.meta))
              : askSelection('请精读《' + state.current.meta.title + '》（id="' + state.current.meta.id + '"）全篇并调用 paper_notes(action="save_study_note") 保存一份结构化中文精读笔记。', { page: 1 }),
          title: obsidianEnabled() ? '让 agent 精读全文并写入 Obsidian（走会话）' : '让 agent 精读全文并保存研读笔记',
        },
        obsidianEnabled() ? '精读整篇（交给会话）' : '精读并存笔记',
      ),
    ),
  )

  pane.append(
    h(
      'div',
      { class: 'notes-section-head' },
      h('span', {}, 'AI 讲解与研读笔记 (' + studyNotes.length + ')'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'ghost',
          onclick: async () => {
            const title = window.prompt('研读笔记标题：', '§' + (state.page || 1) + ' 研读总结')
            if (!title) return
            const md = window.prompt('笔记正文（支持 Markdown）：', '')
            if (!md || !md.trim()) return
            try {
              const res = await rpc('studyNotes.save', {
                id: state.current.meta.id,
                note: { title: title.trim(), page: state.page || 1, sectionId: state.sectionId || null, scope: 'section', markdown: md.trim() },
              })
              state.studyNotes = res.studyNotes || []
              toast('已保存研读笔记')
              render()
            } catch (error) {
              toast('保存失败：' + error.message)
            }
          },
        },
        '＋ 新建笔记',
      ),
    ),
  )
  if (studyNotes.length === 0) {
    pane.append(h('div', { class: 'hint' }, '还没有 AI 研读笔记。在右侧让 Agent「讲解本节」或「讲解选中」，会自动归纳整理到这里。'))
  }
  for (const sn of studyNotes) {
    pane.append(
      h(
        'div',
        { class: 'study-note-card' },
        h(
          'div',
          { class: 'study-note-head' },
          h('span', { class: 'study-note-title' }, sn.title || '研读笔记'),
          h('span', { class: 'badge' }, sn.scope || 'section'),
          h('span', { class: 'muted' }, 'p.' + (sn.page || 1)),
          h('span', { class: 'spacer' }),
          h('button', { class: 'ghost', onclick: () => jumpToPage(sn.page || 1) }, '跳回 p.' + (sn.page || 1)),
          h(
            'button',
            {
              class: 'danger',
              onclick: async () => {
                try {
                  const res = await rpc('studyNotes.delete', { id: state.current.meta.id, ids: [sn.id] })
                  state.studyNotes = res.studyNotes || []
                  render()
                } catch (error) {
                  toast('删除失败：' + error.message)
                }
              },
            },
            '删除',
          ),
        ),
        sn.anchorQuote ? h('div', { class: 'quote' }, sn.anchorQuote) : null,
        h('div', { class: 'study-note-body markdown', html: renderMarkdown(sn.markdown || '') }),
      ),
    )
  }

  pane.append(
    h(
      'div',
      { class: 'notes-section-head' },
      h('span', {}, '原文富标注与高亮 (' + (anns.length + highlights.length) + ')'),
      h('span', { class: 'spacer' }),
      [
        ['all', '全部'],
        ['highlight', '高亮'],
        ['style', '下划线/加粗'],
        ['comment', '批注/插入'],
      ].map(([fKey, fLabel]) =>
        h(
          'button',
          {
            class: 'topic-pill' + (filter === fKey ? ' active' : ''),
            onclick: () => {
              state.annFilter = fKey
              render()
            },
          },
          fLabel,
        ),
      ),
    ),
  )

  if (filteredAnns.length === 0 && highlights.length === 0) {
    pane.append(h('div', { class: 'hint' }, '还没有原文标注。到「对照」视图划选英文/译文，点浮窗色点、下划线、加粗、💬 批注或 ‹+› 插入即可持久化保存。'))
  }
  for (const ann of filteredAnns) {
    pane.append(
      h(
        'div',
        { class: 'ann-note-card' },
        ann.quote ? h('div', { class: 'quote' }, ann.quote) : null,
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'ann-kind-tag' }, ANN_KIND_LABELS[ann.kind] || ann.kind),
          h('span', { class: 'muted' }, 'p.' + (ann.page || 1) + (ann.target === 'zh' ? ' · 译文' : ' · 原文')),
          ann.note ? h('span', {}, ann.note) : null,
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { onclick: () => jumpToAnnotationTarget(ann) }, '跳回原文'),
          h('button', { onclick: (e) => openAnnotationPopover(ann, e.currentTarget?.getBoundingClientRect?.() || { left: 100, top: 120 }) }, '编辑'),
          ann.quote ? h('button', { onclick: () => askSelection(ann.quote, { page: ann.page || 1, sectionId: ann.sectionId || null }) }, '讲解这段') : null,
          h('button', { class: 'danger', onclick: () => deleteAnnotationById(ann.id) }, '删除'),
        ),
      ),
    )
  }
  for (const [index, highlight] of highlights.entries()) {
    pane.append(
      h(
        'div',
        { class: 'highlight-item' },
        h('div', { class: 'quote' }, highlight.text),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, 'p.' + highlight.page + (highlight.note ? ' · ' + highlight.note : ''))),
        h(
          'div',
          { class: 'row' },
          h('button', { onclick: () => jumpToPage(highlight.page) }, '跳回原文'),
          h('button', { onclick: () => askSelection(highlight.text, { page: highlight.page || 1 }) }, '讲解这段'),
          !NATIVE_READER ? h('button', { onclick: () => draftSelection(highlight.text, { page: highlight.page || 1 }) }, '引用追问') : null,
          h(
            'button',
            {
              class: 'danger',
              onclick: () => {
                saveNotes(highlights.filter((_, i) => i !== index))
              },
            },
            '删除',
          ),
        ),
      ),
    )
  }
  return pane
}

function renderCardPane() {
  const pane = h('div', { class: 'pane' })
  if (!state.card) {
    pane.append(
      h(
        'div',
        { class: 'empty' },
        h('h2', {}, 'Obsidian 里还没有这张卡片'),
        h('p', {}, '可以让 agent 读全文，把「一句话结论 / 研究问题 / 方法线索 / 应用场景 / 局限线索」写进卡片；已存在则只改这些字段行。'),
        h('div', { class: 'empty-actions' }, h('button', { class: 'primary', onclick: () => insertPrompt(P.syncCard(state.current.meta)) }, '生成并写入卡片（交给会话）')),
      ),
    )
    return pane
  }
  pane.append(
    h(
      'div',
      { class: 'toolbar', style: { borderBottom: 'none', padding: '0 0 8px' } },
      h('span', { class: 'muted', title: state.card.path }, state.card.path.split(/[\\/]/).slice(-2).join('/')),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => insertPrompt(P.syncCard(state.current.meta)), title: '让会话重新提炼并更新卡片关键字段' }, '更新卡片（交给会话）'),
      h('button', { onclick: () => rpc('vault.open', { path: state.card.path }).catch((error) => toast(error.message)) }, '在 Obsidian 打开'),
      h('button', { onclick: () => loadCard().then(() => render()) }, '刷新'),
    ),
  )
  const metaRows = Object.entries(state.card.frontmatter || {})
    .filter(([, value]) => value !== null && value !== '' && !Array.isArray(value))
    .slice(0, 12)
  pane.append(
    h(
      'div',
      { class: 'blocks' },
      h('h3', {}, 'frontmatter'),
      h('div', { class: 'hint' }, metaRows.map(([key, value]) => key + ': ' + String(value)).join(' · ')),
      h('h3', {}, '正文'),
      h('div', { class: 'markdown', html: renderMarkdown(state.card.body) }),
    ),
  )
  return pane
}

// ---------------------------------------------------------------- 右侧对话抽屉

function renderChat() {
  const aside = h('aside', { class: 'chat', 'aria-label': '论文对话' })
  const sessionMode = state.chatMode === 'session' && state.session.available
  const header = h(
    'div',
    { class: 'chat-head' },
    h('span', { class: 'chat-title' }, sessionMode ? '对话 · DSH 会话' : '对话'),
    h('span', { class: 'spacer' }),
    sessionMode
      ? null
      : h(
          'select',
          { class: 'chat-model', title: '对话模型（保存到 AI 设置）', onchange: (event) => saveModel('chatModel', event.target.value) },
          ...modelOptions(state.aiConfig && state.aiConfig.chatModel),
        ),
    sessionMode ? null : h('button', { class: 'ghost', title: '清空对话历史', onclick: clearChat }, '清空'),
    state.session.available
      ? h(
          'button',
          {
            class: 'ghost' + (sessionMode ? ' active' : ''),
            title: sessionMode ? '切回插件内自绘对话（不写进 DSH 会话）' : '把对话落进真正的 DSH 会话（主界面能接着聊）',
            onclick: () => {
              state.chatMode = sessionMode ? 'local' : 'session'
              state.session.started = ''
              // 切回「本地」时把会话流停掉：否则后台还在收帧、白白重绘，也容易把旧回答画进新气泡
              if (state.chatMode === 'local') stopSessionStream()
              render()
            },
          },
          sessionMode ? '本地' : '会话',
        )
      : null,
    h('button', { class: 'ghost', title: '收起对话', onclick: () => togglePane('chat') }, '×'),
  )
  aside.append(header)
  if (!state.current && !sessionMode) {
    aside.append(h('div', { class: 'hint chat-hint' }, '打开一篇论文后在这里对话。'))
    return aside
  }
  if (sessionMode) {
    renderSessionChat(aside)
    setupDropZone(aside)
    return aside
  }
  aside.append(
    h(
      'div',
      { class: 'chat-quick' },
      h('button', { class: 'ghost', onclick: () => sendQuick('讲解本节', { scope: 'section' }) }, '讲解本节'),
      h('button', { class: 'ghost', onclick: () => { const text = pickedText(); if (text.length < 2) { toast('先在正文里选中一段文字'); return } sendQuick('讲解这段选中的原文：\n> ' + text, { scope: 'selection', selection: text }) } }, '讲解选中段落'),
      h('button', { class: 'ghost', onclick: () => sendQuick('总结全文', { scope: 'paper' }) }, '总结全文'),
    ),
  )
  if (state.aiModels && state.aiModels.ready === false) aside.append(h('div', { class: 'chat-error hint' }, aiReadyHint()))
  const list = h('div', { class: 'chat-messages' })
  if (state.chat.messages.length === 0) list.append(h('div', { class: 'hint chat-hint' }, aiReadyHint()))
  state.chat.messages.forEach((message, index) => list.append(renderMessage(message, index)))
  aside.append(list)
  if (state.chat.error) aside.append(h('div', { class: 'chat-error error' }, state.chat.error))
  const input = h('textarea', {
    id: 'chat-input',
    class: 'chat-input',
    rows: '2',
    placeholder: '问关于这篇论文的任何问题…（Enter 发送，Shift+Enter 换行）',
    value: state.chat.draft || '',
    oninput: (event) => {
      state.chat.draft = event.target.value
    },
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        sendChatDraft()
      }
    },
  })
  const actions = h(
    'div',
    { class: 'chat-actions' },
    h('span', { class: 'hint' }, state.chat.busy ? '正在生成…' : 'Enter 发送'),
    h('span', { class: 'spacer' }),
    state.chat.busy
      ? h('button', { id: 'chat-stop', onclick: stopChat }, '停止')
      : h('button', { class: 'primary', id: 'chat-send', onclick: sendChatDraft }, '发送'),
  )
  aside.append(h('div', { class: 'chat-composer' }, input, actions))
  setupDropZone(aside)
  return aside
}

function renderMessage(message, index) {
  if (message.role === 'user') return h('div', { class: 'msg user' }, h('div', { class: 'msg-body' }, message.content))
  const body = h('div', { class: 'msg-body' + (message.streaming ? ' streaming' : ''), id: message.streaming ? 'chat-live-body' : undefined })
  body.innerHTML = renderAssistantHtml(message.content)
  if (message.streaming) body.append(h('span', { class: 'caret' }))
  if (message.error) body.append(h('div', { class: 'error' }, message.error))
  const actions = h(
    'div',
    { class: 'msg-actions' },
    h('button', { class: 'link', onclick: () => copyText(message.content) }, '复制'),
    h('button', { class: 'link', title: '把这条回答写进 DSH 会话输入框', onclick: () => insertPrompt(message.content) }, '插入到会话'),
    h('button', { class: 'link', title: '从这条回答重新生成', onclick: () => regenerate(index) }, '重新生成'),
    message.model ? h('span', { class: 'muted' }, message.model) : null,
  )
  return h('div', { class: 'msg assistant' }, body, actions)
}

// ---------------------------------------------------------------- 设置（原有 + AI 区）

const FALLBACK_TOPIC_PRESETS = [
  { id: 'llm-agents', label: '大模型与智能体', domain: 'cs', categories: ['cs.CL', 'cs.AI', 'cs.MA'], keywords: ['large language model', 'agent', 'tool use'] },
  { id: 'multimodal-ocr', label: '多模态与文档版面 / OCR', domain: 'cs', categories: ['cs.CV', 'cs.CL'], keywords: ['document parsing', 'OCR', 'vision-language'] },
  { id: 'efficient-training', label: '推理加速 / 量化 / 注意力', domain: 'cs', categories: ['cs.LG', 'cs.AR', 'cs.DC'], keywords: ['KV cache', 'quantization', 'speculative decoding'] },
  { id: 'rag-retrieval', label: '检索增强与知识系统', domain: 'cs', categories: ['cs.IR', 'cs.CL'], keywords: ['retrieval-augmented', 'RAG', 'long context'] },
  { id: 'alignment-eval', label: '对齐 / 安全 / 评测', domain: 'cs', categories: ['cs.CL', 'cs.AI', 'cs.CY'], keywords: ['RLHF', 'alignment', 'hallucination'] },
  { id: 'robotics-vla', label: '具身智能与 VLA', domain: 'cs', categories: ['cs.RO', 'cs.CV'], keywords: ['embodied', 'vision-language-action'] },
  { id: 'rl-reasoning', label: '强化学习与推理', domain: 'cs', categories: ['cs.LG', 'cs.AI'], keywords: ['reinforcement learning', 'chain-of-thought', 'reasoning'] },
  { id: 'systems-infra', label: 'AI 基础设施与分布式系统', domain: 'cs', categories: ['cs.DC', 'cs.OS'], keywords: ['distributed training', 'GPU cluster', 'serving'] },
]

const FALLBACK_ARXIV_DOMAINS = [
  {
    id: 'cs',
    label: '计算机科学',
    labelEn: 'CS',
    categories: [
      { code: 'cs.AI', label: '人工智能' },
      { code: 'cs.CL', label: '计算与语言/NLP' },
      { code: 'cs.CV', label: '计算机视觉' },
      { code: 'cs.LG', label: '机器学习' },
      { code: 'cs.IR', label: '信息检索' },
      { code: 'cs.RO', label: '机器人' },
      { code: 'cs.SE', label: '软件工程' },
      { code: 'cs.CR', label: '密码与安全' },
      { code: 'cs.DB', label: '数据库' },
      { code: 'cs.DC', label: '分布式计算' },
      { code: 'cs.HC', label: '人机交互' },
    ],
  },
  {
    id: 'physics',
    label: '物理学',
    labelEn: 'Physics',
    categories: [
      { code: 'quant-ph', label: '量子物理' },
      { code: 'cond-mat', label: '凝聚态物理' },
      { code: 'astro-ph', label: '天体物理' },
      { code: 'hep-th', label: '高能物理-理论' },
      { code: 'hep-ph', label: '高能物理-唯象' },
      { code: 'gr-qc', label: '广义相对论与量子宇宙' },
      { code: 'physics.optics', label: '光学' },
    ],
  },
  {
    id: 'math',
    label: '数学',
    labelEn: 'Math',
    categories: [
      { code: 'math.OC', label: '优化与控制' },
      { code: 'math.PR', label: '概率论' },
      { code: 'math.NA', label: '数值分析' },
      { code: 'math.ST', label: '统计理论' },
      { code: 'math.CO', label: '组合数学' },
      { code: 'math.AG', label: '代数几何' },
    ],
  },
  {
    id: 'stat',
    label: '统计学',
    labelEn: 'Stat',
    categories: [
      { code: 'stat.ML', label: '统计机器学习' },
      { code: 'stat.ME', label: '统计方法' },
      { code: 'stat.TH', label: '统计理论' },
      { code: 'stat.AP', label: '统计应用' },
    ],
  },
  {
    id: 'eess',
    label: '电气与系统科学',
    labelEn: 'EESS',
    categories: [
      { code: 'eess.AS', label: '音频与语音处理' },
      { code: 'eess.IV', label: '图像与视频处理' },
      { code: 'eess.SP', label: '信号处理' },
      { code: 'eess.SY', label: '系统与控制' },
    ],
  },
  {
    id: 'q-bio',
    label: '定量生物学',
    labelEn: 'q-bio',
    categories: [
      { code: 'q-bio.NC', label: '神经元与认知' },
      { code: 'q-bio.GN', label: '基因组学' },
      { code: 'q-bio.BM', label: '生物分子' },
      { code: 'q-bio.QM', label: '定量方法' },
    ],
  },
  {
    id: 'q-fin',
    label: '定量金融',
    labelEn: 'q-fin',
    categories: [
      { code: 'q-fin.CP', label: '计算金融' },
      { code: 'q-fin.PM', label: '投资组合管理' },
      { code: 'q-fin.ST', label: '统计金融' },
      { code: 'q-fin.TR', label: '交易与市场微观结构' },
    ],
  },
  {
    id: 'econ',
    label: '经济学',
    labelEn: 'Econ',
    categories: [
      { code: 'econ.EM', label: '计量经济学' },
      { code: 'econ.TH', label: '经济理论' },
      { code: 'econ.GN', label: '一般经济学' },
    ],
  },
]

function buildDefaultTopicItems(subscribed = ['llm-agents', 'multimodal-ocr', 'efficient-training']) {
  const subSet = new Set(Array.isArray(subscribed) ? subscribed : [])
  return FALLBACK_TOPIC_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    domain: p.domain || 'cs',
    categories: [...(p.categories || [])],
    keywords: [...(p.keywords || [])],
    enabled: subSet.has(p.id),
  }))
}

function openSettings() {
  state.showSettings = true
  state.dbTestResult = null
  state.netTestResult = null
  state.topicEditor = null
  loadDoctor()
  loadAi(true).then(() => {
    state.aiDraft = {
      translateModel: (state.aiConfig && state.aiConfig.translateModel) || null,
      chatModel: (state.aiConfig && state.aiConfig.chatModel) || null,
      temperature: state.aiConfig && Number.isFinite(Number(state.aiConfig.temperature)) ? Number(state.aiConfig.temperature) : 0.2,
      concurrency: Math.min(100, Math.max(1, Math.trunc(Number(state.aiConfig && state.aiConfig.concurrency) || 10))),
    }
    Promise.all([
      rpc('settings.get'),
      rpc('search.topics').catch(() => ({ domains: FALLBACK_ARXIV_DOMAINS, topics: FALLBACK_TOPIC_PRESETS })),
    ])
      .then(([value, topicData]) => {
        state.settings = value
        const cfg = (value && value.config) || {}
        state.fullConfig = cfg
        if (Array.isArray(topicData && topicData.topics) && topicData.topics.length) {
          state.latestFeed.topics = topicData.topics
        }
        if (Array.isArray(topicData && topicData.domains) && topicData.domains.length) {
          state.latestFeed.domains = topicData.domains
        }
        if (cfg.ai && Number.isFinite(Number(cfg.ai.concurrency))) {
          state.aiDraft.concurrency = Math.min(100, Math.max(1, Math.trunc(Number(cfg.ai.concurrency) || 10)))
        }
        const rawItems =
          Array.isArray(cfg.topics && cfg.topics.items)
            ? cfg.topics.items.map((it) => ({
                id: it.id,
                label: it.label,
                domain: it.domain || 'cs',
                categories: Array.isArray(it.categories) ? [...it.categories] : [],
                keywords: Array.isArray(it.keywords) ? [...it.keywords] : [],
                enabled: Boolean(it.enabled),
              }))
            : buildDefaultTopicItems(cfg.topics && cfg.topics.subscribed)
        state.settingsDraft = {
          python: cfg.python || '',
          vault: cfg.vault || '',
          kb: cfg.kb || '',
          storage: cfg.storage || 'link',
          obsidian: { enabled: Boolean(cfg.obsidian && cfg.obsidian.enabled), syncStatus: !(cfg.obsidian && cfg.obsidian.syncStatus === false) },
          network: {
            mode: (cfg.network && cfg.network.mode) || 'auto',
            proxyUrl: (cfg.network && cfg.network.proxyUrl) || '',
            proxyAuthConfigured: Boolean(cfg.network && cfg.network.proxyAuthConfigured),
            clearProxyAuth: false,
          },
          topics: {
            items: rawItems,
            customText: Array.isArray(cfg.topics && cfg.topics.custom) ? cfg.topics.custom.join(', ') : '',
            feedSource: (cfg.topics && cfg.topics.feedSource) || 'arxiv',
          },
          database: {
            driver: (cfg.database && cfg.database.driver) || 'sqlite',
            tablePrefix: (cfg.database && cfg.database.tablePrefix) || 'pb_',
            host: (cfg.database && cfg.database.host) || '127.0.0.1',
            port: Number((cfg.database && cfg.database.port) || 3306),
            database: (cfg.database && cfg.database.database) || 'paper_workbench',
            user: (cfg.database && cfg.database.user) || '',
            password: '',
            clearPassword: false,
            passwordConfigured: Boolean(cfg.database && cfg.database.passwordConfigured),
            passwordHint: (cfg.database && cfg.database.passwordHint) || '',
            ssl: Boolean(cfg.database && cfg.database.ssl),
          },
          ocr: Object.assign({}, cfg.ocr || {}),
        }
        render()
      })
      .catch((error) => toast(error.message))
  })
  render()
}

/**
 * 环境自检：新宿主有 doctor.run（返回 { ok, at, checks[] }），旧宿主没有这个接口。
 * 旧宿主上静默降级成一行「要重启桌面端」的提示，不弹 toast、不抛错。
 */
async function loadDoctor(force = false) {
  if (state.doctor.loading) return
  if (!force && (state.doctor.report || state.doctor.unsupported || state.doctor.error)) return
  state.doctor.loading = true
  state.doctor.error = ''
  if (state.showSettings) render()
  try {
    const value = await rpc('doctor.run')
    state.doctor.report = value && Array.isArray(value.checks) ? value : null
    state.doctor.unsupported = false
  } catch (error) {
    state.doctor.report = null
    // 旧宿主：接口不存在。只在设置页里留一句可操作的话，别打扰用户。
    state.doctor.unsupported = /no such method|not found|404|未知方法/i.test(error.message)
    state.doctor.error = state.doctor.unsupported ? '' : error.message
  } finally {
    state.doctor.loading = false
    if (state.showSettings) render()
  }
}

const DOCTOR_STATUS = { ok: 'ok', warn: 'warn', error: 'FAIL', skip: 'skip' }

function doctorRow(check) {
  const status = String((check && check.status) || 'warn')
  return h(
    'div',
    { class: 'doctor-item ' + status },
    h('span', { class: 'doctor-badge ' + status }, DOCTOR_STATUS[status] || status),
    h('span', { class: 'doctor-label' }, (check && check.label) || (check && check.id) || ''),
    h('span', { class: 'doctor-detail' }, (check && check.detail) || ''),
    check && check.hint ? h('span', { class: 'doctor-hint hint' }, check.hint) : null,
  )
}

function renderDoctorSection() {
  const doctor = state.doctor
  const report = doctor.report
  const checks = report && Array.isArray(report.checks) ? report.checks : []
  let body = null
  if (doctor.loading && !report) body = h('div', { class: 'hint' }, '正在检测…')
  else if (doctor.unsupported) body = h('div', { class: 'hint' }, '自检要重启桌面端后可用（当前宿主还没有 doctor.run 接口）。')
  else if (doctor.error) body = h('div', { class: 'hint' }, '自检失败：' + doctor.error)
  else if (checks.length === 0) body = h('div', { class: 'hint' }, '还没有检测结果。')
  else body = h('div', { class: 'doctor-list' }, ...checks.map(doctorRow))
  return h(
    'div',
    { class: 'doctor' },
    h('div', { class: 'divider' }, '环境自检'),
    h(
      'div',
      { class: 'doctor-head' },
      h(
        'span',
        { class: 'hint' },
        report && report.at ? '检测时间 ' + String(report.at).replace('T', ' ').slice(0, 19) : '检查 Python / 存储 / 模型 / Obsidian / OCR 是否就绪',
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'ghost', disabled: doctor.loading, onclick: () => loadDoctor(true) }, doctor.loading ? '检测中…' : '重新检测'),
    ),
    body,
  )
}

function renderSettings() {
  const settings = state.settings || { config: {}, dataRoot: '' }
  const config = settings.config || {}
  const ai = state.aiConfig || {}
  const draft = state.aiDraft || {
    translateModel: ai.translateModel || null,
    chatModel: ai.chatModel || null,
    temperature: Number.isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2,
    concurrency: Math.min(100, Math.max(1, Math.trunc(Number(ai.concurrency) || 10))),
  }
  if (!state.settingsDraft) {
    state.settingsDraft = {
      python: config.python || '',
      vault: config.vault || '',
      kb: config.kb || '',
      storage: config.storage || 'link',
      obsidian: { enabled: Boolean(config.obsidian && config.obsidian.enabled), syncStatus: true },
      network: {
        mode: (config.network && config.network.mode) || 'auto',
        proxyUrl: (config.network && config.network.proxyUrl) || '',
        proxyAuthConfigured: Boolean(config.network && config.network.proxyAuthConfigured),
        clearProxyAuth: false,
      },
      topics: {
        items:
          Array.isArray(config.topics && config.topics.items)
            ? config.topics.items.map((it) => ({ ...it }))
            : buildDefaultTopicItems(config.topics && config.topics.subscribed),
        customText: Array.isArray(config.topics && config.topics.custom) ? config.topics.custom.join(', ') : '',
        feedSource: (config.topics && config.topics.feedSource) || 'arxiv',
      },
      database: { driver: 'sqlite', tablePrefix: 'pb_', host: '127.0.0.1', port: 3306, database: 'paper_workbench', user: '', password: '', clearPassword: false, passwordConfigured: false, ssl: false },
      ocr: Object.assign({}, config.ocr || {}),
    }
  }
  const sd = state.settingsDraft
  sd.network ||= { mode: 'auto', proxyUrl: '' }
  if (!Array.isArray(sd.topics.items)) sd.topics.items = buildDefaultTopicItems(sd.topics.subscribed)
  const domainsCatalog = state.latestFeed.domains && state.latestFeed.domains.length ? state.latestFeed.domains : FALLBACK_ARXIV_DOMAINS

  const field = (key, label, placeholder) => {
    const id = 'set-' + key
    return h(
      'div',
      { class: 'field' },
      h('label', { for: id }, label),
      h('input', {
        id,
        type: 'text',
        value: sd[key] || '',
        placeholder: placeholder || '',
        onchange: (event) => {
          sd[key] = event.target.value
        },
      }),
    )
  }
  const modelSelect = (id, label, key) =>
    h(
      'div',
      { class: 'field' },
      h('label', {}, label + '（“跟随当前模型”= 用 DSH 会话里的默认模型）'),
      h(
        'select',
        {
          id,
          onchange: (event) => {
            draft[key] = parseModelValue(event.target.value)
          },
        },
        ...modelOptions(draft[key]),
      ),
    )

  const dbPayloadFromDraft = () => ({
    driver: sd.database.driver || 'sqlite',
    tablePrefix: sd.database.tablePrefix || 'pb_',
    host: sd.database.host || '127.0.0.1',
    port: Number(sd.database.port) || (sd.database.driver === 'postgres' ? 5432 : 3306),
    database: sd.database.database || 'paper_workbench',
    user: sd.database.user || '',
    password: sd.database.password || '',
    clearPassword: Boolean(sd.database.clearPassword),
    ssl: Boolean(sd.database.ssl),
  })

  const renderTopicEditor = () => {
    const ed = state.topicEditor
    if (!ed) return null
    const selectedDomain = domainsCatalog.find((d) => d.id === ed.domain) || null
    const currentCats = String(ed.categories || '')
      .split(/[\s,，]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    return h(
      'div',
      { class: 'topic-editor-box' },
      h(
        'div',
        { class: 'db-grid' },
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'topic-edit-label' }, '研究方向名称'),
          h('input', {
            id: 'topic-edit-label',
            type: 'text',
            placeholder: '例如：量子纠错与表面码 / 定量金融微观结构',
            value: ed.label || '',
            oninput: (e) => { ed.label = e.target.value },
          }),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'topic-edit-domain' }, '所属 arXiv 学科领域（点选下方分类号可快速填入）'),
          h(
            'select',
            {
              id: 'topic-edit-domain',
              onchange: (e) => {
                ed.domain = e.target.value
                render()
              },
            },
            ...domainsCatalog.map((d) => h('option', { value: d.id, selected: ed.domain === d.id }, d.label + ' (' + d.labelEn + ')')),
            h('option', { value: 'custom', selected: ed.domain === 'custom' }, '跨学科 / 纯关键词检索'),
          ),
        ),
      ),
      selectedDomain
        ? h(
            'div',
            { class: 'subcat-row', style: { margin: '4px 0 8px' } },
            selectedDomain.categories.map((cat) => {
              const picked = currentCats.includes(cat.code)
              return h(
                'button',
                {
                  type: 'button',
                  class: 'subcat-pill' + (picked ? ' active' : ''),
                  onclick: () => {
                    const nextCats = picked ? currentCats.filter((c) => c !== cat.code) : [...currentCats, cat.code]
                    ed.categories = nextCats.join(', ')
                    if (!ed.label.trim() && nextCats.length === 1) ed.label = cat.label
                    render()
                  },
                },
                cat.label + ' · ' + cat.code,
              )
            }),
          )
        : null,
      h(
        'div',
        { class: 'db-grid' },
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'topic-edit-cats' }, 'arXiv 分类号（可选，逗号分隔）'),
          h('input', {
            id: 'topic-edit-cats',
            type: 'text',
            placeholder: '例如：quant-ph, cond-mat 或 q-fin.PM',
            value: ed.categories || '',
            oninput: (e) => { ed.categories = e.target.value },
          }),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'topic-edit-kws' }, '检索关键词（可选，逗号分隔）'),
          h('input', {
            id: 'topic-edit-kws',
            type: 'text',
            placeholder: '例如：surface code, causal inference',
            value: ed.keywords || '',
            oninput: (e) => { ed.keywords = e.target.value },
          }),
        ),
      ),
      h(
        'div',
        { class: 'field-row' },
        h(
          'button',
          {
            type: 'button',
            id: 'topic-edit-confirm',
            class: 'primary',
            onclick: () => {
              const cats = String(ed.categories || '').split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean)
              const kws = String(ed.keywords || '').split(/[,，;\n]+/).map((s) => s.trim()).filter(Boolean)
              if (cats.length === 0 && kws.length === 0) {
                toast('请至少填写一个 arXiv 分类号或检索关键词')
                return
              }
              const label = String(ed.label || '').trim() || kws[0] || cats.join(', ')
              const nextItem = {
                id: ed.id || ('topic-' + Date.now().toString(36)),
                label,
                domain: ed.domain || 'custom',
                categories: cats,
                keywords: kws,
                enabled: ed.enabled !== false,
              }
              if (Number.isInteger(ed.idx) && ed.idx >= 0 && ed.idx < sd.topics.items.length) {
                sd.topics.items.splice(ed.idx, 1, nextItem)
              } else {
                sd.topics.items.unshift(nextItem)
              }
              state.topicEditor = null
              render()
            },
          },
          ed.idx >= 0 ? '更新该方向' : '添加到列表',
        ),
        h('button', { type: 'button', class: 'ghost', onclick: () => { state.topicEditor = null; render() } }, '取消'),
      ),
    )
  }

  return h(
    'div',
    { class: 'modal settings-view' },
    h('div', { class: 'modal-head' }, h('h3', {}, '设置'), h('span', { class: 'spacer' }), h('button', { id: 'settings-close', class: 'ghost', title: '关闭设置', onclick: () => { state.showSettings = false; render() } }, '✕')),
    h('div', { class: 'hint' }, '数据目录：' + (settings.dataRoot || '')),
    field('python', 'Python 路径（留空自动探测）', 'F:\\ProGramApp\\Anaconda\\python.exe'),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'PDF 存储方式'),
      h(
        'select',
        {
          onchange: (event) => {
            sd.storage = event.target.value
          },
        },
        h('option', { value: 'link', selected: sd.storage !== 'copy' }, 'link：只记原路径（省磁盘）'),
        h('option', { value: 'copy', selected: sd.storage === 'copy' }, 'copy：复制进库（移动原文件也不怕）'),
      ),
    ),

    h('div', { class: 'divider' }, NATIVE_READER ? 'AI 翻译与高并发调度' : 'AI（翻译 / 对话 / 高并发调度）'),
    modelSelect('ai-translate-model', '翻译模型', 'translateModel'),
    NATIVE_READER ? h('p', { class: 'hint' }, '聊天模型与思考程度在右侧原生输入框中选择。') : modelSelect('ai-chat-model', '对话模型', 'chatModel'),
    h(
      'div',
      { class: 'db-grid' },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'ai-concurrency' }, '翻译并发数（1–100，按原文顺序派发，遇 429 自动降速退避）'),
        h('input', {
          id: 'ai-concurrency',
          type: 'number',
          min: '1',
          max: '100',
          step: '1',
          value: String(draft.concurrency || 10),
          oninput: (event) => {
            draft.concurrency = Math.min(100, Math.max(1, Math.trunc(Number(event.target.value) || 1)))
          },
        }),
        h(
          'div',
          { class: 'quick-chips' },
          [4, 10, 20, 30].map((n) =>
            h(
              'button',
              {
                type: 'button',
                class: 'quick-chip' + (Number(draft.concurrency) === n ? ' active' : ''),
                onclick: () => {
                  draft.concurrency = n
                  render()
                },
              },
              n + ' 并发',
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'ai-temperature' }, '温度（0–1，默认 0.2）'),
        h('input', {
          id: 'ai-temperature',
          type: 'number',
          min: '0',
          max: '1',
          step: '0.05',
          value: String(draft.temperature),
          oninput: (event) => {
            draft.temperature = Math.max(0, Math.min(1, Number(event.target.value) || 0))
          },
        }),
      ),
    ),

    h('div', { class: 'divider' }, '网络与代理（arXiv / OpenAlex 检索与 PDF 下载）'),
    h(
      'div',
      { class: 'db-grid' },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'net-mode' }, '代理模式'),
        h(
          'select',
          {
            id: 'net-mode',
            onchange: (e) => {
              sd.network.mode = e.target.value
              state.netTestResult = null
              render()
            },
          },
          h('option', { value: 'auto', selected: sd.network.mode === 'auto' }, '自动探测（环境变量 / Windows 系统代理，推荐）'),
          h('option', { value: 'custom', selected: sd.network.mode === 'custom' }, '手动指定代理（HTTP / HTTPS / SOCKS5）'),
          h('option', { value: 'direct', selected: sd.network.mode === 'direct' }, '直连（不使用任何代理）'),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'net-proxy-url' }, '代理服务器地址' + (sd.network.mode !== 'custom' ? '（切到「手动指定代理」时生效）' : '')),
        h('input', {
          id: 'net-proxy-url',
          type: 'text',
          disabled: sd.network.mode !== 'custom',
          placeholder: '例如 http://127.0.0.1:7897 或 socks5://127.0.0.1:1080',
          value: sd.network.proxyUrl || '',
          oninput: (e) => {
            sd.network.proxyUrl = e.target.value
          },
        }),
      ),
    ),
    sd.network.proxyAuthConfigured ? h(
      'label',
      { class: 'topic-check-item' },
      h('input', {
        id: 'net-clear-auth',
        type: 'checkbox',
        checked: Boolean(sd.network.clearProxyAuth),
        onchange: (event) => { sd.network.clearProxyAuth = event.target.checked },
      }),
      h('span', {}, '已保存代理认证（不回显）；勾选以清除，同地址留空则保留认证'),
    ) : null,
    h(
      'div',
      { class: 'field-row' },
      h(
        'button',
        {
          type: 'button',
          id: 'net-test-btn',
          class: 'ghost',
          disabled: state.netBusy !== '',
          onclick: async () => {
            state.netBusy = 'test'
            render()
            try {
              state.netTestResult = await rpc('network.test', { network: { mode: sd.network.mode, proxyUrl: sd.network.proxyUrl, clearProxyAuth: Boolean(sd.network.clearProxyAuth) } })
            } catch (error) {
              state.netTestResult = { ok: false, error: error.message }
            } finally {
              state.netBusy = ''
              render()
            }
          },
        },
        state.netBusy === 'test' ? '探测中…' : '测试网络连通',
      ),
      h('span', { class: 'hint' }, '若在线检索搜不到论文，可点此测试 arXiv 与 OpenAlex 是否需要代理。'),
    ),
    state.netTestResult
      ? h(
          'div',
          { class: 'db-status-banner ' + (state.netTestResult.ok ? 'ok' : 'err') },
          state.netTestResult.error
            ? '✗ 网络测试失败：' + state.netTestResult.error
            : (state.netTestResult.ok ? '✓ 连通正常' : '✗ 无法连接') +
                ' · 路径：' +
                (state.netTestResult.effectiveProxy ? state.netTestResult.effectiveProxy + ' (' + state.netTestResult.source + ')' : '直连') +
                ' · arXiv ' +
                (state.netTestResult.arxiv?.ok ? state.netTestResult.arxiv.ms + 'ms' : '失败(' + (state.netTestResult.arxiv?.error || '') + ')') +
                ' · OpenAlex ' +
                (state.netTestResult.openalex?.ok ? state.netTestResult.openalex.ms + 'ms' : '失败(' + (state.netTestResult.openalex?.error || '') + ')'),
        )
      : null,

    h('div', { class: 'divider' }, '关注研究方向（支持全学科自定义添加、编辑与启停）'),
    h(
      'div',
      { class: 'field-row' },
      h('span', { class: 'hint' }, '勾选启用的方向将在「在线检索」首页聚合展示最新论文；支持物理、数学、统计、金融等全部 arXiv 学科。'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          type: 'button',
          id: 'topic-add-btn',
          class: 'ghost',
          onclick: () => {
            state.topicEditor = { idx: -1, id: '', label: '', domain: 'cs', categories: '', keywords: '', enabled: true }
            render()
          },
        },
        '＋ 新增自定义方向',
      ),
      h(
        'button',
        {
          type: 'button',
          id: 'topic-reset-btn',
          class: 'ghost',
          onclick: () => {
            sd.topics.items = buildDefaultTopicItems(['llm-agents', 'multimodal-ocr', 'efficient-training'])
            state.topicEditor = null
            render()
          },
        },
        '恢复默认推荐',
      ),
    ),
    renderTopicEditor(),
    h(
      'div',
      { class: 'topic-manage-list' },
      sd.topics.items.map((item, idx) => {
        const metaParts = []
        if (Array.isArray(item.categories) && item.categories.length) metaParts.push(item.categories.join(', '))
        if (Array.isArray(item.keywords) && item.keywords.length) metaParts.push(item.keywords.slice(0, 3).join(' / '))
        return h(
          'div',
          { class: 'topic-manage-row', 'data-topic-id': item.id },
          h('input', {
            type: 'checkbox',
            checked: Boolean(item.enabled),
            onchange: (e) => {
              item.enabled = e.target.checked
            },
          }),
          h('strong', {}, item.label),
          metaParts.length ? h('span', { class: 'topic-meta', title: metaParts.join(' · ') }, metaParts.join(' · ')) : null,
          h('span', { class: 'spacer' }),
          h(
            'button',
            {
              type: 'button',
              class: 'ghost',
              onclick: () => {
                state.topicEditor = {
                  idx,
                  id: item.id,
                  label: item.label,
                  domain: item.domain || 'cs',
                  categories: (item.categories || []).join(', '),
                  keywords: (item.keywords || []).join(', '),
                  enabled: item.enabled !== false,
                }
                render()
              },
            },
            '编辑',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'ghost danger-subtle',
              onclick: () => {
                sd.topics.items.splice(idx, 1)
                if (state.topicEditor && state.topicEditor.idx === idx) state.topicEditor = null
                render()
              },
            },
            '删除',
          ),
        )
      }),
    ),
    h(
      'div',
      { class: 'db-grid' },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'topics-custom' }, '额外快捷关注关键词（英文/中文，逗号分隔）'),
        h('input', {
          id: 'topics-custom',
          type: 'text',
          placeholder: 'e.g. KV cache, surface code, Econometrics',
          value: sd.topics.customText || '',
          oninput: (event) => {
            sd.topics.customText = event.target.value
          },
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', {}, '最新论文源'),
        h(
          'select',
          {
            onchange: (event) => {
              sd.topics.feedSource = event.target.value
            },
          },
          h('option', { value: 'arxiv', selected: sd.topics.feedSource === 'arxiv' }, 'arXiv 最新投稿（推荐）'),
          h('option', { value: 'openalex', selected: sd.topics.feedSource === 'openalex' }, 'OpenAlex 近 90 天'),
          h('option', { value: 'both', selected: sd.topics.feedSource === 'both' }, 'arXiv + OpenAlex 合并去重'),
        ),
      ),
    ),

    h('div', { class: 'divider' }, '数据存储后端与迁移（SQLite / PostgreSQL / MySQL）'),
    h(
      'div',
      { class: 'db-grid' },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'db-driver' }, '存储后端驱动'),
        h(
          'select',
          {
            id: 'db-driver',
            onchange: (event) => {
              const drv = event.target.value
              sd.database.driver = drv
              if (drv === 'postgres' && (!sd.database.port || sd.database.port === 3306)) sd.database.port = 5432
              if (drv === 'mysql' && (!sd.database.port || sd.database.port === 5432)) sd.database.port = 3306
              state.dbTestResult = null
              render()
            },
          },
          h('option', { value: 'sqlite', selected: sd.database.driver === 'sqlite' }, 'SQLite（默认，零配置）'),
          h('option', { value: 'postgres', selected: sd.database.driver === 'postgres' }, 'PostgreSQL（纯 Node 协议）'),
          h('option', { value: 'mysql', selected: sd.database.driver === 'mysql' }, 'MySQL / MariaDB（纯 Node 协议）'),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'db-prefix' }, '表前缀（仅允许字母/数字/下划线）'),
        h('input', {
          id: 'db-prefix',
          type: 'text',
          value: sd.database.tablePrefix || 'pb_',
          oninput: (event) => {
            sd.database.tablePrefix = event.target.value
          },
        }),
      ),
    ),
    sd.database.driver !== 'sqlite'
      ? h(
          'div',
          { class: 'db-grid' },
          h(
            'div',
            { class: 'field' },
            h('label', {}, '主机（Host）'),
            h('input', { type: 'text', value: sd.database.host, oninput: (e) => { sd.database.host = e.target.value } }),
          ),
          h(
            'div',
            { class: 'field' },
            h('label', {}, '端口（Port）'),
            h('input', { type: 'number', value: String(sd.database.port), oninput: (e) => { sd.database.port = Number(e.target.value) || 3306 } }),
          ),
          h(
            'div',
            { class: 'field' },
            h('label', {}, '数据库名'),
            h('input', { type: 'text', value: sd.database.database, oninput: (e) => { sd.database.database = e.target.value } }),
          ),
          h(
            'div',
            { class: 'field' },
            h('label', {}, '用户名'),
            h('input', { type: 'text', value: sd.database.user, oninput: (e) => { sd.database.user = e.target.value } }),
          ),
          h(
            'div',
            { class: 'field' },
            h('label', {}, sd.database.passwordConfigured ? '密码（已保存 ' + (sd.database.passwordHint || '***') + '，留空不修改）' : '密码'),
            h('input', {
              type: 'password',
              autocomplete: 'off',
              placeholder: sd.database.passwordConfigured ? '留空保持不变' : '数据库密码',
              oninput: (e) => {
                sd.database.password = e.target.value
                sd.database.clearPassword = false
              },
            }),
          ),
          h(
            'div',
            { class: 'field' },
            h('label', {}, 'TLS / SSL'),
            h(
              'select',
              {
                onchange: (e) => {
                  sd.database.ssl = e.target.value === 'true'
                },
              },
              h('option', { value: 'false', selected: !sd.database.ssl }, '自动 / 关闭'),
              h('option', { value: 'true', selected: Boolean(sd.database.ssl) }, '强制 TLS 加密'),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'field-row' },
      h(
        'button',
        {
          class: 'ghost',
          disabled: state.dbBusy !== '',
          onclick: async () => {
            state.dbBusy = 'test'
            render()
            try {
              state.dbTestResult = await rpc('db.test', { database: dbPayloadFromDraft() })
            } catch (error) {
              state.dbTestResult = { ok: false, error: error.message }
            } finally {
              state.dbBusy = ''
              render()
            }
          },
        },
        state.dbBusy === 'test' ? '测试中…' : '测试连接',
      ),
      sd.database.driver !== 'sqlite'
        ? h(
            'button',
            {
              class: 'ghost',
              disabled: state.dbBusy !== '',
              onclick: async () => {
                if (!window.confirm('将当前激活数据库里的全量译文、标注、研读笔记与自检结果迁移到当前填写的目标数据库？不会删除源库数据。')) return
                state.dbBusy = 'migrate'
                render()
                try {
                  const res = await rpc('db.migrate', { database: dbPayloadFromDraft(), mode: 'merge' })
                  state.dbTestResult = {
                    ok: true,
                    latencyMs: res.durationMs,
                    serverVersion: res.targetDriver + '（迁移 ' + res.papers + ' 篇 / 译文 ' + (res.migrated?.translations || 0) + ' / 标注 ' + (res.migrated?.annotations || 0) + '）',
                  }
                  toast('迁移完成，校验一致！')
                } catch (error) {
                  state.dbTestResult = { ok: false, error: error.message }
                  toast('迁移失败：' + error.message)
                } finally {
                  state.dbBusy = ''
                  render()
                }
              },
            },
            state.dbBusy === 'migrate' ? '迁移中…' : '一键迁移到该库',
          )
        : null,
      h('button', { class: 'ghost', onclick: () => exportDbSnapshot(null) }, '导出全库备份 (.json)'),
      h('button', { class: 'ghost', onclick: importDbSnapshot }, '导入备份 (.json)'),
    ),
    state.dbTestResult
      ? h(
          'div',
          { class: 'db-status-banner ' + (state.dbTestResult.ok ? 'ok' : 'err') },
          state.dbTestResult.ok
            ? '✓ 连接正常 · ' + (state.dbTestResult.serverVersion || state.dbTestResult.driver || '') + ' · ' + (state.dbTestResult.latencyMs || 0) + 'ms'
            : '✗ 失败：' + (state.dbTestResult.error || '无法连接'),
        )
      : null,

    h('div', { class: 'divider' }, 'Obsidian 知识库联动（可选）'),
    h(
      'label',
      { class: 'topic-check-item' },
      h('input', {
        id: 'obsidian-enabled',
        type: 'checkbox',
        checked: Boolean(sd.obsidian && sd.obsidian.enabled),
        onchange: (event) => {
          sd.obsidian.enabled = event.target.checked
          render()
        },
      }),
      h('span', {}, '启用 Obsidian 知识库联动（展示「卡片」页签、从笔记库导入及状态同步；默认关闭以保持纯净工作台体验）'),
    ),
    sd.obsidian && sd.obsidian.enabled ? field('vault', 'Obsidian vault 路径（留空自动探测）', 'D:\\系统组件\\文档\\Obsidian Vault') : null,
    sd.obsidian && sd.obsidian.enabled ? field('kb', '论文知识库目录（留空自动探测）', '...\\F盘编程知识库\\论文知识库') : null,

    h('div', { class: 'divider' }, '扫描件 OCR（PaddleOCR 云端接口）'),
    h(
      'div',
      { class: 'field' },
      h('label', {}, (config.ocr && config.ocr.configured) ? 'PaddleOCR API Key（已保存 ' + (config.ocr.hint || '') + '，留空表示不修改）' : 'PaddleOCR API Key（去 ai.baidu.com 的 AI Studio 创建）'),
      h('input', {
        type: 'password',
        autocomplete: 'off',
        placeholder: (config.ocr && config.ocr.configured) ? '已配置，留空不修改' : '粘贴 API Key',
        oninput: (event) => {
          state.ocrToken = event.target.value
          state.ocrClear = false
        },
      }),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'OCR 模型'),
      h(
        'select',
        {
          onchange: (event) => {
            sd.ocr = Object.assign({}, sd.ocr || {}, { model: event.target.value })
          },
        },
        ['PaddleOCR-VL-1.6', 'PP-StructureV3', 'PP-OCRv6'].map((model) =>
          h('option', { value: model, selected: ((sd.ocr || {}).model || 'PaddleOCR-VL-1.6') === model }, model + (model === 'PaddleOCR-VL-1.6' ? '（版面 Markdown，推荐）' : model === 'PP-OCRv6' ? '（纯文字，最快）' : '（结构化版面）')),
        ),
      ),
    ),
    h(
      'div',
      { class: 'field-row' },
      h('span', { class: 'hint' }, 'Key 与密码只存本机配置文件（权限 0600），不进日志、不回传浏览器明文。'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'ghost',
          disabled: !(config.ocr && config.ocr.configured),
          onclick: () => {
            state.ocrToken = ''
            state.ocrClear = true
            toast('已标记为「清除」（保存后生效）')
          },
        },
        '清除 Key',
      ),
    ),
    renderDoctorSection(),
    h(
      'div',
      { class: 'foot' },
      h('button', { onclick: () => { state.showSettings = false; render() } }, '取消'),
      h(
        'button',
        {
          id: 'settings-save',
          class: 'primary',
          onclick: async () => {
            const customList = String(sd.topics.customText || '')
              .split(/[,，\n]/)
              .map((s) => s.trim())
              .filter(Boolean)
            const token = (state.ocrToken || '').trim()
            const patch = {
              python: sd.python,
              vault: sd.vault,
              kb: sd.kb,
              storage: sd.storage,
              obsidian: { enabled: Boolean(sd.obsidian.enabled), syncStatus: true },
              network: {
                mode: sd.network.mode || 'auto',
                proxyUrl: String(sd.network.proxyUrl || '').trim(),
                clearProxyAuth: Boolean(sd.network.clearProxyAuth),
              },
              topics: {
                items: sd.topics.items.map((it) => ({ ...it })),
                custom: customList,
                feedSource: sd.topics.feedSource || 'arxiv',
              },
              database: dbPayloadFromDraft(),
              ocr: Object.assign({}, sd.ocr || {}, { token: token ? token : state.ocrClear ? null : '' }),
            }
            const aiPatch = {
              translateModel: draft.translateModel,
              chatModel: draft.chatModel,
              temperature: draft.temperature,
              concurrency: Math.min(100, Math.max(1, Math.trunc(Number(draft.concurrency) || 10))),
            }
            try {
              const saved = await rpc('settings.set', { patch })
              if (saved && saved.config) state.fullConfig = saved.config
            } catch (error) {
              toast('设置保存失败：' + error.message)
              return
            }
            try {
              await saveAiPatch(aiPatch)
            } catch (error) {
              toast('AI 设置保存失败：' + error.message)
            }
            state.aiConfig = Object.assign({}, state.aiConfig, aiPatch)
            state.showSettings = false
            state.topicEditor = null
            state.ocrToken = ''
            state.ocrClear = false
            state.latestFeed.loaded = false
            await loadHealth()
            if (state.current) await loadDoc(state.current.meta.id).catch(() => {})
            if (state.tab === 'online') loadLatestFeed(true).catch(() => {})
            render(true)
            toast('设置已保存')
          },
        },
        '保存',
      ),
    ),
  )
}

// ---------------------------------------------------------------- 在线检索

async function loadLatestFeed(force = false) {
  const lf = state.latestFeed
  lf.loading = true
  lf.error = ''
  render()
  try {
    const args = { force: Boolean(force) }
    if (lf.mode === 'domain') {
      if (lf.category) args.category = lf.category
      else if (lf.domainId) args.domainId = lf.domainId
    } else if (lf.topicFilter && lf.topicFilter !== 'all') {
      args.topicId = lf.topicFilter
    }
    const res = await rpc('search.latest', args)
    lf.items = Array.isArray(res && res.items) ? res.items : []
    if (lf.mode !== 'domain' && (!lf.topicFilter || lf.topicFilter === 'all') && Array.isArray(res && res.topics) && res.topics.length) {
      lf.topics = res.topics
    }
    lf.partialErrors = Array.isArray(res && res.partialErrors) ? res.partialErrors : []
    lf.loaded = true
  } catch (error) {
    lf.error = error.message
  } finally {
    lf.loading = false
    render()
  }
}

async function quickSubscribeArxivTarget(label, domainId, categoryCode) {
  try {
    const settingsRes = await rpc('settings.get')
    const cfg = (settingsRes && settingsRes.config) || {}
    const items = Array.isArray(cfg.topics && cfg.topics.items) ? cfg.topics.items.map((it) => ({ ...it })) : buildDefaultTopicItems(cfg.topics && cfg.topics.subscribed)
    const cats = categoryCode ? [categoryCode] : (FALLBACK_ARXIV_DOMAINS.find((d) => d.id === domainId)?.categories || []).map((c) => c.code)
    const existed = items.find((it) => Array.isArray(it.categories) && it.categories.length === cats.length && it.categories.every((c) => cats.includes(c)))
    if (existed) {
      existed.enabled = true
    } else {
      items.unshift({
        id: 'sub-' + (categoryCode || domainId).replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase(),
        label,
        domain: domainId || 'custom',
        categories: cats,
        keywords: [],
        enabled: true,
      })
    }
    const saved = await rpc('settings.set', {
      patch: {
        topics: {
          items,
          custom: (cfg.topics && cfg.topics.custom) || [],
          feedSource: (cfg.topics && cfg.topics.feedSource) || 'arxiv',
        },
      },
    })
    if (saved && saved.config) state.fullConfig = saved.config
    toast('已加入我的订阅方向：' + label)
    render()
  } catch (error) {
    toast('添加订阅失败：' + error.message)
  }
}

function renderOnlineResultCard(item) {
  const pubDate = item.publishedAt || item.published || ''
  const dateTag = pubDate ? String(pubDate).slice(0, 10) : item.year || ''
  return h(
    'div',
    { class: 'result' },
    h('div', { class: 't' }, item.title),
    h(
      'div',
      { class: 'a' },
      item.source ? h('span', { class: 'badge' }, item.source) : null,
      dateTag ? h('span', { class: 'badge' }, String(dateTag)) : null,
      Array.isArray(item.categories) && item.categories.length ? h('span', { class: 'badge' }, item.categories[0]) : null,
      [fmtAuthors(item.authors), item.venue].filter(Boolean).join(' · '),
    ),
    h('div', { class: 'abs' }, item.abstract || ''),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary',
          disabled: state.busy === 'import:' + item.title,
          onclick: async () => {
            state.busy = 'import:' + item.title
            render()
            try {
              const value = await rpc('search.import', { item })
              toast('已入库：' + value.meta.title)
              await loadLibrary()
              if (value.meta) openPaper(value.meta.id)
            } catch (error) {
              toast('入库失败：' + error.message)
            } finally {
              state.busy = ''
              render()
            }
          },
        },
        item.pdfUrl ? '下载并入库' : '无开放 PDF',
      ),
      item.url || item.absUrl ? h('button', { onclick: () => window.open(item.url || item.absUrl, '_blank', 'noopener') }, '打开原文页') : null,
      h('button', { onclick: () => insertGeneralPrompt('帮我查找并研读这篇论文：' + item.title + (item.doi ? '（DOI ' + item.doi + '）' : '') + '，提炼研究动机、方法设计与核心结论。') }, '让 agent 读'),
    ),
  )
}

function renderOnline() {
  const box = h('div', { class: 'online' })
  box.append(
    h(
      'div',
      { class: 'online-bar' },
      h('input', {
        type: 'search',
        placeholder: '关键词 / arXiv ID / DOI，例如：prompt tuning、quant-ph 或 2103.10385',
        value: state.online.q,
        oninput: (event) => {
          state.online.q = event.target.value
        },
        onkeydown: (event) => {
          if (event.key === 'Enter') doSearch()
        },
      }),
      h(
        'select',
        {
          onchange: (event) => {
            state.online.source = event.target.value
          },
        },
        h('option', { value: 'both', selected: state.online.source === 'both' }, 'arXiv + OpenAlex'),
        h('option', { value: 'arxiv', selected: state.online.source === 'arxiv' }, '仅 arXiv'),
        h('option', { value: 'openalex', selected: state.online.source === 'openalex' }, '仅 OpenAlex'),
      ),
      h('button', { class: 'primary', onclick: doSearch, disabled: state.online.loading }, state.online.loading ? '检索中…' : '检索'),
      state.online.items.length > 0
        ? h('button', { class: 'ghost', onclick: () => { state.online.items = []; state.online.error = ''; render() } }, '返回学科与订阅流')
        : null,
      obsidianEnabled()
        ? h('button', { onclick: () => insertGeneralPrompt(P.vaultSearch(state.online.q || '论文')) }, '问笔记库')
        : h('button', { onclick: () => insertGeneralPrompt('请在当前工作台文献库中梳理与「' + (state.online.q || '论文') + '」相关的已有工作、方法差异与研究空白。') }, '问文献库'),
    ),
  )
  if (state.online.error) box.append(h('div', { class: 'error' }, state.online.error))
  if (Array.isArray(state.online.warnings) && state.online.warnings.length > 0) {
    box.append(h('div', { class: 'hint' }, '提示：' + state.online.warnings.join('；')))
  }
  for (const item of state.online.items) {
    box.append(renderOnlineResultCard(item))
  }

  if (state.online.items.length === 0) {
    const lf = state.latestFeed
    const domainsCatalog = lf.domains && lf.domains.length ? lf.domains : FALLBACK_ARXIV_DOMAINS
    const cfgItems = state.fullConfig && state.fullConfig.topics && Array.isArray(state.fullConfig.topics.items) ? state.fullConfig.topics.items : null
    const subIds = (state.fullConfig && state.fullConfig.topics && state.fullConfig.topics.subscribed) || ['llm-agents', 'multimodal-ocr', 'efficient-training']
    const activeSubs = cfgItems
      ? cfgItems.filter((it) => it.enabled)
      : (lf.topics && lf.topics.length ? lf.topics : FALLBACK_TOPIC_PRESETS).filter((t) => subIds.includes(t.id))
    const activeDomain = lf.mode === 'domain' ? domainsCatalog.find((d) => d.id === lf.domainId) || null : null
    const canFetchLive = Boolean(state.fullConfig?.topics || state.health?.obsidian !== undefined)

    const feedPanel = h('div', { class: 'feed-panel' })
    feedPanel.append(
      h(
        'div',
        { class: 'feed-head' },
        h('strong', {}, activeDomain ? 'arXiv 学科最新论文 · ' + activeDomain.label : '订阅主题与全学科最新论文'),
        h('span', { class: 'hint' }, '按发布时间倒序'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', disabled: lf.loading, onclick: () => loadLatestFeed(true) }, lf.loading ? '刷新中…' : '↻ 刷新最新'),
        h('button', { class: 'ghost', onclick: openSettings }, '⚙ 订阅与代理设置'),
      ),
      h(
        'div',
        { class: 'domain-nav' },
        h(
          'div',
          { class: 'domain-row' },
          h('span', { class: 'domain-row-label' }, '学科导航'),
          h(
            'button',
            {
              type: 'button',
              class: 'domain-pill' + (lf.mode !== 'domain' ? ' active' : ''),
              onclick: () => {
                lf.mode = 'subs'
                lf.domainId = ''
                lf.category = ''
                lf.topicFilter = 'all'
                if (canFetchLive) loadLatestFeed(false)
                else render()
              },
            },
            '★ 我的订阅',
          ),
          domainsCatalog.map((d) =>
            h(
              'button',
              {
                type: 'button',
                class: 'domain-pill' + (lf.mode === 'domain' && lf.domainId === d.id ? ' active' : ''),
                'data-domain': d.id,
                onclick: () => {
                  lf.mode = 'domain'
                  lf.domainId = d.id
                  lf.category = ''
                  if (canFetchLive) loadLatestFeed(false)
                  else render()
                },
              },
              d.label,
            ),
          ),
        ),
        activeDomain
          ? h(
              'div',
              { class: 'subcat-row' },
              h('span', { class: 'domain-row-label' }, '细分方向'),
              h(
                'button',
                {
                  type: 'button',
                  class: 'subcat-pill' + (!lf.category ? ' active' : ''),
                  onclick: () => {
                    lf.category = ''
                    if (canFetchLive) loadLatestFeed(false)
                    else render()
                  },
                },
                '全部 ' + activeDomain.label,
              ),
              activeDomain.categories.map((cat) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'subcat-pill' + (lf.category === cat.code ? ' active' : ''),
                    'data-cat': cat.code,
                    onclick: () => {
                      lf.category = cat.code
                      if (canFetchLive) loadLatestFeed(false)
                      else render()
                    },
                  },
                  cat.label + ' (' + cat.code + ')',
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'ghost',
                  onclick: () => {
                    const catMeta = lf.category ? activeDomain.categories.find((c) => c.code === lf.category) : null
                    const subLabel = catMeta ? catMeta.label + ' (' + catMeta.code + ')' : activeDomain.label
                    quickSubscribeArxivTarget(subLabel, activeDomain.id, lf.category || '')
                  },
                },
                '＋ 订阅当前方向',
              ),
            )
          : h(
              'div',
              { class: 'topic-pills' },
              h(
                'button',
                {
                  class: 'topic-pill' + (lf.topicFilter === 'all' ? ' active' : ''),
                  onclick: () => {
                    lf.topicFilter = 'all'
                    if (canFetchLive) loadLatestFeed(false)
                    else render()
                  },
                },
                '全部订阅',
              ),
              activeSubs.map((t) =>
                h(
                  'button',
                  {
                    class: 'topic-pill' + (lf.topicFilter === t.id ? ' active' : ''),
                    onclick: () => {
                      lf.topicFilter = t.id
                      if (canFetchLive) loadLatestFeed(false)
                      else render()
                    },
                  },
                  t.label,
                ),
              ),
              h('button', { type: 'button', class: 'subcat-pill', onclick: openSettings }, '＋ 添加/编辑方向'),
            ),
      ),
    )
    if (lf.error) {
      feedPanel.append(
        h(
          'div',
          { class: 'error' },
          '最新论文拉取失败：' + lf.error + '（若本机需走代理访问 arXiv，请点右上角「⚙ 订阅与代理设置」配置代理并测试连通性）',
        ),
      )
    } else if (Array.isArray(lf.partialErrors) && lf.partialErrors.length > 0 && lf.items.length === 0) {
      feedPanel.append(
        h(
          'div',
          { class: 'error' },
          '拉取受阻：' + lf.partialErrors[0].message + '（请点「⚙ 订阅与代理设置 → 网络与代理」检查代理端口并测试网络连通）',
        ),
      )
    }
    const feedItems = lf.items.filter((item) => {
      if (lf.mode === 'domain' || !lf.topicFilter || lf.topicFilter === 'all') return true
      if (Array.isArray(item.topics) && item.topics.includes(lf.topicFilter)) return true
      if (Array.isArray(item.topicIds) && item.topicIds.includes(lf.topicFilter)) return true
      if (Array.isArray(item.matchedTopics) && item.matchedTopics.includes(lf.topicFilter)) return true
      return true
    })
    for (const item of feedItems) feedPanel.append(renderOnlineResultCard(item))
    if (!lf.loading && feedItems.length === 0 && !lf.error && !(lf.partialErrors && lf.partialErrors.length > 0)) {
      feedPanel.append(h('div', { class: 'hint' }, lf.loaded ? '当前筛选方向暂无最新论文，可切换上方 8 大学科标签或点「↻ 刷新最新」。' : '正在准备订阅流，也可直接点击上方 8 大学科浏览最新 arXiv 预印本。'))
    }
    box.append(feedPanel)
  }
  return h('div', { class: 'content' }, box)
}

async function doSearch() {
  const query = String(state.online.q || '').trim()
  if (!query) return
  state.online.loading = true
  state.online.error = ''
  state.online.warnings = []
  render()
  try {
    const value = await rpc('search.online', { query, source: state.online.source, limit: 10 })
    state.online.items = value.items || []
    state.online.warnings = Array.isArray(value.warnings) ? value.warnings : []
  } catch (error) {
    state.online.error = '检索失败：' + error.message
  } finally {
    state.online.loading = false
    render()
  }
}

function comparePicked() {
  const items = state.papers.filter((paper) => state.picked.has(paper.id))
  if (items.length < 2) {
    toast('至少选 2 篇才能对比')
    return
  }
  if (NATIVE_READER) askNative(P.compare(items), { scope: 'papers', paperIds: items.map(paper => paper.id) })
  else insertPrompt(P.compare(items))
}

// ---------------------------------------------------------------- 导入（保留）

async function importByPath() {
  const value = window.prompt('输入 PDF 的绝对路径：\n（示例：G:\\笔记\\LLM知识体系论文\\高效微调\\Prompt Tuning.pdf）')
  if (!value) return
  try {
    const result = await rpc('library.importPath', { path: value.trim() })
    toast(result.existed ? '这篇已经在库里：' + result.meta.title : '已入库：' + result.meta.title)
    await loadLibrary()
    openPaper(result.meta.id)
  } catch (error) {
    toast('导入失败：' + error.message)
  }
}

function uploadPdf() {
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf' })
  input.onchange = async () => {
    const file = input.files && input.files[0]
    if (!file) return
    try {
      const url = API + 'upload?name=' + encodeURIComponent(file.name)
      const response = await fetch(url, { method: 'POST', body: await file.arrayBuffer() })
      const data = await response.json().catch(() => ({ ok: false, error: 'HTTP ' + response.status }))
      if (!data.ok) throw new Error(data.error)
      toast('已入库：' + data.value.meta.title)
      await loadLibrary()
      openPaper(data.value.meta.id)
    } catch (error) {
      toast('上传失败：' + error.message)
    }
  }
  input.click()
}

async function importFromDir() {
  const dir = window.prompt('输入本地论文文件夹的绝对路径（会递归扫描子文件夹里的 .pdf 并以文件夹名作分组）：')
  if (!dir || !dir.trim()) return
  toast('正在批量扫描目录导入 PDF…')
  try {
    const value = await rpc('library.importDir', { dir: dir.trim(), recursive: true })
    toast('扫描 ' + value.scanned + ' 份 PDF，新入库 ' + value.imported.length + ' 篇，跳过 ' + value.skipped.length + ' 篇')
    await loadLibrary()
    render()
  } catch (error) {
    toast('目录导入失败：' + error.message)
  }
}

async function importFromVault() {
  toast('正在扫描 Obsidian 卡片…')
  try {
    const value = await rpc('library.importFromVault')
    toast('扫描 ' + value.scanned + ' 张卡片，新入库 ' + value.imported.length + ' 篇，跳过 ' + value.skipped.length + ' 篇')
    await loadLibrary()
    render()
  } catch (error) {
    toast('导入失败：' + error.message)
  }
}

// ---------------------------------------------------------------- 划词菜单 / 高亮

let floating = null
let floatingShownAt = 0

function hideFloating() {
  if (floating) {
    floating.remove()
    floating = null
  }
  state.selection = null
}

function showFloating(x, y, text) {
  hideFloating()
  const meta = state.current && state.current.meta
  if (!meta) return
  rememberReaderSelection(text)
  const rich = captureRichSelectionSnapshot(window.getSelection(), text)
  const pageRects = selectionMemory.pageRects || null
  const snapshot = {
    keys: selectionMemory.keys || [],
    host: selectionMemory.host || null,
    pageRects,
    rich,
  }
  state.selection = { text, ...snapshot }
  floatingShownAt = Date.now()
  const vw = Number(window.innerWidth) || 1200
  const vh = Number(window.innerHeight) || 800
  const safeX = Number.isFinite(x) ? x : 16
  const safeY = Number.isFinite(y) ? y : 64
  const left = Math.max(8, Math.min(Math.max(8, vw - 390), safeX))
  const desiredTop = safeY < 72 ? Math.max(8, safeY) + 28 : safeY - (rich ? 74 : 46)
  const top = Math.max(8, Math.min(Math.max(8, vh - 86), desiredTop))
  const rectHint = { left, top: top + 36 }
  floating = h(
    'div',
    {
      class: 'floating-menu' + (rich ? ' floating-two-row' : ''),
      style: { left: left + 'px', top: top + 'px' },
      onmousedown: (event) => event.preventDefault(),
    },
    rich
      ? h(
          'div',
          { class: 'floating-row floating-row-ann' },
          ['yellow', 'green', 'blue', 'pink', 'purple'].map((c) =>
            h('button', {
              type: 'button',
              class: 'floating-dot c-' + c,
              title: '高亮 (' + c + ')',
              onclick: () => {
                hideFloating()
                createRichAnnotation('highlight', c, '', rich)
              },
            }),
          ),
          h('button', { type: 'button', onclick: () => { hideFloating(); createRichAnnotation('underline', 'blue', '', rich) } }, '下划线'),
          h('button', { type: 'button', onclick: () => { hideFloating(); createRichAnnotation('bold', 'yellow', '', rich) } }, '加粗'),
          h('button', { type: 'button', onclick: (event) => { event && event.stopPropagation && event.stopPropagation(); hideFloating(); openAnnotationPopover({ ...rich, kind: 'comment', color: 'yellow', note: '' }, rectHint) } }, '💬 批注'),
          h('button', { type: 'button', onclick: (event) => { event && event.stopPropagation && event.stopPropagation(); hideFloating(); openAnnotationPopover({ ...rich, kind: 'insert', color: 'purple', note: '' }, rectHint) } }, '‹+› 插入'),
          annotationsFor(rich.paragraphKey).some((a) => (a.target || 'orig') === rich.target && !(a.endOffset <= rich.startOffset || a.startOffset >= rich.endOffset))
            ? h('button', { type: 'button', onclick: () => { hideFloating(); clearParagraphAnnotations(rich.paragraphKey, rich) } }, '清除')
            : null,
        )
      : null,
    h(
      'div',
      { class: 'floating-row' },
      h('button', { class: 'primary-soft', title: '自动结合全篇上下文，针对公式/算法/实验/概念自适应深度拆解', onclick: () => { const selected = text; hideFloating(); askSelection(selected) } }, '讲解选中'),
      h('button', { title: '将选中文本与页码引用填入右侧输入框，由你输入具体追问', onclick: () => { const selected = text; hideFloating(); draftSelection(selected) } }, '引用追问'),
      h('button', { title: '就地打开划词精译卡片（即使本段已翻译也立即呈现片段译文）', onclick: () => { const selected = text; hideFloating(); translateSelection(selected, snapshot) } }, '翻译'),
      h('button', { onclick: () => { rich ? createRichAnnotation('highlight', 'yellow', '', rich) : addHighlight(text, snapshot.pageRects); hideFloating() } }, '高亮'),
      h('button', { onclick: () => { copyText(text); hideFloating() } }, '复制'),
    ),
  )
  document.body.append(floating)
}

function askSelection(text, explicitSource = null) {
  if (!state.current) return
  if (String(text || '').trim().length < 2) {
    toast('没拿到选中的正文，请重新划选一段再点')
    return
  }
  if (!NATIVE_READER && !state.layout.chatOpen) {
    state.layout.chatOpen = true
    saveLayout()
  }
  sendChat('讲解这段选中的原文：\n> ' + String(text), chatContext({ selection: String(text), ...(explicitSource ? { explicitSource } : {}) }))
}

/**
 * 划词翻译：统一打开就地锚定的「划词精译卡片」（.sel-trans），
 * 即便所在整段已有译文也能立即看到所选短句的精准译文；同时在卡片内提供「重译整段」入口。
 */
function translateSelection(text, snapshot = null) {
  const liveKeys = selectionParagraphKeys()
  const rememberedKeys =
    selectionMemory.paperId === state.current?.meta?.id && Date.now() - selectionMemory.at < SELECTION_MEMORY_MS
      ? selectionMemory.keys || []
      : []
  const keys = liveKeys.length ? liveKeys : (snapshot?.keys?.length ? snapshot.keys : rememberedKeys)
  const host = selectionHostNode() || snapshot?.host || selectionMemory.host || null
  // 旧版宿主没有 ad-hoc 接口时兜底整段翻译
  if (!(state.health && state.health.ai && state.health.ai.adhoc)) {
    if (keys.length) {
      translateKeys(keys)
      return
    }
    toast('原文页划词翻译要重启桌面端后才生效')
    return
  }
  let contextText = ''
  if (keys.length > 0 && state.doc && Array.isArray(state.doc.paragraphs)) {
    const owner = state.doc.paragraphs.find((p) => paragraphKey(p) === keys[0])
    if (owner && owner.text && String(owner.text).trim() !== String(text || '').trim()) {
      contextText = String(owner.text)
    }
  }
  const paperTitle = String((state.current && state.current.meta && state.current.meta.title) || '')
  translateSelectionCard(String(text || ''), host, {
    keys,
    contextText,
    paperTitle,
    rich: snapshot?.rich || null,
    pageRects: snapshot?.pageRects || selectionMemory.pageRects || null,
  })
}

/** 选区覆盖到的段落 key（对照视图才有；跨段拖选会命中多段）。 */
function selectionParagraphKeys() {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return []
  const range = selection.getRangeAt(0)
  const keys = []
  for (const para of document.querySelectorAll('.para[data-key]')) {
    const key = para.getAttribute('data-key')
    if (!key) continue
    try {
      if (!range.intersectsNode(para)) continue
    } catch {
      continue
    }
    keys.push(key)
  }
  return keys
}

/**
 * 一次性划词精译卡片：走 /ai/translate 的 ad-hoc 分支（附带所在段落只读消歧上下文），
 * 不写 trans 表、不污染对话历史，提供「复制译文」「存为批注」「重译整段」快捷动作。
 */
async function translateSelectionCard(text, fallbackHost = null, extra = {}) {
  const value = String(text || '').trim()
  if (value.length < 2 || !state.current) return
  if (!(state.health && state.health.ai && state.health.ai.adhoc)) {
    toast('划词精译需要重启桌面端后生效')
    return
  }
  const host = selectionHostNode() || fallbackHost
  const old = document.querySelector('.sel-trans')
  if (old) old.remove()
  const body = h('div', { class: 'zh-text' }, '正在精译所选片段…')
  let finalZh = ''
  const keys = Array.isArray(extra.keys) ? extra.keys.filter(Boolean) : []

  const isPageWrapHost = Boolean(host && host.classList && host.classList.contains('page-wrap'))
  const pr = extra.pageRects && Array.isArray(extra.pageRects.rects) && extra.pageRects.rects.length > 0 ? extra.pageRects.rects[extra.pageRects.rects.length - 1] : null
  const cardStyle =
    isPageWrapHost && pr
      ? { position: 'absolute', left: '20px', right: '20px', top: Math.min(86, Math.max(4, (pr.y + pr.h) * 100 + 1)).toFixed(2) + '%', zIndex: '8' }
      : undefined

  const card = h(
    'div',
    {
      class: 'sel-trans',
      ...(cardStyle ? { style: cardStyle } : {}),
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => e.stopPropagation(),
    },
    h(
      'div',
      { class: 'sel-trans-head' },
      h('strong', {}, '划词精译'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'link', onclick: () => card.remove() }, '关闭'),
    ),
    h('div', { class: 'sel-trans-quote' }, value.length > 160 ? value.slice(0, 160) + '…' : value),
    body,
    h(
      'div',
      { class: 'sel-trans-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'link',
          onclick: () => {
            if (finalZh) copyText(finalZh)
            else toast('译文生成中，请稍候')
          },
        },
        '复制译文',
      ),
      extra.rich
        ? h(
            'button',
            {
              type: 'button',
              class: 'link',
              onclick: async () => {
                if (!finalZh) { toast('译文生成中，请稍候'); return }
                card.remove()
                await saveRichAnnotation({
                  paragraphKey: extra.rich.paragraphKey,
                  target: extra.rich.target || 'orig',
                  kind: 'comment',
                  color: 'blue',
                  startOffset: extra.rich.startOffset,
                  endOffset: extra.rich.endOffset,
                  quote: extra.rich.quote || value,
                  prefix: extra.rich.prefix || '',
                  suffix: extra.rich.suffix || '',
                  note: '【划词译文】' + finalZh,
                  page: extra.rich.page || state.page || 1,
                  sectionId: extra.rich.sectionId || null,
                  blockId: extra.rich.blockId || null,
                })
              },
            },
            '存为批注',
          )
        : null,
      keys.length > 0
        ? h(
            'button',
            {
              type: 'button',
              class: 'link',
              title: '重新翻译并覆盖整段译文缓存',
              onclick: () => {
                card.remove()
                translateKeys(keys)
              },
            },
            '重译整段',
          )
        : null,
    ),
  )

  if (isPageWrapHost && pr) {
    host.append(card)
  } else if (host && host.parentElement && host.isConnected !== false) {
    host.parentElement.insertBefore(card, host.nextSibling)
  } else {
    ;(document.querySelector('.page-pane .stage, .compare, .pane, .blocks') || document.body).prepend(card)
  }

  let accumulated = ''
  try {
    await streamSse(
      TRANSLATE_URL,
      {
        id: state.current.meta.id,
        text: value,
        ...(extra.contextText ? { contextText: extra.contextText } : {}),
        ...(extra.paperTitle ? { paperTitle: extra.paperTitle } : {}),
        reqId: genId(),
      },
      {
        start() {},
        delta(data) {
          accumulated += String((data && data.text) || '')
          finalZh = accumulated.trim()
          body.textContent = accumulated
        },
        done(data) {
          const final = String((data && data.text) || accumulated || '').trim()
          finalZh = final
          body.textContent = final || '（模型没有返回译文）'
        },
        error(data) {
          body.textContent = '翻译失败：' + String((data && data.message) || '未知错误')
        },
        end() {},
      },
      new AbortController().signal,
    )
  } catch (error) {
    body.textContent = '翻译失败：' + error.message
  }
}

async function addHighlight(text, capturedPageRects = null) {
  const note = window.prompt('给这段高亮加个备注（可留空）：') || ''
  const notes = state.current.notes || { highlights: [] }
  let page = state.page
  let rects = []
  const liveRects = capturePageSelectionRects() || capturedPageRects || selectionMemory.pageRects
  if (liveRects && Array.isArray(liveRects.rects) && liveRects.rects.length > 0) {
    page = liveRects.page || page
    rects = liveRects.rects
  } else {
    const block = state.blocks.find((item) => String(item.text || '').includes(text.slice(0, 24)))
    if (block && state.pageInfo && block.x2 !== undefined) {
      rects.push({
        x: block.x / state.pageInfo.w,
        y: block.y / state.pageInfo.h,
        w: (block.x2 - block.x) / state.pageInfo.w,
        h: (block.y2 - block.y) / state.pageInfo.h,
      })
    }
  }
  const highlights = (notes.highlights || []).concat([{ page, text, note, rects, color: 'yellow', at: new Date().toISOString() }])
  await saveNotes(highlights)
  toast('已保存高亮')
}

// ---------------------------------------------------------------- 会话注入（次要通道）

function insertPrompt(text) {
  if (NATIVE_READER) return askNative(text, { scope: 'paper' })
  window.parent.postMessage({ __pb: true, type: 'insert-prompt', text }, location.origin)
  toast('已写入当前会话输入框，回到对话里发送即可')
}

function insertGeneralPrompt(text) {
  if (NATIVE_READER) return askNative(text, { scope: 'general' })
  window.parent.postMessage({ __pb: true, type: 'insert-prompt', text }, location.origin)
  toast('已写入当前会话输入框，回到对话里发送即可')
}

const P = {
  guide: (m) =>
    '请给我一份论文《' + m.title + '》（id="' + m.id + '"）的「3 分钟阅读导览」：\n' +
    '1. 先用 paper_doc（id="' + m.id + '"，sections="outline"）与 paper_read 查看摘要、引言和结论；\n' +
    '2. 按四个层次简洁输出：\n' +
    '   - 核心痛点：现有工作卡在哪里？\n' +
    '   - 核心直觉（Aha Moment）：这篇论文最关键的设计巧思是什么？\n' +
    '   - 关键证据：最能支撑结论的 2-3 组实验/消融是什么（严禁编造数字）？\n' +
    '   - 阅读路线建议：哪些章节/图表最值得精读，哪些可略读？\n' +
    '3. 每条关键判断后保留工具返回的完整论文引用链接（或 [p.N]）。',
  summarize: (m) =>
    '请系统总结论文《' + m.title + '》（id="' + m.id + '"）的研究问题、核心方法架构、主要实验结论与局限性：\n' +
    '- 按需调用 paper_doc / paper_read 核对正文与实验表，严禁凭记忆猜数字；\n' +
    '- 涉及核心公式或机制时保留原符号并用通俗直觉解释；\n' +
    '- 每条结论后附完整论文引用链接（或 [p.N]），点击即可跳回阅读器对应位置。',
  deepRead: (m) =>
    '请精读这篇论文并把结构化研读报告落到 Obsidian。\n标题：《' + m.title + '》\n库内 id：' + m.id + '\n\n步骤：\n1. 调用 paper_doc / paper_read（id="' + m.id + '"，按章节完整覆盖摘要、方法、实验与局限）读透全文；\n2. 用中文输出七节报告：摘要、研究问题与动机、核心方法（含关键公式与符号解释）、主要贡献、实验设置与核心结论、局限与边界条件、可复现实现要点；\n3. 调用 paper_obsidian（id="' + m.id + '"，report=<报告全文>）把报告写进卡片。\n\n要求：每条事实与实验结论后标注页码引用（如 [p.N]），绝不编造实验指标或对比基线。',
  askSelection: (m, text) =>
    '关于论文《' + m.title + '》（id="' + m.id + '"），我选中了这段原文：\n> ' + String(text) + '\n\n请用中文准确拆解它的技术含义、关键符号/术语定义，以及它在整篇论文论证链条中的作用；必要时用 paper_doc / paper_read（id="' + m.id + '"）回看上下文，并附上可点击的原文引用。',
  syncCard: (m) =>
    '请把论文《' + m.title + '》（id="' + m.id + '"）的知识化字段写进 Obsidian 卡片：\n先用 paper_doc / paper_read 核对全文核心内容，然后调用 paper_obsidian（id="' + m.id + '", sections={"一句话结论": "...", "研究问题": "...", "方法线索": "...", "应用场景": "...", "局限线索": "..."}）。\n每个字段 1-2 句，信息密度高、忠于原文实验与方法细节，不要空话套话。',
  compare: (items) =>
    '请对比下面几篇论文，写一篇高质量中文主题综述（注重脉络演进与横向洞察，不要写成孤立的逐篇摘要拼接）：\n' +
    items.map((m, i) => i + 1 + '. 《' + m.title + '》 id="' + m.id + '"').join('\n') +
    '\n\n步骤：\n1. 用 paper_doc / paper_read 逐篇核对摘要、方法骨架与主实验表；\n2. 先给一张清晰的多维对比表（问题设定 / 核心机制 / 复杂度或代价 / 数据集与关键指标 / 适用边界）；\n3. 再分析技术演进脉络：核心共识、路线分歧、trade-off 以及尚未解决的开放问题；\n4. 引用具体结论时明确标出所属论文与页码引用；最后用 paper_obsidian（action="survey", topic="<主题名>", markdown=<综述全文>）写入「方向综述」。',
  vaultSearch: (query) =>
    '请在 Obsidian 论文知识库里检索与「' + query + '」相关的卡片（paper_obsidian action="search", query="' + query + '"），按技术路线归纳已有论文的核心结论、方法异同与当前知识空白。',
}

// ---------------------------------------------------------------- 全局事件

document.addEventListener('selectionchange', () => {
  const text = liveReaderSelection()
  rememberReaderSelection(text)
  flushDeferredRender()
})

document.addEventListener('mouseup', (event) => {
  if (floating && floating.contains(event.target)) return
  if (state.annPopover && state.annPopover.el && state.annPopover.el.contains(event.target)) return
  const text = selectionText()
  const target = event.target
  // 划词只对正文/对话区域生效；点在按钮、输入框、目录上不弹菜单
  const inText = target && target.closest && target.closest('.compare, .page-pane, .markdown, .blocks, .chat-messages')
  if (inText && text.length >= 2 && state.current) {
    const range = window.getSelection().getRangeAt(0)
    const rect = range.getBoundingClientRect()
    showFloating(rect.left, rect.top, text)
  } else if (!floating) {
    hideFloating()
  }
})

document.addEventListener('click', (event) => {
  const justOpenedAnn = state.annPopover && Date.now() - (state.annPopover.openedAt || 0) < 120
  if (state.annPopover && state.annPopover.el && !justOpenedAnn && !state.annPopover.el.contains(event.target)) {
    closeAnnotationPopover()
  }
  // 拖选结束时浏览器会在鼠标松开处补一个 click（跨段选择时它落在 .compare 上），
  // 不能让它把刚弹出来的划词菜单立刻关掉——那会让「问 AI」永远点不到。
  const justShown = floating && Date.now() - floatingShownAt < 300
  if (floating && !floating.contains(event.target) && !justShown) hideFloating()
  const cite = event.target instanceof Element ? event.target.closest('.cite') : null
  if (cite) {
    event.preventDefault()
    const page = Number(cite.getAttribute('data-page')) || 1
    jumpToPage(page)
  }
})

// ---------------------------------------------------------------- 启动

// ---------------------------------------------------------------- v3：搜索 / 深色 / 回收站 / 日志 / 自检 / 配图 / 原生会话

const DARK_KEY = 'paper-workbench.dark'

function loadDark() {
  try {
    const value = Number(localStorage.getItem(DARK_KEY) || 0)
    return Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 0
  } catch {
    return 0
  }
}

function applyDark() {
  document.body.classList.toggle('pdf-dark', state.dark >= 1)
  document.body.classList.toggle('pdf-dark-strong', state.dark >= 2)
}

function cycleDark() {
  state.dark = (state.dark + 1) % 3
  try {
    localStorage.setItem(DARK_KEY, String(state.dark))
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略 */
  }
  applyDark()
  saveSessionSoon({ dark: state.dark })
  toast(state.dark === 0 ? 'PDF 深色：关' : state.dark === 1 ? 'PDF 深色：柔和' : 'PDF 深色：强')
  render()
}

function cssKey(value) {
  const text = String(value || '')
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(text)
  return text.replace(/["\\]/g, '\\$&')
}

/** v3 的接口（搜索/日志/自检/回收站/配图/会话）只在 p3 宿主上存在；旧宿主给一句可操作的提示。 */
function hostReady() {
  return !!(state.health && state.health.phase === 'p3')
}

function needRestart() {
  toast('这个功能要重启桌面端（宿主代码只在插件加载时执行一次）')
}

// --- 文内搜索（搜文档模型，不重新解析 PDF）

function openSearch() {
  if (!hostReady()) {
    needRestart()
    return
  }
  if (!state.current) {
    toast('先打开一篇论文')
    return
  }
  state.search.open = true
  render()
  setTimeout(() => {
    const input = document.querySelector('#search-input')
    if (input) {
      input.focus()
      input.select()
    }
  }, 30)
}

function closeSearch() {
  state.search.open = false
  state.search.error = ''
  render()
}

async function runSearch(query) {
  if (!state.current) return
  const id = state.current.meta.id
  const seq = state.openSeq
  const stale = () => seq !== state.openSeq || !state.current || state.current.meta.id !== id
  const q = String(query || '').trim()
  state.search.q = q
  state.search.error = ''
  if (!q) {
    state.search.hits = []
    render()
    return
  }
  state.search.busy = true
  render()
  try {
    const value = await rpc('search.doc', { id, query: q, limit: 120 })
    if (stale()) return
    state.search.hits = Array.isArray(value.hits) ? value.hits : []
    state.search.active = 0
    if (state.search.hits.length === 0) state.search.error = '没有命中'
  } catch (error) {
    if (stale()) return
    state.search.hits = []
    state.search.error = error.message
  }
  if (stale()) return
  state.search.busy = false
  render()
  if (state.search.hits.length) gotoSearchHit(0)
}

function gotoSearchHit(index) {
  const hit = state.search.hits[index]
  if (!hit) return
  state.search.active = index
  if (hit.kind === 'title' && hit.sectionId) {
    const section = sectionsOf().find((item) => item.id === hit.sectionId)
    if (section) {
      state.search.open = false
      jumpToSection(section)
      return
    }
  }
  if (state.tab === 'page') {
    state.search.open = false
    jumpToPage(hit.page || 1)
    return
  }
  if (state.tab !== 'compare') {
    state.tab = 'compare'
    state.search.open = false
    render()
  }
  const node = document.querySelector('.para[data-key="' + cssKey(hit.key) + '"]')
  if (node) {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node.classList.add('flash')
    setTimeout(() => node.classList.remove('flash'), 1600)
    // 这里不能再 render()：整页重绘会把滚动位置拉回顶部、flash 节点也被换掉
  } else {
    state.search.open = false
    jumpToPage(hit.page || 1)
  }
}

function renderSearchOverlay() {
  const s = state.search
  return h(
    'div',
    {
      class: 'overlay',
      onclick: (event) => {
        if (event.target === event.currentTarget) closeSearch()
      },
    },
    h(
      'div',
      { class: 'search-box' },
      h(
        'div',
        { class: 'search-head' },
        h('input', {
          id: 'search-input',
          class: 'search-input',
          placeholder: '在全文里搜（段落 / 标题）…',
          value: s.q,
          oninput: (event) => {
            s.q = event.target.value
          },
          onkeydown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              runSearch(s.q)
            } else if (event.key === 'Escape') {
              closeSearch()
            }
          },
        }),
        h('button', { class: 'primary', onclick: () => runSearch(s.q) }, s.busy ? '搜索中…' : '搜索'),
        h('button', { class: 'ghost', onclick: closeSearch }, '关闭'),
      ),
      h(
        'div',
        { class: 'search-meta' },
        h('span', { class: 'hint' }, s.hits.length ? s.active + 1 + ' / ' + s.hits.length + ' 处命中（点条目跳转，Esc 关闭）' : s.error || '回车搜索；搜索范围是当前文档模型的段落与标题'),
        h('span', { class: 'spacer' }),
        s.hits.length
          ? h('button', { class: 'ghost', onclick: () => gotoSearchHit((s.active + s.hits.length - 1) % s.hits.length) }, '上一处')
          : null,
        s.hits.length ? h('button', { class: 'ghost', onclick: () => gotoSearchHit((s.active + 1) % s.hits.length) }, '下一处') : null,
      ),
      h(
        'div',
        { class: 'search-list' },
        ...s.hits.map((hit, index) =>
          h(
            'button',
            { class: 'search-hit' + (index === s.active ? ' active' : ''), onclick: () => gotoSearchHit(index) },
            h('span', { class: 'search-page' }, 'p.' + (hit.page || '?')),
            h(
              'span',
              { class: 'search-snippet' },
              hit.before,
              h('mark', {}, hit.text.slice(hit.at, hit.at + s.q.length)),
              hit.after,
            ),
          ),
        ),
      ),
    ),
  )
}

// --- 配图（正文里按「图 N」插入）

async function loadFigures(seq) {
  if (!state.current) {
    state.figures = []
    state.figuresByKey = {}
    return
  }
  const id = state.current.meta.id
  const stale = () => (seq !== undefined && seq !== state.openSeq) || !state.current || state.current.meta.id !== id
  try {
    const value = await rpc('figures.list', { id })
    if (stale()) return
    state.figures = Array.isArray(value.figures) ? value.figures : []
  } catch {
    if (stale()) return
    state.figures = []
  }
  buildFiguresByKey()
}

/** 把配图按「正文里提到 图 N / Figure N 的段落」分组；与 lib/figures.js 的 assignFigures 同一套规则。 */
function buildFiguresByKey() {
  const map = {}
  state.figuresByKey = map
  const paragraphs = (state.doc && state.doc.paragraphs) || []
  // 版面模型给的图已经按位置渲染在「图块自己那一段」里了，不用再按图注/正文猜着挂
  const entries = (state.figures || [])
    .map((figure, position) => ({ figure, position }))
    .filter(({ figure }) => figure.attachOrder === undefined || figure.attachOrder === null)
  if (entries.length === 0) return
  const labelOf = (text) => {
    const match = /(?:图|圖|Figure|Fig\.?)\s*([0-9]+|[IVXLC]+)/i.exec(String(text || ''))
    if (!match) return null
    const raw = match[1].toUpperCase()
    if (/^[0-9]+$/.test(raw)) return Number(raw)
    const roman = { I: 1, V: 5, X: 10, L: 50, C: 100 }
    let total = 0
    for (let i = 0; i < raw.length; i += 1) {
      const cur = roman[raw[i]] || 0
      const next = roman[raw[i + 1]] || 0
      total += cur < next ? -cur : cur
    }
    return total || null
  }
  const used = new Set()
  // ① 图注段落先认领自己的图（与 lib/figures.js 一致）：图与图注不能分家
  for (const paragraph of paragraphs) {
    if ((paragraph.kind || 'body') !== 'caption') continue
    const label = labelOf(paragraph.text)
    if (!label) continue
    const key = paragraphKey(paragraph)
    if (!key) continue
    const hit = entries.find(
      ({ figure, position }) => !used.has(position) && Number(figure.label) === label &&
        Number(figure.page) === Number(paragraph.page))
    if (!hit) continue
    used.add(hit.position)
    if (!map[key]) map[key] = []
    map[key].push({ ...hit.figure, position: hit.position })
  }
  // ② 正文提到「图 N / Figure N」的段落
  for (const paragraph of paragraphs) {
    if ((paragraph.kind || 'body') !== 'body') continue
    const label = labelOf(paragraph.text)
    if (!label) continue
    const key = paragraphKey(paragraph)
    if (!key) continue
    const hits = entries.filter(({ figure, position }) => Number(figure.label) === label && !used.has(position))
    for (const { figure, position } of hits) {
      if (used.has(position)) continue
      used.add(position)
      if (!map[key]) map[key] = []
      map[key].push({ ...figure, position })
    }
  }
  // 没有 label 的图：按同页最近段落兜底，至少让读者能看到
  for (const { figure, position } of entries) {
    if (used.has(position)) continue
    if (figure.label) continue
    const samePage = paragraphs.find((paragraph) => Number(paragraph.page) === Number(figure.page))
    if (!samePage) continue
    const key = paragraphKey(samePage)
    if (!key) continue
    if (!map[key]) map[key] = []
    map[key].push({ ...figure, position })
    used.add(position)
  }
}

function renderInlineFigure(figure, ownCaption = false) {
  const src = API + 'figure?id=' + encodeURIComponent(state.current.meta.id) + '&index=' + figure.position
  const caption = figure.caption || '图 ' + (figure.label || figure.position + 1)
  const node = h(
    'figure',
    { class: 'inline-fig' },
    h('img', {
      src,
      alt: caption,
      loading: 'lazy',
      title: '点击看大图',
      onclick: () => window.open(src, '_blank', 'noopener'),
    }),
  )
  if (!ownCaption) node.append(h('figcaption', {}, caption))
  return node
}

// --- 版面解析（PP-StructureV3）

/**
 * 跑一次版面解析。会花钱、会上传 PDF，所以：先查有没有 Key，再明确确认一次。
 * 结果落 layout.json，doc/figures 由服务端优先读它，前端只要重载这两样。
 */
let layoutPollTimer = null

/** 停掉轮询（切论文、关面板、任务结束时都要调，否则会一直打接口）。 */
function stopLayoutPoll() {
  if (layoutPollTimer !== null) {
    clearTimeout(layoutPollTimer)
    layoutPollTimer = null
  }
}

/**
 * 版面解析是**后台任务**：请求立刻返回，进度靠轮询 layout.status。
 * 早先是「发一个请求一直等到结束」，面板一关/一切走，前端就不再听结果了
 * （服务端还在跑，但界面上看起来像死了，且失败时什么都不知道）。
 */
function paintLayoutButton() {
  const button = document.getElementById('layout-run')
  if (!button) return
  const docReady = !!(state.doc && Array.isArray(state.doc.paragraphs) && state.doc.paragraphs.length > 0)
  button.disabled = !(docReady && state.current) || !hostReady()
  button.className = 'ghost' + (state.layoutResumable && !state.layoutBusy ? ' dirty' : '')
  button.onclick = state.layoutBusy ? cancelLayoutParse : runLayoutParse
  button.textContent = state.layoutBusy
    ? '解析中… ' + ((state.layoutJob && state.layoutJob.pages) || 0) + '/' + ((state.layoutJob && state.layoutJob.totalPages) || '?')
    : state.layoutResumable ? '续跑版面 ' + state.layoutSavedPages + ' 页' : '版面解析'
  if (state.layoutJob && state.layoutBusy && state.layoutJob.stage) {
    button.title = state.layoutJob.stage
  }
}

// 版面质量：passed 才敢说「模型给的全对得上文本层」，需要复核的页要点名。
function setLayoutQuality(layout) {
  state.layoutSchemaVersion = layout ? Number(layout.schemaVersion) || 1 : 0
  state.layoutQuality = layout && layout.quality ? layout.quality.status : null
  state.layoutBadPages = layout && Array.isArray(layout.pages)
    ? layout.pages.filter(page => page.status && page.status !== 'ready').length
    : 0
}

async function openLayoutReport() {
  const meta = state.current && state.current.meta
  if (!meta) return
  if (!hostReady()) { needRestart(); return }
  const paperId = meta.id
  try {
    const report = await rpc('layout.report', { id: paperId })
    // 报告是异步回来的：期间用户可能切到另一篇，不能把 A 的页号画到 B 上
    if (!state.current || state.current.meta.id !== paperId) return
    state.layoutReport = report && report.exists ? report : null
    if (!state.layoutReport) toast('这篇还没有版面解析结果')
    render()
  } catch (error) {
    if (!state.current || state.current.meta.id !== paperId) return
    toast('读取质量报告失败：' + error.message, 5000)
  }
}

function renderLayoutReport() {
  const report = state.layoutReport
  const close = () => { state.layoutReport = null; render() }
  const pages = report && Array.isArray(report.pages) ? report.pages.filter(page => page.status !== 'ready') : []
  const schemaVersion = report ? Number(report.schemaVersion) || 1 : 0
  const quality = report && report.quality ? report.quality.status : 'unknown'
  if (schemaVersion < 2) {
    return h('div', { class: 'overlay', onclick: event => { if (event.target === event.currentTarget) close() } },
      h('div', { class: 'modal layout-report' },
        h('div', { class: 'modal-head' }, h('strong', {}, '版面质量报告'), h('button', { class: 'ghost', onclick: close }, '关闭')),
        h('div', { class: 'modal-body' }, h('p', { class: 'muted' }, '这是旧版（schemaVersion 1）版面结果，重新解析后可查看逐页质量报告。'))))
  }
  return h('div', { class: 'overlay', onclick: event => { if (event.target === event.currentTarget) close() } },
    h('div', { class: 'modal layout-report' },
      h('div', { class: 'modal-head' },
        h('strong', {}, '版面质量报告'),
        h('button', { class: 'ghost', onclick: close }, '关闭')),
      h('div', { class: 'modal-body' },
        h('p', {}, quality === 'passed' ? '所有页的文字都能和 PDF 文本层对上。' : '有些页需要复核（点击目录/原文页对比）：'),
        h('p', { class: 'muted' }, '版本 ' + (report.revision || '—') + ' · 被排除的块 ' + ((report.excluded || []).length) + ' 个'),
        pages.length === 0
          ? h('p', { class: 'muted' }, '没有需要复核的页。')
          : h('ul', { class: 'layout-report-pages' }, pages.map(page => {
            const total = (page.issues || []).length
            const blocking = page.summary && Number.isFinite(page.summary.blocking) ? page.summary.blocking : total
            const info = page.summary && Number.isFinite(page.summary.informational) ? page.summary.informational : 0
            return h('li', {},
              h('button', { class: 'link', onclick: () => { state.layoutReport = null; jumpToPage(page.n) } }, '第 ' + page.n + ' 页'),
              ' · ' + page.status + ' · ' + total + ' 个问题' + (info > 0 ? '（需人工 ' + blocking + '，提示 ' + info + '）' : ''),
              page.fallback ? ' · 显示原页' : '')
          }))))
  )
}

async function pollLayoutJob(id) {
  stopLayoutPoll()
  const tick = async () => {
    if (!state.current || state.current.meta.id !== id) {
      stopLayoutPoll()
      return
    }
    let status = null
    try {
      status = await rpc('layout.status', { id })
    } catch (error) {
      // 宿主重启 / 一次 500 都会到这里：不复位的话按钮永远停在「解析中…」
      stopLayoutPoll()
      if (state.current && state.current.meta.id === id) {
        state.layoutBusy = false
        render()
        toast('查版面进度失败：' + (error && error.message ? error.message : error))
      }
      return
    }
    // 请求在飞的时候可能已经切了论文：别把上一篇的状态写到新论文上
    if (!state.current || state.current.meta.id !== id) {
      stopLayoutPoll()
      return
    }
    const job = status && status.job
    state.layoutJob = job || null
    state.layoutResumable = Boolean(status && status.resumable)
    state.layoutSavedPages = (status && status.savedPages) || 0
    state.layoutApplied = Boolean(status && status.layout && status.layout.applied)
    setLayoutQuality(status && status.layout)
    // interrupted 也是终态：磁盘上写着 running 但进程已经重启过，再轮询也等不到结果
    const settled = !job || job.state === 'done' || job.state === 'failed' ||
      job.state === 'cancelled' || job.state === 'interrupted'
    if (settled) {
      state.layoutBusy = false
      stopLayoutPoll()
      render()
      if (job && job.state === 'done') {
        await loadDoc(id)
        await loadFigures()
        render()
      } else if (job && job.state === 'failed') {
        toast('版面解析失败：' + (job.error || '未知原因'))
      }
      return
    }
    state.layoutBusy = job.state === 'running'
    // 不要每 2 秒整页重绘：那会把正在读的选区、滚动和输入框都掀掉。
    // 只改按钮自己的文字/状态，等任务结束再整体 render。
    paintLayoutButton()
    layoutPollTimer = setTimeout(tick, 2000)
  }
  await tick()
}

async function refillLayoutText() {
  const meta = state.current && state.current.meta
  if (!meta) return
  if (!hostReady()) {
    needRestart()
    return
  }
  if (state.layoutBusy) return
  const id = meta.id
  const seq = state.openSeq
  const stale = () => seq !== state.openSeq || !state.current || state.current.meta.id !== id
  state.layoutBusy = true
  render()
  try {
    const result = await rpc('layout.refill', { id })
    if (stale()) return
    await loadDoc(id, seq)
    if (stale()) return
    toast(result.changed > 0
      ? '重填了 ' + result.changed + ' 块文字（' + result.pages + ' 页从 PDF 文本层取）'
      : '文字已经是最新的（没有需要重填的块）')
  } catch (error) {
    if (!stale()) toast('重填文字失败：' + error.message, 5000)
  } finally {
    if (!stale()) {
      state.layoutBusy = false
      render()
    }
  }
}

async function runLayoutParse() {
  const meta = state.current && state.current.meta
  if (!meta) return
  if (!hostReady()) {
    needRestart()
    return
  }
  if (state.layoutBusy) return
  const id = meta.id
  const seq = state.openSeq
  const stale = () => seq !== state.openSeq || !state.current || state.current.meta.id !== id
  let status = null
  try {
    status = await rpc('layout.status', { id })
  } catch (error) {
    if (!stale()) toast('查版面状态失败：' + error.message)
    return
  }
  if (stale()) return
  if (status && status.ready === false) {
    toast('还没填 PaddleOCR 的 API Key：设置 → PaddleOCR 里填一次')
    return
  }
  const current = status && status.layout
  const resumable = Boolean(status && status.resumable)
  const question = resumable
    ? '上次没跑完，已完成 ' + status.savedPages + ' 页（已存盘，不用重传）。\n接着跑剩下的页？'
    : current
      ? '这篇已经解析过（' + current.blocks + ' 块 / ' + current.figures + ' 图，' + current.model + '）。\n重新解析会再上传一次 PDF、再花一次配额，确定？'
      : '版面解析会把整篇 PDF 上传到百度 AI Studio，用 PP-StructureV3 按页计费。\n解析后对照视图按真实版面切段，图表原位显示；结果会存到 layout.json，下次不用重跑。继续？'
  if (!window.confirm(question)) return
  if (stale()) return
  state.layoutBusy = true
  render()
  try {
    await rpc('layout.start', { id, resume: resumable })
    if (stale()) return
    await pollLayoutJob(id)
  } catch (error) {
    if (!stale()) {
      state.layoutBusy = false
      render()
      toast('版面解析没能开始：' + error.message)
    }
  }
}

async function cancelLayoutParse() {
  const meta = state.current && state.current.meta
  if (!meta) return
  try {
    const result = await rpc('layout.cancel', { id: meta.id })
    if (result && result.cancelled) {
      toast('已请求取消：当前这一批跑完就停，已完成的页会留着')
    } else {
      // 任务可能已经结束/被重启清掉了：把按钮复位，别让它一直显示「解析中…」
      state.layoutBusy = false
      render()
      toast('没有正在跑的版面任务（可能已经结束）')
    }
  } catch (error) {
    toast('取消失败：' + error.message)
  }
}

// --- 翻译自检// --- 翻译自检

async function runReview(mode = 'static') {
  if (!state.current) return
  if (!hostReady()) {
    needRestart()
    return
  }
  const id = state.current.meta.id
  const seq = state.openSeq
  const stale = () => seq !== state.openSeq || !state.current || state.current.meta.id !== id
  state.reviewBusy = true
  render()
  try {
    const value = await rpc('review.run', { id, mode })
    if (stale()) return
    state.review = value.review || null
    const count = (state.review && state.review.issues ? state.review.issues.length : 0)
    toast(count ? '自检发现 ' + count + ' 处可疑译文' : '自检通过：没发现明显问题')
  } catch (error) {
    if (!stale()) toast('自检失败：' + error.message)
  } finally {
    if (!stale()) {
      state.reviewBusy = false
      render()
    }
  }
}

function renderReviewPanel() {
  const review = state.review
  if (!review) return null
  const issues = Array.isArray(review.issues) ? review.issues : []
  const stats = review.stats || {}
  return h(
    'div',
    { class: 'review-panel' },
    h(
      'div',
      { class: 'review-head' },
      h('span', {}, '自检：' + issues.length + ' 处可疑（检查 ' + (stats.checked || 0) + ' 段）'),
      stats.llmError ? h('span', { class: 'muted' }, '模型检查降级：' + stats.llmError) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'link', onclick: () => { state.review = null; render() } }, '收起'),
    ),
    issues.length
      ? h(
          'div',
          { class: 'review-list' },
          ...issues.slice(0, 200).map((issue) =>
            h(
              'div',
              { class: 'review-item ' + (issue.severity || 'warn') },
              h('span', { class: 'review-code' }, issue.code || 'issue'),
              h('span', { class: 'review-msg' }, issue.message || issue.issue || ''),
              issue.key ? h('button', { class: 'link', onclick: () => gotoParagraphKey(issue.key) }, '定位') : null,
            ),
          ),
        )
      : h('div', { class: 'hint' }, '没发现明显问题。'),
  )
}

function gotoParagraphKey(key) {
  const node = document.querySelector('.para[data-key="' + cssKey(key) + '"]')
  if (!node) {
    toast('这一段不在当前视图里（可能已重新分节）')
    return
  }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  node.classList.add('flash')
  setTimeout(() => node.classList.remove('flash'), 1600)
}

// --- 任务日志抽屉

function toggleLogs() {
  if (!hostReady()) {
    needRestart()
    return
  }
  state.logs.open = !state.logs.open
  if (state.logs.open) {
    loadLogs()
    startLogPoll()
  } else {
    stopLogPoll()
  }
  render()
}

async function loadLogs(silent = false) {
  if (!state.current) return
  const id = state.current.meta.id
  const seq = state.openSeq
  try {
    const value = await rpc('logs.list', { id, after: 0, limit: 300 })
    if (seq !== state.openSeq || !state.current || state.current.meta.id !== id) return
    const events = Array.isArray(value.events) ? value.events : []
    const changed = events.length !== state.logs.events.length
    state.logs.events = events
    state.logs.lastSeq = value.lastSeq || 0
    if (changed && !silent) render()
    else if (changed && silent && state.logs.open) render()
  } catch {
    /* 日志读失败不打扰用户 */
  }
}

function startLogPoll() {
  stopLogPoll()
  state.logs.timer = setInterval(() => loadLogs(true), 2500)
}

function stopLogPoll() {
  if (state.logs.timer) clearInterval(state.logs.timer)
  state.logs.timer = null
}

async function clearLogs() {
  if (!state.current) return
  await rpc('logs.clear', { id: state.current.meta.id }).catch((error) => toast(error.message))
  state.logs.events = []
  render()
}

function renderLogDrawer() {
  if (!state.logs.open) return null
  const events = state.logs.events.slice(-200)
  return h(
    'div',
    { class: 'log-drawer' },
    h(
      'div',
      { class: 'log-head' },
      h('span', {}, '任务日志（' + state.logs.events.length + ' 条）'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'ghost', onclick: clearLogs }, '清空'),
      h('button', { class: 'ghost', onclick: toggleLogs }, '收起'),
    ),
    h(
      'div',
      { class: 'log-list' },
      events.length === 0
        ? h('div', { class: 'hint' }, '还没有日志。翻译、OCR、自检都会在这里留下记录。')
        : events.map((event) =>
            h(
              'div',
              { class: 'log-item ' + (event.level || 'info') },
              h('span', { class: 'log-time' }, String(event.at || '').replace('T', ' ').slice(11, 19)),
              h('span', { class: 'log-kind' }, event.kind || 'log'),
              h('span', { class: 'log-msg' }, event.message || ''),
            ),
          ),
    ),
  )
}

// --- 回收站

async function openTrash() {
  if (!hostReady()) {
    needRestart()
    return
  }
  state.trash.open = true
  state.trash.busy = true
  state.trash.error = ''
  render()
  try {
    const value = await rpc('trash.list')
    state.trash.items = Array.isArray(value.items) ? value.items : []
  } catch (error) {
    state.trash.error = error.message
  }
  state.trash.busy = false
  render()
}

function closeTrash() {
  state.trash.open = false
  render()
}

async function restoreTrashItem(name) {
  try {
    await rpc('trash.restore', { name })
    toast('已恢复到文献库')
    await loadLibrary()
    await openTrash()
  } catch (error) {
    toast('恢复失败：' + error.message)
  }
}

async function purgeTrashItem(name) {
  if (!window.confirm('彻底删除这一项？回收站里的文件会被真的删掉，无法恢复。')) return
  try {
    await rpc('trash.purge', { name })
    toast('已彻底删除')
    await openTrash()
  } catch (error) {
    toast('删除失败：' + error.message)
  }
}

function renderTrashModal() {
  const t = state.trash
  return h(
    'div',
    {
      class: 'overlay',
      onclick: (event) => {
        if (event.target === event.currentTarget) closeTrash()
      },
    },
    h(
      'div',
      { class: 'search-box trash-box' },
      h(
        'div',
        { class: 'search-head' },
        h('span', { class: 'search-title' }, '回收站'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', onclick: closeTrash }, '关闭'),
      ),
      h('div', { class: 'hint' }, '删除论文只是移到这里，PDF 原件不动；恢复后回到文献库原来的分组。'),
      t.error ? h('div', { class: 'error' }, t.error) : null,
      t.busy
        ? h('div', { class: 'hint' }, '读取中…')
        : t.items.length === 0
          ? h('div', { class: 'hint' }, '回收站是空的。')
          : h(
              'div',
              { class: 'trash-list' },
              ...t.items.map((item) =>
                h(
                  'div',
                  { class: 'trash-item' },
                  h('div', { class: 'trash-title' }, item.title || item.id),
                  h('div', { class: 'muted' }, item.id + ' · ' + String(item.trashedAt || '').slice(0, 19).replace('T', ' ')),
                  h('span', { class: 'spacer' }),
                  h('button', { onclick: () => restoreTrashItem(item.name) }, '恢复'),
                  h('button', { class: 'danger', onclick: () => purgeTrashItem(item.name) }, '彻底删除'),
                ),
              ),
            ),
    ),
  )
}

// --- 原生会话（对话落进真正的 DSH 会话）

/** 宿主会话里存的是「范围前缀 + 用户原话」，气泡里只显示用户自己写的那句。 */
function stripScopePrompt(text) {
  const value = String(text || '')
  const marker = '引用原文时用 [p.N] 标页码。'
  if (value.startsWith('【本次对话的论文范围】') || value.startsWith('【用户上传的附件】')) {
    const index = value.lastIndexOf(marker)
    if (index >= 0) return value.slice(index + marker.length).replace(/^\s+/, '')
  }
  return value
}

function sessionMessages() {
  const out = []
  let live = null
  for (const frame of state.session.frames) {
    if (!frame) continue
    if (frame.kind === 'snapshot') {
      // snapshot 是会话的历史事件流：重开面板时靠它把之前的消息补回来
      out.length = 0
      live = null
      for (const item of frame.messages || []) out.push({ role: item.role, text: item.text, blocks: item.blocks })
      continue
    }
    if (frame.kind === 'message') {
      out.push({ role: frame.role || 'assistant', text: frame.text || '', blocks: frame.blocks })
      live = null
    } else if (frame.kind === 'delta') {
      if (!live) {
        live = { role: 'assistant', text: '', reasoning: '', streaming: true }
        out.push(live)
      }
      if (frame.part === 'reasoning') live.reasoning = (live.reasoning || '') + (frame.text || '')
      else live.text += frame.text || ''
    } else if (frame.kind === 'done') {
      if (live) live.streaming = false
      live = null
    } else if (frame.kind === 'error') {
      // 模型报错要能看见：以前这类帧被归成 other，界面上直接没有回答
      if (live) live.streaming = false
      out.push({ role: 'error', text: String(frame.text || '会话返回了错误') })
      live = null
    }
  }
  return out
}

const SESSION_FRAMES_MAX = 2000

/**
 * 裁剪会话帧窗口。旧实现固定只留最后 400 帧，窗口可能落在一帧 delta 上，
 * 于是 history 缓冲从半句话开始（sessionMessages 会给它新起一条流式气泡）。
 * 现在上限放到 2000，并且只在窗口起点是「完整消息/结束」边界时才裁。
 */
function pruneSessionFrames() {
  const frames = state.session.frames
  if (frames.length <= SESSION_FRAMES_MAX) return
  const target = frames.length - SESSION_FRAMES_MAX
  let start = target
  while (start < frames.length) {
    const kind = frames[start] && frames[start].kind
    if (kind === 'message' || kind === 'done') break
    start += 1
  }
  if (start >= frames.length) return // 窗口里没有可用的消息边界：宁可不裁，也不显示半句
  state.session.frames = frames.slice(start)
}

/**
 * 会话流增量帧只更新最后一条正在流式输出的气泡（和本地对话的 paintLiveChat 同款思路）：
 * 每帧 render() 会换掉 #chat-input，用户正在输入的字会丢焦点。
 * 没有这条气泡时（新一轮回答刚开始）也只补一条，不整页重绘。
 */
/**
 * 会话里的「思考过程」与工具调用：宿主把一次回答拆成 reasoning/text 部件。
 * 思考默认折叠（和 DeepSeek 官方客户端一样），工具调用只显示名字，点开看摘要。
 */
function renderSessionBlocks(message) {
  const blocks = Array.isArray(message.blocks) ? message.blocks : []
  const liveReasoning = String(message.reasoning || '').trim()
  if (blocks.length === 0 && liveReasoning === '') return null
  const reasoning = (blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('\n\n') || liveReasoning).trim()
  const tools = blocks.filter((b) => b.type === 'tool')
  if (reasoning === '' && tools.length === 0) return null
  const wrap = h('div', { class: 'msg-extra' })
  if (tools.length > 0) {
    const names = tools.map((t) => t.name || '工具').join(' · ')
    wrap.append(
      h(
        'details',
        { class: 'msg-tools' },
        h('summary', {}, '工具调用 ' + tools.length + ' 次'),
        h('pre', { class: 'tool-body' }, names + '\n\n' + tools.map((t) => (t.name ? t.name + ': ' : '') + (t.text || '')).join('\n\n')),
      ),
    )
  }
  if (reasoning !== '') {
    wrap.append(h('details', { class: 'msg-think' }, h('summary', {}, '思考过程'), h('pre', { class: 'think-body' }, reasoning)))
  }
  return wrap
}

function paintSessionLive() {
  const messages = sessionMessages()
  const live = messages.length > 0 ? messages[messages.length - 1] : null
  if (!live || !live.streaming) return false
  const list = document.querySelector('.chat-messages')
  if (!list) return false
  let wrap = document.getElementById('session-live')
  if (!wrap) {
    wrap = h('div', { class: 'msg assistant', id: 'session-live' })
    wrap.append(h('div', { class: 'msg-extra' }))
    wrap.append(h('div', { class: 'msg-body streaming', id: 'session-live-body' }))
    list.append(wrap)
    const hint = list.querySelector('.chat-hint')
    if (hint) hint.remove()
  }
  const extra = wrap.querySelector('.msg-extra')
  const reasoning = String(live.reasoning || '')
  if (reasoning !== '') {
    let think = extra.querySelector('.msg-think')
    if (!think) {
      think = h('details', { class: 'msg-think', open: true }, h('summary', {}, '思考过程'), h('pre', { class: 'think-body' }))
      extra.append(think)
    }
    const body = think.querySelector('.think-body')
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 24
    body.textContent = reasoning
    if (atEnd) body.scrollTop = body.scrollHeight
  }
  const body = document.getElementById('session-live-body')
  body.innerHTML = renderAssistantHtml(live.text) + '<span class="caret"></span>'
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 80) list.scrollTop = list.scrollHeight
  return true
}

async function startSessionStream(force = false) {
  if (NATIVE_READER) return
  if (!state.session.available) return
  const conv = activeConv()
  // 没有对话就先不建：用户发出第一条消息（或点了「＋ 新建」）才创建，避免每开一次面板就多一个空对话
  if (!conv) return
  const id = conv.id
  if (!force && state.session.started === id && state.session.streaming) return
  stopSessionStream()
  state.session.started = id
  state.session.frames = []
  state.session.error = ''
  state.session.streaming = true
  const controller = new AbortController()
  state.session.abort = controller
  // 代次令牌：连了两条流（发送后自动重连 + 面板重绘触发）时，旧流的帧不能再写进列表，
  // 否则一条提问会出现两个气泡、回答也会重复。
  const seq = (state.session.seq || 0) + 1
  state.session.seq = seq
  render()
  try {
    await streamSseGet(
      '/paper-workbench/session/follow?conv=' + encodeURIComponent(id),
      {
        frame: (frame) => {
          if (state.session.seq !== seq) return
          if (frame && frame.kind === 'snapshot') {
            // 历史消息一次性铺开，不参与后面的增量拼接。
            // 没有历史时保留本地乐观回显（用户刚发出去的那句），别把气泡弄丢。
            if ((frame.messages || []).length > 0) {
              state.session.frames = [{ kind: 'snapshot', messages: frame.messages }]
              render()
            }
            return
          }
          // 同一条消息可能既有 snapshot 又有 user/message 事件（宿主补发），
          // 相邻重复就直接丢掉，否则一次提问会出现三个气泡。
          if (frame && frame.kind === 'message') {
            // 用展开后的消息列表比较：snapshot 里的历史也要算进来
            const recent = sessionMessages()
            const last = recent.length > 0 ? recent[recent.length - 1] : null
            if (last && last.role === frame.role && last.text === frame.text) return
          }
          state.session.frames.push(frame)
          pruneSessionFrames()
          // 增量帧只补最后一口气泡；只有消息边界与流结束才整页重绘，
          // 否则流式期间每帧 render() 都会换掉 #chat-input，输入框丢焦点、草稿被打断。
          if (frame && frame.kind === 'delta') paintSessionLive()
          else if (frame && (frame.kind === 'message' || frame.kind === 'done' || frame.kind === 'error')) render()
        },
        error: (data) => {
          state.session.error = (data && data.error) || '会话流出错'
          render()
        },
      },
      controller.signal,
    )
  } catch (error) {
    if (!controller.signal.aborted) state.session.error = error.message
  }
  state.session.streaming = false
  render()
}

function stopSessionStream() {
  if (state.session.abort) {
    state.session.abort.abort()
    state.session.abort = null
  }
  state.session.streaming = false
}

async function sendSessionMessage(text) {
  if (NATIVE_READER) return askNative(text)
  const content = String(text || '').trim()
  if (!content) return
  if (!state.chats.available) {
    toast('这个界面要重启桌面端后才生效（宿主代码只在插件加载时执行一次）')
    return
  }
  const conv = await ensureConversation().catch((error) => {
    state.session.error = error.message
    return null
  })
  if (!conv) {
    render()
    return
  }
  state.session.frames.push({ kind: 'message', role: 'user', text: content })
  state.session.error = ''
  render()
  try {
    await rpc('session.ask', { conversationId: conv.id, text: content })
    await loadConversations().catch(() => {})
    // 先发出去再连流：宿主 follow 会补发最近消息，不会漏掉刚发的问题
    startSessionStream(true)
  } catch (error) {
    state.session.error = error.message
    render()
  }
}

// ---------------------------------------------------------------- 对话（多篇论文 + 附件，落进 DSH 会话）
function activeConv() {
  return state.chats.items.find((item) => item.id === state.chats.activeId) || null
}

function paperLabel(id) {
  const paper = state.papers.find((item) => item.id === id)
  const meta = (state.current && state.current.meta && state.current.meta.id === id ? state.current.meta : null) || (paper && paper.meta) || paper || {}
  return String(meta.title || id)
}

async function loadConversations() {
  if (NATIVE_READER) return
  if (!state.session.available) return
  state.chats.loading = true
  try {
    const data = await rpc('conv.list')
    state.chats.items = Array.isArray(data.items) ? data.items : []
    state.chats.activeId = data.activeId || (state.chats.items[0] ? state.chats.items[0].id : '')
    state.chats.error = ''
    state.chats.available = true
  } catch (error) {
    // 旧宿主（还没有 conv.* 接口）上不要装作能用：给一句明确的话，别让人以为是数据丢了
    state.chats.available = false
    state.chats.error = error.message
  }
  state.chats.loading = false
}

async function ensureConversation() {
  if (activeConv()) return activeConv()
  if (state.chats.items.length > 0) {
    state.chats.activeId = state.chats.items[0].id
    return state.chats.items[0]
  }
  const paperIds = state.current ? [state.current.meta.id] : []
  const title = state.current && state.current.meta ? '关于《' + state.current.meta.title + '》' : '新对话'
  const conv = await rpc('conv.create', { title: String(title).slice(0, 60), paperIds })
  await loadConversations()
  state.chats.activeId = conv.id
  return conv
}

async function newConversation() {
  state.convMenu = false
  try {
    const paperIds = state.current ? [state.current.meta.id] : []
    const conv = await rpc('conv.create', { title: '新对话', paperIds })
    await loadConversations()
    state.chats.activeId = conv.id
    switchConversationStream(conv.id)
  } catch (error) {
    toast('新建对话失败：' + error.message)
  }
  render()
}

function switchConversationStream(id) {
  stopSessionStream()
  state.session.started = ''
  state.session.frames = []
  state.session.error = ''
  state.chat.draft = ''
  state.chats.activeId = id
  startSessionStream(true)
}

async function switchConversation(id) {
  state.convMenu = false
  try {
    await rpc('conv.active', { id })
  } catch (error) {
    toast('切换对话失败：' + error.message)
  }
  switchConversationStream(id)
  render()
}

async function renameConversation() {
  const conv = activeConv()
  if (!conv) return
  const title = window.prompt('对话标题', conv.title || '新对话')
  if (title === null) return
  state.convMenu = false
  try {
    await rpc('conv.update', { id: conv.id, title })
    await loadConversations()
  } catch (error) {
    toast('改名失败：' + error.message)
  }
  render()
}

async function removeConversation() {
  const conv = activeConv()
  if (!conv) return
  if (!window.confirm('删除这个对话？DSH 里的会话记录不会被删，只是从这里移除。')) return
  state.convMenu = false
  try {
    await rpc('conv.remove', { id: conv.id })
    await loadConversations()
    const next = activeConv()
    if (next) switchConversationStream(next.id)
    else state.session.frames = []
  } catch (error) {
    toast('删除失败：' + error.message)
  }
  render()
}

async function addPaperToConversation(paperId) {
  const conv = activeConv()
  if (!conv) return
  const paperIds = Array.from(new Set([...(conv.paperIds || []), paperId])).slice(0, 30)
  try {
    await rpc('conv.update', { id: conv.id, paperIds })
    await loadConversations()
    toast('已加入：' + paperLabel(paperId))
  } catch (error) {
    toast('加入失败：' + error.message)
  }
  render()
}

async function removePaperFromConversation(paperId) {
  const conv = activeConv()
  if (!conv) return
  const paperIds = (conv.paperIds || []).filter((id) => id !== paperId)
  try {
    await rpc('conv.update', { id: conv.id, paperIds })
    await loadConversations()
  } catch (error) {
    toast('移除失败：' + error.message)
  }
  render()
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      const comma = text.indexOf(',')
      resolve(comma >= 0 ? text.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function attachFiles(files) {
  const conv = await ensureConversation().catch(() => null)
  if (!conv) return
  const list = Array.from(files || [])
  if (list.length === 0) return
  state.attachBusy = true
  render()
  let ok = 0
  for (const file of list) {
    if (file.size > 40 * 1024 * 1024) {
      toast('跳过（超过 40MB）：' + file.name)
      continue
    }
    try {
      const dataBase64 = await readFileBase64(file)
      await rpc('conv.attach', { id: conv.id, name: file.name, dataBase64 })
      ok += 1
    } catch (error) {
      toast('上传失败：' + file.name + ' · ' + error.message)
    }
  }
  state.attachBusy = false
  try {
    await loadConversations()
  } catch (error) {
    /* 忽略 */
  }
  if (ok > 0) toast('已添加 ' + ok + ' 个附件（提问时会把路径告诉 agent）')
  render()
}

async function detachAttachment(filePath) {
  const conv = activeConv()
  if (!conv) return
  try {
    await rpc('conv.detach', { id: conv.id, path: filePath })
    await loadConversations()
  } catch (error) {
    toast('移除附件失败：' + error.message)
  }
  render()
}

function pickFiles() {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.style.display = 'none'
  input.onchange = () => attachFiles(input.files)
  document.body.append(input)
  input.click()
  setTimeout(() => input.remove(), 1000)
}

function renderConvMenu() {
  const conv = activeConv()
  const menu = h('div', { class: 'conv-menu' })
  if (state.chats.items.length === 0) menu.append(h('div', { class: 'hint' }, '还没有对话'))
  for (const item of state.chats.items) {
    const count = (item.paperIds || []).length
    menu.append(
      h(
        'button',
        {
          class: 'conv-item' + (conv && item.id === conv.id ? ' active' : ''),
          onclick: () => switchConversation(item.id),
        },
        h('span', { class: 'conv-item-title' }, item.title || '新对话'),
        h('span', { class: 'conv-item-meta' }, count > 0 ? count + ' 篇' : '未挂论文'),
      ),
    )
  }
  menu.append(
    h(
      'div',
      { class: 'conv-menu-foot' },
      h('button', { class: 'ghost', onclick: newConversation }, '＋ 新建'),
      h('button', { class: 'ghost', onclick: renameConversation, disabled: !conv }, '改名'),
      h('button', { class: 'ghost danger', onclick: removeConversation, disabled: !conv }, '删除'),
    ),
  )
  return menu
}

/**
 * 把这条对话交给 DSH 原生会话界面。
 *
 * 面板里这套 UI 只能发文本（prompt 接口只收 {type:'text'}），真正的附件上传、
 * 工具调用展开、模型/权限切换都在宿主会话页上。所以这里用 postMessage 请宿主
 * （lib/client.js）调 uiWorkspace.openSession 跳过去，能力立刻完整。
 */
function openConvInDsh() {
  const conv = activeConv()
  if (!conv || !conv.sessionId) {
    toast('这条对话还没有会话：先发一句话，等会话建好再打开', 'warn')
    return
  }
  if (window.parent === window) {
    toast('面板是嵌在 DSH 里的，单独打开这个页面没法跳转', 'warn')
    return
  }
  window.parent.postMessage({ __pb: true, type: 'open-session', sessionId: conv.sessionId }, window.location.origin)
  toast('正在主界面打开这条会话…', 'info')
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return
  const data = event.data
  if (!data || data.__pb !== true || data.type !== 'opened') return
  if (data.ok) toast('已在主界面打开，附件与工具调用都在那边', 'ok')
  else toast(data.message || '打开会话失败', 'warn')
})

/** 把文件拖进对话面板就能当附件（和 DSH 输入框的拖拽一致）。 */
function setupDropZone(node) {
  let depth = 0
  node.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return
    event.preventDefault()
    depth += 1
    node.classList.add('drop-hot')
  })
  node.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })
  node.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) node.classList.remove('drop-hot')
  })
  node.addEventListener('drop', (event) => {
    if (!event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return
    event.preventDefault()
    depth = 0
    node.classList.remove('drop-hot')
    attachFiles(event.dataTransfer.files).catch((error) => toast(String(error && error.message ? error.message : error), 'warn'))
  })
}

function renderConvBar() {
  const conv = activeConv()
  const bar = h('div', { class: 'conv-bar' })
  bar.append(
    h(
      'div',
      { class: 'conv-row' },
      h(
        'button',
        {
          class: 'conv-name',
          title: '切换 / 新建 / 改名 / 删除对话',
          onclick: () => {
            state.convMenu = !state.convMenu
            render()
          },
        },
        h('span', { class: 'conv-name-text' }, conv ? conv.title || '新对话' : '新建对话'),
        h('span', { class: 'conv-caret' }, '▾'),
      ),
      h('span', { class: 'spacer' }),
      state.attachBusy ? h('span', { class: 'hint' }, '上传中…') : null,
      h('button', { class: 'ghost', title: '上传附件（把本地文件路径告诉 agent）', onclick: pickFiles }, '📎'),
      h(
        'button',
        {
          class: 'ghost',
          title: '在 DSH 原生会话界面里打开（附件、工具调用、模型选择都在那边）',
          onclick: openConvInDsh,
        },
        '↗',
      ),
    ),
  )
  if (state.convMenu) bar.append(renderConvMenu())
  const chips = h('div', { class: 'conv-chips' })
  for (const paperId of conv ? conv.paperIds || [] : []) {
    chips.append(
      h(
        'span',
        { class: 'conv-chip', title: paperId },
        h('span', { class: 'conv-chip-text' }, paperLabel(paperId)),
        h('button', { class: 'conv-chip-x', title: '从对话范围里移除', onclick: () => removePaperFromConversation(paperId) }, '×'),
      ),
    )
  }
  for (const file of conv ? conv.attachments || [] : []) {
    chips.append(
      h(
        'span',
        { class: 'conv-chip attach', title: file.path },
        h('span', { class: 'conv-chip-text' }, file.name),
        h('button', { class: 'conv-chip-x', title: '移除附件', onclick: () => detachAttachment(file.path) }, '×'),
      ),
    )
  }
  chips.append(
    h(
      'button',
      {
        class: 'conv-add',
        title: '把另一篇论文加进这个对话（一次问多篇）',
        onclick: () => {
          state.convPicker.open = true
          state.convPicker.q = ''
          state.convMenu = false
          render()
        },
      },
      '＋ 论文',
    ),
  )
  bar.append(chips)
  return bar
}

function renderConvPicker() {
  const q = state.convPicker.q.trim().toLowerCase()
  const conv = activeConv()
  const picked = new Set(conv ? conv.paperIds || [] : [])
  const items = state.papers.filter((paper) => {
    if (picked.has(paper.id)) return false
    if (!q) return true
    const title = String((paper.meta && paper.meta.title) || paper.title || '')
    return title.toLowerCase().includes(q) || paper.id.includes(q)
  })
  const list = h('div', { class: 'picker-list' })
  if (items.length === 0) list.append(h('div', { class: 'hint' }, picked.size > 0 ? '所有论文都已经在这个对话里了' : '没有匹配的论文'))
  for (const paper of items.slice(0, 200)) {
    const title = String((paper.meta && paper.meta.title) || paper.title || paper.id)
    const pages = (paper.meta && paper.meta.pages) || paper.pageCount || 0
    list.append(
      h(
        'button',
        {
          class: 'picker-item',
          onclick: async () => {
            state.convPicker.open = false
            await addPaperToConversation(paper.id)
          },
        },
        h('span', { class: 'picker-title' }, title),
        h('span', { class: 'picker-meta' }, (pages ? pages + ' 页 · ' : '') + paper.id),
      ),
    )
  }
  return h(
    'div',
    { class: 'overlay', onclick: (event) => { if (event.target.classList.contains('overlay')) { state.convPicker.open = false; render() } } },
    h(
      'div',
      { class: 'modal picker-modal', role: 'dialog', 'aria-label': '选择论文' },
      h(
        'div',
        { class: 'modal-head' },
        h('strong', null, '加入对话的论文'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', onclick: () => { state.convPicker.open = false; render() } }, '×'),
      ),
      h('input', {
        class: 'picker-search',
        placeholder: '按标题或 id 过滤…',
        value: state.convPicker.q,
        oninput: (event) => {
          state.convPicker.q = event.target.value
          render()
        },
      }),
      list,
    ),
  )
}

function renderSessionChat(aside) {
  if (!state.chats.available) {
    aside.append(
      h(
        'div',
        { class: 'chat-error' },
        '多篇论文对话需要重启桌面端（宿主代码只在插件加载时执行一次）。现在可以先用「本地」模式，或重开插件后再回来。',
      ),
    )
  }
  aside.append(renderConvBar())
  aside.append(
    h(
      'div',
      { class: 'chat-quick' },
      h('button', { class: 'ghost', onclick: () => sendSessionMessage('讲解这一节的核心贡献：' + (state.sectionId || '')) }, '讲解本节'),
      h(
        'button',
        {
          class: 'ghost',
          onclick: () => {
            const text = pickedText()
            if (text.length < 2) {
              toast('先在正文里选中一段文字')
              return
            }
            sendSessionMessage('讲解这段选中的原文：\n> ' + text)
          },
        },
        '讲解选中段落',
      ),
      h('button', { class: 'ghost', onclick: () => sendSessionMessage('用三句话总结这篇论文') }, '总结全文'),
    ),
  )
  if (state.session.error) aside.append(h('div', { class: 'chat-error error' }, state.session.error))
  const list = h('div', { class: 'chat-messages' })
  const messages = sessionMessages()
  if (messages.length === 0) {
    list.append(h('div', { class: 'hint chat-hint' }, state.session.streaming ? '正在接上会话…' : '这一段对话就是 DSH 里的真实会话，关掉面板也能在主界面继续。'))
  }
  for (const message of messages) {
    if (message.role === 'user') {
      list.append(h('div', { class: 'msg user' }, h('div', { class: 'msg-body' }, stripScopePrompt(message.text))))
      continue
    }
    if (message.role === 'error') {
      // 模型/宿主报错时给一条红字，别让用户对着「思考中」一直等
      list.append(h('div', { class: 'msg assistant' }, h('div', { class: 'msg-body chat-error error' }, message.text)))
      continue
    }
    const body = h('div', { class: 'msg-body' + (message.streaming ? ' streaming' : ''), id: message.streaming ? 'session-live-body' : undefined })
    body.innerHTML = renderAssistantHtml(message.text)
    if (message.streaming) body.append(h('span', { class: 'caret' }))
    const extra = renderSessionBlocks(message)
    list.append(
      h(
        'div',
        { class: 'msg assistant' },
        extra || '',
        body,
        h(
          'div',
          { class: 'msg-actions' },
          h('button', { class: 'link', onclick: () => copyText(message.text) }, '复制'),
          h('button', { class: 'link', onclick: () => sendSessionMessage('请重新回答上一条，并换一种更简洁的说法。') }, '重新生成'),
        ),
      ),
    )
  }
  aside.append(list)
  const input = h('textarea', {
    id: 'chat-input',
    class: 'chat-input',
    rows: '2',
    placeholder: '在这个真实会话里继续问…（Enter 发送）',
    value: state.chat.draft || '',
    oninput: (event) => {
      state.chat.draft = event.target.value
    },
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const text = state.chat.draft
        state.chat.draft = ''
        sendSessionMessage(text)
      }
    },
  })
  aside.append(
    h(
      'div',
      { class: 'chat-composer' },
      input,
      h(
        'div',
        { class: 'chat-actions' },
        h('span', { class: 'hint' }, state.session.streaming ? '会话流已连上' : '点「重连」可重新接上'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', onclick: () => startSessionStream(true) }, '重连'),
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              const text = state.chat.draft
              state.chat.draft = ''
              sendSessionMessage(text)
            },
          },
          '发送',
        ),
      ),
    ),
  )
  // 面板打开时自动接上会话流：有对话按对话，没有论文也没有对话就先不连（等第一条消息）
  const conv = activeConv()
  const key = conv ? conv.id : state.current ? state.current.meta.id : ''
  if (key && state.session.started !== key && !state.session.streaming) startSessionStream()
}

/** 能重试的失败段落：任务记录的失败项 + 停在 error 的段落（整篇失败时 job.failed 可能是空的）。 */
function failedSegmentKeys() {
  const keys = new Set(state.job && state.job.failed ? state.job.failed : [])
  for (const [key, item] of state.streams) {
    if (item && item.status === 'error' && !state.trans[key]) keys.add(key)
  }
  return [...keys]
}

function retryFailedSegments() {
  const failed = failedSegmentKeys()
  if (failed.length === 0) {
    toast('没有失败的段落')
    return
  }
  translateKeys(failed)
}

// 启动失败不能静默：以前 boot 里任何一步抛错，界面就停在「还没有论文」而没有任何提示。
async function boot() {
  try {
    await bootInner()
  } catch (error) {
    console.error('[paper-workbench] 启动失败', error)
    // 留在 DOM 上，方便用户/支持时一眼看到（控制台不是每个人都开）
    document.documentElement.dataset.pbBootError = String((error && error.message) || error)
    toast('工作台启动失败：' + (error && error.message ? error.message : error))
  }
}

async function bootInner() {
  applyDark()
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.cropMode) {
      state.cropMode = false
      render(true)
      return
    }
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || String(event.key).toLowerCase() !== 'f') return
    if (event.isComposing) return
    const target = event.target
    // 输入框 / 可编辑区 / 设置与回收站弹层里的 Ctrl+F 交给浏览器自己的查找
    if (target && (target.isContentEditable || (target.closest && target.closest('input, textarea, select, [contenteditable="true"]')))) return
    if (state.showSettings || state.trash.open || state.convPicker.open) return
    // 旧宿主没有文内搜索接口：不 preventDefault，让浏览器的查找照常可用
    if (!state.current || !hostReady()) return
    event.preventDefault()
    openSearch()
  })
  render()
  await Promise.all([loadHealth(), loadAi()])
  state.session.available = !NATIVE_READER && !!(state.health && state.health.session && state.health.session.available)
  if (!state.session.available) state.chatMode = 'local'
  else await loadConversations().catch(() => {})
  await loadLibrary()
  render()
  // 面板关掉再打开等于重开页面：把上次看到哪儿、停在哪个页签还原回去。
  // 本地一份（同端口刷新快）+ 服务端一份（桌面端重启换端口也不丢），取较新的。
  const session = pickSession(loadSession(), await loadSessionRemote())
  if (session && typeof session === 'object') {
    let localHasLayout = false
    let localHasTree = false
    let localHasAi = false
    let localHasDark = false
    try {
      localHasLayout = localStorage.getItem(LAYOUT_KEY) !== null
      localHasTree = localStorage.getItem(TREE_KEY) !== null
      localHasAi = localStorage.getItem(AI_KEY) !== null
      localHasDark = localStorage.getItem(DARK_KEY) !== null
    } catch {
      /* 隐私模式下忽略 */
    }
    let appliedRemotePrefs = false
    if (!localHasLayout && session.layout && typeof session.layout === 'object') {
      state.layout = {
        side: clampNumber(session.layout.side, LAYOUT_LIMITS.side.min, LAYOUT_LIMITS.side.max, state.layout.side),
        outline: clampNumber(session.layout.outline, LAYOUT_LIMITS.outline.min, LAYOUT_LIMITS.outline.max, state.layout.outline),
        chat: clampNumber(session.layout.chat, LAYOUT_LIMITS.chat.min, LAYOUT_LIMITS.chat.max, state.layout.chat),
        sideOpen: session.layout.sideOpen !== false,
        outlineOpen: session.layout.outlineOpen !== false,
        chatOpen: session.layout.chatOpen !== false,
      }
      appliedRemotePrefs = true
    }
    if (!localHasTree && Array.isArray(session.expanded)) {
      state.expanded = new Set(session.expanded.filter((item) => typeof item === 'string'))
      appliedRemotePrefs = true
    }
    if (!localHasAi && session.readerAi && typeof session.readerAi === 'object') {
      state.ai = {
        translateOn: session.readerAi.translateOn === true,
        onlyZh: session.readerAi.onlyZh === true,
        hideZh: session.readerAi.hideZh === true,
        sideBySide: session.readerAi.sideBySide === true,
      }
      appliedRemotePrefs = true
    }
    if (!localHasDark && [0, 1, 2].includes(session.dark)) {
      state.dark = session.dark
      applyDark()
      appliedRemotePrefs = true
    }
    if (appliedRemotePrefs) render()
  }
  if (session && session.paperId && state.papers.some((paper) => paper.id === session.paperId)) {
    sessionRestoring = true
    try {
      await openPaper(session.paperId, { session })
    } finally {
      sessionRestoring = false
    }
    saveSession()
  }
  const link = new URLSearchParams(location.search)
  if (link.has('paper')) {
    await navigateReader({
      paperId: link.get('paper'),
      page: Number(link.get('page') || 1),
      blockId: link.get('block'),
      sectionId: link.get('section'),
      revision: link.get('revision'),
    })
  }
  if (state.session.available && state.layout.chatOpen && state.current) startSessionStream()
  notifyReaderState()
}

// 关闭 / 切走时把当前位置记下来（pagehide 比 beforeunload 在嵌入场景更可靠）
window.addEventListener('pagehide', () => saveSession({}, { keepalive: true }))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession({}, { keepalive: true })
})

// 调试/自测钩子：浏览器控制台里可以直接读 state、注入 mock、手动触发渲染。
window.__pb = {
  state,
  rpc,
  render,
  loadDoc,
  openPaper,
  openSettings,
  loadDoctor,
  translateSection,
  translateAll,
  translateSelection,
  pauseTranslate,
  resumeTranslate,
  createRichAnnotation,
  deleteAnnotationById,
  clearParagraphAnnotations,
  clearAllAnnotations,
  openAnnotationPopover,
  closeAnnotationPopover,
  applyParagraphAnnotations,
  extractCleanSelection,
  toggleParaCollapse,
  draftSelection,
  ensurePageTextLayer,
  loadLatestFeed,
  importFromDir,
  exportPaperMarkdown,
  sendChat,
  sectionsOf,
  saveSession,
  loadSession,
}

boot()
