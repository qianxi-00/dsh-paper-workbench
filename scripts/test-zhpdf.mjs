/**
 * 中文版 PDF 的单元测试（不联网、不碰真实库）。
 *
 * 跑法：node scripts/test-zhpdf.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createZhPdf, transFingerprint, zhPagesFromDoc, ZH_FILE, ZH_META } from '../lib/zhpdf.js'

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
let savedTrans = trans
let written = { ok: true, blocks: 4, skipped: 0, pages: 3 }
const fakeStore = {
  paperFile: (id, name) => path.join(root, id, name),
  resolvePdf: async () => ({ path: path.join(root, 'paper-z', 'paper.pdf') }),
  readTrans: async () => savedTrans,
}
const runner = createZhPdf({
  store: fakeStore,
  pdf: {
    callTool: async (command, payload) => {
      calls.push([command, payload])
      fs.writeFileSync(payload.out, 'zh-pdf-bytes')
      return written
    },
  },
})

check('status：还没生成', (await runner.status('paper-z')).exists === false)

let missing = ''
try { await runner.build('paper-z', { doc }) } catch (error) { missing = error.message }
check('缺少任何可写回译文都不调用渲染器', /缺少.*译文/.test(missing) && calls.length === 0, missing)
calls.length = 0
savedTrans = { entries: { ...trans.entries, h6: { zh: '最后一段。' } } }

const built = await runner.build('paper-z', { doc })
equal('build：走 zhpdf 命令', calls.map(item => item[0]), ['zhpdf'])
equal('build：返回统计', [built.blocks, built.skipped, built.pages], [4, 0, 3])
equal('build：输出文件是 paper-zh.pdf', path.basename(built.path), ZH_FILE)
check('build：payload 带 lineheight 与 pages', calls[0][1].lineheight > 0 && calls[0][1].pages.length === 3)
equal('build：payload 每段都有原文和译文',
  [calls[0][1].pages[0].blocks[0].source, calls[0][1].pages[0].blocks[0].text], ['Introduction', '引言'])

const status = await runner.status('paper-z')
check('status：存在且有大小', status.exists === true && status.size > 0)
equal('status：没有 generating 记录时报出块数/页数', [status.blocks, status.pages], [4, 3])
check('status：生成记录里存的是当前译文指纹',
  JSON.parse(fs.readFileSync(path.join(paperDir, ZH_META), 'utf8')).transHash === transFingerprint(savedTrans))
check('status：刚生成完不算过期', status.stale === false)

const published = fs.readFileSync(built.path)
const publishedMeta = fs.readFileSync(path.join(paperDir, ZH_META))
written = { ok: true, blocks: 3, skipped: 1, pages: 3 }
let skippedFailure = ''
try { await runner.build('paper-z', { doc }) } catch (error) { skippedFailure = error.message }
check('渲染漏段时拒绝发布并保留原文件与元数据', Boolean(skippedFailure) &&
  fs.readFileSync(built.path).equals(published) && fs.readFileSync(path.join(paperDir, ZH_META)).equals(publishedMeta), skippedFailure)
written = { ok: true, blocks: 4, skipped: 0, pages: 3 }

const sourcePath = path.join(paperDir, 'paper.pdf')
const sourceChange = createZhPdf({ store: fakeStore, pdf: { callTool: async (_command, payload) => {
  fs.writeFileSync(payload.out, 'different-pdf-bytes')
  fs.writeFileSync(sourcePath, 'swap')
  return written
} } })
let staleSource = ''
try { await sourceChange.build('paper-z', { doc }) } catch (error) { staleSource = error.message }
check('生成期间源 PDF 被等长替换时保留旧文件', /源 PDF/.test(staleSource) &&
  fs.readFileSync(built.path).equals(published) && fs.readFileSync(path.join(paperDir, ZH_META)).equals(publishedMeta), staleSource)
check('源 PDF 改变后旧中文版过期', (await runner.status('paper-z')).stale)
fs.writeFileSync(sourcePath, 'fake')

const blockedMeta = path.join(paperDir, ZH_META + '.tmp')
fs.mkdirSync(blockedMeta)
let metaFailure = ''
try {
  await createZhPdf({ store: fakeStore, pdf: { callTool: async (_command, payload) => {
    fs.writeFileSync(payload.out, 'different-pdf-bytes')
    return written
  } } }).build('paper-z', { doc })
} catch (error) { metaFailure = error.message }
fs.rmSync(blockedMeta, { recursive: true })
check('元数据发布失败时回滚PDF并保留旧元数据', Boolean(metaFailure) &&
  fs.readFileSync(built.path).equals(published) && fs.readFileSync(path.join(paperDir, ZH_META)).equals(publishedMeta), metaFailure)

check('status：doc.json 更新后判定为过期',
  await (async () => {
    fs.writeFileSync(path.join(paperDir, 'doc.json'), '{}')
    const later = new Date(Date.now() + 2000)
    fs.utimesSync(path.join(paperDir, 'doc.json'), later, later)
    return (await runner.status('paper-z')).stale === true
  })())

check('status：译文改了也判定为过期（不依赖 doc.json 时间）',
  await (async () => {
    const changed = { entries: { h1: { zh: '第一段（改过）。' }, h3: { zh: '第二段。' }, h5: { zh: '引言' } } }
    const runner2 = createZhPdf({ store: { ...fakeStore, readTrans: async () => changed }, pdf: null })
    return (await runner2.status('paper-z')).stale === true
  })())

check('status：没有生成记录的老文件算过期',
  await (async () => {
    fs.rmSync(path.join(paperDir, ZH_META), { force: true })
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

const splitDoc = { paragraphs: [{
  hash: 'split', kind: 'body', page: 1, crossPage: true,
  text: 'The first part continues onto the next page.',
  pageFragments: [{ page: 1, text: 'The first part', bbox: [10, 70, 90, 85] }, { page: 2, text: 'continues onto the next page.', bbox: [10, 5, 185, 20] }],
}, { hash: 'bare', kind: 'body', page: 3, text: 'A unique line without a box.' }] }
const splitTrans = { entries: { split: { zh: '第一部分接到下一页。' }, bare: { zh: '一行没有坐标的文字。' } } }
let recoveryCalls = 0
const recovery = createZhPdf({ store: { ...fakeStore, readTrans: async () => splitTrans }, pdf: { pageLines: async () => ({ ok: true, lines: [
  { text: 'A unique line without a box.', x: 10, y: 30, x2: 200, y2: 44 },
] }), callTool: async (_command, payload) => {
  recoveryCalls += 1
  equal('跨页段按页写回，译文不丢字', payload.pages.slice(0, 2).flatMap(item => item.blocks.map(block => block.text)).join(''), '第一部分接到下一页。')
  equal('无框段从唯一匹配的本地文本行恢复', payload.pages[2]?.blocks[0].rect, [10, 30, 200, 44])
  fs.writeFileSync(payload.out, 'zh-pdf-bytes')
  return { ok: true, blocks: 3, skipped: 0, pages: 3 }
} } })
let geometryFailure = ''
try { await recovery.build('paper-z', { doc: splitDoc }) } catch (error) { geometryFailure = error.message }
check('跨页及缺失坐标可恢复后才渲染', recoveryCalls === 1 && !geometryFailure, geometryFailure)

let cannotLocate = ''
try { await recovery.build('paper-z', { doc: { paragraphs: [...splitDoc.paragraphs, { hash: 'wrong', kind: 'body', page: 3, text: 'Not on this page.' }] } }) }
catch (error) { cannotLocate = error.message }
check('无法恢复的段落带页码阻止发布', /第 3 页/.test(cannotLocate) && recoveryCalls === 1, cannotLocate)

await runner.clear('paper-z')
check('clear 删掉文件与生成记录',
  !fs.existsSync(path.join(paperDir, ZH_FILE)) && !fs.existsSync(path.join(paperDir, ZH_META)))

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
