/**
 * arXiv / OpenAlex 在线检索 + PDF 下载。
 *
 * 为什么这样实现：
 *   - 只用 Node 内置的 fetch / URL / AbortSignal / fs 能力，不引依赖、不抓 HTML：
 *     两个源都有官方结构化接口（arXiv Atom、OpenAlex JSON），解析网页既脆又没必要。
 *   - 纯函数与网络分开：解析器只吃字符串/对象，测试脚本可以直接喂固定 fixture，
 *     不发任何请求；网络函数只负责拼 URL、超时与中文错误包装。
 *   - Atom 用正则而不是 XML 库：arXiv 的 Atom 结构固定且只有一层文本，
 *     为它引一个 XML 解析器不划算。但 <link> 的属性顺序不固定（实测 href/rel/type
 *     与 rel/type/href 两种都出现过），所以先把整条标签的属性抓成对象再判断，
 *     而不是按固定顺序匹配字符串。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** 官方接口都要求带可识别的 UA；arXiv 对不带 UA 的脚本请求会直接 403。 */
const USER_AGENT = 'dsh-paper-workbench/0.1 (+https://github.com/qianxi-00/dsh-paper-workbench)'
const ARXIV_API = 'https://export.arxiv.org/api/query'
const OPENALEX_API = 'https://api.openalex.org'
const DEFAULT_SEARCH_TIMEOUT = 15000
const DEFAULT_DOWNLOAD_TIMEOUT = 120000
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024

/** arXiv 新式编号（2007-04 起）：YYMM.NNNN[N]。 */
const RE_NEW_ARXIV_ID = /^\d{4}\.\d{4,5}$/
/** arXiv 旧式编号：archive[.subclass]/YYMMNNN，例如 hep-th/9901001、math.GT/0309136。 */
const RE_OLD_ARXIV_ID = /^[a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/\d{7}$/i
/** DOI：10.<4-9 位注册号>/<后缀>，后缀里不允许空白。 */
const RE_DOI = /^10\.\d{4,9}\/\S+$/

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/** 把数字参数收敛到 [min, max]；非法值回落到 fallback，避免把 NaN 拼进 URL。 */
function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** arXiv 接口返回的链接仍是 http，统一升到 https，避免明文下载与多余重定向。 */
function toHttps(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : null
}

/**
 * XML 实体反转义。
 * 用一次扫描 + 回调完成（而不是连续 replace），否则 `&amp;lt;` 这类内容会被二次解码。
 */
function decodeXmlEntities(text) {
  return String(text).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, name) => {
    switch (name) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
        return String.fromCodePoint(code)
      }
    }
  })
}

/** 抓某标签的第一段内部文本；只用于 Atom 里没有嵌套标签的字段。 */
function pickTag(block, tag) {
  const match = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(block)
  return match ? match[1] : ''
}

/** arXiv 的 title/summary 里有换行与缩进，先反转义再压成单个空格。 */
function cleanAtomText(raw) {
  // CDATA 是合法 XML，取值时要剥掉包裹，否则标题会带着 <![CDATA[ ]]> 进库
  const text = String(raw).trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
  return decodeXmlEntities(text).replace(/\s+/g, ' ').trim()
}

/** 把一条 <link ...> 的属性拆成对象；属性顺序不固定，所以不能按顺序匹配。 */
function parseAtomLinks(block) {
  const links = []
  const linkRe = /<link\b([^>]*?)\/?>/g
  let match
  while ((match = linkRe.exec(block)) !== null) {
    const attrs = {}
    const attrRe = /([a-zA-Z:_-]+)="([^"]*)"/g
    let attr
    while ((attr = attrRe.exec(match[1])) !== null) attrs[attr[1]] = decodeXmlEntities(attr[2])
    links.push(attrs)
  }
  return links
}

/** 每个 <author> 块里的 <name>；不直接全局匹配 <name>，避免把别的字段混进来。 */
function parseAtomAuthors(block) {
  const names = []
  const authorRe = /<author\b[^>]*>([\s\S]*?)<\/author>/g
  let match
  while ((match = authorRe.exec(block)) !== null) {
    const name = cleanAtomText(pickTag(match[1], 'name'))
    if (name !== '') names.push(name)
  }
  return names
}

/** 提取所有 <category term="..." /> 的分类名（不依赖属性顺序）。 */
function parseAtomCategories(block, primaryCategory) {
  const seen = new Set()
  const categories = []
  const push = (cat) => {
    const clean = decodeXmlEntities(String(cat || '')).trim()
    if (clean === '' || seen.has(clean)) return
    seen.add(clean)
    categories.push(clean)
  }
  if (primaryCategory) push(primaryCategory)
  const catRe = /<category\b([^>]*?)\/?>/g
  let match
  while ((match = catRe.exec(block)) !== null) {
    const term = /\bterm="([^"]*)"/.exec(match[1])
    if (term) push(term[1])
  }
  return categories
}

/**
 * 解析 arXiv Atom 响应。
 * 纯函数（导出是为了让测试脚本能直接喂 fixture）。
 * 只遍历 <entry>，因此 feed 级别的 <title> 不会被误抓成论文标题。
 */
export function parseArxivAtom(xml) {
  const items = []
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g
  let match
  while ((match = entryRe.exec(String(xml || ''))) !== null) {
    const block = match[1]
    const rawId = cleanAtomText(pickTag(block, 'id'))
    // 无效 id 时 arXiv 仍然返回 200，但会塞一个 id 为 /api/errors#... 的错误条目。
    if (rawId.includes('/api/errors#')) {
      const reason = cleanAtomText(pickTag(block, 'summary'))
      throw new Error('检索失败：arXiv 返回错误：' + (reason || rawId))
    }
    const arxivId = normalizeArxivId(rawId)
    const links = parseAtomLinks(block)
    const pdfLink = links.find((link) => link.rel === 'related' && link.type === 'application/pdf')
    const doiLink = links.find((link) => link.title === 'doi' && typeof link.href === 'string')
    const primary = /<arxiv:primary_category\b[^>]*?\bterm="([^"]*)"/.exec(block)
    const primaryCategory = primary ? decodeXmlEntities(primary[1]) : null
    const published = cleanAtomText(pickTag(block, 'published'))
    const updated = cleanAtomText(pickTag(block, 'updated'))
    const dateSource = published || updated
    const year = /^\d{4}/.test(dateSource) ? Number(dateSource.slice(0, 4)) : null
    const rawDoi = cleanAtomText(pickTag(block, 'arxiv:doi')) || (doiLink ? doiLink.href : '')
    items.push({
      arxivId,
      doi: normalizeDoi(rawDoi),
      title: cleanAtomText(pickTag(block, 'title')),
      authors: parseAtomAuthors(block),
      year,
      published: published === '' ? null : published,
      publishedAt: published === '' ? null : published,
      updatedAt: updated === '' ? null : updated,
      abstract: cleanAtomText(pickTag(block, 'summary')) || null,
      // 少数老论文没有 pdf link，用编号兜底拼一个稳定地址。
      pdfUrl: pdfLink ? toHttps(pdfLink.href) : arxivId === null ? null : 'https://arxiv.org/pdf/' + arxivId,
      absUrl: rawId === '' ? null : toHttps(rawId),
      primaryCategory,
      categories: parseAtomCategories(block, primaryCategory),
    })
  }
  return items
}

