#!/usr/bin/env node
// 仅使用临时 DSH_HOME、真实 tar 包和本地命令桩；绝不访问网络或真实文献库。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(path.join(os.tmpdir(), 'pb-release-safety-'))
process.env.DSH_PAPER_WORKBENCH_DATA = path.join(temp, 'data')
const bashCandidates = process.platform === 'win32'
  ? [...String(spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout || '').trim().split(/\r?\n/).map(p => path.resolve(path.dirname(p), '../bin/bash.exe')), 'C:/Program Files/Git/bin/bash.exe']
  : ['bash']
const bash = bashCandidates.find(bin => spawnSync(bin, ['-c', 'printf ok'], { encoding: 'utf8' }).stdout === 'ok')
assert.ok(bash, '回归需要可用的 Git Bash / bash')
const ps = ['pwsh', ...(process.platform === 'win32' ? ['powershell'] : [])].find(bin => spawnSync(bin, ['-NoProfile', '-Command', 'exit 0']).status === 0)
const slash = p => p.replace(/\\/g, '/')
const quote = p => `'${slash(p).replace(/'/g, `'\\''`)}'`
const shellPath = p => slash(p).replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`)
const psQuote = p => `'${p.replace(/'/g, "''")}'`
let passed = 0
let failed = 0
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
}
function run(bin, args, cwd, env = {}) {
  const result = spawnSync(bin, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 })
  if (result.error) throw result.error
  return { ...result, output: result.stdout + result.stderr }
}
function executable(file, text) { writeFileSync(file, text); chmodSync(file, 0o755) }
function stub(bin, name, source) {
  const js = path.join(bin, `${name}.cjs`)
  writeFileSync(js, source)
  executable(path.join(bin, name), `#!/usr/bin/env bash\nexec node ${quote(js)} "$@"\n`)
}
function fixture(name, version = '1.2.3') {
  const dir = path.join(temp, name)
  const home = path.join(dir, 'dsh')
  const bin = path.join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const pkg = path.join(home, 'profiles/desktop/package.json')
  mkdirSync(path.dirname(pkg), { recursive: true })
  writeFileSync(pkg, '{"name":"fixture-profile","private":true}\n')
  for (const dest of ['plugins/dsh-paper-workbench', 'profiles/desktop/node_modules/dsh-paper-workbench']) {
    mkdirSync(path.join(home, dest), { recursive: true })
    writeFileSync(path.join(home, dest, 'keep.txt'), '旧版本必须保留')
  }
  const src = path.join(dir, 'src/package')
  mkdirSync(src, { recursive: true })
  writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'dsh-paper-workbench', version }))
  writeFileSync(path.join(src, 'payload.txt'), 'fixture'.repeat(1000))
  // 随机数据避免小包被 PowerShell 安装器的最小下载长度检查误拒绝。
  writeFileSync(path.join(src, 'padding.bin'), Buffer.from(Array.from({ length: 2048 }, () => Math.random() * 256)))
  const archive = path.join(dir, 'fixture.tgz')
  const tar = run(bash, ['-c', 'tar -czf fixture.tgz -C src package'], dir)
  assert.equal(tar.status, 0, tar.output)
  const log = path.join(dir, 'commands.jsonl')
  const env = { PB_FIXTURE: archive, PB_LOG: log, PB_MODE: 'ok', DSH_HOME: home, DSH_PAPER_WORKBENCH_DATA: path.join(dir, 'data'), NPM_CONFIG_USERCONFIG: path.join(dir, 'npmrc'), npm_config_userconfig: path.join(dir, 'npmrc') }
  stub(bin, 'curl', `const fs=require('node:fs'); const a=process.argv.slice(2); const u=a.at(-1); fs.appendFileSync(process.env.PB_LOG,JSON.stringify(a)+'\\n'); if(u.includes('/releases/latest')) { console.log(JSON.stringify({tag_name:'v1.2.3'})); process.exit(0) } if(process.env.PB_MODE==='missing'&&!u.includes('/heads/main')) process.exit(22); fs.copyFileSync(process.env.PB_FIXTURE,a[a.indexOf('-o')+1]);`)
  stub(bin, 'dsh', `require('node:fs').appendFileSync(process.env.PB_LOG,'"DSH CLI SHOULD NOT RUN"\\n'); process.exit(0)`)
  return { dir, home, bin, pkg, archive, log, env, original: readFileSync(pkg, 'utf8') }
}
function unchanged(f) {
  assert.equal(readFileSync(f.pkg, 'utf8'), f.original, '拒绝安装时 profile 必须保持原样')
  for (const dest of ['plugins/dsh-paper-workbench', 'profiles/desktop/node_modules/dsh-paper-workbench']) {
    assert.equal(readFileSync(path.join(f.home, dest, 'keep.txt'), 'utf8'), '旧版本必须保留')
  }
}
function install(kind, f, { version = 'v1.2.3', mode = 'ok', profile = 'desktop' } = {}) {
  const env = { ...f.env, PB_MODE: mode }
  if (kind === 'bash') {
    const args = [path.join(root, 'scripts/install.sh'), '--dsh-home', slash(f.home), '--profile', profile, '--skip-py-install', ...(version ? ['--version', version] : [])]
    return run(bash, ['-c', `export PATH=${quote(shellPath(f.bin))}:$PATH; [ "$(command -v curl)" = ${quote(shellPath(path.join(f.bin, 'curl')))} ] || exit 97; exec bash "$@"`, 'fixture', ...args], root, env)
  }
  const wrapper = path.join(f.dir, 'invoke.ps1')
  writeFileSync(wrapper, `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\nfunction Invoke-RestMethod { @{tag_name='v1.2.3'} }\nfunction Invoke-WebRequest { param($Uri,$OutFile,$Headers,[switch]$UseBasicParsing,$TimeoutSec) Add-Content -LiteralPath $env:PB_LOG -Value $Uri; if ($env:PB_MODE -eq 'missing' -and $Uri -notlike '*/heads/main') { throw 'fixture download unavailable' }; Copy-Item -LiteralPath $env:PB_FIXTURE -Destination $OutFile }\nfunction dsh { Add-Content -LiteralPath $env:PB_LOG -Value 'DSH CLI SHOULD NOT RUN'; $global:LASTEXITCODE=0 }\n& ${psQuote(path.join(root, 'scripts/install.ps1'))} -DshHome ${psQuote(f.home)} -Profile ${profile} -SkipPyInstall ${version ? `-Version ${psQuote(version)}` : ''}\nexit $LASTEXITCODE\n`)
  return run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], root, env)
}

try {
  for (const kind of ['bash', ...(ps ? ['powershell'] : [])]) {
    check(`${kind}: 显式版本下载失败不回退 main，旧安装保持不变`, () => {
      const f = fixture(`${kind}-missing`)
      const result = install(kind, f, { mode: 'missing' })
      assert.notEqual(result.status, 0, result.output)
      unchanged(f)
      assert.doesNotMatch(readFileSync(f.log, 'utf8'), /heads\/main/, '不得请求 main')
    })
    check(`${kind}: 下载版本不匹配必须在替换文件前失败`, () => {
      const f = fixture(`${kind}-mismatch`, '9.9.9')
      const result = install(kind, f)
      assert.notEqual(result.status, 0, result.output)
      assert.match(result.output, /版本|version/i)
      unchanged(f)
    })
    check(`${kind}: v 前缀正常化后精确版本安装成功`, () => {
      const f = fixture(`${kind}-ok`, '1.2.3')
      const result = install(kind, f)
      assert.equal(result.status, 0, result.output)
      assert.equal(JSON.parse(readFileSync(path.join(f.home, 'plugins/dsh-paper-workbench/package.json'))).version, '1.2.3')
    })
    check(`${kind}: 无版本自动下载仍允许回退 main`, () => {
      const f = fixture(`${kind}-auto`, '9.9.9')
      const result = install(kind, f, { version: '', mode: 'missing' })
      assert.equal(result.status, 0, result.output)
      assert.match(readFileSync(f.log, 'utf8'), /heads\/main/)
    })
    check(`${kind}: 显式版本 web 安装同样先校验包版本`, () => {
      const f = fixture(`${kind}-web`, '9.9.9')
      const result = install(kind, f, { profile: 'web' })
      assert.notEqual(result.status, 0, result.output)
      assert.doesNotMatch(readFileSync(f.log, 'utf8'), /DSH CLI SHOULD NOT RUN/)
      unchanged(f)
    })
  }
  if (!ps) console.log('SKIP PowerShell 不可用；请在 Windows CI 运行 PowerShell 安装回归')

  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  function workflowRun(name) {
    const start = workflow.indexOf(`      - name: ${name}`)
    assert.ok(start >= 0, `缺少工作流步骤 ${name}`)
    const end = workflow.indexOf('\n      - name:', start + 1)
    const step = workflow.slice(start, end < 0 ? undefined : end)
    const script = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length)
    return script.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
  }
  const metadataScript = workflowRun('Resolve release metadata')
  function metadata(version, tag, event = 'workflow_dispatch') {
    const dir = mkdtempSync(path.join(temp, 'metadata-'))
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }))
    const script = path.join(dir, 'metadata.sh')
    const output = path.join(dir, 'output.txt')
    writeFileSync(script, metadataScript)
    const result = run(bash, ['-e', '-o', 'pipefail', script], dir, { GITHUB_OUTPUT: output, INPUT_TAG: tag, EVENT_NAME: event, REF_TYPE: 'tag', REF_NAME: tag })
    return { ...result, metadata: existsSync(output) ? readFileSync(output, 'utf8') : '' }
  }
  for (const [version, tag, event, rejected] of [
    ['1.2.3', '', 'workflow_dispatch', false],
    ['1.2.3-beta.1', 'v1.2.3-beta.1', 'push', false],
    ['1.2.3', 'v9.9.9', 'workflow_dispatch', true],
    ['1.2.3', 'v9.9.9', 'push', true],
    ['1.2.3', '1.2.3', 'workflow_dispatch', true],
  ]) check(`metadata: ${event} ${tag || '自动标签'} ${rejected ? '拒绝不匹配版本' : '输出正确版本'}`, () => {
    const result = metadata(version, tag, event)
    if (rejected) {
      assert.notEqual(result.status, 0, result.output)
      assert.equal(result.metadata, '', '失败时不得输出可供发布使用的 metadata')
    } else {
      assert.equal(result.status, 0, result.output)
      assert.match(result.metadata, new RegExp(`^tag=v${version.replaceAll('.', '\\.')}\\r?$`, 'm'))
      assert.match(result.metadata, new RegExp(`^prerelease=${version.includes('-')}\\r?$`, 'm'))
    }
  })
  const publishScript = workflowRun('Publish to npm with provenance (when NPM_TOKEN secret is configured)')
    .replaceAll('${{ steps.pack.outputs.tarball }}', 'fixture.tgz')
    .replaceAll('${{ steps.meta.outputs.version }}', '1.2.3')
    .replaceAll('${{ steps.meta.outputs.prerelease }}', 'false')
  function publish(mode, { prerelease = false, token = 'fixture-only-not-a-credential' } = {}) {
    const f = fixture(`npm-${mode}-${prerelease}-${token ? 'token' : 'none'}`)
    mkdirSync(path.join(f.dir, 'dist'))
    writeFileSync(path.join(f.dir, 'dist/fixture.tgz'), readFileSync(f.archive))
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(f.archive)).digest('base64')
    stub(f.bin, 'npm', `const fs=require('node:fs'); const a=process.argv.slice(2); fs.appendFileSync(process.env.PB_LOG,JSON.stringify(a)+'\\n'); if(a[0]==='view') { if(process.env.PB_MODE==='missing') { console.log(JSON.stringify({error:{code:'E404'}})); process.exit(1) } if(process.env.PB_MODE==='auth'||process.env.PB_MODE==='network') { console.error(JSON.stringify({error:{code:process.env.PB_MODE==='auth'?'E401':'ECONNRESET',summary:'E404 appears only in explanatory text'}})); process.exit(1) } if(process.env.PB_MODE==='malformed') { console.log('not-json'); process.exit(0) } if(process.env.PB_MODE==='empty') process.exit(0); console.log(JSON.stringify(process.env.PB_MODE==='same'?process.env.PB_INTEGRITY:'sha512-wrong')); }`)
    const preload = path.join(f.dir, 'npm-stub.cjs')
    // Windows Node 无法直接 spawn 无扩展名的 shell 桩；将 npm 进程路由到同一个可执行 Node 桩。
    writeFileSync(preload, `const cp=require('node:child_process'); const original=cp.spawnSync; cp.spawnSync=function(command,args,options){ if(command==='npm') return original(process.execPath,[${JSON.stringify(path.join(f.bin, 'npm.cjs'))},...args],options); return original(command,args,options) };`)
    const script = path.join(f.dir, 'publish.sh')
    writeFileSync(script, publishScript)
    const result = run(bash, ['-e', '-o', 'pipefail', '-c', `export PATH=${quote(shellPath(f.bin))}:$PATH; [ "$(command -v npm)" = ${quote(shellPath(path.join(f.bin, 'npm')))} ] || exit 97; source ${quote(script)}`], f.dir, { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, PB_MODE: mode, PB_INTEGRITY: integrity, NPM_TOKEN: token, NODE_AUTH_TOKEN: token, RELEASE_VERSION: '1.2.3', RELEASE_PRERELEASE: String(prerelease), RELEASE_TARBALL: 'fixture.tgz' })
    return { ...result, log: existsSync(f.log) ? readFileSync(f.log, 'utf8') : '' }
  }
  for (const prerelease of [false, true]) check(`npm: E404 才发布，${prerelease ? '预发布 next' : '稳定版 latest'}`, () => {
    const result = publish('missing', { prerelease })
    assert.equal(result.status, 0, result.output)
    const args = result.log.trim().split('\n').map(JSON.parse).find(a => a[0] === 'publish')
    assert.ok(args, result.log)
    assert.equal(args[args.indexOf('--tag') + 1], prerelease ? 'next' : 'latest')
  })
  check('npm: 已存在且 integrity 相同才跳过发布', () => {
    const result = publish('same')
    assert.equal(result.status, 0, result.output)
    assert.doesNotMatch(result.log, /"publish"/)
  })
  for (const mode of ['different', 'auth', 'network', 'malformed', 'empty']) check(`npm: ${mode} 必须失败且不发布`, () => {
    const result = publish(mode)
    assert.notEqual(result.status, 0, result.output)
    assert.doesNotMatch(result.log, /"publish"/)
  })
  check('npm: token 缺失明确说明跳过，且不运行 npm', () => {
    const result = publish('missing', { token: '' })
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /NPM_TOKEN/)
    assert.match(result.output, /跳过|skip/i)
    assert.equal(result.log, '')
  })
} finally {
  rmSync(temp, { recursive: true, force: true })
}
console.log(`\n发布安全回归：${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
