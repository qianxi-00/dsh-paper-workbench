/**
 * 论文工作台 SPA（vanilla JS，无构建）。
 *
 * 三件事：
 *   1. 文献库：本地论文列表、按专题分组、搜索、导入（路径 / 上传 / Obsidian 卡片）。
 *   2. 阅读：页图 + 目录 + 全文检索 + 文本层划词 + 高亮笔记 + 中文页。
 *   3. 交给 agent：所有"理解/翻译/整理"按钮都只把一段带上下文的指令写进当前会话，
 *      真正的推理由原生会话里的 agent 用 paper_* 工具完成（面板不做独立对话）。
 */

const API = '/paper-workbench/api/'
const app = document.getElementById('app')
const toastEl = document.getElementById('toast')

const state = {
  papers: [],
  topics: [],
  filter: '',
  picked: new Set(),
  collapsed: new Set(),
  current: null, // { meta, outline, notes, zhChars }
  tab: 'read',
  page: 1,
  pageInfo: null, // { w, h }
  blocks: [],
  outlineOpen: true,
  zoom: 1,
  fitScale: 2,
  zh: '',
  card: null,
  online: { q: '', source: 'both', items: [], loading: false, error: '' },
  health: null,
  busy: '',
  showSettings: false,
  settings: null,
  selection: null,
  // 扫描件 OCR：ocr 是服务端状态（state/model/pages/error），ocrPages 是按页文本
  ocr: null,
  ocrPages: [],
  ocrBusy: '',
  ocrToken: '',
  ocrClear: false,
}

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
  if (!data.ok) throw new Error(data.error || '请求失败')
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

