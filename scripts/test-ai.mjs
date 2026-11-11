/**
 * lib/ai.js / lib/sse.js 自测。
 *
 * 不依赖 DSH 宿主：数据根指到系统临时目录，llm 用会产出 text-delta/finish 的假实现，
 * agentDefaultModel 也是假的。所有断言都跑在临时目录里，不碰真实论文库。
 * 运行：node scripts/test-ai.mjs
 */
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import * as ai from '../lib/ai.js'
import { pipeSse, sseError } from '../lib/sse.js'

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-ai-test-'))
process.env.DSH_PAPER_WORKBENCH_DATA = path.join(tmpRoot, 'data')
// store.js 在模块求值时就固定了 DATA_ROOT，所以必须先设环境变量再动态 import
const store = await import('../lib/store.js')

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
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]))
  }
  return false
}

function eq(actual, expected, message) {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      (message ? message + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual),
    )
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

// ---------------------------------------------------------------- 假数据 / 假服务

function hashAt(seed) {
  return createHash('sha1').update(String(seed)).digest('hex').slice(0, 16)
}

function makeSection({ id = 's1', order = 0, title = '1 Introduction', startParagraph = 0 } = {}) {
  return { id, order, title, level: 1, page: 1, hash: hashAt('section:' + id), startParagraph }
}

function makeParagraph({ id, order, section = 's1', kind = 'body', text = 'Hello world', page = 1 }) {
  return { id, order, page, section, kind, level: 0, text, hash: hashAt('paragraph:' + id) }
}

function makeDoc({ sections = [], paragraphs = [], title = '测试论文' } = {}) {
  return {
    version: 1,
    source: 'pdf-text',
    builtAt: new Date().toISOString(),
    pdf: {},
    title,
    sections,
    paragraphs,
  }
}

function textChunks(text) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 从翻译 prompt 里抠出段落 id，按 id 回一条「译文」。 */
function idsIn(options) {
  const content = options.messages[0].content[0].text
  const ids = []
  for (const match of content.matchAll(/"id":"([^"]+)"/g)) ids.push(match[1])
  return ids
}

function echoBatch(options) {
  const ids = idsIn(options)
  return textChunks(JSON.stringify(ids.map((id) => ({ id, zh: '译-' + id }))))
}

/** 标题 prompt 的回复：JSON 对象，键是原标题。 */
function titleReply(options) {
  const text = options.messages[0].content[0].text
  const lines = text.split('\n')
  const start = lines.indexOf('待翻译标题（每行一个 JSON 字符串）：') + 1
  const titles = []
  for (let index = start; index < lines.length && lines[index].startsWith('"'); index += 1) {
    try {
      titles.push(JSON.parse(lines[index]))
    } catch {
      break
    }
  }
  return textChunks(JSON.stringify(Object.fromEntries(titles.map((title) => [title, '标题-' + title]))))
}

