// Public seams: persisted runLayout -> refillText, and rebuild-layout CLI.
// Catches cross-batch text loss, guessed identities and writes after rejection.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-layout-replay-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root
process.env.PYTHONUTF8 = '1'
process.env.PADDLE_OCR_TOKEN = ''
globalThis.fetch = async () => { throw new Error('Network forbidden in replay regression') }
const store = await import('../lib/store.js')
const { createLayout } = await import('../lib/layout.js')
const { createLayoutArchive } = await import('../lib/layout-archive.js')
const archive = createLayoutArchive({ store })
const repo = fileURLToPath(new URL('../', import.meta.url))
const cli = path.join(repo, 'scripts/quality/rebuild-layout.mjs')
const inputs = new Map()
await store.setConfig({ ocr: { token: 'fixture-not-a-real-key', maxCloudPages: 0 } })
let passed = 0, failed = 0, sequence = 0
async function check(name, task) {
  try { await task(); passed++; console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack) }
}
const texts = ['First page.', 'Second page.', 'Third page.', 'Fourth page.', 'Fifth page.', 'Sixth page.']
function row(text, index) {
  return JSON.stringify({ result: { layoutParsingResults: [{ prunedResult: {
    page_index: index, width: 600, height: 800,
    parsing_res_list: text ? [{ block_label: 'text', block_content: text, block_bbox: [20, 40, 580, 80] }] : [],
  } }] } })
}
async function fixture({ values = texts, batchPages = 2, reverse = false } = {}) {
  const id = 'replay-' + (++sequence)
  const source = path.join(root, id + '.pdf')
  await fs.writeFile(source, 'Unique fixture PDF bytes: ' + id)
  inputs.set(id, source)
  await store.addPaper({ id, title: 'Offline replay fixture', srcPath: source, storage: 'link', pageCount: values.length, hasText: false })
  let submits = 0
  const jobs = new Map()
  const runner = createLayout({ store, pdf: { async callTool(command, args) {
    if (command === 'info') return { pages: values.length, sizes: values.map((_, i) => ({ n: i + 1, w: 600, h: 800 })) }
    if (command === 'split') return { ok: true }
    if (command === 'page_lines') return { lines: [] }
    throw new Error('Unexpected PDF command: ' + command)
  } }, ocr: {
    async submitJob({ filePath }) {
      const [, start, end] = /^p(\d+)-(\d+)\.pdf$/.exec(path.basename(filePath))
      const jobId = 'fixture-' + (++submits)
      jobs.set(jobId, [Number(start), Number(end)])
      return { jobId }
    },
    async pollJob({ jobId }) { return { jsonUrl: jobId } },
    async fetchResults({ jsonUrl }) {
      const [start, end] = jobs.get(jsonUrl)
      const rows = values.slice(start - 1, end).map((value, i) => row(value, i))
      return { text: (reverse ? rows.reverse() : rows).join('\n') }
    },
  } })
  await runner.runLayout(id, { batchPages, resume: false })
  return { id, runner, submits: () => submits,
    expected: values.flatMap((value, i) => value ? [[i + 1, value]] : []) }
}
const content = layout => layout.blocks.map(block => [block.page, block.text])
async function snapshot(id) {
  const result = {}
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative + '/')
      else result[relative] = (await fs.readFile(path.join(dir, entry.name))).toString('base64')
    }
  }
  await walk(store.paperFile(id, ''))
  result['source-pdf'] = (await fs.readFile(inputs.get(id))).toString('base64')
  return result
}
async function legacy(id, mutate = () => {}) {
  const layout = await archive.readPublished(id)
  for (const page of layout.pages) delete page.rawRef
  mutate(layout)
  await archive.publishDerived(id, layout, await archive.readInput(id, layout.revision))
}
async function refill(f, times = 1) {
  const before = await snapshot(f.id)
  const submissions = f.submits()
  for (let i = 0; i < times; i++) {
    await f.runner.refillText(f.id)
    assert.deepEqual(content(await archive.readPublished(f.id)), f.expected)
  }
  const after = await snapshot(f.id)
  for (const [file, bytes] of Object.entries(before)) {
    if (file === 'current.json' || file === 'layout-data/current.json' || file === 'layout.json') continue
    assert.equal(after[file], bytes, 'Historical evidence changed: ' + file)
  }
  assert.equal(f.submits(), submissions, 'Offline refill must not submit OCR')
}
async function rejected(f, run = () => f.runner.refillText(f.id)) {
  await fs.writeFile(store.paperFile(f.id, 'doc.json'), JSON.stringify({ paragraphs: [{ text: 'Preserve existing document' }] }))
  const before = await snapshot(f.id)
  await assert.rejects(run, /raw|hash|页|来源|身份|归档/i)
  assert.deepEqual(await snapshot(f.id), before, 'Rejection changed current, projection, document or history')
}
function cliRun(id, apply = true) {
  const result = spawnSync(process.execPath, [cli, id, '--data=' + root, ...(apply ? ['--apply'] : [])], {
    cwd: repo, encoding: 'utf8', timeout: 30000,
  })
  if (result.error) throw result.error
  return result
}

