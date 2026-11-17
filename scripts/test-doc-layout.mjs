/** Layout → doc/figures integration. Synthetic files only; no Python or network. */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-doc-layout-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root
const store = await import('../lib/store.js')
const docModule = await import('../lib/doc.js')
const figuresModule = await import('../lib/figures.js')
const layoutModule = await import('../lib/layout.js')
let passed = 0
let failed = 0
async function check(name, run) {
  try { await run(); passed++; console.log('PASS  ' + name) }
  catch (error) { failed++; console.error('FAIL  ' + name + ': ' + error.message) }
}

try {
  const file = path.join(root, 'synthetic.pdf')
  await fs.writeFile(file, 'Synthetic PDF fingerprint fixture; parser is never invoked.')
  const stat = await fs.stat(file)
  const source = { path: file, size: stat.size, mtimeMs: stat.mtimeMs }
  const id = 'layout-doc-1'
  await store.addPaper({ id, title: 'Synthetic paper', srcPath: file, pageCount: 2, hasText: true })
  await store.writeTextCache(id, { source, pages: [1, 2].map(n => ({ n, w: 600, h: 800, blocks: [
    { kind: 'heading', text: n + ' Section', size: 16, x: 70, y: 80, x2: 400, y2: 100 },
    { kind: 'body', text: 'Fallback text for page ' + n + '.', size: 10, x: 70, y: 120, x2: 500, y2: 160 },
  ] })) })
  const block = (kind, text, extra = {}) => ({ page: 1, kind, text, bbox: { x: 70, y: 100, width: 400, height: 30 }, ...extra })
  let layout = {
    version: layoutModule.LAYOUT_VERSION, revision: 'revision-source', at: '2026-01-01T00:00:00.000Z',
    source, model: 'synthetic', pageCount: 2,
    blocks: [
      block('heading', '1 Introduction', { level: 1 }),
      block('body', 'Source paragraph, fully preserved.'),
      block('figure', '', { figureIndex: 0 }),
      block('caption', 'Figure 1: Synthetic figure.'),
      block('formula', '', { latex: 'O=\\operatorname{softmax}(QK^{T})V' }),
      block('heading', '2 Method', { level: 1, page: 2 }),
      block('table', 'a | b', { page: 2, figureIndex: 1, html: '<table><tr><td>a</td></tr></table>', table: { rows: [{ cells: [{ text: 'a' }] }] } }),
      block('body', 'Second paragraph.', { page: 2 }),
    ].map((value, order) => ({ ...value, order, blockId: 'b-' + order })),
    figures: [
      { index: 0, page: 1, kind: 'figure', bbox: { x: 70, y: 100, width: 400, height: 100 }, caption: 'Figure 1: Synthetic figure.', blockIndex: 2 },
      { index: 1, page: 2, kind: 'table', bbox: { x: 70, y: 100, width: 400, height: 100 }, caption: '', blockIndex: 6 },
    ],
  }
  const saveLayout = () => store.writeJsonAtomic(store.paperFile(id, layoutModule.LAYOUT_FILE), layout)
  await saveLayout()

  await check('projection preserves blockId/revision and legacy paragraph ids', async () => {
    const doc = docModule.buildLayoutDoc({ meta: {}, pdf: {}, layout })
    assert.equal(doc.revision, layout.revision)
    assert.equal(doc.citationVersion, 1)
    assert.deepEqual(doc.paragraphs.map(p => p.blockId), layout.blocks.map(b => b.blockId))
    assert.deepEqual(doc.paragraphs.map(p => p.id), layout.blocks.map((_, i) => 'p' + String(i).padStart(4, '0')))
  })
  await check('legacy layout does not invent source identity', async () => {
    const doc = docModule.buildLayoutDoc({ meta: {}, pdf: {}, layout: { blocks: [block('body', 'Legacy body.')] } })
    assert.equal(doc.revision, null)
    assert.ok(!doc.paragraphs[0].blockId)
  })
  await check('doc preserves layout kinds, sections, formula and table', async () => {
    const { doc, built } = await docModule.getDoc(id)
    assert.equal(built, true)
    assert.equal(doc.source, 'layout')
    assert.deepEqual(doc.paragraphs.map(p => p.kind), layout.blocks.map(b => b.kind))
    assert.equal(doc.paragraphs[2].figureIndex, 0)
    assert.equal(doc.paragraphs[4].latex, layout.blocks[4].latex)
    assert.deepEqual(doc.paragraphs[6].table, layout.blocks[6].table)
    assert.deepEqual(doc.sections.map(s => s.title), ['1 Introduction', '2 Method'])
    assert.deepEqual(doc.paragraphs.map(p => p.section), ['s1', 's1', 's1', 's1', 's1', 's2', 's2', 's2'])
  })
  await check('unchanged layout uses the document cache', async () => {
    assert.equal((await docModule.getDoc(id)).built, false)
  })
  await check('missing citation version invalidates old cache', async () => {
    const cached = await store.readDoc(id)
    delete cached.citationVersion
    await store.writeDoc(id, cached)
    const value = await docModule.getDoc(id)
    assert.equal(value.built, true)
    assert.equal(value.doc.citationVersion, 1)
  })
  await check('missing block identity invalidates otherwise current cache', async () => {
    const cached = await store.readDoc(id)
    delete cached.paragraphs[1].blockId
    await store.writeDoc(id, cached)
    const value = await docModule.getDoc(id)
    assert.equal(value.built, true)
    assert.equal(value.doc.paragraphs[1].blockId, 'b-1')
  })
  await check('revision change invalidates cache even if layout.at is unchanged', async () => {
    layout = { ...layout, revision: 'revision-new' }
    await saveLayout()
    const value = await docModule.getDoc(id)
    assert.equal(value.built, true)
    assert.equal(value.doc.revision, 'revision-new')
  })
  await check('outline and algorithm version changes rebuild once', async () => {
    await store.updateMeta(id, { outline: [{ title: '1 Introduction', page: 1, level: 1 }] })
    assert.equal((await docModule.getDoc(id)).built, true)
    assert.equal((await docModule.getDoc(id)).built, false)
    const cached = await store.readDoc(id)
    await store.writeDoc(id, { ...cached, layoutBuild: 'old-build' })
    assert.equal((await docModule.getDoc(id)).built, true)
  })
  await check('explicit rebuild preserves paragraph hashes', async () => {
    const first = await docModule.getDoc(id, { rebuild: true })
    const second = await docModule.getDoc(id, { rebuild: true })
    assert.equal(second.built, true)
    assert.deepEqual(first.doc.paragraphs.map(p => p.hash), second.doc.paragraphs.map(p => p.hash))
  })
  await check('figures use published layout instead of a prior PDF cache', async () => {
    await store.writeJsonAtomic(store.paperFile(id, 'figures.json'), { version: 1, source, figures: [{ index: 9, page: 1 }] })
    const figures = await figuresModule.listFigures(id)
    assert.deepEqual(figures.map(f => f.kind), ['figure', 'table'])
    assert.deepEqual(figures.map(f => f.attachOrder), [2, 6])
  })
  await check('stale layout falls back to synthetic text without invoking a parser', async () => {
    layout = { ...layout, source: { ...source, size: 1 } }
    await saveLayout()
    const { doc } = await docModule.getDoc(id, { rebuild: true })
    assert.equal(doc.source, 'pdf-text')
    assert.ok(doc.paragraphs.some(p => p.text.includes('Fallback text')))
    assert.ok(doc.paragraphs.every(p => !p.blockId))
  })
} finally {
  await store.closeDb().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
}
console.log(`${passed} PASS / ${failed} FAIL`)
process.exitCode = failed ? 1 : 0
