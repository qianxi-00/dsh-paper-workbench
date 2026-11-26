// Public seams: genuine ir-4 archive -> runner, rebuild CLI and batch CLI.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-ir4-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root
process.env.PADDLE_OCR_TOKEN = ''
process.env.PYTHONUTF8 = '1'
globalThis.fetch = async () => { throw new Error('Offline regression forbids network') }
const store = await import('../lib/store.js')
const { createLayout } = await import('../lib/layout.js')
const { createLayoutArchive } = await import('../lib/layout-archive.js')
const realPdf = await import('../lib/pdf.js')
const archive = createLayoutArchive({ store })
const golden = JSON.parse(await fs.readFile(new URL('./fixtures/layout-ir4-primary.json', import.meta.url), 'utf8'))
const repo = fileURLToPath(new URL('../', import.meta.url))
const expected = [[1, 'Existing primary Alpha.'], [2, 'Existing primary Beta.']]
const content = layout => layout.blocks.map(b => [b.page, b.text])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
let sequence = 0, passed = 0, failed = 0, ocrCalls = 0
const forbiddenOcr = Object.fromEntries(['submitJob', 'pollJob', 'fetchResults'].map(name => [name, async () => {
  ocrCalls++; throw new Error('Offline replay attempted ' + name)
}]))
// Child processes use the real CLI/PDF boundary. Any cloud access is recorded
// and rejected before transport, even if a synthetic token was accidentally used.
async function offlineNetwork() {
  const { appendFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  globalThis.fetch = async () => {
    appendFileSync(join(process.env.DSH_PAPER_WORKBENCH_DATA, 'network-attempts.log'), 'forbidden\n')
    throw new Error('Offline CLI attempted network')
  }
}
const preload = 'data:text/javascript,' + encodeURIComponent('await (' + offlineNetwork.toString() + ')()')
const read = file => fs.readFile(file, 'utf8').then(JSON.parse)
await store.setConfig({ ocr: { token: '', maxCloudPages: 0 } })

function pristine(layout) {
  assert.equal(golden.producer, '310fe96d6579a47e4b63c150ac37e658a0c4420d')
  assert.equal(golden.baseRefillPerformed, false)
  assert.equal(layout.build, 'ir-4')
  assert.equal(layout.model, 'PaddleOCR-VL-1.6')
  assert(layout.pages.every(p => p.rawRef === undefined), 'Must use real old page shape')
  assert.equal(layout.rawRefs.length, 1)
  assert.equal(layout.rawRefs[0].model, layout.model, 'Do not pre-refill with base: it strips this metadata')
  assert.equal(layout.rawRefs[0].page, '1-2')
  assert.equal(layout.rawRefs[0].hash, sha(golden.raw))
  assert.equal(layout.source.sha256, sha(Buffer.from(golden.pdfBase64, 'base64')))
  assert(layout.blocks.every(b => b.sourceBlocks.every(s => s.source === 'service' && s.rawRef.model === layout.model)))
  assert.deepEqual(content(layout), expected)
}
pristine(golden.layout)

async function fixture() {
  const id = 'ir4-' + (++sequence)
  const source = path.join(root, id + '.pdf')
  await fs.writeFile(source, Buffer.from(golden.pdfBase64, 'base64'))
  await store.addPaper({ id, title: 'Frozen base runner/archive output', srcPath: source, storage: 'link', pageCount: 2, hasText: false })
  const layout = structuredClone(golden.layout)
  const dir = store.paperFile(id, 'layout-data')
  for (const name of ['raw', 'inputs', 'revisions']) await fs.mkdir(path.join(dir, name), { recursive: true })
  await fs.writeFile(path.join(dir, 'raw', layout.rawRefs[0].hash + '.jsonl'), golden.raw)
  await store.writeJsonAtomic(path.join(dir, 'inputs', layout.revision + '.json'), golden.input)
  await store.writeJsonAtomic(path.join(dir, 'revisions', layout.revision + '.json'), layout)
  await store.writeJsonAtomic(path.join(dir, 'current.json'), { revision: layout.revision, sourceHash: layout.source.sha256 })
  await store.writeJsonAtomic(store.paperFile(id, 'layout.json'), layout)
  await store.writeJsonAtomic(store.paperFile(id, 'doc.json'), { version: 1, paragraphs: [{ text: 'Keep previous document' }], sections: [] })
  await store.writeJsonAtomic(store.paperFile(id, 'notes.json'), { note: 'Keep historical notes' })
  pristine(await archive.readPublished(id))
  return { id, source, runner: createLayout({ store, pdf: realPdf, ocr: forbiddenOcr }) }
}
async function snapshot(f) {
  const result = {}
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + '/')
      else result[name] = sha(await fs.readFile(path.join(directory, entry.name)))
    }
  }
  await walk(store.paperFile(f.id, ''))
  result['source-pdf'] = sha(await fs.readFile(f.source))
  return result
}
function history(before, after) {
  for (const [name, digest] of Object.entries(before)) {
    if (/^layout-data\/(raw|inputs|revisions)\//.test(name) || ['source-pdf', 'notes.json'].includes(name)) assert.equal(after[name], digest, name)
  }
}
function cli(f, target, args) {
  const script = target === 'batch' ? 'scripts/batch-layout.mjs' : 'scripts/quality/rebuild-layout.mjs'
  const options = target === 'batch' ? ['--id=' + f.id, ...args] : [f.id, '--data=' + root, ...args]
  const result = spawnSync(process.execPath, ['--import', preload, path.join(repo, script), ...options], {
    cwd: repo, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.ifError(result.error)
  return { code: result.status, output: result.stdout + result.stderr }
}
async function upgraded(f, before) {
  const layout = await archive.readPublished(f.id)
  assert.equal(layout.build, 'ir-5')
  assert.equal(layout.model, 'PaddleOCR-VL-1.6')
  assert.deepEqual(content(layout), expected)
  assert(layout.pages.every(p => p.rawRef?.model === layout.model))
  history(before, await snapshot(f))
}
async function mutate(f, change) {
  const layout = await archive.readPublished(f.id)
  change(layout)
  await archive.publishDerived(f.id, layout, golden.input)
}
async function check(name, task) {
  try { await task(); passed++; console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack) }
}

try {
  for (let round = 1; round <= Number(process.env.PB_REPLAY_ROUNDS || 10); round++) {
    await check(`${round}: pristine ir-4 primary runner upgrades and repeats offline`, async () => {
      const f = await fixture(), before = await snapshot(f)
      await f.runner.refillText(f.id)
      await f.runner.refillText(f.id)
      await upgraded(f, before)
      assert.equal((await snapshot(f))['doc.json'], before['doc.json'])
    })
    await check(`${round}: primary rebuild CLI dry-run and apply`, async () => {
      const f = await fixture(), before = await snapshot(f)
      let result = cli(f, 'rebuild', [])
      assert.equal(result.code, 0, result.output)
      assert.deepEqual(await snapshot(f), before)
      result = cli(f, 'rebuild', ['--apply'])
      assert.equal(result.code, 0, result.output)
      await upgraded(f, before)
      assert.equal((await read(store.paperFile(f.id, 'doc.json'))).revision, (await archive.readPublished(f.id)).revision)
    })
    await check(`${round}: batch dry-run selects offline for genuine ir-4`, async () => {
      const f = await fixture(), before = await snapshot(f)
      const result = cli(f, 'batch', ['--dry-run', '--refill-existing'])
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /2 页 · 离线重建/)
      assert.deepEqual(await snapshot(f), before)
    })
    await check(`${round}: batch actually upgrades a scan without OCR/token and repeats offline`, async () => {
      const f = await fixture(), before = await snapshot(f)
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = cli(f, 'batch', ['--refill-existing'])
        assert.equal(result.code, 0, result.output)
        await upgraded(f, before)
      }
      const record = (await read(path.join(root, '.batch-layout/manifest.json'))).papers[f.id]
      assert.equal(record.status, 'done')
      assert.equal(record.attempts, 0, 'Offline batch must not enter cloud submission')
      assert.equal(record.ocrJobId, undefined)
      const layout = await archive.readPublished(f.id)
      assert.equal((await read(store.paperFile(f.id, 'doc.json'))).revision, layout.revision)
      assert.deepEqual(await read(store.paperFile(f.id, 'layout.json')), layout)
    })
    for (const [name, change] of [
      ['supplemental source', layout => { layout.blocks[0].sourceBlocks[0].source = 'vl' }],
      ['mismatched primary model', layout => { layout.rawRefs[0].model = 'PP-StructureV3' }],
    ]) await check(`${round}: ${name} still rejects runner and CLI without writes`, async () => {
      const f = await fixture()
      await mutate(f, change)
      const before = await snapshot(f)
      await assert.rejects(() => f.runner.refillText(f.id), /来源/)
      const result = cli(f, 'rebuild', ['--apply'])
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /来源/)
      assert.deepEqual(await snapshot(f), before)
    })
    await check(`${round}: batch ambiguity fails before publication without cloud fallback`, async () => {
      const f = await fixture()
      const other = await archive.saveRaw(f.id, golden.raw.replace('Alpha', 'Conflict'), { page: '1-2', model: golden.layout.model })
      await mutate(f, layout => layout.rawRefs.push(other))
      const before = await snapshot(f)
      const result = cli(f, 'batch', ['--refill-existing'])
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /多个 raw 争用同一全局页/)
      assert.deepEqual(await snapshot(f), before)
    })
    await check(`${round}: unknown build and non-refill/force do not bypass current build checks`, async () => {
      const f = await fixture()
      for (const args of [[], ['--refill-existing', '--force']]) {
        const result = cli(f, 'batch', ['--dry-run', ...args])
        assert.equal(result.code, 0, result.output)
        assert.match(result.output, /云端解析/)
      }
      await mutate(f, layout => { layout.build = 'ir-unknown' })
      const before = await snapshot(f)
      const result = cli(f, 'batch', ['--dry-run', '--refill-existing'])
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /云端解析/)
      assert.deepEqual(await snapshot(f), before)
    })
  }
  assert.equal(ocrCalls, 0)
  assert.equal(await fs.readFile(path.join(root, 'network-attempts.log'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e }), '')
} finally {
  await store.closeDb()
  await fs.rm(root, { recursive: true, force: true })
}
console.log(`${passed} PASS / ${failed} FAIL (legacy replay; zero OCR/network calls)`)
process.exitCode = failed ? 1 : 0
