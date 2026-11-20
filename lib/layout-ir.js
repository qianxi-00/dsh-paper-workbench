/** Pure, offline layout IR. Never import layout.js: it owns the integration boundary. */
import { createHash } from 'node:crypto'

const BUILD = 'ir-4'
const kinds = { text: 'body', abstract: 'body', content: 'body', paragraph_title: 'heading', doc_title: 'heading', figure_title: 'caption', table_title: 'caption', footnote: 'footnote', formula: 'formula', formula_number: 'formula_number', image: 'figure', chart: 'figure', table: 'table', list: 'list', algorithm: 'algorithm', reference: 'body', aside_text: 'body' }
const decorations = new Set(['header', 'footer', 'number', 'page_number'])
const list = value => Array.isArray(value) ? value : []
const text = value => String(value ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/gu, ' ').trim()
const comparable = value => text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/
const joinLines = values => {
  let out = ''
  for (const value of values) {
    const line = text(value)
    if (!line) continue
    if (!out) { out = line; continue }
    // PDF 抽取偶尔把断词写成「pre-  dictor」（连字符后带空格），
    // 若只判断 endsWith('-') 会保留这个空格，正文里就出现 "pre- dictor"。
    if (/-\s*$/.test(out) && /^[A-Za-z0-9]/.test(line)) out = out.replace(/\s+$/, '') + line
    else if (CJK.test(out.slice(-1)) && CJK.test(line[0])) out += line
    else out += ' ' + line
  }
  return out
}
const rect = value => Array.isArray(value)
  ? { x: value[0], y: value[1], width: value[2] - value[0], height: value[3] - value[1] }
  : { x: value?.x, y: value?.y, width: value?.width ?? value?.x2 - value?.x, height: value?.height ?? value?.y2 - value?.y }
const validRect = b => b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0
const area = b => validRect(b) ? b.width * b.height : 0
const intersection = (a, b) => !validRect(a) || !validRect(b) ? 0 : Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
const iou = (a, b) => intersection(a, b) / Math.max(1, area(a) + area(b) - intersection(a, b))
const locatedIssue = (code, page, blockId, detail) => ({ code, page, ...(blockId ? { blockId } : {}), ...(detail ? { detail } : {}) })
const NON_BLOCKING_CODES = new Set(['text-conflict', 'rescued-pdf-line', 'unmatched-pdf-line', 'duplicate-formula'])
export function qualitySummary(issues) {
  return {
    blocking: issues.filter(issue => !NON_BLOCKING_CODES.has(issue.code)).length,
    informational: issues.filter(issue => NON_BLOCKING_CODES.has(issue.code)).length,
  }
}
const quality = issues => ({ status: issues.length ? 'needs_review' : 'passed', issues, summary: qualitySummary(issues) })
const isVisual = b => b.kind === 'figure' || b.kind === 'table'
const compareBlocks = (a, b) => a.page - b.page || (a.sourceOrder ?? a.bbox.y) - (b.sourceOrder ?? b.bbox.y) || a.bbox.x - b.bbox.x || a.blockId.localeCompare(b.blockId)
const issue = (block, code, detail) => block.quality.issues.push(locatedIssue(code, block.page, block.blockId, detail))

function similarity(left, right) {
  const a = comparable(left), b = comparable(right)
  if (!a || !b) return 0
  if (a.includes(b) || b.includes(a)) return 1
  const grams = s => { const bag = new Map(); for (let i = 1; i < s.length; i++) { const g = s.slice(i - 1, i + 1); bag.set(g, (bag.get(g) || 0) + 1) } return bag }
  const bag = grams(a), other = grams(b)
  let shared = 0
  for (const [g, count] of bag) shared += Math.min(count, other.get(g) || 0)
  return 2 * shared / Math.max(1, a.length + b.length - 2)
}

function garbled(value) {
  const s = text(value), words = s.split(/\s+/u)
  return /[\uFFFD\u0000-\u0008\uE000-\uF8FF]/u.test(s) || (words.length >= 6 && words.filter(w => /^[a-z]$/i.test(w)).length / words.length > 0.6)
}

/** 只在目录上下文/点引导线和多条页码共同佐证时识别；正文数字不构成目录。 */
export function tocEntryInfo(value) {
  const s = text(value)
  const target = /(?:\s|[.．…·])+(\d{1,4})\s*$/.exec(s)
  if (!target) return null
  const title = s.slice(0, target.index).replace(/[\s.．…·]+$/g, '')
  if (!/[\p{L}]/u.test(title)) return null
  const number = /^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)+|[A-Z](?=[.、]?\s|\p{Script=Han}))[.、]?\s*/u.exec(title)
  return { tocLevel: number ? number[1].split('.').length : 1, tocTargetPage: Number(target[1]), numbered: Boolean(number), leader: /(?:[.．·]\s*){2,}|…/u.test(s) }
}

export function structureTocRows(rows, context = false) {
  const values = rows.filter(r => text(r.text))
  const parsed = values.map(r => tocEntryInfo(r.text))
  const hits = parsed.filter(Boolean)
  if (hits.length < 3 || hits.length < values.length * 0.6 ||
    !(context || hits.filter(p => p.leader).length >= 2) || hits.filter(p => p.numbered || p.leader).length < 3) return null
  return values.map((row, i) => ({ ...row, ...(parsed[i] ? { tocLevel: parsed[i].tocLevel, tocTargetPage: parsed[i].tocTargetPage } : { tocLevel: 1 }) }))
}

function geometricRows(lines) {
  const rows = []
  for (const line of [...lines].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const box = line.bbox
    const prev = rows.at(-1)
    const overlap = prev ? Math.min(prev.bbox.y + prev.bbox.height, box.y + box.height) - Math.max(prev.bbox.y, box.y) : 0
    if (prev && overlap >= Math.min(prev.bbox.height, box.height) * 0.45 && box.x >= prev.bbox.x + prev.bbox.width - 3) {
      prev.text = joinLines([prev.text, line.text])
      prev.bbox = union(prev.bbox, box)
      prev.lineIds.push(line.lineId)
    } else rows.push({ text: text(line.text), bbox: { ...box }, lineIds: [line.lineId] })
  }
  return rows
}

