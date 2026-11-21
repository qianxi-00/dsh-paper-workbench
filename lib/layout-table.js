/**
 * 结构化表格模型（纯函数，零网络/零 fs）。
 *
 * 为什么单独一个模块：OCR 版面接口（block_content 里的 HTML）和 PyMuPDF 抽出的二维网格
 * 都只是「原始证据」，前端要画表、要核验，必须先变成一个规整、可校验的模型。这里独立实现
 * （不 import lib/layout.js），避免把版面解析的副作用带进纯逻辑。
 *
 * 模型约定：
 *   {
 *     rows: [ { cells: [ { text, rowSpan, colSpan, placeholder? } ] } ],
 *     cols,               // 逻辑列数（每行 cells.length 都等于它）
 *     headerRows,         // 表头行数
 *     source,             // 'service'(HTML) | 'pdf'(grid)
 *     quality: { ok, issues: [] }
 *   }
 *
 * 关键点：rowspan/colspan 会**展开成网格占位**——合并单元格的左上角保留原文与跨度，被它
 * 覆盖的格子填入空占位（placeholder:true），于是每一行都有且只有 cols 个格子，前端可以直接
 * 按下标画，不会错列。占位不是信息：质量统计里不计入「有内容格子」。
 */

const DEFAULT_MAX_ROWS = 400
const DEFAULT_MAX_COLS = 40
/** 单个格子文字超过这个长度基本就是「整段文字被塞进一个格子」的伪表。 */
const MAX_CELL_TEXT = 400
/** 单个单元格的跨度上限，防止畸形 HTML（rowspan=99999）把内存打爆。 */
const MAX_SPAN = 20

function toInt(value, fallback, min, max) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 网格占位：被合并单元格覆盖的位置，不含信息但占一个逻辑列。 */
function placeholder() {
  return { text: '', rowSpan: 1, colSpan: 1, placeholder: true }
}

/**
 * 单次匹配解码 HTML 实体，避免解码结果再次被当成实体处理。&#39;/&apos; 都是单引号。
 */
function decodeEntities(text) {
  return String(text).replace(/&(?:#([0-9]+);?|#x([0-9a-f]+);?|nbsp;|lt;|gt;|quot;|#39;|apos;|amp;)/gi,
    (reference, decimal, hexadecimal) => {
      if (decimal === undefined && hexadecimal === undefined) {
        switch (reference.toLowerCase()) {
          case '&nbsp;': return ' '
          case '&lt;': return '<'
          case '&gt;': return '>'
          case '&quot;': return '"'
          case '&apos;':
          case '&#39;': return "'"
          case '&amp;': return '&'
          default: return reference
        }
      }
      const codePoint = Number.parseInt(decimal || hexadecimal, hexadecimal === undefined ? 10 : 16)
      if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return reference
      }
      return String.fromCodePoint(codePoint)
    })
}

/** 单元格内文：<br> 当换行，其它标签剥成空格，实体解码，逐行压平多余空白。 */
function decodeCellText(inner) {
  const withBreaks = String(inner === undefined || inner === null ? '' : inner)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

/** 读 colspan/rowspan：非法或 <=1 一律当 1，超过 MAX_SPAN 截断。 */
function spanOf(attrs, name) {
  const match = new RegExp(name + '\\s*=\\s*["\']?(\\d+)', 'i').exec(String(attrs || ''))
  const value = match ? Number(match[1]) : 1
  return Number.isFinite(value) && value > 1 ? Math.min(MAX_SPAN, Math.floor(value)) : 1
}

/** 从 HTML 里按出现顺序抽 <tr> 与 <td>/<th>，保留 span 与「是否整行都是表头」。 */
function parseHtmlRows(html) {
  const rows = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells = []
    const cellRe = /<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi
    let cellMatch
    let allHeader = true
    let any = false
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      any = true
      const header = cellMatch[1].toLowerCase() === 'h'
      if (!header) allHeader = false
      cells.push({
        text: decodeCellText(cellMatch[3]),
        rowSpan: spanOf(cellMatch[2], 'rowspan'),
        colSpan: spanOf(cellMatch[2], 'colspan'),
        header,
      })
    }
    rows.push({ cells, allHeader: any && allHeader })
  }
  return rows
}

/** 该行有效宽度 = 最后一个已定义格子的下标 + 1。 */
function widthOf(row) {
  let width = 0
  for (let i = 0; i < row.length; i += 1) if (row[i] !== undefined) width = i + 1
  return width
}

