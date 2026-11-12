/**
 * lib/review.js 自测。
 *
 * 静态规则用假 doc / entries；LLM 检查用假 llm + 假 agentDefaultModel，
 * 不联网、不启动 DSH，也不写任何真实数据目录（store 全是内存实现）。
 * 运行：node scripts/test-review.mjs
 */
import { staticIssues, buildReviewPrompt, parseReviewReply, createReview } from '../lib/review.js'

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

// ---------------------------------------------------------------- 假数据

function paragraph(hash, text, kind = 'body') {
  return { id: 'p-' + hash, order: 0, page: 1, section: 's1', kind, level: 0, text, hash }
}

function docOf(paragraphs) {
  return {
    sections: [{ id: 's1', order: 0, title: '引言', level: 1, page: 1, hash: 's1hash', startParagraph: 0 }],
    paragraphs,
  }
}

function entryMap(values) {
  const entries = {}
  for (const [key, value] of Object.entries(values)) {
    entries[key] = { zh: String(value), at: '2026-01-01T00:00:00.000Z', model: 'test/model' }
  }
  return entries
}

const LONG_SOURCE =
  'This paper studies parameter-efficient fine-tuning methods and reports empirical results across many downstream tasks, ' +
  'including classification, question answering, and summarization, with ablations on model scale and prompt length.'

const RULE_DOC = docOf([
  paragraph('k01', 'A short source sentence for the empty rule.'),
  paragraph('k02', 'English source for the english-left rule.'),
  paragraph('k03', 'A source sentence that ends normally.'),
  paragraph('k04', 'Transformer 123'),
  paragraph('k05', 'See the results in the appendix for further details.'),
  paragraph('k06', 'The loss is computed as follows.'),
  paragraph('k07', LONG_SOURCE),
  paragraph('k08', 'The proposed method improves accuracy by 3.2 points on average while updating only 0.1% of the parameters.'),
  paragraph('k09', 'This heading is not a body paragraph.'),
  paragraph('heading1', 'Method', 'heading'),
  paragraph('untranslated', 'This body paragraph has no translation entry at all.'),
])

const RULE_ENTRIES = entryMap({
  k01: '',
  k02:
    'This paragraph was never translated into Chinese at all, only the original English text remains here, which is why the rule should fire.',
  k03: '这是被截断的译文，',
  k04: 'Transformer 123',
  k05: '结果见第 12 页的附录。',
  k06: '损失按 $x + y 计算，但没有闭合。',
  k07: '短译。',
  k08: '该方法平均提升 3.2 个百分点的准确率，同时只更新主干网络 0.1% 的参数。',
  heading1: '',
})

const RULE_ISSUES = staticIssues(RULE_DOC, RULE_ENTRIES)

function codesOf(issues, key) {
  return issues
    .filter((issue) => issue.key === key)
    .map((issue) => issue.code)
    .sort()
}

function makeStore({ doc, trans, failWrite = null } = {}) {
  const writes = []
  return {
    writes,
    async readDoc() {
      return doc || null
    },
    async readTrans() {
      return trans || { version: 1, target: 'zh', entries: {} }
    },
    async writeReview(id, result) {
      if (failWrite) throw failWrite
      writes.push({ id, result })
    },
  }
}