function tocRowsForBlock(block, lines, context) {
  if (!['body', 'list', 'heading'].includes(block.kind)) return null
  const rows = geometricRows(lines)
  const geometric = structureTocRows(rows, context || block.label === 'content')
  for (const candidate of block.candidates) {
    const modelRows = String(candidate.text).split(/\r?\n/).filter(s => s.trim()).map(s => ({ text: text(s), bbox: { ...block.bbox }, lineIds: [] }))
    const structured = structureTocRows(modelRows, context || block.label === 'content')
    if (!structured) continue
    if (geometric) {
      // PDF 漏了整条而服务候选完整时，逐行严格对齐；已存在的 PDF 字符仍全部保留。
      const key = value => value.replace(/\s/g, '')
      let cursor = 0
      const aligned = structured.map(row => {
        const pdf = rows[cursor]
        if (pdf && key(pdf.text) === key(row.text)) { cursor += 1; return { ...row, ...pdf, source: 'pdf' } }
        return { ...row, source: candidate.source }
      })
      if (cursor === rows.length && structured.length > rows.length) return aligned
      continue
    }
    // 单个 PDF 行失去几何分隔时，只有逐字守恒才允许借用服务换行。
    const pdfText = joinLines(rows.map(r => r.text))
    if (rows.length && pdfText.replace(/\s/g, '') !== structured.map(r => r.text).join('').replace(/\s/g, '')) continue
    if (rows.length) structured[0].lineIds = rows.flatMap(r => r.lineIds)
    return structured
  }
  return geometric
}

function choose(block) {
  const nonempty = block.candidates.filter(c => c.text)
  // 图注的正文价值是「模型认出的图题/表题」；PDF 文本层常把图内标签一起抠进来。
  // 但模型也可能拼错单词，所以只在 PDF 候选明显比模型候选长（多出的多半是图内文字）时罚分，
  // 等长时仍允许 PDF 纠正拼写。
  const modelLens = block.candidates.filter(c => c.source !== 'pdf' && c.text).map(c => comparable(c.text).length)
  const shortestModel = modelLens.length ? Math.min(...modelLens) : 0
  const scored = block.candidates.map((c, index) => {
    const normalized = comparable(c.text)
    const overlongCaption = block.kind === 'caption' && c.source === 'pdf' && shortestModel > 0 &&
      normalized.length > shortestModel * 1.25 + 10
    const incomplete = normalized.length >= 5 && nonempty.some(other => {
      const longer = comparable(other.text)
      return !garbled(other.text) && longer.length > normalized.length + 5 && longer.includes(normalized)
    })
    const glued = !/\s/u.test(c.text) && nonempty.some(other => comparable(other.text) === normalized && text(other.text).split(' ').length > 3)
    return { c, index, incomplete, value: (c.text ? 1 : 0) + (c.source === 'pdf' ? 0.3 : 0) - (garbled(c.text) ? 10 : 0) - (incomplete ? 2 : 0) - (glued ? 1 : 0) - (overlongCaption ? 3 : 0) }
  }).sort((a, b) => b.value - a.value || a.index - b.index)
  const chosen = scored[0].c
  if (block.kind === 'algorithm') {
    block.text = chosen.source === 'pdf'
      ? String(chosen.text || '').replace(/\r\n?/g, '\n').trim()
      : formatAlgorithmFallback(chosen.text)
  } else {
    block.text = text(chosen.text)
  }
  if (block.kind === 'heading') {
    // 版面模型会把加粗的段内过渡句（"could be formulated as:"）标成 paragraph_title：
    // 小写开头、冒号/分号/逗号结尾或过长的都不是章节标题，降回正文免得污染目录。
    if (block.label === 'paragraph_title' &&
      (block.text === '' || /^[a-z]/.test(block.text) || /[:：,，;；]$/.test(block.text) || block.text.length > 120)) {
      block.kind = 'body'
      block.level = 0
    } else {
      // 必须在选中文字之后再算层级：makeBlock 阶段 text 还是空的，正则永远不命中
      const match = /^\s*(\d+(?:\.\d+){0,3})\.?\s+\S/.exec(block.text || '')
      block.level = match ? match[1].split('.').length : 1
    }
  }
  block.selectedSource = chosen.source
  block.selectionReason = scored.some(s => s.incomplete) ? 'more-complete-candidate' : chosen.source === 'pdf' ? 'readable-pdf-text' : 'best-readable-model-candidate'
  block.sourceHash = hash(block.kind === 'algorithm' ? block.text : text(chosen.text))
  if (nonempty.some(c => garbled(c.text))) issue(block, 'garbled-candidate')
  if (nonempty.some(c => comparable(c.text) !== comparable(chosen.text))) issue(block, 'text-conflict')
  if (!isVisual(block) && block.kind !== 'algorithm' && block.label !== 'formula_number' && !nonempty.some(c => c.source === 'pdf')) issue(block, 'unverified-model-text')
  if (!isVisual(block) && block.label !== 'formula_number' && !block.text) issue(block, 'empty-text')
  block.quality = quality(block.quality.issues)
}

function formatAlgorithmFallback(raw) {
  let out = String(raw ?? '').normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if (!out) return ''
  if (out.includes('\n')) {
    return out.split('\n').map(l => l.replace(/\s+$/g, '')).filter(Boolean).join('\n')
  }
  out = out
    .replace(/\s+(?=(?:Hyperparam|Input|Output|Require|Ensure):)/g, '\n')
    .replace(/\s+(?=(?:def\s+[A-Za-z_]|for\s+[^\n]{1,40}\bdo\b|if\s+[^\n]{1,40}\bthen\b|else\b|return\s))/g, '\n')
  return out.trim()
}

function formatAlgorithmLines(lines) {
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const line of sorted) {
    const h = Math.max(6, Number(line.height) || (Number(line.y2) - Number(line.y)) || 10)
    const lx0 = Number(line.x) || 0
    const lx1 = Number(line.x2 ?? (lx0 + Number(line.width || 0))) || lx0
    const ly0 = Number(line.y) || 0
    const ly1 = Number(line.y2 ?? (ly0 + h)) || (ly0 + h)
    const prev = rows.at(-1)
    if (prev) {
      const ph = Math.max(6, prev.y1 - prev.y0)
      const overlapY = Math.min(prev.y1, ly1) - Math.max(prev.y0, ly0)
      if (overlapY / Math.min(ph, h) >= 0.45 && lx0 >= prev.x1 - 8 && lx0 - prev.x1 <= 36) {
        const sep = lx0 - prev.x1 >= 1.6 && !prev.text.endsWith('-') ? ' ' : ''
        prev.text = prev.text + sep + text(line.text)
        prev.x1 = Math.max(prev.x1, lx1)
        prev.y0 = Math.min(prev.y0, ly0)
        prev.y1 = Math.max(prev.y1, ly1)
        continue
      }
    }
    rows.push({ x0: lx0, x1: lx1, y0: ly0, y1: ly1, text: text(line.text) })
  }
  const nonEmpty = rows.filter(r => r.text)
  if (!nonEmpty.length) return ''
  const minX = Math.min(...nonEmpty.map(r => r.x0))
  return nonEmpty.map(r => {
    const steps = Math.max(0, Math.min(6, Math.round((r.x0 - minX) / 14)))
    return '  '.repeat(steps) + r.text
  }).join('\n')
}