function fmtAuthors(authors) {
  if (!Array.isArray(authors) || authors.length === 0) return ''
  return authors.length > 3 ? authors.slice(0, 3).join(', ') + ' 等' : authors.join(', ')
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/** 够用的 Markdown 渲染：标题 / 引用 / 代码 / 粗体 / 列表 / 表格分隔线。 */
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
    if (/^\|/.test(line)) {
      out.push('<div class="muted">' + escapeHtml(line) + '</div>')
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
    .replace(/\$([^$]+)\$/g, '<span class="muted">$1</span>')
}

// ---------------------------------------------------------------- 会话注入

function insertPrompt(text) {
  window.parent.postMessage({ __pb: true, type: 'insert-prompt', text }, '*')
  toast('已写入当前会话输入框，回到对话里发送即可')
}

const P = {
  deepRead: (m) =>
    '请精读这篇论文并把结果落到 Obsidian。\n' +
    '标题：《' + m.title + '》\n库内 id：' + m.id + '\n\n' +
    '步骤：\n' +
    '1. 调用 paper_read（id="' + m.id + '"，先 pages="1-6"，需要再往后读）读完全文；\n' +
    '2. 用中文输出七节报告：摘要、研究问题、方法、主要贡献、实验与结论、局限、可复现要点；\n' +
    '3. 调用 paper_obsidian（id="' + m.id + '"，report=<报告全文>）把报告写进卡片。\n\n' +
    '要求：每条结论后面用 [p.N] 标注原文页码；不要编造实验数字。',

  translateAll: (m) =>
    '请把这篇论文整本翻译成中文并写入库里。\n' +
    '标题：《' + m.title + '》\n库内 id：' + m.id + '\n\n' +
    '步骤：\n' +
    '1. 用 paper_read（id="' + m.id + '"）分批读原文，每次 2-3 页；\n' +
    '2. 逐页翻译：公式与术语保留（术语首次出现附英文原词），图表标题一并翻；每页译文以 "## p.N" 开头，需要时用 "> " 引用原文；\n' +
    '3. 每翻完一页调用 paper_translate（id="' + m.id + '", page=N, markdown=<该页译文>）追加写入；\n' +
    '4. 全部完成后报告总页数。\n\n' +
    '注意：不要一次把全文塞进一次调用，宁可多轮。',

  translatePage: (m, page) =>
    '请把论文《' + m.title + '》（id="' + m.id + '"）第 ' + page + ' 页翻译成中文：\n' +
    '1. paper_read（id="' + m.id + '", pages="' + page + '"）读原文；\n' +
    '2. 中文译文以 "## p.' + page + '" 开头，公式与术语保留；\n' +
    '3. 用 paper_translate（id="' + m.id + '", page=' + page + ', markdown=<译文>）写入。',

  explainPage: (m, page) =>
    '请讲解论文《' + m.title + '》（id="' + m.id + '"）第 ' + page + ' 页：\n' +
    '先用 paper_read（id="' + m.id + '", pages="' + page + '"）读原文，然后用中文说明：这一段在论证什么、关键定义/公式是什么、和全文主线的关系、我没看懂时该补什么背景。',

  askSelection: (m, text) =>
    '关于论文《' + m.title + '》（id="' + m.id + '"），我选中了这段原文：\n' +
    '> ' + String(text).slice(0, 1200) + '\n\n' +
    '请用中文解释它的含义，并说明它在论文论证里的作用；必要时用 paper_read（id="' + m.id + '"）回看上下文，回答里标 [p.N]。',

  translateSelection: (m, text) => '把下面这段论文原文翻译成中文（保留术语与公式）：\n> ' + String(text).slice(0, 1600),

  askPaper: (m) =>
    '请先用 paper_read（id="' + m.id + '"）读一遍论文《' + m.title + '》，然后用中文做一个 5 句话的导读：它解决什么问题、核心做法、最关键证据、局限、值不值得细读。',

  syncCard: (m) =>
    '请把论文《' + m.title + '》（id="' + m.id + '"）的知识化字段写进 Obsidian 卡片：\n' +
    '先用 paper_read 读全文，然后调用 paper_obsidian（id="' + m.id + '", sections={"一句话结论": "...", "研究问题": "...", "方法线索": "...", "应用场景": "...", "局限线索": "..."}）。\n' +
    '每个字段 1-2 句，忠于原文，不要空话。',

  compare: (items) =>
    '请对比下面几篇论文，写一篇中文主题综述（不是逐篇摘要）：\n' +
    items.map((m, i) => i + 1 + '. 《' + m.title + '》 id="' + m.id + '"').join('\n') + '\n\n' +
    '步骤：\n' +
    '1. 用 paper_read 逐篇读（每篇至少读摘要+方法+实验）；\n' +
    '2. 先给一张对比表（问题设定 / 方法 / 数据与评测 / 主要结论 / 局限）；\n' +
    '3. 再写研究脉络：共识、分歧、还没解决的问题；\n' +
    '4. 最后用 paper_obsidian（action="survey", topic="<主题名>", markdown=<综述全文>）写入「方向综述」。',

  vaultSearch: (query) =>
    '请在 Obsidian 论文知识库里检索与「' + query + '」相关的卡片（paper_obsidian action="search", query="' + query + '"），然后用中文总结：这个主题下已经有哪些论文、各自的结论是什么、还缺什么。',
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
  render()
}

async function loadHealth() {
  try {
    state.health = await rpc('health')
  } catch {
    state.health = null
  }
}

async function openPaper(id) {
  try {
    state.busy = 'open'
    render()
    const value = await rpc('library.get', { id })
    state.current = value
    state.page = Math.max(1, Math.min(value.meta.lastReadPage || 1, value.meta.pageCount || 1))
    state.pageInfo = null
    state.blocks = []
    state.zh = ''
    state.card = null
    state.ocr = value.ocr || null
    state.ocrPages = []
    state.tab = 'read'
    await loadPage(state.page)
    if (state.ocr && state.ocr.pages > 0) await loadOcrText()
    if (value.meta.status === 'unread') {
      await rpc('library.update', { id, patch: { status: 'reading' } }).catch(() => {})
      await loadLibrary()
    }
  } catch (error) {
    toast('打开失败：' + error.message)
  } finally {
    state.busy = ''
    render()
  }
}

async function loadPage(page) {
  if (!state.current) return
  state.page = Math.max(1, page)
  const meta = state.current.meta
  try {
    const text = await rpc('pdf.text', { id: meta.id, pages: [state.page] })
    const pageData = (text.pages || [])[0]
    if (pageData) {
      state.pageInfo = { w: pageData.w, h: pageData.h }
      state.blocks = pageData.blocks || []
    } else {
      state.pageInfo = null
      state.blocks = []
    }
    const info = await rpc('pdf.info', { id: meta.id }).catch(() => null)
    if (info && info.pages) {
      state.current.meta.pageCount = info.pages
      state.page = Math.min(state.page, info.pages)
    }
    await rpc('library.update', { id: meta.id, patch: { lastReadPage: state.page } }).catch(() => {})
  } catch (error) {
    // 文本层失败不阻断阅读：仍可看页图
    state.blocks = []
    state.pageInfo = null
    toast('取文本层失败：' + error.message)
  }
  render()
}

async function loadZh() {
  if (!state.current) return
  try {
    const value = await rpc('zh.read', { id: state.current.meta.id })
    state.zh = value.markdown || ''
    render()
  } catch (error) {
    toast('读取译文失败：' + error.message)
  }
}

async function loadCard() {
  if (!state.current) return
  try {
    state.card = await rpc('vault.read', { id: state.current.meta.id })
  } catch {
    state.card = null
  }
  render()
}

// ---------------------------------------------------------------- OCR（扫描件）

/** 拉全篇 OCR 文本，按页存起来，文本页按当前页取用。 */
async function loadOcrText() {
  if (!state.current) return
  try {
    const value = await rpc('ocr.text', { id: state.current.meta.id, pages: 'all' })
    state.ocrPages = value.pages || []
  } catch {
    state.ocrPages = []
  }
}

/** 提交 OCR 任务并轮询进度；完成后切到「文本」页显示结果。 */
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
    // 最长等 40 分钟：PaddleOCR 高峰期排队会慢，但不想无限轮询下去
    while ((status.state === 'pending' || status.state === 'running') && Date.now() - began < 40 * 60 * 1000) {
      const waited = Math.round((Date.now() - began) / 1000)
      state.ocrBusy =
        'OCR 进行中：' +
        (status.extractedPages || 0) +
        ' / ' +
        (status.totalPages || '?') +
        ' 页（已等 ' +
        waited +
        ' 秒）'
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
    state.tab = 'text'
    toast('OCR 完成：' + (status.pages || state.ocrPages.length) + ' 页')
  } catch (error) {
    toast('OCR 失败：' + error.message)
  } finally {
    state.ocrBusy = ''
    render()
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

// ---------------------------------------------------------------- 渲染

function render() {
  app.replaceChildren(renderShell())
}

function renderShell() {
  return h('div', { class: 'shell' }, renderSide(), renderMain())
}

function renderSide() {
  const filtered = state.papers.filter((paper) => {
    if (!state.filter) return true
    const haystack = [paper.title, paper.year, (paper.tags || []).join(' '), (paper.topics || []).join(' '), paper.arxivId]
      .join(' ')
      .toLowerCase()
    return haystack.includes(state.filter.toLowerCase())
  })
  const groups = new Map()
  for (const paper of filtered) {
    const key = (paper.topics && paper.topics[0]) || '未分类'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(paper)
  }

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
            render()
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
          ? h(
              'button',
              {
                class: 'primary',
                title: '让 agent 对比这些论文并写一篇方向综述',
                onclick: () => {
                  const items = state.papers.filter((paper) => state.picked.has(paper.id))
                  if (items.length < 2) {
                    toast('至少选 2 篇才能对比')
                    return
                  }
                  insertPrompt(P.compare(items))
                },
              },
              '对比综述 (' + state.picked.size + ')',
            )
          : null,
        state.picked.size > 0
          ? h('button', { class: 'ghost', onclick: () => { state.picked.clear(); render() } }, '取消选择')
          : null,
      ),
    ),
    h(
      'div',
      { class: 'tree' },
      filtered.length === 0
        ? h('div', { class: 'hint', style: { padding: '10px 6px' } }, '还没有论文。用上面的按钮导入，或先去在线检索。')
        : [...groups.entries()].map(([topic, items]) => {
            const collapsed = state.collapsed.has(topic)
            return h(
              'div',
              { class: 'topic' },
              h(
                'div',
                {
                  class: 'topic-title',
                  onclick: () => {
                    if (collapsed) state.collapsed.delete(topic)
                    else state.collapsed.add(topic)
                    render()
                  },
                },
                h('span', {}, (collapsed ? '▸ ' : '▾ ') + topic),
                h('span', {}, items.length),
              ),
              collapsed
                ? null
                : items.map((paper) =>
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
                  ),
            )
          }),
    ),
    h(
      'div',
      { class: 'statusbar' },
      h('span', {}, state.health && state.health.pdf && state.health.pdf.ok ? 'PDF ✓' : 'PDF ✗'),
      h('span', {}, state.health && state.health.vault && state.health.vault.ok ? 'Obsidian ✓' : 'Obsidian ✗'),
      h(
        'span',
        { title: 'PaddleOCR 云端接口（扫描件）' },
        'OCR ' + (state.health && state.health.ocr && state.health.ocr.configured ? '✓' : '✗'),
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'ghost', onclick: openSettings, title: '设置' }, '⚙'),
    ),
  )
}

