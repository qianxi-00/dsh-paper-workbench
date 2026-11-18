#!/usr/bin/env node
/**
 * 批量对文献库中所有 PDF 运行 PP-StructureV3 版面解析（必要时对无文本层扫描件先跑 OCR），
 * 并就地升级旧版 v1 / 重建 doc.json 与 figures.json。
 *
 * 用法：
 *   node scripts/batch-layout.mjs [--concurrency=3] [--refill-existing] [--force] [--no-upgrade-v1] [--dry-run] [--id=<paperId>]
 *
 * 数据目录默认 ~/.dsh/paper-workbench（可通过 DSH_PAPER_WORKBENCH_DATA 覆盖）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import * as store from '../lib/store.js'
import * as pdf from '../lib/pdf.js'
import * as ocr from '../lib/ocr.js'
import { createLayout, readPublishedLayout } from '../lib/layout.js'
import * as doc from '../lib/doc.js'
import * as figures from '../lib/figures.js'

function parseArgs(argv) {
  const opts = {
    concurrency: 3,
    refillExisting: false,
    force: false,
    upgradeV1: true,
    dryRun: false,
    ids: [],
    help: false,
  }
  for (const arg of argv) {
    if (arg.startsWith('--concurrency=')) opts.concurrency = Math.max(1, Math.min(16, Math.trunc(Number(arg.slice(14)) || 3)))
    else if (arg === '--refill-existing') opts.refillExisting = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--no-upgrade-v1') opts.upgradeV1 = false
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg.startsWith('--id=')) opts.ids.push(arg.slice(5).trim())
    else if (arg === '-h' || arg === '--help') opts.help = true
  }
  return opts
}

async function resolveValidPdf(meta) {
  const candidates = [store.paperFile(meta.id, 'paper.pdf'), meta.srcPath ? path.resolve(meta.srcPath) : ''].filter(Boolean)
  for (const file of candidates) {
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat || !stat.isFile() || stat.size === 0) continue
    if (path.extname(file).toLowerCase() === '.pdf') return file
    // 同目录下同名 .pdf 兜底
    const alt = file.replace(/\.[^.]+$/, '.pdf')
    if (alt !== file) {
      const altStat = await fsp.stat(alt).catch(() => null)
      if (altStat && altStat.isFile() && altStat.size > 0) return alt
    }
  }
  return null
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('用法：node scripts/batch-layout.mjs [--concurrency=3] [--refill-existing] [--force] [--no-upgrade-v1] [--dry-run] [--id=<id>]')
    return
  }

  const config = await store.getConfig()
  const token = String((config && config.ocr && config.ocr.token) || '').trim()
  const allPapers = await store.listPapers()
  const targetPapers = opts.ids.length > 0 ? allPapers.filter((p) => opts.ids.includes(p.id)) : allPapers
  const runner = createLayout({ store, pdf, ocr })

  const skipped = []
  const queue = []
  const refillQueue = []

  for (const meta of targetPapers) {
    const pdfPath = await resolveValidPdf(meta)
    if (!pdfPath) {
      skipped.push({ id: meta.id, title: meta.title, reason: '非 PDF 文件或原 PDF 缺失（' + (meta.srcPath || '无路径') + '）' })
      continue
    }
    const existing = await readPublishedLayout(store, meta.id).catch(() => null)
    const schemaVersion = existing ? Number(existing.schemaVersion) || 1 : 0
    if (existing && !opts.force) {
      if (schemaVersion >= 2) {
        if (opts.refillExisting) refillQueue.push({ meta, pdfPath, existing })
        else skipped.push({ id: meta.id, title: meta.title, reason: '已有 schemaVersion ' + schemaVersion + ' 版面' })
        continue
      }
      if (!opts.upgradeV1) {
        if (opts.refillExisting) refillQueue.push({ meta, pdfPath, existing })
        else skipped.push({ id: meta.id, title: meta.title, reason: '已有 v1 版面（--no-upgrade-v1 跳过）' })
        continue
      }
    }
    const hasPartial = Boolean(await runner.readPartial(meta.id).catch(() => null))
    queue.push({ meta, pdfPath, hadV1: schemaVersion === 1, hasPartial })
  }

  queue.sort((a, b) => {
    if (a.hasPartial !== b.hasPartial) return a.hasPartial ? -1 : 1
    return (Number(a.meta.pageCount) || 999) - (Number(b.meta.pageCount) || 999)
  })

  console.log(
    `数据目录: ${store.DATA_ROOT}\n` +
      `总条目: ${targetPapers.length} · 待云端版面解析: ${queue.length} · 离线重填升级(v2): ${refillQueue.length} · 跳过: ${skipped.length} · 并发: ${opts.concurrency}`,
  )
  for (const item of skipped) {
    console.log(`  [跳过] ${item.id} (${item.reason})`)
  }

  if (opts.dryRun) {
    for (const item of refillQueue) console.log(`  [干跑·离线重填] ${item.meta.id}`)
    for (const item of queue) console.log(`  [干跑·云端解析] ${item.meta.id} (${item.meta.pageCount || '?'} 页${item.hadV1 ? ', v1->v2' : ''})`)
    return
  }

  if (queue.length > 0 && !token) {
    throw new Error('未配置 PaddleOCR Token（config.ocr.token），无法执行云端版面解析')
  }

  const results = { ok: 0, refilled: 0, failed: [] }

  // 1. 先跑无需上传的离线 v2 重填升级 + 重建 doc/figures
  for (const item of refillQueue) {
    const id = item.meta.id
    try {
      const res = await runner.refillText(id)
      doc.invalidateDocCache(id)
      await store.clearDocCache(id).catch(() => {})
      await doc.getDoc(id, { rebuild: true })
      await figures.listFigures(id, { refresh: true }).catch(() => {})
      results.refilled += 1
      console.log(`[离线升级 ${results.refilled}/${refillQueue.length}] ${id} · blocks=${res.blocks} revision=${res.revision || '-'}`)
    } catch (error) {
      results.failed.push({ id, stage: 'refill', error: error && error.message ? error.message : String(error) })
      console.error(`[离线升级失败] ${id} · ${error && error.message ? error.message : error}`)
    }
  }

  // 2. 并发跑云端 PP-StructureV3 版面解析 + doc/figures 重建
  let cursor = 0
  const total = queue.length
  let completed = 0

  async function worker() {
    while (cursor < queue.length) {
      const index = cursor++
      const { meta, pdfPath } = queue[index]
      const id = meta.id
      const started = Date.now()
      try {
        // 若确认为无文本层扫描件且尚无 ocr.md，先跑一次 PaddleOCR-VL-1.6
        if (meta.hasText === false) {
          const existingOcr = await store.readOcr(id).catch(() => '')
          if (!existingOcr.trim()) {
            const ocrRes = await ocr.runOcr({
              token,
              model: (config.ocr && config.ocr.model) || 'PaddleOCR-VL-1.6',
              filePath: pdfPath,
              optionalPayload: { useDocOrientationClassify: Boolean(config.ocr && config.ocr.orient), useDocUnwarping: false },
            })
            await store.writeOcr(id, ocrRes.markdown)
          }
        }
        const layout = await runner.runLayout(id, { model: 'PP-StructureV3' })
        doc.invalidateDocCache(id)
        await store.clearDocCache(id).catch(() => {})
        await doc.getDoc(id, { rebuild: true })
        await figures.listFigures(id, { refresh: true }).catch(() => {})
        completed += 1
        results.ok += 1
        const sec = ((Date.now() - started) / 1000).toFixed(1)
        const q = layout.quality ? layout.quality.status : 'unknown'
        console.log(
          `[完成 ${completed}/${total}] ${id} · ${layout.pageCount}p · blocks=${(layout.blocks || []).length} · figures=${(layout.figures || []).length} · quality=${q} · ${sec}s`,
        )
      } catch (error) {
        completed += 1
        const msg = error && error.message ? error.message : String(error)
        results.failed.push({ id, stage: 'layout', error: msg })
        console.error(`[失败 ${completed}/${total}] ${id} · ${msg}`)
      }
    }
  }

  if (queue.length > 0) {
    const workers = Array.from({ length: Math.min(opts.concurrency, queue.length) }, () => worker())
    await Promise.all(workers)
  }

  if (results.failed.length > 0) {
    const retryIds = new Set(results.failed.map((f) => f.id))
    const retryItems = queue.filter((item) => retryIds.has(item.meta.id))
    if (retryItems.length > 0) {
      console.log(`\n开始自动重试 ${retryItems.length} 篇失败/超时论文（将从 layout.partial.json 断点续拉）…`)
      results.failed = []
      queue.length = 0
      queue.push(...retryItems)
      cursor = 0
      completed = 0
      const retryWorkers = Array.from({ length: Math.min(opts.concurrency, queue.length) }, () => worker())
      await Promise.all(retryWorkers)
    }
  }

  console.log('\n==== 批量版面处理汇总 ====')
  console.log(`跳过: ${skipped.length} | 离线升级: ${results.refilled} | 云端解析成功: ${results.ok} | 失败: ${results.failed.length}`)
  if (results.failed.length > 0) {
    for (const item of results.failed) {
      console.log(`  - ${item.id} [${item.stage}]: ${item.error}`)
    }
    process.exitCode = 1
  }
  await store.closeDb().catch(() => {})
}

main().catch(async (error) => {
  console.error('批量版面脚本异常：' + (error && error.stack ? error.stack : error))
  await store.closeDb().catch(() => {})
  process.exit(1)
})
