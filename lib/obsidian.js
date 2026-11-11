/**
 * Obsidian 论文知识库读写（仅 Node 标准库）。
 * 为什么不引 YAML 库：frontmatter 用“行级合并”就够 —— 解析后整体重写会打乱键序、吃掉注释与
 * 未知字段，破坏用户依赖 frontmatter 的 dataview 查询。为什么备份 + .tmp + rename：Obsidian
 * 开着 vault 会即时扫描文件，原子替换保证它读到的永远是完整版本。只读函数绝不写盘。
 */
import { promises as fsp, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

const SECTION_FIELDS = ['抽取状态', '一句话结论', '研究问题', '方法线索', '应用场景', '局限线索']
const KB_SECTION = '内容知识化'
const CARD_TAGS = ['llm-paper-kb', 'paper-card']
const SURVEY_TAGS = ['llm-paper-kb', 'survey']

// 所有行操作都把 \r 留在行尾：join('\n') 时 CRLF 原样还原，不改用户文件的换行风格。
const splitLines = (text) => String(text ?? '').split('\n')
const bare = (line) => String(line ?? '').replace(/\r$/, '')
const eolSuffix = (text) => (String(text ?? '').includes('\r\n') ? '\r' : '')
const withEol = (lines, eol) => lines.map((line) => line + eol)
const escapeRegExp = (text) => String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isCardFile = (name) => /\.md$/i.test(name) && !/\.pb-backup\.md$/i.test(name)
const backupPath = (target) => (/\.md$/i.test(target) ? target.replace(/\.md$/i, '.pb-backup.md') : target + '.pb-backup.md')

async function exists(target, wantDir = false) {
  try {
    const stat = await fsp.stat(target)
    return wantDir ? stat.isDirectory() : true
  } catch {
    return false
  }
}

function kbPath(kb) {
  if (typeof kb === 'string' && kb.trim() !== '') return kb
  if (kb && typeof kb.path === 'string' && kb.path !== '') return kb.path
  throw new Error('论文知识库路径无效：请先调用 detectPaperKb()')
}

// ------------------------------------------------------------------ vault 探测
/** 读 Obsidian 的 vault 清单；文件缺失/损坏按空清单处理。 */
export function listVaults() {
  if (!process.env.APPDATA) return []
  try {
    const data = JSON.parse(readFileSync(path.join(process.env.APPDATA, 'obsidian', 'obsidian.json'), 'utf8'))
    const vaults = data && typeof data.vaults === 'object' && data.vaults !== null ? data.vaults : {}
    return Object.values(vaults)
      .filter((vault) => vault && typeof vault.path === 'string' && vault.path.trim() !== '')
      .map((vault) => ({ path: vault.path, open: vault.open === true }))
      .sort((a, b) => Number(b.open) - Number(a.open)) // 打开中的在前，detectVault 取第一个
  } catch {
    return []
  }
}

export function detectVault() {
  const open = listVaults().find((vault) => vault.open)
  return open ? open.path : null
}

/** 找论文知识库根：同时含 论文/ 与队列文件；优先名字含「论文知识库」，其次层级浅的。 */
export async function detectPaperKb(vaultPath) {
  const root = typeof vaultPath === 'string' ? vaultPath : vaultPath && vaultPath.path
  if (!root) return null
  const found = []
  const queue = [{ dir: root, depth: 0 }]
  const isKb = async (dir) =>
    (await exists(path.join(dir, '论文'), true)) &&
    ((await exists(path.join(dir, '论文阅读队列.md'))) || (await exists(path.join(dir, '00-论文知识库总览.md'))))
  while (queue.length > 0) {
    const item = queue.shift()
    if (await isKb(item.dir)) found.push(item)
    if (item.depth >= 3) continue // 再深就不像知识库根了
    const entries = await fsp.readdir(item.dir, { withFileTypes: true }).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 })
    }
  }
  if (found.length === 0) return null
  found.sort((a, b) => {
    const named = Number(!path.basename(a.dir).includes('论文知识库')) - Number(!path.basename(b.dir).includes('论文知识库'))
    return named !== 0 ? named : a.depth - b.depth
  })
  return found[0].dir
}

