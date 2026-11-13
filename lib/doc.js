/**
 * 段落级文档模型（v2）：把 PDF 文本层 / OCR 结果整理成「节 → 段落」。
 *
 * 产物是 papers/<id>/doc.json（形状见 docs/v2-contracts.md §2.1），可随时重建：
 *   - 除 getDoc 之外全是纯函数，能单测（scripts/test-doc.mjs）；
 *   - 段落 hash 只由 (kind, 归一化文本) 决定，与页码/顺序解耦，重排 PDF 后旧译文仍能命中；
 *   - 任何解析异常都不抛给上层，一律回落到「每页一段」的退化模型。
 *
 * 字号启发式照搬 assets/pdf_tool.py 的 _clustered_body_size / _heuristic_outline：
 * SIZE_TOLERANCE=0.94、HEURISTIC_RATIO=1.12、标题长度 ≤120、最多 3 级。
 */
import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import * as store from './store.js'
import { extractText } from './pdf.js'

export const DOC_VERSION = 1

// ---- 字号启发式（与 pdf_tool.py 同名常量保持一致）
const SIZE_TOLERANCE = 0.94 // 同簇判定：size >= 簇代表 * 0.94（即 ±6%）
const HEURISTIC_RATIO = 1.12 // 标题：字号 ≥ 正文 × 1.12
const MAX_TITLE_LEN = 120 // 标题长度上限
const MAX_LEVELS = 3 // 标题最多 3 级
const DEFAULT_BODY_SIZE = 10 // 量不出正文时的兜底字号（A4/Letter 正文常见 9~12）

// ---- 同页合并：同字号(±0.6)、列重叠 ≥60%、纵向间距 ≤0.6×字号
const MERGE_SIZE_DELTA = 0.6
const MERGE_OVERLAP = 0.6
const MERGE_GAP_RATIO = 0.6

// ---- 页眉/页脚：块中心落在页高 6%~94% 之外丢弃；页码行还要求字号 < 0.9×正文
const HEADER_RATIO = 0.06
const FOOTER_RATIO = 0.94
const PAGE_NUMBER_FONT_RATIO = 0.9

// ---- 公式段：非字母数字字符占比 ≥30% 且长度 <400
const FORMULA_RATIO = 0.3
const FORMULA_MAX_LENGTH = 400
const FORMULA_MIN_LENGTH = 8 // 太短的符号块（"—"、"1"）不算公式

// 句末/分句终止标点：跨页合并与同页合并都用它区分「段中断行」与「真正的段落结束」
const TERMINAL_PUNCT = new Set(['.', '!', '?', '。', '！', '？', ':', ';', '：', '；'])

const ZERO_WIDTH_RE = /[\u200b-\u200f\u2060\ufeff]/g
const PAGE_NUMBER_RE = /^\d{1,4}$/
const PAGE_LABEL_RE = /^(page|part|p\.)\s*\d+/i
const CAPTION_RE = /^(figure|fig\.?|table|图|表)\s*\d+/i
const NUMERIC_ONLY_RE = /^[\d\s.,:;()\-–—/]+$/
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u3000-\u303f]/
// 行尾脚注/引用标记：数字、上标数字、†‡、星号
const FOOTNOTE_TAIL_RE = /[0-9\u00b9\u00b2\u00b3\u2070-\u2079\u2020\u2021*\u2217\u2022]+$/

// ---------------------------------------------------------------- 文本归一化

