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
import { looksLikeByline, paragraphKey } from './ai.js'

/** 文件名（和 paper.pdf 放一起，跟着论文目录走）。 */
export const ZH_FILE = 'paper-zh.pdf'

/**
 * 生成时用的「译文指纹」存在这个小文件里：没有它就说不清这份中文版是哪一版译文做的，
 * 只能算过期（提示重新生成），不能假装是最新的。
 */
export const ZH_META = 'paper-zh.json'

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

/** 从文档和译文收集可写回块、缺译文键及不能安全定位的块数。 */
export function zhPayloadFromDoc(doc, trans) {
  const entries = trans && trans.entries && typeof trans.entries === 'object' ? trans.entries : {}
  const pages = new Map()
  let crossPage = 0
  let unlocated = 0
  const missing = new Set()
  for (const paragraph of (doc && doc.paragraphs) || []) {
    if (!paragraph || !REPLACE_KINDS.has(paragraph.kind) || !String(paragraph.text || '').trim() || looksLikeByline(paragraph.text)) continue
    if (paragraph.crossPage === true) {
      crossPage += 1
      continue
    }
    const bbox = Array.isArray(paragraph.bbox) ? paragraph.bbox.map(Number) : []
    const page = Number(paragraph.page)
    if (paragraph.geometryTrusted === false || !Number.isInteger(page) || page < 1 ||
      bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
      unlocated += 1
      continue
    }
    const key = paragraphKey(paragraph)
    if (!key) throw new Error('文档段落没有译文标识，请先重建文档模型')
    const entry = entries[key]
    const zh = entry && typeof entry === 'object' ? entry.zh : entry
    if (typeof zh !== 'string' || zh.trim() === '') {
      missing.add(key)
      continue
    }
    if (!pages.has(page)) pages.set(page, [])
    pages.get(page).push({
      rect: bbox.map(value => Math.round(Number(value) * 100) / 100),
      text: zh.trim(),
      source: String(paragraph.text || ''),
    })
  }
  return {
    pages: [...pages.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, blocks]) => ({ n, blocks })),
    crossPage,
    unlocated,
    missingKeys: [...missing],
  }
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
    const { pages, missingKeys, crossPage, unlocated } = zhPayloadFromDoc(doc, await store.readTrans(id))
    return { missingKeys, crossPage, unlocated, readyBlocks: pages.reduce((sum, page) => sum + page.blocks.length, 0) }
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
    const stale = !meta || meta.complete !== true || String(meta.transHash || '') !== fingerprint || String(meta.docAt || '') !== docAt
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
  async function build(id, options = {}) {
    if (!pdf || typeof pdf.callTool !== 'function') throw new Error('zhpdf 需要 pdf 依赖')
    const doc = options.doc
    if (!doc || !Array.isArray(doc.paragraphs)) throw new Error('还没有文档模型：先打开论文等它解析完')
    const docAt = await docStamp(id)
    const trans = await store.readTrans(id)
    const transHash = transFingerprint(trans)
    const payload = zhPayloadFromDoc(doc, trans)
    if (payload.missingKeys.length) throw new Error('还没有译文：缺少 ' + payload.missingKeys.length + ' 段可写回译文，未生成中文版')
    const pages = payload.pages
    const blocks = pages.reduce((sum, page) => sum + page.blocks.length, 0)
    if (blocks === 0) throw new Error('没有能安全写回原版面的文字，请先检查文档模型和版面解析')
    const { path: pdfPath } = await store.resolvePdf(id)
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
        { timeoutMs: 300000 },
      )
      if (result?.ok !== true) throw new Error('生成中文版失败：' + (result?.error || '未知原因'))
      blocksWritten = Number(result.blocks)
      pagesTotal = Number(result.pages)
      if (blocksWritten !== blocks || result.skipped !== 0 || !Number.isInteger(pagesTotal) || pagesTotal < pages.at(-1).n) {
        throw new Error('有段落无法写回原版面，未替换已有中文版（预期 ' + blocks + ' 段，实际写入 ' + (blocksWritten || 0) + ' 段）')
      }
      if (!(await fsp.stat(staged)).size) throw new Error('生成的中文版为空，未替换已有文件')
      if (docAt !== await docStamp(id) || transHash !== transFingerprint(await store.readTrans(id))) {
        throw new Error('生成期间文档或译文已更新，请重新生成')
      }
      const backup = path.join(dir, 'previous.pdf')
      const hadPrevious = await fsp.copyFile(out, backup).then(() => true, error => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      await fsp.rename(staged, out)
      try {
        await writeMeta(store.paperFile, id, {
          at: new Date().toISOString(), blocks: blocksWritten, pages: pagesTotal, docAt, transHash, complete: true,
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