function toggleOnline() {
  state.tab = state.tab === 'online' ? 'read' : 'online'
  render()
}

function renderMain() {
  if (state.showSettings) return renderSettings()
  if (state.tab === 'online' || (!state.current && state.online.items.length > 0)) return renderMainWithTop(renderOnline())
  if (!state.current) return renderMainWithTop(renderEmpty())
  return renderMainWithTop(renderReader())
}

function renderMainWithTop(body) {
  return h('section', { class: 'main' }, renderTopbar(), body)
}

function renderTopbar() {
  if (!state.current) {
    return h(
      'div',
      { class: 'topbar' },
      h('span', { class: 'title' }, '论文工作台'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => toggleOnline() }, '在线检索'),
    )
  }
  const meta = state.current.meta
  const tabs = [
    ['read', '原文'],
    ['text', '文本'],
    ['zh', '中文'],
    ['notes', '笔记'],
    ['card', '卡片'],
  ]
  return h(
    'div',
    { class: 'topbar' },
    h('span', { class: 'title', title: meta.title }, meta.title),
    h(
      'div',
      { class: 'tabs' },
      tabs.map(([key, label]) =>
        h(
          'button',
          {
            class: 'tab' + (state.tab === key ? ' active' : ''),
            onclick: () => {
              state.tab = key
              if (key === 'zh') loadZh()
              if (key === 'card') loadCard()
              render()
            },
          },
          label + (key === 'notes' ? ' ' + ((state.current.notes && state.current.notes.highlights) || []).length : ''),
        ),
      ),
    ),
    h('span', { class: 'spacer' }),
    h('button', { class: 'primary', onclick: () => insertPrompt(P.deepRead(meta)), title: '让 agent 精读全文并写入 Obsidian' }, '精读整篇'),
    h('button', { onclick: () => insertPrompt(P.translateAll(meta)) }, '整本翻译'),
    h('button', { onclick: () => insertPrompt(P.askPaper(meta)) }, '导读'),
    h('button', { onclick: () => insertPrompt(P.syncCard(meta)) }, '写入卡片'),
    meta.hasText === false || state.ocr
      ? h(
          'button',
          { class: 'ghost', onclick: runOcr, disabled: !!state.ocrBusy, title: '扫描件：调用 PaddleOCR 识别全文' },
          state.ocrBusy ? 'OCR 中…' : state.ocr && state.ocr.pages > 0 ? '重新 OCR' : 'OCR 识别',
        )
      : null,
    h(
      'button',
      {
        class: 'ghost',
        title: '删除（移入回收站）',
        onclick: async () => {
          if (!confirm('把这篇文章移出文献库？（PDF 不会删除，只会移入 .trash）')) return
          await rpc('library.remove', { id: meta.id }).catch((error) => toast(error.message))
          state.current = null
          await loadLibrary()
        },
      },
      '✕',
    ),
  )
}

