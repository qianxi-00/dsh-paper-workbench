/**
 * lib/doc.js 自测：段落级文档模型。
 *
 * 全部跑在 os.tmpdir() 造的独立数据根下（DSH_PAPER_WORKBENCH_DATA），不写真实文献库；
 * 「真实库样例」只读复制 papers/<id>/ 的 text.json + meta.json 过来再跑 getDoc。
 * 运行：node scripts/test-doc.mjs
 */
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0
let skipped = 0

function ok(condition, message) {
  if (!condition) throw new Error(message || '断言失败')
}

function eq(actual, expected, message) {
  if (Object.is(actual, expected)) return
  // 数组/对象按 JSON 比较（这里没有循环引用，够用）
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === 'object' &&
    typeof expected === 'object' &&
    JSON.stringify(actual) === JSON.stringify(expected)
  ) {
    return
  }
  throw new Error(
    (message ? message + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual),
  )
}

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + (error && error.message ? error.message : String(error)))
  }
}

function skip(name, reason) {
  skipped += 1
  console.log('SKIP  ' + name + (reason ? '（' + reason + '）' : ''))
}

// ---------------------------------------------------------------- 合成数据工具

/** 一个文本块：y2 按字号 1.2 倍高估，x 默认占单栏左半边。 */
function block(text, y, options = {}) {
  const size = options.size === undefined ? 10 : options.size
  const x = options.x === undefined ? 72 : options.x
  const x2 = options.x2 === undefined ? 520 : options.x2
  return { x, y, x2, y2: options.y2 === undefined ? y + size * 1.2 : options.y2, size, bold: false, text }
}

function page(number, blocks, options = {}) {
  return { page: number, w: options.w === undefined ? 612 : options.w, h: options.h === undefined ? 792 : options.h, blocks }
}

function texts(paragraphs) {
  return paragraphs.map((paragraph) => paragraph.text)
}

function hashSeq(doc) {
  return doc.paragraphs.map((paragraph) => paragraph.hash).join(',')
}

function handParagraph(order, pageNo, kind, text, level = 0, size = 10) {
  return {
    id: 'p' + String(order).padStart(4, '0'),
    order,
    page: pageNo,
    kind,
    level,
    text,
    hash: '',
    bbox: [0, 0, 0, 0],
    size,
    crossPage: false,
  }
}

// ---------------------------------------------------------------- 主流程

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-doc-test-'))
process.env.DSH_PAPER_WORKBENCH_DATA = tmpRoot
// 必须在设完环境变量之后动态 import：store.js 在模块加载时就读 DATA_ROOT
const model = await import('../lib/doc.js')
const store = await import('../lib/store.js')

const { paragraphHash, titleHash, mergeBlocks, assignSections, buildDoc, getDoc, invalidateDocCache, outlineFingerprint } = model

