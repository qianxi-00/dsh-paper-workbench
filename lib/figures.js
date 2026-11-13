/**
 * 配图管线：把 pdf_tool.py 抽出的图片框缓存进论文目录，供正文段落挂接与裁剪预览。
 *
 * 缓存：papers/<id>/figures.json（附源 PDF 的 mtime+size，变了自动重抽）；
 * 裁剪图：papers/<id>/.figures/f<index>.png。
 * 所有盘上路径都走 store.js，DATA_ROOT 可由 DSH_PAPER_WORKBENCH_DATA 覆盖（测试用）。
 *
 * 注意：pdf_tool 只认 raster 图（get_image_info）；LaTeX 里用矢量绘制的图抽不到，
 * 这是契约 §2 明确取的实现方式，不是漏判。
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from './store.js'
import { callTool } from './pdf.js'

export const FIGURES_VERSION = 1
const CACHE_NAME = 'figures.json'
const FIGURE_DIR = '.figures'
const RENDER_SCALE = 2 // 裁剪预览的默认放大倍数（对应 pdf_tool render 的 scale）
const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
const LABEL_RE = /(?:图|圖|\bfig(?:ure)?\.?)\s*([0-9]+|[ivxlcdm]+)/i
const REF_RE = /(?:图|圖|\bfig(?:ure)?\.?)\s*([0-9]+|[ivxlcdm]+)/gi

function round2(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0
}

/** 罗马数字（图注里偶见 Figure IV）转整数；非法返回 null。 */
function parseLabelToken(token) {
  if (/^\d+$/.test(token)) return parseInt(token, 10)
  let total = 0
  let previous = 0
  for (const char of token.toLowerCase().split('').reverse()) {
    const value = ROMAN[char]
    if (!value) return null
    if (value < previous) total -= value
    else {
      total += value
      previous = value
    }
  }
  return total || null
}

/** '图 3' / 'Figure 3' / 'Fig. 3' → 3；认不出返回 null。 */
export function normalizeLabel(text) {
  const match = LABEL_RE.exec(String(text === undefined || text === null ? '' : text))
  return match ? parseLabelToken(match[1]) : null
}

/** 段落里的所有图引用：'图 2 和图 3' → Set{2,3}。 */
function referencesIn(text) {
  const refs = new Set()
  const value = String(text || '')
  REF_RE.lastIndex = 0
  let match = REF_RE.exec(value)
  while (match) {
    const label = parseLabelToken(match[1])
    if (label) refs.add(label)
    match = REF_RE.exec(value)
  }
  return refs
}

/** 段落键：与 lib/ai.js 的 paragraphKey 一致（doc.json 的 hash，小写）；兼容 key/id 兜底。 */
function paragraphKey(paragraph) {
  if (!paragraph || typeof paragraph !== 'object') return ''
  const raw = paragraph.hash !== undefined ? paragraph.hash
    : paragraph.key !== undefined ? paragraph.key : paragraph.id
  return String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase()
}

/** 读盘/调 Python 前统一净化图对象，坏数据直接丢掉。 */
function normalizeFigure(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  const width = Number(raw.width)
  const height = Number(raw.height)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(width > 0) || !(height > 0)) return null
  const label = Number(raw.label)
  return {
    page: Math.max(1, Math.round(Number(raw.page) || 1)),
    x: round2(x),
    y: round2(y),
    x2: round2(Number.isFinite(Number(raw.x2)) ? raw.x2 : x + width),
    y2: round2(Number.isFinite(Number(raw.y2)) ? raw.y2 : y + height),
    width: round2(width),
    height: round2(height),
    index: Math.max(1, Math.round(Number(raw.index) || 1)),
    caption: typeof raw.caption === 'string' && raw.caption.trim() ? raw.caption.trim() : null,
    label: Number.isFinite(label) && label > 0 ? Math.round(label) : null,
  }
}

/**
 * 配图清单：优先读缓存，源 PDF 的 mtime+size 变了（或 refresh）才重抽。
 * 没有 PDF / 论文不存在时返回 []（有旧缓存就返回旧缓存），不抛错。
 */