export function tidyFormulaLatex(raw) {
  let out = String(raw ?? '').normalize('NFC').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  out = out.replace(/^\\\[|\\\]$/g, '').replace(/^\$\$?|\$\$?$/g, '')
  out = out.replace(/\\begin\{(?:equation|align)\*?\}/g, '').replace(/\\end\{(?:equation|align)\*?\}/g, '')
  out = out.replace(/\\(mathtt|mathsf|mathrm|mathbf|operatorname|text)\{([^{}\\]+)\}/g, (full, cmd, inner) => {
    const trimmed = inner.trim()
    if (!trimmed.includes(' ')) return full
    // 把 PP-StructureV3 在运算符/等幅词内部插入的单字母空格还原（\mathtt{R E T R O} / \operatorname{s o f t m a x}）
    return '\\' + cmd + '{' + trimmed.replace(/\b([A-Za-z](?:\s+[A-Za-z])+)\b/g, seg => {
      const letters = seg.split(/\s+/)
      const shouldCompact = letters.length >= 3 || cmd === 'operatorname' || letters.every(ch => ch >= 'A' && ch <= 'Z')
      return shouldCompact ? letters.join('') : seg
    }) + '}'
  })
  return out.replace(/\s+\n\s+/g, '\n').trim()
}

const STRUCTURED_LATEX_RE = /\\[A-Za-z]+|[_^{}]/
const FORMULA_PROSE_RE = /\b(the|and|with|for|is|are|was|were|of|to|in|on|we|our|this|that|these|those|however|noted|since|because|although|while|where|leads|performance|compared|model|assumption|inferior)\b/i

function looksLikeProseLine(value) {
  const s = text(value)
  if (!s) return false
  if (FORMULA_PROSE_RE.test(s)) return true
  const longWords = s.split(/\s+/).filter(w => /^[A-Za-z]{4,}$/.test(w)).length
  return longWords >= 3 && !/[=≜<>≤≥∑∫]/.test(s)
}

function transformRect(bbox, matrix) {
  if (!validRect(bbox) || !matrix) return { ...bbox }
  const [a, b, c, d, e, f] = matrix
  const corners = [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x, bbox.y + bbox.height], [bbox.x + bbox.width, bbox.y + bbox.height]]
    .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f])
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1])
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

