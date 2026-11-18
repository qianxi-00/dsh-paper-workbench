/**
 * 「论文」专属 DSH 工作区 Skills 与 AGENTS.md 自动部署器。
 *
 * 约定（DSH Desktop 会话建立时自动扫描）：
 *   - <workspaceDir>/AGENTS.md
 *   - <workspaceDir>/.dsh/skills/<skillName>/SKILL.md
 *
 * 合并策略：
 *   - AGENTS.md 内由 `<!-- pb:skills:begin v1 -->` ... `<!-- pb:skills:end -->` 划定受管区块；
 *   - 标记外部的用户自定义规则原封不动保留；
 *   - 版本标记与内容完全一致时幂等跳过写磁盘，避免无效触发文件监听或刷新。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILLS_VERSION = 'v1'
export const BEGIN_MARKER = '<!-- pb:skills:begin ' + SKILLS_VERSION + ' -->'
export const END_MARKER = '<!-- pb:skills:end -->'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ASSETS_DIR = path.resolve(HERE, '..', 'assets', 'workspace-skills')

const BEGIN_LINE_RE = /<!--\s*pb:skills:begin(?:\s+v[0-9A-Za-z._-]+)?\s*-->/
const END_LINE_RE = /<!--\s*pb:skills:end\s*-->/

const SHARED = (globalThis.__pbWorkspaceSkillsShared ||= { chains: new Map() })

function serializeWorkspace(key, task) {
  const prev = SHARED.chains.get(key) || Promise.resolve()
  const run = prev.then(task, task)
  const tail = run.then(() => undefined, () => undefined)
  SHARED.chains.set(key, tail)
  return run.finally(() => {
    if (SHARED.chains.get(key) === tail) SHARED.chains.delete(key)
  })
}

function detectEol(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n'
}

function normalizeEol(text, eol) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\n/g, eol)
}

async function readTextIfExists(file) {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function writeFileAtomic(file, content) {
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36) +
    '-' + Math.random().toString(36).slice(2, 8)
  try {
    await fsp.writeFile(tmp, content, 'utf8')
    await fsp.rename(tmp, file)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 纯函数：把受管 AGENTS 正文合并进已有 AGENTS.md，完整保留标记外部的用户自定义内容。
 */
export function mergeAgentsMarkdown(existingContent, managedBody) {
  const body = String(managedBody || '').trim()
  const hasExisting = typeof existingContent === 'string' && existingContent.length > 0
  const eol = hasExisting ? detectEol(existingContent) : '\n'
  const block = normalizeEol(BEGIN_MARKER + '\n' + body + '\n' + END_MARKER, eol)

  if (!hasExisting) {
    return block + '\n'
  }

  const beginMatch = BEGIN_LINE_RE.exec(existingContent)
  if (beginMatch) {
    const afterBegin = beginMatch.index + beginMatch[0].length
    const rest = existingContent.slice(afterBegin)
    const endMatch = END_LINE_RE.exec(rest)
    if (endMatch) {
      const prefix = existingContent.slice(0, beginMatch.index)
      const suffix = rest.slice(endMatch.index + endMatch[0].length)
      return prefix + block + suffix
    }
  }

  // 原文件已有用户自写内容但尚无有效成对标记：保留原内容在前，追加受管区块在后
  const trimmedTail = existingContent.replace(/[ \t]+$/, '')
  const separator = trimmedTail.endsWith(eol + eol)
    ? ''
    : trimmedTail.endsWith('\n')
      ? eol
      : eol + eol
  return trimmedTail + separator + block + eol
}

async function loadTemplates(assetsDir) {
  const root = path.resolve(assetsDir || DEFAULT_ASSETS_DIR)
  const agentsPath = path.join(root, 'AGENTS.md')
  const agentsBody = await fsp.readFile(agentsPath, 'utf8').catch((error) => {
    throw new Error('缺少工作区 AGENTS.md 模板（' + agentsPath + '）：' + (error && error.message ? error.message : String(error)))
  })

  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  const skills = []
  const dirNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()

  for (const name of dirNames) {
    const skillPath = path.join(root, name, 'SKILL.md')
    const content = await readTextIfExists(skillPath)
    if (content === null) continue
    skills.push({ name, content: normalizeEol(content.trimEnd(), '\n') + '\n' })
  }

  return { agentsBody, skills }
}

/**
 * 同步工作区 AGENTS.md 与 .dsh/skills/<name>/SKILL.md 到 workspaceDir。
 * 空路径安全返回而不报错；版本标记与内容未变时幂等跳过写磁盘。
 */
export async function ensureWorkspaceSkills(workspaceDir, opts = {}) {
  if (typeof workspaceDir !== 'string') {
    return { workspaceDir: '', version: SKILLS_VERSION, updated: [], skipped: [] }
  }
  const raw = workspaceDir.replace(/\u0000/g, '').trim()
  if (!raw) {
    return { workspaceDir: '', version: SKILLS_VERSION, updated: [], skipped: [] }
  }

  const targetDir = path.resolve(raw)
  const assetsDir = opts && typeof opts.assetsDir === 'string' && opts.assetsDir.trim()
    ? opts.assetsDir.trim()
    : DEFAULT_ASSETS_DIR

  return serializeWorkspace(targetDir, async () => {
    const { agentsBody, skills } = await loadTemplates(assetsDir)
    await fsp.mkdir(targetDir, { recursive: true })

    const updated = []
    const skipped = []

    const syncOne = async (relPosixPath, targetFile, nextText) => {
      const current = await readTextIfExists(targetFile)
      if (current === nextText) {
        skipped.push(relPosixPath)
        return
      }
      await writeFileAtomic(targetFile, nextText)
      updated.push(relPosixPath)
    }

    const agentsFile = path.join(targetDir, 'AGENTS.md')
    const currentAgents = await readTextIfExists(agentsFile)
    const nextAgents = mergeAgentsMarkdown(currentAgents, agentsBody)
    await syncOne('AGENTS.md', agentsFile, nextAgents)

    for (const skill of skills) {
      const rel = '.dsh/skills/' + skill.name + '/SKILL.md'
      const skillFile = path.join(targetDir, '.dsh', 'skills', skill.name, 'SKILL.md')
      const currentSkill = await readTextIfExists(skillFile)
      const eol = currentSkill !== null ? detectEol(currentSkill) : '\n'
      const nextSkill = normalizeEol(skill.content, eol)
      await syncOne(rel, skillFile, nextSkill)
    }

    return {
      workspaceDir: targetDir,
      version: SKILLS_VERSION,
      updated,
      skipped,
    }
  })
}
