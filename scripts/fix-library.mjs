/**
 * 修一次历史遗留的库数据，默认只打印计划（dry-run），加 --apply 才动库。
 *
 *   node scripts/fix-library.mjs            # 看清单
 *   node scripts/fix-library.mjs --apply    # 真删、真改名、补内容指纹
 *
 * 四件事：
 *   1) 同一 PDF 被并发导入成两条（addPaper 的查重与写索引曾在两个临界区，已修）——
 *      按 srcPath 分组，留信息最全的一条，其余 removePaper 进 .trash。
 *   2) 同一份 PDF 被复制成两个文件名（BLIP-3 就有一份 2408.08872v4-BLIP3.pdf、
 *      一份 Xue_BLIP-3_...pdf）—— 按文件 sha1 分组，同样只留一条。
 *   3) 老记录没有 contentHash（内容指纹），补上，将来再导入同样文件才能挡住。
 *   4) 标题是文件名的（`2601.21957v1--PaddleOCR-VL-1.5`、`2408.08872v4-BLIP3`）——
 *      用 PDF 首页最大字号那行换掉。
 *
 * 删除只搬到 .trash，不真删文件；改名/补指纹只写 meta（索引 + meta.json）。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

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

function pathKey(meta) {
  return String(meta.srcPath || meta.originPath || '').toLowerCase()
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 同组里挑一条留下：信息最全的，同分取最早入库的 */
function pickKeeper(list) {
  return list.slice().sort((a, b) => {
    const diff = richness(b) - richness(a)
    if (diff !== 0) return diff
    // 同分时留标题更完整的（`FLASH` vs `Transformer Quality in Linear Time`）
    const longer = String(b.title || '').length - String(a.title || '').length
    if (longer !== 0) return longer
    return String(a.addedAt || '').localeCompare(String(b.addedAt || ''))
  })
}

async function main() {
  const papers = await listPapers()
  console.log(`库里 ${papers.length} 条 · ${APPLY ? 'APPLY' : 'DRY-RUN'}`)

  // --- 先给每篇算内容指纹（顺便知道哪些 PDF 已经定位不到）
  const hashes = new Map()
  const missing = []
  for (const meta of papers) {
    try {
      const found = await resolvePdf(meta.id)
      hashes.set(meta.id, await hashFile(found.path))
    } catch {
      missing.push(meta)
    }
  }
  console.log(`能定位到 PDF：${hashes.size} 条；定位不到：${missing.length} 条`)

  const dropped = new Map() // id → 原因

  // --- 1. 同一路径
  const byPath = new Map()
  for (const meta of papers) {
    const key = pathKey(meta)
    if (!key) continue
    if (!byPath.has(key)) byPath.set(key, [])
    byPath.get(key).push(meta)
  }
  for (const list of byPath.values()) {
    if (list.length < 2) continue
    const [keep, ...extras] = pickKeeper(list)
    console.log(`\n[同路径 x${list.length}] ${keep.title}`)
    console.log(`  保留 ${keep.id}`)
    for (const item of extras) {
      console.log(`  删除 ${item.id}`)
      dropped.set(item.id, '同路径')
    }
  }

  // --- 2. 同一内容（不同文件名/目录）
  const byHash = new Map()
  for (const meta of papers) {
    if (dropped.has(meta.id)) continue
    const hash = hashes.get(meta.id)
    if (!hash) continue
    if (!byHash.has(hash)) byHash.set(hash, [])
    byHash.get(hash).push(meta)
  }
  for (const [hash, list] of byHash) {
    if (list.length < 2) continue
    const [keep, ...extras] = pickKeeper(list)
    console.log(`\n[同内容 x${list.length}] sha1 ${hash.slice(0, 12)}`)
    console.log(`  保留 ${keep.id}  ${keep.title.slice(0, 60)}`)
    for (const item of extras) {
      console.log(`  删除 ${item.id}  ${item.title.slice(0, 60)}`)
      dropped.set(item.id, '同内容')
    }
  }

  console.log(`\n待删 ${dropped.size} 条（同路径 ${[...dropped.values()].filter((v) => v === '同路径').length}、同内容 ${[...dropped.values()].filter((v) => v === '同内容').length}）`)

  // --- 3. 补内容指纹
  const backfill = papers.filter((meta) => !dropped.has(meta.id) && hashes.has(meta.id) && !meta.contentHash)
  console.log(`待补内容指纹 ${backfill.length} 条`)

  // --- 4. 标题是文件名的
  const renames = []
  for (const meta of papers) {
    if (dropped.has(meta.id)) continue
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
  for (const id of dropped.keys()) {
    try {
      await removePaper(id)
      removed += 1
    } catch (error) {
      console.log(`删除失败 ${id}: ${error.message}`)
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
  let hashed = 0
  for (const meta of backfill) {
    try {
      await updateMeta(meta.id, { contentHash: hashes.get(meta.id) })
      hashed += 1
    } catch (error) {
      console.log(`写指纹失败 ${meta.id}: ${error.message}`)
    }
  }
  const after = await listPapers()
  console.log(`\n完成：删 ${removed} 条、改名 ${renamed} 条、补指纹 ${hashed} 条；库里现在 ${after.length} 条（删掉的在 ~/.dsh/paper-workbench/.trash/）`)
}

main().catch((error) => {
  console.error('失败：', error)
  process.exitCode = 1
})
