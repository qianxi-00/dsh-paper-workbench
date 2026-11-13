/**
 * 存储安全回归测试（可毁库/丢数据那几条）。
 *
 *   node scripts/test-safety.mjs
 *
 * 全程指向 %TEMP% 的临时数据根，跑完删目录，绝不碰 ~/.dsh/paper-workbench。
 *
 * 盯的四个事故：
 *   1) purgeTrash('..') 会把 path.join 折叠成数据根，把整个库删光（RPC 直接透传名字）；
 *   2) 两路并发 writeTrans 各删对方的 key，最终译文全空（两窗口/两路 SSE 就能触发）；
 *   3) 彻底删除论文后译文/日志/自检还留在库里，重新导入同 id 会「继承」隐私数据；
 *   4) index.json 坏掉时重建路径把坏文件复制成 .bak，毁掉唯一备份。
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const stamp = Date.now() + '-' + process.pid
const root = path.join(os.tmpdir(), 'pb-safety-' + stamp)
process.env.DSH_PAPER_WORKBENCH_DATA = root

const store = await import('../lib/store.js')
const db = await import('../lib/db.js')

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

async function expectError(name, fn) {
  try {
    await fn()
    check(name, false, '没有抛错')
  } catch (error) {
    check(name, true, '「' + error.message + '」')
  }
}

async function exists(target) {
  return fsp.stat(target).then(() => true, () => false)
}

async function main() {
  const pdf = path.join(root, 'sample.pdf')
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(pdf, 'fake-pdf-bytes')

  const { meta } = await store.addPaper({ title: '[test] 安全', srcPath: pdf, hasText: true })
  check('建了一篇测试论文', Boolean(meta.id), meta.id)

  // ---- 1) 回收站名字逃逸
  await expectError("purgeTrash('.') 要拒绝", () => store.purgeTrash('.'))
  await expectError("purgeTrash('..') 要拒绝", () => store.purgeTrash('..'))
  await expectError('purgeTrash 带路径分隔符要拒绝', () => store.purgeTrash('a/../b'))
  await expectError('purgeTrash 反斜杠路径要拒绝', () => store.purgeTrash('..\\x'))
  await expectError('purgeTrash 空名要拒绝', () => store.purgeTrash(''))
  check('数据根还在', await exists(path.join(root, 'index.json')))

  // ---- 2) 并发 writeTrans 不互删
  const id = meta.id
  // 翻译流用的是增量合并（mergeTrans）：两路并发各写各的段，谁都不能删对方的 key。
  await Promise.all([
    store.mergeTrans(id, { target: 'zh', entries: { 'seg-a1': { zh: '甲一' }, 'seg-a2': { zh: '甲二' } } }),
    store.mergeTrans(id, { target: 'zh', entries: { 'seg-b1': { zh: '乙一' }, 'seg-b2': { zh: '乙二' } } }),
  ])
  const after = await store.readTrans(id)
  const keys = Object.keys(after.entries).sort()
  check('两路并发写译文后 key 都还在', keys.length === 4, keys.join(','))
  check('并发写没有把译文写成空串', Object.values(after.entries).every((item) => item.zh !== ''))

  // ---- 3) 彻底删除要清掉译文/日志/自检
  await store.writeReview(id, { mode: 'static', issues: [{ key: 'seg-a1', code: 'too-short' }], stats: { checked: 1 } })
  await db.jobAppend(id, { kind: 'translate', message: '开始翻译' })
  const removed = await store.removePaper(id)
  const trashed = (await store.listTrash()).find((item) => item.id === id)
  check('论文进了回收站', Boolean(trashed), removed && removed.name)
  await store.purgeTrash(trashed.name)
  check('彻底删除后译文清空', Object.keys((await store.readTrans(id)).entries).length === 0)
  check('彻底删除后日志清空', db.jobList(id).events.length === 0)
  check('彻底删除后自检清空', (await store.readReview(id)) === null)

  // ---- 4) index.json 坏掉时不要毁掉 .bak
  await store.setConfig({ python: 'x' }) // 确保目录结构齐全
  await fsp.writeFile(path.join(root, 'index.json.bak'), '{"version":1,"papers":[]}', 'utf8')
  const goodBak = await fsp.readFile(path.join(root, 'index.json.bak'), 'utf8')
  await fsp.writeFile(path.join(root, 'index.json'), '{ 这不是 JSON', 'utf8')
  await store.listPapers() // 触发从 papers/*/meta.json 重建
  const keptBak = await fsp.readFile(path.join(root, 'index.json.bak'), 'utf8').catch(() => '')
  check('重建索引不会把坏文件复制成 .bak', keptBak === goodBak, keptBak.slice(0, 40))

  console.log('')
  console.log(pass + ' PASS / ' + fail + ' FAIL')
  await store.closeDb()
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error('测试崩了：', error)
  await store.closeDb().catch(() => {})
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  process.exit(1)
})
