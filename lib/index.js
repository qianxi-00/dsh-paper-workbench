/**
 * dsh-paper-workbench 宿主端。
 *
 * 职责：
 *   - 静态页：/paper-workbench/app  —— 工作台 SPA（vanilla JS，无构建）
 *   - 接口：  /paper-workbench/api/* —— 文献库、PDF 取文/渲页、检索、Obsidian 读写
 *   - 工具：  ctx.tools.register(...) —— 供原生会话里的 agent 调用
 *
 * 约定：外置插件不能用 @deepseek-ai/dsh-tools 的 defineTool（profile 里没有该包），
 * 因此工具一律用裸 JSON-Schema 定义注册（同 dsh-git-forge 的做法）。
 * HTTP 细节在 lib/server.js（dev-server 复用同一份处理器）。
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DATA_ROOT,
  CONFIG_FILE,
  PAGES_DIR,
  PAPERS_DIR,
  addPaper,
  attachToConversation,
  clearAnnotations,
  clearStudyNotes,
  clearTrans,
  createConversation,
  deleteAnnotations,
  deleteStudyNotes,
  deleteTransKeys,
  detachFromConversation,
  ensureDirs,
  getConfig,
  getConversation,
  getDbBackend,
  getMeta,
  listConversations,
  listPapers,
  listTrash,
  paperFile,
  purgeTrash,
  readAnnotations,
  readChat,
  readDoc,
  readJson,
  readNotes,
  readOcr,
  readOcrJob,
  readReview,
  readStudyNotes,
  readTextCache,
  readTrans,
  readUiState,
  readZh,
  removeConversation,
  removePaper,
  resolvePdf,
  restoreTrash,
  saveAnnotations,
  saveStudyNote,
  setActiveConversation,
  setConfig,
  updateConversation,
  updateMeta,
  writeChat,
  writeJsonAtomic,
  writeNotes,
  writeOcr,
  writeOcrJob,
  writeReview,
  writeTextCache,
  writeTrans,
  writeUiState,
} from './store.js'
import { buildScopePrompt } from './conv.js'
import { createPaperContext, mergeUiState } from './paper-context.js'
import { cropRegion, extractText as pdfText, findPython, info as pdfInfo, loadText, outline as pdfOutline, pageLines, renderPage, searchText } from './pdf.js'
import { createHandler, json } from './server.js'
import { registerTools } from './tools.js'

export const name = 'dsh-paper-workbench'
export const inject = ['webServer', 'tools', 'connection']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const APP_DIR = path.join(ROOT, 'assets', 'app')
export const PREFIX = '/paper-workbench'

// ---------------------------------------------------------------- 延迟加载的兄弟模块
// 为什么延迟：这两个模块可能还没写完/被用户删掉，静态 import 会让整个插件加载失败，
// 表现是左栏入口直接消失。模块级缓存保证只 import 一次。
// 为什么要带 query：宿主在同一个进程里重新启用插件时，index.js 会重新 import，但
// `import('./session.js')` 会命中 Node 的 ESM 缓存拿到上一次加载的旧代码——改完
// session.js 之类的兄弟模块「重开插件」不生效，只有重启整个桌面端才行。带上每次加载
// 唯一的 tag，重开插件就等于重新读一遍磁盘。
const LOAD_TAG = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const lazyModules = new Map()
async function mod(name) {
  if (!lazyModules.has(name)) {
    lazyModules.set(name, import('./' + name + '.js?load=' + LOAD_TAG))
  }
  try {
    return await lazyModules.get(name)
  } catch (error) {
    lazyModules.delete(name)
    throw new Error('内部模块 ' + name + '.js 不可用：' + (error && error.message ? error.message : String(error)))
  }
}

async function isLayoutApplied(id, layout) {
  try {
    const storeModule = await mod('store')
    const resolved = await storeModule.resolvePdf(id)
    const stat = await fsp.stat(resolved.path)
    const source = layout && layout.source ? layout.source : null
    return Boolean(source &&
      Number(source.size) === Number(stat.size) &&
      Math.round(Number(source.mtimeMs)) === Math.round(stat.mtimeMs))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- v2：宿主 AI 服务句柄
// llm / agentDefaultModel 在 apply 里通过 ctx.inject 拿；拿不到时（headless、没配模型）
// 插件照常提供阅读功能，只是翻译/对话会明确告诉用户缺什么，而不是静默失败。
let aiRuntime = { llm: null, agentDefaultModel: null }

/** 供 apply/dev-server 注入宿主服务；测试里也用它塞假 llm。 */
export function setAiRuntime(next) {
  aiRuntime = {
    llm: (next && next.llm) || null,
    agentDefaultModel: (next && next.agentDefaultModel) || null,
  }
  return aiRuntime
}

export function getAiRuntime() {
  return aiRuntime
}

let aiEngine = null

/** 延迟装配 AI 引擎：ai.js 缺失时只有翻译/对话题不可用，不影响插件加载。 */
async function engine() {
  if (aiEngine === null) {
    const [ai, storeModule] = await Promise.all([mod('ai'), mod('store')])
    aiEngine = ai.createAi({ store: storeModule, getServices: () => aiRuntime })
  }
  return aiEngine
}

// ---------------------------------------------------------------- v3：原生会话 / 任务日志
// 原生会话：把面板里的对话落到真正的 DSH 会话（用户能在主界面继续同一段对话）。
// sessionController/workspaceController 属于 web profile，headless 下缺席，所以是可选注入。
let sessionRuntime = { sessionController: null, workspaceController: null, workspaceRegistry: null }

export function setSessionRuntime(next) {
  sessionRuntime = {
    sessionController: (next && next.sessionController) || null,
    workspaceController: (next && next.workspaceController) || null,
    workspaceRegistry: (next && next.workspaceRegistry) || null,
  }
  sessionBridge = null
  conversationBridges.clear()
  return sessionRuntime
}

export function getSessionRuntime() {
  return sessionRuntime
}

/**
 * 论文工作台的会话都挂到这一个工作区下（默认 `<数据根>/论文`）。
 * 可以在 config.json 的 workspace 段里改标题与目录，改完重开插件生效。
 */
async function workspaceSettings() {
  const config = await getConfig().catch(() => ({}))
  const section = config && typeof config.workspace === 'object' && config.workspace ? config.workspace : {}
  const title = typeof section.title === 'string' && section.title.trim() !== '' ? section.title.trim() : '论文'
  const custom = typeof section.path === 'string' ? section.path.trim() : ''
  return { title, path: custom !== '' ? custom : path.join(DATA_ROOT, '论文') }
}

let sessionBridge = null
const conversationBridges = new Map()
async function bridge(sessionId = '') {
  const cached = sessionId ? conversationBridges.get(sessionId) : sessionBridge
  if (cached) return cached
  const sessionModule = await mod('session')
  const workspace = await workspaceSettings()
  const value = sessionModule.createSessionBridge({
    getServices: () => {
      const services = { ...aiRuntime, ...sessionRuntime }
      const controller = services.sessionController
      if (sessionId && controller) {
        // The legacy bridge derives pb-* ids. Stored conversation ids are authoritative.
        // Bind every Host request at this boundary, including imported history aliases.
        services.sessionController = Object.fromEntries(['create', 'prompt', 'follow'].map(method => [method,
          typeof controller[method] === 'function'
            ? (request, ...rest) => controller[method](method === 'follow'
              ? { ...request, address: { ...request.address, sessionId } }
              : { ...request, sessionId }, ...rest)
            : undefined,
        ]))
      }
      return services
    },
    dataRoot: DATA_ROOT,
    workspacePath: workspace.path,
    workspaceTitle: workspace.title,
  })
  if (sessionId) conversationBridges.set(sessionId, value)
  else sessionBridge = value
  return value
}

/** 上传附件上限：超过这个大小就别往 base64 RPC 里塞了。 */
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024

/**
 * 对话范围里的论文：按库里的记录补标题/页数/真实 PDF 路径。
 * 库里的记录可能指向已经不存在的文件，这里只负责把路径给出去，读不读得到由 agent 决定。
 */
async function papersForConversation(conv) {
  const papers = await listPapers().catch(() => [])
  const byId = new Map(papers.map((item) => [item.id, item]))
  const out = []
  for (const id of conv && Array.isArray(conv.paperIds) ? conv.paperIds : []) {
    const meta = byId.get(id)
    if (!meta) continue
    const pdf = await resolvePdf(id).catch(() => null)
    out.push({
      id,
      title: meta.title || id,
      pages: meta.pageCount || 0,
      path: pdf && pdf.path ? pdf.path : meta.srcPath || '',
    })
  }
  return out
}

const paperContext = createPaperContext({
  getConversation, listConversations, updateConversation,
  buildPrompt: buildScopePrompt,
  loadPaper: async id => {
    const meta = await getMeta(id)
    if (!meta) return null
    const pdf = await resolvePdf(id).catch(() => null)
    return { id, title: meta.title || id, pages: meta.pageCount || 0, path: pdf?.path || meta.srcPath || '', available: Boolean(pdf) }
  },
  loadSources: async id => {
    const [layoutModule, storeModule] = await Promise.all([mod('layout'), mod('store')])
    const [layout, doc, text] = await Promise.all([
      layoutModule.readPublishedLayout(storeModule, id).catch(() => null),
      readDoc(id).catch(() => null),
      readTextCache(id).catch(() => null),
    ])
    // A changed source PDF invalidates cached coordinates without running a parser/OCR.
    const [layoutValid, docValid, textValid] = await Promise.all([
      layout && isLayoutApplied(id, layout),
      doc && isLayoutApplied(id, { source: { size: doc.pdf?.bytes, mtimeMs: doc.pdf?.mtimeMs } }),
      text && isLayoutApplied(id, text),
    ])
    const stale = layout && !layoutValid || !layoutValid && doc && !docValid || !layoutValid && !docValid && text && !textValid
    return { layout: layoutValid ? layout : null, doc: docValid ? doc : null, text: textValid ? text : null, reason: stale ? 'stale-source' : null }
  },
})

export function setPaperContextRuntime(next) {
  return paperContext.setRuntime(next)
}

// Shared by every API instance: serialize the whole UI read/merge/write operation.
globalThis.__pbUiChain ||= Promise.resolve()
function updateUiState(patch) {
  const run = globalThis.__pbUiChain.then(async () => {
    const state = mergeUiState(await readUiState(), patch)
    return { ok: true, state: await writeUiState(state) }
  })
  globalThis.__pbUiChain = run.then(() => undefined, () => undefined)
  return run
}

// 任务日志：经统一数据库后端（默认 SQLite/JSON，可切 PostgreSQL/MySQL），给界面底部「日志」抽屉用。
let jobLogger = null
async function jobs() {
  if (jobLogger === null) {
    const [jobsModule, dbBackend] = await Promise.all([mod('jobs'), getDbBackend()])
    jobLogger = jobsModule.createJobLogger({
      append: (paperId, event) => dbBackend.jobAppend(paperId, event),
      list: (paperId, opts) => dbBackend.jobList(paperId, opts),
      clear: (paperId) => dbBackend.jobClear(paperId),
    })
  }
  return jobLogger
}

/** 宿主常驻后台持久化翻译调度器（与 HTTP 连接解耦，按论文维度维护暂停/断点）。 */
async function getTranslateJobs() {
  const [tjMod, ai, storeModule, dbBackend] = await Promise.all([
    mod('translate-jobs'),
    engine(),
    mod('store'),
    getDbBackend(),
  ])
  const holder = (globalThis.__pbTranslateJobs ||= { manager: null, tag: '', root: '' })
  if (!holder.manager || holder.tag !== LOAD_TAG || holder.root !== DATA_ROOT) {
    holder.manager = tjMod.createTranslateJobManager({
      ai,
      store: storeModule,
      dbBackendOrDb: dbBackend,
      jobs,
    })
    holder.tag = LOAD_TAG
    holder.root = DATA_ROOT
  }
  await holder.manager.ready()
  return holder.manager
}

/** 日志模块自己坏掉不能拖垮业务：包一层，永不抛。 */
async function safeJob(fn) {
  try {
    const logger = await jobs()
    return fn(logger)
  } catch {
    return null
  }
}

/** 只接受 {provider,model} 或 null；空字符串/残缺对象一律当"跟随当前模型"。 */function sanitizeModelChoice(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return null
  const provider = String(value.provider || '').trim()
  const model = String(value.model || '').trim()
  if (!provider || !model) return null
  return { provider, model }
}

/** 旧版本把划词翻译塞进了对话（「把这段原文翻译成中文…」），读历史时过滤掉这些消息。 */
function isLegacyTranslateMessage(message) {
  const content = String((message && message.content) || '')
  return /^\s*把这段原文翻译成中文/.test(content)
}