/**
 * 归一化 arXiv 编号，非法返回 null。
 *
 * 支持：2103.10385、arXiv:2103.10385v2、arxiv.org 的 abs/pdf 链接、hep-th/9901001。
 * 统一去掉版本号：同一个编号的不同版本是同一篇论文，入库/去重都按裸编号更稳；
 * 需要具体版本时 pdfUrl/absUrl 里仍带着接口返回的版本号。
 */
export function normalizeArxivId(input) {
  if (typeof input !== 'string') return null
  let text = input.trim()
  if (text === '') return null
  if (/^https?:\/\//i.test(text)) {
    let url
    try {
      url = new URL(text)
    } catch {
      return null
    }
    // 只认 arxiv.org 及其子域，避免把随便一个 /abs/xxx 的网址误判成论文。
    if (!/(^|\.)arxiv\.org$/i.test(url.hostname)) return null
    const match = /^\/(?:abs|pdf|html)\/(.+)$/i.exec(url.pathname)
    if (!match) return null
    text = match[1]
  }
  text = text.replace(/^arxiv:\s*/i, '')
  text = text.replace(/[?#].*$/, '')
  text = text.replace(/\/+$/, '')
  text = text.replace(/\.pdf$/i, '')
  text = text.replace(/v\d+$/i, '')
  text = text.trim()
  return RE_NEW_ARXIV_ID.test(text) || RE_OLD_ARXIV_ID.test(text) ? text : null
}

/**
 * 归一化 DOI，非法返回 null。
 * 支持 10.1000/xyz、doi:10.1000/xyz、https://doi.org/10.1000/xyz。
 * 不改写大小写：DOI 虽不区分大小写，但保留发布方的写法能减少无谓的差异。
 */
export function normalizeDoi(input) {
  if (typeof input !== 'string') return null
  let text = input.trim()
  if (text === '') return null
  if (/^https?:\/\//i.test(text)) {
    let url
    try {
      url = new URL(text)
    } catch {
      return null
    }
    if (!/(^|\.)(doi\.org|dx\.doi\.org)$/i.test(url.hostname)) return null
    text = url.pathname.replace(/^\/+/, '')
    try {
      text = decodeURIComponent(text)
    } catch {
      /* 百分号编码坏了就按原文继续校验 */
    }
  }
  text = text.replace(/^doi:\s*/i, '').trim()
  return RE_DOI.test(text) ? text : null
}

/** 统一的文本请求：带 UA、跟随重定向、整段（含读 body）计入超时，错误转中文。 */
async function fetchText(url, { timeoutMs = DEFAULT_SEARCH_TIMEOUT, accept = '*/*', fetchImpl = fetch } = {}) {
  const timeout = clampInt(timeoutMs, DEFAULT_SEARCH_TIMEOUT, 1000, 600000)
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  try {
    const res = await doFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error('检索失败：HTTP ' + res.status)
    return await res.text()
  } catch (error) {
    const message = messageOf(error)
    if (message.startsWith('检索失败')) throw error
    if (timedOut) throw new Error('检索失败：请求超时（' + timeout + 'ms）')
    throw new Error('检索失败：网络错误（' + message + '）')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 检索 arXiv。
 * 传了 id 就按 id_list 查（优先于 query），否则 search_query=all:<query>；
 * query 先 encodeURIComponent，多词保持原样交给 all:（空格 = AND）。
 */
export async function searchArxiv({ query, id, limit = 10, timeoutMs = DEFAULT_SEARCH_TIMEOUT } = {}) {
  const max = clampInt(limit, 10, 1, 2000)
  const hasId = id !== undefined && id !== null && String(id).trim() !== ''
  const arxivId = hasId ? normalizeArxivId(id) : null
  if (hasId && arxivId === null) throw new Error('检索失败：无效的 arXiv ID（' + String(id) + '）')
  const keyword = typeof query === 'string' ? query.trim() : ''
  if (arxivId === null && keyword === '') throw new Error('检索失败：需要 query 或 id')
  const params =
    arxivId === null ? 'search_query=all:' + encodeURIComponent(keyword) : 'id_list=' + encodeURIComponent(arxivId)
  const xml = await fetchText(ARXIV_API + '?' + params + '&max_results=' + max, {
    timeoutMs,
    accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
  })
  return { source: 'arxiv', items: parseArxivAtom(xml) }
}

/**
 * 把 OpenAlex 的 abstract_inverted_index 还原成文本。
 * 该字段是「词 → 它在摘要中的位置列表」，位置是全文词序号，与对象键顺序无关，
 * 所以必须按 position 填槽位、再按槽位顺序拼接。
 */
function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return null
  const slots = []
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue
    for (const position of positions) {
      const at = Number(position)
      if (Number.isInteger(at) && at >= 0) slots[at] = word
    }
  }
  const text = slots.filter((word) => typeof word === 'string').join(' ').trim()
  return text === '' ? null : text
}

/** 期刊/会议名：优先 primary_location.source，旧响应里可能是 host_venue。 */
function pickVenue(work) {
  const primary = work.primary_location
  if (primary && primary.source && primary.source.display_name) return primary.source.display_name
  if (work.host_venue && work.host_venue.display_name) return work.host_venue.display_name
  return null
}

/** 从 OpenAlex work 尽力还原 arXiv 编号，便于与 arXiv 源精确跨源去重。 */
function extractOpenAlexArxivId(work, normalizedDoi) {
  const candidates = []
  if (work.ids && typeof work.ids.arxiv === 'string') candidates.push(work.ids.arxiv)
  if (normalizedDoi && /^10\.48550\/arxiv\./i.test(normalizedDoi)) {
    candidates.push(normalizedDoi.replace(/^10\.48550\/arxiv\./i, ''))
  }
  const best = work.best_oa_location
  const primary = work.primary_location
  if (best && best.pdf_url) candidates.push(best.pdf_url)
  if (best && best.landing_page_url) candidates.push(best.landing_page_url)
  if (primary && primary.pdf_url) candidates.push(primary.pdf_url)
  if (primary && primary.landing_page_url) candidates.push(primary.landing_page_url)
  for (const candidate of candidates) {
    const id = normalizeArxivId(candidate)
    if (id !== null) return id
  }
  return null
}

/**
 * 解析 OpenAlex 响应（搜索结果 { results: [...] } 或单条 work 对象）。
 * 纯函数（导出是为了让测试脚本能直接喂 fixture）。
 */
export function parseOpenAlexWorks(payload) {
  if (!payload || typeof payload !== 'object') return []
  const works = Array.isArray(payload.results) ? payload.results : [payload]
  return works
    .filter(
      (work) =>
        work &&
        typeof work === 'object' &&
        (typeof work.id === 'string' || typeof work.doi === 'string' || typeof work.title === 'string'),
    )
    .map((work) => {
      const best = work.best_oa_location
      const primary = work.primary_location
      const rawId = String(work.id || '')
      const openalexId = /W\d+$/.exec(rawId)
      const doi = normalizeDoi(work.doi)
      const published =
        typeof work.publication_date === 'string' && work.publication_date.trim() !== ''
          ? work.publication_date.trim()
          : null
      const updatedAt =
        typeof work.updated_date === 'string' && work.updated_date.trim() !== '' ? work.updated_date.trim() : null
      const year = Number.isInteger(work.publication_year)
        ? work.publication_year
        : published && /^\d{4}/.test(published)
          ? Number(published.slice(0, 4))
          : null
      return {
        // OpenAlex 的 work.id 是 https://openalex.org/W123 形式，返回裸 ID 更方便当键用。
        id: openalexId ? openalexId[0] : work.id || null,
        arxivId: extractOpenAlexArxivId(work, doi),
        doi,
        title: work.title || work.display_name || null,
        authors: Array.isArray(work.authorships)
          ? work.authorships.map((entry) => (entry && entry.author && entry.author.display_name) || '').filter(Boolean)
          : [],
        year,
        published,
        publishedAt: published,
        updatedAt,
        venue: pickVenue(work),
        abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
        // 有 OA 版本时优先 best_oa_location 的 PDF；没有就是 null。
        pdfUrl: (best && best.pdf_url) || (primary && primary.pdf_url) || null,
        url:
          (best && best.landing_page_url) ||
          (primary && primary.landing_page_url) ||
          (typeof work.doi === 'string' ? work.doi : work.id || null),
      }
    })
}

/** DOI 允许出现斜杠，斜杠必须留在路径分隔位，所以逐段编码后再拼。 */
function encodeDoiPath(doi) {
  return doi
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** 检索 OpenAlex；传 doi 查单条（/works/https://doi.org/<doi>），否则按关键词搜。 */
export async function searchOpenAlex({ query, doi, limit = 10, timeoutMs = DEFAULT_SEARCH_TIMEOUT } = {}) {
  const max = clampInt(limit, 10, 1, 200)
  const hasDoi = doi !== undefined && doi !== null && String(doi).trim() !== ''
  const normalizedDoi = hasDoi ? normalizeDoi(doi) : null
  if (hasDoi && normalizedDoi === null) throw new Error('检索失败：无效的 DOI（' + String(doi) + '）')
  const keyword = typeof query === 'string' ? query.trim() : ''
  if (normalizedDoi === null && keyword === '') throw new Error('检索失败：需要 query 或 doi')
  const url =
    normalizedDoi === null
      ? OPENALEX_API + '/works?search=' + encodeURIComponent(keyword) + '&per-page=' + max
      : OPENALEX_API + '/works/https://doi.org/' + encodeDoiPath(normalizedDoi)
  const body = await fetchText(url, { timeoutMs, accept: 'application/json' })
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error('检索失败：OpenAlex 返回的不是合法 JSON')
  }
  return { source: 'openalex', items: parseOpenAlexWorks(payload) }
}

/** 合并去重键：标题压成小写单空格 + 年份。 */
function dedupeKey(item) {
  const title = String((item && item.title) || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  if (title === '') return ''
  const year = item.year === null || item.year === undefined ? '' : String(item.year)
  return title + '|' + year
}

/**
 * 并行检索两个源并合并去重。
 * 交错合并（arxiv[0], openalex[0], arxiv[1], ...）：如果直接拼接，arXiv 命中多时
 * 会把 limit 全占满，OpenAlex 特意找的 OA PDF 一条都看不到。
 * 单源失败不影响结果；两个都失败才抛错。
 */
export async function searchBoth({ query, limit = 8 } = {}) {
  const keyword = typeof query === 'string' ? query.trim() : ''
  if (keyword === '') throw new Error('检索失败：需要 query')
  const max = clampInt(limit, 8, 1, 50)
  const settled = await Promise.allSettled([
    searchArxiv({ query: keyword, limit: max }),
    searchOpenAlex({ query: keyword, limit: max }),
  ])
  if (settled.every((entry) => entry.status === 'rejected')) {
    const reasons = settled.map((entry) => (entry.status === 'rejected' ? messageOf(entry.reason) : ''))
    throw new Error('检索失败：arXiv 与 OpenAlex 均不可用（' + reasons.join('；') + '）')
  }
  const arxivItems = settled[0].status === 'fulfilled' ? settled[0].value.items : []
  const openalexItems = settled[1].status === 'fulfilled' ? settled[1].value.items : []
  // 单源失败不能静默：否则界面只会「结果变少」，用户看不出是 OpenAlex 限流了
  const warnings = []
  if (settled[0].status === 'rejected') warnings.push('arXiv 不可用：' + messageOf(settled[0].reason))
  if (settled[1].status === 'rejected') warnings.push('OpenAlex 不可用：' + messageOf(settled[1].reason))
  const merged = []
  const rounds = Math.max(arxivItems.length, openalexItems.length)
  for (let i = 0; i < rounds; i += 1) {
    if (arxivItems[i]) merged.push(arxivItems[i])
    if (openalexItems[i]) merged.push(openalexItems[i])
  }
  const seen = new Set()
  const items = []
  for (const item of merged) {
    const key = dedupeKey(item)
    if (key !== '' && seen.has(key)) continue
    if (key !== '') seen.add(key)
    items.push(item)
    if (items.length >= max) break
  }
  return warnings.length > 0 ? { items, warnings } : { items }
}

/** 超限提示：默认 200MB 时显示整数，非整数上限保留一位小数。 */
function pdfTooLarge(maxBytes) {
  const mb = maxBytes / (1024 * 1024)
  return 'PDF 超过 ' + (Number.isInteger(mb) ? String(mb) : mb.toFixed(1)) + 'MB 上限'
}

/** 本地写盘错误（权限/磁盘满/路径不存在）与网络错误区分开，提示才有意义。 */
function isFileWriteError(error) {
  const code = String((error && error.code) || '')
  return ['EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EBUSY', 'EEXIST', 'EISDIR', 'ENOTDIR'].includes(code)
}

function toDownloadError(error, timedOut, timeoutMs) {
  const message = messageOf(error)
  if (message.startsWith('下载失败') || message === '下载内容不是 PDF' || message.startsWith('PDF 超过')) return error
  if (timedOut) return new Error('下载失败：超时（' + timeoutMs + 'ms）')
  if (isFileWriteError(error)) return new Error('下载失败：写入文件失败（' + message + '）')
  return new Error('下载失败：网络错误（' + message + '）')
}

async function removeQuietly(file) {
  try {
    await fsp.unlink(file)
  } catch {
    /* 临时文件不存在就没什么可删的 */
  }
}

/**
 * 流式下载 PDF 到 destPath。
 *
 * 先写 destPath.tmp，成功后再 rename：中途失败/超时不会留下一个「看起来像论文」
 * 的半截文件。HTTP 200 不代表内容是 PDF（例如反爬页、登录页），所以校验前 5 字节
 * 的 %PDF-；content-length 明显超限时提前拒绝，避免白下载几百 MB。
 */
export async function downloadPdf(url, destPath, { timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let target
  try {
    target = new URL(String(url))
  } catch {
    throw new Error('下载失败：无效的链接')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('下载失败：只支持 http(s) 链接')
  if (typeof destPath !== 'string' || destPath.trim() === '') throw new Error('下载失败：保存路径无效')
  const filePath = path.resolve(destPath)
  const tmpPath = filePath + '.tmp'
  const limit = clampInt(maxBytes, DEFAULT_MAX_BYTES, 1, Number.MAX_SAFE_INTEGER)
  const timeout = clampInt(timeoutMs, DEFAULT_DOWNLOAD_TIMEOUT, 1000, 3600000)
  await fsp.mkdir(path.dirname(filePath), { recursive: true })

  const controller = new AbortController()
  let timedOut = false
  let timer = null
  let handle = null
  let bytes = 0
  try {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
    const res = await fetch(target, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf, */*' },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error('下载失败：HTTP ' + res.status)
    // 只拒绝「https 被降级成 http」；本来就给的是 http 链接时放行（arXiv 老链接常见）
    if (target.protocol === 'https:' && String(res.url || '').startsWith('http://')) {
      throw new Error('下载失败：链接被重定向到明文 http，已拒绝')
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) throw new Error(pdfTooLarge(limit))
    if (!res.body) throw new Error('下载失败：响应没有内容')

    handle = await fsp.open(tmpPath, 'w')
    let head = Buffer.alloc(0)
    for await (const chunk of res.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (head.length < 5) {
        head = Buffer.concat([head, buffer])
        // 已经攒够 5 字节仍不是 %PDF-，多半是 HTML 错误页，立刻停，别下完整个站点。
        if (head.length >= 5 && head.toString('latin1', 0, 5) !== '%PDF-') throw new Error('下载内容不是 PDF')
      }
      bytes += buffer.length
      if (bytes > limit) throw new Error(pdfTooLarge(limit))
      await handle.write(buffer)
    }
    if (head.length < 5 || head.toString('latin1', 0, 5) !== '%PDF-') throw new Error('下载内容不是 PDF')
    await handle.close()
    handle = null
    await fsp.rename(tmpPath, filePath)
    return { bytes, path: filePath }
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        /* 句柄可能已经失效 */
      }
    }
    await removeQuietly(tmpPath)
    throw toDownloadError(error, timedOut, timeout)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 按 arXiv 编号取单条元数据；编号非法或查不到返回 null。
 * 网络错误继续抛（它不等于「这篇论文不存在」）。
 */
export async function fetchArxivMeta(arxivId) {
  const id = normalizeArxivId(arxivId)
  if (id === null) return null
  const result = await searchArxiv({ id, limit: 1 })
  return result.items.length > 0 ? result.items[0] : null
}

// --- 科研主题订阅与最新论文 Feed -------------------------------------------

const DEFAULT_FEED_LIMIT = 18
const DEFAULT_LATEST_LIMIT = 15
const DEFAULT_OPENALEX_WINDOW_DAYS = 90
const RE_ARXIV_CATEGORY = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)?$/

/**
 * 预设科研主题目录。
 * 每项提供双源检索条件，避免纯分类查询被宽泛子领域淹没。
 */
export const PRESET_TOPICS = Object.freeze([
  Object.freeze({
    id: 'llm-agents',
    label: '大模型与智能体',
    desc: '大语言模型自主智能体、多智能体协同、工具调用与任务规划',
    arxivCategories: Object.freeze(['cs.CL', 'cs.AI', 'cs.MA']),
    arxivQuery: '("LLM agent" OR "multi-agent" OR "tool use" OR "autonomous agent")',
    openalexQuery: 'large language model autonomous agent tool use',
  }),
  Object.freeze({
    id: 'multimodal-ocr',
    label: '多模态与文档版面 / OCR',
    desc: '视觉语言模型、文档版面分析、表格结构解析与端到端 OCR',
    arxivCategories: Object.freeze(['cs.CV', 'cs.CL']),
    arxivQuery: '("document layout" OR "OCR" OR "document understanding" OR "vision-language model")',
    openalexQuery: 'multimodal document understanding OCR layout',
  }),
  Object.freeze({
    id: 'efficient-training',
    label: '推理加速 / 量化 / 注意力',
    desc: '模型量化、KV Cache 压缩、投机采样与高效注意力机制',
    arxivCategories: Object.freeze(['cs.LG', 'cs.DC']),
    arxivQuery: '("quantization" OR "speculative decoding" OR "KV cache" OR "efficient attention")',
    openalexQuery: 'LLM inference quantization speculative decoding attention',
  }),
  Object.freeze({
    id: 'rag-retrieval',
    label: '检索增强与知识系统',
    desc: '检索增强生成（RAG）、稠密检索、知识图谱与长上下文记忆',
    arxivCategories: Object.freeze(['cs.IR', 'cs.CL']),
    arxivQuery: '("retrieval-augmented" OR "RAG" OR "dense retrieval" OR "knowledge graph")',
    openalexQuery: 'retrieval-augmented generation dense retrieval knowledge',
  }),
  Object.freeze({
    id: 'alignment-eval',
    label: '对齐 / 安全 / 评测 / 幻觉',
    desc: '偏好对齐、幻觉抑制、安全护栏、越狱防御与基准评测',
    arxivCategories: Object.freeze(['cs.CL', 'cs.AI']),
    arxivQuery: '("alignment" OR "hallucination" OR "LLM safety" OR "benchmark evaluation")',
    openalexQuery: 'large language model alignment safety hallucination evaluation',
  }),
  Object.freeze({
    id: 'robotics-vla',
    label: '具身智能与视觉语言动作模型',
    desc: '具身智能体、视觉-语言-动作（VLA）策略、灵巧操作与仿真迁移',
    arxivCategories: Object.freeze(['cs.RO', 'cs.CV']),
    arxivQuery: '("vision-language-action" OR "embodied AI" OR "robot manipulation" OR "VLA")',
    openalexQuery: 'vision-language-action embodied robot manipulation',
  }),
  Object.freeze({
    id: 'rl-reasoning',
    label: '强化学习与慢思考推理',
    desc: '强化学习微调、测试时计算扩展、思维链推理与自我博弈',
    arxivCategories: Object.freeze(['cs.LG', 'cs.AI']),
    arxivQuery: '("reinforcement learning" OR "reasoning model" OR "chain-of-thought" OR "test-time compute")',
    openalexQuery: 'reinforcement learning reasoning language model test-time',
  }),
  Object.freeze({
    id: 'systems-infra',
    label: 'AI 基础设施与分布式系统',
    desc: '分布式训练调度、推理服务引擎、GPU 集群通信与异构并行',
    arxivCategories: Object.freeze(['cs.DC', 'cs.PF']),
    arxivQuery: '("distributed training" OR "LLM serving" OR "inference serving" OR "GPU cluster")',
    openalexQuery: 'distributed LLM training inference serving system',
  }),
])

const PRESET_TOPIC_MAP = new Map(PRESET_TOPICS.map((topic) => [topic.id, topic]))

function isoNow(now) {
  if (now === undefined || now === null) return new Date().toISOString()
  const ms = typeof now === 'number' ? now : Date.parse(String(now))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString()
}

function toStringList(input, splitComma = false) {
  if (input === undefined || input === null) return []
  const rawList = Array.isArray(input)
    ? input
    : splitComma
      ? String(input).split(/[\s,]+/)
      : [input]
  const seen = new Set()
  const out = []
  for (const item of rawList) {
    if (typeof item !== 'string' && typeof item !== 'number') continue
    const text = String(item).trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** 剥除可能破坏 all:"..." 引号边界的字符（引号、反斜杠、换行控制符）。 */
function cleanArxivTerm(raw) {
  return String(raw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从预设主题的 arxivQuery 提取引号词组；若无引号则返回原文本。 */
function parseTopicArxivTerms(arxivQuery) {
  const raw = String(arxivQuery || '').trim()
  if (raw === '') return []
  const terms = []
  const re = /"([^"]+)"/g
  let match
  while ((match = re.exec(raw)) !== null) {
    const clean = cleanArxivTerm(match[1])
    if (clean !== '') terms.push(clean)
  }
  if (terms.length > 0) return terms
  const fallback = cleanArxivTerm(raw)
  return fallback === '' ? [] : [fallback]
}

/**
 * 构建规范的 arXiv search_query 表达式（纯函数）。
 * 分类只放行合法 arXiv category，关键词统一转义并包裹为 all:"..."。
 */
export function buildArxivLatestQuery({ categories, keywords } = {}) {
  const validCats = []
  const seenCats = new Set()
  for (const rawCat of toStringList(categories, true)) {
    if (!RE_ARXIV_CATEGORY.test(rawCat) || seenCats.has(rawCat)) continue
    seenCats.add(rawCat)
    validCats.push(rawCat)
  }

  const validTerms = []
  const seenTerms = new Set()
  for (const rawKw of toStringList(keywords, false)) {
    const clean = cleanArxivTerm(rawKw)
    if (clean === '' || seenTerms.has(clean)) continue
    seenTerms.add(clean)
    validTerms.push(clean)
  }

  if (validCats.length === 0 && validTerms.length === 0) {
    throw new Error('检索失败：需要 categories 或 keywords')
  }

  const catPart =
    validCats.length === 0
      ? ''
      : validCats.length === 1
        ? 'cat:' + validCats[0]
        : '(' + validCats.map((c) => 'cat:' + c).join(' OR ') + ')'

  const kwPart =
    validTerms.length === 0
      ? ''
      : validTerms.length === 1
        ? 'all:"' + validTerms[0] + '"'
        : '(' + validTerms.map((t) => 'all:"' + t + '"').join(' OR ') + ')'

  if (catPart !== '' && kwPart !== '') return catPart + ' AND ' + kwPart
  return catPart || kwPart
}

/** 构建带 submittedDate 降序排序的 arXiv API 请求 URL（纯函数）。 */
export function buildArxivLatestUrl({ categories, keywords, limit = DEFAULT_LATEST_LIMIT } = {}) {
  const max = clampInt(limit, DEFAULT_LATEST_LIMIT, 1, 2000)
  const searchQuery = buildArxivLatestQuery({ categories, keywords })
  return (
    ARXIV_API +
    '?search_query=' +
    encodeURIComponent(searchQuery) +
    '&sortBy=submittedDate&sortOrder=descending&max_results=' +
    max
  )
}

/** 构建 OpenAlex search 参数串（纯函数）。 */
export function buildOpenAlexLatestQuery({ keywords, topicQueries } = {}) {
  const parts = []
  const seen = new Set()
  for (const raw of [...toStringList(topicQueries, false), ...toStringList(keywords, false)]) {
    const clean = raw
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/["\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean === '' || seen.has(clean)) continue
    seen.add(clean)
    parts.push(clean)
  }
  if (parts.length === 0) throw new Error('检索失败：需要 keywords 或 topicQueries')
  if (parts.length === 1) return parts[0]
  return parts.map((p) => '(' + p + ')').join(' OR ')
}

/** 构建近 N 天（默认 90 天）OpenAlex 最新论文查询 URL（纯函数）。 */
export function buildOpenAlexLatestUrl({
  keywords,
  topicQueries,
  limit = DEFAULT_LATEST_LIMIT,
  days = DEFAULT_OPENALEX_WINDOW_DAYS,
  now = Date.now(),
} = {}) {
  const max = clampInt(limit, DEFAULT_LATEST_LIMIT, 1, 200)
  const windowDays = clampInt(days, DEFAULT_OPENALEX_WINDOW_DAYS, 1, 3650)
  const baseMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.parse(String(now))
  const anchorMs = Number.isFinite(baseMs) ? baseMs : Date.now()
  const sinceDate = new Date(anchorMs - windowDays * 86400 * 1000).toISOString().slice(0, 10)
  const search = buildOpenAlexLatestQuery({ keywords, topicQueries })
  return (
    OPENALEX_API +
    '/works?search=' +
    encodeURIComponent(search) +
    '&filter=from_publication_date:' +
    sinceDate +
    '&sort=publication_date:desc&per-page=' +
    max
  )
}

/** 归一化论文标题用于跨源去重（纯函数）。 */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function parseDateValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 1000 && raw <= 9999) return Date.UTC(raw, 0, 1)
    return Number.isFinite(raw) ? raw : null
  }
  const text = String(raw).trim()
  if (text === '') return null
  if (/^\d{4}$/.test(text)) return Date.UTC(Number(text), 0, 1)
  if (/^\d{4}-\d{2}$/.test(text)) {
    const [y, m] = text.split('-').map(Number)
    return Date.UTC(y, m - 1, 1)
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** 按 publishedAt || published || updatedAt || year 提取用于倒序排序的时间戳（纯函数）。 */
export function getItemTimestamp(item) {
  if (!item || typeof item !== 'object') return -Infinity
  for (const candidate of [item.publishedAt, item.published, item.updatedAt, item.year]) {
    const ts = parseDateValue(candidate)
    if (ts !== null) return ts
  }
  return -Infinity
}

function sortFeedItems(items) {
  return [...items].sort((a, b) => {
    const diff = getItemTimestamp(b) - getItemTimestamp(a)
    if (diff !== 0) return diff
    const ua = parseDateValue(a && a.updatedAt) ?? -Infinity
    const ub = parseDateValue(b && b.updatedAt) ?? -Infinity
    if (ub !== ua) return ub - ua
    return 0
  })
}

function mergeStringArray(a, b) {
  const seen = new Set()
  const out = []
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue
    for (const v of list) {
      if (typeof v !== 'string') continue
      const s = v.trim()
      if (s === '' || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

function pickRicherDate(d1, d2) {
  const s1 = typeof d1 === 'string' ? d1.trim() : ''
  const s2 = typeof d2 === 'string' ? d2.trim() : ''
  if (!s1) return s2 || null
  if (!s2) return s1
  const hasTime1 = /[T:]/.test(s1)
  const hasTime2 = /[T:]/.test(s2)
  if (hasTime1 !== hasTime2) return hasTime1 ? s1 : s2
  return s1.length >= s2.length ? s1 : s2
}

function pickNewerOrRicherDate(d1, d2) {
  const s1 = typeof d1 === 'string' ? d1.trim() : ''
  const s2 = typeof d2 === 'string' ? d2.trim() : ''
  if (!s1) return s2 || null
  if (!s2) return s1
  const t1 = parseDateValue(s1) ?? -Infinity
  const t2 = parseDateValue(s2) ?? -Infinity
  if (t1 !== t2) return t1 > t2 ? s1 : s2
  return pickRicherDate(s1, s2)
}

function titleQualityScore(s) {
  let score = 100
  const hasUpper = /[A-Z]/.test(s)
  const hasLower = /[a-z]/.test(s)
  if (hasUpper && !hasLower) score -= 20 // 全大写标题扣分
  if (!hasUpper && hasLower) score -= 15 // 全小写英文标题扣分
  if (/[.!]\s*$/.test(s)) score -= 5 // 常见抓取脏末尾句号/叹号扣分
  return score
}

function pickBetterTitle(t1, t2) {
  const s1 = typeof t1 === 'string' ? t1.trim() : ''
  const s2 = typeof t2 === 'string' ? t2.trim() : ''
  if (!s1) return s2 || null
  if (!s2) return s1
  const q1 = titleQualityScore(s1)
  const q2 = titleQualityScore(s2)
  if (q1 !== q2) return q1 > q2 ? s1 : s2
  return s1.length >= s2.length ? s1 : s2
}

function pickBetterPdfUrl(u1, u2) {
  const s1 = typeof u1 === 'string' ? u1.trim() : ''
  const s2 = typeof u2 === 'string' ? u2.trim() : ''
  if (!s1) return s2 || null
  if (!s2) return s1
  const isArxiv1 = /arxiv\.org\/pdf\//i.test(s1)
  const isArxiv2 = /arxiv\.org\/pdf\//i.test(s2)
  if (isArxiv1 !== isArxiv2) return isArxiv1 ? s1 : s2
  return s1
}

function cloneNormalizedItem(item) {
  const arxivId = normalizeArxivId(item.arxivId) || (item.arxivId ? String(item.arxivId).trim() : null)
  const doi = normalizeDoi(item.doi) || (item.doi ? String(item.doi).trim() : null)
  const published = typeof item.published === 'string' && item.published.trim() !== '' ? item.published.trim() : null
  const publishedAt =
    typeof item.publishedAt === 'string' && item.publishedAt.trim() !== '' ? item.publishedAt.trim() : published
  const updatedAt = typeof item.updatedAt === 'string' && item.updatedAt.trim() !== '' ? item.updatedAt.trim() : null
  const topics = mergeStringArray(
    Array.isArray(item.topics) ? item.topics : item.topic ? [item.topic] : [],
    [],
  )
  const sources = mergeStringArray(
    Array.isArray(item.sources) ? item.sources : item.source ? [item.source] : [],
    [],
  )
  const categories = mergeStringArray(
    item.primaryCategory ? [item.primaryCategory] : [],
    Array.isArray(item.categories) ? item.categories : [],
  )
  return {
    ...item,
    arxivId: arxivId || null,
    id: item.id || null,
    doi: doi || null,
    title: typeof item.title === 'string' ? item.title.trim() : item.title || null,
    authors: Array.isArray(item.authors) ? item.authors.filter(Boolean) : [],
    year: Number.isInteger(item.year) ? item.year : null,
    published,
    publishedAt,
    updatedAt,
    venue: item.venue || null,
    abstract: typeof item.abstract === 'string' && item.abstract.trim() !== '' ? item.abstract.trim() : null,
    pdfUrl: item.pdfUrl || null,
    absUrl: item.absUrl || null,
    url: item.url || item.absUrl || null,
    primaryCategory: item.primaryCategory || null,
    categories,
    ...(topics.length > 0 ? { topics } : {}),
    ...(sources.length > 0 ? { sources, source: item.source || sources[0] } : {}),
  }
}

function mergeTwoItems(a, b) {
  const authorsA = Array.isArray(a.authors) ? a.authors : []
  const authorsB = Array.isArray(b.authors) ? b.authors : []
  const absA = typeof a.abstract === 'string' ? a.abstract : ''
  const absB = typeof b.abstract === 'string' ? b.abstract : ''
  const topics = mergeStringArray(a.topics, b.topics)
  const sources = mergeStringArray(a.sources, b.sources)
  const categories = mergeStringArray(a.categories, b.categories)
  const published = pickRicherDate(a.published, b.published)
  const publishedAt = pickRicherDate(a.publishedAt || a.published, b.publishedAt || b.published)
  const updatedAt = pickNewerOrRicherDate(a.updatedAt, b.updatedAt)
  return {
    ...b,
    ...a,
    arxivId: a.arxivId || b.arxivId || null,
    id: a.id || b.id || null,
    doi: a.doi || b.doi || null,
    title: pickBetterTitle(a.title, b.title),
    authors: authorsB.length > authorsA.length ? authorsB : authorsA,
    year: Number.isInteger(a.year) ? a.year : Number.isInteger(b.year) ? b.year : null,
    published,
    publishedAt,
    updatedAt,
    venue: a.venue || b.venue || null,
    abstract: absB.length > absA.length ? absB : absA || null,
    pdfUrl: pickBetterPdfUrl(a.pdfUrl, b.pdfUrl),
    absUrl: a.absUrl || b.absUrl || null,
    url: a.url || b.url || a.absUrl || b.absUrl || null,
    primaryCategory: a.primaryCategory || b.primaryCategory || null,
    categories,
    ...(topics.length > 0 ? { topics } : {}),
    ...(sources.length > 0 ? { sources, source: a.source || b.source || sources[0] } : {}),
  }
}

/**
 * 合并来自多个查询/数据源的论文条目（纯函数）：
 * - 按 arxivId / doi / 归一化标题去重，合并保留最丰富的元信息（如 arXiv 摘要+分类 与 OpenAlex venue+DOI）；
 * - 按 publishedAt || published || updatedAt || year 从新到旧排序。
 */
export function mergeFeedItems(rawItems, { limit } = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return []
  const entries = []
  const byArxiv = new Map()
  const byDoi = new Map()
  const byTitle = new Map()

  const registerKeys = (slot, entry) => {
    if (entry.arxivId) byArxiv.set(entry.arxivId.toLowerCase(), slot)
    if (entry.doi) byDoi.set(entry.doi.toLowerCase(), slot)
    const titleKey = normalizeTitle(entry.title)
    if (titleKey) byTitle.set(titleKey, slot)
  }

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue
    const item = cloneNormalizedItem(raw)
    const hitSlots = new Set()
    if (item.arxivId) {
      const s = byArxiv.get(item.arxivId.toLowerCase())
      if (s !== undefined) hitSlots.add(s)
    }
    if (item.doi) {
      const s = byDoi.get(item.doi.toLowerCase())
      if (s !== undefined) hitSlots.add(s)
    }
    const titleKey = normalizeTitle(item.title)
    if (titleKey) {
      const s = byTitle.get(titleKey)
      if (s !== undefined) hitSlots.add(s)
    }

    if (hitSlots.size === 0) {
      const slot = entries.length
      entries.push(item)
      registerKeys(slot, item)
      continue
    }

    const slots = [...hitSlots].sort((x, y) => x - y)
    const primarySlot = slots[0]
    let merged = mergeTwoItems(entries[primarySlot], item)
    for (let i = 1; i < slots.length; i += 1) {
      const extraSlot = slots[i]
      if (entries[extraSlot]) {
        merged = mergeTwoItems(merged, entries[extraSlot])
        entries[extraSlot] = null
      }
    }
    entries[primarySlot] = merged
    registerKeys(primarySlot, merged)
  }

  const sorted = sortFeedItems(entries.filter(Boolean))
  if (limit === undefined || limit === null) return sorted
  const max = clampInt(limit, sorted.length, 1, 10000)
  return sorted.slice(0, max)
}

/** 按发布时间倒序检索最新 arXiv 论文。 */
export async function searchArxivLatest({
  categories,
  keywords,
  limit = DEFAULT_LATEST_LIMIT,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT,
  now,
  fetchImpl,
} = {}) {
  const url = buildArxivLatestUrl({ categories, keywords, limit })
  const xml = await fetchText(url, {
    timeoutMs,
    accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
    fetchImpl,
  })
  const items = sortFeedItems(parseArxivAtom(xml))
  return { source: 'arxiv', items, fetchedAt: isoNow(now) }
}

/** 按近 90 天发布时间倒序检索最新 OpenAlex 论文。 */
export async function searchOpenAlexLatest({
  keywords,
  topicQueries,
  limit = DEFAULT_LATEST_LIMIT,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT,
  days = DEFAULT_OPENALEX_WINDOW_DAYS,
  now,
  fetchImpl,
} = {}) {
  const url = buildOpenAlexLatestUrl({ keywords, topicQueries, limit, days, now })
  const body = await fetchText(url, {
    timeoutMs,
    accept: 'application/json',
    fetchImpl,
  })
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error('检索失败：OpenAlex 返回的不是合法 JSON')
  }
  const items = sortFeedItems(parseOpenAlexWorks(payload))
  return { source: 'openalex', items, fetchedAt: isoNow(now) }
}

async function mapSettledWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(runners)
  return results
}

function matchCustomTopicIds(item, customEntries) {
  if (customEntries.length === 1) return [customEntries[0].id]
  const haystack = [item.title || '', item.abstract || '', ...(item.authors || [])].join(' ').toLowerCase()
  const matched = customEntries.filter((entry) => haystack.includes(entry.keyword.toLowerCase())).map((e) => e.id)
  return matched.length > 0 ? matched : customEntries.map((e) => e.id)
}

/**
 * 拉取科研订阅 Feed（预设主题 + 自定义关键词）：
 * - 单任务/单源失败不阻塞其余结果，出错详情记入 partialErrors；
 * - 结果按 arxivId / doi / 归一化标题去重合并，并按发布日期从新到旧排序。
 */
export async function fetchTopicFeed({
  subscribed = [],
  custom = [],
  source = 'arxiv',
  limit = DEFAULT_FEED_LIMIT,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT,
  days = DEFAULT_OPENALEX_WINDOW_DAYS,
  now,
  fetchImpl,
} = {}) {
  const src = source === undefined || source === null || String(source).trim() === '' ? 'arxiv' : String(source).trim()
  if (src !== 'arxiv' && src !== 'openalex' && src !== 'both') {
    throw new Error('订阅拉取失败：不支持的数据源（' + src + '）')
  }

  const max = clampInt(limit, DEFAULT_FEED_LIMIT, 1, 200)
  const partialErrors = []
  const topics = []
  const presets = []
  const seenPresetIds = new Set()

  const subscribedList = Array.isArray(subscribed) ? subscribed : subscribed ? [subscribed] : []
  for (const entry of subscribedList) {
    const id = typeof entry === 'string' ? entry.trim() : entry && typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id || seenPresetIds.has(id)) continue
    seenPresetIds.add(id)
    const preset = PRESET_TOPIC_MAP.get(id)
    if (!preset) {
      partialErrors.push({
        source: 'preset',
        topicId: id,
        label: id,
        message: '未知预设主题：' + id,
      })
      continue
    }
    presets.push(preset)
    topics.push({
      id: preset.id,
      label: preset.label,
      desc: preset.desc,
      kind: 'preset',
      arxivCategories: [...preset.arxivCategories],
    })
  }

  const customKeywords = []
  const customObjects = []
  const seenCustom = new Set()
  const customList = Array.isArray(custom) ? custom : custom ? [custom] : []
  for (const entry of customList) {
    if (typeof entry === 'string') {
      const kw = entry.trim()
      const key = kw.toLowerCase()
      if (!kw || seenCustom.has(key)) continue
      seenCustom.add(key)
      const topicId = 'custom:' + kw
      customKeywords.push({ id: topicId, keyword: kw })
      topics.push({ id: topicId, label: kw, kind: 'custom' })
    } else if (entry && typeof entry === 'object') {
      const kws = toStringList(entry.keywords ?? entry.query, false)
      const cats = toStringList(entry.categories ?? entry.arxivCategories, true)
      if (kws.length === 0 && cats.length === 0) continue
      const label = String(entry.label || kws[0] || cats.join(',')).trim()
      const topicId = String(entry.id || 'custom:' + label).trim()
      if (seenCustom.has(topicId.toLowerCase())) continue
      seenCustom.add(topicId.toLowerCase())
      customObjects.push({ id: topicId, label, keywords: kws, categories: cats })
      topics.push({ id: topicId, label, kind: 'custom' })
    }
  }

  const fetchedAt = isoNow(now)
  if (presets.length === 0 && customKeywords.length === 0 && customObjects.length === 0) {
    return { topics, items: [], fetchedAt, partialErrors }
  }

  const unitCount = presets.length + (customKeywords.length > 0 ? 1 : 0) + customObjects.length
  const perLimit = clampInt(unitCount <= 1 ? max : Math.max(8, Math.ceil((max * 1.5) / unitCount)), max, 1, 50)
  const useArxiv = src === 'arxiv' || src === 'both'
  const useOpenAlex = src === 'openalex' || src === 'both'

  const tasks = []
  const pushTask = (taskSource, topicId, label, runSearch, resolveTopics) => {
    tasks.push({
      source: taskSource,
      topicId,
      label,
      run: async () => {
        const res = await runSearch()
        return res.items.map((item) => ({
          ...item,
          source: taskSource,
          sources: [taskSource],
          topics: resolveTopics(item),
        }))
      },
    })
  }

  for (const preset of presets) {
    if (useArxiv) {
      pushTask(
        'arxiv',
        preset.id,
        preset.label,
        () =>
          searchArxivLatest({
            categories: preset.arxivCategories,
            keywords: parseTopicArxivTerms(preset.arxivQuery),
            limit: perLimit,
            timeoutMs,
            now,
            fetchImpl,
          }),
        () => [preset.id],
      )
    }
    if (useOpenAlex) {
      pushTask(
        'openalex',
        preset.id,
        preset.label,
        () =>
          searchOpenAlexLatest({
            topicQueries: preset.openalexQuery,
            limit: perLimit,
            timeoutMs,
            days,
            now,
            fetchImpl,
          }),
        () => [preset.id],
      )
    }
  }

  if (customKeywords.length > 0) {
    const kwList = customKeywords.map((c) => c.keyword)
    const labelText = kwList.join(', ')
    const mapTopics = (item) => matchCustomTopicIds(item, customKeywords)
    if (useArxiv) {
      pushTask(
        'arxiv',
        customKeywords[0].id,
        labelText,
        () => searchArxivLatest({ keywords: kwList, limit: perLimit, timeoutMs, now, fetchImpl }),
        mapTopics,
      )
    }
    if (useOpenAlex) {
      pushTask(
        'openalex',
        customKeywords[0].id,
        labelText,
        () => searchOpenAlexLatest({ keywords: kwList, limit: perLimit, timeoutMs, days, now, fetchImpl }),
        mapTopics,
      )
    }
  }

  for (const obj of customObjects) {
    if (useArxiv) {
      pushTask(
        'arxiv',
        obj.id,
        obj.label,
        () =>
          searchArxivLatest({
            categories: obj.categories,
            keywords: obj.keywords,
            limit: perLimit,
            timeoutMs,
            now,
            fetchImpl,
          }),
        () => [obj.id],
      )
    }
    if (useOpenAlex && obj.keywords.length > 0) {
      pushTask(
        'openalex',
        obj.id,
        obj.label,
        () => searchOpenAlexLatest({ keywords: obj.keywords, limit: perLimit, timeoutMs, days, now, fetchImpl }),
        () => [obj.id],
      )
    }
  }

  const settled = await mapSettledWithConcurrency(tasks, 3, (task) => task.run())
  const collected = []
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i]
    const task = tasks[i]
    if (result.status === 'fulfilled') {
      collected.push(...result.value)
    } else {
      partialErrors.push({
        source: task.source,
        topicId: task.topicId,
        label: task.label,
        message: messageOf(result.reason),
      })
    }
  }

  return {
    topics,
    items: mergeFeedItems(collected, { limit: max }),
    fetchedAt,
    partialErrors,
  }
}
