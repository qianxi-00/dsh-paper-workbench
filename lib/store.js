/**
 * 本地存储：配置、文献索引、每篇论文的目录。
 *
 * 设计要点：
 *   - 元数据/文档模型/笔记落普通文件（用户能自己看、能拷走）；
 *   - 逐段译文、任务日志、自检结果落 SQLite（`lib/db.js`），量大、要按 key 查、要能增量写；
 *   - index.json 的读改写串行化，写用 tmp+rename 原子替换，并留一份 .bak；
 *   - 论文 id 只允许 [a-z0-9._-]，防止拼路径时被 ../ 逃逸；
 *   - 默认不复制 PDF（storage:'link' 只记原路径），省磁盘也省得搬运大文件。
 */
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import {
  makeConversation,
  mergeConversation,
  normalizeChats,
  normalizeConversation,
  normalizePaperIds,
} from './conv.js'

export const DATA_ROOT = process.env.DSH_PAPER_WORKBENCH_DATA
  ? path.resolve(process.env.DSH_PAPER_WORKBENCH_DATA)
  : path.join(os.homedir(), '.dsh', 'paper-workbench')
export const PAPERS_DIR = path.join(DATA_ROOT, 'papers')
export const PAGES_DIR = path.join(DATA_ROOT, '.pages')
export const TRASH_DIR = path.join(DATA_ROOT, '.trash')
export const CONFIG_FILE = path.join(DATA_ROOT, 'config.json')
export const INDEX_FILE = path.join(DATA_ROOT, 'index.json')
export const CHATS_FILE = path.join(DATA_ROOT, 'chats.json')
export const CHATS_DIR = path.join(DATA_ROOT, 'chats')

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/

const DEFAULT_CONFIG = {
  version: 1,
  // link: 库里只记原路径；copy: 把 PDF 复制进 papers/<id>/paper.pdf
  storage: 'link',
  // 留空则自动探测（Anaconda → python → py）
  python: '',
  // 留空则自动从 Obsidian 配置里找 open 的 vault 与「论文知识库」目录
  vault: '',
  kb: '',
  // 扫描件 OCR：调 PaddleOCR 云端（AISTUDIO）接口。token 只存在本机配置文件里，
  // 不写进仓库、不进日志、不回给客户端明文（settings.get 只回掩码）。
  ocr: {
    token: '',
    model: 'PaddleOCR-VL-1.6',
    // 提交任务时附带的版面选项，与官方示例一致（默认全关，避免额外耗时）
    orient: false,
    unwarp: false,
    chart: false,
  },
  // v2 内置 AI：null 表示跟随 DSH 当前模型（agentDefaultModel.currentSelection）。
  // 翻译与对话各自可选一个模型；target 留字段是为以后加别的目标语言。
  ai: {
    translateModel: null,
    chatModel: null,
    target: 'zh',
    concurrency: 1,
    temperature: 0.2,
  },
  // 面板偏好，客户端读写
  ui: { tab: 'library', zoom: 'fit-width' },
}

/** 深合并一层：只用于 config 这种扁平对象，避免把默认值整个覆盖掉。 */
function mergeShallow(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = { ...base[key], ...value }
    } else {
      out[key] = value
    }
  }
  return out
}

export async function ensureDirs() {
  await fsp.mkdir(DATA_ROOT, { recursive: true })
  await fsp.mkdir(PAPERS_DIR, { recursive: true })
  await fsp.mkdir(PAGES_DIR, { recursive: true })
}

export async function readJson(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    // 坏文件不要静默吞掉：留给调用方决定，这里只在控制台提示一次
    console.error('[paper-workbench] 读取 JSON 失败 ' + file + '：' + (error && error.message))
    return fallback
  }
}

/** 原子写：同目录 tmp → rename；rename 在 Windows 上覆盖已存在文件是安全的。 */
export async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36)
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

// ---------------------------------------------------------------- 配置

let configCache = null

export async function getConfig() {
  if (configCache !== null) return configCache
  await ensureDirs()
  const stored = await readJson(CONFIG_FILE, {})
  configCache = mergeShallow(DEFAULT_CONFIG, stored)
  return configCache
}

