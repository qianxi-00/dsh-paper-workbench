#!/usr/bin/env node
/**
 * 工具层测试：不启动 DSH，直接 import createApi() + createTools() 调用 7 个工具，
 * 验证 agent 真正会拿到的返回值（而不只是 HTTP 接口）。
 *
 *   node scripts/test-tools.mjs
 * 会往库里写一篇样例（幂等），并写入一条笔记与一页译文。
 */
import { createApi } from '../lib/index.js'
import { createTools, parsePages } from '../lib/tools.js'

const api = createApi()
const tools = new Map(createTools(api).map((tool) => [tool.name, tool]))
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

async function call(name, args) {
  const tool = tools.get(name)
  if (!tool) throw new Error('没有这个工具：' + name)
  return tool.execute(args || {}, {})
}

function body(result) {
  return result && typeof result.text === 'string' ? result.text : ''
}

async function main() {
  check('注册了 7 个工具', tools.size === 7, [...tools.keys()].join(', '))
  check('parsePages "1-3,5"', JSON.stringify(parsePages('1-3,5', 10)) === '[1,2,3,5]')
  check('parsePages all 上限', parsePages('all', 10).length === 10)

  const imported = await call('paper_import', { path: SAMPLE, topic: '加速训练' })
  check('paper_import 按路径入库', imported.isError === false && body(imported).includes('"id"'), body(imported).split('\n')[0])
  const id = JSON.parse(body(imported)).id

  const list = await call('paper_library', { action: 'list' })
  check('paper_library 列表', list.isError === false && JSON.parse(body(list)).papers.some((p) => p.id === id))

  const meta = await call('paper_read', { id, mode: 'meta' })
  check('paper_read meta', body(meta).includes('"pageCount"'), 'pageCount=' + JSON.parse(body(meta)).pageCount)

  const text = await call('paper_read', { id, pages: '1-1' })
  check('paper_read 文本', text.isError === false && body(text).includes('FlashAttention'), body(text).split('\n')[0])

  const outline = await call('paper_read', { id, mode: 'outline' })
  check('paper_read 目录', outline.isError === false && body(outline).includes('p.1'))

  const bad = await call('paper_read', { id: 'no-such-paper-000' })
  check('错误 id 返回 isError', bad.isError === true && body(bad).includes('失败'))

  const online = await call('paper_search_online', { query: 'prompt tuning', limit: 3 })
  check('paper_search_online', online.isError === false && JSON.parse(body(online)).length > 0)

  const notes = await call('paper_notes', { id, action: 'add', text: '工具测试高亮', page: 2, note: '' })
  check('paper_notes 追加', notes.isError === false && body(notes).includes('已保存'))
  const notesList = await call('paper_notes', { id, action: 'list' })
  check('paper_notes 读回', body(notesList).includes('工具测试高亮'))

  const translated = await call('paper_translate', { id, page: 1, markdown: '这是第 1 页的中文译文（工具测试）。', mode: 'replace' })
  check('paper_translate 写入', translated.isError === false && body(translated).includes('p.1'))

  const vault = await call('paper_obsidian', { action: 'status' })
  check('paper_obsidian 状态', vault.isError === false && body(vault).includes('"ok": true'))

  const search = await call('paper_obsidian', { action: 'search', query: 'FlashAttention' })
  check('paper_obsidian 检索', search.isError === false && JSON.parse(body(search)).hits.length > 0)

  console.log('')
  console.log('结果：PASS ' + pass + ' / FAIL ' + fail)
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('工具测试异常：' + (error && error.stack ? error.stack : error))
  process.exitCode = 1
})
