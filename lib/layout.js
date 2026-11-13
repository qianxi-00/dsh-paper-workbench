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

export const LAYOUT_VERSION = 1
export const LAYOUT_FILE = 'layout.json'
export const LAYOUT_MODEL = 'PP-StructureV3'
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
  table: 'table',
  image: 'figure',
  chart: 'figure',
  algorithm: 'body',
  reference: 'body',
  list: 'body',
  aside_text: 'body',
}

const DROP_LABELS = new Set(['header', 'footer', 'number', 'page_number', 'seal', 'abstract_title'])
const FIGURE_LABELS = new Set(['image', 'chart', 'table'])
const KEEP_EMPTY_KINDS = new Set(['figure', 'table', 'formula'])
const TEXT_LABELS = new Set(['text', 'paragraph_title', 'doc_title', 'figure_title',
  'table_title', 'footnote', 'algorithm', 'reference', 'list', 'aside_text'])

export function labelToKind(label) {
  const key = String(label === undefined || label === null ? '' : label).trim().toLowerCase()
  if (key === '') return null
  if (DROP_LABELS.has(key)) return null
  return KIND_BY_LABEL[key] || 'body'
}

export function isDroppedLabel(label) {
  return DROP_LABELS.has(String(label || '').trim().toLowerCase())
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
  let skipped = 0
  for (const line of String(text === undefined || text === null ? '' : text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      skipped += 1
      continue
    }
    const result = row && row.result && typeof row.result === 'object' ? row.result : row
    const list = result && Array.isArray(result.layoutParsingResults) ? result.layoutParsingResults : []
    if (list.length === 0) {
      skipped += 1
      continue
    }
    for (const item of list) {
      const pruned = item && item.prunedResult && typeof item.prunedResult === 'object'
        ? item.prunedResult
        : item
      if (!pruned || typeof pruned !== 'object') {
        skipped += 1
        continue
      }
      const blocks = Array.isArray(pruned.parsing_res_list) ? pruned.parsing_res_list : []
      pages.push({
        n: pages.length + 1,
        width: number(pruned.width),
        height: number(pruned.height),
        blocks,
      })
    }
  }
  if (pages.length === 0) {
    throw new Error('版面解析失败：返回内容里没有可解析的页')
  }
  return { pages, skipped }
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

  return {
    version: LAYOUT_VERSION,
    at: opts.now || new Date().toISOString(),
    model: String(opts.model || LAYOUT_MODEL),
    jobId: String(opts.jobId || ''),
    source: opts.source || null,
    pageCount: Number(opts.pageCount) || 0,
    servicePages: pages.length,
    warnings,
    blocks,
    figures,
  }
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
async function attachTables(blocks, options) {
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
    for (const block of items) {
      const picked = pickTable(found, block.bbox)
      let model = picked ? gridToTableModel(picked.rows, { headerRows: picked.headerRows, source: 'pdf' }) : null
      if (!model && block.html) model = htmlToTableModel(block.html)
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
export function createLayout(deps = {}) {
  const store = deps.store
  const pdf = deps.pdf
  const ocr = deps.ocr
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()

  if (!store || typeof store.paperFile !== 'function') throw new Error('layout 需要 store 依赖')

  async function readLayout(id) {
    const value = await store.readJson(store.paperFile(id, LAYOUT_FILE), null)
    if (!value || typeof value !== 'object' || !Array.isArray(value.blocks)) return null
    return value
  }

  async function clearLayout(id) {
    const file = store.paperFile(id, LAYOUT_FILE)
    try {
      await fsp.rm(file, { force: true })
      return true
    } catch {
      return false
    }
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
    const pages = []
    const jobs = []
    const warnings = []
    let skipped = 0
    try {
      for (let start = 1; start <= pageCount; start += batchPages) {
        const end = Math.min(pageCount, start + batchPages - 1)
        if (opts.signal && opts.signal.aborted) throw new Error('版面解析已取消')
        const part = path.join(tmpRoot, `p${start}-${end}.pdf`)
        const split = await pdf.callTool('split', { path: pdfPath, from: start, to: end, out: part })
        if (!split || split.ok !== true) throw new Error('切分 PDF 失败：' + ((split && split.error) || '未知原因'))

        emit({ phase: 'submit', start, end, total: pageCount })
        const submitted = await ocr.submitJob({ token, filePath: part, model })
        const jobId = submitted && submitted.jobId
        if (!jobId) throw new Error('提交版面解析失败：响应里没有 jobId')
        jobs.push(jobId)

        const polled = await ocr.pollJob({
          token,
          jobId,
          onProgress: info2 => emit({
            phase: 'poll', jobId, start, end, total: pageCount,
            state: info2.state, extractedPages: info2.extractedPages, totalPages: info2.totalPages,
          }),
        })
        const fetched = await ocr.fetchResults({ jsonUrl: polled.jsonUrl, withRaw: true })
        const parsed = parseLayoutJsonl(fetched.text)
        skipped += parsed.skipped
        if (parsed.pages.length !== end - start + 1) {
          warnings.push(`第 ${start}-${end} 页：服务端返回 ${parsed.pages.length} 页，与上传的 ${end - start + 1} 页不一致，按顺序对齐`)
        }
        for (let index = 0; index < parsed.pages.length; index += 1) {
          const page = parsed.pages[index]
          pages.push({ ...page, n: start + index })
        }
      }

      // 每个块的文字按 bbox 从 PDF 文本层的「行」回填：
      // 行的边界是确定的，块边界可能切在词中间，按行取才不会出现 "y" + "ew years" 这种碎块。
      const textByPage = new Map()
      for (const page of pages) {
        if (opts.signal && opts.signal.aborted) throw new Error('版面解析已取消')
        const size = pageSizes.find(item => Math.trunc(number(item.n)) === page.n) || null
        const scaleX = size && page.width > 0 ? number(size.w) / page.width : 1
        const scaleY = size && page.height > 0 ? number(size.h) / page.height : 1
        const wanted = []
        for (let index = 0; index < page.blocks.length; index += 1) {
          const raw = page.blocks[index] || {}
          if (!needsPdfText(raw.block_label)) continue
          const bbox = Array.isArray(raw.block_bbox) ? raw.block_bbox : []
          if (bbox.length !== 4) continue
          wanted.push({
            index,
            label: String(raw.block_label || '').trim().toLowerCase(),
            serviceText: raw.block_content,
            rect: [number(bbox[0]) * scaleX, number(bbox[1]) * scaleY,
              number(bbox[2]) * scaleX, number(bbox[3]) * scaleY],
          })
        }
        const texts = new Map()
        if (wanted.length > 0) {
          let lines = []
          try {
            const fetched = await pdf.callTool('page_lines', { path: pdfPath, page: page.n })
            lines = fetched && Array.isArray(fetched.lines) ? fetched.lines : []
          } catch (error) {
            warnings.push(`第 ${page.n} 页：取文本层失败（${error && error.message ? error.message : error}），该页改用服务端文字`)
          }
          const used = new Set()
          const pickedByBlock = new Map(wanted.map(block => [block.index, []]))
          const accepts = (block, line) => {
            const [x0, y0, x1, y1] = block.rect
            const lx0 = number(line.x)
            const ly0 = number(line.y)
            const lx1 = number(line.x2)
            const ly1 = number(line.y2)
            const overlapX = Math.max(0, Math.min(x1, lx1) - Math.max(x0, lx0))
            const overlapY = Math.max(0, Math.min(y1, ly1) - Math.max(y0, ly0))
            const lineArea = Math.max(1e-3, (lx1 - lx0) * (ly1 - ly0))
            const covered = (overlapX * overlapY) / lineArea   // 面积覆盖率，不能只看某一轴
            const centre = (lx0 + lx1) / 2 >= x0 && (lx0 + lx1) / 2 <= x1 &&
              (ly0 + ly1) / 2 >= y0 && (ly0 + ly1) / 2 <= y1
            return { ok: covered >= 0.5 || centre, lx0, ly0, lx1, ly1 }
          }
          // 第一遍：块框覆盖到的行
          for (const block of wanted) {
            lines.forEach((line, lineIndex) => {
              if (used.has(lineIndex)) return
              if (!accepts(block, line).ok) return
              used.add(lineIndex)
              pickedByBlock.get(block.index).push(line)
            })
          }
          // 第二遍：版面框之间的缝里的行（模型的块框偶尔会漏掉段落首行）。
          // 只补给「文本层拿到的字明显比服务端少」的邻近块，免得把别的段落的行抢过来。
          const extra = new Map()
          lines.forEach((line, lineIndex) => {
            if (used.has(lineIndex)) return
            const lx0 = number(line.x)
            const lx1 = number(line.x2)
            const ly0 = number(line.y)
            const ly1 = number(line.y2)
            const centreY = (ly0 + ly1) / 2
            const lineHeight = Math.max(1, ly1 - ly0)
            let best = null
            let bestGap = Number.POSITIVE_INFINITY
            for (const block of wanted) {
              // 标题/图注本身就短，不参与补行，否则正文首行会被吸进标题
              if (block.label !== 'text' && block.label !== 'footnote' && block.label !== 'algorithm') continue
              const [x0, y0, x1, y1] = block.rect
              if (x1 < lx0 || x0 > lx1) continue
              const gap = centreY < y0 ? y0 - centreY : (centreY > y1 ? centreY - y1 : 0)
              if (gap > lineHeight * 2.5) continue
              const current = joinLines(pickedByBlock.get(block.index).map(item => item.text))
              const pdfLength = current.length
              const serviceLength = String(block.serviceText || '').length
              if (serviceLength < 60 || pdfLength >= serviceLength * 0.85) continue
              // 只有在「像被截断」时才补：要么开头是小写（丢了段首），要么结尾没标点（丢了段尾）
              const beginsLower = /^[a-z]/.test(current)
              const endsOpen = current !== '' && !/[.!?:;。！？：；”")\]}]$/.test(current)
              if (!beginsLower && !endsOpen) continue
              if (gap < bestGap) {
                bestGap = gap
                best = block
              }
            }
            if (best) {
              used.add(lineIndex)
              if (!extra.has(best.index)) extra.set(best.index, [])
              extra.get(best.index).push(line)
            }
          })
          // 第三遍：段首那行掉进版面框的缝里时，用服务端文字做证据把它补回来。
          // 判据：文本层这段字在服务端文字里不是从 0 开始（说明它前面还有字），
          // 且缝里那行确实是服务端文字开头的一部分。
          for (const block of wanted) {
            if (block.label !== 'text' && block.label !== 'footnote') continue
            const items = pickedByBlock.get(block.index)
            const current = joinLines(items.map(item => item.text))
            const at = missingHeadPosition(block.serviceText, current)
            if (at <= 0) continue
            const prefix = normalizeForMatch(block.serviceText).slice(0, at)
            const [x0, y0, x1] = block.rect
            const blockTop = block.rect[1]
            const candidates = []
            lines.forEach((line, lineIndex) => {
              if (used.has(lineIndex)) return
              const lx0 = number(line.x)
              const lx1 = number(line.x2)
              const ly1 = number(line.y2)
              if (lx1 < x0 || lx0 > x1) return
              if (ly1 > blockTop + 2) return                       // 只补块上方的行
              if (blockTop - ly1 > Math.max(12, (number(line.y2) - number(line.y)) * 3)) return
              const normalized = normalizeForMatch(line.text)
              if (normalized === '' || !prefix.includes(normalized)) return
              candidates.push({ lineIndex, line })
            })
            candidates.sort((a, b) => number(b.line.y) - number(a.line.y))
            for (const candidate of candidates) {
              used.add(candidate.lineIndex)
              items.push(candidate.line)
            }
          }
          for (const [index, items] of pickedByBlock) {
            const all = items.concat(extra.get(index) || [])
            all.sort((a, b) => {
              const ay = number(a.y)
              const by = number(b.y)
              return ay === by ? number(a.x) - number(b.x) : ay - by
            })
            const value = joinLines(all.map(item => item.text))
            if (value !== '') texts.set(index, value)
          }
        }
        textByPage.set(page.n, texts)
        emit({ phase: 'text', page: page.n, total: pageCount })
      }

      const layout = normalizeLayout(pages, {
        pageSizes,
        pageCount,
        model,
        jobId: jobs.join(','),
        source,
        warnings,
        now: now().toISOString(),
        textFor: (pageNumber, blockIndex) => {
          const texts = textByPage.get(pageNumber)
          return texts ? texts.get(blockIndex) || '' : ''
        },
      })
      layout.skipped = skipped
      layout.batchPages = batchPages
      // 表格结构：版面模型只给了「这是表格、在哪」，行列从 PDF 自己要
      layout.tables = await attachTables(layout.blocks, { pdf, pdfPath, warnings: layout.warnings })
      await store.writeJsonAtomic(store.paperFile(id, LAYOUT_FILE), layout)
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
    const resolved = await store.resolvePdf(id)
    const pdfPath = resolved && resolved.path
    if (!pdfPath) throw new Error('找不到这篇的 PDF 文件')
    const warnings = Array.isArray(layout.warnings) ? layout.warnings : []
    for (const block of layout.blocks) delete block.table
    const attached = await attachTables(layout.blocks, { pdf, pdfPath, warnings })
    layout.warnings = warnings
    layout.tables = attached
    await store.writeJsonAtomic(store.paperFile(id, LAYOUT_FILE), layout)
    return { attached, tables: attached, warnings }
  }

  return { readLayout, clearLayout, runLayout, refreshTables }
}
