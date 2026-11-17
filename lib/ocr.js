/**
 * 扫描件 OCR（PaddleOCR 云端任务：提交 → 轮询 → 取 jsonl → 拼 Markdown）。
 *
 * 为什么这样实现：
 *   - 只用 Node 内置的 fetch / FormData / Blob / fs，不引依赖：AI Studio 的接口就是
 *     标准 multipart 与 REST，套一层 SDK 只会多一个要跟版本的东西。
 *   - 纯函数与网络分开：parseJsonl / pagesToMarkdown 只吃字符串与数组，自测脚本能直接
 *     喂固定 fixture；网络函数只负责拼请求、轮询与中文错误包装。
 *   - 结果只能从 jsonUrl 取（对象存储直链，**不带** Authorization），所以「提交/轮询的
 *     鉴权」和「取结果」是两条独立路径，出错提示也分开写。
 *   - 轮询按「总超时 + 间隔」而不是固定次数：任务耗时取决于页数，固定次数会在长文档上
 *     误判失败。但 sleepImpl 可注入（测试里瞬时返回），此时真实时间几乎不走、光靠
 *     elapsed 判不出超时，因此另设一个由总超时推算的轮询次数上限兜底，保证任何实现下
 *     都能终止。
 *   - token 是密钥：所有错误消息在带出服务端正文/原始错误前都过一遍脱敏，
 *     保证消息里永远不出现 token 子串。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** 建任务 / 查任务共用的基础地址（末尾不带斜杠，轮询时再拼 /<jobId>）。 */
export const DEFAULT_JOB_URL = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs'
/** PaddleOCR-VL 出 Markdown 版面（最适合阅读/翻译）；PP-StructureV3 同型；PP-OCRv6 只有文字。 */
export const OCR_MODELS = ['PaddleOCR-VL-1.6', 'PP-StructureV3', 'PP-OCRv6']
export const DEFAULT_MODEL = 'PaddleOCR-VL-1.6'

const DEFAULT_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 1800000
/** 单次请求（上传 / 轮询 / 取结果）的兜底超时，避免一个挂起的连接把整体超时架空。 */
const DEFAULT_REQUEST_TIMEOUT = 300000
/** 错误消息里允许带出的服务端正文字符数。 */
const BODY_EXCERPT = 200
/** AI Studio 文档写的是小写 bearer；鉴权方案名大小写不敏感，照抄即可。 */
const AUTH_SCHEME = 'bearer'
/** 取结果（jsonl）的响应体上限：正常几百页也就几十 MB，256MB 足够，超过多半是错误页/攻击。 */
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024 * 1024
/** 取消时统一抛这句话，调用方按子串判断，避免各家 fetch 的 AbortError 文案不一致。 */
const CANCEL_MESSAGE = 'OCR 任务已取消'

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/** 统一构造取消错误（每次新建，保留栈），外部可按 message 里是否含 CANCEL_MESSAGE 识别。 */
function cancelError() {
  return new Error(CANCEL_MESSAGE)
}

function isCancelError(error) {
  return Boolean(error && error.message && String(error.message).includes(CANCEL_MESSAGE))
}

/** 已取消就立刻抛：轮询循环每轮开头、请求前都要检查，别等下一次网络调用才发现。 */
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw cancelError()
}

/**
 * 合并「单次请求超时」信号与「外部取消」信号：任意一个触发都会中止 fetch。
 * AbortSignal.any 从 Node 20.3 起可用；本机 Node 24 走它，老环境退化到手写合流。
 */