export async function setConfig(patch) {
  const next = mergeShallow(await getConfig(), patch)
  await writeJsonAtomic(CONFIG_FILE, next)
  configCache = next
  return next
}

// ---------------------------------------------------------------- 索引

export function assertId(id) {
  const value = String(id || '')
  if (!ID_RE.test(value)) throw new Error('非法的论文 id：' + value)
  return value
}

let indexChain = Promise.resolve()

/** 串行执行索引的读改写，避免两个请求同时写坏 index.json。 */
function withIndex(task) {
  const run = indexChain.then(task, task)
  indexChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function readIndex() {
  const data = await readJson(INDEX_FILE, null)
  if (data && Array.isArray(data.papers)) return { version: 1, papers: data.papers }
  // 首次使用或文件损坏：从 papers/*/meta.json 重建，尽最大努力救回数据
  const papers = []
  let entries = []
  try {
    entries = await fsp.readdir(PAPERS_DIR, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const meta = await readJson(path.join(PAPERS_DIR, entry.name, 'meta.json'), null)
    if (meta && meta.id) papers.push(meta)
  }
  return { version: 1, papers }
}

async function writeIndex(index) {
  const snapshot = { version: 1, papers: index.papers }
  // 保留上一版，坏写不会把整个库弄丢
  try {
    await fsp.copyFile(INDEX_FILE, INDEX_FILE + '.bak')
  } catch {
    /* 第一次写时没有旧文件，忽略 */
  }
  await writeJsonAtomic(INDEX_FILE, snapshot)
}

export async function listPapers() {
  const index = await withIndex(readIndex)
  return index.papers.slice().sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')))
}

export async function getMeta(id) {
  const safe = assertId(id)
  // 优先读单篇 meta.json（索引可能落后于磁盘），没有再查索引
  const meta = await readJson(path.join(PAPERS_DIR, safe, 'meta.json'), null)
  if (meta && meta.id === safe) return meta
  const index = await withIndex(readIndex)
  const found = index.papers.find((item) => item.id === safe)
  if (!found) throw new Error('论文不存在：' + safe)
  return found
}

export function paperDir(id) {
  return path.join(PAPERS_DIR, assertId(id))
}

export function paperFile(id, name) {
  return path.join(paperDir(id), name)
}

/** 生成稳定、可读、可当目录名的 id：arXiv 号优先，其次 DOI，最后标题摘要。 */
export function makeId(meta) {
  const base =
    (meta.arxivId && String(meta.arxivId)) ||
    (meta.doi && String(meta.doi)) ||
    (meta.title && String(meta.title)) ||
    'paper'
  let slug = String(base)
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  if (!slug || !/^[a-z0-9]/.test(slug)) slug = 'paper-' + slug.replace(/[^a-z0-9]/g, '')
  const hash = createHash('sha1')
    .update(String(meta.title || '') + String(meta.srcPath || '') + String(Date.now()) + String(Math.random()))
    .digest('hex')
    .slice(0, 6)
  return (slug + '-' + hash).slice(0, 80)
}

/**
 * 入库：写 papers/<id>/meta.json 并更新索引。
 * 同一篇（srcPath 相同，或 arxivId/doi 相同）不重复入库，返回已有记录。
 */
export async function addPaper(meta) {
  await ensureDirs()
  const normalized = { ...meta }
  normalized.srcPath = normalized.srcPath ? path.resolve(String(normalized.srcPath)) : ''

  const id = normalized.id && ID_RE.test(normalized.id) ? normalized.id : makeId(normalized)
  const now = new Date().toISOString()
  const record = {
    id,
    title: normalized.title || '未命名论文',
    authors: Array.isArray(normalized.authors) ? normalized.authors : [],
    year: normalized.year || '',
    venue: normalized.venue || '',
    arxivId: normalized.arxivId || '',
    doi: normalized.doi || '',
    abstract: normalized.abstract || '',
    url: normalized.url || '',
    topics: Array.isArray(normalized.topics) ? normalized.topics : [],
    tags: Array.isArray(normalized.tags) ? normalized.tags : [],
    status: normalized.status || 'unread',
    priority: normalized.priority || 'normal',
    storage: normalized.storage || 'link',
    srcPath: normalized.srcPath,
    originPath: normalized.originPath || normalized.srcPath,
    pageCount: normalized.pageCount || 0,
    hasText: normalized.hasText !== false,
    vaultCard: normalized.vaultCard || '',
    contentHash: normalized.contentHash || '',
    lastReadPage: normalized.lastReadPage || 1,
    zhPages: normalized.zhPages || 0,
    addedAt: normalized.addedAt || now,
    updatedAt: now,
  }

  // 查重 + 建目录 + 写索引必须在同一个临界区里：
  // 并行导入同一个 PDF 时，分成两段「先读后写」会各插一条（2026-11-11 实测重复了 31 对）。
  return withIndex(async () => {
    const index = await readIndex()
    const target = normalized.srcPath.toLowerCase()
    const found = index.papers.find((item) => {
      if (target && item.srcPath && path.resolve(item.srcPath).toLowerCase() === target) return true
      if (target && item.originPath && path.resolve(item.originPath).toLowerCase() === target) return true
      // 同一份 PDF 被复制成两个文件名、放进两个目录时 srcPath 挡不住，只能比内容指纹
      if (normalized.contentHash && item.contentHash && item.contentHash === normalized.contentHash) return true
      if (normalized.arxivId && item.arxivId && String(item.arxivId) === String(normalized.arxivId)) return true
      if (normalized.doi && item.doi && String(item.doi).toLowerCase() === String(normalized.doi).toLowerCase()) return true
      return false
    })
    if (found) return { meta: found, existed: true }

    const dir = paperDir(record.id)
    await fsp.mkdir(dir, { recursive: true })
    await writeJsonAtomic(path.join(dir, 'meta.json'), record)
    index.papers = index.papers.filter((item) => item.id !== record.id)
    index.papers.push(record)
    await writeIndex(index)
    return { meta: record, existed: false }
  })
}

export async function updateMeta(id, patch) {
  const safe = assertId(id)
  return withIndex(async () => {
    const index = await readIndex()
    const position = index.papers.findIndex((item) => item.id === safe)
    if (position < 0) throw new Error('论文不存在：' + safe)
    const allowed = [
      'title', 'authors', 'year', 'venue', 'arxivId', 'doi', 'abstract', 'url',
      'topics', 'tags', 'status', 'priority', 'storage', 'srcPath', 'originPath', 'outline',
      'pageCount', 'hasText', 'vaultCard', 'lastReadPage', 'zhPages', 'contentHash',
    ]
    const next = { ...index.papers[position] }
    for (const key of allowed) {
      if (patch && patch[key] !== undefined) next[key] = patch[key]
    }
    next.updatedAt = new Date().toISOString()
    index.papers[position] = next
    await writeJsonAtomic(path.join(PAPERS_DIR, safe, 'meta.json'), next)
    await writeIndex(index)
    return next
  })
}

/** 删除 = 移进 .trash（目录整体搬家），索引里移除。 */
export async function removePaper(id) {
  const safe = assertId(id)
  return withIndex(async () => {
    const index = await readIndex()
    const record = index.papers.find((item) => item.id === safe)
    if (!record) throw new Error('论文不存在：' + safe)
    await fsp.mkdir(TRASH_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(TRASH_DIR, safe + '-' + stamp)
    try {
      await fsp.rename(paperDir(safe), target)
    } catch (error) {
      // 目录不存在也算删除成功（索引脏数据）
      if (!error || error.code !== 'ENOENT') throw error
    }
    index.papers = index.papers.filter((item) => item.id !== safe)
    await writeIndex(index)
    return { id: safe, trashed: target }
  })
}

// ---------------------------------------------------------------- 每篇论文的文件

export function pdfPathOf(meta) {
  const local = paperFile(meta.id, 'paper.pdf')
  return { local, src: meta.srcPath ? path.resolve(meta.srcPath) : '' }
}

/** 找可用的 PDF：优先库内副本，其次原路径。 */
export async function resolvePdf(id) {
  const meta = await getMeta(id)
  const { local, src } = pdfPathOf(meta)
  for (const candidate of [local, src]) {
    if (!candidate) continue
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isFile() && stat.size > 0) return { path: candidate, meta }
    } catch {
      /* 换下一个候选 */
    }
  }
  throw new Error('找不到 PDF 文件：' + (src || local) + '（可能已被移动或删除）')
}

export async function readTextCache(id) {
  return readJson(paperFile(id, 'text.json'), null)
}

export async function writeTextCache(id, value) {
  await writeJsonAtomic(paperFile(id, 'text.json'), value)
}

export async function readNotes(id) {
  return readJson(paperFile(id, 'notes.json'), { highlights: [] })
}

export async function writeNotes(id, notes) {
  await writeJsonAtomic(paperFile(id, 'notes.json'), notes)
}

export async function readZh(id) {
  try {
    return await fsp.readFile(paperFile(id, 'zh.md'), 'utf8')
  } catch {
    return ''
  }
}

export async function writeZhAppend(id, chunk) {
  await fsp.appendFile(paperFile(id, 'zh.md'), chunk, 'utf8')
}

// ---------------------------------------------------------------- OCR（扫描件）

/** OCR 任务状态：papers/<id>/ocr.json；失败留错误信息，便于界面显示原因。 */
export async function readOcrJob(id) {
  return readJson(paperFile(id, 'ocr.json'), null)
}

export async function writeOcrJob(id, value) {
  await writeJsonAtomic(paperFile(id, 'ocr.json'), value)
}

/** OCR 正文：papers/<id>/ocr.md，按 `## p.N` 分段（与 zh.md 同一约定）。 */
export async function readOcr(id) {
  try {
    return await fsp.readFile(paperFile(id, 'ocr.md'), 'utf8')
  } catch {
    return ''
  }
}

export async function writeOcr(id, markdown) {
  await writeFileAtomic(paperFile(id, 'ocr.md'), markdown)
}

// ---------------------------------------------------------------- v2：文档模型 / 译文 / 对话

/** 文档模型：papers/<id>/doc.json（由 lib/doc.js 生成，可随时重建）。 */
export async function readDoc(id) {
  const value = await readJson(paperFile(id, 'doc.json'), null)
  return value && typeof value === 'object' ? value : null
}

export async function writeDoc(id, doc) {
  await writeJsonAtomic(paperFile(id, 'doc.json'), doc)
  return doc
}

export async function removeDoc(id) {
  await fsp.rm(paperFile(id, 'doc.json'), { force: true }).catch(() => {})
}

/**
 * 逐段译文：SQLite（`lib/db.js` 的 translations 表）。
 *
 * entries 以「段落 hash」或「t:<标题 hash>」为键，和页号、段落顺序解耦：
 * PDF 重新导入但文字没变时，旧译文仍然命中。
 * 老版本的 `papers/<id>/trans.json` 会在第一次读取时自动导进库，之后不再写文件。
 */
let dbModule = null
async function loadDb() {
  if (!dbModule) dbModule = await import('./db.js')
  return dbModule
}

/**
 * 关掉 SQLite 连接。WAL 模式会在库旁边留 -wal/-shm 文件，
 * 测试清理临时目录、备份或恢复数据库之前必须先调它，否则 Windows 上会 EBUSY。
 */
export async function closeDb() {
  if (!dbModule) return false
  try {
    return dbModule.closeDb()
  } catch {
    return false
  }
}

function modelToDb(model) {
  if (!model) return ''
  if (typeof model === 'string') return model
  try {
    return JSON.stringify(model)
  } catch {
    return ''
  }
}

function modelFromDb(text) {
  if (!text) return null
  if (typeof text !== 'string') return text
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text)
      return value && typeof value === 'object' ? value : text
    } catch {
      return text
    }
  }
  return text
}

