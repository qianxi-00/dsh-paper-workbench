// Public boundary: parsing and runLayout must never turn missing OCR pages into valid pages.
// Network/PDF extraction are fixture inputs; persistence and the layout runner stay real.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLayout, parseLayoutJsonl } from '../lib/layout.js'

let passed = 0
let failed = 0
async function check(name, task) {
  try { await task(); passed++; console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message) }
}
function row(text, index) {
  const prunedResult = { width: 600, height: 800, parsing_res_list: [
    { block_label: 'text', block_content: text, block_bbox: [20, 40, 580, 70] },
  ] }
  if (index !== undefined) prunedResult.page_index = index
  return JSON.stringify({ result: { layoutParsingResults: [{ prunedResult }] } })
}

await check('坏行之后的正文仍属于第三页，不压成第二页', () => {
  const parsed = parseLayoutJsonl([row('page one'), '{broken', row('page three')].join('\n'))
  assert.deepEqual(parsed.pages.map(page => [page.n, page.blocks[0].block_content]), [[1, 'page one'], [3, 'page three']])
  assert.equal(parsed.skipped, 1)
})
await check('无结果的一行仍占原页身份', () => {
  const parsed = parseLayoutJsonl([row('one'), '{"result":{}}', row('three')].join('\n'))
  assert.deepEqual(parsed.pages.map(page => page.n), [1, 3])
})
await check('服务显式页索引保留，不按结果抵达顺序重编号', () => {
  const parsed = parseLayoutJsonl([row('three', 2), row('one', 0)].join('\n'))
  assert.deepEqual(parsed.pages.map(page => [page.n, page.blocks[0].block_content]), [[3, 'three'], [1, 'one']])
})

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-page-identity-'))
const pdfPath = path.join(root, 'input.pdf')
await fs.writeFile(pdfPath, 'fixture input consumed only by fake PDF adapter')
const store = {
  paperFile: (id, name) => path.join(root, id, name),
  getMeta: async id => ({ id, title: 'Page identity fixture' }),
  resolvePdf: async () => ({ path: pdfPath }),
  getConfig: async () => ({ ocr: { token: 'fixture-not-a-real-key' } }),
  readJson: async (file, fallback) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
  },
  writeJsonAtomic: async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(value))
  },
}
const pdf = {
  callTool: async (command, input) => {
    if (command === 'info') return { ok: true, pages: 3, sizes: [1, 2, 3].map(n => ({ n, w: 600, h: 800 })) }
    if (command === 'split') return { ok: true, pages: input.to - input.from + 1 }
    if (command === 'page_lines') return { ok: true, page: input.page, width: 600, height: 800, lines: [] }
    throw new Error('Unexpected PDF command: ' + command)
  },
}

let fixtureNumber = 0
async function supplementFixture({ primary = row('Page one.', 0), supplement = row('Page two.', 0), pageCount = 2, batchPages = pageCount, model } = {}) {
  const id = 'supplement-' + (++fixtureNumber)
  const submissions = [], splits = [], textPages = []
  const jobs = new Map()
  let seed = true
  const runner = createLayout({ store, pdf: { async callTool(command, input) {
    if (command === 'info') return { pages: pageCount, sizes: Array.from({ length: pageCount }, (_, i) => ({ n: i + 1, w: 600, h: 800 })) }
    if (command === 'split') {
      splits.push([input.from, input.to])
      await fs.writeFile(input.out, JSON.stringify([input.from, input.to]))
      return { ok: true }
    }
    if (command === 'page_lines') { textPages.push(input.page); return { lines: [] } }
    throw new Error('Unexpected PDF command: ' + command)
  } }, ocr: {
    async submitJob({ model, filePath }) {
      const range = JSON.parse(await fs.readFile(filePath, 'utf8'))
      submissions.push([model, ...range])
      const jobId = 'fixture-' + submissions.length
      jobs.set(jobId, { range, supplemental: path.basename(filePath).startsWith('vl-') })
      return { jobId }
    },
    async pollJob({ jobId }) { return { jsonUrl: jobId } },
    async fetchResults({ jsonUrl }) {
      const job = jobs.get(jsonUrl)
      if (seed) return { text: Array.from({ length: job.range[1] - job.range[0] + 1 }, (_, i) => row('Previous page ' + (job.range[0] + i), i)).join('\n') }
      if (job.supplemental) {
        if (supplement instanceof Error) throw supplement
        return { text: supplement }
      }
      return { text: typeof primary === 'function' ? primary(job.range) : primary }
    },
  } })
  await runner.runLayout(id, { batchPages, resume: false, model })
  const before = await runner.readLayout(id)
  const pointer = await fs.readFile(store.paperFile(id, 'layout-data/current.json'), 'utf8')
  const projection = await fs.readFile(store.paperFile(id, 'layout.json'), 'utf8')
  seed = false
  submissions.length = splits.length = textPages.length = 0
  return { id, runner, submissions, splits, textPages, before, pointer, projection, batchPages, model }
}

