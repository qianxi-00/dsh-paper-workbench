/**
 * 修一次历史遗留的库数据，默认只打印计划（dry-run），加 --apply 才动库。
 *
 *   node scripts/fix-library.mjs            # 看清单
 *   node scripts/fix-library.mjs --apply    # 真删、真改名
 *
 * 两件事：
 *   1) 同一 PDF 被并发导入成两条（addPaper 的查重与写索引曾在两个临界区，已修）——
 *      按 srcPath 分组，留信息最全的一条，其余 removePaper 进 .trash。
 *   2) 标题是文件名的（`2601.21957v1--PaddleOCR-VL-1.5`、`1812.05159`）——
 *      用 PDF 首页最大字号那行换掉。
 *
 * 注意：删除只搬到 .trash，不真删文件；改名只写 meta（索引 + meta.json）。
 */

import { listPapers, removePaper, resolvePdf, updateMeta } from '../lib/store.js'
import { looksLikeFileName, titleFromPage1 } from '../lib/index.js'
import { extractText } from '../lib/pdf.js'

const APPLY = process.argv.includes('--apply')

/** 一条记录有多少"有用信息"，用来在重复里挑留下的那条 */
function richness(meta) {
  let score = 0
  if (meta.abstract) score += 3
  if (Array.isArray(meta.outline) && meta.outline.length > 0) score += 3
  if (Array.isArray(meta.tags) && meta.tags.length > 0) score += 1
  if (Array.isArray(meta.topics) && meta.topics.length > 0) score += 1
  if (meta.vaultCard) score += 1
  if (meta.zhPages > 0) score += 2
  if (meta.lastReadPage > 1) score += 1
  if (meta.pageCount > 0) score += 1
  if (meta.title && !looksLikeFileName(meta.title)) score += 2
  return score
}

function keyOf(meta) {
  const raw = meta.srcPath || meta.originPath || ''
  return String(raw).toLowerCase()
}

async function main() {
  const papers = await listPapers()
  console.log(`库里 ${papers.length} 条 · ${APPLY ? 'APPLY' : 'DRY-RUN'}`)

  // --- 1. 分组去重
  const groups = new Map()
  for (const meta of papers) {
    const key = keyOf(meta)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(meta)
  }

  const drop = []
  for (const [key, list] of groups) {
    if (list.length < 2) continue
    const sorted = list.slice().sort((a, b) => {
      const diff = richness(b) - richness(a)
      if (diff !== 0) return diff
      return String(a.addedAt || '').localeCompare(String(b.addedAt || ''))
    })
    const keep = sorted[0]
    const extras = sorted.slice(1)
    console.log(`\n[重复 x${list.length}] ${keep.title}`)
    console.log(`  保留 ${keep.id}  (信息分 ${richness(keep)})`)
    for (const item of extras) {
      console.log(`  删除 ${item.id}  (信息分 ${richness(item)}, ${String(item.addedAt || '').slice(11, 23)})`)
      drop.push(item)
    }
  }
  console.log(`\n重复组 ${[...groups.values()].filter((l) => l.length > 1).length} 个，待删 ${drop.length} 条`)

  // --- 2. 标题是文件名的
  const dropIds = new Set(drop.map((item) => item.id))
  const renames = []
  for (const meta of papers) {
    if (dropIds.has(meta.id)) continue
    if (!looksLikeFileName(meta.title)) continue
    if (meta.hasText === false) continue
    let found = null
    try {
      found = await resolvePdf(meta.id)
    } catch {
      found = null
    }
    if (!found) {
      console.log(`\n[标题待修·无 PDF] ${meta.id}  ${meta.title}`)
      continue
    }
    let next = ''
    try {
      next = titleFromPage1(await extractText(found.path))
    } catch (error) {
      console.log(`\n[标题待修·取文失败] ${meta.id}  ${error.message.slice(0, 60)}`)
      continue
    }
    if (!next || looksLikeFileName(next)) {
      console.log(`\n[标题待修·首页没找到] ${meta.id}  ${meta.title}`)
      continue
    }
    renames.push({ id: meta.id, from: meta.title, to: next })
    console.log(`\n[改名] ${meta.id}`)
    console.log(`  旧: ${meta.title}`)
    console.log(`  新: ${next}`)
  }
  console.log(`\n待改名 ${renames.length} 条`)

  if (!APPLY) {
    console.log('\nDRY-RUN：没有改动任何数据。确认后加 --apply 执行。')
    return
  }

  let removed = 0
  for (const item of drop) {
    try {
      await removePaper(item.id)
      removed += 1
    } catch (error) {
      console.log(`删除失败 ${item.id}: ${error.message}`)
    }
  }
  let renamed = 0
  for (const item of renames) {
    try {
      await updateMeta(item.id, { title: item.to })
      renamed += 1
    } catch (error) {
      console.log(`改名失败 ${item.id}: ${error.message}`)
    }
  }
  const after = await listPapers()
  console.log(`\n完成：删 ${removed} 条、改名 ${renamed} 条；库里现在 ${after.length} 条（删掉的在 ~/.dsh/paper-workbench/.trash/）`)
}

main().catch((error) => {
  console.error('失败：', error)
  process.exitCode = 1
})
