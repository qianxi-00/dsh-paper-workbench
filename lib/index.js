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
import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DATA_ROOT,
  CONFIG_FILE,
  PAGES_DIR,
  addPaper,
  clearTrans,
  deleteTransKeys,
  ensureDirs,
  getConfig,
  getMeta,
  listPapers,
  listTrash,
  purgeTrash,
  readChat,
  readNotes,
  readOcr,
  readOcrJob,
  readReview,
  readTextCache,
  readTrans,
  readUiState,
  readZh,
  removePaper,
  resolvePdf,
  restoreTrash,
  setConfig,
  updateMeta,
  writeChat,
  writeNotes,
  writeOcr,
  writeOcrJob,
  writeReview,
  writeTextCache,
  writeTrans,
  writeUiState,
} from './store.js'
import { extractText as pdfText, findPython, info as pdfInfo, loadText, outline as pdfOutline, renderPage, searchText } from './pdf.js'
import { createHandler } from './server.js'
import { registerTools } from './tools.js'

export const name = 'dsh-paper-workbench'
export const inject = ['webServer', 'tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const APP_DIR = path.join(ROOT, 'assets', 'app')
export const PREFIX = '/paper-workbench'

// ---------------------------------------------------------------- 延迟加载的兄弟模块
// 为什么延迟：这两个模块可能还没写完/被用户删掉，静态 import 会让整个插件加载失败，
// 表现是左栏入口直接消失。模块级缓存保证只 import 一次。
const lazyModules = new Map()
async function mod(name) {
  if (!lazyModules.has(name)) {
    lazyModules.set(name, import('./' + name + '.js'))
  }
  try {
    return await lazyModules.get(name)
  } catch (error) {
    lazyModules.delete(name)
    throw new Error('内部模块 ' + name + '.js 不可用：' + (error && error.message ? error.message : String(error)))
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
let sessionRuntime = { sessionController: null, workspaceController: null }

export function setSessionRuntime(next) {
  sessionRuntime = {
    sessionController: (next && next.sessionController) || null,
    workspaceController: (next && next.workspaceController) || null,
  }
  sessionBridge = null
  return sessionRuntime
}

export function getSessionRuntime() {
  return sessionRuntime
}

let sessionBridge = null
async function bridge() {
  if (sessionBridge === null) {
    const sessionModule = await mod('session')
    sessionBridge = sessionModule.createSessionBridge({
      getServices: () => ({ ...aiRuntime, ...sessionRuntime }),
      dataRoot: DATA_ROOT,
    })
  }
  return sessionBridge
}

// 任务日志：落 SQLite（lib/db.js），给界面底部「日志」抽屉用。
let jobLogger = null
async function jobs() {
  if (jobLogger === null) {
    const [jobsModule, db] = await Promise.all([mod('jobs'), mod('db')])
    jobLogger = jobsModule.createJobLogger({
      append: (paperId, event) => db.jobAppend(paperId, event),
      list: (paperId, opts) => db.jobList(paperId, opts),
      clear: (paperId) => db.jobClear(paperId),
    })
  }
  return jobLogger
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

function ocrModelOf(config) {
  const model = String((config.ocr && config.ocr.model) || OCR_DEFAULT_MODEL)
  return OCR_MODELS.includes(model) ? model : OCR_DEFAULT_MODEL
}

/** 给配置做一份可安全回给浏览器的副本：没有 token，只有「配没配 / 尾号」。 */
function publicConfig(config) {
  const token = String((config.ocr && config.ocr.token) || '')
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
  const meta = await getMeta(id)
  const config = await getConfig()
  const token = String((config.ocr && config.ocr.token) || '')
  if (!token) throw new Error('还没有配置 PaddleOCR 的 API Key：在工作台「设置 → 扫描件 OCR」里填入后保存。')
  const running = ocrJobs.get(id)
  if (running && (running.state === 'pending' || running.state === 'running')) {
    return ocrStatusOf(id)
  }
  const pdf = await resolvePdf(id)
  const model = modelArg && OCR_MODELS.includes(modelArg) ? modelArg : ocrModelOf(config)
  const record = {
    state: 'pending',
    model,
    jobId: '',
    totalPages: 0,
    extractedPages: 0,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    error: '',
    pages: 0,
  }
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
          record.state = info.state === 'done' ? 'done' : info.state || 'running'
          if (info.totalPages) record.totalPages = info.totalPages
          if (typeof info.extractedPages === 'number' && info.extractedPages >= 0) record.extractedPages = info.extractedPages
          void persist()
        },
      })
      await writeOcr(id, result.markdown)
      // 扫描件建模依赖 ocr.md：OCR 换了内容必须让 doc 重建
      ;(await mod('doc')).invalidateDocCache(id)
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

export function createApi() {
  return {
    // --- 二进制钩子（由 server.js 调用）
    pageImage: async ({ id, page, scale }) => {
      const meta = await getMeta(id)
      const pdf = await resolvePdf(meta.id)
      const p = Math.max(1, Number(page) || 1)
      const s = Math.min(4, Math.max(0.5, Number(scale) || 2))
      const target = pageImageFile(meta.id, p, s)
      const sourceStat = await fsp.stat(pdf.path)
      const cached = await fsp.stat(target).catch(() => null)
      if (cached === null || cached.mtimeMs < sourceStat.mtimeMs) {
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await renderPage(pdf.path, p, target, s)
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
      const temp = path.join(tempDir, 'up-' + Date.now().toString(36) + '.pdf')
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
        const dbModule = await mod('db')
        db = dbModule.dbInfo()
      } catch (error) {
        db = { engine: 'unavailable', error: error && error.message ? error.message : String(error) }
      }
      return {
        ok: true,
        plugin: 'dsh-paper-workbench',
        phase: 'p3',
        root: ROOT,
        dataRoot: DATA_ROOT,
        papers: papers.length,
        pdf: python === null ? { ok: false, python: '' } : { ok: true, python: python.python, version: python.version },
        vault: vault.ok ? { ok: true, vault: vault.vault, kb: vault.kb } : { ok: false, error: vault.error },
        ocr: { configured: token.length > 0, model: ocrModelOf(config) },
        ai,
        db,
        session: { available: Boolean(sessionRuntime.sessionController), idPrefix: 'pb-' },
        time: new Date().toISOString(),
      }
    },

    'settings.get': async () => ({ config: publicConfig(await getConfig()), dataRoot: DATA_ROOT }),

    'settings.set': async (args) => {
      const patch = { ...((args && args.patch) || {}) }
      // ocr.token：非空字符串=换新；null=清除；其它（省略或空串）=保持原样。
      // 这样界面上的掩码输入框留空不会误删已保存的 Key。
      if (patch.ocr && typeof patch.ocr === 'object') {
        const current = (await getConfig()).ocr || {}
        const next = { ...current }
        for (const key of ['model', 'orient', 'unwarp', 'chart']) {
          if (patch.ocr[key] !== undefined) next[key] = patch.ocr[key]
        }
        if (patch.ocr.token === null) next.token = ''
        else if (typeof patch.ocr.token === 'string' && patch.ocr.token.trim() !== '') next.token = patch.ocr.token.trim()
        patch.ocr = next
      }
      const before = patch.ocr ? { ...(await getConfig()).ocr } : null
      const config = await setConfig(patch)
      invalidateVault()
      if (before && before.token && !(config.ocr && config.ocr.token)) {
        // Key 被清掉是破坏性操作：留一行日志，事后能查到是什么时候没的
        console.warn('[paper-workbench] PaddleOCR Key 已被清除（settings.set 传了 token:null）')
      }
      if (patch.ocr && typeof patch.ocr === 'object' && config.ocr && config.ocr.token) {
        // 配置文件里存的是明文 Key：把权限收紧到仅本人可读写。
        await fsp.chmod(CONFIG_FILE, 0o600).catch(() => {})
      }
      return { config: publicConfig(config) }
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
      const meta = await updateMeta(args && args.id, (args && args.patch) || {})
      // 状态/优先级同时同步到 Obsidian 卡片（失败不影响库操作）
      if (args && args.patch && (args.patch.status || args.patch.priority)) {
        try {
          const vault = await vaultContext()
          if (vault.ok) {
            const card = await vault.obs.locateCard(vault.kb, {
              source: meta.srcPath,
              sourceRelative: meta.vaultCard,
              title: meta.title,
            })
            if (card) await vault.obs.setStatus(vault.kb, card.path, meta.status, meta.priority)
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
      spawn('cmd', ['/c', 'start', '', pdf.path], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
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
      return { items: (await arxiv.searchBoth({ query, limit })).items, source: 'both' }
    },

    'search.import': async (args) => {
      const arxiv = await mod('arxiv')
      const item = (args && args.item) || {}
      if (!item.pdfUrl) throw new Error('这条结果没有开放获取的 PDF 链接')
      await ensureDirs()
      const tempDir = path.join(DATA_ROOT, '.tmp')
      await fsp.mkdir(tempDir, { recursive: true })
      const temp = path.join(tempDir, 'dl-' + Date.now().toString(36) + '.pdf')
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
      const card = await vault.obs.readCard(target)
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
      const obs = await mod('obsidian')
      const target = String((args && args.path) || '')
      if (!target) throw new Error('缺少 path')
      return { ok: obs.openInObsidian(target) }
    },

    // --- v2：段落级文档模型
    'doc.get': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const [doc, storeModule] = await Promise.all([mod('doc'), mod('store')])
      const result = await doc.getDoc(id, { rebuild: Boolean(args && args.rebuild) })
      const trans = await storeModule.readTrans(id)
      return {
        doc: result.doc,
        built: Boolean(result.built),
        stale: Boolean(result.stale),
        ms: result.ms,
        trans: { entries: trans.entries, model: trans.model },
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

    'ai.settings.get': async () => ({ config: publicConfig(await getConfig()) }),

    'ai.settings.set': async (args) => {
      const raw = (args && args.patch) || {}
      // 允许两种写法：{ ai: {...} } 或直接 {...}
      const patch = raw.ai && typeof raw.ai === 'object' ? raw.ai : raw
      const current = (await getConfig()).ai || {}
      const next = { ...current }
      for (const key of ['translateModel', 'chatModel']) {
        if (patch[key] !== undefined) next[key] = sanitizeModelChoice(patch[key])
      }
      if (patch.target !== undefined) next.target = String(patch.target || 'zh') === 'zh' ? 'zh' : 'zh'
      if (patch.concurrency !== undefined) next.concurrency = Math.min(4, Math.max(1, Number(patch.concurrency) || 1))
      if (patch.temperature !== undefined) {
        const value = Number(patch.temperature)
        next.temperature = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.2
      }
      const config = await setConfig({ ai: next })
      return { config: publicConfig(config) }
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
      for (const section of doc.sections || []) scan('t:' + section.id, section.title, 'title', section.id, section.page)
      for (const paragraph of doc.paragraphs || []) scan(paragraph.key, paragraph.text, paragraph.kind, paragraph.sectionId, paragraph.page)
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
      return logger.list(id, { after: Number(args && args.after) || 0, limit: Number(args && args.limit) || 200 })
    },

    'logs.clear': async (args) => {
      const id = String((args && args.id) || '')
      if (!id) throw new Error('缺少 id')
      const logger = await jobs()
      return { cleared: logger.clear(id) }
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

    'session.ask': async (args) => {
      const id = String((args && args.id) || '')
      const text = String((args && args.text) || '').trim()
      if (!id) throw new Error('缺少 id')
      if (!text) throw new Error('问题是空的')
      const b = await bridge()
      const pdf = await resolvePdf(id).catch(() => null)
      const cwd = pdf && pdf.path ? path.dirname(pdf.path) : DATA_ROOT
      return b.ask(id, text, { cwd })
    },

    // 界面状态（当前论文 / 页签 / 页码 / 滚动位置）：存服务端，桌面端重启换了端口也不丢
    'ui.get': async () => ({ state: await readUiState() }),

    'ui.set': async (args) => {
      const patch = args && args.state && typeof args.state === 'object' ? args.state : null
      if (!patch) throw new Error('缺少 state')
      const allowed = ['paperId', 'tab', 'page', 'scrollTop', 'sectionId', 'layout', 'expanded']
      const clean = {}
      for (const key of allowed) if (key in patch) clean[key] = patch[key]
      const merged = { ...(await readUiState()), ...clean }
      await writeUiState(merged)
      return { ok: true, state: merged }
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
        if (job) await safeJob((logger) => logger.finish(job, 'ok', { done, failed }))
      } catch (error) {
        if (job) await safeJob((logger) => logger.fail(job, error))
        throw error
      }
    },
    chat: async function* chatStream(body, options) {
      const ai = await engine()
      yield* ai.chat(body, options)
    },
    // 原生会话：把 sessionController.follow 的帧转成 SSE 的 frame 事件，前端自己渲染。
    session: async function* sessionStream(body, options) {
      const b = await bridge()
      const id = String((body && body.id) || '')
      if (!id) throw new Error('缺少 id')
      if (!b.available()) throw new Error('原生会话不可用：这个宿主没有 sessionController')
      const pdf = await resolvePdf(id).catch(() => null)
      const cwd = pdf && pdf.path ? path.dirname(pdf.path) : DATA_ROOT
      await b.ensure(id, { cwd })
      for await (const frame of b.follow(id, { signal: options && options.signal, maxMessages: 200 })) {
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
  const handler = createHandler({ api, appDir: APP_DIR, prefix: PREFIX, streams })
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
    setSessionRuntime({ sessionController: rctx.sessionController, workspaceController: rctx.workspaceController })
    try {
      rctx.effect(() => () => setSessionRuntime({ sessionController: null, workspaceController: null }))
    } catch {
      /* 同上 */
    }
    console.log('[dsh-paper-workbench] 已接入原生会话服务')
  })

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