async function assertPreserved(f) {
  assert.deepEqual(await f.runner.readLayout(f.id), f.before)
  assert.equal(await fs.readFile(store.paperFile(f.id, 'layout-data/current.json'), 'utf8'), f.pointer)
  assert.equal(await fs.readFile(store.paperFile(f.id, 'layout.json'), 'utf8'), f.projection)
}

try {
  await check('显式 page_index:0 的两页短批次只补第二页并发布完整正文', async () => {
    const f = await supplementFixture()
    const value = await f.runner.runLayout(f.id, { maxCloudPages: 1, resume: false })
    assert.deepEqual(f.submissions, [['PP-StructureV3', 1, 2], ['PaddleOCR-VL-1.6', 2, 2]])
    assert.deepEqual(f.splits, [[1, 2], [2, 2]])
    assert.deepEqual(f.textPages, [1, 2])
    assert.deepEqual(value.blocks.map(b => [b.page, b.text, b.sourceBlocks[0].source]), [[1, 'Page one.', 'service'], [2, 'Page two.', 'vl']])
    assert.deepEqual(value.rawRefs.map(ref => [ref.model, ref.page]), [['PP-StructureV3', '1-2'], ['PaddleOCR-VL-1.6', '2']])
    assert.equal(value.pages.length, 2)
    assert.notEqual(value.quality.status, 'failed')
    assert.deepEqual(await f.runner.readLayout(f.id), value)
  })
  await check('显式第二页不能压成第一页，只补缺失的第一页', async () => {
    const f = await supplementFixture({ primary: row('Page two.', 1), supplement: row('Page one.', 0) })
    const value = await f.runner.runLayout(f.id, { maxCloudPages: 1, resume: false })
    assert.deepEqual(f.submissions, [['PP-StructureV3', 1, 2], ['PaddleOCR-VL-1.6', 1, 1]])
    assert.deepEqual(value.blocks.map(b => [b.page, b.text]), [[1, 'Page one.'], [2, 'Page two.']])
  })
  await check('后续批次按上传范围定位缺页，整篇只补一次', async () => {
    const f = await supplementFixture({ pageCount: 4, batchPages: 2,
      primary: ([start]) => start === 1 ? [row('Page one.', 0), row('Page two.', 1)].join('\n') : row('Page three.', 0),
      supplement: row('Page four.', 0),
    })
    const value = await f.runner.runLayout(f.id, { batchPages: 2, maxCloudPages: 1, resume: false })
    assert.deepEqual(f.submissions, [['PP-StructureV3', 1, 2], ['PP-StructureV3', 3, 4], ['PaddleOCR-VL-1.6', 4, 4]])
    assert.deepEqual(f.textPages, [1, 2, 3, 4])
    assert.deepEqual(value.blocks.map(b => [b.page, b.text]), [[1, 'Page one.'], [2, 'Page two.'], [3, 'Page three.'], [4, 'Page four.']])
  })
  await check('完整批次即使启用补充也不额外上传', async () => {
    const f = await supplementFixture({ primary: [row('Page one.', 0), row('Page two.', 1)].join('\n') })
    await f.runner.runLayout(f.id, { maxCloudPages: 1, resume: false })
    assert.deepEqual(f.submissions, [['PP-StructureV3', 1, 2]])
  })
  for (const [name, options, maxCloudPages] of [
    ['默认关闭', {}, undefined],
    ['显式关闭', {}, 0],
    ['没有显式页索引', { primary: row('Unknown page.') }, 1],
    ['显式和顺序身份混杂', { primary: [row('Page one.', 0), row('Unknown page.')].join('\n'), pageCount: 3 }, 1],
    ['主模型坏行', { primary: row('Page one.', 0) + '\n{broken' }, 1],
    ['主模型重复页', { primary: [row('Page one.', 0), row('Duplicate.', 0)].join('\n') }, 1],
    ['主模型越界页', { primary: row('Outside page.', 2) }, 1],
    ['缺页超过全篇预算', { pageCount: 3 }, 1],
    ['主模型不是 PP-StructureV3', { model: 'PaddleOCR-VL-1.6' }, 1],
  ]) {
    await check(name + '拒绝补充并保留已有发布', async () => {
      const f = await supplementFixture(options)
      await assert.rejects(f.runner.runLayout(f.id, { maxCloudPages, model: f.model, resume: false }), /未发布新结果/)
      assert.deepEqual(f.submissions, [[f.model || 'PP-StructureV3', 1, options.pageCount || 2]])
      await assertPreserved(f)
    })
  }
  const empty = JSON.stringify({ result: { layoutParsingResults: [{ prunedResult: {
    page_index: 0, width: 600, height: 800, parsing_res_list: [],
  } }] } })
  for (const [name, supplement] of [
    ['错误的单页索引', row('Wrong page.', 1)],
    ['多页结果', [row('Page two.', 0), row('Extra page.', 1)].join('\n')],
    ['重复页索引', [row('Page two.', 0), row('Duplicate.', 0)].join('\n')],
    ['坏行', row('Page two.', 0) + '\n{broken'],
    ['缺少页结果', '{"result":{}}'],
    ['空块列表', empty],
    ['空文字', row('   ', 0)],
    ['只有页眉', row('Header.', 0).replace('"text"', '"header"')],
    ['无效尺寸', row('Page two.', 0).replace('"width":600', '"width":0')],
    ['只有 Markdown 无法校验页身份', JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: 'Page two.' } }] } })],
    ['下载失败', new Error('fixture download failed')],
  ]) {
    await check('VL ' + name + '不发布，原指针及正文不变', async () => {
      const f = await supplementFixture({ supplement })
      await assert.rejects(f.runner.runLayout(f.id, { maxCloudPages: 1, resume: false }), /第 2 页补充识别失败.*未发布新结果/)
      assert.deepEqual(f.submissions, [['PP-StructureV3', 1, 2], ['PaddleOCR-VL-1.6', 2, 2]])
      await assertPreserved(f)
    })
  }
  for (const [name, text] of [
    ['坏行', [row('one'), '{broken', row('three')].join('\n')],
    ['少一页', [row('one'), row('three')].join('\n')],
    ['重复页号', [row('one', 0), row('one again', 0), row('three', 2)].join('\n')],
    ['超出上传范围', [row('one', 0), row('two', 1), row('outside', 4)].join('\n')],
  ]) {
    await check(name + '不发布整篇完成，也不覆盖已有成功结果', async () => {
      const id = 'failure-' + failed + '-' + passed
      const original = { version: 1, blocks: [{ text: 'previous verified layout' }], at: '2026-01-01T00:00:00Z' }
      await store.writeJsonAtomic(store.paperFile(id, 'layout.json'), original)
      const runner = createLayout({ store, pdf, ocr: {
        submitJob: async () => ({ jobId: 'fixture-job' }),
        pollJob: async () => ({ state: 'done', jsonUrl: 'https://fixture.invalid/result' }),
        fetchResults: async () => ({ text }),
      } })
      await assert.rejects(runner.runLayout(id, { batchPages: 3, resume: false }), /页|page/i)
      assert.deepEqual(await store.readJson(store.paperFile(id, 'layout.json')), original)
    })
  }
  await check('完整的三页结果正常发布且页号与正文一一对应', async () => {
    const runner = createLayout({ store, pdf, ocr: {
      submitJob: async () => ({ jobId: 'fixture-job-valid' }),
      pollJob: async () => ({ state: 'done', jsonUrl: 'https://fixture.invalid/result' }),
      fetchResults: async () => ({ text: [row('Page one.'), row('Page two.'), row('Page three.')].join('\n') }),
    } })
    const value = await runner.runLayout('valid', { batchPages: 3, resume: false })
    assert.deepEqual(value.blocks.map(block => [block.page, block.text]), [[1, 'Page one.'], [2, 'Page two.'], [3, 'Page three.']])
  })
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
console.log(`${passed} PASS / ${failed} FAIL`)
process.exitCode = failed ? 1 : 0
