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
    const primary = /<arxiv:primary_category\b[^>]*?\bterm="([^"]*)"/.exec(block)
    const published = cleanAtomText(pickTag(block, 'published'))
    const year = /^\d{4}/.test(published) ? Number(published.slice(0, 4)) : null
    items.push({
      arxivId,
      title: cleanAtomText(pickTag(block, 'title')),
      authors: parseAtomAuthors(block),
      year,
      published: published === '' ? null : published,
      abstract: cleanAtomText(pickTag(block, 'summary')) || null,
      // 少数老论文没有 pdf link，用编号兜底拼一个稳定地址。
      pdfUrl: pdfLink ? toHttps(pdfLink.href) : arxivId === null ? null : 'https://arxiv.org/pdf/' + arxivId,
      absUrl: rawId === '' ? null : toHttps(rawId),
      primaryCategory: primary ? decodeXmlEntities(primary[1]) : null,
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
async function fetchText(url, { timeoutMs = DEFAULT_SEARCH_TIMEOUT, accept = '*/*' } = {}) {
  const timeout = clampInt(timeoutMs, DEFAULT_SEARCH_TIMEOUT, 1000, 600000)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  try {
    const res = await fetch(url, {
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
      return {
        // OpenAlex 的 work.id 是 https://openalex.org/W123 形式，返回裸 ID 更方便当键用。
        id: openalexId ? openalexId[0] : work.id || null,
        doi: normalizeDoi(work.doi),
        title: work.title || work.display_name || null,
        authors: Array.isArray(work.authorships)
          ? work.authorships.map((entry) => (entry && entry.author && entry.author.display_name) || '').filter(Boolean)
          : [],
        year: Number.isInteger(work.publication_year) ? work.publication_year : null,
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
