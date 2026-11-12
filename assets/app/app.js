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
const CHAT_URL = '/paper-workbench/ai/chat'
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
  chat: { messages: [], busy: false, abort: null, error: '', draft: '' },
  chatDraft: '',
  card: null,
  settings: null,
  aiDraft: null,
  showSettings: false,
  selection: null,
  health: null,
  busy: '',
  online: { q: '', source: 'both', items: [], loading: false, error: '' },
  ocr: null,
  ocrPages: [],
  ocrBusy: '',
  ocrToken: '',
  ocrClear: false,
  // v3：文内搜索 / PDF 深色 / 回收站 / 任务日志 / 自检 / 配图 / 原生会话
  search: { open: false, q: '', hits: [], active: 0, busy: false, error: '' },
  dark: loadDark(),
  trash: { open: false, items: [], busy: false, error: '' },
  logs: { open: false, events: [], lastSeq: 0, timer: null, busy: false },
  review: null,
  reviewBusy: false,
  figures: [],
  figuresByKey: {},
  chatMode: 'session', // session = 落进真正的 DSH 会话；local = 插件自绘（老宿主兜底）
  session: { available: false, frames: [], streaming: false, abort: null, error: '', started: '' },
  // v3.1：一个「对话」= 一条 DSH 会话，可挂多篇论文 + 附件，多轮持久
  chats: { items: [], activeId: '', loading: false, error: '', available: true },
  convMenu: false,
  convPicker: { open: false, q: '' },
  attachBusy: false,
}

let pendingScrollReset = false

// ---------------------------------------------------------------- 小工具

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
  toastEl.textContent = message
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastEl.hidden = true
  }, ms)
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

function selectionText() {
  const selection = window.getSelection()
  return selection ? String(selection).trim() : ''
}

/**
 * 划词取文不能只信「此刻」的选择区：
 * - 点按钮会把选择区塌成光标（鼠标按下处），String(selection) 变成空串或残余一两个字符；
 * - 重渲染换掉正文节点时，Chrome 会把选择区挪到新节点上，留下一段「不是用户选的东西」。
 * 所以拖选过程中（selectionchange）持续记住最后一次像样的选区文本，取文时优先用它。
 */
let selectionMemory = { text: '', at: 0 }
const SELECTION_MEMORY_MS = 5 * 60 * 1000

/** 用户此刻选中的正文（只在阅读区里算数，输入框/按钮里的选择不算）。 */
function liveReaderSelection() {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return ''
  const text = String(selection).trim()
  if (!text) return ''
  const anchor = selection.anchorNode
  const element = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
  if (!element || !element.closest) return ''
  return element.closest('.compare, .page-pane, .markdown, .blocks') ? text : ''
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
function saveSession(patch = {}) {
  if (sessionRestoring) return
  const meta = state.current && state.current.meta
  const scroller = document.querySelector('.compare-scroll')
  const existing = loadSession()
  // 没打开论文时（刚启动）不要把上次的 paperId 抹成 null，否则下次进来就回到空态
  const next = {
    paperId: (meta && meta.id) || existing.paperId || null,
    tab: state.tab,
    page: state.page,
    sectionId: state.sectionId || null,
    scrollTop: scroller ? scroller.scrollTop : existing.scrollTop,
    ...patch,
  }
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...existing, ...next, at: new Date().toISOString() }))
  } catch {
    /* 隐私模式下忽略 */
  }
  // 同时写一份到插件自己的数据目录：桌面端重启后端口会变，localStorage 按站点隔离会丢，
  // 服务端这份能让「退出再进」跨重启也回到原处。
  if (state.current || patch.paperId) {
    rpc('ui.set', { state: { paperId: next.paperId, tab: next.tab, page: next.page, scrollTop: next.scrollTop, sectionId: next.sectionId } }).catch(
      () => {},
    )
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
  if (!remote || !remote.paperId) return local || {}
  if (!local || !local.paperId) return remote
  return String(remote.at || '') > String(local.at || '') ? remote : local
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
    return { translateOn: raw.translateOn === true, onlyZh: raw.onlyZh === true }
  } catch {
    return { translateOn: false, onlyZh: false }
  }
}

function saveAiState() {
  try {
    localStorage.setItem(AI_KEY, JSON.stringify(state.ai))
  } catch {
    /* 同上 */
  }
}

// ---------------------------------------------------------------- 布局（三栏 + 目录列）

const shellColumns = (layout) => {
  const tracks = []
  if (layout.sideOpen) tracks.push(layout.side + 'px', '6px')
  tracks.push('minmax(0,1fr)')
  if (layout.chatOpen) tracks.push('6px', layout.chat + 'px')
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
  })
  element.addEventListener('pointermove', (event) => {
    if (!drag) return
    // 对话列在右侧：分隔条往左拖才是变宽，方向和左列相反
    const delta = event.clientX - drag.startX
    setWidth(drag.start + (kind === 'chat' ? -delta : delta))
  })
  element.addEventListener('pointerup', () => finishDrag(true))
  element.addEventListener('pointercancel', () => finishDrag(true))
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
    if (paragraph.kind === 'formula') return false // 公式/表格段不翻
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
  return {
    start(data) {
      const key = normalizeKey(data && data.key)
      if (!key) return
      const item = state.streams.get(key) || { status: 'streaming', text: '', message: '' }
      item.status = 'streaming'
      state.streams.set(key, item)
      paintTranslation(key)
    },
    delta(data) {
      const key = normalizeKey(data && data.key)
      if (!key) return
      const item = state.streams.get(key) || { status: 'streaming', text: '', message: '' }
      item.status = 'streaming'
      item.text = (item.text || '') + String((data && data.text) || '')
      state.streams.set(key, item)
      paintTranslation(key)
    },
    done(data) {
      const key = normalizeKey(data && data.key)
      if (!key || job.done.has(key)) return // 幂等：同一次请求重复 done 只覆盖一次
      job.done.add(key)
      const text = String((data && data.text) || '').trim()
      if (text !== '') state.trans[key] = { zh: text, model: (data && data.model) || '', at: new Date().toISOString() }
      state.streams.delete(key)
      paintTranslation(key)
      paintTranslateChrome()
    },
    error(data) {
      const key = normalizeKey(data && data.key)
      if (!key) return
      job.failed.add(key)
      state.streams.set(key, { status: 'error', text: '', message: String((data && data.message) || '翻译失败') })
      paintTranslation(key)
      paintTranslateChrome()
    },
    end(data) {
      state.translateBusy = false
      paintTranslateChrome()
      if (data && data.ok === false) {
        state.translateError =
          job.mode === 'titles'
            ? '目录翻译没有全部成功，失败的标题可以点「重试」'
            : '翻译没有全部成功，失败的段落可以点「重试」'
        paintTranslateChrome()
      }
    },
  }
}

