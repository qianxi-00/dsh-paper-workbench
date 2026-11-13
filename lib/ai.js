/**
 * v2 内置 AI 引擎：模型清单、逐段翻译、侧边对话。
 *
 * 为什么这样拆：
 *   - 解析器、提示词、范围计算全是纯函数。模型返回的 JSON 是整条链里最容易坏的一环，
 *     拿固定样例就能断言，不需要真的调 LLM；
 *   - 网络/流式调用统一经 getServices() 注入的 llm 走，测试里换成假 llm 即可，
 *     所以整个模块在没有 DSH 宿主的机器上也能跑；
 *   - 事件形状严格按 docs/v2-contracts.md §7.2，SSE 层（lib/sse.js）只做转发。
 *
 * 翻译的落盘策略：trans.json 的键是段落/标题 hash，和页码解耦；写盘按节 + 1 秒节流，
 * 中断时把已经翻好的部分 flush 掉，绝不覆盖旧译文。
 */

export const EMPTY_MODEL_MESSAGE = '没有可用的模型：请先在 DSH 设置里配置模型适配器'
export const NO_DOC_MESSAGE = '这篇论文还没有文档模型：先在工作台打开一次（或点「重建文档模型」）'

// 四条硬约束写在 prompt 里，同时在测试里断言（改文案会直接让测试失败，避免悄悄退化）。
const TRANSLATE_SYSTEM = '你是学术论文的翻译引擎。只输出译文，不解释、不加代码块、不写前言后语。'
const TITLE_SYSTEM = '你是学术论文标题的翻译引擎。只输出 JSON 对象，不解释、不加代码块。'
const CHAT_SYSTEM = [
  '你是论文阅读助手，用中文回答。',
  '只依据下面给出的论文上下文回答，不要编造上下文里没有的数字、结论或引用。',
  '引用原文时在句末标注来源页码，如 [p.5]；上下文里没有页码时不要编造 [p.N]。',
  '先给结论，再给依据，回答尽量简洁。',
].join('\n')

const MAX_SELECTION_PARAGRAPHS = 400
const FLUSH_INTERVAL_MS = 1000
const RETRY_DELAY_MS = 2000
const MAX_TOKENS_CAP = 16384
const MAX_HISTORY_MESSAGES = 12
const MAX_HISTORY_CHARS = 2000
const SECTION_CONTEXT_CHARS = 6000
const PAPER_CONTEXT_CHARS = 8000

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

