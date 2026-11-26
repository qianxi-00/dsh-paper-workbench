/**
 * 版面模型（PaddleOCR AI Studio 的 PP-StructureV3）客户端与契约。
 *
 * 为什么需要它：PyMuPDF 的文本块在单栏论文里就是一个大 block（一章几万字），
 * 靠字号/缩进猜段落只能到「差不多」；图内文字、整页表格、双栏顺序都是猜不准的。
 * 版面模型直接给块级结果：标签、阅读顺序、bbox，表格还是 HTML、公式还是 LaTeX。
 *
 * 两条原则：
 *  1. **结构走模型、正文走文本层**：服务端的 OCR 认字有错（tokns / ReTRo[OF]），
 *     数字原生 PDF 的文本层是准的，所以每个块的文字按 bbox 从 PDF 里再抠一遍。
 *  2. **契约稳定、可离线测**：parsed → normalize 都是纯函数，网络与 Python 只在外层。
 */

import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { buildDocumentLayout, qualitySummary, tidyFormulaLatex } from './layout-ir.js'
export { qualitySummary, tidyFormulaLatex }
import { buildTableModelFromHtml } from './layout-table.js'
import { createLayoutArchive, fingerprintPdf } from './layout-archive.js'

export const LAYOUT_VERSION = 1
export const LAYOUT_FILE = 'layout.json'
// 断点：每批完成就落盘，进程被杀/客户端断开后可以接着跑（不重新上传已完成的页）
export const LAYOUT_PARTIAL = 'layout.partial.json'
/** 从 layout.json 构建文档模型/配图清单的算法版本：清理规则一改就加一，旧 doc.json 自动失效重算。 */
export const LAYOUT_BUILD = 'ir-5'
// 后台任务状态：面板轮询它显示进度，重启后据此判断「上次跑到哪、要不要续」
export const LAYOUT_JOB = 'layout.job.json'
export const LAYOUT_MODEL = 'PP-StructureV3'

/** 所有读路径（doc / figures / RPC）都从这里读：current.json 指针优先，旧 layout.json 只作只读兼容。 */
export async function readPublishedLayout(store, id) {
  return createLayoutArchive({ store }).readPublished(id)
}
export const LAYOUT_BATCH_PAGES = 50

/** 模型标签 → 段落 kind。header/footer/number 直接丢，不进正文。 */
const KIND_BY_LABEL = {
  text: 'body',
  paragraph_title: 'heading',
  doc_title: 'heading',
  figure_title: 'caption',
  table_title: 'caption',
  footnote: 'footnote',
  formula: 'formula',
  formula_number: 'formula_number',
  table: 'table',
  image: 'figure',
  chart: 'figure',
  algorithm: 'algorithm',
  reference: 'body',
  list: 'body',
  aside_text: 'body',
}

const DROP_LABELS = new Set(['header', 'footer', 'number', 'page_number', 'seal', 'abstract_title'])
const FIGURE_LABELS = new Set(['image', 'chart', 'table'])
const KEEP_EMPTY_KINDS = new Set(['figure', 'table', 'formula'])
const TEXT_LABELS = new Set(['text', 'paragraph_title', 'doc_title', 'figure_title',
  'table_title', 'footnote', 'algorithm', 'reference', 'list', 'aside_text',
  // abstract/content 是 PP-StructureV3 给摘要段的标签：漏掉它们就会把服务端 OCR
  // 的错字版（"rnibenoder"/"dctkns"）当成正文，而 PDF 文本层其实是干净的。
  'abstract', 'content'])

export function labelToKind(label) {
  const key = String(label === undefined || label === null ? '' : label).trim().toLowerCase()
  if (key === '') return null
  if (DROP_LABELS.has(key)) return null
  return KIND_BY_LABEL[key] || 'body'
}

export function isDroppedLabel(label) {
  return DROP_LABELS.has(String(label || '').trim().toLowerCase())
}

const CAPTION_LABELS = new Set(['figure_title', 'table_title'])

/** 图注/表注用版面模型给的文字：PDF 文本层在这一小块里常把图内标签一起框进来，还会截断。 */
export function isCaptionLabel(label) {
  return CAPTION_LABELS.has(String(label || '').trim().toLowerCase())
}

export function needsPdfText(label) {
  return TEXT_LABELS.has(String(label || '').trim().toLowerCase())
}

/** 标题层级：`2.1. Training` → 2；没有编号返回 null，交给上层按字号/长度判断。 */
export function headingLevel(text) {
  const match = /^\s*(\d+(?:\.\d+){0,3})\.?\s+\S/.exec(String(text || ''))
  if (!match) return null
  return match[1].split('.').length
}

/** 服务端给的公式是裸 LaTeX（可能带 $$ 或 \[ \]），统一成行间 `$$…$$` 的内层。 */
export function cleanLatex(raw) {
  let value = String(raw === undefined || raw === null ? '' : raw).trim()
  if (value === '') return ''
  value = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  value = value.replace(/^\\\[|\\\]$/g, '').replace(/^\$\$?|\$\$?$/g, '')
  value = value.replace(/\\begin\{(?:equation|align)\*?\}/g, '').replace(/\\end\{(?:equation|align)\*?\}/g, '')
  return value.replace(/\s+\n\s+/g, '\n').trim()
}

/** 表格 HTML → 纯文本（给翻译/搜索用；渲染仍用 HTML）。 */
export function htmlToText(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw)
  if (value.trim() === '') return ''
  const rows = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(value)) !== null) {
    const cells = []
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const text = cellMatch[1]
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ')
        .trim()
      cells.push(text)
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    if (cells.some(cell => cell !== '')) rows.push(cells.join(' | '))
  }
  if (rows.length > 0) return rows.join('\n')
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 版面模型给的表格 HTML → 前端能直接画的结构（行/列/单元格）。
 *
 * 为什么不把 HTML 直接塞进页面：服务端 HTML 不可信（脏标签、脚本、畸形嵌套），
 * 前端一贯用 h() 建 DOM、不用 innerHTML；转成数据既安全又能单测。
 * colspan/rowspan 保留下来，画的时候还原成属性。
 */
export function htmlToTableModel(raw, options = {}) {
  const value = String(raw === undefined || raw === null ? '' : raw)
  if (value.trim() === '') return null
  const maxRows = Math.max(1, Math.round(number(options.maxRows, 200)))
  const maxCols = Math.max(1, Math.round(number(options.maxCols, 40)))
  const rows = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(value)) !== null && rows.length < maxRows) {
    const cells = []
    const cellRe = /<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null && cells.length < maxCols) {
      const attrs = cellMatch[2] || ''
      const text = decodeCellText(cellMatch[3])
      cells.push({
        text,
        header: cellMatch[1].toLowerCase() === 'h',
        colspan: spanOf(attrs, 'colspan'),
        rowspan: spanOf(attrs, 'rowspan'),
      })
    }
    if (cells.some(cell => cell.text !== '')) {
      rows.push({
        cells,
        header: cells.every(cell => cell.header),
      })
    }
  }
  if (rows.length === 0) return null
  const cols = rows.reduce((max, row) => Math.max(max, row.cells.reduce((sum, cell) => sum + cell.colspan, 0)), 0)
  return { rows, cols, headerRows: rows[0] && rows[0].header ? 1 : 0, source: 'service' }
}

