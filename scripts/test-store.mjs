/**
 * store 层回归测试：重点盯 2026-11-11 那次「同一篇被并发导入成两条」的事故。
 *
 *   node scripts/test-store.mjs
 *
 * 只碰临时文件：把样例 PDF 复制到 %TEMP%，跑完删掉库记录与临时文件。
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { addPaper, listPapers, removePaper } from '../lib/store.js'

const SAMPLE = 'G:\\笔记\\LLM知识体系论文\\加速训练\\FlashAttention.pdf'

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

async function main() {
  const tmp = path.join(os.tmpdir(), 'pb-store-race-' + Date.now() + '.pdf')
  await fsp.copyFile(SAMPLE, tmp)

  const meta = { title: '[test] 并发去重', srcPath: tmp, hasText: true, topics: ['测试'] }
  // 关键：两个 addPaper 并发进来。以前查重在临界区外，会各插一条。
  const [first, second] = await Promise.all([addPaper(meta), addPaper({ ...meta })])

  check('并发 addPaper 只新增一条', Number(first.existed) + Number(second.existed) === 1,
    `existed=${first.existed}/${second.existed}`)
  check('两次返回同一条记录', first.meta.id === second.meta.id, first.meta.id)

  const list = await listPapers()
  const same = list.filter((item) => String(item.srcPath || '').toLowerCase() === tmp.toLowerCase())
  check('库里该路径只有一条', same.length === 1, `找到 ${same.length} 条`)

  // 串行第二次必须是 existed:true，且不新增
  const third = await addPaper({ ...meta })
  check('串行重复导入返回 existed:true', third.existed === true && third.meta.id === first.meta.id)

  await removePaper(first.meta.id)
  await fsp.rm(tmp, { force: true })
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
