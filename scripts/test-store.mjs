/**
 * store 层回归测试：盯 2026-11-11 那两次「同一篇进库两遍」的事故。
 *
 *   node scripts/test-store.mjs
 *
 *   - 并发导入同一个路径：addPaper 的查重和写索引曾经在两个临界区，并行时各插一条。
 *   - 同一份 PDF 换个文件名/目录再导入：srcPath 挡不住，要靠 contentHash。
 *
 * 全程只碰 %TEMP% 下的假文件（store 不读文件内容），跑完删记录、删文件，不污染真实库。
 */
import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { addPaper, listPapers, removePaper } from '../lib/store.js'

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
  const tmp = path.join(os.tmpdir(), 'pb-store-race-' + stamp + '.bin')
  const copy = path.join(os.tmpdir(), 'pb-store-copy-' + stamp + '.bin')
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
  await fsp.rm(tmp, { force: true })
  await fsp.rm(copy, { force: true })
  const after = await listPapers()
  check('清理后库里不再有测试记录', !after.some((item) => item.id === first.meta.id))

  console.log(`\nPASS ${pass} / FAIL ${fail}`)
  if (fail > 0) process.exitCode = 1
  else console.log('ALL PASS')
}

main().catch((error) => {
  console.error('测试崩了：', error)
  process.exitCode = 1
})