/** 折叠所有空白（含换行）、去零宽字符：hash 与标题匹配都用它。 */
export function collapseWs(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 保留换行（OCR 的表格行要用），只压掉行内多余空白与连续空行。 */
function cleanText(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 标题归一化：小写 + 只留字母数字（a-z0-9 的 CJK 超集），用于模糊匹配。 */
function titleKey(text) {
  return String(text === undefined || text === null ? '' : text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// ---------------------------------------------------------------- 段落 / 标题 hash

/**
 * 纯函数：段落 hash，16 位十六进制（sha1 前 16 位）。
 *
 * 归一化规则：去零宽字符（\u200b-\u200f、\ufeff）、把所有空白折叠成单个空格、去首尾空白；
 * kind 统一小写。文本大小写**不**折叠（cases 影响内容），页码/顺序不参与。
 */
export function paragraphHash(kind, text) {
  const normalizedKind = collapseWs(kind || 'body').toLowerCase()
  return createHash('sha1')
    .update(normalizedKind + '\u0000' + collapseWs(text))
    .digest('hex')
    .slice(0, 16)
}

/**
 * 纯函数：标题 hash，16 位十六进制。
 *
 * 与段落 hash 同一套空白/零宽归一化，另外折叠大小写 —— 节标题只用来命中译文缓存，
 * 大小写差异不该让缓存失效。
 */
export function titleHash(title) {
  return createHash('sha1')
    .update('title\u0000' + collapseWs(title).toLowerCase())
    .digest('hex')
    .slice(0, 16)
}

// ---------------------------------------------------------------- 小工具

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function round2(value) {
  return Math.round(toNumber(value) * 100) / 100
}

function endsWithTerminal(text) {
  // 末尾的脚注/引用标记（"…primitive.1"、"…method†"）先剥掉再判断句末标点
  const trimmed = collapseWs(text).replace(FOOTNOTE_TAIL_RE, '')
  if (!trimmed) return false
  return TERMINAL_PUNCT.has(trimmed[trimmed.length - 1])
}

/** 段落首字母小写（CJK 无大小写，按「可续行」处理）。 */
function startsLowercase(text) {
  const trimmed = collapseWs(text)
  if (!trimmed) return false
  const first = Array.from(trimmed)[0]
  if (/^\p{Ll}$/u.test(first)) return true
  return CJK_RE.test(first)
}

/**
 * 拼接被断行的两截文字：行尾连字符直接拼（IO- + aware → IO-aware），
 * 中文之间不插空格，其余用空格。
 */
function joinWrapped(left, right) {
  const head = String(left || '')
  const tail = String(right || '')
  if (!head) return tail
  if (!tail) return head
  if (/[-\u2010-\u2011\u2013]$/.test(head)) return head + tail
  if (CJK_RE.test(head[head.length - 1]) && CJK_RE.test(tail[0])) return head + tail
  return head + ' ' + tail
}

function truncateTitle(text, max = 60) {
  const value = collapseWs(text)
  if (value.length <= max) return value
  return value.slice(0, max).replace(/[\s,.;:，。；：]+$/, '') + '…'
}

// ---------------------------------------------------------------- 字号统计 / 分档

/** 统计「字号 → 字符数」：只数非空白字符，与 pdf_tool.py 一致。 */
function countCharSizes(pages) {
  const sizeChars = {}
  for (const page of pages) {
    for (const block of page.blocks) {
      if (!(block.size > 0)) continue
      const key = Math.round(block.size * 100) / 100
      const chars = block.text.replace(/\s+/g, '').length
      if (chars > 0) sizeChars[key] = (sizeChars[key] || 0) + chars
    }
  }
  return sizeChars
}

/**
 * 取正文字号：PDF 里同一视觉字号常因缩放抖动被拆成多个值，按 ±6% 聚簇，
 * 取字符总量最大的簇，簇内最大字号作正文（与 pdf_tool.py 的 _clustered_body_size 一致）。
 */
export function clusteredBodySize(sizeChars) {
  const sizes = Object.keys(sizeChars || {})
    .map(Number)
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((a, b) => b - a)
  const clusters = []
  for (const size of sizes) {
    const last = clusters[clusters.length - 1]
    if (last && size >= last.size * SIZE_TOLERANCE) last.chars += sizeChars[size]
    else clusters.push({ size, chars: sizeChars[size] })
  }
  if (!clusters.length) return 0
  let best = clusters[0]
  for (const cluster of clusters) if (cluster.chars > best.chars) best = cluster
  return best.size
}

/** 标题字号档位：从大到小聚簇，依次是 1/2/3 级。 */
function sizeTiers(sizes) {
  const unique = [...new Set(sizes.filter((size) => size > 0))].sort((a, b) => b - a)
  const tiers = []
  for (const size of unique) {
    if (!tiers.length || size < tiers[tiers.length - 1] * SIZE_TOLERANCE) tiers.push(size)
  }
  return tiers
}

function levelForSize(size, tiers, maxLevels) {
  for (let index = 0; index < tiers.length; index += 1) {
    if (size >= tiers[index] * SIZE_TOLERANCE) return Math.min(index + 1, maxLevels)
  }
  return Math.min(tiers.length || 1, maxLevels)
}

// ---------------------------------------------------------------- 块 / 页规范化

function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null
  const text = collapseWs(raw.text)
  if (!text) return null
  const x = round2(raw.x)
  const y = round2(raw.y)
  const x2 = Math.max(x, round2(raw.x2 === undefined ? x : raw.x2))
  const y2 = Math.max(y, round2(raw.y2 === undefined ? y : raw.y2))
  // pdf_tool（v2 起）会在块上带 kind：heading/body/list/caption/footnote。
  // 有就用它，别再靠字号猜（小节标题常与正文同字号，只加粗）。
  const kind = typeof raw.kind === 'string' && BLOCK_KINDS.has(raw.kind) ? raw.kind : ''
  return { x, y, x2, y2, size: round2(raw.size), bold: raw.bold === true, text, kind }
}

const BLOCK_KINDS = new Set(['heading', 'body', 'list', 'caption', 'footnote'])

/** 容忍 pages 直接是数组，或整个 text.json 对象（{ pages: [...] }）。 */
function normalizePages(pages) {
  const list = Array.isArray(pages) ? pages : pages && Array.isArray(pages.pages) ? pages.pages : []
  const out = []
  list.forEach((page, index) => {
    if (!page || typeof page !== 'object') return
    const blocks = (Array.isArray(page.blocks) ? page.blocks : []).map(normalizeBlock).filter(Boolean)
    if (!blocks.length) return
    // text.json 里页号字段是 "n"（pdf_tool.py 写的）；契约文档写的是 "page"，两个都认
    const pageNo = Math.max(1, Math.round(toNumber(page.page !== undefined ? page.page : page.n, index + 1)))
    out.push({
      page: pageNo,
      w: round2(page.w),
      h: round2(page.h),
      blocks,
    })
  })
  return out
}

// ---------------------------------------------------------------- 页眉 / 页脚

function isHeaderFooter(block, page, bodySize, options) {
  if (page.h > 0) {
    const centerY = (block.y + block.y2) / 2
    if (centerY < page.h * options.headerRatio || centerY > page.h * options.footerRatio) return true
  }
  // 页码/页标签：只在字号明显小于正文时剔除（正文里孤立的 "2024" 不该被吞掉）
  const compact = block.text.replace(/\s+/g, '')
  const looksPageNumber = PAGE_NUMBER_RE.test(compact) || PAGE_LABEL_RE.test(block.text)
  if (looksPageNumber && (bodySize <= 0 || block.size < bodySize * PAGE_NUMBER_FONT_RATIO)) return true
  return false
}

// ---------------------------------------------------------------- 同页合并

/** 标题被拆成「2.1」+「Hardware Performance」两个块（同一条基线）：合回去，否则目录对不上。 */
function canMergeHeadingLine(current, block) {
  if (current.kind !== 'heading' || block.kind !== 'heading') return false
  const minHeight = Math.min(current.y2 - current.y, block.y2 - block.y)
  const overlap = Math.min(current.y2, block.y2) - Math.max(current.y, block.y)
  if (!(minHeight > 0) || overlap / minHeight < 0.5) return false
  const lineHeight = Math.max(current.size, block.size, 10)
  const gap = block.x - current.x2
  if (gap >= -2 && gap <= lineHeight * 2.5) return 'append'
  // 编号在左、标题在右，但先遇到的可能是标题（"3" 排在 "An Efficient …" 之后）
  const back = current.x - block.x2
  if (back >= -2 && back <= lineHeight * 2.5) return 'prepend'
  return false
}

/** 标题换行续写（「FlashAttention: …」+「with IO-Awareness」）：同一字号、紧跟下一行。 */
function canMergeHeadingWrap(current, block) {
  if (current.kind !== 'heading' || block.kind !== 'heading') return false
  if (Math.abs(current.size - block.size) > 1.2) return false
  const lineHeight = Math.max(current.size, block.size, 10)
  const gap = block.y - current.y2
  if (!(gap >= -2 && gap <= lineHeight * 0.9)) return false
  // 标题居中时第二行会右移/左移很多，不看 x，只看是不是紧跟着的下一行
  return true
}

function canMergeSamePage(current, block, size, options) {
  // 带明确 kind 的块不并：图注/标题/列表各自独立，并进去会把结构吃掉
  if (current.kind && current.kind !== 'body') return false
  if (block.kind && block.kind !== 'body') return false
  if (current.kind !== block.kind && (current.kind || block.kind)) return false
  // 同字号（±0.6）
  if (Math.abs(current.size - size) > options.mergeSizeDelta) return false
  // 纵向间距 ≤0.6×字号（负值=两块有重叠，允许）
  const gap = block.y - current.y2
  if (gap > options.mergeGapRatio * Math.max(current.size, size)) return false
  // 列重叠 ≥60%（按较窄的一块算宽度，避免短末行被判成别列）
  const overlap = Math.min(current.x2, block.x2) - Math.max(current.x, block.x)
  const width = Math.min(current.x2 - current.x, block.x2 - block.x)
  if (!(width > 0) || overlap / width < options.mergeOverlap) return false
  // 以终止标点收尾说明这是独立段落：有些 PDF（LaTeX 单栏）段间距为 0，
  // 只靠间距会把整页正文粘成一段，故补这道闸。
  if (endsWithTerminal(current.text)) return false
  return true
}

function mergePageBlocks(blocks, bodySize, options) {
  const out = []
  let current = null
  for (const block of blocks) {
    const size = block.size > 0 ? block.size : bodySize
    const headingJoin = current ? canMergeHeadingLine(current, block) : false
    if (current && (headingJoin || canMergeHeadingWrap(current, block))) {
      current.text = headingJoin === 'prepend'
        ? (block.text + ' ' + current.text).trim()
        : (current.text + ' ' + block.text).trim()
      current.x2 = Math.max(current.x2, block.x2)
      current.y2 = Math.max(current.y2, block.y2)
      continue
    }
    if (current && canMergeSamePage(current, block, size, options)) {
      current.text = joinWrapped(current.text, block.text)
      current.x = Math.min(current.x, block.x)
      current.y = Math.min(current.y, block.y)
      current.x2 = Math.max(current.x2, block.x2)
      current.y2 = Math.max(current.y2, block.y2)
      current.size = Math.max(current.size, size) // 段内字号取大值：标题被拆块时保留标题字号
      continue
    }
    current = {
      text: block.text,
      x: block.x,
      y: block.y,
      x2: block.x2,
      y2: block.y2,
      size,
      kind: block.kind || '',
      crossPage: false,
    }
    out.push(current)
  }
  return out
}

// ---------------------------------------------------------------- 跨页合并

function canMergeAcrossPages(previous, next, bodySize, options) {
  if (!(next.page > previous.page)) return false
  // 图注/标题/列表不跨页拼
  if ((previous.kind && previous.kind !== 'body') || (next.kind && next.kind !== 'body')) return false
  if (Math.abs(previous.size - next.size) > options.mergeSizeDelta) return false
  // 标题/图注不跨页拼（字号达到标题档的一律不拼）
  const limit = bodySize * options.heuristicRatio
  if (bodySize > 0 && (previous.size >= limit || next.size >= limit)) return false
  // 上一段没写完（无终止标点）且下一段首字母小写 → 同一段被分页切断
  if (endsWithTerminal(previous.text)) return false
  return startsLowercase(next.text)
}

function mergeAcrossPages(paragraphs, bodySize, options) {
  const out = []
  for (const item of paragraphs) {
    const previous = out[out.length - 1]
    if (previous && canMergeAcrossPages(previous, item, bodySize, options)) {
      previous.text = joinWrapped(previous.text, item.text)
      previous.crossPage = true
      // bbox 保留起始页的那一块（跨页矩形没有几何意义），只打 crossPage 标记
      continue
    }
    out.push({ ...item })
  }
  return out
}

// ---------------------------------------------------------------- 段落分类

function isCaptionText(text) {
  return CAPTION_RE.test(collapseWs(text))
}

function isFormulaText(text, options) {
  const raw = collapseWs(text)
  if (raw.length >= options.formulaMaxLength) return false
  const compact = raw.replace(/\s+/g, '')
  if (compact.length < FORMULA_MIN_LENGTH) return false
  const symbols = (compact.match(/[^\p{L}\p{N}]/gu) || []).length
  return symbols / compact.length >= options.formulaRatio
}

/** 标题形状：字号 ≥1.12×正文、长度 ≤120、不以句号逗号结尾、非纯数字。 */
function isHeadingShape(text, size, bodySize, options) {
  const value = collapseWs(text)
  if (!value || value.length > options.maxTitleLen) return false
  if (bodySize <= 0) return false
  if (size < bodySize * options.heuristicRatio) return false
  if (/[.,。，、]$/.test(value)) return false
  if (NUMERIC_ONLY_RE.test(value)) return false
  return true
}

function classifyParagraphs(paragraphs, bodySize, options) {
  const items = paragraphs.map((paragraph) => ({
    ...paragraph,
    kind: BLOCK_KINDS.has(paragraph.kind) ? paragraph.kind : 'body',
    level: 0,
  }))
  // 顺序：图注 → 公式 → 标题 → 正文。
  // 图注优先于标题：被加粗放大的 "Table 1: …" 不该进目录；标题优先于公式的判断见下面注释。
  for (const item of items) {
    if (item.kind === 'body' && isCaptionText(item.text)) item.kind = 'caption'
    if (item.kind === 'body' && isFormulaText(item.text, options)) item.kind = 'formula'
  }
  for (const item of items) {
    if (item.kind === 'heading') item.headingCandidate = true
    if (item.kind !== 'body') continue
    if (!isHeadingShape(item.text, item.size, bodySize, options)) continue
    item.headingCandidate = true
  }
  const tiers = sizeTiers(items.filter((item) => item.headingCandidate).map((item) => item.size))
  for (const item of items) {
    if (item.kind !== 'body') continue
    if (item.headingCandidate) {
      item.kind = 'heading'
      item.level = levelForSize(item.size, tiers, options.maxLevels)
    }
    delete item.headingCandidate
  }
  return items
}

// ---------------------------------------------------------------- 公开：合成段落

/**
 * 纯函数：把 text.json 的 pages[].blocks[] 合成段落（不读盘）。
 *
 * opts 可注入 bodySize / headerRatio / footerRatio / mergeSizeDelta / mergeOverlap /
 * mergeGapRatio / heuristicRatio / maxTitleLen / maxLevels / formulaRatio / crossPage。
 */
export function mergeBlocks(pages, opts = {}) {
  const options = {
    bodySize: 0,
    headerRatio: HEADER_RATIO,
    footerRatio: FOOTER_RATIO,
    mergeSizeDelta: MERGE_SIZE_DELTA,
    mergeOverlap: MERGE_OVERLAP,
    mergeGapRatio: MERGE_GAP_RATIO,
    heuristicRatio: HEURISTIC_RATIO,
    maxTitleLen: MAX_TITLE_LEN,
    maxLevels: MAX_LEVELS,
    formulaRatio: FORMULA_RATIO,
    formulaMaxLength: FORMULA_MAX_LENGTH,
    crossPage: true,
    ...opts,
  }
  const normalized = normalizePages(pages)
  const measured = options.bodySize > 0 ? options.bodySize : clusteredBodySize(countCharSizes(normalized))
  const bodySize = measured > 0 ? measured : DEFAULT_BODY_SIZE

  const merged = []
  for (const page of normalized) {
    const blocks = page.blocks.filter((block) => !isHeaderFooter(block, page, bodySize, options))
    for (const item of mergePageBlocks(blocks, bodySize, options)) {
      merged.push({ ...item, page: page.page })
    }
  }

  const joined = options.crossPage ? mergeAcrossPages(merged, bodySize, options) : merged
  const classified = classifyParagraphs(joined, bodySize, options)

  return classified.map((item, order) => ({
    id: 'p' + String(order).padStart(4, '0'),
    order,
    page: item.page,
    kind: item.kind,
    level: item.kind === 'heading' ? item.level : 0,
    text: item.text,
    hash: paragraphHash(item.kind, item.text),
    bbox: [item.x, item.y, item.x2, item.y2],
    size: round2(item.size),
    crossPage: item.crossPage === true,
  }))
}

// ---------------------------------------------------------------- 分节

/** 校验并净化 outline（meta.json 里可能是空数组/脏数据）。 */
function normalizeOutline(outline) {
  const list = Array.isArray(outline) ? outline : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const title = collapseWs(item.title)
    if (!title) continue
    out.push({
      title,
      level: Math.min(6, Math.max(1, Math.round(toNumber(item.level, 1)))),
      page: Math.max(1, Math.round(toNumber(item.page, 1))),
    })
  }
  return out
}

function paragraphOrder(paragraph, index) {
  return Number.isFinite(paragraph && paragraph.order) ? paragraph.order : index
}

/**
 * 给 outline 的每一条找锚点段落：先整段文字归一化后完全相等，再段首匹配（"1 Introduction"
 * vs "Introduction"），再正文包含（标题较长时），最后退回「该页第一个段落」。
 * fromIndex 保证锚点单调不减，不会两条 outline 指到同一处又倒回去。
 */
function findAnchor(paragraphs, item, fromIndex) {
  // 锚点必须单调不减：上一节找到的位置就是这一节的搜索起点
  const start = Math.min(Math.max(fromIndex, 0), paragraphs.length - 1)
  const want = titleKey(item.title)
  if (want) {
    for (let index = start; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index]
      if (paragraph.kind === 'caption' || paragraph.kind === 'formula') continue
      if (titleKey(paragraph.text) === want) return index
    }
    for (let index = start; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index]
      if (paragraph.kind === 'caption' || paragraph.kind === 'formula') continue
      if (paragraph.kind !== 'heading') continue
      const key = titleKey(paragraph.text)
      if (!key) continue
      const limit = Math.max(want.length * 2.2, want.length + 12)
      if (key.length <= limit && (key.includes(want) || want.includes(key))) return index
    }
    if (want.length >= 6) {
      for (let index = start; index < paragraphs.length; index += 1) {
        const paragraph = paragraphs[index]
        if (paragraph.kind === 'caption' || paragraph.kind === 'formula') continue
        if (titleKey(paragraph.text).includes(want)) return index
      }
    }
  }
  // 标题文字对不上（扫描件 OCR 差异等）：按 outline 的页码找该页第一个段落
  for (let index = start; index < paragraphs.length; index += 1) {
    if (paragraphs[index].page >= item.page) return index
  }
  return paragraphs.length - 1
}

