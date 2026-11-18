/**
 * 自动化安装器、Skill 与 CI/CD 工作流回归测试。
 *
 * 全部跑在 os.tmpdir() 隔离临时目录下，绝不触碰真实 ~/.dsh 或本机 DSH Home。
 * 运行：node scripts/test-install-agent.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, promises as fsp, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-agent.mjs')
const SKILL_MD = path.join(REPO_ROOT, 'skills', 'install-dsh-paper-workbench', 'SKILL.md')
const CI_YML = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const RELEASE_YML = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml')

let passed = 0
let failed = 0

function ok(condition, message) {
  if (!condition) throw new Error(message || '断言失败')
}

function eq(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((message ? message + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
  }
}

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + (error && error.message ? error.message : String(error)))
  }
}

function runInstaller(args, extraEnv = {}) {
  const res = spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      ...extraEnv,
    },
  })
  return {
    status: res.status == null ? -1 : res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
  }
}

/**
 * 轻量 YAML 基础语法检查器（零外部依赖）：
 * 1) 禁止出现 Tab 缩进或 Tab 字符；
 * 2) 校验 GitHub Actions `${{ ... }}` 表达式括号配对；
 * 3) 校验非 block scalar 行的键值对/列表结构、缩进回退对齐与引号配对；
 * 4) 若本机恰好装有 PyYAML 则顺带用 yaml.safe_load 复验（未装则不报错）。
 */
