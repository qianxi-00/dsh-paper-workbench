/**
 * 中文版 PDF：把译文写回原版面，右栏渲染它就和原文逐页对齐。
 *
 * 为什么单独一个模块：它既不是「文档模型」也不是「版面解析」，而是从两者派生出来的一份
 * 输出文件（`papers/<id>/paper-zh.pdf`）。生成是纯本地操作（PyMuPDF，不上传、不花钱），
 * 只有可安全定位的文字块全部具备译文且全部成功写入，才发布新版文件。
 */
import crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { looksLikeByline, paragraphKey, titleKey } from './ai.js'
import { fingerprintPdf } from './layout-archive.js'

/** 文件名（和 paper.pdf 放一起，跟着论文目录走）。 */
export const ZH_FILE = 'paper-zh.pdf'

/**
 * 生成时用的「译文指纹」存在这个小文件里：没有它就说不清这份中文版是哪一版译文做的，
 * 只能算过期（提示重新生成），不能假装是最新的。
 */
export const ZH_META = 'paper-zh.json'
const activeBuilds = (globalThis.__pbZhPdfBuilds ||= new Map())

/** 译文指纹：只算有内容的条目，按 hash 排序，避免对象键顺序影响结果。 */
export function transFingerprint(trans) {
  const entries = trans && trans.entries && typeof trans.entries === 'object' ? trans.entries : {}
  const rows = []
  for (const key of Object.keys(entries).sort()) {
    const value = entries[key]
    const zh = value && typeof value === 'object' ? value.zh : value
    if (typeof zh !== 'string' || zh.trim() === '') continue
    rows.push(key + '\u0000' + zh.trim())
  }
  return crypto.createHash('sha1').update(rows.join('\u0001')).digest('hex').slice(0, 16)
}