export async function listFigures(id, opts = {}) {
  const safeId = String(id === undefined || id === null ? '' : id).trim()
  if (!safeId) return []
  const refresh = Boolean(opts && opts.refresh === true)
  let cachePath = null
  try {
    cachePath = store.paperFile(safeId, CACHE_NAME)
  } catch {
    return [] // id 不合法，按「没有这篇论文」处理
  }
  const cached = await store.readJson(cachePath, null)
  const cachedFigures = cached && Array.isArray(cached.figures) ? cached.figures : null

  let resolved = null
  try {
    resolved = await store.resolvePdf(safeId)
  } catch {
    resolved = null
  }
  if (!resolved) return [] // 契约：没有 PDF 就返回空数组（不抛错，也不用旧缓存冒充）

  const stat = await fsp.stat(resolved.path).catch(() => null)
  const source = stat ? { path: resolved.path, size: stat.size, mtimeMs: stat.mtimeMs } : null
  const fresh = Boolean(
    cachedFigures &&
    cached.version === FIGURES_VERSION &&
    source &&
    cached.source &&
    cached.source.path === source.path &&
    cached.source.size === source.size &&
    cached.source.mtimeMs === source.mtimeMs,
  )
  if (!refresh && fresh) return cachedFigures

  const value = await callTool('figures', { path: resolved.path }, { timeoutMs: 60000 })
  const figures = (Array.isArray(value.figures) ? value.figures : [])
    .map(normalizeFigure)
    .filter(Boolean)
  await store.writeJsonAtomic(cachePath, { version: FIGURES_VERSION, source, figures }).catch(() => {
    /* 缓存写失败不影响本次返回 */
  })
  // 图序/裁剪区域可能变了：把指纹写进 .figures/.stamp，figurePath 发现不一致就重渲。
  // 只比 PNG 的 mtime 与 PDF 的 mtime 是看不出来的（重抽时 PDF 没变），会张冠李戴。
  await writeStamp(safeId, { version: FIGURES_VERSION, source, figures }).catch(() => {})
  return figures
}

function rectGap(anchor, box) {
  const dx = Math.max(0, Math.max(anchor.x - box[2], box[0] - anchor.x2))
  const dy = Math.max(0, Math.max(anchor.y - box[3], box[1] - anchor.y2))
  return dx * dx + dy * dy
}

/**
 * 把配图挂到正文段落：
 *   - 有 label：按段落里出现的 `图 N` / `Figure N` / `Fig. N` 匹配，同一张图只归第一次出现的段落；
 *   - 没 label：按「同页、与图片框几何距离最近的段落」兜底；
 *   - caption/heading/formula 段落不参与 label 匹配（图注本身会提 Figure N，不能抢挂）。
 * 返回 { byParagraph: { [段落hash]: Figure[] }, used, unmatched }。
 */
export function assignFigures(doc, figures) {
  const paragraphs = doc && Array.isArray(doc.paragraphs) ? doc.paragraphs : []
  const list = (Array.isArray(figures) ? figures : []).filter((figure) => figure && typeof figure === 'object')
  const byParagraph = {}
  const used = new Set()

  const append = (key, figure) => {
    const bucket = byParagraph[key] || (byParagraph[key] = [])
    bucket.push(figure)
  }

  // ① 先按图注认领：图注段落（kind:'caption'）里写了「Figure 7」，图 7 就应该贴在这段下面。
  //    这比「正文提到 Figure 7」的位置更贴近原文版面，也保证图注与图不分离。
  const captionParagraphs = paragraphs.filter(
    (paragraph) => paragraph && typeof paragraph === 'object' && paragraph.kind === 'caption',
  )
  list.forEach((figure, position) => {
    const label = Number(figure.label)
    if (!Number.isFinite(label) || label <= 0) return
    const page = Math.max(1, Math.round(Number(figure.page) || 1))
    const captionRe = new RegExp('^(?:figure|fig\\.?|table|图|表)\\s*' + Math.round(label) + '\\b', 'i')
    const match = captionParagraphs.find((paragraph) =>
      Number(paragraph.page) === page && captionRe.test(String(paragraph.text || '')))
    if (!match) return
    const key = paragraphKey(match)
    if (!key) return
    used.add(position)
    append(key, figure)
  })

  const bodyParagraphs = paragraphs.filter(
    (paragraph) => paragraph && typeof paragraph === 'object' &&
      (paragraph.kind === undefined || paragraph.kind === 'body'),
  )
  for (const paragraph of bodyParagraphs) {
    const key = paragraphKey(paragraph)
    if (!key) continue
    const refs = referencesIn(paragraph.text)
    if (!refs.size) continue
    list.forEach((figure, position) => {
      if (used.has(position)) return
      const label = Number(figure.label)
      if (!Number.isFinite(label) || label <= 0 || !refs.has(Math.round(label))) return
      used.add(position)
      append(key, figure)
    })
  }

  // 兜底：没有 label 的图，找同一页距离最近的段落
  const byPage = new Map()
  for (const paragraph of paragraphs) {
    if (!paragraph || typeof paragraph !== 'object') continue
    const page = Math.max(1, Math.round(Number(paragraph.page) || 1))
    if (!byPage.has(page)) byPage.set(page, [])
    byPage.get(page).push(paragraph)
  }
  list.forEach((figure, position) => {
    if (used.has(position)) return
    const label = Number(figure.label)
    if (Number.isFinite(label) && label > 0) return // 有 label 但正文没提：保持 unmatched
    const page = Math.max(1, Math.round(Number(figure.page) || 1))
    const candidates = byPage.get(page) || []
    const anchor = {
      x: Number(figure.x) || 0,
      y: Number(figure.y) || 0,
      x2: Number(figure.x2) || (Number(figure.x) || 0) + (Number(figure.width) || 0),
      y2: Number(figure.y2) || (Number(figure.y) || 0) + (Number(figure.height) || 0),
    }
    let best = null
    for (const paragraph of candidates) {
      const key = paragraphKey(paragraph)
      if (!key) continue
      const box = Array.isArray(paragraph.bbox) && paragraph.bbox.length === 4
        ? paragraph.bbox.map(Number)
        : null
      const gap = box ? rectGap(anchor, box) : Number.MAX_SAFE_INTEGER
      const order = Number.isFinite(Number(paragraph.order)) ? Number(paragraph.order) : 0
      if (!best || gap < best.gap || (gap === best.gap && order < best.order)) {
        best = { key, gap, order }
      }
    }
    if (!best) return
    used.add(position)
    append(best.key, figure)
  })

  return {
    byParagraph,
    used: used.size,
    unmatched: list.filter((figure, position) => !used.has(position)),
  }
}

