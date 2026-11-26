#!/usr/bin/env node
/**
 * 用已归档的 PP-StructureV3 raw 重建 schemaVersion 2 页面模型，不重新上传 PDF。
 * 默认 dry-run，只打印摘要；--apply 才发布为新 revision（旧 revision 永久保留）。
 *
 *   node scripts/quality/rebuild-layout.mjs <paperId> [--data=<数据根>] [--apply]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const id = args.find(a => !a.startsWith('--'))
const dataArg = args.find(a => a.startsWith('--data='))
const dataRoot = dataArg ? dataArg.slice(7) : process.env.DSH_PAPER_WORKBENCH_DATA || path.join(os.homedir(), '.dsh', 'paper-workbench')
const apply = args.includes('--apply')
if (!id) {
  console.error('用法：node scripts/quality/rebuild-layout.mjs <paperId> [--data=<数据根>] [--apply]')
  process.exit(2)
}
process.env.DSH_PAPER_WORKBENCH_DATA = dataRoot
const store = await import('../../lib/store.js')
const pdf = await import('../../lib/pdf.js')
const { createLayoutArchive } = await import('../../lib/layout-archive.js')
const { replayLayoutPages, attachTables } = await import('../../lib/layout.js')
const { buildDocumentLayout } = await import('../../lib/layout-ir.js')

const archive = createLayoutArchive({ store })
const layout = await archive.readPublished(id)
if (!layout) {
  console.error('找不到这篇的版面结果。')
  process.exit(1)
}
if (Number(layout.schemaVersion) !== 2) {
  console.error('这篇不是 schemaVersion 2 页面模型，不能从 raw 重建；请先在面板点「版面」。')
  process.exit(1)
}
const servicePages = await replayLayoutPages(layout, ref => archive.readRaw(id, ref))
if (!servicePages.length) {
  console.error('找不到可用的 raw JSONL 归档，无法离线重建。')
  process.exit(1)
}
let pdfPath = ''
try {
  const resolved = await store.resolvePdf(id)
  if (resolved?.path && fs.existsSync(resolved.path)) pdfPath = resolved.path
} catch { /* 无原始 PDF 时回退 lineAssignments */ }
const pdfPages = []
for (const page of layout.pages || []) {
  let lines = null
  if (pdfPath) {
    try {
      const fetched = await pdf.callTool('page_lines', { path: pdfPath, page: page.n })
      if (fetched && Array.isArray(fetched.lines)) lines = fetched.lines
    } catch { /* 回退 lineAssignments */ }
  }
  if (!lines) {
    lines = (page.lineAssignments || []).map(a => ({
      text: a.text,
      x: a.bbox.x,
      y: a.bbox.y,
      x2: a.bbox.x + a.bbox.width,
      y2: a.bbox.y + a.bbox.height,
    }))
  }
  pdfPages.push({ page: page.n, width: page.width, height: page.height, lines })
}
const pageSizes = (layout.pages || []).map(page => ({ n: page.n, w: page.width, h: page.height, rotation: page.rotation }))
const next = buildDocumentLayout({ source: layout.source, pageCount: layout.pageCount, pageSizes, servicePages, pdfPages, model: layout.model, jobId: layout.jobId, at: new Date().toISOString() })
if (pdfPath) {
  next.tables = await attachTables(next.blocks, { pdf, pdfPath, warnings: next.warnings })
}
const counts = {}; for (const block of next.blocks) counts[block.kind] = (counts[block.kind] || 0) + 1
const codes = {}; for (const issue of next.quality.issues || []) codes[issue.code] = (codes[issue.code] || 0) + 1
console.log(JSON.stringify({ paperId: id, pageCount: next.pageCount, blocks: next.blocks.length, kinds: counts, quality: next.quality.status, issues: codes, apply }, null, 2))
if (!apply) {
  console.log('dry-run：没有写入。加 --apply 才发布为新 revision。')
  process.exit(0)
}
const input = await archive.readInput(id, layout.revision)
const previous = await store.readDoc(id)
const meta = await store.getMeta(id)
const { buildLayoutDoc, writeRebuiltDoc } = await import('../../lib/doc.js')
const result = await archive.publishDerived(id, next, input || {})
const doc = buildLayoutDoc({ layout: await archive.readPublished(id), meta, outline: meta.outline || [], pdf: previous?.pdf || null })
await writeRebuiltDoc(id, previous, doc)
await store.closeDb()
console.log('已发布新 revision：' + result.revision)
