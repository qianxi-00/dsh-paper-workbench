/**
 * 原生 DSH 会话桥：一篇论文（或一个「多篇论文的对话」）固定一个 sessionId，用宿主的
 * sessionController 建会话、发消息、订阅回复流；帧怎么序列化（SSE）由 server 层决定，这里不做。
 *
 * 为什么这样实现：
 *   - 只做「拼参数 + 转发 + 宽容归一化」：宿主服务的形状由 DSH 决定，桥里判断越少，
 *     换宿主版本时坏得越少；所以 follow 原样 yield frame，不缓存、不改写。
 *   - ensure 带缓存与并发去重：打开一篇论文可能同时触发 ask 和 follow，重复 create
 *     会撞「会话已存在」；另外宿主可能在桥启动前就建过同名会话，所以「已存在」类错误
 *     一律按复用处理 —— 但其它错误必须原样上抛，不能把真实故障吞成「已复用」。
 *   - normalizeFrame 整体包在 try/catch 里：帧来自宿主，形状未知，属性读取甚至可能是
 *     会抛错的 getter；任何异常都不该打断一条 SSE 流。识别不出就返回
 *     {kind:'other', raw}，原文仍能透传给前端。
 *   - dataRoot 只当 cwd 兜底：调用方给了 cwd 就用调用方的，没给才退到工作台数据根。
 *   - 会话 id 可以由调用方覆盖（`options.sessionId`）：多篇论文的对话有自己的 id，
 *     不能按单篇论文推导。
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { sessionIdForConversation } from './conv.js'

export { sessionIdForConversation }

const SESSION_PREFIX = 'pb-'
const MAX_SESSION_ID = 64
const DEFAULT_MAX_MESSAGES = 200
const MAX_MESSAGES_LIMIT = 10000
const MAX_TEXT_DEPTH = 6

/**
 * 论文工作台的会话统一挂在一个「论文」工作区下，而不是按每篇 PDF 所在目录各建一个。
 * 工作区在 DSH 侧栏里按目录分组，目录名就是默认标题；所以目录本身也叫「论文」，
 * 这样即使宿主不认显式标题，侧栏显示的也是「论文」。
 */
const WORKSPACE_TITLE = '论文'
const WORKSPACE_DIR = '论文'

const UNAVAILABLE_MESSAGE = '原生会话不可用（这个宿主没有 sessionController）'
const MISSING_CREATE = '原生会话不可用（宿主没有 sessionController.create）'
const MISSING_PROMPT = '原生会话不可用（宿主没有 sessionController.prompt）'
const MISSING_FOLLOW = '原生会话不可用（宿主没有 sessionController.follow）'

/**
 * 宿主内部会直接 `signal.throwIfAborted()`，传 undefined 就是
 * `Cannot read properties of undefined (reading 'throwIfAborted')`。
 * 所以调用方没给信号时，也要传一个真的、永不 abort 的 AbortSignal。
 */
const NEVER_ABORTED = new AbortController().signal

