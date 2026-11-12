/**
 * v3 翻译自检：7 条静态规则 + 可选的 LLM 审校。
 *
 * 为什么这样拆：
 *   - 静态规则、prompt、回复解析都是纯函数。模型返回的 JSON 是整条链里最容易坏的一环，
 *     拿固定样例就能断言，不需要真的联网或启动 DSH；
 *   - LLM 只经 getServices() 注入的 llm 调用；缺服务、缺当前模型、模型报错时都降级成
 *     纯静态检查，把原因写进 stats.llmError，自检入口绝不因为模型不可用而失败；
 *   - 结果形状严格按 docs/v3-contracts.md §3：{ at, mode, issues, stats }。
 *
 * 译文条目兼容两种历史形状：{ [hash]: '中文' } 与 { [hash]: { zh, at, model } }。
 * 静态问题里 error 表示「确定坏了」（空、截断、与原文相同），
 * warn 表示「可疑、值得人工确认」（英文残留、页码、$ 配对、过短）。
 */

const REVIEW_SYSTEM = '你是学术论文的翻译审校引擎。只输出 JSON 数组，不解释、不加代码块、不写前言后语。'

const MAX_BATCH_ITEMS = 8
const MAX_BATCH_CHARS = 4000
const REVIEW_TEMPERATURE = 0
const REVIEW_MAX_TOKENS = 1200
const DEFAULT_LIMIT = 80

const ASCII_LETTERS_RE = /[A-Za-z]/g
const PAGE_REF_RE = /p\.\s*\d+/i
const PAGE_REF_CN_RE = /第\s*\d+\s*页/
const TRUNCATED_TAIL_RE = /(?:，|、|,)$/
const TRUNCATED_WORD_RE = /(?:^|\s)(and|the|of)$/i
const DOLLAR_RE = /\$/g

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function keyOf(paragraph) {
  const hash = paragraph && typeof paragraph === 'object' ? paragraph.hash : paragraph
  return String(hash === undefined || hash === null ? '' : hash).trim().toLowerCase()
}

function zhOf(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.zh === 'string') return entry.zh
  return ''
}

/**
 * 读译文表。契约里 staticIssues(doc, trans) 的第二参既可能是 entries，
 * 也可能是 readTrans 的 { version, target, model, entries }；两种都接受。
 */
function entriesOf(trans) {
  if (!trans || typeof trans !== 'object' || Array.isArray(trans)) return {}
  if (trans.entries && typeof trans.entries === 'object' && !Array.isArray(trans.entries)) return trans.entries
  return trans
}

function stripWhitespace(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, '')
}

/** 英文占比：ASCII 字母 / 非空白字符 > 55% 且长度 > 40。短译文不判，避免术语名误伤。 */
function isEnglishLeft(text) {
  const value = String(text || '')
  if (value.length <= 40) return false
  const visible = value.replace(/\s+/g, '')
  if (!visible) return false
  const letters = visible.match(ASCII_LETTERS_RE)
  return Boolean(letters) && letters.length / visible.length > 0.55
}

/** 截断：以中文逗号/顿号/英文逗号结尾，或英文虚词 and/the/of 收尾。 */
function isTruncated(text) {
  const value = String(text || '').trim()
  if (!value) return false
  return TRUNCATED_TAIL_RE.test(value) || TRUNCATED_WORD_RE.test(value)
}

function countDollars(text) {
  const matched = String(text || '').match(DOLLAR_RE)
  return matched ? matched.length : 0
}

function staticIssue(key, code, severity, message) {
  return { key, code, severity, message }
}

/**
 * 静态检查（纯函数）：只检查 kind==='body' 且 trans 里有条目（哪怕是空字符串）的段落。
 * 空译文只报 empty 一条：后面几条都以「有译文」为前提，继续报只会制造噪音。
 */
export function staticIssues(doc, trans) {
  const entries = entriesOf(trans)
  const paragraphs = Array.isArray(doc && doc.paragraphs) ? doc.paragraphs : []
  const issues = []
  for (const paragraph of paragraphs) {
    if (!paragraph || paragraph.kind !== 'body') continue
    const key = keyOf(paragraph)
    if (!key || !hasOwn(entries, key)) continue
    const source = String(paragraph.text || '')
    const zh = zhOf(entries[key])
    if (!zh.trim()) {
      issues.push(staticIssue(key, 'empty', 'error', '译文为空'))
      continue
    }
    if (isEnglishLeft(zh)) {
      issues.push(staticIssue(key, 'english-left', 'warn', '译文里英文占比过高，可能没有真正翻译'))
    }
    if (isTruncated(zh)) {
      issues.push(staticIssue(key, 'truncated', 'error', '译文在句中标点处结束，疑似被截断'))
    }
    if (stripWhitespace(zh) === stripWhitespace(source) && stripWhitespace(source)) {
      issues.push(staticIssue(key, 'same-as-source', 'error', '译文与原文相同'))
    }
    if (PAGE_REF_RE.test(zh) || PAGE_REF_CN_RE.test(zh)) {
      issues.push(staticIssue(key, 'page-ref', 'warn', '译文里残留了页码引用'))
    }
    if (countDollars(zh) % 2 === 1) {
      issues.push(staticIssue(key, 'dollar-odd', 'warn', '译文里的 $ 数量为奇数，行内公式可能没有闭合'))
    }
    if (source.length > 80 && zh.length < source.length * 0.15) {
      issues.push(staticIssue(key, 'too-short', 'warn', '译文明显短于原文，可能有漏译'))
    }
  }
  return issues
}

