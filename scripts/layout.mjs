#!/usr/bin/env node
/**
 * 手动跑一次版面解析（PP-StructureV3），把 layout.json 落到论文目录里。
 *
 *   node scripts/layout.mjs <论文 id>
 *   node scripts/layout.mjs <论文 id> --batch=20 --model=PP-StructureV3
 *
 * 为什么要单独一个脚本：版面解析要上传 PDF、按页计费，不能一开论文就自动跑；
 * 先让用户在命令行/设置页显式触发一次，确认效果再决定要不要默认打开。
 *
 * 数据目录默认是 ~/.dsh/paper-workbench，可用 DSH_PAPER_WORKBENCH_DATA 覆盖。
 */
import * as store from '../lib/store.js'
import * as pdf from '../lib/pdf.js'
import * as ocr from '../lib/ocr.js'
import { createLayout, layoutSummary } from '../lib/layout.js'

function parseArgs(argv) {
  const options = { id: '', batchPages: 0, model: '' }
  for (const arg of argv) {
    if (arg.startsWith('--batch=')) options.batchPages = Number(arg.slice(8)) || 0
    else if (arg.startsWith('--model=')) options.model = arg.slice(8).trim()
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (!arg.startsWith('-')) options.id = arg.trim()
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help || options.id === '') {
  console.log('用法：node scripts/layout.mjs <论文 id> [--batch=50] [--model=PP-StructureV3]')
  console.log('提示：先 `node scripts/doctor.mjs` 看看 Python / OCR Key 是否就绪。')
  process.exit(options.help ? 0 : 2)
}

const runner = createLayout({ store, pdf, ocr })
let lastPhase = ''
try {
  const layout = await runner.runLayout(options.id, {
    batchPages: options.batchPages || undefined,
    model: options.model || undefined,
    onProgress: event => {
      if (event.phase === 'poll') {
        const line = `轮询 ${event.state} · 已解析 ${event.extractedPages === null ? '?' : event.extractedPages}/${event.totalPages || '?'} 页`
        if (line !== lastPhase) {
          lastPhase = line
          console.log(line)
        }
        return
      }
      if (event.phase === 'submit') console.log(`提交第 ${event.start}-${event.end} 页（共 ${event.total} 页）`)
      if (event.phase === 'text') process.stdout.write(`\r抠文本层 ${event.page}/${event.total}`)
    },
  })
  process.stdout.write('\n')
  const summary = layoutSummary(layout)
  console.log('版面解析完成：')
  console.log(`  页数 ${summary.pages}（服务端返回 ${summary.servicePages} 页）`)
  console.log(`  块 ${summary.blocks}：` + Object.entries(summary.byKind).map(([kind, count]) => `${kind} ${count}`).join(' / '))
  console.log(`  图/表 ${summary.figures}`)
  console.log(`  模型 ${summary.model} · ${summary.at}`)
  for (const warning of layout.warnings || []) console.log('  警告：' + warning)
  if (Array.isArray(layout.skipped) === false && layout.skipped) console.log(`  跳过的坏行 ${layout.skipped}`)
} catch (error) {
  console.error('版面解析失败：' + (error && error.message ? error.message : error))
  process.exit(1)
}
