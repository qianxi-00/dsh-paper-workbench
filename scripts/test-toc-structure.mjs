/** Public IR/doc/PDF seams; all files are synthetic and confined to a temporary directory. */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-toc-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root
process.env.PYTHONUTF8 = '1'
const { buildDocumentLayout } = await import('../lib/layout-ir.js')
const { buildDoc, buildLayoutDoc, mergeBlocks, paragraphHash } = await import('../lib/doc.js')
const { callTool, findPython } = await import('../lib/pdf.js')
after(async () => { await fs.rm(root, { recursive: true, force: true }) })
const raw = (id, label, value, box) => ({ block_id: id, block_label: label, block_content: value, block_bbox: box })
const rows = ['1 Introduction 3', '2 A complete architecture omitted by the service . . . 4', '2.1 Training recipe . . . 7', '3 Evaluation 10']
const line = (value, y, x = 40, x2 = 360) => ({ text: value, x, y, x2, y2: y + 10, size: 10 })
const fixture = (values = rows, service = '1Introduction 3\n24\n2.1Training recipe 7\n3Evaluation 10') => ({
  source: { sha256: 'a'.repeat(64) }, pageCount: 1, pageSizes: [{ n: 1, w: 400, h: 600 }],
  servicePages: [{ n: 1, width: 400, height: 600, blocks: [raw('h', 'paragraph_title', 'Contents', [40, 60, 160, 80]), raw('toc', 'content', service, [35, 95, 370, 220])] }],
  pdfPages: [{ page: 1, width: 400, height: 600, lines: [line('Contents', 65), ...values.map((v, i) => line(v, 100 + 22 * i))] }],
})
const compact = s => s.replace(/\s+/g, '')

test('IR keeps complete PDF contents as separate auditable TOC entries', () => {
  const input = fixture(), copy = structuredClone(input)
  const layout = buildDocumentLayout(input)
  const entries = layout.blocks.filter(b => b.role === 'toc-entry')
  assert.equal(entries.length, 4, 'collapsed PDF candidate must become four entries')
  assert.deepEqual(entries.map(b => b.text), rows)
  assert.deepEqual(entries.map(b => b.kind), ['list', 'list', 'list', 'list'])
  assert.deepEqual(entries.map(b => b.tocLevel), [1, 1, 2, 1])
  assert.deepEqual(entries.map(b => b.tocTargetPage), [3, 4, 7, 10])
  assert.equal(new Set(entries.map(b => b.blockId)).size, 4)
  assert.ok(entries.every(b => b.parentBlockId && b.fragments[0].lineIds.length))
  assert.equal(compact(entries.map(b => b.text).join('')), compact(rows.join('')))
  assert.equal(layout.quality.metrics.assignedLines, 5)
  assert.equal(new Set(layout.pages[0].lineAssignments.map(a => a.lineId)).size, 5)
  assert.ok(layout.pages[0].lineAssignments.every(a => layout.blocks.some(b => b.blockId === a.blockId)))
  const doc = buildLayoutDoc({ layout, meta: {}, pdf: {} })
  assert.equal(doc.paragraphs.filter(p => p.role === 'toc-entry').length, 4)
  assert.deepEqual(doc.sections.map(s => s.title), ['Contents'])
  assert.deepEqual(input, copy)
  assert.deepEqual(buildDocumentLayout(input), layout)
})

test('same-baseline fragments including page labels become one TOC row', () => {
  const input = fixture()
  input.pdfPages[0].lines = [line('Contents', 65), ...rows.flatMap((value, i) => {
    const at = value.lastIndexOf(' ')
    return [line(value.slice(0, at), 100 + i * 22, 40, 300), line(value.slice(at + 1), 100 + i * 22, 345, 360)]
  })]
  const entries = buildDocumentLayout(input).blocks.filter(b => b.role === 'toc-entry')
  assert.deepEqual(entries.map(b => b.text), rows)
  assert.ok(entries.every(b => b.fragments[0].lineIds.length === 2))
})