function medianNum(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 早期上传未关闭 PP-StructureV3 的 UVDoc 曲面矫正（use_doc_unwarping: true），
 * 导致平坦电子 PDF 的服务框整体出现 12~45pt 拉伸或平移偏移。利用页内高置信文字锚点
 * 自动拟合页面级仿射缩放+平移矩阵，仅在残差明显改善时应用。
 */
function refineUnwarpedMatrix(baseMatrix, serviceBlocks, pdfLines, preprocessing) {
  const unwarped = preprocessing?.model_settings?.use_doc_unwarping === true
  if (!unwarped || !Array.isArray(serviceBlocks) || !Array.isArray(pdfLines) || pdfLines.length < 4) return baseMatrix
  const lines = pdfLines.map(l => ({ bbox: rect(l), key: comparable(l.text) })).filter(l => validRect(l.bbox) && l.key.length >= 10)
  if (!lines.length) return baseMatrix
  const pairs = []
  for (const raw of serviceBlocks) {
    const label = String(raw?.block_label ?? raw?.label ?? '').trim().toLowerCase()
    if (!['paragraph_title', 'doc_title', 'figure_title', 'table_title', 'text', 'caption'].includes(label)) continue
    const box = transformRect(rect(raw.block_bbox ?? raw.bbox), baseMatrix)
    if (!validRect(box) || box.height > 42) continue
    const key = comparable(raw.block_content ?? raw.text ?? '')
    if (key.length < 10) continue
    const matches = lines.filter(l => {
      const sim = l.key === key ? 1 : (l.key.includes(key) || key.includes(l.key)) ? Math.min(l.key.length, key.length) / Math.max(l.key.length, key.length) : similarity(l.key, key)
      return sim >= 0.84 && Math.abs((l.bbox.y + l.bbox.height / 2) - (box.y + box.height / 2)) <= 65
    })
    if (matches.length !== 1) continue
    pairs.push({
      sx: box.x + box.width / 2,
      px: matches[0].bbox.x + matches[0].bbox.width / 2,
      sy: box.y + box.height / 2,
      py: matches[0].bbox.y + matches[0].bbox.height / 2,
    })
  }
  if (pairs.length < 2) return baseMatrix
  const rawErr = medianNum(pairs.map(p => Math.abs(p.py - p.sy)))
  if (rawErr < 6) return baseMatrix
  const ySpan = Math.max(...pairs.map(p => p.sy)) - Math.min(...pairs.map(p => p.sy))
  let ay = 1, ty = medianNum(pairs.map(p => p.py - p.sy))
  if (ySpan >= 100 && pairs.length >= 3) {
    const myS = pairs.reduce((s, p) => s + p.sy, 0) / pairs.length
    const myP = pairs.reduce((s, p) => s + p.py, 0) / pairs.length
    const num = pairs.reduce((s, p) => s + (p.sy - myS) * (p.py - myP), 0)
    const den = pairs.reduce((s, p) => s + (p.sy - myS) ** 2, 0)
    const slope = den > 1 ? num / den : 1
    if (slope >= 0.82 && slope <= 1.2) {
      ay = slope
      ty = myP - ay * myS
    }
  }
  const fittedErr = medianNum(pairs.map(p => Math.abs(p.py - (ay * p.sy + ty))))
  if (fittedErr >= rawErr * 0.65 || fittedErr > 9) return baseMatrix
  const txCandidate = medianNum(pairs.map(p => p.px - p.sx))
  const rawErrX = medianNum(pairs.map(p => Math.abs(p.px - p.sx)))
  const tx = Math.abs(txCandidate) >= 4 && Math.abs(txCandidate) <= 40 && rawErrX >= 4 ? txCandidate : 0
  const [a, b, c, d, e, f] = baseMatrix
  return [a, b, c, d * ay, e + tx, f * ay + ty]
}

function coordinateTransform(page, data, source, pdfData = null) {
  if (!data) return { matrix: null, status: 'absent' }
  if (source === 'pdf') {
    // page_lines already returns rendered coordinates; nativeToRendered is evidence only.
    const known = [page.width, page.height].every(v => Number.isFinite(v) && v > 0) &&
      (!data.width || Math.abs(data.width - page.width) < 0.1) && (!data.height || Math.abs(data.height - page.height) < 0.1)
    if (!known) page.quality.issues.push(locatedIssue('unknown-coordinate-transform', page.n, null, source))
    return { matrix: known ? [1, 0, 0, 1, 0, 0] : null, status: known ? 'known' : 'unknown', coordinateSpace: 'rendered' }
  }
  const w = data.width ?? (source === 'pdf' ? page.width : null)
  const h = data.height ?? (source === 'pdf' ? page.height : null)
  const preprocessing = data.raw?.prunedResult?.doc_preprocessor_res ?? data.raw?.doc_preprocessor_res
  const angle = data.rotation ?? preprocessing?.angle ?? 0
  const explicit = data.nativeToRendered?.matrix ?? data.nativeToRendered
  let matrix = null
  if (explicit !== undefined) {
    if (Array.isArray(explicit) && explicit.length === 6 && explicit.every(Number.isFinite) && Math.abs(explicit[0] * explicit[3] - explicit[1] * explicit[2]) > 1e-9) matrix = explicit.slice()
  } else if ([w, h, page.width, page.height].every(v => Number.isFinite(v) && v > 0) && angle === 0 && Math.abs((w / h) / (page.width / page.height) - 1) <= 0.02) {
    matrix = refineUnwarpedMatrix([page.width / w, 0, 0, page.height / h, 0, 0], data.blocks, pdfData?.lines, preprocessing)
  }
  if (!matrix) page.quality.issues.push(locatedIssue('unknown-coordinate-transform', page.n, null, source))
  return { matrix, status: matrix ? 'known' : 'unknown', from: { width: w ?? null, height: h ?? null, rotation: angle }, to: { width: page.width, height: page.height } }
}

function makeBlock(raw, page, source, sourcePage, sha256) {
  const rawBBox = rect(raw.block_bbox ?? raw.bbox)
  const mapping = page.transforms?.[source]
  const geometryTrusted = validRect(rawBBox) && mapping?.status !== 'unknown'
  const transformed = transformRect(rawBBox, mapping?.matrix)
  const bbox = validRect(transformed) && mapping?.status !== 'unknown' ? transformed : { x: 0, y: 0, width: 0, height: 0 }
  const label = String(raw.block_label ?? raw.label ?? '').trim().toLowerCase()
  const blockId = 'b-' + hash([sha256, page.n, raw.block_id ?? { bbox, label }]).slice(0, 24)
  const value = raw.block_content ?? raw.text ?? ''
  const score = raw.score ?? raw.block_score ?? raw.confidence
  const block = { page: page.n, pageId: page.pageId, blockId, order: 0, kind: kinds[label] || 'body', label, bbox, rawBBox, geometryTrusted,
    sourceOrder: Number.isFinite(raw.block_order ?? raw.order) ? raw.block_order ?? raw.order : null,
    sourceBlocks: [{ source, id: raw.block_id ?? null, order: raw.block_order ?? raw.order ?? null, bbox: { ...rawBBox }, rawRef: sourcePage?.rawRef ?? null }],
    candidates: [{ source, text: String(value), score: Number.isFinite(score) ? score : null, rawRef: sourcePage?.rawRef ?? null }],
    fragments: [{ page: page.n, bbox: { ...bbox }, lineIds: [] }], sourceBlockIds: raw.block_id === undefined ? [] : [raw.block_id], quality: quality([]) }
  if (!geometryTrusted) issue(block, validRect(rawBBox) ? 'unknown-coordinate-transform' : 'invalid-block-bbox')
  if (!kinds[label] && !decorations.has(label)) issue(block, 'unknown-label', label)
  if (block.kind === 'table') {
    block.html = String(raw.html ?? value)
    if (raw.table !== undefined) block.table = structuredClone(raw.table)
    if (raw.cells !== undefined) block.cells = structuredClone(raw.cells)
  }
  if (block.kind === 'formula') block.latex = tidyFormulaLatex(raw.latex ?? value)
  return block
}

function modelBlocks(page, service, supplementary, sha256) {
  const blocks = list(service?.blocks).map(raw => makeBlock(raw, page, 'service', service, sha256)).sort(compareBlocks)
  const supplement = list(supplementary?.blocks).map(raw => makeBlock(raw, page, 'vl', supplementary, sha256)).sort(compareBlocks)
  // Pair source candidates globally before assigning any PDF lines. No first-block wins.
  const sameFamily = (b, vl) => b.kind === vl.kind && (b.kind !== 'caption' || b.label === vl.label)
  const pairs = supplement.flatMap(vl => blocks.filter(b => sameFamily(b, vl) && b.geometryTrusted && vl.geometryTrusted && iou(b.bbox, vl.bbox) >= 0.45).map(b => ({ b, vl, score: iou(b.bbox, vl.bbox) + 0.2 * similarity(b.candidates[0].text, vl.candidates[0].text) })))
    .sort((a, b) => b.score - a.score || a.b.blockId.localeCompare(b.b.blockId) || a.vl.blockId.localeCompare(b.vl.blockId))
  const paired = new Set(), used = new Set()
  for (const pair of pairs) {
    if (paired.has(pair.vl) || used.has(pair.b)) continue
    pair.b.candidates.push(...pair.vl.candidates)
    pair.b.sourceBlocks.push(...pair.vl.sourceBlocks)
    pair.b.quality.issues.push(...pair.vl.quality.issues.map(i => ({ ...i, blockId: pair.b.blockId })))
    pair.b.sourceBlockIds.push(...pair.vl.sourceBlockIds.filter(id => !pair.b.sourceBlockIds.includes(id)))
    paired.add(pair.vl); used.add(pair.b)
  }
  return [...blocks, ...supplement.filter(b => !paired.has(b))].sort(compareBlocks)
}

function assignLines(page, blocks, pdf, sha256) {
  const owned = new Map(blocks.map(b => [b, []]))
  const lines = list(pdf?.lines).map((l, i) => ({ ...l, bbox: transformRect(rect(l), page.transforms.pdf.matrix), lineId: page.pageId + '-l' + (i + 1) }))
  for (const line of lines) {
    const ranked = blocks.filter(b => b.geometryTrusted && page.transforms.pdf.status !== 'unknown').map(block => {
      const overlap = intersection(block.bbox, line.bbox) / Math.max(1, area(line.bbox))
      const agreement = Math.max(0, ...block.candidates.map(c => similarity(c.text, line.text)))
      return { block, overlap, agreement, score: overlap * 0.45 + agreement * 0.55 + (isVisual(block) && overlap >= 0.9 ? 0.4 : 0) }
    }).filter(c => c.overlap >= 0.5).sort((a, b) => b.score - a.score || area(a.block.bbox) - area(b.block.bbox) || a.block.blockId.localeCompare(b.block.blockId))
    if (ranked.length > 1 && Math.abs(ranked[0].score - ranked[1].score) < 1e-9) {
      issue(ranked[0].block, 'ambiguous-line-owner', line.lineId)
    }
    let owner = ranked[0]?.block
    if (!owner) {
      // 服务模型的块框经常从第二行开始（第一行被算进上一个块或留白），
      // PDF 行贴在图/表/正文块上方十几 pt 时不能直接丢成孤立块。
      // 只接受「文字高度相似 + 水平对齐 + 垂直距离很小」的块，避免把图内标签救回正文。
      const lineCenterY = line.bbox.y + line.bbox.height / 2
      const rescued = blocks
        .filter(b => b.geometryTrusted && !isVisual(b) && b.kind !== 'caption' && b.kind !== 'formula' && b.label !== 'formula_number')
        .map(b => {
          const gap = Math.max(0, b.bbox.y - (line.bbox.y + line.bbox.height), line.bbox.y - (b.bbox.y + b.bbox.height))
          const horizontal = Math.max(0, Math.min(b.bbox.x + b.bbox.width, line.bbox.x + line.bbox.width) - Math.max(b.bbox.x, line.bbox.x)) / Math.max(1, line.bbox.width)
          const agreement = Math.max(0, ...b.candidates.map(c => similarity(c.text, line.text)))
          const centerDistance = Math.abs((b.bbox.y + b.bbox.height / 2) - lineCenterY)
          return { b, gap, horizontal, agreement, centerDistance, score: agreement - gap / 100 - centerDistance / 500 }
        })
        .filter(c => c.gap <= 28 && c.horizontal >= 0.6 && c.agreement >= 0.55)
        .sort((a, b) => b.score - a.score || a.b.blockId.localeCompare(b.b.blockId))
      if (rescued.length) {
        owner = rescued[0].b
        page.quality.issues.push(locatedIssue('rescued-pdf-line', page.n, owner.blockId, line.lineId))
      }
    }
    if (!owner) {
      // 图/表内部的坐标轴、图例、行标签经常在服务块框之外；
      // 先挂到最近的图/表块上（不进入正文），不要把图内文字变成独立段落。
      const lineCenterY = line.bbox.y + line.bbox.height / 2
      const labelLike = text(line.text).length <= 48 && !/[.!?。！？]$/u.test(text(line.text))
      const visual = blocks
        .filter(b => labelLike && isVisual(b) && b.geometryTrusted)
        .map(b => {
          const gap = Math.max(0, b.bbox.y - (line.bbox.y + line.bbox.height), line.bbox.y - (b.bbox.y + b.bbox.height))
          const horizontal = Math.max(0, Math.min(b.bbox.x + b.bbox.width, line.bbox.x + line.bbox.width) - Math.max(b.bbox.x, line.bbox.x)) / Math.max(1, line.bbox.width)
          return { b, gap, horizontal }
        })
        .filter(c => c.gap <= 24 && c.horizontal >= 0.7)
        .sort((a, b) => a.gap - b.gap || b.horizontal - a.horizontal || a.b.blockId.localeCompare(b.b.blockId))
      if (visual.length) owner = visual[0].b
    }
    if (!owner) {
      owner = makeBlock({ block_label: 'text', bbox: line.bbox, block_content: '' }, page, 'pdf', null, sha256)
      owner.bbox = validRect(line.bbox) ? { ...line.bbox } : { x: 0, y: 0, width: 0, height: 0 }
      owner.fragments[0].bbox = { ...owner.bbox }
      owner.blockId = 'b-' + hash([sha256, page.n, 'pdf-line', validRect(line.bbox) ? line.bbox : line.lineId]).slice(0, 24)
      owner.candidates = []
      owner.sourceBlockIds = []
      owner.quality.issues = []
      issue(owner, 'unmatched-pdf-line')
      if (!validRect(line.bbox)) issue(owner, 'invalid-line-bbox')
      if (page.transforms.pdf.status === 'unknown') issue(owner, 'unknown-coordinate-transform')
      blocks.push(owner); owned.set(owner, [])
    }
    owned.get(owner).push(line)
    const role = isVisual(owner) ? owner.kind + '-internal' : 'text'
    page.lineAssignments.push({ lineId: line.lineId, blockId: owner.blockId, role, text: text(line.text), bbox: { ...line.bbox }, candidates: ranked.map(c => ({ blockId: c.block.blockId, geometry: c.overlap, agreement: c.agreement, score: c.score })) })
  }
  const tocContext = blocks.some(b => b.candidates.some(c => /^(?:contents|table of contents|目\s*录)\s*$/i.test(text(c.text))))
  const tocBlocks = new Map()
  for (const block of blocks) {
    const lines = owned.get(block).sort((a, b) => a.y - b.y || a.x - b.x)
    const tocRows = tocRowsForBlock(block, lines, tocContext)
    if (tocRows) tocBlocks.set(block, tocRows)
    block.fragments[0].lineIds = lines.map(l => l.lineId)
    if (lines.length) {
      const pdfJoined = block.kind === 'algorithm' ? formatAlgorithmLines(lines) : joinLines(lines.map(l => l.text))
      block.candidates.push({ source: 'pdf', text: pdfJoined, score: null, lineIds: lines.map(l => l.lineId) })
    }
    choose(block)
    if (block.kind === 'formula') {
      const pdfCandidate = block.candidates.filter(c => c.source === 'pdf').at(-1)
      const pdfLatex = pdfCandidate ? text(pdfCandidate.text).replace(/^\$+|\$+$/g, '') : ''
      if (pdfLatex && mathText(pdfLatex) !== mathText(block.latex || '')) {
        issue(block, 'formula-text-conflict')
        const hasStructuredLatex = STRUCTURED_LATEX_RE.test(block.latex || '')
        const pdfHasLatex = STRUCTURED_LATEX_RE.test(pdfLatex)
        if (!looksLikeProseLine(pdfLatex) && (!block.latex || garbled(block.latex) || !hasStructuredLatex || pdfHasLatex)) {
          block.latex = tidyFormulaLatex(pdfLatex)
          block.selectedSource = 'pdf'
        }
      }
    }
    if (block.kind === 'figure') block.text = ''
  }
  // 目录条目是原生块：每条有稳定身份，PDF 行仍恰好归属一次；保留原候选以便审计。
  const entries = blocks.flatMap(block => {
    const rows = tocBlocks.get(block)
    if (!rows) return [block]
    return rows.map((row, index) => {
      const entry = { ...block, kind: 'list', role: 'toc-entry', tocLevel: row.tocLevel,
        ...(row.tocTargetPage !== undefined ? { tocTargetPage: row.tocTargetPage } : {}),
        parentBlockId: block.blockId, blockId: 'b-' + hash([block.blockId, 'toc-entry', index]).slice(0, 24),
        sourceOrder: (block.sourceOrder ?? block.bbox.y) + index / (rows.length + 1), bbox: { ...row.bbox },
        text: row.text, sourceHash: hash(text(row.text)), selectedSource: row.source || (owned.get(block).length ? 'pdf' : block.selectedSource),
        selectionReason: row.source && row.source !== 'pdf' ? 'toc-model-line-without-pdf' : owned.get(block).length ? 'toc-pdf-lines-preserved' : 'toc-model-lines-preserved',
        fragments: [{ page: page.n, bbox: { ...row.bbox }, lineIds: row.lineIds }],
        quality: quality(block.quality.issues.map(i => ({ ...i }))) }
      if (row.source && row.source !== 'pdf') {
        entry.geometryTrusted = false
        issue(entry, 'unverified-model-text')
      }
      entry.quality.issues.forEach(i => { i.blockId = entry.blockId })
      for (const assignment of page.lineAssignments.filter(a => row.lineIds.includes(a.lineId))) {
        assignment.sourceBlockId = block.blockId
        assignment.blockId = entry.blockId
        assignment.role = 'toc-entry'
      }
      return entry
    })
  })
  blocks.splice(0, blocks.length, ...entries)
  return lines.length
}

const horizontalCoverage = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) / Math.max(1, Math.min(a.width, b.width))
const mathText = value => text(value).replace(/^\$+|\$+$/g, '').replace(/\\(?:left|right)\b/g, '').replace(/\s+/g, '')
const union = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) })

