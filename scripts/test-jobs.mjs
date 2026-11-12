/**
 * lib/jobs.js 回归测试：只用内存版 append/list/clear，不碰 SQLite、不碰真实库。
 *
 *   node scripts/test-jobs.mjs
 *
 * 覆盖契约 §4 末尾列出的用例外，再补三类容易回归的点：
 * - 事件形状/中文可读 message/进度数字；
 * - 存储实现抛错或返回 rejected Promise 时不能把业务拖垮；
 * - 模块保持纯依赖注入（源码里不允许出现 lib/db.js）。
 */
import { readFile } from 'node:fs/promises'

import { createJobLogger } from '../lib/jobs.js'

let pass = 0
let fail = 0

function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log('PASS  ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail += 1
    console.log('FAIL  ' + name + (detail ? '  ' + detail : ''))
  }
}

/** 内存版存储：形状和 lib/db.js 的 jobAppend/jobList/jobClear 对齐。 */
function memoryStore() {
  const data = new Map()
  const calls = { list: [], clear: [] }
  let seq = 0

  function append(paperId, event) {
    seq += 1
    const row = { seq, at: new Date().toISOString(), ...event }
    if (!data.has(paperId)) data.set(paperId, [])
    data.get(paperId).push(row)
    return seq
  }

  function list(paperId, opts = {}) {
    calls.list.push({ paperId, opts })
    const after = Number(opts.after) || 0
    const limit = Number(opts.limit) || 200
    const events = (data.get(paperId) || []).filter((row) => row.seq > after).slice(0, limit)
    return { events, lastSeq: events.length ? events[events.length - 1].seq : after }
  }

  function clear(paperId) {
    calls.clear.push(paperId)
    const count = (data.get(paperId) || []).length
    data.delete(paperId)
    return count
  }

  return {
    append,
    list,
    clear,
    calls,
    events(paperId) {
      return data.get(paperId) || []
    },
  }
}

function captureWarnings(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  try {
    fn()
  } finally {
    console.warn = original
  }
  return warnings
}

async function captureWarningsAsync(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  try {
    await fn()
  } finally {
    console.warn = original
  }
  return warnings
}

async function main() {
  try {
    await run()
  } catch (error) {
    fail += 1
    console.error('测试崩了：' + (error && error.message ? error.message : String(error)))
  }
  console.log(`\nPASS ${pass} / FAIL ${fail}`)
  process.exitCode = fail > 0 ? 1 : 0
}

