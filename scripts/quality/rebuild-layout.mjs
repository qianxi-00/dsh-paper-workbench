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
const dataRoot = dataArg ? dataArg.slice(7) : path.join(os.homedir(), '.dsh', 'paper-workbench')
const apply = args.includes('--apply')
if (!id) {
  console.error('用法：node scripts/quality/rebuild-layout.mjs <paperId> [--data=<数据根>] [--apply]')
  process.exit(2)
}
process.env.DSH_PAPER_WORKBENCH_DATA = dataRoot
const store = await import('../../lib/store.js')
const { createLayoutArchive } = await import('../../lib/layout-archive.js')
const { parseLayoutJsonl } = await import('../../lib/layout.js')
const { buildDocumentLayout } = await import('../../lib/layout-ir.js')

const paperDir = path.join(dataRoot, 'papers', id)
const layoutPath = path.join(paperDir, 'layout.json')
const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'))
if (Number(layout.schemaVersion) !== 2) {
  console.error('这篇不是 schemaVersion 2 页面模型，不能从 raw 重建；请先在面板点「版面」。')
  process.exit(1)
}
const rawDir = path.join(paperDir, 'layout-data', 'raw')
let rawFiles = []
try { rawFiles = fs.readdirSync(rawDir).filter(name => name.endsWith('.jsonl')) } catch { /* 下面报错 */ }
if (rawFiles.length !== 1) {
  console.error(`需要恰好一个 raw JSONL 才能离线重建（当前 ${rawFiles.length} 个）。`)
  process.exit(1)
}
const archive = createLayoutArchive({ store })
const hash = rawFiles[0].slice(0, -6)
const rawText = await archive.readRaw(id, { hash })
const parsed = parseLayoutJsonl(rawText)
if (parsed.skipped > 0) {
  console.error(`raw 里有 ${parsed.skipped} 个坏页，拒绝重建。`)
  process.exit(1)
}
const pdfPages = layout.pages.map(page => ({
  page: page.n, width: page.width, height: page.height,
  lines: (page.lineAssignments || []).map(a => ({ text: a.text, x: a.bbox.x, y: a.bbox.y, x2: a.bbox.x + a.bbox.width, y2: a.bbox.y + a.bbox.height })),
}))
const pageSizes = layout.pages.map(page => ({ n: page.n, w: page.width, h: page.height }))
const next = buildDocumentLayout({ source: layout.source, pageCount: layout.pageCount, pageSizes, servicePages: parsed.pages, pdfPages, model: layout.model, jobId: layout.jobId, at: new Date().toISOString() })
const counts = {}; for (const block of next.blocks) counts[block.kind] = (counts[block.kind] || 0) + 1
const codes = {}; for (const issue of next.quality.issues || []) codes[issue.code] = (codes[issue.code] || 0) + 1
console.log(JSON.stringify({ paperId: id, pageCount: next.pageCount, blocks: next.blocks.length, kinds: counts, quality: next.quality.status, issues: codes, apply }, null, 2))
if (!apply) {
  console.log('dry-run：没有写入。加 --apply 才发布为新 revision。')
  process.exit(0)
}
const input = await archive.readInput(id, layout.revision)
const result = await archive.publishDerived(id, next, input || {})
await store.clearDocCache(id).catch(() => {})
console.log('已发布新 revision：' + result.revision)