function toSections(anchors, paragraphs) {
  return anchors.map((anchor, order) => {
    const paragraph = paragraphs[anchor.index]
    return {
      id: 's' + (order + 1),
      order,
      title: anchor.title,
      level: anchor.level,
      page: paragraph.page,
      hash: titleHash(anchor.title),
      startParagraph: paragraphOrder(paragraph, anchor.index),
    }
  })
}

function sectionsFromOutline(paragraphs, outline, options) {
  const anchors = []
  let cursor = 0
  for (const item of outline) {
    let index = findAnchor(paragraphs, item, cursor)
    // 两条 outline 命中同一个段落时顺延一段：每节至少要有一段，目录才不会出现空节
    const previous = anchors.length ? anchors[anchors.length - 1].index : -1
    if (index <= previous) index = Math.min(previous + 1, paragraphs.length - 1)
    if (index < 0) continue
    cursor = index
    anchors.push({ index, title: item.title, level: item.level })
  }
  if (!anchors.length) return []
  if (anchors[0].index > 0) anchors.unshift({ index: 0, title: options.fallbackTitle, level: 1 })
  return toSections(anchors, paragraphs)
}

function sectionsFromHeuristic(paragraphs, options) {
  const anchors = []
  const headings = []
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.kind === 'heading') headings.push({ index, paragraph })
  })
  if (headings.length) {
    for (const { index, paragraph } of headings) {
      anchors.push({
        index,
        title: truncateTitle(paragraph.text, options.maxTitleLen),
        level: Math.min(options.maxLevels, Math.max(1, paragraph.level || 1)),
      })
    }
  } else if (new Set(paragraphs.map((paragraph) => paragraph.page)).size > 1) {
    // 多页又量不出标题：把每页首段当节标题，至少让目录能按页跳
    const seen = new Set()
    paragraphs.forEach((paragraph, index) => {
      if (seen.has(paragraph.page)) return
      seen.add(paragraph.page)
      anchors.push({ index, title: truncateTitle(paragraph.text, 60) || '第 ' + paragraph.page + ' 页', level: 1 })
    })
  }
  // 单页又没有标题：整篇一节「正文」（不拿正文首句冒充标题）
  if (!anchors.length) anchors.push({ index: 0, title: options.fallbackTitle, level: 1 })
  if (anchors[0].index > 0) anchors.unshift({ index: 0, title: options.fallbackTitle, level: 1 })
  return toSections(anchors, paragraphs)
}

