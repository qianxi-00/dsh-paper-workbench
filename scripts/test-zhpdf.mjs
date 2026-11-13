/**
 * 中文版 PDF 的单元测试（不联网、不碰真实库）。
 *
 * 跑法：node scripts/test-zhpdf.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createZhPdf, zhPagesFromDoc, ZH_FILE } from '../lib/zhpdf.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`PASS ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}
function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const doc = {
  paragraphs: [
    { hash: 'h1', kind: 'body', page: 2, text: 'First paragraph.', bbox: [10, 20, 300, 40] },
    { hash: 'h2', kind: 'formula', page: 2, text: '', latex: 'x=1', bbox: [10, 50, 300, 70] },
    { hash: 'h3', kind: 'body', page: 3, text: 'Second paragraph.', bbox: [10, 80, 300, 100] },
    { hash: 'h4', kind: 'figure', page: 3, text: '[图 1]', bbox: [10, 110, 300, 200] },
    { hash: 'h5', kind: 'heading', page: 1, text: 'Introduction', bbox: [10, 10, 200, 24] },
    { hash: 'h6', kind: 'body', page: 3, text: 'Not translated.', bbox: [10, 210, 300, 230] },
    { hash: 'h7', kind: 'table', page: 3, text: 'a | b', bbox: [10, 240, 300, 260] },
  ],
}
const trans = { entries: { h1: { zh: '第一段。' }, h3: { zh: '第二段。' }, h5: { zh: '引言' }, h2: { zh: '公式' } } }

const pages = zhPagesFromDoc(doc, trans)
equal('只带「有译文 + 可替换」的段落：页数与顺序', pages.map(page => page.n), [1, 2, 3])
equal('第 1 页只有标题', pages[0].blocks.map(block => block.text), ['引言'])
equal('公式/图/表不参与替换', pages[1].blocks.map(block => block.text), ['第一段。'])
equal('没译文的段落被跳过', pages[2].blocks.map(block => block.text), ['第二段。'])
equal('rect 四舍五入到 2 位', pages[1].blocks[0].rect, [10, 20, 300, 40])
check('带上原文（用来在 PDF 里找行）', pages[1].blocks[0].source === 'First paragraph.')

const entriesAsText = zhPagesFromDoc(doc, { entries: { h1: '纯文本形式' } })
equal('译文是纯字符串也认', entriesAsText[0].blocks[0].text, '纯文本形式')
equal('空译文跳过', zhPagesFromDoc(doc, { entries: { h1: { zh: '   ' } } }), [])

// ---------------------------------------------------------------- build / status

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-zhpdf-test-'))
const paperDir = path.join(root, 'paper-z')
fs.mkdirSync(paperDir, { recursive: true })
fs.writeFileSync(path.join(paperDir, 'paper.pdf'), 'fake')
const calls = []
const fakeStore = {
  paperFile: (id, name) => path.join(root, id, name),
  resolvePdf: async () => ({ path: path.join(root, 'paper-z', 'paper.pdf') }),
  readTrans: async () => trans,
}
const runner = createZhPdf({
  store: fakeStore,
  pdf: {
    callTool: async (command, payload) => {
      calls.push([command, payload])
      fs.writeFileSync(payload.out, 'zh-pdf-bytes')
      return { ok: true, blocks: 3, skipped: 1, pages: 3 }
    },
  },
})

check('status：还没生成', (await runner.status('paper-z')).exists === false)

const built = await runner.build('paper-z', { doc })
equal('build：走 zhpdf 命令', calls.map(item => item[0]), ['zhpdf'])
equal('build：返回统计', [built.blocks, built.skipped, built.pages], [3, 1, 3])
equal('build：输出文件是 paper-zh.pdf', path.basename(built.path), ZH_FILE)
check('build：payload 带 lineheight 与 pages', calls[0][1].lineheight > 0 && calls[0][1].pages.length === 3)
equal('build：payload 每段都有原文和译文',
  [calls[0][1].pages[0].blocks[0].source, calls[0][1].pages[0].blocks[0].text], ['Introduction', '引言'])

const status = await runner.status('paper-z')
check('status：存在且有大小', status.exists === true && status.size > 0)
check('status：doc.json 更新后判定为过期',
  await (async () => {
    fs.writeFileSync(path.join(paperDir, 'doc.json'), '{}')
    const later = new Date(Date.now() + 2000)
    fs.utimesSync(path.join(paperDir, 'doc.json'), later, later)
    return (await runner.status('paper-z')).stale === true
  })())

let noTrans = ''
try {
  await createZhPdf({
    store: { ...fakeStore, readTrans: async () => ({ entries: {} }) },
    pdf: { callTool: async () => ({ ok: true }) },
  }).build('paper-z', { doc })
} catch (error) {
  noTrans = error.message
}
check('没有译文时给中文提示', noTrans.includes('还没有译文'), noTrans)

let noDoc = ''
try {
  await runner.build('paper-z', {})
} catch (error) {
  noDoc = error.message
}
check('没有文档模型时给中文提示', noDoc.includes('文档模型'), noDoc)

let failure = ''
try {
  await createZhPdf({
    store: fakeStore,
    pdf: { callTool: async () => ({ ok: false, error: '磁盘满了' }) },
  }).build('paper-z', { doc })
} catch (error) {
  failure = error.message
}
check('工具报错时带上原因', failure.includes('磁盘满了'), failure)

await runner.clear('paper-z')
check('clear 删掉文件', !fs.existsSync(path.join(paperDir, ZH_FILE)))

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