const EQ_NUM_RE = /^\(\s*(\d+(?:\.\d+)?[a-z]?|[ivxlcdm]+)\s*\)$/i
const TRAILING_EQ_NUM_RE = /\(\s*(\d+(?:\.\d+)?[a-z]?)\s*\)\s*$/i

function stripLatexCommands(raw) {
  return text(raw)
    .replace(/^\$+|\$+$/g, '')
    .replace(/\\(?:triangleq|stackrel\{?\s*\\triangle\s*\}?\{?=?\})/g, '≜')
    .replace(/\\(?:leqslant|leq|le)\b/g, '≤')
    .replace(/\\(?:geqslant|geq|ge)\b/g, '≥')
    .replace(/\\(?:approx)\b/g, '≈')
    .replace(/\\(?:in)\b/g, '∈')
    .replace(/\\(?:times)\b/g, '×')
    .replace(/\\(?:mid)\b/g, '|')
    .replace(/\\(?:sum)\b/g, '∑')
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '')
    .replace(/\\(?:mathtt|mathsf|mathrm|mathbf|mathcal|mathbb|operatorname|text)\{([^{}]*)\}/g, '$1')
    .replace(/\\[A-Za-z]+/g, '')
    .replace(/[{}_^]/g, '')
    .replace(/\u2212/g, '-')
}

