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

  const { meta } = await store.addPaper({ title: '[test] 安全', srcPath: pdf, hasText: true, pageCount: 12 })
  check('建了一篇测试论文', Boolean(meta.id), meta.id)

  // ---- 1) 回收站名字逃逸
  await expectError("purgeTrash('.') 要拒绝", () => store.purgeTrash('.'))
  await expectError("purgeTrash('..') 要拒绝", () => store.purgeTrash('..'))
  await expectError('purgeTrash 带路径分隔符要拒绝', () => store.purgeTrash('a/../b'))
  await expectError('purgeTrash 反斜杠路径要拒绝', () => store.purgeTrash('..\\x'))
  await expectError('purgeTrash 空名要拒绝', () => store.purgeTrash(''))
  await expectError("restoreTrash('.') 要拒绝", () => store.restoreTrash('.'))
  await expectError("restoreTrash('..') 要拒绝", () => store.restoreTrash('..'))
  await expectError('restoreTrash 带路径分隔符要拒绝', () => store.restoreTrash('a/../b'))
  check('数据根还在', await exists(path.join(root, 'index.json')))

  // ---- 1b) API 边界防注入：library.update 禁止篡改 srcPath，vault.open 禁止跨出知识库，upload 与 search.doc 正常可用
  const { createApi } = await import('../lib/index.js')
  const api = createApi()
  await expectError('library.update 拒绝篡改 srcPath', () =>
    api['library.update']({ id: meta.id, patch: { srcPath: path.join(root, 'config.json'), storage: 'link' } }),
  )
  await store.setConfig({ vault: root, kb: root })
  await expectError('vault.open 拒绝知识库外路径', () =>
    api['vault.open']({ path: path.resolve(root, '..', 'outside.md') }),
  )
  await expectError('vault.open 拒绝非 .md 文件', () =>
    api['vault.open']({ path: path.join(root, 'index.json') }),
  )
  await store.writeTextCache(meta.id, {
    pages: [{ n: 2, w: 600, h: 800, blocks: [{ x: 40, y: 100, x2: 500, y2: 120, size: 11, text: 'Prompt tuning safety probe.' }] }],
  })
  const docHits = await api['search.doc']({ id: meta.id, query: 'safety' })
  check(
    'search.doc 返回真实段落 hash 与 sectionId',
    /^[0-9a-f]{16}$/.test(docHits.hits[0]?.key || '') && Boolean(docHits.hits[0]?.sectionId),
    JSON.stringify(docHits.hits[0] && { key: docHits.hits[0].key, sectionId: docHits.hits[0].sectionId }),
  )
  // upload 端点（验证 randomUUID 与 PDF 字节流落库正常）
  const { Readable } = await import('node:stream')
  const uploadReq = Readable.from([Buffer.from('%PDF-1.4\n%fake\n')])
  const uploaded = await api.upload({ req: uploadReq, url: new URL('http://127.0.0.1/paper-workbench/api/upload?name=upload-test.pdf') })
  check('upload 端点正常生成临时文件并入库', Boolean(uploaded.meta && uploaded.meta.id), uploaded.meta && uploaded.meta.id)
  if (uploaded.meta?.id) {
    const upRemoved = await store.removePaper(uploaded.meta.id)
    const upTrashed = (await store.listTrash()).find((item) => item.id === uploaded.meta.id)
    if (upTrashed) await store.purgeTrash(upTrashed.name)
  }

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
  check('论文进了回收站且保留页数', Boolean(trashed) && trashed.pages === 12, removed && removed.name)
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

  // ---- 5) HTTP HEAD 不返回实体、同 reqId 重试不误删新流
  const http = await import('node:http')
  const { createHandler } = await import('../lib/server.js')
  const pagePng = path.join(root, 'page1.png')
  await fsp.writeFile(pagePng, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const abortedSignals = []
  let activeResolve1
  let activeResolve2
  let streamCalls = 0
  const srvHandler = createHandler({
    prefix: '/paper-workbench',
    appDir: path.resolve('assets/app'),
    api: {
      pageImage: async () => ({ path: pagePng, mime: 'image/png' }),
      figureImage: async () => ({ path: pagePng, mime: 'image/png' }),
    },
    streams: {
      translate: async function* (_body, { signal }) {
        const idx = ++streamCalls
        signal.addEventListener('abort', () => abortedSignals.push(idx), { once: true })
        yield { event: 'start', data: { idx } }
        await new Promise(resolve => {
          if (idx === 1) activeResolve1 = resolve
          else activeResolve2 = resolve
        })
      },
    },
  })
  const server = http.createServer(srvHandler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/paper-workbench'
  try {
    for (const urlPath of ['/app/style.css', '/api/page?id=x&page=1', '/api/figure?id=x&index=0']) {
      const headRes = await fetch(baseUrl + urlPath, { method: 'HEAD' })
      const bodyText = await headRes.text()
      check('HEAD ' + urlPath + ' 返回 200 且空响应体', headRes.status === 200 && bodyText.length === 0 && Number(headRes.headers.get('content-length')) > 0)
    }
    const req1 = fetch(baseUrl + '/ai/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reqId: 'dup-req-1' }),
    })
    await new Promise(r => setTimeout(r, 30))
    const req2 = await fetch(baseUrl + '/ai/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reqId: 'dup-req-1' }),
    })
    await new Promise(r => setTimeout(r, 30))
    if (activeResolve1) activeResolve1({ done: true })
    await (await req1).text().catch(() => {})
    check('相同 reqId 新流会先中止旧流(#1)而不中止自身(#2)', abortedSignals.length === 1 && abortedSignals[0] === 1, abortedSignals.join(','))
    const cancelRes = await fetch(baseUrl + '/ai/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reqId: 'dup-req-1' }),
    }).then(r => r.json())
    if (activeResolve2) activeResolve2({ done: true })
    await (await req2).text().catch(() => {})
    check('旧流结束不误删同 reqId 新流控制器，cancel 仍能命中(#2)', cancelRes.ok === true && abortedSignals.includes(2), JSON.stringify(cancelRes))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

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