export async function readTrans(id) {
  const safe = assertId(id)
  const { transAll, migrateTransJson } = await loadDb()
  let value = transAll(safe)
  let entries = value && value.entries && typeof value.entries === 'object' ? value.entries : {}
  if (Object.keys(entries).length === 0) {
    const legacy = await readJson(paperFile(safe, 'trans.json'), null)
    const legacyEntries = legacy && legacy.entries && typeof legacy.entries === 'object' ? legacy.entries : null
    if (legacyEntries && Object.keys(legacyEntries).length) {
      await migrateTransJson(safe, legacy)
      // 迁移完把老文件改名：否则用户删掉某段译文后，下次读又会被当成「空库」重新导入一遍
      await fsp.rename(paperFile(safe, 'trans.json'), paperFile(safe, 'trans.json.migrated')).catch(() => {})
      value = transAll(safe)
      entries = value && value.entries ? value.entries : {}
    }
  }
  // 库里每个 key 只存纯文本；客户端一直读 entry.zh，这里统一成 { zh, model } 形状
  const shaped = {}
  for (const [key, raw] of Object.entries(entries || {})) {
    if (typeof raw === 'string') shaped[key] = { zh: raw, model: null }
    else if (raw && typeof raw === 'object') shaped[key] = { zh: typeof raw.zh === 'string' ? raw.zh : '', model: raw.model || null }
  }
  return {
    version: 1,
    target: (value && value.target) || 'zh',
    model: modelFromDb(value && value.model),
    updatedAt: (value && value.updatedAt) || null,
    entries: shaped,
  }
}