function combineSignals(timeoutSignal, externalSignal) {
  if (!externalSignal) return timeoutSignal
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSignal, externalSignal])
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (timeoutSignal.aborted || externalSignal.aborted) {
    controller.abort()
  } else {
    timeoutSignal.addEventListener('abort', onAbort, { once: true })
    externalSignal.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

/** 把数字参数收敛到 [min, max]；非法值回落到 fallback。 */
function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * 截断并脱敏服务端正文：鉴权失败时接口会回显 key，落进错误消息前必须替换成 ***。
 * 顺带把换行压成空格，错误消息里不该出现多行正文。
 */
function excerpt(text, token) {
  const raw = String(text === undefined || text === null ? '' : text)
  const safe = token ? raw.split(token).join('***') : raw
  return safe.replace(/\s+/g, ' ').trim().slice(0, BODY_EXCERPT)
}

/** 原始错误（网络栈/第三方实现）也可能带上 token，统一再脱敏一次。 */
function redact(message, token) {
  const raw = String(message)
  return token ? raw.split(token).join('***') : raw
}

/**
 * 给单次请求套一个超时信号。
 * 用 AbortController + unref 的定时器而不是 AbortSignal.timeout：定时器不压住事件循环，
 * 自测脚本里注入的 fetchImpl 忽略 signal 时进程也能正常退出。
 */
function withTimeout(ms) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ms)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => clearTimeout(timer),
  }
}

/** 假 fetchImpl（测试/宿主注入）可能只给 status，ok 缺失时按状态码判断。 */
function isOk(res) {
  if (res && typeof res.ok === 'boolean') return res.ok
  const status = Number(res && res.status)
  return Number.isFinite(status) && status >= 200 && status < 300
}

function statusOf(res) {
  const status = Number(res && res.status)
  return Number.isFinite(status) ? status : 0
}

/** 空 token 立刻失败：给用户看的是「没配置」，而不是绕一圈回一个 401。 */
function requireToken(token) {
  const value = typeof token === 'string' ? token.trim() : ''
  if (value === '') throw new Error('未配置 PaddleOCR 的 API Key')
  return value
}

function resolveModel(model) {
  const value = typeof model === 'string' && model.trim() !== '' ? model.trim() : DEFAULT_MODEL
  if (!OCR_MODELS.includes(value)) {
    throw new Error('OCR 提交失败：不支持的模型 ' + value + '（可选：' + OCR_MODELS.join(' / ') + '）')
  }
  return value
}

function resolveJobUrl(jobUrl) {
  const value = typeof jobUrl === 'string' && jobUrl.trim() !== '' ? jobUrl.trim() : DEFAULT_JOB_URL
  return value.replace(/\/+$/, '')
}

function requestTimeout(value) {
  return clampInt(value, DEFAULT_REQUEST_TIMEOUT, 1000, 3600000)
}

/**
 * optionalPayload 统一发 JSON **字符串**：multipart 模式下它只能是字符串，URL 模式沿用
 * 同一字段名，服务端大概率也是同一段解析逻辑，发对象反而可能被判非法。
 */
function normalizePayload(optionalPayload) {
  if (optionalPayload === undefined || optionalPayload === null || optionalPayload === '') return '{}'
  if (typeof optionalPayload === 'string') return optionalPayload
  return JSON.stringify(optionalPayload)
}

/** 只保留「字符串 → 非空地址」的键，脏数据（null、嵌套对象）不进结果。 */
function stringMap(value) {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry !== '') out[key] = entry
  }
  return out
}

/** prunedResult.rec_texts 是字符串数组；容忍非数组与混入的非字符串。 */
function recTexts(item) {
  const pruned = item && item.prunedResult
  const list = pruned && Array.isArray(pruned.rec_texts) ? pruned.rec_texts : []
  return list
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .join('\n')
}

/**
 * 粗粒度去 Markdown：只为了给 `text` 一个不含标记的纯文本视图（统计字数、搜索用），
 * 渲染仍然用 markdown 原文。宁可漏掉少量标记，也不做完整解析 —— 论文正文里的下划线、
 * 星号（如 `P_value`、`x*y`）比标题符号常见得多，过度清洗会改坏内容。
 */