function abortError() {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

function fakeLlm(handler) {
  const calls = []
  return {
    calls,
    listProviders() {
      return [{ id: 'fake', name: 'Fake' }]
    },
    async listModels(provider) {
      return [{ provider, id: 'm1', name: 'M1' }]
    },
    stream(options) {
      calls.push(options)
      const index = calls.length - 1
      let plan = []
      try {
        plan = handler ? handler(options, index) : []
      } catch {
        plan = []
      }
      return (async function* () {
        if (options.signal && options.signal.aborted) throw abortError()
        for (const chunk of plan || []) {
          if (options.signal && options.signal.aborted) throw abortError()
          yield chunk
        }
      })()
    },
  }
}

function fakeServices(llm, selection = { provider: 'fake', model: 'm1' }) {
  return {
    getServices: () => ({
      llm,
      agentDefaultModel: selection === null ? null : { currentSelection: () => selection },
    }),
  }
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

class FakeReq extends EventEmitter {}

class FakeRes extends EventEmitter {
  constructor() {
    super()
    this.status = 0
    this.headers = null
    this.headersSent = false
    this.chunks = []
    this.ended = false
  }
  writeHead(status, headers) {
    this.status = status
    this.headers = headers || {}
    this.headersSent = true
  }
  flushHeaders() {}
  write(chunk) {
    this.chunks.push(String(chunk))
    return true
  }
  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.chunks.push(String(chunk))
    this.ended = true
    this.emit('close')
  }
}

async function main() {
  // ---------------------------------------------------------------- 纯函数

  await check('clampMaxTokens：0/极小/正常/超长与自定义上下限', () => {
    eq(ai.clampMaxTokens(0), 512)
    eq(ai.clampMaxTokens(10), 512)
    eq(ai.clampMaxTokens(1000), 1800)
    eq(ai.clampMaxTokens(100000), 8192)
    eq(ai.clampMaxTokens(1000, { min: 100, max: 2000, factor: 2 }), 2000)
    eq(ai.clampMaxTokens('abc'), 512)
  })

  await check('chunkItems：每批 ≤6 段/≤2000 字符，且不跨节', () => {
    const seven = Array.from({ length: 7 }, (_, index) => ({ id: 'p' + index, section: 's1', text: 'x'.repeat(10) }))
    eq(ai.chunkItems(seven).map((chunk) => chunk.length), [6, 1])
    eq(ai.chunkItems(seven, { maxItems: 3 }).map((chunk) => chunk.length), [3, 3, 1])
    const mixed = [
      { id: 'a', section: 's1', text: 'x' },
      { id: 'b', section: 's1', text: 'x' },
      { id: 'c', section: 's2', text: 'x' },
      { id: 'd', section: 's2', text: 'x' },
    ]
    eq(ai.chunkItems(mixed).map((chunk) => chunk.map((item) => item.id)), [['a', 'b'], ['c', 'd']])
    const long = [
      { id: 'long', section: 's1', text: 'x'.repeat(2500) },
      { id: 'next', section: 's1', text: 'y' },
    ]
    eq(ai.chunkItems(long).map((chunk) => chunk.length), [1, 1])
  })

  await check('buildTranslatePrompt：system 固定，user 含标题/JSON 协议/四条硬约束', () => {
    const prompt = ai.buildTranslatePrompt({
      paper: { title: 'Prompt Tuning' },
      section: { title: '2 Method' },
      items: [{ id: 'p1', text: 'Hello & <x>' }],
    })
    eq(prompt.system, '你是学术论文的翻译引擎。只输出译文，不解释、不加代码块、不写前言后语。')
    ok(prompt.user.includes('论文标题：Prompt Tuning'), '应包含论文标题')
    ok(prompt.user.includes('节标题：2 Method'), '应包含节标题')
    ok(prompt.user.includes('{"id":"p1","text":"Hello & <x>"}'), '应包含段落的 JSON 行')
    ok(prompt.user.includes('[{"id":"p0042","zh":"译文"}]'), '应包含 JSON 输出协议')
    for (const keyword of ['原样保留', 'MathML', '中文（English）', '不增删内容']) {
      ok(prompt.user.includes(keyword), '应包含硬约束关键词：' + keyword)
    }
  })

  await check('parseTranslateReply：正常/代码块/前后缀/坏 JSON/缺 id/空译文', () => {
    eq(ai.parseTranslateReply('[{"id":"p1","zh":"一"},{"id":"p2","zh":"二"}]', ['p1', 'p2']), {
      p1: '一',
      p2: '二',
    })
    eq(ai.parseTranslateReply('```json\n[{"id":"p1","zh":"一"}]\n```', ['p1']), { p1: '一' })
    eq(ai.parseTranslateReply('好的：\n[{"id":"p1","zh":"一"}]\n以上', ['p1']), { p1: '一' })
    eq(ai.parseTranslateReply('not json', ['p1']), null)
    eq(ai.parseTranslateReply('[{"id":"p1","zh":"一"}]', ['p1', 'p2']), null)
    eq(ai.parseTranslateReply('[{"id":"p1","zh":""}]', ['p1']), null)
    eq(ai.parseTranslateReply('[]', ['p1']), null)
  })

  await check('paragraphKey / titleKey：统一小写且标题带 t: 前缀', () => {
    eq(ai.paragraphKey({ hash: 'ABCDEF' }), 'abcdef')
    eq(ai.paragraphKey('ABCDEF'), 'abcdef')
    eq(ai.titleKey({ hash: 'ABCDEF' }), 't:abcdef')
    eq(ai.titleKey({ hash: '' }), '')
  })

  await check('resolveModel：配置优先，null 跟随 DSH，支持 "provider/model" 字符串', () => {
    eq(ai.resolveModel({ translateModel: null }, { provider: 'p', model: 'm' }, 'translate'), {
      provider: 'p',
      model: 'm',
    })
    eq(ai.resolveModel({ translateModel: { provider: 'p2', model: 'm2' } }, { provider: 'p', model: 'm' }, 'translate'), {
      provider: 'p2',
      model: 'm2',
    })
    eq(ai.resolveModel({ chatModel: 'p3/m3' }, null, 'chat'), { provider: 'p3', model: 'm3' })
    eq(ai.resolveModel({}, null, 'translate'), null)
  })

  await check('buildChatContext：本节截断 ≤6000，选中文字保留', () => {
    const s1 = makeSection({ id: 's1', title: '1 Introduction' })
    const s2 = makeSection({ id: 's2', order: 1, title: '5 Conclusion' })
    const longParagraph = makeParagraph({ id: 'p0', order: 0, section: 's1', text: 'A'.repeat(7000) })
    const shortParagraph = makeParagraph({ id: 'p1', order: 1, section: 's2', text: '这就是结论。' })
    const doc = makeDoc({ sections: [s1, s2], paragraphs: [longParagraph, shortParagraph] })
    const longContext = ai.buildChatContext({ doc, meta: { title: '上下文论文' }, sectionId: 's1' })
    ok(longContext.includes('1 Introduction'), '应包含节标题')
    ok(longContext.length <= 6001, '本节上下文应截断到 6000 字符附近，实际 ' + longContext.length)
    const selectionContext = ai.buildChatContext({
      doc,
      meta: { title: '上下文论文' },
      sectionId: 's2',
      selection: '选中的句子',
    })
    ok(selectionContext.includes('这就是结论。'), '应包含本节正文')
    ok(selectionContext.includes('选中的句子'), '应包含选中文字')
  })

  await check('buildChatContext：paper 范围含摘要/全部章节/结论节', () => {
    const s1 = makeSection({ id: 's1', title: '1 Introduction' })
    const s2 = makeSection({ id: 's2', order: 1, title: '5 Conclusion' })
    const conclusion = makeParagraph({ id: 'p1', order: 1, section: 's2', text: '结论正文。' })
    const doc = makeDoc({ sections: [s1, s2], paragraphs: [conclusion] })
    const context = ai.buildChatContext({ doc, meta: { title: '上下文论文', abstract: '摘要内容' }, scope: 'paper' })
    ok(context.includes('摘要内容'), '应包含摘要')
    ok(context.includes('1 Introduction') && context.includes('5 Conclusion'), '应包含全部章节标题')
    ok(context.includes('结论正文。'), '应包含结论节正文')
  })

  await check('buildChatMessages：历史只取最近 12 条且每条截断 2000 字符', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'h' + index + '-' + 'x'.repeat(3000),
    }))
    const messages = ai.buildChatMessages({
      meta: { title: 'T' },
      context: '上下文',
      history,
      question: '问题是什么？',
    })
    eq(messages.length, 13)
    ok(
      messages.slice(0, 12).every((message) => message.content[0].text.length === 2000),
      '每条历史应截断到 2000 字符',
    )
    ok(
      messages.slice(0, 12).every((message) => message.content[0].type === 'text'),
      '内容块类型应为 text',
    )
    eq(messages[0].role, 'user')
    eq(messages[11].role, 'assistant')
    ok(messages[12].content[0].text.includes('上下文'), '最后一轮应带上下文')
    ok(messages[12].content[0].text.includes('问题是什么？'), '最后一轮应带问题')
  })

  // ---------------------------------------------------------------- models

  await check('models：提供方/模型/跟随模型齐全时 ready:true', async () => {
    const llm = fakeLlm(echoBatch)
    const result = await ai.createAi({ store, ...fakeServices(llm) }).models()
    eq(result.ready, true)
    eq(result.providers, [{ id: 'fake', name: 'Fake' }])
    eq(result.models, [{ provider: 'fake', id: 'm1', name: 'M1' }])
    eq(result.follow, { provider: 'fake', model: 'm1' })
    eq(result.translateModel, { provider: 'fake', model: 'm1' })
    eq(result.chatModel, { provider: 'fake', model: 'm1' })
    eq(result.warnings, [])
  })

  await check('models：没有 llm 服务时 ready:false 且给出下一步提示', async () => {
    const result = await ai.createAi({ store, getServices: () => ({ llm: null, agentDefaultModel: null }) }).models()
    eq(result.ready, false)
    eq(result.providers, [])
    eq(result.models, [])
    ok(typeof result.reason === 'string' && result.reason.length > 0, '应给出 reason')
    ok(result.reason.includes('DSH'), 'reason 应指向 DSH 设置')
  })

  await check('models：单个提供方 listModels 失败只记 warning，不拖垮整体', async () => {
    const badLlm = {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => {
        throw new Error('适配器没启动')
      },
      stream: () => (async function* () {})(),
    }
    const result = await ai.createAi({ store, ...fakeServices(badLlm) }).models()
    eq(result.warnings.length, 1)
    ok(result.warnings[0].includes('适配器没启动'), 'warning 应带原始错误')
    eq(result.ready, false)
  })

  // ---------------------------------------------------------------- translate

  await check('translate 正常一批：start/done/end 事件与 trans.json 落盘', async () => {
    const section = makeSection({ id: 's1', title: '1 Introduction' })
    const p0 = makeParagraph({ id: 'p0', order: 0, text: 'First paragraph about prompt tuning.' })
    const p1 = makeParagraph({ id: 'p1', order: 1, text: 'Second paragraph.' })
    const formula = makeParagraph({ id: 'p2', order: 2, kind: 'formula', text: 'x = y' })
    await store.writeDoc('tr1', makeDoc({ sections: [section], paragraphs: [p0, p1, formula] }))
    const llm = fakeLlm(echoBatch)
    const controller = new AbortController()
    const events = await collect(
      ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'tr1' }, { signal: controller.signal }),
    )
    eq(llm.calls.length, 1)
    eq(llm.calls[0].provider, 'fake')
    eq(llm.calls[0].model, 'm1')
    ok(llm.calls[0].system.includes('翻译引擎'), 'system 应为翻译引擎提示词')
    ok(llm.calls[0].signal instanceof AbortSignal, '必须把 signal 透传给 llm.stream')
    const content = llm.calls[0].messages[0].content[0]
    eq(content.type, 'text')
    ok(content.text.includes('First paragraph') && !content.text.includes('x = y'), '公式不应进入翻译请求')
    eq(
      events.map((event) => event.event),
      ['start', 'start', 'done', 'done', 'end'],
    )
    eq(events[2].data.text, '译-p0')
    eq(events[3].data.text, '译-p1')
    eq(events[4].data.ok, true)
    eq(events[4].data.done, 2)
    const trans = await store.readTrans('tr1')
    eq(trans.entries[p0.hash].zh, '译-p0')
    eq(trans.entries[p1.hash].zh, '译-p1')
    eq(trans.entries[formula.hash], undefined)
    eq(trans.model, { provider: 'fake', model: 'm1' })
  })

  await check('translate 缓存命中零请求，混合时只请求未翻译段落', async () => {
    const section = makeSection({ id: 's1' })
    const p0 = makeParagraph({ id: 'p0', order: 0, text: 'cached text' })
    const p1 = makeParagraph({ id: 'p1', order: 1, text: 'fresh text' })
    await store.writeDoc('tr2', makeDoc({ sections: [section], paragraphs: [p0, p1] }))
    await store.writeTrans('tr2', {
      target: 'zh',
      model: { provider: 'old', model: 'm0' },
      entries: { [p0.hash]: { zh: '旧译文', at: new Date().toISOString(), model: 'old/m0' } },
    })
    const llm = fakeLlm(echoBatch)
    const events = await collect(ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'tr2' }))
    eq(llm.calls.length, 1)
    eq(llm.calls[0].messages[0].content[0].text.includes('cached text'), false, '缓存段落不应再发请求')
    const cachedDone = events.find((event) => event.event === 'done' && event.data.key === p0.hash)
    eq(cachedDone.data.cached, true)
    eq(cachedDone.data.text, '旧译文')
    const freshDone = events.find((event) => event.event === 'done' && event.data.key === p1.hash)
    eq(freshDone.data.cached, false)
    const trans = await store.readTrans('tr2')
    eq(trans.entries[p0.hash].zh, '旧译文', '旧译文不能被覆盖')
  })

  await check('parse 失败 → 整批退化为逐段（请求数 = 1 批 + 段数）', async () => {
    const section = makeSection({ id: 's1' })
    const paragraphs = [0, 1, 2].map((n) => makeParagraph({ id: 'p' + n, order: n, text: 'content ' + n }))
    await store.writeDoc('tr3', makeDoc({ sections: [section], paragraphs }))
    const llm = fakeLlm((options, index) => (index === 0 ? textChunks('这不是 JSON') : echoBatch(options)))
    const events = await collect(ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'tr3' }))
    eq(llm.calls.length, 4)
    eq(llm.calls.length - 1, 3, '逐段兜底调用次数应等于段数')
    eq(events.filter((event) => event.event === 'done').length, 3)
    eq(events.filter((event) => event.event === 'error').length, 0)
    const trans = await store.readTrans('tr3')
    eq(Object.keys(trans.entries).length, 3)
  })

  await check('finish{kind:error} → 逐段兜底仍失败则 error，且不覆盖旧译文', async () => {
    const section = makeSection({ id: 's1' })
    const p0 = makeParagraph({ id: 'p0', order: 0, text: '已经翻过' })
    const p1 = makeParagraph({ id: 'p1', order: 1, text: '翻不出来' })
    await store.writeDoc('tr4', makeDoc({ sections: [section], paragraphs: [p0, p1] }))
    await store.writeTrans('tr4', { entries: { [p0.hash]: { zh: '旧译文', at: new Date().toISOString() } } })
    const llm = fakeLlm(() => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }])
    const events = await collect(ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'tr4' }))
    const errors = events.filter((event) => event.event === 'error')
    eq(errors.length, 1)
    eq(errors[0].data.key, p1.hash)
    eq(errors[0].data.message, 'boom')
    const end = events[events.length - 1]
    eq(end.event, 'end')
    eq(end.data.ok, false)
    eq(end.data.failed, 1)
    eq(end.data.done, 1)
    const trans = await store.readTrans('tr4')
    eq(trans.entries[p0.hash].zh, '旧译文')
    eq(trans.entries[p1.hash], undefined)
  })

  await check('abort → end{aborted:true} 且已完成的 6 段已落盘', async () => {
    const section = makeSection({ id: 's1' })
    const paragraphs = Array.from({ length: 7 }, (_, n) => makeParagraph({ id: 'p' + n, order: n, text: 'text ' + n }))
    await store.writeDoc('tr5', makeDoc({ sections: [section], paragraphs }))
    const controller = new AbortController()
    const llm = fakeLlm((options, index) => {
      if (index === 0) return echoBatch(options)
      controller.abort()
      return []
    })
    const events = await collect(
      ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'tr5' }, { signal: controller.signal }),
    )
    const end = events[events.length - 1]
    eq(end.event, 'end')
    eq(end.data.aborted, true)
    eq(end.data.done, 6)
    eq(llm.calls.length, 2)
    const trans = await store.readTrans('tr5')
    eq(Object.keys(trans.entries).length, 6)
  })

  await check('max-tokens 截断 → maxTokens 翻倍重发一次后成功', async () => {
    const section = makeSection({ id: 's1' })
    const paragraphs = [0, 1].map((n) => makeParagraph({ id: 'p' + n, order: n, text: 'text ' + n }))
    await store.writeDoc('tr6', makeDoc({ sections: [section], paragraphs }))
    const llm = fakeLlm((options, index) => {
      if (index === 0) {
        return [
          { type: 'text-delta', index: 0, text: '[{"id":"p0","zh":"半' },
          { type: 'finish', reason: { kind: 'max-tokens' } },
        ]
      }
      return echoBatch(options)
    })
    const events = await collect(ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'tr6' }))
    eq(llm.calls.length, 2)
    eq(llm.calls[1].maxTokens, llm.calls[0].maxTokens * 2)
    eq(events.filter((event) => event.event === 'done' && event.data.truncated !== true).length, 2)
    const trans = await store.readTrans('tr6')
    eq(Object.keys(trans.entries).length, 2)
  })

  await check('429 自动重试一次并 sleep 2000ms', async () => {
    const section = makeSection({ id: 's1' })
    const paragraphs = [0].map((n) => makeParagraph({ id: 'p' + n, order: n, text: 'text ' + n }))
    await store.writeDoc('tr7', makeDoc({ sections: [section], paragraphs }))
    const slept = []
    const llm = fakeLlm((options, index) => {
      if (index === 0) {
        return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', status: 429 } } }]
      }
      return echoBatch(options)
    })
    const events = await collect(
      ai.createAi({
        store,
        ...fakeServices(llm),
        sleepImpl: async (ms) => {
          slept.push(ms)
        },
      }).translate({ id: 'tr7' }),
    )
    eq(slept, [2000])
    eq(llm.calls.length, 2)
    eq(events[events.length - 1].data.ok, true)
  })

  await check('titles:true 合成一次标题请求，键为 t:<hash>', async () => {
    const s1 = makeSection({ id: 's1', title: '1 Introduction' })
    const s2 = makeSection({ id: 's2', order: 1, title: '2 Method' })
    await store.writeDoc('tr8', makeDoc({ sections: [s1, s2], paragraphs: [] }))
    const llm = fakeLlm(titleReply)
    const events = await collect(ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'tr8', titles: true }))
    eq(llm.calls.length, 1)
    const doneEvents = events.filter((event) => event.event === 'done')
    eq(doneEvents.length, 2)
    eq(doneEvents[0].data.key, ai.titleKey(s1))
    const trans = await store.readTrans('tr8')
    eq(trans.entries[ai.titleKey(s1)].zh, '标题-1 Introduction')
    eq(trans.entries[ai.titleKey(s2)].zh, '标题-2 Method')
  })

  await check('sectionIds 超过 400 段：截断并 end.truncated:true', async () => {
    const section = makeSection({ id: 's1' })
    const paragraphs = Array.from({ length: 401 }, (_, n) => makeParagraph({ id: 'p' + n, order: n, text: 't' + n }))
    await store.writeDoc('tr9', makeDoc({ sections: [section], paragraphs }))
    const llm = fakeLlm(echoBatch)
    const events = await collect(
      ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'tr9', sectionIds: [section.id] }),
    )
    const end = events[events.length - 1]
    eq(end.event, 'end')
    eq(end.data.truncated, true)
    eq(end.data.done, 400)
    eq(llm.calls.length, Math.ceil(400 / 6))
  })

  await check('finish{kind:aborted} → end{aborted:true}，不写译文', async () => {
    const section = makeSection({ id: 's1' })
    const paragraphs = [makeParagraph({ id: 'p0', order: 0, text: 'x' })]
    await store.writeDoc('tr10', makeDoc({ sections: [section], paragraphs }))
    const llm = fakeLlm(() => [{ type: 'finish', reason: { kind: 'aborted' } }])
    const events = await collect(ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'tr10' }))
    const end = events[events.length - 1]
    eq(end.event, 'end')
    eq(end.data.aborted, true)
    const trans = await store.readTrans('tr10')
    eq(trans.entries[paragraphs[0].hash], undefined)
  })

  // ---------------------------------------------------------------- chat

  await check('chat：delta 聚合、done、chat.json 落盘与历史接续', async () => {
    await store.addPaper({ id: 'chat1', title: '聊天论文', abstract: '这是摘要。' })
    const llm = fakeLlm(() => [
      { type: 'text-delta', index: 0, text: '你好，' },
      { type: 'text-delta', index: 0, text: '这篇论文讲提示微调。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const engine = ai.createAi({ store, ...fakeServices(llm) })
    const controller = new AbortController()
    const events = await collect(
      engine.chat({ id: 'chat1', messages: [{ role: 'user', content: '这篇论文讲了什么？' }] }, { signal: controller.signal }),
    )
    eq(
      events.map((event) => event.event),
      ['delta', 'delta', 'done', 'end'],
    )
    eq(events[2].data.text, '你好，这篇论文讲提示微调。')
    eq(events[2].data.model, 'fake/m1')
    ok(llm.calls[0].system.includes('论文阅读助手'), 'system 应为论文助手')
    ok(llm.calls[0].signal instanceof AbortSignal, '必须把 signal 透传给 llm.stream')
    ok(llm.calls[0].messages[0].content[0].text.includes('这篇论文讲了什么？'), '问题应进入消息')
    const chat = await store.readChat('chat1')
    eq(chat.messages.length, 2)
    eq(chat.messages[0].role, 'user')
    eq(chat.messages[1].role, 'assistant')
    eq(chat.messages[1].model, 'fake/m1')

    // 第二轮只发一条新消息：历史从 chat.json 接上
    const second = await collect(engine.chat({ id: 'chat1', messages: [{ role: 'user', content: '能再说细一点吗？' }] }))
    eq(second[second.length - 1].data.ok, true)
    const call = llm.calls[llm.calls.length - 1]
    eq(call.messages.length, 3)
    eq((await store.readChat('chat1')).messages.length, 4)
  })

  await check('chat 模型报错 → error + end{ok:false}，不写 chat.json', async () => {
    const before = (await store.readChat('chat1')).messages.length
    const llm = fakeLlm(() => [{ type: 'finish', reason: { kind: 'error', failure: { message: '模型挂了' } } }])
    const events = await collect(
      ai.createAi({ store, ...fakeServices(llm) }).chat({
        id: 'chat1',
        messages: [{ role: 'user', content: '在吗？' }],
      }),
    )
    eq(
      events.map((event) => event.event),
      ['error', 'end'],
    )
    eq(events[0].data.message, '模型挂了')
    eq(events[1].data.ok, false)
    eq((await store.readChat('chat1')).messages.length, before)
  })

  // ---------------------------------------------------------------- 空服务 / 缺文档

  await check('没有 llm 服务：translate/chat 首帧抛「没有可用的模型」', async () => {
    const engine = ai.createAi({ store, getServices: () => ({ llm: null, agentDefaultModel: null }) })
    let translateError = null
    try {
      for await (const event of engine.translate({ id: 'tr1' })) void event
    } catch (error) {
      translateError = error
    }
    ok(translateError && translateError.message.includes('没有可用的模型'), 'translate 应抛中文模型错误')
    let chatError = null
    try {
      for await (const event of engine.chat({ id: 'chat1', messages: [{ role: 'user', content: 'hi' }] })) void event
    } catch (error) {
      chatError = error
    }
    ok(chatError && chatError.message.includes('没有可用的模型'), 'chat 应抛中文模型错误')
  })

  await check('translate 缺文档：首帧抛「还没有文档模型」且零请求', async () => {
    const llm = fakeLlm(echoBatch)
    let error = null
    try {
      for await (const event of ai.createAi({ store, ...fakeServices(llm) }).translate({ id: 'nodoc1' })) void event
    } catch (caught) {
      error = caught
    }
    ok(error && error.message.includes('还没有文档模型'), '应提示先打开论文')
    eq(llm.calls.length, 0)
  })

  // ---------------------------------------------------------------- SSE

  await check('pipeSse：响应头、事件格式与自动 end', async () => {
    const req = new FakeReq()
    const res = new FakeRes()
    async function* sample() {
      yield { event: 'start', data: { key: 'a1' } }
      yield { event: 'done', data: { key: 'a1', cached: false } }
      yield { event: 'end', data: { ok: true } }
    }
    await pipeSse(req, res, sample(), { heartbeatMs: 1000 })
    eq(res.status, 200)
    ok(res.headers['Content-Type'].includes('text/event-stream'), 'Content-Type 应为 event-stream')
    eq(res.headers['Cache-Control'], 'no-store')
    eq(res.headers['X-Accel-Buffering'], 'no')
    const text = res.chunks.join('')
    ok(text.includes('event: start\ndata: {"key":"a1"}\n\n'), '事件格式应为 event/data 两行')
    ok(text.includes('event: end\ndata: {"ok":true}\n\n'))
    eq(res.ended, true)
  })

  await check('pipeSse：慢迭代器期间发心跳注释行', async () => {
    const req = new FakeReq()
    const res = new FakeRes()
    async function* slow() {
      await new Promise((resolve) => setTimeout(resolve, 40))
      yield { event: 'end', data: { ok: true } }
    }
    await pipeSse(req, res, slow(), { heartbeatMs: 5 })
    ok(res.chunks.join('').includes(': ping'), '应写心跳注释行')
  })

  await check('pipeSse：迭代器抛错转成 error + end，不抛给 HTTP 层', async () => {
    const req = new FakeReq()
    const res = new FakeRes()
    async function* boom() {
      yield { event: 'start', data: { ok: true } }
      throw new Error('炸了')
    }
    await pipeSse(req, res, boom(), { heartbeatMs: 1000 })
    const text = res.chunks.join('')
    ok(text.includes('event: error\ndata: {"message":"炸了"}'), '应把异常转成 error 事件')
    ok(text.includes('event: end\ndata: {"ok":false,"aborted":false}'), '应补 end 帧')
    eq(res.ended, true)
  })

  await check('pipeSse：POST body 读完后的 req close 不当作断连', async () => {
    const req = new FakeReq()
    const res = new FakeRes()
    req.complete = true
    req.socket = { destroyed: false }
    async function* sample() {
      yield { event: 'start', data: {} }
      yield { event: 'end', data: { ok: true } }
    }
    const running = pipeSse(req, res, sample(), { heartbeatMs: 1000 })
    req.emit('close')
    await running
    eq(res.ended, true)
    ok(res.chunks.join('').includes('event: end'), '应当继续把事件发完')
  })

  await check('pipeSse：客户端断开时停止消费并结束响应', async () => {
    const req = new FakeReq()
    const res = new FakeRes()
    let pulls = 0
    async function* endless() {
      pulls += 1
      yield { event: 'start', data: { ok: true } }
      await new Promise(() => {})
    }
    const running = pipeSse(req, res, endless(), { heartbeatMs: 1000 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    req.emit('close')
    await Promise.race([
      running,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('pipeSse 没有退出')), 1000)),
    ])
    ok(pulls >= 1, '应至少读到一个事件')
    eq(res.ended, true)
  })

  await check('sseError：未发头时返回 JSON，已发头时补 error/end 帧', () => {
    const res = new FakeRes()
    sseError(res, 503, '没有可用的模型')
    eq(res.status, 503)
    eq(JSON.parse(res.chunks[0]), { ok: false, error: '没有可用的模型' })
    const late = new FakeRes()
    late.headersSent = true
    sseError(late, 500, '晚到的错误')
    const text = late.chunks.join('')
    ok(text.includes('event: error') && text.includes('event: end'), '应补两帧事件')
    eq(late.ended, true)
  })

  // ---------------------------------------------------------------- 收尾

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