function validateWorkflowYaml(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  ok(!raw.includes('\t'), path.basename(filePath) + ' 不能包含 Tab 字符')
  const lines = raw.split(/\r?\n/)
  let blockIndent = null
  const exprOpenMatches = raw.match(/\$\{\{/g) || []
  const exprCloseMatches = raw.match(/\}\}/g) || []
  ok(exprOpenMatches.length <= exprCloseMatches.length, path.basename(filePath) + ' 存在未闭合的 ${{ 表达式')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    i += 1
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length

    if (blockIndent !== null) {
      if (indent > blockIndent) continue
      blockIndent = null
    }

    ok(!/\$\{\{[^}]*$/.test(trimmed), path.basename(filePath) + ' 第 ' + i + ' 行存在未闭合 ${{')

    // 剥离行尾块标量符号 | 或 >
    if (/^([-\s]*[^:#\s][^:]*|-\s*[^:]+):\s*[|>][-+]?\s*(#.*)?$/.test(line)) {
      blockIndent = indent
      continue
    }

    // 检查合法 YAML 结构形态：list item (- ...)、mapping (key: ...)、或单行流式键值
    const isList = /^-\s+/.test(trimmed) || trimmed === '-'
    const isMapping = /^[A-Za-z0-9_."'/-]+(\s+[A-Za-z0-9_."'/-]+)*\s*:(\s|$)/.test(trimmed)
    ok(isList || isMapping, path.basename(filePath) + ' 第 ' + i + ' 行疑似无效 YAML 语法：' + trimmed)
  }

  // 若环境恰好存在 PyYAML，追加真解析校验
  const pyCheck = spawnSync('python', ['-c', 'import yaml,sys; yaml.safe_load(open(sys.argv[1], encoding="utf-8"))', filePath], {
    encoding: 'utf8',
    timeout: 10000,
  })
  if (pyCheck.status !== 0 && pyCheck.stderr && !/No module named ['"]yaml['"]/.test(pyCheck.stderr)) {
    throw new Error('PyYAML 解析 ' + path.basename(filePath) + ' 失败：' + pyCheck.stderr)
  }
}

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-install-test-'))

try {
  // 1. CLI --help 与错误参数处理
  await check('CLI --help 返回 0 并展示所有约定参数', () => {
    const res = runInstaller(['--help'])
    eq(res.status, 0)
    for (const flag of ['--dsh-home', '--data-dir', '--workspace', '--repo', '--mode', '--dry-run', '--json', '--skip-py-install']) {
      ok(res.stdout.includes(flag), '帮助文档缺少参数 ' + flag)
    }
  })

  await check('非法 --mode 在 --json 下输出合法错误 JSON 并返回非零退出码', () => {
    const res = runInstaller(['--mode', 'badmode', '--json'])
    ok(res.status !== 0, '非法参数应返回非零退出码')
    const parsed = JSON.parse(res.stdout)
    eq(parsed.ok, false)
    ok(parsed.error && parsed.error.includes('badmode'))
  })

  // 2. 隔离假 DSH Home #1：--dry-run --json 不写盘
  const dsh1 = path.join(tmpRoot, 'dsh-link')
  const profile1 = path.join(dsh1, 'profiles', 'desktop')
  const pkg1Path = path.join(profile1, 'package.json')
  const data1 = path.join(tmpRoot, 'data-1')
  const ws1 = path.join(tmpRoot, 'ws-1')
  const initialPkg1Obj = {
    name: 'dsh-profile-desktop',
    private: true,
    author: 'preserve-me',
    scripts: { start: 'echo keep' },
    dependencies: {
      'existing-plugin': '^1.2.3',
    },
    dsh: {
      profile: {
        bundles: ['existing-plugin'],
      },
    },
  }
  const initialPkg1Raw = JSON.stringify(initialPkg1Obj, null, 2) + '\n'
  await fsp.mkdir(profile1, { recursive: true })
  await fsp.writeFile(pkg1Path, initialPkg1Raw, 'utf8')

  await check('--dry-run --json 准确规划但不修改假 DSH Home 与数据目录', () => {
    const res = runInstaller([
      '--dsh-home', dsh1,
      '--data-dir', data1,
      '--workspace', ws1,
      '--dry-run',
      '--json',
      '--skip-py-install',
    ])
    eq(res.status, 0, res.stderr || res.stdout)
    const report = JSON.parse(res.stdout)
    eq(report.ok, true)
    eq(report.dryRun, true)
    eq(report.mode, 'link')
    eq(report.checks.dsh.status, 'ok')
    eq(report.checks.dsh.changed, true)
    eq(report.checks.dsh.dependencySpec, 'link:' + REPO_ROOT.replace(/\\/g, '/'))
    eq(report.writtenFiles, [])
    ok(report.plannedFiles.includes(pkg1Path), 'plannedFiles 应含 package.json')
    ok(report.plannedFiles.includes(pkg1Path + '.bak'), 'plannedFiles 应含 .bak')
    ok(Array.isArray(report.optionalUserConfigs) && report.optionalUserConfigs.length === 4, '应列出 4 项用户可选/待确认项')
    ok(report.optionalUserConfigs.some((x) => /PaddleOCR/i.test(x.title)), '应包含 PaddleOCR Token 项')
    ok(report.optionalUserConfigs.some((x) => /PostgreSQL|MySQL/i.test(x.title)), '应包含 PostgreSQL/MySQL 项')
    ok(report.optionalUserConfigs.some((x) => /Obsidian/i.test(x.title)), '应包含 Obsidian Vault 项')
    ok(report.optionalUserConfigs.some((x) => /dsh-paper-workbench/.test(x.title)), '应包含 DSH 插件重启/启用项')

    eq(readFileSync(pkg1Path, 'utf8'), initialPkg1Raw, 'dry-run 不应改写 package.json')
    ok(!existsSync(pkg1Path + '.bak'), 'dry-run 不应生成 .bak')
    ok(!existsSync(data1), 'dry-run 不应创建数据目录')
    ok(!existsSync(ws1), 'dry-run 不应创建工作区目录')
  })

  // 3. 实际写入（--mode link）：验证依赖、原字段保留、.bak 备份、node_modules 链接
  await check('实际写入 --mode link 正确更新依赖、保留原字段、生成 .bak 并挂载链接', () => {
    const res = runInstaller([
      '--dsh-home', dsh1,
      '--data-dir', data1,
      '--workspace', ws1,
      '--mode', 'link',
      '--json',
      '--skip-py-install',
    ])
    eq(res.status, 0, res.stderr || res.stdout)
    const report = JSON.parse(res.stdout)
    eq(report.ok, true)
    eq(report.dryRun, false)
    eq(report.checks.dsh.changed, true)
    eq(report.checks.dsh.registeredInBundles, false)
    eq(report.checks.dsh.pluginEnableStatus, 'not_registered')

    ok(existsSync(pkg1Path + '.bak'), '应生成 package.json.bak')
    eq(readFileSync(pkg1Path + '.bak', 'utf8'), initialPkg1Raw, '.bak 应逐字节等于原文件')

    const updated = JSON.parse(readFileSync(pkg1Path, 'utf8'))
    eq(updated.name, 'dsh-profile-desktop', '保留 name')
    eq(updated.private, true, '保留 private')
    eq(updated.author, 'preserve-me', '保留自定义字段 author')
    eq(updated.scripts, { start: 'echo keep' }, '保留 scripts')
    eq(updated.dsh, initialPkg1Obj.dsh, '保留 dsh.profile.bundles')
    eq(updated.dependencies['existing-plugin'], '^1.2.3', '保留已有依赖')
    eq(updated.dependencies['dsh-paper-workbench'], 'link:' + REPO_ROOT.replace(/\\/g, '/'), '写入 link 依赖')

    const linkedPkg = path.join(profile1, 'node_modules', 'dsh-paper-workbench', 'package.json')
    ok(existsSync(linkedPkg), 'node_modules/dsh-paper-workbench 应可解析 package.json')
    ok(existsSync(path.join(data1, 'papers')), '应创建 dataDir/papers')
    ok(existsSync(path.join(data1, '.pages')), '应创建 dataDir/.pages')
    ok(existsSync(ws1), '应创建 workspace 目录')
    if (existsSync(path.join(REPO_ROOT, 'assets', 'workspace-skills', 'AGENTS.md'))) {
      ok(existsSync(path.join(ws1, 'AGENTS.md')), 'workspace-skills 存在时应同步 AGENTS.md 到工作区')
    }
  })

  // 4. 幂等重跑 + cordis.patch.yml disabled:true 检测
  await check('幂等重跑与 cordis.patch.yml disabled:true 状态检测', async () => {
    await fsp.writeFile(
      path.join(profile1, 'cordis.patch.yml'),
      '- id: paper-workbench\n  name: dsh-paper-workbench\n  disabled: true\n',
      'utf8',
    )
    const res = runInstaller([
      '--dsh-home', dsh1,
      '--data-dir', data1,
      '--json',
      '--skip-py-install',
    ])
    eq(res.status, 0, res.stderr || res.stdout)
    const report = JSON.parse(res.stdout)
    eq(report.ok, true)
    eq(report.checks.dsh.changed, false)
    eq(report.checks.dsh.foundInCordisPatch, true)
    eq(report.checks.dsh.disabledInCordisPatch, true)
    eq(report.checks.dsh.pluginEnableStatus, 'disabled_in_cordis_patch')
    eq(readFileSync(pkg1Path + '.bak', 'utf8'), initialPkg1Raw, '无变更时原 .bak 保持不变')
  })

  // 5. DSH_HOME 环境变量自动发现 + --mode copy 实测
  const dsh2 = path.join(tmpRoot, 'dsh-copy')
  const profile2 = path.join(dsh2, 'profiles', 'desktop')
  const pkg2Path = path.join(profile2, 'package.json')
  const data2 = path.join(tmpRoot, 'data-2')
  const initialPkg2Raw = JSON.stringify(
    {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: { other: '0.1.0' },
      dsh: { profile: { bundles: ['other', 'dsh-paper-workbench'] } },
    },
    null,
    4,
  ) + '\n'
  await fsp.mkdir(profile2, { recursive: true })
  await fsp.writeFile(pkg2Path, initialPkg2Raw, 'utf8')

  await check('DSH_HOME 自动发现与 --mode copy 完整复制包及写入 file: 依赖', () => {
    const res = runInstaller(
      ['--data-dir', data2, '--mode', 'copy', '--json', '--skip-py-install'],
      { DSH_HOME: dsh2 },
    )
    eq(res.status, 0, res.stderr || res.stdout)
    const report = JSON.parse(res.stdout)
    eq(report.ok, true)
    eq(report.checks.dsh.discoveredBy, 'env')
    eq(report.checks.dsh.dshHome, path.resolve(dsh2))
    eq(report.checks.dsh.registeredInBundles, true)
    eq(report.checks.dsh.pluginEnableStatus, 'enabled')

    const expectedCopyDir = path.join(dsh2, 'plugins', 'dsh-paper-workbench')
    const expectedSpec = 'file:' + expectedCopyDir.replace(/\\/g, '/')
    const updated2 = JSON.parse(readFileSync(pkg2Path, 'utf8'))
    eq(updated2.dependencies['dsh-paper-workbench'], expectedSpec)
    eq(updated2.dependencies.other, '0.1.0')
    ok(existsSync(pkg2Path + '.bak'), 'copy 模式应生成 .bak')
    ok(existsSync(path.join(expectedCopyDir, 'lib', 'index.js')), 'plugins/dsh-paper-workbench 应含 lib/index.js')
    ok(existsSync(path.join(profile2, 'node_modules', 'dsh-paper-workbench', 'package.json')), 'node_modules 副本应就绪')
  })

  // 6. 指定不存在的 --dsh-home 报错
  await check('不存在的 --dsh-home 明确返回 ok:false 且退出码非 0', () => {
    const missing = path.join(tmpRoot, 'missing-dsh')
    const res = runInstaller(['--dsh-home', missing, '--data-dir', data2, '--json', '--skip-py-install'])
    ok(res.status !== 0, '缺失 DSH Home 应返回非零退出码')
    const report = JSON.parse(res.stdout)
    eq(report.ok, false)
    eq(report.checks.dsh.status, 'not_found')
  })

  // 7. assets/workspace-skills/ 同步预览与复制（用临时假仓库测试 + 用户 AGENTS.md 保留）
  await check('mock 仓库含 assets/workspace-skills/ 时支持 dry-run 预览与保留用户内容同步', async () => {
    const mockRepo = path.join(tmpRoot, 'mock-repo')
    const skillSrc = path.join(mockRepo, 'assets', 'workspace-skills', 'paper-helper')
    await fsp.mkdir(skillSrc, { recursive: true })
    await fsp.writeFile(
      path.join(mockRepo, 'package.json'),
      JSON.stringify({ name: 'dsh-paper-workbench', version: '0.8.0' }),
      'utf8',
    )
    await fsp.writeFile(path.join(mockRepo, 'assets', 'workspace-skills', 'AGENTS.md'), '# Managed Rules\n', 'utf8')
    await fsp.writeFile(path.join(skillSrc, 'SKILL.md'), '---\nname: paper-helper\n---\n', 'utf8')

    const ws3 = path.join(tmpRoot, 'ws-3')
    await fsp.mkdir(ws3, { recursive: true })
    await fsp.writeFile(path.join(ws3, 'AGENTS.md'), '# Custom User Header\n', 'utf8')

    const dry = runInstaller([
      '--repo', mockRepo,
      '--dsh-home', dsh1,
      '--data-dir', data1,
      '--workspace', ws3,
      '--dry-run',
      '--json',
      '--skip-py-install',
    ])
    eq(dry.status, 0, dry.stderr || dry.stdout)
    const dryReport = JSON.parse(dry.stdout)
    eq(dryReport.checks.workspaceSkills.status, 'planned')
    const expectedDst = path.join(ws3, '.dsh', 'skills', 'paper-helper', 'SKILL.md')
    ok(dryReport.checks.workspaceSkills.files.includes(expectedDst))
    ok(!existsSync(expectedDst), 'dry-run 不应实际复制 workspace-skills')
    eq(readFileSync(path.join(ws3, 'AGENTS.md'), 'utf8'), '# Custom User Header\n', 'dry-run 不应改写用户 AGENTS.md')

    const live = runInstaller([
      '--repo', mockRepo,
      '--dsh-home', dsh1,
      '--data-dir', data1,
      '--workspace', ws3,
      '--json',
      '--skip-py-install',
    ])
    eq(live.status, 0, live.stderr || live.stdout)
    const liveReport = JSON.parse(live.stdout)
    eq(liveReport.checks.workspaceSkills.status, 'ok')
    ok(existsSync(expectedDst), '实际运行应同步 workspace-skills 到目标工作区')
    const mergedAgents = readFileSync(path.join(ws3, 'AGENTS.md'), 'utf8')
    ok(mergedAgents.includes('# Custom User Header'), '合并后应保留用户原有 AGENTS.md 内容')
    ok(mergedAgents.includes('# Managed Rules'), '合并后应写入受管 AGENTS 规则')
  })

  // 8. SKILL.md 格式完整性校验
  await check('skills/install-dsh-paper-workbench/SKILL.md 格式与关键内容完整', () => {
    ok(existsSync(SKILL_MD), '缺少 SKILL.md')
    const content = readFileSync(SKILL_MD, 'utf8')
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
    ok(fm, 'SKILL.md 必须以 YAML frontmatter (--- ... ---) 开头')
    ok(!fm[1].includes('\t'), 'SKILL.md frontmatter 不能含 Tab')
    ok(/^name:\s*install-dsh-paper-workbench\s*$/m.test(fm[1]), 'frontmatter name 应为 install-dsh-paper-workbench')
    ok(/^description:\s*\S+/m.test(fm[1]), 'frontmatter 必须包含非空 description')
    for (const token of ['install-agent.mjs', '--dry-run', '--json', 'doctor.mjs', 'PaddleOCR', 'PostgreSQL', 'Obsidian']) {
      ok(content.includes(token), 'SKILL.md 缺少关键说明：' + token)
    }
  })

  // 9. CI/CD workflow YAML 语法与必备要素校验
  await check('.github/workflows/ci.yml 语法合法且覆盖跨平台与 JSON 引擎回归', () => {
    ok(existsSync(CI_YML), '缺少 .github/workflows/ci.yml')
    validateWorkflowYaml(CI_YML)
    const yml = readFileSync(CI_YML, 'utf8')
    for (const token of [
      'ubuntu-latest',
      'windows-latest',
      'macos-latest',
      'pull_request',
      'workflow_dispatch',
      'actions/checkout@v4',
      'actions/setup-node@v4',
      'actions/setup-python@v5',
      'pymupdf',
      'node --check',
      'DSH_PAPER_WORKBENCH_DATA',
      'PYTHONUTF8',
      'PB_CI',
      'npm test',
      'test-install-agent.mjs',
      'PB_DB_ENGINE',
      'test-db.mjs',
      'npm pack --dry-run',
    ]) {
      ok(yml.includes(token), 'ci.yml 缺少要素：' + token)
    }
    for (const branch of ['dev', 'test', 'prod', 'main']) {
      ok(new RegExp('^\\s*-\\s*' + branch + '\\s*$', 'm').test(yml), 'ci.yml 缺少触发分支：' + branch)
    }
  })

  await check('.github/workflows/release.yml 语法合法且包含测试门禁、打包、校验与 Release', () => {
    ok(existsSync(RELEASE_YML), '缺少 .github/workflows/release.yml')
    validateWorkflowYaml(RELEASE_YML)
    const yml = readFileSync(RELEASE_YML, 'utf8')
    for (const token of [
      'v*',
      'workflow_dispatch',
      'pymupdf',
      'npm test',
      'npm pack',
      'SHA256SUMS.txt',
      'softprops/action-gh-release@v2',
      'install-agent.mjs',
      'SKILL.md',
    ]) {
      ok(yml.includes(token), 'release.yml 缺少要素：' + token)
    }
  })
} finally {
  try {
    await fsp.rm(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 清理临时目录失败不影响测试结论 */
  }
}

console.log('')
console.log('PASS ' + passed + ' / FAIL ' + failed)
process.exitCode = failed ? 1 : 0
