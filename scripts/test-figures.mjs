#!/usr/bin/env node
/**
 * 配图管线契约测试（docs/v3-contracts.md §2）。
 *
 * 覆盖：
 *   - normalizeLabel 各种写法；
 *   - 真实 PDF（FlashAttention，只读）抽图、缓存、refresh；
 *   - assignFigures 的 label 命中、同一图只挂第一次、图注不抢挂、无 label 同页兜底；
 *   - figureBuffer / figurePath 的裁剪 PNG；
 *   - 无 PDF / 不存在的论文返回 [] 不抛错；
 *   - 跑完校验输入 PDF 的 sha1 没变。
 *
 * 运行：node scripts/test-figures.mjs，结果打印 PASS n / FAIL m。
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PDF = String.raw`G:\笔记\LLM知识体系论文\加速训练\FlashAttention.pdf`
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('PASS  ' + name)
    return
  }
  failed += 1
  let suffix = ''
  if (detail !== undefined) {
    suffix = ' -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
    if (suffix.length > 300) suffix = suffix.slice(0, 300) + '…'
  }
  console.log('FAIL  ' + name + suffix)
}

async function sha1(file) {
  const data = await fsp.readFile(file)
  return createHash('sha1').update(data).digest('hex')
}

function isFigureShape(figure) {
  return Boolean(
    figure &&
    typeof figure === 'object' &&
    Number.isFinite(figure.page) && figure.page >= 1 &&
    [figure.x, figure.y, figure.width, figure.height].every((value) => Number.isFinite(value)) &&
    figure.width > 0 && figure.height > 0 &&
    Number.isInteger(figure.index) && figure.index >= 1 &&
    (figure.label === null || Number.isInteger(figure.label)) &&
    (figure.caption === null || typeof figure.caption === 'string'),
  )
}

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-figures-test-'))
process.env.DSH_PAPER_WORKBENCH_DATA = tmpRoot

try {
  const store = await import('../lib/store.js')
  const figuresLib = await import('../lib/figures.js')
  const docLib = await import('../lib/doc.js')

  // ---------------------------------------------------------------- normalizeLabel
  const labelCases = [
    ['图 3', 3],
    ['圖 12', 12],
    ['Figure 3', 3],
    ['Fig. 3', 3],
    ['FIG. 7', 7],
    ['Figure IV', 4],
    ['Fig 5:', 5],
    ['Table 3', null],
    ['见第 3 节', null],
    ['', null],
  ]
  for (const [input, expected] of labelCases) {
    check('normalizeLabel(' + JSON.stringify(input) + ') === ' + String(expected),
      figuresLib.normalizeLabel(input) === expected, figuresLib.normalizeLabel(input))
  }

  // ---------------------------------------------------------------- 真实 PDF 抽图
  const pdfExists = await fsp.stat(PDF).then((stat) => stat.isFile() && stat.size > 0).catch(() => false)
  check('样例 PDF 存在', pdfExists, PDF)
  if (!pdfExists) throw new Error('缺少测试 PDF，后续断言跳过')

  const beforeSha1 = await sha1(PDF)
  const { meta } = await store.addPaper({ title: 'FlashAttention（配图测试）', srcPath: PDF })
  const id = meta.id

  const figures = await figuresLib.listFigures(id)
  check('listFigures 返回非空数组', Array.isArray(figures) && figures.length > 0, figures.length)
  if (!Array.isArray(figures) || !figures.length) throw new Error('没有抽到配图，后续断言跳过')
  check('figure 字段齐全且类型正确', figures.every(isFigureShape))
  check('至少一条有 caption', figures.some((figure) => typeof figure.caption === 'string' && figure.caption.length > 0))
  check('caption 含 Figure 字样', figures.some((figure) => figure.caption && /figure/i.test(figure.caption)))

  const pageIndices = new Map()
  for (const figure of figures) {
    if (!pageIndices.has(figure.page)) pageIndices.set(figure.page, [])
    pageIndices.get(figure.page).push(figure.index)
  }
  const indexOk = [...pageIndices.values()].every((list) => {
    const sorted = list.slice().sort((a, b) => a - b)
    return sorted.every((value, index) => value === index + 1)
  })
  check('index 按页从 1 连续编号', indexOk, [...pageIndices.entries()])

  // ---------------------------------------------------------------- 缓存
  const cacheFile = path.join(tmpRoot, 'papers', id, 'figures.json')
  const cache = await store.readJson(cacheFile, null)
  check('figures.json 已写缓存', Boolean(cache && Array.isArray(cache.figures) && cache.figures.length === figures.length))
  check('缓存记录了源 PDF 指纹', Boolean(cache && cache.source && typeof cache.source.mtimeMs === 'number' && cache.source.size > 0))
  const again = await figuresLib.listFigures(id)
  check('第二次调用命中缓存（结果一致）', JSON.stringify(again) === JSON.stringify(figures))
  const refreshed = await figuresLib.listFigures(id, { refresh: true })
  check('refresh 能重新抽取', Array.isArray(refreshed) && refreshed.length === figures.length)

  // ---------------------------------------------------------------- assignFigures（合成数据）
  const syntheticFigures = [
    { page: 1, label: 3, x: 10, y: 100, width: 200, height: 100, index: 1 },
    { page: 1, label: 4, x: 10, y: 400, width: 200, height: 100, index: 2 },
    { page: 2, label: null, x: 10, y: 100, width: 200, height: 100, index: 1 },
  ]
  const syntheticDoc = {
    paragraphs: [
      { hash: 'h1', kind: 'body', page: 1, order: 0, text: '如图 3 所示，效果很好。', bbox: [0, 90, 500, 99] },
      { hash: 'h2', kind: 'body', page: 1, order: 1, text: 'Figure 3 again', bbox: [0, 120, 500, 130] },
      { hash: 'h3', kind: 'caption', page: 1, order: 2, text: 'Figure 4: caption text', bbox: [0, 540, 500, 550] },
      { hash: 'h4', kind: 'body', page: 2, order: 3, text: '无编号图附近的正文段落', bbox: [0, 90, 500, 99] },
      { hash: 'h5', kind: 'body', page: 2, order: 4, text: '另一段', bbox: [0, 500, 500, 510] },
    ],
  }
  const assignment = figuresLib.assignFigures(syntheticDoc, syntheticFigures)
  const first = assignment.byParagraph.h1 || []
  check('label 匹配归到第一次出现的正文段落', first.length === 1 && first[0].label === 3)
  check('同一张图不会挂到第二处引用', !assignment.byParagraph.h2)
  // 图注段落认领自己的图（label 4 的图注就是 h3）：图与图注不能分家
  check('图注段落认领自己的图（label 4 挂到 caption）',
    (assignment.byParagraph.h3 || []).some((figure) => Number(figure.label) === 4))
  check('无 label 的图按同页最近段落兜底', (assignment.byParagraph.h4 || []).some((figure) => figure.label === null))
  check('同一页更远的段落不抢兜底', !(assignment.byParagraph.h5 || []).length)
  check('used + unmatched 数目自洽', assignment.used + assignment.unmatched.length === syntheticFigures.length)

  // ---------------------------------------------------------------- assignFigures（真实 doc）
  const built = await docLib.getDoc(id)
  const doc = built && built.doc
  check('getDoc 能建出段落模型', Boolean(doc && Array.isArray(doc.paragraphs) && doc.paragraphs.length > 0))
  if (doc) {
    const real = figuresLib.assignFigures(doc, figures)
    check('真实 doc 的 assignFigures 至少命中一段', real.used > 0, real.used)
    check('byParagraph 的键都是段落 hash', Object.keys(real.byParagraph).every((key) => /^[0-9a-f]{16}$/.test(key)))
  }

  // ---------------------------------------------------------------- 裁剪 PNG
  const buffer = await figuresLib.figureBuffer(id, 0)
  check('figureBuffer 返回 Buffer', Buffer.isBuffer(buffer))
  check('figureBuffer 是 PNG 且 > 5KB',
    buffer.length > 5000 && buffer.subarray(0, 4).equals(PNG_MAGIC), buffer.length)

  const file = await figuresLib.figurePath(id, 0)
  const fileBuffer = await fsp.readFile(file)
  check('figurePath 返回绝对路径且落在 .figures 下', path.isAbsolute(file) && file.includes('.figures'), file)
  check('figurePath 产物是 PNG 且 > 5KB',
    fileBuffer.length > 5000 && fileBuffer.subarray(0, 4).equals(PNG_MAGIC), fileBuffer.length)
  const secondFile = await figuresLib.figurePath(id, 0)
  check('figurePath 第二次复用缓存文件', secondFile === file)

  // ---------------------------------------------------------------- 无 PDF
  const { meta: noPdf } = await store.addPaper({ title: '没有 PDF 的论文', srcPath: path.join(tmpRoot, 'not-exists.pdf') })
  let empty = null
  let emptyError = null
  try {
    empty = await figuresLib.listFigures(noPdf.id)
  } catch (error) {
    emptyError = error
  }
  check('无 PDF 时 listFigures 不抛错', emptyError === null, emptyError && emptyError.message)
  check('无 PDF 时返回空数组', Array.isArray(empty) && empty.length === 0)

  let ghost = null
  try {
    ghost = await figuresLib.listFigures('no-such-paper')
  } catch (error) {
    ghost = error
  }
  check('不存在的论文 id 返回 []', Array.isArray(ghost) && ghost.length === 0)

  // ---------------------------------------------------------------- 输入只读
  const afterSha1 = await sha1(PDF)
  check('样例 PDF 未被修改（sha1 不变）', afterSha1 === beforeSha1)
} catch (error) {
  check('测试脚本未异常终止', false, error && error.message ? error.message : String(error))
} finally {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  console.log('\n结果：PASS ' + passed + ' / FAIL ' + failed)
  process.exitCode = failed ? 1 : 0
}