/**
 * 把「原始单元格」展开成规整网格：每个格子的覆盖区都填上占位，保证行内无洞。
 * 返回 { grid, maxWidth }；grid[r][c] 要么是源单元格，要么是占位。
 */
function expandTable(parsedRows) {
  const grid = []
  const ensure = (r) => {
    if (!grid[r]) grid[r] = []
  }
  for (let r = 0; r < parsedRows.length; r += 1) {
    ensure(r)
    let c = 0
    for (const cell of parsedRows[r].cells) {
      while (grid[r][c] !== undefined) c += 1
      const colSpan = Math.max(1, cell.colSpan || 1)
      const rowSpan = Math.max(1, cell.rowSpan || 1)
      grid[r][c] = { text: cell.text, rowSpan, colSpan, header: cell.header === true }
      // 同一行被 colspan 覆盖的列
      for (let dc = 1; dc < colSpan; dc += 1) {
        if (grid[r][c + dc] === undefined) grid[r][c + dc] = placeholder()
      }
      // 下面被 rowspan 覆盖的整块区域
      for (let dr = 1; dr < rowSpan; dr += 1) {
        ensure(r + dr)
        for (let dc = 0; dc < colSpan; dc += 1) {
          if (grid[r + dr][c + dc] === undefined) grid[r + dr][c + dc] = placeholder()
        }
      }
      c += colSpan
    }
  }
  let maxWidth = 0
  for (const row of grid) maxWidth = Math.max(maxWidth, widthOf(row))
  return { grid, maxWidth }
}

/** 去掉尾部全占位的空行（rowspan 越界之类的残留）。 */
function trimEmptyTail(grid) {
  let end = grid.length
  while (end > 0) {
    const row = grid[end - 1] || []
    const hasContent = row.some((cell) => cell && cell.placeholder !== true)
    if (hasContent) break
    end -= 1
  }
  return grid.slice(0, end)
}

/** 由展开后的网格生成最终 rows（每行补足到 cols 个格子）。 */
function gridToRows(grid, cols) {
  const rows = []
  for (const row of grid) {
    const cells = []
    for (let c = 0; c < cols; c += 1) {
      const cell = row[c]
      if (cell === undefined) cells.push(placeholder())
      else cells.push(cell)
    }
    rows.push({ cells })
  }
  return rows
}

/** 合并质量结论：build 阶段的截断问题 + 结构质量一起给出。 */
function mergeQuality(model, buildIssues) {
  const base = tableModelQuality(model)
  const issues = []
  const seen = new Set()
  for (const issue of buildIssues.concat(base.issues)) {
    if (!seen.has(issue)) {
      seen.add(issue)
      issues.push(issue)
    }
  }
  return { ok: issues.length === 0, issues }
}

/**
 * 服务端 HTML（block_content）→ 可核验表格模型。
 * 没有任何 <tr> 时返回 null（不是表格，没有模型可谈）；有行则返回模型，质量问题写进 quality。
 */
export function buildTableModelFromHtml(html, opts = {}) {
  const source = typeof opts.source === 'string' && opts.source.trim() !== '' ? opts.source.trim() : 'service'
  const maxRows = toInt(opts.maxRows, DEFAULT_MAX_ROWS, 2, 10000)
  const maxCols = toInt(opts.maxCols, DEFAULT_MAX_COLS, 2, 500)
  const parsed = parseHtmlRows(String(html === undefined || html === null ? '' : html))
  if (parsed.length === 0) return null

  const buildIssues = []
  const rawRows = parsed.length
  if (rawRows > maxRows) buildIssues.push('行数超过上限（' + rawRows + ' > ' + maxRows + '）')
  const workRows = parsed.slice(0, maxRows)

  const { grid, maxWidth } = expandTable(workRows)
  const trimmed = trimEmptyTail(grid)
  const rawCols = maxWidth
  let cols = Math.min(rawCols, maxCols)
  if (rawCols > maxCols) buildIssues.push('列数超过上限（' + rawCols + ' > ' + maxCols + '）')
  if (cols < 1) cols = 1

  let rows = gridToRows(trimmed, cols)
  if (rows.length > maxRows) {
    rows = rows.slice(0, maxRows)
    if (!buildIssues.some((issue) => issue.startsWith('行数超过上限'))) {
      buildIssues.push('行数超过上限（' + rows.length + ' > ' + maxRows + '）')
    }
  }

  let headerRows = 0
  while (headerRows < workRows.length && workRows[headerRows].allHeader) headerRows += 1
  if (opts.headerRows !== undefined) headerRows = toInt(opts.headerRows, headerRows, 0, rows.length)
  headerRows = Math.min(headerRows, rows.length)

  const model = { rows, cols, headerRows, source, quality: { ok: true, issues: [] } }
  model.quality = mergeQuality(model, buildIssues)
  return model
}

