#!/usr/bin/env node
/**
 * 独立调试服务器：不重启 DSH 就能调试 SPA 与全部接口。
 *
 *   node scripts/dev-server.mjs [端口] [--mock-llm]
 *   然后浏览器打开 http://127.0.0.1:57571/paper-workbench/app
 *
 * 它和宿主里跑的是同一份 lib/server.js + createApi()，所以这里调通的行为
 * 装进 DSH 后一致（差别只有认证/Host 检查与真实数据目录）。
 *
 * --mock-llm：塞一个假的 llm + agentDefaultModel，翻译与对话会返回确定性的假流。
 * 只用于调试 UI 与 SSE，不产生任何网络请求，也不消耗 token。
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// store.js 在模块求值时就固定了数据目录，所以要先决定数据目录、再动态 import 插件入口
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const MOCK_LLM = args.includes('--mock-llm')

// --mock-llm 时默认把数据目录挪到临时目录：假模型写出来的译文 / 日志 / 对话不该进用户的真实文献库。
// 想在假模型下看真实库，显式设 DSH_PAPER_WORKBENCH_DATA 即可。
if (MOCK_LLM && !process.env.DSH_PAPER_WORKBENCH_DATA) {
  process.env.DSH_PAPER_WORKBENCH_DATA = path.join(os.tmpdir(), 'pb-dev-mock')
}

const { createApi, createStreams, setAiRuntime } = await import('../lib/index.js')
const { createHandler } = await import('../lib/server.js')
const PORT = Number(args.find((item) => /^\d+$/.test(item)) || 57571)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假模型：按请求里出现的「段 id / 中文提示」编出稳定文本，便于断言与截图。 */
function mockLlm() {
  return {
    listProviders: () => [{ id: 'mock', name: '本地假模型（dev-server）' }],
    listModels: async () => [{ provider: 'mock', id: 'mock-translate', name: 'Mock Translate' }],
    stream(options) {
      const prompt = (options.messages || [])
        .map((message) => (message.content || []).map((part) => part.text || '').join(''))
        .join('\n')
      const text = mockReply(prompt)
      return (async function* generate() {
        const parts = text.match(/[\s\S]{1,12}/g) || ['']
        for (const part of parts) {
          await sleep(12)
          yield { type: 'text-delta', index: 0, text: part }
        }
        yield { type: 'usage', usage: { inputTokens: prompt.length, outputTokens: text.length } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** 翻译请求要 JSON；对话请求回一段带页码的说明。 */
function mockReply(prompt) {
  if (prompt.includes('逐条翻译成中文')) {
    const ids = [...prompt.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((match) => match[1])
    if (ids.length === 0) return JSON.stringify([{ id: 'p0001', zh: '（假模型）这一段没有拿到 id。' }])
    return JSON.stringify(
      ids.map((id) => ({ id, zh: '（假模型译文）' + id + ' 这一段的中文示例，用来验证逐段对照与流式渲染。' })),
    )
  }
  if (prompt.includes('键是原标题')) {
    // 标题行就在「待翻译标题」之后，每行一个 JSON 字符串；行长没有上限（论文标题可能很长）
    const tail = prompt.split('待翻译标题')[1] || ''
    const titles = tail
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"') && line.endsWith('"'))
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    const map = {}
    for (const title of titles) map[title] = '（假）' + title
    return JSON.stringify(map)
  }
  return '（假模型回答）这是一段用于验证侧边对话流式输出的示例回答，引用页码 [p.1]，并说明当前节在讲什么。'
}

if (MOCK_LLM) {
  setAiRuntime({
    llm: mockLlm(),
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-translate' }) },
  })
  console.log('[dev] 已启用假模型（--mock-llm）：翻译/对话不会发真实请求')
}

const streams = createStreams()

const handler = createHandler({
  api: createApi(),
  appDir: path.join(ROOT, 'assets', 'app'),
  prefix: '/paper-workbench',
  streams,
})

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error('[dev] 未捕获异常：' + error.stack)
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: String(error && error.message) }))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[dev] http://127.0.0.1:' + PORT + '/paper-workbench/app')
})