/** 把节起点写回段落：段落从所属节的 startParagraph 起归属该节。 */
function applySectionIds(paragraphs, sections) {
  const starts = sections.map((section) => section.startParagraph)
  // 节首那一段如果本身是标题，级别以节（outline）为准：字号启发式很容易被
  // arXiv 侧边章、日期行这类异常大字号块带偏，把真正的章节标题压到 3 级。
  const levelAtStart = new Map()
  for (const section of sections) {
    levelAtStart.set(section.startParagraph, Math.min(MAX_LEVELS, Math.max(1, section.level)))
  }
  return paragraphs.map((paragraph, index) => {
    const order = paragraphOrder(paragraph, index)
    let sectionId = sections.length ? sections[0].id : undefined
    for (let cursor = sections.length - 1; cursor >= 0; cursor -= 1) {
      if (order >= starts[cursor]) {
        sectionId = sections[cursor].id
        break
      }
    }
    const level = paragraph.kind === 'heading' && levelAtStart.has(order) ? levelAtStart.get(order) : paragraph.level
    // 显式重建对象：doc.json 的字段顺序固定成契约 §2.1 的样子，读起来稳定
    return {
      id: paragraph.id,
      order,
      page: paragraph.page,
      section: sectionId,
      kind: paragraph.kind,
      level,
      text: paragraph.text,
      hash: paragraph.hash,
      bbox: paragraph.bbox,
      size: paragraph.size,
      crossPage: paragraph.crossPage,
    }
  })
}

