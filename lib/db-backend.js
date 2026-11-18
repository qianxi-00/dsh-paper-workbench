/**
 * 统一异步多数据库后端门面（SQLite / JSON 退化 / PostgreSQL v3 / MySQL v10）。
 *
 * 设计要点：
 *   - 零第三方 npm 依赖：SQLite 异步包装 ./db.js（保留其 node:sqlite -> JSON 自动退化与全部边界语义）；
 *     PostgreSQL 使用 ./db-pg.js；MySQL 使用 ./db-mysql.js。
 *   - 严格表前缀白名单（/^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/，默认 'pb_'）+ 标识符安全引用 + 全参数化查询。
 *   - 5 张核心表与 lib/db.js 契约完全一致：translations / job_events / reviews / annotations / study_notes。
 *   - 跨后端迁移（migrateTo）支持 SQLite <-> PostgreSQL <-> MySQL 任意互转，事务写入、校验计数且绝不破坏源库。
 */
import path from 'node:path'

import * as defaultSqliteModule from './db.js'
import { createMysqlClient, createMysqlPool, quoteMysqlIdent } from './db-mysql.js'
import { createPgClient, createPgPool, quotePgIdent } from './db-pg.js'

export const DEFAULT_TABLE_PREFIX = 'pb_'
export const TABLE_PREFIX_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/
export const SNAPSHOT_FORMAT = 'dsh-paper-workbench-db'
export const SNAPSHOT_VERSION = 1

const DEFAULT_TARGET = 'zh'
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
const BATCH_SIZE = 200
const ANN_KINDS = new Set(['highlight', 'underline', 'bold', 'comment', 'insert'])
const ANN_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple', 'note'])
const STUDY_SCOPES = new Set(['paper', 'section', 'selection', 'figure', 'formula'])

const TABLE_BASES = ['translations', 'job_events', 'reviews', 'annotations', 'study_notes']

/* ------------------------------------------------------------------ 校验与规范化 */

export function validateTablePrefix(prefix) {
  if (prefix === undefined || prefix === null || prefix === '') return DEFAULT_TABLE_PREFIX
  const raw = String(prefix)
  if (!TABLE_PREFIX_RE.test(raw)) {
    throw new Error(
      '数据库表前缀不合法（仅允许字母、数字和下划线，须以字母或下划线开头，长度 1~16）：' + raw,
    )
  }
  return raw
}

function normalizeDriverName(raw) {
  const s = String(raw || 'sqlite').trim().toLowerCase()
  if (s === '' || s === 'sqlite' || s === 'sqlite3') return 'sqlite'
  if (s === 'postgres' || s === 'postgresql' || s === 'pg') return 'postgres'
  if (s === 'mysql' || s === 'mariadb') return 'mysql'
  throw new Error('不支持的数据库驱动类型：' + String(raw))
}

/**
 * 归一化配置：同时兼容完整 config（{ database: { driver, postgres: {...} } }）
 * 与扁平配置（{ driver: 'postgres', host, port, ... }）。
 */
export function normalizeDbConfig(input = {}) {
  const root = input && typeof input === 'object' ? input : {}
  const dbSection = root.database && typeof root.database === 'object' ? root.database : root
  const driver = normalizeDriverName(dbSection.driver)
  const sub = dbSection[driver] && typeof dbSection[driver] === 'object' ? dbSection[driver] : {}
  const merged = { ...dbSection, ...sub }
  const tablePrefix = validateTablePrefix(
    sub.tablePrefix !== undefined ? sub.tablePrefix : dbSection.tablePrefix,
  )

  if (driver === 'sqlite') {
    return {
      driver: 'sqlite',
      tablePrefix,
      path: typeof merged.path === 'string' && merged.path.trim() !== '' ? path.resolve(merged.path.trim()) : '',
    }
  }

  const defaultPort = driver === 'postgres' ? 5432 : 3306
  const port = merged.port === undefined || merged.port === '' ? defaultPort : Number(merged.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`数据库端口号不合法：${merged.port}`)
  }

  return {
    driver,
    tablePrefix,
    host: String(merged.host || '127.0.0.1').trim() || '127.0.0.1',
    port,
    database: String(merged.database || (driver === 'postgres' ? 'postgres' : 'paper_workbench')).trim(),
    user: String(merged.user || (driver === 'postgres' ? 'postgres' : 'root')).trim(),
    password: merged.password === undefined || merged.password === null ? '' : String(merged.password),
    ssl: merged.ssl ?? false,
    connectTimeoutMs: Math.max(200, Number(merged.connectTimeoutMs) || 8000),
    queryTimeoutMs: Math.max(500, Number(merged.queryTimeoutMs) || 30000),
    maxPoolSize: Math.max(1, Math.min(32, Number(merged.maxPoolSize) || 4)),
  }
}

function configSignature(cfg) {
  return JSON.stringify({
    driver: cfg.driver,
    tablePrefix: cfg.tablePrefix,
    path: cfg.path || '',
    host: cfg.host || '',
    port: cfg.port || 0,
    database: cfg.database || '',
    user: cfg.user || '',
    password: cfg.password || '',
    ssl: cfg.ssl ?? false,
    connectTimeoutMs: cfg.connectTimeoutMs || 0,
    queryTimeoutMs: cfg.queryTimeoutMs || 0,
    maxPoolSize: cfg.maxPoolSize || 0,
  })
}

function assertPaperId(paperId) {
  if (typeof paperId !== 'string' || paperId.trim() === '') throw new Error('论文 id 不能为空')
  return paperId
}

let lastIsoMs = 0
function nowIso() {
  const now = Date.now()
  lastIsoMs = now > lastIsoMs ? now : lastIsoMs + 1
  return new Date(lastIsoMs).toISOString()
}

function toCount(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.floor(n))
}

function entryText(key, value, strict) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if (typeof value.zh === 'string') return value.zh
    if (typeof value.text === 'string') return value.text
  }
  if (!strict) return null
  throw new Error('译文条目必须是字符串（或以 zh 为字段的对象）：' + key)
}

function entriesToPairs(entries, strict) {
  if (entries === null || entries === undefined) return []
  if (typeof entries !== 'object' || Array.isArray(entries)) {
    if (!strict) return []
    throw new Error('entries 必须是 { key: text } 形式的对象')
  }
  const byKey = new Map()
  for (const [key, value] of Object.entries(entries)) {
    if (key === '') throw new Error('entries 里有空的 key')
    const text = entryText(key, value, strict)
    if (text === null) continue
    byKey.set(key, text)
  }
  return [...byKey.entries()]
}

function modelText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (error) {
    throw new Error('模型信息不是可序列化的数据', { cause: error })
  }
}

function parseModel(text) {
  if (typeof text !== 'string' || text === '') return ''
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? parsed : text
  } catch {
    return text
  }
}