function markdownToText(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?/, '').replace(/```[\s]*$/, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** 一页版面结果（PaddleOCR-VL / PP-StructureV3）：Markdown 正文 + 两张图片地址表。 */
function layoutPage(n, layout) {
  const item = layout && typeof layout === 'object' ? layout : {}
  const block = item.markdown && typeof item.markdown === 'object' ? item.markdown : {}
  const markdown = typeof block.text === 'string' ? block.text.trim() : ''
  return {
    n,
    markdown,
    // 有 Markdown 时由它生成纯文本视图；没有就退回 rec_texts（VL 一般没有该字段）。
    text: markdown === '' ? recTexts(item) : markdownToText(markdown),
    images: stringMap(block.images),
    outputImages: stringMap(item.outputImages),
  }
}

/** 一页 PP-OCRv6 结果：没有 Markdown，只有整页图与（可能的）逐行文字。 */
function ocrPage(n, ocr) {
  const item = ocr && typeof ocr === 'object' ? ocr : {}
  const outputImages = stringMap(item.outputImages)
  // 把 ocrImage 并进 outputImages：前端可以用同一条取图路径，不必再判别模型。
  if (typeof item.ocrImage === 'string' && item.ocrImage !== '') outputImages.ocrImage = item.ocrImage
  return { n, markdown: '', text: recTexts(item), images: {}, outputImages }
}

/**
 * 本地 PDF 走 multipart。
 * 不手动设 Content-Type：boundary 由 fetch 按 FormData 自己生成，手写必然对不上。
 */
async function formRequest(filePath, model, optionalPayload) {
  let bytes
  try {
    bytes = await fsp.readFile(filePath)
  } catch (error) {
    throw new Error('OCR 提交失败：读取 PDF 失败（' + messageOf(error) + '）')
  }
  if (bytes.length === 0) throw new Error('OCR 提交失败：PDF 文件是空的')
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), path.basename(filePath))
  form.append('model', model)
  form.append('optionalPayload', optionalPayload)
  return { headers: {}, body: form }
}

/** 线上文件走 JSON；只接受 http(s)，免得 draft 掉 file:// 之类地址还要等服务端报错。 */
function jsonRequest(fileUrl, model, optionalPayload) {
  let target
  try {
    target = new URL(fileUrl)
  } catch {
    throw new Error('OCR 提交失败：fileUrl 不是合法的链接')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('OCR 提交失败：fileUrl 只支持 http(s) 链接')
  }
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileUrl: target.toString(), model, optionalPayload }),
  }
}

/**
 * 把一个 PDF 提交成 OCR 任务，返回 { jobId }。
 * filePath 与 fileUrl 二选一：前者 multipart 上传本地文件，后者让服务端去拉线上地址。
 * 失败一律 throw 中文 Error，消息里不会出现 token。
 */
export async function submitJob(opts = {}) {
  const token = requireToken(opts.token)
  const jobUrl = resolveJobUrl(opts.jobUrl)
  const model = resolveModel(opts.model)
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch
  const filePath = typeof opts.filePath === 'string' ? opts.filePath.trim() : ''
  const fileUrl = typeof opts.fileUrl === 'string' ? opts.fileUrl.trim() : ''
  if (filePath !== '' && fileUrl !== '') throw new Error('OCR 提交失败：filePath 与 fileUrl 只能二选一')
  if (filePath === '' && fileUrl === '') throw new Error('OCR 提交失败：需要 filePath 或 fileUrl')
  const payload = normalizePayload(opts.optionalPayload)
  const signal = opts.signal
  throwIfAborted(signal)
  const request =
    filePath === '' ? jsonRequest(fileUrl, model, payload) : await formRequest(filePath, model, payload)
  const timeout = requestTimeout(opts.requestTimeoutMs)

  let res
  const guard = withTimeout(timeout)
  try {
    res = await fetchImpl(jobUrl, {
      method: 'POST',
      headers: { Authorization: AUTH_SCHEME + ' ' + token, ...request.headers },
      body: request.body,
      signal: combineSignals(guard.signal, signal),
    })
  } catch (error) {
    if (signal && signal.aborted) throw cancelError()
    if (guard.timedOut()) throw new Error('OCR 提交失败：请求超时（' + timeout + 'ms）')
    throw new Error('OCR 提交失败：网络错误（' + redact(messageOf(error), token) + '）')
  } finally {
    guard.done()
  }

  let text
  try {
    text = await res.text()
  } catch (error) {
    throw new Error('OCR 提交失败：读取响应失败（' + redact(messageOf(error), token) + '）')
  }
  if (!isOk(res)) {
    throw new Error('OCR 提交失败：HTTP ' + statusOf(res) + '（' + excerpt(text, token) + '）')
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('OCR 提交失败：响应不是合法 JSON（' + excerpt(text, token) + '）')
  }
  const jobId = body && body.data ? body.data.jobId : undefined
  if (typeof jobId !== 'string' || jobId.trim() === '') {
    throw new Error('OCR 提交失败：响应里缺少 data.jobId，无法轮询（' + excerpt(text, token) + '）')
  }
  return { jobId: jobId.trim() }
}

/**
 * 默认 sleep：除了按时醒来，还要能被取消 —— 外部 abort 时立刻 reject 并清掉定时器，
 * 不能让用户点了「取消」还要等满一个轮询间隔。
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(cancelError())
      return
    }
    let onAbort = null
    const timer = setTimeout(() => {
      // 正常醒来时摘掉 abort 监听，避免长轮询里成百上千次 sleep 把监听器堆在同一个 signal 上。
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) {
      onAbort = () => {
        clearTimeout(timer)
        reject(cancelError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * 可中断的 sleep：注入的 sleepImpl（测试用瞬时返回）也要能被取消，所以统一用 Promise.race
 * 把「睡眠完成」和「abort」赛跑，输的一方直接丢弃、不产生未处理拒绝。
 */
async function cancellableSleep(ms, sleepImpl, signal) {
  throwIfAborted(signal)
  const work = Promise.resolve(sleepImpl(ms, signal))
  if (!signal) {
    await work
    return
  }
  let onAbort = null
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(cancelError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([work, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** 轮询错误统一带 jobId 上下文：多任务并发时才知道是哪一条失败（但绝不带 token）。 */
function pollError(jobId, detail) {
  return new Error('OCR 轮询失败（job ' + jobId + '）：' + detail)
}

/** 一次状态查询：带鉴权 + 单次请求超时 + 外部取消，错误统一转中文并脱敏。 */
async function requestStatus({ url, token, fetchImpl, timeout, signal, jobId }) {
  throwIfAborted(signal)
  const guard = withTimeout(timeout)
  let res
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: AUTH_SCHEME + ' ' + token, Accept: 'application/json' },
      signal: combineSignals(guard.signal, signal),
    })
  } catch (error) {
    if (signal && signal.aborted) throw cancelError()
    if (guard.timedOut()) throw pollError(jobId, '请求超时（' + timeout + 'ms）')
    throw pollError(jobId, '网络错误（' + redact(messageOf(error), token) + '）')
  } finally {
    guard.done()
  }

  let text
  try {
    text = await res.text()
  } catch (error) {
    if (signal && signal.aborted) throw cancelError()
    throw pollError(jobId, '读取响应失败（' + redact(messageOf(error), token) + '）')
  }
  if (!isOk(res)) {
    throw pollError(jobId, 'HTTP ' + statusOf(res) + '（' + excerpt(text, token) + '）')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw pollError(jobId, '响应不是合法 JSON（' + excerpt(text, token) + '）')
  }
}

/**
 * 轮询任务直到 done/failed，返回 { state:'done', jsonUrl, extractProgress, polls }。
 * onProgress 每次轮询都调一次（done 那次也算），给前端画进度用；totalPages 会沿用
 * 上一次已知值 —— done 的 extractProgress 里通常没有 totalPages，否则进度条会突然回退。
 */
export async function pollJob(opts = {}) {
  const token = requireToken(opts.token)
  const jobId = typeof opts.jobId === 'string' ? opts.jobId.trim() : ''
  if (jobId === '') throw new Error('OCR 轮询失败：缺少 jobId')
  const statusUrl = resolveJobUrl(opts.jobUrl) + '/' + encodeURIComponent(jobId)
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch
  const sleep = typeof opts.sleepImpl === 'function' ? opts.sleepImpl : defaultSleep
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const signal = opts.signal
  const interval = clampInt(opts.intervalMs, DEFAULT_INTERVAL_MS, 200, 600000)
  const timeout = clampInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 24 * 3600 * 1000)
  const requestMs = requestTimeout(opts.requestTimeoutMs)
  const maxPolls = Math.ceil(timeout / interval) + 5
  const startedAt = Date.now()
  let polls = 0
  let totalPages = null

  for (;;) {
    // 每轮开头先看取消：用户点取消后连一次多余的网络请求都不该发。
    throwIfAborted(signal)
    const elapsedMs = Date.now() - startedAt
    if (polls > 0 && elapsedMs >= timeout) {
      throw new Error('OCR 轮询超时（job ' + jobId + '，' + timeout + 'ms，已轮询 ' + polls + ' 次）')
    }
    if (polls >= maxPolls) {
      throw new Error('OCR 轮询超时（job ' + jobId + '，' + timeout + 'ms 内轮询次数已达上限 ' + maxPolls + ' 次）')
    }
    polls += 1
    const body = await requestStatus({ url: statusUrl, token, fetchImpl, timeout: requestMs, signal, jobId })
    const data = body && body.data && typeof body.data === 'object' ? body.data : {}
    const state = typeof data.state === 'string' ? data.state.trim() : ''
    const progress = data.extractProgress && typeof data.extractProgress === 'object' ? data.extractProgress : null
    if (progress && Number.isFinite(Number(progress.totalPages))) totalPages = Number(progress.totalPages)
    const extracted = progress && Number.isFinite(Number(progress.extractedPages)) ? Number(progress.extractedPages) : null
    if (onProgress) onProgress({ state, jobId, totalPages, extractedPages: extracted, elapsedMs: Date.now() - startedAt })

    if (state === 'done') {
      const jsonUrl = data.resultUrl ? data.resultUrl.jsonUrl : undefined
      if (typeof jsonUrl !== 'string' || jsonUrl.trim() === '') {
        throw new Error('OCR 任务已完成（job ' + jobId + '），但响应里缺少 resultUrl.jsonUrl')
      }
      return { state: 'done', jsonUrl: jsonUrl.trim(), extractProgress: progress, polls }
    }
    if (state === 'failed') {
      const reason = data.errorMsg === undefined || data.errorMsg === null ? '' : String(data.errorMsg).trim()
      throw new Error('OCR 任务失败（job ' + jobId + '）：' + (reason === '' ? '服务端未给出原因' : redact(reason, token)))
    }
    if (state === '') throw pollError(jobId, '响应里缺少 data.state')
    if (state !== 'pending' && state !== 'running') {
      throw pollError(jobId, '未知的任务状态 "' + redact(state, token) + '"，已轮询 ' + polls + ' 次')
    }
    await cancellableSleep(interval, sleep, signal)
  }
}

/**
 * 解析 jsonl 文本为页数组。纯函数，不联网。
 *
 * 空行跳过；单行 JSON 坏掉只计入 skipped，不整体失败 —— 一次任务里几百页挤在一个
 * jsonl 里，个别行被截断不该让整本书报废。
 * 页号按「行 × 行内结果」的先后连续递增，保证 pagesToMarkdown 的 `## p.N` 与页面对得上。
 */
export function parseJsonl(text) {
  const pages = []
  let skipped = 0
  for (const line of String(text === undefined || text === null ? '' : text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      skipped += 1
      // 坏行也要占一个页码：直接 continue 会让后面所有页的 `## p.N` 前移一位
      pages.push({ n: pages.length + 1, markdown: '', text: '', images: {}, outputImages: {} })
      continue
    }
    const result = row && typeof row === 'object' && !Array.isArray(row) ? row.result : null
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      skipped += 1
      pages.push({ n: pages.length + 1, markdown: '', text: '', images: {}, outputImages: {} })
      continue
    }
    const layouts = Array.isArray(result.layoutParsingResults) ? result.layoutParsingResults : []
    const ocrs = Array.isArray(result.ocrResults) ? result.ocrResults : []
    // 两种结果互斥（VL/Structure 出 Markdown，PP-OCRv6 只出文字），优先版面结果；
    // 只有它为空时才走 ocrResults，否则同一页会被算两遍、页码整体错位。
    if (layouts.length > 0) {
      for (const layout of layouts) pages.push(layoutPage(pages.length + 1, layout))
    } else if (ocrs.length > 0) {
      for (const ocr of ocrs) pages.push(ocrPage(pages.length + 1, ocr))
    } else {
      // 既没有版面也没有文字：仍然占一个页码，否则后面页的编号会错位。
      pages.push({ n: pages.length + 1, markdown: '', text: '', images: {}, outputImages: {} })
    }
  }
  return { pages, skipped }
}

