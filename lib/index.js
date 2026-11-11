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
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DATA_ROOT,
  PAGES_DIR,
  addPaper,
  ensureDirs,
  getConfig,
  getMeta,
  listPapers,
  readNotes,
  readTextCache,
  readZh,
  removePaper,
  resolvePdf,
  setConfig,
  updateMeta,
  writeNotes,
  writeTextCache,
} from './store.js'
import { findPython, info as pdfInfo, loadText, outline as pdfOutline, renderPage, searchText } from './pdf.js'
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
      return {
        ok: true,
        plugin: 'dsh-paper-workbench',
        phase: 'p1',
        root: ROOT,
        dataRoot: DATA_ROOT,
        papers: papers.length,
        pdf: python === null ? { ok: false, python: '' } : { ok: true, python: python.python, version: python.version },
        vault: vault.ok ? { ok: true, vault: vault.vault, kb: vault.kb } : { ok: false, error: vault.error },
        time: new Date().toISOString(),
      }
    },

    'settings.get': async () => ({ config: await getConfig(), dataRoot: DATA_ROOT }),

    'settings.set': async (args) => {
      const config = await setConfig(args && args.patch ? args.patch : {})
      invalidateVault()
      return { config }
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
      return { meta, outline, hasText: meta.hasText !== false, notes, zhChars: zh.length }
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

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-paper-workbench] webServer 服务不可用，插件未加载')
    return
  }

  const handler = createHandler({ api: createApi(), appDir: APP_DIR, prefix: PREFIX })
  console.log('[dsh-paper-workbench] 宿主已加载，静态目录：' + APP_DIR)

  ctx.effect(() => webServer.register({ kind: 'prefix', path: PREFIX, handler }))

  // agent 工具：让原生会话能直接读写文献库 / PDF / Obsidian
  ctx.effect(() => {
    const disposers = registerTools(ctx, createApi())
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