export async function writeTrans(id, trans) {
  const safe = assertId(id)
  const { transAll, transPut, transDelete } = await loadDb()
  const entries = (trans && trans.entries) || {}
  const target = (trans && trans.target) || 'zh'
  const model = modelToDb(trans && trans.model)
  await transPut(safe, entries, { target, model })
  // 调用方传的是「完整快照」，库里多余的键要删掉（否则重新翻译时删段不会生效）
  const existing = transAll(safe).entries || {}
  const stale = Object.keys(existing).filter((key) => !(key in entries))
  if (stale.length) await transDelete(safe, stale)
  return {
    version: 1,
    target,
    model: modelFromDb(model),
    updatedAt: new Date().toISOString(),
    entries: { ...entries },
  }
}

/** 删掉指定 key 的译文（`trans.clear` 只清指定段落时用）。 */
export async function deleteTransKeys(id, keys) {
  const safe = assertId(id)
  const list = Array.isArray(keys) ? keys.filter((key) => typeof key === 'string' && key) : []
  if (!list.length) return 0
  const { transDelete } = await loadDb()
  return transDelete(safe, list)
}

/** 清空这篇论文的全部译文。 */
export async function clearTrans(id) {
  const safe = assertId(id)
  const { transClear } = await loadDb()
  return transClear(safe)
}

