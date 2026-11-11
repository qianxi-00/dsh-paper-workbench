#!/usr/bin/env node
/**
 * 接口冒烟测试：直接打 HTTP，覆盖面板真正会走的路径。
 *
 *   node scripts/smoke.mjs [baseUrl]
 *   默认 http://127.0.0.1:57571（scripts/dev-server.mjs）
 *   装进 DSH 后：node scripts/smoke.mjs http://127.0.0.1:57570
 *
 * 注意：会用样例 PDF 真正入库（写 ~/.dsh/paper-workbench），但不会往 Obsidian 写卡片。
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:57571').replace(/\/+$/, '')
const API = BASE + '/paper-workbench/api/'
const SAMPLE = 'G:\\笔记\\LLM知识体系论文\\高效微调\\Prompt Tuning.pdf'

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

async function rpc(method, args = {}) {
  const response = await fetch(API + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const data = await response.json()
  if (!data.ok) throw new Error(method + '：' + data.error)
  return data.value
}

async function main() {
  console.log('BASE ' + BASE)

  const health = await rpc('health')
  check('health 返回插件信息', health.plugin === 'dsh-paper-workbench', 'phase=' + health.phase)
  check('PyMuPDF 可用', Boolean(health.pdf && health.pdf.ok), health.pdf && health.pdf.python)
  console.log('      vault: ' + (health.vault.ok ? health.vault.kb : health.vault.error))

  const imported = await rpc('library.importPath', { path: SAMPLE, topic: '高效微调' })
  check('导入本地 PDF', Boolean(imported.meta && imported.meta.id), 'id=' + (imported.meta && imported.meta.id))
  const id = imported.meta.id

  const list = await rpc('library.list')
  check('文献库列表包含刚导入的论文', list.items.some((item) => item.id === id), '共 ' + list.items.length + ' 篇')

  const detail = await rpc('library.get', { id })
  check('library.get 返回页数与文本标志', detail.meta.pageCount > 0, detail.meta.pageCount + ' 页')

  const text = await rpc('pdf.text', { id, pages: [1] })
  const blocks = (text.pages && text.pages[0] && text.pages[0].blocks) || []
  check('取第 1 页文本块', blocks.length > 0, blocks.length + ' 块')
  check('文本块带坐标与字号', blocks.length > 0 && blocks[0].x2 > blocks[0].x && blocks[0].size > 0)

  const search = await rpc('pdf.search', { id, query: 'prompt' })
  check('全文检索命中', search.hits.length > 0, search.hits.length + ' 处')

  const imageResponse = await fetch(API + 'page?id=' + encodeURIComponent(id) + '&page=1&scale=2')
  const imageBytes = Buffer.from(await imageResponse.arrayBuffer())
  check(
    '页面渲染返回 PNG',
    imageResponse.ok && imageBytes.subarray(1, 4).toString('latin1') === 'PNG',
    imageBytes.length + ' 字节',
  )

  const rawResponse = await fetch(API + 'raw?id=' + encodeURIComponent(id))
  const rawHead = Buffer.from((await rawResponse.arrayBuffer()).slice(0, 5)).toString('latin1')
  check('原始 PDF 端点可用', rawResponse.ok && rawHead === '%PDF-', rawHead)

  await rpc('notes.save', {
    id,
    highlights: [{ page: 1, text: '冒烟测试高亮', note: '', rects: [], color: 'note' }],
  })
  const notes = await rpc('notes.get', { id })
  check('高亮笔记写入并读回', notes.highlights.length === 1, notes.highlights.length + ' 条')

  const online = await rpc('search.online', { query: 'prompt tuning', source: 'arxiv', limit: 2 }).catch((error) => ({ error }))
  check('在线检索（arXiv）', Boolean(online.items && online.items.length > 0), online.error ? String(online.error.message) : (online.items || []).length + ' 条')

  const vault = await rpc('vault.status')
  check('Obsidian 论文知识库可识别', vault.ok === true, vault.ok ? vault.cards + ' 张卡片' : vault.error)

  await rpc('library.remove', { id })
  const after = await rpc('library.list')
  check('删除后列表不再包含', !after.items.some((item) => item.id === id))

  console.log('')
  console.log('结果：PASS ' + pass + ' / FAIL ' + fail)
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('冒烟测试异常：' + (error && error.stack ? error.stack : error))
  process.exitCode = 1
})