function renderEmpty() {
  return h(
    'div',
    { class: 'content' },
    h(
      'div',
      { class: 'empty' },
      h('h2', {}, '把论文放进工作台，然后交给会话里的 agent'),
      h(
        'ol',
        {},
        h('li', {}, '左侧导入本地 PDF，或点「在线检索」按关键词 / arXiv 号 / DOI 找开放获取论文；'),
        h('li', {}, '选中论文后可以看原文页图、目录、全文检索，划词直接送入当前对话；'),
        h('li', {}, '「精读整篇」「整本翻译」会把带论文 id 的指令写进当前会话，由 agent 调工具完成并落盘；'),
        h('li', {}, '结果会自动写回 Obsidian 论文知识库的卡片（frontmatter 行级合并，不动你手写的字段）。'),
      ),
    ),
  )
}

function renderReader() {
  const meta = state.current.meta
  return h(
    'div',
    { class: 'content' },
    h(
      'div',
      { class: 'reader' + (state.outlineOpen && state.current.outline.length > 0 ? ' with-outline' : '') },
      state.outlineOpen && state.current.outline.length > 0 ? renderOutline() : null,
      renderTabBody(),
    ),
  )
}

function renderOutline() {
  return h(
    'div',
    { class: 'outline' },
    state.current.outline.map((item) =>
      h(
        'div',
        {
          class: 'lv' + Math.min(3, item.level || 1),
          title: item.title,
          onclick: () => {
            loadPage(item.page || 1)
          },
        },
        item.title,
      ),
    ),
  )
}