function abortError() {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

function isAbort(error) {
  return Boolean(error && (error.name === 'AbortError' || error.aborted === true))
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError()
}

function labelOf(model) {
  return model ? model.provider + '/' + model.model : ''
}

function truncate(text, max) {
  const value = String(text === undefined || text === null ? '' : text)
  return value.length > max ? value.slice(0, max) : value
}

/** 配置里允许 `{provider, model}` 或 `"provider/model"` 两种写法，统一成对象。 */
function normalizeModel(value) {
  if (!value) return null
  if (typeof value === 'string') {
    const text = value.trim()
    const slash = text.indexOf('/')
    if (slash > 0 && slash < text.length - 1) {
      return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
    }
    return null
  }
  if (typeof value === 'object') {
    const provider = String(value.provider || value.providerId || '').trim()
    const model = String(value.model || value.id || '').trim()
    if (!provider || !model) return null
    const out = { provider, model }
    if (value.reasoningEffort) out.reasoningEffort = String(value.reasoningEffort)
    return out
  }
  return null
}

function readServices(getServices) {
  try {
    const value = typeof getServices === 'function' ? getServices() : null
    return value && typeof value === 'object' ? value : {}
  } catch {
    // 宿主服务在启动早期可能还没注入，按「没有模型」处理即可，不要炸掉面板
    return {}
  }
}

function followSelection(agentDefaultModel) {
  if (!agentDefaultModel || typeof agentDefaultModel.currentSelection !== 'function') return null
  try {
    return normalizeModel(agentDefaultModel.currentSelection())
  } catch {
    return null
  }
}

/** 段落键：doc.json 里的 paragraph.hash，统一小写（契约要求键大小写不敏感）。 */
export function paragraphKey(paragraph) {
  const hash = paragraph && typeof paragraph === 'object' ? paragraph.hash : paragraph
  return String(hash === undefined || hash === null ? '' : hash).trim().toLowerCase()
}

/** 标题键：`t:` + sections[].hash，和段落键区分开，避免同一个 hash 撞车。 */
export function titleKey(section) {
  const hash = section && typeof section === 'object' ? section.hash : section
  const value = String(hash === undefined || hash === null ? '' : hash).trim().toLowerCase()
  return value ? 't:' + value : ''
}

/**
 * 由字符数估算输出 token 预算：中文大约 1 字 ≈ 1.8 token。
 * 夹在 [min, max] 之间，避免 0 段或超长段落把请求参数弄坏。
 */
export function clampMaxTokens(chars, { min = 512, max = 8192, factor = 1.8 } = {}) {
  const value = Number(chars)
  if (!Number.isFinite(value) || value <= 0) return min
  return Math.min(max, Math.max(min, Math.round(value * factor)))
}

/**
 * 把段落分批：同节相邻、每批 ≤ maxItems 段且 ≤ maxChars 字符。
 * 分批是为了：① 一次请求能对齐更多上下文；② 单批失败时兜底成本可控。
 * 单段超过 maxChars 时独占一批，不能把它拆开（拆开会切断句子）。
 */
export function chunkItems(items, { maxChars = 2000, maxItems = 6 } = {}) {
  const charLimit = Math.max(1, Number(maxChars) || 2000)
  const itemLimit = Math.max(1, Number(maxItems) || 6)
  const chunks = []
  let current = []
  let chars = 0
  const flush = () => {
    if (!current.length) return
    chunks.push(current)
    current = []
    chars = 0
  }
  for (const item of items || []) {
    if (!item) continue
    const text = String(item.text || '')
    const section = String(item.section || '')
    const sectionChanged = current.length > 0 && String(current[0].section || '') !== section
    if (current.length > 0 && (sectionChanged || current.length >= itemLimit || chars + text.length > charLimit)) {
      flush()
    }
    current.push(item)
    chars += text.length
  }
  flush()
  return chunks
}

/** 翻译 prompt：标题/节标题给模型定位上下文，JSON 协议 + 四条硬约束保证可用性。 */
export function buildTranslatePrompt({ paper, section, items } = {}) {
  const title = (paper && (paper.title || paper.id)) || '（未命名论文）'
  const sectionTitle = (section && section.title) || '（正文）'
  const list = (items || []).map((item) => ({
    id: String(item && item.id ? item.id : ''),
    text: String(item && item.text ? item.text : ''),
  }))
  const user = [
    '论文标题：' + title,
    '节标题：' + sectionTitle,
    '',
    '请把下面 ' + list.length + ' 个段落逐条翻译成中文。只输出一个 JSON 数组，不要输出其它文字：',
    '[{"id":"p0042","zh":"译文"}]',
    '待翻译段落（每行一个 JSON）：',
    ...list.map((item) => JSON.stringify(item)),
    '',
    '硬约束：',
    '1. 行内公式、符号、变量名、数字、引用编号（如 [12]）原样保留，不加 $、不改 LaTeX。',
    '2. 不输出 MathML / HTML 实体 / Unicode 数学排版，不重排公式。',
    '3. 术语首次出现用「中文（English）」，图表编号保留。',
    '4. 不增删内容，不合并或拆分段落。',
    '5. 行内公式只写一次 $...$：不要写成 \\(...\\)、\\[...\\] 或 $$...$$，公式内部不换行。',
  ].join('\n')
  return { system: TRANSLATE_SYSTEM, user }
}

/**
 * 公式卫生：模型偶尔会把行内公式写坏（MathML 标签、\(…\) 与 $…$ 双写、公式里换行）。
 * 只做「不改变数学含义」的清理；拿不准的地方原样保留，宁可少改。
 */
export function tidyMath(text) {
  let out = String(text === undefined || text === null ? '' : text)
  if (!out) return ''
  // MathML / 富文本残留
  out = out.replace(
    /<\/?(?:math|semantics|annotation|mrow|mi|mn|mo|msup|msub|msqrt|mfrac|mtext|mspace|mtable|mtr|mtd)\b[^>]*>/gi,
    '',
  )
  // \[ ... \] 与 \( ... \) → $ ... $
  out = out.replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => '$' + String(body).trim() + '$')
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => '$' + String(body).trim() + '$')
  // 正文里的 $$...$$ 收成行内 $...$
  out = out.replace(/\$\$([^$\n]+?)\$\$/g, (_, body) => '$' + String(body).trim() + '$')
  // 行内公式内部不换行。开 $ 后必须紧跟非空白、闭 $ 前也必须是非空白：
  // 否则「价格是 $5，公式 $x+y$」会把 "5，公式 " 当成公式内容配对。
  out = out.replace(/\$(?=\S)([^$\n]*?)(?<=\S)\$/g, (_, body) => '$' + String(body).replace(/\s*\n\s*/g, ' ').trim() + '$')
  // 三个以上的 $ 收成两个（JS 替换串里的 $$ 是字面量 $，这里要写成 $$$$）
  out = out.replace(/\${3,}/g, '$$$$')
  // 中文标点两侧的多余空格
  out = out.replace(/[ \t]+([，。；：！？）】」』])/g, '$1').replace(/([（【「『])[ \t]+/g, '$1')
  return out.trim()
}

/**
 * 从可能带前言/代码块的回复里抠出 JSON 文本。
 *
 * 不能用「第一个 open 到最后一个 close」：模型常在 JSON 后面补一句带方括号的说明
 * （「（[12] 是原文引用）」），那样切出来的串包含尾注、JSON.parse 直接失败，
 * 整批翻译会退化成逐段请求。这里按括号深度找第一个真正闭合的位置。
 */
function extractJson(text, open, close) {
  let raw = String(text === undefined || text === null ? '' : text).trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  const start = raw.indexOf(open)
  if (start < 0) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return raw.slice(start, index + 1)
    }
  }
  // 没闭合（回复被截断）：退回「到最后一个 close」，让解析器报错走逐段兜底
  const end = raw.lastIndexOf(close)
  return end > start ? raw.slice(start, end + 1) : ''
}

/**
 * 解析批量翻译回复，返回 { 段落 id: 中文 }。
 * 坏 JSON、不是数组、缺任意一个预期的 id、译文为空 → 返回 null，
 * 让调用方走「逐段兜底」，而不是把半截结果写进 trans.json。
 */
