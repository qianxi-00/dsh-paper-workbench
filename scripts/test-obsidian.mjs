/**
 * lib/obsidian.js 自测。
 *
 * 只在 %TEMP%\pb-obs-test-<随机> 下建假 vault；所有断言都跑在临时目录里，
 * 绝不读写真实 Obsidian 库（detectVault 用临时 APPDATA 模拟，不碰真实配置）。
 * 运行：node scripts/test-obsidian.mjs
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as obsidian from '../lib/obsidian.js'

// 从真实卡片复制来的固定样例：frontmatter 混杂内联/块列表、注释，正文含内容知识化字段行。
const SAMPLE = String.raw`---
tags:
  - llm-paper-kb
  - paper-card
status: generated
generated: 2026-05-17T22:19:29+08:00
paper_category: 高效微调
knowledge_nodes: ["后训练与对齐"]
concepts: ["后训练"]
paper_status: unread
paper_priority: normal
mapping_source: category
needs_manual_review: false
# 这一行是注释，合并时必须保留
source: G:\笔记\LLM知识体系论文\高效微调\Prompt Tuning.pdf
source_relative: LLM知识体系论文\高效微调\Prompt Tuning.pdf
---

# Prompt Tuning

## 文件

- 原文：G:\笔记\LLM知识体系论文\高效微调\Prompt Tuning.pdf
- 译文：未翻译

## 知识连接

- 上位方向：[[参数高效微调]]
- 相关知识节点：[[后训练与对齐]]

## 关联

- 前序：[[Prefix Tuning]]
- 后续：[[P-Tuning]]

## 内容知识化

- 抽取状态：已抽取
- 一句话结论：旧结论：提示微调用少量可学习向量替代全参数微调。
- 研究问题：能否只训练极少量参数达到接近全量微调的效果？
- 方法线索：在输入前拼接可学习的 soft prompt，只更新这部分参数。
- 应用场景：低资源、多任务的文本分类与生成。
- 局限线索：对模型规模有依赖，小模型上收益有限。

## 摘要摘录

Prompt tuning 把离散提示替换为连续可学习向量，并在大量任务上验证了其有效性。
`

const SOURCE = String.raw`G:\笔记\LLM知识体系论文\高效微调\Prompt Tuning.pdf`
const SOURCE_RELATIVE = String.raw`LLM知识体系论文\高效微调\Prompt Tuning.pdf`

let passed = 0
let failed = 0

function ok(condition, message) {
  if (!condition) throw new Error(message)
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  }
  return false
}

function eq(actual, expected, message) {
  if (!deepEqual(actual, expected)) {
    throw new Error((message ? message + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
  }
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

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-obs-test-'))
  const vault = path.join(tmpRoot, 'vault')
  const kb = path.join(vault, 'F盘编程知识库', '论文知识库')
  const cardDir = path.join(kb, '论文', '高效微调')
  const cardPath = path.join(cardDir, 'Prompt Tuning.md')

  // ---- 假 vault：真实布局 + 一个名字不含「论文知识库」的干扰库
  await fsp.mkdir(cardDir, { recursive: true })
  await fsp.mkdir(path.join(kb, '方向综述'), { recursive: true })
  await fsp.writeFile(path.join(kb, '论文阅读队列.md'), '# 论文阅读队列\n\n- [ ] Prompt Tuning\n', 'utf8')
  await fsp.writeFile(cardPath, SAMPLE, 'utf8')
  await fsp.mkdir(path.join(vault, '旧库', '论文'), { recursive: true })
  await fsp.writeFile(path.join(vault, '旧库', '论文阅读队列.md'), '# 旧队列\n', 'utf8')

  // ---- 1. vault / 知识库探测
  await check('detectPaperKb 找到名为「论文知识库」的目录', async () => {
    eq(await obsidian.detectPaperKb(vault), kb)
  })

  await check('detectPaperKb 对不存在的路径返回 null', async () => {
    eq(await obsidian.detectPaperKb(path.join(tmpRoot, '不存在')), null)
  })

  const appData = path.join(tmpRoot, 'appdata')
  await fsp.mkdir(path.join(appData, 'obsidian'), { recursive: true })
  await fsp.writeFile(
    path.join(appData, 'obsidian', 'obsidian.json'),
    JSON.stringify({
      vaults: {
        a: { path: vault, open: false },
        b: { path: path.join(vault, '旧库'), open: true },
      },
    }),
    'utf8',
  )
  const appDataBackup = process.env.APPDATA
  try {
    process.env.APPDATA = appData
    await check('detectVault 返回 open:true 的 vault', async () => {
      eq(obsidian.detectVault(), path.join(vault, '旧库'))
    })
    await check('listVaults 返回全部 vault 且打开中的排前面', async () => {
      const vaults = obsidian.listVaults()
      eq(vaults.length, 2)
      eq(vaults[0].open, true)
      eq(vaults[0].path, path.join(vault, '旧库'))
      eq(vaults[1].path, vault)
    })
  } finally {
    if (appDataBackup === undefined) delete process.env.APPDATA
    else process.env.APPDATA = appDataBackup
  }

  // ---- 2. 解析
  await check('parseFrontmatter 解析标量、块列表、内联列表与布尔', () => {
    const parsed = obsidian.parseFrontmatter(SAMPLE)
    eq(parsed.frontmatter.paper_category, '高效微调')
    eq(parsed.frontmatter.source, SOURCE)
    eq(parsed.frontmatter.tags, ['llm-paper-kb', 'paper-card'])
    eq(parsed.frontmatter.knowledge_nodes, ['后训练与对齐'])
    eq(parsed.frontmatter.needs_manual_review, false)
    ok(parsed.body.includes('## 内容知识化'), 'body 应包含正文小节')
    ok(parsed.bodyStartLine > 1, 'bodyStartLine 应指向 frontmatter 之后')
  })

  // ---- 3. 行级合并
  await check('mergeFrontmatter 只改目标行，其它行逐字节不变', () => {
    const merged = obsidian.mergeFrontmatter(SAMPLE, { paper_status: 'reading' })
    const before = SAMPLE.split('\n')
    const after = merged.split('\n')
    eq(after.length, before.length, '行数')
    const diff = []
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i]) diff.push({ index: i, before: before[i], after: after[i] })
    }
    eq(diff.length, 1, '差异行数')
    eq(diff[0].before, 'paper_status: unread')
    eq(diff[0].after, 'paper_status: reading')
    eq(obsidian.mergeFrontmatter(SAMPLE, { paper_status: 'unread' }), SAMPLE, '值相同应原样返回')
  })

  await check('mergeFrontmatter 保持块列表/内联列表风格，新键追加且不动注释', () => {
    const block = obsidian.mergeFrontmatter(SAMPLE, { tags: ['llm-paper-kb', 'paper-card', 'review'] })
    ok(block.split('\n').includes('  - review'), '块列表应保持块列表风格')
    ok(!block.includes('tags: ['), '块列表不应被改成内联')

    const inline = obsidian.mergeFrontmatter(SAMPLE, { knowledge_nodes: ['后训练与对齐', '提示学习'] })
    const inlineLine = inline.split('\n').find((line) => line.startsWith('knowledge_nodes:'))
    ok(inlineLine !== undefined, '内联列表所在行不应消失')
    ok(inlineLine.trim().startsWith('knowledge_nodes: [') && inlineLine.trim().endsWith(']'), '内联列表应保持内联风格')
    eq(obsidian.parseFrontmatter(inline).frontmatter.knowledge_nodes, ['后训练与对齐', '提示学习'])

    const added = obsidian.mergeFrontmatter(SAMPLE, { review_note: '待人工复核' })
    const addedLines = added.split('\n')
    const closeAt = addedLines.lastIndexOf('---')
    ok(closeAt > 0, '应能找到 frontmatter 结束行')
    eq(addedLines[closeAt - 1], 'review_note: 待人工复核')
    ok(addedLines.includes('# 这一行是注释，合并时必须保留'), '注释行不能被删')
  })

  // ---- 4. upsert：更新既有卡片（frontmatter + 字段行 + 标记小节）
  const paper = {
    title: 'Prompt Tuning',
    category: '高效微调',
    source: SOURCE,
    sourceRelative: SOURCE_RELATIVE,
    fields: { paper_status: 'reading' },
    sections: {
      一句话结论: '新结论：软提示以极少参数逼近全量微调。',
      精读报告: '## 结论\n\n第一条精读结论。',
    },
  }

  await check('upsertCard 更新既有卡片', async () => {
    const result = await obsidian.upsertCard(kb, paper)
    eq(result.path, cardPath)
    eq(result.created, false)
    eq(result.changed, true)
    const text = await fsp.readFile(cardPath, 'utf8')
    eq(obsidian.parseFrontmatter(text).frontmatter.paper_status, 'reading')
    ok(text.includes('## 精读报告'), '应追加精读报告小节')
    ok(text.includes('<!-- pb:begin 精读报告 -->') && text.includes('<!-- pb:end 精读报告 -->'))
    ok(text.includes('第一条精读结论。'))
  })

  await check('一句话结论字段行只改值且仍只有一行', async () => {
    const text = await fsp.readFile(cardPath, 'utf8')
    const hits = text.split('\n').filter((line) => /^-\s*一句话结论[：:]/.test(line))
    eq(hits.length, 1, '字段行数量')
    eq(hits[0], '- 一句话结论：新结论：软提示以极少参数逼近全量微调。')
  })

  await check('同样输入第二次 upsertCard → changed=false 且文件字节不变', async () => {
    const bytes1 = await fsp.readFile(cardPath)
    const second = await obsidian.upsertCard(kb, paper)
    const bytes2 = await fsp.readFile(cardPath)
    eq(second.changed, false)
    eq(second.created, false)
    eq(Buffer.compare(bytes1, bytes2), 0, '文件字节')
  })

  await check('备份只有一份，且内容是合并前的原文', async () => {
    const names = await fsp.readdir(cardDir)
    const backups = names.filter((name) => name.endsWith('.pb-backup.md'))
    eq(backups.length, 1, '备份文件数量')
    eq(backups[0], 'Prompt Tuning.pb-backup.md')
    eq(await fsp.readFile(path.join(cardDir, backups[0]), 'utf8'), SAMPLE)
  })

  // ---- 5. 定位
  await check('locateCard 依次命中 source / source_relative / 标题', async () => {
    const bySource = await obsidian.locateCard(kb, {
      source: 'g:/笔记/llm知识体系论文/高效微调/prompt tuning.pdf',
    })
    eq(bySource && bySource.path, cardPath, '按 source（斜杠+大小写不敏感）')
    const byRelative = await obsidian.locateCard(kb, {
      sourceRelative: String.raw`llm知识体系论文\高效微调\prompt tuning.pdf`,
    })
    eq(byRelative && byRelative.path, cardPath, '按 source_relative')
    const byTitle = await obsidian.locateCard(kb, { title: 'Prompt Tuning' })
    eq(byTitle && byTitle.path, cardPath, '按标题')
    eq(await obsidian.locateCard(kb, { source: String.raw`D:\nope\x.pdf` }), null)
  })

  // ---- 6. 状态
  await check('setStatus 改 paper_status / paper_priority（走行级合并）', async () => {
    const changed = await obsidian.setStatus(kb, cardPath, 'read', 'high')
    eq(changed.changed, true)
    const frontmatter = obsidian.parseFrontmatter(await fsp.readFile(cardPath, 'utf8')).frontmatter
    eq(frontmatter.paper_status, 'read')
    eq(frontmatter.paper_priority, 'high')
    const again = await obsidian.setStatus(kb, cardPath, 'read')
    eq(again.changed, false, '状态没变时不应写盘')
  })

  // ---- 7. 新建卡片
  const newTitle = 'Bad/Title:  With   Spaces?'
  let createdPath = null

  await check('新建卡片：路径与文件名规范、最小 frontmatter、正文小节', async () => {
    const created = await obsidian.upsertCard(kb, {
      title: newTitle,
      category: '测试分类',
      source: String.raw`G:\tmp\bad.pdf`,
      sections: { 一句话结论: '新建卡片的结论。' },
    })
    eq(created.created, true)
    createdPath = created.path
    eq(createdPath, path.join(kb, '论文', '测试分类', 'BadTitle With Spaces.md'))
    const text = await fsp.readFile(createdPath, 'utf8')
    ok(text.startsWith('---\n'), 'frontmatter 应在文件开头')
    ok(text.includes('tags: [llm-paper-kb, paper-card]'), '最小 frontmatter 应含 tags')
    ok(text.includes('paper_status: unread'), '新卡片默认 unread')
    ok(text.includes('paper_category: 测试分类'))
    ok(text.includes('## 内容知识化'), '应补内容知识化小节')
    ok(text.includes('- 一句话结论：新建卡片的结论。'))
    ok(text.includes('# ' + newTitle), '正文一级标题应使用原题名')
  })

  await check('同名标题复用既有文件，不新建第二张', async () => {
    const again = await obsidian.upsertCard(kb, { title: newTitle, category: '测试分类' })
    eq(again.path, createdPath)
    eq(again.created, false)
  })

  // ---- 8. 列表与检索
  await check('listCards 递归列出论文目录、忽略备份文件', async () => {
    const cards = await obsidian.listCards(kb)
    eq(cards.length, 2)
    ok(cards.every((card) => !card.path.endsWith('.pb-backup.md')), '备份文件不应入列')
    eq(cards.find((card) => card.path === cardPath).title, 'Prompt Tuning')
  })

  await check('searchVault 大小写不敏感命中并返回上下文片段', async () => {
    const hits = await obsidian.searchVault(kb, 'PROMPT TUNING')
    ok(hits.length > 0, '应有命中')
    const hit = hits.find((item) => item.path === cardPath)
    ok(hit !== undefined, '应命中 Prompt Tuning 卡片')
    ok(hit.snippet.toLowerCase().includes('prompt tuning'), '片段应包含命中文本')
    eq(await obsidian.searchVault(kb, '绝对不存在的关键词zzz'), [])
  })

  // ---- 9. 方向综述
  const surveyPath = path.join(kb, '方向综述', '提示微调综述.md')

  await check('writeSurvey 新建综述（tags 含 survey、带 generated）', async () => {
    const result = await obsidian.writeSurvey(kb, '提示微调综述', '# 提示微调综述\n\n第一版内容。')
    eq(result.path, surveyPath)
    eq(result.created, true)
    const frontmatter = obsidian.parseFrontmatter(await fsp.readFile(surveyPath, 'utf8')).frontmatter
    ok(Array.isArray(frontmatter.tags) && frontmatter.tags.includes('survey') && frontmatter.tags.includes('llm-paper-kb'))
    ok(typeof frontmatter.generated === 'string' && frontmatter.generated.length > 0, '应写 generated 时间')
  })

  await check('writeSurvey 替换正文并保留其它 frontmatter 字段', async () => {
    const original = await fsp.readFile(surveyPath, 'utf8')
    await fsp.writeFile(surveyPath, obsidian.mergeFrontmatter(original, { reviewer: 'Qian Xi' }), 'utf8')
    const result = await obsidian.writeSurvey(kb, '提示微调综述', '# 提示微调综述\n\n第二版内容。')
    eq(result.changed, true)
    const text = await fsp.readFile(surveyPath, 'utf8')
    ok(text.includes('第二版内容。'))
    ok(!text.includes('第一版内容。'))
    eq(obsidian.parseFrontmatter(text).frontmatter.reviewer, 'Qian Xi')
  })

  // ---- 收尾
  console.log('')
  console.log('检查 ' + (passed + failed) + ' 项：通过 ' + passed + '，失败 ' + failed)
  if (failed === 0) {
    await fsp.rm(tmpRoot, { recursive: true, force: true })
    console.log('ALL PASS')
  } else {
    console.log('临时目录保留：' + tmpRoot)
    console.log('FAILED ' + failed)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.log('FAIL  测试脚本异常终止 -> ' + (error && error.stack ? error.stack : String(error)))
  console.log('FAILED 1')
  process.exitCode = 1
})