function opSignature(value) {
  const s = stripLatexCommands(value).replace(TRAILING_EQ_NUM_RE, '')
  return new Set((s.match(/[+\-=≜<>≤≥≈×÷]/g) || []))
}

function isDuplicateFormulaBody(body, formula) {
  if (!formula || formula.kind !== 'formula' || !formula.geometryTrusted || !body.geometryTrusted) return false
  if (horizontalCoverage(body.bbox, formula.bbox) < 0.65) return false
  const bodyMid = body.bbox.y + body.bbox.height / 2
  const formMid = formula.bbox.y + formula.bbox.height / 2
  if (Math.abs(bodyMid - formMid) > Math.max(24, body.bbox.height + formula.bbox.height)) return false
  const rawBody = text(body.text)
  const rawFormula = formula.latex || formula.text || ''
  if (!/[=≜+\-∑∫√≤≥]/u.test(rawBody)) return false
  if (mathText(rawBody) === mathText(rawFormula)) return horizontalCoverage(body.bbox, formula.bbox) >= 0.85
  // 无主 PDF 行 / 非散文的紧邻公式行：算子不能冲突，且字母数字骨架高度被公式包含
  if (looksLikeProseLine(rawBody) || /[.!?。！？;；]$/.test(rawBody)) return false
  const cleanedBody = rawBody.replace(TRAILING_EQ_NUM_RE, '').trim()
  const bodyOps = opSignature(cleanedBody)
  const formOps = opSignature(rawFormula)
  if (!bodyOps.size || ![...bodyOps].every(op => formOps.has(op))) return false
  const bNorm = comparable(stripLatexCommands(cleanedBody))
  const fNorm = comparable(stripLatexCommands(rawFormula))
  if (bNorm.length < 3 || fNorm.length < 3) return false
  const fBag = new Map()
  for (const ch of fNorm) fBag.set(ch, (fBag.get(ch) || 0) + 1)
  let hit = 0
  for (const ch of bNorm) {
    const left = fBag.get(ch) || 0
    if (left > 0) { hit += 1; fBag.set(ch, left - 1) }
  }
  return hit / bNorm.length >= 0.78 && Math.abs(bNorm.length - fNorm.length) <= Math.max(12, Math.max(bNorm.length, fNorm.length) * 0.55)
}