export function parseTranslateReply(text, expectedIds) {
  const ids = (expectedIds || []).map((id) => String(id))
  if (!ids.length) return null
  const raw = extractJson(text, '[', ']')
  if (!raw) return null
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  const found = new Map()
  for (const row of data) {
    if (!row || typeof row !== 'object') continue
    const id = String(row.id === undefined || row.id === null ? '' : row.id).trim()
    const zh = typeof row.zh === 'string' ? tidyMath(row.zh) : ''
    if (id && zh) found.set(id, zh)
  }
  const out = {}
  for (const id of ids) {
    const zh = found.get(id)
    if (!zh) return null
    out[id] = zh
  }
  return out
}

/** 标题翻译回复：JSON 对象 { 原标题: 中文 }；缺任意一个标题同样返回 null。 */
function parseTitleReply(text, titles) {
  const raw = extractJson(text, '{', '}')
  if (!raw) return null
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const map = new Map()
  for (const [from, to] of Object.entries(data)) {
    if (typeof to === 'string' && to.trim()) map.set(String(from).trim(), tidyMath(to))
  }
  const out = {}
  for (const title of titles) {
    const key = String(title === undefined || title === null ? '' : title).trim()
    const zh = map.get(key)
    if (!zh) return null
    out[key] = zh
  }
  return out
}

function buildTitlePrompt({ doc, sections }) {
  const titles = (sections || []).map((section) => section.title).filter(Boolean)
  const user = [
    '论文标题：' + ((doc && doc.title) || '（未命名论文）'),
    '请把下面 ' + titles.length + ' 个小节标题翻译成中文。只输出一个 JSON 对象，键是原标题，值是中文标题，不要输出其它文字：',
    '{"原标题":"中文"}',
    '待翻译标题（每行一个 JSON 字符串）：',
    ...titles.map((title) => JSON.stringify(title)),
    '要求：标题里的编号（如 3.2）保留；术语首次出现用「中文（English）」；不要增删内容。',
  ].join('\n')
  return { system: TITLE_SYSTEM, user }
}

function paragraphsOfSection(doc, sectionId) {
  const paragraphs = Array.isArray(doc && doc.paragraphs) ? doc.paragraphs : []
  return paragraphs.filter((paragraph) => paragraph && String(paragraph.section || '') === String(sectionId))
}

function findSection(doc, sectionId) {
  const sections = Array.isArray(doc && doc.sections) ? doc.sections : []
  return sections.find((section) => section && String(section.id) === String(sectionId)) || null
}

/** 结论节：优先按标题找，找不到就退化成最后一节（论文结构千奇百怪，不能死认 Conclusion）。 */
function pickConclusionSection(doc) {
  const sections = Array.isArray(doc && doc.sections) ? doc.sections : []
  const pattern = /(conclusion|conclusions|讨论|结论|总结|discussion|summary|limitations)/i
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    if (sections[index] && pattern.test(String(sections[index].title || ''))) return sections[index]
  }
  return sections.length ? sections[sections.length - 1] : null
}

/**
 * 对话上下文（纯函数）：
 *   - section 范围：本节正文 ≤ maxChars（默认 6000），选中文字附在最后；
 *   - paper 范围：摘要 + 全部节标题 + 结论节正文，总长 ≤ maxChars（默认 8000）。
 * 超长直接截断加省略号：宁可少给一点，也不要把整本 PDF 塞进 prompt 把模型撑爆。
 */
export function buildChatContext({ doc, meta, sectionId, page, selection, scope, maxChars } = {}) {
  const paperScope = scope === 'paper'
  const limit = Number(maxChars) > 0 ? Number(maxChars) : paperScope ? PAPER_CONTEXT_CHARS : SECTION_CONTEXT_CHARS
  const parts = []
  if (paperScope) {
    if (meta && meta.abstract) parts.push('【摘要】\n' + String(meta.abstract))
    const sections = Array.isArray(doc && doc.sections) ? doc.sections : []
    const titles = sections.map((section) => section && section.title).filter(Boolean)
    if (titles.length) parts.push('【章节】\n' + titles.join('\n'))
    const conclusion = pickConclusionSection(doc)
    if (conclusion) {
      const body = paragraphsOfSection(doc, conclusion.id).map((paragraph) => paragraph.text).filter(Boolean).join('\n')
      if (body) parts.push('【' + (conclusion.title || '结论') + '】\n' + body)
    }
  } else {
    const section = findSection(doc, sectionId)
    if (section) {
      const body = paragraphsOfSection(doc, section.id).map((paragraph) => paragraph.text).filter(Boolean).join('\n')
      parts.push('【' + (section.title || '本节') + '】\n' + body)
    } else if (doc && page) {
      const paragraphs = Array.isArray(doc.paragraphs) ? doc.paragraphs : []
      const body = paragraphs
        .filter((paragraph) => paragraph && Number(paragraph.page) === Number(page))
        .map((paragraph) => paragraph.text)
        .filter(Boolean)
        .join('\n')
      if (body) parts.push('【第 ' + page + ' 页】\n' + body)
    }
  }
  // 选中文字单独留预算：先截断正文再拼它，否则用户选中一句问「这段什么意思」，
  // 模型根本拿不到那句（正文已经吃掉全部预算）。
  const selected = selection ? String(selection).trim() : ''
  const selectionPart = selected ? '【选中原文】\n' + selected : ''
  const body = parts.join('\n\n')
  const room = selectionPart ? Math.max(600, limit - selectionPart.length - 8) : limit
  const clipped = body.length > room ? body.slice(0, room) + '…' : body
  const text = selectionPart ? clipped + '\n\n' + selectionPart : clipped
  return text.length > limit + selectionPart.length ? text.slice(0, limit + selectionPart.length) : text
}