function jsonText(value, label) {
  if (value === null || value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch (error) {
    throw new Error(label + '不是可序列化的数据', { cause: error })
  }
}

function parseJsonValue(text) {
  if (text === null || text === undefined || text === '') return null
  if (typeof text !== 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function normalizeJobInput(event) {
  const src = event && typeof event === 'object' ? event : {}
  const level = src.level === 'warn' || src.level === 'error' ? src.level : 'info'
  const kind = src.kind === null || src.kind === undefined || src.kind === '' ? 'log' : String(src.kind)
  const message = src.message === null || src.message === undefined ? '' : String(src.message)
  const extra = jsonText(src.extra, '日志的 extra ')
  const at = typeof src.at === 'string' && src.at !== '' ? src.at : nowIso()
  return { at, level, kind, message, extra }
}

function normalizeReviewInput(review) {
  const src = review && typeof review === 'object' ? review : {}
  const at = typeof src.at === 'string' && src.at !== '' ? src.at : nowIso()
  const mode = typeof src.mode === 'string' && src.mode !== '' ? src.mode : 'both'
  const payload = {
    issues: Array.isArray(src.issues) ? src.issues : [],
    stats: src.stats && typeof src.stats === 'object' && !Array.isArray(src.stats) ? src.stats : {},
  }
  for (const [key, value] of Object.entries(src)) {
    if (key === 'at' || key === 'mode' || key === 'issues' || key === 'stats') continue
    payload[key] = value
  }
  const text = jsonText(payload, '自检结果') || '{}'
  return { at, mode, payload, text }
}

function normalizeAnnotationInput(raw, fallbackNow, preserveUpdatedAt = false) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const paragraphKey = String(src.paragraphKey ?? src.paragraph_key ?? '').trim().toLowerCase()
  if (!paragraphKey) throw new Error('标注缺少段落键（paragraphKey）')
  const idRaw = String(src.id || '').trim()
  const id = idRaw || ('ann-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))
  const kind = ANN_KINDS.has(String(src.kind || 'highlight')) ? String(src.kind || 'highlight') : 'highlight'
  const color = ANN_COLORS.has(String(src.color || 'yellow')) ? String(src.color || 'yellow') : 'yellow'
  const target = src.target === 'zh' ? 'zh' : 'orig'
  const startOffset = Math.max(0, Math.floor(Number(src.startOffset ?? src.start_offset ?? 0) || 0))
  const endOffset = Math.max(startOffset, Math.floor(Number(src.endOffset ?? src.end_offset ?? startOffset) || 0))
  return {
    id,
    paragraphKey,
    target,
    kind,
    color,
    startOffset,
    endOffset,
    quote: String(src.quote ?? src.text ?? '').slice(0, 8000),
    prefix: String(src.prefix ?? '').slice(-120),
    suffix: String(src.suffix ?? '').slice(0, 120),
    note: String(src.note ?? '').slice(0, 8000),
    page: Math.max(1, Math.floor(Number(src.page) || 1)),
    sectionId: src.sectionId || src.section_id ? String(src.sectionId ?? src.section_id).slice(0, 120) : null,
    blockId: src.blockId || src.block_id ? String(src.blockId ?? src.block_id).slice(0, 200) : null,
    createdAt: typeof src.createdAt === 'string' && src.createdAt ? src.createdAt : fallbackNow,
    updatedAt: preserveUpdatedAt && typeof src.updatedAt === 'string' && src.updatedAt ? src.updatedAt : fallbackNow,
  }
}

function formatAnnotationRow(row) {
  return {
    id: row.id,
    paragraphKey: row.paragraph_key,
    target: row.target || 'orig',
    kind: row.kind || 'highlight',
    color: row.color || 'yellow',
    startOffset: Number(row.start_offset) || 0,
    endOffset: Number(row.end_offset) || 0,
    quote: row.quote || '',
    prefix: row.prefix || '',
    suffix: row.suffix || '',
    note: row.note || '',
    page: Number(row.page) || 1,
    sectionId: row.section_id || null,
    blockId: row.block_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }
}

function normalizeStudyNoteInput(raw, fallbackNow, preserveUpdatedAt = false) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const title = String(src.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || '研读笔记'
  const markdown = String(src.markdown ?? src.content ?? '').trim()
  if (!markdown) throw new Error('研读笔记内容（markdown）不能为空')
  const idRaw = String(src.id || '').trim()
  const id = idRaw || ('sn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))
  const scopeRaw = String(src.scope || 'section')
  const scope = STUDY_SCOPES.has(scopeRaw) ? scopeRaw : 'section'
  return {
    id,
    title,
    scope,
    sectionId: src.sectionId || src.section_id ? String(src.sectionId ?? src.section_id).slice(0, 120) : null,
    page: Math.max(1, Math.floor(Number(src.page) || 1)),
    blockId: src.blockId || src.block_id ? String(src.blockId ?? src.block_id).slice(0, 200) : null,
    anchorQuote: String(src.anchorQuote ?? src.anchor_quote ?? '').slice(0, 2000),
    markdown: markdown.slice(0, 120000),
    payload: src.payload ? jsonText(src.payload, '笔记附加数据') : null,
    createdAt: typeof src.createdAt === 'string' && src.createdAt ? src.createdAt : fallbackNow,
    updatedAt: preserveUpdatedAt && typeof src.updatedAt === 'string' && src.updatedAt ? src.updatedAt : fallbackNow,
  }
}

function formatStudyNoteRow(row) {
  return {
    id: row.id,
    title: row.title,
    scope: row.scope || 'section',
    sectionId: row.section_id || null,
    page: Number(row.page) || 1,
    blockId: row.block_id || null,
    anchorQuote: row.anchor_quote || '',
    markdown: row.markdown || '',
    payload: parseJsonValue(row.payload),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }
}

function dedupeById(items) {
  const map = new Map()
  for (const item of items) map.set(item.id, item)
  return [...map.values()]
}

function tableNames(prefix, quoteFn) {
  const safePrefix = validateTablePrefix(prefix)
  const raw = {}
  const quoted = {}
  for (const base of TABLE_BASES) {
    const name = safePrefix + base
    raw[base] = name
    quoted[base] = quoteFn(name)
  }
  return { prefix: safePrefix, raw, quoted }
}

function chunkList(items, size = BATCH_SIZE) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function sanitizeErrorMessage(error, cfg) {
  let msg = error && error.message ? String(error.message) : String(error || '未知数据库错误')
  if (cfg && cfg.password) {
    msg = msg.split(cfg.password).join('***')
  }
  return msg
}

/* ------------------------------------------------------------------ DDL 生成 */

function buildPgDdl(prefix) {
  const { prefix: safePrefix, quoted } = tableNames(prefix, quotePgIdent)
  const idx = (suffix) => quotePgIdent('idx_' + safePrefix + suffix)
  return [
    `CREATE TABLE IF NOT EXISTS ${quoted.translations} (
      paper_id TEXT NOT NULL,
      target TEXT NOT NULL,
      key TEXT NOT NULL,
      text TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (paper_id, target, key)
    )`,
    `CREATE INDEX IF NOT EXISTS ${idx('trans_paper_updated')} ON ${quoted.translations} (paper_id, updated_at)`,

    `CREATE TABLE IF NOT EXISTS ${quoted.job_events} (
      seq BIGSERIAL PRIMARY KEY,
      paper_id TEXT NOT NULL,
      at TEXT NOT NULL,
      level TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      extra TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS ${idx('job_paper_seq')} ON ${quoted.job_events} (paper_id, seq)`,

    `CREATE TABLE IF NOT EXISTS ${quoted.reviews} (
      paper_id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      mode TEXT NOT NULL,
      payload TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS ${quoted.annotations} (
      paper_id TEXT NOT NULL,
      id TEXT NOT NULL,
      paragraph_key TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'orig',
      kind TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'yellow',
      start_offset INTEGER NOT NULL DEFAULT 0,
      end_offset INTEGER NOT NULL DEFAULT 0,
      quote TEXT NOT NULL DEFAULT '',
      prefix TEXT NOT NULL DEFAULT '',
      suffix TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      page INTEGER NOT NULL DEFAULT 1,
      section_id TEXT,
      block_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (paper_id, id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${idx('ann_paper_page')} ON ${quoted.annotations} (paper_id, page, start_offset, created_at)`,

    `CREATE TABLE IF NOT EXISTS ${quoted.study_notes} (
      paper_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'section',
      section_id TEXT,
      page INTEGER NOT NULL DEFAULT 1,
      block_id TEXT,
      anchor_quote TEXT NOT NULL DEFAULT '',
      markdown TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (paper_id, id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${idx('study_paper_updated')} ON ${quoted.study_notes} (paper_id, updated_at, created_at)`,
  ]
}

function buildMysqlDdl(prefix) {
  const { quoted } = tableNames(prefix, quoteMysqlIdent)
  return [
    `CREATE TABLE IF NOT EXISTS ${quoted.translations} (
      paper_id VARCHAR(191) NOT NULL,
      target VARCHAR(64) NOT NULL,
      \`key\` VARCHAR(255) NOT NULL,
      text LONGTEXT NOT NULL,
      model LONGTEXT NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (paper_id, target, \`key\`),
      INDEX idx_trans_paper_updated (paper_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${quoted.job_events} (
      seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      paper_id VARCHAR(191) NOT NULL,
      at VARCHAR(64) NOT NULL,
      level VARCHAR(32) NOT NULL,
      kind VARCHAR(64) NOT NULL,
      message LONGTEXT NOT NULL,
      extra LONGTEXT NULL,
      INDEX idx_job_paper_seq (paper_id, seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${quoted.reviews} (
      paper_id VARCHAR(191) NOT NULL PRIMARY KEY,
      at VARCHAR(64) NOT NULL,
      mode VARCHAR(64) NOT NULL,
      payload LONGTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${quoted.annotations} (
      paper_id VARCHAR(191) NOT NULL,
      id VARCHAR(191) NOT NULL,
      paragraph_key VARCHAR(255) NOT NULL,
      target VARCHAR(32) NOT NULL DEFAULT 'orig',
      kind VARCHAR(32) NOT NULL,
      color VARCHAR(32) NOT NULL DEFAULT 'yellow',
      start_offset INT NOT NULL DEFAULT 0,
      end_offset INT NOT NULL DEFAULT 0,
      quote LONGTEXT NOT NULL,
      prefix VARCHAR(512) NOT NULL,
      suffix VARCHAR(512) NOT NULL,
      note LONGTEXT NOT NULL,
      page INT NOT NULL DEFAULT 1,
      section_id VARCHAR(191) NULL,
      block_id VARCHAR(255) NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (paper_id, id),
      INDEX idx_ann_paper_page (paper_id, page, start_offset, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ${quoted.study_notes} (
      paper_id VARCHAR(191) NOT NULL,
      id VARCHAR(191) NOT NULL,
      title VARCHAR(255) NOT NULL,
      scope VARCHAR(32) NOT NULL DEFAULT 'section',
      section_id VARCHAR(191) NULL,
      page INT NOT NULL DEFAULT 1,
      block_id VARCHAR(255) NULL,
      anchor_quote LONGTEXT NOT NULL,
      markdown LONGTEXT NOT NULL,
      payload LONGTEXT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (paper_id, id),
      INDEX idx_study_paper_updated (paper_id, updated_at, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ]
}

/* ------------------------------------------------------------------ SQL 适配器（PG / MySQL 共用逻辑） */

function createSqlAdapter(cfg, pool, dialect) {
  const isPg = dialect === 'postgres'
  const quote = isPg ? quotePgIdent : quoteMysqlIdent
  const tables = tableNames(cfg.tablePrefix, quote)
  const qt = tables.quoted

  let schemaPromise = null
  const ph = (index) => (isPg ? '$' + index : '?')

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        const statements = isPg ? buildPgDdl(cfg.tablePrefix) : buildMysqlDdl(cfg.tablePrefix)
        for (const ddl of statements) {
          await pool.simpleQuery(ddl)
        }
      })().catch((err) => {
        schemaPromise = null
        throw err
      })
    }
    return schemaPromise
  }

  function rowChanges(res) {
    return isPg ? Number(res.rowCount) || 0 : Number(res.affectedRows) || 0
  }

  async function runInTx(connOrPool, fn) {
    if (connOrPool !== pool) return fn(connOrPool)
    return pool.tx((conn) => fn(conn))
  }

  async function upsertTranslationsOn(conn, paperId, target, model, pairs, atOverride) {
    if (pairs.length === 0) return 0
    const at = atOverride || nowIso()
    for (const chunk of chunkList(pairs)) {
      const params = []
      const valuesSql = chunk.map(([key, text]) => {
        const base = params.length
        params.push(paperId, target, key, text, model, at)
        return `(${ph(base + 1)}, ${ph(base + 2)}, ${ph(base + 3)}, ${ph(base + 4)}, ${ph(base + 5)}, ${ph(base + 6)})`
      }).join(', ')
      if (isPg) {
        await conn.query(
          `INSERT INTO ${qt.translations} (paper_id, target, key, text, model, updated_at)
           VALUES ${valuesSql}
           ON CONFLICT (paper_id, target, key) DO UPDATE SET
             text = EXCLUDED.text, model = EXCLUDED.model, updated_at = EXCLUDED.updated_at`,
          params,
        )
      } else {
        await conn.query(
          `INSERT INTO ${qt.translations} (\`paper_id\`, \`target\`, \`key\`, \`text\`, \`model\`, \`updated_at\`)
           VALUES ${valuesSql}
           ON DUPLICATE KEY UPDATE
             \`text\` = VALUES(\`text\`), \`model\` = VALUES(\`model\`), \`updated_at\` = VALUES(\`updated_at\`)`,
          params,
        )
      }
    }
    return pairs.length
  }

  async function deleteTranslationsByKeysOn(conn, paperId, keys) {
    let total = 0
    for (const chunk of chunkList(keys, 500)) {
      const params = [paperId, ...chunk]
      const holes = chunk.map((_, idx) => ph(idx + 2)).join(', ')
      const keyCol = isPg ? 'key' : '`key`'
      const res = await conn.query(
        `DELETE FROM ${qt.translations} WHERE paper_id = ${ph(1)} AND ${keyCol} IN (${holes})`,
        params,
      )
      total += rowChanges(res)
    }
    return total
  }

  async function upsertAnnotationsOn(conn, paperId, items) {
    if (items.length === 0) return []
    const unique = dedupeById(items)
    for (const chunk of chunkList(unique)) {
      const params = []
      const valuesSql = chunk.map((a) => {
        const b = params.length
        params.push(
          paperId, a.id, a.paragraphKey, a.target, a.kind, a.color,
          a.startOffset, a.endOffset, a.quote, a.prefix, a.suffix,
          a.note, a.page, a.sectionId, a.blockId, a.createdAt, a.updatedAt,
        )
        const holes = []
        for (let i = 1; i <= 17; i += 1) holes.push(ph(b + i))
        return `(${holes.join(', ')})`
      }).join(', ')

      if (isPg) {
        await conn.query(
          `INSERT INTO ${qt.annotations} (
             paper_id, id, paragraph_key, target, kind, color, start_offset, end_offset,
             quote, prefix, suffix, note, page, section_id, block_id, created_at, updated_at
           ) VALUES ${valuesSql}
           ON CONFLICT (paper_id, id) DO UPDATE SET
             paragraph_key = EXCLUDED.paragraph_key, target = EXCLUDED.target, kind = EXCLUDED.kind,
             color = EXCLUDED.color, start_offset = EXCLUDED.start_offset, end_offset = EXCLUDED.end_offset,
             quote = EXCLUDED.quote, prefix = EXCLUDED.prefix, suffix = EXCLUDED.suffix,
             note = EXCLUDED.note, page = EXCLUDED.page, section_id = EXCLUDED.section_id,
             block_id = EXCLUDED.block_id, updated_at = EXCLUDED.updated_at`,
          params,
        )
      } else {
        await conn.query(
          `INSERT INTO ${qt.annotations} (
             paper_id, id, paragraph_key, target, kind, color, start_offset, end_offset,
             quote, prefix, suffix, note, page, section_id, block_id, created_at, updated_at
           ) VALUES ${valuesSql}
           ON DUPLICATE KEY UPDATE
             paragraph_key = VALUES(paragraph_key), target = VALUES(target), kind = VALUES(kind),
             color = VALUES(color), start_offset = VALUES(start_offset), end_offset = VALUES(end_offset),
             quote = VALUES(quote), prefix = VALUES(prefix), suffix = VALUES(suffix),
             note = VALUES(note), page = VALUES(page), section_id = VALUES(section_id),
             block_id = VALUES(block_id), updated_at = VALUES(updated_at)`,
          params,
        )
      }
    }
    return unique
  }

  async function upsertStudyNotesOn(conn, paperId, items) {
    if (items.length === 0) return []
    const unique = dedupeById(items)
    for (const chunk of chunkList(unique)) {
      const params = []
      const valuesSql = chunk.map((n) => {
        const b = params.length
        params.push(
          paperId, n.id, n.title, n.scope, n.sectionId, n.page,
          n.blockId, n.anchorQuote, n.markdown, n.payload, n.createdAt, n.updatedAt,
        )
        const holes = []
        for (let i = 1; i <= 12; i += 1) holes.push(ph(b + i))
        return `(${holes.join(', ')})`
      }).join(', ')

      if (isPg) {
        await conn.query(
          `INSERT INTO ${qt.study_notes} (
             paper_id, id, title, scope, section_id, page, block_id, anchor_quote, markdown, payload, created_at, updated_at
           ) VALUES ${valuesSql}
           ON CONFLICT (paper_id, id) DO UPDATE SET
             title = EXCLUDED.title, scope = EXCLUDED.scope, section_id = EXCLUDED.section_id,
             page = EXCLUDED.page, block_id = EXCLUDED.block_id, anchor_quote = EXCLUDED.anchor_quote,
             markdown = EXCLUDED.markdown, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
          params,
        )
      } else {
        await conn.query(
          `INSERT INTO ${qt.study_notes} (
             paper_id, id, title, scope, section_id, page, block_id, anchor_quote, markdown, payload, created_at, updated_at
           ) VALUES ${valuesSql}
           ON DUPLICATE KEY UPDATE
             title = VALUES(title), scope = VALUES(scope), section_id = VALUES(section_id),
             page = VALUES(page), block_id = VALUES(block_id), anchor_quote = VALUES(anchor_quote),
             markdown = VALUES(markdown), payload = VALUES(payload), updated_at = VALUES(updated_at)`,
          params,
        )
      }
    }
    return unique
  }

  async function jobInsertOn(conn, paperId, normalizedEvent) {
    if (isPg) {
      const res = await conn.query(
        `INSERT INTO ${qt.job_events} (paper_id, at, level, kind, message, extra)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING seq`,
        [paperId, normalizedEvent.at, normalizedEvent.level, normalizedEvent.kind, normalizedEvent.message, normalizedEvent.extra],
      )
      return Number(res.rows[0]?.seq) || 0
    }
    const res = await conn.query(
      `INSERT INTO ${qt.job_events} (paper_id, at, level, kind, message, extra)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [paperId, normalizedEvent.at, normalizedEvent.level, normalizedEvent.kind, normalizedEvent.message, normalizedEvent.extra],
    )
    return Number(res.insertId) || 0
  }

  async function reviewUpsertOn(conn, paperId, norm) {
    if (isPg) {
      await conn.query(
        `INSERT INTO ${qt.reviews} (paper_id, at, mode, payload) VALUES ($1, $2, $3, $4)
         ON CONFLICT (paper_id) DO UPDATE SET at = EXCLUDED.at, mode = EXCLUDED.mode, payload = EXCLUDED.payload`,
        [paperId, norm.at, norm.mode, norm.text],
      )
    } else {
      await conn.query(
        `INSERT INTO ${qt.reviews} (paper_id, at, mode, payload) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE at = VALUES(at), mode = VALUES(mode), payload = VALUES(payload)`,
        [paperId, norm.at, norm.mode, norm.text],
      )
    }
  }

  return {
    driver: dialect,
    engine: dialect,
    tablePrefix: tables.prefix,
    ensureSchema,
    tx: (fn) => pool.tx(fn),
    close: () => pool.close(),

    async counts(conn = pool) {
      const out = {}
      for (const base of TABLE_BASES) {
        const res = await conn.query(`SELECT COUNT(*) AS n FROM ${qt[base]}`)
        out[base] = Number(res.rows[0]?.n) || 0
      }
      return out
    },

    async info() {
      try {
        const ping = await pool.ping()
        const counts = await this.counts()
        return {
          driver: dialect,
          engine: dialect,
          healthy: true,
          details: {
            host: cfg.host,
            port: cfg.port,
            database: cfg.database,
            tablePrefix: tables.prefix,
            serverVersion: ping.serverVersion || pool.serverVersion || null,
          },
          counts,
        }
      } catch (error) {
        return {
          driver: dialect,
          engine: dialect,
          healthy: false,
          details: {
            host: cfg.host,
            port: cfg.port,
            database: cfg.database,
            tablePrefix: tables.prefix,
            serverVersion: pool.serverVersion || null,
            error: sanitizeErrorMessage(error, cfg),
          },
          counts: { translations: 0, job_events: 0, reviews: 0, annotations: 0, study_notes: 0 },
        }
      }
    },

    async transAll(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      const keyCol = isPg ? 'key' : '`key`'
      const res = await conn.query(
        `SELECT target, ${keyCol}, text, model, updated_at FROM ${qt.translations}
         WHERE paper_id = ${ph(1)} ORDER BY updated_at ASC, ${keyCol} ASC`,
        [paperId],
      )
      const out = { version: 1, target: DEFAULT_TARGET, model: '', updatedAt: null, entries: {} }
      for (const row of res.rows) {
        out.entries[row.key] = row.text
        out.target = row.target || DEFAULT_TARGET
        out.model = parseModel(row.model)
        out.updatedAt = row.updated_at || null
      }
      return out
    },

    async transPut(paperId, entries, opts = {}, conn = pool) {
      assertPaperId(paperId)
      const pairs = entriesToPairs(entries, true)
      if (pairs.length === 0) return 0
      const target = typeof opts.target === 'string' && opts.target.trim() !== '' ? opts.target.trim() : DEFAULT_TARGET
      const model = modelText(opts.model)
      if (conn === pool) await ensureSchema()
      return runInTx(conn, (c) => upsertTranslationsOn(c, paperId, target, model, pairs, opts.updatedAt))
    },

    async transMerge(paperId, entries, opts = {}, conn = pool) {
      return this.transPut(paperId, entries, opts, conn)
    },

    async transReplace(paperId, entries, opts = {}, conn = pool) {
      assertPaperId(paperId)
      const pairs = entriesToPairs(entries, true)
      const target = typeof opts.target === 'string' && opts.target.trim() !== '' ? opts.target.trim() : DEFAULT_TARGET
      const model = modelText(opts.model)
      if (conn === pool) await ensureSchema()
      return runInTx(conn, async (c) => {
        const keep = new Set(pairs.map(([k]) => k))
        const keyCol = isPg ? 'key' : '`key`'
        const existing = await c.query(
          `SELECT ${keyCol} FROM ${qt.translations} WHERE paper_id = ${ph(1)}`,
          [paperId],
        )
        const stale = existing.rows.map((r) => r.key).filter((k) => !keep.has(k))
        if (stale.length > 0) await deleteTranslationsByKeysOn(c, paperId, stale)
        if (pairs.length > 0) await upsertTranslationsOn(c, paperId, target, model, pairs, opts.updatedAt)
        return pairs.length
      })
    },

    async transDelete(paperId, keys, conn = pool) {
      assertPaperId(paperId)
      const list = (Array.isArray(keys) ? keys : keys === null || keys === undefined ? [] : [keys])
        .map((k) => String(k))
        .filter((k) => k !== '')
      if (list.length === 0) return 0
      if (conn === pool) await ensureSchema()
      return runInTx(conn, (c) => deleteTranslationsByKeysOn(c, paperId, list))
    },

    async transClear(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      const res = await conn.query(`DELETE FROM ${qt.translations} WHERE paper_id = ${ph(1)}`, [paperId])
      return rowChanges(res)
    },

    async jobAppend(paperId, event, conn = pool) {
      assertPaperId(paperId)
      const norm = normalizeJobInput(event)
      if (conn === pool) await ensureSchema()
      return jobInsertOn(conn, paperId, norm)
    },

    async jobList(paperId, opts = {}, conn = pool) {
      assertPaperId(paperId)
      const after = toCount(opts.after, 0)
      const limit = Math.min(MAX_LIMIT, Math.max(1, toCount(opts.limit, DEFAULT_LIMIT)))
      if (conn === pool) await ensureSchema()
      let rows
      if (opts.latest) {
        const res = await conn.query(
          `SELECT seq, at, level, kind, message, extra FROM ${qt.job_events}
           WHERE paper_id = ${ph(1)} ORDER BY seq DESC LIMIT ${ph(2)}`,
          [paperId, limit],
        )
        rows = res.rows.slice().reverse()
      } else {
        const res = await conn.query(
          `SELECT seq, at, level, kind, message, extra FROM ${qt.job_events}
           WHERE paper_id = ${ph(1)} AND seq > ${ph(2)} ORDER BY seq ASC LIMIT ${ph(3)}`,
          [paperId, after, limit],
        )
        rows = res.rows
      }
      const events = rows.map((row) => ({
        seq: Number(row.seq),
        at: row.at,
        level: row.level,
        kind: row.kind,
        message: row.message,
        extra: parseJsonValue(row.extra),
      }))
      return { events, lastSeq: events.length > 0 ? events[events.length - 1].seq : after }
    },

    async jobClear(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      const res = await conn.query(`DELETE FROM ${qt.job_events} WHERE paper_id = ${ph(1)}`, [paperId])
      return rowChanges(res)
    },

    async reviewPut(paperId, review, conn = pool) {
      assertPaperId(paperId)
      const norm = normalizeReviewInput(review)
      if (conn === pool) await ensureSchema()
      await reviewUpsertOn(conn, paperId, norm)
      return { ...norm.payload, at: norm.at, mode: norm.mode }
    },

    async reviewGet(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      const res = await conn.query(
        `SELECT at, mode, payload FROM ${qt.reviews} WHERE paper_id = ${ph(1)}`,
        [paperId],
      )
      const row = res.rows[0]
      if (!row) return null
      const parsed = parseJsonValue(row.payload)
      const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      return { ...payload, at: row.at, mode: row.mode }
    },

    async reviewDelete(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      const res = await conn.query(`DELETE FROM ${qt.reviews} WHERE paper_id = ${ph(1)}`, [paperId])
      return rowChanges(res)
    },

    async migrateTransJson(paperId, legacy) {
      assertPaperId(paperId)
      if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return 0
      const pairs = entriesToPairs(legacy.entries, false).filter(([, text]) => text !== '')
      if (pairs.length === 0) return 0
      const target = typeof legacy.target === 'string' && legacy.target.trim() !== '' ? legacy.target.trim() : DEFAULT_TARGET
      const model = modelText(legacy.model)
      await ensureSchema()
      return pool.tx(async (conn) => {
        const cntRes = await conn.query(
          `SELECT COUNT(*) AS n FROM ${qt.translations} WHERE paper_id = ${ph(1)}`,
          [paperId],
        )
        if ((Number(cntRes.rows[0]?.n) || 0) > 0) return 0
        return upsertTranslationsOn(conn, paperId, target, model, pairs)
      })
    },

    async annList(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      const res = await conn.query(
        `SELECT id, paragraph_key, target, kind, color, start_offset, end_offset, quote, prefix, suffix,
                note, page, section_id, block_id, created_at, updated_at
         FROM ${qt.annotations} WHERE paper_id = ${ph(1)} ORDER BY page ASC, start_offset ASC, created_at ASC`,
        [paperId],
      )
      return res.rows.map(formatAnnotationRow)
    },

    async annUpsert(paperId, itemOrList, conn = pool, opts = {}) {
      assertPaperId(paperId)
      const rawList = Array.isArray(itemOrList) ? itemOrList : [itemOrList]
      if (rawList.length === 0) return []
      const now = nowIso()
      const preserve = Boolean(opts && opts.preserveUpdatedAt)
      const items = rawList.map((raw) => normalizeAnnotationInput(raw, now, preserve))
      if (conn === pool) await ensureSchema()
      await runInTx(conn, (c) => upsertAnnotationsOn(c, paperId, items))
      return items
    },

    async annReplacePaper(paperId, items, conn = pool, opts = {}) {
      assertPaperId(paperId)
      const rawList = Array.isArray(items) ? items : []
      const now = nowIso()
      const preserve = Boolean(opts && opts.preserveUpdatedAt)
      const normalized = rawList.map((raw) => normalizeAnnotationInput(raw, now, preserve))
      if (conn === pool) await ensureSchema()
      await runInTx(conn, async (c) => {
        await c.query(`DELETE FROM ${qt.annotations} WHERE paper_id = ${ph(1)}`, [paperId])
        if (normalized.length > 0) await upsertAnnotationsOn(c, paperId, normalized)
      })
      return normalized
    },

    async annDelete(paperId, ids, conn = pool) {
      assertPaperId(paperId)
      const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '').trim()).filter(Boolean)
      if (list.length === 0) return 0
      if (conn === pool) await ensureSchema()
      return runInTx(conn, async (c) => {
        let total = 0
        for (const chunk of chunkList(list, 500)) {
          const holes = chunk.map((_, idx) => ph(idx + 2)).join(', ')
          const res = await c.query(
            `DELETE FROM ${qt.annotations} WHERE paper_id = ${ph(1)} AND id IN (${holes})`,
            [paperId, ...chunk],
          )
          total += rowChanges(res)
        }
        return total
      })
    },

    async annClear(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      const res = await conn.query(`DELETE FROM ${qt.annotations} WHERE paper_id = ${ph(1)}`, [paperId])
      return rowChanges(res)
    },

    async studyNoteList(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      const res = await conn.query(
        `SELECT id, title, scope, section_id, page, block_id, anchor_quote, markdown, payload, created_at, updated_at
         FROM ${qt.study_notes} WHERE paper_id = ${ph(1)} ORDER BY updated_at DESC, created_at DESC`,
        [paperId],
      )
      return res.rows.map(formatStudyNoteRow)
    },

    async studyNoteUpsert(paperId, noteOrList, conn = pool, opts = {}) {
      assertPaperId(paperId)
      const rawList = Array.isArray(noteOrList) ? noteOrList : [noteOrList]
      if (rawList.length === 0) return []
      const now = nowIso()
      const preserve = Boolean(opts && opts.preserveUpdatedAt)
      const items = rawList.map((raw) => normalizeStudyNoteInput(raw, now, preserve))
      if (conn === pool) await ensureSchema()
      await runInTx(conn, (c) => upsertStudyNotesOn(c, paperId, items))
      return Array.isArray(noteOrList) ? items : items[0]
    },

    async studyNoteDelete(paperId, ids, conn = pool) {
      assertPaperId(paperId)
      const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '').trim()).filter(Boolean)
      if (list.length === 0) return 0
      if (conn === pool) await ensureSchema()
      return runInTx(conn, async (c) => {
        let total = 0
        for (const chunk of chunkList(list, 500)) {
          const holes = chunk.map((_, idx) => ph(idx + 2)).join(', ')
          const res = await c.query(
            `DELETE FROM ${qt.study_notes} WHERE paper_id = ${ph(1)} AND id IN (${holes})`,
            [paperId, ...chunk],
          )
          total += rowChanges(res)
        }
        return total
      })
    },

    async studyNoteClear(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      const res = await conn.query(`DELETE FROM ${qt.study_notes} WHERE paper_id = ${ph(1)}`, [paperId])
      return rowChanges(res)
    },

    async listPaperIds(conn = pool) {
      if (conn === pool) await ensureSchema()
      const res = await conn.query(
        `SELECT DISTINCT paper_id FROM (
           SELECT paper_id FROM ${qt.translations}
           UNION SELECT paper_id FROM ${qt.job_events}
           UNION SELECT paper_id FROM ${qt.reviews}
           UNION SELECT paper_id FROM ${qt.annotations}
           UNION SELECT paper_id FROM ${qt.study_notes}
         ) AS pb_all_papers`,
      )
      return res.rows.map((r) => String(r.paper_id || '')).filter(Boolean).sort()
    },

    async deletePaperData(paperId, conn = pool) {
      assertPaperId(paperId)
      if (conn === pool) await ensureSchema()
      return runInTx(conn, async (c) => {
        const translations = await this.transClear(paperId, c)
        const job_events = await this.jobClear(paperId, c)
        const reviews = await this.reviewDelete(paperId, c)
        const annotations = await this.annClear(paperId, c)
        const study_notes = await this.studyNoteClear(paperId, c)
        return {
          paperId,
          deleted: { translations, job_events, reviews, annotations, study_notes },
        }
      })
    },
  }
}