test('service TOC lines restore line breaks only when every PDF character survives', () => {
  const input = fixture()
  input.pdfPages[0].lines = [line('Contents', 65), line(rows.join(' '), 100)]
  input.servicePages[0].blocks[1].block_content = rows.join('\n')
  const entries = buildDocumentLayout(input).blocks.filter(b => b.role === 'toc-entry')
  assert.deepEqual(entries.map(b => b.text), rows)
  const incomplete = fixture()
  incomplete.pdfPages[0].lines = input.pdfPages[0].lines
  const retained = buildDocumentLayout(incomplete).blocks.find(b => b.sourceBlockIds.includes('toc'))
  assert.equal(compact(retained.text), compact(rows.join('')), 'short service candidate may never replace the complete PDF')
})

test('a complete model TOC is not shortened by an incomplete PDF candidate', () => {
  const input = fixture(rows.slice(0, 3), rows.join('\n'))
  const entries = buildDocumentLayout(input).blocks.filter(b => b.role === 'toc-entry')
  assert.deepEqual(entries.map(b => b.text), rows)
  assert.equal(entries.at(-1).selectedSource, 'service')
  assert.equal(entries.at(-1).geometryTrusted, false)
  assert.equal(entries.at(-1).selectionReason, 'toc-model-line-without-pdf')
  assert.ok(entries.at(-1).quality.issues.some(i => i.code === 'unverified-model-text'))
})

test('TOC-only pages without heading labels do not turn entries into section titles', () => {
  const layout = { blocks: [1, 2].flatMap(page => rows.map((text, i) => ({ kind: 'list', role: 'toc-entry', text, page, blockId: `b-${page}-${i}` }))) }
  const doc = buildLayoutDoc({ layout, meta: {}, pdf: {} })
  assert.deepEqual(doc.sections.map(s => s.title), ['正文'])
  assert.equal(doc.sections[0].synthetic, true)
})

test('model-only Chinese TOC lines keep levels and page targets', () => {
  const input = fixture()
  input.servicePages[0].blocks[0].block_content = '目录'
  input.servicePages[0].blocks[1].block_content = '1 绪论 …… 3\n1.1 研究背景 …… 4\n2 方法 …… 8'
  input.pdfPages[0].lines = []
  const entries = buildDocumentLayout(input).blocks.filter(b => b.role === 'toc-entry')
  assert.deepEqual(entries.map(b => [b.tocLevel, b.tocTargetPage]), [[1, 3], [2, 4], [1, 8]])
})

test('ordinary body lines with numbers stay a single body and retain its hash', () => {
  const values = ['We evaluated 1 model using 3', 'different settings and 4', 'independent datasets in the study.']
  const input = fixture(values, values.join('\n'))
  input.servicePages[0].blocks[0].block_content = 'Results'
  input.servicePages[0].blocks[1].block_label = 'text'
  const layout = buildDocumentLayout(input)
  const body = layout.blocks.find(b => b.sourceBlockIds.includes('toc'))
  assert.equal(body.kind, 'body')
  assert.equal(body.role, undefined)
  assert.equal(body.text, values.join(' '))
  const doc = buildLayoutDoc({ layout, meta: {}, pdf: {} })
  assert.equal(doc.paragraphs.find(p => p.blockId === body.blockId).hash, paragraphHash('body', values.join(' ')))
})

test('Contents context alone does not split ordinary capitalized prose ending in numbers', () => {
  const values = ['We evaluated the model using 3', 'Different settings were tested in 4', 'Independent datasets contributed 5']
  const layout = buildDocumentLayout(fixture(values, values.join('\n')))
  assert.equal(layout.blocks.filter(b => b.role === 'toc-entry').length, 0)
  assert.equal(layout.blocks.find(b => b.sourceBlockIds.includes('toc')).text, values.join(' '))
})

test('legacy layout TOC multiline text projects as entries without fake sections', () => {
  const layout = { blocks: [
    { page: 1, kind: 'heading', text: 'Contents', level: 1 },
    { page: 1, kind: 'body', label: 'content', text: rows.join('\n'), blockId: 'legacy-toc' },
    { page: 2, kind: 'heading', text: '1 Introduction', level: 1 },
  ] }
  const doc = buildLayoutDoc({ layout, meta: {}, pdf: {} })
  assert.equal(doc.paragraphs.filter(p => p.role === 'toc-entry').length, 4)
  assert.deepEqual(doc.sections.map(s => s.title), ['Contents', '1 Introduction'])
})