async function run() {
  // ---------------------------------------------------------------- 生命周期
  const memory = memoryStore()
  const logger = createJobLogger(memory)

  const jobId = logger.start('demo', 'translate', { title: '演示论文', pages: 43 })
  check('start 返回 <paperId>#<n>', jobId === 'demo#1', jobId)
  check('同一篇第二条任务编号自增', logger.start('demo', 'ocr') === 'demo#2')
  check('不同论文各自从 #1 编号', logger.start('other', 'doc') === 'other#1')

  const startEvent = memory.events('demo')[0]
  check(
    'start 事件形状 level/kind/message/extra',
    startEvent.level === 'info' &&
      startEvent.kind === 'start' &&
      startEvent.message === '开始翻译' &&
      startEvent.extra.title === '演示论文' &&
      startEvent.extra.pages === 43,
    JSON.stringify(startEvent),
  )
  check('append 被调用时事件带 seq/at（存储层正常写入）', Number.isInteger(startEvent.seq) && typeof startEvent.at === 'string')

  const noMetaMemory = memoryStore()
  const noMetaLogger = createJobLogger(noMetaMemory)
  noMetaLogger.start('plain', 'doc')
  const noMetaEvent = noMetaMemory.events('plain')[0]
  check(
    'start 没传 meta 时事件不带 extra 键',
    noMetaEvent && !Object.prototype.hasOwnProperty.call(noMetaEvent, 'extra'),
    JSON.stringify(noMetaEvent),
  )

  let active = logger.active()
  const demoSummary = active.find((item) => item.jobId === jobId)
  check('active 只返回未结束任务（3 条）', active.length === 3, `count=${active.length}`)
  check(
    'active 摘要字段齐全',
    demoSummary &&
      demoSummary.paperId === 'demo' &&
      demoSummary.kind === 'translate' &&
      typeof demoSummary.startedAt === 'string' &&
      demoSummary.lastMessage === '开始翻译',
    JSON.stringify(demoSummary),
  )

  logger.log(jobId, 'warn', '缓存没有命中，正在请求模型', { key: 'abc' })
  const logEvent = memory.events('demo').find((event) => event.message === '缓存没有命中，正在请求模型')
  check(
    'log 事件 level/kind/extra 原样透传',
    logEvent && logEvent.level === 'warn' && logEvent.kind === 'log' && logEvent.extra.key === 'abc',
    JSON.stringify(logEvent),
  )
  active = logger.active()
  check('active 的 lastMessage 跟随最后一条日志', active.find((item) => item.jobId === jobId).lastMessage === '缓存没有命中，正在请求模型')

  logger.progress(jobId, { done: 12, total: 43 })
  const progressEvent = memory.events('demo').find((event) => event.kind === 'progress')
  check('progress message 是可读中文（翻译 12/43 段）', progressEvent.message === '翻译 12/43 段', progressEvent.message)
  check('progress extra 带数字 done/total', progressEvent.extra.done === 12 && progressEvent.extra.total === 43)
  check('active 的 lastMessage 跟随 progress', logger.active().find((item) => item.jobId === jobId).lastMessage === '翻译 12/43 段')

  logger.finish(jobId, 'ok', { note: '搞定' })
  const endEvent = memory.events('demo').find((event) => event.kind === 'end')
  check(
    'finish(ok) 写 end / info / 完成 / status=ok',
    endEvent &&
      endEvent.level === 'info' &&
      endEvent.kind === 'end' &&
      endEvent.message === '翻译完成' &&
      endEvent.extra.status === 'ok' &&
      endEvent.extra.note === '搞定',
    JSON.stringify(endEvent),
  )
  const countAfterFirstFinish = memory.events('demo').length
  logger.finish(jobId, 'failed', { error: '不该再写' })
  logger.fail(jobId, new Error('也不该再写'))
  check('finish 幂等：重复 finish/fail 不再写事件', memory.events('demo').length === countAfterFirstFinish)
  check('active 排除已结束任务', logger.active().every((item) => item.jobId !== jobId))

  const failedMemory = memoryStore()
  const failedLogger = createJobLogger(failedMemory)
  const failedId = failedLogger.start('fail', 'review')
  failedLogger.finish(failedId, 'failed', { reason: '模型返回空' })
  const failedEvent = failedMemory.events('fail').find((event) => event.kind === 'end')
  check(
    'finish(failed) → error / 失败 / status=failed',
    failedEvent.level === 'error' &&
      failedEvent.kind === 'end' &&
      failedEvent.message === '自检失败' &&
      failedEvent.extra.status === 'failed',
    JSON.stringify(failedEvent),
  )

  const cancelMemory = memoryStore()
  const cancelLogger = createJobLogger(cancelMemory)
  const cancelId = cancelLogger.start('cancel', 'figures')
  cancelLogger.finish(cancelId, 'cancelled')
  const cancelEvent = cancelMemory.events('cancel').find((event) => event.kind === 'end')
  check(
    'finish(cancelled) → warn / 已取消 / status=cancelled',
    cancelEvent.level === 'warn' &&
      cancelEvent.kind === 'end' &&
      cancelEvent.message === '配图已取消' &&
      cancelEvent.extra.status === 'cancelled',
    JSON.stringify(cancelEvent),
  )

  const weirdMemory = memoryStore()
  const weirdLogger = createJobLogger(weirdMemory)
  const weirdId = weirdLogger.start('weird', 'translate')
  weirdLogger.finish(weirdId, '某天新状态')
  const weirdEvent = weirdMemory.events('weird').find((event) => event.kind === 'end')
  check(
    'finish 未知 status 归一成 ok（不抛）',
    weirdEvent && weirdEvent.extra.status === 'ok' && weirdEvent.message === '翻译完成',
    JSON.stringify(weirdEvent),
  )

  // ---------------------------------------------------------------- 事件顺序
  const orderMemory = memoryStore()
  const orderLogger = createJobLogger(orderMemory)
  const orderId = orderLogger.start('order', 'translate')
  orderLogger.log(orderId, 'info', '第一步')
  orderLogger.progress(orderId, { done: 1, total: 2 })
  orderLogger.finish(orderId, 'ok')
  check(
    'start→log→progress→end 顺序正确',
    JSON.stringify(orderMemory.events('order').map((event) => event.kind)) === JSON.stringify(['start', 'log', 'progress', 'end']),
    JSON.stringify(orderMemory.events('order').map((event) => event.kind)),
  )

  // ---------------------------------------------------------------- 未知 jobId
  const ghostMemory = memoryStore()
  const ghostLogger = createJobLogger(ghostMemory)
  let ghostThrew = false
  let ghostId = ''
  try {
    ghostLogger.log('ghost#7', 'info', '孤儿日志', { source: 'test' })
    ghostLogger.log('no-hash', 'error', '没有井号的 id')
    ghostId = ghostLogger.start('ghost', 'translate')
  } catch {
    ghostThrew = true
  }
  check('未知 jobId 的 log 不抛', !ghostThrew)
  const ghostLog = ghostMemory.events('ghost').find((event) => event.message === '孤儿日志')
  check('未知 jobId 的日志按解析出的 paperId 记录（kind=log）', ghostLog && ghostLog.kind === 'log' && ghostLog.extra.source === 'test')
  check('没有井号的 jobId 整串当 paperId', ghostMemory.events('no-hash').some((event) => event.message === '没有井号的 id'))

  ghostLogger.log('ghost#9', 'not-a-level', '非法 level 归一 info')
  const illegalLevel = ghostMemory.events('ghost').find((event) => event.message === '非法 level 归一 info')
  check('非法 level 归一成 info 而不是抛错', illegalLevel && illegalLevel.level === 'info')

  let progressThrew = false
  try {
    ghostLogger.progress('ghost#9', { done: 3, total: 10 })
  } catch {
    progressThrew = true
  }
  check('未知 jobId 的 progress 不抛且仍记录', !progressThrew && ghostMemory.events('ghost').some((event) => event.kind === 'progress'))

  const ghostBefore = ghostMemory.events('ghost').length
  ghostLogger.finish('ghost#8', 'ok')
  const ghostAfterOne = ghostMemory.events('ghost').length
  ghostLogger.finish('ghost#8', 'ok')
  check('未知 jobId 的 finish 只记一次', ghostAfterOne === ghostBefore + 1 && ghostMemory.events('ghost').length === ghostAfterOne)
  check(
    '未知 jobId 的 finish 文案可读（任务完成）',
    ghostMemory.events('ghost').some((event) => event.kind === 'end' && event.message === '任务完成'),
  )
  check('ghost 自己的任务仍在 active', ghostLogger.active().some((item) => item.jobId === ghostId))

  // ---------------------------------------------------------------- 进度单位
  const unitMemory = memoryStore()
  const unitLogger = createJobLogger(unitMemory)
  const translateId = unitLogger.start('units', 'translate')
  unitLogger.progress(translateId, { done: 12, total: 43 })
  const ocrId = unitLogger.start('units', 'ocr')
  unitLogger.progress(ocrId, { done: 2, total: 10 })
  const figuresId = unitLogger.start('units', 'figures')
  unitLogger.progress(figuresId, { done: 1, total: 3 })
  const progressMessages = unitMemory.events('units').filter((event) => event.kind === 'progress').map((event) => event.message)
  check('translate 进度单位是段', progressMessages.includes('翻译 12/43 段'), progressMessages.join(' / '))
  check('ocr 进度单位是页', progressMessages.includes('OCR 2/10 页'))
  check('figures 进度单位是张', progressMessages.includes('配图 1/3 张'))

  const oddMemory = memoryStore()
  const oddLogger = createJobLogger(oddMemory)
  const oddId = oddLogger.start('odd', 'translate')
  oddLogger.progress(oddId, { done: 'x', total: -2 })
  check('非法进度数字归一成 0/0', oddMemory.events('odd').some((event) => event.kind === 'progress' && event.message === '翻译 0/0 段'))

  const emptyKindMemory = memoryStore()
  const emptyKindLogger = createJobLogger(emptyKindMemory)
  const emptyKindId = emptyKindLogger.start('empty-kind', '', undefined)
  emptyKindLogger.progress(emptyKindId, { done: 1, total: 2 })
  check('空 kind 的 start 文案是「开始任务」', emptyKindMemory.events('empty-kind')[0].message === '开始任务')
  check('空 kind 的 progress 只显示「进度 1/2」', emptyKindMemory.events('empty-kind').find((event) => event.kind === 'progress').message === '进度 1/2')

  // ---------------------------------------------------------------- fail
  const failMemory = memoryStore()
  const failLogger = createJobLogger(failMemory)
  const failId = failLogger.start('boom', 'translate')
  failLogger.fail(failId, new Error('模型不可用'))
  const failEvent = failMemory.events('boom').find((event) => event.kind === 'error')
  check(
    'fail 写 error / error / 带原因 / status=failed',
    failEvent &&
      failEvent.level === 'error' &&
      failEvent.kind === 'error' &&
      failEvent.message === '翻译失败：模型不可用' &&
      failEvent.extra.status === 'failed',
    JSON.stringify(failEvent),
  )
  const failCount = failMemory.events('boom').length
  failLogger.finish(failId, 'ok')
  check('fail 之后再 finish 不重复写', failMemory.events('boom').length === failCount)
  check('fail 后 active 不再包含该任务', failLogger.active().length === 0)

  const stringFailMemory = memoryStore()
  const stringFailLogger = createJobLogger(stringFailMemory)
  const stringFailId = stringFailLogger.start('string-fail', 'ocr')
  stringFailLogger.fail(stringFailId, '进程超时')
  check(
    'fail 接受字符串错误',
    stringFailMemory.events('string-fail').some((event) => event.kind === 'error' && event.message === 'OCR失败：进程超时'),
  )

  // ---------------------------------------------------------------- list / clear
  const dbMemory = memoryStore()
  const dbLogger = createJobLogger(dbMemory)
  const dbId = dbLogger.start('c', 'translate')
  dbLogger.log(dbId, 'info', '一条日志')
  const listed = dbLogger.list('c', { limit: 1 })
  check('list 透传 opts 并正常返回', listed.events.length === 1 && listed.lastSeq === 1, JSON.stringify(listed))
  check('list 把 paperId/opts 透传给注入函数', dbMemory.calls.list.at(-1).paperId === 'c' && dbMemory.calls.list.at(-1).opts.limit === 1)
  const cleared = dbLogger.clear('c')
  check('clear 返回删除条数', cleared === 2, String(cleared))
  check('clear 透传 paperId', dbMemory.calls.clear.at(-1) === 'c')
  check('clear 后 list 空', dbLogger.list('c').events.length === 0)

  // ---------------------------------------------------------------- 注入实现坏了
  const brokenCalls = []
  const broken = {
    append() {
      brokenCalls.push('append')
      throw new Error('磁盘已满')
    },
    list() {
      throw new Error('读日志失败')
    },
    clear() {
      throw new Error('清日志失败')
    },
  }
  const warnings = captureWarnings(() => {
    const brokenLogger = createJobLogger(broken)
    let broke = false
    let brokenId = ''
    try {
      brokenId = brokenLogger.start('broken', 'translate')
      check('append 抛错仍返回 jobId 并能在 active 里看到', brokenLogger.active().some((item) => item.jobId === brokenId), brokenId)
      brokenLogger.log(brokenId, 'info', '写不进去')
      brokenLogger.progress(brokenId, { done: 1, total: 2 })
      brokenLogger.finish(brokenId, 'ok')
    } catch {
      broke = true
    }
    check('append 抛错时 start/log/progress/finish 都不抛', !broke && typeof brokenId === 'string', brokenId)
    const emptyList = brokenLogger.list('broken')
    check('list 抛错时返回空结构', emptyList && Array.isArray(emptyList.events) && emptyList.lastSeq === 0, JSON.stringify(emptyList))
    check('clear 抛错时返回 0', brokenLogger.clear('broken') === 0)
  })
  check('存储出错时只 console.warn，不停业务', warnings.length >= 3, `warnings=${warnings.length}`)
  check('write 失败被逐次尝试（没有因第一次失败就停）', brokenCalls.length >= 4, `append 调用 ${brokenCalls.length} 次`)

  const asyncWarnings = await captureWarningsAsync(async () => {
    const asyncBroken = {
      append: () => Promise.reject(new Error('异步写失败')),
      list: () => ({ events: [], lastSeq: 0 }),
      clear: () => 0,
    }
    const asyncLogger = createJobLogger(asyncBroken)
    asyncLogger.start('async', 'translate')
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  check('append 返回 rejected Promise 也不产生未处理异常（只 warn）', asyncWarnings.some((line) => line.includes('异步写失败')), asyncWarnings.join(' | '))

  const missingWarnings = captureWarnings(() => {
    const missingLogger = createJobLogger({})
    const missingId = missingLogger.start('missing', 'doc')
    check('缺依赖时 start 仍可用', /^missing#\d+$/.test(missingId), missingId)
    check('缺依赖时 list 返回空结构', missingLogger.list('missing').events.length === 0)
    check('缺依赖时 clear 返回 0', missingLogger.clear('missing') === 0)
  })
  check('缺依赖时只 warn 不抛', missingWarnings.length >= 3, `warnings=${missingWarnings.length}`)

  // ---------------------------------------------------------------- 纯依赖注入
  const source = await readFile(new URL('../lib/jobs.js', import.meta.url), 'utf8')
  check('jobs.js 不 import lib/db.js（保持纯依赖注入）', !/from\s+['"][^'"]*db\.js['"]/.test(source))
}

await main()