/* ------------------------------------------------------------------ SQLite 适配器（复用 ./db.js） */

function createSqliteModuleAdapter(sqliteMod, cfg) {
  return {
    driver: 'sqlite',
    get engine() {
      return sqliteMod.dbInfo().engine
    },
    tablePrefix: cfg.tablePrefix,
    async ensureSchema() {
      sqliteMod.getDb()
    },
    async tx(fn) {
      const handle = sqliteMod.getDb()
      if (typeof handle.tx === 'function') {
        let out
        // sqliteMod handle.tx 为同步事务：先开启事务前只允许同步调用；
        // 对 async 跨库导入我们按批同步写入 ./db.js 的方法，避免 Promise 在事务外提交。
        out = handle.tx(() => fn(null))
        return out
      }
      return fn(null)
    },
    async close() {
      return sqliteMod.closeDb()
    },
    async counts() {
      return sqliteMod.extendedCounts()
    },
    async info() {
      try {
        const base = sqliteMod.dbInfo()
        const counts = sqliteMod.extendedCounts()
        return {
          driver: 'sqlite',
          engine: base.engine,
          healthy: true,
          details: { path: base.path, tablePrefix: cfg.tablePrefix },
          counts: {
            translations: Number(counts.translations) || 0,
            job_events: Number(counts.job_events) || 0,
            reviews: Number(counts.reviews) || 0,
            annotations: Number(counts.annotations) || 0,
            study_notes: Number(counts.study_notes) || 0,
          },
        }
      } catch (error) {
        return {
          driver: 'sqlite',
          engine: 'sqlite',
          healthy: false,
          details: { path: sqliteMod.dbPath(), tablePrefix: cfg.tablePrefix, error: sanitizeErrorMessage(error, cfg) },
          counts: { translations: 0, job_events: 0, reviews: 0, annotations: 0, study_notes: 0 },
        }
      }
    },
    async transAll(paperId) { return sqliteMod.transAll(paperId) },
    async transPut(paperId, entries, opts) { return sqliteMod.transPut(paperId, entries, opts) },
    async transMerge(paperId, entries, opts) { return sqliteMod.transMerge(paperId, entries, opts) },
    async transReplace(paperId, entries, opts) { return sqliteMod.transReplace(paperId, entries, opts) },
    async transDelete(paperId, keys) { return sqliteMod.transDelete(paperId, keys) },
    async transClear(paperId) { return sqliteMod.transClear(paperId) },
    async jobAppend(paperId, event) {
      // 若指定了原始时间戳 at（跨库迁移场景），直接保留原时间戳写入底层 handle
      if (event && typeof event === 'object' && typeof event.at === 'string' && event.at !== '') {
        assertPaperId(paperId)
        const norm = normalizeJobInput(event)
        const handle = sqliteMod.getDb()
        return handle.tx(() => handle.jobInsert(paperId, norm))
      }
      return sqliteMod.jobAppend(paperId, event)
    },
    async jobList(paperId, opts) { return sqliteMod.jobList(paperId, opts) },
    async jobClear(paperId) { return sqliteMod.jobClear(paperId) },
    async reviewGet(paperId) { return sqliteMod.reviewGet(paperId) },
    async reviewPut(paperId, review) { return sqliteMod.reviewPut(paperId, review) },
    async reviewDelete(paperId) { return sqliteMod.reviewDelete(paperId) },
    async migrateTransJson(paperId, legacy) { return sqliteMod.migrateTransJson(paperId, legacy) },
    async annList(paperId) { return sqliteMod.annList(paperId) },
    async annUpsert(paperId, itemOrList) { return sqliteMod.annUpsert(paperId, itemOrList) },
    async annReplacePaper(paperId, items) { return sqliteMod.annReplacePaper(paperId, items) },
    async annDelete(paperId, ids) { return sqliteMod.annDelete(paperId, ids) },
    async annClear(paperId) { return sqliteMod.annClear(paperId) },
    async studyNoteList(paperId) { return sqliteMod.studyNoteList(paperId) },
    async studyNoteUpsert(paperId, noteOrList) { return sqliteMod.studyNoteUpsert(paperId, noteOrList) },
    async studyNoteDelete(paperId, ids) { return sqliteMod.studyNoteDelete(paperId, ids) },
    async studyNoteClear(paperId) { return sqliteMod.studyNoteClear(paperId) },
    async listPaperIds() { return sqliteMod.allPaperIdsInDb() },
    async deletePaperData(paperId) {
      assertPaperId(paperId)
      const handle = sqliteMod.getDb()
      return handle.tx(() => ({
        paperId,
        deleted: {
          translations: sqliteMod.transClear(paperId),
          job_events: sqliteMod.jobClear(paperId),
          reviews: sqliteMod.reviewDelete(paperId),
          annotations: sqliteMod.annClear(paperId),
          study_notes: sqliteMod.studyNoteClear(paperId),
        },
      }))
    },
    /** 供 importSnapshot/migrateTo 同步事务包裹 ./db.js 操作用 */
    runSyncTx(fn) {
      return sqliteMod.getDb().tx(fn)
    },
  }
}