/**
 * index 只按 figures.json 的**数组位置**（0 基）解释 —— 前端拿到的就是 figure.position。
 *
 * 不再「位置找不到就按页面内编号 figures[].index（1 基）再找一次」：两种 1 基/0 基语义混在
 * 一个参数里，会出现「要第 1 张编号图、却拿到数组第 1 张（实际是编号 5）」这种张冠李戴。
 */
async function resolveFigure(id, index) {
  const figures = await listFigures(id)
  const position = Number(index)
  if (Number.isInteger(position) && position >= 0 && position < figures.length) {
    return { figures, figure: figures[position], position }
  }
  throw new Error('没有第 ' + index + ' 张配图（共 ' + figures.length + ' 张，从 0 开始）')
}

function clipOf(figure) {
  return [figure.x, figure.y, figure.width, figure.height]
}

/** 按 figures.json 的 bbox 调 pdf_tool render(clip)，返回 PNG Buffer（临时文件即读即删）。 */
export async function figureBuffer(id, index) {
  const { figure } = await resolveFigure(id, index)
  const resolved = await store.resolvePdf(id)
  const outPath = path.join(os.tmpdir(), 'pb-figure-' + process.pid + '-' + Date.now().toString(36) + '.png')
  try {
    await callTool('render', {
      path: resolved.path,
      page: figure.page,
      scale: RENDER_SCALE,
      out: outPath,
      clip: clipOf(figure),
    }, { timeoutMs: 45000 })
    return await fsp.readFile(outPath)
  } finally {
    await fsp.rm(outPath, { force: true }).catch(() => {})
  }
}

/** 把本次 figures.json 的指纹写进 .figures/.stamp（供 PNG 缓存失效判断）。 */
async function writeStamp(id, value) {
  const dir = path.join(store.paperDir(id), FIGURE_DIR)
  await fsp.mkdir(dir, { recursive: true })
  const stamp = {
    version: value.version,
    source: value.source,
    figures: (value.figures || []).map((figure) => [figure.page, figure.x, figure.y, figure.x2, figure.y2]),
  }
  await store.writeJsonAtomic(path.join(dir, '.stamp'), stamp)
}

async function stampMatches(id) {
  const dir = path.join(store.paperDir(id), FIGURE_DIR)
  const stamp = await store.readJson(path.join(dir, '.stamp'), null).catch(() => null)
  const cached = await store.readJson(path.join(store.paperDir(id), CACHE_NAME), null).catch(() => null)
  if (!stamp || !cached || !Array.isArray(cached.figures)) return false
  const expected = JSON.stringify((cached.figures || []).map((figure) => [figure.page, figure.x, figure.y, figure.x2, figure.y2]))
  return JSON.stringify(stamp.figures || null) === expected && stamp.version === FIGURES_VERSION
}

/** 裁剪图缓存到 papers/<id>/.figures/f<index>.png，返回绝对路径；PDF 或图序变了就重渲。 */
export async function figurePath(id, index) {
  const { figure, position } = await resolveFigure(id, index)
  const resolved = await store.resolvePdf(id)
  const dir = path.join(store.paperDir(id), FIGURE_DIR)
  const file = path.join(dir, 'f' + position + '.png')
  const [existing, pdfStat] = await Promise.all([
    fsp.stat(file).catch(() => null),
    fsp.stat(resolved.path).catch(() => null),
  ])
  const stamp = existing && existing.size > 0 ? await stampMatches(id) : false
  if (existing && existing.size > 0 && stamp && (!pdfStat || existing.mtimeMs >= pdfStat.mtimeMs)) return file
  await fsp.mkdir(dir, { recursive: true })
  await callTool('render', {
    path: resolved.path,
    page: figure.page,
    scale: RENDER_SCALE,
    out: file,
    clip: clipOf(figure),
  }, { timeoutMs: 45000 })
  return file
}