/** 单元格里的内容：<br> 当换行，其它标签剥掉，实体解码，空白压平。 */
function decodeCellText(inner) {
  return String(inner || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(line => line !== '')
    .join('\n')
}

function spanOf(attrs, name) {
  const match = new RegExp(name + '\\s*=\\s*["\']?(\\d+)', 'i').exec(String(attrs || ''))
  const value = match ? Number(match[1]) : 1
  return Number.isFinite(value) && value > 1 ? Math.min(20, Math.floor(value)) : 1
}

/**
 * PyMuPDF 抽出来的二维文本 → 同一个结构（没有 colspan，第一行是否是表头由 Python 侧判断）。
 */
export function gridToTableModel(grid, options = {}) {
  const rows = Array.isArray(grid) ? grid : []
  const maxRows = Math.max(1, Math.round(number(options.maxRows, 200)))
  const maxCols = Math.max(1, Math.round(number(options.maxCols, 40)))
  const headerRows = Math.max(0, Math.min(1, Math.round(number(options.headerRows, 0))))
  const shaped = []
  for (const raw of rows.slice(0, maxRows)) {
    const cells = (Array.isArray(raw) ? raw : []).slice(0, maxCols).map((cell, index) => ({
      text: String(cell === undefined || cell === null ? '' : cell).trim(),
      header: index >= 0 && shaped.length < headerRows,
      colspan: 1,
      rowspan: 1,
    }))
    if (cells.some(cell => cell.text !== '')) shaped.push({ cells, header: cells.length > 0 && cells.every(cell => cell.header) })
  }
  if (shaped.length === 0) return null
  const cols = shaped.reduce((max, row) => Math.max(max, row.cells.length), 0)
  return { rows: shaped, cols, headerRows: headerRows > 0 ? 1 : 0, source: String(options.source || 'pdf') }
}

/**
 * 结构可信度：表格模型最容易出的问题是「整列文字被塞进一个格子」或大面积空表。
 * 这里只做保守判断——过不了就退回「裁剪图 + 文字」，宁可不显示也不误导。
 */
export function tableQuality(model) {
  if (!model || !Array.isArray(model.rows) || model.rows.length < 2) return { ok: false, reason: '行数不足' }
  const counts = model.rows.map(row => row.cells.reduce((sum, cell) => sum + (cell.colspan || 1), 0))
  const modal = counts.slice().sort((a, b) => counts.filter(x => x === b).length - counts.filter(x => x === a).length)[0]
  const same = counts.filter(count => count === modal).length / counts.length
  if (modal < 2) return { ok: false, reason: '列数不足' }
  if (same < 0.6) return { ok: false, reason: '每行列数不一致' }
  const cells = []
  for (const row of model.rows) for (const cell of row.cells) cells.push(cell)
  const filled = cells.filter(cell => cell.text !== '').length
  if (filled / Math.max(1, cells.length) < 0.3) return { ok: false, reason: '空格子太多' }
  const longest = cells.reduce((max, cell) => Math.max(max, cell.text.length), 0)
  if (longest > 400) return { ok: false, reason: '有格子塞了整段文字' }
  // 版面模型给的 HTML 常把一整列数字并进一个 <td>（"5.1 / 5.6 6.9 / 7.8"）：
  // 格子数一致、也非空，但画出来数字全错列。PDF 格线切出来的没有这个毛病。
  if (model.source !== 'pdf') {
    const crowded = cells.filter(cell => (String(cell.text || '').match(/\d+(?:[.,]\d+)?/g) || []).length >= 3).length
    if (crowded / Math.max(1, cells.length) > 0.3) return { ok: false, reason: '格子里的数字太挤（疑似合并列）' }
  }
  return { ok: true, reason: '' }
}

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function round(value) {
  return Math.round(number(value) * 100) / 100
}

/**
 * 解析结果 jsonl → [{ n, width, height, blocks }]。
 *
 * 一个 jsonl 行是一页；行内的 layoutParsingResults 可能有多项（分片），按出现顺序连续编号。
 * 坏行只计数不抛错 —— 一本几百页的书里个别行被截断，不该让整次解析报废。
 */
export function parseLayoutJsonl(text) {
  const pages = []
  const issues = []
  const seen = new Set()
  let slots = 0
  let skipped = 0
  const reject = (n, reason) => { skipped += 1; issues.push({ page: n, reason }) }
  for (const line of String(text === undefined || text === null ? '' : text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      reject(++slots, 'invalid-json')
      continue
    }
    const result = row && row.result && typeof row.result === 'object' ? row.result : row
    const list = result && Array.isArray(result.layoutParsingResults) ? result.layoutParsingResults : []
    if (list.length === 0) {
      reject(++slots, 'missing-page-result')
      continue
    }
    for (const item of list) {
      const ordinal = ++slots
      const pruned = item && item.prunedResult && typeof item.prunedResult === 'object'
        ? item.prunedResult
        : item
      if (!pruned || typeof pruned !== 'object' || !Array.isArray(pruned.parsing_res_list)) {
        reject(ordinal, 'invalid-page-result')
        continue
      }
      // page_index is zero-based when the service supplies it. Otherwise keep
      // the original result slot, including malformed slots; never compact pages.
      const explicit = pruned.page_index ?? item.page_index
      if (explicit !== undefined && (!Number.isSafeInteger(explicit) || explicit < 0)) {
        reject(ordinal, 'invalid-page-index')
        continue
      }
      const n = explicit === undefined ? ordinal : explicit + 1
      if (seen.has(n)) {
        reject(n, 'duplicate-page-index')
        continue
      }
      seen.add(n)
      pages.push({
        n,
        width: number(pruned.width),
        height: number(pruned.height),
        blocks: pruned.parsing_res_list,
        raw: item,
        resultSlot: ordinal,
        pageIdentity: explicit === undefined ? 'result-slot' : 'service-index',
      })
    }
  }
  if (pages.length === 0) {
    throw new Error('版面解析失败：返回内容里没有可解析的页')
  }
  return { pages, skipped, slots, issues }
}

/** Replay only evidence named by this revision. Never infer identity from directory order. */
export async function replayLayoutPages(layout, readRaw) {
  const fail = detail => { throw new Error('版面 raw 页来源不完整或不唯一，拒绝离线重建：' + detail) }
  const pages = layout.pages || []
  const total = layout.pageCount
  const validPage = n => Number.isSafeInteger(n) && n >= 1 && n <= total
  if (!Number.isSafeInteger(total) || total < 1 || pages.length !== total ||
      new Set(pages.map(p => p.n)).size !== total || pages.some(p => !validPage(p.n))) fail('全局页号不合法')
  const groups = new Map()
  const add = (ref, target = null, source = 'service') => {
    if (ref === null || ref === undefined) return
    if (!/^[a-f0-9]{64}$/.test(ref.hash || '')) fail('raw hash 不合法')
    // Other model evidence must not silently become service evidence or disappear.
    if (source !== 'service' || (ref.model && ref.model !== LAYOUT_MODEL)) fail('暂不支持该来源的安全回放')
    if (target !== null && !validPage(target)) fail('来源目标页越界')
    let range = null
    if (ref.page !== undefined && ref.page !== null && ref.page !== '') {
      const match = /^(\d+)(?:-(\d+))?$/.exec(String(ref.page))
      if (!match) fail('raw 批次范围不合法')
      range = [Number(match[1]), Number(match[2] || match[1])]
      if (!range.every(validPage) || range[0] > range[1]) fail('raw 批次范围越界')
      if (target !== null && (target < range[0] || target > range[1])) fail('页绑定与批次范围冲突')
    }
    if (!groups.has(ref.hash)) groups.set(ref.hash, { ref, ranges: new Map(), targets: new Set() })
    const group = groups.get(ref.hash)
    if (range) group.ranges.set(range.join('-'), { ref, range })
    if (target !== null) group.targets.add(target)
  }
  for (const page of pages) add(page.rawRef, page.n)
  for (const ref of layout.rawRefs || []) add(ref)
  // Old revisions lost page.rawRef but retained batch ranges in block evidence.
  for (const block of [...(layout.blocks || []), ...(layout.excluded || []).map(item => item.block).filter(Boolean)]) {
    for (const item of [...(block.sourceBlocks || []), ...(block.candidates || [])]) add(item.rawRef, block.page, item.source)
  }
  if (!groups.size) {
    if ((layout.blocks || []).some(b => (b.sourceBlocks || []).some(s => s.source !== 'pdf'))) fail('缺少原始来源引用')
    return [] // A PDF-only model has no cloud evidence to replay.
  }
  const resolved = new Map()
  for (const [hash, group] of groups) {
    const parsed = parseLayoutJsonl(await readRaw({ hash }))
    const count = parsed.pages.length
    if (parsed.skipped || parsed.slots !== count || parsed.pages.some(p => !Number.isSafeInteger(p.n) || p.n < 1 || p.n > count) ||
        new Set(parsed.pages.map(p => p.n)).size !== count) fail('raw 局部页号重复、缺失或越界')
    let ranges = [...group.ranges.values()]
    if (!ranges.length) {
      const targets = [...group.targets].sort((a, b) => a - b)
      // A single full-document raw is also unambiguous without block/page bindings.
      if (!targets.length && groups.size === 1 && count === total) targets.push(...pages.map(p => p.n).sort((a, b) => a - b))
      if (targets.length !== count || targets.some((n, i) => n !== targets[0] + i)) fail('无法恢复 raw 的完整页绑定')
      ranges = [{ ref: group.ref, range: [targets[0], targets.at(-1)] }]
    }
    const covered = new Set()
    for (const { ref, range: [start, end] } of ranges) {
      if (end - start + 1 !== count) fail('raw 页数与批次范围不符')
      for (const page of parsed.pages) {
        const n = start + page.n - 1
        const previous = resolved.get(n)
        if (previous && (previous.rawRef.hash !== hash || previous.localPage !== page.n)) fail('多个 raw 争用同一全局页')
        resolved.set(n, { ...page, n, localPage: page.n, rawRef: { ...ref, page: `${start}-${end}` } })
        covered.add(n)
      }
    }
    if ([...group.targets].some(n => !covered.has(n))) fail('页绑定与 raw 范围冲突')
  }
  if (resolved.size !== total || pages.some(p => !resolved.has(p.n))) fail('部分全局页缺少 raw 证据')
  return [...resolved.values()].sort((a, b) => a.n - b.n)
}

const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 把同一个块里的多行拼回一段：行尾连字符去掉空格，中文之间不插空格。 */
export function joinLines(lines) {
  let out = ''
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw === undefined || raw === null ? '' : raw).trim()
    if (line === '') continue
    if (out === '') {
      out = line
      continue
    }
    if (out.endsWith('-') && /^[A-Za-z0-9]/.test(line)) out += line
    else if (CJK_RE.test(out.slice(-1)) && CJK_RE.test(line[0])) out += line
    else out += ' ' + line
  }
  return out
}

