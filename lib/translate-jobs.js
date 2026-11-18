/**
 * 宿主常驻后台持久化翻译调度器（v8+）。
 *
 * 解决的问题：
 *   1. HTTP SSE 连接与翻译任务彻底解耦：切换标签/论文、关闭阅读器、切换 DSH 会话只
 *      unsubscribe 观察者，绝不中断后台 `ai.translate()`；
 *   2. 单论文最多一个运行中任务，状态同步维护并发度、分批进度、当前章节与错误摘要；
 *   3. 关键状态（启动/暂停/完成/失败）立刻原子落盘 `<paperDir>/translate.job.json`，
 *      高频进度防抖落盘；进程冷重启后自动把遗留 `running` 归一化为 `paused`，
 *      支持随时从断点继续翻译（跳过已写入 DB/trans.json 的段落）。
 */
import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  buildPaperGlossary,
  clampConcurrency,
  DEFAULT_TRANSLATE_CONCURRENCY,
  MAX_TRANSLATE_CONCURRENCY,
} from './ai.js'

export { clampConcurrency, DEFAULT_TRANSLATE_CONCURRENCY, MAX_TRANSLATE_CONCURRENCY }
export const JOB_FILE = 'translate.job.json'
export const RESTART_PAUSED_REASON = '服务重启后等待继续翻译'

const PERSIST_DEBOUNCE_MS = 120
const VALID_SCOPES = new Set(['all', 'section', 'paragraph'])