/**
 * 纯函数：把段落分配到节。
 *
 * - 有 outline：标题文字做归一化模糊匹配找锚点，找不到再用 outline.page 找该页首段；
 * - 没有 outline：拿 kind:'heading' 的段落当节标题，再不行就把每页首段当节标题，
 *   整篇只剩一页时就是单节 "s1"；
 * - 首节标题缺失时补「正文」，保证第 0 段一定落在第一节里。
 */
export function assignSections(paragraphs, outline, opts = {}) {
  const list = Array.isArray(paragraphs)
    ? paragraphs.filter((paragraph) => paragraph && typeof paragraph === 'object')
    : []
  if (!list.length) return { sections: [], paragraphs: [] }
  const options = { fallbackTitle: '正文', maxTitleLen: MAX_TITLE_LEN, maxLevels: MAX_LEVELS, ...opts }

  let sections = sectionsFromOutline(list, normalizeOutline(outline), options)
  if (!sections.length) sections = sectionsFromHeuristic(list, options)
  return { sections, paragraphs: applySectionIds(list, sections) }
}

// ---------------------------------------------------------------- OCR（扫描件）

/** 按 `## p.N` 切页；没有分页标记时整篇算第 1 页。 */
function splitOcrPages(markdown) {
  const text = String(markdown || '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return []
  const pages = []
  let current = { page: 1, lines: [] }
  for (const line of text.split('\n')) {
    const marker = /^##\s*p\.?\s*(\d+)\s*$/i.exec(line.trim())
    if (marker) {
      pages.push(current)
      current = { page: Math.max(1, parseInt(marker[1], 10) || 1), lines: [] }
      continue
    }
    current.lines.push(line)
  }
  pages.push(current)
  return pages.filter((page) => page.lines.some((line) => line.trim()))
}

/**
 * 页内切段：空行分段；`#`/`##`/`###` 行是 heading（但 `## p.N` 已在上面被当分页标记）；
 * 表格行（`|`）与列表项归 kind:'list'，连续表格行合成一段（保留换行，表格才有形状）。
 */
function ocrPageParagraphs(page) {
  const out = []
  let buffer = []
  const flush = () => {
    if (!buffer.length) return
    const text = cleanText(buffer.join(' '))
    if (text) out.push({ kind: 'body', level: 0, text })
    buffer = []
  }
  let table = null
  const flushTable = () => {
    if (!table) return
    out.push({ kind: 'list', level: 0, text: cleanText(table.join('\n')) })
    table = null
  }

  for (const raw of page.lines) {
    const line = raw.trim()
    if (!line) {
      flush()
      flushTable()
      continue
    }
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (heading) {
      flush()
      flushTable()
      out.push({ kind: 'heading', level: Math.min(3, heading[1].length), text: cleanText(heading[2]) })
      continue
    }
    if (line.startsWith('|')) {
      flush()
      if (!table) table = []
      table.push(line)
      continue
    }
    flushTable()
    if (/^([-*+]|\d+[.)])\s+/.test(line)) {
      flush()
      const text = cleanText(line.replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1'))
      if (text) out.push({ kind: 'list', level: 0, text })
      continue
    }
    buffer.push(line.replace(/\*\*([^*]+)\*\*/g, '$1'))
  }
  flush()
  flushTable()
  return out
}

/** 扫描件：按页段拼成段落（hash/id 由 finalize 补），并顺手从 heading 里造一份 outline。 */
function buildOcrParagraphs(ocrMarkdown) {
  const pages = splitOcrPages(ocrMarkdown)
  const paragraphs = []
  const outline = []
  for (const page of pages) {
    for (const item of ocrPageParagraphs(page)) {
      paragraphs.push({ page: page.page, kind: item.kind, level: item.level, text: item.text, size: 0 })
      if (item.kind === 'heading' && item.level <= 3 && item.text.length <= MAX_TITLE_LEN) {
        outline.push({ level: item.level, title: item.text, page: page.page })
      }
    }
  }
  return { paragraphs, outline }
}

// ---------------------------------------------------------------- 收尾 / 退化模型

/** 补 id/order/hash/bbox，并保证字段顺序与契约 §2.1 一致。 */
function finalizeParagraphs(items, defaults = {}) {
  return items.map((item, order) => {
    const kind = item.kind || 'body'
    const text = cleanText(item.text)
    const bbox = Array.isArray(item.bbox) && item.bbox.length === 4
      ? item.bbox.slice(0, 4).map(round2)
      : [0, 0, 0, 0]
    return {
      id: 'p' + String(order).padStart(4, '0'),
      order,
      page: Math.max(1, Math.round(toNumber(item.page, defaults.page || 1))),
      kind,
      level: kind === 'heading' ? Math.min(MAX_LEVELS, Math.max(1, Math.round(toNumber(item.level, 1)))) : 0,
      text,
      hash: paragraphHash(kind, text),
      bbox,
      size: round2(item.size),
      crossPage: item.crossPage === true,
    }
  })
}

/**
 * 退化模型：每页一段（页内文字用空格拼），不抛错。
 * 连页都拿不到时给一段提示文案，保证上层拿到的 doc 永远有段落。
 */
function degenerateDoc({ meta, text, ocrMarkdown, pdf, builtAt }) {
  const pages = normalizePages(text && text.pages)
  const items = []
  for (const page of pages) {
    const content = page.blocks.map((block) => block.text).join(' ')
    if (collapseWs(content)) items.push({ page: page.page, kind: 'body', text: content })
  }
  let source = 'pdf-text'
  if (!items.length) {
    source = 'ocr'
    const ocrPages = splitOcrPages(ocrMarkdown)
    for (const page of ocrPages) {
      const content = cleanText(page.lines.join(' '))
      if (content) items.push({ page: page.page, kind: 'body', text: content })
    }
  }
  if (!items.length) {
    const fallback = collapseWs(meta && meta.abstract) || collapseWs(meta && meta.title) || '（这篇论文没有可提取的正文）'
    items.push({ page: 1, kind: 'body', text: fallback })
  }
  const paragraphs = finalizeParagraphs(items)
  const { sections, paragraphs: withSections } = assignSections(paragraphs, [])
  return {
    version: DOC_VERSION,
    source,
    builtAt,
    title: collapseWs((meta && meta.title) || ''),
    pdf: pdfOf(pdf),
    sections,
    paragraphs: withSections,
    degraded: true, // 追加字段：让上层/排查脚本能看出这是退化结果
  }
}

function pdfOf(pdf) {
  const value = pdf && typeof pdf === 'object' ? pdf : {}
  return {
    sha1: typeof value.sha1 === 'string' ? value.sha1 : '',
    bytes: Math.max(0, Math.round(toNumber(value.bytes))),
    mtimeMs: Math.max(0, Math.round(toNumber(value.mtimeMs))),
  }
}

function normalizeDocInput(input) {
  const value = input && typeof input === 'object' ? input : {}
  return {
    meta: value.meta && typeof value.meta === 'object' ? value.meta : {},
    text: value.text && typeof value.text === 'object' ? value.text : null,
    outline: Array.isArray(value.outline) ? value.outline : value.meta && Array.isArray(value.meta.outline) ? value.meta.outline : [],
    ocrMarkdown: typeof value.ocrMarkdown === 'string' ? value.ocrMarkdown : '',
    pdf: value.pdf,
  }
}

/**
 * 纯函数：组装完整 doc 对象。
 *
 * 优先用文本层（mergeBlocks + assignSections）；没有文本层就用 OCR Markdown；
 * 都失败则回落到「每页一段」的退化模型 —— 任何异常都不抛给上层。
 */
export function buildDoc(input) {
  const doc = buildDocCore(input)
  return { ...doc, outlineHash: outlineFingerprint(input && input.outline) }
}

function buildDocCore(input) {
  const { meta, text, outline, ocrMarkdown, pdf } = normalizeDocInput(input)
  const builtAt = new Date().toISOString()

  try {
    const paragraphs = mergeBlocks(text && text.pages)
    if (paragraphs.length) {
      const { sections, paragraphs: withSections } = assignSections(paragraphs, outline)
      if (sections.length && withSections.length) {
        return {
          version: DOC_VERSION,
          source: 'pdf-text',
          builtAt,
          title: collapseWs(meta.title || ''),
          pdf: pdfOf(pdf),
          sections,
          paragraphs: withSections,
        }
      }
    }
  } catch (error) {
    console.error('[paper-workbench] 文本层建模失败，尝试 OCR：' + (error && error.message))
  }

  try {
    const ocr = buildOcrParagraphs(ocrMarkdown)
    if (ocr.paragraphs.length) {
      const paragraphs = finalizeParagraphs(ocr.paragraphs)
      // 有 meta.outline 就用它（OCR 文本也能模糊匹配），否则用 OCR 自己的 heading 造节
      const { sections, paragraphs: withSections } = assignSections(paragraphs, outline.length ? outline : ocr.outline)
      const firstHeading = ocr.paragraphs.find((item) => item.kind === 'heading')
      return {
        version: DOC_VERSION,
        source: 'ocr',
        builtAt,
        title: collapseWs(meta.title || (firstHeading && firstHeading.text) || ''),
        pdf: pdfOf(pdf),
        sections,
        paragraphs: withSections,
      }
    }
  } catch (error) {
    console.error('[paper-workbench] OCR 建模失败，回落到每页一段：' + (error && error.message))
  }

  return degenerateDoc({ meta, text, ocrMarkdown, pdf, builtAt })
}

/**
 * 目录指纹：meta.outline 变了（重新导入、OCR 补出 TOC、目录被手动修过）就该重建 doc.json。
 * 只按 PDF sha1 判断缓存会留下「目录有 28 条、正文却只有 1 节」的旧模型（2026-11-11 实测到过）。
 */
export function outlineFingerprint(outline) {
  const list = Array.isArray(outline) ? outline : []
  const payload = list
    .map((item) => [Number(item && item.page) || 0, String((item && item.level) || ''), String((item && item.title) || '').trim()].join('~'))
    .join('|')
  return createHash('sha1').update(payload).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------- 对外入口（读盘）

/** pdf sha1 缓存：同一篇论文反复 getDoc 不用重算（按 mtime+size 失效）。 */
const sha1Cache = new Map() // id → { path, mtimeMs, bytes, sha1 }

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 取 PDF 指纹：{ path, sha1, bytes, mtimeMs }；文件不在时抛 store 的错误。 */
async function pdfFingerprint(id) {
  const resolved = await store.resolvePdf(id) // { path, meta }
  const stat = await fsp.stat(resolved.path)
  const cached = sha1Cache.get(id)
  if (cached && cached.path === resolved.path && cached.mtimeMs === stat.mtimeMs && cached.bytes === stat.size) {
    return { path: resolved.path, sha1: cached.sha1, bytes: stat.size, mtimeMs: stat.mtimeMs }
  }
  const sha1 = await sha1File(resolved.path)
  sha1Cache.set(id, { path: resolved.path, mtimeMs: stat.mtimeMs, bytes: stat.size, sha1 })
  return { path: resolved.path, sha1, bytes: stat.size, mtimeMs: stat.mtimeMs }
}

function isUsableDoc(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    value.version === DOC_VERSION &&
    Array.isArray(value.paragraphs) &&
    value.paragraphs.length > 0 &&
    Array.isArray(value.sections)
  )
}

/**
 * 对外入口：读 doc.json 缓存，用 PDF 的 sha1 校验；不一致或 rebuild 时重建并写盘。
 *
 * 返回 { doc, built, stale?, ms }。失败时：有旧 doc 就返回旧 doc + stale:true（页面还能看），
 * 没有就抛错（错误消息直接给用户看）。
 */
export async function getDoc(id, opts = {}) {
  // 单飞：两个窗口/搜索与重建同时要同一篇时，不要各自 spawn 一个 PyMuPDF 把整本扫两遍。
  const key = String(id || '') + (opts && opts.rebuild ? '#rebuild' : '')
  const running = inflight.get(key)
  if (running) return running
  const task = getDocInner(id, opts).finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

const inflight = new Map()

async function getDocInner(id, { rebuild = false } = {}) {
  const started = Date.now()
  const safeId = String(id || '')
  if (!safeId) throw new Error('缺少论文 id')
  const cached = await store.readDoc(safeId).catch(() => null)
  const usable = isUsableDoc(cached)

  let meta = null
  let metaError = null
  try {
    meta = await store.getMeta(safeId)
  } catch (error) {
    meta = null
    metaError = error
  }
  // 论文不存在就当场说清楚：否则会退化成一段占位文本，界面显示「几乎没有内容」
  if (!meta) throw metaError || new Error('论文不存在：' + safeId)

  // 目录变了也重建：只比 PDF sha1 会留下「目录 28 条、正文却只有 1 节」的旧模型
  const outlineChanged = Boolean(
    usable && meta && outlineFingerprint(meta.outline) !== String(cached.outlineHash || ''),
  )

  let fingerprint = null
  let fingerprintError = null
  try {
    fingerprint = await pdfFingerprint(safeId)
  } catch (error) {
    fingerprintError = error
  }

  // text.json 以前只在打开「文本」页时才生成，于是没被打开过的论文建模时只有一段占位，
  // 对照视图看起来「几乎空白」。这里直接抽一次并缓存，不依赖用户先点别的页。
  let text = await store.readTextCache(safeId).catch(() => null)
  // text.json 可能来自旧版本 PDF：按 source 指纹判断是否要重抽（没有 source 的老缓存也算旧）。
  const textStale = Boolean(
    fingerprint &&
      text &&
      (!text.source ||
        text.source.size !== fingerprint.bytes ||
        text.source.mtimeMs !== fingerprint.mtimeMs),
  )
  const hasCachedText = Boolean(text && Array.isArray(text.pages) && text.pages.length)
  // 有缓存就不要再整本重扫：扫描页抽出来是「每页若干空 blocks」，重扫只会白等几十秒。
  // 没有缓存时 cached 是 null，这里不能摸 cached.degraded（曾经因此让 search.doc 直接 500）
  const needsText = Boolean(fingerprint) && (!hasCachedText || textStale)
  if (needsText) {
    try {
      const resolved = await store.resolvePdf(safeId)
      const fresh = await extractText(resolved.path)
      if (fresh && Array.isArray(fresh.pages) && fresh.pages.length) {
        // 带上 source 指纹：PDF 换了版本要能认出来，pdf.js 的 loadText 也靠它命中缓存
        const source = {
          path: resolved.path,
          size: fingerprint ? fingerprint.bytes : undefined,
          mtimeMs: fingerprint ? fingerprint.mtimeMs : undefined,
        }
        text = { ...fresh, source }
        try {
          await store.writeTextCache(safeId, text)
        } catch (error) {
          // 写缓存失败不影响这次建模
          console.error('[paper-workbench] 写 text.json 失败 ' + safeId + '：' + (error && error.message))
        }
      }
    } catch {
      // 扫描件没有文本层（或这台机器没装 PyMuPDF）：保持原样，后面走 OCR / 退化
    }
  }
  const hasText = Boolean(text && Array.isArray(text.pages) && text.pages.some((page) => (page.blocks || []).some((block) => String(block.text || '').trim())))

  const sameFile = Boolean(fingerprint && cached && cached.pdf && String(cached.pdf.sha1 || '') === fingerprint.sha1)
  // 退化模型（一段占位）只要现在有文本层就必须重建，否则会一直显示那一行
  const healed = Boolean(usable && cached.degraded === true && hasText)
  if (usable && sameFile && !outlineChanged && !healed && !rebuild) {
    return { doc: cached, built: false, ms: Date.now() - started }
  }
  // PDF 暂时定位不到：旧模型还能用就先给用户，标记 stale 让界面提示「可能已过期」
  if (usable && !fingerprint && !outlineChanged && !rebuild) {
    return { doc: cached, built: false, stale: true, ms: Date.now() - started }
  }
  // 仍是退化模型且抽不出文本：别每次调用都重算一遍
  if (usable && cached.degraded === true && !hasText && !rebuild && !outlineChanged) {
    return { doc: cached, built: false, stale: true, ms: Date.now() - started }
  }

  try {
    const outline = Array.isArray((meta || {}).outline) ? meta.outline : []
    const ocrMarkdown = await store.readOcr(safeId)
    const doc = buildDoc({ meta: meta || {}, text, outline, ocrMarkdown, pdf: fingerprint ? { ...fingerprint } : null })
    if (!doc.paragraphs.length) throw new Error('解析后没有任何段落')
    try {
      await store.writeDoc(safeId, doc)
    } catch (error) {
      // 写盘失败不该让用户看不到内容：下次调用会再次重建
      console.error('[paper-workbench] 写 doc.json 失败 ' + safeId + '：' + (error && error.message))
    }
    // PDF 定位不到时仍然能从 text.json/ocr.md 建模，但没法保证与 PDF 对齐，标 stale 提醒界面
    return fingerprint
      ? { doc, built: true, ms: Date.now() - started }
      : { doc, built: true, stale: true, ms: Date.now() - started }
  } catch (error) {
    if (usable) return { doc: cached, built: false, stale: true, ms: Date.now() - started }
    throw fingerprintError && !fingerprint ? fingerprintError : error
  }
}

/**
 * 清掉内存里的 PDF sha1 缓存（测试、重新导入、替换 PDF 后用）。
 * `dropDoc: true` 连 doc.json 一起删：OCR 写完 ocr.md 时正文来源变了，
 * 只清内存缓存的话下次 getDoc 仍会命中旧 doc.json（扫描件继续显示占位）。
 */
export function invalidateDocCache(id, { dropDoc = false } = {}) {
  if (id === undefined || id === null || id === '') {
    sha1Cache.clear()
    return
  }
  const safeId = String(id)
  sha1Cache.delete(safeId)
  if (dropDoc) {
    // 调用方多是同步路径：删文件不阻塞，失败下不为例（getDoc 会自己重建）
    store.clearDocCache(safeId).catch(() => {})
  }
}