/** 下载 jsonl 并解析，返回 { pages, skipped }。jsonUrl 来自轮询结果，缺了就没法取。 */
export async function fetchResults(opts = {}) {
  const jsonUrl = typeof opts.jsonUrl === 'string' ? opts.jsonUrl.trim() : ''
  const signal = opts.signal
  const jobId = typeof opts.jobId === 'string' ? opts.jobId.trim() : ''
  // 错误里带 jobId 便于定位是哪条任务取的数；没有 jobId 时保持原前缀，兼容老调用。
  const label = jobId === '' ? '获取 OCR 结果失败' : '获取 OCR 结果失败（job ' + jobId + '）'
  if (jsonUrl === '') throw new Error(label + '：缺少 jsonUrl')
  let target
  try {
    target = new URL(jsonUrl)
  } catch {
    throw new Error(label + '：jsonUrl 不是合法的链接')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(label + '：jsonUrl 只支持 http(s) 链接')
  }
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch
  const timeout = requestTimeout(opts.requestTimeoutMs)
  const maxBytes = clampInt(opts.maxResultBytes, DEFAULT_MAX_RESULT_BYTES, 1024, 1024 * 1024 * 1024)

  throwIfAborted(signal)
  // 对象存储直链，不能带 Authorization：带了反而会被 S3 类服务当成签名冲突拒掉。
  const guard = withTimeout(timeout)
  let res
  try {
    res = await fetchImpl(target.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain;q=0.9, */*' },
      signal: combineSignals(guard.signal, signal),
    })
  } catch (error) {
    if (signal && signal.aborted) throw cancelError()
    if (guard.timedOut()) throw new Error(label + '：请求超时（' + timeout + 'ms）')
    throw new Error(label + '：网络错误（' + messageOf(error) + '）')
  } finally {
    guard.done()
  }

  // 结果体上限：Content-Length 先挡一道；真 fetch 有 body 时按流累计字节，
  // 超限立即 cancel reader，不能先 arrayBuffer()/text() 把整份错误页读进内存再检查。
  let text
  try {
    const headerLength = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN
    if (Number.isFinite(headerLength) && headerLength > maxBytes) {
      throw new Error(label + '：结果体超过上限（' + maxBytes + ' 字节）')
    }
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      const chunks = []
      let total = 0
      try {
        for (;;) {
          const step = await reader.read()
          if (step.done) break
          const chunk = Buffer.from(step.value)
          total += chunk.length
          if (total > maxBytes) {
            await reader.cancel().catch(() => {})
            throw new Error(label + '：结果体超过上限（' + maxBytes + ' 字节）')
          }
          chunks.push(chunk)
        }
      } finally {
        if (typeof reader.releaseLock === 'function') reader.releaseLock()
      }
      text = Buffer.concat(chunks).toString('utf8')
    } else if (typeof res.arrayBuffer === 'function') {
      const buffer = await res.arrayBuffer()
      if (buffer.byteLength > maxBytes) throw new Error(label + '：结果体超过上限（' + maxBytes + ' 字节）')
      text = Buffer.from(buffer).toString('utf8')
    } else {
      text = await res.text()
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(label + '：结果体超过上限（' + maxBytes + ' 字节）')
    }
  } catch (error) {
    if (isCancelError(error)) throw error
    if (error && String(error.message || '').includes('结果体超过上限')) throw error
    if (signal && signal.aborted) throw cancelError()
    throw new Error(label + '：读取响应失败（' + messageOf(error) + '）')
  }
  if (!isOk(res)) {
    throw new Error(label + '：HTTP ' + statusOf(res) + '（' + excerpt(text, '') + '）')
  }
  const parsed = parseJsonl(text)
  if (parsed.pages.length === 0) {
    // 200 也可能是一张 HTML 错误页：返回空 pages 会让调用方 writeOcr('') 覆盖上一次的结果
    throw new Error(label + '：返回内容里没有可解析的页（' + excerpt(text, '') + '）')
  }
  if (parsed.skipped === parsed.pages.length) {
    throw new Error(label + '：' + parsed.skipped + ' 行结果全部无法解析（' +
      excerpt(text, '') + '）')
  }
  // withRaw：版面解析要自己读 block 级字段，不能只拿拼好的 markdown（默认行为不变）。
  return opts.withRaw === true
    ? { pages: parsed.pages, skipped: parsed.skipped, text }
    : { pages: parsed.pages, skipped: parsed.skipped }
}

/**
 * 把页数组拼成 ocr 文档：每页一段，段首 `## p.<n>`，段间空行分隔
 * （与翻译产出的 zh.md 里 `## p.N` 约定一致，前端可以复用同一套分页渲染）。
 * 空页也占号：页码必须和 PDF 物理页一一对应，缺号会让读者以为丢页。
 */
export function pagesToMarkdown(pages) {
  const list = Array.isArray(pages) ? pages : []
  const blocks = []
  let pagesWithText = 0
  for (let i = 0; i < list.length; i += 1) {
    const page = list[i] && typeof list[i] === 'object' ? list[i] : {}
    const n = Number.isFinite(Number(page.n)) ? Number(page.n) : i + 1
    const markdown = typeof page.markdown === 'string' ? page.markdown.trim() : ''
    const text = typeof page.text === 'string' ? page.text.trim() : ''
    const body = markdown !== '' ? markdown : text
    if (body !== '') pagesWithText += 1
    blocks.push(body === '' ? '## p.' + n : '## p.' + n + '\n\n' + body)
  }
  return { markdown: blocks.join('\n\n'), pagesWithText }
}

/**
 * 一步到位：submit + poll + fetch + parse。
 * 返回 { jobId, model, pages, markdown, pagesWithText, elapsedMs }。
 */
export async function runOcr(opts = {}) {
  const startedAt = Date.now()
  const model = resolveModel(opts.model)
  const { jobId } = await submitJob({ ...opts, model })
  const polled = await pollJob({ ...opts, jobId })
  const { pages } = await fetchResults({ jsonUrl: polled.jsonUrl, fetchImpl: opts.fetchImpl, signal: opts.signal, jobId })
  const { markdown, pagesWithText } = pagesToMarkdown(pages)
  return { jobId, model, pages, markdown, pagesWithText, elapsedMs: Date.now() - startedAt }
}
