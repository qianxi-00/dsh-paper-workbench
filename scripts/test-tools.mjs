#!/usr/bin/env node
/**
 * 工具层测试：不启动 DSH，直接 import createApi() + createTools() 调用 10 个工具，
 * 验证 agent 真正会拿到的返回值（而不只是 HTTP 接口）。
 *
 *   node scripts/test-tools.mjs
 * 会隔离在临时目录（DSH_PAPER_WORKBENCH_DATA）运行，若无本地样例 PDF 则自动生成合成 PDF。
 */
import { execFileSync } from 'node:child_process'
import fs, { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ownTmp = !process.env.DSH_PAPER_WORKBENCH_DATA
const tmpRoot = ownTmp
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'pb-tools-test-'))
  : process.env.DSH_PAPER_WORKBENCH_DATA
if (ownTmp) process.env.DSH_PAPER_WORKBENCH_DATA = tmpRoot

const { createApi } = await import('../lib/index.js')
const { createTools, parsePages } = await import('../lib/tools.js')
const { findPython } = await import('../lib/pdf.js')

const api = createApi()
const tools = new Map(createTools(api).map((tool) => [tool.name, tool]))
const LOCAL_SAMPLE = 'G:\\笔记\\LLM知识体系论文\\加速训练\\FlashAttention.pdf'

async function resolveSamplePdf() {
  if (process.env.PB_FORCE_SYNTH_SAMPLE !== '1' && fs.existsSync(LOCAL_SAMPLE)) return { path: LOCAL_SAMPLE, synthetic: false }
  const py = await findPython()
  if (!py || !py.python) throw new Error('CI / 离线样例生成需要可用的 Python + PyMuPDF')
  const outPdf = path.join(tmpRoot, 'FlashAttention-synth.pdf')
  const pyScript = [
    'import fitz, sys',
    'doc = fitz.open()',
    'p1 = doc.new_page()',
    'p1.insert_text((72, 72), "FlashAttention: Fast and Memory-Efficient Exact Attention", fontsize=16)',
    'p1.insert_text((72, 110), "1 Introduction", fontsize=13)',
    'p1.insert_text((72, 138), "We propose FlashAttention, an IO-aware exact attention algorithm that tiles Q, K, V matrices in SRAM.", fontsize=10.5)',
    'p2 = doc.new_page()',
    'p2.insert_text((72, 72), "2 Method", fontsize=13)',
    'p2.insert_text((72, 100), "As illustrated in Figure 1, tiling avoids reading and writing the N x N attention matrix to HBM.", fontsize=10.5)',
    'p2.insert_text((72, 130), "Figure 1: Tiled attention block diagram across SRAM and HBM.", fontsize=9.5)',
    'doc.save(sys.argv[1])',
  ].join('\n')
  execFileSync(py.python, ['-c', pyScript, outPdf], { stdio: 'pipe' })
  return { path: outPdf, synthetic: true }
}

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

async function checkDocPageLimit() {
  const store = await import('../lib/store.js')
  const py = await findPython()
  const pdfPath = path.join(tmpRoot, 'page-limit-synth.pdf')
  execFileSync(py.python, ['-c', [
    'import fitz, sys',
    'doc = fitz.open()',
    'for n in range(1, 202):',
    '    page = doc.new_page()',
    '    page.insert_text((72, 138), "LIMIT REGRESSION CONTENT PAGE " + str(n) + ".", fontsize=10.5)',
    'doc.save(sys.argv[1])',
  ].join('\n'), pdfPath], { stdio: 'pipe' })

  for (const fallback of [false, true]) {
    const id = fallback ? 'p-limit-build' : 'p-limit-get'
    const source = path.join(tmpRoot, id + '.pdf')
    await fsp.copyFile(pdfPath, source)
    await store.addPaper({ id, srcPath: source, title: 'Synthetic page limit', pageCount: 201 })
    const contentCalls = []
    const docTool = createTools({
      ...api,
      'doc.get': async (args) => {
        contentCalls.push('doc.get')
        if (fallback && contentCalls.length === 1) throw new Error('Synthetic missing document')
        return api['doc.get'](args)
      },
      'doc.build': async (args) => {
        contentCalls.push('doc.build')
        return api['doc.build'](args)
      },
    }).find((tool) => tool.name === 'paper_doc')
    const label = fallback ? 'doc.build 回退' : '冷 doc.get'
    const rejected = await docTool.execute({ id, pages: '1-100,51-201' })
    check('paper_doc ' + label + ' 拒绝 201 个唯一页', rejected.isError === true && /200.*本次未读取任何页/.test(body(rejected)))
    check('paper_doc ' + label + ' 超限前不获取或构建正文', contentCalls.length === 0, JSON.stringify(contentCalls))
    const cached = await store.readTextCache(id)
    check('paper_doc ' + label + ' 超限不写正文缓存', !cached || !cached.pages?.length, 'cachedPages=' + (cached?.pages?.length || 0))

    const positive = await docTool.execute({ id, pages: '1-2' })
    check('paper_doc ' + label + ' 合法范围可正常读取', positive.isError === false && body(positive).includes('CONTENT PAGE 1.') && body(positive).includes('[p.2]') && !body(positive).includes('[p.3]'))
    const boundary = await docTool.execute({ id, pages: '1-100,51-200,200', maxChars: 160000 })
    check('paper_doc ' + label + ' 去重后 200 页仍可读取', boundary.isError === false && body(boundary).includes('[p.200]') && !body(boundary).includes('[p.201]'))
  }

  const doc = {
    pdf: { pages: 2 },
    sections: [{ id: 's1', page: 1, title: 'Synthetic section' }],
    paragraphs: [{ section: 's1', page: 1, text: 'STRUCTURE PAGE COUNT FALLBACK' }],
  }
  const fallbackTool = createTools({
    'library.get': async () => ({ meta: { title: 'Synthetic structure', pageCount: 0 } }),
    'doc.get': async () => ({ doc }),
  }).find((tool) => tool.name === 'paper_doc')
  const all = await fallbackTool.execute({ id: 'p-structure', pages: ' ALL ' })
  check('paper_doc all 保留文档页数回退', all.isError === false && body(all).includes('STRUCTURE PAGE COUNT FALLBACK'))
}