async function readMeta(paperFile, id) {
  try {
    const text = await fsp.readFile(paperFile(id, ZH_META), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function writeMeta(paperFile, id, value) {
  const file = paperFile(id, ZH_META)
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, file)
}

/** 哪些段落参与替换：正文类都要，公式/图/表不动（图是位图，公式换了会破坏可读性）。 */
const REPLACE_KINDS = new Set(['body', 'heading', 'caption', 'list', 'footnote'])

const validBox = (box) => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[0] < box[2] && box[1] < box[3]
const normLine = (text) => String(text || '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase()

export function docFingerprint(doc) {
  return crypto.createHash('sha256').update(JSON.stringify({ revision: doc.revision, paragraphs: doc.paragraphs, sections: doc.sections })).digest('hex')
}

/** 只恢复唯一的完整行匹配；不凭相似度或版面框猜测缺失坐标。 */
function matchLocalLines(source, sheets, crossPage) {
  const target = normLine(source)
  if (!target) return null
  const flat = sheets.flatMap(({ page, lines }) => lines.map(line => ({ page, text: line.text, bbox: [line.x, line.y, line.x2, line.y2] })))
    .filter(line => normLine(line.text) && validBox(line.bbox))
  let found = null
  for (let i = 0; i < flat.length && flat[i].page === sheets[0].page; i++) {
    let prefix = ''
    for (let j = i; j < flat.length; j++) {
      prefix += normLine(flat[j].text)
      if (!target.startsWith(prefix)) break
      if (prefix !== target) continue
      if (crossPage !== (flat[i].page !== flat[j].page)) break
      if (found) return null
      found = flat.slice(i, j + 1)
      break
    }
  }
  if (!found) return null
  const groups = new Map()
  for (const { page, text, bbox } of found) {
    const block = groups.get(page)
    if (!block) groups.set(page, { page, text, bbox })
    else {
      block.text += ' ' + text
      block.bbox = [Math.min(block.bbox[0], bbox[0]), Math.min(block.bbox[1], bbox[1]), Math.max(block.bbox[2], bbox[2]), Math.max(block.bbox[3], bbox[3])]
    }
  }
  return [...groups.values()]
}

function splitTranslation(text, fragments) {
  if (fragments.length === 1) return [text]
  const chars = Array.from(text)
  if (chars.length < fragments.length || chars.filter(char => char.trim()).length < fragments.length) return null
  const weights = fragments.map(({ text }) => normLine(text).length)
  const total = weights.reduce((sum, size) => sum + size, 0)
  let start = 0, covered = 0
  const parts = fragments.map((_, i) => {
    covered += weights[i]
    const remain = fragments.length - i - 1
    const end = remain ? Math.min(chars.length - remain, Math.max(start + 1, Math.round(chars.length * covered / total))) : chars.length
    const part = chars.slice(start, end).join('')
    start = end
    return part
  })
  return parts.every(part => part.trim()) ? parts : null
}

function formatIssues(issues) {
  return issues.slice(0, 8).map(({ page, reason }) => `第 ${page || '?'} 页：${reason}`).join('；') + (issues.length > 8 ? `；另有 ${issues.length - 8} 项` : '')
}

/** 从文档和译文收集所有文字目标，不能定位的目标不能当作可忽略项。 */
export function zhPayloadFromDoc(doc, trans, resolved = new Map()) {
  const entries = trans && trans.entries && typeof trans.entries === 'object' ? trans.entries : {}
  const pages = new Map()
  const issues = []
  let crossPage = 0
  let unlocated = 0
  const missing = new Set()
  const targets = new Set()
  const retained = {}
  for (const paragraph of (doc && doc.paragraphs) || []) {
    if (!paragraph || !String(paragraph.text || '').trim()) continue
    if (!REPLACE_KINDS.has(paragraph.kind) || looksLikeByline(paragraph.text)) {
      const kind = looksLikeByline(paragraph.text) ? 'byline' : paragraph.kind
      retained[kind] = (retained[kind] || 0) + 1
      continue
    }
    const key = paragraphKey(paragraph)
    if (!key) throw new Error('文档段落没有译文标识，请先重建文档模型')
    targets.add(key)
    const entry = entries[key]
    const zh = entry && typeof entry === 'object' ? entry.zh : entry
    if (typeof zh !== 'string' || !zh.trim()) missing.add(key)
    const page = Number(paragraph.page)
    const source = String(paragraph.text)
    const fragments = resolved.get(paragraph) || (paragraph.crossPage !== true && paragraph.geometryTrusted !== false && Number.isInteger(page) && page > 0 && validBox(paragraph.bbox) ? [{ page, bbox: paragraph.bbox, text: source }] : null)
    if (paragraph.crossPage === true) crossPage += 1
    if (!fragments?.length) {
      unlocated += 1
      issues.push({ page, reason: paragraph.crossPage === true ? '无法唯一定位跨页段落的原文行' : '无法唯一定位段落的原文行' })
      continue
    }
    if (missing.has(key)) continue
    const chunks = splitTranslation(zh.trim(), fragments)
    if (!chunks) {
      issues.push({ page, reason: '译文无法分配到所有跨页文字块' })
      continue
    }
    fragments.forEach((fragment, i) => {
      if (!pages.has(fragment.page)) pages.set(fragment.page, [])
      pages.get(fragment.page).push({
        rect: fragment.bbox.map(value => Math.round(value * 100) / 100),
        text: chunks[i],
        source: fragment.text,
      })
    })
  }
  let missingTitleCount = 0
  for (const section of doc.sections || []) {
    if (section.synthetic || !String(section.title || '').trim()) continue
    const key = titleKey(section)
    if (!key) continue
    targets.add(key)
    const entry = entries[key]
    const text = typeof entry === 'object' ? entry?.zh : entry
    if (typeof text !== 'string' || !text.trim()) {
      missing.add(key)
      missingTitleCount += 1
    }
  }
  return {
    pages: [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([n, blocks]) => ({ n, blocks })),
    crossPage,
    unlocated,
    issues,
    missingKeys: [...missing],
    targetCount: targets.size,
    missingTitleCount,
    retained,
  }
}

async function recoverGeometry(doc, pdf, pdfPath) {
  const result = new Map()
  const cache = new Map()
  const linesFor = (page) => {
    if (!cache.has(page)) cache.set(page, Promise.resolve().then(() => pdf.pageLines(pdfPath, page)).then(result => result?.ok && Array.isArray(result.lines) ? result.lines : []).catch(() => []))
    return cache.get(page)
  }
  for (const paragraph of doc.paragraphs) {
    if (!paragraph || !REPLACE_KINDS.has(paragraph.kind) || !String(paragraph.text || '').trim() || looksLikeByline(paragraph.text)) continue
    const page = Number(paragraph.page)
    if (!Number.isInteger(page) || page < 1) continue
    const cross = paragraph.crossPage === true
    if (!cross && paragraph.geometryTrusted !== false && validBox(paragraph.bbox)) continue
    const fragments = paragraph.pageFragments
    if (cross && paragraph.geometryTrusted !== false && Array.isArray(fragments) && fragments.length >= 2 && fragments[0].page === page && fragments.every((part, i) => Number.isInteger(part.page) && (!i || part.page === fragments[i - 1].page + 1) && validBox(part.bbox) && normLine(part.text)) && normLine(fragments.map(part => part.text).join('')) === normLine(paragraph.text)) {
      result.set(paragraph, fragments)
      continue
    }
    if (typeof pdf?.pageLines !== 'function') continue
    const sheets = [{ page, lines: await linesFor(page) }]
    if (cross) sheets.push({ page: page + 1, lines: await linesFor(page + 1) })
    const match = matchLocalLines(paragraph.text, sheets, cross)
    if (match) result.set(paragraph, match)
  }
  return result
}

/** 兼容旧调用方：只要 pages。 */
export function zhPagesFromDoc(doc, trans) {
  return zhPayloadFromDoc(doc, trans).pages
}

export function createZhPdf({ store, pdf }) {
  if (!store || typeof store.paperFile !== 'function') throw new Error('zhpdf 需要 store 依赖')
  // status / clear 只碰文件，不需要 pdf；build 里再校验（否则查状态也会报「缺依赖」）

  function fileOf(id) {
    return store.paperFile(id, ZH_FILE)
  }

  async function docStamp(id) {
    return fsp.stat(store.paperFile(id, 'doc.json')).then(stat => String(stat.mtimeMs), error => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
  }

  async function inspect(id, doc) {
    if (!Array.isArray(doc?.paragraphs)) throw new Error('还没有文档模型：先打开论文等它解析完')
    const { path: pdfPath } = await store.resolvePdf(id)
    const resolved = await recoverGeometry(doc, pdf, pdfPath)
    const trans = await store.readTrans(id)
    const { pages, ...coverage } = zhPayloadFromDoc(doc, trans, resolved)
    const source = await fingerprintPdf(pdfPath)
    return { ...coverage, missingCount: coverage.missingKeys.length, readyBlocks: pages.reduce((sum, page) => sum + page.blocks.length, 0), sourceHash: source.sha256, docHash: docFingerprint(doc), transHash: transFingerprint(trans) }
  }

  /** 中文版状态：存在与否、什么时候生成的、和当前译文/文档模型是否对得上。 */
  async function status(id) {
    const file = fileOf(id)
    let stat = null
    try {
      stat = await fsp.stat(file)
    } catch {
      return { exists: false, pages: 0, blocks: 0, at: '', size: 0, stale: false }
    }
    const meta = await readMeta(store.paperFile, id)
    const docAt = await docStamp(id).catch(() => null)
    let fingerprint = ''
    try {
      fingerprint = transFingerprint(await store.readTrans(id))
    } catch {
      fingerprint = ''
    }
    // 三种情况都算过期：没有生成记录（老文件）、译文变了、文档模型重建过
    const sourceHash = await store.resolvePdf(id).then(({ path }) => fingerprintPdf(path)).then(source => source.sha256, () => null)
    const stale = !meta || meta.complete !== true || sourceHash === null || meta.sourceHash !== sourceHash || String(meta.transHash || '') !== fingerprint || String(meta.docAt || '') !== docAt
    return {
      exists: true,
      pages: meta ? Number(meta.pages) || 0 : 0,
      blocks: meta ? Number(meta.blocks) || 0 : 0,
      at: new Date(stat.mtimeMs).toISOString(),
      size: stat.size,
      stale,
    }
  }

  /**
   * 生成（或重新生成）中文版。
   * 返回 {ok, blocks, skipped, pages, path}；没有译文时抛中文错误，让面板提示去翻译。
   */
  function build(id, options = {}) {
    const file = fileOf(id)
    if (!activeBuilds.has(file)) {
      const task = renderPdf(id, options).finally(() => activeBuilds.delete(file))
      activeBuilds.set(file, task)
    }
    return activeBuilds.get(file)
  }

  async function renderPdf(id, options) {
    options.signal?.throwIfAborted()
    if (!pdf || typeof pdf.callTool !== 'function') throw new Error('zhpdf 需要 pdf 依赖')
    const doc = options.doc
    if (!doc || !Array.isArray(doc.paragraphs)) throw new Error('还没有文档模型：先打开论文等它解析完')
    const docAt = await docStamp(id)
    if (options.docHash) {
      const currentDoc = JSON.parse(await fsp.readFile(store.paperFile(id, 'doc.json'), 'utf8'))
      if (docFingerprint(currentDoc) !== options.docHash) throw new Error('文档已更新，请重新生成中文版')
    }
    const trans = await store.readTrans(id)
    const transHash = transFingerprint(trans)
    if (options.transHash && options.transHash !== transHash) throw new Error('译文已更新，请重新生成中文版')
    const { path: pdfPath } = await store.resolvePdf(id)
    const source = await fingerprintPdf(pdfPath)
    if (options.sourceHash && options.sourceHash !== source.sha256 || options.docHash && options.docHash !== docFingerprint(doc)) {
      throw new Error('源 PDF 或文档已更新，请重新生成中文版')
    }
    const payload = zhPayloadFromDoc(doc, trans, await recoverGeometry(doc, pdf, pdfPath))
    if (payload.issues.length) throw new Error('无法完整生成中文版：' + formatIssues(payload.issues))
    if (payload.missingKeys.length) throw new Error('还没有译文：缺少 ' + payload.missingKeys.length + ' 段可写回译文，未生成中文版')
    const pages = payload.pages
    const blocks = pages.reduce((sum, page) => sum + page.blocks.length, 0)
    if (blocks === 0) throw new Error('没有能安全写回原版面的文字，请先检查文档模型和版面解析')
    const out = fileOf(id)
    const dir = await fsp.mkdtemp(path.join(path.dirname(out), '.zhpdf-'))
    const staged = path.join(dir, ZH_FILE)
    let blocksWritten
    let pagesTotal
    let retainBackup = false
    try {
      const result = await pdf.callTool(
        'zhpdf',
        { path: pdfPath, out: staged, pages, lineheight: Number(options.lineheight) || 1.3 },
        { timeoutMs: 300000, signal: options.signal },
      )
      options.signal?.throwIfAborted()
      if (result?.ok !== true) throw new Error('生成中文版失败：' + (result?.error || '未知原因'))
      blocksWritten = Number(result.blocks)
      pagesTotal = Number(result.pages)
      if (blocksWritten !== blocks || result.skipped !== 0 || !Number.isInteger(pagesTotal) || pagesTotal < pages.at(-1).n) {
        const details = Array.isArray(result.failures) && result.failures.length ? '：' + formatIssues(result.failures) : ''
        throw new Error('有段落无法写回原版面，未替换已有中文版（预期 ' + blocks + ' 段，实际写入 ' + (blocksWritten || 0) + ' 段）' + details)
      }
      if (!(await fsp.stat(staged)).size) throw new Error('生成的中文版为空，未替换已有文件')
      const currentSource = await store.resolvePdf(id).then(({ path }) => fingerprintPdf(path))
      if (source.sha256 !== currentSource.sha256 || source.path !== currentSource.path || docAt !== await docStamp(id) || transHash !== transFingerprint(await store.readTrans(id))) {
        throw new Error('生成期间源 PDF、文档或译文已更新，请重新生成')
      }
      const backup = path.join(dir, 'previous.pdf')
      const hadPrevious = await fsp.copyFile(out, backup).then(() => true, error => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      options.signal?.throwIfAborted()
      await fsp.rename(staged, out)
      try {
        await writeMeta(store.paperFile, id, {
          at: new Date().toISOString(), blocks: blocksWritten, pages: pagesTotal, docAt, docHash: docFingerprint(doc), transHash, sourceHash: source.sha256, complete: true,
          crossPage: payload.crossPage, unlocated: payload.unlocated,
        })
      } catch (error) {
        try {
          if (hadPrevious) await fsp.rename(backup, out)
          else await fsp.rm(out, { force: true })
        } catch (rollbackError) {
          // 回滚失败时保留备份，避免 finally 清掉唯一旧文件。
          retainBackup = true
          throw new Error('生成记录保存失败且旧文件恢复失败，请检查磁盘权限；备份保留于 ' + backup, { cause: rollbackError })
        }
        throw new Error('生成记录保存失败，已保留旧版中文版：' + error.message, { cause: error })
      }
    } finally {
      if (!retainBackup) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    return { ok: true, blocks: blocksWritten, skipped: 0, crossPage: payload.crossPage, unlocated: payload.unlocated, pages: pagesTotal, path: out }
  }

  async function clear(id) {
    await fsp.rm(fileOf(id), { force: true }).catch(() => {})
    await fsp.rm(store.paperFile(id, ZH_META), { force: true }).catch(() => {})
    return { ok: true, exists: false }
  }

  async function readFile(id) {
    return fileOf(id)
  }

  return { status, inspect, build, clear, readFile, fileOf }
}
