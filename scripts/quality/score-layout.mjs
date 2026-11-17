#!/usr/bin/env node
/**
 * 本地对照基线（不需要云服务）：
 * 用 PDF 文本层的行做参照，算 layout.json 的字符覆盖率、行覆盖率和重复率。
 * 不是人工 gold，不能替代 evaluate.py 的独立评测；只用于同一篇论文的版本对比。
 *
 *   node scripts/quality/score-layout.mjs <paperId> [--data=C:/Users/.../.dsh/paper-workbench]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const id = args.find(a => !a.startsWith('--'))
const dataArg = args.find(a => a.startsWith('--data='))
const dataRoot = dataArg ? dataArg.slice(7) : path.join(os.homedir(), '.dsh', 'paper-workbench')
if (!id) {
  console.error('用法：node scripts/quality/score-layout.mjs <paperId> [--data=<数据根>]')
  process.exit(2)
}

process.env.DSH_PAPER_WORKBENCH_DATA = dataRoot
const paperDir = path.join(dataRoot, 'papers', id)
const layoutPath = path.join(paperDir, 'layout.json')
if (!fs.existsSync(layoutPath)) {
  console.error('找不到 ' + layoutPath)
  process.exit(1)
}
const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'))
const store = await import('../../lib/store.js')
let pdfPath
try {
  pdfPath = (await store.resolvePdf(id)).path
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const { callTool } = await import('../../lib/pdf.js')
const norm = text => String(text || '').normalize('NFC').replace(/\s+/g, '')
const pages = new Map()
for (const block of layout.blocks || []) {
  const n = Number(block.page) || 1
  if (!pages.has(n)) pages.set(n, [])
  pages.get(n).push(String(block.text || block.latex || ''))
}
const pageCount = Number(layout.pageCount) || Math.max(0, ...pages.keys())
let pdfChars = 0
let layoutChars = 0
let lineTotal = 0
let lineHit = 0
let duplicates = 0
const seen = new Set()
for (const blockText of layout.blocks || []) {
  const key = norm(blockText).slice(0, 400)
  if (key.length >= 20) {
    if (seen.has(key)) duplicates += 1
    seen.add(key)
  }
}
for (let n = 1; n <= pageCount; n++) {
  let result
  try {
    result = await callTool('page_lines', { path: pdfPath, page: n })
  } catch (error) {
    console.error('第 ' + n + ' 页取文本层失败：' + error.message)
    continue
  }
  const text = norm((pages.get(n) || []).join('\n'))
  layoutChars += text.length
  for (const line of result.lines || []) {
    const value = norm(line.text)
    if (value.length < 4) continue
    pdfChars += value.length
    lineTotal += 1
    if (text.includes(value)) lineHit += 1
  }
}
const ratio = (a, b) => (b === 0 ? null : Math.round((a / b) * 10000) / 10000)
const report = {
  paperId: id,
  schemaVersion: Number(layout.schemaVersion) || 1,
  revision: layout.revision || '',
  pageCount,
  blocks: (layout.blocks || []).length,
  pdfChars,
  layoutChars,
  charRatio: ratio(layoutChars, pdfChars),
  lineCoverage: ratio(lineHit, lineTotal),
  duplicateRate: ratio(duplicates, Math.max(1, (layout.blocks || []).length)),
  quality: layout.quality ? layout.quality.status : null,
  note: '参照是 PDF 文本层，不是人工 gold；扫描页没有文本层时这些指标不适用。',
}
console.log(JSON.stringify(report, null, 2))