async function main() {
  await checkDocPageLimit()
  const sampleInfo = await resolveSamplePdf()
  const SAMPLE = sampleInfo.path
  check('注册了 10 个工具', tools.size === 10 && tools.has('paper_doc') && tools.has('paper_explain'), [...tools.keys()].join(', '))
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

  const docText = await call('paper_doc', { id, maxChars: 4000 })
  const docBody = body(docText)
  check(
    'paper_doc 返回按节的段落文本',
    docText.isError === false && docBody.includes('节清单') && docBody.includes('[p.'),
    docBody.split('\n')[0],
  )

  const explained = await call('paper_explain', { id, mode: 'paper' })
  const explainBody = body(explained)
  check(
    'paper_explain 返回整篇上下文与引用格式',
    explained.isError === false && explainBody.includes('FlashAttention') && explainBody.includes('[p.'),
  )

  if (!sampleInfo.synthetic) {
    const online = await call('paper_search_online', { query: 'prompt tuning', limit: 3 })
    check('paper_search_online', online.isError === false && JSON.parse(body(online)).length > 0)
  } else {
    console.log('PASS  跳过外网 paper_search_online（CI 合成样本模式）')
    pass += 1
  }

  const notes = await call('paper_notes', { id, action: 'add', text: '工具测试高亮', page: 2, note: '' })
  check('paper_notes 追加高亮', notes.isError === false && body(notes).includes('已保存'))
  const studySaved = await call('paper_notes', { id, action: 'save_study_note', title: '工具测试精读', page: 1, markdown: '- 测试研读摘要' })
  check('paper_notes 保存研读笔记', studySaved.isError === false && body(studySaved).includes('"total": 1'))
  const notesList = await call('paper_notes', { id, action: 'list' })
  check('paper_notes 读回', body(notesList).includes('工具测试高亮'))

  const translated = await call('paper_translate', { id, page: 1, markdown: '这是第 1 页的中文译文（工具测试）。', mode: 'replace' })
  check('paper_translate 写入', translated.isError === false && body(translated).includes('p.1'))

  const vault = await call('paper_obsidian', { action: 'status' })
  if (body(vault).includes('"ok": true')) {
    check('paper_obsidian 状态', vault.isError === false)
    const search = await call('paper_obsidian', { action: 'search', query: 'FlashAttention' })
    check('paper_obsidian 检索', search.isError === false && JSON.parse(body(search)).hits.length > 0)
  } else {
    console.log('SKIP  paper_obsidian 状态与检索（当前环境未配置 Obsidian vault）')
  }

  console.log('')
  console.log('结果：PASS ' + pass + ' / FAIL ' + fail)
  if (fail > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('工具测试异常：' + (error && error.stack ? error.stack : error))
    process.exitCode = 1
  })
  .finally(async () => {
    const store = await import('../lib/store.js').catch(() => null)
    if (store && typeof store.closeDb === 'function') await store.closeDb().catch(() => {})
    if (ownTmp) await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })
