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
const INSTALL_PS1 = path.join(REPO_ROOT, 'scripts', 'install.ps1')
const INSTALL_SH = path.join(REPO_ROOT, 'scripts', 'install.sh')
const ICON_SVG = path.join(REPO_ROOT, 'icon.svg')
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

function runInstaller(args, extraEnv = {}, installer = INSTALLER) {
  const res = spawnSync(process.execPath, [installer, ...args], {
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

  const cliAlias = path.join(tmpRoot, 'cli-alias')
  let cliAliasAvailable = true
  try { await fsp.symlink(REPO_ROOT, cliAlias, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
    cliAliasAvailable = false
    console.log('SKIP  CLI 目录链接入口不可用：' + error.code)
  }
  if (cliAliasAvailable) await check('CLI 经目录链接启动仍执行入口并输出有效帮助 JSON', () => {
    const direct = runInstaller(['--help', '--json'])
    const aliased = runInstaller(['--help', '--json'], {}, path.join(cliAlias, 'scripts', 'install-agent.mjs'))
    eq(direct.status, 0, direct.stderr)
    eq(aliased.status, 0, aliased.stderr)
    const expected = JSON.parse(direct.stdout)
    eq(expected.ok, true)
    ok(expected.help.includes('--dsh-home'))
    eq(JSON.parse(aliased.stdout), expected)
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
    ok(Array.isArray(report.optionalUserConfigs) && report.optionalUserConfigs.length === 5, '应列出 5 项用户可选/待确认项')
    ok(report.optionalUserConfigs.some((x) => /代理|Proxy/i.test(x.title)), '应包含网络代理项')
    ok(report.optionalUserConfigs.some((x) => /PaddleOCR/i.test(x.title)), '应包含 PaddleOCR Token 项')
    ok(report.optionalUserConfigs.some((x) => /PostgreSQL|MySQL/i.test(x.title)), '应包含 PostgreSQL/MySQL 项')
    ok(report.optionalUserConfigs.some((x) => /Obsidian/i.test(x.title)), '应包含 Obsidian Vault 项')
    ok(report.optionalUserConfigs.some((x) => /dsh-paper-workbench/.test(x.title)), '应包含 DSH 插件重启/启用项')

    eq(readFileSync(pkg1Path, 'utf8'), initialPkg1Raw, 'dry-run 不应改写 package.json')
    ok(!existsSync(pkg1Path + '.bak'), 'dry-run 不应生成 .bak')
    ok(!existsSync(data1), 'dry-run 不应创建数据目录')
    ok(!existsSync(ws1), 'dry-run 不应创建工作区目录')
  })

  await check('安装报告识别 network.proxyUrl 模式并脱敏认证信息', async () => {
    const proxyData = path.join(tmpRoot, 'proxy-data')
    const directData = path.join(tmpRoot, 'direct-data')
    const autoData = path.join(tmpRoot, 'auto-data')
    await Promise.all([proxyData, directData, autoData].map((dir) => fsp.mkdir(dir, { recursive: true })))
    await fsp.writeFile(path.join(proxyData, 'config.json'), JSON.stringify({
      network: { mode: 'custom', proxyUrl: 'http://config-user:config-secret@127.0.0.1:7897' },
    }))
    await fsp.writeFile(path.join(directData, 'config.json'), JSON.stringify({
      network: { mode: 'direct', proxyUrl: 'http://config-user:config-secret@127.0.0.1:7897' },
    }))
    await fsp.writeFile(path.join(autoData, 'config.json'), JSON.stringify({ network: { mode: 'auto', proxyUrl: '' } }))
    const env = {
      HTTPS_PROXY: '', https_proxy: '',
      HTTP_PROXY: 'http://env-user:env-secret@127.0.0.1:8888', http_proxy: '',
      ALL_PROXY: '', all_proxy: '', PB_DISABLE_SYSTEM_PROXY: '1',
    }
    const args = (dataDir) => [
      '--dsh-home', dsh1, '--data-dir', dataDir, '--workspace', ws1,
      '--dry-run', '--json', '--skip-py-install',
    ]

    const custom = runInstaller(args(proxyData), env)
    eq(custom.status, 0, custom.stderr || custom.stdout)
    const customReport = JSON.parse(custom.stdout)
    eq(customReport.checks.proxy, {
      configured: true,
      url: 'http://127.0.0.1:7897',
      authConfigured: true,
      source: 'custom',
    })
    ok(!custom.stdout.includes('config-secret') && !custom.stdout.includes('env-secret'), 'JSON 安装报告不得泄漏代理凭据')

    const direct = runInstaller(args(directData), env)
    eq(direct.status, 0, direct.stderr || direct.stdout)
    eq(JSON.parse(direct.stdout).checks.proxy.configured, false, 'direct 必须压过系统代理环境变量')
    eq(JSON.parse(direct.stdout).checks.proxy.source, 'direct')
    ok(JSON.parse(direct.stdout).optionalUserConfigs.find((item) => item.id === 'network_proxy').how.includes('不会覆盖该模式'))
    ok(!direct.stdout.includes('config-secret') && !direct.stdout.includes('env-secret'))

    const auto = runInstaller(args(autoData), env)
    eq(auto.status, 0, auto.stderr || auto.stdout)
    const autoReport = JSON.parse(auto.stdout)
    eq(autoReport.checks.proxy.url, 'http://127.0.0.1:8888')
    eq(autoReport.checks.proxy.authConfigured, true)
    eq(autoReport.checks.proxy.source, 'env')
    ok(!auto.stdout.includes('env-secret'), '自动探测环境代理也不得泄漏认证信息')

    const human = runInstaller(args(proxyData).filter((arg) => arg !== '--json'), env)
    eq(human.status, 0, human.stderr || human.stdout)
    ok(!human.stdout.includes('config-secret'), '人类可读安装报告不得泄漏代理凭据')
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

  // Copy must not remove its source through either installation target's alias.
  for (const [mode, location, alias] of [
    ['copy', 'plugins', 'exact'], ['copy', 'plugins', 'case'], ['copy', 'plugins', 'junction'],
    ['copy', 'node_modules', 'exact'], ['copy', 'node_modules', 'case'], ['copy', 'node_modules', 'junction'],
    ['link', 'node_modules', 'case'],
  ]) {
    if (alias === 'case' && process.platform !== 'win32') {
      console.log('SKIP  ' + mode + ' ' + location + ' Windows 大小写别名（仅 Windows）')
      continue
    }
    const home = path.join(tmpRoot, 'same-source-' + mode + '-' + location + '-' + alias)
    const profile = path.join(home, 'profiles', 'desktop')
    const pluginDir = path.join(home, 'plugins', 'dsh-paper-workbench')
    const nmDir = path.join(profile, 'node_modules', 'dsh-paper-workbench')
    const source = location === 'plugins' ? pluginDir : nmDir
    const sourcePkg = { name: 'dsh-paper-workbench', version: '1.2.0' }
    await fsp.mkdir(source, { recursive: true })
    await fsp.mkdir(profile, { recursive: true })
    await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {} }))
    await fsp.writeFile(path.join(source, 'package.json'), JSON.stringify(sourcePkg))
    await fsp.writeFile(path.join(source, 'keep-source.txt'), 'source-must-survive')
    await fsp.writeFile(path.join(source, '.env.keep-source'), 'synthetic-local-setting=keep\n')
    let repoArgument = source
    if (alias === 'case') repoArgument = location === 'plugins'
      ? path.join(home, 'PLUGINS', 'dsh-paper-workbench')
      : path.join(profile, 'NODE_MODULES', 'dsh-paper-workbench')
    if (alias === 'junction') {
      repoArgument = path.join(home, 'source-alias')
      try { await fsp.symlink(source, repoArgument, process.platform === 'win32' ? 'junction' : 'dir') }
      catch (error) {
        if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
        console.log('SKIP  ' + mode + ' ' + location + ' 目录链接不可用：' + error.code)
        continue
      }
    }
    await check(mode + ' ' + location + ' ' + alias + ' 同源保留源文件且目标包有效', async () => {
      eq(await fsp.realpath(repoArgument), await fsp.realpath(source), '夹具必须是真实同源')
      const res = runInstaller([
        '--repo', repoArgument, '--dsh-home', home, '--data-dir', path.join(home, 'data'),
        '--workspace', path.join(home, 'workspace'), '--mode', mode, '--json', '--skip-py-install',
      ])
      eq(res.status, 0, res.stderr || res.stdout)
      eq(JSON.parse(res.stdout).ok, true)
      for (const name of ['package.json', 'keep-source.txt', '.env.keep-source']) {
        ok(existsSync(path.join(source, name)), '同源安装不能删除源文件：' + name)
      }
      eq(JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')), sourcePkg)
      eq(readFileSync(path.join(source, 'keep-source.txt'), 'utf8'), 'source-must-survive')
      eq(readFileSync(path.join(source, '.env.keep-source'), 'utf8'), 'synthetic-local-setting=keep\n')
      for (const target of mode === 'copy' ? [pluginDir, nmDir] : [nmDir]) {
        eq(JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')), sourcePkg)
        eq(readFileSync(path.join(target, 'keep-source.txt'), 'utf8'), 'source-must-survive')
        if (await fsp.realpath(target) !== await fsp.realpath(source)) {
          ok(!existsSync(path.join(target, '.env.keep-source')), '普通副本不能包含源本地配置')
        }
      }
    })
  }

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
    for (const token of ['install.ps1', 'install.sh', 'install-agent.mjs', '--dry-run', '--json', 'doctor.mjs', '127.0.0.1:7897', 'PaddleOCR', 'PostgreSQL', 'Obsidian']) {
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
      'NPM_TOKEN',
      'npm publish',
      '--provenance',
      'id-token: write',
      'softprops/action-gh-release@v2',
      'install.ps1',
      'install.sh',
      'install-agent.mjs',
      'SKILL.md',
    ]) {
      ok(yml.includes(token), 'release.yml 缺少要素：' + token)
    }
  })

  // 10. icon.svg 存在且为合法独立 SVG XML (< 3 KB)
  await check('icon.svg 存在、体积 < 3 KB 且为合法独立 SVG XML', () => {
    ok(existsSync(ICON_SVG), '仓库根目录缺少 icon.svg')
    const raw = readFileSync(ICON_SVG, 'utf8')
    const bytes = Buffer.byteLength(raw, 'utf8')
    ok(bytes > 100 && bytes < 3072, 'icon.svg 体积应小于 3 KB，当前为 ' + bytes + ' bytes')
    ok(/^\s*<svg\b[\s\S]*<\/svg>\s*$/.test(raw), 'icon.svg 应以 <svg ...> 包裹并以 </svg> 结尾')
    ok(raw.includes('xmlns="http://www.w3.org/2000/svg"'), 'icon.svg 应包含 SVG 命名空间 xmlns')
    ok(raw.includes('viewBox="0 0 128 128"'), 'icon.svg 应包含 viewBox="0 0 128 128"')
    ok(/#2563EB/i.test(raw) && /#1D4ED8/i.test(raw), 'icon.svg 应包含约定品牌蓝渐变色')
    const pyXml = spawnSync('python', ['-c', 'import sys,xml.etree.ElementTree as ET; ET.fromstring(open(sys.argv[1], encoding="utf-8").read())', ICON_SVG], {
      encoding: 'utf8',
      timeout: 8000,
    })
    if (pyXml.status === 0 || (pyXml.stderr && pyXml.stderr.trim())) {
      eq(pyXml.status, 0, 'XML 解析 icon.svg 失败：' + pyXml.stderr)
    }
  })

  // 11. scripts/install.ps1 存在且在假 DSH_HOME 下通过 -DryRun
  await check('scripts/install.ps1 存在且在隔离假 DSH_HOME 下通过 -DryRun 预览', async () => {
    ok(existsSync(INSTALL_PS1), '缺少 scripts/install.ps1')
    const psRaw = readFileSync(INSTALL_PS1, 'utf8')
    for (const token of ['-Version', '-Profile', '-DshHome', '-DryRun', 'minimumReleaseAgeExclude', 'dsh.profile.bundles', 'pymupdf']) {
      ok(psRaw.includes(token), 'install.ps1 缺少关键逻辑：' + token)
    }

    const psBins = []
    const winPs51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const candidates = [
      { bin: 'pwsh', legacy: false },
      ...(process.platform === 'win32' && existsSync(winPs51) ? [{ bin: winPs51, legacy: true }] : []),
      ...(process.platform === 'win32' ? [{ bin: 'powershell', legacy: true }] : []),
    ]
    for (const item of candidates) {
      const probe = spawnSync(item.bin, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
        encoding: 'utf8',
        timeout: 8000,
      })
      if (probe.status === 0 && String(probe.stdout || '').trim()) {
        psBins.push(item)
        if (psBins.length >= 2) break
      }
    }

    if (psBins.length === 0 && process.platform !== 'win32') {
      return
    }
    ok(psBins.length > 0, 'Windows 环境应存在可用的 pwsh 或 powershell')

    const fakePsHome = path.join(tmpRoot, 'dsh-ps-dry')
    const fakePsProf = path.join(fakePsHome, 'profiles', 'desktop')
    const fakePsPkg = path.join(fakePsProf, 'package.json')
    const fakePsWs = path.join(fakePsProf, 'pnpm-workspace.yaml')
    const initPkg = JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {} }, null, 2) + '\n'
    await fsp.mkdir(fakePsProf, { recursive: true })
    await fsp.writeFile(fakePsPkg, initPkg, 'utf8')
    await fsp.writeFile(fakePsWs, 'packages:\n  - .\n', 'utf8')

    for (const { bin, legacy } of psBins) {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        ...(legacy ? ['-ExecutionPolicy', 'Bypass'] : []),
        '-File',
        INSTALL_PS1,
        '-DryRun',
        '-DshHome',
        fakePsHome,
        '-Version',
        'v1.1.0',
      ]
      const run = spawnSync(bin, args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          DSH_HOME: fakePsHome,
          DSH_PAPER_WORKBENCH_DATA: path.join(tmpRoot, 'data-ps-dry'),
        },
      })
      eq(run.status, 0, bin + ' 执行失败：' + String(run.stderr || run.stdout))
      ok(/dry-run/i.test(run.stdout), bin + ' 执行 install.ps1 -DryRun 应输出 dry-run 预览信息')
      eq(readFileSync(fakePsPkg, 'utf8'), initPkg, 'install.ps1 -DryRun 不应修改 package.json')
      ok(!existsSync(fakePsPkg + '.bak'), 'install.ps1 -DryRun 不应创建 .bak')
      ok(!existsSync(path.join(fakePsHome, 'plugins')), 'install.ps1 -DryRun 不应创建 plugins 目录')
    }
  })

  // 12. scripts/install.sh 存在、严格 LF 换行且在假 DSH_HOME 下通过 --dry-run
  await check('scripts/install.sh 存在、严格 LF 换行（无 CRLF）且通过 bash --dry-run', async () => {
    ok(existsSync(INSTALL_SH), '缺少 scripts/install.sh')
    const shBuf = readFileSync(INSTALL_SH)
    ok(!shBuf.includes(0x0d), 'scripts/install.sh 严禁包含 CR (\\r\\n) 字符，必须保持纯 LF 换行以兼容 curl ... | bash')
    const shRaw = shBuf.toString('utf8')
    ok(shRaw.startsWith('#!/usr/bin/env bash\n'), 'scripts/install.sh 必须以 #!/usr/bin/env bash\\n 开头')
    for (const token of ['--version', '--profile', '--dsh-home', '--dry-run', 'minimumReleaseAgeExclude', 'dsh.profile.bundles', 'pymupdf']) {
      ok(shRaw.includes(token), 'install.sh 缺少关键逻辑：' + token)
    }

    let bashBin = ''
    if (process.platform === 'win32') {
      const cands = []
      const whereGit = spawnSync('where.exe', ['git'], { encoding: 'utf8', timeout: 4000 })
      if (whereGit.status === 0) {
        for (const gitExe of String(whereGit.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
          const gitRoot = path.resolve(path.dirname(gitExe), '..')
          cands.push(path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe'))
        }
      }
      cands.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe')
      for (const cand of cands) {
        if (!existsSync(cand)) continue
        const probe = spawnSync(cand, ['-c', 'printf ok'], { encoding: 'utf8', timeout: 4000 })
        if (probe.status === 0 && probe.stdout === 'ok') {
          bashBin = cand
          break
        }
      }
    } else {
      const probe = spawnSync('bash', ['-c', 'printf ok'], { encoding: 'utf8', timeout: 4000 })
      if (probe.status === 0 && probe.stdout === 'ok') bashBin = 'bash'
    }

    if (!bashBin) {
      return
    }

    const syntaxRes = spawnSync(bashBin, ['-n', INSTALL_SH], { encoding: 'utf8', timeout: 8000 })
    eq(syntaxRes.status, 0, 'bash -n 语法检查失败：' + (syntaxRes.stderr || syntaxRes.stdout))

    const fakeShHome = path.join(tmpRoot, 'dsh-sh-dry')
    const fakeShProf = path.join(fakeShHome, 'profiles', 'desktop')
    const fakeShPkg = path.join(fakeShProf, 'package.json')
    const fakeShWs = path.join(fakeShProf, 'pnpm-workspace.yaml')
    const initPkg = JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {} }, null, 2) + '\n'
    await fsp.mkdir(fakeShProf, { recursive: true })
    await fsp.writeFile(fakeShPkg, initPkg, 'utf8')
    await fsp.writeFile(fakeShWs, 'packages:\n  - .\n', 'utf8')

    const run = spawnSync(bashBin, [INSTALL_SH, '--dry-run', '--dsh-home', fakeShHome, '--version', 'v1.1.0'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        DSH_HOME: fakeShHome,
        DSH_PAPER_WORKBENCH_DATA: path.join(tmpRoot, 'data-sh-dry'),
      },
    })
    eq(run.status, 0, String(run.stderr || run.stdout))
    ok(/dry-run/i.test(run.stdout), 'install.sh --dry-run 应输出 dry-run 预览信息')
    eq(readFileSync(fakeShPkg, 'utf8'), initPkg, 'install.sh --dry-run 不应修改 package.json')
    ok(!existsSync(fakeShPkg + '.bak'), 'install.sh --dry-run 不应创建 .bak')
    ok(!existsSync(path.join(fakeShHome, 'plugins')), 'install.sh --dry-run 不应创建 plugins 目录')
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