// One cleanup pass before publishing IDs/order. Exclusions retain the original IR.
function cleanPage(blocks, page, excluded, sha256) {
  const dropped = new Set()
  const formulas = blocks.filter(b => b.kind === 'formula')
  // 1) formula_number 块或孤立 "(2)" 行绑定到同基线公式块，不再作为孤立段落出现
  for (const block of blocks) {
    const isNumLabel = block.label === 'formula_number' || block.kind === 'formula_number'
    const raw = text(block.text)
    const isOrphanEqNum = block.sourceBlockIds.length === 0 && EQ_NUM_RE.test(raw)
    if (!isNumLabel && !isOrphanEqNum) continue
    const blockMid = block.bbox.y + block.bbox.height / 2
    const target = formulas
      .filter(f => f.geometryTrusted && block.geometryTrusted && Math.abs((f.bbox.y + f.bbox.height / 2) - blockMid) <= Math.max(20, f.bbox.height * 1.25))
      .sort((a, b) => Math.abs((a.bbox.y + a.bbox.height / 2) - blockMid) - Math.abs((b.bbox.y + b.bbox.height / 2) - blockMid))[0] || null
    if (target && raw) {
      target.equationNumber = target.equationNumber ? `${target.equationNumber} ${raw}` : raw
    }
    if (isOrphanEqNum) {
      block.quality.issues = block.quality.issues.filter(i => i.code !== 'unmatched-pdf-line')
    }
    dropped.add(block)
    excluded.push({ reason: 'formula-number', page: page.n, blockId: block.blockId, duplicateOf: target ? target.blockId : null, block: structuredClone(block) })
    for (const assignment of page.lineAssignments.filter(a => a.blockId === block.blockId)) {
      Object.assign(assignment, { excluded: true, reason: 'formula-number', ...(target ? { duplicateOf: target.blockId } : {}) })
    }
  }
  for (const body of blocks.filter(b => b.kind === 'body' && !decorations.has(b.label) && !dropped.has(b))) {
    const formula = formulas.find(f => isDuplicateFormulaBody(body, f))
    if (formula) {
      const m = TRAILING_EQ_NUM_RE.exec(text(body.text))
      if (m && !formula.equationNumber) formula.equationNumber = '(' + m[1] + ')'
      dropped.add(body)
      excluded.push({ reason: 'duplicate-formula', page: page.n, blockId: body.blockId, duplicateOf: formula.blockId, block: structuredClone(body) })
      for (const assignment of page.lineAssignments.filter(a => a.blockId === body.blockId)) Object.assign(assignment, { excluded: true, reason: 'duplicate-formula', duplicateOf: formula.blockId })
    }
  }
  const retained = []
  for (const block of blocks.filter(b => !dropped.has(b)).sort(compareBlocks)) {
    const prev = retained.at(-1)
    const last = prev?.fragments.at(-1)?.bbox
    const gap = last ? block.bbox.y - last.y - last.height : -1
    // Hyphenated continuation is positive text evidence; mere proximity is not.
    const canJoin = prev && prev.kind === 'body' && block.kind === 'body' && kinds[prev.label] && kinds[block.label] && prev.geometryTrusted && block.geometryTrusted &&
      /[\p{L}]-$/u.test(prev.text) && /^\p{Ll}/u.test(block.text) && gap >= 0 && gap <= Math.max(8, last.height) &&
      horizontalCoverage(last, block.bbox) >= 0.9 && Math.abs(last.x - block.bbox.x) <= 5
    if (!canJoin) { retained.push(block); continue }
    const oldIds = [prev.blockId, block.blockId]
    prev.mergedBlockIds = [...(prev.mergedBlockIds || [prev.blockId]), ...(block.mergedBlockIds || [block.blockId])]
    prev.blockId = 'b-' + hash([sha256, page.n, 'merge', prev.mergedBlockIds]).slice(0, 24)
    prev.text += block.text
    prev.sourceHash = hash(text(prev.text))
    if (prev.selectedSource !== block.selectedSource) prev.selectedSource = 'mixed'
    prev.selectionReason = 'content-supported-hyphen-continuation'
    prev.bbox = union(prev.bbox, block.bbox)
    prev.fragments.push(...block.fragments)
    prev.candidates.push(...block.candidates)
    prev.sourceBlocks.push(...block.sourceBlocks)
    prev.sourceBlockIds = [...new Set([...prev.sourceBlockIds, ...block.sourceBlockIds])]
    prev.quality = quality([...prev.quality.issues, ...block.quality.issues].map(i => ({ ...i, blockId: prev.blockId })))
    for (const assignment of page.lineAssignments.filter(a => oldIds.includes(a.blockId))) {
      assignment.sourceBlockId = assignment.blockId
      assignment.blockId = prev.blockId
    }
  }
  return retained
}

function captionMarker(value) {
  const match = /\b(fig(?:ure)?\.?|table)\s*(\d+)(?:\s*\(([a-z])\))?/iu.exec(text(value)) || /([图表])\s*(\d+)(?:\s*\(([a-z])\))?/u.exec(text(value))
  return match ? { kind: /^(?:table|表)$/i.test(match[1]) ? 'table' : 'figure', number: match[2], panel: match[3] || null } : null
}

function linkFigures(blocks, source) {
  const visuals = blocks.filter(isVisual)
  const figures = visuals.map(block => {
    const index = visuals.indexOf(block)
    block.figureIndex = index
    return { index, page: block.page, kind: block.kind, label: block.label, bbox: { ...block.bbox }, caption: '', captionOrder: null,
      blockIndex: block.order, assetId: 'a-' + hash([source.sha256, block.page, block.bbox, BUILD]).slice(0, 24), blockId: block.blockId, captionBlockIds: [] }
  })
  for (const caption of blocks.filter(b => b.kind === 'caption')) {
    const marker = captionMarker(caption.text)
    const kind = caption.label === 'table_title' ? 'table' : caption.label === 'figure_title' ? 'figure' : marker?.kind
    if (marker && marker.kind !== kind) { issue(caption, 'caption-type-conflict'); continue }
    const ranked = visuals.filter(b => b.page === caption.page && b.kind === kind && b.geometryTrusted && caption.geometryTrusted).map(block => {
      const assetMarker = block.candidates.map(c => captionMarker(c.text)).find(Boolean)
      const horizontal = horizontalCoverage(caption.bbox, block.bbox)
      const gap = caption.bbox.y >= block.bbox.y + block.bbox.height ? caption.bbox.y - block.bbox.y - block.bbox.height
        : block.bbox.y >= caption.bbox.y + caption.bbox.height ? block.bbox.y - caption.bbox.y - caption.bbox.height : -1
      const direction = kind === 'table' ? caption.bbox.y < block.bbox.y : caption.bbox.y > block.bbox.y
      return { block, assetMarker, horizontal, gap, score: (marker && assetMarker?.number === marker.number ? 2 : 0) + horizontal - gap / 100 + (direction ? 0.1 : 0) - Math.abs(caption.order - block.order) * 0.001 }
    }).filter(p => p.horizontal >= 0.5 && p.gap >= 0 && p.gap <= 80 && (!marker || !p.assetMarker || marker.number === p.assetMarker.number))
      .sort((a, b) => b.score - a.score || a.block.blockId.localeCompare(b.block.blockId))
    if (!ranked.length) { issue(caption, 'unlinked-caption'); continue }
    const subfigureEvidence = marker && /\([a-z]\).*\([a-z]\)/iu.test(caption.text)
    const panels = subfigureEvidence ? ranked.filter(p => p.assetMarker?.number === marker.number && p.assetMarker?.panel && caption.text.includes('(' + p.assetMarker.panel + ')')) : []
    const canGroup = panels.length > 1 && new Set(panels.map(p => p.assetMarker.panel)).size === panels.length &&
      Math.max(...panels.map(p => p.block.bbox.y)) - Math.min(...panels.map(p => p.block.bbox.y)) <= 20
    if (!canGroup && ranked[1] && ranked[0].score - ranked[1].score < 0.15) { issue(caption, 'ambiguous-caption'); continue }
    const selected = canGroup ? panels : [ranked[0]]
    caption.figureIndices = selected.map(p => p.block.figureIndex)
    for (const match of selected) {
      const figure = figures[match.block.figureIndex]
      figure.captionBlockIds.push(caption.blockId)
      figure.caption = [figure.caption, caption.text].filter(Boolean).join(' ')
      figure.captionOrder ??= caption.order
    }
  }
  for (const visual of visuals) if (!figures[visual.figureIndex].captionBlockIds.length) issue(visual, 'unlinked-asset')
  return figures
}