/** 帧名（kind/type/event/...）里表示「一条完整消息」的词。 */
const RE_MESSAGE = /(^|[-_.:])(message|msg|assistant|user|reply|answer|chat|utterance|turn|text|content)$/i
/** 帧名里表示「增量」的词；比 message 先判断，assistant-delta 才不会被当成消息。 */
const RE_DELTA = /(^|[-_.:])(delta|chunk|token|partial|increment|stream)$/i
/** 帧名里表示「结束」的词。 */
// 注意 end(?:ed)? / finish(?:ed)? / stop(?:ped)? 的写法：写成 ended? 只能匹配 end 或 ende。
const RE_DONE = /(^|[-_.:])(done|end(?:ed)?|finish(?:ed)?|complete(?:d)?|close[ds]?|stop(?:ped)?|abort(?:ed)?|cancel+ed?)$/i
/** 帧名里表示「出错」的词：错误帧原样透传，别当成助手文本。 */
const RE_FAILURE = /(^|[-_.:])(error|failed?|failure|exception)$/i
/** 帧名里带 user 时，没给 role 的文本按用户消息归类。 */
const RE_USER = /(^|[-_.:])users?($|[-_.:])/i

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/** 把数字参数收敛到 [min, max]；非法值回落到 fallback。 */
function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 宿主服务可能没注入，getServices 本身也可能抛；两种都当成「没有」。 */
function readServices(getServices) {
  try {
    const value = typeof getServices === 'function' ? getServices() : null
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * 「已存在」类错误：宿主在桥启动前建过同一个会话时 create 会失败，这不是故障。
 * 只认明确的信号（code / name / 文案），不能宽到把「目录不存在」也当成已存在。
 */
function isAlreadyExists(error) {
  if (!error) return false
  const code = String(error.code || '').toUpperCase()
  if (['EEXIST', 'EALREADY', 'EXISTS', 'ALREADY_EXISTS', 'DUPLICATE'].includes(code)) return true
  if (/alreadyexists|existserror/i.test(String(error.name || ''))) return true
  return /already (exists|existed|created|registered|present)|已存在|已经存在|已被创建|重复创建|duplicate/i.test(
    messageOf(error),
  )
}

/**
 * 论文 id → 稳定的会话 id。
 * 宿主对 sessionId 的字符集有要求，所以只留 [a-zA-Z0-9._-]，其余连续字符压成一个 -，
 * 并去掉首尾的 -（避免 `/abc` 变成 `pb--abc`）；总长不超过 64，超出部分截断并再去尾。
 * paperId 为空或全是非法字符时退成 `pb-paper`：宁可共用一个「无主」会话，也不产出空壳 id。
 */
export function sessionIdFor(paperId) {
  const raw = paperId === undefined || paperId === null ? '' : String(paperId)
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (cleaned === '') return SESSION_PREFIX + 'paper'
  const room = MAX_SESSION_ID - SESSION_PREFIX.length
  const body = cleaned.length > room ? cleaned.slice(0, room).replace(/-+$/, '') : cleaned
  return SESSION_PREFIX + (body === '' ? 'paper' : body)
}

/**
 * 调用方给了 sessionId 就用它（多篇论文的对话有自己的会话 id），否则按单篇论文推导。
 * 这是「一个对话一个会话」和「一篇论文一个会话」两种用法的分界点。
 */
function resolveSessionId(paperId, options = {}) {
  const given = options && options.sessionId !== undefined && options.sessionId !== null
    ? String(options.sessionId).trim()
    : ''
  return given !== '' ? given : sessionIdFor(paperId)
}

/**
 * 把任意宿主帧归一化成 {kind, role?, text?, at?, raw}。
 * 纯函数、绝不抛错：null / 字符串 / 数组 / 数字 / 会抛错的 getter 都有兜底。
 */
export function normalizeFrame(frame) {
  try {
    return classifyFrame(frame)
  } catch {
    return { kind: 'other', raw: frame }
  }
}

function classifyFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return { kind: 'other', raw: frame }

  const node = pickNode(frame)
  const name = nameOf(frame) || nameOf(node)
  const role = roleOf(node) || roleOf(frame)
  const text = textOf(node) || textOf(frame) || ''

  // 结束优先：finish/done 帧通常没有 role 也没有正文。
  if (isDone(frame, name)) return descriptor(frame, { kind: 'done' })
  if (isFailure(frame, name)) return { kind: 'other', raw: frame }
  // 增量的文字可能为空（心跳/占位），只要是增量帧就照实报 kind。
  if (isDelta(frame, node, name)) return descriptor(frame, { kind: 'delta', text })
  if (text !== '') {
    // 有 role 或帧名明确是消息 → 消息；帧名完全缺失（裸 content）时也按消息兜底，
    // 因为 follow({assistantStream:true}) 里没有标记的文本最可能就是助手正文。
    if (role !== '' || isMessageName(name) || name === '') {
      return descriptor(frame, { kind: 'message', role: role || defaultRole(name), text })
    }
  }
  return { kind: 'other', raw: frame }
}

function descriptor(frame, fields) {
  const at = atOf(frame)
  const out = { ...fields }
  if (at !== undefined) out.at = at
  out.raw = frame
  return out
}

/** 真正的载荷可能在 message / msg / data(.message) / payload / frame / body 里。 */
function pickNode(frame) {
  const candidates = [
    frame.message,
    frame.msg,
    frame.data && typeof frame.data === 'object' ? frame.data.message : undefined,
    frame.data,
    frame.payload,
    frame.frame,
    frame.body,
  ]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate
  }
  return frame
}

/** 帧名：kind / type / event 优先，status / state / phase 兜后。 */
function nameOf(value) {
  if (!value || typeof value !== 'object') return ''
  for (const key of ['kind', 'type', 'event', 'name', 'status', 'state', 'phase']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/** 说话人：role / speaker / from / sender / author（含对象形式与 message.role）。 */
function roleOf(value) {
  if (!value || typeof value !== 'object') return ''
  const candidates = [value.role, value.speaker, value.from, value.sender, value.author, value.message && value.message.role]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (candidate && typeof candidate === 'object') {
      const nested = candidate.role || candidate.kind
      if (typeof nested === 'string' && nested.trim() !== '') return nested.trim()
    }
  }
  return ''
}

/**
 * 从任意节点里挖正文：字符串直接用；数组按段落拼（多段之间用换行，避免单词粘连）；
 * 对象依次看 text/delta、content/parts/blocks，再看 text/message/data/payload/value。
 * 深度上限防止宿主塞来循环引用；拿不到文本一律返回空串。
 */
function textOf(value, depth = 0) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || depth > MAX_TEXT_DEPTH) return ''
  if (Array.isArray(value)) {
    const parts = []
    for (const item of value) {
      const text = textOf(item, depth + 1)
      if (text !== '') parts.push(text)
    }
    return parts.join('\n')
  }
  if (typeof value.text === 'string' && value.text !== '') return value.text
  if (typeof value.delta === 'string' && value.delta !== '') return value.delta
  for (const key of ['content', 'parts', 'blocks', 'text', 'delta', 'message', 'data', 'payload', 'value']) {
    if (value[key] === undefined) continue
    const text = textOf(value[key], depth + 1)
    if (text !== '') return text
  }
  return ''
}

