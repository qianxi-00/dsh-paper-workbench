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

try {
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