/** Build all declared pages without I/O, mutable globals, timestamps or random IDs. */
export function buildDocumentLayout(input) {
  if (!input?.source?.sha256 || typeof input.source.sha256 !== 'string') throw new TypeError('source.sha256 is required')
  const source = structuredClone(input.source)
  const blocks = [], pages = [], figures = [], excluded = []
  let pdfLines = 0
  if (input.pageCount !== undefined && (!Number.isInteger(input.pageCount) || input.pageCount < 0)) throw new TypeError('pageCount must be a non-negative integer')
  const pageCount = input.pageCount || Math.max(0, ...list(input.pageSizes).map(p => p.n), ...list(input.servicePages).map(p => p.n), ...list(input.pdfPages).map(p => p.page))
  for (let n = 1; n <= pageCount; n++) {
    const service = list(input.servicePages).find(p => p.n === n)
    const supplementary = list(input.supplementaryPages).find(p => p.n === n)
    const pdf = list(input.pdfPages).find(p => p.page === n)
    const size = list(input.pageSizes).find(p => p.n === n)
    const pageId = 'p-' + hash([source.sha256, n]).slice(0, 24)
    const page = { n, pageId, width: size?.w ?? pdf?.width ?? null, height: size?.h ?? pdf?.height ?? null, rotation: size?.rotation ?? null,
      cropbox: structuredClone(size?.cropbox ?? null), nativeToRendered: structuredClone(size?.nativeToRendered ?? null),
      status: 'ready', quality: quality([]), blockIds: [], lineAssignments: [], unassignedLineIds: [] }
    page.transforms = { service: coordinateTransform(page, service, 'service', pdf), vl: coordinateTransform(page, supplementary, 'vl', pdf), pdf: coordinateTransform(page, pdf, 'pdf') }
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) page.quality.issues.push(locatedIssue('missing-page-dimensions', n))
    const missing = !service && !supplementary && !pdf
    if (!service && !supplementary) page.quality.issues.push(locatedIssue('missing-layout-page', n))
    if (missing) page.quality.issues.push(locatedIssue('missing-page', n))
    if (pdf?.error) page.quality.issues.push(locatedIssue('pdf-extraction-error', n, null, String(pdf.error)))
    if (service?.status && !['ready', 'completed', 'succeeded'].includes(service.status)) page.quality.issues.push(locatedIssue('service-page-status', n, null, service.status))
    const serviceFailed = Boolean(service?.status && !['ready', 'completed', 'succeeded'].includes(service.status))
    if (serviceFailed && !list(pdf?.lines).length && !list(supplementary?.blocks).length) {
      page.quality.issues.push(locatedIssue('source-page-failed', n, null, String(service.status)))
      page.quality.status = 'failed'
      page.status = 'failed'
      page.fallback = { kind: 'original-page', page: n }
      pages.push(page)
      continue
    }
    const pageBlocks = modelBlocks(page, service, supplementary, source.sha256)
    pdfLines += assignLines(page, pageBlocks, pdf, source.sha256)
    for (const block of pageBlocks) {
      if (!decorations.has(block.label)) continue
      excluded.push({ reason: 'page-decoration', page: n, blockId: block.blockId, block: structuredClone(block) })
      for (const assignment of page.lineAssignments.filter(a => a.blockId === block.blockId)) Object.assign(assignment, { excluded: true, reason: 'page-decoration' })
    }
    const retained = cleanPage(pageBlocks.filter(b => !decorations.has(b.label)), page, excluded, source.sha256)
    blocks.push(...retained)
    page.blockIds = retained.map(b => b.blockId)
    page.quality = quality([...page.quality.issues, ...pageBlocks.flatMap(b => b.quality.issues)])
    page.status = missing ? 'failed' : page.quality.status === 'passed' ? 'ready' : 'needs_review'
    if (missing) page.quality.status = 'failed'
    if (page.status !== 'ready') page.fallback = { kind: 'original-page', page: n }
    pages.push(page)
  }
  blocks.forEach((b, order) => { b.order = order })
  figures.push(...linkFigures(blocks, source))
  for (const page of pages) {
    const pageBlocks = blocks.filter(b => b.page === page.n)
    for (const block of pageBlocks) block.quality = quality(block.quality.issues)
    page.quality.issues = [...new Map([...page.quality.issues, ...pageBlocks.flatMap(b => b.quality.issues)].map(i => [JSON.stringify(i), i])).values()]
    if (page.status !== 'failed') {
      page.quality = quality(page.quality.issues)
      page.status = page.quality.status === 'passed' ? 'ready' : 'needs_review'
    }
    if (page.status !== 'ready') page.fallback = { kind: 'original-page', page: page.n }
  }
  const issues = pages.flatMap(p => p.quality.issues)
  const { at, ...semanticInput } = input
  return { version: 1, schemaVersion: 2, build: BUILD, revision: hash({ build: BUILD, input: semanticInput }), at: at ?? null,
    model: input.model ?? '', jobId: input.jobId ?? '', source, pageCount, servicePages: list(input.servicePages).length,
    warnings: [], blocks, excluded, figures, pages, quality: { ...quality(issues), status: pages.some(p => p.status === 'failed') ? 'failed' : quality(issues).status,
      metrics: { pdfLines, assignedLines: pages.reduce((n, p) => n + p.lineAssignments.filter(a => !a.excluded).length, 0), excludedLines: pages.reduce((n, p) => n + p.lineAssignments.filter(a => a.excluded).length, 0), unassignedLines: 0 } },
    rawRefs: structuredClone([...new Map([...list(input.rawRefs), ...[...list(input.servicePages), ...list(input.supplementaryPages)].map(p => p.rawRef).filter(ref => ref !== undefined && ref !== null)].map(ref => [JSON.stringify(canonical(ref)), ref])).values()]) }

}