/** 比对「服务端文字 vs 文本层文字」用的归一化：去空白与标点，只留字母数字。 */
export function normalizeForMatch(text) {
  return String(text === undefined || text === null ? '' : text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 文本层这段文字是不是缺了开头（段首那行落在版面框的缝里）。 */
export function missingHeadPosition(serviceText, pdfText) {
  const service = normalizeForMatch(serviceText)
  const pdf = normalizeForMatch(pdfText)
  if (service === '' || pdf === '') return -1
  if (service.startsWith(pdf)) return -1
  const probe = pdf.slice(0, Math.min(30, pdf.length))
  return service.indexOf(probe)
}

/** 文本层抠出来的字是不是废的：掉字距的 PDF 会得到 "P f F t d A t" 这种 */
export function looksBrokenText(text) {
  const value = String(text || '').trim()
  if (value === '') return false
  const tokens = value.split(/\s+/)
  if (tokens.length < 6) return false
  const singles = tokens.filter(token => token.length === 1).length
  return singles / tokens.length > 0.5
}

function normalizeCaptionText(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
}

/**
 * 服务页 → 契约 layout。纯函数：不读盘、不联网。
 *
 * @param {Array} pages            parseLayoutJsonl 的 pages（服务坐标系）
 * @param {object} opts
 * @param {Array<{n:number,w:number,h:number}>} opts.pageSizes PDF 里的页尺寸（pt）
 * @param {(page:number, blockIndex:number) => string} [opts.textFor] 按块取文本层文字
 * @param {number} [opts.pageOffset] 分片时这一段在第一页之前有几页
 */
export function normalizeLayout(pages, opts = {}) {
  const pageSizes = Array.isArray(opts.pageSizes) ? opts.pageSizes : []
  const textFor = typeof opts.textFor === 'function' ? opts.textFor : () => ''
  const offset = Math.max(0, Math.trunc(number(opts.pageOffset)))
  const warnings = Array.isArray(opts.warnings) ? opts.warnings.slice() : []
  const blocks = []
  const figures = []

  for (const page of pages) {
    const pageNumber = offset + Math.max(1, Math.trunc(number(page.n, 1)))
    const size = pageSizes.find(item => Math.trunc(number(item.n)) === pageNumber) ||
      pageSizes[pageNumber - 1] || null
    const svcW = number(page.width)
    const svcH = number(page.height)
    const pdfW = size ? number(size.w) : svcW
    const pdfH = size ? number(size.h) : svcH
    const scaleX = svcW > 0 && pdfW > 0 ? pdfW / svcW : 1
    const scaleY = svcH > 0 && pdfH > 0 ? pdfH / svcH : 1
    if (svcW > 0 && svcH > 0 && pdfW > 0 && pdfH > 0) {
      const ratioService = svcW / svcH
      const ratioPdf = pdfW / pdfH
      if (Math.abs(ratioService - ratioPdf) / Math.max(ratioService, ratioPdf) > 0.02) {
        warnings.push(`第 ${pageNumber} 页的宽高比与服务端不一致（${svcW}x${svcH} vs ${pdfW}x${pdfH}），坐标按两轴分别缩放`)
      }
    }

    const rawBlocks = Array.isArray(page.blocks) ? page.blocks : []
    const rawToBlock = new Map()

    for (let index = 0; index < rawBlocks.length; index += 1) {
      const raw = rawBlocks[index] || {}
      const label = String(raw.block_label || '').trim().toLowerCase()
      const kind = labelToKind(label)
      if (kind === null) continue
      const bboxRaw = Array.isArray(raw.block_bbox) ? raw.block_bbox : []
      const x0 = number(bboxRaw[0]) * scaleX
      const y0 = number(bboxRaw[1]) * scaleY
      const x1 = number(bboxRaw[2]) * scaleX
      const y1 = number(bboxRaw[3]) * scaleY
      const bbox = {
        x: round(Math.max(0, Math.min(x0, x1))),
        y: round(Math.max(0, Math.min(y0, y1))),
        width: round(Math.max(0, Math.abs(x1 - x0))),
        height: round(Math.max(0, Math.abs(y1 - y0))),
      }
      if (bbox.width <= 0 || bbox.height <= 0) continue

      let text = ''
      let latex = ''
      let html = ''
      if (kind === 'formula') {
        latex = cleanLatex(raw.block_content)
      } else if (kind === 'table') {
        html = String(raw.block_content || '').trim()
        text = htmlToText(html)
      } else {
        const serviceText = normalizeCaptionText(raw.block_content)
        const pdfText = normalizeCaptionText(textFor(pageNumber, index))
        // 图注优先用服务端文字：PDF 文本层在不少排版里会掉词间空格（"Figure3: Anillustrationof"）
        text = kind === 'caption' ? (serviceText || pdfText) : pdfText
        if (text === '' || looksBrokenText(text)) text = serviceText || text
        if (text === '' && KEEP_EMPTY_KINDS.has(kind) === false) continue   // 空段落没有任何意义
      }
      if (kind === 'figure') text = ''

      const entry = {
        page: pageNumber,
        label,
        kind,
        bbox,
        text,
      }
      if (latex !== '') entry.latex = latex
      if (html !== '') entry.html = html
      if (kind === 'heading') {
        // 版面模型会把加粗的行内小标题（"could be formulated as:"）也标成 paragraph_title，
        // 这类进了目录就是噪音：小写开头、冒号/逗号收尾、过长的都不算真标题。
        const value = String(text || '').trim()
        if (value === '' || /^[a-z]/.test(value) || /[:：,，;；]$/.test(value) || value.length > 120) {
          entry.kind = 'body'
        } else {
          const level = headingLevel(value)
          if (level !== null) entry.level = level
        }
      }
      if (FIGURE_LABELS.has(label)) {
        entry.figureIndex = figures.length
        figures.push({
          index: figures.length,
          page: pageNumber,
          kind: label === 'table' ? 'table' : 'figure',
          label,
          bbox,
          caption: '',
          captionOrder: null,
          blockIndex: blocks.length,
          rawIndex: index,
        })
        if (kind === 'table' && text !== '') entry.text = text
      }
      entry.order = blocks.length
      blocks.push(entry)
      rawToBlock.set(index, entry)
    }

    // 图注认领：同一页里，图片/表格块找最近的 figure_title/table_title。
    // 位置相同时偏向下方的那个 —— 论文的图注绝大多数在图下方，表格标题在上方，
    // 按距离取最近即可，同距离时用 0.5 的偏置决定。
    const claimedCaptions = new Set()
    for (const figure of figures) {
      if (figure.page !== pageNumber || figure.caption !== '') continue
      let best = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const [rawIndex, block] of rawToBlock) {
        if (block.kind !== 'caption') continue
        if (claimedCaptions.has(block.order)) continue      // 一条图注只归一张图
        const bias = rawIndex < figure.rawIndex ? 0.5 : 0   // 同距离时优先下方（图注在多数论文里在图下面）
        const distance = Math.abs(rawIndex - figure.rawIndex) + bias
        if (distance < bestDistance) {
          bestDistance = distance
          best = block
        }
      }
      if (best) {
        figure.caption = best.text
        figure.captionOrder = best.order
        claimedCaptions.add(best.order)
      }
      delete figure.rawIndex
    }
  }

  // 收尾清理：去掉公式的重复 text 块、接回被拆开的段落，图注的 order 跟着重编号
  const cleaned = cleanLayoutBlocks(blocks)
  for (const figure of figures) {
    if (figure.captionOrder !== null) figure.captionOrder = cleaned.orderMap.get(figure.captionOrder) ?? null
    figure.blockIndex = cleaned.orderMap.get(figure.blockIndex) ?? null
  }
  if (cleaned.dropped > 0) warnings.push(`去掉了 ${cleaned.dropped} 个与公式块重复的正文块`)
  if (cleaned.merged > 0) warnings.push(`接回了 ${cleaned.merged} 处被拆开的段落`)

  return {
    version: LAYOUT_VERSION,
    at: opts.now || new Date().toISOString(),
    model: String(opts.model || LAYOUT_MODEL),
    jobId: String(opts.jobId || ''),
    source: opts.source || null,
    pageCount: Number(opts.pageCount) || 0,
    servicePages: pages.length,
    warnings,
    blocks: cleaned.blocks,
    excluded: cleaned.excluded,
    figures,
  }
}

// ---------------------------------------------------------------- 块清理
//
// PP-StructureV3 有两个稳定出现的小毛病，纯文本后处理就能修，不必重新上传：
//   1. 一行公式会同时给一个 `formula` 块（带 LaTeX）和一个 `text` 块（PDF 文本层抠出来的，
//      上下标顺序是乱的，比如 "N X LNAT = log P (yn | X; θ) (2)"）。后者是重复，且更难读；
//   2. 模型偶尔把一段正文拆成两个相邻块（前一块没句末标点，后一块小写开头）。

const SENTENCE_END = /[.!?。！？;；]$/
const MATH_SYMBOLS = /[=∑Σ∫√≈≤≥±×÷∞∂∇παβγθλμσφψω]/

/** 一行/一块文字看起来是不是公式（用来识别「公式块重复出来的 text 块」）。 */
// 「公式的乱序文本版」几乎不含英文功能词，正文短句（where α = 0.3 …）会。
// 用这个兜住 cleanLayoutBlocks 的误删：宁可留一行重复公式，也不要吃掉一句正文。
const PROSE_WORDS = /\b(the|and|where|with|for|is|are|was|were|of|to|in|on|we|our|this|that|these|those|from|by|as|at|be|been|an|or|if|then|when|which|such|each|than|can|may|not|but|it|its|they|their|also|using|use|uses|figure|table|section|following|given|denote|denotes|respectively)\b/i

export function looksLikeFormulaText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (value === '' || value.length > 220) return false
  if (PROSE_WORDS.test(value)) return false
  if (SENTENCE_END.test(value)) return false
  if (!/[=<>≈≤≥]/.test(value) && !MATH_SYMBOLS.test(value)) return false
  const tokens = value.split(' ').filter(Boolean)
  if (tokens.length < 3) return false
  const short = tokens.filter(token => token.length <= 3).length / tokens.length
  const words = tokens.filter(token => /^[A-Za-z]{5,}$/.test(token)).length
  // 公式的 token 绝大多数很短（单字母、符号、编号），真正文反过来
  return short >= 0.45 && words <= Math.max(2, Math.floor(tokens.length * 0.25))
}