/**
 * PyMuPDF 抽出的二维文本网格（rows 数组，无 span）→ 同一个表格模型。
 * 全空的尾行会被丢弃（PyMuPDF 常在表下方留空行）；headerRows 由调用方/opts 指定。
 */
export function buildTableModelFromGrid(rows, opts = {}) {
  const source = typeof opts.source === 'string' && opts.source.trim() !== '' ? opts.source.trim() : 'pdf'
  const maxRows = toInt(opts.maxRows, DEFAULT_MAX_ROWS, 2, 10000)
  const maxCols = toInt(opts.maxCols, DEFAULT_MAX_COLS, 2, 500)
  const input = Array.isArray(rows) ? rows : []
  if (input.length === 0) return null

  const buildIssues = []
  // 先按「至少有一个非空格子」过滤空行，再套行列上限。
  const useful = []
  for (const raw of input) {
    const list = Array.isArray(raw) ? raw : []
    const cells = list.map((cell) => String(cell === undefined || cell === null ? '' : cell).trim())
    if (cells.some((text) => text !== '')) useful.push(cells)
  }
  if (useful.length === 0) return null

  if (useful.length > maxRows) buildIssues.push('行数超过上限（' + useful.length + ' > ' + maxRows + '）')
  const rawCols = useful.reduce((max, cells) => Math.max(max, cells.length), 0)
  let cols = Math.min(rawCols, maxCols)
  if (rawCols > maxCols) buildIssues.push('列数超过上限（' + rawCols + ' > ' + maxCols + '）')
  if (cols < 1) cols = 1

  const shaped = []
  for (const cells of useful.slice(0, maxRows)) {
    const out = []
    for (let c = 0; c < cols; c += 1) {
      const text = c < cells.length ? cells[c] : ''
      out.push({ text, rowSpan: 1, colSpan: 1 })
    }
    shaped.push({ cells: out })
  }

  let headerRows = toInt(opts.headerRows, 0, 0, shaped.length)
  headerRows = Math.min(headerRows, shaped.length)

  const model = { rows: shaped, cols, headerRows, source, quality: { ok: true, issues: [] } }
  model.quality = mergeQuality(model, buildIssues)
  return model
}

/**
 * 结构可信度：表格最常见的坏法是「整列文字被塞进一个格子」或大面积空表。
 * 只做保守判断——不过就标记 ok:false，让调用方退回「裁剪图 + 文字」，宁可不显示也不误导。
 */
export function tableModelQuality(model) {
  if (!model || !Array.isArray(model.rows)) return { ok: false, issues: ['缺少表格模型'] }
  const rows = model.rows
  const issues = []

  if (rows.length > DEFAULT_MAX_ROWS) issues.push('行数超过上限（' + rows.length + ' > ' + DEFAULT_MAX_ROWS + '）')
  if (rows.length < 2) issues.push('行数不足（' + rows.length + '）')

  const widths = rows.map((row) => (Array.isArray(row && row.cells) ? row.cells.length : 0))
  const cols = Number.isFinite(Number(model.cols)) ? Number(model.cols) : Math.max(0, ...widths)
  if (cols > DEFAULT_MAX_COLS) issues.push('列数超过上限（' + cols + ' > ' + DEFAULT_MAX_COLS + '）')
  if (cols < 2) issues.push('列数不足（' + cols + '）')
  if (widths.some((width) => width !== cols)) issues.push('每行列数不一致')

  let total = 0
  let filled = 0
  let longest = 0
  for (const row of rows) {
    const cells = Array.isArray(row && row.cells) ? row.cells : []
    for (const cell of cells) {
      total += 1
      if (cell && cell.placeholder !== true && typeof cell.text === 'string' && cell.text.trim() !== '') {
        filled += 1
        longest = Math.max(longest, cell.text.length)
      }
    }
  }
  if (total > 0 && filled / total < 0.3) {
    issues.push('空格子太多（填充率 ' + Math.round((filled / total) * 100) + '%）')
  }
  if (longest > MAX_CELL_TEXT) issues.push('有格子塞了整段文字（最长 ' + longest + ' 字符）')

  return { ok: issues.length === 0, issues }
}