async function runTranslate(body, job) {
  if (state.translateBusy) {
    toast('已有翻译任务在进行，先停止或等它结束')
    return
  }
  if (!state.current) return
  state.translateBusy = true
  state.translateError = ''
  state.job = job
  state.translateReqId = genId()
  markPending(job)
  render() // 先让占位的“翻译中…”出现，并显示停止按钮
  const controller = new AbortController()
  state.translateAbort = controller
  try {
    await streamSse(TRANSLATE_URL, { ...body, reqId: state.translateReqId }, translateHandlers(job), controller.signal)
  } catch (error) {
    if (error.name !== 'AbortError') {
      state.translateError = '翻译失败：' + error.message
      toast(state.translateError, 5000)
    }
  } finally {
    if (state.translateAbort === controller) state.translateAbort = null
    state.translateBusy = false
    // 未收到 done 的段落标记为中断，已缓存的译文优先保留
    for (const [key, item] of [...state.streams]) {
      if (item.status === 'pending' || item.status === 'streaming') {
        if (state.trans[key]) state.streams.delete(key)
        else if (!state.translateError) state.streams.set(key, { status: 'error', text: '', message: '翻译已停止，可重试' })
      }
    }
    paintAllTranslations()
    paintTranslateChrome()
    if (state.tab === 'compare') {
      const status = document.getElementById('translate-status')
      if (status) status.textContent = state.translateError || progressText()
    }
  }
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
  const ok = window.confirm('整篇翻译：' + sections.length + ' 节 · ' + paragraphs.length + ' 段。\n\n会按节串行推进，翻译结果写入这篇论文的 trans.json；中途可停止。继续？')
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
  // 只翻标题：额外带一个空 keys，让宿主把段落池收成空（只传 titles 会被当成整篇段落翻译）。
  // 这是宿主 lib/ai.js 的当前语义，写在请求里比依赖后端改更稳。
  runTranslate({ id: state.current.meta.id, titles: true, keys: [] }, job)
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

function stopTranslate() {
  const controller = state.translateAbort
  if (controller) {
    try {
      controller.abort()
    } catch {
      /* 已结束 */
    }
  }
  const reqId = state.translateReqId
  if (reqId) {
    fetch(API + 'ai/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reqId }) }).catch(() => {})
  }
  state.translateBusy = false
  // 停下来不是「翻完了」，状态栏要能区分，避免用户以为整篇已经完成
  if (state.job) state.job.stopped = true
  toast('已停止翻译')
  paintTranslateChrome()
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
  const job = state.job
  if (!job) return state.translateBusy ? '翻译中…' : ''
  const suffix = state.translateBusy ? '' : job.stopped ? '（已停止）' : '（已结束）'
  if (job.mode === 'titles') return '目录翻译 ' + Math.min(job.done.size, job.totalParagraphs) + '/' + job.totalParagraphs + suffix
  const sections = job.totalSections || JobSectionCount(job)
  const sectionText = sections > 0 ? sectionDoneCount(job) + '/' + sections + ' 节 · ' : ''
  return '翻译 ' + sectionText + Math.min(job.done.size, job.totalParagraphs) + '/' + job.totalParagraphs + ' 段' + suffix
  function JobSectionCount(current) {
    return current.keysBySection.size
  }
}

function toggleTranslate() {
  state.ai.translateOn = !state.ai.translateOn
  saveAiState()
  if (state.ai.translateOn) {
    const sectionId = state.sectionId || (sectionsOf()[0] && sectionsOf()[0].id)
    if (sectionId) translateSection(sectionId)
    else render()
  } else {
    render()
  }
}

function toggleOnlyZh() {
  state.ai.onlyZh = !state.ai.onlyZh
  saveAiState()
  render()
}

function paintTranslation(key) {
  const nodes = document.querySelectorAll('[data-zh="' + key + '"]')
  if (nodes.length === 0) return
  const text = state.trans[key] && state.trans[key].zh
  const stream = state.streams.get(key)
  for (const node of nodes) node.replaceChildren(...zhContent(key, text, stream))
  // 译文是在 render 之后才到的：.compare 的 show-zh 是渲染时算的，
  // 不补这一步，划词/单段翻译完成后段落下面的中文会被 display:none 藏起来。
  if (text || stream) {
    const compare = document.querySelector('.compare')
    if (compare && !compare.classList.contains('show-zh')) compare.classList.add('show-zh')
  }
}

function zhContent(key, text, stream) {
  if (text) return [h('div', { class: 'zh-text' }, text)]
  if (stream && stream.status === 'streaming') {
    return [h('div', { class: 'zh-text' }, stream.text || ''), h('span', { class: 'caret' })]
  }
  if (stream && stream.status === 'pending') return [h('span', { class: 'muted' }, '翻译中…')]
  if (stream && stream.status === 'error') {
    return [h('span', { class: 'error' }, stream.message), h('button', { class: 'link', onclick: () => retryKey(key) }, '重试')]
  }
  return []
}

function paintAllTranslations() {
  const keys = new Set([...Object.keys(state.trans), ...state.streams.keys()])
  for (const key of keys) paintTranslation(key)
}

function paintTranslateChrome() {
  const status = document.getElementById('translate-status')
  if (status) {
    status.textContent = state.translateError || progressText()
    status.classList.toggle('error', state.translateError !== '')
  }
  const stop = document.getElementById('translate-stop')
  if (stop) stop.disabled = !state.translateBusy
  for (const id of ['translate-all', 'translate-section', 'translate-titles']) {
    const button = document.getElementById(id)
    if (button) button.disabled = !state.doc || state.translateBusy
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

async function openPaper(id, options = {}) {
  // 从会话记忆恢复时：页签、页码、当前节都按离开时的样子来，不重置成「对照 / 上次阅读页」
  const restore = options.session && options.session.paperId === id ? options.session : null
  try {
    state.busy = 'open'
    render()
    const value = await rpc('library.get', { id })
    state.current = value
    const wantedPage = restore && Number(restore.page) > 0 ? Number(restore.page) : value.meta.lastReadPage || 1
    state.page = Math.max(1, Math.min(wantedPage, value.meta.pageCount || 1))
    state.pageInfo = null
    state.blocks = []
    state.card = null
    state.ocr = value.ocr || null
    state.ocrPages = []
    state.tab = (restore && restore.tab) || 'compare'
    state.doc = null
    state.docError = ''
    state.trans = {}
    state.streams = new Map()
    state.job = null
    state.translateError = ''
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
    await Promise.all([loadPage(state.page), loadDoc(id), loadChat(id), loadAi(), loadFigures()])
    buildFiguresByKey()
    if (value.meta.status === 'unread') {
      await rpc('library.update', { id, patch: { status: 'reading' } }).catch(() => {})
      await loadLibrary()
    }
  } catch (error) {
    toast('打开失败：' + error.message)
  } finally {
    state.busy = ''
    render()
    if (restore && Number.isFinite(Number(restore.scrollTop))) {
      const scroller = document.querySelector('.compare-scroll')
      if (scroller) scroller.scrollTop = Number(restore.scrollTop)
    }
    saveSession({ paperId: id, tab: state.tab, page: state.page, sectionId: state.sectionId })
    if (state.session.available && state.layout.chatOpen) startSessionStream(true)
  }
}

/** 取一页页图/文本块；不负责 render，调用方决定何时重绘（避免打开论文时闪屏多次）。 */
async function loadPage(page) {
  if (!state.current) return
  const meta = state.current.meta
  const total = meta.pageCount || 0
  state.page = Math.max(1, Math.min(Number(page) || 1, total || Number(page) || 1))
  try {
    const text = await rpc('pdf.text', { id: meta.id, pages: [state.page] })
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
    if (info && info.pages) {
      meta.pageCount = info.pages
      state.page = Math.min(state.page, info.pages)
    }
    await rpc('library.update', { id: meta.id, patch: { lastReadPage: state.page } }).catch(() => {})
    saveSessionSoon({ page: state.page })
    // 连续滚动视图：重绘后滚到这一页（打开论文、跳转、搜索命中都靠它定位）
    state.pendingPage = state.page
  } catch (error) {
    state.blocks = []
    state.pageInfo = null
    toast('取文本层失败：' + error.message)
  }
}

async function loadDoc(id) {
  state.docBusy = true
  try {
    const value = await rpc('doc.get', { id })
    state.doc = (value && value.doc) || null
    state.docError = state.doc ? '' : 'doc.get 没有返回文档模型'
    state.trans = {}
    const entries = (value && value.trans && value.trans.entries) || {}
    for (const [key, entry] of Object.entries(entries)) state.trans[String(key).toLowerCase()] = entry
  } catch (error) {
    state.doc = null
    state.docError = error.message
    state.trans = {}
  } finally {
    state.docBusy = false
  }
}

async function rebuildDoc() {
  if (!state.current || state.docBusy) return
  state.docBusy = true
  render()
  try {
    await rpc('doc.build', { id: state.current.meta.id })
    await loadDoc(state.current.meta.id)
    toast('文档模型已重建')
  } catch (error) {
    state.docError = '重建失败：' + error.message
    toast('重建失败：' + error.message)
  } finally {
    state.docBusy = false
    render()
  }
}

async function loadCard() {
  if (!state.current) return
  try {
    state.card = await rpc('vault.read', { id: state.current.meta.id })
  } catch {
    state.card = null
  }
}

async function loadChat(id) {
  try {
    const value = await rpc('chat.get', { id })
    state.chat.messages = (value.messages || []).map((message) => ({
      role: message.role,
      content: message.content,
      model: message.model || '',
      context: message.context,
    }))
  } catch (error) {
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

async function loadOcrText() {
  if (!state.current) return
  try {
    const value = await rpc('ocr.text', { id: state.current.meta.id, pages: 'all' })
    state.ocrPages = value.pages || []
  } catch {
    state.ocrPages = []
  }
}

async function runOcr() {
  if (!state.current || state.ocrBusy) return
  const id = state.current.meta.id
  const model = (state.settings && state.settings.config && state.settings.config.ocr && state.settings.config.ocr.model) || ''
  const began = Date.now()
  state.ocrBusy = '正在提交 OCR 任务…'
  render()
  try {
    let status = await rpc('ocr.start', model ? { id, model } : { id })
    state.ocr = status
    while ((status.state === 'pending' || status.state === 'running') && Date.now() - began < 40 * 60 * 1000) {
      state.ocrBusy = 'OCR 进行中：' + (status.extractedPages || 0) + ' / ' + (status.totalPages || '?') + ' 页（已等 ' + Math.round((Date.now() - began) / 1000) + ' 秒）'
      render()
      await new Promise((resolve) => setTimeout(resolve, 2500))
      status = await rpc('ocr.status', { id })
      state.ocr = status
    }
    if (status.state === 'pending' || status.state === 'running') {
      throw new Error('等了 40 分钟还没完成，任务可能仍在云端跑；稍后回到这篇按「OCR 识别」查状态。')
    }
    if (status.state === 'failed') throw new Error(status.error || 'OCR 任务失败')
    await loadOcrText()
    await loadDoc(id) // 扫描件 OCR 完成后，对照视图用新的 ocr → doc
    toast('OCR 完成：' + (status.pages || state.ocrPages.length) + ' 页')
  } catch (error) {
    toast('OCR 失败：' + error.message)
  } finally {
    state.ocrBusy = ''
    render()
  }
}

// ---------------------------------------------------------------- 渲染入口

let deferredRender = false
let deferredSince = 0
const RENDER_DEFER_MAX_MS = 1200

/** 选区消失（或等太久）后补做被推迟的整页重绘。 */
function flushDeferredRender() {
  if (!deferredRender) return
  if (liveReaderSelection().length >= 2 && Date.now() - deferredSince < RENDER_DEFER_MAX_MS) return
  deferredRender = false
  deferredSince = 0
  render()
}

function render() {
  // 用户正在正文里选字时别整页重绘：app.replaceChildren() 会把选区所在的节点一起换掉，
  // 拖选到一半节点被换掉，Chrome 会把选区挪到新节点上，mouseup 时取到的就不是用户选的那段。
  // 这里先记账，等选区空了（或最多等 RENDER_DEFER_MAX_MS）再补绘。
  if (liveReaderSelection().length >= 2) {
    if (!deferredSince) deferredSince = Date.now()
    if (Date.now() - deferredSince < RENDER_DEFER_MAX_MS) {
      deferredRender = true
      return
    }
  }
  deferredRender = false
  deferredSince = 0
  const previousScroll = pendingScrollReset ? 0 : (document.querySelector('.compare-scroll') || {}).scrollTop || 0
  const previousPageScroll = (document.querySelector('.page-scroll') || {}).scrollTop || state.pageScrollTop || 0
  const previousOutline = (document.querySelector('.outline') || {}).scrollTop || 0
  pendingScrollReset = false
  app.replaceChildren(renderShell())
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
}

function renderShell() {
  const layout = state.layout
  const children = []
  if (layout.sideOpen) children.push(renderSide(), makeSplitter('side'))
  children.push(renderMain())
  if (layout.chatOpen) children.push(makeSplitter('chat'), renderChat())
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
        h('button', { onclick: importFromVault, title: '扫描 Obsidian 卡片里记录的原始 PDF 并入库' }, '从笔记库导入'),
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
                  'aria-expanded': open ? 'true' : 'false',
                  onclick: () => toggleGroup(topic, searching),
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
                        onclick: () => openPaper(paper.id),
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
                      h('span', { class: 'dot ' + (paper.notesCount ? 'note' : paper.status || '') }),
                      h(
                        'span',
                        {},
                        h('div', { class: 'paper-title' }, paper.title),
                        h('div', { class: 'paper-meta' }, [paper.year, fmtAuthors(paper.authors), paper.pageCount ? paper.pageCount + ' 页' : ''].filter(Boolean).join(' · ')),
                      ),
                      h('span', { class: 'paper-meta' }, paper.status === 'read' ? '✓' : ''),
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
      h('span', {}, state.health && state.health.vault && state.health.vault.ok ? 'Obsidian ✓' : 'Obsidian ✗'),
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
  render()
}

function renderMain() {
  const overlays = []
  if (state.search.open) overlays.push(renderSearchOverlay())
  if (state.trash.open) overlays.push(renderTrashModal())
  if (state.convPicker.open) overlays.push(renderConvPicker())
  if (state.showSettings) return h('section', { class: 'main' }, renderTopbar(), h('div', { class: 'content' }, renderSettings()), ...overlays)
  const content = state.tab === 'online' || (!state.current && state.online.items.length > 0) ? renderOnline() : !state.current ? renderEmpty() : renderReader()
  return h('section', { class: 'main' }, renderTopbar(), content, ...overlays)
}

function paneButton(kind, label) {
  const open = state.layout[kind + 'Open']
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
    ['card', '卡片'],
  ]
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
              label + (key === 'notes' ? ' ' + (((state.current.notes && state.current.notes.highlights) || []).length) : ''),
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
    meta ? h('button', { class: 'ghost', 'data-act': 'search', disabled: !hostReady(), title: hostReady() ? '文内搜索（Ctrl+F）' : '重启桌面端后可用', onclick: openSearch }, '🔍') : null,
    h('button', { class: 'ghost', 'data-act': 'dark', title: 'PDF 深色（三档：关/柔和/强）', onclick: cycleDark }, state.dark === 0 ? '◐' : state.dark === 1 ? '◑' : '◒'),
    h('button', { class: 'ghost', 'data-act': 'trash', disabled: !hostReady(), title: hostReady() ? '回收站' : '重启桌面端后可用', onclick: openTrash }, '🗑'),
    meta
      ? h(
          'button',
          {
            class: 'ghost',
            title: '移入回收站（PDF 不删）',
            onclick: async () => {
              if (!window.confirm('把这篇文章移出文献库？（PDF 不会删除，只会移入 .trash）')) return
              await rpc('library.remove', { id: meta.id }).catch((error) => toast(error.message))
              state.current = null
              state.doc = null
              await loadLibrary()
            },
          },
          '✕',
        )
      : null,
      h('button', { class: 'ghost', onclick: openSettings, title: '设置' }, '⚙'),
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
      h('h2', {}, '论文工作台 v2：对照阅读 + 面板内翻译与对话'),
      h(
        'ol',
        {},
        h('li', {}, '左侧导入本地 PDF，或点「在线检索」按关键词 / arXiv 号 / DOI 找开放获取论文；'),
        h('li', {}, '打开论文后默认进入「对照」：节标题 + 原文段 + 中文译文连续滚动，目录点击只跳转；'),
        h('li', {}, '工具栏的「译」开关逐段翻译当前节，「整篇翻译」按节串行推进，「停止」随时中断；'),
        h('li', {}, '右侧对话抽屉流式回答，回答里的 [p.N] 可点开原文页；翻译/对话模型在设置里选。'),
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
    paintOutlineActive()
  } else if (state.tab === 'page') {
    loadPage(section.page || 1).then(() => render())
  }
}

function explainSection(sectionId) {
  const section = sectionsOf().find((item) => item.id === sectionId)
  if (!state.layout.chatOpen) {
    state.layout.chatOpen = true
    saveLayout()
  }
  sendChat('讲解本节：' + (section ? section.title : sectionId), chatContext({ sectionId }))
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
  // 只要已有译文或正在翻译就展示译文层：点「译本节 / 整篇翻译」时译开关可能是关的
  const hasZh = state.ai.translateOn || state.ai.onlyZh || Object.keys(state.trans).length > 0 || state.streams.size > 0
  const compare = h('div', {
    class: 'compare' + (hasZh ? ' show-zh' : '') + (state.ai.onlyZh ? ' only-zh' : ''),
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
    for (const paragraph of bySection.get(section.id) || []) {
      if (paragraph.kind === 'heading' && sameHeading(paragraph.text, section.title)) continue
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

function renderParagraph(paragraph) {
  const kind = paragraph.kind || 'body'
  const id = 'para-' + paragraph.id
  if (kind === 'heading') {
    const level = Math.min(4, Math.max(2, (paragraph.level || 2) + 1))
    return h('h' + level, { class: 'para kind-heading level-' + level, id }, paragraph.text)
  }
  const key = paragraphKey(paragraph)
  const entry = key ? state.trans[key] : null
  const para = h(
    'div',
    {
      class: 'para kind-' + kind + (entry ? ' has-zh' : ''),
      id,
      'data-key': key,
      'data-section': paragraph.section || '',
      'data-page': paragraph.page || 1,
      ondblclick: () => {
        const selected = selectionText()
        askSelection(selected || paragraph.text)
      },
    },
    h('div', { class: 'para-orig' }, paragraph.text),
  )
  if (kind === 'formula') {
    para.append(
      h(
        'div',
        { class: 'para-zh formula-note' },
        '（公式/表格段，见原文页 p.' + (paragraph.page || '?') + '）',
        h('button', { class: 'link', onclick: () => jumpToPage(paragraph.page || 1) }, '打开原文页'),
      ),
    )
    return para
  }
  if (key) para.append(h('div', { class: 'para-zh', 'data-zh': key }, ...zhContent(key, entry && entry.zh, state.streams.get(key))))
  const figures = key && state.figuresByKey ? state.figuresByKey[key] : null
  if (Array.isArray(figures)) for (const figure of figures) para.append(renderInlineFigure(figure))
  return para
}

function jumpToPage(page) {
  // 引用 [p.N]、目录跳转、搜索命中都走这里：切到原文页并滚到那一页
  const total = (state.current && state.current.meta && state.current.meta.pageCount) || 0
  const target = Math.max(1, Math.min(Number(page) || 1, total || Number(page) || 1))
  state.tab = 'page'
  state.page = target
  state.pendingPage = target
  loadPage(target).then(() => render())
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
  return h(
    'div',
    { class: 'toolbar compare-toolbar' },
    h(
      'button',
      {
        id: 'translate-toggle',
        class: 'switch' + (state.ai.translateOn ? ' on' : ''),
        role: 'switch',
        'aria-checked': state.ai.translateOn ? 'true' : 'false',
        title: '打开后对当前节逐段翻译',
        onclick: toggleTranslate,
      },
      '译',
    ),
    h('button', { id: 'translate-section', disabled: !docReady || state.translateBusy, onclick: () => translateSection(state.sectionId || (sectionsOf()[0] && sectionsOf()[0].id)) }, '译本节'),
    h('button', { id: 'translate-all', disabled: !docReady || state.translateBusy, onclick: confirmTranslateAll }, '整篇翻译'),
    h('button', { id: 'translate-stop', disabled: !state.translateBusy, onclick: stopTranslate }, '停止'),
    h('span', { class: 'translate-status' + (status === state.translateError && status ? ' error' : ''), id: 'translate-status' }, status),
    h('span', { class: 'spacer' }),
    h(
      'button',
      {
        id: 'only-zh-toggle',
        class: 'switch' + (state.ai.onlyZh ? ' on' : ''),
        role: 'switch',
        'aria-checked': state.ai.onlyZh ? 'true' : 'false',
        title: '隐藏原文，只看中文译文',
        onclick: toggleOnlyZh,
      },
      '只看译文',
    ),
    h('button', { id: 'translate-titles', disabled: !docReady || state.translateBusy, title: '批量翻译节标题，目录显示英文/中文两行', onclick: translateTitles }, '目录翻译'),
    state.job && state.job.failed && state.job.failed.size
      ? h('button', { id: 'retry-failed', title: '重新请求这些翻译失败的段落', onclick: retryFailedSegments }, '重试失败 ' + state.job.failed.size)
      : null,
    h('button', { id: 'review-run', disabled: !docReady || !hostReady() || state.reviewBusy, title: hostReady() ? '检查空译文、截断、残留英文、公式残留等可疑段落' : '重启桌面端后可用', onclick: () => runReview('static') }, state.reviewBusy ? '自检中…' : '自检'),
    h('button', { id: 'logs-toggle', class: 'ghost' + (state.logs.open ? ' active' : ''), disabled: !hostReady(), title: hostReady() ? '任务日志（翻译 / OCR / 自检）' : '重启桌面端后可用', onclick: toggleLogs }, '日志'),
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

function pageImageSrc(meta, page) {
  const scale = Math.max(1, Math.round(state.fitScale * state.zoom * 10) / 10)
  return API + 'page?id=' + encodeURIComponent(meta.id) + '&page=' + page + '&scale=' + scale
}

function renderPageBlock(meta, page) {
  const wrap = h('div', { class: 'page-wrap', 'data-page': String(page) })
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
    for (const rect of highlight.rects || []) {
      layer.append(
        h('div', {
          class: 'hl' + (highlight.color === 'note' ? ' note' : ''),
          style: { left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.w * 100 + '%', height: rect.h * 100 + '%' },
          title: highlight.text,
        }),
      )
    }
  }
  wrap.append(image, layer, h('span', { class: 'page-no' }, String(page)))
  return wrap
}

/** 只给视口附近的页发图片请求；同时用「中间那条线」判断当前在读第几页。 */
function setupPageScroll(stage) {
  if (!stage) return
  if (state.pageObserver) state.pageObserver.disconnect()
  if (state.pageSpy) state.pageSpy.disconnect()
  const loader = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const img = entry.target.querySelector('img[data-src]')
        if (img) {
          img.src = img.getAttribute('data-src')
          img.removeAttribute('data-src')
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
      h('button', { onclick: openSearch, title: '全文检索' }, '🔍 检索'),
      h('button', { onclick: () => explainPage() }, '讲解本页'),
      h('span', { class: 'spacer' }),
      state.current.meta.hasText === false || state.ocr
        ? h('button', { class: 'ghost', onclick: runOcr, disabled: !!state.ocrBusy, title: '扫描件：调用 PaddleOCR 识别全文' }, state.ocrBusy ? 'OCR 中…' : state.ocr && state.ocr.pages > 0 ? '重新 OCR' : 'OCR 识别')
        : null,
      h('button', { onclick: () => window.open(API + 'raw?id=' + encodeURIComponent(meta.id), '_blank') }, '浏览器打开 PDF'),
    ),
    ocrBar(),
    stage,
    h(
      'div',
      { class: 'statusbar' },
      h('span', { class: 'cur-page' }, '第 ' + state.page + ' 页'),
      h('span', {}, state.blocks.length + ' 个文本块'),
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
  function openSearch() {
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
  if (state.ocrBusy) return h('div', { class: 'ocr-bar' }, h('span', {}, state.ocrBusy))
  if (state.blocks.length === 0) {
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
            ? '扫描件：这一页没有文本层，可调用 PaddleOCR 识别整篇'
            : '扫描件：还没配置 PaddleOCR API Key（设置 → 扫描件 OCR）',
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: runOcr, disabled: !configured }, 'OCR 识别整篇'),
    )
  }
  if (ocrState.pages > 0) return h('div', { class: 'ocr-bar' }, h('span', { class: 'hint' }, '已 OCR ' + ocrState.pages + ' 页，可用于核对与问答'))
  return null
}

function explainPage() {
  if (!state.layout.chatOpen) {
    state.layout.chatOpen = true
    saveLayout()
  }
  sendChat('讲解第 ' + state.page + ' 页', chatContext({ page: state.page }))
}

// ---------------------------------------------------------------- 笔记 / 卡片

function renderNotesPane() {
  const notes = state.current.notes || { highlights: [] }
  const highlights = notes.highlights || []
  const pane = h('div', { class: 'pane' })
  pane.append(
    h(
      'div',
      { class: 'toolbar', style: { borderBottom: 'none', padding: '0 0 10px' } },
      h('span', { class: 'muted' }, highlights.length + ' 条高亮'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => insertPrompt(P.deepRead(state.current.meta)), title: '让 agent 精读全文并写入 Obsidian（走会话）' }, '精读整篇（交给会话）'),
    ),
  )
  if (highlights.length === 0) pane.append(h('div', { class: 'hint' }, '还没有笔记。到原文页或对照视图选中一段文字，点「高亮」即可收藏到这里。'))
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
          h('button', { onclick: () => askSelection(highlight.text) }, '问 AI'),
          h('button', { onclick: () => insertPrompt(P.askSelection(state.current.meta, highlight.text)) }, '插入会话'),
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
    return aside
  }
  aside.append(
    h(
      'div',
      { class: 'chat-quick' },
      h('button', { class: 'ghost', onclick: () => sendQuick('讲解本节', { scope: 'section' }) }, '讲解本节'),
      h('button', { class: 'ghost', onclick: () => { const text = pickedText(); if (text.length < 2) { toast('先在正文里选中一段文字'); return } sendQuick('讲解这段选中的原文：\n> ' + text.slice(0, 800), { scope: 'section', selection: text.slice(0, 2000) }) } }, '讲解选中段落'),
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

function openSettings() {
  state.showSettings = true
  loadAi(true).then(() => {
    state.aiDraft = {
      translateModel: (state.aiConfig && state.aiConfig.translateModel) || null,
      chatModel: (state.aiConfig && state.aiConfig.chatModel) || null,
      temperature: state.aiConfig && Number.isFinite(Number(state.aiConfig.temperature)) ? Number(state.aiConfig.temperature) : 0.2,
    }
    rpc('settings.get')
      .then((value) => {
        state.settings = value
        render()
      })
      .catch((error) => toast(error.message))
  })
  render()
}

function renderSettings() {
  const settings = state.settings || { config: {}, dataRoot: '' }
  const config = settings.config || {}
  const ai = state.aiConfig || {}
  const draft = state.aiDraft || {
    translateModel: ai.translateModel || null,
    chatModel: ai.chatModel || null,
    temperature: Number.isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2,
  }
  const field = (key, label, placeholder) =>
    h(
      'div',
      { class: 'field' },
      h('label', {}, label),
      h('input', {
        type: 'text',
        value: config[key] || '',
        placeholder: placeholder || '',
        onchange: (event) => {
          config[key] = event.target.value
        },
      }),
    )
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
  return h(
    'div',
    { class: 'modal settings-view' },
    h('div', { class: 'modal-head' }, h('h3', {}, '设置'), h('span', { class: 'spacer' }), h('button', { class: 'ghost', onclick: () => { state.showSettings = false; render() } }, '✕')),
    h('div', { class: 'hint' }, '数据目录：' + (settings.dataRoot || '')),
    field('python', 'Python 路径（留空自动探测）', 'F:\\ProGramApp\\Anaconda\\python.exe'),
    field('vault', 'Obsidian vault 路径（留空自动探测）', 'D:\\系统组件\\文档\\Obsidian Vault'),
    field('kb', '论文知识库目录（留空自动探测）', '...\\F盘编程知识库\\论文知识库'),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'PDF 存储方式'),
      h(
        'select',
        {
          onchange: (event) => {
            config.storage = event.target.value
          },
        },
        h('option', { value: 'link', selected: config.storage !== 'copy' }, 'link：只记原路径（省磁盘）'),
        h('option', { value: 'copy', selected: config.storage === 'copy' }, 'copy：复制进库（移动原文件也不怕）'),
      ),
    ),
    h('div', { class: 'divider' }, 'AI（翻译 / 对话）'),
    modelSelect('ai-translate-model', '翻译模型', 'translateModel'),
    modelSelect('ai-chat-model', '对话模型', 'chatModel'),
    h(
      'div',
      { class: 'field' },
      h('label', {}, '温度（0–1，默认 0.2；越低越稳定）'),
      h('input', {
        id: 'ai-temperature',
        type: 'number',
        min: '0',
        max: '1',
        step: '0.05',
        value: String(draft.temperature),
        // 保存按钮点击前如果输入框还没失焦，change 可能来不及触发；input 也记一次，避免温度白改
        oninput: (event) => {
          draft.temperature = Math.max(0, Math.min(1, Number(event.target.value) || 0))
        },
        onchange: (event) => {
          draft.temperature = Math.max(0, Math.min(1, Number(event.target.value) || 0))
        },
      }),
    ),
    state.aiConfig && state.aiConfig.target ? h('div', { class: 'hint' }, '目标语言：' + state.aiConfig.target) : null,
    state.aiModels && state.aiModels.ready === false ? h('div', { class: 'hint error' }, 'AI 暂不可用：' + (state.aiModels.reason || '宿主没有提供模型')) : null,
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
            config.ocr = Object.assign({}, config.ocr || {}, { model: event.target.value })
          },
        },
        ['PaddleOCR-VL-1.6', 'PP-StructureV3', 'PP-OCRv6'].map((model) =>
          h('option', { value: model, selected: ((config.ocr || {}).model || 'PaddleOCR-VL-1.6') === model }, model + (model === 'PaddleOCR-VL-1.6' ? '（版面 Markdown，推荐）' : model === 'PP-OCRv6' ? '（纯文字，最快）' : '（结构化版面）')),
        ),
      ),
    ),
    h(
      'div',
      { class: 'field-row' },
      h('span', { class: 'hint' }, 'Key 只存在本机 ' + ((settings.dataRoot || '') + '\\config.json') + '（权限 0600），不写进仓库、不进日志、不回传浏览器明文。'),
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
    h(
      'div',
      { class: 'foot' },
      h('button', { onclick: () => { state.showSettings = false; render() } }, '取消'),
      h(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            const patch = Object.assign({}, config)
            const token = (state.ocrToken || '').trim()
            patch.ocr = Object.assign({}, config.ocr || {}, { token: token ? token : state.ocrClear ? null : '' })
            try {
              await rpc('settings.set', { patch })
            } catch (error) {
              toast('普通设置保存失败：' + error.message)
            }
            const aiPatch = { translateModel: draft.translateModel, chatModel: draft.chatModel, temperature: draft.temperature }
            try {
              await saveAiPatch(aiPatch)
            } catch (error) {
              toast('AI 设置保存失败：' + error.message)
            }
            state.aiConfig = Object.assign({}, state.aiConfig, aiPatch)
            state.showSettings = false
            state.ocrToken = ''
            state.ocrClear = false
            await loadHealth()
            render()
            toast('设置已保存')
          },
        },
        '保存',
      ),
    ),
  )
}

// ---------------------------------------------------------------- 在线检索

function renderOnline() {
  const box = h('div', { class: 'online' })
  box.append(
    h(
      'div',
      { class: 'online-bar' },
      h('input', {
        type: 'search',
        placeholder: '关键词 / arXiv ID / DOI，例如：prompt tuning 或 2103.10385',
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
      h('button', { onclick: () => insertPrompt(P.vaultSearch(state.online.q || '论文')) }, '问笔记库'),
    ),
  )
  if (state.online.error) box.append(h('div', { class: 'error' }, state.online.error))
  for (const item of state.online.items) {
    box.append(
      h(
        'div',
        { class: 'result' },
        h('div', { class: 't' }, item.title),
        h('div', { class: 'a' }, h('span', { class: 'badge' }, item.source || ''), [item.year, fmtAuthors(item.authors), item.venue].filter(Boolean).join(' · ')),
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
          item.url || item.absUrl ? h('button', { onclick: () => window.open(item.url || item.absUrl, '_blank') }, '打开原文页') : null,
          h('button', { onclick: () => insertPrompt('帮我找并读一下这篇论文：' + item.title + (item.doi ? '（DOI ' + item.doi + '）' : '')) }, '让 agent 读'),
        ),
      ),
    )
  }
  if (!state.online.loading && state.online.items.length === 0 && !state.online.error) {
    box.append(h('div', { class: 'hint' }, '检索结果来自 arXiv 与 OpenAlex 的开放接口；点「下载并入库」会把 PDF 复制进库。'))
  }
  return h('div', { class: 'content' }, box)
}

async function doSearch() {
  const query = String(state.online.q || '').trim()
  if (!query) return
  state.online.loading = true
  state.online.error = ''
  render()
  try {
    const value = await rpc('search.online', { query, source: state.online.source, limit: 10 })
    state.online.items = value.items || []
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
  insertPrompt(P.compare(items))
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

async function importFromVault() {
  toast('正在扫描 Obsidian 卡片…')
  try {
    const value = await rpc('library.importFromVault')
    toast('扫描 ' + value.scanned + ' 张卡片，新入库 ' + value.imported.length + ' 篇，跳过 ' + value.skipped.length + ' 篇')
    await loadLibrary()
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
  state.selection = { text }
  floatingShownAt = Date.now()
  floating = h(
    'div',
    { class: 'floating-menu', style: { left: Math.min(window.innerWidth - 340, x) + 'px', top: Math.max(8, y - 44) + 'px' } },
    h('button', { onclick: () => { const selected = text; hideFloating(); askSelection(selected) } }, '问 AI'),
    h('button', { onclick: () => { const selected = text; hideFloating(); translateSelection(selected) } }, '翻译'),
    h('button', { onclick: () => { addHighlight(text); hideFloating() } }, '高亮'),
    h('button', { onclick: () => { copyText(text); hideFloating() } }, '复制'),
    h('button', { onclick: () => { const selected = text; hideFloating(); insertPrompt(P.askSelection(meta, selected)) } }, '插入会话'),
  )
  document.body.append(floating)
}

function askSelection(text) {
  if (!state.current) return
  if (String(text || '').trim().length < 2) {
    toast('没拿到选中的正文，请重新划选一段再点')
    return
  }
  if (!state.layout.chatOpen) {
    state.layout.chatOpen = true
    saveLayout()
  }
  sendChat('讲解这段选中的原文：\n> ' + String(text).slice(0, 1200), chatContext({ selection: String(text).slice(0, 2000) }))
}

/** 划词翻译：只触发这几次模型请求，不进对话、不留对话历史；译文贴在原文段下面。 */
function translateSelection(text) {
  const keys = selectionParagraphKeys()
  if (keys.length) {
    translateKeys(keys)
    return
  }
  // 没有段落模型（原文页 / 纯文本块）时退化成一次性小工具：结果贴在选区附近，不进对话
  translateSelectionCard(String(text || ''))
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
 * 一次性划词翻译（原文页 / 无段落模型时用）：/ai/translate 的 ad-hoc 分支，
 * 宿主不读缓存、不写 trans.json、不碰 chat.json，每次都是全新请求。
 */
async function translateSelectionCard(text) {
  const value = text.trim()
  if (value.length < 2 || !state.current) return
  // 老宿主没有 ad-hoc 通道：带 text 但没 keys 的请求会被当成「整篇翻译」，绝不能发。
  if (!(state.health && state.health.ai && state.health.ai.adhoc)) {
    toast('原文页划词翻译要重启桌面端后才生效；对照页的划词翻译现在就能用')
    return
  }
  let host = null
  const selection = window.getSelection()
  const anchor = selection && selection.anchorNode
  const start = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
  if (start && start.closest) host = start.closest('.blocks > *, .page-pane p, .markdown p, .para')
  const old = document.querySelector('.sel-trans')
  if (old) old.remove()
  const body = h('div', { class: 'zh-text' }, '翻译中…')
  const card = h(
    'div',
    { class: 'sel-trans' },
    h('div', { class: 'sel-trans-head' }, '划词译文', h('button', { class: 'link', onclick: () => card.remove() }, '关闭')),
    body,
  )
  if (host && host.parentElement) host.parentElement.insertBefore(card, host.nextSibling)
  else (document.querySelector('.content') || document.body).append(card)
  let accumulated = ''
  try {
    await streamSse(
      TRANSLATE_URL,
      { id: state.current.meta.id, text: value, reqId: genId() },
      {
        start() {},
        delta(data) {
          accumulated += String((data && data.text) || '')
          body.textContent = accumulated
        },
        done(data) {
          const final = String((data && data.text) || accumulated || '').trim()
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

async function addHighlight(text) {
  const note = window.prompt('给这段高亮加个备注（可留空）：') || ''
  const notes = state.current.notes || { highlights: [] }
  const block = state.blocks.find((item) => String(item.text || '').includes(text.slice(0, 24)))
  const rects = []
  if (block && state.pageInfo && block.x2 !== undefined) {
    rects.push({
      x: block.x / state.pageInfo.w,
      y: block.y / state.pageInfo.h,
      w: (block.x2 - block.x) / state.pageInfo.w,
      h: (block.y2 - block.y) / state.pageInfo.h,
    })
  }
  const highlights = (notes.highlights || []).concat([{ page: state.page, text, note, rects, color: 'note', at: new Date().toISOString() }])
  await saveNotes(highlights)
  toast('已保存高亮')
}

// ---------------------------------------------------------------- 会话注入（次要通道）

function insertPrompt(text) {
  window.parent.postMessage({ __pb: true, type: 'insert-prompt', text }, '*')
  toast('已写入当前会话输入框，回到对话里发送即可')
}

const P = {
  deepRead: (m) =>
    '请精读这篇论文并把结果落到 Obsidian。\n标题：《' + m.title + '》\n库内 id：' + m.id + '\n\n步骤：\n1. 调用 paper_read（id="' + m.id + '"，先 pages="1-6"，需要再往后读）读完全文；\n2. 用中文输出七节报告：摘要、研究问题、方法、主要贡献、实验与结论、局限、可复现要点；\n3. 调用 paper_obsidian（id="' + m.id + '"，report=<报告全文>）把报告写进卡片。\n\n要求：每条结论后面用 [p.N] 标注原文页码；不要编造实验数字。',
  askSelection: (m, text) =>
    '关于论文《' + m.title + '》（id="' + m.id + '"），我选中了这段原文：\n> ' + String(text).slice(0, 1200) + '\n\n请用中文解释它的含义，并说明它在论文论证里的作用；必要时用 paper_read（id="' + m.id + '"）回看上下文，回答里标 [p.N]。',
  syncCard: (m) =>
    '请把论文《' + m.title + '》（id="' + m.id + '"）的知识化字段写进 Obsidian 卡片：\n先用 paper_read 读全文，然后调用 paper_obsidian（id="' + m.id + '", sections={"一句话结论": "...", "研究问题": "...", "方法线索": "...", "应用场景": "...", "局限线索": "..."}）。\n每个字段 1-2 句，忠于原文，不要空话。',
  compare: (items) =>
    '请对比下面几篇论文，写一篇中文主题综述（不是逐篇摘要）：\n' +
    items.map((m, i) => i + 1 + '. 《' + m.title + '》 id="' + m.id + '"').join('\n') +
    '\n\n步骤：\n1. 用 paper_read 逐篇读（每篇至少读摘要+方法+实验）；\n2. 先给一张对比表（问题设定 / 方法 / 数据与评测 / 主要结论 / 局限）；\n3. 再写研究脉络：共识、分歧、还没解决的问题；\n4. 最后用 paper_obsidian（action="survey", topic="<主题名>", markdown=<综述全文>）写入「方向综述」。',
  vaultSearch: (query) =>
    '请在 Obsidian 论文知识库里检索与「' + query + '」相关的卡片（paper_obsidian action="search", query="' + query + '"），然后用中文总结：这个主题下已经有哪些论文、各自的结论是什么、还缺什么。',
}

// ---------------------------------------------------------------- 全局事件

document.addEventListener('selectionchange', () => {
  const text = selectionText()
  if (text.length >= 2) selectionMemory = { text, at: Date.now() }
  flushDeferredRender()
})

document.addEventListener('mouseup', (event) => {
  if (floating && floating.contains(event.target)) return
  const text = selectionText()
  const target = event.target
  // 划词只对正文/对话区域生效；点在按钮、输入框、目录上不弹菜单
  const inText = target && target.closest && target.closest('.compare, .page-pane, .markdown, .blocks, .chat-messages')
  if (inText && text.length >= 2 && text.length <= 4000 && state.current) {
    const range = window.getSelection().getRangeAt(0)
    const rect = range.getBoundingClientRect()
    showFloating(rect.left, rect.top, text)
  } else if (!floating) {
    hideFloating()
  }
})

document.addEventListener('click', (event) => {
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
    const value = await rpc('search.doc', { id: state.current.meta.id, query: q, limit: 120 })
    state.search.hits = Array.isArray(value.hits) ? value.hits : []
    state.search.active = 0
    if (state.search.hits.length === 0) state.search.error = '没有命中'
  } catch (error) {
    state.search.hits = []
    state.search.error = error.message
  }
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
    render()
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

async function loadFigures() {
  if (!state.current) {
    state.figures = []
    state.figuresByKey = {}
    return
  }
  try {
    const value = await rpc('figures.list', { id: state.current.meta.id })
    state.figures = Array.isArray(value.figures) ? value.figures : []
  } catch {
    state.figures = []
  }
  buildFiguresByKey()
}

/** 把配图按「正文里提到 图 N / Figure N 的段落」分组；与 lib/figures.js 的 assignFigures 同一套规则。 */
function buildFiguresByKey() {
  const map = {}
  state.figuresByKey = map
  const paragraphs = (state.doc && state.doc.paragraphs) || []
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
  for (const paragraph of paragraphs) {
    if ((paragraph.kind || 'body') !== 'body') continue
    const label = labelOf(paragraph.text)
    if (!label) continue
    const key = paragraphKey(paragraph)
    if (!key) continue
    const hits = state.figures
      .map((figure, position) => ({ figure, position }))
      .filter(({ figure }) => Number(figure.label) === label && !used.has(figure.position ?? -1))
    for (const { figure, position } of hits) {
      if (used.has(position)) continue
      used.add(position)
      if (!map[key]) map[key] = []
      map[key].push({ ...figure, position })
    }
  }
  // 没有 label 的图：按同页最近段落兜底，至少让读者能看到
  for (let position = 0; position < state.figures.length; position += 1) {
    if (used.has(position)) continue
    const figure = state.figures[position]
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

function renderInlineFigure(figure) {
  const src = API + 'figure?id=' + encodeURIComponent(state.current.meta.id) + '&index=' + figure.position
  const caption = figure.caption || '图 ' + (figure.label || figure.position + 1)
  return h(
    'figure',
    { class: 'inline-fig' },
    h('img', {
      src,
      alt: caption,
      loading: 'lazy',
      title: '点击看大图',
      onclick: () => window.open(src, '_blank', 'noopener'),
    }),
    h('figcaption', {}, caption),
  )
}

// --- 翻译自检

async function runReview(mode = 'static') {
  if (!state.current) return
  if (!hostReady()) {
    needRestart()
    return
  }
  state.reviewBusy = true
  render()
  try {
    const value = await rpc('review.run', { id: state.current.meta.id, mode })
    state.review = value.review || null
    const count = (state.review && state.review.issues ? state.review.issues.length : 0)
    toast(count ? '自检发现 ' + count + ' 处可疑译文' : '自检通过：没发现明显问题')
  } catch (error) {
    toast('自检失败：' + error.message)
  }
  state.reviewBusy = false
  render()
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
  try {
    const value = await rpc('logs.list', { id: state.current.meta.id, after: 0, limit: 300 })
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
    if (frame.kind === 'message') {
      out.push({ role: frame.role || 'assistant', text: frame.text || '' })
      live = null
    } else if (frame.kind === 'delta') {
      if (!live) {
        live = { role: 'assistant', text: '', streaming: true }
        out.push(live)
      }
      live.text += frame.text || ''
    } else if (frame.kind === 'done') {
      if (live) live.streaming = false
      live = null
    }
  }
  return out
}

async function startSessionStream(force = false) {
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
  render()
  try {
    await streamSseGet(
      '/paper-workbench/session/follow?conv=' + encodeURIComponent(id),
      {
        frame: (frame) => {
          state.session.frames.push(frame)
          if (state.session.frames.length > 400) state.session.frames = state.session.frames.slice(-400)
          render()
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
    const title = String((paper.meta && paper.meta.title) || '')
    return title.toLowerCase().includes(q) || paper.id.includes(q)
  })
  const list = h('div', { class: 'picker-list' })
  if (items.length === 0) list.append(h('div', { class: 'hint' }, picked.size > 0 ? '所有论文都已经在这个对话里了' : '没有匹配的论文'))
  for (const paper of items.slice(0, 200)) {
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
        h('span', { class: 'picker-title' }, String((paper.meta && paper.meta.title) || paper.id)),
        h('span', { class: 'picker-meta' }, (paper.meta && paper.meta.pages ? paper.meta.pages + ' 页' : '') + ' · ' + paper.id),
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
            sendSessionMessage('讲解这段选中的原文：\\n> ' + text.slice(0, 800))
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
    const body = h('div', { class: 'msg-body' + (message.streaming ? ' streaming' : '') })
    body.innerHTML = renderAssistantHtml(message.text)
    if (message.streaming) body.append(h('span', { class: 'caret' }))
    list.append(h('div', { class: 'msg assistant' }, body, h('div', { class: 'msg-actions' }, h('button', { class: 'link', onclick: () => copyText(message.text) }, '复制'))))
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

function retryFailedSegments() {
  const failed = state.job && state.job.failed ? [...state.job.failed] : []
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
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'f' && state.current) {
      event.preventDefault()
      openSearch()
    }
  })
  render()
  await Promise.all([loadHealth(), loadAi()])
  state.session.available = !!(state.health && state.health.session && state.health.session.available)
  if (!state.session.available) state.chatMode = 'local'
  else await loadConversations().catch(() => {})
  await loadLibrary()
  render()
  // 面板关掉再打开等于重开页面：把上次看到哪儿、停在哪个页签还原回去。
  // 本地一份（同端口刷新快）+ 服务端一份（桌面端重启换端口也不丢），取较新的。
  const session = pickSession(loadSession(), await loadSessionRemote())
  if (session && session.paperId && state.papers.some((paper) => paper.id === session.paperId)) {
    sessionRestoring = true
    try {
      await openPaper(session.paperId, { session })
    } finally {
      sessionRestoring = false
    }
    saveSession()
  }
  if (state.session.available && state.layout.chatOpen && state.current) startSessionStream()
}

// 关闭 / 切走时把当前位置记下来（pagehide 比 beforeunload 在嵌入场景更可靠）
window.addEventListener('pagehide', () => saveSession())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession()
})

// 调试/自测钩子：浏览器控制台里可以直接读 state、注入 mock、手动触发渲染。
window.__pb = {
  state,
  rpc,
  render,
  loadDoc,
  openPaper,
  translateSection,
  translateAll,
  translateSelection,
  sendChat,
  sectionsOf,
  saveSession,
  loadSession,
}

boot()