/** 侧边对话历史：papers/<id>/chat.json；裁剪到最近 200 条由调用方负责。 */
export async function readChat(id) {
  const value = await readJson(paperFile(id, 'chat.json'), null)
  const empty = { version: 1, model: null, messages: [] }
  if (!value || typeof value !== 'object') return empty
  return {
    version: 1,
    model: value.model && typeof value.model === 'object' ? value.model : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    messages: Array.isArray(value.messages) ? value.messages : [],
  }
}

export async function writeChat(id, chat) {
  const next = {
    version: 1,
    model: (chat && chat.model) || null,
    updatedAt: new Date().toISOString(),
    messages: (chat && Array.isArray(chat.messages) ? chat.messages : []).slice(-200),
  }
  await writeJsonAtomic(paperFile(id, 'chat.json'), next)
  return next
}

/**
 * 界面状态（当前论文 / 页签 / 页码 / 滚动位置 / 三栏宽度）。
 * 存服务端而不只是 localStorage：桌面端每次重启端口会变，浏览器把它当不同站点，
 * localStorage 就丢了——用户会以为「退出再进又变成新的」。
 */
export async function readUiState() {
  const value = await readJson(path.join(DATA_ROOT, 'ui.json'), null)
  if (!value || typeof value !== 'object') return {}
  return value
}