function renderTabBody() {
  if (state.tab === 'text') return renderTextPane()
  if (state.tab === 'zh') return renderZhPane()
  if (state.tab === 'notes') return renderNotesPane()
  if (state.tab === 'card') return renderCardPane()
  return renderPagePane()
}

// ---------------------------------------------------------------- 原文页

function renderPagePane() {
  const meta = state.current.meta
  const total = meta.pageCount || 0
  const stage = h('div', { class: 'stage' })
  const wrap = h('div', { class: 'page-wrap' })
  // 先用已知的页面宽高比占位，避免图片加载前整个阅读区塌成 0 高
  if (state.pageInfo) wrap.style.aspectRatio = state.pageInfo.w + ' / ' + state.pageInfo.h
  const src = API + 'page?id=' + encodeURIComponent(meta.id) + '&page=' + state.page + '&scale=' + Math.max(1, Math.round(state.fitScale * state.zoom * 10) / 10)
  const image = h('img', { src, alt: 'p.' + state.page, draggable: false })
  image.addEventListener('load', () => {
    prefetch(state.page + 1)
  })
  image.addEventListener('error', () => {
    image.remove()
    wrap.append(
      h('div', { class: 'page-missing' }, '这一页渲染失败。若 PDF 未复制进库且原路径已移动，请重新导入；也可能是本机 Python/PyMuPDF 不可用（看左下角 PDF 状态）。'),
    )
  })
  const layer = h('div', { class: 'hl-layer' })
  const highlights = ((state.current.notes && state.current.notes.highlights) || []).filter((item) => item.page === state.page)
  if (state.pageInfo) {
    for (const highlight of highlights) {
      for (const rect of highlight.rects || []) {
        layer.append(
          h('div', {
            class: 'hl' + (highlight.color === 'note' ? ' note' : ''),
            style: {
              left: rect.x * 100 + '%',
              top: rect.y * 100 + '%',
              width: rect.w * 100 + '%',
              height: rect.h * 100 + '%',
            },
            title: highlight.text,
          }),
        )
      }
    }
  }
  wrap.append(image, layer)
  stage.append(wrap)

  return h(
    'div',
    { class: 'reader', style: { display: 'flex', flexDirection: 'column', flex: '1' } },
    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'pager' },
        h('button', { onclick: () => loadPage(state.page - 1), disabled: state.page <= 1 }, '‹'),
        h('input', {
          type: 'text',
          value: state.page,
          onchange: (event) => loadPage(Number(event.target.value) || 1),
        }),
        h('span', { class: 'muted' }, '/ ' + (total || '?')),
        h('button', { onclick: () => loadPage(state.page + 1), disabled: total > 0 && state.page >= total }, '›'),
      ),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => setZoom(state.zoom - 0.15) }, '－'),
      h('button', { onclick: () => setZoom(1), title: '适合宽度' }, Math.round(state.zoom * 100) + '%'),
      h('button', { onclick: () => setZoom(state.zoom + 0.15) }, '＋'),
      h('span', { class: 'sep' }),
      h('button', { class: state.outlineOpen ? 'primary' : '', onclick: () => { state.outlineOpen = !state.outlineOpen; render() } }, '目录'),
      h('button', { onclick: () => insertPrompt(P.explainPage(meta, state.page)) }, '讲解本页'),
      h('button', { onclick: () => insertPrompt(P.translatePage(meta, state.page)) }, '翻译本页'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: openSearch, title: '全文检索' }, '🔍 检索'),
      h('button', { onclick: () => window.open(API + 'raw?id=' + encodeURIComponent(meta.id), '_blank') }, '浏览器打开 PDF'),
    ),
    stage,
    h(
      'div',
      { class: 'statusbar' },
      h('span', {}, (state.pageInfo ? Math.round(state.pageInfo.w) + '×' + Math.round(state.pageInfo.h) + ' pt' : '无文本层')),
      h('span', {}, state.blocks.length + ' 个文本块'),
      h('span', { class: 'spacer' }),
      h('span', {}, '共 ' + (total || '?') + ' 页'),
    ),
  )

  function setZoom(value) {
    state.zoom = Math.max(0.4, Math.min(3, value))
    render()
  }
  function prefetch(page) {
    if (!page || (total && page > total)) return
    const img = new Image()
    img.src = API + 'page?id=' + encodeURIComponent(meta.id) + '&page=' + page + '&scale=2'
  }
  function openSearch() {
    const query = prompt('全文检索关键词：')
    if (!query) return
    rpc('pdf.search', { id: meta.id, query })
      .then((value) => {
        if (!value.hits || value.hits.length === 0) {
          toast('没有命中')
          return
        }
        state.tab = 'text'
        state.page = value.hits[0].page
        render()
        toast('共 ' + value.hits.length + ' 处命中，已跳到第 ' + value.hits[0].page + ' 页')
      })
      .catch((error) => toast(error.message))
  }
}