function nowIso() {
  return new Date().toISOString()
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

function isAbort(error) {
  return Boolean(error && (error.name === 'AbortError' || error.aborted === true))
}

function makeJobId(paperId) {
  return (
    'tj-' +
    String(paperId).slice(0, 24) +
    '-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 7)
  )
}

function createQueue() {
  const items = []
  const waiters = []
  let closed = false

  function push(value) {
    if (closed) return
    if (waiters.length > 0) waiters.shift()({ value, done: false })
    else items.push(value)
  }

  function close() {
    if (closed) return
    closed = true
    while (waiters.length > 0) waiters.shift()({ value: undefined, done: true })
  }

  async function next() {
    if (items.length > 0) return { value: items.shift(), done: false }
    if (closed) return { value: undefined, done: true }
    return new Promise((resolve) => {
      waiters.push(resolve)
    })
  }

  return { push, close, next }
}

/**
 * 创建后台翻译调度器。
 * @param {object} deps
 * @param {object} deps.ai 含 `translate(body, opts)` 的 AI 引擎
 * @param {object} deps.store 存储模块（lib/store.js 或同契约 mock）
 * @param {object} [deps.dbBackendOrDb] 可选数据库模块/句柄
 * @param {object|Function} [deps.jobs] 可选任务日志器（lib/jobs.js）
 * @param {Function} [deps.broadcast] 可选全局状态广播回调
 */
export function createTranslateJobManager({ ai, store, dbBackendOrDb, jobs, broadcast } = {}) {
  const jobsByPaper = new Map()
  const jobsById = new Map()
  const hydratedPapers = new Set()

  function resolvePaperId(raw) {
    const id = String(raw === undefined || raw === null ? '' : raw).trim()
    if (!id) throw new Error('缺少论文 id：无法定位翻译任务')
    if (store && typeof store.assertId === 'function') return store.assertId(id)
    if (/[\\/]|^\.\.?$|\0/.test(id)) throw new Error('非法的论文 id：' + id)
    return id
  }

  function resolvePapersDir() {
    if (store && typeof store.PAPERS_DIR === 'string' && store.PAPERS_DIR) return store.PAPERS_DIR
    if (store && typeof store.paperDir === 'function') {
      try {
        return path.dirname(store.paperDir('probe'))
      } catch {
        return ''
      }
    }
    if (store && typeof store.paperFile === 'function') {
      try {
        return path.dirname(path.dirname(store.paperFile('probe', JOB_FILE)))
      } catch {
        return ''
      }
    }
    return ''
  }

  function jobFilePath(paperId) {
    if (store && typeof store.paperFile === 'function') return store.paperFile(paperId, JOB_FILE)
    if (store && typeof store.paperDir === 'function') return path.join(store.paperDir(paperId), JOB_FILE)
    const dir = resolvePapersDir()
    if (!dir) throw new Error('缺少 store：无法确定翻译任务状态文件路径')
    return path.join(dir, paperId, JOB_FILE)
  }

  async function readJsonFile(file, fallback = null) {
    if (store && typeof store.readJson === 'function') {
      return store.readJson(file, fallback)
    }
    try {
      const text = await fsp.readFile(file, 'utf8')
      return JSON.parse(text)
    } catch (error) {
      if (error && error.code === 'ENOENT') return fallback
      return fallback
    }
  }

  async function writeJsonFileAtomic(file, value) {
    if (store && typeof store.writeJsonAtomic === 'function') {
      await store.writeJsonAtomic(file, value)
      return
    }
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp =
      file +
      '.tmp-' +
      process.pid +
      '-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 8)
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    await fsp.rename(tmp, file)
  }

  async function safeJobLog(fn) {
    try {
      const logger = typeof jobs === 'function' ? await jobs() : jobs
      if (!logger) return null
      return fn(logger)
    } catch {
      return null
    }
  }

  function notifyBroadcast(event, job, data) {
    if (typeof broadcast !== 'function') return
    try {
      broadcast({
        type: 'translate-job',
        event,
        jobId: job.id,
        paperId: job.paperId,
        job: snapshotOf(job),
        data,
      })
    } catch {
      /* 广播回调失败绝不拖垮后台翻译任务 */
    }
  }

  function emit(job, event, data) {
    const frame = { event, data }
    for (const listener of [...job.listeners]) {
      try {
        listener(frame)
      } catch {
        /* 单个订阅者异常不影响任务与其它订阅者 */
      }
    }
    notifyBroadcast(event, job, data)
  }

  function snapshotOf(job) {
    if (!job) return null
    const snap = {
      id: job.id,
      paperId: job.paperId,
      scope: job.scope,
      ...(job.sectionId ? { sectionId: job.sectionId } : {}),
      ...(job.sectionIds ? { sectionIds: job.sectionIds.slice() } : {}),
      ...(job.keys ? { keys: job.keys.slice() } : {}),
      ...(job.titles ? { titles: true } : {}),
      target: job.target,
      model: job.model,
      status: job.status,
      concurrency: job.concurrency,
      completed: job.completed,
      total: job.total,
      already: job.already,
      pending: job.pending,
      failed: job.failed,
      skipped: job.skipped,
      completedChunks: job.completedChunks,
      totalChunks: job.totalChunks,
      currentSectionId: job.currentSectionId,
      currentSectionTitle: job.currentSectionTitle,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
    }
    if (job.error) snap.error = job.error
    return snap
  }

  function serializedPayloadOf(job, patch = null) {
    const payload = snapshotOf(job)
    if (patch) {
      if (patch.status !== undefined) payload.status = patch.status
      if (patch.updatedAt !== undefined) payload.updatedAt = patch.updatedAt
      if (patch.error) payload.error = patch.error
      else if (patch.error === '') delete payload.error
    }
    if (job.requestedModel !== undefined && job.requestedModel !== null) {
      payload.requestedModel = job.requestedModel
    }
    if (job.retranslate) payload.retranslate = true
    return payload
  }

  function enqueuePersist(job, patch = null) {
    const payload = serializedPayloadOf(job, patch)
    const file = jobFilePath(job.paperId)
    const run = job._persistChain.then(() => writeJsonFileAtomic(file, payload))
    job._persistChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function schedulePersist(job) {
    if (job._persistTimer) return
    job._persistTimer = setTimeout(() => {
      job._persistTimer = null
      enqueuePersist(job).catch(() => {})
    }, PERSIST_DEBOUNCE_MS)
    if (typeof job._persistTimer.unref === 'function') job._persistTimer.unref()
  }

  async function flushPersist(job, patch = null) {
    if (job._persistTimer) {
      clearTimeout(job._persistTimer)
      job._persistTimer = null
    }
    try {
      await enqueuePersist(job, patch)
    } catch (error) {
      console.error('[paper-workbench] 保存翻译任务断点失败：' + messageOf(error))
    }
  }

  function createJobRecord(raw) {
    const now = nowIso()
    const sectionIds = Array.isArray(raw.sectionIds) && raw.sectionIds.length ? raw.sectionIds.map(String) : null
    const sectionId = raw.sectionId
      ? String(raw.sectionId)
      : sectionIds
        ? sectionIds.find((id) => id !== '*titles') || null
        : null
    const keys = Array.isArray(raw.keys) && raw.keys.length ? raw.keys.map((k) => String(k).toLowerCase()) : null
    let scope = VALID_SCOPES.has(raw.scope) ? raw.scope : ''
    if (!scope) {
      if (keys) scope = 'paragraph'
      else if (sectionId || sectionIds) scope = 'section'
      else scope = 'all'
    }
    return {
      id: String(raw.id || makeJobId(raw.paperId)),
      paperId: String(raw.paperId),
      scope,
      sectionId,
      sectionIds,
      keys,
      titles: Boolean(raw.titles),
      retranslate: Boolean(raw.retranslate),
      target: String(raw.target || 'zh'),
      model: String(raw.model || ''),
      requestedModel: raw.requestedModel !== undefined ? raw.requestedModel : null,
      status: String(raw.status || 'running'),
      concurrency: clampConcurrency(raw.concurrency),
      completed: Math.max(0, Number(raw.completed) || 0),
      total: Math.max(0, Number(raw.total) || 0),
      already: Math.max(0, Number(raw.already) || 0),
      pending: Math.max(0, Number(raw.pending) || 0),
      failed: Math.max(0, Number(raw.failed) || 0),
      skipped: Math.max(0, Number(raw.skipped) || 0),
      completedChunks: Math.max(0, Number(raw.completedChunks) || 0),
      totalChunks: Math.max(0, Number(raw.totalChunks) || 0),
      currentSectionId: String(raw.currentSectionId || ''),
      currentSectionTitle: String(raw.currentSectionTitle || ''),
      startedAt: String(raw.startedAt || raw.updatedAt || now),
      updatedAt: String(raw.updatedAt || now),
      error: raw.error ? String(raw.error) : '',
      listeners: new Set(),
      _translatedEntries: new Map(),
      _controller: null,
      _runPromise: null,
      _pauseRequested: false,
      _persistTimer: null,
      _persistChain: Promise.resolve(),
      _logId: null,
    }
  }

  function registerJob(job) {
    jobsByPaper.set(job.paperId, job)
    jobsById.set(job.id, job)
  }

  function normalizeRecoveredRecord(paperId, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const wasRunning = raw.status === 'running'
    const normalizedStatus = wasRunning
      ? 'paused'
      : ['paused', 'done', 'error'].includes(raw.status)
        ? raw.status
        : 'paused'
    const job = createJobRecord({
      ...raw,
      paperId: raw.paperId || paperId,
      status: normalizedStatus,
      updatedAt: wasRunning ? nowIso() : raw.updatedAt || nowIso(),
      error: wasRunning ? RESTART_PAUSED_REASON : raw.error || '',
    })
    return { job, dirty: wasRunning }
  }

  async function loadExistingTranslations(job) {
    if (!job || job.completed <= 0 || job._translatedEntries.size > 0) return
    try {
      let entries = null
      if (store && typeof store.readTrans === 'function') {
        const trans = await store.readTrans(job.paperId)
        entries = trans && trans.entries
      } else if (dbBackendOrDb && typeof dbBackendOrDb.transAll === 'function') {
        const trans = dbBackendOrDb.transAll(job.paperId)
        entries = trans && trans.entries
      }
      if (!entries || typeof entries !== 'object') return
      for (const [key, value] of Object.entries(entries)) {
        const text = typeof value === 'string' ? value : value && typeof value.zh === 'string' ? value.zh : ''
        if (!text) continue
        const model = value && typeof value === 'object' && value.model ? String(value.model) : job.model || ''
        job._translatedEntries.set(String(key).toLowerCase(), {
          key: String(key).toLowerCase(),
          text,
          model,
          cached: true,
        })
      }
    } catch {
      /* 读取历史译文摘要失败不影响恢复继续翻译 */
    }
  }

  // 同步快扫真实磁盘上的断点文件，确保刚创建 manager 就能在内存中看到冷重启前的任务
  const pendingPersistOnBoot = []
  const papersDir = resolvePapersDir()
  if (papersDir && fs.existsSync(papersDir)) {
    try {
      const entries = fs.readdirSync(papersDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const paperId = entry.name
        const file = path.join(papersDir, paperId, JOB_FILE)
        if (!fs.existsSync(file)) continue
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
          const recovered = normalizeRecoveredRecord(paperId, raw)
          if (!recovered) continue
          hydratedPapers.add(paperId)
          if (!jobsByPaper.has(paperId)) {
            registerJob(recovered.job)
            if (recovered.dirty) pendingPersistOnBoot.push(recovered.job)
          }
        } catch {
          /* 损坏的单篇断点文件忽略，避免阻塞整个调度器启动 */
        }
      }
    } catch {
      /* 忽略目录不可读 */
    }
  }

  let hydrated = false
  let hydrating = null

  async function ensureHydrated() {
    if (hydrated) return
    if (hydrating) return hydrating
    hydrating = (async () => {
      try {
        for (const job of pendingPersistOnBoot) {
          await flushPersist(job)
        }
        pendingPersistOnBoot.length = 0

        for (const job of jobsByPaper.values()) {
          if (job.completed > 0 && job._translatedEntries.size === 0) {
            await loadExistingTranslations(job)
          }
        }

        // 兼容虚拟/自定义 store（只实现 listPapers + readJson，不直接放物理目录）
        if (store && typeof store.listPapers === 'function') {
          const papers = await store.listPapers().catch(() => [])
          for (const meta of Array.isArray(papers) ? papers : []) {
            const paperId = meta && meta.id ? String(meta.id) : ''
            if (!paperId || hydratedPapers.has(paperId) || jobsByPaper.has(paperId)) continue
            hydratedPapers.add(paperId)
            const raw = await readJsonFile(jobFilePath(paperId), null)
            const recovered = normalizeRecoveredRecord(paperId, raw)
            if (!recovered) continue
            registerJob(recovered.job)
            if (recovered.dirty) await flushPersist(recovered.job)
            if (recovered.job.completed > 0) await loadExistingTranslations(recovered.job)
          }
        }
        hydrated = true
      } finally {
        hydrating = null
      }
    })()
    return hydrating
  }

  // 构造时尽早把冷重启状态写回磁盘（测试即使只调用 new Manager 后直接读文件也能看到 paused）
  if (pendingPersistOnBoot.length > 0) {
    void ensureHydrated()
  }

  async function lookupJobAsync(idOrPaper) {
    await ensureHydrated()
    const key = String(idOrPaper === undefined || idOrPaper === null ? '' : idOrPaper).trim()
    if (!key) return null
    const existing = jobsById.get(key) || jobsByPaper.get(key)
    if (existing) return existing
    try {
      const safe = resolvePaperId(key)
      if (!hydratedPapers.has(safe)) {
        hydratedPapers.add(safe)
        const raw = await readJsonFile(jobFilePath(safe), null)
        const recovered = normalizeRecoveredRecord(safe, raw)
        if (recovered) {
          registerJob(recovered.job)
          if (recovered.dirty) await flushPersist(recovered.job)
          return recovered.job
        }
      }
    } catch {
      /* 不是合法 paperId 时按未找到处理 */
    }
    return null
  }

  function buildTranslateBody(job, overrideRetranslate = false) {
    const body = {
      id: job.paperId,
      target: job.target || 'zh',
      concurrency: job.concurrency,
    }
    if (overrideRetranslate) body.retranslate = true
    if (job.titles) body.titles = true
    if (job.keys && job.keys.length > 0) body.keys = job.keys.slice()
    else if (job.sectionIds && job.sectionIds.length > 0) body.sectionIds = job.sectionIds.slice()
    else if (job.scope === 'section' && job.sectionId) body.sectionIds = [job.sectionId]
    if (job.requestedModel) body.model = job.requestedModel
    else if (job.model) body.model = job.model
    return body
  }

  function launchJobLoop(job, translateBody) {
    const controller = job._controller || new AbortController()
    job._controller = controller
    job._pauseRequested = false

    const run = (async () => {
      const logId = await safeJobLog((logger) =>
        logger.start(job.paperId, 'translate', {
          scope: job.scope,
          sectionId: job.sectionId || '',
          concurrency: job.concurrency,
          jobId: job.id,
        }),
      )
      job._logId = logId

      let endData = null
      let lastStreamError = ''
      let fatalStreamError = false

      const finalizeTerminal = async ({ status, error, logFn, event, extra }) => {
        const updatedAt = nowIso()
        await flushPersist(job, { status, error, updatedAt })
        await safeJobLog(logFn)
        job.status = status
        job.error = error
        job.updatedAt = updatedAt
        emit(job, event, { ...snapshotOf(job), ...extra })
      }

      try {
        if (job._pauseRequested || controller.signal.aborted) {
          const err = new Error('已暂停')
          err.name = 'AbortError'
          throw err
        }
        let runBody = translateBody
        if (!runBody.glossary && store) {
          const [doc, meta, trans] = await Promise.all([
            typeof store.readDoc === 'function' ? store.readDoc(job.paperId).catch(() => null) : null,
            typeof store.getMeta === 'function' ? store.getMeta(job.paperId).catch(() => null) : null,
            typeof store.readTrans === 'function' ? store.readTrans(job.paperId).catch(() => null) : null,
          ])
          if (doc || meta) {
            const glossary = buildPaperGlossary({ doc, meta, trans })
            if (glossary && (glossary.glossaryBlock || glossary.title)) {
              runBody = { ...runBody, glossary }
            }
          }
        }
        if (job._pauseRequested || controller.signal.aborted) {
          const err = new Error('已暂停')
          err.name = 'AbortError'
          throw err
        }
        const iterable = ai.translate(runBody, {
          signal: controller.signal,
          emitProgress: true,
        })
        for await (const frame of iterable) {
          if (!frame || !frame.event) continue
          const data = frame.data && typeof frame.data === 'object' ? frame.data : {}

          if (frame.event === 'start') {
            if (!data.key || data.kind === 'start') {
              if (Number.isFinite(Number(data.total))) job.total = Number(data.total)
              if (Number.isFinite(Number(data.already))) job.already = Number(data.already)
              if (Number.isFinite(Number(data.pending))) job.pending = Number(data.pending)
              if (Number.isFinite(Number(data.already))) job.completed = Math.max(job.completed, Number(data.already))
              if (Number.isFinite(Number(data.concurrency))) job.concurrency = clampConcurrency(data.concurrency)
              if (Number.isFinite(Number(data.totalChunks))) job.totalChunks = Number(data.totalChunks)
              if (Number.isFinite(Number(data.completedChunks))) job.completedChunks = Number(data.completedChunks)
              if (data.model) job.model = String(data.model)
              if (data.sectionId !== undefined) job.currentSectionId = String(data.sectionId || '')
              if (data.sectionTitle !== undefined) job.currentSectionTitle = String(data.sectionTitle || '')
              job.updatedAt = nowIso()
              schedulePersist(job)
              emit(job, 'progress', snapshotOf(job))
            } else if (data.sectionId !== undefined || data.sectionTitle !== undefined) {
              if (data.sectionId !== undefined) job.currentSectionId = String(data.sectionId || '')
              if (data.sectionTitle !== undefined) job.currentSectionTitle = String(data.sectionTitle || '')
            }
          } else if (frame.event === 'done') {
            const key = data.key ? String(data.key).toLowerCase() : ''
            if (key) {
              job._translatedEntries.set(key, {
                key,
                text: String(data.text || ''),
                model: String(data.model || job.model || ''),
                cached: Boolean(data.cached),
              })
              job.completed = Math.max(job.completed, job._translatedEntries.size)
              if (job.total < job.completed) job.total = job.completed
              if (data.model && !job.model) job.model = String(data.model)
              job.updatedAt = nowIso()
              schedulePersist(job)
              emit(job, 'chunk', {
                key,
                text: String(data.text || ''),
                model: String(data.model || job.model || ''),
                cached: Boolean(data.cached),
                jobId: job.id,
                paperId: job.paperId,
              })
            }
          } else if (frame.event === 'skipped') {
            const key = data.key ? String(data.key).toLowerCase() : ''
            job.skipped += 1
            job.updatedAt = nowIso()
            schedulePersist(job)
            emit(job, 'chunk', {
              key,
              skipped: true,
              reason: String(data.reason || ''),
              jobId: job.id,
              paperId: job.paperId,
            })
          } else if (frame.event === 'progress') {
            if (Number.isFinite(Number(data.concurrency))) job.concurrency = clampConcurrency(data.concurrency)
            if (Number.isFinite(Number(data.completedChunks))) job.completedChunks = Number(data.completedChunks)
            if (Number.isFinite(Number(data.totalChunks))) job.totalChunks = Number(data.totalChunks)
            if (Number.isFinite(Number(data.done))) job.completed = Math.max(job.completed, Number(data.done))
            if (Number.isFinite(Number(data.total))) job.total = Number(data.total)
            if (Number.isFinite(Number(data.already))) job.already = Number(data.already)
            if (Number.isFinite(Number(data.pending))) job.pending = Number(data.pending)
            if (Number.isFinite(Number(data.failed))) job.failed = Number(data.failed)
            if (Number.isFinite(Number(data.skipped))) job.skipped = Number(data.skipped)
            if (data.sectionId !== undefined) job.currentSectionId = String(data.sectionId || '')
            if (data.sectionTitle !== undefined) job.currentSectionTitle = String(data.sectionTitle || '')
            job.updatedAt = nowIso()
            schedulePersist(job)
            await safeJobLog((logger) => logger.progress(logId, { done: job.completed, total: job.total }))
            emit(job, 'progress', snapshotOf(job))
          } else if (frame.event === 'error') {
            if (data.key) {
              job.failed += 1
              job.updatedAt = nowIso()
              emit(job, 'error', {
                key: String(data.key).toLowerCase(),
                message: String(data.message || '翻译失败'),
                jobId: job.id,
                paperId: job.paperId,
              })
            } else {
              fatalStreamError = true
              lastStreamError = String(data.message || '翻译失败')
            }
          } else if (frame.event === 'end') {
            endData = data
          }
        }

        if (job._pauseRequested || controller.signal.aborted || (endData && endData.aborted)) {
          await finalizeTerminal({
            status: 'paused',
            error: '',
            logFn: (logger) =>
              logger.finish(logId, 'cancelled', { done: job.completed, failed: job.failed, paused: true }),
            event: 'paused',
            extra: { aborted: true, reason: '已暂停' },
          })
          return
        }

        const failedCount = Number(endData && endData.failed !== undefined ? endData.failed : job.failed) || 0
        job.failed = failedCount
        if ((endData && endData.ok === false) || fatalStreamError || failedCount > 0) {
          const errMessage = lastStreamError || '有 ' + failedCount + ' 段翻译失败，可点击继续翻译重试'
          await finalizeTerminal({
            status: 'error',
            error: errMessage,
            logFn: (logger) => logger.fail(logId, errMessage),
            event: 'error',
            extra: { message: errMessage, fatal: true, ok: false, done: job.completed, failed: failedCount },
          })
          return
        }

        if (endData && Number.isFinite(Number(endData.done))) {
          job.completed = Math.max(job.completed, Number(endData.done))
        }
        if (endData && Number.isFinite(Number(endData.completedChunks))) {
          job.completedChunks = Number(endData.completedChunks)
        }
        if (endData && Number.isFinite(Number(endData.totalChunks))) {
          job.totalChunks = Number(endData.totalChunks)
        }
        if (endData && endData.model) job.model = String(endData.model)
        if (job.total < job.completed) job.total = job.completed
        await finalizeTerminal({
          status: 'done',
          error: '',
          logFn: (logger) => logger.finish(logId, 'ok', { done: job.completed, failed: 0 }),
          event: 'done',
          extra: { ok: true, done: job.completed, failed: 0, skipped: job.skipped },
        })
      } catch (error) {
        if (isAbort(error) || job._pauseRequested || controller.signal.aborted) {
          await finalizeTerminal({
            status: 'paused',
            error: '',
            logFn: (logger) =>
              logger.finish(logId, 'cancelled', { done: job.completed, failed: job.failed, paused: true }),
            event: 'paused',
            extra: { aborted: true, reason: '已暂停' },
          })
          return
        }
        const errMessage = messageOf(error)
        await finalizeTerminal({
          status: 'error',
          error: errMessage,
          logFn: (logger) => logger.fail(logId, error),
          event: 'error',
          extra: { message: errMessage, fatal: true, ok: false },
        })
      } finally {
        if (job._controller === controller) job._controller = null
        if (job._persistTimer) {
          clearTimeout(job._persistTimer)
          job._persistTimer = null
        }
      }
    })()

    job._runPromise = run
    return run
  }

  /**
   * 启动一篇论文的后台翻译任务。
   * 单论文最多一个运行中任务：若该论文已有 `running` 任务，直接返回当前运行态快照。
   */
  async function startJob(params = {}) {
    if (!ai || typeof ai.translate !== 'function') {
      throw new Error('翻译引擎不可用：无法启动后台翻译任务')
    }
    const rawText = typeof params.text === 'string' ? params.text.trim() : ''
    if (rawText) throw new Error('划词翻译不支持启动后台持久化任务')

    const paperId = resolvePaperId(params.paperId !== undefined ? params.paperId : params.id)
    await ensureHydrated()
    await lookupJobAsync(paperId)

    const existing = jobsByPaper.get(paperId)
    if (existing && existing.status === 'running') {
      return snapshotOf(existing)
    }

    const keys = Array.isArray(params.keys) && params.keys.length ? params.keys.map((k) => String(k).toLowerCase()) : null
    const rawSectionIds = Array.isArray(params.sectionIds) && params.sectionIds.length
      ? params.sectionIds.map(String).filter(Boolean)
      : params.sectionId !== undefined && params.sectionId !== null && String(params.sectionId).trim() !== ''
        ? [String(params.sectionId).trim()]
        : null
    let scope = VALID_SCOPES.has(params.scope) ? params.scope : ''
    if (!scope) {
      if (keys) scope = 'paragraph'
      else if (rawSectionIds) scope = 'section'
      else scope = 'all'
    }
    const sectionIds = scope === 'all' && !Array.isArray(params.sectionIds) ? null : rawSectionIds
    const sectionId =
      params.sectionId !== undefined && params.sectionId !== null && String(params.sectionId).trim() !== ''
        ? String(params.sectionId).trim()
        : sectionIds
          ? sectionIds.find((id) => id !== '*titles') || null
          : null

    // 在首个 await 前同步占位，防止并发请求穿透单论文互斥限制
    const now = nowIso()
    const job = createJobRecord({
      id: makeJobId(paperId),
      paperId,
      scope,
      sectionId,
      sectionIds,
      keys,
      titles: Boolean(params.titles) || Boolean(sectionIds && sectionIds.includes('*titles')),
      retranslate: params.retranslate === true,
      target: params.target || 'zh',
      requestedModel: params.model !== undefined ? params.model : null,
      model: typeof params.model === 'string' ? params.model : '',
      status: 'running',
      concurrency:
        params.concurrency !== undefined && params.concurrency !== null
          ? clampConcurrency(params.concurrency, DEFAULT_TRANSLATE_CONCURRENCY)
          : DEFAULT_TRANSLATE_CONCURRENCY,
      startedAt: now,
      updatedAt: now,
    })
    job._controller = new AbortController()
    registerJob(job)
    hydratedPapers.add(paperId)

    let configAi = {}
    if (store && typeof store.getConfig === 'function') {
      const cfg = await store.getConfig().catch(() => null)
      configAi = (cfg && cfg.ai) || {}
    }
    if (params.concurrency === undefined || params.concurrency === null) {
      job.concurrency = clampConcurrency(configAi.concurrency, DEFAULT_TRANSLATE_CONCURRENCY)
    }
    if (!params.target && configAi.target) {
      job.target = String(configAi.target)
    }

    await flushPersist(job)
    const translateBody = buildTranslateBody(job, job.retranslate)
    launchJobLoop(job, translateBody)
    return snapshotOf(job)
  }

  /**
   * 显式暂停后台翻译：触发 controller.abort()，捕获 AbortError 并标为 `paused`（绝非 error）。
   */
  async function pauseJob(paperIdOrJobId) {
    const job = await lookupJobAsync(paperIdOrJobId)
    if (!job) return null
    if (job.status !== 'running') return snapshotOf(job)

    job._pauseRequested = true
    if (job._controller && !job._controller.signal.aborted) {
      job._controller.abort()
    }
    if (job._runPromise) {
      await job._runPromise.catch(() => {})
    }
    return snapshotOf(job)
  }

  /**
   * 从断点继续翻译：复用上次 scope/sectionId/target/model/concurrency，默认跳过已译段落。
   */
  async function resumeJob(paperIdOrJobId, overrideParams = {}) {
    if (!ai || typeof ai.translate !== 'function') {
      throw new Error('翻译引擎不可用：无法继续翻译任务')
    }
    const job = await lookupJobAsync(paperIdOrJobId)
    if (!job) throw new Error('没有可继续的翻译任务：' + String(paperIdOrJobId || ''))
    if (job.status === 'running') return snapshotOf(job)

    const overrides = overrideParams && typeof overrideParams === 'object' ? overrideParams : {}
    if (overrides.scope && VALID_SCOPES.has(overrides.scope)) job.scope = overrides.scope
    if (overrides.sectionId !== undefined) {
      job.sectionId = overrides.sectionId ? String(overrides.sectionId) : null
      if (overrides.sectionIds === undefined) {
        job.sectionIds = job.sectionId ? [job.sectionId] : null
      }
    }
    if (overrides.sectionIds !== undefined) {
      job.sectionIds = Array.isArray(overrides.sectionIds) && overrides.sectionIds.length
        ? overrides.sectionIds.map(String)
        : null
      if (overrides.sectionId === undefined) {
        job.sectionId = job.sectionIds ? job.sectionIds.find((id) => id !== '*titles') || null : null
      }
    }
    if (overrides.keys !== undefined) {
      job.keys = Array.isArray(overrides.keys) && overrides.keys.length
        ? overrides.keys.map((k) => String(k).toLowerCase())
        : null
    }
    if (overrides.titles !== undefined) job.titles = Boolean(overrides.titles)
    if (overrides.target !== undefined && overrides.target) job.target = String(overrides.target)
    if (overrides.model !== undefined) {
      job.requestedModel = overrides.model
      if (typeof overrides.model === 'string') job.model = overrides.model
    }
    if (overrides.concurrency !== undefined && overrides.concurrency !== null) {
      job.concurrency = clampConcurrency(overrides.concurrency)
    }

    const retranslate = overrides.retranslate === true
    job.retranslate = retranslate
    if (retranslate) job.completed = 0
    job.status = 'running'
    job.error = ''
    job.failed = 0
    job.skipped = 0
    job.completedChunks = 0
    job.updatedAt = nowIso()
    job._translatedEntries.clear()
    job._controller = new AbortController()
    job._pauseRequested = false

    await flushPersist(job)
    const translateBody = buildTranslateBody(job, retranslate)
    launchJobLoop(job, translateBody)
    return snapshotOf(job)
  }

  /** 查询单个或全部已知任务状态。 */
  async function status(paperId) {
    if (paperId !== undefined && paperId !== null && String(paperId).trim() !== '') {
      const job = await lookupJobAsync(paperId)
      return snapshotOf(job)
    }
    await ensureHydrated()
    return [...jobsByPaper.values()]
      .map((job) => snapshotOf(job))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  }

  /** 返回所有进行中或已暂停待续传的任务状态摘要。 */
  async function listActive() {
    await ensureHydrated()
    return [...jobsByPaper.values()]
      .filter((job) => job.status === 'running' || job.status === 'paused')
      .map((job) => snapshotOf(job))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  }

  function replayTo(job, listener, isActive) {
    const snap = snapshotOf(job)
    const entries = [...job._translatedEntries.values()]
    try {
      listener({
        event: 'progress',
        data: {
          ...snap,
          replay: true,
          translatedCount: entries.length,
          translatedKeys: entries.map((item) => item.key),
        },
      })
    } catch {
      /* 订阅者异常不影响任务 */
    }
    for (const item of entries) {
      if (!isActive()) return
      try {
        listener({
          event: 'chunk',
          data: {
            ...item,
            jobId: job.id,
            paperId: job.paperId,
            replay: true,
          },
        })
      } catch {
        /* 订阅者异常不影响任务 */
      }
    }
    if (!isActive()) return
    if (job.status === 'done') {
      try {
        listener({
          event: 'done',
          data: { ...snap, ok: true, done: job.completed, failed: 0, skipped: job.skipped, replay: true },
        })
      } catch {
        /* ignore */
      }
    } else if (job.status === 'paused') {
      try {
        listener({
          event: 'paused',
          data: { ...snap, aborted: true, reason: job.error || '已暂停', replay: true },
        })
      } catch {
        /* ignore */
      }
    } else if (job.status === 'error') {
      try {
        listener({
          event: 'error',
          data: { ...snap, message: job.error || '翻译失败', fatal: true, ok: false, replay: true },
        })
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 订阅任务事件流：HTTP 断连时只调用返回的 `unsubscribe()` 退订观察者，
   * 绝不触碰后台任务的 `AbortController`。
   */
  function subscribe(jobIdOrPaperId, listener, { replay = true } = {}) {
    if (typeof listener !== 'function') throw new Error('subscribe 需要回调函数')
    const key = String(jobIdOrPaperId === undefined || jobIdOrPaperId === null ? '' : jobIdOrPaperId).trim()
    let active = true
    let attachedJob = null

    const attach = async (job) => {
      if (!active || !job) return
      attachedJob = job
      if (replay !== false) {
        if (job._translatedEntries.size === 0 && job.completed > 0) {
          await loadExistingTranslations(job)
          if (!active) return
        }
        replayTo(job, listener, () => active)
      }
      if (active) job.listeners.add(listener)
    }

    const syncJob = jobsById.get(key) || jobsByPaper.get(key)
    if (syncJob) {
      if (replay !== false && !(syncJob._translatedEntries.size === 0 && syncJob.completed > 0)) {
        // 绝大多数场景（刚 startJob / 运行中重连）同步重放并立即挂上 listener，零微任务间隙
        attachedJob = syncJob
        replayTo(syncJob, listener, () => active)
        if (active) syncJob.listeners.add(listener)
      } else {
        void attach(syncJob)
      }
    } else {
      void lookupJobAsync(key).then((found) => attach(found))
    }

    return function unsubscribe() {
      if (!active) return
      active = false
      if (attachedJob) attachedJob.listeners.delete(listener)
    }
  }

  /** 将 subscribe 包装为兼容 lib/sse.js `pipeSse` 的 AsyncIterable；外部 signal 断连仅退订。 */
  async function* stream(jobIdOrPaperId, { signal, replay = true } = {}) {
    const queue = createQueue()
    let ended = false
    const unsubscribe = subscribe(
      jobIdOrPaperId,
      (frame) => {
        if (!frame) return
        queue.push(frame)
        if (
          frame.event === 'done' ||
          frame.event === 'paused' ||
          (frame.event === 'error' && frame.data && frame.data.fatal)
        ) {
          ended = true
          queue.close()
        }
      },
      { replay },
    )
    const onAbort = () => {
      unsubscribe()
      queue.close()
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    try {
      for (;;) {
        const step = await queue.next()
        if (step.done) break
        yield step.value
      }
      if (!ended && signal && signal.aborted) return
    } finally {
      unsubscribe()
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }
  }

  return {
    startJob,
    pauseJob,
    resumeJob,
    status,
    listActive,
    subscribe,
    stream,
    ready: ensureHydrated,
  }
}