/**
 * 组装发给 llm.stream 的 messages：最近 12 条历史（每条截断 2000 字符）+ 本轮问题。
 * 历史太长会把上下文挤掉，太短又接不上；12 条是「一问一答」翻页阅读的经验值。
 */
export function buildChatMessages({ meta, context, history, question } = {}) {
  const messages = []
  const list = Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : []
  for (const item of list) {
    if (!item) continue
    const text = truncate(item.content, MAX_HISTORY_CHARS).trim()
    if (!text) continue
    messages.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text }] })
  }
  const head = []
  if (meta && meta.title) head.push('论文：' + String(meta.title))
  if (context) head.push(context)
  head.push('问题：' + String(question === undefined || question === null ? '' : question))
  messages.push({ role: 'user', content: [{ type: 'text', text: head.join('\n\n') }] })
  return messages
}

/** 选模型：工作台配置优先，null 表示跟随 DSH 当前模型；都没有就是 null。 */
export function resolveModel(configAi, follow, kind) {
  const ai = configAi && typeof configAi === 'object' ? configAi : {}
  const configured = kind === 'chat' ? ai.chatModel : ai.translateModel
  return normalizeModel(configured) || normalizeModel(follow)
}

// ---------------------------------------------------------------- 流式调用小工具

function finishError(reason) {
  const failure = (reason && reason.failure) || {}
  const error = new Error(failure.message || '模型调用失败：没有返回原因')
  if (failure.code) error.code = failure.code
  if (failure.status) error.status = failure.status
  return error
}

function isRetryable(error) {
  if (!error) return false
  if (Number(error.status) === 429 || Number(error.code) === 429) return true
  const code = String(error.code || '').toUpperCase()
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNABORTED'].includes(code)) return true
  return /rate.?limit|too many requests|\b429\b|fetch failed|network|socket hang up|terminated/i.test(messageOf(error))
}

/** 按 index 聚合 text-delta；reasoning-delta 不进正文（避免把思考过程当译文）。 */
async function collectStream(llm, options) {
  const parts = []
  let finish = null
  let usage = null
  for await (const chunk of llm.stream(options)) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') {
      const index = Number.isInteger(chunk.index) ? chunk.index : 0
      parts[index] = (parts[index] || '') + String(chunk.text || '')
    } else if (chunk.type === 'usage') {
      usage = chunk.usage || usage
    } else if (chunk.type === 'finish') {
      finish = chunk.reason || null
    }
  }
  const text = parts.map((part) => part || '').join('')
  return { text, finish, usage }
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 一次模型调用 + 429/网络错误重试一次（sleep 2000，可注入 sleepImpl 方便测试）。
 * finish.reason.kind==='max-tokens' 不在这里重试：那要由调用方加倍 maxTokens 重发。
 */
async function streamWithRetry(llm, options, { signal, sleep }) {
  let retried = false
  for (;;) {
    throwIfAborted(signal)
    let result
    try {
      result = await collectStream(llm, { ...options, signal })
    } catch (error) {
      if (isAbort(error) || (signal && signal.aborted)) throw abortError()
      if (!retried && isRetryable(error)) {
        retried = true
        await sleep(RETRY_DELAY_MS, signal)
        continue
      }
      throw error
    }
    if (result.finish && result.finish.kind === 'aborted') throw abortError()
    if (result.finish && result.finish.kind === 'error') {
      const error = finishError(result.finish)
      if (!retried && isRetryable(error)) {
        retried = true
        await sleep(RETRY_DELAY_MS, signal)
        continue
      }
      throw error
    }
    const truncated = Boolean(result.finish && result.finish.kind === 'max-tokens')
    return { ...result, truncated }
  }
}

// ---------------------------------------------------------------- 工厂

/**
 * 创建 AI 引擎。runtime 由 lead 注入：
 *   { store, getServices: () => ({ llm, agentDefaultModel }), sleepImpl? }
 * store 用 lib/store.js；getServices 在宿主里返回 ctx.llm / ctx.agentDefaultModel，测试里给假实现。
 */
