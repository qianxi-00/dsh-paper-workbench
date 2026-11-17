// Fixed text/rectangles exercise the public seam; no PDF, storage or network.
import assert from 'node:assert/strict'
import { test } from 'node:test'
const mod = await import('../lib/layout-ir.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})
const build = input => {
  assert.equal(typeof mod.buildDocumentLayout, 'function', 'buildDocumentLayout is the synchronous public seam')
  return mod.buildDocumentLayout(input)
}
const raw = (id, label, text, bbox, extra = {}) => ({ block_id: id, block_label: label, block_content: text, block_bbox: bbox, ...extra })
const line = (text, x = 10, y = 20, x2 = 190, y2 = 32) => ({ text, x, y, x2, y2, size: 12 })
const fixture = (blocks, lines = [], extra = {}) => ({
  source: { sha256: 'a'.repeat(64) }, pageCount: 1, pageSizes: [{ n: 1, w: 400, h: 600 }],
  servicePages: [{ n: 1, width: 400, height: 600, blocks }],
  pdfPages: [{ page: 1, width: 400, height: 600, lines }], ...extra,
})

test('PDF spelling wins but conflicting sources remain reviewable and immutable', () => {
  const input = fixture([raw('p', 'text', 'The model counts toknes.', [10, 20, 200, 40])], [line('The model counts tokens.')])
  const copy = structuredClone(input)
  const result = build(input)
  assert.equal(result.version, 1)
  assert.equal(result.schemaVersion, 2)
  assert.equal(result.blocks[0].text, 'The model counts tokens.')
  assert.equal(result.blocks[0].selectedSource, 'pdf')
  assert.equal(result.blocks[0].quality.status, 'needs_review')
  assert.deepEqual(result.blocks[0].quality.summary, { blocking: 0, informational: 1 })
  assert.deepEqual(result.pages[0].quality.summary, { blocking: 0, informational: 1 })
  assert.deepEqual(result.quality.summary, { blocking: 0, informational: 1 })
  assert.deepEqual(result.blocks[0].candidates.map(c => [c.source, c.text, c.score]), [
    ['service', 'The model counts toknes.', null], ['pdf', 'The model counts tokens.', null],
  ])
  assert.ok(result.blocks[0].selectionReason)
  assert.deepEqual(input, copy)
})

test('same input is deterministic and timestamps do not alter revision', () => {
  const input = fixture([raw('p', 'text', 'Exact text.', [10, 20, 200, 40])], [line('Exact text.')])
  assert.deepEqual(build(input), build(input))
  assert.equal(build({ ...input, at: 'before' }).revision, build({ ...input, at: 'after' }).revision)
})

test('complete service caption beats a clipped PDF suffix', () => {
  const r = build(fixture([raw('cap', 'figure_title', 'Figure 2. The complete caption describes the result.', [10, 20, 200, 50])], [line('describes the result.')]))
  const b = r.blocks[0]
  assert.equal(b.text, 'Figure 2. The complete caption describes the result.')
  assert.equal(b.selectedSource, 'service')
  assert.equal(b.candidates.length, 2)
  assert.match(b.selectionReason, /complete/)
})

test('scanned-page VL text beats garbled structure text without invented confidence', () => {
  const r = build(fixture([raw('scan', 'text', '� � � �', [10, 20, 200, 50])], [], {
    supplementaryPages: [{ n: 1, width: 400, height: 600, rawRef: 'raw-vl', blocks: [raw('vl', 'text', 'Readable scanned paragraph.', [10, 20, 200, 50], { score: 0.84 })] }],
  }))
  assert.equal(r.blocks.length, 1)
  assert.equal(r.blocks[0].text, 'Readable scanned paragraph.')
  assert.equal(r.blocks[0].selectedSource, 'vl')
  assert.deepEqual(r.blocks[0].candidates.map(c => c.score), [null, 0.84])
  assert.equal(r.blocks[0].quality.status, 'needs_review')
  assert.ok(r.blocks[0].quality.issues.some(i => i.code === 'garbled-candidate'))
})

test('heading level is computed after the winning text is known', () => {
  const r = build(fixture([raw('h', 'paragraph_title', '2.3 Method', [10, 20, 200, 50])], [line('2.3 Method')]))
  assert.equal(r.blocks[0].kind, 'heading')
  assert.equal(r.blocks[0].level, 2)
})

test('overlong PDF caption loses to a shorter complete model caption', () => {
  const r = build(fixture([raw('cap', 'figure_title', 'Figure 1: Overview.', [10, 20, 200, 50])],
    [line('Figure 1: Overview. (a) Input (b) Output (c) Encoder')]))
  assert.equal(r.blocks[0].text, 'Figure 1: Overview.')
  assert.equal(r.blocks[0].selectedSource, 'service')
})

test('readable PDF caption can beat a model spelling mistake', () => {
  const r = build(fixture([raw('cap', 'figure_title', 'Figure 4. Token coutns.', [10, 20, 200, 50])], [line('Figure 4. Token counts.')]))
  assert.equal(r.blocks[0].text, 'Figure 4. Token counts.')
  assert.equal(r.blocks[0].selectedSource, 'pdf')
})

test('unmatched body lines survive with one auditable owner', () => {
  const r = build(fixture([raw('p', 'text', 'First paragraph.', [10, 20, 200, 40])], [line('First paragraph.'), line('Model omitted this paragraph.', 10, 80, 250, 92)]))
  assert.deepEqual(r.blocks.map(b => b.text), ['First paragraph.', 'Model omitted this paragraph.'])
  assert.equal(r.blocks[1].quality.status, 'needs_review')
  assert.equal(r.pages[0].lineAssignments.length, 2)
  assert.equal(new Set(r.pages[0].lineAssignments.map(a => a.lineId)).size, 2)
  assert.equal(r.pages[0].unassignedLineIds.length, 0)
  assert.equal(r.quality.metrics.pdfLines, 2)
  assert.equal(r.quality.metrics.assignedLines, 2)
})

test('line ownership uses characters and geometry, independent of model array order', () => {
  const wrong = raw('wrong', 'text', 'Unrelated content here.', [8, 18, 202, 44])
  const right = raw('right', 'text', 'Stable ownership.', [10, 20, 200, 40])
  const a = build(fixture([wrong, right], [line('Stable ownership.')]))
  const b = build(fixture([right, wrong], [line('Stable ownership.')]))
  const owner = r => r.blocks.find(block => block.blockId === r.pages[0].lineAssignments[0].blockId)
  assert.deepEqual(owner(a).sourceBlockIds, ['right'])
  assert.equal(owner(a).blockId, owner(b).blockId)
  assert.equal(a.pages[0].lineAssignments.length, 1)
})

test('figure labels do not leak into overlapping body candidate text', () => {
  const r = build(fixture([
    raw('body', 'text', 'Actual body remains.', [0, 0, 350, 300]), raw('fig', 'image', '', [10, 20, 200, 120]),
  ], [line('Encoder'), line('Actual body remains.', 10, 180, 220, 192)]))
  assert.equal(r.blocks.find(b => b.sourceBlockIds.includes('body')).text, 'Actual body remains.')
  const labelOwner = r.pages[0].lineAssignments.find(a => a.role === 'figure-internal')
  assert.ok(labelOwner)
  assert.equal(r.blocks.find(b => b.blockId === labelOwner.blockId).kind, 'figure')
})

test('text repair changes content hash while preserving block and page identity', () => {
  const a = build(fixture([raw('stable', 'text', 'Original spelling.', [10, 20, 200, 40])]))
  const b = build(fixture([raw('stable', 'text', 'Corrected spelling.', [10, 20, 200, 40])]))
  assert.equal(a.blocks[0].blockId, b.blocks[0].blockId)
  assert.equal(a.blocks[0].pageId, b.blocks[0].pageId)
  assert.notEqual(a.blocks[0].sourceHash, b.blocks[0].sourceHash)
  assert.notEqual(a.revision, b.revision)
})

test('known isotropic service coordinates are transformed and recorded', () => {
  const r = build(fixture([], [line('Scaled text.')], { servicePages: [{ n: 1, width: 800, height: 1200, blocks: [raw('scaled', 'text', 'Scaled text.', [20, 40, 400, 80])] }] }))
  assert.deepEqual(r.blocks[0].bbox, { x: 10, y: 20, width: 190, height: 20 })
  assert.deepEqual(r.pages[0].transforms.service.matrix, [0.5, 0, 0, 0.5, 0, 0])
  assert.equal(r.pages[0].status, 'ready')
})

test('bad dimensions never publish an invented anisotropic transform', () => {
  const r = build(fixture([], [line('Visible original text.')], { servicePages: [{ n: 1, width: 1200, height: 400, blocks: [raw('bad', 'text', 'Service text.', [10, 20, 200, 40])] }] }))
  assert.equal(r.pages[0].status, 'needs_review')
  assert.deepEqual(r.pages[0].fallback, { kind: 'original-page', page: 1 })
  assert.equal(r.pages[0].transforms.service.matrix, null)
  assert.ok(r.blocks.some(b => b.text === 'Visible original text.'))
  assert.ok(r.pages[0].quality.issues.some(i => i.code === 'unknown-coordinate-transform' && i.page === 1))
})

test('missing middle page retains its position and original-page fallback', () => {
  const r = build(fixture([], [], { pageCount: 3, pageSizes: [{ n: 1, w: 400, h: 600 }, { n: 2, w: 400, h: 600 }, { n: 3, w: 400, h: 600 }],
    servicePages: [{ n: 1, width: 400, height: 600, blocks: [] }, { n: 3, width: 400, height: 600, blocks: [] }], pdfPages: [] }))
  assert.deepEqual(r.pages.map(p => p.n), [1, 2, 3])
  assert.equal(r.pages[1].status, 'failed')
  assert.deepEqual(r.pages[1].fallback, { kind: 'original-page', page: 2 })
  assert.ok(r.quality.issues.some(i => i.page === 2 && i.code === 'missing-page'))
})

test('missing size and unknown preprocessing rotation cannot be ready', () => {
  const noSize = build(fixture([raw('p', 'text', 'No size.', [10, 20, 200, 40])], [], { pageSizes: [], pdfPages: [] }))
  assert.equal(noSize.pages[0].status, 'needs_review')
  assert.ok(noSize.pages[0].fallback)
  const rotated = build(fixture([], [], { servicePages: [{ n: 1, width: 400, height: 600, raw: { doc_preprocessor_res: { angle: 90 } }, blocks: [raw('p', 'text', 'Rotated.', [10, 20, 200, 40])] }] }))
  assert.equal(rotated.pages[0].transforms.service.matrix, null)
  assert.equal(rotated.pages[0].status, 'needs_review')
})

test('invalid PDF rectangles keep their text in a review block', () => {
  const r = build(fixture([], [{ text: 'Text with an invalid rectangle.', x: 10, y: 20, x2: NaN, y2: 32 }]))
  assert.equal(r.blocks[0].text, 'Text with an invalid rectangle.')
  assert.ok(r.blocks[0].quality.issues.some(i => i.code === 'invalid-line-bbox'))
  assert.equal(r.pages[0].lineAssignments.length, 1)
})

test('unknown labels survive and header exclusions retain original block and line reason', () => {
  const r = build(fixture([
    raw('u', 'future_label', 'Unfamiliar structured text.', [10, 20, 200, 40]),
    raw('h', 'header', 'Running header', [10, 2, 200, 14]),
  ], [line('Running header', 10, 2, 190, 14), line('Unfamiliar structured text.')]))
  assert.equal(r.blocks.find(b => b.label === 'future_label').text, 'Unfamiliar structured text.')
  assert.ok(r.excluded.some(e => e.reason === 'page-decoration' && e.block.sourceBlockIds.includes('h')))
  assert.ok(r.pages[0].lineAssignments.some(a => a.reason === 'page-decoration' && a.excluded))
  assert.equal(r.pages[0].lineAssignments.length, 2)
})

test('source refs, original order and table metadata are passed through without parsing HTML', () => {
  const table = { cells: [{ row: 0, col: 0, text: 'A', rowspan: 2 }] }
  const r = build(fixture([], [], { rawRefs: ['raw-manifest'], servicePages: [{ n: 1, width: 400, height: 600, rawRef: 'raw-structure', blocks: [raw('t', 'table', '<table><tr><td>A</td></tr></table>', [10, 20, 200, 80], { block_order: 7, table })] }] }))
  assert.equal(r.blocks[0].html, '<table><tr><td>A</td></tr></table>')
  assert.deepEqual(r.blocks[0].table, table)
  assert.equal(r.blocks[0].sourceOrder, 7)
  assert.deepEqual(r.rawRefs, ['raw-manifest', 'raw-structure'])
})

test('native-to-rendered metadata never transforms already rendered PDF lines again', () => {
  const r = build(fixture([raw('p', 'text', 'Rendered coordinates.', [10, 20, 200, 40])], [line('Rendered coordinates.')], {
    pageSizes: [{ n: 1, w: 400, h: 600, rotation: 90, nativeToRendered: [0, 1, -1, 0, 400, 0] }],
  }))
  assert.deepEqual(r.pages[0].nativeToRendered, [0, 1, -1, 0, 400, 0])
  assert.deepEqual(r.blocks[0].candidates[1].lineIds, [r.pages[0].lineAssignments[0].lineId])
  assert.equal(r.blocks[0].bbox.x, 10)
})

test('figure and table captions bind by type and geometry despite hostile array order', () => {
  const r = build(fixture([
    raw('tc', 'table_title', 'Table 2. Table values.', [10, 290, 200, 310]),
    raw('fig', 'image', '', [10, 20, 200, 120]),
    raw('table', 'table', '<table/>', [10, 320, 200, 420]),
    raw('fc', 'figure_title', 'Figure 1. Figure values.', [10, 130, 200, 150]),
  ]))
  assert.equal(r.figures.length, 2)
  const f = r.figures.find(f => f.kind === 'figure'), t = r.figures.find(f => f.kind === 'table')
  assert.equal(f.caption, 'Figure 1. Figure values.')
  assert.equal(t.caption, 'Table 2. Table values.')
  assert.equal(r.blocks[f.blockIndex].blockId, f.blockId)
  assert.equal(r.blocks[f.blockIndex].figureIndex, f.index)
  assert.ok(f.assetId)
  assert.equal(f.captionBlockIds.length, 1)
})

test('numbered captions do not cross types or conflicting numbers', () => {
  const r = build(fixture([
    raw('f', 'image', 'Figure 3', [10, 20, 200, 120]),
    raw('wrong-number', 'figure_title', 'Figure 8. Different asset.', [10, 125, 200, 145]),
    raw('wrong-type', 'table_title', 'Table 3. Table asset.', [10, 150, 200, 170]),
  ]))
  assert.equal(r.figures[0]?.caption, '')
  assert.ok(r.quality.issues.some(i => i.code === 'unlinked-caption' && i.blockId && i.page === 1))
})

test('one caption can describe two geometrically supported subfigures', () => {
  const r = build(fixture([
    raw('fa', 'image', 'Figure 5(a)', [10, 20, 180, 120]),
    raw('fb', 'image', 'Figure 5(b)', [210, 20, 380, 120]),
    raw('cap', 'figure_title', 'Figure 5. (a) Input. (b) Output.', [10, 130, 380, 150]),
  ]))
  assert.deepEqual(r.figures.map(f => f.caption), ['Figure 5. (a) Input. (b) Output.', 'Figure 5. (a) Input. (b) Output.'])
  assert.equal(r.figures[0].captionBlockIds[0], r.figures[1].captionBlockIds[0])
})

test('ambiguous unnumbered caption remains unlinked with a located issue', () => {
  const r = build(fixture([
    raw('fa', 'image', '', [10, 20, 180, 120]), raw('fb', 'image', '', [210, 20, 380, 120]),
    raw('cap', 'figure_title', 'Comparison of both systems.', [10, 130, 380, 150]),
  ]))
  assert.deepEqual(r.figures.map(f => f.caption), ['', ''])
  assert.ok(r.quality.issues.some(i => i.code === 'ambiguous-caption' && i.blockId && i.page === 1))
})

test('nearby formula with different operators or content cannot delete body', () => {
  const r = build(fixture([
    raw('body', 'text', 'a = b + c', [10, 20, 200, 36]), raw('formula', 'formula', 'a = b - c', [10, 40, 200, 56]),
  ]))
  assert.ok(r.blocks.some(b => b.text === 'a = b + c'))
  assert.equal(r.excluded.filter(e => e.reason === 'duplicate-formula').length, 0)
})

test('evidenced duplicate formula retains excluded source and all PDF line accounts', () => {
  const r = build(fixture([
    raw('dup', 'text', 'x = y + z', [10, 20, 200, 36]), raw('formula', 'formula', 'x = y + z', [10, 40, 200, 56]),
  ], [line('x = y + z')]))
  assert.equal(r.blocks.length, 1)
  assert.equal(r.blocks[0].kind, 'formula')
  const excluded = r.excluded.find(e => e.reason === 'duplicate-formula')
  assert.equal(excluded.block.text, 'x = y + z')
  assert.equal(excluded.duplicateOf, r.blocks[0].blockId)
  assert.ok(r.pages[0].lineAssignments[0].excluded)
})

test('content-supported adjacent continuation merges once preserving fragments and sources', () => {
  const input = fixture([
    raw('first', 'text', 'The text-', [10, 20, 200, 36]), raw('second', 'text', 'only model works.', [10, 40, 200, 56]),
    raw('other', 'text', 'Separate paragraph.', [10, 100, 200, 116]),
  ])
  const r = build(input)
  assert.equal(r.blocks.length, 2)
  assert.equal(r.blocks[0].text, 'The text-only model works.')
  assert.deepEqual(r.blocks[0].sourceBlockIds, ['first', 'second'])
  assert.equal(r.blocks[0].fragments.length, 2)
  assert.deepEqual(build(input), r)
})

test('negative gap and cross-column proximity are not continuation evidence', () => {
  const r = build(fixture([
    raw('first', 'text', 'Previous text-', [10, 400, 200, 416], { block_order: 0 }),
    raw('second', 'text', 'only sentence.', [10, 20, 200, 36], { block_order: 1 }),
    raw('third', 'text', 'Different column-', [210, 40, 390, 56], { block_order: 2 }),
    raw('fourth', 'text', 'only here.', [10, 60, 200, 76], { block_order: 3 }),
  ]))
  assert.equal(r.blocks.length, 4)
})

test('operator conflicts and ambiguous ownership are never marked passed', () => {
  const formulas = build(fixture([raw('f', 'formula', 'a = b - c', [10, 20, 200, 40])], [line('a = b + c')]))
  assert.equal(formulas.blocks[0].quality.status, 'needs_review')
  assert.equal(formulas.blocks[0].latex, 'a = b + c')
  const tied = build(fixture([
    raw('a', 'text', 'Identical candidate.', [10, 20, 200, 40]), raw('b', 'text', 'Identical candidate.', [10, 20, 200, 40]),
  ], [line('Identical candidate.')]))
  const owner = tied.blocks.find(b => b.blockId === tied.pages[0].lineAssignments[0].blockId)
  assert.ok(owner.quality.issues.some(i => i.code === 'ambiguous-line-owner'))
})

test('unsupported service geometry cannot absorb VL candidates from another coordinate frame', () => {
  const r = build(fixture([], [line('Actual PDF.')], {
    servicePages: [{ n: 1, width: 1200, height: 400, blocks: [raw('s', 'text', 'Wrong geometry.', [10, 20, 200, 40])] }],
    supplementaryPages: [{ n: 1, width: 400, height: 600, blocks: [raw('v', 'text', 'Actual PDF.', [10, 20, 200, 40])] }],
  }))
  assert.equal(r.blocks.length, 2)
  assert.equal(r.blocks.find(b => b.sourceBlockIds.includes('v')).text, 'Actual PDF.')
  assert.equal(r.pages[0].lineAssignments.length, 1)
})

test('missing structure with a readable PDF page remains reviewable', () => {
  const r = build(fixture([], [], { servicePages: [] }))
  assert.equal(r.pages[0].status, 'needs_review')
  assert.ok(r.pages[0].quality.issues.some(i => i.code === 'missing-layout-page'))
})

test('invalid page count is rejected instead of silently losing the page list', () => {
  assert.throws(() => build(fixture([], [], { pageCount: -1 })), /pageCount/)
})

test('source page failures never become a passed empty page', () => {
  const r = build(fixture([], [], { servicePages: [{ n: 1, width: 400, height: 600, status: 'failed', blocks: [] }], pdfPages: [] }))
  assert.equal(r.pages[0].status, 'failed')
  assert.equal(r.quality.status, 'failed')
})

test('raw line account includes the actual text and rectangle', () => {
  const r = build(fixture([raw('p', 'text', 'Trace this exact line.', [10, 20, 200, 40])], [line('Trace this exact line.')]))
  assert.equal(r.pages[0].lineAssignments[0].text, 'Trace this exact line.')
  assert.deepEqual(r.pages[0].lineAssignments[0].bbox, { x: 10, y: 20, width: 180, height: 12 })
})

test('cross-type supplementary captions are not collapsed into one candidate set', () => {
  const r = build(fixture([raw('f', 'figure_title', 'Figure 1. Correct.', [10, 20, 200, 40])], [], {
    supplementaryPages: [{ n: 1, width: 400, height: 600, blocks: [raw('t', 'table_title', 'Table 1. Wrong type.', [10, 20, 200, 40])] }],
  }))
  assert.equal(r.blocks.length, 2)
})

test('selected mathematical glyphs preserve superscripts and styled letters', () => {
  const r = build(fixture([raw('m', 'text', 'ℝ and x² remain mathematical symbols.', [10, 20, 200, 40])], [line('ℝ and x² remain mathematical symbols.')]))
  assert.equal(r.blocks[0].text, 'ℝ and x² remain mathematical symbols.')
  const changed = build(fixture([raw('m', 'text', 'R and x2 remain mathematical symbols.', [10, 20, 200, 40])], [line('R and x2 remain mathematical symbols.')]))
  assert.notEqual(r.blocks[0].sourceHash, changed.blocks[0].sourceHash)
})

test('source sha256 is mandatory for version two identities', () => {
  assert.throws(() => build({ ...fixture([], []), source: {} }), /source\.sha256/)
})

test('a PDF line just above a service block is rescued, not orphaned', () => {
  const r = build(fixture(
    [raw('p', 'text', 'First line continues here.\nSecond line continues here.', [10, 50, 200, 100])],
    [line('First line continues here.', 10, 36, 190, 48), line('Second line continues here.', 10, 52, 190, 64)],
  ))
  assert.equal(r.blocks.length, 1)
  assert.equal(r.blocks[0].sourceBlockIds.length, 1)
  assert.equal(r.blocks[0].quality.issues.some(i => i.code === 'unmatched-pdf-line'), false)
  assert.match(r.blocks[0].text, /First line continues here/)
})

test('stray short labels near a visual block stay figure-internal, not body paragraphs', () => {
  const r = build(fixture(
    [raw('fig', 'image', '', [100, 100, 200, 180])],
    [line('insertion', 110, 88, 150, 96)],
  ))
  assert.equal(r.blocks.length, 1)
  assert.equal(r.blocks[0].kind, 'figure')
  assert.equal(r.pages[0].lineAssignments.length, 1)
  assert.equal(r.pages[0].lineAssignments[0].role, 'figure-internal')
})

test('a hyphenated line break keeps the hyphen and drops the PDF extraction space', () => {
  const r = build(fixture(
    [raw('p', 'text', 'A pre- dictor now works.', [10, 20, 200, 60])],
    [line('A pre-', 10, 22, 190, 34), line('dictor now works.', 10, 36, 190, 48)],
  ))
  assert.equal(r.blocks[0].text, 'A pre-dictor now works.')
})