// ------------------------------------------------------------------ frontmatter 解析
function frontmatterBounds(lines) {
  if (lines.length === 0 || bare(lines[0]).replace(/^\uFEFF/, '') !== '---') return null
  for (let i = 1; i < lines.length; i += 1) if (bare(lines[i]) === '---' || bare(lines[i]) === '...') return { open: 0, close: i }
  return null
}

/** YAML 标量子集；写回用 JSON.stringify 加引号，所以双引号串用 JSON.parse 还原最稳。 */
function parseScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) } catch { return text.slice(1, -1) }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'")
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

/** 内联列表：正则按引号内/外的逗号切分，引号里的逗号不会被拆开。 */
function parseFlowList(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return parseScalar(trimmed)
  const parts = trimmed.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) || []
  return parts.map((part) => part.trim()).filter((part) => part !== '').map(parseScalar)
}

/** 认不出的嵌套映射/多行字符串原样进 extra：写回永远基于原文行，extra 只保证信息不丢。 */
function parseYamlSubset(lines) {
  const frontmatter = {}
  const extra = {}
  let i = 0
  while (i < lines.length) {
    const line = bare(lines[i])
    i += 1
    if (line.trim() === '' || line.trimStart().startsWith('#') || /^\s/.test(line)) continue
    const colon = line.indexOf(':')
    if (colon <= 0) {
      extra[line.trim()] = [line]
      continue
    }
    const key = line.slice(0, colon).trim()
    const rest = line.slice(colon + 1).trim()
    if (rest !== '') {
      if (rest.startsWith('[')) frontmatter[key] = parseFlowList(rest)
      else if (rest.startsWith('{') || /^[|>]/.test(rest)) extra[key] = [line]
      else frontmatter[key] = parseScalar(rest)
      continue
    }
    const block = []
    while (i < lines.length && /^\s+\S/.test(bare(lines[i]))) {
      block.push(lines[i])
      i += 1
    }
    if (block.length > 0 && block.every((item) => /^\s*-\s/.test(bare(item)))) {
      frontmatter[key] = block.map((item) => parseScalar(bare(item).replace(/^\s*-\s?/, '')))
    } else if (block.length > 0) extra[key] = block
    else frontmatter[key] = ''
  }
  return { frontmatter, extra }
}

/** 解析整份 Markdown：frontmatter / 原始行 / 正文 / 正文起始行号（1 起）。 */
export function parseFrontmatter(text) {
  const raw = String(text ?? '')
  const lines = splitLines(raw)
  const bounds = frontmatterBounds(lines)
  if (bounds === null) return { frontmatter: {}, extra: {}, lines, body: raw, bodyStartLine: 1 }
  const parsed = parseYamlSubset(lines.slice(bounds.open + 1, bounds.close))
  return { frontmatter: parsed.frontmatter, extra: parsed.extra, lines, body: lines.slice(bounds.close + 1).join('\n'), bodyStartLine: bounds.close + 2 }
}