export async function writeUiState(state) {
  const safe = state && typeof state === 'object' ? state : {}
  const next = { ...safe, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(path.join(DATA_ROOT, 'ui.json'), next)
  return next
}

// ---------------------------------------------------------------- v3：自检结果 / 回收站

/** 翻译自检结果（SQLite reviews 表）。 */
export async function readReview(id) {
  const safe = assertId(id)
  const { reviewGet } = await loadDb()
  return reviewGet(safe)
}

export async function writeReview(id, review) {
  const safe = assertId(id)
  const { reviewPut } = await loadDb()
  const payload = {
    ...(review && typeof review === 'object' ? review : {}),
    at: (review && review.at) || new Date().toISOString(),
  }
  await reviewPut(safe, payload)
  return payload
}

/** 回收站目录名形如 `<id>-2026-11-11T06-42-44-123Z`；id 本身也可能带 -，优先读 meta.json。 */
function trashStamp(name) {
  const match = /-(\d{4}-\d{2}-\d{2}T[\d-]+Z?)$/.exec(name)
  return match ? match[1] : ''
}

export async function listTrash() {
  let names = []
  try {
    names = await fsp.readdir(TRASH_DIR)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const dir = path.join(TRASH_DIR, name)
    let stat = null
    try {
      stat = await fsp.stat(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const meta = await readJson(path.join(dir, 'meta.json'), null)
    const id = meta && meta.id ? meta.id : name.slice(0, Math.max(0, name.length - trashStamp(name).length - 1))
    out.push({
      name,
      id,
      title: (meta && meta.title) || '',
      pages: (meta && Number(meta.pages)) || 0,
      addedAt: (meta && meta.addedAt) || null,
      trashedAt: stat.mtime.toISOString(),
      bytes: 0,
    })
  }
  out.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)))
  return out
}