async function main() {
  // ============================================================== 1. hash
  await check('paragraphHash 折叠空白与零宽字符，稳定 16 位小写十六进制', () => {
    const a = paragraphHash('body', 'Hello  world\n第二行')
    const b = paragraphHash('body', '  Hello world 第二行\u200b ')
    eq(a, b, '空白/零宽差异应折叠')
    ok(/^[0-9a-f]{16}$/.test(a), '应为 16 位小写十六进制，实际 ' + a)
    eq(paragraphHash('body', 'Hello world 第二行'), a, '同一输入应稳定')
  })

  await check('paragraphHash 区分 kind、不折叠大小写', () => {
    ok(paragraphHash('body', 'Same') !== paragraphHash('heading', 'Same'), 'kind 应参与 hash')
    ok(paragraphHash('body', 'Same') !== paragraphHash('body', 'same'), '文本大小写不应被折叠')
  })

  await check('titleHash 折叠大小写与空白', () => {
    eq(titleHash('3.2 Method'), titleHash('3.2   method'))
    eq(titleHash('3.2 Method'), titleHash('3.2 Method'), '同一标题应稳定')
    ok(titleHash('Method') !== titleHash('Introduction'), '不同标题应不同')
    ok(/^[0-9a-f]{16}$/.test(titleHash('x')), '应为 16 位十六进制')
  })

  // ============================================================== 2. 页眉页脚
  await check('mergeBlocks 剔除页眉、页脚页码，正文里同形的数字保留', () => {
    const pages = [
      page(1, [
        block('Journal of Testing 2026', 12), // 页眉：中心 18 < 792*0.06≈47.5
        block('This body line has no full stop yet', 200),
        block('and continues right below it', 213), // 与上一块同字号、同栏、间距 1 → 合并
        block('2024', 300), // 页内数字，字号=正文 → 保留
        block('12', 770, { size: 8 }), // 页脚页码：字号 8 < 0.9×正文
        block('Page 3 of 12', 776, { size: 8 }), // 页标签
      ]),
    ]
    const paragraphs = mergeBlocks(pages, { bodySize: 10 })
    const all = texts(paragraphs).join(' | ')
    ok(!all.includes('Journal of Testing 2026'), '页眉应被剔除，实际：' + all)
    ok(!all.includes('Page 3 of 12'), '页标签应被剔除，实际：' + all)
    ok(!paragraphs.some((paragraph) => paragraph.text === '12'), '页脚页码应被剔除')
    ok(all.includes('This body line has no full stop yet and continues right below it'), '同段断行应合并，实际：' + all)
    ok(paragraphs.some((paragraph) => paragraph.text === '2024'), '页内数字不应被当页码剔除')
  })

  // ============================================================== 3. 同页合并
  await check('mergeBlocks 同页合并：无终止标点的断行合并', () => {
    const pages = [page(1, [block('This paragraph is split', 200), block('across two blocks', 212)])]
    const paragraphs = mergeBlocks(pages, { bodySize: 10 })
    eq(paragraphs.length, 1, '应合并成 1 段')
    eq(paragraphs[0].text, 'This paragraph is split across two blocks')
    eq(paragraphs[0].crossPage, false)
  })

  await check('mergeBlocks 同页合并：以句号结尾就不合并（防整页粘成一段）', () => {
    const pages = [page(1, [block('First paragraph ends here.', 200), block('Second paragraph starts', 212)])]
    const paragraphs = mergeBlocks(pages, { bodySize: 10 })
    eq(paragraphs.length, 2, '终止标点应阻断合并')
    eq(paragraphs[0].text, 'First paragraph ends here.')
    eq(paragraphs[1].text, 'Second paragraph starts')
  })

  await check('mergeBlocks 同页合并：行尾脚注标记不阻挡句末判定', () => {
    const pages = [
      page(1, [block('The result follows this primitive.1', 200), block('We validate it experimentally', 212)]),
    ]
    eq(mergeBlocks(pages, { bodySize: 10 }).length, 2, '脚注标记应还原出句末标点，阻断合并')
  })

  await check('mergeBlocks 同页合并：字号差 >0.6 不合并', () => {
    const pages = [page(1, [block('Big heading line', 200, { size: 16 }), block('body follows here', 212)])]
    const paragraphs = mergeBlocks(pages, { bodySize: 10 })
    eq(paragraphs.length, 2, '不同字号不应合并')
    eq(paragraphs[0].kind, 'heading')
  })

  await check('mergeBlocks 同页合并：列不重叠不合并（双栏），间距过大不合并', () => {
    const twoColumns = [
      page(1, [
        block('left column line one', 200, { x: 72, x2: 290 }),
        block('right column line one', 200, { x: 320, x2: 540 }),
        block('left column line two', 260, { x: 72, x2: 290 }),
      ]),
    ]
    const paragraphs = mergeBlocks(twoColumns, { bodySize: 10 })
    eq(paragraphs.length, 3, '左右栏与远间距都不该合并')
  })

  // ============================================================== 4. 跨页合并
  await check('mergeBlocks 跨页合并：无终止标点 + 下段小写 → 合并并标 crossPage', () => {
    const pages = [
      page(1, [block('the model therefore', 200)]),
      page(2, [block('requires more data', 120)]),
    ]
    const paragraphs = mergeBlocks(pages, { bodySize: 10 })
    eq(paragraphs.length, 1, '应跨页合并成 1 段')
    eq(paragraphs[0].text, 'the model therefore requires more data')
    eq(paragraphs[0].page, 1, '跨页段落的 page 取起始页')
    eq(paragraphs[0].crossPage, true)
  })

  await check('mergeBlocks 跨页合并：上段有句号不合并', () => {
    const pages = [
      page(1, [block('the model therefore.', 200)]),
      page(2, [block('requires more data', 120)]),
    ]
    eq(mergeBlocks(pages, { bodySize: 10 }).length, 2, '句号应阻断跨页合并')
  })

  await check('mergeBlocks 跨页合并：下段首字母大写不合并', () => {
    const pages = [
      page(1, [block('the model therefore', 200)]),
      page(2, [block('Requires more data', 120)]),
    ]
    eq(mergeBlocks(pages, { bodySize: 10 }).length, 2, '大写开头应阻断跨页合并')
  })

  // ============================================================== 5. 标题 / 图注 / 公式
  await check('mergeBlocks 标题分档：字号越大级别越高，最多 3 级', () => {
    const pages = [
      page(1, [
        block('1 Introduction', 100, { size: 16 }),
        block('2.1 Hardware Performance', 160, { size: 13 }),
        block('A third level heading', 220, { size: 11.5 }),
        block('Body text sits at the normal size.', 280),
      ]),
    ]
    const paragraphs = mergeBlocks(pages, { bodySize: 10 })
    eq(paragraphs[0].kind, 'heading')
    eq(paragraphs[0].level, 1)
    eq(paragraphs[1].level, 2)
    eq(paragraphs[2].level, 3)
    eq(paragraphs[3].kind, 'body')
    eq(paragraphs[3].level, 0, '非标题的 level 应为 0')
  })

  await check('mergeBlocks 标题形状：以句号逗号结尾 / 过长 / 纯数字都不算标题', () => {
    const pages = [
      page(1, [
        block('This line ends with a period.', 100, { size: 16 }),
        block('This line ends with a comma,', 160, { size: 16 }),
        block('A'.repeat(200), 220, { size: 16 }),
        block('2024', 280, { size: 16 }),
        block('Real Heading', 340, { size: 16 }),
      ]),
    ]
    const paragraphs = mergeBlocks(pages, { bodySize: 10 })
    const kinds = paragraphs.map((paragraph) => paragraph.kind + ':' + paragraph.level)
    eq(kinds, ['body:0', 'body:0', 'body:0', 'body:0', 'heading:1'], '只有 Real Heading 是标题')
  })

  await check('mergeBlocks 图注：Figure / Fig. / Table / 图 / 表 前缀', () => {
    const pages = [
      page(1, [
        block('Figure 1: Overview of our method.', 100),
        block('Fig. 2 shows the pipeline.', 140),
        block('Table 2 | Results on the benchmark.', 180),
        block('图 3 模型结构示意。', 220),
        block('表 4 实验结果对比。', 260),
        block('We discuss this in Section 5.', 300),
      ]),
    ]
    const kinds = mergeBlocks(pages, { bodySize: 10 }).map((paragraph) => paragraph.kind)
    eq(kinds.slice(0, 5), ['caption', 'caption', 'caption', 'caption', 'caption'])
    eq(kinds[5], 'body')
  })

  await check('mergeBlocks 公式：符号占比 ≥30% 且长度 <400', () => {
    const formula = 'ℓ(𝑥) = ℓ( 𝑥(1)𝑥(2) ) = 𝑒𝑚(𝑥(1))𝑓(𝑥(1))'
    const pages = [
      page(1, [
        block(formula, 100),
        block('A normal sentence with a couple of (parentheses) and 3 numbers.', 160),
        block(formula + ' ' + 'x'.repeat(420), 220),
      ]),
    ]
    const paragraphs = mergeBlocks(pages, { bodySize: 10 })
    eq(paragraphs[0].kind, 'formula', '公式应判成 formula')
    eq(paragraphs[1].kind, 'body', '普通句子不该判成公式')
    eq(paragraphs[2].kind, 'body', '超长文本不算公式')
  })

  await check('mergeBlocks 输出字段符合契约 §2.1（id/order/hash/bbox/level）', () => {
    const pages = [page(1, [block('1 Introduction', 100, { size: 16 }), block('Some body text.', 160)])]
    const paragraphs = mergeBlocks(pages, { bodySize: 10 })
    eq(paragraphs.length, 2)
    const first = paragraphs[0]
    eq(first.id, 'p0000')
    eq(first.order, 0)
    eq(paragraphs[1].id, 'p0001')
    eq(paragraphs[1].order, 1)
    eq(first.kind, 'heading')
    eq(first.hash, paragraphHash('heading', '1 Introduction'))
    ok(Array.isArray(first.bbox) && first.bbox.length === 4, 'bbox 应是 4 元数组')
    eq(first.page, 1)
    eq(first.crossPage, false)
    ok(typeof first.size === 'number' && first.size > 0, 'size 应是数字')
    ok(!('section' in first), 'mergeBlocks 不负责分节（section 由 assignSections 补）')
  })

  // ============================================================== 6. outline 锚点
  const outlineParagraphs = [
    handParagraph(0, 1, 'body', 'Abstract text that comes before the first heading.'),
    handParagraph(1, 1, 'heading', '1 Introduction', 1, 16),
    handParagraph(2, 1, 'body', 'Intro body.'),
    handParagraph(3, 2, 'heading', '2 Background', 1, 16),
    handParagraph(4, 2, 'body', 'Background body.'),
    handParagraph(5, 3, 'heading', '2.1 Hardware', 2, 13),
    handParagraph(6, 3, 'body', 'Hardware body.'),
    handParagraph(7, 4, 'heading', '4 Experiments', 3, 13),
    handParagraph(8, 4, 'body', 'Experiments body.'),
  ]

  await check('assignSections 有 outline：精确匹配 + 段首模糊匹配 + 页码兜底', () => {
    const outline = [
      { level: 1, title: '1 Introduction', page: 1 },
      { level: 1, title: 'Background', page: 2 }, // 段首模糊：段落是 "2 Background"
      { level: 2, title: 'Hardware Performance', page: 3 }, // 文字对不上 → 用页码兜底
      { level: 1, title: '4 Experiments', page: 4 },
    ]
    const { sections, paragraphs } = assignSections(outlineParagraphs, outline)
    eq(sections.length, 5, '正文前缀 + 4 条 outline')
    eq(sections.map((section) => section.id), ['s1', 's2', 's3', 's4', 's5'])
    eq(sections.map((section) => section.order), [0, 1, 2, 3, 4], 'order 从 0 连续')
    eq(sections[0].title, '正文', '首节标题缺失时补「正文」')
    eq(sections[0].startParagraph, 0)
    eq(sections[1].title, '1 Introduction')
    eq(sections[1].startParagraph, 1)
    eq(sections[1].page, 1)
    eq(sections[2].title, 'Background')
    eq(sections[2].startParagraph, 3, '段首模糊匹配应命中 "2 Background"')
    eq(sections[2].page, 2)
    eq(sections[3].startParagraph, 5, '文字对不上时应按 outline.page 找该页首段')
    eq(sections[3].page, 3)
    eq(sections[3].level, 2, 'level 取 outline.level')
    eq(sections[4].page, 4)
    eq(sections[1].hash, titleHash('1 Introduction'), 'section.hash = titleHash(title)')
    eq(paragraphs[7].level, 1, '节首标题段落的 level 应以 outline 为准（字号启发式把它判成了 3 级）')
    ok(paragraphs.every((paragraph) => typeof paragraph.section === 'string'), '每段都要有 section')
    eq(paragraphs[0].section, 's1')
    eq(paragraphs[1].section, 's2')
    eq(paragraphs[8].section, 's5')
  })

  await check('assignSections 不修改入参（纯函数）且可重复调用', () => {
    const snapshot = JSON.stringify(outlineParagraphs)
    const outline = [{ level: 1, title: '2 Background', page: 2 }]
    const a = assignSections(outlineParagraphs, outline)
    const b = assignSections(outlineParagraphs, outline)
    eq(JSON.stringify(outlineParagraphs), snapshot, '入参不应被修改')
    eq(JSON.stringify(a.sections), JSON.stringify(b.sections), '两次结果应一致')
  })

  await check('assignSections 有 outline 但文字全对不上时按页码 + 单调锚点', () => {
    const outline = [
      { level: 1, title: '不存在的标题甲', page: 2 },
      { level: 1, title: '不存在的标题乙', page: 4 },
    ]
    const { sections, paragraphs } = assignSections(outlineParagraphs, outline)
    eq(sections.length, 3, '正文前缀 + 2 条')
    eq(sections[1].page, 2)
    eq(sections[2].page, 4)
    ok(sections[2].startParagraph > sections[1].startParagraph, '锚点必须单调递增')
    eq(paragraphs[paragraphs.length - 1].section, 's3')
  })

  await check('assignSections 无 outline：用 kind:heading 的段落当节标题', () => {
    const { sections } = assignSections(outlineParagraphs, [])
    eq(sections.length, 5, '正文前缀 + 4 个 heading')
    eq(sections[0].title, '正文')
    eq(sections.slice(1).map((section) => section.title), [
      '1 Introduction',
      '2 Background',
      '2.1 Hardware',
      '4 Experiments',
    ])
    eq(sections[2].level, 1)
    eq(sections[3].level, 2)
  })

  await check('assignSections 无 outline 无 heading：每页首段当节标题', () => {
    const paragraphs = [
      handParagraph(0, 1, 'body', 'First page opening sentence.'),
      handParagraph(1, 1, 'body', 'First page second sentence.'),
      handParagraph(2, 2, 'body', 'Second page opening sentence.'),
    ]
    const { sections } = assignSections(paragraphs, [])
    eq(sections.length, 2, '一页一节')
    eq(sections[0].startParagraph, 0)
    eq(sections[0].title, 'First page opening sentence.')
    eq(sections[1].startParagraph, 2)
    eq(sections[1].page, 2)
  })

  await check('assignSections 无 outline 无 heading 单页：整篇一节 s1「正文」', () => {
    const paragraphs = [handParagraph(0, 1, 'body', 'Only one page here.')]
    const { sections } = assignSections(paragraphs, [])
    eq(sections.length, 1)
    eq(sections[0].id, 's1')
    eq(sections[0].title, '正文')
  })

  // ============================================================== 7. OCR
  const OCR_SAMPLE = [
    '# DeepSeek-OCR 2: A New Baseline',
    '',
    '## p.1',
    '',
    '## 1 Introduction',
    '',
    'Recent work on OCR models has grown quickly.',
    'It spans several lines.',
    '',
    '## p.2',
    '',
    '| Model | Score |',
    '| --- | --- |',
    '| OCR2 | 91.1 |',
    '',
    '- bullet one',
    '- bullet two',
    '',
  ].join('\n')

  await check('buildDoc 扫描件走 OCR：按 ## p.N 分页、表格与列表归 list、heading 分节', () => {
    const doc = buildDoc({ meta: { title: 'OCR 论文' }, text: null, ocrMarkdown: OCR_SAMPLE })
    eq(doc.source, 'ocr')
    eq(doc.title, 'OCR 论文', 'doc.title 优先用 meta.title')
    const { sections, paragraphs } = doc
    ok(sections.length >= 2, '应有节，实际 ' + sections.length)
    const first = paragraphs[0]
    eq(first.kind, 'heading')
    eq(first.level, 1)
    eq(first.text, 'DeepSeek-OCR 2: A New Baseline')
    ok(
      paragraphs.some((paragraph) => paragraph.kind === 'list' && paragraph.text.includes('| Model | Score |')),
      '表格行应归 kind:list 并保留换行',
    )
    ok(
      paragraphs.some((paragraph) => paragraph.kind === 'list' && paragraph.text === 'bullet one'),
      '列表项应归 kind:list',
    )
    ok(
      paragraphs.some((paragraph) => paragraph.text === 'Recent work on OCR models has grown quickly. It spans several lines.'),
      '页内断行应用空格拼成一段',
    )
    ok(paragraphs.some((paragraph) => paragraph.page === 2), '应有第 2 页的段落')
    eq(doc.pdf.sha1, '', '没有 PDF 时 sha1 为空串')
    eq(doc.paragraphs[0].id, 'p0000')
  })

  await check('buildDoc 扫描件没有 meta.title 时标题取 OCR 首个 heading', () => {
    const doc = buildDoc({ meta: {}, ocrMarkdown: OCR_SAMPLE })
    eq(doc.title, 'DeepSeek-OCR 2: A New Baseline')
  })

  // ============================================================== 7.5 目录指纹
  await check('outlineFingerprint：目录变则指纹变，标题首尾空白不敏感', () => {
    const a = outlineFingerprint([{ level: 1, title: 'Introduction', page: 1 }])
    const b = outlineFingerprint([{ level: 1, title: 'Introduction ', page: 1 }])
    const c = outlineFingerprint([{ level: 1, title: 'Introduction', page: 2 }])
    const d = outlineFingerprint([{ level: 1, title: 'Introduction', page: 1 }, { level: 2, title: 'Method', page: 3 }])
    eq(a, b, '标题首尾空白不应改变指纹')
    ok(a !== c, '页码变应换指纹')
    ok(a !== d, '新增目录项应换指纹')
    ok(/^[0-9a-f]{16}$/.test(a), '应为 16 位小写十六进制')
    eq(outlineFingerprint(null), outlineFingerprint([]), '没目录时为空目录的指纹')
  })

  await check('buildDoc 把目录指纹写进模型，供 getDoc 判断缓存是否过期', () => {
    const outline = [{ level: 1, title: 'Introduction', page: 1 }, { level: 2, title: 'Method', page: 2 }]
    const doc = buildDoc({ meta: { title: 'X' }, text: { pages: [] }, outline, ocrMarkdown: OCR_SAMPLE })
    eq(doc.outlineHash, outlineFingerprint(outline), 'outlineHash 应等于 outlineFingerprint(outline)')
  })

  // ============================================================== 8. 退化模型
  await check('buildDoc 退化：没有文本层也没有 OCR 时不抛错，给一段提示', () => {
    const doc = buildDoc({ meta: { title: '只有标题' }, text: { pages: [] }, ocrMarkdown: '' })
    eq(doc.degraded, true)
    ok(doc.paragraphs.length >= 1, '退化模型至少 1 段')
    ok(doc.paragraphs[0].text.length > 0, '退化段落不该是空串')
    ok(doc.sections.length >= 1, '退化模型也要有节')
    eq(doc.paragraphs[0].hash, paragraphHash(doc.paragraphs[0].kind, doc.paragraphs[0].text))
  })

  await check('buildDoc 退化：text 结构坏掉（pages 不是数组）也不抛错', () => {
    const doc = buildDoc({ meta: { title: 'X' }, text: { pages: 'nonsense' }, ocrMarkdown: '' })
    eq(doc.degraded, true)
    ok(doc.paragraphs.length === 1, '应回落到每页一段的退化模型')
  })

  await check('buildDoc 退化：每页一段（页内文字用空格拼）', () => {
    const doc = buildDoc({
      meta: { title: 'Y' },
      text: { pages: [page(1, [block('one', 200), block('two', 260)]), page(2, [block('three', 200)])] },
      ocrMarkdown: '',
      pdf: { sha1: 'abc', bytes: 3, mtimeMs: 1 },
    })
    // 正常路径能建模，不该退化
    eq(doc.degraded, undefined)
    eq(doc.source, 'pdf-text')
    eq(doc.pdf.sha1, 'abc')
    ok(doc.paragraphs.length >= 2, '应至少两段')
  })

  // ============================================================== 9. 真实库样例
  const REAL_ROOT = path.join(os.homedir(), '.dsh', 'paper-workbench', 'papers')
  const samples = await findRealSamples(REAL_ROOT, 4)
  if (!samples.length) {
    skip('真实库样例集成', '真实库里没有带 text.json 的论文，真实库不可用')
    skip('getDoc 缓存 / sha1 校验', '同上')
    skip('原生 TOC 的 section.page 与 outline.page', '同上')
  } else {
    for (const sample of samples) {
      await runSampleIntegration(sample, tmpRoot)
    }
  }

  // ============================================================== 9.5 没 text.json 也要能建模
  // 2026-11-11：text.json 只在打开「文本」页时才生成，于是 102 篇论文的对照视图只有一行占位。
  // getDoc 现在会自己抽 PDF 文本层并写回 text.json。
  await check('text.json 缺失时 getDoc 自己抽 PDF 文本层', async () => {
    const realPdf = 'G:\\笔记\\LLM知识体系论文\\加速训练\\FlashAttention.pdf'
    try {
      await fsp.access(realPdf)
    } catch {
      throw new Error('样例 PDF 不在本机：' + realPdf)
    }
    // 复制一份再入库：直接引用真实 PDF 会命中真实库样例的同路径去重，拿不到新建的记录
    const copy = path.join(tmpRoot, 'autoextract.pdf')
    await fsp.copyFile(realPdf, copy)
    const added = await store.addPaper({
      id: 'autoextract-1',
      title: '自动抽文',
      srcPath: copy,
      pageCount: 34,
      hasText: true,
    })
    ok(added.existed === false, '应新建一条记录，实际命中了已有记录 ' + added.meta.id)
    try {
      const result = await getDoc(added.meta.id)
      ok(result.built === true, '应该现场建模')
      ok(result.doc.paragraphs.length > 50, '段落数应远多于占位一段，实际 ' + result.doc.paragraphs.length)
      const cached = await store.readTextCache(added.meta.id)
      ok(Boolean(cached && Array.isArray(cached.pages) && cached.pages.length), '抽出的文本层应写回 text.json')
    } finally {
      await store.removePaper(added.meta.id).catch(() => {})
      await fsp.rm(copy, { force: true })
    }
  })

  // ============================================================== 收尾
  console.log('')
  console.log('PASS ' + passed + ' / FAIL ' + failed + ' / SKIP ' + skipped)
  console.log('RC ' + (failed === 0 ? 0 : 1))
  if (failed === 0) {
    await fsp.rm(tmpRoot, { recursive: true, force: true })
  } else {
    console.log('临时目录保留：' + tmpRoot)
    process.exitCode = 1
  }
}