test('PDF-text contents preserve entry lines while ordinary prose still merges', () => {
  const blocks = [{ text: 'Contents', kind: 'heading', x: 40, y: 60, x2: 160, y2: 75, size: 14 },
    ...rows.map((text, i) => ({ text, kind: 'body', x: 40, y: 100 + i * 12, x2: 360, y2: 110 + i * 12, size: 10 }))]
  const doc = buildDoc({ meta: {}, text: { pages: [{ n: 1, w: 400, h: 600, blocks }] } })
  assert.deepEqual(doc.paragraphs.filter(p => p.role === 'toc-entry').map(p => p.text), rows)
})

test('synthetic fallback is explicit and a real section named 正文 is not synthetic', () => {
  const layout = { blocks: [{ kind: 'body', text: 'Preface.', page: 1 }, { kind: 'heading', text: '正文', page: 1 }, { kind: 'body', text: 'Real body.', page: 1 }] }
  const doc = buildLayoutDoc({ layout, meta: {}, pdf: {} })
  assert.equal(doc.sections[0].synthetic, true)
  assert.notEqual(doc.sections[1].synthetic, true)
})

const titleA = 'Knowing What You Know: A Trait Theory of Reviewer'
const titleB = 'Value in Human-AI Cognitive Systems'
const titleBlocks = [
  { text: titleA, kind: 'heading', x: 137.28, y: 136.69, x2: 476.88, y2: 151.04, size: 14.35 },
  { text: titleB, kind: 'heading', x: 189.13, y: 154.63, x2: 425.04, y2: 168.97, size: 14.35 },
  { text: 'Abstract', kind: 'heading', x: 284.84, y: 283.7, x2: 329.32, y2: 295.65, size: 11.96 },
  { text: 'This is ordinary abstract prose. '.repeat(20), kind: 'body', x: 100, y: 310, x2: 500, y2: 480, size: 10 },
]
test('old split outline uses the single complete visual heading once', () => {
  const doc = buildDoc({ meta: {}, text: { pages: [{ n: 1, w: 612, h: 792, blocks: titleBlocks }] },
    outline: [{ title: titleA, level: 1, page: 1 }, { title: titleB, level: 1, page: 1 }, { title: 'Abstract', level: 2, page: 1 }] })
  assert.deepEqual(doc.sections.map(s => s.title), [titleA + ' ' + titleB, 'Abstract'])
})

test('nearby different numbered headings and separate columns never merge', () => {
  const heading = (text, x, y, x2) => ({ text, kind: 'heading', size: 14, x, y, x2, y2: y + 14 })
  const blocks = [heading('1 Introduction', 40, 100, 180), heading('2 Methods', 40, 117, 180),
    heading('Left heading', 40, 200, 180), heading('Right heading', 240, 217, 380)]
  assert.equal(mergeBlocks([{ n: 1, w: 400, h: 600, blocks }], { bodySize: 10 }).length, 4)
})

test('PDF outline joins the measured multiline title but keeps numbered headings separate', async () => {
  const found = await findPython()
  assert.ok(found, 'Python + PyMuPDF is required by the existing PDF suite')
  const file = path.join(root, 'title-fixture.pdf')
  const create = spawnSync(found.python, ['-c', `import fitz,sys\ndoc=fitz.open()\np=doc.new_page(width=612,height=792)\np.insert_text((137,151),${JSON.stringify(titleA)},fontsize=14.35)\np.insert_text((189,169),${JSON.stringify(titleB)},fontsize=14.35)\np.insert_text((40,240),'1 Introduction',fontsize=14)\np.insert_text((40,257),'2 Methods',fontsize=14)\nfor i in range(24): p.insert_text((40,310+i*13),'Ordinary body text gives a reliable font-size baseline.',fontsize=10)\ndoc.save(sys.argv[1])\ndoc.close()`, file], { encoding: 'utf8' })
  assert.equal(create.status, 0, create.stderr)
  const result = await callTool('outline', { path: file })
  assert.deepEqual(result.items.slice(0, 3).map(i => i.title), [titleA + ' ' + titleB, '1 Introduction', '2 Methods'])
})
