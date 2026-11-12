/**
 * 会话（conversation）的纯逻辑：形状、id、范围提示词。
 *
 * 为什么单独一层：
 *   - 「哪些论文算这次对话的范围」要能单测，不该埋在 HTTP handler 里；
 *   - 提示词是给模型看的，格式改一次就会影响所有回答，集中在这里改、在这里测；
 *   - 这里不碰磁盘、不碰宿主，store.js / index.js / SPA 都复用同一套形状。
 *
 * 形状（chats.json）：
 *   { version: 1, activeId: 'c-xxx', items: [conversation] }
 *   conversation = { id, title, sessionId, paperIds, attachments, createdAt, updatedAt }
 *   attachment   = { name, path, size, at }
 */

export const CONV_PREFIX = 'pb-conv-'
export const MAX_SESSION_ID = 64
const MAX_TITLE = 80
const MAX_PAPERS = 30
const MAX_ATTACHMENTS = 40

/** 会话 id：`c-<36 进制时间>-<随机>`，满足 store 的 ID_RE（小写字母开头、≤80）。 */
export function newConversationId(now = Date.now(), random = Math.random) {
  const stamp = Math.max(0, Math.floor(Number(now) || 0)).toString(36)
  const rand = Math.floor((typeof random === 'function' ? random() : Math.random()) * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return ('c-' + stamp + '-' + rand).slice(0, 80)
}

/** 宿主会话 id：`pb-conv-<会话 id 的合法化>`，超长截断，空则 `pb-conv-conv`。 */
export function sessionIdForConversation(conversationId) {
  const raw = conversationId === undefined || conversationId === null ? '' : String(conversationId)
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const room = MAX_SESSION_ID - CONV_PREFIX.length
  const body = cleaned === '' ? 'conv' : cleaned.length > room ? cleaned.slice(0, room).replace(/-+$/, '') : cleaned
  return CONV_PREFIX + (body === '' ? 'conv' : body)
}

function text(value) {
  return value === undefined || value === null ? '' : String(value)
}

function paperId(value) {
  const id = text(value).trim()
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id) ? id : ''
}

/** 去重、去空、限长；顺序保留（用户挑论文的顺序就是提示词里的顺序）。 */
export function normalizePaperIds(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const id = paperId(item)
    if (id !== '' && !out.includes(id)) out.push(id)
    if (out.length >= MAX_PAPERS) break
  }
  return out
}

export function normalizeAttachments(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue
    const filePath = text(item.path).trim()
    if (filePath === '') continue
    out.push({
      name: text(item.name).trim() || filePath.split(/[\\/]/).pop() || '附件',
      path: filePath,
      size: Math.max(0, Math.floor(Number(item.size) || 0)),
      at: text(item.at) || null,
    })
    if (out.length >= MAX_ATTACHMENTS) break
  }
  return out
}

export function normalizeTitle(value, fallback = '未命名对话') {
  const title = text(value).replace(/\s+/g, ' ').trim()
  if (title === '') return fallback
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE) : title
}

/** 读进来的任何形状都收敛成契约形状；坏条目直接丢掉，不让一条脏数据拖垮整个列表。 */
export function normalizeConversation(raw, { now = new Date().toISOString() } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const id = text(src.id).trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)) return null
  const createdAt = text(src.createdAt) || now
  return {
    id,
    title: normalizeTitle(src.title, '论文对话'),
    sessionId: text(src.sessionId).trim() || sessionIdForConversation(id),
    paperIds: normalizePaperIds(src.paperIds),
    attachments: normalizeAttachments(src.attachments),
    createdAt,
    updatedAt: text(src.updatedAt) || createdAt,
  }
}

export function normalizeChats(raw, { now = new Date().toISOString() } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const items = []
  const seen = new Set()
  for (const item of Array.isArray(src.items) ? src.items : []) {
    const conv = normalizeConversation(item, { now })
    if (!conv || seen.has(conv.id)) continue
    seen.add(conv.id)
    items.push(conv)
  }
  const activeId = text(src.activeId).trim()
  return {
    version: 1,
    activeId: activeId !== '' && seen.has(activeId) ? activeId : items.length > 0 ? items[0].id : null,
    items,
  }
}

/** 新建一条会话：标题没给就按第一篇论文叫「《标题》的对话」。 */
export function makeConversation(input = {}, { now = new Date().toISOString(), random = Math.random } = {}) {
  const id = newConversationId(Date.now(), random)
  const paperIds = normalizePaperIds(input.paperIds)
  return {
    id,
    title: normalizeTitle(input.title, paperIds.length > 0 ? '论文对话' : '新对话'),
    sessionId: sessionIdForConversation(id),
    paperIds,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** 部分更新：只改传入的字段；paperIds / attachments 传了才替换。 */
export function mergeConversation(prev, patch = {}, { now = new Date().toISOString() } = {}) {
  const base = normalizeConversation(prev, { now })
  if (!base) return null
  const src = patch && typeof patch === 'object' ? patch : {}
  const next = { ...base, updatedAt: now }
  if (src.title !== undefined) next.title = normalizeTitle(src.title, base.title)
  if (src.paperIds !== undefined) next.paperIds = normalizePaperIds(src.paperIds)
  if (src.attachments !== undefined) next.attachments = normalizeAttachments(src.attachments)
  if (src.sessionId !== undefined) {
    const sessionId = text(src.sessionId).trim()
    if (sessionId !== '') next.sessionId = sessionId
  }
  return next
}

function pageText(pages) {
  const n = Math.floor(Number(pages) || 0)
  return n > 0 ? n + ' 页' : ''
}

/**
 * 拼「这次对话看哪些论文 / 哪些附件」的提示词前缀。
 * papers: [{ id, title, pages, path }]，attachments: [{ name, path }]。
 * 没有范围时返回空串（单篇问答不需要前缀，保持提问原样）。
 */
export function buildScopePrompt({ conversation, papers, attachments } = {}) {
  const conv = conversation && typeof conversation === 'object' ? conversation : {}
  const list = (Array.isArray(papers) ? papers : []).filter((p) => p && text(p.id).trim() !== '')
  const files = normalizeAttachments(
    attachments !== undefined && attachments !== null ? attachments : conv.attachments,
  )
  const lines = []
  if (list.length > 0) {
    lines.push('【本次对话的论文范围】')
    list.forEach((paper, index) => {
      const id = text(paper.id).trim()
      const title = text(paper.title).trim() || id
      const bits = ['《' + title + '》', 'id=' + id]
      const pages = pageText(paper.pages)
      if (pages !== '') bits.push(pages)
      const filePath = text(paper.path).trim()
      if (filePath !== '') bits.push('PDF: ' + filePath)
      lines.push(String(index + 1) + '. ' + bits.join(' · '))
    })
    lines.push('需要正文时用 paper_read / paper_doc 工具（参数 id 用上面的 id），不要凭空猜内容。')
  }
  if (files.length > 0) {
    lines.push('【用户上传的附件】')
    for (const file of files) lines.push('- ' + file.name + '：' + file.path)
    lines.push('这些是本地文件，直接用文件工具读取。')
  }
  if (lines.length > 0) {
    lines.push('引用原文时用 [p.N] 标页码。')
    lines.push('')
  }
  return lines.join('\n')
}

/** 会话列表给前端用的摘要（只带界面上要显示的字段）。 */
export function conversationSummary(conv) {
  const c = normalizeConversation(conv)
  if (!c) return null
  return {
    id: c.id,
    title: c.title,
    sessionId: c.sessionId,
    paperIds: c.paperIds,
    attachmentCount: c.attachments.length,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}
