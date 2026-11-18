/**
 * 有序并发翻译（lib/ai.js）+ 宿主常驻后台持久化翻译调度器（lib/translate-jobs.js）自测。
 *
 * 全程隔离在系统临时目录中运行，不依赖 DSH 宿主，不碰真实论文库。
 * 运行：node scripts/test-translate-jobs.mjs
 */
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import * as aiModule from '../lib/ai.js'
import { createJobLogger } from '../lib/jobs.js'
import { createTranslateJobManager, JOB_FILE, RESTART_PAUSED_REASON } from '../lib/translate-jobs.js'

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-translate-jobs-test-'))
process.env.DSH_PAPER_WORKBENCH_DATA = path.join(tmpRoot, 'data')
const store = await import('../lib/store.js')
const db = await import('../lib/db.js')

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
    console.log('FAIL  ' + name + ' -> ' + (error && error.stack ? error.stack : String(error)))
  }
}

function hashAt(seed) {
  return createHash('sha1').update(String(seed)).digest('hex').slice(0, 16)
}

function makeSection({ id = 's1', order = 0, title = '1 Introduction', startParagraph = 0 } = {}) {
  return { id, order, title, level: 1, page: 1, hash: hashAt('section:' + id), startParagraph }
}

function makeParagraph({ id, order, section = 's1', kind = 'body', text = 'Hello world', page = 1 }) {
  return { id, order, page, section, kind, level: 0, text, hash: hashAt('paragraph:' + id) }
}

function makeDoc({ sections = [], paragraphs = [], title = '并发翻译测试论文' } = {}) {
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

function idsIn(options) {
  const content = options.messages[0].content[0].text
  const marker = '待翻译段落（每行一个 JSON）：'
  const at = content.indexOf(marker)
  const slice = at >= 0 ? content.slice(at + marker.length) : content
  const ids = []
  for (const match of slice.matchAll(/\{"id":"([^"]+)","text":/g)) ids.push(match[1])
  return ids
}

function abortError() {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时（' + timeoutMs + 'ms）')
}

function createFakeServices(handler) {
  const calls = []
  let inFlight = 0
  let maxInFlight = 0
  const llm = {
    calls,
    stats: () => ({ inFlight, maxInFlight }),
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    listModels: async (provider) => [
      { provider, id: 'm1', name: 'M1' },
      { provider, id: 'm2', name: 'M2' },
    ],
    stream(options) {
      const index = calls.length
      calls.push(options)
      return (async function* () {
        if (options.signal && options.signal.aborted) throw abortError()
        inFlight += 1
        if (inFlight > maxInFlight) maxInFlight = inFlight
        try {
          const chunks = await handler(options, index)
          for (const chunk of chunks || []) {
            if (options.signal && options.signal.aborted) throw abortError()
            yield chunk
          }
        } finally {
          inFlight -= 1
        }
      })()
    },
  }
  return {
    llm,
    getServices: () => ({
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'm1' }) },
    }),
  }
}