function overlapsHorizontally(a, b) {
  if (!a || !b) return 0
  const ax0 = number(a.x)
  const ax1 = ax0 + number(a.width)
  const bx0 = number(b.x)
  const bx1 = bx0 + number(b.width)
  const shared = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0))
  return shared / Math.max(1, Math.min(ax1 - ax0, bx1 - bx0))
}

function sameFormulaText(text, latex) {
  // Geometry alone cannot prove a duplicate. Keep uncertain OCR/formula pairs;
  // only whitespace and explicit math delimiters are irrelevant here.
  const normalized = value => cleanLatex(String(value || '')).normalize('NFC').replace(/\s+/g, '')
  const source = normalized(text)
  return source !== '' && source === normalized(latex)
}

/**
 * 去掉「和公式块重复的 text 块」，并把被模型拆开的正文接回去。
 * 返回 { blocks, orderMap, dropped, merged }：orderMap 用来把图注的 order 跟着改。
 */
export function cleanLayoutBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const formulas = list.filter(block => block && block.kind === 'formula' && String(block.latex || '').trim() !== '')
  const kept = []
  const excluded = []
  let dropped = 0
  for (const block of list) {
    if (!block) continue
    if (block.kind !== 'body' || !looksLikeFormulaText(block.text)) {
      kept.push(block)
      continue
    }
    const center = number(block.bbox.y) + number(block.bbox.height) / 2
    const twin = formulas.find(candidate => {
      if (candidate.page !== block.page) return false
      const other = number(candidate.bbox.y) + number(candidate.bbox.height) / 2
      if (Math.abs(other - center) > Math.max(8, number(block.bbox.height), number(candidate.bbox.height))) return false
      return overlapsHorizontally(block.bbox, candidate.bbox) >= 0.8 && sameFormulaText(block.text, candidate.latex)
    })
    if (twin) {
      dropped += 1
      excluded.push({ reason: 'duplicate-formula', block: { ...block }, targetOrder: twin.order })
      continue
    }
    kept.push(block)
  }

  // 接回被拆开的段落：前一段没有句末标点、后一段小写开头、两块贴得很近
  const mergedBlocks = []
  let merged = 0
  for (const block of kept) {
    const previous = mergedBlocks[mergedBlocks.length - 1]
    const canMerge = previous &&
      previous.kind === 'body' && block.kind === 'body' &&
      previous.page === block.page &&
      !SENTENCE_END.test(String(previous.text || '').trim()) &&
      /^[a-z(]/.test(String(block.text || '').trim()) &&
      // 双栏页里左右两栏的块也可能「上一块没写完、下一块小写开头」，
      // 但它们不是同一段：必须横向也对得上，否则会把左右栏拼成一句
      overlapsHorizontally(previous.bbox, block.bbox) >= 0.5 &&
      number(block.bbox.y) >= number(previous.bbox.y) + number(previous.bbox.height) &&
      number(block.bbox.y) - (number(previous.bbox.y) + number(previous.bbox.height)) <= 6
    if (!canMerge) {
      mergedBlocks.push({ ...block, sourceOrders: Array.isArray(block.sourceOrders) ? [...block.sourceOrders] : [block.order] })
      continue
    }
    const glue = /[a-z]-$/.test(String(previous.text || '').trim()) ? '' : ' '
    previous.text = String(previous.text || '').trim() + glue + String(block.text || '').trim()
    previous.sourceOrders.push(...(Array.isArray(block.sourceOrders) ? block.sourceOrders : [block.order]))
    previous.bbox = {
      x: Math.min(number(previous.bbox.x), number(block.bbox.x)),
      y: Math.min(number(previous.bbox.y), number(block.bbox.y)),
      width: Math.max(number(previous.bbox.x) + number(previous.bbox.width), number(block.bbox.x) + number(block.bbox.width)) - Math.min(number(previous.bbox.x), number(block.bbox.x)),
      height: Math.max(number(previous.bbox.y) + number(previous.bbox.height), number(block.bbox.y) + number(block.bbox.height)) - Math.min(number(previous.bbox.y), number(block.bbox.y)),
    }
    merged += 1
  }

  const orderMap = new Map()
  mergedBlocks.forEach((block, index) => {
    orderMap.set(block.order, index)
    for (const sourceOrder of block.sourceOrders) orderMap.set(sourceOrder, index)
    block.order = index
  })
  for (const item of excluded) orderMap.set(item.block.order, orderMap.get(item.targetOrder))
  return { blocks: mergedBlocks, orderMap, dropped, merged, excluded }
}

/** 给前端/日志用的小结。 */
export function layoutSummary(layout) {
  const by = {}
  for (const block of layout.blocks || []) by[block.kind] = (by[block.kind] || 0) + 1
  return {
    pages: layout.pageCount,
    servicePages: layout.servicePages,
    blocks: (layout.blocks || []).length,
    figures: (layout.figures || []).length,
    byKind: by,
    warnings: (layout.warnings || []).length,
    at: layout.at,
    model: layout.model,
  }
}

// ---------------------------------------------------------------- 表格结构

const TABLE_KIND = 'table'

/**
 * 版面块框和 PyMuPDF 表格框的重合度：同一页可能有好几张表，取最贴合的那张。
 */
function pickTable(tables, bbox) {
  if (!Array.isArray(tables) || tables.length === 0) return null
  if (!bbox || !Number.isFinite(number(bbox.x, NaN))) return tables[0]
  const x0 = number(bbox.x)
  const y0 = number(bbox.y)
  const x1 = x0 + number(bbox.width)
  const y1 = y0 + number(bbox.height)
  let best = null
  let bestScore = 0
  for (const table of tables) {
    const box = Array.isArray(table.bbox) ? table.bbox : []
    if (box.length !== 4) continue
    const ox = Math.max(0, Math.min(x1, number(box[2])) - Math.max(x0, number(box[0])))
    const oy = Math.max(0, Math.min(y1, number(box[3])) - Math.max(y0, number(box[1])))
    const area = Math.max(1, (number(box[2]) - number(box[0])) * (number(box[3]) - number(box[1])))
    const score = (ox * oy) / area
    if (score > bestScore) {
      bestScore = score
      best = table
    }
  }
  return bestScore >= 0.25 ? best : null
}

/**
 * 给每个「表格」块补上真实的行列结构：先要 PDF 自己的格子（PyMuPDF 按格线切），
 * booktabs 那种没竖线的表抽不出来时，退回版面模型的表格 HTML。
 * 两条路都有可信度门槛，过不了就只保留「裁剪图 + 文字」，不硬画一张错的表。
 */