/**
 * 针对显式传入的独立 SQLite 文件路径（如 migrateTo 目标指定了不同 path）
 * 优先使用 node:sqlite 打开临时连接；在 Node < 22.5 无 node:sqlite 或 PB_DB_ENGINE=json 时
 * 自动降级为 ./db.js 的独立 JSON 文件句柄，绝不干扰当前激活的 ./db.js 单例与 env。
 */
async function openStandaloneSqliteTarget(filePath, tablePrefix, sqliteMod = defaultSqliteModule) {
  const forced = String(process.env.PB_DB_ENGINE || '').trim().toLowerCase()
  let DatabaseSync = null
  if (forced !== 'json') {
    try {
      const mod = await import('node:sqlite')
      if (mod && typeof mod.DatabaseSync === 'function') DatabaseSync = mod.DatabaseSync
    } catch {
      DatabaseSync = null
    }
  }
  if (!DatabaseSync) {
    const handle = sqliteMod.openDbFile(filePath)
    const fallbackApi = {
      driver: 'sqlite',
      engine: handle.engine,
      tablePrefix,
      async ensureSchema() {},
      async close() { handle.close() },
      async counts() {
        const c = handle.extendedCounts()
        return {
          translations: Number(c.translations) || 0,
          job_events: Number(c.job_events) || 0,
          reviews: Number(c.reviews) || 0,
          annotations: Number(c.annotations) || 0,
          study_notes: Number(c.study_notes) || 0,
        }
      },
      runSyncTx(fn) { return handle.tx(fn) },
      transAll(paperId) {
        const rows = handle.transRows(paperId)
        const out = { version: 1, target: DEFAULT_TARGET, model: '', updatedAt: null, entries: {} }
        for (const r of rows) {
          out.entries[r.key] = r.text
          out.target = r.target || DEFAULT_TARGET
          out.model = parseModel(r.model)
          out.updatedAt = r.updated_at || null
        }
        return out
      },
      transClear(paperId) { return handle.tx(() => handle.transDeleteAll(paperId)) },
      transReplace(paperId, entries, opts = {}) {
        const pairs = entriesToPairs(entries, true)
        const target = typeof opts.target === 'string' && opts.target.trim() !== '' ? opts.target.trim() : DEFAULT_TARGET
        const model = modelText(opts.model)
        const at = opts.updatedAt || nowIso()
        return handle.tx(() => {
          handle.transDeleteAll(paperId)
          return pairs.length ? handle.transUpsert(paperId, target, model, pairs, at) : 0
        })
      },
      transMerge(paperId, entries, opts = {}) {
        const pairs = entriesToPairs(entries, true)
        const target = typeof opts.target === 'string' && opts.target.trim() !== '' ? opts.target.trim() : DEFAULT_TARGET
        const model = modelText(opts.model)
        const at = opts.updatedAt || nowIso()
        return pairs.length ? handle.tx(() => handle.transUpsert(paperId, target, model, pairs, at)) : 0
      },
      annList(paperId) { return handle.annRows(paperId).map(formatAnnotationRow) },
      annClear(paperId) { return handle.tx(() => handle.annDeleteAll(paperId)) },
      annUpsert(paperId, items) {
        const now = nowIso()
        const list = (Array.isArray(items) ? items : [items]).map((x) => normalizeAnnotationInput(x, now, true))
        handle.tx(() => handle.annUpsert(paperId, list))
        return list
      },
      annReplacePaper(paperId, items) {
        return handle.tx(() => {
          handle.annDeleteAll(paperId)
          if (!items || !items.length) return []
          const now = nowIso()
          const list = items.map((x) => normalizeAnnotationInput(x, now, true))
          handle.annUpsert(paperId, list)
          return list
        })
      },
      studyNoteList(paperId) { return handle.studyNoteRows(paperId).map(formatStudyNoteRow) },
      studyNoteClear(paperId) { return handle.tx(() => handle.studyNoteDeleteAll(paperId)) },
      studyNoteUpsert(paperId, items) {
        const now = nowIso()
        const list = (Array.isArray(items) ? items : [items]).map((x) => normalizeStudyNoteInput(x, now, true))
        handle.tx(() => handle.studyNoteUpsert(paperId, list))
        return Array.isArray(items) ? list : list[0]
      },
      reviewGet(paperId) {
        const row = handle.reviewRow(paperId)
        if (!row) return null
        const parsed = parseJsonValue(row.payload)
        const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
        return { ...payload, at: row.at, mode: row.mode }
      },
      reviewPut(paperId, review) {
        const norm = normalizeReviewInput(review)
        handle.tx(() => handle.reviewUpsert(paperId, norm.at, norm.mode, norm.text))
        return { ...norm.payload, at: norm.at, mode: norm.mode }
      },
      reviewDelete(paperId) { return handle.tx(() => handle.reviewDelete(paperId)) },
      jobClear(paperId) { return handle.tx(() => handle.jobDeleteAll(paperId)) },
      jobList(paperId, opts = {}) {
        const after = toCount(opts.after, 0)
        const limit = Math.min(MAX_LIMIT, Math.max(1, toCount(opts.limit, DEFAULT_LIMIT)))
        const rows = handle.jobRows(paperId, after, limit)
        const events = rows.map((r) => ({ seq: Number(r.seq), at: r.at, level: r.level, kind: r.kind, message: r.message, extra: parseJsonValue(r.extra) }))
        return { events, lastSeq: events.length > 0 ? events[events.length - 1].seq : after }
      },
      jobAppend(paperId, event) {
        const norm = normalizeJobInput(event)
        return handle.tx(() => handle.jobInsert(paperId, norm))
      },
    }
    return fallbackApi
  }
  const { mkdirSync } = await import('node:fs')
  mkdirSync(path.dirname(filePath), { recursive: true })
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS translations (
      paper_id TEXT NOT NULL, target TEXT NOT NULL, key TEXT NOT NULL,
      text TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      PRIMARY KEY (paper_id, target, key));
    CREATE TABLE IF NOT EXISTS job_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, paper_id TEXT NOT NULL, at TEXT NOT NULL,
      level TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, extra TEXT);
    CREATE TABLE IF NOT EXISTS reviews (
      paper_id TEXT PRIMARY KEY, at TEXT NOT NULL, mode TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS annotations (
      paper_id TEXT NOT NULL, id TEXT NOT NULL, paragraph_key TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'orig', kind TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'yellow',
      start_offset INTEGER NOT NULL DEFAULT 0, end_offset INTEGER NOT NULL DEFAULT 0,
      quote TEXT NOT NULL DEFAULT '', prefix TEXT NOT NULL DEFAULT '', suffix TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', page INTEGER NOT NULL DEFAULT 1, section_id TEXT, block_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (paper_id, id));
    CREATE TABLE IF NOT EXISTS study_notes (
      paper_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'section', section_id TEXT, page INTEGER NOT NULL DEFAULT 1,
      block_id TEXT, anchor_quote TEXT NOT NULL DEFAULT '', markdown TEXT NOT NULL, payload TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (paper_id, id));
  `)

  const api = {
    driver: 'sqlite',
    engine: 'sqlite',
    tablePrefix,
    async ensureSchema() {},
    async close() { db.close() },
    async counts() {
      return {
        translations: Number(db.prepare('SELECT COUNT(*) AS n FROM translations').get().n),
        job_events: Number(db.prepare('SELECT COUNT(*) AS n FROM job_events').get().n),
        reviews: Number(db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n),
        annotations: Number(db.prepare('SELECT COUNT(*) AS n FROM annotations').get().n),
        study_notes: Number(db.prepare('SELECT COUNT(*) AS n FROM study_notes').get().n),
      }
    },
    runSyncTx(fn) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const res = fn()
        db.exec('COMMIT')
        return res
      } catch (err) {
        try { db.exec('ROLLBACK') } catch { /* ignore */ }
        throw err
      }
    },
    transAll(paperId) {
      const rows = db.prepare('SELECT target, key, text, model, updated_at FROM translations WHERE paper_id = ? ORDER BY updated_at ASC, rowid ASC').all(paperId)
      const out = { version: 1, target: DEFAULT_TARGET, model: '', updatedAt: null, entries: {} }
      for (const r of rows) {
        out.entries[r.key] = r.text
        out.target = r.target || DEFAULT_TARGET
        out.model = parseModel(r.model)
        out.updatedAt = r.updated_at || null
      }
      return out
    },
    transClear(paperId) { return Number(db.prepare('DELETE FROM translations WHERE paper_id = ?').run(paperId).changes) },
    transReplace(paperId, entries, opts = {}) {
      const pairs = entriesToPairs(entries, true)
      const target = typeof opts.target === 'string' && opts.target.trim() !== '' ? opts.target.trim() : DEFAULT_TARGET
      const model = modelText(opts.model)
      const at = opts.updatedAt || nowIso()
      db.prepare('DELETE FROM translations WHERE paper_id = ?').run(paperId)
      const ins = db.prepare('INSERT INTO translations (paper_id, target, key, text, model, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      for (const [k, v] of pairs) ins.run(paperId, target, k, v, model, at)
      return pairs.length
    },
    transMerge(paperId, entries, opts = {}) {
      const pairs = entriesToPairs(entries, true)
      const target = typeof opts.target === 'string' && opts.target.trim() !== '' ? opts.target.trim() : DEFAULT_TARGET
      const model = modelText(opts.model)
      const at = opts.updatedAt || nowIso()
      const ins = db.prepare(
        `INSERT INTO translations (paper_id, target, key, text, model, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(paper_id, target, key) DO UPDATE SET text = excluded.text, model = excluded.model, updated_at = excluded.updated_at`,
      )
      for (const [k, v] of pairs) ins.run(paperId, target, k, v, model, at)
      return pairs.length
    },
    annList(paperId) {
      return db.prepare(
        `SELECT id, paragraph_key, target, kind, color, start_offset, end_offset, quote, prefix, suffix,
                note, page, section_id, block_id, created_at, updated_at
         FROM annotations WHERE paper_id = ? ORDER BY page ASC, start_offset ASC, created_at ASC`,
      ).all(paperId).map(formatAnnotationRow)
    },
    annClear(paperId) { return Number(db.prepare('DELETE FROM annotations WHERE paper_id = ?').run(paperId).changes) },
    annUpsert(paperId, items) {
      const now = nowIso()
      const list = (Array.isArray(items) ? items : [items]).map((x) => normalizeAnnotationInput(x, now, true))
      const ins = db.prepare(
        `INSERT INTO annotations (
           paper_id, id, paragraph_key, target, kind, color, start_offset, end_offset,
           quote, prefix, suffix, note, page, section_id, block_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(paper_id, id) DO UPDATE SET
           paragraph_key = excluded.paragraph_key, target = excluded.target, kind = excluded.kind,
           color = excluded.color, start_offset = excluded.start_offset, end_offset = excluded.end_offset,
           quote = excluded.quote, prefix = excluded.prefix, suffix = excluded.suffix,
           note = excluded.note, page = excluded.page, section_id = excluded.section_id,
           block_id = excluded.block_id, updated_at = excluded.updated_at`,
      )
      for (const a of list) {
        ins.run(paperId, a.id, a.paragraphKey, a.target, a.kind, a.color, a.startOffset, a.endOffset, a.quote, a.prefix, a.suffix, a.note, a.page, a.sectionId, a.blockId, a.createdAt, a.updatedAt)
      }
      return list
    },
    annReplacePaper(paperId, items) {
      api.annClear(paperId)
      return items.length ? api.annUpsert(paperId, items) : []
    },
    studyNoteList(paperId) {
      return db.prepare(
        `SELECT id, title, scope, section_id, page, block_id, anchor_quote, markdown, payload, created_at, updated_at
         FROM study_notes WHERE paper_id = ? ORDER BY updated_at DESC, created_at DESC`,
      ).all(paperId).map(formatStudyNoteRow)
    },
    studyNoteClear(paperId) { return Number(db.prepare('DELETE FROM study_notes WHERE paper_id = ?').run(paperId).changes) },
    studyNoteUpsert(paperId, items) {
      const now = nowIso()
      const list = (Array.isArray(items) ? items : [items]).map((x) => normalizeStudyNoteInput(x, now, true))
      const ins = db.prepare(
        `INSERT INTO study_notes (
           paper_id, id, title, scope, section_id, page, block_id, anchor_quote, markdown, payload, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(paper_id, id) DO UPDATE SET
           title = excluded.title, scope = excluded.scope, section_id = excluded.section_id,
           page = excluded.page, block_id = excluded.block_id, anchor_quote = excluded.anchor_quote,
           markdown = excluded.markdown, payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      for (const n of list) {
        ins.run(paperId, n.id, n.title, n.scope, n.sectionId, n.page, n.blockId, n.anchorQuote, n.markdown, n.payload, n.createdAt, n.updatedAt)
      }
      return Array.isArray(items) ? list : list[0]
    },
    reviewGet(paperId) {
      const row = db.prepare('SELECT at, mode, payload FROM reviews WHERE paper_id = ?').get(paperId)
      if (!row) return null
      const parsed = parseJsonValue(row.payload)
      const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      return { ...payload, at: row.at, mode: row.mode }
    },
    reviewPut(paperId, review) {
      const norm = normalizeReviewInput(review)
      db.prepare(
        `INSERT INTO reviews (paper_id, at, mode, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT(paper_id) DO UPDATE SET at = excluded.at, mode = excluded.mode, payload = excluded.payload`,
      ).run(paperId, norm.at, norm.mode, norm.text)
      return { ...norm.payload, at: norm.at, mode: norm.mode }
    },
    reviewDelete(paperId) { return Number(db.prepare('DELETE FROM reviews WHERE paper_id = ?').run(paperId).changes) },
    jobClear(paperId) { return Number(db.prepare('DELETE FROM job_events WHERE paper_id = ?').run(paperId).changes) },
    jobList(paperId, opts = {}) {
      const after = toCount(opts.after, 0)
      const limit = Math.min(MAX_LIMIT, Math.max(1, toCount(opts.limit, DEFAULT_LIMIT)))
      const rows = db.prepare('SELECT seq, at, level, kind, message, extra FROM job_events WHERE paper_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(paperId, after, limit)
      const events = rows.map((r) => ({ seq: Number(r.seq), at: r.at, level: r.level, kind: r.kind, message: r.message, extra: parseJsonValue(r.extra) }))
      return { events, lastSeq: events.length > 0 ? events[events.length - 1].seq : after }
    },
    jobAppend(paperId, event) {
      const norm = normalizeJobInput(event)
      const res = db.prepare('INSERT INTO job_events (paper_id, at, level, kind, message, extra) VALUES (?, ?, ?, ?, ?, ?)').run(paperId, norm.at, norm.level, norm.kind, norm.message, norm.extra)
      return Number(res.lastInsertRowid)
    },
  }
  return api
}

/* ------------------------------------------------------------------ 门面工厂 */

export function createDbBackend({ getConfig, sqliteModule } = {}) {
  const readConfig = typeof getConfig === 'function' ? getConfig : async () => ({ database: { driver: 'sqlite' } })
  const sqliteMod = sqliteModule || defaultSqliteModule

  let activeSig = ''
  let activeAdapter = null

  async function resolveActive() {
    const rawCfg = await readConfig()
    const cfg = normalizeDbConfig(rawCfg)
    const sig = configSignature(cfg)
    if (activeAdapter && activeSig === sig) return activeAdapter

    if (activeAdapter && activeAdapter.driver !== 'sqlite') {
      await activeAdapter.close().catch(() => {})
    }
    activeAdapter = null

    if (cfg.driver === 'sqlite') {
      activeAdapter = createSqliteModuleAdapter(sqliteMod, cfg)
    } else if (cfg.driver === 'postgres') {
      activeAdapter = createSqlAdapter(cfg, createPgPool(cfg), 'postgres')
    } else {
      activeAdapter = createSqlAdapter(cfg, createMysqlPool(cfg), 'mysql')
    }
    activeSig = sig
    return activeAdapter
  }

  async function readAllJobEvents(adapter, paperId) {
    const all = []
    let after = 0
    while (true) {
      const page = await adapter.jobList(paperId, { after, limit: MAX_LIMIT })
      if (!page.events || page.events.length === 0) break
      all.push(...page.events)
      if (page.events.length < MAX_LIMIT || page.lastSeq <= after) break
      after = page.lastSeq
    }
    return all
  }

  function eventKey(ev) {
    return [ev.at || '', ev.level || 'info', ev.kind || 'log', ev.message || '', JSON.stringify(ev.extra ?? null)].join('\u0000')
  }

  async function writePaperPayload(targetAdapter, conn, paperId, paperData, jobEvents, mode) {
    const trans = paperData.translations && typeof paperData.translations === 'object' ? paperData.translations : {}
    const entries = trans.entries && typeof trans.entries === 'object' && !Array.isArray(trans.entries) ? trans.entries : {}
    const transOpts = {
      target: typeof trans.target === 'string' && trans.target.trim() !== '' ? trans.target.trim() : DEFAULT_TARGET,
      model: trans.model ?? '',
      updatedAt: typeof trans.updatedAt === 'string' ? trans.updatedAt : undefined,
    }
    const annotations = Array.isArray(paperData.annotations) ? paperData.annotations : []
    const studyNotes = Array.isArray(paperData.studyNotes) ? paperData.studyNotes : []
    const review = paperData.review && typeof paperData.review === 'object' ? paperData.review : null

    const stats = { translations: 0, annotations: 0, studyNotes: 0, reviews: 0, jobEvents: 0 }

    if (mode === 'replace') {
      if (Object.keys(entries).length > 0) {
        stats.translations = await targetAdapter.transReplace(paperId, entries, transOpts, conn)
      } else {
        await targetAdapter.transClear(paperId, conn)
      }
      await targetAdapter.annReplacePaper(paperId, annotations, conn, { preserveUpdatedAt: true })
      stats.annotations = annotations.length
      await targetAdapter.studyNoteClear(paperId, conn)
      if (studyNotes.length > 0) {
        await targetAdapter.studyNoteUpsert(paperId, studyNotes, conn, { preserveUpdatedAt: true })
        stats.studyNotes = studyNotes.length
      }
      if (review) {
        await targetAdapter.reviewPut(paperId, review, conn)
        stats.reviews = 1
      } else {
        await targetAdapter.reviewDelete(paperId, conn)
      }
      if (Array.isArray(jobEvents)) {
        await targetAdapter.jobClear(paperId, conn)
        for (const ev of jobEvents) {
          await targetAdapter.jobAppend(paperId, ev, conn)
          stats.jobEvents += 1
        }
      }
    } else {
      if (Object.keys(entries).length > 0) {
        stats.translations = await targetAdapter.transMerge(paperId, entries, transOpts, conn)
      }
      if (annotations.length > 0) {
        await targetAdapter.annUpsert(paperId, annotations, conn, { preserveUpdatedAt: true })
        stats.annotations = annotations.length
      }
      if (studyNotes.length > 0) {
        await targetAdapter.studyNoteUpsert(paperId, studyNotes, conn, { preserveUpdatedAt: true })
        stats.studyNotes = studyNotes.length
      }
      if (review) {
        await targetAdapter.reviewPut(paperId, review, conn)
        stats.reviews = 1
      }
      if (Array.isArray(jobEvents) && jobEvents.length > 0) {
        const existingEvents = await readAllJobEvents({ jobList: (id, o) => targetAdapter.jobList(id, o, conn) }, paperId)
        const existingCounts = new Map()
        for (const ev of existingEvents) {
          const k = eventKey(ev)
          existingCounts.set(k, (existingCounts.get(k) || 0) + 1)
        }
        for (const ev of jobEvents) {
          const k = eventKey(ev)
          const rem = existingCounts.get(k) || 0
          if (rem > 0) {
            existingCounts.set(k, rem - 1)
            continue
          }
          await targetAdapter.jobAppend(paperId, ev, conn)
          stats.jobEvents += 1
        }
      }
    }
    return stats
  }

  return {
    async info() {
      const adapter = await resolveActive()
      return adapter.info()
    },

    async testConnection(dbCfg) {
      const cfg = normalizeDbConfig(dbCfg)
      const start = Date.now()

      if (cfg.driver === 'sqlite') {
        try {
          if (cfg.path && path.resolve(cfg.path) !== path.resolve(sqliteMod.dbPath())) {
            const tmp = await openStandaloneSqliteTarget(cfg.path, cfg.tablePrefix, sqliteMod)
            await tmp.close()
            return {
              ok: true,
              driver: 'sqlite',
              latencyMs: Date.now() - start,
              serverVersion: tmp.engine === 'sqlite' ? (process.versions.sqlite || 'node-sqlite') : 'json-fallback',
              tablesReady: true,
            }
          }
          const info = sqliteMod.dbInfo()
          return {
            ok: true,
            driver: 'sqlite',
            latencyMs: Date.now() - start,
            serverVersion: info.engine === 'sqlite' ? (process.versions.sqlite || 'node-sqlite') : 'json-fallback',
            tablesReady: true,
          }
        } catch (error) {
          return {
            ok: false,
            driver: 'sqlite',
            latencyMs: Date.now() - start,
            serverVersion: null,
            tablesReady: false,
            error: sanitizeErrorMessage(error, cfg),
          }
        }
      }

      const client = cfg.driver === 'postgres' ? createPgClient(cfg) : createMysqlClient(cfg)
      const quote = cfg.driver === 'postgres' ? quotePgIdent : quoteMysqlIdent
      const tables = tableNames(cfg.tablePrefix, quote)
      const probeName = tables.prefix + '_perm_' + Math.random().toString(36).slice(2, 6)
      const probeQuoted = quote(probeName)

      try {
        await client.connect()
        const ping = await client.ping()

        // 1. 检查 5 张表是否已就绪
        const expected = TABLE_BASES.map((b) => tables.raw[b])
        let tablesReady = false
        if (cfg.driver === 'postgres') {
          const res = await client.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name IN ($1, $2, $3, $4, $5)`,
            expected,
          )
          tablesReady = res.rows.length === TABLE_BASES.length
        } else {
          const res = await client.query(
            `SELECT table_name AS table_name FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name IN (?, ?, ?, ?, ?)`,
            expected,
          )
          tablesReady = res.rows.length === TABLE_BASES.length
        }

        // 2. 探测建表与删表权限（不触碰正式表）
        await client.simpleQuery(`CREATE TABLE IF NOT EXISTS ${probeQuoted} (k INT)`)
        await client.simpleQuery(`DROP TABLE IF EXISTS ${probeQuoted}`)

        return {
          ok: true,
          driver: cfg.driver,
          latencyMs: Date.now() - start,
          serverVersion: ping.serverVersion || client.serverVersion || null,
          tablesReady,
        }
      } catch (error) {
        return {
          ok: false,
          driver: cfg.driver,
          latencyMs: Date.now() - start,
          serverVersion: client.serverVersion || null,
          tablesReady: false,
          error: sanitizeErrorMessage(error, cfg),
        }
      } finally {
        await client.close().catch(() => {})
      }
    },

    async ensureSchema(dbCfg) {
      if (dbCfg === undefined) {
        const adapter = await resolveActive()
        await adapter.ensureSchema()
        return { driver: adapter.driver, tablePrefix: adapter.tablePrefix, ok: true }
      }
      const cfg = normalizeDbConfig(dbCfg)
      if (cfg.driver === 'sqlite') {
        if (cfg.path && path.resolve(cfg.path) !== path.resolve(sqliteMod.dbPath())) {
          const tmp = await openStandaloneSqliteTarget(cfg.path, cfg.tablePrefix, sqliteMod)
          await tmp.close()
        } else {
          sqliteMod.getDb()
        }
        return { driver: 'sqlite', tablePrefix: cfg.tablePrefix, ok: true }
      }

      const pool = cfg.driver === 'postgres' ? createPgPool(cfg) : createMysqlPool(cfg)
      try {
        const adapter = createSqlAdapter(cfg, pool, cfg.driver)
        await adapter.ensureSchema()
        return { driver: cfg.driver, tablePrefix: cfg.tablePrefix, ok: true }
      } finally {
        await pool.close().catch(() => {})
      }
    },

    async transAll(paperId) { return (await resolveActive()).transAll(paperId) },
    async transPut(paperId, entries, opts) { return (await resolveActive()).transPut(paperId, entries, opts) },
    async transMerge(paperId, entries, opts) { return (await resolveActive()).transMerge(paperId, entries, opts) },
    async transReplace(paperId, entries, opts) { return (await resolveActive()).transReplace(paperId, entries, opts) },
    async transDelete(paperId, keys) { return (await resolveActive()).transDelete(paperId, keys) },
    async transClear(paperId) { return (await resolveActive()).transClear(paperId) },

    async jobAppend(paperId, event) { return (await resolveActive()).jobAppend(paperId, event) },
    async jobList(paperId, opts) { return (await resolveActive()).jobList(paperId, opts) },
    async jobClear(paperId) { return (await resolveActive()).jobClear(paperId) },

    async reviewGet(paperId) { return (await resolveActive()).reviewGet(paperId) },
    async reviewPut(paperId, review) { return (await resolveActive()).reviewPut(paperId, review) },
    async reviewDelete(paperId) { return (await resolveActive()).reviewDelete(paperId) },

    async migrateTransJson(paperId, legacy) { return (await resolveActive()).migrateTransJson(paperId, legacy) },

    async annList(paperId) { return (await resolveActive()).annList(paperId) },
    async annUpsert(paperId, itemOrList) { return (await resolveActive()).annUpsert(paperId, itemOrList) },
    async annReplacePaper(paperId, items) { return (await resolveActive()).annReplacePaper(paperId, items) },
    async annDelete(paperId, ids) { return (await resolveActive()).annDelete(paperId, ids) },
    async annClear(paperId) { return (await resolveActive()).annClear(paperId) },

    async studyNoteList(paperId) { return (await resolveActive()).studyNoteList(paperId) },
    async studyNoteUpsert(paperId, noteOrList) { return (await resolveActive()).studyNoteUpsert(paperId, noteOrList) },
    async studyNoteDelete(paperId, ids) { return (await resolveActive()).studyNoteDelete(paperId, ids) },
    async studyNoteClear(paperId) { return (await resolveActive()).studyNoteClear(paperId) },

    async listPaperIds() { return (await resolveActive()).listPaperIds() },
    async allPaperIdsInDb() { return (await resolveActive()).listPaperIds() },
    async extendedCounts() { return (await this.info()).counts },
    async deletePaperData(paperId) { return (await resolveActive()).deletePaperData(paperId) },

    async exportSnapshot(paperIds) {
      const adapter = await resolveActive()
      const ids = Array.isArray(paperIds)
        ? [...new Set(paperIds.map(assertPaperId))].sort()
        : await adapter.listPaperIds()
      const papers = {}
      for (const id of ids) {
        const [translations, annotations, studyNotes, review] = await Promise.all([
          adapter.transAll(id),
          adapter.annList(id),
          adapter.studyNoteList(id),
          adapter.reviewGet(id),
        ])
        papers[id] = { translations, annotations, studyNotes, review }
      }
      return {
        format: SNAPSHOT_FORMAT,
        version: SNAPSHOT_VERSION,
        exportedAt: nowIso(),
        sourceDriver: adapter.driver,
        papers,
      }
    },

    async importSnapshot(snapshot, { mode = 'merge' } = {}) {
      if (mode !== 'merge' && mode !== 'replace') {
        throw new Error('不支持的导入模式（仅允许 merge 或 replace）：' + String(mode))
      }
      if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        snapshot.format !== SNAPSHOT_FORMAT ||
        snapshot.version !== SNAPSHOT_VERSION ||
        !snapshot.papers ||
        typeof snapshot.papers !== 'object' ||
        Array.isArray(snapshot.papers)
      ) {
        throw new Error('导入快照格式不合法，缺少有效的数据头或 papers 字段')
      }

      const adapter = await resolveActive()
      await adapter.ensureSchema()
      const entries = Object.entries(snapshot.papers)
      for (const [id] of entries) assertPaperId(id)

      const totals = { papers: 0, translations: 0, annotations: 0, studyNotes: 0, reviews: 0 }

      if (adapter.driver === 'sqlite' && typeof adapter.runSyncTx === 'function') {
        // SQLite 同步事务内批量写入（保证全量原子性）
        sqliteMod.getDb().tx(() => {
          for (const [id, data] of entries) {
            const p = data && typeof data === 'object' ? data : {}
            const trans = p.translations && typeof p.translations === 'object' ? p.translations : {}
            const transEntries = trans.entries && typeof trans.entries === 'object' && !Array.isArray(trans.entries) ? trans.entries : {}
            const transOpts = {
              target: typeof trans.target === 'string' && trans.target.trim() !== '' ? trans.target.trim() : DEFAULT_TARGET,
              model: trans.model ?? '',
            }
            const annotations = Array.isArray(p.annotations) ? p.annotations : []
            const studyNotes = Array.isArray(p.studyNotes) ? p.studyNotes : []
            const review = p.review && typeof p.review === 'object' ? p.review : null

            totals.papers += 1
            if (mode === 'replace') {
              if (Object.keys(transEntries).length > 0) totals.translations += sqliteMod.transReplace(id, transEntries, transOpts)
              else sqliteMod.transClear(id)
              sqliteMod.annReplacePaper(id, annotations)
              totals.annotations += annotations.length
              sqliteMod.studyNoteClear(id)
              if (studyNotes.length > 0) {
                sqliteMod.studyNoteUpsert(id, studyNotes)
                totals.studyNotes += studyNotes.length
              }
              if (review) {
                sqliteMod.reviewPut(id, review)
                totals.reviews += 1
              } else {
                sqliteMod.reviewDelete(id)
              }
            } else {
              if (Object.keys(transEntries).length > 0) totals.translations += sqliteMod.transMerge(id, transEntries, transOpts)
              if (annotations.length > 0) {
                sqliteMod.annUpsert(id, annotations)
                totals.annotations += annotations.length
              }
              if (studyNotes.length > 0) {
                sqliteMod.studyNoteUpsert(id, studyNotes)
                totals.studyNotes += studyNotes.length
              }
              if (review) {
                sqliteMod.reviewPut(id, review)
                totals.reviews += 1
              }
            }
          }
        })
        return totals
      }

      await adapter.tx(async (conn) => {
        for (const [id, data] of entries) {
          const p = data && typeof data === 'object' ? data : {}
          const s = await writePaperPayload(adapter, conn, id, p, null, mode)
          totals.papers += 1
          totals.translations += s.translations
          totals.annotations += s.annotations
          totals.studyNotes += s.studyNotes
          totals.reviews += s.reviews
        }
      })
      return totals
    },

    async migrateTo(targetDbCfg, { mode = 'merge', onProgress } = {}) {
      if (mode !== 'merge' && mode !== 'replace') {
        throw new Error('不支持的迁移模式（仅允许 merge 或 replace）：' + String(mode))
      }
      const start = Date.now()
      const notify = typeof onProgress === 'function' ? onProgress : () => {}
      const source = await resolveActive()
      const targetCfg = normalizeDbConfig(targetDbCfg)

      notify({ phase: 'prepare', done: 0, total: 0 })
      const sourceCounts = await source.counts()
      const paperIds = await source.listPaperIds()
      const total = paperIds.length

      // 从源库只读导出完整数据（包含 5 张表），绝不修改源库
      const perPaper = []
      for (let i = 0; i < paperIds.length; i += 1) {
        const id = paperIds[i]
        const [translations, annotations, studyNotes, review, jobEvents] = await Promise.all([
          source.transAll(id),
          source.annList(id),
          source.studyNoteList(id),
          source.reviewGet(id),
          readAllJobEvents(source, id),
        ])
        perPaper.push({ id, data: { translations, annotations, studyNotes, review }, jobEvents })
      }

      let targetAdapter
      let shouldCloseTarget = false
      if (targetCfg.driver === 'sqlite') {
        if (targetCfg.path && path.resolve(targetCfg.path) !== path.resolve(sqliteMod.dbPath())) {
          targetAdapter = await openStandaloneSqliteTarget(targetCfg.path, targetCfg.tablePrefix, sqliteMod)
          shouldCloseTarget = true
        } else {
          targetAdapter = createSqliteModuleAdapter(sqliteMod, targetCfg)
        }
      } else {
        const pool = targetCfg.driver === 'postgres' ? createPgPool(targetCfg) : createMysqlPool(targetCfg)
        targetAdapter = createSqlAdapter(targetCfg, pool, targetCfg.driver)
        shouldCloseTarget = true
      }

      const migrated = { translations: 0, job_events: 0, reviews: 0, annotations: 0, study_notes: 0 }

      try {
        await targetAdapter.ensureSchema()

        const verifyPaperOn = async (item, conn) => {
          const gotTrans = await targetAdapter.transAll(item.id, conn)
          const srcEntries = item.data.translations.entries || {}
          for (const [k, v] of Object.entries(srcEntries)) {
            if (gotTrans.entries[k] !== v) {
              throw new Error(`迁移校验失败：论文 ${item.id} 译文键 ${k} 内容不一致`)
            }
          }
          if (mode === 'replace' && Object.keys(gotTrans.entries).length !== Object.keys(srcEntries).length) {
            throw new Error(`迁移校验失败：论文 ${item.id} 译文数量不一致`)
          }

          const gotAnns = await targetAdapter.annList(item.id, conn)
          const annIds = new Set(gotAnns.map((a) => a.id))
          for (const a of item.data.annotations) {
            if (!annIds.has(a.id)) throw new Error(`迁移校验失败：论文 ${item.id} 缺少标注 ${a.id}`)
          }
          if (mode === 'replace' && gotAnns.length !== item.data.annotations.length) {
            throw new Error(`迁移校验失败：论文 ${item.id} 标注数量不一致`)
          }

          const gotNotes = await targetAdapter.studyNoteList(item.id, conn)
          const noteIds = new Set(gotNotes.map((n) => n.id))
          for (const n of item.data.studyNotes) {
            if (!noteIds.has(n.id)) throw new Error(`迁移校验失败：论文 ${item.id} 缺少研读笔记 ${n.id}`)
          }
          if (mode === 'replace' && gotNotes.length !== item.data.studyNotes.length) {
            throw new Error(`迁移校验失败：论文 ${item.id} 研读笔记数量不一致`)
          }

          if (item.data.review) {
            const gotRev = await targetAdapter.reviewGet(item.id, conn)
            if (!gotRev) throw new Error(`迁移校验失败：论文 ${item.id} 缺少自检结果`)
          }

          const gotJobs = await readAllJobEvents({ jobList: (id, o) => targetAdapter.jobList(id, o, conn) }, item.id)
          if (gotJobs.length < item.jobEvents.length || (mode === 'replace' && gotJobs.length !== item.jobEvents.length)) {
            throw new Error(`迁移校验失败：论文 ${item.id} 任务日志数量不一致（期望 ${item.jobEvents.length}，实际 ${gotJobs.length}）`)
          }
        }

        if (targetAdapter.driver === 'sqlite' && typeof targetAdapter.runSyncTx === 'function') {
          targetAdapter.runSyncTx(() => {
            for (let i = 0; i < perPaper.length; i += 1) {
              const { id, data, jobEvents } = perPaper[i]
              const trans = data.translations || {}
              const entries = trans.entries || {}
              const transOpts = { target: trans.target || DEFAULT_TARGET, model: trans.model ?? '', updatedAt: trans.updatedAt || undefined }
              if (mode === 'replace') {
                if (Object.keys(entries).length > 0) migrated.translations += targetAdapter.transReplace(id, entries, transOpts)
                else targetAdapter.transClear(id)
                targetAdapter.annReplacePaper(id, data.annotations)
                migrated.annotations += data.annotations.length
                targetAdapter.studyNoteClear(id)
                if (data.studyNotes.length > 0) {
                  targetAdapter.studyNoteUpsert(id, data.studyNotes)
                  migrated.study_notes += data.studyNotes.length
                }
                if (data.review) {
                  targetAdapter.reviewPut(id, data.review)
                  migrated.reviews += 1
                } else {
                  targetAdapter.reviewDelete(id)
                }
                targetAdapter.jobClear(id)
                for (const ev of jobEvents) {
                  targetAdapter.jobAppend(id, ev)
                  migrated.job_events += 1
                }
              } else {
                if (Object.keys(entries).length > 0) migrated.translations += targetAdapter.transMerge(id, entries, transOpts)
                if (data.annotations.length > 0) {
                  targetAdapter.annUpsert(id, data.annotations)
                  migrated.annotations += data.annotations.length
                }
                if (data.studyNotes.length > 0) {
                  targetAdapter.studyNoteUpsert(id, data.studyNotes)
                  migrated.study_notes += data.studyNotes.length
                }
                if (data.review) {
                  targetAdapter.reviewPut(id, data.review)
                  migrated.reviews += 1
                }
                if (jobEvents.length > 0) {
                  const existingEvents = []
                  let after = 0
                  while (true) {
                    const p = targetAdapter.jobList(id, { after, limit: MAX_LIMIT })
                    if (!p.events.length) break
                    existingEvents.push(...p.events)
                    if (p.events.length < MAX_LIMIT || p.lastSeq <= after) break
                    after = p.lastSeq
                  }
                  const counts = new Map()
                  for (const ev of existingEvents) counts.set(eventKey(ev), (counts.get(eventKey(ev)) || 0) + 1)
                  for (const ev of jobEvents) {
                    const k = eventKey(ev)
                    const rem = counts.get(k) || 0
                    if (rem > 0) { counts.set(k, rem - 1); continue }
                    targetAdapter.jobAppend(id, ev)
                    migrated.job_events += 1
                  }
                }
              }
              notify({ phase: 'paper', done: i + 1, total, paperId: id })
            }
          })
          for (const item of perPaper) {
            await verifyPaperOn(item, null)
          }
        } else {
          await targetAdapter.tx(async (conn) => {
            for (let i = 0; i < perPaper.length; i += 1) {
              const { id, data, jobEvents } = perPaper[i]
              const s = await writePaperPayload(targetAdapter, conn, id, data, jobEvents, mode)
              migrated.translations += s.translations
              migrated.annotations += s.annotations
              migrated.study_notes += s.studyNotes
              migrated.reviews += s.reviews
              migrated.job_events += s.jobEvents
              notify({ phase: 'paper', done: i + 1, total, paperId: id })
            }
            notify({ phase: 'verify', done: total, total })
            for (const item of perPaper) {
              await verifyPaperOn(item, conn)
            }
          })
        }

        const targetCounts = await targetAdapter.counts()
        for (const base of TABLE_BASES) {
          if (Number(targetCounts[base]) < Number(sourceCounts[base])) {
            throw new Error(`迁移后目标表 ${base} 行数（${targetCounts[base]}）少于源库（${sourceCounts[base]}）`)
          }
        }

        notify({ phase: 'done', done: total, total })
        return {
          ok: true,
          sourceDriver: source.driver,
          targetDriver: targetAdapter.driver,
          mode,
          verified: true,
          papers: paperIds.length,
          migrated,
          sourceCounts,
          targetCounts,
          durationMs: Date.now() - start,
        }
      } finally {
        if (shouldCloseTarget && targetAdapter) {
          await targetAdapter.close().catch(() => {})
        }
      }
    },

    async close() {
      if (!activeAdapter) return false
      const prev = activeAdapter
      activeAdapter = null
      activeSig = ''
      return prev.close()
    },
  }
}
