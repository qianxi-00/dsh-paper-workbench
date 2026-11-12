/**
 * 任务日志：把翻译、OCR、文档解析等长任务的生命周期写成可读事件。
 *
 * 为什么依赖注入：真正落库的是 lib/db.js（SQLite，必要时退化成 JSON），这里只认
 * append/list/clear 三个函数。模块不 import db，测试拿内存假实现就能跑；宿主在
 * db 还没接好时也能先把它传进来。
 *
 * 为什么所有入口都包 try/catch：日志是旁路能力，日志自己坏了不能把翻译/解析任务
 * 一起拖垮。任何存储异常都只 console.warn 一行，调用方照常继续。
 */

const KIND_LABELS = { translate: '翻译', ocr: 'OCR', doc: '解析', review: '自检', figures: '配图' }
const KIND_UNITS = { translate: '段', ocr: '页', doc: '页', review: '段', figures: '张' }
const LEVELS = new Set(['info', 'warn', 'error'])
const MAX_MESSAGE = 500
const MAX_JOBS = 800

/**
 * 建一个任务日志器。
 * @param {{append?:Function, list?:Function, clear?:Function}} deps
 *   append(paperId, event) → seq；list(paperId, opts) → {events,lastSeq}；clear(paperId) → 删除条数
 */
export function createJobLogger(deps = {}) {
  const dbAppend = dependency(deps, 'append', () => 0)
  const dbList = dependency(deps, 'list', () => ({ events: [], lastSeq: 0 }))
  const dbClear = dependency(deps, 'clear', () => 0)

  // jobId -> 摘要。只有未结束的才会出现在 active()；结束的留着是为了让 finish/fail 幂等。
  const jobs = new Map()
  // paperId -> 已用过的最大编号。只增不减：clear 日志后也不复用旧 jobId，避免前后记录串号。
  const counters = new Map()

  /** 开始一个任务，返回 `<paperId>#<n>`。 */
  function start(paperId, kind, meta) {
    const owner = paperOf(paperId)
    const jobKind = normalizeKind(kind)
    const n = (counters.get(owner) || 0) + 1
    counters.set(owner, n)
    const jobId = owner + '#' + n
    const label = kindLabel(jobKind)
    const message = '开始' + label
    const job = {
      jobId,
      paperId: owner,
      kind: jobKind,
      startedAt: new Date().toISOString(),
      lastMessage: message,
      done: 0,
      total: 0,
      ended: false,
    }
    jobs.set(jobId, job)
    prune()
    emit(owner, 'info', 'start', message, meta === undefined ? undefined : extraOf(meta))
    return jobId
  }

  /** 记一条普通日志。未知 jobId 不抛：从 id 里解析出 paperId，按 kind:'log' 记过去。 */
  function log(jobId, level, message, extra) {
    const found = lookup(jobId)
    const text = messageText(message)
    const lvl = LEVELS.has(level) ? level : 'info'
    if (found.job) found.job.lastMessage = text
    emit(found.paperId, lvl, 'log', text, extra)
  }

  /**
   * 进度：同时记一条可读 message（如「翻译 12/43 段」）和 extra {done,total}。
   * 两者都要：日志列表只显示 message，后续 UI 若画进度条需要数字。
   */
  function progress(jobId, counts) {
    const found = lookup(jobId)
    const done = countOf(counts && counts.done)
    const total = countOf(counts && counts.total)
    const job = found.job
    const label = job ? KIND_LABELS[job.kind] || job.kind : ''
    const unit = job ? KIND_UNITS[job.kind] || '' : ''
    const message = (label ? label + ' ' : '进度 ') + done + '/' + total + (unit ? ' ' + unit : '')
    if (job) {
      job.done = done
      job.total = total
      job.lastMessage = message
    }
    emit(found.paperId, 'info', 'progress', message, { done, total })
  }

  /** 结束任务。同一 job 只记一次；未知 jobId 也建一个影子任务，保证重复 finish 不重复写。 */
  function finish(jobId, status, extra) {
    const found = lookup(jobId)
    if (found.job && found.job.ended) return
    const state = status === 'failed' || status === 'cancelled' ? status : 'ok'
    const job = found.job || shadow(found, jobId)
    const level = state === 'failed' ? 'error' : state === 'cancelled' ? 'warn' : 'info'
    const message = kindLabel(job.kind) + (state === 'failed' ? '失败' : state === 'cancelled' ? '已取消' : '完成')
    job.ended = true
    job.lastMessage = message
    const payload =
      extra && typeof extra === 'object' && !Array.isArray(extra) ? { ...extra, status: state } : { status: state }
    emit(found.paperId, level, 'end', message, payload)
  }

  /** 失败收尾：kind:'error'，message 带上原因；同样只记一次。 */
  function fail(jobId, error) {
    const found = lookup(jobId)
    if (found.job && found.job.ended) return
    const job = found.job || shadow(found, jobId)
    const message = kindLabel(job.kind) + '失败：' + errorText(error)
    job.ended = true
    job.lastMessage = message
    emit(found.paperId, 'error', 'error', message, { status: 'failed' })
  }

  /** 读某篇论文的日志；存储读失败返回空结构，不让界面跟着崩。 */
  function list(paperId, opts) {
    try {
      return dbList(paperOf(paperId), opts)
    } catch (error) {
      warn('读日志失败：' + errorText(error))
      return { events: [], lastSeq: 0 }
    }
  }

  /** 清空某篇论文的日志；存储失败返回 0。 */
  function clear(paperId) {
    try {
      return dbClear(paperOf(paperId))
    } catch (error) {
      warn('清日志失败：' + errorText(error))
      return 0
    }
  }

  /** 正在跑的任务摘要。只读快照，外部改它不会影响内部状态。 */
  function active() {
    return [...jobs.values()]
      .filter((job) => !job.ended)
      .map((job) => ({
        jobId: job.jobId,
        paperId: job.paperId,
        kind: job.kind,
        startedAt: job.startedAt,
        lastMessage: job.lastMessage,
      }))
  }

  function lookup(jobId) {
    const raw = jobId === undefined || jobId === null ? '' : String(jobId)
    const known = jobs.get(raw)
    if (known) return { jobId: raw, paperId: known.paperId, job: known }
    return { jobId: raw, paperId: paperIdFromJobId(raw), job: undefined }
  }

  /** 给未知 jobId 的 finish/fail 建一个已存在的影子记录，第二次调用就能被 ended 挡住。 */
  function shadow(found, jobId) {
    const stub = {
      jobId: found.jobId || jobId,
      paperId: found.paperId,
      kind: '',
      startedAt: new Date().toISOString(),
      lastMessage: '',
      done: 0,
      total: 0,
      ended: false,
    }
    jobs.set(stub.jobId, stub)
    prune()
    return stub
  }

  function emit(paperId, level, kind, message, extra) {
    const event = { level, kind, message: clipText(message) }
    if (extra !== undefined && extra !== null) event.extra = extra
    try {
      const result = dbAppend(paperId, event)
      // 目前 db 是同步的；万一以后换成异步实现，也别把 rejection 变成未处理异常。
      if (result && typeof result.catch === 'function') {
        result.catch((error) => warn('写日志失败：' + errorText(error)))
      }
    } catch (error) {
      warn('写日志失败：' + errorText(error))
    }
  }

  /** 已结束的记录只是为幂等保留，数量大了清掉一半，避免常驻进程内存无限涨。 */
  function prune() {
    if (jobs.size <= MAX_JOBS) return
    for (const [key, job] of jobs) {
      if (jobs.size <= Math.floor(MAX_JOBS / 2)) break
      if (job.ended) jobs.delete(key)
    }
    while (jobs.size > MAX_JOBS) {
      const oldest = jobs.keys().next().value
      jobs.delete(oldest)
    }
  }

  return { start, log, progress, finish, fail, list, clear, active }
}