/** 健康检查用的 AI 概览：只读 provider 目录，不发网络请求。 */
function aiHealth() {
  const { llm, agentDefaultModel } = aiRuntime
  if (!llm) return { ready: false, reason: '宿主还没有提供 llm 服务' }
  try {
    const providers = llm.listProviders() || []
    let follow = null
    try {
      if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
        follow = agentDefaultModel.currentSelection() || null
      }
    } catch {
      follow = null
    }
    return {
      ready: providers.length > 0,
      // 前端据此判断能不能用「划词一次性翻译」（只需要 body.text，不读 doc、不写盘）
      adhoc: true,
      providers: providers.map((item) => ({ id: item.id, name: item.name })),
      follow,
    }
  } catch (error) {
    return { ready: false, reason: error && error.message ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------- Obsidian 定位
let vaultCache = null

async function vaultContext() {
  if (vaultCache !== null && Date.now() - vaultCache.at < 30000) return vaultCache
  const obs = await mod('obsidian')
  const config = await getConfig()
  let vault = config.vault || ''
  let kb = config.kb || ''
  if (!vault) {
    vault = obs.detectVault() || ''
  }
  if (!vault) {
    vaultCache = { at: Date.now(), ok: false, error: '没有检测到 Obsidian vault（读不到 obsidian.json）' }
    return vaultCache
  }
  if (!kb) {
    kb = (await obs.detectPaperKb(vault)) || path.join(vault, 'F盘编程知识库', '论文知识库')
  }
  const exists = await fsp
    .stat(kb)
    .then((stat) => stat.isDirectory())
    .catch(() => false)
  vaultCache = exists
    ? { at: Date.now(), ok: true, vault, kb, obs }
    : { at: Date.now(), ok: false, vault, kb, error: '论文知识库目录不存在：' + kb }
  return vaultCache
}

function invalidateVault() {
  vaultCache = null
}

// ---------------------------------------------------------------- 扫描件 OCR（PaddleOCR 云端）
// 只调官方 AISTUDIO 接口，不本地跑模型；token 存在 config.ocr.token，永远不回给客户端明文。
const OCR_MODELS = ['PaddleOCR-VL-1.6', 'PP-StructureV3', 'PP-OCRv6']
const OCR_DEFAULT_MODEL = 'PaddleOCR-VL-1.6'

/** 进程内的实时进度（重启后仍有 ocr.json 兜底）。 */
const ocrJobs = new Map()
// 版面解析的后台任务：内存里留一份，落盘一份（layout.job.json）
const layoutJobs = new Map()
// 同一篇同时只允许一个中文版生成：两个 pdf_tool 抢同一个 .tmp 会写出坏文件
const zhpdfBuilds = new Map()
// 每篇的 OCR 世代号：clear / 重新提交都会 +1，旧的后台任务看到世代变了就不再回写
const ocrGen = new Map()

function ocrModelOf(config) {
  const model = String((config.ocr && config.ocr.model) || OCR_DEFAULT_MODEL)
  return OCR_MODELS.includes(model) ? model : OCR_DEFAULT_MODEL
}

function networkConfigWithSavedAuth(netMod, raw, stored, clearProxyAuth = false) {
  const next = netMod.normalizeNetworkConfig(raw)
  const requested = netMod.redactProxyUrl(next.proxyUrl)
  const storedConfig = netMod.normalizeNetworkConfig(stored)
  const current = netMod.redactProxyUrl(storedConfig.proxyUrl)
  if (clearProxyAuth) {
    next.proxyUrl = requested.url
  } else if (!requested.authenticated && current.authenticated && requested.url === current.url) {
    next.proxyUrl = storedConfig.proxyUrl
  }
  return next
}

/** 给配置做一份可安全回给浏览器的副本：没有 token/password，只有「配没配 / 尾号」。 */
async function publicConfig(config) {
  const [netMod, arxivMod] = await Promise.all([
    mod('net').catch(() => null),
    mod('arxiv').catch(() => null),
  ])
  const token = String((config.ocr && config.ocr.token) || '')
  const dbCfg = config && config.database && typeof config.database === 'object' ? config.database : {}
  const dbDriver = String(dbCfg.driver || 'sqlite')
  const dbPass = String(dbCfg.password || '')
  const obsCfg = config && config.obsidian && typeof config.obsidian === 'object' ? config.obsidian : {}
  const topicsCfg = config && config.topics && typeof config.topics === 'object' ? config.topics : {}
  const normTopics = arxivMod && typeof arxivMod.normalizeTopicsConfig === 'function'
    ? arxivMod.normalizeTopicsConfig(topicsCfg)
    : {
        items: Array.isArray(topicsCfg.items) ? topicsCfg.items : [],
        customKeywords: Array.isArray(topicsCfg.custom) ? topicsCfg.custom : [],
        subscribed: Array.isArray(topicsCfg.subscribed) ? topicsCfg.subscribed : ['llm-agents', 'multimodal-ocr', 'efficient-training'],
        feedSource: String(topicsCfg.feedSource || 'arxiv'),
      }
  const normNetwork = netMod && typeof netMod.normalizeNetworkConfig === 'function'
    ? netMod.normalizeNetworkConfig(config && config.network)
    : { mode: 'auto', proxyUrl: '' }
  const safeProxy = netMod && typeof netMod.redactProxyUrl === 'function'
    ? netMod.redactProxyUrl(normNetwork.proxyUrl)
    : { url: '', authenticated: false }
  return {
    ...config,
    ocr: {
      model: ocrModelOf(config),
      orient: Boolean(config.ocr && config.ocr.orient),
      unwarp: Boolean(config.ocr && config.ocr.unwarp),
      chart: Boolean(config.ocr && config.ocr.chart),
      configured: token.length > 0,
      hint: token.length === 0 ? '' : token.length > 8 ? token.slice(0, 4) + '…' + token.slice(-4) : '***',
    },
    obsidian: {
      enabled: Boolean(obsCfg.enabled),
      syncStatus: obsCfg.syncStatus !== false,
    },
    network: {
      ...normNetwork,
      proxyUrl: safeProxy.url,
      proxyAuthConfigured: safeProxy.authenticated,
    },
    database: {
      driver: dbDriver,
      tablePrefix: String(dbCfg.tablePrefix || 'pb_'),
      host: String(dbCfg.host || '127.0.0.1'),
      port: Number(dbCfg.port) || (dbDriver === 'postgres' ? 5432 : 3306),
      user: String(dbCfg.user || ''),
      database: String(dbCfg.database || (dbDriver === 'postgres' ? 'postgres' : 'paper_workbench')),
      ssl: Boolean(dbCfg.ssl),
      password: '',
      passwordConfigured: dbPass.length > 0,
      passwordHint: dbPass.length === 0 ? '' : dbPass.length > 4 ? '***' + dbPass.slice(-2) : '***',
    },
    topics: {
      items: normTopics.items,
      customKeywords: normTopics.customKeywords,
      custom: normTopics.customKeywords,
      subscribed: normTopics.subscribed,
      feedSource: normTopics.feedSource,
    },
  }
}

/** 把 ocr.md 拆成 [{ n, text }]；段标记与 zh.md 相同：`## p.N`。 */
export function splitOcrPages(markdown) {
  const pages = []
  if (!markdown) return pages
  let current = null
  for (const line of String(markdown).split(/\r?\n/)) {
    const hit = /^##\s*p\.(\d+)\s*$/.exec(line.trim())
    if (hit) {
      current = { n: Number(hit[1]), lines: [] }
      pages.push(current)
      continue
    }
    if (current !== null) current.lines.push(line)
  }
  return pages.map((page) => ({ n: page.n, text: page.lines.join('\n').trim() }))
}

function pickOcrPages(markdown, pages) {
  const all = splitOcrPages(markdown)
  if (!Array.isArray(pages) || pages.length === 0) return all
  const wanted = new Set(pages.map(Number))
  return all.filter((page) => wanted.has(page.n))
}

/** 当前 OCR 状态：内存里的实时进度优先，其次磁盘上的上次结果。 */
async function ocrStatusOf(id) {
  const meta = await getMeta(id)
  const config = await getConfig()
  const live = ocrJobs.get(id)
  const stored = await readOcrJob(id)
  const word = live || stored
  const markdown = await readOcr(id)
  const pages = splitOcrPages(markdown).length
  return {
    id: meta.id,
    configured: String((config.ocr && config.ocr.token) || '').length > 0,
    model: ocrModelOf(config),
    state: word ? word.state : 'idle',
    jobId: (word && word.jobId) || '',
    totalPages: (word && word.totalPages) || 0,
    extractedPages: (word && word.extractedPages) || 0,
    startedAt: (word && word.startedAt) || '',
    finishedAt: (word && word.finishedAt) || '',
    error: (word && word.error) || '',
    pages: (word && word.pages) || pages,
    chars: markdown.length,
  }
}

/** 提交 OCR 任务（立即返回），后台轮询；完成后写 ocr.md 并回填 meta.ocr。 */
async function startOcr(id, modelArg) {
  const running = ocrJobs.get(id)
  if (running && (running.state === 'pending' || running.state === 'running')) {
    return ocrStatusOf(id)
  }
  // 同步占位：下面有一串 await，两个并发 POST 都能通过上面这次检查，会重复提交、
  // 重复计费、结果互相覆盖。先把「正在跑」写进内存，再去做校验和提交。
  const generation = (ocrGen.get(id) || 0) + 1
  ocrGen.set(id, generation)
  ocrJobs.set(id, {
    state: 'pending',
    model: '',
    jobId: '',
    totalPages: 0,
    extractedPages: 0,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    error: '',
    pages: 0,
  })
  try {
    return await submitOcr(id, modelArg, generation)
  } catch (error) {
    if (ocrGen.get(id) === generation) ocrJobs.delete(id)
    throw error
  }
}

/** 校验配置并提交 OCR；占位已经由 startOcr 写好。 */
async function submitOcr(id, modelArg, generation) {
  const live = () => ocrGen.get(id) === generation
  const meta = await getMeta(id)
  const config = await getConfig()
  const token = String((config.ocr && config.ocr.token) || '')
  if (!token) throw new Error('还没有配置 PaddleOCR 的 API Key：在工作台「设置 → 扫描件 OCR」里填入后保存。')
  const pdf = await resolvePdf(id)
  const model = modelArg && OCR_MODELS.includes(modelArg) ? modelArg : ocrModelOf(config)
  const record = ocrJobs.get(id) || {}
  Object.assign(record, {
    state: 'pending',
    model,
    jobId: '',
    totalPages: 0,
    extractedPages: 0,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    error: '',
    pages: 0,
  })
  ocrJobs.set(id, record)
  const persist = async () => {
    await writeOcrJob(id, { ...record }).catch(() => {})
  }
  await persist()

  // 后台跑，不阻塞 HTTP 请求；错误只落在 record 上，由 ocr.status 读出来。
  ;(async () => {
    try {
      const ocr = await mod('ocr')
      const optional = {
        useDocOrientationClassify: Boolean(config.ocr && config.ocr.orient),
        useDocUnwarping: Boolean(config.ocr && config.ocr.unwarp),
        useChartRecognition: Boolean(config.ocr && config.ocr.chart),
      }
      const result = await ocr.runOcr({
        token,
        model,
        filePath: pdf.path,
        optionalPayload: optional,
        onProgress: (info) => {
          if (!live()) return          // 已经 clear 掉了：别把结果写回来
          record.state = info.state === 'done' ? 'done' : info.state || 'running'
          // jobId 全程落盘：重启后还能知道该续拉哪个任务，报错时也能定位
          if (info.jobId) record.jobId = info.jobId
          if (info.totalPages) record.totalPages = info.totalPages
          if (typeof info.extractedPages === 'number' && info.extractedPages >= 0) record.extractedPages = info.extractedPages
          void persist()
        },
      })
      if (!live()) return            // 期间用户点了「清除 OCR」：不要再把结果写回去
      await writeOcr(id, result.markdown)
      // 扫描件建模依赖 ocr.md：OCR 换了内容必须让 doc 重建
      ;(await mod('doc')).invalidateDocCache(id, { dropDoc: true })
      record.state = 'done'
      record.finishedAt = new Date().toISOString()
      record.pages = result.pages.length
      record.chars = result.markdown.length
      record.jobId = result.jobId || record.jobId
      await updateMeta(id, {
        ocr: { state: 'done', model, pages: record.pages, chars: record.chars, at: record.finishedAt },
      }).catch(() => {})
      await persist()
    } catch (error) {
      if (!live()) return            // 已取消，不是失败
      const raw = error && error.message ? error.message : String(error)
      record.state = 'failed'
      record.finishedAt = new Date().toISOString()
      record.error = raw.split(token).join('***')
      await persist()
      console.error('[paper-workbench] OCR 失败（' + id + '）：' + record.error)
    }
  })()

  return ocrStatusOf(id)
}

/** 把库里的论文映射成 Obsidian 卡片的字段补丁。 */
function cardPatch(meta, extra = {}) {
  const fields = {
    paper_status: meta.status || 'unread',
    paper_priority: meta.priority || 'normal',
    source: meta.srcPath || '',
  }
  if (meta.topics && meta.topics.length === 1) fields.paper_category = meta.topics[0]
  const concepts = extra.concepts || meta.tags || []
  if (concepts.length > 0) {
    fields.concepts = concepts
    fields.knowledge_nodes = extra.knowledge_nodes || concepts
  }
  return { fields, sections: extra.sections || {} }
}

// ---------------------------------------------------------------- 入库公共流程

// 从笔记库/文件夹导入时，文件名常是 `2601.21957v1--PaddleOCR-VL-1.5` 这种流水号，
// 读起来根本不是标题。这几个判断决定要不要去 PDF 首页找真标题。
const TITLE_NOISE = /^(arxiv|doi|https?:|www\.)/i
export function looksLikeFileName(title) {
  const text = String(title || '').trim()
  if (!text) return true
  if (text.includes('--')) return true
  if (/^[\d.\-_]+(v\d+)?$/i.test(text)) return true
  if (/\.pdf$/i.test(text)) return true
  if (/^[0-9a-f]{32,}$/i.test(text)) return true
  // 2408.08872v4-BLIP3 / 2212.04356v1(Whisper)
  if (/^\d{4}\.\d{4,5}(v\d+)?[\s_(\-]/.test(text)) return true
  // Xue_BLIP-3_A_Family_of_Open_Large_Multimodal_Models_ICCVW_2025_paper
  if (/^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+){2,}$/.test(text)) return true
  return false
}

/** 首页最大字号那几行拼成标题；必须排除 arXiv 水印（它是整页最大字号）。 */
export function titleFromPage1(text) {
  const page = text && Array.isArray(text.pages) ? text.pages[0] : null
  const blocks = Array.isArray(page && page.blocks) ? page.blocks : []
  if (blocks.length === 0) return ''
  // 先剔掉 arXiv 水印/页码/网址——它们是整页最大字号，会把标题挤掉
  const useful = blocks
    .map((item) => ({
      size: Number(item.size) || 0,
      text: String(item.text || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((item) => item.size > 0 && item.text.length >= 6 && item.text.length <= 300)
    .filter((item) => !TITLE_NOISE.test(item.text))
    .filter((item) => !/^page\s*\d+/i.test(item.text))
    .filter((item) => !/^abstract$/i.test(item.text))
  if (useful.length === 0) return ''
  const maxSize = Math.max(...useful.map((item) => item.size))
  const lines = useful.filter((item) => item.size >= maxSize * 0.92).map((item) => item.text)
  if (lines.length === 0) return ''
  let title = lines[0]
  // 标题常被拆成两三行（换行处不会断词时直接拼）
  for (const extra of lines.slice(1, 3)) {
    if (title.length >= 60) break
    if (extra.length > 160) break
    title += ' ' + extra
  }
  // 标题下面常紧跟一行同样字号的 Abstract，别把它粘进标题
  return title.replace(/\s+abstract$/i, '').slice(0, 300)
}

async function fileSha1(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function importOne(input) {
  await ensureDirs()
  const meta0 = {
    title: input.title,
    authors: input.authors || [],
    year: input.year || '',
    venue: input.venue || '',
    arxivId: input.arxivId || '',
    doi: input.doi || '',
    abstract: input.abstract || '',
    url: input.url || '',
    topics: input.topics || [],
    tags: input.tags || [],
    status: input.status || 'unread',
    priority: input.priority || 'normal',
    srcPath: path.resolve(input.srcPath),
    vaultCard: input.vaultCard || '',
  }
  const config = await getConfig()
  const storage = input.storage || config.storage || 'link'
  meta0.storage = storage

  // 先探测 PDF 信息（拿页数与是否有文本层）；PyMuPDF 不可用时降级但不阻断入库
  try {
    const scanned = await pdfInfo(meta0.srcPath)
    meta0.pageCount = scanned.pages || 0
    meta0.hasText = scanned.hasText !== false
    if (Array.isArray(scanned.toc) && scanned.toc.length > 0) meta0.outline = scanned.toc
  } catch {
    meta0.hasText = false
  }

  // 文件名式标题（笔记库导入、批量拖文件夹）用首页正文换掉，失败就保留原名
  if (looksLikeFileName(meta0.title) && meta0.hasText) {
    try {
      const guessed = titleFromPage1(await pdfText(meta0.srcPath))
      if (guessed && !looksLikeFileName(guessed)) meta0.title = guessed
    } catch {
      /* 取不到首页就保持原样，不阻断入库 */
    }
  }

  // 内容指纹：同一份 PDF 被复制成两个文件名时也能查出来（库里有 BLIP-3 两个副本）
  try {
    meta0.contentHash = await fileSha1(meta0.srcPath)
  } catch {
    /* 读不到就不比内容，只按路径/编号查重 */
  }

  const added = await addPaper(meta0)
  if (added.existed) return added

  const dir = path.join(DATA_ROOT, 'papers', added.meta.id)
  await fsp.mkdir(dir, { recursive: true })
  if (storage === 'copy' && input.copyFrom) {
    const target = path.join(dir, 'paper.pdf')
    if (path.resolve(input.copyFrom) !== path.resolve(target)) {
      await fsp.copyFile(input.copyFrom, target + '.tmp')
      await fsp.rename(target + '.tmp', target)
    }
    // 复制后 srcPath 指向库内副本（原路径留档，便于"在别处打开"和去重）
    added.meta = await updateMeta(added.meta.id, { srcPath: target, originPath: meta0.srcPath })
  }
  return added
}

function pageImageFile(id, page, scale) {
  const rounded = String(Math.round(scale * 100) / 100).replace('.', '_')
  return path.join(PAGES_DIR, id, 'p' + page + '@' + rounded + '.png')
}

// ---------------------------------------------------------------- API

export function createApi({ fetchTopicFeed } = {}) {
  return {
    // --- 二进制钩子（由 server.js 调用）
    pageImage: async ({ id, page, scale, source }) => {
      const meta = await getMeta(id)
      const pdf = await resolvePdf(meta.id)
      const p = Math.max(1, Number(page) || 1)
      const s = Math.min(4, Math.max(0.5, Number(scale) || 2))
      // source=zh：渲染中文版 PDF（版面原样、正文换成译文），缓存单独一套
      const zhMode = String(source || '') === 'zh'
      const imagePath = zhMode ? paperFile(meta.id, 'paper-zh.pdf') : pdf.path
      const sourceStat = await fsp.stat(imagePath).catch(() => null)
      if (sourceStat === null) throw new Error(zhMode ? '还没有中文版：先在面板里生成一次' : 'PDF 不存在')
      const target = zhMode
        ? path.join(PAGES_DIR, meta.id, 'zh-p' + p + '@' + String(Math.round(s * 100) / 100).replace('.', '_') + '.png')
        : pageImageFile(meta.id, p, s)
      const cached = await fsp.stat(target).catch(() => null)
      if (cached === null || cached.mtimeMs < sourceStat.mtimeMs) {
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await renderPage(imagePath, p, target, s)
      }
      return { path: target, mime: 'image/png' }
    },

    rawPdf: async ({ id }) => {
      const pdf = await resolvePdf(id)
      return { path: pdf.path }
    },

    // v3：裁剪后的配图（按 figures.json 的数组下标取）
    figureImage: async ({ id, index }) => {
      const figuresModule = await mod('figures')
      const file = await figuresModule.figurePath(String(id || ''), Number(index) || 0)
      return { path: file, mime: 'image/png' }
    },

    upload: async ({ req, url }) => {
      const name = String(url.searchParams.get('name') || 'upload.pdf')
      const topic = String(url.searchParams.get('topic') || '')
      if (!/\.pdf$/i.test(name)) throw new Error('只支持 PDF 文件')
      const body = await readBody(req)
      if (body.length < 5 || body.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('上传内容不是 PDF')
      const tempDir = path.join(DATA_ROOT, '.tmp')
      await fsp.mkdir(tempDir, { recursive: true })
      const temp = path.join(tempDir, 'up-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8) + '.pdf')
      await fsp.writeFile(temp, body)
      try {
        const result = await importOne({
          srcPath: temp,
          title: path.basename(name, path.extname(name)),
          topics: topic ? [topic] : [],
          storage: 'copy',
          copyFrom: temp,
        })
        return result
      } finally {
        await fsp.rm(temp, { force: true }).catch(() => {})
      }
    },

    // --- 基础
    health: async () => {
      const papers = await listPapers().catch(() => [])
      const python = await findPython().catch(() => null)
      const vault = await vaultContext().catch((error) => ({ ok: false, error: error.message }))
      const config = await getConfig().catch(() => ({}))
      const token = String((config.ocr && config.ocr.token) || '')
      const ai = aiHealth()
      let db = { engine: 'unavailable' }
      try {
        const dbBackend = await getDbBackend()
        const bInfo = await dbBackend.info()
        if (bInfo.driver === 'sqlite') {
          const dbModule = await mod('db')
          db = { ...dbModule.dbInfo(), driver: 'sqlite', healthy: bInfo.healthy, counts: bInfo.counts }
        } else {
          db = {
            engine: bInfo.driver,
            driver: bInfo.driver,
            healthy: bInfo.healthy,
            path: '',
            details: bInfo.details,
            counts: bInfo.counts,
            rows: {
              translations: Number(bInfo.counts && bInfo.counts.translations) || 0,
              job_events: Number(bInfo.counts && bInfo.counts.job_events) || 0,
              reviews: Number(bInfo.counts && bInfo.counts.reviews) || 0,
            },
          }
        }
      } catch (error) {
        db = { engine: 'unavailable', error: error && error.message ? error.message : String(error) }
      }
      const activeTranslations = await getTranslateJobs()
        .then((mgr) => mgr.listActive())
        .catch(() => [])
      return {
        ok: true,
        plugin: 'dsh-paper-workbench',
        phase: 'p3',
        root: ROOT,
        dataRoot: DATA_ROOT,
        papers: papers.length,
        pdf: python === null ? { ok: false, python: '' } : { ok: true, python: python.python, version: python.version },
        obsidian: { enabled: Boolean(config.obsidian && config.obsidian.enabled) },
        vault: vault.ok ? { ok: true, vault: vault.vault, kb: vault.kb } : { ok: false, error: vault.error },
        ocr: { configured: token.length > 0, model: ocrModelOf(config) },
        ai,
        db,
        activeTranslations,
        session: {
          available: Boolean(sessionRuntime.sessionController),
          paperScope: paperContext.runtimeReady(),
          idPrefix: 'pb-',
          // 面板里所有会话都挂在这个工作区下；前端把它显示在对话栏上，方便对照侧栏。
          workspace: await workspaceSettings(),
        },
        time: new Date().toISOString(),
      }
    },

    // 环境自检：新用户第一件事。CLI（scripts/doctor.mjs）走同一个模块，报告内容一致。
    'doctor.run': async () => {
      const doctor = await mod('doctor')
      return doctor.runDoctor({
        ai: aiHealth(),
        host: {
          session: Boolean(sessionRuntime.sessionController),
          workspace: Boolean(sessionRuntime.workspaceRegistry || sessionRuntime.workspaceController),
          paperScope: paperContext.runtimeReady(),
        },
      })
    },

    'settings.get': async () => ({ config: await publicConfig(await getConfig()), dataRoot: DATA_ROOT }),

    'settings.set': async (args) => {
      const patch = { ...((args && args.patch) || {}) }
      const existingCfg = await getConfig()
      let invalidateFeedCache = false
      // ocr.token：非空字符串=换新；null=清除；其它（省略或空串）=保持原样。
      if (patch.ocr && typeof patch.ocr === 'object') {
        const current = existingCfg.ocr || {}
        const next = { ...current }
        for (const key of ['model', 'orient', 'unwarp', 'chart']) {
          if (patch.ocr[key] !== undefined) next[key] = patch.ocr[key]
        }
        if (patch.ocr.token === null) next.token = ''
        else if (typeof patch.ocr.token === 'string' && patch.ocr.token.trim() !== '') next.token = patch.ocr.token.trim()
        patch.ocr = next
      }
      if (patch.ai && typeof patch.ai === 'object') {
        const aiMod = await mod('ai')
        const current = existingCfg.ai || {}
        const next = { ...current }
        for (const key of ['translateModel', 'chatModel']) {
          if (patch.ai[key] !== undefined) next[key] = sanitizeModelChoice(patch.ai[key])
        }
        if (patch.ai.target !== undefined) next.target = String(patch.ai.target || 'zh') === 'zh' ? 'zh' : 'zh'
        if (patch.ai.concurrency !== undefined) {
          next.concurrency = aiMod.clampConcurrency(patch.ai.concurrency, current.concurrency || 10)
        }
        if (patch.ai.temperature !== undefined) {
          const val = Number(patch.ai.temperature)
          next.temperature = Number.isFinite(val) ? Math.min(1, Math.max(0, val)) : 0.2
        }
        patch.ai = next
      }
      if (patch.obsidian && typeof patch.obsidian === 'object') {
        const current = existingCfg.obsidian || {}
        patch.obsidian = {
          enabled: patch.obsidian.enabled !== undefined ? Boolean(patch.obsidian.enabled) : Boolean(current.enabled),
          syncStatus: patch.obsidian.syncStatus !== undefined ? Boolean(patch.obsidian.syncStatus) : current.syncStatus !== false,
        }
      }
      if (patch.network !== undefined) {
        const netMod = await mod('net')
        const mergedNet =
          typeof patch.network === 'string'
            ? patch.network
            : { ...(existingCfg.network || {}), ...(patch.network && typeof patch.network === 'object' ? patch.network : {}) }
        patch.network = networkConfigWithSavedAuth(
          netMod,
          mergedNet,
          existingCfg.network,
          Boolean(patch.network && typeof patch.network === 'object' && patch.network.clearProxyAuth),
        )
        invalidateFeedCache = true
      }
      if (patch.topics && typeof patch.topics === 'object') {
        const arxivMod = await mod('arxiv')
        const current = existingCfg.topics || {}
        const rawMerged = patch.topics.resetDefaults
          ? {
              subscribed: ['llm-agents', 'multimodal-ocr', 'efficient-training'],
              customKeywords: [],
              feedSource: patch.topics.feedSource || current.feedSource || 'arxiv',
            }
          : {
              ...current,
              ...patch.topics,
              ...(patch.topics.items === undefined && patch.topics.subscribed !== undefined ? { items: undefined } : {}),
            }
        const norm = arxivMod.normalizeTopicsConfig(rawMerged)
        patch.topics = {
          items: norm.items,
          customKeywords: norm.customKeywords,
          custom: norm.customKeywords,
          subscribed: norm.subscribed,
          feedSource: norm.feedSource,
        }
        invalidateFeedCache = true
      }
      let dbTouched = false
      if (patch.database && typeof patch.database === 'object') {
        dbTouched = true
        const current = existingCfg.database || {}
        const dbBackendMod = await mod('db-backend')
        const prefix = dbBackendMod.validateTablePrefix(
          patch.database.tablePrefix !== undefined ? patch.database.tablePrefix : current.tablePrefix,
        )
        const nextDb = {
          driver: ['sqlite', 'postgres', 'mysql'].includes(String(patch.database.driver || current.driver || 'sqlite'))
            ? String(patch.database.driver || current.driver || 'sqlite')
            : 'sqlite',
          tablePrefix: prefix,
          host: String(patch.database.host ?? current.host ?? '127.0.0.1').trim() || '127.0.0.1',
          port: Math.min(65535, Math.max(1, Math.trunc(Number(patch.database.port ?? current.port ?? 3306) || 3306))),
          user: String(patch.database.user ?? current.user ?? '').trim(),
          database: String(patch.database.database ?? current.database ?? 'paper_workbench').trim(),
          ssl: patch.database.ssl !== undefined ? Boolean(patch.database.ssl) : Boolean(current.ssl),
          password: current.password || '',
        }
        if (patch.database.clearPassword === true || patch.database.password === null) {
          nextDb.password = ''
        } else if (typeof patch.database.password === 'string' && patch.database.password !== '') {
          nextDb.password = patch.database.password
        }
        patch.database = nextDb
      }
      const before = patch.ocr ? { ...existingCfg.ocr } : null
      if (invalidateFeedCache) {
        await fsp.rm(path.join(DATA_ROOT, '.tmp', 'feed-cache.json'), { force: true }).catch(() => {
          throw new Error('清理旧订阅缓存失败，请检查工作台数据目录是否可写')
        })
      }
      const config = await setConfig(patch)
      invalidateVault()
      if (dbTouched) {
        const backend = await getDbBackend().catch(() => null)
        if (backend && typeof backend.close === 'function') await backend.close().catch(() => {})
      }
      // 换了 Python 路径就让下一次 probe 立刻重来（否则缓存里还是旧解释器）
      if (typeof patch.python === 'string') {
        const pdfModule = await mod('pdf').catch(() => null)
        if (pdfModule && typeof pdfModule.resetPython === 'function') pdfModule.resetPython()
      }
      if (before && before.token && !(config.ocr && config.ocr.token)) {
        console.warn('[paper-workbench] PaddleOCR Key 已被清除（settings.set 传了 token:null）')
      }
      return { config: await publicConfig(config) }
    },

    'network.test': async (args) => {
      const netMod = await mod('net')
      const current = await getConfig()
      const cfg = args && args.network !== undefined
        ? networkConfigWithSavedAuth(
            netMod,
            args.network,
            current.network,
            Boolean(args.network && typeof args.network === 'object' && args.network.clearProxyAuth),
          )
        : current.network
      return netMod.testNetworkConnectivity(cfg)
    },

    // --- 文献库
    'library.list': async () => {
      const papers = await listPapers()
      const topics = new Map()
      for (const paper of papers) {
        for (const topic of paper.topics || []) topics.set(topic, (topics.get(topic) || 0) + 1)
      }
      return {
        items: papers,
        topics: [...topics.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      }
    },

    'library.get': async (args) => {
      const meta = await getMeta(args && args.id)
      let outline = []
      try {
        const pdf = await resolvePdf(meta.id)
        if (meta.outline && meta.outline.length > 0) {
          outline = meta.outline
        } else {
          const value = await pdfOutline(pdf.path).catch(() => ({ items: [] }))
          outline = (value.items || []).map((item) => ({ level: item.level, title: item.title, page: item.page }))
          if (outline.length > 0) await updateMeta(meta.id, { outline })
        }
      } catch (error) {
        // 取不到目录不算致命：阅读器仍可渲染页图
        if (!/找不到 PDF|python|PyMuPDF/i.test(String(error && error.message))) throw error
      }
      const notes = await readNotes(meta.id)
      const zh = await readZh(meta.id)
      const ocr = await ocrStatusOf(meta.id).catch(() => null)
      return {
        meta,
        outline,
        hasText: meta.hasText !== false,
        notes,
        zhChars: zh.length,
        ocr: ocr
          ? { state: ocr.state, model: ocr.model, pages: ocr.pages, chars: ocr.chars, error: ocr.error, configured: ocr.configured }
          : null,
      }
    },

    'library.importPath': async (args) => {
      const source = String((args && args.path) || '').trim()
      if (!source) throw new Error('缺少 path')
      const absolute = path.resolve(source)
      const stat = await fsp.stat(absolute).catch(() => null)
      if (stat === null || !stat.isFile()) throw new Error('文件不存在：' + absolute)
      if (path.extname(absolute).toLowerCase() !== '.pdf') throw new Error('只支持 PDF 文件')
      return importOne({
        srcPath: absolute,
        title: (args && args.title) || path.basename(absolute, path.extname(absolute)),
        authors: (args && args.authors) || [],
        year: (args && args.year) || '',
        arxivId: (args && args.arxivId) || '',
        doi: (args && args.doi) || '',
        abstract: (args && args.abstract) || '',
        url: (args && args.url) || '',
        topics: args && args.topic ? [args.topic] : [],
        storage: (args && args.storage) || undefined,
        copyFrom: absolute,
      })
    },

    'library.update': async (args) => {
      const rawPatch = (args && args.patch && typeof args.patch === 'object') ? args.patch : {}
      for (const forbidden of ['srcPath', 'originPath', 'storage', 'vaultCard']) {
        if (Object.hasOwn(rawPatch, forbidden)) {
          throw new Error('不允许通过更新接口修改底层文件路径或存储模式（' + forbidden + '）')
        }
      }
      const safePatch = {}
      for (const key of ['title', 'authors', 'year', 'venue', 'arxivId', 'doi', 'abstract', 'url', 'topics', 'tags', 'status', 'priority', 'lastReadPage']) {
        if (rawPatch[key] !== undefined) safePatch[key] = rawPatch[key]
      }
      const meta = await updateMeta(args && args.id, safePatch)
      // 状态/优先级仅在开启 Obsidian 联动时同步到卡片（失败不影响库操作）
      if (safePatch.status || safePatch.priority) {
        try {
          const cfg = await getConfig()
          if (cfg && cfg.obsidian && cfg.obsidian.enabled) {
            const vault = await vaultContext()
            if (vault.ok) {
              const card = await vault.obs.locateCard(vault.kb, {
                source: meta.srcPath,
                sourceRelative: meta.vaultCard,
                title: meta.title,
              })
              if (card) await vault.obs.setStatus(vault.kb, card.path, meta.status, meta.priority)
            }
          }
        } catch (error) {
          console.error('[paper-workbench] 同步 Obsidian 状态失败：' + (error && error.message))
        }
      }
      return { meta }
    },

    'library.remove': async (args) => {
      const value = await removePaper(args && args.id)
      invalidateVault()
      // 删掉的论文可能还留在 doc 的 sha1 缓存里，顺手清掉
      const docModule = await mod('doc')
      docModule.invalidateDocCache(String((args && args.id) || ''))
      return value
    },

    'library.openPdf': async (args) => {
      const pdf = await resolvePdf(args && args.id)
      const opener = process.platform === 'win32'
        ? ['explorer.exe', [pdf.path]]
        : process.platform === 'darwin'
          ? ['open', [pdf.path]]
          : ['xdg-open', [pdf.path]]
      const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
      return { path: pdf.path }
    },

    'library.importFromVault': async () => {
      const vault = await vaultContext()
      if (!vault.ok) throw new Error(vault.error)
      const cards = await vault.obs.listCards(vault.kb)
      const papers = await listPapers()
      const known = new Set()
      for (const paper of papers) {
        if (paper.srcPath) known.add(String(paper.srcPath).toLowerCase())
        if (paper.originPath) known.add(String(paper.originPath).toLowerCase())
      }
      const imported = []
      const skipped = []
      for (const card of cards) {
        const frontmatter = card.frontmatter || {}
        const source = frontmatter.source ? String(frontmatter.source) : ''
        if (!source) {
          skipped.push({ title: card.title, reason: '卡片没有 source 字段' })
          continue
        }
        if (path.extname(source).toLowerCase() !== '.pdf') {
          skipped.push({ title: card.title, reason: '源文件不是 PDF：' + (path.extname(source) || '无扩展名') })
          continue
        }
        if (known.has(source.toLowerCase())) continue
        const stat = await fsp.stat(source).catch(() => null)
        if (stat === null || !stat.isFile()) {
          skipped.push({ title: card.title, reason: '原 PDF 不存在：' + source })
          continue
        }
        try {
          const result = await importOne({
            srcPath: path.resolve(source),
            title: card.title,
            topics: frontmatter.paper_category ? [frontmatter.paper_category] : [],
            status: frontmatter.paper_status || 'unread',
            priority: frontmatter.paper_priority || 'normal',
            tags: Array.isArray(frontmatter.concepts) ? frontmatter.concepts : [],
            vaultCard: card.path,
          })
          imported.push(result.meta)
          known.add(source.toLowerCase())
        } catch (error) {
          skipped.push({ title: card.title, reason: error.message })
        }
      }
      return { imported, skipped, scanned: cards.length }
    },

    'library.importDir': async (args) => {
      const dirRaw = String((args && args.dir) || '').trim()
      if (!dirRaw) throw new Error('缺少目录路径（dir）')
      const rootDir = path.resolve(dirRaw)
      const rootStat = await fsp.stat(rootDir).catch(() => null)
      if (!rootStat || !rootStat.isDirectory()) throw new Error('目录不存在：' + rootDir)
      const recursive = args && args.recursive !== false
      const defaultTopic = String((args && args.topic) || '').trim()
      const storage = args && args.storage ? String(args.storage) : undefined
      const maxFiles = 500
      const maxDepth = 4
      const pdfFiles = []
      const skipped = []

      async function walk(curDir, depth) {
        if (pdfFiles.length >= maxFiles || depth > maxDepth) return
        let entries = []
        try {
          entries = await fsp.readdir(curDir, { withFileTypes: true })
        } catch (error) {
          skipped.push({ title: path.basename(curDir), reason: '无法读取目录：' + (error && error.message) })
          return
        }
        for (const entry of entries) {
          if (pdfFiles.length >= maxFiles) break
          if (entry.name.startsWith('.')) continue
          const full = path.join(curDir, entry.name)
          if (entry.isDirectory()) {
            if (recursive && depth < maxDepth) await walk(full, depth + 1)
          } else if (entry.isFile()) {
            if (path.extname(entry.name).toLowerCase() === '.pdf') {
              pdfFiles.push(full)
            }
          }
        }
      }

      await walk(rootDir, 0)
      const papers = await listPapers()
      const known = new Set()
      for (const p of papers) {
        if (p.srcPath) known.add(path.resolve(p.srcPath).toLowerCase())
        if (p.originPath) known.add(path.resolve(p.originPath).toLowerCase())
      }
      const imported = []
      for (const file of pdfFiles) {
        const lower = file.toLowerCase()
        if (known.has(lower)) {
          skipped.push({ title: path.basename(file, '.pdf'), reason: '已在库中（跳过重复）' })
          continue
        }
        const rel = path.relative(rootDir, file)
        const parts = rel.split(path.sep).filter(Boolean)
        const folderTopic = parts.length > 1 ? parts[0] : ''
        const topic = defaultTopic || folderTopic
        try {
          const result = await importOne({
            srcPath: file,
            title: path.basename(file, path.extname(file)),
            topics: topic ? [topic] : [],
            storage,
            copyFrom: file,
          })
          if (result && result.existed) {
            skipped.push({ title: result.meta.title, reason: '内容或路径重复（已存在）' })
          } else if (result && result.meta) {
            imported.push(result.meta)
            known.add(lower)
          }
        } catch (error) {
          skipped.push({ title: path.basename(file, '.pdf'), reason: error && error.message ? error.message : String(error) })
        }
      }
      return { dir: rootDir, scanned: pdfFiles.length, imported, skipped }
    },

    // --- PDF
    'pdf.info': async (args) => {
      const meta = await getMeta(args && args.id)
      const pdf = await resolvePdf(meta.id)
      const value = await pdfInfo(pdf.path)
      if (value.pages && value.pages !== meta.pageCount) await updateMeta(meta.id, { pageCount: value.pages })
      return value
    },

    'pdf.text': async (args) => {
      const meta = await getMeta(args && args.id)
      const pdf = await resolvePdf(meta.id)
      const cached = await loadText(meta, pdf.path, () => readTextCache(meta.id), (value) => writeTextCache(meta.id, value))
      const wanted = args && args.pages
      if (wanted === 'all' || wanted === undefined || wanted === null) return cached
      const set = new Set((Array.isArray(wanted) ? wanted : [wanted]).map((n) => Number(n)))
      return { ...cached, pages: (cached.pages || []).filter((page) => set.has(Number(page.n))) }
    },

    'pdf.outline': async (args) => {
      const meta = await getMeta(args && args.id)
      const pdf = await resolvePdf(meta.id)
      const value = await pdfOutline(pdf.path)
      const items = value.items || []
      await updateMeta(meta.id, { outline: items })
      // 目录变了，分节结果就变了：下次 doc.get 必须重建
      ;(await mod('doc')).invalidateDocCache(meta.id)
      return { items, heuristic: Boolean(value.heuristic) }
    },

    'pdf.search': async (args) => {
      const meta = await getMeta(args && args.id)
      const pdf = await resolvePdf(meta.id)
      const cached = await loadText(meta, pdf.path, () => readTextCache(meta.id), (value) => writeTextCache(meta.id, value))
      return { hits: searchText(cached, args && args.query, args && args.limit ? Number(args.limit) : 60) }
    },

    'pdf.pageLines': async (args) => {
      const meta = await getMeta(args && args.id)
      const page = Math.max(1, Math.trunc(Number(args && args.page) || 1))
      const pdf = await resolvePdf(meta.id)
      const stat = await fsp.stat(pdf.path)
      const cacheFile = path.join(PAPERS_DIR, meta.id, '.pagelines', 'p' + page + '.json')
      const cached = await readJson(cacheFile, null)
      if (
        cached &&
        Number(cached.size) === Number(stat.size) &&
        Math.round(Number(cached.mtimeMs)) === Math.round(Number(stat.mtimeMs)) &&
        Array.isArray(cached.lines)
      ) {
        return cached
      }
      const res = await pageLines(pdf.path, page)
      const out = {
        page: Number(res && res.page) || page,
        width: Number(res && res.width) || 612,
        height: Number(res && res.height) || 792,
        lines: Array.isArray(res && res.lines) ? res.lines : [],
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }
      await writeJsonAtomic(cacheFile, out).catch(() => {})
      return out
    },

    'pdf.cropRegion': async (args) => {
      const meta = await getMeta(args && args.id)
      const pdf = await resolvePdf(meta.id)
      const page = Math.max(1, Math.trunc(Number(args && args.page) || 1))
      const tmpDir = path.join(DATA_ROOT, '.tmp')
      await fsp.mkdir(tmpDir, { recursive: true })
      const out = path.join(tmpDir, 'crop-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8) + '.png')
      try {
        const res = await cropRegion(pdf.path, page, (args && args.rect) || {}, out, 2.2)
        const buf = await fsp.readFile(out)
        return {
          page: Number(res && res.page) || page,
          width: Number(res && res.width) || 0,
          height: Number(res && res.height) || 0,
          text: String((res && res.text) || ''),
          mime: 'image/png',
          fileName: meta.id + '-p' + (Number(res && res.page) || page) + '-crop.png',
          imageBase64: buf.toString('base64'),
        }
      } finally {
        await fsp.rm(out, { force: true }).catch(() => {})
      }
    },

    // --- 笔记
    'notes.get': async (args) => readNotes(args && args.id),
    'notes.save': async (args) => {
      const id = String((args && args.id) || '')
      const notes = {
        highlights: Array.isArray(args && args.highlights) ? args.highlights : [],
        updatedAt: new Date().toISOString(),
      }
      await writeNotes(id, notes)
      return { count: notes.highlights.length }
    },

    // --- 译文
    'zh.read': async (args) => {
      const id = String((args && args.id) || '')
      const markdown = await readZh(id)
      const pages = (markdown.match(/^## p\.\d+/gm) || []).length
      return { markdown, pages, chars: markdown.length }
    },

    // --- 扫描件 OCR（PaddleOCR 云端，API Key 在设置里填）
    'ocr.status': async (args) => ocrStatusOf(String((args && args.id) || '')),

    'ocr.start': async (args) => startOcr(String((args && args.id) || ''), args && args.model ? String(args.model) : ''),

    'ocr.read': async (args) => {
      const markdown = await readOcr(String((args && args.id) || ''))
      return { markdown, pages: splitOcrPages(markdown).length, chars: markdown.length }
    },

    // 按页码取 OCR 文本；没有 ocr.md 时返回空数组，由调用方决定是否提示先做 OCR
    'ocr.text': async (args) => {
      const markdown = await readOcr(String((args && args.id) || ''))
      const all = splitOcrPages(markdown)
      const wanted = args && args.pages
      const pages = wanted === 'all' || wanted === undefined || wanted === null ? all : pickOcrPages(markdown, wanted)
      return { pages, total: all.length, chars: markdown.length }
    },

    // 清掉某篇的 OCR 结果（不动 PDF 本身）
    'ocr.clear': async (args) => {
      const id = String((args && args.id) || '')
      // 世代号 +1：进行中的后台任务会看到 live()===false，不再回写 ocr.md / meta
      ocrGen.set(id, (ocrGen.get(id) || 0) + 1)
      await writeOcr(id, '')
      await writeOcrJob(id, { state: 'idle', model: ocrModelOf(await getConfig()), pages: 0 })
      ocrJobs.delete(id)
      ;(await mod('doc')).invalidateDocCache(id)
      return { ok: true }
    },

    // --- 在线检索
    'search.online': async (args) => {
      const arxiv = await mod('arxiv')
      const query = String((args && args.query) || '').trim()
      if (!query) throw new Error('请输入关键词或 arXiv ID / DOI')
      const limit = Math.min(25, Math.max(1, Number((args && args.limit) || 8)))
      const source = (args && args.source) || 'both'
      if (source === 'arxiv') return { items: (await arxiv.searchArxiv({ query, limit })).items, source }
      if (source === 'openalex') return { items: (await arxiv.searchOpenAlex({ query, limit })).items, source }
      const both = await arxiv.searchBoth({ query, limit })
      return { items: both.items, ...(both.warnings ? { warnings: both.warnings } : {}), source: 'both' }
    },

    'search.import': async (args) => {
      const arxiv = await mod('arxiv')
      const item = (args && args.item) || {}
      if (!item.pdfUrl) throw new Error('这条结果没有开放获取的 PDF 链接')
      await ensureDirs()
      const tempDir = path.join(DATA_ROOT, '.tmp')
      await fsp.mkdir(tempDir, { recursive: true })
      const temp = path.join(tempDir, 'dl-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8) + '.pdf')
      try {
        await arxiv.downloadPdf(item.pdfUrl, temp)
        return await importOne({
          srcPath: temp,
          title: item.title || '未命名论文',
          authors: item.authors || [],
          year: item.year || '',
          venue: item.venue || '',
          abstract: item.abstract || '',
          arxivId: item.arxivId || '',
          doi: item.doi || '',
          url: item.url || item.absUrl || '',
          topics: args && args.topic ? [args.topic] : [],
          storage: 'copy',
          copyFrom: temp,
        })
      } finally {
        await fsp.rm(temp, { force: true }).catch(() => {})
      }
    },

    'search.topics': async () => {
      const [arxiv, config] = await Promise.all([mod('arxiv'), getConfig()])
      const norm = arxiv.normalizeTopicsConfig(config && config.topics)
      return {
        domains: arxiv.ARXIV_DOMAINS || [],
        topics: arxiv.PRESET_TOPICS || [],
        config: {
          ...norm,
          custom: norm.customKeywords,
        },
      }
    },

    'search.latest': async (args) => {
      const [arxiv, config] = await Promise.all([mod('arxiv'), getConfig()])
      const cfgTopics = arxiv.normalizeTopicsConfig(config && config.topics)
      const topicId = args && args.topicId ? String(args.topicId).trim() : ''
      const domainId = args && args.domainId ? String(args.domainId).trim() : ''
      const category = args && args.category ? String(args.category).trim() : ''
      const hasExplicitLegacy = Boolean(
        args && (args.items !== undefined || args.subscribed !== undefined || args.custom !== undefined || args.customKeywords !== undefined),
      )
      const effectiveTopicsCfg = hasExplicitLegacy
        ? arxiv.normalizeTopicsConfig({
            ...cfgTopics,
            ...(args.items !== undefined ? { items: args.items } : { items: undefined }),
            ...(args.subscribed !== undefined ? { subscribed: args.subscribed } : {}),
            ...(args.customKeywords !== undefined
              ? { customKeywords: args.customKeywords }
              : args.custom !== undefined
                ? { custom: args.custom }
                : {}),
          })
        : cfgTopics
      const source = (args && args.source) || effectiveTopicsCfg.feedSource || 'arxiv'
      const limit = Math.min(40, Math.max(1, Number((args && args.limit) || 18)))
      const force = Boolean(args && args.force)
      const networkConfig = config && config.network
      const networkFingerprint = createHash('sha256').update(JSON.stringify(networkConfig || null)).digest('hex')
      const cacheKey = JSON.stringify({
        topics: effectiveTopicsCfg,
        topicId,
        domainId,
        category,
        source,
        limit,
        networkFingerprint,
      })
      const cacheFile = path.join(DATA_ROOT, '.tmp', 'feed-cache.json')
      const CACHE_VERSION = 2
      const CACHE_TTL_MS = 15 * 60 * 1000
      // 旧缓存键可能含代理凭据，强刷也要在拉取前清理。
      const cached = await fsp.readFile(cacheFile, 'utf8').then(async (text) => {
        let entry
        try {
          entry = JSON.parse(text)
        } catch {
          // 旧写入中断后可能留下含明文的残缺 JSON，也要清理。
        }
        if (entry?.version === CACHE_VERSION) return entry
        await fsp.rm(cacheFile, { force: true }).catch(() => {
          throw new Error('清理旧订阅缓存失败，请检查工作台数据目录是否可写')
        })
        return null
      }, async (error) => {
        if (error.code !== 'ENOENT') {
          await fsp.rm(cacheFile, { force: true }).catch(() => {
            throw new Error('清理旧订阅缓存失败，请检查工作台数据目录是否可写')
          })
        }
        return null
      })
      if (
        !force &&
        cached &&
        cached.key === cacheKey &&
        typeof cached.savedAt === 'number' &&
        Date.now() - cached.savedAt < CACHE_TTL_MS &&
        cached.value &&
        Array.isArray(cached.value.items) &&
        cached.value.items.length > 0
      ) {
        return { ...cached.value, cached: true }
      }
      const value = await (fetchTopicFeed ?? arxiv.fetchTopicFeed)({
        topicsConfig: effectiveTopicsCfg,
        topicId: topicId || undefined,
        domainId: domainId || undefined,
        category: category || undefined,
        source,
        limit,
        networkConfig,
      })
      if (value && Array.isArray(value.items) && value.items.length > 0) {
        await writeJsonAtomic(cacheFile, { version: CACHE_VERSION, key: cacheKey, savedAt: Date.now(), value }).catch(() => {})
      }
      return { ...value, cached: false }
    },

    // --- Obsidian
    'vault.status': async () => {
      const vault = await vaultContext()
      if (!vault.ok) return { ok: false, error: vault.error, vault: vault.vault || '', kb: vault.kb || '' }
      const cards = await vault.obs.listCards(vault.kb)
      return { ok: true, vault: vault.vault, kb: vault.kb, cards: cards.length }
    },

    'vault.scan': async () => {
      const vault = await vaultContext()
      if (!vault.ok) throw new Error(vault.error)
      const cards = await vault.obs.listCards(vault.kb)
      const missing = []
      let linked = 0
      for (const card of cards) {
        const source = card.frontmatter && card.frontmatter.source ? String(card.frontmatter.source) : ''
        if (!source) continue
        const stat = await fsp.stat(source).catch(() => null)
        if (stat && stat.isFile()) linked += 1
        else missing.push({ title: card.title, source, path: card.path })
      }
      return { cards: cards.length, linked, missing }
    },

    'vault.read': async (args) => {
      const vault = await vaultContext()
      if (!vault.ok) throw new Error(vault.error)
      let target = String((args && args.path) || '')
      if (!target && args && args.id) {
        const meta = await getMeta(args.id)
        const card = await vault.obs.locateCard(vault.kb, {
          source: meta.srcPath,
          sourceRelative: meta.vaultCard,
          title: meta.title,
        })
        if (!card) throw new Error('没有找到对应的 Obsidian 卡片')
        target = card.path
      }
      if (!target) throw new Error('缺少 path 或 id')
      // path 来自工具参数（模型可被 PDF 正文诱导），只能读知识库里的 .md；否则等于给了 agent 任意读文件的能力
      const root = path.resolve(vault.kb || vault.vault || '')
      const resolved = path.resolve(target)
      const relative = path.relative(root, resolved)
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('只能读知识库里的卡片：' + resolved)
      }
      if (path.extname(resolved).toLowerCase() !== '.md') throw new Error('只能读 .md 卡片：' + resolved)
      const card = await vault.obs.readCard(resolved)
      return { path: card.path, frontmatter: card.frontmatter, body: card.body }
    },

    'vault.upsert': async (args) => {
      const vault = await vaultContext()
      if (!vault.ok) throw new Error(vault.error)
      const meta = await getMeta(args && args.id)
      const extra = { sections: (args && args.sections) || {}, concepts: args && args.concepts }
      if (args && args.report) extra.sections['精读报告'] = String(args.report)
      const patch = cardPatch(meta, extra)
      if (args && args.fields) {
        for (const [key, value] of Object.entries(args.fields)) {
          if (key === 'sections') continue
          patch.fields[key] = value
        }
      }
      const paper = {
        title: meta.title,
        category: meta.topics && meta.topics.length > 0 ? meta.topics[0] : '',
        source: meta.srcPath,
        sourceRelative: meta.vaultCard,
        fields: patch.fields,
        sections: patch.sections,
      }
      const result = await vault.obs.upsertCard(vault.kb, paper, patch)
      if (result.path) await updateMeta(meta.id, { vaultCard: result.path })
      invalidateVault()
      return result
    },

    'vault.survey': async (args) => {
      const vault = await vaultContext()
      if (!vault.ok) throw new Error(vault.error)
      const topic = String((args && args.topic) || '').trim()
      const markdown = String((args && args.markdown) || '')
      if (!topic) throw new Error('缺少 topic')
      if (!markdown.trim()) throw new Error('综述内容为空')
      const result = await vault.obs.writeSurvey(vault.kb, topic, markdown)
      invalidateVault()
      return result
    },

    'vault.search': async (args) => {
      const vault = await vaultContext()
      if (!vault.ok) throw new Error(vault.error)
      return {
        hits: await vault.obs.searchVault(vault.kb, String((args && args.query) || ''), Number((args && args.limit) || 20)),
      }
    },

    'vault.open': async (args) => {
      const vault = await vaultContext()
      if (!vault.ok) throw new Error(vault.error)
      const target = String((args && args.path) || '').trim()
      if (!target) throw new Error('缺少 path')
      const root = path.resolve(vault.kb || vault.vault || '')
      const resolved = path.resolve(target)
      const relative = path.relative(root, resolved)
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('只能打开知识库里的卡片：' + resolved)
      }
      if (path.extname(resolved).toLowerCase() !== '.md') throw new Error('只能打开 .md 卡片：' + resolved)
      return { ok: vault.obs.openInObsidian(resolved) }
    },

    // --- v2：段落级文档模型
    'doc.get': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const [doc, storeModule] = await Promise.all([mod('doc'), mod('store')])
      const result = await doc.getDoc(id, { rebuild: Boolean(args && args.rebuild) })
      const [trans, annotations, studyNotes, translateJob] = await Promise.all([
        storeModule.readTrans(id),
        storeModule.readAnnotations(id).catch(() => []),
        storeModule.readStudyNotes(id).catch(() => []),
        getTranslateJobs().then((mgr) => mgr.status(id)).catch(() => null),
      ])
      return {
        doc: result.doc,
        built: Boolean(result.built),
        stale: Boolean(result.stale),
        ms: result.ms,
        trans: { entries: trans.entries, model: trans.model },
        annotations,
        studyNotes,
        translateJob,
      }
    },

    'doc.build': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const docModule = await mod('doc')
      docModule.invalidateDocCache(id)
      const result = await docModule.getDoc(id, { rebuild: true })
      return {
        sections: (result.doc.sections || []).length,
        paragraphs: (result.doc.paragraphs || []).length,
        source: result.doc.source,
        ms: result.ms,
      }
    },

    // --- v2：内置 AI（翻译 / 对话 / 模型目录）
    'ai.models': async () => {
      const ai = await engine()
      return ai.models()
    },

    'ai.settings.get': async () => ({ config: await publicConfig(await getConfig()) }),

    'ai.settings.set': async (args) => {
      const aiMod = await mod('ai')
      const raw = (args && args.patch) || {}
      // 允许两种写法：{ ai: {...} } 或直接 {...}
      const patch = raw.ai && typeof raw.ai === 'object' ? raw.ai : raw
      const current = (await getConfig()).ai || {}
      const next = { ...current }
      for (const key of ['translateModel', 'chatModel']) {
        if (patch[key] !== undefined) next[key] = sanitizeModelChoice(patch[key])
      }
      if (patch.target !== undefined) next.target = String(patch.target || 'zh') === 'zh' ? 'zh' : 'zh'
      if (patch.concurrency !== undefined) {
        next.concurrency = aiMod.clampConcurrency(patch.concurrency, current.concurrency || 10)
      }
      if (patch.temperature !== undefined) {
        const value = Number(patch.temperature)
        next.temperature = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.2
      }
      const config = await setConfig({ ai: next })
      return { config: await publicConfig(config) }
    },

    'trans.get': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const trans = await readTrans(id)
      return { entries: trans.entries, model: trans.model, updatedAt: trans.updatedAt || null }
    },

    'trans.clear': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const trans = await readTrans(id)
      const keys = args && Array.isArray(args.keys) ? args.keys.map((key) => String(key).toLowerCase()) : null
      const before = Object.keys(trans.entries).length
      if (keys === null) {
        const removed = await clearTrans(id)
        return { ok: true, removed }
      }
      const removed = await deleteTransKeys(id, keys)
      return { ok: true, removed, left: Math.max(0, before - removed) }
    },

    'chat.get': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const chat = await readChat(id)
      const messages = Array.isArray(chat.messages) ? chat.messages : []
      // 旧版本把「划词翻译」也发成了一条对话消息；翻译现在是独立小工具，
      // 这些记录既不该显示，也不该混进对话上下文。翻译的那一轮（问 + 答）整对清掉，
      // 否则会留下一条没头没尾的「译文如下：…」。
      const kept = []
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]
        if (isLegacyTranslateMessage(message)) {
          const next = messages[index + 1]
          if (next && next.role === 'assistant') index += 1
          continue
        }
        // 「问」已经不在的孤儿回答（旧版本翻译那轮的 assistant 半截）
        if (message && message.role === 'assistant' && /^\s*译文如下/.test(String(message.content || ''))) continue
        kept.push(message)
      }
      if (kept.length !== messages.length) {
        await writeChat(id, { model: chat.model || null, messages: kept }).catch(() => {})
      }
      return { messages: kept, model: chat.model }
    },

    'chat.clear': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      await writeChat(id, { model: null, messages: [] })
      return { ok: true }
    },

    // --- v3：文内搜索（搜文档模型的段落，不碰 PDF 文本层）
    'search.doc': async (args) => {
      const id = String((args && args.id) || '')
      const query = String((args && args.query) || '').trim()
      if (!id) throw new Error('缺少 id')
      if (!query) return { hits: [], total: 0 }
      const docModule = await mod('doc')
      const built = await docModule.getDoc(id)
      const doc = built.doc || {}
      const needle = query.toLowerCase()
      const limit = Math.min(200, Math.max(1, Number(args && args.limit) || 50))
      const hits = []
      const scan = (key, text, kind, sectionId, page) => {
        const source = String(text || '')
        if (!source) return
        const lower = source.toLowerCase()
        let at = lower.indexOf(needle)
        while (at >= 0 && hits.length < limit) {
          hits.push({
            key,
            kind,
            sectionId: sectionId || null,
            page: Number(page) || 1,
            text: source,
            at,
            before: source.slice(Math.max(0, at - 40), at),
            after: source.slice(at + query.length, at + query.length + 40),
          })
          at = lower.indexOf(needle, at + Math.max(1, needle.length))
        }
      }
      for (const section of doc.sections || []) {
        const key = section.hash ? 't:' + String(section.hash).toLowerCase() : 't:' + section.id
        scan(key, section.title, 'title', section.id, section.page)
      }
      for (const paragraph of doc.paragraphs || []) {
        const key = paragraph.hash ? String(paragraph.hash).toLowerCase() : String(paragraph.id || '')
        scan(key, paragraph.text, paragraph.kind, paragraph.section, paragraph.page)
      }
      return { hits, total: hits.length, truncated: hits.length >= limit }
    },

    // --- v3：配图
    'figures.list': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const figuresModule = await mod('figures')
      const figures = await figuresModule.listFigures(id, { refresh: Boolean(args && args.refresh) })
      return { figures }
    },

    // --- v4：版面解析（PP-StructureV3）
    'layout.status': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const [layoutModule, storeModule] = await Promise.all([mod('layout'), mod('store')])
      const reader = layoutModule.createLayout({ store: storeModule })
      const layout = await reader.readLayout(id)
      const storeInfo = await storeModule.getConfig().catch(() => null)
      const token = storeInfo && storeInfo.ocr ? String(storeInfo.ocr.token || '') : ''
      // 任务进度：内存里的实时记录优先，其次磁盘上的上次状态（重启后据此判断能不能续跑）
      const partial = await reader.readPartial(id).catch(() => null)
      let job = layoutJobs.get(id) || (await storeModule.readJson(paperFile(id, 'layout.job.json'), null).catch(() => null))
      if (job) job = { ...job }
      if (job) delete job.controller
      if (job && job.state === 'running' && !layoutJobs.has(id)) {
        // 进程重启了：内存里没有这个任务，磁盘却写着 running。
        // 但 layout.json 比 job 文件新，说明结果其实已经写完（只是收尾的落盘没赶上），按完成算。
        const layoutAt = layout ? String(layout.at || '') : ''
        const jobAt = String(job.at || '')
        if (layoutAt && layoutAt >= jobAt) {
          job.state = 'done'
          job.stage = '完成'
        } else {
          job.state = 'interrupted'
          job.stage = '上次中断了（已完成 ' + ((partial && partial.pages ? partial.pages.length : 0)) + ' 页）'
        }
      }
      const savedPages = partial && Array.isArray(partial.pages) ? partial.pages.length : 0
      return {
        layout: layout
          ? {
            ...layoutModule.layoutSummary(layout),
            jobId: String(layout.jobId || ''),
            applied: await isLayoutApplied(id, layout),
            schemaVersion: Number(layout.schemaVersion) || 1,
            revision: String(layout.revision || ''),
            quality: layout.quality
              ? { ...layout.quality, summary: layout.quality.summary || layoutModule.qualitySummary(layout.quality.issues || []) }
              : null,
            pages: (layout.pages || []).map(page => ({
              n: page.n,
              status: page.status || 'ready',
              issues: (page.quality && page.quality.issues ? page.quality.issues.length : 0),
              summary: page.quality && page.quality.summary
                ? page.quality.summary
                : page.quality && Array.isArray(page.quality.issues) ? layoutModule.qualitySummary(page.quality.issues) : null,
              fallback: page.fallback || null,
            })),
          }
          : null,
        job: job || null,
        // 有断点就能「接着跑」：已完成的批次不会重新上传，不重复花钱
        resumable: savedPages > 0,
        savedPages,
        ready: token !== '',
      }
    },

    // 质量报告：每页状态、问题清单、被排除的块。前端据此提示「哪些页要看原页」。
    'layout.report': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const [layoutModule, storeModule] = await Promise.all([mod('layout'), mod('store')])
      const layout = await layoutModule.createLayout({ store: storeModule }).readLayout(id)
      if (!layout) return { exists: false }
      return {
        exists: true,
        schemaVersion: Number(layout.schemaVersion) || 1,
        revision: String(layout.revision || ''),
        at: String(layout.at || ''),
        quality: layout.quality
          ? { ...layout.quality, summary: layout.quality.summary || layoutModule.qualitySummary(layout.quality.issues || []) }
          : null,
        pages: (layout.pages || []).map(page => ({
          n: page.n,
          status: page.status || 'ready',
          width: page.width || 0,
          height: page.height || 0,
          fallback: page.fallback || null,
          issues: (page.quality && page.quality.issues) || [],
          summary: page.quality && page.quality.summary
            ? page.quality.summary
            : page.quality && Array.isArray(page.quality.issues) ? layoutModule.qualitySummary(page.quality.issues) : null,
        })),
        excluded: (layout.excluded || []).map(item => ({ reason: item.reason, page: item.page, blockId: item.blockId })),
      }
    },

    // 后台跑版面解析：面板关掉、切走、甚至刷新页面都不会把任务带走。
    // 进度与断点都落盘（layout.job.json / layout.partial.json），下次打开能接着跑。
    'layout.start': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const running = layoutJobs.get(id)
      if (running && running.state === 'running') {
        // 正在跑就返回同一份快照；controller 留在内存里，别塞进 JSON 响应
        const shown = { ...running }
        delete shown.controller
        return shown
      }
      // 占位要在 await 之前：首次 mod() 是真的动态 import，中间几毫秒足够第二条请求挤进来，
      // 那样同一篇会被上传两遍、按页扣两次钱
      const placeholder = {
        id, state: 'running', stage: '准备', model: String((args && args.model) || ''),
        pages: 0, totalPages: 0, batches: 0, jobId: '', resumed: false,
        startedAt: new Date().toISOString(), finishedAt: '', error: '',
      }
      layoutJobs.set(id, placeholder)
      let layoutModule
      let storeModule
      let pdfModule
      let ocrModule
      try {
        ;[layoutModule, storeModule, pdfModule, ocrModule] = await Promise.all([
          mod('layout'), mod('store'), mod('pdf'), mod('ocr'),
        ])
      } catch (error) {
        if (layoutJobs.get(id) === placeholder) layoutJobs.delete(id)
        throw error
      }
      const runner = layoutModule.createLayout({ store: storeModule, pdf: pdfModule, ocr: ocrModule })
      const record = {
        id,
        state: 'running',
        stage: '准备',
        model: String((args && args.model) || ''),
        pages: 0,
        totalPages: 0,
        batches: 0,
        jobId: '',
        resumed: false,
        startedAt: new Date().toISOString(),
        finishedAt: '',
        error: '',
      }
      const controller = new AbortController()
      record.controller = controller
      layoutJobs.set(id, record)
      // 进度会连着来（submit/poll/batch 一串），落盘必须排队：
      // 并发 writeJsonAtomic 有先后翻转的可能，旧快照后落地会让磁盘上一直写着 running
      let persistChain = Promise.resolve()
      const persist = () => {
        const plain = { ...record }
        delete plain.controller
        const snapshot = { ...plain, at: new Date().toISOString() }
        persistChain = persistChain
          .then(() => storeModule.writeJsonAtomic(paperFile(id, 'layout.job.json'), snapshot))
          .catch(() => {})
        return persistChain
      }
      await persist()
      const job = await safeJob((logger) => logger.start(id, 'layout', { model: record.model }))
      // 不 await：请求立刻返回，前端轮询 layout.status 看进度
      ;(async () => {
        try {
          const layout = await runner.runLayout(id, {
            model: record.model || undefined,
            batchPages: args && args.batchPages,
            // 不传就沿用「默认续跑」；显式 false 才丢弃断点
            resume: args && typeof args.resume === 'boolean' ? args.resume : undefined,
            maxCloudPages: args && args.maxCloudPages,
            signal: controller.signal,
            onProgress: (event) => {
              if (!event) return
              if (event.total) record.totalPages = event.total
              if (event.phase === 'submit') {
                record.stage = '上传第 ' + event.start + '-' + event.end + ' 页'
                record.batches += 1
                record.batchStart = Math.max(0, event.start - 1)
              } else if (event.phase === 'poll') {
                record.stage = '识别第 ' + event.start + '-' + event.end + ' 页'
                if (event.jobId) record.jobId = event.jobId
                // extractedPages 是「这一批」的进度，直接当总数会让面板从 50 掉回 0
                if (typeof event.extractedPages === 'number') {
                  record.pages = Math.min(record.totalPages || Infinity, (record.batchStart || 0) + event.extractedPages)
                }
              } else if (event.phase === 'batch') {
                record.stage = '已保存 ' + event.saved + '/' + event.total + ' 页'
                record.pages = event.saved
              } else if (event.phase === 'resume') {
                record.resumed = true
                record.stage = '接着上次跑（已完成 ' + event.pages + ' 页）'
                record.pages = event.pages
              } else if (event.phase === 'text') {
                record.stage = '回填文本层（第 ' + event.page + '/' + event.total + ' 页）'
              }
              void persist()
            },
          })
          const docModule = await mod('doc')
          docModule.invalidateDocCache(id)
          await storeModule.clearDocCache(id).catch(() => {})
          record.state = 'done'
          record.stage = '完成'
          record.finishedAt = new Date().toISOString()
          record.layout = layoutModule.layoutSummary(layout)
          record.pages = record.totalPages || record.pages
          record.error = ''
          if (job) await safeJob((logger) => logger.finish(job, 'ok', { blocks: (layout.blocks || []).length }))
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          record.state = controller.signal.aborted ? 'cancelled' : 'failed'
          record.stage = controller.signal.aborted ? '已取消' : '失败'
          record.finishedAt = new Date().toISOString()
          record.error = message
          if (job) await safeJob((logger) => logger.fail(job, error))
        } finally {
          delete record.controller
          await persist()
          if (layoutJobs.get(id) === record) layoutJobs.delete(id)
        }
      })()
      const shown = { ...record }
      delete shown.controller
      return shown
    },

    'layout.cancel': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const record = layoutJobs.get(id)
      if (!record || !record.controller) return { ok: false, cancelled: false }
      record.controller.abort()
      return { ok: true, cancelled: true }
    },

    'layout.run': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const busy = layoutJobs.get(id)
      if (busy && busy.state === 'running') throw new Error('这篇的版面任务正在后台跑：等它结束，或在面板里取消')
      const [layoutModule, storeModule, pdfModule, ocrModule] = await Promise.all([
        mod('layout'), mod('store'), mod('pdf'), mod('ocr'),
      ])
      const runner = layoutModule.createLayout({ store: storeModule, pdf: pdfModule, ocr: ocrModule })
      const job = await safeJob((logger) => logger.start(id, 'layout', { model: String((args && args.model) || '') }))
      try {
        const layout = await runner.runLayout(id, {
          model: args && args.model,
          batchPages: args && args.batchPages,
        })
        // 版面换了就要重建 doc 与配图缓存，否则界面上还是旧模型。
        // 这里必须等 doc.json 真删掉再返回：删盘是异步的，不等就会出现「刚解析完还是旧文本」。
        const docModule = await mod('doc')
        docModule.invalidateDocCache(id)
        await storeModule.clearDocCache(id).catch(() => {})
        if (job) await safeJob((logger) => logger.finish(job, 'ok', { blocks: (layout.blocks || []).length }))
        return { layout: layoutModule.layoutSummary(layout) }
      } catch (error) {
        if (job) await safeJob((logger) => logger.fail(job, error))
        throw error
      }
    },

    // 中文版 PDF：把译文写回原版面，右栏渲染它就和原文逐页对齐（纯本地，不上传）
    'zhpdf.status': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const [zhModule, storeModule] = await Promise.all([mod('zhpdf'), mod('store')])
      return zhModule.createZhPdf({ store: storeModule }).status(id)
    },
    'zhpdf.build': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      // 两个请求同时进来会各起一个 pdf_tool 写同一个 .tmp：单飞，第二次直接等结果
      const pending = zhpdfBuilds.get(id)
      if (pending) return pending
      const task = (async () => {
        const [zhModule, storeModule, pdfModule, docModule] = await Promise.all([
          mod('zhpdf'), mod('store'), mod('pdf'), mod('doc'),
        ])
        const built = await docModule.getDoc(id)
        const job = await safeJob((logger) => logger.start(id, 'zhpdf', {}))
        try {
          // getDoc 返回 { doc, built, ms }，不是文档模型本身
          const result = await zhModule.createZhPdf({ store: storeModule, pdf: pdfModule }).build(id, { doc: built.doc })
          if (job) await safeJob((logger) => logger.finish(job, 'ok', { blocks: result.blocks }))
          return result
        } catch (error) {
          if (job) await safeJob((logger) => logger.fail(job, error))
          throw error
        }
      })()
      zhpdfBuilds.set(id, task)
      try {
        return await task
      } finally {
        if (zhpdfBuilds.get(id) === task) zhpdfBuilds.delete(id)
      }
    },
    'zhpdf.clear': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const [zhModule, storeModule] = await Promise.all([mod('zhpdf'), mod('store')])
      return zhModule.createZhPdf({ store: storeModule }).clear(id)
    },

    'layout.clear': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const busy = layoutJobs.get(id)
      if (busy && busy.state === 'running') throw new Error('这篇的版面任务正在后台跑：先取消，再清除')
      const [layoutModule, storeModule2] = await Promise.all([mod('layout'), mod('store')])
      const reader = layoutModule.createLayout({ store: storeModule2 })
      const cleared = await reader.clearLayout(id)
      // 只清 layout.json 不够：断点和任务状态还在，刷新后仍会显示「续跑 N 页」并真的重跑旧页
      await reader.clearPartial(id).catch(() => {})
      await fsp.rm(storeModule2.paperFile(id, 'layout.job.json'), { force: true }).catch(() => {})
      const [docModule, storeModule] = await Promise.all([mod('doc'), mod('store')])
      docModule.invalidateDocCache(id)
      await storeModule.clearDocCache(id).catch(() => {})
      return { cleared }
    },

    // 只补表格结构：不重新上传 PDF、不花额度（老 layout.json 回填，或表格抽取逻辑改进后重跑）
    'layout.tables': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const busy = layoutJobs.get(id)
      if (busy && busy.state === 'running') throw new Error('这篇的版面任务正在后台跑：等它结束再补表格')
      const [layoutModule, storeModule, pdfModule] = await Promise.all([mod('layout'), mod('store'), mod('pdf')])
      const runner = layoutModule.createLayout({ store: storeModule, pdf: pdfModule })
      const result = await runner.refreshTables(id)
      const docModule = await mod('doc')
      docModule.invalidateDocCache(id)
      await storeModule.clearDocCache(id).catch(() => {})
      return result
    },

    // 只重填文字：某些块标签（abstract）早期没走 PDF 文本层，存下的是服务端 OCR 的错字版。
    // 这里按 bbox 从文本层重取一遍，不重新上传、不花配额。
    'layout.refill': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const busy = layoutJobs.get(id)
      if (busy && busy.state === 'running') throw new Error('这篇的版面任务正在后台跑：等它结束再重填')
      const [layoutModule, storeModule, pdfModule] = await Promise.all([mod('layout'), mod('store'), mod('pdf')])
      const runner = layoutModule.createLayout({ store: storeModule, pdf: pdfModule })
      const result = await runner.refillText(id)
      if (result.changed > 0) {
        const docModule = await mod('doc')
        docModule.invalidateDocCache(id)
        await storeModule.clearDocCache(id).catch(() => {})
      }
      return result
    },

    // --- v3：翻译自检
    'review.run': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const [reviewModule, storeModule] = await Promise.all([mod('review'), mod('store')])
      const reviewer = reviewModule.createReview({ store: storeModule, getServices: () => aiRuntime })
      const job = await safeJob((logger) => logger.start(id, 'review', { mode: String((args && args.mode) || 'both') }))
      try {
        const result = await reviewer.run(id, { mode: args && args.mode, limit: args && args.limit })
        if (job) await safeJob((logger) => logger.finish(job, 'ok', { issues: (result.issues || []).length }))
        return { review: result }
      } catch (error) {
        if (job) await safeJob((logger) => logger.fail(job, error))
        throw error
      }
    },

    'review.get': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      return { review: await readReview(id) }
    },

    // --- v3：任务日志
    'logs.list': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const logger = await jobs()
      const after = Number(args && args.after) || 0
      const limit = Number(args && args.limit) || 300
      return Promise.resolve(logger.list(id, after > 0 ? { after, limit } : { latest: limit })).catch(() => ({
        events: [],
        lastSeq: 0,
      }))
    },

    'logs.clear': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const logger = await jobs()
      return { cleared: await Promise.resolve(logger.clear(id)).catch(() => 0) }
    },

    // --- v1.0：后台持久翻译任务控制
    'translate.start': async (args) => {
      const mgr = await getTranslateJobs()
      return { job: await mgr.startJob(args || {}) }
    },

    'translate.pause': async (args) => {
      const key = String((args && (args.jobId || args.id)) || '')
      if (!key) throw new Error('缺少论文 id 或任务 jobId')
      const mgr = await getTranslateJobs()
      return { job: await mgr.pauseJob(key) }
    },

    'translate.resume': async (args) => {
      const key = String((args && (args.jobId || args.id)) || '')
      if (!key) throw new Error('缺少论文 id 或任务 jobId')
      const mgr = await getTranslateJobs()
      return { job: await mgr.resumeJob(key, args || {}) }
    },

    'translate.status': async (args) => {
      const mgr = await getTranslateJobs()
      const id = String((args && args.id) || '').trim()
      if (id) return { job: await mgr.status(id) }
      const [jobsList, all] = await Promise.all([mgr.listActive(), mgr.status()])
      return { jobs: jobsList, all }
    },

    // --- v1.0：原文富标注 & 研读笔记 & 导出
    'annotations.list': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      return { annotations: await readAnnotations(id) }
    },

    'annotations.save': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const payload = args && args.annotations !== undefined ? args.annotations : args && args.annotation
      if (!payload) throw new Error('缺少 annotation 数据')
      const annotations = await saveAnnotations(id, payload, { replace: Boolean(args && args.replace) })
      return { annotations }
    },

    'annotations.delete': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      return deleteAnnotations(id, args && (args.ids || args.annId))
    },

    'annotations.clear': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const cleared = await clearAnnotations(id)
      return { cleared, annotations: [] }
    },

    'studyNotes.list': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      return { studyNotes: await readStudyNotes(id) }
    },

    'studyNotes.save': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const payload = args && args.notes !== undefined ? args.notes : args && args.note
      if (!payload) throw new Error('缺少 note 数据')
      return saveStudyNote(id, payload)
    },

    'studyNotes.delete': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      return deleteStudyNotes(id, args && (args.ids || args.noteId))
    },

    'studyNotes.clear': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      return { cleared: await clearStudyNotes(id), studyNotes: [] }
    },

    'paper.explain': async (args) => {
      const [explainMod, storeMod, docMod, figuresMod, dbBackend] = await Promise.all([
        mod('explain'),
        mod('store'),
        mod('doc'),
        mod('figures'),
        getDbBackend(),
      ])
      return explainMod.buildPaperExplain(args || {}, {
        store: storeMod,
        docLib: docMod,
        figuresLib: figuresMod,
        dbLib: dbBackend,
      })
    },

    'paper.exportMarkdown': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const includeTrans = !args || args.includeTrans !== false
      const [meta, notes, annotations, studyNotes, trans, docBuilt] = await Promise.all([
        getMeta(id),
        readNotes(id).catch(() => ({ highlights: [] })),
        readAnnotations(id).catch(() => []),
        readStudyNotes(id).catch(() => []),
        includeTrans ? readTrans(id).catch(() => ({ entries: {} })) : Promise.resolve({ entries: {} }),
        includeTrans ? mod('doc').then((d) => d.getDoc(id)).catch(() => null) : Promise.resolve(null),
      ])
      const lines = []
      lines.push('# ' + (meta.title || id))
      lines.push('')
      const metaBits = []
      if (Array.isArray(meta.authors) && meta.authors.length) metaBits.push('**作者**: ' + meta.authors.join(', '))
      if (meta.year) metaBits.push('**年份**: ' + meta.year)
      if (meta.venue) metaBits.push('**来源**: ' + meta.venue)
      if (meta.arxivId) metaBits.push('**arXiv**: ' + meta.arxivId)
      if (meta.doi) metaBits.push('**DOI**: ' + meta.doi)
      if (metaBits.length) lines.push(metaBits.join(' | '), '')
      if (meta.abstract) lines.push('## 摘要', '', meta.abstract, '')

      if (studyNotes.length > 0) {
        lines.push('## AI 讲解与研读笔记', '')
        for (const sn of studyNotes) {
          lines.push('### ' + (sn.title || '研读笔记') + '（p.' + (sn.page || 1) + '）', '')
          if (sn.anchorQuote) lines.push('> ' + sn.anchorQuote.replace(/\n+/g, ' '), '')
          lines.push(sn.markdown || '', '')
        }
      }

      const highlights = Array.isArray(notes && notes.highlights) ? notes.highlights : []
      if (annotations.length > 0 || highlights.length > 0) {
        lines.push('## 原文标注与高亮', '')
        for (const ann of annotations) {
          const kindMap = { highlight: '高亮', underline: '下划线', bold: '加粗', comment: '批注', insert: '插入' }
          lines.push('- **[' + (kindMap[ann.kind] || ann.kind) + ' · p.' + (ann.page || 1) + ']** ' + (ann.quote || '(段内批注)'))
          if (ann.note) lines.push('  - 笔记：' + ann.note.replace(/\n+/g, '\n    '))
        }
        for (const hl of highlights) {
          lines.push('- **[高亮 · p.' + (hl.page || 1) + ']** ' + (hl.text || ''))
          if (hl.note) lines.push('  - 笔记：' + hl.note.replace(/\n+/g, '\n    '))
        }
        lines.push('')
      }

      const entries = (trans && trans.entries) || {}
      const doc = docBuilt && docBuilt.doc
      if (includeTrans && doc && Array.isArray(doc.paragraphs) && Object.keys(entries).length > 0) {
        lines.push('## 双语对照存档', '')
        const secById = new Map((doc.sections || []).map((s) => [s.id, s]))
        let lastSec = null
        for (const para of doc.paragraphs) {
          if (para.section && para.section !== lastSec) {
            lastSec = para.section
            const sec = secById.get(lastSec)
            if (sec) {
              const tKey = sec.hash ? 't:' + String(sec.hash).toLowerCase() : 't:' + sec.id
              const tZh = entries[tKey] && entries[tKey].zh ? ' / ' + entries[tKey].zh : ''
              lines.push('### ' + sec.title + tZh + ' (p.' + (sec.page || 1) + ')', '')
            }
          }
          const key = para.hash ? String(para.hash).toLowerCase() : String(para.id || '')
          const zh = entries[key] && entries[key].zh ? entries[key].zh : ''
          lines.push(para.text || '', '')
          if (zh) lines.push('> **译**：' + zh.replace(/\n+/g, '\n> '), '')
        }
      }

      const safeStem = (meta.id || 'paper').replace(/[^a-z0-9._-]+/gi, '-')
      return { filename: safeStem + '-notes.md', markdown: lines.join('\n'), meta }
    },

    // --- v1.0：多数据库后端状态 / 测试 / 导出 / 导入 / 迁移
    'db.status': async () => (await getDbBackend()).info(),

    'db.test': async (args) => {
      const config = await getConfig()
      const currentDb = (config && config.database) || {}
      const input = (args && args.database && typeof args.database === 'object' ? args.database : args) || {}
      const merged = { ...currentDb, ...input }
      if ((!input.password || input.password === '') && input.clearPassword !== true) {
        merged.password = currentDb.password || ''
      }
      const backend = await getDbBackend()
      return backend.testConnection(merged)
    },

    'db.export': async (args) => {
      const backend = await getDbBackend()
      const snapshot = await backend.exportSnapshot(args && Array.isArray(args.paperIds) ? args.paperIds : undefined)
      return { snapshot }
    },

    'db.import': async (args) => {
      const backend = await getDbBackend()
      return backend.importSnapshot(args && args.snapshot, { mode: (args && args.mode) || 'merge' })
    },

    'db.migrate': async (args) => {
      const config = await getConfig()
      const currentDb = (config && config.database) || {}
      const input = (args && args.database && typeof args.database === 'object' ? args.database : args) || {}
      const target = { ...currentDb, ...input }
      if ((!input.password || input.password === '') && input.clearPassword !== true) {
        target.password = currentDb.password || ''
      }
      const backend = await getDbBackend()
      return backend.migrateTo(target, { mode: (args && args.mode) || 'merge' })
    },

    // --- v3：回收站
    'trash.list': async () => ({ items: await listTrash() }),
    'trash.restore': async (args) => restoreTrash(String((args && args.name) || '')),
    'trash.purge': async (args) => purgeTrash(String((args && args.name) || '')),

    // --- v3：原生会话
    'session.status': async () => {
      const b = await bridge()
      return { available: b.available() }
    },

    'paper.context.get': args => paperContext.get(args),
    'paper.context.set': args => paperContext.set(args),

    'session.prepare': async args => {
      const snapshot = await paperContext.get(args)
      const ws = await workspaceSettings().catch(() => null)
      if (ws && ws.path) {
        await mod('workspace-skills').then((m) => m.ensureWorkspaceSkills(ws.path)).catch(() => {})
      }
      const b = await bridge(snapshot.sessionId)
      if (!snapshot.scope?.registered && typeof b.forget === 'function') b.forget()
      // ensure may await agent/created; it must run outside the context queue.
      await b.ensure(snapshot.conversationId, { sessionId: snapshot.sessionId })
      return paperContext.get(args)
    },

    // --- v3.1：对话（一个对话 = 一个宿主会话，可以带多篇论文和附件）
    'conv.list': async () => listConversations(),

    'conv.create': async (args) => {
      const paperIds = Array.isArray(args && args.paperIds) ? args.paperIds : []
      const title = String((args && args.title) || '')
      return paperContext.mutate(() => createConversation({ title, paperIds }))
    },

    'conv.update': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const patch = {}
      if (args.title !== undefined) patch.title = args.title
      if (args.paperIds !== undefined) patch.paperIds = args.paperIds
      return paperContext.mutate(() => updateConversation(id, patch), id)
    },

    'conv.remove': async (args) => {
      const id = String((args && args.id) || '')
      return paperContext.remove(id, () => removeConversation(id))
    },

    'conv.active': async (args) => {
      const id = String((args && args.id) || '')
      return paperContext.mutate(() => setActiveConversation(id), id)
    },

    'conv.attach': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const name = String((args && args.name) || '')
      const base64 = String((args && args.dataBase64) || '')
      if (base64 === '') throw new Error('附件是空的')
      const data = Buffer.from(base64, 'base64')
      if (data.length === 0) throw new Error('附件是空的')
      if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('附件太大（上限 40MB）')
      return paperContext.mutate(() => attachToConversation(id, { name, data }), id)
    },

    'conv.detach': async (args) => {
      const id = String((args && args.id) || '')
      return paperContext.mutate(() => detachFromConversation(id, String((args && args.path) || '')), id)
    },

    'session.ask': async (args) => {
      const conversationId = String((args && args.conversationId) || '')
      const id = String((args && args.id) || '')
      const text = String((args && args.text) || '').trim()
      if (!conversationId && !id) throw new Error('缺少 id')
      if (!text) throw new Error('问题是空的')
      const b = await bridge()
      if (conversationId) {
        const conv = await getConversation(conversationId)
        if (!conv) throw new Error('对话不存在：' + conversationId)
        const papers = await papersForConversation(conv)
        const cwd = papers.length > 0 && papers[0].path ? path.dirname(papers[0].path) : DATA_ROOT
        await paperContext.mutate(() => updateConversation(conversationId, {}), conversationId)
        const snapshot = await paperContext.get({ conversationId })
        const content = buildScopePrompt({ conversation: conv, papers, context: snapshot.context }) + text
        const scopedBridge = await bridge(conv.sessionId)
        const result = await scopedBridge.ask(conversationId, content, { cwd, sessionId: conv.sessionId })
        return { ...result, sessionId: conv.sessionId }
      }
      const pdf = await resolvePdf(id).catch(() => null)
      const cwd = pdf && pdf.path ? path.dirname(pdf.path) : DATA_ROOT
      return b.ask(id, text, { cwd })
    },

    // 界面状态（当前论文 / 页签 / 页码 / 滚动位置）：存服务端，桌面端重启换了端口也不丢
    'ui.get': async () => ({ state: mergeUiState(await readUiState()) }),

    'ui.set': async (args) => {
      const patch = args && args.state && typeof args.state === 'object' && !Array.isArray(args.state) ? args.state : null
      if (!patch) throw new Error('缺少 state')
      return updateUiState(patch)
    },
  }
}

