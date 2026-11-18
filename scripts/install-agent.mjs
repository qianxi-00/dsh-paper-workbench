#!/usr/bin/env node
/**
 * 零依赖跨平台自动安装器（Windows / macOS / Linux）。
 *
 * 供人类或 AI Coding Agent（Claude Code / Codex / Antigravity / DSH）调用：
 *   1. 校验 Node.js >= 20（并提示 22.5+ 内置 SQLite 与 <22.5 JSON 降级差异）
 *   2. 探测 Python 3 + PyMuPDF（import fitz）；缺失时视参数安全尝试或清晰给出待办
 *   3. 自动发现本机 DSH Home（或按 --dsh-home 指定）并检查 profiles/desktop/package.json 与插件启停配置
 *   4. 写前备份 .bak 后安全更新 dependencies["dsh-paper-workbench"]（支持 --mode link|copy 与 --dry-run）
 *   5. 准备数据目录并预览/同步 assets/workspace-skills/（若存在）
 *   6. 输出人类 + Agent（--json）双友好的结构化报告与剩余用户可选项
 */
import { spawn } from 'node:child_process'
import { existsSync, promises as fsp, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..')
const IS_WIN = process.platform === 'win32'

const SKIP_COPY_NAMES = new Set([
  '.git',
  '.github',
  'node_modules',
  'dist',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
  '.pages',
  '.trash',
  'data',
])

export function printHelp() {
  return [
    '用法：node scripts/install-agent.mjs [选项]',
    '',
    '选项：',
    '  --dsh-home <path>    指定 DSH Home 目录（含 profiles/desktop/package.json）',
    '  --data-dir <path>    指定插件数据目录（默认 $DSH_PAPER_WORKBENCH_DATA 或 ~/.dsh/paper-workbench）',
    '  --workspace <path>   指定工作区目录（用于准备目录或同步 workspace-skills）',
    '  --repo <path>        指定 dsh-paper-workbench 仓库目录（默认当前脚本所在仓库）',
    '  --mode <link|copy>   安装方式：link（默认，开发链接）或 copy（复制包到 DSH 目录）',
    '  --dry-run            只探测与规划，不写入任何文件或执行 pip 安装',
    '  --json               输出严格合法的 JSON（供 Agent 解析）',
    '  --skip-py-install    缺失 PyMuPDF 时不尝试自动 pip 安装，只报告待办',
    '  -h, --help           显示帮助信息',
  ].join('\n')
}

export function parseArgs(argv) {
  const opts = {
    dshHome: '',
    dataDir: '',
    workspace: '',
    repo: '',
    mode: 'link',
    dryRun: false,
    json: false,
    skipPyInstall: false,
    help: false,
  }
  const valueFlags = new Map([
    ['--dsh-home', 'dshHome'],
    ['--data-dir', 'dataDir'],
    ['--workspace', 'workspace'],
    ['--repo', 'repo'],
    ['--mode', 'mode'],
  ])

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '')
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    if (arg === '--dry-run') {
      opts.dryRun = true
      continue
    }
    if (arg === '--json') {
      opts.json = true
      continue
    }
    if (arg === '--skip-py-install') {
      opts.skipPyInstall = true
      continue
    }

    const eqIdx = arg.indexOf('=')
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg
    const prop = valueFlags.get(flag)
    if (!prop) {
      throw new Error('未知参数：' + arg + '（使用 --help 查看可用参数）')
    }
    let val = ''
    if (eqIdx >= 0) {
      val = arg.slice(eqIdx + 1)
    } else {
      if (i + 1 >= argv.length) throw new Error('参数缺少值：' + flag)
      val = String(argv[++i] || '')
    }
    if (!val.trim()) throw new Error('参数值不能为空：' + flag)
    opts[prop] = val
  }

  if (opts.mode !== 'link' && opts.mode !== 'copy') {
    throw new Error('--mode 仅支持 link 或 copy，当前为：' + opts.mode)
  }
  return opts
}

