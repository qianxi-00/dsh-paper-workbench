/**
 * 版面模型 → doc / figures 的接线自测（hermetic，不联网）。
 *
 * 用真实 PDF 造一份「合成 layout.json」，验证：
 *  - doc.source === 'layout'、段落 kind/顺序/figureIndex 与 layout 一致；
 *  - 版面与 PDF 对不上（size 变了）时自动退回文本层；
 *  - figures.list 直接用 layout 的图/表清单（不再跑 PyMuPDF 规则）。
 *
 * 运行：node scripts/test-doc-layout.mjs
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SOURCE_PDF = 'G:\\笔记\\LLM知识体系论文\\加速训练\\FlashAttention.pdf'

let passed = 0
let failed = 0
let skipped = 0

function ok(condition, message) {
  if (!condition) throw new Error(message || '断言失败')
}
function eq(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  throw new Error((message ? message + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
}
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + (error && error.message ? error.message : String(error)))
  }
}
function skip(name, reason) {
  skipped += 1
  console.log('SKIP  ' + name + (reason ? '（' + reason + '）' : ''))
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-doc-layout-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root

const store = await import('../lib/store.js')
const docModule = await import('../lib/doc.js')
const figuresModule = await import('../lib/figures.js')
const layoutModule = await import('../lib/layout.js')

let existing = null
try {
  existing = await fsp.stat(SOURCE_PDF)
} catch {
  existing = null
}
if (!existing) {
  skip('版面模型接线', '没有样例 PDF：' + SOURCE_PDF)
  await fsp.rm(root, { recursive: true, force: true })
  console.log(`\n${passed} PASS / ${failed} FAIL / ${skipped} SKIP`)
  process.exit(failed === 0 ? 0 : 1)
}

const copy = path.join(root, 'sample.pdf')
await fsp.copyFile(SOURCE_PDF, copy)
const added = await store.addPaper({ id: 'layout-doc-1', title: '版面样例', srcPath: copy, pageCount: 34, hasText: true })
const id = added.meta.id
const stat = await fsp.stat(copy)

function block(page, kind, label, text, bbox, extra = {}) {
  return { order: 0, page, kind, label, text, bbox, ...extra }
}

const layout = {
  version: 1,
  at: '2026-01-01T00:00:00.000Z',
  model: 'PP-StructureV3',
  jobId: 'job-test',
  source: { size: stat.size, mtimeMs: stat.mtimeMs, path: copy },
  pageCount: 34,
  servicePages: 1,
  warnings: [],
  blocks: [
    block(1, 'heading', 'paragraph_title', '1 Introduction', { x: 72, y: 80, width: 300, height: 16 }, { level: 1 }),
    block(1, 'body', 'text', '第一段正文，讲 attention 为什么慢。', { x: 72, y: 110, width: 480, height: 40 }),
    block(1, 'figure', 'image', '', { x: 72, y: 170, width: 460, height: 200 }, { figureIndex: 0 }),
    block(1, 'caption', 'figure_title', 'Figure 1: IO-aware attention.', { x: 72, y: 378, width: 460, height: 24 }),
    block(1, 'formula', 'formula', '', { x: 120, y: 420, width: 300, height: 40 }, { latex: 'O=\\operatorname{softmax}(QK^{T})V' }),
    block(1, 'heading', 'paragraph_title', '2 Method', { x: 72, y: 480, width: 260, height: 16 }, { level: 1 }),
    block(1, 'table', 'table', 'a | b', { x: 72, y: 520, width: 460, height: 140 }, {
      figureIndex: 1,
      html: '<table><tr><td>a</td><td>b</td></tr></table>',
      table: {
        rows: [
          { cells: [{ text: 'Model', header: true, colspan: 1, rowspan: 1 }, { text: 'WER', header: true, colspan: 1, rowspan: 1 }], header: true },
          { cells: [{ text: 'Paraformer', header: false, colspan: 1, rowspan: 1 }, { text: '5.1', header: false, colspan: 1, rowspan: 1 }], header: false },
        ],
        cols: 2,
        headerRows: 1,
        source: 'pdf',
      },
    }),
    block(1, 'body', 'text', '第二段正文，讲 tiling。', { x: 72, y: 680, width: 480, height: 40 }),
  ],
  figures: [
    { index: 0, page: 1, kind: 'figure', label: 'image', bbox: { x: 72, y: 170, width: 460, height: 200 }, caption: 'Figure 1: IO-aware attention.', captionOrder: 3, blockIndex: 2 },
    { index: 1, page: 1, kind: 'table', label: 'table', bbox: { x: 72, y: 520, width: 460, height: 140 }, caption: '', captionOrder: null, blockIndex: 6 },
  ],
}
await store.writeJsonAtomic(store.paperFile(id, layoutModule.LAYOUT_FILE), layout)

await check('layout.status 能读到摘要', async () => {
  const read = await layoutModule.createLayout({ store, pdf: null, ocr: null }).readLayout(id)
  ok(read && read.blocks.length === 8, '读回的块数不对')
  const summary = layoutModule.layoutSummary(read)
  eq(summary.figures, 2, '图数')
  eq(summary.byKind.heading, 2, '标题数')
})

await check('doc 用版面模型建模', async () => {
  const built = await docModule.getDoc(id)
  ok(built.built === true, '应该现场建模')
  eq(built.doc.source, 'layout', 'doc.source')
  eq(built.doc.layoutAt, layout.at, 'layoutAt 要带上')
  eq(built.doc.paragraphs.length, 8, '段落数应与块数一致')
  eq(built.doc.paragraphs.map(item => item.kind),
    ['heading', 'body', 'figure', 'caption', 'formula', 'heading', 'table', 'body'], '段落 kind 顺序')
  eq(built.doc.paragraphs[2].figureIndex, 0, '图块的 figureIndex')
  eq(built.doc.paragraphs[6].figureIndex, 1, '表格块的 figureIndex')
  eq(built.doc.paragraphs[4].latex, 'O=\\operatorname{softmax}(QK^{T})V', '公式 latex')
  eq(built.doc.paragraphs[6].html.startsWith('<table>'), true, '表格 html')
  eq(built.doc.paragraphs[6].table.rows.length, 2, '表格结构要传到 doc')
  eq(built.doc.paragraphs[6].table.rows[1].cells[1].text, '5.1', '表格单元格文字')
  eq(built.doc.sections.map(section => section.title), ['1 Introduction', '2 Method'], '节标题')
  eq(built.doc.paragraphs.map(item => item.section), ['s1', 's1', 's1', 's1', 's1', 's2', 's2', 's2'], '节归属')
})

await check('第二次读 doc 命中缓存', async () => {
  const again = await docModule.getDoc(id)
  eq(again.built, false, '第二次不应重建')
  eq(again.doc.source, 'layout', '缓存来源')
})

await check('段落 hash 稳定（译文能对上）', async () => {
  const first = await docModule.getDoc(id, { rebuild: true })
  const second = await docModule.getDoc(id, { rebuild: true })
  eq(first.doc.paragraphs.map(item => item.hash), second.doc.paragraphs.map(item => item.hash), '两次重建的 hash')
  const paragraph = first.doc.paragraphs[1]
  eq(paragraph.text, '第一段正文，讲 attention 为什么慢。', '第 2 段的文字')
  ok(paragraph.hash === docModule.paragraphHash(paragraph.kind, paragraph.text),
    '正文 hash 应与纯函数一致：' + JSON.stringify(paragraph.text) + ' ' + paragraph.hash)
})

await check('figures.list 用版面的图/表清单', async () => {
  const figures = await figuresModule.listFigures(id)
  eq(figures.length, 2, '图数')
  eq([figures[0].kind, figures[1].kind], ['figure', 'table'], 'kind')
  eq([figures[0].attachOrder, figures[1].attachOrder], [2, 6], 'attachOrder 指向版面块')
  eq(figures[0].label, 1, '图注编号')
})

await check('版面与 PDF 对不上时退回文本层', async () => {
  // 把 layout.source 改小，模拟「PDF 换过版本」
  const stale = { ...layout, at: '2026-01-02T00:00:00.000Z', source: { ...layout.source, size: 1 } }
  await store.writeJsonAtomic(store.paperFile(id, layoutModule.LAYOUT_FILE), stale)
  docModule.invalidateDocCache(id, { dropDoc: true })
  await new Promise(resolve => setTimeout(resolve, 120))
  const built = await docModule.getDoc(id, { rebuild: true })
  ok(built.doc.source !== 'layout', '过期版面不应被使用，实际 ' + built.doc.source + ' built=' + built.built)
  ok(built.doc.paragraphs.length > 8, '文本层路线段落应远多于 8，实际 ' + built.doc.paragraphs.length)
})

await check('没有 layout.json 时也能正常建模', async () => {
  await layoutModule.createLayout({ store, pdf: null, ocr: null }).clearLayout(id)
  docModule.invalidateDocCache(id, { dropDoc: true })
  await new Promise(resolve => setTimeout(resolve, 120))
  const built = await docModule.getDoc(id, { rebuild: true })
  ok(built.doc.source !== 'layout', '不该再用版面')
  ok(built.doc.sections.length > 1, '文本层路线应有多个节')
})

await store.removePaper(id)
await store.closeDb().catch(() => {})
await fsp.rm(root, { recursive: true, force: true })

console.log(`\n${passed} PASS / ${failed} FAIL / ${skipped} SKIP`)
process.exit(failed === 0 ? 0 : 1)