/** upload 钩子需要读原始请求体，server.js 只传 req，这里补一个最小实现。 */
async function readBody(req, limitBytes = 512 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('上传内容超过上限')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------- 插件入口

/**
 * 三条 SSE 流（翻译 / 对话 / 原生会话）。放在模块级是为了让 dev-server 复用同一份实现，
 * 否则调试服务器里翻译不会写任务日志、行为与宿主不一致。
 */
export function createStreams() {
  return {
    translate: async function* translateStream(body, options) {
      const persistent = Boolean(body && body.persistent) && !String((body && body.text) || '').trim() && Boolean(body && body.id)
      if (persistent) {
        const mgr = await getTranslateJobs()
        const job = body.resume ? await mgr.resumeJob(String(body.id), body) : await mgr.startJob(body)
        yield* mgr.stream(job.id, { signal: options && options.signal, replay: true })
        return
      }
      const ai = await engine()
      const id = body && body.id ? String(body.id) : ''
      const job = id
        ? await safeJob((logger) =>
            logger.start(id, 'translate', {
              keys: Array.isArray(body.keys) ? body.keys.length : 0,
              sectionIds: Array.isArray(body.sectionIds) ? body.sectionIds.length : 0,
              titles: Boolean(body.titles),
            }),
          )
        : null
      let done = 0
      let failed = 0
      try {
        for await (const frame of ai.translate(body, options)) {
          if (frame && frame.event === 'done') done += 1
          else if (frame && frame.event === 'error') failed += 1
          yield frame
        }
        // 客户端断开（signal aborted）时记 canceled：记 ok 会让日志抽屉显示「翻译完成」，
        // 而用户其实什么都没拿到。
        const aborted = Boolean(options && options.signal && options.signal.aborted)
        if (job) {
          await safeJob((logger) =>
            aborted ? logger.finish(job, 'cancelled', { done, failed }) : logger.finish(job, 'ok', { done, failed }),
          )
        }
      } catch (error) {
        if (job) {
          const aborted = Boolean(options && options.signal && options.signal.aborted)
          await safeJob((logger) => (aborted ? logger.finish(job, 'cancelled', { done, failed }) : logger.fail(job, error)))
        }
        throw error
      }
    },
    translateFollow: async function* translateFollowStream(body, options) {
      const key = String((body && (body.jobId || body.id)) || '').trim()
      if (!key) throw new Error('缺少 id 或 jobId')
      const mgr = await getTranslateJobs()
      yield* mgr.stream(key, {
        signal: options && options.signal,
        replay: !(body && body.replay === false),
      })
    },
    chat: async function* chatStream(body, options) {
      const ai = await engine()
      yield* ai.chat(body, options)
    },
    // 原生会话：把 sessionController.follow 的帧转成 SSE 的 frame 事件，前端自己渲染。
    // body.conversationId 走「一个对话一个会话」（可带多篇论文）；body.id 是旧的单篇用法。
    session: async function* sessionStream(body, options) {
      const b = await bridge()
      if (!b.available()) throw new Error('原生会话不可用：这个宿主没有 sessionController')
      const conversationId = String((body && body.conversationId) || '')
      const id = String((body && body.id) || '')
      if (!conversationId && !id) throw new Error('缺少 id')
      let target = id
      let sessionId = ''
      let cwd = DATA_ROOT
      if (conversationId) {
        const conv = await getConversation(conversationId)
        if (!conv) throw new Error('对话不存在：' + conversationId)
        const papers = await papersForConversation(conv)
        sessionId = conv.sessionId
        target = conversationId
        cwd = papers.length > 0 && papers[0].path ? path.dirname(papers[0].path) : DATA_ROOT
      } else {
        const pdf = await resolvePdf(id).catch(() => null)
        cwd = pdf && pdf.path ? path.dirname(pdf.path) : DATA_ROOT
      }
      const scopedBridge = sessionId ? await bridge(sessionId) : b
      await scopedBridge.ensure(target, { cwd, sessionId })
      if (conversationId) await paperContext.get({ conversationId })
      for await (const frame of scopedBridge.follow(target, {
        signal: options && options.signal,
        maxMessages: 200,
        sessionId,
      })) {
        yield { event: 'frame', data: b.normalizeFrame(frame) }
      }
    },
  }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-paper-workbench] webServer 服务不可用，插件未加载')
    return
  }

  // v2：流式 AI。包一层 async generator，ai.js 缺失时错误会以 SSE error 事件交给前端，
  // 而不是让整个 HTTP handler 崩掉。v3 起顺手把进度写进任务日志（日志坏了不影响翻译）。
  const streams = createStreams()

  const api = createApi()
  const handleRequest = createHandler({ api, appDir: APP_DIR, prefix: PREFIX, streams })
  // webServer 的原始前缀路由不保证默认认证；每次请求都由宿主 connection 判定身份。
  const handler = (req, res) => {
    let refused = 503
    try {
      const connection = ctx.get('connection')
      if (typeof connection?.requestRejection === 'function') refused = connection.requestRejection(req)
    } catch {
      // 服务缺失、卸载或认证异常均拒绝，不能退回 Host / Origin 校验。
    }
    if (refused !== undefined) {
      const status = refused === 401 || refused === 403 ? refused : 503
      const error = status === 401 ? '请先登录 DSH，再打开论文工作台'
        : status === 403 ? '宿主拒绝此请求，请从已授权的 DSH 界面访问'
          : '宿主认证服务不可用，请检查 DSH 的 connection 服务并重新加载插件'
      json(res, status, { ok: false, error })
      return
    }
    return handleRequest(req, res)
  }
  console.log('[dsh-paper-workbench] 宿主已加载，静态目录：' + APP_DIR)

  ctx.effect(() => webServer.register({ kind: 'prefix', path: PREFIX, handler }))

  // 宿主模型服务：可选依赖。headless 或没配模型适配器时缺席，阅读功能不受影响。
  ctx.inject(['llm', 'agentDefaultModel'], (rctx) => {
    setAiRuntime({ llm: rctx.llm, agentDefaultModel: rctx.agentDefaultModel })
    try {
      rctx.effect(() => () => setAiRuntime({ llm: null, agentDefaultModel: null }))
    } catch {
      /* 老版本 cordis 没有 effect 时忽略：进程退出时句柄自然失效 */
    }
    console.log('[dsh-paper-workbench] 已接入宿主模型服务')
  })

  // v3：原生会话（侧边对话落到真正的 DSH 会话）。同样可选：headless 下没有这两个服务。
  ctx.inject(['sessionController', 'workspaceController'], (rctx) => {
    // workspaceRegistry 只用来「按标题复用工作区」；它缺席时桥会退回 workspaceController。
    let registry = null
    try {
      registry = rctx.get('workspaceRegistry') || null
    } catch {
      registry = null
    }
    setSessionRuntime({
      sessionController: rctx.sessionController,
      workspaceController: rctx.workspaceController,
      workspaceRegistry: registry,
    })
    try {
      rctx.effect(() => () => setSessionRuntime({ sessionController: null, workspaceController: null, workspaceRegistry: null }))
    } catch {
      /* 同上 */
    }
    console.log('[dsh-paper-workbench] 已接入原生会话服务')
  })

  // Serial agent/created runs before the first turn for startup/resume/clear/compact.
  // Inject ['agents'] only and resolve agentPresets optionally so DSH versions with or without agentPresets work.
  ctx.inject(['agents'], rctx => {
    let presets = rctx.agentPresets || null
    if (!presets && typeof rctx.get === 'function') {
      try {
        presets = rctx.get('agentPresets') || null
      } catch {
        presets = null
      }
    }
    if (typeof rctx.on === 'function') {
      rctx.on('agent/created', async function (payload) {
        await paperContext.onAgentCreated(payload && payload.agent)
      })
      rctx.on('agent/disposed', function (payload) {
        const agent = payload && payload.agent
        paperContext.onAgentDisposed(agent)
        if (agent && agent.id) conversationBridges.get(agent.id)?.forget()
      })
    }
    const initScope = () => {
      setPaperContextRuntime({ agents: rctx.agents, agentPresets: presets }).catch(error => {
        console.error('[dsh-paper-workbench] 论文会话上下文初始化失败：' + error.message)
      })
    }
    try {
      rctx.effect(() => {
        initScope()
        return () => paperContext.dispose()
      })
    } catch {
      initScope()
    }
  })

  // 确保「论文」专属工作区 Skills 与 AGENTS.md 已部署到位（幂等，不影响已有用户自定义内容）
  workspaceSettings()
    .then((ws) => (ws && ws.path ? mod('workspace-skills').then((m) => m.ensureWorkspaceSkills(ws.path)) : null))
    .catch(() => {})

  // agent 工具：让原生会话能直接读写文献库 / PDF / Obsidian
  ctx.effect(() => {
    const disposers = registerTools(ctx, api)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 注销失败不影响卸载 */
        }
      }
    }
  })
}