/** 时间戳：只认明确的字段，认出什么类型返回什么类型（数字或时间字符串）。 */
function atOf(frame) {
  for (const key of ['at', 'ts', 'time', 'timestamp', 'createdAt']) {
    const value = frame[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function isDone(frame, name) {
  if (frame.done === true || frame.finished === true || frame.complete === true || frame.completed === true) return true
  // 有些结束帧是带 finish 对象的（例如 {kind:'finish', reason:{kind:'stop'}} 之外的写法）。
  if (frame.finish !== undefined && frame.finish !== null && frame.finish !== false) return true
  return name !== '' && RE_DONE.test(name)
}

function isFailure(frame, name) {
  if (frame.error !== undefined && frame.error !== null && frame.error !== false && frame.error !== '') return true
  if (frame.exception !== undefined && frame.exception !== null) return true
  return name !== '' && RE_FAILURE.test(name)
}

function isDelta(frame, node, name) {
  return hasDelta(frame) || hasDelta(node) || (name !== '' && RE_DELTA.test(name))
}

function hasDelta(value) {
  if (!value || typeof value !== 'object') return false
  const delta = value.delta
  return typeof delta === 'string' || (delta !== null && typeof delta === 'object')
}

function isMessageName(name) {
  return name !== '' && RE_MESSAGE.test(name)
}

function defaultRole(name) {
  return name !== '' && RE_USER.test(name) ? 'user' : 'assistant'
}

/** 宿主给什么就 yield 什么：不缓存、不改写、不在这里做 SSE 序列化。 */
async function* relay(controller, request, signal) {
  for await (const frame of controller.follow(request, signal)) yield frame
}

/** 工作区结果容错：{workspace:{workspaceId}} / {workspace:{id}} / 裸 id 都认。 */
function workspaceIdOf(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  const candidates = [value && value.workspace, value && value.data && value.data.workspace, value]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const id = candidate.workspaceId || candidate.id
    if (typeof id === 'string' && id.trim() !== '') return id.trim()
  }
  return null
}

/**
 * 创建会话桥。runtime 由 lead 注入 `{getServices, dataRoot}`：
 * getServices 在宿主里返回 ctx（取 sessionController / workspaceController），测试里给假实现。
 */
export function createSessionBridge({ getServices, dataRoot, workspacePath, workspaceTitle } = {}) {
  /** 已确认建好的会话；缓存让 ask/follow 不重复 create。 */
  const ready = new Set()
  /** 进行中的 create，按 sessionId 去重，避免并发请求撞「已存在」。 */
  const inflight = new Map()
  /** 「论文」工作区只解析一次：成功失败都缓存，别每开一个对话就重试一遍建目录。 */
  let workspaceTask = null
  const title = typeof workspaceTitle === 'string' && workspaceTitle.trim() !== ''
    ? workspaceTitle.trim()
    : WORKSPACE_TITLE
  const dir = typeof workspacePath === 'string' && workspacePath.trim() !== ''
    ? workspacePath.trim()
    : (typeof dataRoot === 'string' && dataRoot.trim() !== ''
      ? path.join(dataRoot.trim(), WORKSPACE_DIR)
      : null)

  function currentServices() {
    return readServices(getServices)
  }

  function requireController() {
    const controller = currentServices().sessionController
    if (!controller) throw new Error(UNAVAILABLE_MESSAGE)
    return controller
  }

  function available() {
    return Boolean(currentServices().sessionController)
  }

  /** cwd 兜底顺序：调用方给的 → 工作台数据根 → null（让宿主用自己的默认目录）。 */
  function resolveCwd(cwd) {
    if (typeof cwd === 'string' && cwd.trim() !== '') return cwd.trim()
    if (typeof dataRoot === 'string' && dataRoot.trim() !== '') return dataRoot.trim()
    return null
  }

  /**
   * 「论文」工作区：{id, path} 或 null。
   * 为什么不是每篇 PDF 一个工作区：DSH 侧栏按会话头里的 cwd 分组，PDF 分散在
   * 各个专题目录时会建出一堆「模型」「加速训练」工作区；这里统一落到一个目录。
   */
  function ensureWorkspace() {
    if (workspaceTask === null) workspaceTask = resolveWorkspace()
    return workspaceTask
  }

  async function resolveWorkspace() {
    if (dir === null) return null
    const services = currentServices()
    const registry = services.workspaceRegistry
    const controller = services.workspaceController
    // 宿主只接受已存在的目录；已存在时 mkdir 是 no-op。
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch {
      return null
    }
    // 1) 已经有同名工作区就直接用（用户可能自己建过「论文」）。
    if (registry && typeof registry.list === 'function') {
      try {
        const found = registry.list().find((item) => item && item.title === title)
        if (found && found.id) return { id: found.id, path: found.path || dir }
      } catch {
        /* 列不出来就继续往下建 */
      }
    }
    // 2) 按目录注册；同一目录重复调用原样返回旧实体（不会改标题），所以再补一次标题。
    if (registry && typeof registry.create === 'function') {
      try {
        const workspace = await registry.create(dir, title)
        if (workspace && workspace.id) {
          if (workspace.title !== title && typeof workspace.setTitle === 'function') {
            await Promise.resolve(workspace.setTitle(title)).catch(() => {})
          }
          return { id: workspace.id, path: workspace.path || dir }
        }
      } catch {
        /* 退回下面的 Remote 版 */
      }
    }
    // 3) 老宿主只有 workspaceController：按目录建，标题由目录名决定（目录也叫「论文」）。
    if (controller && typeof controller.create === 'function') {
      try {
        const id = workspaceIdOf(await controller.create({ path: dir }))
        if (id !== null) return { id, path: dir }
      } catch {
        /* 工作区不可用：退回只带 cwd 的会话，别把「工作区」误报成致命错误 */
      }
    }
    return null
  }

  async function createSession(controller, sessionId, cwd) {
    const workspace = await ensureWorkspace()
    if (workspace !== null) {
      // 只给 workspaceId：宿主的 create 不接受 workspaceId 与 cwd 同时出现
      // （"session.create accepts workspaceId or cwd, not both"），会话的 cwd 由工作区决定。
      await createOrReuse(controller, { sessionId, workspaceId: workspace.id })
      return
    }
    await createOrReuse(controller, cwd === null ? { sessionId } : { sessionId, cwd })
  }

  async function createOrReuse(controller, args) {
    try {
      await controller.create(args)
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }
  }

  /** 建/复用这篇论文的会话，返回 {sessionId}；并发调用只真正 create 一次。 */
  async function ensure(paperId, options = {}) {
    const controller = requireController()
    if (typeof controller.create !== 'function') throw new Error(MISSING_CREATE)
    const sessionId = resolveSessionId(paperId, options)
    if (ready.has(sessionId)) return { sessionId }
    const running = inflight.get(sessionId)
    if (running) return running
    const task = createSession(controller, sessionId, resolveCwd(options.cwd)).then(() => {
      ready.add(sessionId)
      return { sessionId }
    })
    inflight.set(sessionId, task)
    try {
      return await task
    } finally {
      inflight.delete(sessionId)
    }
  }

  /** 先 ensure 再 prompt；signal 原样作为第二个参数透传。 */
  async function ask(paperId, text, options = {}) {
    const controller = requireController()
    if (typeof controller.prompt !== 'function') throw new Error(MISSING_PROMPT)
    const content = text === undefined || text === null ? '' : String(text)
    if (content.trim() === '') throw new Error('请输入要发送的内容')
    const { sessionId } = await ensure(paperId, { cwd: options.cwd, sessionId: options.sessionId })
    const requestId = SESSION_PREFIX + randomUUID()
    await controller.prompt({ sessionId, content: [{ type: 'text', text: content }], requestId }, options.signal || NEVER_ABORTED)
    return { sessionId, requestId }
  }

  /**
   * 订阅回复流，返回 async iterable。
   * 服务缺失时同步抛错（调用点就能报出来）；真正的 follow 在第一次迭代时才发起，
   * 避免请求被中断后仍占着宿主一条流。
   */
  function follow(paperId, options = {}) {
    const controller = requireController()
    if (typeof controller.follow !== 'function') throw new Error(MISSING_FOLLOW)
    const sessionId = resolveSessionId(paperId, options)
    const maxMessages = clampInt(options.maxMessages, DEFAULT_MAX_MESSAGES, 1, MAX_MESSAGES_LIMIT)
    return relay(
      controller,
      { address: { kind: 'session', sessionId }, maxMessages, assistantStream: true },
      options.signal || NEVER_ABORTED,
    )
  }

  return { available, ensure, ask, follow, normalizeFrame }
}