/**
 * LLM 审校 prompt（纯函数）：一次最多 8 段 / 4000 字符由调用方切好。
 * user 里每行一个 JSON，模型只需要照协议回 JSON 数组；没有问题的段落不出现在数组里。
 */
export function buildReviewPrompt(batch) {
  const rows = (Array.isArray(batch) ? batch : [])
    .map((item) => ({
      key: String((item && item.key) || ''),
      source: String((item && item.source) || ''),
      zh: String((item && item.zh) || ''),
    }))
    .filter((item) => item.key)
  const user = [
    '下面是对论文段落的原文与中文译文。请逐条审校：是否有错译、漏译、术语不一致，',
    '数字、公式、引用编号是否被改动，语气是否适合学术论文。',
    '',
    '只输出一个 JSON 数组，不要输出其它文字；没有问题的段落不要出现在数组里：',
    '[{"key":"<段落键>","severity":"warn|error","issue":"一句话说明问题","suggest":"修改建议"}]',
    '待审校段落（每行一个 JSON）：',
    ...rows.map((row) => JSON.stringify(row)),
  ].join('\n')
  return { system: REVIEW_SYSTEM, user }
}

/** 从可能带代码块/前后废话的回复里抠出 JSON 数组文本。 */
function extractJsonArray(text) {
  let raw = String(text === undefined || text === null ? '' : text).trim()
  if (!raw) return ''
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  if (raw.startsWith('[') && raw.endsWith(']')) return raw
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start >= 0 && end > start) return raw.slice(start, end + 1)
  return ''
}

/**
 * 解析审校回复：容忍 ```json 围栏与前后废话；坏 JSON / 非数组一律返回 []。
 * expectedKeys 给出时只保留已知段落键（模型可能把 key 抄错或编造）。
 */
export function parseReviewReply(text, expectedKeys) {
  const raw = extractJsonArray(text)
  if (!raw) return []
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const allowed = Array.isArray(expectedKeys) ? new Set(expectedKeys.map((key) => String(key))) : null
  const issues = []
  for (const row of data) {
    if (!row || typeof row !== 'object') continue
    const key = String(row.key === undefined || row.key === null ? '' : row.key).trim()
    if (!key) continue
    if (allowed && !allowed.has(key)) continue
    const issue = String(row.issue || row.message || '').trim()
    if (!issue) continue
    const severity = String(row.severity || '').toLowerCase() === 'error' ? 'error' : 'warn'
    const suggest = typeof row.suggest === 'string' ? row.suggest.trim() : ''
    issues.push({ key, severity, issue, suggest })
  }
  return issues
}

// ---------------------------------------------------------------- LLM 调用小工具

function abortError() {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

function finishError(reason) {
  const failure = (reason && reason.failure) || {}
  return new Error(failure.message || '模型调用失败：没有返回原因')
}

/** 按 index 聚合 text-delta，只取正文；finish 帧负责中止/报错判断。 */
async function collectStream(llm, options) {
  const parts = []
  let finish = null
  for await (const chunk of llm.stream(options)) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') {
      const index = Number.isInteger(chunk.index) ? chunk.index : 0
      parts[index] = (parts[index] || '') + String(chunk.text || '')
    } else if (chunk.type === 'finish') {
      finish = chunk.reason || null
    }
  }
  return { text: parts.map((part) => part || '').join(''), finish }
}

function readServices(getServices) {
  try {
    const value = typeof getServices === 'function' ? getServices() : null
    return value && typeof value === 'object' ? value : {}
  } catch {
    // 宿主服务启动早期可能还没注入：按「没有模型」降级，不要炸掉自检
    return {}
  }
}

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

/** 当前 DSH 模型：拿不到就返回 null，由调用方写 llmError。 */
function selectionOf(agentDefaultModel) {
  if (!agentDefaultModel || typeof agentDefaultModel.currentSelection !== 'function') return null
  try {
    return normalizeModel(agentDefaultModel.currentSelection())
  } catch {
    return null
  }
}

