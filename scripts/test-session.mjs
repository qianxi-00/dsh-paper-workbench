/**
 * lib/session.js 自测。
 *
 * 不连真实宿主（拿不到）：sessionController / workspaceController 全是假的，只断言
 * 「桥到底发了什么」。覆盖 sessionId 清洗、ensure 建/复用/回退/并发去重、prompt 参数
 * 形状与 signal 透传、follow 透传与 abort、normalizeFrame 的六类帧形态、服务缺失文案。
 * 桥不碰磁盘，所以不需要临时目录，也不会写真实论文库。
 * 运行：node scripts/test-session.mjs
 */
import assert from 'node:assert/strict'

import { sessionIdFor, createSessionBridge, normalizeFrame } from '../lib/session.js'

const UNAVAILABLE = '原生会话不可用（这个宿主没有 sessionController）'

let passed = 0
let failed = 0

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

function abortError() {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

// ---------------------------------------------------------------- 假服务

/** workspaceController.create → {workspace:{workspaceId}}；sessionController 三个方法都记调用。 */
function makeFakes(options = {}) {
  const calls = { workspace: [], create: [], prompt: [], follow: [] }

  const workspaceController =
    options.workspaceController === null
      ? undefined
      : {
          async create(args) {
            calls.workspace.push(args)
            if (options.workspaceError) throw options.workspaceError
            return { workspace: { workspaceId: options.workspaceId || 'ws-1' } }
          },
        }

  const sessionController =
    options.sessionController === null
      ? undefined
      : {
          async create(args) {
            calls.create.push(args)
            if (options.createError) {
              const error = typeof options.createError === 'function' ? options.createError(args) : options.createError
              if (error) throw error
            }
            return { sessionId: args.sessionId }
          },
          async prompt(args, signal) {
            calls.prompt.push({ args, signal })
            return { ok: true }
          },
          follow(args, signal) {
            calls.follow.push({ args, signal })
            return options.stream ? options.stream(signal) : (async function* () {})()
          },
        }

  const services = {}
  if (sessionController) services.sessionController = sessionController
  if (workspaceController) services.workspaceController = workspaceController
  return { services, calls }
}

function bridgeFor(services, dataRoot = 'C:/tmp/pb-data') {
  return createSessionBridge({ getServices: () => services, dataRoot })
}

async function collect(iterable) {
  const frames = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

/** 断言 promise 以指定文案拒绝（比正则更严格，防止文案漂移）。 */
async function rejectsWith(promiseOrFactory, expected) {
  const promise = typeof promiseOrFactory === 'function' ? promiseOrFactory() : promiseOrFactory
  try {
    await promise
  } catch (error) {
    assert.equal(error.message, expected)
    return error
  }
  throw new Error('应当抛出：' + expected)
}

/** normalizeFrame 结果按字段断言，并统一确认 raw 是原始对象的引用。 */
function assertFrame(frame, expected) {
  const out = normalizeFrame(frame)
  for (const key of Object.keys(expected)) {
    assert.deepEqual(out[key], expected[key], '帧字段 ' + key + ' 不符合预期')
  }
  assert.equal(out.raw, frame)
  return out
}

// ---------------------------------------------------------------- 用例

async function run() {
  await check('sessionIdFor：前缀、非法字符替换、首尾与 64 长度上限', () => {
    assert.equal(sessionIdFor('2504.12345'), 'pb-2504.12345')
    assert.equal(sessionIdFor('arXiv:2103.10385v2'), 'pb-arXiv-2103.10385v2')
    assert.equal(sessionIdFor('2024/中文 v2:test?x'), 'pb-2024-v2-test-x')
    assert.equal(sessionIdFor('/abc'), 'pb-abc')
    assert.equal(sessionIdFor('abc/'), 'pb-abc')
    assert.match(sessionIdFor('a b_c-d.e'), /^pb-[a-zA-Z0-9._-]+$/)
    // 空 / 纯非法字符：兜底成 pb-paper，不产出空壳 id
    assert.equal(sessionIdFor(''), 'pb-paper')
    assert.equal(sessionIdFor('   '), 'pb-paper')
    assert.equal(sessionIdFor('中文论文'), 'pb-paper')
    // 上限 64（含 pb- 前缀）
    assert.equal(sessionIdFor('x'.repeat(100)), 'pb-' + 'x'.repeat(61))
    assert.equal(sessionIdFor('x'.repeat(100)).length, 64)
    assert.ok(sessionIdFor('a'.repeat(60) + '/' + 'b'.repeat(20)).length <= 64)
  })

  await check('ensure：先建工作区，再用 workspaceId 建会话', async () => {
    const fakes = makeFakes()
    const bridge = bridgeFor(fakes.services)
    const out = await bridge.ensure('2504.12345', { cwd: 'C:/papers/2504.12345' })
    assert.deepEqual(out, { sessionId: 'pb-2504.12345' })
    assert.deepEqual(fakes.calls.workspace, [{ path: 'C:/papers/2504.12345' }])
    assert.deepEqual(fakes.calls.create, [{ sessionId: 'pb-2504.12345', workspaceId: 'ws-1' }])
  })

  await check('ensure：工作区失败回退 create({sessionId, cwd})', async () => {
    const fakes = makeFakes({ workspaceError: new Error('工作区创建被拒绝') })
    const bridge = bridgeFor(fakes.services)
    await bridge.ensure('p1', { cwd: 'C:/p1' })
    assert.deepEqual(fakes.calls.create, [{ sessionId: 'pb-p1', cwd: 'C:/p1' }])
  })

  await check('ensure：没有 cwd 时用 dataRoot 兜底', async () => {
    const fakes = makeFakes({ workspaceController: null })
    const bridge = bridgeFor(fakes.services, 'C:/data-root')
    await bridge.ensure('p2')
    assert.deepEqual(fakes.calls.create, [{ sessionId: 'pb-p2', cwd: 'C:/data-root' }])
  })

  await check('ensure：不支持的模型式参数不出现；「已存在」当复用，其它错误上抛', async () => {
    const existing = Object.assign(new Error('session pb-p3 already exists'), { code: 'EEXIST' })
    const fakes = makeFakes({ workspaceController: null, createError: existing })
    const bridge = bridgeFor(fakes.services)
    assert.deepEqual(await bridge.ensure('p3'), { sessionId: 'pb-p3' })
    // 已存在被吞掉后应记入缓存：第二次不再 create。
    await bridge.ensure('p3')
    assert.equal(fakes.calls.create.length, 1)

    const broken = makeFakes({ workspaceController: null, createError: new Error('写入会话目录失败') })
    await rejectsWith(bridgeFor(broken.services).ensure('p4'), '写入会话目录失败')
  })

  await check('ensure：并发调用只 create 一次', async () => {
    const fakes = makeFakes()
    const bridge = bridgeFor(fakes.services)
    const [a, b] = await Promise.all([bridge.ensure('p5'), bridge.ensure('p5')])
    assert.deepEqual(a, { sessionId: 'pb-p5' })
    assert.deepEqual(b, { sessionId: 'pb-p5' })
    assert.equal(fakes.calls.create.length, 1)
  })

  await check('ask：先 ensure，再按 {sessionId, content, requestId} 形状 prompt 且透传 signal', async () => {
    const fakes = makeFakes()
    const bridge = bridgeFor(fakes.services)
    const controller = new AbortController()
    const out = await bridge.ask('2504.12345', '把这段翻译成中文', { cwd: 'C:/p', signal: controller.signal })
    assert.equal(out.sessionId, 'pb-2504.12345')
    assert.equal(typeof out.requestId, 'string')
    assert.ok(out.requestId.length > 0, 'requestId 不能为空')
    assert.equal(fakes.calls.prompt.length, 1)
    const { args, signal } = fakes.calls.prompt[0]
    assert.deepEqual(args.content, [{ type: 'text', text: '把这段翻译成中文' }])
    assert.equal(args.sessionId, 'pb-2504.12345')
    assert.equal(args.requestId, out.requestId)
    assert.equal(signal, controller.signal)
  })

  await check('ask：requestId 每次不同；空文本在发请求前就报中文错', async () => {
    const fakes = makeFakes()
    const bridge = bridgeFor(fakes.services)
    const first = await bridge.ask('p6', 'hi')
    const second = await bridge.ask('p6', 'hi')
    assert.notEqual(first.requestId, second.requestId)
    assert.equal(fakes.calls.prompt.length, 2)
    await rejectsWith(bridge.ask('p6', '   '), '请输入要发送的内容')
    assert.equal(fakes.calls.prompt.length, 2, '空文本不该发 prompt')
  })

  await check('follow：请求形状正确，帧原样透传（引用不变）', async () => {
    const frames = [
      { kind: 'assistant-delta', text: '你' },
      { kind: 'assistant-delta', text: '好' },
      { kind: 'finish', reason: { kind: 'stop' } },
    ]
    const fakes = makeFakes({
      stream: () =>
        (async function* () {
          for (const frame of frames) yield frame
        })(),
    })
    const bridge = bridgeFor(fakes.services)
    const controller = new AbortController()
    const seen = await collect(bridge.follow('2504.12345', { signal: controller.signal }))
    assert.equal(seen.length, 3)
    for (let i = 0; i < frames.length; i += 1) assert.equal(seen[i], frames[i], '第 ' + (i + 1) + ' 帧被改写了')
    assert.deepEqual(fakes.calls.follow[0].args, {
      address: { kind: 'session', sessionId: 'pb-2504.12345' },
      maxMessages: 200,
      assistantStream: true,
    })
    assert.equal(fakes.calls.follow[0].signal, controller.signal)
  })

  await check('follow：maxMessages 透传并收敛到 [1, 10000]', async () => {
    const fakes = makeFakes({ stream: () => (async function* () {})() })
    const bridge = bridgeFor(fakes.services)
    await collect(bridge.follow('p7', { maxMessages: 5 }))
    assert.equal(fakes.calls.follow[0].args.maxMessages, 5)
    await collect(bridge.follow('p7', { maxMessages: -3 }))
    assert.equal(fakes.calls.follow[1].args.maxMessages, 1)
    await collect(bridge.follow('p7', { maxMessages: 'abc' }))
    assert.equal(fakes.calls.follow[2].args.maxMessages, 200)
  })

  await check('follow：abort 由宿主流抛出并原样传上来', async () => {
    const controller = new AbortController()
    const fakes = makeFakes({
      stream: (signal) =>
        (async function* () {
          yield { kind: 'assistant-delta', text: 'a' }
          controller.abort()
          if (signal && signal.aborted) throw abortError()
          yield { kind: 'assistant-delta', text: 'b' }
        })(),
    })
    const bridge = bridgeFor(fakes.services)
    await assert.rejects(
      collect(bridge.follow('p8', { signal: controller.signal })),
      (error) => error.name === 'AbortError',
    )
    assert.equal(controller.signal.aborted, true)
  })

  await check('服务缺失：available() false，ask/follow/ensure 抛统一中文文案', async () => {
    const bridge = createSessionBridge({ getServices: () => ({}) })
    assert.equal(bridge.available(), false)
    assert.throws(() => bridge.follow('p'), (error) => error.message === UNAVAILABLE)
    await rejectsWith(bridge.ask('p', 'hi'), UNAVAILABLE)
    await rejectsWith(bridge.ensure('p'), UNAVAILABLE)
    // getServices 自己抛错也只是「不可用」，不能让调用方 500。
    const broken = createSessionBridge({
      getServices: () => {
        throw new Error('boom')
      },
    })
    assert.equal(broken.available(), false)
  })

  await check('available()：只有 sessionController 才算可用，normalizeFrame 挂在桥上', () => {
    const fakes = makeFakes()
    const bridge = bridgeFor(fakes.services)
    assert.equal(bridge.available(), true)
    assert.equal(bridge.normalizeFrame, normalizeFrame)
    assert.equal(createSessionBridge({ getServices: () => ({ workspaceController: {} }) }).available(), false)
  })

  // ------------------------------------------------------------ normalizeFrame

  await check('normalizeFrame ①：{kind:"message", message:{role, content:[{type:"text"}]}}', () => {
    const frame = { kind: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } }
    assertFrame(frame, { kind: 'message', role: 'assistant', text: '你好' })
  })

  await check('normalizeFrame ②：{type:"message", role, content:"字符串"}', () => {
    assertFrame({ type: 'message', role: 'user', content: '请把这段翻译成中文' }, {
      kind: 'message',
      role: 'user',
      text: '请把这段翻译成中文',
    })
  })

  await check('normalizeFrame ③：增量帧（assistant-delta / stream + delta 对象 / 空占位）', () => {
    assertFrame({ kind: 'assistant-delta', text: '片段' }, { kind: 'delta', text: '片段' })
    assertFrame({ kind: 'stream', delta: { text: '块' } }, { kind: 'delta', text: '块' })
    // 只有增量标记、没有文字：仍是 delta，不能当成空消息
    assertFrame({ kind: 'assistant-delta' }, { kind: 'delta', text: '' })
  })

  await check('normalizeFrame ④：不认识的帧进 other 且保留 raw；错误帧不当正文', () => {
    const frame = { event: 'paper-workbench-status', payload: { state: 'running' } }
    assertFrame(frame, { kind: 'other' })
    assert.equal(normalizeFrame(frame).raw, frame)
    assertFrame({ kind: 'stream-error', message: '模型挂了' }, { kind: 'other' })
  })

  await check('normalizeFrame ⑤：裸 content / 嵌套 content 数组 / data 解包都能取到文本', () => {
    assertFrame({ content: [{ type: 'text', text: '只说正文' }] }, {
      kind: 'message',
      role: 'assistant',
      text: '只说正文',
    })
    assertFrame(
      { kind: 'message', message: { role: 'assistant', content: [[{ type: 'text', text: '甲' }], { type: 'text', text: '乙' }] } },
      { kind: 'message', role: 'assistant', text: '甲\n乙' },
    )
    assertFrame({ data: { message: { role: 'assistant', content: [{ type: 'text', text: '深层' }] } } }, {
      kind: 'message',
      role: 'assistant',
      text: '深层',
    })
  })

  await check('normalizeFrame ⑥：finish / done / 完成状态都归一成 done', () => {
    assertFrame({ kind: 'finish', reason: { kind: 'stop' } }, { kind: 'done' })
    assertFrame({ event: 'done' }, { kind: 'done' })
    assertFrame({ done: true }, { kind: 'done' })
    assertFrame({ status: 'completed' }, { kind: 'done' })
  })

  await check('normalizeFrame：null/字符串/数组/数字/无文本消息/会抛的 getter 都不抛', () => {
    for (const input of [null, undefined, 'plain string', 42, [], [{ type: 'text', text: 'x' }], true]) {
      const out = normalizeFrame(input)
      assert.equal(out.kind, 'other')
      assert.equal(out.raw, input)
    }
    // 有 role 但没有正文：不算消息
    assertFrame({ kind: 'message', message: { role: 'assistant', content: [] } }, { kind: 'other' })
    // 属性读取抛错（getter/Proxy）也必须兜住，否则一条 SSE 流会被一帧打断
    const hostile = {
      get kind() {
        throw new Error('boom')
      },
    }
    const out = normalizeFrame(hostile)
    assert.equal(out.kind, 'other')
    assert.equal(out.raw, hostile)
  })

  await check('normalizeFrame：at 透出时间戳（数字原样、缺失时不带该字段）', () => {
    assertFrame({ kind: 'assistant-delta', text: 'x', at: 1700000000000 }, {
      kind: 'delta',
      text: 'x',
      at: 1700000000000,
    })
    assert.equal(normalizeFrame({ kind: 'assistant-delta', text: 'x' }).at, undefined)
  })
}

try {
  await run()
} catch (error) {
  failed += 1
  console.log('FAIL  测试脚本异常终止 -> ' + (error && error.stack ? error.stack : String(error)))
}

console.log('')
console.log('结果：PASS ' + passed + ' / FAIL ' + failed)
if (failed === 0) {
  console.log('ALL PASS')
} else {
  console.log('FAILED ' + failed)
  process.exitCode = 1
}
