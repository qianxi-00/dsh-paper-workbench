/**
 * 中文版 PDF：把译文写回原版面，右栏渲染它就和原文逐页对齐。
 *
 * 为什么单独一个模块：它既不是「文档模型」也不是「版面解析」，而是从两者派生出来的一份
 * 输出文件（`papers/<id>/paper-zh.pdf`）。生成是纯本地操作（PyMuPDF，不上传、不花钱），
 * 但要不要生成由用户决定 —— 段落译文缺失时那一段保留原文，所以它是「部分中文」的页面。
 */
import { promises as fsp } from 'node:fs'

/** 文件名（和 paper.pdf 放一起，跟着论文目录走）。 */
export const ZH_FILE = 'paper-zh.pdf'

/** 哪些段落参与替换：正文类都要，公式/图/表不动（图是位图，公式换了会破坏可读性）。 */
const REPLACE_KINDS = new Set(['body', 'heading', 'caption', 'list', 'footnote'])

/**
 * 从文档模型 + 译文生成 payload。
 * 只带「有译文」的段落：没译文的段落保留英文，页面看起来是混排，但不会丢内容。
 */
export function zhPagesFromDoc(doc, trans) {
  const entries = trans && trans.entries && typeof trans.entries === 'object' ? trans.entries : {}
  const pages = new Map()
  for (const paragraph of (doc && doc.paragraphs) || []) {
    if (!paragraph || !REPLACE_KINDS.has(paragraph.kind)) continue
    const entry = entries[paragraph.hash]
    const zh = entry && typeof entry === 'object' ? entry.zh : entry
    if (typeof zh !== 'string' || zh.trim() === '') continue
    const bbox = Array.isArray(paragraph.bbox) ? paragraph.bbox : null
    if (!bbox || bbox.length !== 4) continue
    const page = Math.max(1, Math.round(Number(paragraph.page) || 1))
    if (!pages.has(page)) pages.set(page, [])
    pages.get(page).push({
      rect: bbox.map(value => Math.round(Number(value) * 100) / 100),
      text: zh.trim(),
      source: String(paragraph.text || ''),
    })
  }
  return [...pages.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, blocks]) => ({ n, blocks }))
}

export function createZhPdf({ store, pdf }) {
  if (!store || typeof store.paperFile !== 'function') throw new Error('zhpdf 需要 store 依赖')
  // status / clear 只碰文件，不需要 pdf；build 里再校验（否则查状态也会报「缺依赖」）

  function fileOf(id) {
    return store.paperFile(id, ZH_FILE)
  }

  /** 中文版状态：存在与否、什么时候生成的、和当前文档模型是否对得上。 */
  async function status(id) {
    const file = fileOf(id)
    let stat = null
    try {
      stat = await fsp.stat(file)
    } catch {
      return { exists: false, pages: 0, at: '', size: 0, stale: false }
    }
    let docStat = null
    try {
      docStat = await fsp.stat(store.paperFile(id, 'doc.json'))
    } catch {
      docStat = null
    }
    return {
      exists: true,
      pages: 0,
      at: new Date(stat.mtimeMs).toISOString(),
      size: stat.size,
      // doc.json 比中文版新 ⇒ 段落/译文变了，页面是旧的
      stale: Boolean(docStat && docStat.mtimeMs > stat.mtimeMs),
    }
  }

  /**
   * 生成（或重新生成）中文版。
   * 返回 {ok, blocks, skipped, pages, path}；没有译文时抛中文错误，让面板提示去翻译。
   */
  async function build(id, options = {}) {
    if (!pdf || typeof pdf.callTool !== 'function') throw new Error('zhpdf 需要 pdf 依赖')
    const doc = options.doc
    if (!doc || !Array.isArray(doc.paragraphs)) throw new Error('还没有文档模型：先打开论文等它解析完')
    const trans = await store.readTrans(id)
    const pages = zhPagesFromDoc(doc, trans)
    const blocks = pages.reduce((sum, page) => sum + page.blocks.length, 0)
    if (blocks === 0) throw new Error('这篇还没有译文：先翻译几段（或整篇），再生成中文版')
    const { path: pdfPath } = await store.resolvePdf(id)
    const out = fileOf(id)
    const result = await pdf.callTool(
      'zhpdf',
      { path: pdfPath, out, pages, lineheight: Number(options.lineheight) || 1.3 },
      { timeoutMs: 300000 },
    )
    if (!result || result.ok !== true) throw new Error('生成中文版失败：' + ((result && result.error) || '未知原因'))
    return { ok: true, blocks: Number(result.blocks) || 0, skipped: Number(result.skipped) || 0, pages: Number(result.pages) || 0, path: out }
  }

  async function clear(id) {
    await fsp.rm(fileOf(id), { force: true }).catch(() => {})
    return { ok: true, exists: false }
  }

  async function readFile(id) {
    return fileOf(id)
  }

  return { status, build, clear, readFile, fileOf }
}