export function createAi({ store, getServices, sleepImpl } = {}) {
  if (!store) throw new Error('createAi 缺少 store：无法读写论文数据')
  const defaultSleepImpl = typeof sleepImpl === 'function' ? sleepImpl : defaultSleep

  async function aiConfig() {
    try {
      const config = await store.getConfig()
      return (config && config.ai) || {}
    } catch {
      return {}
    }
  }

  /** 模型清单：提供方 / 每个提供方的模型 / DSH 当前模型，以及能不能用（ready + 下一步提示）。 */
  async function models() {
    const warnings = []
    const ai = await aiConfig()
    const services = readServices(getServices)
    const llm = services.llm || null
    const follow = followSelection(services.agentDefaultModel)
    let providers = []
    if (llm && typeof llm.listProviders === 'function') {
      try {
        const raw = llm.listProviders()
        providers = (Array.isArray(raw) ? raw : [])
          .map((item) => ({
            id: String((item && item.id) || ''),
            name: String((item && (item.name || item.id)) || ''),
          }))
          .filter((item) => item.id)
      } catch (error) {
        warnings.push('读取模型提供方失败：' + messageOf(error))
      }
    }
    const list = []
    if (llm && providers.length) {
      if (typeof llm.listModels !== 'function') {
        // 老版本宿主没有 listModels：给一条「手填模型名」占位，设置面板仍能用
        for (const provider of providers) list.push({ provider: provider.id, id: '', name: '手填模型名' })
      } else {
        await Promise.all(
          providers.map(async (provider) => {
            try {
              const rows = await llm.listModels(provider.id)
              const modelsOfProvider = Array.isArray(rows) ? rows : []
              for (const row of modelsOfProvider) {
                const id = String((row && row.id) || '')
                if (!id) continue
                list.push({
                  provider: String((row && row.provider) || provider.id),
                  id,
                  name: String((row && row.name) || id),
                })
              }
              if (!modelsOfProvider.length) warnings.push('提供方「' + (provider.name || provider.id) + '」没有可用模型')
            } catch (error) {
              // 单个提供方失败不拖垮整个清单（例如某个适配器暂时没启动）
              warnings.push('读取模型列表失败（' + provider.id + '）：' + messageOf(error))
            }
          }),
        )
      }
    }
    const translateModel = resolveModel(ai, follow, 'translate')
    const chatModel = resolveModel(ai, follow, 'chat')
    const ready = Boolean(llm && providers.length && list.length && (translateModel || chatModel))
    let reason = ''
    if (!ready) {
      if (!llm) reason = '当前 DSH 没有提供 llm 服务，无法调用模型；请确认 DSH 版本后重启。'
      else if (!providers.length) reason = '没有可用的模型提供方：请先在 DSH 设置里配置模型适配器。'
      else if (!list.length) reason = '没有可用的模型：请先在 DSH 设置里配置模型适配器。'
      else reason = '还没有选中模型：请在 DSH 设置里选一个当前模型，或在工作台设置里指定翻译/对话模型。'
    }
    return {
      providers,
      models: list,
      follow,
      translateModel,
      chatModel,
      ready,
      warnings,
      ...(reason ? { reason } : {}),
    }
  }

  /**
   * 逐段翻译（AsyncIterable<{event,data}>）。
   *
   * 请求顺序：缓存的段落直接 done(cached:true) → 待翻译段落按节/长度分批 → 批失败或
   * 解析不出来时整批退化为逐段（每段只兜底一次）。写盘在「换节」或「距上次 ≥1s」时发生，
   * 中断时也会 flush，所以用户中途关页面不会白翻。
   */
  async function* translate(body = {}, options = {}) {
    const signal = options.signal
    const sleep = typeof options.sleepImpl === 'function' ? options.sleepImpl : defaultSleepImpl
    const id = body && body.id
    const ai = await aiConfig()
    const services = readServices(getServices)
    const llm = services.llm
    const model = resolveModel(ai, followSelection(services.agentDefaultModel), 'translate')
    if (!model || !llm || typeof llm.stream !== 'function') throw new Error(EMPTY_MODEL_MESSAGE)

    const target = body.target || ai.target || 'zh'
    const temperature = Number.isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2
    const modelLabel = labelOf(model)

    // 划词翻译是一个独立的翻译小工具：不读 trans.json、不写盘、不进对话历史，
    // 每次调用都是一次全新的模型请求（只把这一次选中的原文送进去）。
    const adhocText = typeof body.text === 'string' ? body.text.trim() : ''
    if (adhocText) {
      yield* translateAdhoc(adhocText)
      return
    }

    if (!id) throw new Error('缺少论文 id：无法确定要翻译哪篇论文')
    const doc = await store.readDoc(id)
    if (!doc) throw new Error(NO_DOC_MESSAGE)
    const retranslate = body.retranslate === true
    const modelPayload = { provider: model.provider, model: model.model }
    const meta = await store.getMeta(id).catch(() => null)
    const paperTitle = (meta && meta.title) || doc.title || ''

    const trans = await store.readTrans(id)
    const entries = { ...(trans.entries || {}) }
    let dirty = false
    let lastFlush = Date.now()
    const state = { done: 0, failed: 0 }

    async function flush(force = false) {
      if (!dirty) return
      if (!force && Date.now() - lastFlush < FLUSH_INTERVAL_MS) return
      await store.mergeTrans(id, { target, model: modelPayload, entries })
      dirty = false
      lastFlush = Date.now()
    }

    async function safeFlush() {
      try {
        await flush(true)
      } catch (error) {
        console.error('[paper-workbench] 保存译文失败：' + messageOf(error))
      }
    }

    function storeEntry(key, zh) {
      if (!key || !zh) return false
      const old = entries[key]
      // 除非用户明确要求重译，否则绝不覆盖已有译文（模型偶发抽风不能毁掉旧结果）
      if (old && old.zh && !retranslate) return false
      entries[key] = { zh, at: new Date().toISOString(), model: modelLabel }
      dirty = true
      return true
    }

    const paragraphs = Array.isArray(doc.paragraphs) ? doc.paragraphs : []
    const sections = Array.isArray(doc.sections) ? doc.sections : []
    const titlesWanted =
      body.titles === true || (Array.isArray(body.sectionIds) && body.sectionIds.includes('*titles'))
    const sectionIds = Array.isArray(body.sectionIds)
      ? body.sectionIds.map(String).filter((sectionId) => sectionId !== '*titles')
      : null
    const keyList = Array.isArray(body.keys) ? body.keys.map((key) => String(key).toLowerCase()) : null

    let pool
    let selectionTruncated = false
    if (keyList) {
      // keys 优先：前端重试单段时只传这一段的 hash
      const byHash = new Map()
      for (const paragraph of paragraphs) {
        if (paragraph && paragraph.hash) byHash.set(paragraphKey(paragraph), paragraph)
      }
      pool = keyList.map((key) => byHash.get(key)).filter(Boolean)
    } else if (sectionIds) {
      const wanted = new Set(sectionIds)
      pool = paragraphs.filter((paragraph) => paragraph && wanted.has(String(paragraph.section || '')))
      if (pool.length > MAX_SELECTION_PARAGRAPHS) {
        pool = pool.slice(0, MAX_SELECTION_PARAGRAPHS)
        selectionTruncated = true
      }
    } else {
      // 只翻目录标题时（titles:true）不该顺手把整篇段落也翻一遍
      pool = titlesWanted ? [] : paragraphs.slice()
    }
    pool = pool.filter((paragraph) => paragraph && paragraph.hash && paragraph.kind !== 'formula')

    const sectionOf = (paragraph) =>
      sections.find((section) => section && String(section.id) === String(paragraph.section)) || {
        id: paragraph.section,
        title: '',
      }

    async function requestOnce(prompt, maxTokens) {
      return streamWithRetry(
        llm,
        {
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          system: prompt.system,
          temperature,
          maxTokens,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        },
        { signal, sleep },
      )
    }

    /**
     * 划词翻译：一次请求只翻这一小段，流式回传；不读缓存、不写 trans.json、不进 chat.json。
     * key 固定为 'selection'，前端按它把译文贴到选区所在段落下面。
     */
    async function* translateAdhoc(text) {
      const key = 'selection'
      yield { event: 'start', data: { key, kind: 'selection', cached: false, model: modelLabel } }
      let full = ''
      try {
        throwIfAborted(signal)
        const stream = llm.stream({
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          system:
            '你是学术论文翻译。把用户给的英文原文翻译成简体中文：保留术语、公式、引用编号、作者名与机构名的原文，' +
            '不要解释、不要加标题、不要输出原文，只给译文。',
          temperature,
          maxTokens: clampMaxTokens(text.length, { min: 512 }),
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          signal,
        })
        for await (const chunk of stream) {
          if (!chunk) continue
          if (chunk.type === 'text-delta') {
            const piece = String(chunk.text || '')
            if (!piece) continue
            full += piece
            yield { event: 'delta', data: { key, text: piece } }
          } else if (chunk.type === 'finish') {
            const kind = chunk.reason && chunk.reason.kind
            if (kind === 'error') throw finishError(chunk.reason)
            if (kind === 'aborted') throw abortError()
          }
        }
        const zh = tidyMath(full)
        if (zh.trim() === '') throw new Error('模型没有返回内容（空回复）')
        yield { event: 'done', data: { key, text: zh, model: modelLabel, cached: false } }
        yield { event: 'end', data: { ok: true, done: 1, failed: 0, model: modelLabel } }
      } catch (error) {
        if (isAbort(error) || (signal && signal.aborted)) {
          yield { event: 'end', data: { ok: false, aborted: true, done: 0, failed: 0, model: modelLabel } }
          return
        }
        yield { event: 'error', data: { key, message: messageOf(error) } }
        yield { event: 'end', data: { ok: false, done: 0, failed: 1, model: modelLabel } }
      }
    }

    /** 一批请求：遇到 max-tokens 截断就把预算翻倍重发一次（上限 16384）。 */
    async function translateBatch(items, section, maxTokens) {
      const prompt = buildTranslatePrompt({ paper: { title: paperTitle, id }, section, items })
      let result = await requestOnce(prompt, maxTokens)
      if (result.truncated) {
        const bigger = Math.min(MAX_TOKENS_CAP, maxTokens * 2)
        if (bigger > maxTokens) result = await requestOnce(prompt, bigger)
      }
      return result
    }

    /** 批请求失败 / JSON 不可用时的兜底：每段单独请求一次，仍失败才 emit error。 */
    async function* fallback(items, section) {
      for (const paragraph of items) {
        throwIfAborted(signal)
        const key = paragraphKey(paragraph)
        try {
          const maxTokens = clampMaxTokens(String(paragraph.text || '').length)
          const result = await translateBatch([paragraph], section, maxTokens)
          const parsed = result.truncated ? null : parseTranslateReply(result.text, [String(paragraph.id || '')])
          if (parsed && parsed[String(paragraph.id || '')]) {
            storeEntry(key, parsed[String(paragraph.id || '')])
            yield { event: 'done', data: { key, text: parsed[String(paragraph.id || '')], model: modelLabel, cached: false } }
            state.done += 1
            await flush()
            continue
          }
          state.failed += 1
          yield {
            event: 'error',
            data: { key, message: result.truncated ? '模型输出被截断（max-tokens）' : '模型返回格式不正确' },
          }
        } catch (error) {
          if (isAbort(error) || (signal && signal.aborted)) throw error
          state.failed += 1
          yield { event: 'error', data: { key, message: messageOf(error) } }
        }
      }
    }

    async function* translateChunks(pending) {
      const chunks = chunkItems(pending, { maxChars: 2000, maxItems: 6 })
      let lastSectionId = null
      for (const chunk of chunks) {
        throwIfAborted(signal)
        const first = chunk[0]
        const section = sectionOf(first)
        const sectionId = String(first.section || '')
        if (lastSectionId !== null && sectionId !== lastSectionId) await flush(true)
        lastSectionId = sectionId
        for (const paragraph of chunk) {
          yield { event: 'start', data: { key: paragraphKey(paragraph), kind: paragraph.kind || 'body', cached: false } }
        }
        const chars = chunk.reduce((sum, paragraph) => sum + String(paragraph.text || '').length, 0)
        const baseTokens = clampMaxTokens(chars)
        let result = null
        try {
          result = await translateBatch(chunk, section, baseTokens)
        } catch (error) {
          if (isAbort(error) || (signal && signal.aborted)) throw error
          yield* fallback(chunk, section)
          continue
        }
        if (result.truncated) {
          // 已经翻倍重发过还是截断：不写盘（半截译文比没有更糟）。
          // 必须发 error + 计入 failed：只发空 done 会让状态栏报「翻译完成」，
          // 这些段也进不了失败集合，用户没有单键重试入口。
          for (const paragraph of chunk) {
            state.failed += 1
            yield {
              event: 'error',
              data: { key: paragraphKey(paragraph), message: '模型输出被截断（max-tokens），这一段没翻完' },
            }
          }
          continue
        }
        const expected = chunk.map((paragraph) => String(paragraph.id || ''))
        const parsed = parseTranslateReply(result.text, expected)
        if (!parsed) {
          // 解析失败或 id 不全：整批退化为逐段，不放弃这一批
          yield* fallback(chunk, section)
          continue
        }
        for (const paragraph of chunk) {
          const key = paragraphKey(paragraph)
          const zh = parsed[String(paragraph.id || '')]
          if (!storeEntry(key, zh)) continue
          yield { event: 'done', data: { key, text: zh, model: modelLabel, cached: false } }
          state.done += 1
        }
        await flush()
      }
    }

    async function* translateTitles(titlesSections) {
      const cachedRows = []
      const pendingRows = []
      for (const section of titlesSections) {
        const key = titleKey(section)
        if (!key) continue
        const hit = entries[key]
        if (hit && hit.zh && !retranslate) cachedRows.push({ key, zh: hit.zh, model: hit.model || '' })
        else pendingRows.push({ key, section })
      }
      for (const row of cachedRows) {
        yield { event: 'start', data: { key: row.key, kind: 'title', cached: true } }
        yield { event: 'done', data: { key: row.key, text: row.zh, model: row.model, cached: true } }
        state.done += 1
      }
      if (!pendingRows.length) return
      throwIfAborted(signal)
      for (const row of pendingRows) {
        yield { event: 'start', data: { key: row.key, kind: 'title', cached: false } }
      }
      // 契约要求标题「合成一次请求」：标题很短，全部节标题放进一个 JSON 对象一次翻完；
      // 失败时整批报错，不拆成多次请求（标题量小，拆开只会更慢）。
      const group = pendingRows
      const titles = group.map((row) => String(row.section.title || ''))
      const prompt = buildTitlePrompt({ doc, sections: group.map((row) => row.section) })
      try {
        const chars = titles.reduce((sum, title) => sum + title.length, 0)
        const result = await requestOnce(prompt, clampMaxTokens(chars, { min: 256 }))
        const parsed = result.truncated ? null : parseTitleReply(result.text, titles)
        if (!parsed) throw new Error('模型返回格式不正确或输出被截断')
        for (const row of group) {
          const zh = parsed[String(row.section.title || '')]
          if (!storeEntry(row.key, zh)) continue
          yield { event: 'done', data: { key: row.key, text: zh, model: modelLabel, cached: false } }
          state.done += 1
        }
        await flush()
      } catch (error) {
        if (isAbort(error) || (signal && signal.aborted)) throw error
        for (const row of group) {
          state.failed += 1
          yield { event: 'error', data: { key: row.key, message: messageOf(error) } }
        }
      }
    }

    const pending = []
    for (const paragraph of pool) {
      const key = paragraphKey(paragraph)
      const hit = entries[key]
      if (hit && hit.zh && !retranslate) {
        yield { event: 'start', data: { key, kind: paragraph.kind || 'body', cached: true } }
        yield { event: 'done', data: { key, text: hit.zh, model: hit.model || '', cached: true } }
        state.done += 1
        continue
      }
      pending.push(paragraph)
    }

    // keys 里带 t:<hash> 的是「重试某一个标题」：只翻这些，别把整本目录重翻一遍
    const titleKeys = keyList ? keyList.filter((key) => key.startsWith('t:')) : null
    const titleSections = titlesWanted
      ? sections.filter(
          (section) =>
            section &&
            section.hash &&
            section.title &&
            (sectionIds === null || sectionIds.includes(String(section.id))) &&
            (titleKeys === null || titleKeys.includes(String(titleKey(section)))),
        )
      : []

    try {
      if (titleSections.length) yield* translateTitles(titleSections)
      yield* translateChunks(pending)
      try {
        await flush(true)
      } catch (error) {
        yield { event: 'error', data: { message: '译文写盘失败：' + messageOf(error) } }
        yield { event: 'end', data: { ok: false, done: state.done, failed: state.failed, model: modelLabel } }
        return
      }
      yield {
        event: 'end',
        data: {
          ok: state.failed === 0,
          done: state.done,
          failed: state.failed,
          model: modelLabel,
          ...(selectionTruncated ? { truncated: true } : {}),
        },
      }
    } catch (error) {
      if (isAbort(error) || (signal && signal.aborted)) {
        await safeFlush()
        yield {
          event: 'end',
          data: { ok: false, aborted: true, done: state.done, failed: state.failed, model: modelLabel },
        }
        return
      }
      await safeFlush()
      yield { event: 'error', data: { message: messageOf(error) } }
      yield { event: 'end', data: { ok: false, done: state.done, failed: state.failed, model: modelLabel } }
    } finally {
      // 消费者提前 return()（例如浏览器断连）时也把已得部分落盘
      if (dirty) {
        try {
          await store.mergeTrans(id, { target, model: modelPayload, entries })
        } catch {
          /* 清理阶段不再抛错 */
        }
      }
    }
  }

  /**
   * 侧边对话（AsyncIterable<{event,data}>）：上下文 + 最近 12 条历史 → 流式回答。
   * 成功时把本轮 user/assistant 追加进 chat.json（store.writeChat 自动裁剪到 200 条）。
   */
  async function* chat(body = {}, options = {}) {
    const signal = options.signal
    const id = body && body.id
    if (!id) throw new Error('缺少论文 id：无法确定在哪篇论文里对话')
    const ai = await aiConfig()
    const services = readServices(getServices)
    const llm = services.llm
    const follow = followSelection(services.agentDefaultModel)
    const model = normalizeModel(body.model) || resolveModel(ai, follow, 'chat')
    if (!model || !llm || typeof llm.stream !== 'function') throw new Error(EMPTY_MODEL_MESSAGE)

    const incoming = Array.isArray(body.messages) ? body.messages : []
    const question = String(
      (body.question !== undefined && body.question !== null ? body.question : '') ||
        (incoming.length ? incoming[incoming.length - 1].content : '') ||
        '',
    ).trim()
    if (!question) throw new Error('请输入问题')
    let history
    if (incoming.length > 1) {
      history = incoming.slice(0, -1)
    } else {
      // 只发了一条消息的客户端：把 chat.json 里已有的历史接上，避免每轮都失忆
      const stored = await store.readChat(id).catch(() => ({ messages: [] }))
      history = Array.isArray(stored.messages) ? stored.messages : []
    }

    const meta = await store.getMeta(id).catch(() => null)
    const doc = await store.readDoc(id).catch(() => null)
    const rawContext = body.context && typeof body.context === 'object' ? body.context : {}
    const scope = body.scope === 'paper' ? 'paper' : 'section'
    const context = buildChatContext({
      doc,
      meta,
      sectionId: rawContext.sectionId,
      page: rawContext.page,
      selection: rawContext.selection,
      scope,
    })
    const messages = buildChatMessages({ meta, context, history, question })
    const temperature = Number.isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2
    const modelLabel = labelOf(model)
    const modelPayload = { provider: model.provider, model: model.model }

    let text = ''
    let usage = null
    let truncated = false
    try {
      throwIfAborted(signal)
      const stream = llm.stream({
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        system: CHAT_SYSTEM,
        temperature,
        messages,
        signal,
      })
      for await (const chunk of stream) {
        throwIfAborted(signal)
        if (!chunk) continue
        if (chunk.type === 'text-delta') {
          const piece = String(chunk.text || '')
          if (piece) {
            text += piece
            yield { event: 'delta', data: { text: piece } }
          }
        } else if (chunk.type === 'usage') {
          usage = chunk.usage || usage
        } else if (chunk.type === 'finish') {
          if (chunk.reason && chunk.reason.kind === 'error') throw finishError(chunk.reason)
          if (chunk.reason && chunk.reason.kind === 'aborted') throw abortError()
          if (chunk.reason && chunk.reason.kind === 'max-tokens') truncated = true
        }
      }
      if (text.trim() === '') throw new Error('模型没有返回内容（空回复）')
      try {
        await appendChatRound({ store, id, question, answer: text, model: modelPayload, modelLabel, context: rawContext })
      } catch (error) {
        // 回答已经流给用户了，保存失败只记日志，不要把这一轮判成失败
        console.error('[paper-workbench] 保存对话失败：' + messageOf(error))
      }
      yield { event: 'done', data: { text, model: modelLabel, usage, ...(truncated ? { truncated: true } : {}) } }
      yield { event: 'end', data: { ok: true } }
    } catch (error) {
      if (isAbort(error) || (signal && signal.aborted)) {
        yield { event: 'end', data: { ok: false, aborted: true, text } }
        return
      }
      yield { event: 'error', data: { message: messageOf(error) } }
      yield { event: 'end', data: { ok: false, text } }
    }
  }

  return { models, translate, chat }
}

/** 追加一轮对话：id 延续 chat.json 里的 mN 编号，assistant 记录模型名。 */
async function appendChatRound({ store, id, question, answer, model, modelLabel, context }) {
  const chat = await store.readChat(id)
  const list = Array.isArray(chat.messages) ? chat.messages.slice() : []
  let seq = 0
  for (const item of list) {
    const match = /^m(\d+)$/.exec(String((item && item.id) || ''))
    if (match) seq = Math.max(seq, Number(match[1]))
  }
  const userMessage = {
    id: 'm' + (seq + 1),
    role: 'user',
    content: question,
    at: new Date().toISOString(),
  }
  const contextPayload = {}
  if (context && context.sectionId) contextPayload.sectionId = context.sectionId
  if (context && context.page) contextPayload.page = context.page
  if (context && context.selection) contextPayload.selection = context.selection
  if (Object.keys(contextPayload).length) userMessage.context = contextPayload
  const assistantMessage = {
    id: 'm' + (seq + 2),
    role: 'assistant',
    content: answer,
    at: new Date().toISOString(),
    model: modelLabel,
  }
  list.push(userMessage, assistantMessage)
  await store.writeChat(id, { model, messages: list })
}