/** 每批 ≤8 段且 ≤4000 字符；单段超长时独占一批（不能把一段拆开审）。 */
function buildBatches(rows) {
  const batches = []
  let current = []
  let chars = 0
  const flush = () => {
    if (!current.length) return
    batches.push(current)
    current = []
    chars = 0
  }
  for (const row of rows) {
    const size = row.source.length + row.zh.length
    if (current.length && (current.length >= MAX_BATCH_ITEMS || chars + size > MAX_BATCH_CHARS)) flush()
    current.push(row)
    chars += size
  }
  flush()
  return batches
}

// ---------------------------------------------------------------- 工厂

/**
 * 创建自检器。store 只需要 readDoc / readTrans / writeReview（测试里给假实现）；
 * getServices 返回 { llm, agentDefaultModel }，两个都缺失时就是纯静态检查。
 */
export function createReview({ store, getServices } = {}) {
  if (!store || typeof store.readDoc !== 'function') {
    throw new Error('createReview 缺少 store：无法读取论文数据')
  }

  /** LLM 审校：按批请求，任何一批出错就记 llmError 并停止，已得到的 issues 保留。 */
  async function reviewWithLlm({ paragraphs, entries, limit, signal }) {
    const services = readServices(getServices)
    const llm = services.llm
    if (!llm || typeof llm.stream !== 'function') {
      return { issues: [], llmError: '没有可用的 llm 服务：自检已降级为纯静态检查' }
    }
    const model = selectionOf(services.agentDefaultModel)
    if (!model) {
      return { issues: [], llmError: '没有可用的模型：请先在 DSH 设置里配置模型适配器' }
    }
    const rows = []
    for (const paragraph of paragraphs) {
      if (rows.length >= limit) break
      const key = keyOf(paragraph)
      if (!key) continue
      rows.push({ key, source: String(paragraph.text || ''), zh: zhOf(entries[key]) })
    }
    const issues = []
    for (const batch of buildBatches(rows)) {
      const prompt = buildReviewPrompt(batch)
      try {
        const result = await collectStream(llm, {
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          system: prompt.system,
          temperature: REVIEW_TEMPERATURE,
          maxTokens: REVIEW_MAX_TOKENS,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
          signal,
        })
        if (result.finish && result.finish.kind === 'aborted') throw abortError()
        if (result.finish && result.finish.kind === 'error') throw finishError(result.finish)
        const parsed = parseReviewReply(
          result.text,
          batch.map((row) => row.key),
        )
        for (const row of parsed) {
          issues.push({
            key: row.key,
            code: 'llm',
            severity: row.severity,
            message: row.issue,
            ...(row.suggest ? { suggest: row.suggest } : {}),
          })
        }
      } catch (error) {
        // 「绝不抛」：模型不可用/报错只降级，让静态检查结果照常返回
        return { issues, llmError: messageOf(error) }
      }
    }
    return { issues, llmError: null }
  }

  /**
   * 跑一次自检：静态检查覆盖全部已翻译正文段落；LLM 检查最多看 limit 段（默认 80）。
   * 结果通过 store.writeReview 落盘（Lead 接到 db）。
   */
  async function run(paperId, opts = {}) {
    if (!paperId) throw new Error('缺少论文 id：无法确定要自检哪篇论文')
    const mode = opts.mode === 'static' || opts.mode === 'llm' ? opts.mode : 'both'
    const limitValue = Number(opts.limit)
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : DEFAULT_LIMIT
    const signal = opts.signal
    const doc = await store.readDoc(paperId)
    if (!doc) throw new Error('还没有文档模型，先打开一次论文')
    const trans = typeof store.readTrans === 'function' ? await store.readTrans(paperId) : { entries: {} }
    const entries = entriesOf(trans)
    const paragraphs = (Array.isArray(doc.paragraphs) ? doc.paragraphs : []).filter(
      (paragraph) => paragraph && paragraph.kind === 'body',
    )
    const translated = paragraphs.filter((paragraph) => {
      const key = keyOf(paragraph)
      return key && hasOwn(entries, key)
    })

    const issues = []
    let staticCount = 0
    if (mode !== 'llm') {
      const staticList = staticIssues(doc, entries)
      issues.push(...staticList)
      staticCount = staticList.length
    }

    let llmCount = 0
    let llmError
    if (mode !== 'static') {
      const result = await reviewWithLlm({ paragraphs: translated, entries, limit, signal })
      issues.push(...result.issues)
      llmCount = result.issues.length
      if (result.llmError) llmError = result.llmError
    }

    const result = {
      at: new Date().toISOString(),
      mode,
      issues,
      stats: {
        paragraphs: paragraphs.length,
        checked: translated.length,
        staticIssues: staticCount,
        llmIssues: llmCount,
        ...(llmError ? { llmError } : {}),
      },
    }
    await store.writeReview(paperId, result)
    return result
  }

  return { run }
}