// ------------------------------------------------------------------ frontmatter 行级合并
/** 只在会被 YAML 误读时加引号；Windows 路径里的 ":\" 不会被误读，保持原样。 */
function formatScalar(value) {
  if (value === null || value === undefined) return '~'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const text = String(value)
  if (text === '') return '""'
  if (/^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/i.test(text)) return JSON.stringify(text)
  const risky = /^[\s>|&*!%@`{}\[\],#'"-]/.test(text) || /[\s#]$/.test(text) || text.includes(': ') || /[\n\t]/.test(text)
  return risky ? JSON.stringify(text) : text
}

const formatFlowList = (values) => '[' + values.map((value) => formatScalar(value)).join(', ') + ']'
const entryLines = (key, value) => (Array.isArray(value) ? [`${key}: ${formatFlowList(value)}`] : [`${key}: ${formatScalar(value)}`])

function sameValue(existing, value) {
  if (!Array.isArray(existing) && !Array.isArray(value)) return String(existing ?? '') === String(value ?? '')
  if (!Array.isArray(existing) || !Array.isArray(value) || existing.length !== value.length) return false
  return existing.every((item, index) => String(item) === String(value[index]))
}

/** 改一个 key：值相同一个字节不动；保持标量/内联/块列表风格；嵌套结构识别不了就跳过。 */
function replaceOrAppendField(fmLines, key, value, eol) {
  const index = fmLines.findIndex((line) => {
    const text = bare(line)
    if (/^[\s#]/.test(text)) return false
    const colon = text.indexOf(':')
    return colon > 0 && text.slice(0, colon).trim() === key
  })
  if (index < 0) {
    fmLines.push(...withEol(entryLines(key, value), eol))
    return
  }
  const raw = fmLines[index], text = bare(raw), cr = raw.endsWith('\r') ? '\r' : eol
  const colon = text.indexOf(':'), afterColon = text.slice(colon + 1)
  const gap = /^\s*/.exec(afterColon)[0], inline = afterColon.trim()
  let blockEnd = index + 1
  while (blockEnd < fmLines.length && /^\s+\S/.test(bare(fmLines[blockEnd]))) blockEnd += 1
  const blockLines = fmLines.slice(index + 1, blockEnd)
  const isBlock = blockLines.length > 0 && blockLines.every((line) => /^\s*-\s/.test(bare(line)) && !/^\s*-\s+\S+:\s/.test(bare(line)))
  if (blockLines.length > 0 && !isBlock) return
  const current = inline.startsWith('[')
    ? parseFlowList(inline)
    : isBlock
      ? blockLines.map((line) => parseScalar(bare(line).replace(/^\s*-\s?/, '')))
      : parseScalar(inline)
  if (sameValue(current, value)) return
  const count = isBlock ? blockLines.length : 0, space = gap === '' ? ' ' : gap
  if (Array.isArray(value) && isBlock && value.length > 0) {
    const prefix = /^\s*-\s?/.exec(bare(blockLines[0]))[0]
    fmLines.splice(index + 1, count, ...withEol(value.map((item) => prefix + formatScalar(item)), eol))
    return
  }
  const rendered = Array.isArray(value) ? formatFlowList(value) : formatScalar(value)
  fmLines.splice(index, 1 + count, text.slice(0, colon + 1) + space + rendered + cr)
}

/** 行级合并 frontmatter：只改 patch 里出现的 key；没有 frontmatter 就补一块在最前面。 */
export function mergeFrontmatter(text, patch) {
  const source = String(text ?? '')
  const fields = patch && typeof patch === 'object' ? patch : {}
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return source
  const lines = splitLines(source)
  const bounds = frontmatterBounds(lines)
  const eol = source.includes('\r\n') ? '\r' : ''
  if (bounds === null) {
    const head = withEol(['---', ...entries.flatMap(([key, value]) => entryLines(key, value)), '---'], eol)
    return head.join('\n') + (source === '' ? '\n' : '\n\n' + source.replace(/^\n+/, ''))
  }
  const fmLines = lines.slice(bounds.open + 1, bounds.close)
  for (const [key, value] of entries) replaceOrAppendField(fmLines, key, value, eol)
  return [...lines.slice(0, bounds.open + 1), ...fmLines, ...lines.slice(bounds.close)].join('\n')
}

// ------------------------------------------------------------------ 卡片读取与定位
function titleOf(file, body) {
  for (const line of splitLines(body)) {
    const match = /^#[ \t]+(.+?)\s*$/.exec(bare(line))
    if (match !== null) return match[1].trim()
  }
  return path.basename(file).replace(/\.md$/i, '')
}

/** 递归遍历 Markdown；跳过 .trash/.obsidian/node_modules 与符号链接（防环）。 */
async function walkMarkdown(root, accept) {
  const out = []
  const visit = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!['.trash', '.obsidian', 'node_modules'].includes(entry.name)) await visit(full)
      } else if (entry.isFile() && accept(entry.name)) out.push(full)
    }
  }
  await visit(root)
  return out
}

export async function readCard(cardPath) {
  const target = String(cardPath ?? '')
  const raw = await fsp.readFile(target, 'utf8')
  const parsed = parseFrontmatter(raw)
  return { path: target, frontmatter: parsed.frontmatter, body: parsed.body, raw }
}

/** 递归读 论文/ 下所有卡片（忽略 .pb-backup.md 与 .trash）。 */
export async function listCards(kb) {
  const cards = []
  for (const file of await walkMarkdown(path.join(kbPath(kb), '论文'), isCardFile)) {
    try {
      const parsed = parseFrontmatter(await fsp.readFile(file, 'utf8'))
      cards.push({ path: file, title: titleOf(file, parsed.body), frontmatter: parsed.frontmatter })
    } catch {
      // 单张读不出来（被占用/正在同步）不该让整库列表失败
    }
  }
  return cards
}

/** Windows 路径比较键：剥长路径前缀、统一分隔符、大小写不敏感。 */
const normalizePathKey = (value) => String(value ?? '').replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase()

/** source_relative 两边可能一个相对 vault、一个相对知识库，用路径段后缀兜住。 */
function relativeMatch(left, right) {
  const a = normalizePathKey(left).replace(/^\\+/, ''), b = normalizePathKey(right).replace(/^\\+/, '')
  return a !== '' && b !== '' && (a === b || a.endsWith('\\' + b) || b.endsWith('\\' + a))
}

/** 定位卡片：frontmatter.source → source_relative → 标题同名文件；都没有返回 null。 */
export async function locateCard(kb, target) {
  const wanted = target && typeof target === 'object' ? target : {}
  const cards = await listCards(kbPath(kb))
  if (wanted.source) {
    const key = normalizePathKey(wanted.source)
    const hit = cards.find((card) => normalizePathKey(card.frontmatter.source) === key)
    if (hit !== undefined) return hit
  }
  if (wanted.sourceRelative) {
    const hit = cards.find((card) => relativeMatch(card.frontmatter.source_relative, wanted.sourceRelative))
    if (hit !== undefined) return hit
  }
  if (wanted.title && String(wanted.title).trim() !== '') {
    const fileName = safeFileName(wanted.title).toLowerCase() + '.md', title = String(wanted.title).trim().toLowerCase()
    const hit = cards.find((card) => path.basename(card.path).toLowerCase() === fileName || card.title.trim().toLowerCase() === title)
    if (hit !== undefined) return hit
  }
  return null
}

// ------------------------------------------------------------------ 正文小节写入
const normalizeBlockText = (value) => String(value ?? '').replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '')
const oneLine = (value) => normalizeBlockText(value).replace(/\n+/g, ' ').trim()
const hasFieldLine = (text, key) => new RegExp('^[ \\t]*(?:-[ \\t]*)?' + escapeRegExp(key) + '[ \\t]*[：:]', 'm').test(String(text ?? ''))

function findHeading(lines, title) {
  const pattern = new RegExp('^##[ \\t]+' + escapeRegExp(title) + '[ \\t]*\\r?$')
  return lines.findIndex((line) => pattern.test(line))
}

function sectionEnd(lines, start) {
  for (let i = start + 1; i < lines.length; i += 1) if (/^##[ \t]/.test(bare(lines[i]))) return i
  return lines.length
}

/** 在文末接一个块，前后各留一个空行，文件以换行结尾。 */
function appendBlock(text, blockLines) {
  const lines = splitLines(text), eol = eolSuffix(text), blank = eol === '\r' ? '\r' : ''
  while (lines.length > 0 && bare(lines[lines.length - 1]) === '') lines.pop()
  if (lines.length > 0) lines.push(blank)
  lines.push(...withEol(blockLines, eol), blank)
  return lines.join('\n')
}

/** 改「## 内容知识化」字段行：只换值；不存在就按兄弟行的缩进/「- 」风格补一行。 */
function applyFieldLine(text, key, value) {
  const lines = splitLines(text), eol = eolSuffix(text), blank = eol === '\r' ? '\r' : ''
  const nextValue = oneLine(value), heading = findHeading(lines, KB_SECTION)
  if (heading < 0) return appendBlock(text, ['## ' + KB_SECTION, '', '- ' + key + '：' + nextValue])
  const end = sectionEnd(lines, heading)
  const fieldPattern = new RegExp('^([ \\t]*(?:-[ \\t]*)?' + escapeRegExp(key) + '[ \\t]*[：:][ \\t]*)(.*)$')
  for (let i = heading + 1; i < end; i += 1) {
    const match = fieldPattern.exec(bare(lines[i]))
    if (match === null) continue
    if (match[2].trim() === nextValue) return text // 值没变：连行尾都不动
    lines[i] = match[1] + nextValue + (lines[i].endsWith('\r') ? '\r' : eol)
    return lines.join('\n')
  }
  // 字段行不存在：沿用兄弟字段的缩进与「- 」前缀，插在小节最后一个非空行后面
  const stylePattern = /^([ \t]*)(-[ \t]*)?(.+?)([ \t]*[：:])/
  let style = { indent: '', dash: '- ', separator: '：' }
  for (let i = heading + 1; i < end; i += 1) {
    const match = stylePattern.exec(bare(lines[i]))
    if (match !== null) { style = { indent: match[1], dash: match[2] || '', separator: match[4].trim() || '：' }; break }
  }
  const newLine = style.indent + style.dash + key + style.separator + nextValue + eol
  let last = heading
  for (let i = end - 1; i > heading; i -= 1) if (bare(lines[i]).trim() !== '') { last = i; break }
  if (last === heading) {
    // 小节里只有标题：空一行再写字段，保持 Markdown 排版
    const needsBlank = heading + 1 >= lines.length || bare(lines[heading + 1]).trim() !== ''
    lines.splice(heading + 1, 0, ...(needsBlank ? [blank, newLine] : [newLine]))
  } else lines.splice(last + 1, 0, newLine)
  return lines.join('\n')
}

function findLiteralLine(lines, from, to, literal) {
  for (let i = from; i < to; i += 1) if (bare(lines[i]) === literal) return i
  return -1
}

/** 写带 pb 标记的二级小节；已存在但没有标记的小节不碰（避免覆盖人工内容）。 */
function applySubsection(text, key, content) {
  const lines = splitLines(text), eol = eolSuffix(text), heading = findHeading(lines, key)
  const block = ['## ' + key, '', '<!-- pb:begin ' + key + ' -->']
  if (content !== '') block.push(...content.split('\n'))
  block.push('<!-- pb:end ' + key + ' -->')
  if (heading < 0) return appendBlock(text, block)
  const end = sectionEnd(lines, heading)
  const begin = findLiteralLine(lines, heading + 1, end, '<!-- pb:begin ' + key + ' -->')
  const finish = findLiteralLine(lines, heading + 1, end, '<!-- pb:end ' + key + ' -->')
  if (begin < 0 || finish < 0 || finish <= begin) return text
  const replacement = withEol(content === '' ? [] : content.split('\n'), eol)
  if (lines.slice(begin + 1, finish).join('\n') === replacement.join('\n')) return text
  lines.splice(begin + 1, finish - begin - 1, ...replacement)
  return lines.join('\n')
}

function applySections(text, sections) {
  if (!sections || typeof sections !== 'object') return text
  let output = text
  for (const [rawKey, rawValue] of Object.entries(sections)) {
    if (rawValue === undefined || rawValue === null) continue
    const key = String(rawKey).trim()
    if (key === '') continue
    const content = normalizeBlockText(rawValue)
    // 内容知识化下的固定字段按“字段行”改；其它键（精读报告/译文摘要）按二级小节写
    if (SECTION_FIELDS.includes(key) || hasFieldLine(output, key)) output = applyFieldLine(output, key, content)
    else output = applySubsection(output, key, content)
  }
  return output
}

// ------------------------------------------------------------------ 写盘
/** 内容有变化才写：备份旧文件（只保留一份）→ 写 .tmp → rename 原子替换。 */
async function writeText(target, content) {
  let original = null
  try { original = await fsp.readFile(target, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (original !== null && original === content) return { changed: false, created: false }
  await fsp.mkdir(path.dirname(target), { recursive: true })
  if (original !== null) await fsp.copyFile(target, backupPath(target)) // copyFile 按字节复制
  await fsp.writeFile(target + '.tmp', content, 'utf8')
  await fsp.rename(target + '.tmp', target)
  return { changed: true, created: original === null }
}

/** 文件名清洗：去掉 Windows 非法字符与控制字符、压缩空白、截断 80 字符。 */
function safeFileName(title) {
  let name = String(title ?? '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim()
  name = name.replace(/[. ]+$/g, '') // Windows 会静默去掉结尾的点和空格，留着下次按标题就找不到同名文件
  if (name.length > 80) name = name.slice(0, 80).trim()
  if (name === '') throw new Error('标题里没有可用的文件名字符：' + title)
  return name
}

function mergeSpec(paper, patch) {
  const base = paper && typeof paper === 'object' ? paper : {}, over = patch && typeof patch === 'object' ? patch : {}
  return { ...base, ...over, fields: { ...(base.fields || {}), ...(over.fields || {}) }, sections: { ...(base.sections || {}), ...(over.sections || {}) } }
}

function renderFrontmatter(fields) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) lines.push(...entryLines(key, value))
  lines.push('---', '')
  return lines.join('\n')
}

/** 更新既有文件：frontmatter 行级合并 + 正文小节写入。 */
async function updateCardFile(target, spec) {
  const next = applySections(mergeFrontmatter(await fsp.readFile(target, 'utf8'), spec.fields || {}), spec.sections || {})
  const result = await writeText(target, next)
  return { path: target, created: false, changed: result.changed }
}

async function createCardFile(target, spec) {
  const category = String(spec.category ?? '').trim() === '' ? '未分类' : String(spec.category).trim()
  const fields = {
    tags: CARD_TAGS.slice(), status: 'generated', generated: new Date().toISOString(), paper_category: category,
    paper_status: 'unread', paper_priority: 'normal',
    ...(spec.source ? { source: String(spec.source) } : {}), ...(spec.sourceRelative ? { source_relative: String(spec.sourceRelative) } : {}),
  }
  let text = renderFrontmatter(fields) + '\n# ' + spec.title + '\n'
  text = applySections(text, spec.sections || {})
  text = mergeFrontmatter(text, spec.fields || {}) // fields 补丁最后合并，可覆盖最小 frontmatter 的默认值
  const result = await writeText(target, text)
  return { path: target, created: true, changed: result.changed }
}

/** 新建或更新论文卡片。paper: { title, category?, source?, sourceRelative?, fields?, sections? } */
export async function upsertCard(kb, paper, patch) {
  const root = kbPath(kb)
  const spec = mergeSpec(paper, patch)
  if (typeof spec.title !== 'string' || spec.title.trim() === '') throw new Error('upsertCard 需要论文标题（title）')
  const existing = await locateCard(root, { source: spec.source, sourceRelative: spec.sourceRelative, title: spec.title })
  if (existing !== null) return updateCardFile(existing.path, spec)
  const category = String(spec.category ?? '').trim() === '' ? '未分类' : String(spec.category).trim()
  const target = path.join(root, '论文', safeFileName(category), safeFileName(spec.title) + '.md')
  if (await exists(target)) return updateCardFile(target, spec) // 契约：已有同名文件就复用
  return createCardFile(target, spec)
}

/** 改 paper_status / paper_priority；paperOrPath 可以是路径、卡片对象或定位参数。 */
export async function setStatus(kb, paperOrPath, status, priority) {
  const root = kbPath(kb), value = String(status ?? '').trim()
  if (value === '') throw new Error('setStatus 需要目标状态（status）')
  let target = null
  if (typeof paperOrPath === 'string' && paperOrPath.trim() !== '') target = paperOrPath
  else if (paperOrPath && typeof paperOrPath.path === 'string') target = paperOrPath.path
  else if (paperOrPath && typeof paperOrPath === 'object') {
    const found = await locateCard(root, paperOrPath)
    if (found === null) throw new Error('没有找到要改状态的卡片：' + JSON.stringify(paperOrPath))
    target = found.path
  }
  if (target === null) throw new Error('setStatus 需要卡片路径或含 path/source/title 的对象')
  const patch = { paper_status: value }
  if (priority !== undefined && priority !== null && String(priority).trim() !== '') patch.paper_priority = String(priority).trim()
  const result = await writeText(target, mergeFrontmatter(await fsp.readFile(target, 'utf8'), patch))
  return { path: target, changed: result.changed }
}

/** 写方向综述：frontmatter 补 tags 与 generated，正文整体替换，其余字段保留。 */
export async function writeSurvey(kb, topic, markdown) {
  const title = String(topic ?? '').trim()
  if (title === '') throw new Error('writeSurvey 需要综述主题（topic）')
  const target = path.join(kbPath(kb), '方向综述', safeFileName(title) + '.md')
  const body = normalizeBlockText(markdown)
  let original = null
  try { original = await fsp.readFile(target, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  let next
  if (original === null) {
    next = renderFrontmatter({ tags: SURVEY_TAGS.slice(), generated: new Date().toISOString() }) + (body === '' ? '' : '\n' + body + '\n')
  } else {
    const parsed = parseFrontmatter(original)
    const existingTags = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags.map((item) => String(item)) : []
    const fields = { tags: [...existingTags, ...SURVEY_TAGS.filter((tag) => !existingTags.includes(tag))] }
    if (parsed.frontmatter.generated === undefined) fields.generated = new Date().toISOString() // 已有则保留，重复写不刷时间
    const merged = mergeFrontmatter(original, fields)
    const lines = splitLines(merged), bounds = frontmatterBounds(lines)
    if (bounds === null) throw new Error('综述 frontmatter 结构异常，已中止写入：' + target)
    const eol = eolSuffix(merged), bodyLines = body === '' ? [] : body.split('\n').map((line) => line + eol)
    next = lines.slice(0, bounds.close + 1).join('\n') + '\n' + (bodyLines.length === 0 ? '' : '\n' + bodyLines.join('\n') + '\n')
  }
  const result = await writeText(target, next)
  return { path: target, created: result.created, changed: result.changed }
}

// ------------------------------------------------------------------ 全文检索与打开
/**
 * 知识库内字面量检索（大小写不敏感、不做正则），返回命中行前后 60 字符的片段。
 * 范围是知识库目录（论文/分类/方向综述/队列），不是整个 vault，避免卷进无关笔记。
 */
export async function searchVault(kb, query, limit = 20) {
  const needle = String(query ?? '').toLowerCase()
  if (needle === '') return []
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 20
  const hits = []
  for (const file of await walkMarkdown(kbPath(kb), isCardFile)) {
    if (hits.length >= max) break
    let raw = ''
    try { raw = await fsp.readFile(file, 'utf8') } catch { continue }
    const parsed = parseFrontmatter(raw), title = titleOf(file, parsed.body)
    for (const rawLine of parsed.lines) {
      const line = bare(rawLine), at = line.toLowerCase().indexOf(needle)
      if (at < 0) continue
      const start = Math.max(0, at - 60), end = Math.min(line.length, at + needle.length + 60)
      hits.push({ path: file, title, snippet: (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '') })
      if (hits.length >= max) break
    }
  }
  return hits
}

/** 按 PATH + PATHEXT 找 CLI；找不到返回 null（openInObsidian 据此返回 false）。 */
function resolveCli(command) {
  if (process.platform !== 'win32') return command
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter((item) => item !== '')
  const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((item) => item !== '')
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), command + ext.toLowerCase())
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 用 Obsidian CLI 打开卡片：detached 启动后立刻返回，绝不等待窗口。
 * 参数直接传 "path=<path>"（不经 shell，加引号反而会让引号成为路径的一部分）。
 */
export function openInObsidian(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') return false
  const command = resolveCli('obsidian')
  if (command === null) return false
  try {
    const child = spawn(command, ['open', 'path=' + path.resolve(targetPath)], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {}) // ENOENT 等异步错误吞掉，不能让“打开窗口”失败打断工作流
    child.unref()
    return true
  } catch {
    return false
  }
}
