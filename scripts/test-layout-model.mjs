/**
 * 版面模型契约的单元测试（不联网、不碰真实库）。
 *
 * 跑法：node scripts/test-layout-model.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LAYOUT_MODEL,
  LAYOUT_VERSION,
  cleanLatex,
  cleanLayoutBlocks,
  createLayout,
  gridToTableModel,
  headingLevel,
  htmlToTableModel,
  htmlToText,
  labelToKind,
  layoutSummary,
  joinLines,
  looksLikeFormulaText,
  missingHeadPosition,
  normalizeLayout,
  parseLayoutJsonl,
  tableQuality,
} from '../lib/layout.js'

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

const A4 = { n: 1, w: 595, h: 842 }
const SIZE_1191 = { width: 1191, height: 1684 }

function block(label, content, bbox) {
  return { block_label: label, block_content: content, block_bbox: bbox }
}

function page1(blocks) {
  return { n: 1, ...SIZE_1191, blocks }
}

// ---------------------------------------------------------------- 纯函数

equal('labelToKind 基本映射', ['text', 'paragraph_title', 'figure_title', 'formula', 'table', 'image'].map(labelToKind),
  ['body', 'heading', 'caption', 'formula', 'table', 'figure'])
equal('labelToKind 丢弃 header/footer/number', [labelToKind('header'), labelToKind('footer'), labelToKind('number')],
  [null, null, null])
equal('labelToKind 未知标签当正文', labelToKind('something_new'), 'body')

equal('joinLines 行尾连字符', joinLines(['text-', 'only works']), 'text-only works')
equal('joinLines 中文不插空格', joinLines(['本文提出了一种', '新的方法。']), '本文提出了一种新的方法。')
equal('joinLines 英文插空格', joinLines(['hello', 'world']), 'hello world')
equal('missingHeadPosition 缺段首时给出位置',
  missingHeadPosition('Over the past few years, the performance of E2E models has surpassed', 'models has surpassed') > 0, true)
equal('missingHeadPosition 完整时不报警',
  missingHeadPosition('Over the past few years, models has surpassed', 'Over the past few years, models has surpassed'), -1)
equal('cleanLatex $$…$$', cleanLatex('$$E=mc^2$$'), 'E=mc^2')
equal('cleanLatex \\[…\\]', cleanLatex('\\[ a+b \\]'), 'a+b')
equal('cleanLatex equation 环境', cleanLatex('\\begin{equation}x=1\\end{equation}'), 'x=1')
equal('cleanLatex CDATA', cleanLatex('<![CDATA[y=2]]>'), 'y=2')

equal('htmlToText 两行', htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td></td></tr></table>'),
  'a | b\nc')
equal('htmlToText 非表格 HTML', htmlToText('<p>hello <b>world</b></p>'), 'hello world')

equal('headingLevel 2.1', headingLevel('2.1. Training dataset'), 2)
equal('headingLevel 2', headingLevel('2 Method'), 1)
equal('headingLevel 无编号', headingLevel('Method'), null)

const jsonl = [
  { result: { layoutParsingResults: [{ prunedResult: { ...SIZE_1191, parsing_res_list: [block('text', 'x', [0, 0, 10, 10])] } }] } },
].map(row => JSON.stringify(row)).join('\n')
const parsed = parseLayoutJsonl(jsonl)
equal('parseLayoutJsonl 一页', [parsed.pages.length, parsed.skipped, parsed.pages[0].blocks.length], [1, 0, 1])

const parsedBad = parseLayoutJsonl(jsonl + '\nnot json\n{"result":{}}\n')
equal('parseLayoutJsonl 坏行计数', [parsedBad.pages.length, parsedBad.skipped], [1, 2])

let threw = false
try {
  parseLayoutJsonl('')
} catch {
  threw = true
}
check('parseLayoutJsonl 空内容抛错', threw)

const two = parseLayoutJsonl(JSON.stringify({
  result: {
    layoutParsingResults: [
      { prunedResult: { ...SIZE_1191, parsing_res_list: [block('text', 'p1', [0, 0, 10, 10])] } },
      { prunedResult: { ...SIZE_1191, parsing_res_list: [block('text', 'p2', [0, 0, 10, 10])] } },
    ],
  },
}))
equal('parseLayoutJsonl 一行两页连续编号', two.pages.map(page => page.n), [1, 2])

// ---------------------------------------------------------------- normalizeLayout

const layout = normalizeLayout([
  page1([
    block('header', 'arXiv:2601.21957v1 [cs.CV]', [10, 10, 1100, 60]),
    block('paragraph_title', '2 Method', [100, 200, 700, 260]),
    block('text', '服务端 OCR 有错的一句话', [100, 280, 1000, 500]),
    block('image', '', [215, 600, 1005, 900]),
    block('figure_title', 'Figure 2 | Overview of the model.', [215, 910, 1005, 950]),
    block('formula', '$$E=mc^2$$', [300, 1000, 800, 1080]),
    block('table', '<table><tr><td>a</td><td>b</td></tr></table>', [80, 1100, 1100, 1600]),
    block('table_title', 'Table 3 | Results.', [80, 1610, 1100, 1650]),
    block('number', '7', [500, 1660, 600, 1680]),
  ]),
], {
  pageSizes: [A4],
  pageCount: 1,
  textFor: (page, index) => (index === 2 ? '用文本层取到的正文' : (index === 7 ? 'Table 3 | Results.' : '')),
})

equal('normalizeLayout 版本与模型', [layout.version, layout.model], [LAYOUT_VERSION, LAYOUT_MODEL])
equal('normalizeLayout 丢弃 header/number', layout.blocks.map(item => item.kind),
  ['heading', 'body', 'figure', 'caption', 'formula', 'table', 'caption'])
equal('normalizeLayout 正文优先文本层', layout.blocks[1].text, '用文本层取到的正文')
equal('normalizeLayout 公式带 latex 且无正文', [layout.blocks[4].text, layout.blocks[4].latex], ['', 'E=mc^2'])
equal('normalizeLayout 表格有 html 和纯文本', [layout.blocks[5].html.startsWith('<table>'), layout.blocks[5].text],
  [true, 'a | b'])
equal('normalizeLayout bbox 按两轴缩放到 A4',
  [layout.blocks[1].bbox.x, layout.blocks[1].bbox.width],
  [Math.round(100 * 595 / 1191 * 100) / 100, Math.round(900 * 595 / 1191 * 100) / 100])
equal('normalizeLayout 顺序连续', layout.blocks.map(item => item.order), [0, 1, 2, 3, 4, 5, 6])
equal('normalizeLayout 标题层级', layout.blocks[0].level, 1)

equal('normalizeLayout 图与表格各归各的图注',
  layout.figures.map(item => [item.kind, item.caption, item.captionOrder]),
  [['figure', 'Figure 2 | Overview of the model.', 3], ['table', 'Table 3 | Results.', 6]])
equal('normalizeLayout figureIndex 指向 figures', [layout.blocks[2].figureIndex, layout.blocks[5].figureIndex], [0, 1])
equal('normalizeLayout 页尺寸不给时用服务尺寸（无告警）',
  normalizeLayout([page1([block('text', 'x', [0, 0, 10, 10])])], { pageCount: 1 }).warnings, [])
check('normalizeLayout 宽高比不一致有告警',
  normalizeLayout([page1([block('text', 'x', [0, 0, 10, 10])])], { pageSizes: [{ n: 1, w: 612, h: 792 }] }).warnings.length === 1)

const offset = normalizeLayout([page1([block('text', 'x', [0, 0, 10, 10])])], { pageOffset: 50, pageCount: 60 })
equal('normalizeLayout 分片页号偏移', [offset.blocks[0].page, offset.figures.length], [51, 0])

const captionPick = normalizeLayout([page1([
  block('text', '正文', [10, 10, 900, 60]),
  block('figure_title', 'Figure 5: An illustration of the model.', [10, 70, 900, 90]),
  block('text', 'PDF 层掉字距的废文本 P f F t d A t P ll l T', [10, 100, 900, 160]),
  block('text', '', [10, 170, 900, 200]),
])], {
  pageSizes: [A4],
  pageCount: 1,
  textFor: (page, index) => {
    if (index === 0) return '文本层正文'
    if (index === 1) return 'Figure5: Anillustrationofthemodel.'   // PDF 层掉了词间空格
    if (index === 2) return 'P f F t d A t P ll l T f f N t i'
    return ''
  },
})
equal('图注优先用服务端文字（空格没丢）', captionPick.blocks.find(item => item.kind === 'caption').text,
  'Figure 5: An illustration of the model.')
equal('文本层是废字时退回服务端文字', captionPick.blocks[2].text, 'PDF 层掉字距的废文本 P f F t d A t P ll l T')
equal('空正文块被丢掉', captionPick.blocks.some(item => item.text === ''), false)

const summary = layoutSummary(layout)
equal('layoutSummary 统计', [summary.blocks, summary.figures, summary.byKind.body, summary.byKind.caption],
  [7, 2, 1, 2])

// ---------------------------------------------------------------- createLayout（假依赖）

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-layout-model-'))
const paperDir = path.join(root, 'paper-x')
fs.mkdirSync(paperDir, { recursive: true })
const pdfPath = path.join(paperDir, 'paper.pdf')
fs.writeFileSync(pdfPath, 'fake pdf')

const calls = []
const fakeStore = {
  paperFile: (id, name) => path.join(root, id, name),
  getMeta: async id => ({ id, title: '样例' }),
  resolvePdf: async () => ({ path: pdfPath, meta: { id: 'paper-x' } }),
  getConfig: async () => ({ ocr: { token: 'token-1', layoutModel: '' } }),
  readJson: async (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  },
  writeJsonAtomic: async (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  },
}
const fakePdf = {
  callTool: async (command, payload) => {
    calls.push([command, payload])
    if (command === 'info') return { ok: true, pages: 1, sizes: [A4] }
    if (command === 'split') {
      fs.writeFileSync(payload.out, 'part')
      return { ok: true, pages: 1 }
    }
    if (command === 'page_lines') {
      return {
        ok: true,
        page: payload.page,
        lines: [
          { x: 52, y: 52, x2: 448, y2: 70, text: '1 Introduction' },
          { x: 52, y: 92, x2: 498, y2: 110, text: '第一行正文' },
          { x: 52, y: 120, x2: 498, y2: 138, text: '第二行正文' },
        ],
      }
    }
    throw new Error('未预期的命令：' + command)
  },
}
const events = []
const fakeOcr = {
  submitJob: async options => {
    events.push(['submit', options.model, path.basename(options.filePath)])
    return { jobId: 'job-1' }
  },
  pollJob: async options => {
    options.onProgress({ state: 'running', jobId: options.jobId, totalPages: 1, extractedPages: 0 })
    return { state: 'done', jsonUrl: 'http://example.com/x.jsonl' }
  },
  fetchResults: async options => {
    events.push(['fetch', options.withRaw])
    const text = JSON.stringify({
      result: {
        layoutParsingResults: [{
          prunedResult: {
            ...SIZE_1191,
            parsing_res_list: [
              block('paragraph_title', '服务端标题', [100, 100, 900, 160]),
              block('text', '服务端文字', [100, 180, 1000, 400]),
            ],
          },
        }],
      },
    })
    return { pages: [], skipped: 0, text }
  },
}

const runner = createLayout({ store: fakeStore, pdf: fakePdf, ocr: fakeOcr })
const built = await runner.runLayout('paper-x', { onProgress: event => events.push(['emit', event.phase]) })
equal('runLayout 命令顺序', calls.map(item => item[0]), ['info', 'split', 'page_lines'])
equal('runLayout 只上传切片', events.find(item => item[0] === 'submit').slice(1), [LAYOUT_MODEL, 'p1-1.pdf'])
equal('runLayout 取原始结果', events.find(item => item[0] === 'fetch')[1], true)
equal('runLayout 正文按行回填文本层', built.blocks.map(item => item.text),
  ['1 Introduction', '第一行正文第二行正文'])
check('runLayout 落盘 layout.json', fs.existsSync(path.join(paperDir, 'layout.json')))
const reread = await runner.readLayout('paper-x')
equal('readLayout 读回同一份', reread.blocks.length, 2)
check('clearLayout 删得掉', (await runner.clearLayout('paper-x')) && !fs.existsSync(path.join(paperDir, 'layout.json')))

let tokenError = ''
try {
  const noToken = createLayout({
    store: { ...fakeStore, getConfig: async () => ({ ocr: { token: '' } }) },
    pdf: fakePdf,
    ocr: fakeOcr,
  })
  await noToken.runLayout('paper-x')
} catch (error) {
  tokenError = error.message
}
check('没填 Key 时给中文提示', tokenError.includes('API Key'), tokenError)

// 分片：3 页 + 每批 2 页 ⇒ 切两次（1-2、3-3），页号要连续
const batchCalls = []
const batchPdf = {
  callTool: async (command, payload) => {
    batchCalls.push([command, payload.from, payload.to])
    if (command === 'info') return { ok: true, pages: 3, sizes: [A4, A4, A4] }
    if (command === 'split') {
      fs.writeFileSync(payload.out, 'part')
      return { ok: true, pages: payload.to - payload.from + 1 }
    }
    if (command === 'page_lines') {
      return {
        ok: true,
        page: payload.page,
        lines: [{ x: 10, y: 12, x2: 300, y2: 28, text: '第' + payload.page + '页正文' }],
      }
    }
    throw new Error('未预期的命令：' + command)
  },
}
let batchSpan = 1
const batchOcr = {
  submitJob: async options => {
    const match = /p(\d+)-(\d+)\.pdf$/.exec(path.basename(options.filePath))
    batchSpan = match ? Number(match[2]) - Number(match[1]) + 1 : 1
    return { jobId: 'job-b' }
  },
  pollJob: async () => ({ state: 'done', jsonUrl: 'http://example.com/b.jsonl' }),
  fetchResults: async () => ({
    pages: [],
    skipped: 0,
    text: JSON.stringify({
      result: {
        layoutParsingResults: Array.from({ length: batchSpan }, () => ({
          prunedResult: { ...SIZE_1191, parsing_res_list: [block('text', '页', [10, 10, 900, 60])] },
        })),
      },
    }),
  }),
}
const batchRunner = createLayout({ store: fakeStore, pdf: batchPdf, ocr: batchOcr })
const batched = await batchRunner.runLayout('paper-x', { batchPages: 2 })
equal('分片：3 页按 2 页一批切两次', batchCalls.filter(item => item[0] === 'split').map(item => [item[1], item[2]]),
  [[1, 2], [3, 3]])
equal('分片：页号连续', batched.blocks.map(item => item.page), [1, 2, 3])

// 断点续跑：跑到一半断了，下次只补没跑完的批次（不重新上传，也就不会重复计费）
const resumeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-layout-resume-'))
const resumeDir = path.join(resumeRoot, 'paper-r')
fs.mkdirSync(resumeDir, { recursive: true })
const resumePdfPath = path.join(resumeDir, 'paper.pdf')
fs.writeFileSync(resumePdfPath, 'fake pdf for resume')
const resumeStore = {
  paperFile: (id, name) => path.join(resumeRoot, id, name),
  getMeta: async id => ({ id, title: '续跑样例' }),
  resolvePdf: async () => ({ path: resumePdfPath, meta: { id: 'paper-r' } }),
  getConfig: async () => ({ ocr: { token: 'token-1', layoutModel: '' } }),
  readJson: async (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  },
  writeJsonAtomic: async (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  },
}
const resumeSplits = []
const resumePdf = {
  callTool: async (command, payload) => {
    if (command === 'info') return { ok: true, pages: 3, sizes: [A4, A4, A4] }
    if (command === 'split') {
      resumeSplits.push(payload.from)
      fs.writeFileSync(payload.out, 'part')
      return { ok: true, pages: payload.to - payload.from + 1 }
    }
    if (command === 'page_lines') return { ok: true, page: payload.page, lines: [] }
    throw new Error('未预期的命令：' + command)
  },
}
let resumeUploads = 0
let resumeBroken = true
const resumeOcr = {
  submitJob: async () => {
    resumeUploads += 1
    if (resumeBroken && resumeUploads === 2) throw new Error('网络断了')
    return { jobId: 'job-r' + resumeUploads }
  },
  pollJob: async () => ({ state: 'done', jsonUrl: 'http://example.com/r.jsonl' }),
  fetchResults: async () => ({
    pages: [],
    skipped: 0,
    text: JSON.stringify({
      result: {
        layoutParsingResults: [{
          prunedResult: { ...SIZE_1191, parsing_res_list: [block('text', '正文', [10, 10, 900, 60])] },
        }],
      },
    }),
  }),
}
const resumeRunner = createLayout({ store: resumeStore, pdf: resumePdf, ocr: resumeOcr })
let broke = ''
try {
  await resumeRunner.runLayout('paper-r', { batchPages: 1 })
} catch (error) {
  broke = error.message
}
check('断点：第二批失败会把错误抛出来', broke === '网络断了', broke)
const partial = await resumeRunner.readPartial('paper-r')
equal('断点：已完成的第一批落盘', [partial.pages.length, partial.jobs.length], [1, 1])
check('断点：部分结果不写 layout.json', !fs.existsSync(path.join(resumeDir, 'layout.json')))

resumeBroken = false
resumeSplits.length = 0
const resumed = await resumeRunner.runLayout('paper-r', { batchPages: 1, resume: true })
equal('续跑：只上传剩下的两批', resumeSplits, [2, 3])
equal('续跑：页号仍然连续', resumed.blocks.map(item => item.page), [1, 2, 3])
equal('续跑：记下续跑的页数', resumed.resumedPages, 1)
check('续跑：完成后清掉断点文件', !fs.existsSync(path.join(resumeDir, 'layout.partial.json')))
fs.rmSync(resumeRoot, { recursive: true, force: true })

// ---------------------------------------------------------------- 块清理

equal('looksLikeFormulaText 乱序公式', looksLikeFormulaText('N X LNAT = log P (yn | X; θ) (2)'), true)
equal('looksLikeFormulaText 带希腊字母的式子', looksLikeFormulaText('werr(x, y∗) Ltotal = γLCE + LMAE + LN (6)'), true)
equal('looksLikeFormulaText 普通正文', looksLikeFormulaText('The predictor consists of two convolution layers, with the output being a float weight.'), false)
equal('looksLikeFormulaText 带等号的正文句子', looksLikeFormulaText('The number of neighbours equals the batch size we used.'), false)
equal('looksLikeFormulaText 空串', looksLikeFormulaText('   '), false)
// 「公式后面跟一句 where α = …」很常见：不能因为长相像公式就把整句删掉
equal('looksLikeFormulaText 公式旁的正文短句', looksLikeFormulaText('where α = 0.3, β = 0.7 and γ = 0.1'), false)
const guarded = cleanLayoutBlocks([
  { order: 0, page: 1, kind: 'body', text: 'where α = 0.3, β = 0.7 and γ = 0.1', bbox: { x: 10, y: 100, width: 200, height: 16 } },
  { order: 1, page: 1, kind: 'formula', text: '', latex: '\\alpha+\\beta=\\gamma', bbox: { x: 40, y: 112, width: 150, height: 24 } },
])
equal('clean 不删公式旁的正文短句', [guarded.dropped, guarded.blocks.length], [0, 2])

const cleanedBlocks = cleanLayoutBlocks([
  { order: 0, page: 1, kind: 'body', text: 'N X LNAT = log P (yn | X; θ) (2)', bbox: { x: 10, y: 100, width: 200, height: 16 } },
  { order: 1, page: 1, kind: 'formula', text: '', latex: '\\mathcal{L}_{NAT}=\\sum', bbox: { x: 40, y: 118, width: 150, height: 24 } },
  { order: 2, page: 1, kind: 'body', text: 'The model is trained with two losses and the details are', bbox: { x: 10, y: 300, width: 300, height: 16 } },
  { order: 3, page: 1, kind: 'body', text: 'listed in the appendix for completeness.', bbox: { x: 10, y: 320, width: 300, height: 16 } },
  { order: 4, page: 1, kind: 'caption', text: 'Figure 1 | Overview.', bbox: { x: 10, y: 400, width: 300, height: 16 } },
])
equal('clean 去掉公式的重复正文块', [cleanedBlocks.dropped, cleanedBlocks.blocks.length], [1, 3])
equal('clean 接回被拆开的段落', [cleanedBlocks.merged, cleanedBlocks.blocks[1].text],
  [1, 'The model is trained with two losses and the details are listed in the appendix for completeness.'])
equal('clean 重新编号', cleanedBlocks.blocks.map(block => block.order), [0, 1, 2])
equal('clean orderMap 能让图注的 order 跟上',
  [cleanedBlocks.orderMap.get(1), cleanedBlocks.orderMap.get(4)], [0, 2])

// normalizeLayout 里也要生效：公式重复块被去掉、图注的 order 重映射后仍指向正确的块
const cleanedLayout = normalizeLayout([page1([
  block('paragraph_title', '2 Method', [100, 100, 700, 150]),
  block('text', 'N X LNAT = log P (yn | X; θ) (2)', [100, 300, 700, 340]),
  block('formula', '\\mathcal{L}_{NAT}=\\sum', [150, 350, 650, 420]),
  block('figure_title', 'Figure 1 | Overview.', [100, 500, 700, 540]),
  block('image', '', [150, 560, 650, 800]),
])], { pageSizes: [A4], pageCount: 1 })
equal('normalizeLayout 去掉公式重复块', cleanedLayout.blocks.map(item => item.kind),
  ['heading', 'formula', 'caption', 'figure'])
equal('normalizeLayout 图注 order 仍指向 caption 块',
  cleanedLayout.figures[0].captionOrder, cleanedLayout.blocks.find(item => item.kind === 'caption').order)
check('normalizeLayout 记下清理结果', cleanedLayout.warnings.some(text => text.includes('重复')),
  JSON.stringify(cleanedLayout.warnings))

// ---------------------------------------------------------------- 表格结构

const serviceTable = htmlToTableModel(
  '<html><body><table>' +
  '<tr><th rowspan="2">Model</th><th colspan="2">WER</th></tr>' +
  '<tr><th>dev</th><th>test</th></tr>' +
  '<tr><td>Paraformer</td><td>5.1 &lt; 6.2</td><td>5.6<br>7.8</td></tr>' +
  '</table></body></html>')
equal('服务端表格 HTML：行数', serviceTable.rows.length, 3)
equal('服务端表格 HTML：rowspan/colspan', [serviceTable.rows[0].cells[0].rowspan, serviceTable.rows[0].cells[1].colspan], [2, 2])
equal('服务端表格 HTML：表头标记', serviceTable.headerRows, 1)
equal('服务端表格 HTML：按列数（含 colspan）', serviceTable.cols, 3)
equal('服务端表格 HTML：实体与换行', serviceTable.rows[2].cells[1].text, '5.1 < 6.2')
equal('服务端表格 HTML：<br> 当换行', serviceTable.rows[2].cells[2].text, '5.6\n7.8')
equal('服务端表格 HTML：空字符串返回 null', htmlToTableModel('   '), null)

const pdfTable = gridToTableModel([
  ['Model', 'dev', 'test'],
  ['Paraformer', '5.1', '5.6'],
  ['Whisper', '7.2', '7.8'],
], { headerRows: 1 })
equal('PDF 表格：表头行数', pdfTable.headerRows, 1)
equal('PDF 表格：source', pdfTable.source, 'pdf')
check('PDF 表格：可信', tableQuality(pdfTable).ok, JSON.stringify(tableQuality(pdfTable)))
check('全是空格的表格不可信', !tableQuality(gridToTableModel([['', ''], ['', '']])).ok)
check('列数不一致的表格不可信',
  !tableQuality({
    rows: [
      { cells: [{ text: 'a' }, { text: 'b' }] },
      { cells: [{ text: 'c' }] },
      { cells: [{ text: 'd' }, { text: 'e' }, { text: 'f' }] },
    ],
  }).ok)
check('有格子塞了整段文字不可信',
  !tableQuality({
    rows: [
      { cells: [{ text: 'a' }, { text: 'b' }] },
      { cells: [{ text: 'x'.repeat(500) }, { text: 'b' }] },
    ],
  }).ok)

// 跑一次带表格的版面：PDF 格线优先，抽不到时退回服务端 HTML
const tableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-layout-table-'))
const tableDir = path.join(tableRoot, 'paper-t')
fs.mkdirSync(tableDir, { recursive: true })
const tablePdfPath = path.join(tableDir, 'paper.pdf')
fs.writeFileSync(tablePdfPath, 'fake pdf')
const tableStore = {
  paperFile: (id, name) => path.join(tableRoot, id, name),
  getMeta: async id => ({ id, title: '表格样例' }),
  resolvePdf: async () => ({ path: tablePdfPath, meta: { id: 'paper-t' } }),
  getConfig: async () => ({ ocr: { token: 'token-1', layoutModel: '' } }),
  readJson: async (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  },
  writeJsonAtomic: async (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  },
}
const tableCalls = []
const tablePdf = {
  callTool: async (command, payload) => {
    tableCalls.push([command, payload && payload.page])
    if (command === 'info') return { ok: true, pages: 1, sizes: [A4] }
    if (command === 'split') {
      fs.writeFileSync(payload.out, 'part')
      return { ok: true, pages: 1 }
    }
    if (command === 'page_lines') {
      return { ok: true, page: payload.page, lines: [{ x: 52, y: 300, x2: 400, y2: 316, text: '表下正文' }] }
    }
    if (command === 'tables') {
      return {
        ok: true,
        page: payload.page,
        tables: [{
          bbox: [72, 200, 500, 280],
          rows: [['Model', 'dev', 'test'], ['Paraformer', '5.1', '5.6']],
          cols: 3,
          rowCount: 2,
          headerRows: 1,
        }],
      }
    }
    throw new Error('未预期的命令：' + command)
  },
}
const tableOcr = {
  submitJob: async () => ({ jobId: 'job-t' }),
  pollJob: async () => ({ state: 'done', jsonUrl: 'http://example.com/t.jsonl' }),
  fetchResults: async () => ({
    pages: [],
    skipped: 0,
    text: JSON.stringify({
      result: {
        layoutParsingResults: [{
          prunedResult: {
            ...SIZE_1191,
            parsing_res_list: [
              block('table', '<table><tr><td>坏</td></tr></table>', [140, 400, 1020, 560]),
            ],
          },
        }],
      },
    }),
  }),
}
const tableRunner = createLayout({ store: tableStore, pdf: tablePdf, ocr: tableOcr })
const tableBuilt = await tableRunner.runLayout('paper-t')
equal('表格：只对表格页调 tables', tableCalls.filter(item => item[0] === 'tables').map(item => item[1]), [1])
equal('表格：结构来自 PDF 格线', [tableBuilt.blocks[0].table.source, tableBuilt.blocks[0].table.rows.length], ['pdf', 2])
equal('表格：记了补上的表格数', tableBuilt.tables, 1)
const tableReload = await tableRunner.readLayout('paper-t')
check('表格：写进 layout.json', Boolean(tableReload.blocks[0].table) && tableReload.blocks[0].table.cols === 3)
const refreshed = await tableRunner.refreshTables('paper-t')
equal('refreshTables 只重算表格，不重新上传', [refreshed.tables, tableCalls.filter(item => item[0] === 'submit').length], [1, 0])
const warningCount = refreshed.warnings.filter(text => String(text).includes('表格')).length
const refreshedAgain = await tableRunner.refreshTables('paper-t')
equal('refreshTables 不会把告警越堆越多',
  [warningCount, refreshedAgain.warnings.filter(text => String(text).includes('表格')).length], [0, 0])

// 同页两个 table 块：各自认领一张表，不能都拿同一张
const dualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-layout-dual-'))
const dualDir = path.join(dualRoot, 'paper-d')
fs.mkdirSync(dualDir, { recursive: true })
const dualPdfPath = path.join(dualDir, 'paper.pdf')
fs.writeFileSync(dualPdfPath, 'fake pdf dual')
const dualStore = {
  paperFile: (id, name) => path.join(dualRoot, id, name),
  getMeta: async id => ({ id, title: '双表样例' }),
  resolvePdf: async () => ({ path: dualPdfPath, meta: { id: 'paper-d' } }),
  getConfig: async () => ({ ocr: { token: 'token-d', layoutModel: '' } }),
  readJson: async (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
  },
  writeJsonAtomic: async (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  },
}
const dualPdf = {
  callTool: async (command, payload) => {
    if (command === 'info') return { ok: true, pages: 1, sizes: [A4] }
    if (command === 'split') { fs.writeFileSync(payload.out, 'part'); return { ok: true } }
    if (command === 'page_lines') return { ok: true, page: payload.page, lines: [] }
    if (command === 'tables') {
      return { ok: true, tables: [
        { bbox: [72, 100, 500, 200], rows: [['A', '1'], ['B', '2']], cols: 2, rowCount: 2, headerRows: 1 },
        { bbox: [72, 300, 500, 400], rows: [['C', '3'], ['D', '4']], cols: 2, rowCount: 2, headerRows: 1 },
      ] }
    }
    throw new Error('未预期：' + command)
  },
}
const dualOcr = {
  submitJob: async () => ({ jobId: 'job-d' }),
  pollJob: async () => ({ state: 'done', jsonUrl: 'http://example.com/d.jsonl' }),
  fetchResults: async () => ({
    pages: [],
    skipped: 0,
    text: JSON.stringify({ result: { layoutParsingResults: [{ prunedResult: {
      ...SIZE_1191,
      parsing_res_list: [
        block('table', '', [140, 200, 1020, 400]),
        block('table', '', [140, 580, 1020, 780]),
      ],
    } }] } }),
  }),
}
const dualBuilt = await createLayout({ store: dualStore, pdf: dualPdf, ocr: dualOcr }).runLayout('paper-d')
const dualTables = dualBuilt.blocks.filter(item => item.kind === 'table' && item.table)
equal('同页两张表：两个块各拿到一张', dualTables.length, 2)
check('同页两张表：内容不相同（没认领同一张）',
  dualTables.length === 2 && dualTables[0].table.rows[0].cells[0].text !== dualTables[1].table.rows[0].cells[0].text,
  JSON.stringify(dualTables.map(item => item.table && item.table.rows[0].cells[0].text)))
fs.rmSync(dualRoot, { recursive: true, force: true })

fs.rmSync(tableRoot, { recursive: true, force: true })

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