function makeLlm(responder) {
  const calls = []
  const llm = {
    calls,
    async *stream(options) {
      calls.push(options)
      const reply = typeof responder === 'function' ? responder(options, calls.length - 1) : responder
      if (reply instanceof Error) throw reply
      if (Array.isArray(reply)) {
        for (const chunk of reply) yield chunk
        return
      }
      yield { type: 'text-delta', index: 0, text: String(reply) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return llm
}

function agentOf(selection) {
  return { currentSelection: () => selection }
}

function rowsInPrompt(user) {
  return String(user)
    .split('\n')
    .filter((line) => line.startsWith('{"key"')).length
}

// ---------------------------------------------------------------- 静态规则

async function testStaticRules() {
  await check('staticIssues：empty 只报一条且 severity=error', async () => {
    eq(codesOf(RULE_ISSUES, 'k01'), ['empty'])
    const issue = RULE_ISSUES.find((item) => item.key === 'k01')
    eq(issue.severity, 'error')
    ok(issue.message.length > 0, 'message 不能为空')
  })

  await check('staticIssues：english-left（英文占比 >55% 且长度 >40）', async () => {
    eq(codesOf(RULE_ISSUES, 'k02'), ['english-left'])
    eq(RULE_ISSUES.find((item) => item.key === 'k02').severity, 'warn')
  })

  await check('staticIssues：truncated（译文以中文逗号结尾）', async () => {
    eq(codesOf(RULE_ISSUES, 'k03'), ['truncated'])
    eq(RULE_ISSUES.find((item) => item.key === 'k03').severity, 'error')
  })

  await check('staticIssues：same-as-source（去空白后相同）', async () => {
    eq(codesOf(RULE_ISSUES, 'k04'), ['same-as-source'])
  })

  await check('staticIssues：page-ref（第 N 页残留）', async () => {
    eq(codesOf(RULE_ISSUES, 'k05'), ['page-ref'])
  })

  await check('staticIssues：dollar-odd（$ 出现奇数次）', async () => {
    eq(codesOf(RULE_ISSUES, 'k06'), ['dollar-odd'])
  })

  await check('staticIssues：too-short（译文 < 原文 15% 且原文 >80 字符）', async () => {
    eq(codesOf(RULE_ISSUES, 'k07'), ['too-short'])
  })

  await check('staticIssues：正常译文不误报', async () => {
    eq(codesOf(RULE_ISSUES, 'k08'), [])
  })

  await check('staticIssues：只检查 body，heading 与未翻译段落跳过', async () => {
    eq(codesOf(RULE_ISSUES, 'heading1'), [])
    eq(codesOf(RULE_ISSUES, 'untranslated'), [])
    eq(RULE_ISSUES.length, 7)
  })

  await check('staticIssues：兼容 readTrans 包装与字符串条目', async () => {
    const wrapped = staticIssues(RULE_DOC, { version: 1, target: 'zh', entries: RULE_ENTRIES })
    eq(wrapped.length, RULE_ISSUES.length)
    const plain = staticIssues(RULE_DOC, { k01: '', k08: RULE_ENTRIES.k08.zh })
    eq(codesOf(plain, 'k01'), ['empty'])
    eq(codesOf(plain, 'k08'), [])
  })

  await check('staticIssues：问题项形状与 severity 取值合法', async () => {
    for (const issue of RULE_ISSUES) {
      ok(typeof issue.key === 'string' && issue.key.length > 0, 'key 缺失')
      ok(typeof issue.code === 'string' && issue.code.length > 0, 'code 缺失')
      ok(issue.severity === 'warn' || issue.severity === 'error', 'severity 非法：' + issue.severity)
      ok(typeof issue.message === 'string' && issue.message.length > 0, 'message 缺失')
    }
  })
}

// ---------------------------------------------------------------- prompt / parse

async function testPrompt() {
  await check('buildReviewPrompt：system 要求只输出 JSON 数组，user 带协议与每段 JSON', async () => {
    const prompt = buildReviewPrompt([{ key: 'k01', source: 'source text', zh: '译文' }])
    ok(prompt.system.includes('只输出 JSON 数组'), 'system 缺 JSON 约束')
    ok(prompt.user.includes('"key"'), 'user 缺 key 字段')
    ok(prompt.user.includes('"severity"'), 'user 缺 severity 字段')
    ok(prompt.user.includes('"issue"'), 'user 缺 issue 字段')
    ok(prompt.user.includes('"suggest"'), 'user 缺 suggest 字段')
    ok(prompt.user.includes(JSON.stringify({ key: 'k01', source: 'source text', zh: '译文' })), 'user 缺段落 JSON')
    eq(rowsInPrompt(prompt.user), 1)
  })

  await check('buildReviewPrompt：空批次也返回合法协议', async () => {
    const prompt = buildReviewPrompt([])
    ok(prompt.user.includes('[{"key"'), '空批次仍要有协议模板')
    eq(rowsInPrompt(prompt.user), 0)
  })
}

async function testParse() {
  await check('parseReviewReply：容忍 ```json 围栏与前后废话', async () => {
    const text = '好的，结果如下：\n```json\n[{"key":"a","severity":"error","issue":"错译","suggest":"改"}]\n```\n以上。'
    eq(parseReviewReply(text), [{ key: 'a', severity: 'error', issue: '错译', suggest: '改' }])
  })

  await check('parseReviewReply：severity 非法时归一为 warn，缺 issue 的条目丢弃', async () => {
    const text = '[{"key":"a","severity":"fatal","issue":"可疑"},{"key":"b","severity":"error"},{"key":"c","severity":"warn","issue":"   "}]'
    eq(parseReviewReply(text), [{ key: 'a', severity: 'warn', issue: '可疑', suggest: '' }])
  })

  await check('parseReviewReply：坏 JSON / 非数组 / 空文本都返回 []', async () => {
    eq(parseReviewReply('[{"key":'), [])
    eq(parseReviewReply('这不是 JSON'), [])
    eq(parseReviewReply('{"key":"a","issue":"x"}'), [])
    eq(parseReviewReply(''), [])
  })

  await check('parseReviewReply：expectedKeys 过滤未知 key', async () => {
    const text = '[{"key":"known","severity":"warn","issue":"术语"},{"key":"invented","severity":"error","issue":"编造"}]'
    const rows = parseReviewReply(text, ['known'])
    eq(rows.length, 1)
    eq(rows[0].key, 'known')
  })
}

// ---------------------------------------------------------------- createReview

async function testRun() {
  await check('run：缺文档模型时抛出契约文案', async () => {
    const store = makeStore({ doc: null })
    const reviewer = createReview({ store, getServices: () => ({}) })
    let error = null
    try {
      await reviewer.run('paper-1', { mode: 'static' })
    } catch (caught) {
      error = caught
    }
    ok(error, '应当抛错')
    eq(error.message, '还没有文档模型，先打开一次论文')
    eq(store.writes.length, 0)
  })

  await check('run：static 模式零 LLM 请求，issues/stats 落盘形状正确', async () => {
    const store = makeStore({ doc: RULE_DOC, trans: { version: 1, entries: RULE_ENTRIES } })
    const llm = makeLlm('[]')
    const reviewer = createReview({
      store,
      getServices: () => ({ llm, agentDefaultModel: agentOf({ provider: 'p', model: 'm' }) }),
    })
    const result = await reviewer.run('paper-1', { mode: 'static' })
    eq(llm.calls.length, 0)
    eq(result.mode, 'static')
    eq(result.issues.length, 7)
    eq(result.stats.staticIssues, 7)
    eq(result.stats.llmIssues, 0)
    eq(result.stats.paragraphs, 10)
    eq(result.stats.checked, 8)
    ok(!('llmError' in result.stats), 'static 模式不应有 llmError')
    ok(!Number.isNaN(Date.parse(result.at)), 'at 应是 ISO 时间')
    eq(store.writes.length, 1)
    eq(store.writes[0].id, 'paper-1')
    eq(store.writes[0].result, result)
  })

  await check('run：both 合并静态与 LLM issues，调用参数符合契约', async () => {
    const store = makeStore({ doc: RULE_DOC, trans: { version: 1, entries: RULE_ENTRIES } })
    const llm = makeLlm('[{"key":"k08","severity":"warn","issue":"术语不一致","suggest":"统一为提示微调"}]')
    const reviewer = createReview({
      store,
      getServices: () => ({ llm, agentDefaultModel: agentOf({ provider: 'p', model: 'm' }) }),
    })
    const result = await reviewer.run('paper-1', { mode: 'both' })
    eq(llm.calls.length, 1)
    const options = llm.calls[0]
    eq(options.provider, 'p')
    eq(options.model, 'm')
    eq(options.temperature, 0)
    eq(options.maxTokens, 1200)
    ok(options.system.includes('只输出 JSON 数组'), 'system 应来自 buildReviewPrompt')
    ok(options.messages[0].content[0].text.includes('待审校段落'), 'user 应来自 buildReviewPrompt')
    eq(options.messages[0].content[0].type, 'text')
    eq(result.issues.length, 8)
    eq(result.stats.staticIssues, 7)
    eq(result.stats.llmIssues, 1)
    const llmIssue = result.issues.find((issue) => issue.code === 'llm')
    eq(llmIssue.key, 'k08')
    eq(llmIssue.message, '术语不一致')
    eq(llmIssue.suggest, '统一为提示微调')
  })

  await check('run：mode=llm 跳过静态检查', async () => {
    const store = makeStore({ doc: RULE_DOC, trans: { version: 1, entries: RULE_ENTRIES } })
    const llm = makeLlm('[{"key":"k02","severity":"error","issue":"漏译"}]')
    const reviewer = createReview({
      store,
      getServices: () => ({ llm, agentDefaultModel: agentOf({ provider: 'p', model: 'm' }) }),
    })
    const result = await reviewer.run('paper-1', { mode: 'llm' })
    eq(result.stats.staticIssues, 0)
    eq(result.stats.llmIssues, 1)
    eq(result.issues.length, 1)
  })

  await check('run：每批 ≤8 段（9 段拆成 8+1，两次请求）', async () => {
    const paragraphs = []
    const entries = {}
    for (let index = 1; index <= 9; index += 1) {
      const key = 'p' + String(index).padStart(2, '0')
      paragraphs.push(paragraph(key, 'source ' + index))
      entries[key] = { zh: '译文 ' + index }
    }
    const store = makeStore({ doc: docOf(paragraphs), trans: { version: 1, entries } })
    const llm = makeLlm('[]')
    const reviewer = createReview({
      store,
      getServices: () => ({ llm, agentDefaultModel: agentOf({ provider: 'p', model: 'm' }) }),
    })
    await reviewer.run('paper-1', { mode: 'llm' })
    eq(llm.calls.length, 2)
    eq(rowsInPrompt(llm.calls[0].messages[0].content[0].text), 8)
    eq(rowsInPrompt(llm.calls[1].messages[0].content[0].text), 1)
  })

  await check('run：单批 ≤4000 字符（两段超长各占一批）', async () => {
    const store = makeStore({
      doc: docOf([paragraph('a1', 'x'.repeat(2500)), paragraph('a2', 'y'.repeat(2500))]),
      trans: { version: 1, entries: { a1: { zh: '译文一' }, a2: { zh: '译文二' } } },
    })
    const llm = makeLlm('[]')
    const reviewer = createReview({
      store,
      getServices: () => ({ llm, agentDefaultModel: agentOf({ provider: 'p', model: 'm' }) }),
    })
    await reviewer.run('paper-1', { mode: 'llm' })
    eq(llm.calls.length, 2)
    eq(rowsInPrompt(llm.calls[0].messages[0].content[0].text), 1)
    eq(rowsInPrompt(llm.calls[1].messages[0].content[0].text), 1)
  })

  await check('run：limit 限制送审段落数', async () => {
    const paragraphs = []
    const entries = {}
    for (let index = 1; index <= 5; index += 1) {
      const key = 'q' + index
      paragraphs.push(paragraph(key, 'source ' + index))
      entries[key] = { zh: '译文 ' + index }
    }
    const store = makeStore({ doc: docOf(paragraphs), trans: { version: 1, entries } })
    const llm = makeLlm('[]')
    const reviewer = createReview({
      store,
      getServices: () => ({ llm, agentDefaultModel: agentOf({ provider: 'p', model: 'm' }) }),
    })
    await reviewer.run('paper-1', { mode: 'llm', limit: 2 })
    eq(llm.calls.length, 1)
    eq(rowsInPrompt(llm.calls[0].messages[0].content[0].text), 2)
  })

  await check('run：没有 llm 服务时降级为静态，llmError 写进 stats 且不抛', async () => {
    const store = makeStore({ doc: RULE_DOC, trans: { version: 1, entries: RULE_ENTRIES } })
    const reviewer = createReview({ store, getServices: () => ({ llm: null, agentDefaultModel: null }) })
    const result = await reviewer.run('paper-1', { mode: 'both' })
    eq(result.stats.staticIssues, 7)
    ok(typeof result.stats.llmError === 'string' && result.stats.llmError.length > 0, '应有 llmError')
    eq(store.writes.length, 1)
  })

  await check('run：有 llm 但没有当前模型时降级，llmError 说明原因', async () => {
    const store = makeStore({ doc: RULE_DOC, trans: { version: 1, entries: RULE_ENTRIES } })
    const llm = makeLlm('[]')
    const reviewer = createReview({ store, getServices: () => ({ llm, agentDefaultModel: null }) })
    const result = await reviewer.run('paper-1', { mode: 'both' })
    eq(llm.calls.length, 0)
    ok(result.stats.llmError.includes('没有可用的模型'), 'llmError 应提示配置模型')
  })

  await check('run：模型调用报错时保留静态结果并降级', async () => {
    const store = makeStore({ doc: RULE_DOC, trans: { version: 1, entries: RULE_ENTRIES } })
    const llm = makeLlm(new Error('模型连接失败'))
    const reviewer = createReview({
      store,
      getServices: () => ({ llm, agentDefaultModel: agentOf({ provider: 'p', model: 'm' }) }),
    })
    const result = await reviewer.run('paper-1', { mode: 'both' })
    eq(result.stats.staticIssues, 7)
    eq(result.stats.llmIssues, 0)
    eq(result.stats.llmError, '模型连接失败')
    eq(store.writes.length, 1)
  })

  await check('run：模型编造的未知 key 被过滤', async () => {
    const store = makeStore({ doc: RULE_DOC, trans: { version: 1, entries: RULE_ENTRIES } })
    const llm = makeLlm(
      '[{"key":"k02","severity":"warn","issue":"术语"},{"key":"invented","severity":"error","issue":"编造"}]',
    )
    const reviewer = createReview({
      store,
      getServices: () => ({ llm, agentDefaultModel: agentOf({ provider: 'p', model: 'm' }) }),
    })
    const result = await reviewer.run('paper-1', { mode: 'llm' })
    eq(result.stats.llmIssues, 1)
    eq(result.issues[0].key, 'k02')
  })

  await check('run：finish{kind:error} 走降级而不是抛错', async () => {
    const store = makeStore({ doc: RULE_DOC, trans: { version: 1, entries: RULE_ENTRIES } })
    const llm = makeLlm([
      { type: 'text-delta', index: 0, text: '半截' },
      { type: 'finish', reason: { kind: 'error', failure: { message: '上游 500' } } },
    ])
    const reviewer = createReview({
      store,
      getServices: () => ({ llm, agentDefaultModel: agentOf({ provider: 'p', model: 'm' }) }),
    })
    const result = await reviewer.run('paper-1', { mode: 'both' })
    eq(result.stats.llmError, '上游 500')
  })
}

async function main() {
  await testStaticRules()
  await testPrompt()
  await testParse()
  await testRun()

  console.log('')
  console.log('PASS ' + passed + ' / FAIL ' + failed)
  if (failed === 0) {
    console.log('ALL PASS')
  } else {
    console.log('FAILED ' + failed)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.log('FAIL  测试脚本异常终止 -> ' + (error && error.stack ? error.stack : String(error)))
  console.log('PASS ' + passed + ' / FAIL ' + (failed + 1))
  process.exitCode = 1
})