// ---------------------------------------------------------------- 文本页

function renderTextPane() {
  const meta = state.current.meta
  const pane = h('div', { class: 'pane' })
  const body = h('div', { class: 'blocks' })
  const ocrPage = (state.ocrPages || []).find((item) => Number(item.n) === Number(state.page))
  if (state.blocks.length === 0 && ocrPage) {
    // 扫描件：没有文本层，用 OCR 结果顶替本页文本
    body.append(h('div', { class: 'markdown', html: renderMarkdown(ocrPage.text) }))
  }
  for (const block of state.blocks) {
    const node = h(
      'div',
      {
        class: 'block' + (block.size && state.pageInfo && block.size < state.pageInfo.h * 0.012 ? ' small' : ''),
        title: '双击让 agent 解释这段',
        ondblclick: () => {
          const selection = window.getSelection()
          const text = selection && selection.toString().trim() ? selection.toString() : block.text
          insertPrompt(P.askSelection(meta, text))
        },
      },
      block.text,
    )
    body.append(node)
  }
  const ocrState = state.ocr || {}
  const ocrConfig = (state.health && state.health.ocr) || {}
  const ocrConfigured = ocrConfig.configured !== false && ocrState.configured !== false
  let ocrBar = null
  if (state.ocrBusy) {
    ocrBar = h('div', { class: 'ocr-bar' }, h('span', {}, state.ocrBusy))
  } else if (state.blocks.length === 0 && ocrPage) {
    ocrBar = h(
      'div',
      { class: 'ocr-bar' },
      h('span', { class: 'hint' }, '本页文本来自 PaddleOCR 识别（页码与原 PDF 对齐）'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'ghost', onclick: runOcr }, '重新识别'),
    )
  } else if (state.blocks.length === 0) {
    const failed = ocrState.state === 'failed'
    ocrBar = h(
      'div',
      { class: 'ocr-bar' },
      h(
        'span',
        {},
        failed
          ? 'OCR 失败：' + (ocrState.error || '未知错误')
          : ocrConfigured
            ? '扫描件：这一页没有文本层，可调用 PaddleOCR 识别整篇'
            : '扫描件：还没配置 PaddleOCR API Key（设置 → 扫描件 OCR）',
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: runOcr, disabled: !ocrConfigured }, 'OCR 识别整篇'),
    )
  } else if (ocrState.pages > 0) {
    ocrBar = h('div', { class: 'ocr-bar' }, h('span', { class: 'hint' }, '已 OCR ' + ocrState.pages + ' 页，可用于核对与问答'))
  }
  pane.append(
    h(
      'div',
      { class: 'toolbar', style: { borderBottom: 'none', padding: '0 0 8px' } },
      h('button', { onclick: () => loadPage(state.page - 1), disabled: state.page <= 1 }, '‹ 上一页'),
      h('span', { class: 'muted' }, '第 ' + state.page + ' 页'),
      h('button', { onclick: () => loadPage(state.page + 1) }, '下一页 ›'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, '选中文字可译/可问；双击段落直接提问'),
    ),
    ocrBar || h('div', {}),
    body,
  )
  return pane
}