/** 从回收站恢复：目录搬回 papers/<id>，索引条目按 meta.json 重建。 */
export async function restoreTrash(name) {
  const safeName = path.basename(String(name || ''))
  if (!safeName || safeName !== name) throw new Error('回收站条目名不合法')
  const dir = path.join(TRASH_DIR, safeName)
  const meta = await readJson(path.join(dir, 'meta.json'), null)
  if (!meta || !meta.id) throw new Error('回收站里这一项没有 meta.json，无法恢复')
  const id = assertId(meta.id)
  return withIndex(async () => {
    const index = await readIndex()
    if (index.papers.some((item) => item.id === id)) throw new Error('库里已经有同 id 的论文，先删掉它再恢复')
    const target = paperDir(id)
    try {
      await fsp.stat(target)
      throw new Error('papers/' + id + ' 已存在，先删掉它再恢复')
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
    await fsp.rename(dir, target)
    const record = { ...meta, id }
    index.papers.push(record)
    await writeIndex(index)
    return { id, restored: true }
  })
}

/** 彻底删除回收站条目（不可恢复）。 */
export async function purgeTrash(name) {
  const safeName = path.basename(String(name || ''))
  if (!safeName || safeName !== name) throw new Error('回收站条目名不合法')
  await fsp.rm(path.join(TRASH_DIR, safeName), { recursive: true, force: true })
  return { name: safeName, removed: true }
}

/* ------------------------------------------------------------------ 对话（多篇论文的范围 + 附件） */

/**
 * chats.json 只存「对话的范围」：标题、包含哪几篇、附件清单、对应的宿主会话 id。
 * 对话内容本身在 DSH 的会话里（原生会话），这里不重复存一份历史。
 */
export async function readChats() {
  const raw = await readJson(CHATS_FILE, null)
  return normalizeChats(raw)
}

export async function writeChats(data) {
  const next = normalizeChats(data)
  await writeJsonAtomic(CHATS_FILE, next)
  return next
}

export async function listConversations() {
  return readChats()
}

export async function getConversation(id) {
  const safeId = assertId(id)
  const data = await readChats()
  return data.items.find((item) => item.id === safeId) || null
}

export async function createConversation(input = {}) {
  const conv = makeConversation({
    title: input.title,
    paperIds: normalizePaperIds(input.paperIds),
  })
  const data = await readChats()
  data.items.unshift(conv)
  data.activeId = conv.id
  await writeJsonAtomic(CHATS_FILE, data)
  return conv
}

export async function updateConversation(id, patch = {}) {
  const safeId = assertId(id)
  const data = await readChats()
  const index = data.items.findIndex((item) => item.id === safeId)
  if (index < 0) throw new Error('对话不存在：' + safeId)
  const next = mergeConversation(data.items[index], patch)
  if (!next) throw new Error('对话数据不合法：' + safeId)
  data.items[index] = next
  await writeJsonAtomic(CHATS_FILE, data)
  return next
}

export async function removeConversation(id) {
  const safeId = assertId(id)
  const data = await readChats()
  const before = data.items.length
  data.items = data.items.filter((item) => item.id !== safeId)
  if (data.items.length === before) throw new Error('对话不存在：' + safeId)
  if (data.activeId === safeId) data.activeId = data.items.length > 0 ? data.items[0].id : null
  await writeJsonAtomic(CHATS_FILE, data)
  await fsp.rm(path.join(CHATS_DIR, safeId), { recursive: true, force: true }).catch(() => {})
  return { id: safeId, removed: true, activeId: data.activeId }
}

export async function setActiveConversation(id) {
  const safeId = assertId(id)
  const data = await readChats()
  if (!data.items.some((item) => item.id === safeId)) throw new Error('对话不存在：' + safeId)
  data.activeId = safeId
  await writeJsonAtomic(CHATS_FILE, data)
  return { activeId: safeId }
}

/** 附件名去掉路径与危险字符，重名自动加 (2)(3)。 */
function safeFileName(name) {
  const base = path.basename(String(name || '')).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-').trim()
  const cleaned = base.replace(/^\.+/, '')
  return (cleaned === '' ? 'attachment' : cleaned).slice(0, 120)
}

async function uniqueFilePath(dir, name) {
  const ext = path.extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  for (let n = 1; n <= 99; n += 1) {
    const candidate = n === 1 ? name : stem + ' (' + n + ')' + ext
    try {
      await fsp.stat(path.join(dir, candidate))
    } catch (error) {
      if (error && error.code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('同名附件太多，换个名字再传')
}

/** 把上传的字节落到 chats/<id>/files/，并记进会话的附件清单。 */
export async function attachToConversation(id, { name, data } = {}) {
  const safeId = assertId(id)
  const data0 = await readChats()
  const conv = data0.items.find((item) => item.id === safeId)
  if (!conv) throw new Error('对话不存在：' + safeId)
  const bytes = data && typeof data.length === 'number' ? data : Buffer.from([])
  if (bytes.length === 0) throw new Error('附件是空的')
  const dir = path.join(CHATS_DIR, safeId, 'files')
  await fsp.mkdir(dir, { recursive: true })
  const fileName = await uniqueFilePath(dir, safeFileName(name))
  const target = path.join(dir, fileName)
  await fsp.writeFile(target, bytes)
  const attachment = {
    name: fileName,
    path: target,
    size: bytes.length,
    at: new Date().toISOString(),
  }
  conv.attachments = [...conv.attachments, attachment]
  conv.updatedAt = attachment.at
  await writeJsonAtomic(CHATS_FILE, data0)
  return { conversation: conv, attachment }
}

/** 从清单里去掉附件并删文件；path 必须在 chats/<id>/ 下面，防止被当成任意文件删除器。 */
export async function detachFromConversation(id, attachmentPath) {
  const safeId = assertId(id)
  const data = await readChats()
  const conv = data.items.find((item) => item.id === safeId)
  if (!conv) throw new Error('对话不存在：' + safeId)
  const root = path.join(CHATS_DIR, safeId)
  const target = path.resolve(String(attachmentPath || ''))
  const rel = path.relative(root, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('附件路径不在这个对话的目录里')
  const before = conv.attachments.length
  conv.attachments = conv.attachments.filter((item) => path.resolve(item.path) !== target)
  if (conv.attachments.length === before) throw new Error('这个对话里没有这个附件')
  conv.updatedAt = new Date().toISOString()
  await writeJsonAtomic(CHATS_FILE, data)
  await fsp.rm(target, { force: true }).catch(() => {})
  return { conversation: conv, removed: true }
}