try {
  // Ten independent fixtures per case run locally and through the existing CI npm test step.
  for (let round = 1; round <= Number(process.env.PB_REPLAY_ROUNDS || 10); round++) {
    await check(`${round}: three batches retain provenance, non-first offsets and repeated refill`, async () => {
      const f = await fixture({ reverse: true })
      const layout = await archive.readPublished(f.id)
      assert.deepEqual(layout.pages.map(page => page.rawRef?.page), ['1-2', '1-2', '3-4', '3-4', '5-6', '5-6'])
      await refill(f, 2)
    })
    await check(`${round}: legacy pages without rawRef recover from current block/top-level ranges`, async () => {
      const f = await fixture()
      await legacy(f.id)
      await refill(f, 2)
    })
    await check(`${round}: top-level ranges retain blank pages without block evidence`, async () => {
      const f = await fixture({ values: ['First page.', '', 'Third page.'], batchPages: 1 })
      await legacy(f.id, layout => {
        for (const block of layout.blocks) { block.sourceBlocks = []; block.candidates = [] }
      })
      await refill(f)
      assert.equal((await archive.readPublished(f.id)).pages[1].blockIds.length, 0)
    })
    await check(`${round}: same raw hash in distinct batches keeps both global page identities`, async () => {
      const f = await fixture({ values: ['Same text.', 'Same text.', 'Same text.'], batchPages: 1 })
      await legacy(f.id)
      await refill(f)
    })
    await check(`${round}: block-only ranges and complete bindings without ranges remain compatible`, async () => {
      const f = await fixture()
      await legacy(f.id, layout => {
        layout.rawRefs = []
        for (const block of layout.blocks) {
          for (const source of [...block.sourceBlocks, ...block.candidates]) if (source.rawRef) delete source.rawRef.page
        }
      })
      await refill(f)
    })
    await check(`${round}: legacy page hash-only bindings recover a whole single batch`, async () => {
      const f = await fixture({ batchPages: 6 })
      const layout = await archive.readPublished(f.id)
      layout.rawRefs = []
      for (const page of layout.pages) page.rawRef = { hash: page.rawRef.hash }
      for (const block of layout.blocks) { block.sourceBlocks = []; block.candidates = [] }
      await archive.publishDerived(f.id, layout)
      await refill(f)
    })
    await check(`${round}: unrelated valid, stale and malformed directory raws cannot affect replay`, async () => {
      const f = await fixture()
      await legacy(f.id)
      await archive.saveRaw(f.id, row('Unrelated old text.', 0), { page: '1-1' })
      await archive.saveRaw(f.id, '{malformed historical raw')
      await refill(f)
    })
    for (const [name, bad] of [
      ['duplicate raw page', row('one', 0) + '\n' + row('duplicate', 0)],
      ['out-of-range raw page', row('one', 0) + '\n' + row('outside', 4)],
      ['missing raw page', row('one', 0)],
      ['malformed raw page', row('one', 0) + '\n{broken'],
    ]) {
      await check(`${round}: ${name} rejects before publication`, async () => {
        const f = await fixture()
        const replacement = await archive.saveRaw(f.id, bad, { page: '3-4' })
        await legacy(f.id, layout => {
          const oldHash = layout.rawRefs.find(ref => ref.page === '3-4').hash
          function replace(value) {
            if (!value || typeof value !== 'object') return
            if (value.hash === oldHash) Object.assign(value, replacement)
            for (const child of Object.values(value)) replace(child)
          }
          replace(layout)
        })
        await rejected(f)
      })
    }
    await check(`${round}: ambiguous top-level raw hashes without page bindings reject`, async () => {
      const f = await fixture()
      await legacy(f.id, layout => {
        for (const ref of layout.rawRefs) delete ref.page
        for (const block of layout.blocks) { block.sourceBlocks = []; block.candidates = [] }
      })
      await rejected(f)
    })
    await check(`${round}: conflicting current sources reject rather than first-wins`, async () => {
      const f = await fixture()
      const other = await archive.saveRaw(f.id, row('Conflicting current text.', 0), { page: '1-1' })
      await legacy(f.id, layout => layout.rawRefs.push(other))
      await rejected(f)
    })
    for (const page of ['0-2', '5-8', '2-1', 'not-a-range']) {
      await check(`${round}: invalid global batch range ${page} rejects`, async () => {
        const f = await fixture()
        await legacy(f.id, layout => { layout.rawRefs[0].page = page })
        await rejected(f)
      })
    }
    await check(`${round}: missing block rawRef cannot turn cloud evidence into a PDF-only no-op`, async () => {
      const f = await fixture()
      await legacy(f.id, layout => {
        layout.rawRefs = []
        for (const block of layout.blocks) for (const source of [...block.sourceBlocks, ...block.candidates]) source.rawRef = null
      })
      await rejected(f)
    })
    await check(`${round}: supplemental model evidence rejects rather than silently dropping candidates`, async () => {
      const f = await fixture()
      await legacy(f.id, layout => { layout.blocks[0].sourceBlocks[0].source = 'vl' })
      await rejected(f)
    })
    await check(`${round}: block and page identities must agree with declared batch range`, async () => {
      const f = await fixture()
      await legacy(f.id, layout => { layout.blocks[0].sourceBlocks[0].rawRef.page = '3-4' })
      await rejected(f)
    })
    await check(`${round}: missing referenced raw rejects without directory fallback`, async () => {
      const f = await fixture()
      await legacy(f.id, layout => { layout.rawRefs[0].hash = 'f'.repeat(64) })
      await rejected(f)
    })
    await check(`${round}: hash-corrupt raw rejects without writes`, async () => {
      const f = await fixture()
      const layout = await archive.readPublished(f.id)
      await fs.writeFile(store.paperFile(f.id, 'layout-data/raw/' + layout.rawRefs[0].hash + '.jsonl'), 'corrupt')
      await rejected(f)
    })
    await check(`${round}: rebuild CLI rejects ambiguous evidence before --apply writes`, async () => {
      const f = await fixture()
      await legacy(f.id, layout => {
        for (const ref of layout.rawRefs) delete ref.page
        for (const block of layout.blocks) { block.sourceBlocks = []; block.candidates = [] }
      })
      await rejected(f, async () => {
        const result = cliRun(f.id)
        assert.equal(result.status, 1, result.stdout + result.stderr)
        throw new Error(result.stderr)
      })
    })
    await check(`${round}: rebuild CLI dry-run and apply preserve legacy three-batch text/history`, async () => {
      const f = await fixture({ reverse: true })
      await legacy(f.id)
      // No source file: the CLI's supported line-assignment fallback avoids PDF extraction.
      const metaFile = store.paperFile(f.id, 'meta.json')
      const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'))
      meta.srcPath = path.join(root, 'not-present.pdf')
      await fs.writeFile(metaFile, JSON.stringify(meta))
      const before = await snapshot(f.id)
      let result = cliRun(f.id, false)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.deepEqual(await snapshot(f.id), before, 'Dry-run wrote evidence')
      result = cliRun(f.id)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.deepEqual(content(await archive.readPublished(f.id)), f.expected)
      const after = await snapshot(f.id)
      for (const [file, bytes] of Object.entries(before)) {
        if (/^layout-data\/(raw|inputs|revisions)\//.test(file) || file === 'source-pdf') assert.equal(after[file], bytes)
      }
    })
  }
} finally {
  await store.closeDb()
  await fs.rm(root, { recursive: true, force: true })
}
console.log(`${passed} PASS / ${failed} FAIL`)
process.exitCode = failed ? 1 : 0