async function main() {
  // ---------------------------------------------------------------- 1. concurrency = 3 FIFO 与真实并发加速

  await check('concurrency=3：严格按原文 FIFO 顺序发请求、真实并发数为 3、耗时显著低于串行、写库无丢失', async () => {
    const s1 = makeSection({ id: 's1', order: 0, title: '1 Introduction' })
    const s2 = makeSection({ id: 's2', order: 1, title: '2 Method' })
    // 6 个批次（每批 6 段，共 36 段）：chunk 0..2 在 s1，chunk 3..5 在 s2
    const paragraphs = Array.from({ length: 36 }, (_, n) =>
      makeParagraph({
        id: 'p' + String(n).padStart(2, '0'),
        order: n,
        section: n < 18 ? 's1' : 's2',
        text: 'Paragraph number ' + n + ' content for concurrent translation.',
      }),
    )
    await store.writeDoc('conc-1', makeDoc({ sections: [s1, s2], paragraphs }))

    const startedBatches = []
    const finishedBatches = []
    // 故意让 chunk 0 比 chunk 1 慢，验证先完成的 chunk 会流式先吐出来，但发起顺序仍严格 FIFO
    const perBatchDelay = [90, 30, 50, 70, 30, 40]
    const services = createFakeServices(async (options, callIndex) => {
      const ids = idsIn(options)
      startedBatches.push(ids[0])
      const waitMs = perBatchDelay[callIndex] || 30
      await delay(waitMs, options.signal)
      finishedBatches.push(ids[0])
      return [
        { type: 'text-delta', index: 0, text: JSON.stringify(ids.map((id) => ({ id, zh: '译-' + id }))) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    })

    const engine = aiModule.createAi({ store, getServices: services.getServices })
    const t0 = Date.now()
    const events = await collect(engine.translate({ id: 'conc-1', concurrency: 3 }))
    const elapsed = Date.now() - t0

    eq(services.llm.calls.length, 6, '应分为 6 批')
    eq(services.llm.stats().maxInFlight, 3, '并发数必须确实达到 3')
    eq(startedBatches, ['p00', 'p06', 'p12', 'p18', 'p24', 'p30'], '请求必须严格按原文 chunks 顺序 FIFO 发出')
    ok(finishedBatches[0] !== 'p00', '较快的 chunk 1 应先于较慢的 chunk 0 完成并流式吐出')
    const serialTotalMs = perBatchDelay.reduce((a, b) => a + b, 0) // 310ms
    ok(elapsed < serialTotalMs * 0.72, '并发耗时 (' + elapsed + 'ms) 应显著低于串行耗时 (' + serialTotalMs + 'ms)')

    const startMeta = events.find((e) => e.event === 'start' && e.data && e.data.kind === 'start')
    ok(Boolean(startMeta), 'start 事件应包含 kind=start 元信息')
    eq(startMeta.data.total, 36)
    eq(startMeta.data.already, 0)
    eq(startMeta.data.pending, 36)
    eq(startMeta.data.concurrency, 3)
    eq(startMeta.data.model, 'fake/m1')
    eq(startMeta.data.paperId, 'conc-1')
    eq(startMeta.data.totalChunks, 6)

    const progressEvents = events.filter((e) => e.event === 'progress')
    eq(progressEvents.length, 6, '每个 chunk 完成都应回报一次 progress')
    eq(progressEvents.map((e) => e.data.completedChunks), [1, 2, 3, 4, 5, 6])
    ok(progressEvents.every((e) => e.data.concurrency === 3 && e.data.totalChunks === 6))

    const end = events[events.length - 1]
    eq(end.event, 'end')
    eq(end.data.ok, true)
    eq(end.data.done, 36)
    eq(end.data.concurrency, 3)
    eq(end.data.completedChunks, 6)
    eq(end.data.totalChunks, 6)

    const trans = await store.readTrans('conc-1')
    eq(Object.keys(trans.entries).length, 36, '并发写库不得竞争丢条目')
    for (const p of paragraphs) {
      eq(trans.entries[p.hash].zh, '译-' + p.id)
    }
  })

  // ---------------------------------------------------------------- 2. concurrency 并发边界 + 截断重试/兜底/tidyMath 一致性

  await check('concurrency 边界夹在 1..8，且并发池下截断翻倍重试、逐段兜底与 tidyMath 一致', async () => {
    const s1 = makeSection({ id: 's1' })
    // 2 批（每批 6 段，共 12 段）
    const paragraphs = Array.from({ length: 12 }, (_, n) =>
      makeParagraph({
        id: 'c' + n,
        order: n,
        text: 'Sentence ' + n + ' with math $x$.',
      }),
    )
    await store.writeDoc('conc-edge', makeDoc({ sections: [s1], paragraphs }))

    let batch0Hits = 0
    const services = createFakeServices(async (options) => {
      const ids = idsIn(options)
      await delay(15, options.signal)
      // 第 1 批首次 max-tokens 截断，翻倍后返回带 \(...\) 的译文测试 tidyMath
      if (ids.includes('c0') && ids.length > 1) {
        batch0Hits += 1
        if (batch0Hits === 1) {
          return [{ type: 'finish', reason: { kind: 'max-tokens' } }]
        }
        return [
          {
            type: 'text-delta',
            text: JSON.stringify(ids.map((id) => ({ id, zh: '译-' + id + ' \\(x^2\\)' }))),
          },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
      }
      // 第 2 批整批返回坏 JSON 触发逐段兜底，逐段时成功
      if (ids.length > 1) {
        return [
          { type: 'text-delta', text: 'bad json' },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
      }
      return [
        { type: 'text-delta', text: JSON.stringify([{ id: ids[0], zh: '单段-' + ids[0] }]) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    })

    const engine = aiModule.createAi({ store, getServices: services.getServices })
    const events = await collect(engine.translate({ id: 'conc-edge', concurrency: 99 }))
    const startMeta = events.find((e) => e.event === 'start' && e.data && e.data.kind === 'start')
    eq(startMeta.data.concurrency, 8, 'concurrency > 8 应夹到 8')
    const end = events[events.length - 1]
    eq(end.data.ok, true)
    eq(end.data.done, 12)
    const trans = await store.readTrans('conc-edge')
    eq(Object.keys(trans.entries).length, 12)
    eq(trans.entries[paragraphs[0].hash].zh, '译-c0 $x^2$', '并发模式下也应做 tidyMath')
    eq(trans.entries[paragraphs[6].hash].zh, '单段-c6', '并发模式下坏 JSON 应走逐段兜底')
  })

  // ---------------------------------------------------------------- 3. 单论文最多一个运行中任务 & 断连不中断后台完成

  await check('后台任务：单论文互斥，订阅者断连(unsubscribe)绝不中断后台翻译，重连重放完整结果', async () => {
    const s1 = makeSection({ id: 's1', title: '1 Background' })
    const paragraphs = Array.from({ length: 18 }, (_, n) =>
      makeParagraph({ id: 'bg' + n, order: n, text: 'Background paragraph ' + n }),
    )
    await store.writeDoc('bg-1', makeDoc({ sections: [s1], paragraphs }))

    const services = createFakeServices(async (options) => {
      const ids = idsIn(options)
      await delay(35, options.signal)
      return [
        { type: 'text-delta', text: JSON.stringify(ids.map((id) => ({ id, zh: '后台-' + id }))) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    })
    const engine = aiModule.createAi({ store, getServices: services.getServices })
    const logger = createJobLogger({
      append: (pid, ev) => db.jobAppend(pid, ev),
      list: (pid, opts) => db.jobList(pid, opts),
      clear: (pid) => db.jobClear(pid),
    })
    const broadcasts = []
    const mgr = createTranslateJobManager({
      ai: engine,
      store,
      dbBackendOrDb: db,
      jobs: logger,
      broadcast: (msg) => broadcasts.push(msg),
    })

    // 并发调用两次 startJob，应返回同一个任务 ID
    const [job1, job2] = await Promise.all([
      mgr.startJob({ paperId: 'bg-1', concurrency: 2 }),
      mgr.startJob({ paperId: 'bg-1', concurrency: 2 }),
    ])
    eq(job1.id, job2.id, '单论文同时只允许一个运行中任务')
    eq(job1.status, 'running')
    eq((await mgr.listActive()).length, 1)

    // 订阅者 A 收到第一批 chunk 后立即断连（unsubscribe）
    const eventsA = []
    let unsubA = null
    unsubA = mgr.subscribe(job1.id, (frame) => {
      eventsA.push(frame)
      if (frame.event === 'chunk' && typeof unsubA === 'function') {
        unsubA()
      }
    })

    await waitFor(() => eventsA.some((f) => f.event === 'chunk'))
    const countAfterUnsub = eventsA.length
    // 等待后台任务不受断连影响继续跑完直至 done
    await waitFor(async () => (await mgr.status('bg-1'))?.status === 'done', 5000)

    eq(eventsA.length, countAfterUnsub, 'unsubscribe 后不应再收到后续事件')
    const finalStatus = await mgr.status('bg-1')
    eq(finalStatus.status, 'done')
    eq(finalStatus.completed, 18)
    eq(finalStatus.total, 18)
    eq((await mgr.listActive()).length, 0, '完成后不应再出现在 listActive')

    // 重新订阅（replay=true）：应先重放最近状态与已翻译摘要，以及 done 终态
    const eventsB = []
    const unsubB = mgr.subscribe('bg-1', (frame) => eventsB.push(frame), { replay: true })
    await waitFor(() => eventsB.some((f) => f.event === 'done'))
    unsubB()

    const replayProgress = eventsB.find((f) => f.event === 'progress')
    ok(Boolean(replayProgress && replayProgress.data.replay === true))
    eq(replayProgress.data.translatedCount, 18)
    const replayChunks = eventsB.filter((f) => f.event === 'chunk')
    eq(replayChunks.length, 18, '重新订阅应能重放全部 18 条已翻译结果')
    const replayDone = eventsB.find((f) => f.event === 'done')
    eq(replayDone.data.done, 18)

    // 验证 db 与任务日志也完整落地
    const trans = await store.readTrans('bg-1')
    eq(Object.keys(trans.entries).length, 18)
    const logged = logger.list('bg-1')
    ok(logged.events.some((ev) => ev.kind === 'end' && ev.extra && ev.extra.status === 'ok'))
    ok(broadcasts.some((b) => b.event === 'done' && b.paperId === 'bg-1'))
  })

  // ---------------------------------------------------------------- 4. stream() HTTP SSE 断连不中断后台任务

  await check('stream() 外部 signal abort 仅退订观察者，后台继续完成', async () => {
    const s1 = makeSection({ id: 's1' })
    const paragraphs = Array.from({ length: 12 }, (_, n) =>
      makeParagraph({ id: 'st' + n, order: n, text: 'Stream paragraph ' + n }),
    )
    await store.writeDoc('stream-1', makeDoc({ sections: [s1], paragraphs }))

    const services = createFakeServices(async (options) => {
      const ids = idsIn(options)
      await delay(30, options.signal)
      return [
        { type: 'text-delta', text: JSON.stringify(ids.map((id) => ({ id, zh: '流-' + id }))) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    })
    const mgr = createTranslateJobManager({
      ai: aiModule.createAi({ store, getServices: services.getServices }),
      store,
    })

    await mgr.startJob({ paperId: 'stream-1', concurrency: 2 })
    const httpController = new AbortController()
    const got = []
    for await (const frame of mgr.stream('stream-1', { signal: httpController.signal })) {
      got.push(frame)
      if (frame.event === 'chunk') httpController.abort()
    }
    ok(got.some((f) => f.event === 'chunk'))
    await waitFor(async () => (await mgr.status('stream-1'))?.status === 'done', 5000)
    const trans = await store.readTrans('stream-1')
    eq(Object.keys(trans.entries).length, 12)
  })

  // ---------------------------------------------------------------- 5. pauseJob & resumeJob（停发新请求、不报 error、跳过已译）

  await check('显式 pauseJob 停发新请求并落盘 paused，resumeJob 仅翻译剩余未译条目', async () => {
    const s1 = makeSection({ id: 's1', order: 0, title: '1 Intro' })
    const s2 = makeSection({ id: 's2', order: 1, title: '2 Design' })
    // 4 批（s1 2批=12段，s2 2批=12段）
    const paragraphs = Array.from({ length: 24 }, (_, n) =>
      makeParagraph({
        id: 'pr' + String(n).padStart(2, '0'),
        order: n,
        section: n < 12 ? 's1' : 's2',
        text: 'Pause resume paragraph ' + n,
      }),
    )
    await store.writeDoc('pause-1', makeDoc({ sections: [s1, s2], paragraphs }))

    const services = createFakeServices(async (options, index) => {
      const ids = idsIn(options)
      // 第 1 批很快完成，第 2 批故意较慢以便我们在第 1 批结束后精确 pause
      await delay(index === 0 ? 15 : 180, options.signal)
      return [
        { type: 'text-delta', text: JSON.stringify(ids.map((id) => ({ id, zh: '暂续-' + id }))) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    })

    const mgr = createTranslateJobManager({
      ai: aiModule.createAi({ store, getServices: services.getServices }),
      store,
    })

    const subEvents = []
    const job = await mgr.startJob({
      paperId: 'pause-1',
      scope: 'all',
      concurrency: 1,
      target: 'zh',
      model: { provider: 'fake', model: 'm2' },
    })
    const unsub = mgr.subscribe(job.id, (f) => subEvents.push(f))

    // 等第 1 批（6 段）翻完且发出 chunk 后暂停
    await waitFor(() => subEvents.filter((f) => f.event === 'chunk').length >= 6)
    const pausedSnap = await mgr.pauseJob('pause-1')
    unsub()

    eq(pausedSnap.status, 'paused', '主动暂停后 status 应为 paused 而不是 error')
    eq(pausedSnap.error, undefined, '主动暂停不应产生错误信息')
    eq(pausedSnap.completed, 6)
    eq(pausedSnap.total, 24)
    ok(subEvents.some((f) => f.event === 'paused'), '订阅者应收到 paused 帧')
    ok(!subEvents.some((f) => f.event === 'error' && f.data && f.data.fatal), '不应发致命 error 帧')

    const callsAtPause = services.llm.calls.length
    ok(callsAtPause <= 2, '暂停后不应继续发后续批次请求，实际调用数 ' + callsAtPause)
    // 等一小会儿确认没有新的在途请求偷偷发出
    await new Promise((resolve) => setTimeout(resolve, 60))
    eq(services.llm.calls.length, callsAtPause, '暂停后调用数应冻结')

    const diskJob = await store.readJson(store.paperFile('pause-1', JOB_FILE), null)
    eq(diskJob.status, 'paused')
    eq(diskJob.completed, 6)
    eq(diskJob.total, 24)
    eq(diskJob.model, 'fake/m2')

    const transMid = await store.readTrans('pause-1')
    eq(Object.keys(transMid.entries).length, 6, '暂停前已完成 6 段必须已落盘')

    // 确认 listActive 包含已暂停任务
    const activeBeforeResume = await mgr.listActive()
    eq(activeBeforeResume.length, 1)
    eq(activeBeforeResume[0].paperId, 'pause-1')
    eq(activeBeforeResume[0].status, 'paused')

    // 继续翻译：只翻译剩余 18 段，复用 model/concurrency
    const resumed = await mgr.resumeJob('pause-1')
    eq(resumed.id, job.id, 'resumeJob 应沿用原任务 id')
    eq(resumed.status, 'running')
    eq(resumed.model, 'fake/m2')
    eq(resumed.concurrency, 1)

    await waitFor(async () => (await mgr.status('pause-1'))?.status === 'done', 5000)
    const resumeCalls = services.llm.calls.slice(callsAtPause)
    const resumedIds = resumeCalls.flatMap((call) => idsIn(call))
    eq(resumedIds.length, 18, 'resumeJob 只应请求剩余 18 段，不应重翻已译的 6 段')
    for (let i = 0; i < 6; i += 1) {
      ok(!resumedIds.includes('pr0' + i), '已译段落 pr0' + i + ' 不得再次进入请求')
    }
    ok(resumeCalls.every((call) => call.model === 'm2'), 'resumeJob 应复用上次选用的模型 m2')

    const transFinal = await store.readTrans('pause-1')
    eq(Object.keys(transFinal.entries).length, 24)
    eq(transFinal.entries[paragraphs[0].hash].zh, '暂续-pr00', '旧译文不得被覆盖')
    eq(transFinal.entries[paragraphs[6].hash].zh, '暂续-pr06', '续译后剩余段落应补齐')
  })

  // ---------------------------------------------------------------- 6. 冷重启恢复（running -> paused 并可续翻）

  await check('冷重启恢复：预写 status=running 的 translate.job.json → 新建 manager 归一化为 paused → resumeJob 续翻', async () => {
    const s1 = makeSection({ id: 's1', order: 0, title: '1 Abstract' })
    const s2 = makeSection({ id: 's2', order: 1, title: '2 Related Work' })
    const paragraphs = Array.from({ length: 12 }, (_, n) =>
      makeParagraph({
        id: 'cr' + String(n).padStart(2, '0'),
        order: n,
        section: n < 6 ? 's1' : 's2',
        text: 'Cold restart paragraph ' + n,
      }),
    )
    await store.writeDoc('cold-1', makeDoc({ sections: [s1, s2], paragraphs }))
    // 模拟崩溃前已写库的 6 段（s1 全节）
    const preEntries = {}
    for (let i = 0; i < 6; i += 1) {
      preEntries[paragraphs[i].hash] = { zh: '重启前-' + paragraphs[i].id, at: new Date().toISOString(), model: 'fake/m1' }
    }
    await store.mergeTrans('cold-1', { target: 'zh', model: { provider: 'fake', model: 'm1' }, entries: preEntries })

    // 模拟宿主强杀前磁盘上遗留 status: 'running' 的断点文件（仅针对 s2 或整篇）
    await store.writeJsonAtomic(store.paperFile('cold-1', JOB_FILE), {
      id: 'tj-cold-prev',
      paperId: 'cold-1',
      scope: 'all',
      target: 'zh',
      model: 'fake/m2',
      status: 'running',
      concurrency: 3,
      completed: 6,
      total: 12,
      already: 0,
      currentSectionId: 's1',
      currentSectionTitle: '1 Abstract',
      startedAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:01:00.000Z',
    })

    const services = createFakeServices(async (options) => {
      const ids = idsIn(options)
      await delay(20, options.signal)
      return [
        { type: 'text-delta', text: JSON.stringify(ids.map((id) => ({ id, zh: '重启后-' + id }))) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    })

    const mgr2 = createTranslateJobManager({
      ai: aiModule.createAi({ store, getServices: services.getServices }),
      store,
      dbBackendOrDb: db,
    })

    const recovered = await mgr2.status('cold-1')
    ok(Boolean(recovered), '应能从磁盘恢复任务状态')
    eq(recovered.status, 'paused', '冷重启后遗留 running 应自动归一化为 paused')
    eq(recovered.error, RESTART_PAUSED_REASON)
    eq(recovered.concurrency, 3)
    eq(recovered.completed, 6)
    eq(recovered.total, 12)

    const diskAfterBoot = await store.readJson(store.paperFile('cold-1', JOB_FILE), null)
    eq(diskAfterBoot.status, 'paused', '磁盘断点文件也应同步更新为 paused')
    eq(diskAfterBoot.error, RESTART_PAUSED_REASON)

    const active = await mgr2.listActive()
    ok(active.some((item) => item.paperId === 'cold-1' && item.status === 'paused'))

    // 即使在恢复前订阅，replay 也应包含已有的 6 条译文摘要与 paused 状态
    const replayFrames = []
    const unsubReplay = mgr2.subscribe('cold-1', (f) => replayFrames.push(f), { replay: true })
    ok(replayFrames.some((f) => f.event === 'paused' && f.data.error === RESTART_PAUSED_REASON))
    eq(replayFrames.filter((f) => f.event === 'chunk').length, 6)
    unsubReplay()

    // 一键继续翻译：只翻译剩余 s2 的 6 段，复用 concurrency=3 与 model=fake/m2
    const resumed = await mgr2.resumeJob('cold-1')
    eq(resumed.status, 'running')
    await waitFor(async () => (await mgr2.status('cold-1'))?.status === 'done', 5000)

    eq(services.llm.calls.length, 1, '剩余 6 段同属 s2，应仅发 1 批请求')
    eq(services.llm.calls[0].model, 'm2', '应复用断点记录中的模型 m2')
    eq(idsIn(services.llm.calls[0]), ['cr06', 'cr07', 'cr08', 'cr09', 'cr10', 'cr11'])

    const doneSnap = await mgr2.status('cold-1')
    eq(doneSnap.status, 'done')
    eq(doneSnap.completed, 12)
    eq(doneSnap.total, 12)
    eq(doneSnap.already, 6)

    const trans = await store.readTrans('cold-1')
    eq(Object.keys(trans.entries).length, 12)
    eq(trans.entries[paragraphs[0].hash].zh, '重启前-cr00')
    eq(trans.entries[paragraphs[6].hash].zh, '重启后-cr06')
  })

  // ---------------------------------------------------------------- 7. 异常容错：section 局部续跑与错误记录

  await check('section 作用域与错误态恢复：单节失败标记 error 后可 resumeJob 重试成功', async () => {
    const s1 = makeSection({ id: 's1', order: 0, title: '1 Intro' })
    const s2 = makeSection({ id: 's2', order: 1, title: '2 Eval' })
    const p1 = makeParagraph({ id: 'e0', order: 0, section: 's1', text: 'Intro text' })
    const p2 = makeParagraph({ id: 'e1', order: 1, section: 's2', text: 'Eval text 1' })
    const p3 = makeParagraph({ id: 'e2', order: 2, section: 's2', text: 'Eval text 2' })
    await store.writeDoc('err-1', makeDoc({ sections: [s1, s2], paragraphs: [p1, p2, p3] }))

    let failMode = true
    const services = createFakeServices(async (options) => {
      const ids = idsIn(options)
      await delay(10, options.signal)
      if (failMode) {
        return [{ type: 'finish', reason: { kind: 'error', failure: { message: '上游故障' } } }]
      }
      return [
        { type: 'text-delta', text: JSON.stringify(ids.map((id) => ({ id, zh: '恢复-' + id }))) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    })

    const mgr = createTranslateJobManager({
      ai: aiModule.createAi({ store, getServices: services.getServices }),
      store,
    })

    await mgr.startJob({ paperId: 'err-1', scope: 'section', sectionId: 's2', concurrency: 2 })
    await waitFor(async () => (await mgr.status('err-1'))?.status === 'error', 5000)

    const errSnap = await mgr.status('err-1')
    eq(errSnap.status, 'error')
    eq(errSnap.scope, 'section')
    eq(errSnap.sectionId, 's2')
    ok(Boolean(errSnap.error))

    failMode = false
    await mgr.resumeJob('err-1')
    await waitFor(async () => (await mgr.status('err-1'))?.status === 'done', 5000)

    const trans = await store.readTrans('err-1')
    eq(trans.entries[p1.hash], undefined, 'section=s2 任务不应误翻 s1')
    eq(trans.entries[p2.hash].zh, '恢复-e1')
    eq(trans.entries[p3.hash].zh, '恢复-e2')
  })

  // ---------------------------------------------------------------- 8. 运行中途重连（replay:true vs replay:false）& 多论文并发隔离

  await check('运行中途断连后重连续接实时 chunk，且多论文并发各自独立控制', async () => {
    const s1 = makeSection({ id: 's1' })
    const makeList = (prefix, count) =>
      Array.from({ length: count }, (_, n) => makeParagraph({ id: prefix + n, order: n, text: prefix + ' text ' + n }))
    const psA = makeList('ma', 18) // 3 批
    const psB = makeList('mb', 12) // 2 批
    await store.writeDoc('multi-a', makeDoc({ sections: [s1], paragraphs: psA }))
    await store.writeDoc('multi-b', makeDoc({ sections: [s1], paragraphs: psB }))

    const services = createFakeServices(async (options) => {
      const ids = idsIn(options)
      await delay(50, options.signal)
      return [
        { type: 'text-delta', text: JSON.stringify(ids.map((id) => ({ id, zh: '多-' + id }))) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    })
    const mgr = createTranslateJobManager({
      ai: aiModule.createAi({ store, getServices: services.getServices }),
      store,
    })

    await mgr.startJob({ paperId: 'multi-a', concurrency: 1 })
    await mgr.startJob({ paperId: 'multi-b', concurrency: 1 })
    eq((await mgr.listActive()).length, 2, '两篇论文同时处于 active')

    // multi-a 收到第 1 批（6 段）后退订，然后立刻用 replay:true 和 replay:false 各开一个订阅者
    const firstSub = []
    let unsub1 = null
    unsub1 = mgr.subscribe('multi-a', (f) => {
      firstSub.push(f)
      if (firstSub.filter((x) => x.event === 'chunk').length >= 6 && unsub1) unsub1()
    })
    await waitFor(() => firstSub.filter((x) => x.event === 'chunk').length >= 6)

    const liveWithReplay = []
    const liveNoReplay = []
    const unsubReplay = mgr.subscribe('multi-a', (f) => liveWithReplay.push(f), { replay: true })
    const unsubNoReplay = mgr.subscribe('multi-a', (f) => liveNoReplay.push(f), { replay: false })

    // 暂停 multi-b，不应影响 multi-a 继续完成
    const pausedB = await mgr.pauseJob('multi-b')
    eq(pausedB.status, 'paused')

    await waitFor(async () => (await mgr.status('multi-a'))?.status === 'done', 5000)
    unsubReplay()
    unsubNoReplay()

    eq((await mgr.status('multi-b')).status, 'paused', 'multi-b 应仍保持暂停')
    eq(
      liveWithReplay.filter((f) => f.event === 'chunk').length,
      18,
      'replay=true 中途重连应同时收到重放摘要 + 后续实时 chunk 共 18 条',
    )
    ok(liveWithReplay.some((f) => f.event === 'chunk' && f.data.replay === true))
    ok(liveWithReplay.some((f) => f.event === 'done' && !f.data.replay))
    ok(!liveNoReplay.some((f) => f.data && f.data.replay === true), 'replay=false 不应收到重放帧')
    ok(liveNoReplay.some((f) => f.event === 'done'))
  })

  // ---------------------------------------------------------------- 9. concurrency=3 并发池中途 abort

  await check('concurrency=3 中途 abort：已完成批次落盘且停发后续批次，返回 end{aborted:true}', async () => {
    const s1 = makeSection({ id: 's1' })
    const paragraphs = Array.from({ length: 30 }, (_, n) =>
      makeParagraph({ id: 'ab' + n, order: n, text: 'Abort concurrent ' + n }),
    ) // 5 批
    await store.writeDoc('conc-abort', makeDoc({ sections: [s1], paragraphs }))

    const controller = new AbortController()
    const services = createFakeServices(async (options, index) => {
      const ids = idsIn(options)
      if (index === 0) {
        await delay(10, options.signal)
        return [
          { type: 'text-delta', text: JSON.stringify(ids.map((id) => ({ id, zh: '并发中-' + id }))) },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
      }
      await delay(120, options.signal)
      return [
        { type: 'text-delta', text: JSON.stringify(ids.map((id) => ({ id, zh: '晚到-' + id }))) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    })

    const engine = aiModule.createAi({ store, getServices: services.getServices })
    const events = []
    for await (const ev of engine.translate({ id: 'conc-abort', concurrency: 3 }, { signal: controller.signal })) {
      events.push(ev)
      if (ev.event === 'progress' && ev.data.completedChunks === 1) {
        controller.abort()
      }
    }

    const end = events[events.length - 1]
    eq(end.event, 'end')
    eq(end.data.aborted, true)
    eq(end.data.done, 6)
    ok(services.llm.calls.length <= 4, 'abort 后不应继续领取第 5 批请求')
    const trans = await store.readTrans('conc-abort')
    eq(Object.keys(trans.entries).length, 6, '并发池中止前已完成的 6 段必须完整落盘')
  })

  // ---------------------------------------------------------------- 收尾

  console.log('')
  console.log('检查 ' + (passed + failed) + ' 项：通过 ' + passed + '，失败 ' + failed)
  if (failed === 0) {
    await store.closeDb()
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