// ---------------------------------------------------------------- 中文页

function renderZhPane() {
  const pane = h('div', { class: 'pane' })
  if (!state.zh) {
    pane.append(
      h(
        'div',
        { class: 'empty' },
        h('h2', {}, '还没有中文版'),
        h('p', {}, '点顶部「整本翻译」，agent 会分批读原文、逐页翻译并用 paper_translate 写进库；这一页会自动刷新。'),
        h('button', { class: 'primary', onclick: () => insertPrompt(P.translateAll(state.current.meta)) }, '开始整本翻译'),
      ),
    )
    return pane
  }
  pane.append(h('div', { class: 'markdown', html: renderMarkdown(state.zh) }))
  return pane
}

// ---------------------------------------------------------------- 笔记页

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
      h('button', { onclick: () => insertPrompt(P.syncCard(state.current.meta)) }, '整理成卡片字段'),
    ),
  )
  if (highlights.length === 0) {
    pane.append(h('div', { class: 'hint' }, '还没有笔记。到「文本」页选中一段文字，点「高亮」即可收藏到这里。'))
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
          h('button', { onclick: () => { state.page = highlight.page; state.tab = 'read'; loadPage(highlight.page) } }, '跳回原文'),
          h('button', { onclick: () => insertPrompt(P.askSelection(state.current.meta, highlight.text)) }, '问这段'),
          h('button', { onclick: () => insertPrompt(P.translateSelection(state.current.meta, highlight.text)) }, '翻译'),
          h(
            'button',
            {
              class: 'danger',
              onclick: () => {
                const next = highlights.filter((_, i) => i !== index)
                saveNotes(next)
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

// ---------------------------------------------------------------- 卡片页

function renderCardPane() {
  const pane = h('div', { class: 'pane' })
  if (!state.card) {
    pane.append(
      h(
        'div',
        { class: 'empty' },
        h('h2', {}, 'Obsidian 里还没有这张卡片'),
        h('p', {}, '可以现在生成：agent 会读全文，把「一句话结论 / 研究问题 / 方法线索 / 应用场景 / 局限线索」写进卡片；已存在则只改这些字段行。'),
        h('button', { class: 'primary', onclick: () => insertPrompt(P.syncCard(state.current.meta)) }, '生成并写入卡片'),
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
      h('button', { onclick: () => rpc('vault.open', { path: state.card.path }).catch((e) => toast(e.message)) }, '在 Obsidian 打开'),
      h('button', { onclick: () => loadCard() }, '刷新'),
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
        h(
          'div',
          { class: 'a' },
          h('span', { class: 'badge' }, item.source || ''),
          [item.year, fmtAuthors(item.authors), item.venue].filter(Boolean).join(' · '),
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
          item.url || item.absUrl
            ? h('button', { onclick: () => window.open(item.url || item.absUrl, '_blank') }, '打开原文页')
            : null,
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

// ---------------------------------------------------------------- 导入

async function importByPath() {
  const value = prompt('输入 PDF 的绝对路径：\n（示例：G:\\笔记\\LLM知识体系论文\\高效微调\\Prompt Tuning.pdf）')
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

// ---------------------------------------------------------------- 设置

function openSettings() {
  state.showSettings = true
  rpc('settings.get')
    .then((value) => {
      state.settings = value
      render()
    })
    .catch((error) => toast(error.message))
}

function renderSettings() {
  const settings = state.settings || { config: {}, dataRoot: '' }
  const config = settings.config || {}
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
  const modal = h(
    'div',
    { class: 'modal' },
    h('h3', {}, '设置'),
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
    h('div', { class: 'divider' }, '扫描件 OCR（PaddleOCR 云端接口）'),
    h(
      'div',
      { class: 'field' },
      h(
        'label',
        {},
        (config.ocr && config.ocr.configured)
          ? 'PaddleOCR API Key（已保存 ' + (config.ocr.hint || '') + '，留空表示不修改）'
          : 'PaddleOCR API Key（去 ai.baidu.com 的 AI Studio 创建）',
      ),
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
          h(
            'option',
            { value: model, selected: ((config.ocr || {}).model || 'PaddleOCR-VL-1.6') === model },
            model + (model === 'PaddleOCR-VL-1.6' ? '（版面 Markdown，推荐）' : model === 'PP-OCRv6' ? '（纯文字，最快）' : '（结构化版面）'),
          ),
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
            patch.ocr = Object.assign({}, config.ocr || {}, {
              token: token ? token : state.ocrClear ? null : '',
            })
            try {
              await rpc('settings.set', { patch })
              state.showSettings = false
              state.ocrToken = ''
              state.ocrClear = false
              await loadHealth()
              render()
              toast('设置已保存')
            } catch (error) {
              toast('保存失败：' + error.message)
            }
          },
        },
        '保存',
      ),
    ),
  )
  return h('section', { class: 'main' }, h('div', { class: 'content' }, modal))
}

// ---------------------------------------------------------------- 划词菜单

let floating = null

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
  floating = h(
    'div',
    { class: 'floating-menu', style: { left: Math.min(window.innerWidth - 300, x) + 'px', top: Math.max(8, y - 44) + 'px' } },
    h('button', { onclick: () => { insertPrompt(P.askSelection(meta, text)); hideFloating() } }, '问 agent'),
    h('button', { onclick: () => { insertPrompt(P.translateSelection(meta, text)); hideFloating() } }, '翻译'),
    h(
      'button',
      {
        onclick: () => {
          addHighlight(text)
          hideFloating()
        },
      },
      '高亮',
    ),
    h(
      'button',
      {
        onclick: () => {
          copyText(text)
          hideFloating()
        },
      },
      '复制',
    ),
  )
  document.body.append(floating)
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('已复制'),
    () => toast('复制失败'),
  )
}

async function addHighlight(text) {
  const note = prompt('给这段高亮加个备注（可留空）：') || ''
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

document.addEventListener('mouseup', (event) => {
  if (floating && floating.contains(event.target)) return
  const selection = window.getSelection()
  const text = selection ? String(selection).trim() : ''
  if (text.length >= 2 && text.length <= 4000 && state.current) {
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    showFloating(rect.left, rect.top, text)
  } else if (!floating) {
    hideFloating()
  }
})

document.addEventListener('click', (event) => {
  if (floating && !floating.contains(event.target)) hideFloating()
})

// ---------------------------------------------------------------- 启动

async function boot() {
  render()
  await loadHealth()
  await loadLibrary()
  render()
  // 中文页在演示状态下轮询，边译边看
  setInterval(() => {
    if (state.tab === 'zh' && state.current) loadZh()
  }, 5000)
}

boot()