/** 只读地从真实文献库里找「有 text.json + meta.json」的样例。 */
async function findRealSamples(root, limit) {
  let entries = []
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'))
      const text = JSON.parse(await fsp.readFile(path.join(dir, 'text.json'), 'utf8'))
      if (!meta || !Array.isArray(text && text.pages) || !text.pages.length) continue
      found.push({ id: entry.name, dir, meta, text })
    } catch {
      /* 没有 text.json 的论文跳过 */
    }
    if (found.length >= limit) break
  }
  return found
}

/** 一篇真实样例：复制到临时数据根 → getDoc 全流程断言。 */
async function runSampleIntegration(sample, root) {
  const id = sample.id
  const paperDir = path.join(root, 'papers', id)
  await fsp.mkdir(paperDir, { recursive: true })
  await fsp.writeFile(path.join(paperDir, 'meta.json'), JSON.stringify({ ...sample.meta, id }), 'utf8')
  await fsp.writeFile(path.join(paperDir, 'text.json'), JSON.stringify(sample.text), 'utf8')

  // PDF：真实文件在且不太大就复制（顺带验证真 sha1），否则写占位二进制
  let pdfBytes = null
  const srcPath = typeof sample.meta.srcPath === 'string' ? sample.meta.srcPath : ''
  if (srcPath) {
    try {
      const stat = await fsp.stat(srcPath)
      if (stat.isFile() && stat.size > 0 && stat.size <= 8 * 1024 * 1024) pdfBytes = await fsp.readFile(srcPath)
    } catch {
      /* 原 PDF 不在本机：用占位文件 */
    }
  }
  if (!pdfBytes) pdfBytes = Buffer.from('%PDF-1.7 placeholder for doc model test ' + id + '\n')
  const pdfFile = path.join(paperDir, 'paper.pdf')
  await fsp.writeFile(pdfFile, pdfBytes)
  const expectedSha1 = createHash('sha1').update(pdfBytes).digest('hex')

  const first = await getDoc(id)
  await check('[' + id + '] 首次 getDoc 构建：built=true / source=pdf-text / sha1 正确', () => {
    eq(first.built, true)
    eq(first.stale, undefined)
    eq(first.doc.version, 1)
    eq(first.doc.source, 'pdf-text')
    eq(first.doc.pdf.sha1, expectedSha1)
    eq(first.doc.pdf.bytes, pdfBytes.length)
    ok(first.doc.pdf.mtimeMs > 0, 'mtimeMs 应 > 0')
    ok(typeof first.ms === 'number' && first.ms >= 0, 'ms 应是数字')
  })

  await check('[' + id + '] 段落与节非空，页数覆盖整篇', () => {
    ok(first.doc.paragraphs.length > 0, '段落不能为空')
    ok(first.doc.sections.length > 0, '节不能为空')
    const pages = new Set(first.doc.paragraphs.map((paragraph) => paragraph.page))
    ok(pages.size >= 2, '至少覆盖 2 页，实际 ' + pages.size)
  })

  await check('[' + id + '] 段落 id 唯一、order 从 0 连续、页码单调不减', () => {
    const ids = new Set(first.doc.paragraphs.map((paragraph) => paragraph.id))
    eq(ids.size, first.doc.paragraphs.length, '段落 id 应唯一')
    first.doc.paragraphs.forEach((paragraph, index) => {
      eq(paragraph.order, index, 'order 应连续')
      eq(paragraph.id, 'p' + String(index).padStart(4, '0'))
      if (index > 0 && paragraph.page < first.doc.paragraphs[index - 1].page) {
        throw new Error('页码在 order ' + index + ' 处倒退：' + first.doc.paragraphs[index - 1].page + ' → ' + paragraph.page)
      }
    })
  })

  await check('[' + id + '] 每个段落都有 16 位 hash、非空文本，且属于某个节', () => {
    const sectionIds = new Set(first.doc.sections.map((section) => section.id))
    for (const paragraph of first.doc.paragraphs) {
      ok(/^[0-9a-f]{16}$/.test(paragraph.hash), 'hash 不合法：' + paragraph.hash)
      ok(paragraph.text.trim().length > 0, '段落文本不能为空')
      ok(sectionIds.has(paragraph.section), '段落 ' + paragraph.id + ' 的 section 不在 sections 里')
      ok(['heading', 'body', 'list', 'caption', 'formula'].includes(paragraph.kind), '未知 kind：' + paragraph.kind)
    }
    const headingCount = first.doc.paragraphs.filter((paragraph) => paragraph.kind === 'heading').length
    ok(headingCount > 0, '真实论文应至少识别出一个标题')
  })

  await check('[' + id + '] sections 的 order/startParagraph 合法且 id 唯一', () => {
    const { sections, paragraphs } = first.doc
    const ids = new Set(sections.map((section) => section.id))
    eq(ids.size, sections.length, 'section id 应唯一')
    sections.forEach((section, index) => {
      eq(section.order, index)
      ok(section.startParagraph >= 0 && section.startParagraph < paragraphs.length, 'startParagraph 越界')
      if (index > 0) ok(section.startParagraph >= sections[index - 1].startParagraph, 'startParagraph 应单调不减')
      eq(section.hash, titleHash(section.title))
      const target = paragraphs[section.startParagraph]
      ok(target !== undefined, 'startParagraph 应指向真实段落')
      eq(target.section, section.id, 'startParagraph 处段落应属于该节')
      eq(section.page, target.page, 'section.page 应等于锚点段落页码')
    })
  })

  await check('[' + id + '] doc.json 已落盘，内容与返回值一致', async () => {
    const written = JSON.parse(await fsp.readFile(path.join(paperDir, 'doc.json'), 'utf8'))
    eq(written.paragraphs.length, first.doc.paragraphs.length)
    eq(written.pdf.sha1, expectedSha1)
    eq(hashSeq(written), hashSeq(first.doc))
  })

  const second = await getDoc(id)
  await check('[' + id + '] 第二次 getDoc 命中缓存（built=false），段落 hash 序列一致', () => {
    eq(second.built, false)
    eq(second.stale, undefined)
    eq(hashSeq(second.doc), hashSeq(first.doc), '段落 hash 序列应完全一致（幂等）')
  })

  const rebuilt = await getDoc(id, { rebuild: true })
  await check('[' + id + '] rebuild 重算后段落 hash 序列仍一致（幂等）', () => {
    eq(rebuilt.built, true)
    eq(hashSeq(rebuilt.doc), hashSeq(first.doc))
    eq(JSON.stringify(rebuilt.doc.sections), JSON.stringify(first.doc.sections), '节划分也应稳定')
  })

  // PDF 变了（append 一个字符串）：sha1 变化 → 必须重建
  const cacheBuster = Buffer.from('\n% cache buster\n')
  await fsp.appendFile(pdfFile, cacheBuster)
  invalidateDocCache(id)
  const changed = await getDoc(id)
  await check('[' + id + '] PDF 变化后 getDoc 检测到 sha1 不一致并重建', () => {
    eq(changed.built, true)
    ok(changed.doc.pdf.sha1 !== expectedSha1, 'sha1 应更新')
    eq(changed.doc.pdf.bytes, pdfBytes.length + cacheBuster.length, 'bytes 应随文件变化')
  })

  // 旧 doc 存在 + PDF 找不到 → 返回旧 doc 并标 stale
  const savedMeta = JSON.parse(await fsp.readFile(path.join(paperDir, 'meta.json'), 'utf8'))
  await fsp.writeFile(path.join(paperDir, 'meta.json'), JSON.stringify({ ...savedMeta, srcPath: '' }), 'utf8')
  await fsp.rm(pdfFile, { force: true })
  invalidateDocCache(id)
  const stale = await getDoc(id)
  await check('[' + id + '] PDF 丢失但旧 doc 存在：返回旧 doc + stale=true', () => {
    eq(stale.built, false)
    eq(stale.stale, true)
    eq(hashSeq(stale.doc), hashSeq(changed.doc), '应返回上一版 doc')
  })

  // 旧 doc 也没有 → 仍能从 text.json 建模（只是没法用 PDF 校验）
  await store.removeDoc(id)
  const rebuiltWithoutPdf = await getDoc(id, { rebuild: true })
  await check('[' + id + '] PDF 丢失但 text.json 还在：仍能建模，sha1 为空并标 stale', () => {
    eq(rebuiltWithoutPdf.built, true)
    eq(rebuiltWithoutPdf.stale, true, '没有 PDF 算不出 sha1，应标 stale')
    eq(rebuiltWithoutPdf.doc.pdf.sha1, '')
    ok(rebuiltWithoutPdf.doc.paragraphs.length > 0, '段落不能为空')
  })

  // 论文都不存在 → 抛可读错误
  let threw = false
  let message = ''
  try {
    await getDoc('no-such-paper-000')
  } catch (error) {
    threw = true
    message = String((error && error.message) || '')
  }
  await check('[' + id + '] 论文不存在时 getDoc 抛出可读错误', () => {
    eq(threw, true, '应抛错')
    ok(message.includes('论文不存在'), '错误消息应说清原因，实际：' + message)
  })

  // 原生 TOC 对齐：section.page 与 outline.page 相差 ≤2
  // 容差 2 而不是 1：PDF 自带目录的页码常指向「标题在图表里出现的那一页」
  // （DeepSeek-OCR 的 Deep parsing 标 p.12，正文首段在 p.14），这是目录本身不精确，不是分节错。
  const outline = Array.isArray(sample.meta.outline) ? sample.meta.outline : []
  if (!outline.length) {
    skip('[' + id + '] 原生 TOC 的 section.page 与 outline.page 相差 ≤1', 'meta.outline 为空')
    return
  }
  await check('[' + id + '] 原生 TOC 的 section.page 与 outline.page 相差 ≤2', () => {
    const { sections } = changed.doc
    const offset = sections[0] && sections[0].hash === titleHash('正文') ? 1 : 0
    ok(sections.length >= offset + outline.length, '节数 ' + sections.length + ' 少于 outline ' + outline.length)
    const bad = []
    outline.forEach((item, index) => {
      const section = sections[offset + index]
      if (!section) return
      const diff = Math.abs(section.page - item.page)
      if (diff > 2) bad.push(item.title + ' outline p.' + item.page + ' → section p.' + section.page)
    })
    eq(bad.length, 0, '页差 >2 的节：' + bad.slice(0, 5).join('；'))
  })
}

main().catch((error) => {
  console.log('FAIL  测试脚本异常终止 -> ' + (error && error.stack ? error.stack : String(error)))
  console.log('PASS ' + passed + ' / FAIL ' + (failed + 1) + ' / SKIP ' + skipped)
  console.log('RC 1')
  process.exitCode = 1
})
