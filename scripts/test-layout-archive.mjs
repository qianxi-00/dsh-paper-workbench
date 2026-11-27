// Public artifact boundary: immutable raw data, atomic revision publication, safe legacy migration.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
let module
try { module = await import('../lib/layout-archive.js') }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }
let pass = 0, fail = 0
async function check(name, fn) {
  try { assert.equal(typeof module?.createLayoutArchive, 'function', 'layout archive API is missing'); await fn(); pass++; console.log('PASS ' + name) }
  catch (error) { fail++; console.error('FAIL ' + name + ': ' + error.message) }
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-layout-archive-'))
const file = path.join(root, 'input.pdf')
await fs.writeFile(file, 'source bytes for fingerprint')
const store = { paperFile(id, name) { assert.match(id, /^[a-z0-9-]+$/); return path.join(root, id, name) } }
const sourceHash = createHash('sha256').update('source bytes for fingerprint').digest('hex')
const rawText = '{"result":{"page_index":0,"text":"immutable evidence"}}\n'
const fixture = revision => ({ version: 1, schemaVersion: 2, revision, source: { sha256: sourceHash }, pageCount: 2,
  pages: [{ n: 1 }, { n: 2 }], blocks: [{ page: 1, text: 'Kept source.' }], figures: [], quality: { status: 'needs_review', issues: [] } })
const readFiles = files => Promise.all(files.map(file => fs.readFile(file, 'utf8')))
async function interruptedPublication(id) {
  const archive = module.createLayoutArchive({ store })
  const raw = await archive.saveRaw(id, rawText, { page: '1-2', model: 'PP-StructureV3' })
  const input = { rawRefs: [raw], model: 'PP-StructureV3', pdfPages: [{ page: 1, lines: [] }] }
  await archive.publish(id, fixture('previous'), input)
  const currentFiles = [store.paperFile(id, 'layout-data/current.json'), store.paperFile(id, 'layout.json')]
  const currentBefore = await readFiles(currentFiles)
  const layout = { ...fixture('ignored-by-derived'), at: 10, builtAt: 20 }
  const originalWriteFile = fs.writeFile
  let revision, faults = 0
  fs.writeFile = async function (file, ...args) {
    if (path.dirname(String(file)) === store.paperFile(id, 'layout-data/revisions') && faults++ === 0) {
      revision = path.basename(String(file), '.json')
      throw Object.assign(new Error('fixture: interrupted revision write'), { code: 'ENOSPC' })
    }
    return originalWriteFile.call(this, file, ...args)
  }
  try { await assert.rejects(archive.publishDerived(id, layout, input), { code: 'ENOSPC' }) }
  finally { fs.writeFile = originalWriteFile }
  assert.equal(faults, 1)
  assert.match(revision, /^[a-f0-9]{64}$/)
  assert.equal(await archive.readRevision(id, revision), null)
  assert.equal((await archive.readInput(id, revision)).at, 10)
  assert.deepEqual(await readFiles(currentFiles), currentBefore)
  const immutableFiles = [store.paperFile(id, 'layout-data/inputs/' + revision + '.json'),
    store.paperFile(id, 'layout-data/' + raw.file), store.paperFile(id, 'layout-data/revisions/previous.json')]
  return { id, layout, input, revision, currentFiles, currentBefore, immutableFiles,
    immutableBefore: await readFiles(immutableFiles), archive: module.createLayoutArchive({ store }) }
}
try {
  await check('PDF指纹为文件内容hash且携带尺寸', async () => {
    const source = await module.fingerprintPdf(file)
    assert.equal(source.sha256, sourceHash)
    assert.equal(source.size, Buffer.byteLength('source bytes for fingerprint'))
  })
  await check('raw按内容去重，精确读回并拒绝损坏内容', async () => {
    const archive = module.createLayoutArchive({ store })
    const a = await archive.saveRaw('p1', rawText, { page: 1, model: 'PP-StructureV3', jobId: 'job-1' })
    const b = await archive.saveRaw('p1', rawText, { page: 2, model: 'PP-StructureV3', jobId: 'job-2' })
    assert.equal(a.hash, b.hash)
    assert.equal(a.page, 1)
    assert.equal(b.page, 2)
    assert.equal(await archive.readRaw('p1', a), rawText)
    await fs.writeFile(path.join(root, 'p1', 'layout-data', a.file), 'corruption')
    await assert.rejects(archive.readRaw('p1', a), /hash|损坏|校验/)
  })
  await check('发布前备份旧布局；新版本可读取且历史版本保留', async () => {
    const legacy = { version: 1, blocks: [{ text: 'legacy text' }] }
    await fs.mkdir(path.join(root, 'p2'), { recursive: true })
    await fs.writeFile(store.paperFile('p2', 'layout.json'), JSON.stringify(legacy))
    const archive = module.createLayoutArchive({ store })
    const current = fixture('revision-0001')
    await archive.publish('p2', current, { servicePages: [] })
    assert.deepEqual(await archive.readPublished('p2'), current)
    const backups = await fs.readdir(path.join(root, 'p2', 'layout-data', 'legacy'))
    assert.equal(backups.length, 1)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'p2', 'layout-data', 'legacy', backups[0]), 'utf8')), legacy)
    await archive.publish('p2', fixture('revision-0002'), { servicePages: [] })
    assert.deepEqual(await archive.readRevision('p2', 'revision-0001'), current)
    assert.equal((await archive.readPublished('p2')).revision, 'revision-0002')
  })
  await check('缺页或失败产物不能覆盖旧成功版本', async () => {
    const archive = module.createLayoutArchive({ store })
    await archive.publish('p3', fixture('revision-valid'), {})
    const incomplete = fixture('revision-broken'); incomplete.pages.pop()
    await assert.rejects(archive.publish('p3', incomplete, {}), /页/)
    const failed = fixture('revision-failed'); failed.quality.status = 'failed'
    await assert.rejects(archive.publish('p3', failed, {}), /质量|失败/)
    assert.equal((await archive.readPublished('p3')).revision, 'revision-valid')
  })
  await check('版本输入可离线读回，清除当前引用不删除raw或历史', async () => {
    const archive = module.createLayoutArchive({ store })
    const raw = await archive.saveRaw('p4', rawText, { page: 1, model: 'PP-StructureV3' })
    const input = { rawRefs: [raw], pdfPages: [{ page: 1, lines: [] }] }
    await archive.publish('p4', fixture('revision-offline'), input)
    assert.deepEqual(await archive.readInput('p4', 'revision-offline'), input)
    await archive.clear('p4')
    assert.equal(await archive.readPublished('p4'), null)
    assert.equal(await archive.readRaw('p4', raw), rawText)
    assert.equal((await archive.readRevision('p4', 'revision-offline')).revision, 'revision-offline')
  })
  await check('同版本不同内容不能静默覆盖历史', async () => {
    const archive = module.createLayoutArchive({ store })
    await archive.publish('p5', fixture('revision-immutable'), {})
    const changed = fixture('revision-immutable'); changed.blocks[0].text = 'different text'
    await assert.rejects(archive.publish('p5', changed, {}), /不可变|冲突/)
    assert.equal((await archive.readPublished('p5')).blocks[0].text, 'Kept source.')
  })
  await check('input已存但revision中断后，仅时间戳变化可恢复且证据字节不变', async () => {
    const f = await interruptedPublication('retry-time')
    const result = await f.archive.publishDerived(f.id, { ...f.layout, at: 11, builtAt: 21 }, f.input)
    assert.equal(result.revision, f.revision)
    assert.equal(result.projectionSynced, true)
    assert.equal((await f.archive.readPublished(f.id)).blocks[0].text, 'Kept source.')
    assert.equal((await f.archive.readPublished(f.id)).revision, f.revision)
    assert.deepEqual(await readFiles(f.immutableFiles), f.immutableBefore)
    const revisionFile = store.paperFile(f.id, 'layout-data/revisions/' + f.revision + '.json')
    const revisionBefore = await fs.readFile(revisionFile, 'utf8')
    await f.archive.publishDerived(f.id, { ...f.layout, at: 12, builtAt: 22 }, f.input)
    assert.equal(await fs.readFile(revisionFile, 'utf8'), revisionBefore)
    assert.deepEqual(await readFiles(f.immutableFiles), f.immutableBefore)
  })
  for (const kind of ['model', 'raw', 'pdf']) {
    await check('中断重试仍拒绝真实输入冲突：' + kind, async () => {
      const f = await interruptedPublication('conflict-' + kind)
      const input = { ...f.input }
      if (kind === 'model') input.model = 'different-model'
      if (kind === 'raw') input.rawRefs = [{ ...input.rawRefs[0], jobId: 'different-job' }]
      if (kind === 'pdf') input.pdfPages = [{ page: 1, lines: [{ text: 'Conflicting PDF evidence.' }] }]
      await assert.rejects(f.archive.publishDerived(f.id, { ...f.layout, at: 11 }, input), /不可变|冲突/)
      assert.deepEqual(await readFiles(f.currentFiles), f.currentBefore)
      assert.deepEqual(await readFiles(f.immutableFiles), f.immutableBefore)
      assert.equal(await f.archive.readRevision(f.id, f.revision), null)
    })
  }
  for (const [kind, bytes, expected] of [
    ['null', 'null\n', /不可变|冲突/], ['truncated', '{"model":', SyntaxError],
  ]) {
    await check('中断后非法input不能被覆盖或接受：' + kind, async () => {
      const f = await interruptedPublication('invalid-' + kind)
      await fs.writeFile(f.immutableFiles[0], bytes)
      const before = await readFiles(f.immutableFiles)
      await assert.rejects(f.archive.publishDerived(f.id, { ...f.layout, at: 11 }, f.input), expected)
      assert.deepEqual(await readFiles(f.currentFiles), f.currentBefore)
      assert.deepEqual(await readFiles(f.immutableFiles), before)
      assert.equal(await f.archive.readRevision(f.id, f.revision), null)
    })
  }
  await check('完整版本的真实输入冲突仍拒绝且历史和current不变', async () => {
    const archive = module.createLayoutArchive({ store })
    const layout = { ...fixture('complete'), at: 10 }
    await archive.publish('conflict-complete', layout, { model: 'PP-StructureV3', at: 10 })
    const files = ['layout-data/inputs/complete.json', 'layout-data/revisions/complete.json',
      'layout-data/current.json', 'layout.json'].map(name => store.paperFile('conflict-complete', name))
    const before = await readFiles(files)
    await assert.rejects(archive.publish('conflict-complete', { ...layout, at: 11 }, { model: 'different-model', at: 11 }), /不可变|冲突/)
    assert.deepEqual(await readFiles(files), before)
  })
  await check('路径参数不可越界读取原始数据或版本', async () => {
    const archive = module.createLayoutArchive({ store })
    await assert.rejects(archive.readRaw('p6', { hash: '../../input', file: '../../input.pdf' }), /非法|不合法/)
    await assert.rejects(archive.readRevision('p6', '../../input'), /非法|不合法/)
  })
} finally { await fs.rm(root, { recursive: true, force: true }) }
console.log(`${pass} PASS / ${fail} FAIL`)
process.exitCode = fail ? 1 : 0