export async function attachTables(blocks, options) {
  const pdf = options && options.pdf
  const pdfPath = options && options.pdfPath
  const warnings = (options && options.warnings) || []
  const targets = (Array.isArray(blocks) ? blocks : []).filter(block => block.kind === TABLE_KIND)
  if (targets.length === 0 || !pdf || typeof pdf.callTool !== 'function') return 0
  const byPage = new Map()
  for (const block of targets) {
    const page = Math.max(1, Math.round(number(block.page, 1)))
    if (!byPage.has(page)) byPage.set(page, [])
    byPage.get(page).push(block)
  }
  let attached = 0
  for (const [page, items] of byPage) {
    let found = []
    try {
      const result = await pdf.callTool('tables', { path: pdfPath, page })
      found = result && Array.isArray(result.tables) ? result.tables : []
    } catch (error) {
      warnings.push('第 ' + page + ' 页：读表格结构失败（' + (error && error.message ? error.message : error) + '）')
    }
    const usedTables = new Set()
    for (const block of items) {
      // 同一页两个 table 块（表头/表体被拆开）不能都认领同一张表：认领过就跳过
      const picked = pickTable(found.filter((table, index) => !usedTables.has(index)), block.bbox)
      if (picked) {
        const position = found.indexOf(picked)
        if (position >= 0) usedTables.add(position)
      }
      let model = picked ? gridToTableModel(picked.rows, { headerRows: picked.headerRows, source: 'pdf' }) : null
      if (!model && block.html) {
        // 带 rowspan/colspan 的 HTML 用网格展开版：被合并覆盖的位置标 placeholder，
        // 前端渲染时跳过，列就不会错位。
        const parsed = buildTableModelFromHtml(block.html)
        if (parsed) {
          model = {
            rows: parsed.rows.map(row => ({ cells: row.cells.map(cell => ({
              text: cell.text, colspan: cell.colSpan || 1, rowspan: cell.rowSpan || 1,
              header: cell.header === true, placeholder: cell.placeholder === true,
            })) })),
            cols: parsed.cols, headerRows: parsed.headerRows, source: 'service', quality: parsed.quality,
          }
        }
      }
      const quality = tableQuality(model)
      if (quality.ok) {
        block.table = { ...model, source: picked ? 'pdf' : 'service' }
        attached += 1
      } else if (model) {
        warnings.push('第 ' + page + ' 页的表格结构不可靠（' + quality.reason + '），只显示原图与文字')
      }
    }
  }
  return attached
}

// ---------------------------------------------------------------- 读盘与跑任务

/**
 * 版面解析的执行器。网络、Python、磁盘都收在这里，纯逻辑在上面。
 *
 * @param {object} deps
 * @param {object} deps.store  lib/store.js（getConfig/getMeta/resolvePdf/paperFile/readJson/writeJsonAtomic）
 * @param {object} deps.pdf    lib/pdf.js（callTool）
 * @param {object} deps.ocr    lib/ocr.js（submitJob/pollJob/fetchResults）
 */
/**
 * 从一页的文本行里挑出落在 rect 内的行（一行只归一个块）。
 *
 * 判定与 runLayout 的第一遍一致：行面积被块框覆盖 ≥50%，或行中心落在块框内。
 */
export function pickLinesForRect(rect, lines, used = new Set()) {
  const [x0, y0, x1, y1] = rect
  const picked = []
  lines.forEach((line, index) => {
    if (used.has(index)) return
    const lx0 = number(line.x)
    const ly0 = number(line.y)
    const lx1 = number(line.x2)
    const ly1 = number(line.y2)
    const overlapX = Math.max(0, Math.min(x1, lx1) - Math.max(x0, lx0))
    const overlapY = Math.max(0, Math.min(y1, ly1) - Math.max(y0, ly0))
    const lineArea = Math.max(1e-3, (lx1 - lx0) * (ly1 - ly0))
    const covered = (overlapX * overlapY) / lineArea
    const centre = (lx0 + lx1) / 2 >= x0 && (lx0 + lx1) / 2 <= x1 &&
      (ly0 + ly1) / 2 >= y0 && (ly0 + ly1) / 2 <= y1
    if (covered >= 0.5 || centre) {
      used.add(index)
      picked.push(line)
    }
  })
  return picked
}

