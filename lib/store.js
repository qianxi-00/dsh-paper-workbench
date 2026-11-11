/**
 * 本地存储：配置、文献索引、每篇论文的目录。
 *
 * 设计要点：
 *   - 一切都落成普通文件（用户能自己看、能拷走），不做数据库；
 *   - index.json 的读改写串行化，写用 tmp+rename 原子替换，并留一份 .bak；
 *   - 论文 id 只允许 [a-z0-9._-]，防止拼路径时被 ../ 逃逸；
 *   - 默认不复制 PDF（storage:'link' 只记原路径），省磁盘也省得搬运大文件。
 */
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const DATA_ROOT = process.env.DSH_PAPER_WORKBENCH_DATA
  ? path.resolve(process.env.DSH_PAPER_WORKBENCH_DATA)
  : path.join(os.homedir(), '.dsh', 'paper-workbench')
export const PAPERS_DIR = path.join(DATA_ROOT, 'papers')
export const PAGES_DIR = path.join(DATA_ROOT, '.pages')
export const TRASH_DIR = path.join(DATA_ROOT, '.trash')
export const CONFIG_FILE = path.join(DATA_ROOT, 'config.json')
export const INDEX_FILE = path.join(DATA_ROOT, 'index.json')

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

  const existing = await withIndex(readIndex)
  const found = existing.papers.find((item) => {
    const target = normalized.srcPath.toLowerCase()
    if (target && item.srcPath && path.resolve(item.srcPath).toLowerCase() === target) return true
    if (target && item.originPath && path.resolve(item.originPath).toLowerCase() === target) return true
    if (normalized.arxivId && item.arxivId && String(item.arxivId) === String(normalized.arxivId)) return true
    if (normalized.doi && item.doi && String(item.doi).toLowerCase() === String(normalized.doi).toLowerCase()) return true
    return false
  })
  if (found) return { meta: found, existed: true }

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
    lastReadPage: normalized.lastReadPage || 1,
    zhPages: normalized.zhPages || 0,
    addedAt: normalized.addedAt || now,
    updatedAt: now,
  }

  const dir = paperDir(record.id)
  await fsp.mkdir(dir, { recursive: true })
  await writeJsonAtomic(path.join(dir, 'meta.json'), record)
  await withIndex(async () => {
    const index = await readIndex()
    index.papers = index.papers.filter((item) => item.id !== record.id)
    index.papers.push(record)
    await writeIndex(index)
  })
  return { meta: record, existed: false }
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
      'pageCount', 'hasText', 'vaultCard', 'lastReadPage', 'zhPages',
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
