/**
 * store 层回归测试：盯 2026-11-11 那两次「同一篇进库两遍」的事故。
 *
 *   node scripts/test-store.mjs
 *
 *   - 并发导入同一个路径：addPaper 的查重和写索引曾经在两个临界区，并行时各插一条。
 *   - 同一份 PDF 换个文件名/目录再导入：srcPath 挡不住，要靠 contentHash。
 *   - 回收站：索引写失败后保持可恢复，恢复冲突与按项清理不丢数据。
 *
 * 全程只碰 %TEMP% 下的假文件（store 不读文件内容），跑完删记录、删文件，不污染真实库。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-store-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root
const store = await import('../lib/store.js')
const { addPaper, listPapers, listTrash, purgeTrash, removePaper } = store
const { createApi } = await import('../lib/index.js')
const api = createApi()

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log('PASS  ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail += 1
    console.log('FAIL  ' + name + (detail ? '  ' + detail : ''))
  }
}

async function test(name, run) {
  try {
    await run()
    check(name, true)
  } catch (error) {
    check(name, false, error.stack || error.message)
  }
}

async function addFixture(id) {
  const { meta } = await addPaper({ id, title: '[test] 回收站 ' + id, pageCount: 2 })
  await fsp.writeFile(path.join(store.paperDir(id), 'marker.txt'), id)
  return meta
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function main() {
  const stamp = Date.now() + '-' + process.pid
  const tmp = path.join(root, 'pb-store-race-' + stamp + '.bin')
  const copy = path.join(root, 'pb-store-copy-' + stamp + '.bin')
  const payload = Buffer.from('not-a-real-pdf ' + stamp)
  await fsp.writeFile(tmp, payload)
  await fsp.writeFile(copy, payload)
  const contentHash = await hashFile(tmp)
  check('两个临时文件内容指纹一致', contentHash === (await hashFile(copy)))

  const meta = { title: '[test] 并发去重', srcPath: tmp, hasText: true, topics: ['测试'], contentHash }
  // 关键：两个 addPaper 并发进来。以前查重在临界区外，会各插一条。
  const [first, second] = await Promise.all([addPaper(meta), addPaper({ ...meta })])

  check('并发 addPaper 只新增一条', Number(first.existed) + Number(second.existed) === 1,
    `existed=${first.existed}/${second.existed}`)
  check('两次返回同一条记录', first.meta.id === second.meta.id, first.meta.id)

  const list = await listPapers()
  const same = list.filter((item) => String(item.srcPath || '').toLowerCase() === tmp.toLowerCase())
  check('库里该路径只有一条', same.length === 1, `找到 ${same.length} 条`)

  const third = await addPaper({ ...meta })
  check('串行重复导入返回 existed:true', third.existed === true && third.meta.id === first.meta.id)

  // 同一份内容、不同路径（复制件）：srcPath 不同，只能靠内容指纹认出来
  const copied = await addPaper({ ...meta, srcPath: copy })
  check('同一份 PDF 换个路径再导入仍算已存在', copied.existed === true && copied.meta.id === first.meta.id)

  await removePaper(first.meta.id)
  // removePaper 只是移进回收站；测试数据要彻底删掉，别在用户的回收站里堆垃圾
  for (const item of await listTrash()) {
    if (item.id === first.meta.id) await purgeTrash(item.name).catch(() => {})
  }
  await fsp.rm(tmp, { force: true })
  await fsp.rm(copy, { force: true })
  const after = await listPapers()
  check('清理后库里不再有测试记录', !after.some((item) => item.id === first.meta.id))

  for (const persistent of [false, true]) {
    await test(persistent ? '索引持续写失败时回滚目录，保留可用论文' : '移入回收站后索引单次 ENOSPC，状态一致且 API 可恢复', async () => {
      const id = persistent ? 'trash-index-persistent' : 'trash-index-once'
      const meta = await addFixture(id)
      const originalWriteFile = fsp.writeFile
      const fault = Object.assign(new Error('SYNTHETIC_INDEX_ENOSPC'), { code: 'ENOSPC' })
      let injected = false
      fsp.writeFile = async function (file, ...args) {
        if (String(file).startsWith(store.INDEX_FILE + '.tmp-') && (persistent || !injected)) {
          injected = true
          const entry = (await listTrash()).find(item => item.id === id)
          assert.ok(entry, '故障发生在 trash rename 之后')
          assert.equal(await fsp.readFile(path.join(store.TRASH_DIR, entry.name, 'marker.txt'), 'utf8'), id)
          await assert.rejects(fsp.stat(store.paperDir(id)), { code: 'ENOENT' })
          throw fault
        }
        return originalWriteFile.call(this, file, ...args)
      }
      try {
        await assert.rejects(api['library.remove']({ id }), error => error === fault)
      } finally {
        fsp.writeFile = originalWriteFile
      }
      assert.equal(injected, true)
      assert.equal((await listPapers()).some(item => item.id === id), persistent, '索引应与论文目录状态一致')
      if (persistent) {
        assert.equal(await fsp.readFile(path.join(store.paperDir(id), 'marker.txt'), 'utf8'), id)
        assert.equal((await listTrash()).some(item => item.id === id), false)
        await api['library.remove']({ id })
      } else {
        await assert.rejects(fsp.stat(store.paperDir(id)), { code: 'ENOENT' })
      }
      const entry = (await api['trash.list']()).items.find(item => item.id === id)
      assert.ok(entry)
      assert.equal(await fsp.readFile(path.join(store.TRASH_DIR, entry.name, 'marker.txt'), 'utf8'), id)
      assert.deepEqual(await api['trash.restore']({ name: entry.name }), { id, restored: true })
      assert.deepEqual((await listPapers()).filter(item => item.id === id), [meta])
      assert.equal(await fsp.readFile(path.join(store.paperDir(id), 'marker.txt'), 'utf8'), id)
      assert.equal((await api['trash.list']()).items.some(item => item.id === id), false)
    })
  }

  await test('索引补写和目录回滚都失败时保留文件并报告两个故障', async () => {
    const id = 'trash-rollback-failure'
    const meta = await addFixture(id)
    const originalWriteFile = fsp.writeFile
    const originalRename = fsp.rename
    const fault = Object.assign(new Error('SYNTHETIC_INDEX_ENOSPC'), { code: 'ENOSPC' })
    const rollbackFault = Object.assign(new Error('SYNTHETIC_ROLLBACK_EACCES'), { code: 'EACCES' })
    fsp.writeFile = async function (file, ...args) {
      if (String(file).startsWith(store.INDEX_FILE + '.tmp-')) throw fault
      return originalWriteFile.call(this, file, ...args)
    }
    fsp.rename = async function (from, to) {
      if (String(from).startsWith(store.TRASH_DIR + path.sep) && to === store.paperDir(id)) throw rollbackFault
      return originalRename.call(this, from, to)
    }
    try {
      await assert.rejects(api['library.remove']({ id }), error =>
        error instanceof AggregateError && error.errors.includes(fault) && error.errors.includes(rollbackFault) && /回收站/.test(error.message))
    } finally {
      fsp.writeFile = originalWriteFile
      fsp.rename = originalRename
    }
    const entry = (await api['trash.list']()).items.find(item => item.id === id)
    assert.ok(entry)
    assert.equal(await fsp.readFile(path.join(store.TRASH_DIR, entry.name, 'marker.txt'), 'utf8'), id)
    assert.deepEqual((await listPapers()).filter(item => item.id === id), [meta])
    await assert.rejects(fsp.stat(store.paperDir(id)), { code: 'ENOENT' })
    // 故障解除后，删除脏索引与恢复仍只需使用支持的 API。
    await api['library.remove']({ id })
    assert.deepEqual(await api['trash.restore']({ name: entry.name }), { id, restored: true })
    assert.equal(await fsp.readFile(path.join(store.paperDir(id), 'marker.txt'), 'utf8'), id)
  })

  await test('正常删除恢复、同 ID/目标目录冲突保护与 purge 隔离', async () => {
    const id = 'trash-normal'
    const meta = await addFixture(id)
    await api['library.remove']({ id })
    assert.equal((await listPapers()).some(item => item.id === id), false)
    await assert.rejects(fsp.stat(store.paperDir(id)), { code: 'ENOENT' })
    const entry = (await api['trash.list']()).items.find(item => item.id === id)
    assert.ok(entry)
    const marker = path.join(store.TRASH_DIR, entry.name, 'marker.txt')

    await fsp.mkdir(store.paperDir(id))
    const sentinel = path.join(store.paperDir(id), 'sentinel.txt')
    await fsp.writeFile(sentinel, 'keep destination')
    await assert.rejects(api['trash.restore']({ name: entry.name }), /已存在/)
    assert.equal(await fsp.readFile(marker, 'utf8'), id)
    assert.equal(await fsp.readFile(sentinel, 'utf8'), 'keep destination')
    await addPaper({ id, title: 'same id conflict' })
    const indexBefore = await fsp.readFile(store.INDEX_FILE, 'utf8')
    await assert.rejects(api['trash.restore']({ name: entry.name }), /同 id/)
    assert.equal(await fsp.readFile(store.INDEX_FILE, 'utf8'), indexBefore)
    assert.equal(await fsp.readFile(marker, 'utf8'), id)
    assert.equal(await fsp.readFile(sentinel, 'utf8'), 'keep destination')
    const conflict = await api['library.remove']({ id })

    assert.deepEqual(await api['trash.restore']({ name: entry.name }), { id, restored: true })
    assert.deepEqual((await listPapers()).filter(item => item.id === id), [meta])
    assert.equal(await fsp.readFile(path.join(store.paperDir(id), 'marker.txt'), 'utf8'), id)

    const selectedId = 'trash-purge-selected'
    const retainedId = 'trash-purge-retained'
    await addFixture(selectedId)
    await addFixture(retainedId)
    await api['library.remove']({ id: selectedId })
    await api['library.remove']({ id: retainedId })
    const items = (await api['trash.list']()).items
    const selected = items.find(item => item.id === selectedId)
    const retained = items.find(item => item.id === retainedId)
    assert.deepEqual(await api['trash.purge']({ name: selected.name }), { name: selected.name, removed: true, id: selectedId })
    assert.equal((await api['trash.list']()).items.some(item => item.name === selected.name), false)
    assert.equal(await fsp.readFile(path.join(store.TRASH_DIR, retained.name, 'marker.txt'), 'utf8'), retainedId)
    assert.equal(await fsp.readFile(path.join(conflict.trashed, 'sentinel.txt'), 'utf8'), 'keep destination')
    assert.equal(await fsp.readFile(path.join(store.paperDir(id), 'marker.txt'), 'utf8'), id)
    assert.deepEqual(await api['trash.restore']({ name: retained.name }), { id: retainedId, restored: true })
  })

  console.log(`\nPASS ${pass} / FAIL ${fail}`)
  if (fail > 0) process.exitCode = 1
  else console.log('ALL PASS')
}

main().catch((error) => {
  console.error('测试崩了：', error)
  process.exitCode = 1
}).finally(async () => {
  await store.closeDb()
  await fsp.rm(root, { recursive: true, force: true })
})