function runCmd(command, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false
    const out = []
    const err = []
    let child
    try {
      child = spawn(command, args, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error && error.message ? error.message : String(error) })
      return
    }
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ code: -1, stdout: Buffer.concat(out).toString('utf8'), stderr: '命令执行超时（' + timeoutMs + 'ms）' })
    }, timeoutMs)

    if (child.stdout) child.stdout.on('data', (chunk) => out.push(chunk))
    if (child.stderr) child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => finish({ code: -3, stdout: '', stderr: error && error.message ? error.message : String(error) }))
    child.on('close', (code) => {
      finish({ code: code == null ? -1 : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

async function checkNodeRuntime() {
  const raw = String(process.versions.node || '0.0.0')
  const [major, minor] = raw.split('.').map((n) => Number(n) || 0)
  const supported = major >= 20
  let sqliteAvailable = false
  if (major > 22 || (major === 22 && minor >= 5)) {
    try {
      const mod = await import('node:sqlite')
      sqliteAvailable = Boolean(mod && typeof mod.DatabaseSync === 'function')
    } catch {
      sqliteAvailable = false
    }
  }
  if (!supported) {
    return {
      status: 'error',
      version: raw,
      sqlite: false,
      detail: 'Node.js v' + raw + ' 低于最低要求（>= 20.0.0）',
      hint: '请安装或升级 Node.js 20+（推荐 22.5+ 以启用内置 node:sqlite）。',
    }
  }
  if (!sqliteAvailable) {
    return {
      status: 'warn',
      version: raw,
      sqlite: false,
      detail: 'Node.js v' + raw + '（满足 >= 20；未内置 node:sqlite，将自动使用 JSON 存储降级引擎）',
      hint: '升级到 Node 22.5+ 可启用 WAL 模式本地 SQLite。',
    }
  }
  return {
    status: 'ok',
    version: raw,
    sqlite: true,
    detail: 'Node.js v' + raw + '（支持内置 node:sqlite）',
    hint: '',
  }
}

function buildPythonCandidates(configPython) {
  return [
    configPython,
    process.env.DSH_PAPER_PYTHON,
    process.env.PYTHON,
    IS_WIN ? 'F:\\ProGramApp\\Anaconda\\python.exe' : null,
    IS_WIN ? 'py' : 'python3',
    'python',
    'python3',
  ]
    .map((v) => String(v || '').trim())
    .filter((v, idx, list) => Boolean(v) && list.indexOf(v) === idx)
}

async function probeFitz(command) {
  const res = await runCmd(
    command,
    ['-c', 'import fitz,sys;print(fitz.__doc__.split()[1] + "|" + sys.version.split()[0])'],
    15000,
  )
  if (res.code !== 0) return null
  const text = res.stdout.trim()
  if (!text) return null
  const [rawFitzVersion, pythonVersion] = text.split('|')
  const fitzVersion = String(rawFitzVersion || 'unknown').replace(/:+$/, '')
  return { python: command, fitzVersion, pythonVersion: pythonVersion || '' }
}

async function probePython3(command) {
  const res = await runCmd(
    command,
    ['-c', 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}|{int(sys.prefix!=sys.base_prefix)}")'],
    12000,
  )
  if (res.code !== 0) return null
  const text = res.stdout.trim()
  if (!text) return null
  const [version, inVenvFlag] = text.split('|')
  const [major, minor] = String(version || '').split('.').map((n) => Number(n) || 0)
  if (major !== 3) return null
  return { command, version, minor, inVenv: inVenvFlag === '1' }
}

async function checkAndInstallPython(configPython, { dryRun, skipPyInstall }) {
  const candidates = buildPythonCandidates(configPython)
  for (const cand of candidates) {
    const found = await probeFitz(cand)
    if (found) {
      return {
        status: 'ok',
        python: found.python,
        fitzVersion: found.fitzVersion,
        pythonVersion: found.pythonVersion,
        hasPip: null,
        hasUv: null,
        attemptedInstall: false,
        installed: false,
        error: '',
        hint: '',
      }
    }
  }

  let pyInfo = null
  for (const cand of candidates) {
    pyInfo = await probePython3(cand)
    if (pyInfo) break
  }

  let hasPip = false
  if (pyInfo) {
    const pipRes = await runCmd(pyInfo.command, ['-m', 'pip', '--version'], 10000)
    hasPip = pipRes.code === 0
  }
  const uvRes = await runCmd('uv', ['--version'], 8000)
  const hasUv = uvRes.code === 0

  let attemptedInstall = false
  let installed = false
  let attemptError = ''

  if (!dryRun && !skipPyInstall && pyInfo && hasPip && pyInfo.minor >= 10) {
    attemptedInstall = true
    const installArgs = pyInfo.inVenv
      ? ['-m', 'pip', 'install', 'pymupdf']
      : ['-m', 'pip', 'install', '--user', 'pymupdf']
    const pipInstall = await runCmd(pyInfo.command, installArgs, 90000)
    if (pipInstall.code === 0) {
      const recheck = await probeFitz(pyInfo.command)
      if (recheck) {
        installed = true
        return {
          status: 'ok',
          python: recheck.python,
          fitzVersion: recheck.fitzVersion,
          pythonVersion: recheck.pythonVersion,
          hasPip,
          hasUv,
          attemptedInstall: true,
          installed: true,
          error: '',
          hint: '',
        }
      }
      attemptError = 'pip 安装返回成功，但重新 import fitz 仍失败。'
    } else {
      attemptError = (pipInstall.stderr || pipInstall.stdout || '退出码 ' + pipInstall.code).trim().slice(0, 260)
    }
  }

  const installCmd = pyInfo
    ? `${pyInfo.command} -m pip install ${pyInfo.inVenv ? '' : '--user '}pymupdf`.replace(/\s+/g, ' ')
    : IS_WIN
      ? 'winget install --id Python.Python.3.12 && python -m pip install pymupdf'
      : process.platform === 'darwin'
        ? 'brew install python && python3 -m pip install --user pymupdf'
        : 'sudo apt install python3 python3-pip && python3 -m pip install --user pymupdf'

  const hintParts = ['未检测到可用的 Python 3 + PyMuPDF（import fitz）。']
  if (pyInfo && pyInfo.minor < 10) {
    hintParts.push(`当前 Python ${pyInfo.version} 偏旧（推荐 3.10+）。`)
  }
  if (hasUv) {
    hintParts.push(`检测到 uv，建议在独立 venv 安装或执行：${installCmd}。`)
  } else {
    hintParts.push(`请执行：${installCmd}（或在插件设置 / DSH_PAPER_PYTHON 指定已装 pymupdf 的解释器）。`)
  }

  return {
    status: 'missing',
    python: pyInfo ? pyInfo.command : '',
    fitzVersion: '',
    pythonVersion: pyInfo ? pyInfo.version : '',
    hasPip,
    hasUv,
    attemptedInstall,
    installed,
    error: attemptError,
    hint: hintParts.join(' '),
  }
}

export function dshHomeCandidates() {
  const home = os.homedir()
  const raw = [process.env.DSH_HOME]
  if (IS_WIN) {
    raw.push(
      'F:\\ProGramApp\\DSH',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'DSH') : '',
      process.env.APPDATA ? path.join(process.env.APPDATA, 'DSH') : '',
      path.join(home, 'DSH'),
      path.join(home, '.dsh'),
    )
  } else if (process.platform === 'darwin') {
    raw.push(
      path.join(home, '.dsh'),
      path.join(home, 'DSH'),
      path.join(home, 'Library', 'Application Support', 'DSH'),
    )
  } else {
    raw.push(
      path.join(home, '.dsh'),
      path.join(home, 'DSH'),
      process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'DSH') : path.join(home, '.local', 'share', 'DSH'),
    )
  }
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const trimmed = String(item || '').trim()
    if (!trimmed) continue
    const resolved = path.resolve(trimmed)
    const key = IS_WIN ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    out.push(resolved)
  }
  return out
}

function discoverDshHome(explicitHome) {
  if (explicitHome) {
    const resolved = path.resolve(explicitHome)
    const pkgPath = path.join(resolved, 'profiles', 'desktop', 'package.json')
    if (existsSync(pkgPath)) {
      return { found: true, dshHome: resolved, profilePackageJson: pkgPath, discoveredBy: 'flag', candidates: [resolved] }
    }
    return { found: false, dshHome: resolved, profilePackageJson: pkgPath, discoveredBy: 'flag', candidates: [resolved] }
  }

  const candidates = dshHomeCandidates()
  for (let i = 0; i < candidates.length; i += 1) {
    const dir = candidates[i]
    const pkgPath = path.join(dir, 'profiles', 'desktop', 'package.json')
    if (existsSync(pkgPath)) {
      const by = process.env.DSH_HOME && path.resolve(process.env.DSH_HOME) === dir ? 'env' : 'candidate'
      return { found: true, dshHome: dir, profilePackageJson: pkgPath, discoveredBy: by, candidates }
    }
  }
  return { found: false, dshHome: '', profilePackageJson: '', discoveredBy: 'none', candidates }
}

function detectIndent(text) {
  const match = String(text || '').match(/\n([ \t]+)"/)
  return match ? match[1] : '  '
}

/**
 * 检查 profiles/desktop/cordis.patch.yml 中是否显式停用了 paper-workbench。
 * 不引入外部 YAML 库，按插件条目的块缩进边界做保守匹配。
 */
async function inspectCordisPatch(cordisPatchPath) {
  if (!existsSync(cordisPatchPath)) {
    return { exists: false, foundEntry: false, disabled: false }
  }
  const text = await fsp.readFile(cordisPatchPath, 'utf8')
  const lines = text.split(/\r?\n/)
  let activeIndent = -1
  let blockMatches = false
  let foundEntry = false
  let disabled = false

  for (const rawLine of lines) {
    const stripped = rawLine.replace(/#.*$/, '')
    if (!stripped.trim()) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const trimmed = stripped.trim()

    if (/^-\s+(id|name)\s*:/.test(trimmed)) {
      activeIndent = indent
      blockMatches = false
    } else if (activeIndent >= 0 && indent <= activeIndent && !/^-\s/.test(trimmed)) {
      activeIndent = -1
      blockMatches = false
    }

    if (activeIndent >= 0) {
      if (/^(?:-\s*)?id\s*:\s*['"]?paper-workbench['"]?\s*$/.test(trimmed)) {
        blockMatches = true
        foundEntry = true
      } else if (/^(?:-\s*)?name\s*:\s*['"]?dsh-paper-workbench['"]?\s*$/.test(trimmed)) {
        blockMatches = true
        foundEntry = true
      } else if (blockMatches && indent <= activeIndent + 4 && /^disabled\s*:\s*(true|false)\s*$/i.test(trimmed)) {
        disabled = /true/i.test(trimmed)
      }
    }
  }
  return { exists: true, foundEntry, disabled }
}

async function copyPackageTree(srcDir, dstDir) {
  const copied = []
  await fsp.mkdir(dstDir, { recursive: true })
  const visit = async (curSrc, curDst) => {
    const entries = await fsp.readdir(curSrc, { withFileTypes: true })
    await fsp.mkdir(curDst, { recursive: true })
    for (const entry of entries) {
      if (SKIP_COPY_NAMES.has(entry.name) || entry.name.endsWith('.pyc') || entry.name.endsWith('.tmp')) continue
      if (/^\.env(\.|$)/.test(entry.name)) continue
      const from = path.join(curSrc, entry.name)
      const to = path.join(curDst, entry.name)
      if (entry.isDirectory()) {
        await visit(from, to)
      } else if (entry.isFile()) {
        await fsp.copyFile(from, to)
        copied.push(to)
      }
    }
  }
  await visit(srcDir, dstDir)
  return copied
}

async function writeAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now().toString(36)
  await fsp.writeFile(tmp, content, 'utf8')
  await fsp.rename(tmp, filePath)
}

async function safeRemovePath(targetPath) {
  const stat = await fsp.lstat(targetPath).catch(() => null)
  if (!stat) return
  if (stat.isSymbolicLink()) {
    await fsp.unlink(targetPath)
  } else {
    await fsp.rm(targetPath, { recursive: true, force: true })
  }
}

async function listWorkspaceSkillTargets(skillsSrcDir, targetWorkspaceDir) {
  const targets = []
  const agentsSrc = path.join(skillsSrcDir, 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    targets.push({ kind: 'agents', src: agentsSrc, dst: path.join(targetWorkspaceDir, 'AGENTS.md') })
  }
  const entries = await fsp.readdir(skillsSrcDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillMd = path.join(skillsSrcDir, entry.name, 'SKILL.md')
    if (existsSync(skillMd)) {
      targets.push({
        kind: 'skill',
        name: entry.name,
        src: skillMd,
        dst: path.join(targetWorkspaceDir, '.dsh', 'skills', entry.name, 'SKILL.md'),
      })
    }
  }
  return targets
}

async function syncWorkspaceSkillsFallback(targets, targetWorkspaceDir) {
  const updated = []
  await fsp.mkdir(targetWorkspaceDir, { recursive: true })
  for (const item of targets) {
    if (item.kind === 'agents') {
      const body = (await fsp.readFile(item.src, 'utf8')).trim()
      const block = `<!-- pb:skills:begin v1 -->\n${body}\n<!-- pb:skills:end -->\n`
      const current = existsSync(item.dst) ? await fsp.readFile(item.dst, 'utf8') : ''
      let next = block
      if (current) {
        const beginRe = /<!--\s*pb:skills:begin(?:\s+v[0-9A-Za-z._-]+)?\s*-->/
        const endRe = /<!--\s*pb:skills:end\s*-->/
        const b = beginRe.exec(current)
        if (b) {
          const rest = current.slice(b.index + b[0].length)
          const e = endRe.exec(rest)
          if (e) {
            next = current.slice(0, b.index) + block.trimEnd() + rest.slice(e.index + e[0].length)
          } else {
            next = current.trimEnd() + '\n\n' + block
          }
        } else {
          next = current.trimEnd() + '\n\n' + block
        }
      }
      if (current !== next) {
        await writeAtomic(item.dst, next)
        updated.push(item.dst)
      }
    } else {
      const content = await fsp.readFile(item.src, 'utf8')
      const current = existsSync(item.dst) ? await fsp.readFile(item.dst, 'utf8') : null
      if (current !== content) {
        await writeAtomic(item.dst, content)
        updated.push(item.dst)
      }
    }
  }
  return updated
}

async function checkObsidianConfigured(config) {
  const configured = String((config && config.vault) || '').trim()
  if (configured && existsSync(configured)) {
    return { configured: true, path: configured, source: 'config' }
  }
  const obsidianJsonPaths = []
  if (IS_WIN && process.env.APPDATA) {
    obsidianJsonPaths.push(path.join(process.env.APPDATA, 'obsidian', 'obsidian.json'))
  } else if (process.platform === 'darwin') {
    obsidianJsonPaths.push(path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json'))
  } else {
    obsidianJsonPaths.push(path.join(os.homedir(), '.config', 'obsidian', 'obsidian.json'))
  }
  for (const file of obsidianJsonPaths) {
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const vaults = parsed && typeof parsed.vaults === 'object' && parsed.vaults ? Object.values(parsed.vaults) : []
      const openVault = vaults.find((v) => v && v.open === true && typeof v.path === 'string' && v.path.trim())
      if (openVault) return { configured: true, path: openVault.path, source: 'auto' }
    } catch {
      /* ignore malformed obsidian.json */
    }
  }
  return { configured: false, path: '', source: 'none' }
}

export async function runInstall(options) {
  const repoRoot = path.resolve(options.repo || DEFAULT_REPO_ROOT)
  const repoPkgPath = path.join(repoRoot, 'package.json')
  if (!existsSync(repoPkgPath)) {
    throw new Error('仓库目录缺少 package.json：' + repoRoot)
  }
  const repoPkg = JSON.parse(readFileSync(repoPkgPath, 'utf8'))
  if (repoPkg.name !== 'dsh-paper-workbench') {
    throw new Error('目标目录不是 dsh-paper-workbench 仓库（package.json name=' + repoPkg.name + '）')
  }

  const dataDir = path.resolve(
    options.dataDir || process.env.DSH_PAPER_WORKBENCH_DATA || path.join(os.homedir(), '.dsh', 'paper-workbench'),
  )
  const configPath = path.join(dataDir, 'config.json')
  let existingConfig = {}
  if (existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(await fsp.readFile(configPath, 'utf8')) || {}
    } catch {
      existingConfig = {}
    }
  }

  const nodeCheck = await checkNodeRuntime()
  const pyCheck = await checkAndInstallPython(existingConfig.python || '', {
    dryRun: options.dryRun,
    skipPyInstall: options.skipPyInstall,
  })
  const dshDiscovery = discoverDshHome(options.dshHome)
  const obsidianInfo = await checkObsidianConfigured(existingConfig)

  const actions = []
  const writtenFiles = []
  const plannedFiles = []
  const todos = []

  if (nodeCheck.status === 'error') {
    todos.push(nodeCheck.hint)
  }
  if (pyCheck.status !== 'ok') {
    todos.push(pyCheck.hint)
  }

  // ---------------------------------------------------------------- 数据目录 & 工作区
  const dataSubdirs = [dataDir, path.join(dataDir, 'papers'), path.join(dataDir, '.pages')]
  if (options.dryRun) {
    for (const dir of dataSubdirs) {
      if (!existsSync(dir)) plannedFiles.push(dir)
    }
  } else {
    for (const dir of dataSubdirs) {
      await fsp.mkdir(dir, { recursive: true })
    }
  }
  const dataDirCheck = {
    status: 'ok',
    path: dataDir,
    configExists: existsSync(configPath),
  }

  const configuredWs = String((existingConfig && existingConfig.workspace && existingConfig.workspace.path) || '').trim()
  const resolvedWorkspace = options.workspace
    ? path.resolve(options.workspace)
    : configuredWs
      ? path.resolve(configuredWs)
      : path.join(dataDir, '论文')

  let workspaceCheck = { status: options.workspace ? (options.dryRun ? 'planned' : 'ok') : 'default', path: resolvedWorkspace }
  if (options.workspace) {
    if (options.dryRun) {
      if (!existsSync(resolvedWorkspace)) plannedFiles.push(resolvedWorkspace)
    } else {
      await fsp.mkdir(resolvedWorkspace, { recursive: true })
    }
  }

  // ---------------------------------------------------------------- workspace-skills 同步/预览
  const skillsSrcDir = path.join(repoRoot, 'assets', 'workspace-skills')
  let workspaceSkillsCheck = {
    status: 'skip',
    source: skillsSrcDir,
    target: resolvedWorkspace,
    files: [],
    reason: '仓库当前未包含 assets/workspace-skills/，无需额外同步。',
  }
  if (existsSync(skillsSrcDir)) {
    const targets = await listWorkspaceSkillTargets(skillsSrcDir, resolvedWorkspace)
    workspaceSkillsCheck = {
      status: options.dryRun ? 'planned' : 'ok',
      source: skillsSrcDir,
      target: resolvedWorkspace,
      files: targets.map((t) => t.dst),
      reason: '',
    }
    if (options.dryRun) {
      for (const item of targets) {
        plannedFiles.push(item.dst)
        actions.push({ action: 'sync-skill', target: item.dst, executed: false })
      }
    } else {
      const wsModulePath = path.join(repoRoot, 'lib', 'workspace-skills.js')
      let syncedPaths = []
      if (existsSync(wsModulePath)) {
        const { ensureWorkspaceSkills } = await import(pathToFileURL(wsModulePath).href)
        const res = await ensureWorkspaceSkills(resolvedWorkspace, { assetsDir: skillsSrcDir })
        syncedPaths = (res.updated || []).map((rel) => path.join(resolvedWorkspace, rel))
      } else {
        syncedPaths = await syncWorkspaceSkillsFallback(targets, resolvedWorkspace)
      }
      for (const item of targets) {
        const wasUpdated = syncedPaths.some((p) => path.resolve(p) === path.resolve(item.dst))
        if (wasUpdated) writtenFiles.push(item.dst)
        actions.push({ action: 'sync-skill', target: item.dst, executed: true, changed: wasUpdated })
      }
    }
  }

  // ---------------------------------------------------------------- DSH Home 安装与配置检查
  let dshCheck = {
    status: 'not_found',
    dshHome: dshDiscovery.dshHome,
    discoveredBy: dshDiscovery.discoveredBy,
    profilePackageJson: dshDiscovery.profilePackageJson,
    dependencySpec: '',
    previousSpec: null,
    changed: false,
    backupFile: '',
    registeredInBundles: false,
    cordisPatchExists: false,
    foundInCordisPatch: false,
    disabledInCordisPatch: false,
    pluginEnableStatus: 'unknown',
    nodeModulesLink: '',
    nodeModulesStatus: 'skip',
    copyDir: '',
    candidates: dshDiscovery.candidates,
    hint: '',
  }

  if (!dshDiscovery.found) {
    dshCheck.hint = options.dshHome
      ? '指定目录缺少 profiles/desktop/package.json：' + dshDiscovery.profilePackageJson
      : '未在候选路径找到包含 profiles/desktop/package.json 的 DSH Home；请通过 --dsh-home <path> 指定。'
    todos.push(dshCheck.hint)
  } else {
    const profileDir = path.join(dshDiscovery.dshHome, 'profiles', 'desktop')
    const profilePkgPath = dshDiscovery.profilePackageJson
    const rawPkg = await fsp.readFile(profilePkgPath, 'utf8')
    const parsedPkg = JSON.parse(rawPkg)
    const indent = detectIndent(rawPkg)
    const prevDeps = parsedPkg.dependencies && typeof parsedPkg.dependencies === 'object' ? parsedPkg.dependencies : {}
    const previousSpec = Object.prototype.hasOwnProperty.call(prevDeps, 'dsh-paper-workbench')
      ? prevDeps['dsh-paper-workbench']
      : null

    const copyDir = options.mode === 'copy' ? path.join(dshDiscovery.dshHome, 'plugins', 'dsh-paper-workbench') : ''
    const targetSpec =
      options.mode === 'copy'
        ? 'file:' + copyDir.replace(/\\/g, '/')
        : 'link:' + repoRoot.replace(/\\/g, '/')
    const nmLinkPath = path.join(profileDir, 'node_modules', 'dsh-paper-workbench')

    const nextDeps = { ...prevDeps, 'dsh-paper-workbench': targetSpec }
    const nextPkg = { ...parsedPkg, dependencies: nextDeps }
    const nextRaw = JSON.stringify(nextPkg, null, indent) + '\n'
    const changed = previousSpec !== targetSpec

    const bundles = Array.isArray(parsedPkg?.dsh?.profile?.bundles) ? parsedPkg.dsh.profile.bundles : []
    const registeredInBundles = bundles.includes('dsh-paper-workbench')
    const cordisInfo = await inspectCordisPatch(path.join(profileDir, 'cordis.patch.yml'))
    let pluginEnableStatus = 'not_registered'
    if (cordisInfo.disabled) pluginEnableStatus = 'disabled_in_cordis_patch'
    else if (registeredInBundles) pluginEnableStatus = 'enabled'

    const backupPath = profilePkgPath + '.bak'
    if (changed) {
      if (options.dryRun) {
        plannedFiles.push(backupPath, profilePkgPath)
        actions.push({ action: 'backup', target: backupPath, executed: false })
        actions.push({ action: 'write', target: profilePkgPath, executed: false })
      } else {
        if (existsSync(backupPath)) {
          const tsBackup = profilePkgPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
          await writeAtomic(tsBackup, rawPkg)
          writtenFiles.push(tsBackup)
          actions.push({ action: 'backup-history', target: tsBackup, executed: true })
        }
        await writeAtomic(backupPath, rawPkg)
        writtenFiles.push(backupPath)
        actions.push({ action: 'backup', target: backupPath, executed: true })

        await writeAtomic(profilePkgPath, nextRaw)
        writtenFiles.push(profilePkgPath)
        actions.push({ action: 'write', target: profilePkgPath, executed: true })
      }
    }

    let nmStatus = 'ok'
    if (options.mode === 'link') {
      let alreadyLinked = false
      if (existsSync(nmLinkPath)) {
        try {
          alreadyLinked = realpathSync(nmLinkPath) === realpathSync(repoRoot)
        } catch {
          alreadyLinked = false
        }
      }
      if (alreadyLinked) {
        nmStatus = 'already_linked'
      } else if (options.dryRun) {
        nmStatus = 'planned'
        plannedFiles.push(nmLinkPath)
        actions.push({ action: 'symlink', target: nmLinkPath, source: repoRoot, executed: false })
      } else {
        await fsp.mkdir(path.dirname(nmLinkPath), { recursive: true })
        await safeRemovePath(nmLinkPath)
        await fsp.symlink(repoRoot, nmLinkPath, IS_WIN ? 'junction' : 'dir')
        nmStatus = 'linked'
        writtenFiles.push(nmLinkPath)
        actions.push({ action: 'symlink', target: nmLinkPath, source: repoRoot, executed: true })
      }
    } else {
      const sameCopyDir = path.resolve(copyDir) === path.resolve(repoRoot)
      const sameNmDir = path.resolve(nmLinkPath) === path.resolve(repoRoot)
      if (options.dryRun) {
        nmStatus = 'planned'
        if (!sameCopyDir) {
          plannedFiles.push(copyDir)
          actions.push({ action: 'copy-plugin', target: copyDir, executed: false })
        }
        if (!sameNmDir) {
          plannedFiles.push(nmLinkPath)
          actions.push({ action: 'copy-node-modules', target: nmLinkPath, executed: false })
        }
      } else {
        if (!sameCopyDir) {
          await safeRemovePath(copyDir)
          await copyPackageTree(repoRoot, copyDir)
          writtenFiles.push(copyDir)
          actions.push({ action: 'copy-plugin', target: copyDir, executed: true })
        }

        if (!sameNmDir) {
          await fsp.mkdir(path.dirname(nmLinkPath), { recursive: true })
          await safeRemovePath(nmLinkPath)
          await copyPackageTree(sameCopyDir ? repoRoot : copyDir, nmLinkPath)
          writtenFiles.push(nmLinkPath)
          actions.push({ action: 'copy-node-modules', target: nmLinkPath, executed: true })
        }
        nmStatus = 'copied'
      }
    }

    if (pluginEnableStatus === 'disabled_in_cordis_patch') {
      todos.push('检测到 cordis.patch.yml 中设置了 disabled: true，请在 DSH 插件管理重新启用 dsh-paper-workbench 并重启桌面端。')
    } else if (pluginEnableStatus === 'not_registered') {
      todos.push('dsh-paper-workbench 尚未加入 dsh.profile.bundles，请在 DSH 桌面端「插件管理」启用它并重启桌面端。')
    }

    dshCheck = {
      status: 'ok',
      dshHome: dshDiscovery.dshHome,
      discoveredBy: dshDiscovery.discoveredBy,
      profilePackageJson: profilePkgPath,
      dependencySpec: targetSpec,
      previousSpec,
      changed,
      backupFile: changed ? backupPath : '',
      registeredInBundles,
      cordisPatchExists: cordisInfo.exists,
      foundInCordisPatch: cordisInfo.foundEntry,
      disabledInCordisPatch: cordisInfo.disabled,
      pluginEnableStatus,
      nodeModulesLink: nmLinkPath,
      nodeModulesStatus: nmStatus,
      copyDir,
      candidates: dshDiscovery.candidates,
      hint: '',
    }
  }

  const dbDriver = String((existingConfig && existingConfig.database && existingConfig.database.driver) || 'sqlite').toLowerCase()
  const remoteDbConfigured = ['postgres', 'postgresql', 'pg', 'mysql', 'mariadb'].includes(dbDriver)

  const optionalUserConfigs = [
    {
      id: 'paddle_ocr_token',
      index: 1,
      title: 'PaddleOCR Token（扫描件 OCR / PP-StructureV3 版面解析）',
      configured: Boolean(existingConfig && existingConfig.ocr && existingConfig.ocr.token),
      optional: true,
      how: '仅扫描件或付费云端版面解析需要；在工作台「⚙ 设置 → 扫描件 OCR」填入百度 AI Studio Token（写入 config.json，界面脱敏显示）。',
    },
    {
      id: 'remote_database',
      index: 2,
      title: '可选远程数据库（PostgreSQL / MySQL）',
      configured: remoteDbConfigured,
      optional: true,
      how: remoteDbConfigured
        ? `当前已配置远程数据库驱动：${dbDriver}（可在「⚙ 设置」调整或迁移数据）。`
        : '本插件默认使用本地 SQLite（Node 22.5+ 内置 node:sqlite）或 JSON 退化引擎（workbench.db / workbench.json），开箱无需外部库；如需团队共享或远程持久化，可在 config.json 的 database 字段配置 PostgreSQL / MySQL（已内置零依赖协议客户端）。',
    },
    {
      id: 'obsidian_vault',
      index: 3,
      title: '可选 Obsidian Vault（论文卡片与方向综述）',
      configured: obsidianInfo.configured,
      optional: true,
      how: obsidianInfo.configured
        ? '已检测到 Obsidian Vault：' + obsidianInfo.path + '（可在「⚙ 设置」调整 vault / kb 路径）。'
        : '打开目标 Obsidian 库可自动探测，或在「⚙ 设置」手动填写 vault / kb 路径；不配置不影响阅读与翻译。',
    },
    {
      id: 'dsh_plugin_enable',
      index: 4,
      title: '在 DSH 插件管理重启/启用 dsh-paper-workbench',
      configured: dshCheck.status === 'ok' && dshCheck.pluginEnableStatus === 'enabled',
      optional: false,
      how: '打开 DSH 桌面端 → 设置 → 插件管理，启用 dsh-paper-workbench 并重启桌面端（若已开启过请停用后再启用以加载最新服务端模块）。',
    },
  ]

  const ok = nodeCheck.status !== 'error' && dshCheck.status === 'ok'
  return {
    ok,
    dryRun: options.dryRun,
    mode: options.mode,
    repo: repoRoot,
    version: String(repoPkg.version || ''),
    checks: {
      node: nodeCheck,
      python: pyCheck,
      dsh: dshCheck,
      dataDir: dataDirCheck,
      workspace: workspaceCheck,
      workspaceSkills: workspaceSkillsCheck,
    },
    actions,
    writtenFiles,
    plannedFiles,
    todos,
    optionalUserConfigs,
  }
}

export function formatReport(report) {
  const lines = []
  lines.push(`=== dsh-paper-workbench 安装报告（${report.dryRun ? 'dry-run 预览' : '已执行'} · mode=${report.mode}）===`)
  lines.push(`仓库：${report.repo} (v${report.version || '?'})`)
  lines.push('')
  lines.push('[环境检查]')
  lines.push(`- Node.js     [${report.checks.node.status}] ${report.checks.node.detail}`)
  if (report.checks.node.hint) lines.push(`  → ${report.checks.node.hint}`)
  const py = report.checks.python
  const pyText = py.status === 'ok'
    ? `${py.python} (PyMuPDF ${py.fitzVersion}, Python ${py.pythonVersion}${py.installed ? ', 本次已自动安装' : ''})`
    : py.hint
  lines.push(`- PyMuPDF     [${py.status}] ${pyText}`)
  if (py.error) lines.push(`  → 尝试安装失败原因：${py.error}`)

  const dsh = report.checks.dsh
  if (dsh.status === 'ok') {
    lines.push(`- DSH Home    [ok] ${dsh.dshHome} (${dsh.discoveredBy})`)
    lines.push(`- 依赖声明    ${dsh.dependencySpec}${dsh.changed ? (report.dryRun ? '（待写入）' : '（已更新）') : '（已是最新）'}`)
    lines.push(`- 插件启停    bundles=${dsh.registeredInBundles ? '已登记' : '未登记'} / cordis=${dsh.disabledInCordisPatch ? '已禁用(disabled:true)' : '未禁用'} (${dsh.pluginEnableStatus})`)
    lines.push(`- 包挂载位置  ${dsh.nodeModulesLink} (${dsh.nodeModulesStatus})`)
  } else {
    lines.push(`- DSH Home    [FAIL] ${dsh.hint}`)
  }

  lines.push(`- 数据目录    [${report.checks.dataDir.status}] ${report.checks.dataDir.path}`)
  if (report.checks.workspace.path) {
    lines.push(`- 工作区目录  [${report.checks.workspace.status}] ${report.checks.workspace.path}`)
  }
  const wsSkills = report.checks.workspaceSkills
  lines.push(`- 技能同步    [${wsSkills.status}] ${wsSkills.reason || `${wsSkills.files.length} 个文件 → ${wsSkills.target}`}`)

  if (report.writtenFiles.length > 0) {
    lines.push('')
    lines.push('[本次写入文件]')
    for (const file of report.writtenFiles) lines.push(`- ${file}`)
  }
  if (report.plannedFiles.length > 0) {
    lines.push('')
    lines.push('[预计写入文件 (dry-run)]')
    for (const file of report.plannedFiles) lines.push(`- ${file}`)
  }
  if (report.todos.length > 0) {
    lines.push('')
    lines.push('[待处理事项]')
    for (const item of report.todos) lines.push(`- ${item}`)
  }

  lines.push('')
  lines.push('[剩余用户可选项]')
  for (const opt of report.optionalUserConfigs) {
    const tag = opt.configured ? '已就绪' : (opt.optional ? '可选' : '待操作')
    lines.push(`${opt.index}) [${tag}] ${opt.title}`)
    lines.push(`   ${opt.how}`)
  }

  lines.push('')
  lines.push(report.ok ? '结果：安装/检查完成。可运行 `npm run doctor` 复核。' : '结果：存在需要处理的错误项，请按提示排查后重试。')
  return lines.join('\n')
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    const msg = error && error.message ? error.message : String(error)
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    } else {
      console.error(msg)
      console.error('')
      console.error(printHelp())
    }
    process.exitCode = 1
    return
  }

  if (options.help) {
    if (options.json) {
      console.log(JSON.stringify({ ok: true, help: printHelp() }, null, 2))
    } else {
      console.log(printHelp())
    }
    return
  }

  try {
    const report = await runInstall(options)
    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(formatReport(report))
    }
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    const msg = error && error.message ? error.message : String(error)
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    } else {
      console.error('安装失败：' + msg)
    }
    process.exitCode = 1
  }
}

const isEntry = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  }
})()

if (isEntry) {
  await main()
}