// ------------------------------------------------------------------ 内部工具

function dependency(deps, name, fallback) {
  const fn = deps && deps[name]
  if (typeof fn === 'function') return fn
  warn('缺少 ' + name + ' 依赖，任务日志不会落盘')
  return fallback
}

function paperOf(paperId) {
  const text = paperId === undefined || paperId === null ? '' : String(paperId).trim()
  return text || 'unknown'
}

function normalizeKind(kind) {
  const text = kind === undefined || kind === null ? '' : String(kind).trim().toLowerCase()
  return text
}

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || '任务'
}

/**
 * 从未知 jobId 里解析 paperId。jobId 形如 `<paperId>#<n>`，用最后一个 #，避免 paperId
 * 自己含 # 时切错；没有 # 就把整个 id 当 paperId。
 */
function paperIdFromJobId(jobId) {
  const text = String(jobId === undefined || jobId === null ? '' : jobId).trim()
  if (!text) return 'unknown'
  const at = text.lastIndexOf('#')
  if (at > 0) {
    const paper = text.slice(0, at).trim()
    if (paper) return paper
  }
  return text
}

function extraOf(meta) {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) return { ...meta }
  return { meta }
}

function countOf(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function messageText(value) {
  if (typeof value === 'string') return clipText(value)
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') {
    try {
      return clipText(JSON.stringify(value))
    } catch {
      return clipText(String(value))
    }
  }
  return clipText(String(value))
}

function errorText(error) {
  if (error && typeof error.message === 'string' && error.message.trim()) return clipText(error.message.trim())
  if (typeof error === 'string' && error.trim()) return clipText(error.trim())
  return '未知错误'
}

function clipText(value) {
  const text = String(value === undefined || value === null ? '' : value)
  return text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) + '…' : text
}

function warn(text) {
  console.warn('[jobs] ' + text)
}
