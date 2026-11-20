/** 浏览历史仅保留有界书目信息；检索结果、摘要、正文和凭据不进入界面状态。 */
const LIMIT = 200
const paperIdRe = /^[a-z0-9][a-z0-9._-]{0,79}$/
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\r\n\u0000]+/g, ' ').trim().slice(0, max) : ''

function parseHistoryUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('论文链接无效，请使用 HTTP(S) 原文链接') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('论文链接只支持 HTTP(S)')
  if (parsed.username || parsed.password) throw new Error('论文链接不能包含认证信息')
  return parsed
}

export function normalizeHistoryItem(raw, { now = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('缺少论文浏览记录')
  const title = clean(raw.title, 500)
  if (!title) throw new Error('浏览记录缺少论文题名')
  const paperId = paperIdRe.test(raw.paperId || '') ? raw.paperId : ''
  let doi = clean(raw.doi, 2000)
  if (/^https?:\/\//i.test(doi)) {
    const parsed = parseHistoryUrl(doi)
    if (!['doi.org', 'dx.doi.org'].includes(parsed.hostname)) throw new Error('论文 DOI 解析器链接无效')
    doi = parsed.pathname.slice(1)
    try { doi = decodeURIComponent(doi) } catch { /* 保留原 DOI 编码，继续校验。 */ }
  }
  doi = clean(doi, 200).toLowerCase()
  if (doi && !/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error('论文 DOI 标识无效')
  const arxivId = clean(raw.arxivId, 100).replace(/^arxiv:/i, '').replace(/v\d+$/i, '')
  if (arxivId && !/^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/i.test(arxivId)) throw new Error('论文 arXiv 标识无效')
  let url = clean(raw.url || raw.absUrl, 2000)
  if (url) {
    const parsed = parseHistoryUrl(url)
    // 历史只保留公开地址部分，签名参数与阅读定位均不持久化。
    url = parsed.origin + parsed.pathname
  }
  if (!paperId && !doi && !arxivId && !url) throw new Error('浏览记录缺少论文标识或链接')
  const id = doi ? 'doi:' + doi : arxivId ? 'arxiv:' + arxivId.toLowerCase() : url ? 'url:' + url : 'paper:' + paperId
  return {
    id, title,
    ...(doi ? { doi } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(url ? { url } : {}),
    ...(paperId ? { paperId } : {}),
    source: clean(raw.source, 40) || (paperId ? 'library' : ''),
    lastViewedAt: Number.isFinite(Date.parse(now)) ? new Date(now).toISOString() : new Date().toISOString(),
  }
}

export function normalizeBrowseHistory(raw) {
  if (!Array.isArray(raw)) return []
  const items = []
  for (const value of raw.slice(0, LIMIT * 2)) {
    try {
      items.push(normalizeHistoryItem(value, { now: value?.lastViewedAt }))
    } catch { /* 损坏或旧格式条目不阻断正常界面状态。 */ }
  }
  const recentFirst = (a, b) => Date.parse(b.lastViewedAt) - Date.parse(a.lastViewedAt)
  const groups = []
  for (const item of items.sort(recentFirst)) {
    const aliases = new Set(['doi', 'arxivId', 'url', 'paperId']
      .filter(key => item[key])
      .map(key => key + ':' + (key === 'doi' || key === 'arxivId' ? item[key].toLowerCase() : item[key])))
    const matches = groups.filter(group => [...aliases].some(key => group.aliases.has(key)))
    const merged = {}
    // 最近记录优先，旧记录只补空字段；桥接记录可同时合并 DOI 与 arXiv 两组。
    for (const value of [...matches.map(group => group.item), item].sort(recentFirst)) {
      for (const [key, field] of Object.entries(value)) if (!merged[key] && field) merged[key] = field
    }
    for (const group of matches) {
      for (const key of group.aliases) aliases.add(key)
      groups.splice(groups.indexOf(group), 1)
    }
    groups.push({ item: normalizeHistoryItem(merged, { now: merged.lastViewedAt }), aliases })
  }
  return groups.map(group => group.item).sort(recentFirst).slice(0, LIMIT)
}
