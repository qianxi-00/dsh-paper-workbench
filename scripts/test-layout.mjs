/**
 * 版面回归测试：对照视图和原文页「差太多」的那批问题。
 *
 * 用的是真机上的两篇论文（RETRO 单栏 + FlashAttention 双栏），只在文件存在时跑；
 * 文件被搬走就 SKIP，不把测试变成「必须有某台机器的路径」。
 *
 * 覆盖点：
 *   1. 整节被塞成一段（LaTeX 单栏的 block 覆盖整章）——现在按段间距拆开；
 *   2. 图里的文字（"Encoder"/"Neighbours"/"Transformer"…）被当成正文段落；
 *   3. 图注被当成正文、页码/页眉被当成正文；
 *   4. 矢量图（无位图对象）抽不出配图区域。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

process.env.DSH_PAPER_WORKBENCH_DATA =
  process.env.DSH_PAPER_WORKBENCH_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'pb-layout-'))

const store = await import('../lib/store.js')
const docLib = await import('../lib/doc.js')
const figuresLib = await import('../lib/figures.js')

const RETRO = 'G:\\笔记\\LLM知识体系论文\\RETRO.pdf'
const FLASH = 'G:\\笔记\\LLM知识体系论文\\加速训练\\FlashAttention.pdf'

let passed = 0
let failed = 0
function ok(value, message) {
  if (value) {
    passed += 1
    console.log('PASS  ' + message)
  } else {
    failed += 1
    console.log('FAIL  ' + message)
  }
}
function skip(message) {
  console.log('SKIP  ' + message)
}

const tmpRoot = process.env.DSH_PAPER_WORKBENCH_DATA
const copies = []

function copyPaper(source, id) {
  if (!fs.existsSync(source)) return null
  const target = path.join(tmpRoot, id + '.pdf')
  fs.copyFileSync(source, target)
  copies.push(target)
  return target
}

async function build(id, source) {
  const copy = copyPaper(source, id)
  if (!copy) return null
  await store.addPaper({ id, title: id, srcPath: copy, storage: 'copy' })
  return (await docLib.getDoc(id, { rebuild: true })).doc
}

function bodyTexts(doc) {
  return doc.paragraphs.filter((p) => p.kind === 'body').map((p) => p.text)
}

try {
  // ---------------------------------------------------------------- RETRO（单栏、大图）
  const retro = await build('layout-retro', RETRO)
  if (!retro) {
    skip('RETRO.pdf 不在本机，跳过单栏/矢量图用例')
  } else {
    const heads = retro.paragraphs.filter((p) => p.kind === 'heading').map((p) => p.text)
    ok(heads.some((text) => /^2\.\s*Method/.test(text)), '单栏论文能认出一级标题「2. Method」')
    ok(heads.some((text) => /^2\.1\.\s*Training dataset/.test(text)),
      '小节标题（与正文同字号、只加粗）也能认出「2.1. Training dataset」')

    const captions = retro.paragraphs.filter((p) => p.kind === 'caption').map((p) => p.text)
    ok(captions.some((text) => /^Figure 2\b/.test(text)), '图注 Figure 2 归到 caption 而不是正文')

    const bodies = bodyTexts(retro)
    const labels = ['Encoder', 'Neighbours', 'Transformer', 'Retrieval', 'dataset', 'Encoded neighbours']
    const leaked = bodies.filter((text) => labels.includes(text.trim()))
    ok(leaked.length === 0, '图里的标签没有被当成正文段落（泄漏 ' + leaked.length + ' 条）')
    ok(bodies.some((text) => text.includes('We design our retrieval-enhanced architecture')),
      '正文段落还在（没有因为过滤而丢掉整页）')

    const longest = bodies.reduce((max, text) => Math.max(max, text.length), 0)
    ok(longest > 1200, '整节被粘成一段的问题已改善（最长正文段 ' + longest + ' 字符）')

    ok(!bodies.some((text) => /^Improving language models by retrieving from trillions/.test(text)),
      '页眉（每页重复的论文标题行）没有混进正文')

    // 矢量图：RETRO 的 Figure 1/2 没有位图对象，只能靠绘图簇 + 图注定位
    const figures = await figuresLib.listFigures('layout-retro', { refresh: true })
    const page3 = figures.find((figure) => Number(figure.page) === 3)
    ok(Boolean(page3), '矢量图也能抽出配图区域（Figure 2 在第 3 页）')
    if (page3) {
      ok(Number(page3.width) > 300 && Number(page3.height) > 100,
        '矢量图区域尺寸合理（' + Math.round(page3.width) + '×' + Math.round(page3.height) + 'pt）')
      const assigned = figuresLib.assignFigures(retro, figures)
      const captionKey = retro.paragraphs
        .filter((p) => p.kind === 'caption' && /^Figure 2\b/.test(p.text))
        .map((p) => p.hash)[0]
      ok(Boolean(captionKey) && Array.isArray(assigned.byParagraph[captionKey]),
        'Figure 2 挂到自己的图注段落上')
    }
  }

  // ---------------------------------------------------------------- FlashAttention（双栏）
  const flash = await build('layout-flash', FLASH)
  if (!flash) {
    skip('FlashAttention.pdf 不在本机，跳过双栏用例')
  } else {
    const heads = flash.paragraphs.filter((p) => p.kind === 'heading').map((p) => p.text)
    ok(heads.some((text) => /^3\.?\s+FlashAttention: Algorithm/.test(text)),
      '双栏论文的「3 FlashAttention: Algorithm…」是完整标题（编号与标题已合并）')
    ok(heads.some((text) => /^3\.1\s+An Eﬃcient Attention Algorithm/.test(text)),
      '双栏论文的 README 级小节标题完整')

    // 双栏最容易出的错：左右栏交错。看第 2 页前几段有没有把两栏串在一起
    const page2 = flash.paragraphs.filter((p) => Number(p.page) === 2)
    ok(page2.length > 4, '双栏页切出了多个段落（' + page2.length + ' 段）')
    // 交错合并的症状是「阅读顺序来回跳」：同页段落的 y 应该单调不减（同栏内）
    const ys = page2.map((p) => Number(p.bbox[1]) || 0)
    const jumps = ys.filter((value, index) => index > 0 && value < ys[index - 1] - 1).length
    ok(jumps === 0, '双栏页面阅读顺序没有来回跳（y 逆序 ' + jumps + ' 处）')
  }
} finally {
  for (const id of ['layout-retro', 'layout-flash']) {
    await store.removePaper(id).catch(() => {})
  }
  await store.closeDb().catch(() => {})
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* Windows 下句柄没关干净时留给自己清 */
  }
}

console.log('')
console.log('PASS ' + passed + ' / FAIL ' + failed)
if (failed === 0) {
  console.log('ALL PASS')
} else {
  process.exitCode = 1
}