export function createLayout(deps = {}) {
  const store = deps.store
  const pdf = deps.pdf
  const ocr = deps.ocr
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()

  if (!store || typeof store.paperFile !== 'function') throw new Error('layout 需要 store 依赖')
  const archive = deps.archive || createLayoutArchive({ store })

  async function readLayout(id) {
    const value = await archive.readPublished(id)
    if (!value || typeof value !== 'object' || !Array.isArray(value.blocks)) return null
    return value
  }

  async function readPartial(id) {
    const value = await store.readJson(store.paperFile(id, LAYOUT_PARTIAL), null)
    if (!value || typeof value !== 'object' || !Array.isArray(value.pages)) return null
    return value
  }

  async function clearPartial(id) {
    await fsp.rm(store.paperFile(id, LAYOUT_PARTIAL), { force: true }).catch(() => {})
  }

  async function clearLayout(id) {
    await archive.clear(id)
    return true
  }

  /**
   * 跑一次版面解析并落盘 layout.json。
   *
   * @param {string} id
   * @param {object} opts { onProgress, signal, model, batchPages, skipCache }
   */
  async function runLayout(id, opts = {}) {
    if (!pdf || typeof pdf.callTool !== 'function') throw new Error('layout 需要 pdf 依赖')
    if (!ocr || typeof ocr.submitJob !== 'function') throw new Error('layout 需要 ocr 依赖')
    const meta = await store.getMeta(id)
    const { path: pdfPath } = await store.resolvePdf(id)
    const config = await store.getConfig()
    const token = config && config.ocr ? String(config.ocr.token || '') : ''
    if (token === '') {
      throw new Error('还没填 PaddleOCR 的 API Key：设置 → PaddleOCR 里填一次再试')
    }
    const model = String(opts.model || (config.ocr && config.ocr.layoutModel) || LAYOUT_MODEL)
    const batchPages = Math.max(1, Math.min(200, Math.trunc(Number(opts.batchPages) || LAYOUT_BATCH_PAGES)))
    const emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}

    const info = await pdf.callTool('info', { path: pdfPath })
    const pageCount = Number(info && info.pages) || 0
    if (pageCount <= 0) throw new Error('这个 PDF 没有页，无法解析版面')
    const pageSizes = Array.isArray(info.sizes) ? info.sizes : []

    const stat = await fsp.stat(pdfPath)
    const source = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), path: pdfPath }

    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-layout-'))
    // 页号是唯一身份：续跑时重传的批次里可能含已完成的页，按数组追加会出现同一页两份
    const pageMap = new Map()
    const pages = []
    const jobs = []
    const warnings = []
    let skipped = 0
    let pending = null
    // 断点续跑：只认「同一份 PDF（size+mtime）、同一个模型」的旧进度，
    // 否则宁可重来也不要把两篇的东西拼在一起。
    let resumed = 0
    // 默认一律续跑：断点是按页计费换来的，除了显式 resume:false 之外都不该丢掉。
    if (opts.resume !== false) {
      const partial = await readPartial(id)
      if (partial && partial.source && partial.source.size === source.size &&
          partial.source.mtimeMs === source.mtimeMs && String(partial.model || '') === model) {
        for (const page of partial.pages) {
          const pageNumber = Math.trunc(number(page.n))
          if (pageNumber >= 1 && pageNumber <= pageCount && !pageMap.has(pageNumber)) {
            pageMap.set(pageNumber, page)
            pages.push(page)
          }
        }
        for (const jobId of Array.isArray(partial.jobs) ? partial.jobs : []) jobs.push(jobId)
        skipped += Number(partial.skipped) || 0
        for (const warning of Array.isArray(partial.warnings) ? partial.warnings : []) {
          if (!warnings.includes(warning)) warnings.push(warning)
        }
        pending = partial.pending && typeof partial.pending === 'object' ? partial.pending : null
        resumed = pages.length
        if (resumed > 0) emit({ phase: 'resume', pages: resumed, total: pageCount })
      } else {
        await clearPartial(id)
      }
    } else {
      // 换模型/换 PDF/显式重来：旧断点必须作废，否则会把两篇的东西拼在一起
      await clearPartial(id)
    }
    const donePages = new Set(pages.map(page => Math.trunc(number(page.n))))
    try {
      for (let start = 1; start <= pageCount; start += batchPages) {
        const end = Math.min(pageCount, start + batchPages - 1)
        let complete = true
        for (let n = start; n <= end; n += 1) if (!donePages.has(n)) complete = false
        if (complete) continue                       // 这一批上次已经跑完，不再上传（省钱）
        if (opts.signal && opts.signal.aborted) throw new Error('版面解析已取消')
        const part = path.join(tmpRoot, `p${start}-${end}.pdf`)
        const split = await pdf.callTool('split', { path: pdfPath, from: start, to: end, out: part })
        if (!split || split.ok !== true) throw new Error('切分 PDF 失败：' + ((split && split.error) || '未知原因'))

        // 如果上一次在「已提交、还没拿到结果」时断了，先续拉同一个远端 job，
        // 不要重新上传这一批（按页计费，重传就是重复花钱）。
        let jobId = pending && pending.start === start && pending.end === end &&
          pending.model === model && pending.jobId ? String(pending.jobId) : ''
        if (!jobId) {
          // 提交前先落盘 pending：即使进程在 submitJob 返回前死掉，
          // 至少能看出这一批曾经开始过（没有 jobId 时下次会重新提交）。
          await store.writeJsonAtomic(store.paperFile(id, LAYOUT_PARTIAL), {
            version: LAYOUT_VERSION, at: new Date().toISOString(), model, source, pageCount,
            jobs, skipped, warnings, pages, pending: { start, end, model },
          })
          emit({ phase: 'submit', start, end, total: pageCount })
          const optionalPayload = {
            useDocUnwarping: Boolean(config?.ocr?.unwarp),
            useDocOrientationClassify: Boolean(config?.ocr?.orient),
          }
          const submitted = await ocr.submitJob({ token, filePath: part, model, optionalPayload })
          jobId = submitted && submitted.jobId
          if (!jobId) throw new Error('提交版面解析失败：响应里没有 jobId')
          jobs.push(jobId)
          pending = { start, end, model, jobId }
          await store.writeJsonAtomic(store.paperFile(id, LAYOUT_PARTIAL), {
            version: LAYOUT_VERSION, at: new Date().toISOString(), model, source, pageCount,
            jobs, skipped, warnings, pages, pending,
          })
        } else {
          emit({ phase: 'poll', jobId, start, end, total: pageCount, state: 'resume', extractedPages: 0, totalPages: 0 })
        }

        const polled = await ocr.pollJob({
          token,
          jobId,
          timeoutMs: Math.max(60 * 60 * 1000, (end - start + 1) * 120 * 1000),
          onProgress: info2 => emit({
            phase: 'poll', jobId, start, end, total: pageCount,
            state: info2.state, extractedPages: info2.extractedPages, totalPages: info2.totalPages,
          }),
        })
        const fetched = await ocr.fetchResults({ jsonUrl: polled.jsonUrl, withRaw: true })
        // 原始响应不可变归档：以后规则改进可以离线重算，不必再上传/付费。
        const rawRef = await archive.saveRaw(id, fetched.text, { page: `${start}-${end}`, model, jobId })
        const parsed = parseLayoutJsonl(fetched.text)
        const expected = end - start + 1
        const identities = new Set(parsed.pages.map(page => page.n))
        const completeResult = parsed.skipped === 0 && parsed.pages.length === expected &&
          identities.size === expected && parsed.pages.every(page => Number.isSafeInteger(page.n) && page.n >= 1 && page.n <= expected)
        if (!completeResult) {
          // Keep the last published layout and any earlier valid batches. A short
          // or malformed result cannot prove the identity of every uploaded page.
          throw new Error(`第 ${start}-${end} 页的版面结果不完整或页号不合法（返回 ${parsed.pages.length}/${expected} 页，异常 ${parsed.skipped} 项），未发布新结果`)
        }
        skipped += parsed.skipped
        for (const page of parsed.pages) {
          const pageNumber = start + page.n - 1
          const existing = pageMap.get(pageNumber)
          const value = { ...page, n: pageNumber, rawRef }
          if (existing) {
            // 续跑重传了这一页：用新结果覆盖，别再加一份
            const position = pages.indexOf(existing)
            if (position >= 0) pages[position] = value
          } else {
            pages.push(value)
          }
          pageMap.set(pageNumber, value)
          donePages.add(pageNumber)
        }
        // 每批一落盘：客户端断开、进程重启都不会白跑（版面是按页计费的）
        pending = null
        await store.writeJsonAtomic(store.paperFile(id, LAYOUT_PARTIAL), {
          version: LAYOUT_VERSION,
          at: new Date().toISOString(),
          model,
          source,
          pageCount,
          jobs,
          skipped,
          warnings,
          pages,
        })
        emit({ phase: 'batch', start, end, total: pageCount, saved: pages.length })
      }

      pages.sort((a, b) => a.n - b.n)
      if (donePages.size !== pageCount) throw new Error('版面结果缺页，未发布新结果')

      // 可选：PP-StructureV3 缺页/整页不可用时，用 PaddleOCR-VL-1.6 补一轮文字候选。
      // 默认关闭（maxCloudPages=0），避免用户不知情地为第二模型付费。
      const supplementaryPages = []
      const maxSupplement = Math.max(0, Math.trunc(number(opts.maxCloudPages ?? (config.ocr && config.ocr.maxCloudPages), 0)))
      if (maxSupplement > 0) {
        const serviceNumbers = new Set(pages.map(page => page.n))
        const targets = []
        for (let n = 1; n <= pageCount && targets.length < maxSupplement; n += 1) if (!serviceNumbers.has(n)) targets.push(n)
        for (const pageNumber of targets) {
          const size = pageSizes.find(item => Math.trunc(number(item.n)) === pageNumber) || null
          try {
            emit({ phase: 'submit', start: pageNumber, end: pageNumber, total: pageCount, model: 'PaddleOCR-VL-1.6' })
            const part = path.join(tmpRoot, `vl-${pageNumber}.pdf`)
            const split = await pdf.callTool('split', { path: pdfPath, from: pageNumber, to: pageNumber, out: part })
            if (!split || split.ok !== true) throw new Error('切分单页失败')
            const submitted = await ocr.submitJob({
              token,
              filePath: part,
              model: 'PaddleOCR-VL-1.6',
              optionalPayload: {
                useDocUnwarping: Boolean(config?.ocr?.unwarp),
                useDocOrientationClassify: Boolean(config?.ocr?.orient),
              },
            })
            const polled = await ocr.pollJob({ token, jobId: submitted.jobId })
            const fetched = await ocr.fetchResults({ jsonUrl: polled.jsonUrl, withRaw: true })
            const rawRef = await archive.saveRaw(id, fetched.text, { page: String(pageNumber), model: 'PaddleOCR-VL-1.6', jobId: submitted.jobId })
            let page = null
            try {
              const parsed = parseLayoutJsonl(fetched.text)
              page = parsed.pages[0] || null
            } catch {
              const loose = ocr.parseJsonl(fetched.text)
              const item = (loose.pages || [])[0] || null
              if (item) page = { n: 1, width: size ? size.w : 0, height: size ? size.h : 0, blocks: [] , text: item.text, markdown: item.markdown }
            }
            if (!page) throw new Error('没有返回可解析的页')
            const width = number(page.width, size ? size.w : 0)
            const height = number(page.height, size ? size.h : 0)
            const body = String(page.text || page.markdown || '').trim()
            const blocks = Array.isArray(page.blocks) && page.blocks.length > 0
              ? page.blocks
              : [{ block_label: 'text', block_content: body, block_bbox: [0, 0, width, height] }]
            if (blocks.length > 0) supplementaryPages.push({ n: pageNumber, width, height, blocks, rawRef })
          } catch (error) {
            warnings.push(`第 ${pageNumber} 页补充识别失败（${error && error.message ? error.message : error}），保留原页`)
          }
        }
      }

      // 每页取一次文本层，交给统一 IR 做「行级唯一归属 + 候选择优」。
      const pdfPages = []
      for (const page of pages) {
        if (opts.signal && opts.signal.aborted) throw new Error('版面解析已取消')
        let lines = []
        try {
          const fetched = await pdf.callTool('page_lines', { path: pdfPath, page: page.n })
          lines = fetched && Array.isArray(fetched.lines) ? fetched.lines : []
        } catch (error) {
          warnings.push(`第 ${page.n} 页：取文本层失败（${error && error.message ? error.message : error}），该页改用服务端文字`)
        }
        const size = pageSizes.find(item => Math.trunc(number(item.n)) === page.n) || null
        pdfPages.push({
          page: page.n,
          width: number(size ? size.w : page.width, page.width),
          height: number(size ? size.h : page.height, page.height),
          lines,
        })
        emit({ phase: 'text', page: page.n, total: pageCount })
      }

      const fingerprint = await fingerprintPdf(pdfPath)
      const layout = buildDocumentLayout({
        source: fingerprint,
        pageCount,
        pageSizes: pageSizes.map(item => ({ n: Math.trunc(number(item.n)), w: number(item.w), h: number(item.h), rotation: item.rotation })),
        servicePages: pages.map(page => ({
          n: page.n,
          width: page.width,
          height: page.height,
          status: page.status,
          blocks: page.blocks,
          rawRef: page.rawRef,
          // 某些页面靠 doc_preprocessor_res.angle / 原生矩阵才能换算坐标；
          // 原始 item 必须跟着进 IR，否则旋转页会被当成 0° 正常发布。
          raw: page.raw,
        })),
        supplementaryPages,
        pdfPages,
        model,
        jobId: jobs.join(','),
        at: now().toISOString(),
      })
      layout.skipped = skipped
      layout.resumedPages = resumed
      layout.batchPages = batchPages
      for (const warning of warnings) if (!layout.warnings.includes(warning)) layout.warnings.push(warning)
      // 表格结构：版面模型只给「这是表格、在哪」，行列优先从 PDF 自己的格线要。
      layout.tables = await attachTables(layout.blocks, { pdf, pdfPath, warnings: layout.warnings })
      if (layout.quality.status === 'failed') {
        const failed = layout.pages.filter(page => page.status === 'failed').map(page => page.n)
        throw new Error('第 ' + failed.join('、') + ' 页解析失败，未发布新结果（旧版面保留）')
      }
      const published = await archive.publish(id, layout, {
        source: fingerprint,
        model,
        jobId: jobs.join(','),
        pageCount,
        batchPages,
      })
      layout.revision = published.revision
      await clearPartial(id)
      return layout
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 只补表格结构（不重新上传 PDF、不花额度）：给老 layout.json 回填，或表结构逻辑改进后重跑。
   * 返回 { attached, tables, warnings }，attached 是成功补上结构的表格数。
   */
  async function refreshTables(id) {
    const layout = await readLayout(id)
    if (!layout) throw new Error('这篇还没有版面结果：先在面板点「版面」或跑 scripts/layout.mjs')
    const unified = Number(layout.schemaVersion) >= 2
    const resolved = await store.resolvePdf(id)
    const pdfPath = resolved && resolved.path
    if (!pdfPath) throw new Error('找不到这篇的 PDF 文件')
    // 上一轮表格产生的告警要清掉再重算，否则每点一次就多一条，真正的新问题被埋掉
    const warnings = (Array.isArray(layout.warnings) ? layout.warnings : [])
      .filter(warning => !/表格结构不可靠|读表格结构失败/.test(String(warning)))
    for (const block of layout.blocks) delete block.table
    const attached = await attachTables(layout.blocks, { pdf, pdfPath, warnings })
    layout.warnings = warnings
    layout.tables = attached
    if (unified) {
      layout.at = now().toISOString()
      const published = await archive.publishDerived(id, layout, {
        source: layout.source, model: layout.model, jobId: layout.jobId,
      })
      layout.revision = published.revision
    } else {
      await store.writeJsonAtomic(store.paperFile(id, LAYOUT_FILE), layout)
    }
    return { attached, tables: attached, warnings }
  }

  async function refillV2(id, layout, emit) {
    const servicePages = await replayLayoutPages(layout, ref => archive.readRaw(id, ref))
    if (!servicePages.length) {
      return { ok: true, changed: 0, pages: 0, blocks: (layout.blocks || []).length, note: '统一版面模型已按 PDF 文本层生成，无需重填' }
    }
    const { path: pdfPath } = await store.resolvePdf(id)
    const pdfPages = []
    const warnings = []
    for (const page of layout.pages || []) {
      let lines = []
      try {
        const fetched = await pdf.callTool('page_lines', { path: pdfPath, page: page.n })
        lines = fetched && Array.isArray(fetched.lines) ? fetched.lines : []
      } catch (error) {
        warnings.push(`第 ${page.n} 页：取文本层失败（${error?.message || error}）`)
      }
      pdfPages.push({ page: page.n, width: number(page.width), height: number(page.height), lines })
      emit({ phase: 'text', page: page.n, changed: 0 })
    }
    const pageSizes = (layout.pages || []).map(p => ({ n: p.n, w: p.width, h: p.height, rotation: p.rotation }))
    const fingerprint = await fingerprintPdf(pdfPath)
    const rebuilt = buildDocumentLayout({
      source: fingerprint,
      pageCount: Number(layout.pageCount) || pageSizes.length,
      pageSizes,
      servicePages,
      pdfPages,
      model: layout.model,
      jobId: layout.jobId,
      at: now().toISOString(),
    })
    rebuilt.warnings.push(...warnings)
    rebuilt.tables = await attachTables(rebuilt.blocks, { pdf, pdfPath, warnings: rebuilt.warnings })
    const input = layout.revision ? await archive.readInput(id, layout.revision).catch(() => null) : null
    const published = await archive.publishDerived(id, rebuilt, { ...(input || {}), source: fingerprint, model: layout.model, jobId: layout.jobId })
    rebuilt.revision = published.revision
    return { ok: true, changed: rebuilt.blocks.length, pages: pdfPages.length, blocks: rebuilt.blocks.length, revision: published.revision }
  }

  function calibrateV1PageY(pageBlocks, lines) {
    if (pageBlocks.length < 4 || lines.length < 4) return null
    const normLines = lines.map(l => ({ key: normalizeForMatch(l.text), cy: (number(l.y) + number(l.y2)) / 2 }))
      .filter(l => l.key.length >= 10)
    const pairs = []
    for (const block of pageBlocks) {
      const box = block?.bbox
      if (!box || number(box.height) > 42) continue
      const key = normalizeForMatch(block.text)
      if (key.length < 10) continue
      const sy = number(box.y) + number(box.height) / 2
      const hits = normLines.filter(l => (l.key === key || (l.key.includes(key) && key.length >= l.key.length * 0.75) ||
        (key.includes(l.key) && l.key.length >= key.length * 0.75)) && Math.abs(l.cy - sy) <= 65)
      if (hits.length === 1) pairs.push({ sy, py: hits[0].cy })
    }
    if (pairs.length < 3) return null
    const rawErrs = pairs.map(p => Math.abs(p.py - p.sy)).sort((a, b) => a - b)
    const rawErr = rawErrs[Math.floor(rawErrs.length / 2)]
    if (rawErr < 6) return null
    const myS = pairs.reduce((s, p) => s + p.sy, 0) / pairs.length
    const myP = pairs.reduce((s, p) => s + p.py, 0) / pairs.length
    const ySpan = Math.max(...pairs.map(p => p.sy)) - Math.min(...pairs.map(p => p.sy))
    let ay = 1
    let ty = myP - myS
    if (ySpan >= 100) {
      const num = pairs.reduce((s, p) => s + (p.sy - myS) * (p.py - myP), 0)
      const den = pairs.reduce((s, p) => s + (p.sy - myS) ** 2, 0)
      const slope = den > 1 ? num / den : 1
      if (slope >= 0.82 && slope <= 1.2) { ay = slope; ty = myP - ay * myS }
    }
    const fitErrs = pairs.map(p => Math.abs(p.py - (ay * p.sy + ty))).sort((a, b) => a - b)
    const fitErr = fitErrs[Math.floor(fitErrs.length / 2)]
    if (fitErr >= rawErr * 0.65 || fitErr > 9) return null
    return { ay, ty }
  }

  function formatAlgorithmPicked(picked) {
    const sorted = [...picked].sort((a, b) => number(a.y) - number(b.y) || number(a.x) - number(b.x))
    const rows = []
    for (const line of sorted) {
      const lx0 = number(line.x), ly0 = number(line.y), lx1 = number(line.x2), ly1 = number(line.y2)
      const h = Math.max(6, ly1 - ly0)
      const prev = rows.at(-1)
      if (prev) {
        const ph = Math.max(6, prev.y1 - prev.y0)
        const ovY = Math.min(prev.y1, ly1) - Math.max(prev.y0, ly0)
        if (ovY / Math.min(ph, h) >= 0.45 && lx0 >= prev.x1 - 8 && lx0 - prev.x1 <= 36) {
          const sep = lx0 - prev.x1 >= 1.6 && !prev.text.endsWith('-') ? ' ' : ''
          prev.text = prev.text + sep + String(line.text || '').trim()
          prev.x1 = Math.max(prev.x1, lx1)
          prev.y0 = Math.min(prev.y0, ly0)
          prev.y1 = Math.max(prev.y1, ly1)
          continue
        }
      }
      rows.push({ x0: lx0, x1: lx1, y0: ly0, y1: ly1, text: String(line.text || '').trim() })
    }
    const nonEmpty = rows.filter(r => r.text)
    if (!nonEmpty.length) return ''
    const minX = Math.min(...nonEmpty.map(r => r.x0))
    return nonEmpty.map(r => '  '.repeat(Math.max(0, Math.min(6, Math.round((r.x0 - minX) / 14)))) + r.text).join('\n')
  }

  /**
   * 用 PDF 文本层重新回填已有 layout.json 的文字（不重新上传、不花钱）。
   * schemaVersion >= 2 且带 raw 归档时，用新版 IR 规则离线重建；
   * schemaVersion 1 时按页面文本行回填并同步修复 UVDoc 偏移、公式行隔离、algorithm 缩进与公式编号绑定。
   */
  async function refillText(id, opts = {}) {
    if (!pdf || typeof pdf.callTool !== 'function') throw new Error('layout 需要 pdf 依赖')
    const layout = await readLayout(id)
    if (!layout) throw new Error('这篇还没有版面解析结果：先点一次「版面」')
    const emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
    if (Number(layout.schemaVersion) >= 2) {
      return refillV2(id, layout, emit)
    }
    const { path: pdfPath } = await store.resolvePdf(id)
    let changed = 0
    const captionByOrder = new Map()
    for (const figure of layout.figures || []) {
      if (figure && figure.captionOrder !== null && figure.captionOrder !== undefined) {
        captionByOrder.set(figure.captionOrder, String(figure.caption || '').trim())
      }
    }
    for (const block of layout.blocks) {
      if (!block || !isCaptionLabel(block.label)) continue
      const caption = captionByOrder.get(block.order)
      if (!caption) continue
      if (String(block.text || '').trim() === caption) continue
      block.text = caption
      changed += 1
    }

    const allByPage = new Map()
    for (const block of layout.blocks) {
      if (!block || typeof block !== 'object') continue
      const page = Math.trunc(number(block.page))
      if (page < 1) continue
      if (!allByPage.has(page)) allByPage.set(page, [])
      allByPage.get(page).push(block)
    }
    let pages = 0
    for (const [page, pageBlocks] of allByPage) {
      const textBlocks = pageBlocks.filter(block => needsPdfText(block.label) && !isCaptionLabel(block.label))
      if (textBlocks.length === 0) continue
      let lines = []
      try {
        const fetched = await pdf.callTool('page_lines', { path: pdfPath, page })
        lines = fetched && Array.isArray(fetched.lines) ? fetched.lines : []
      } catch {
        continue
      }
      if (lines.length === 0) continue
      pages += 1
      const fit = calibrateV1PageY(pageBlocks, lines)
      if (fit) {
        for (const block of pageBlocks) {
          if (!block.bbox) continue
          block.bbox = {
            x: number(block.bbox.x),
            y: round(number(block.bbox.y) * fit.ay + fit.ty),
            width: number(block.bbox.width),
            height: round(Math.max(1, number(block.bbox.height) * fit.ay)),
          }
          changed += 1
        }
      }
      // 保留被公式 / figure 占用的行，避免相邻正文误把整行公式吞进去
      const used = new Set()
      for (const block of pageBlocks) {
        if (!block.bbox) continue
        if (block.kind === 'formula' || block.label === 'formula_number') {
          const bbox = block.bbox
          const rect = [number(bbox.x), number(bbox.y) - 2, number(bbox.x) + number(bbox.width), number(bbox.y) + number(bbox.height) + 2]
          const reserved = pickLinesForRect(rect, lines, used)
          if (block.label === 'formula_number' && reserved.length > 0 && !block.text) {
            block.text = reserved.map(l => String(l.text || '').trim()).join(' ').trim()
          }
        } else if (block.kind === 'figure' || block.kind === 'table') {
          const bbox = block.bbox
          pickLinesForRect([number(bbox.x), number(bbox.y), number(bbox.x) + number(bbox.width), number(bbox.y) + number(bbox.height)], lines, used)
        } else if (isCaptionLabel(block.label)) {
          const bbox = block.bbox
          const pickedCap = pickLinesForRect([number(bbox.x), number(bbox.y) - 2, number(bbox.x) + number(bbox.width), number(bbox.y) + number(bbox.height) + 2], lines, used)
          if (fit && pickedCap.length) {
            const capText = joinLines(pickedCap.map(l => String(l.text || ''))).trim()
            if (capText && !looksBrokenText(capText) && capText !== String(block.text || '').trim()) {
              block.text = capText
              changed += 1
            }
          }
        }
      }
      for (const block of textBlocks) {
        const bbox = block.bbox || {}
        const rect = [number(bbox.x), number(bbox.y) - (fit ? 2 : 0),
          number(bbox.x) + number(bbox.width), number(bbox.y) + number(bbox.height) + (fit ? 3 : 0)]
        const picked = pickLinesForRect(rect, lines, used)
        if (picked.length === 0) continue
        if (block.label === 'algorithm') {
          block.kind = 'algorithm'
          const algoText = formatAlgorithmPicked(picked)
          if (algoText && algoText !== String(block.text || '')) {
            block.text = algoText
            changed += 1
          }
          continue
        }
        const text = joinLines(picked.map(line => String(line.text || ''))).trim()
        if (!text || text === String(block.text || '').trim()) continue
        block.text = text
        changed += 1
      }
      // 绑定 formula_number 到同一水平的 formula，并清理伪小节标题与相邻重复标题/图注
      const pageFormulas = pageBlocks.filter(b => b.kind === 'formula')
      for (const block of pageBlocks) {
        if (block.label === 'formula_number') {
          const byMid = number(block.bbox?.y) + number(block.bbox?.height) / 2
          const fTarget = pageFormulas
            .filter(f => Math.abs((number(f.bbox?.y) + number(f.bbox?.height) / 2) - byMid) <= Math.max(20, number(f.bbox?.height) * 1.25))
            .sort((a, b) => Math.abs((number(a.bbox?.y) + number(a.bbox?.height) / 2) - byMid) - Math.abs((number(b.bbox?.y) + number(b.bbox?.height) / 2) - byMid))[0]
          if (fTarget && String(block.text || '').trim()) {
            fTarget.equationNumber = String(block.text || '').trim()
            block._drop = true
            changed += 1
          }
        } else if (block.kind === 'heading' && block.label === 'paragraph_title') {
          const val = String(block.text || '').trim()
          if (val === '' || /^[a-z]/.test(val) || /[:：,，;；]$/.test(val) || val.length > 120) {
            block.kind = 'body'
            delete block.level
            changed += 1
          }
        }
      }
      emit({ phase: 'text', page, changed })
    }
    const keptBlocks = []
    for (const block of layout.blocks) {
      if (block && block._drop) continue
      const bTrim = String(block?.text || '').trim()
      if (block && block.kind === 'body' && /^Algorithm\s+\d+\s*[:.]/i.test(bTrim) && bTrim.length <= 220 && !bTrim.includes('\n')) {
        block.kind = 'caption'
        changed += 1
      }
      const prev = keptBlocks.at(-1)
      if (prev && prev.page === block.page) {
        const pn = normalizeForMatch(prev.text)
        const bn = normalizeForMatch(block.text)
        const sameText = pn && pn === bn && (pn.length >= 12 || prev.kind === 'heading' || prev.kind === 'caption')
        if (sameText) {
          keptBlocks[keptBlocks.length - 1] = block
          changed += 1
          continue
        }
        if (prev.kind === 'heading' && block.kind === 'body') {
          const hTrim = String(prev.text || '').trim()
          if (hTrim.length >= 6 && bTrim.length >= hTrim.length + 20) {
            const hWords = hTrim.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            const leadRe = hWords.length ? new RegExp('^' + hWords.join('\\s+') + '(?:[:：.]?\\s+)', 'i') : null
            const leadMatch = leadRe && leadRe.exec(bTrim)
            if (leadMatch) {
              const rest = bTrim.slice(leadMatch[0].length).trim()
              if (rest.length >= 20 && /^[A-Z0-9\u4e00-\u9fff]/.test(rest)) {
                block.text = rest
                changed += 1
              }
            }
          }
        }
      }
      keptBlocks.push(block)
    }
    if (keptBlocks.length !== layout.blocks.length) {
      layout.blocks = keptBlocks
    }
    const cleaned = cleanLayoutBlocks(layout.blocks)
    if (cleaned.dropped > 0 || cleaned.merged > 0 || layout.blocks.some((b, i) => b.order !== i)) {
      layout.blocks = cleaned.blocks
      for (const figure of layout.figures || []) {
        if (figure.captionOrder !== null && figure.captionOrder !== undefined) {
          figure.captionOrder = cleaned.orderMap.get(figure.captionOrder) ?? figure.captionOrder
        }
        if (figure.blockIndex !== null && figure.blockIndex !== undefined) {
          figure.blockIndex = cleaned.orderMap.get(figure.blockIndex) ?? figure.blockIndex
        }
      }
      changed += 1
    }
    for (const block of layout.blocks) {
      if (block.kind === 'formula' && block.latex) block.latex = tidyFormulaLatex(block.latex)
    }
    if (changed > 0) {
      layout.at = now().toISOString()
      layout.refilledAt = layout.at
      await store.writeJsonAtomic(store.paperFile(id, LAYOUT_FILE), layout)
    }
    return { ok: true, changed, pages, blocks: (layout.blocks || []).length }
  }

  return { readLayout, readPartial, clearPartial, clearLayout, runLayout, refreshTables, refillText }
}
