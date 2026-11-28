#!/usr/bin/env node
/** PDF Node 桥生命周期回归：真实子进程 + 局部合成端点，不执行 PDF handlers。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-pdf-bridge-'))
const savedEnv = { ...process.env }
const pids = new Set()
let passed = 0
let failed = 0

// sitecustomize 在 Python 执行脚本前接管；os._exit 保证不会落到真实 pdf_tool.py。
const endpoint = `import json, os, sys, time
from pathlib import Path

if sys.argv[0] == '-c':
    identity = os.environ.get('PB_PDF_BRIDGE_ID') or Path(sys.executable).parent.name
    control_path = os.environ.get('PB_PDF_BRIDGE_PROBE_CONTROL')
    if control_path:
        control = json.loads(Path(control_path).read_text(encoding='utf-8'))
        if control.get('hold') == identity:
            ready = Path(control['ready'])
            release = Path(control['release'])
            ready.write_text(identity, encoding='utf-8')
            deadline = time.monotonic() + 10
            while not release.exists():
                if time.monotonic() >= deadline:
                    os._exit(91)
                time.sleep(0.01)
    print('SYNTHETIC-PDF-BRIDGE 1.0', flush=True)
    os._exit(0)
if Path(sys.argv[0]).name == 'pdf_tool.py':
    try:
        payload = json.load(sys.stdin)
        command = sys.argv[1]
        identity = os.environ.get('PB_PDF_BRIDGE_ID') or Path(sys.executable).parent.name
        Path(payload['ready']).write_text(json.dumps({'pid': os.getpid(), 'command': command}), encoding='utf-8')
        value = {'ok': True, 'value': 42, 'received': payload['value']}
        if command == 'identity':
            value = {'ok': True, 'identity': identity}
        if command == 'prefixed-json':
            print('Synthetic bridge diagnostic', flush=True)
        if command in ('protocol-error', 'protocol-exit7'):
            value = {'ok': False, 'error': '合成协议失败'}
        if command == 'malformed':
            print('{broken', flush=True)
        elif command == 'oversized':
            print('x' * 8192, flush=True)
        elif command not in ('empty-timeout', 'empty-exit7', 'abort'):
            print(json.dumps(value), flush=True)
        if command in ('json-timeout', 'empty-timeout', 'abort'):
            time.sleep(60)
        if command in ('json-exit7', 'protocol-exit7', 'empty-exit7'):
            os._exit(7)
        os._exit(0)
    except BaseException as error:
        print(str(error), file=sys.stderr, flush=True)
        os._exit(99)
`

function running(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function waitFor(read, description) {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    const value = await read()
    if (value) return value
    await delay(10)
  }
  assert.fail('等待超时：' + description)
}

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL  ' + name + '\n' + error.stack)
  }
}

try {
  // 每次运行独立数据根；在任何产品导入前设置，不使用用户的解释器/数据库配置。
  process.env.DSH_PAPER_WORKBENCH_DATA = path.join(root, 'data')
  process.env.PB_DB_PATH = path.join(root, 'data', 'workbench.json')
  process.env.PB_DB_ENGINE = 'json'
  process.env.PADDLE_OCR_TOKEN = ''
  const candidates = [savedEnv.DSH_PAPER_PYTHON, savedEnv.PYTHON, 'python3', 'python', 'py'].filter(Boolean)
  let python = ''
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
    if (probe.status === 0) { python = probe.stdout.trim(); break }
  }
  assert.ok(python, '生命周期回归需要本机 Python，不依赖 PyMuPDF')
  await fsp.writeFile(path.join(root, 'sitecustomize.py'), endpoint)
  process.env.DSH_PAPER_PYTHON = python
  process.env.PYTHONPATH = root
  process.env.PYTHONNOUSERSITE = '1'
  process.env.PYTHONUTF8 = '1'
  const store = await import('../lib/store.js')
  const { callTool, findPython, resetPython } = await import('../lib/pdf.js')

  const interpreterAliases = {}
  for (const identity of ['A', 'B']) {
    const aliasDir = path.join(root, 'interpreters', identity)
    await fsp.mkdir(path.dirname(aliasDir), { recursive: true })
    if (process.platform === 'win32') {
      await fsp.symlink(path.dirname(python), aliasDir, 'junction')
    } else {
      await fsp.mkdir(aliasDir, { recursive: true })
      await fsp.symlink(python, path.join(aliasDir, path.basename(python)))
    }
    interpreterAliases[identity] = path.join(aliasDir, path.basename(python))
  }

  await check('真实 findPython 必须命中局部合成端点', async () => {
    assert.deepEqual(await findPython(), { python, version: 'SYNTHETIC-PDF-BRIDGE 1.0' })
  })
  // 端点未接管时禁止继续，防止测试意外执行真实 PDF handlers。
  assert.equal((await findPython()).version, 'SYNTHETIC-PDF-BRIDGE 1.0')

  await check('idle 配置切换 + resetPython 应选择新解释器', async () => {
    const original = await store.getConfig()
    try {
      await store.setConfig({ python: interpreterAliases.A })
      resetPython()
      process.env.PB_PDF_BRIDGE_ID = 'A'
      assert.equal((await findPython()).python, interpreterAliases.A)
      await store.setConfig({ python: interpreterAliases.B })
      resetPython()
      process.env.PB_PDF_BRIDGE_ID = 'B'
      assert.equal((await findPython()).python, interpreterAliases.B)
    } finally {
      if (savedEnv.PB_PDF_BRIDGE_ID === undefined) delete process.env.PB_PDF_BRIDGE_ID
      else process.env.PB_PDF_BRIDGE_ID = savedEnv.PB_PDF_BRIDGE_ID
      await store.setConfig({ python: original.python })
      resetPython()
    }
  })

  await check('resetPython 后新探测隔离旧在途结果与缓存', async () => {
    const original = await store.getConfig()
    const controlPath = path.join(root, 'probe-control.json')
    const readyPath = path.join(root, 'probe-A-ready')
    const releasePath = path.join(root, 'probe-A-release')
    let old
    try {
      await store.setConfig({ python: interpreterAliases.A })
      resetPython()
      process.env.PB_PDF_BRIDGE_ID = 'A'
      await fsp.writeFile(controlPath, JSON.stringify({ hold: 'A', ready: readyPath, release: releasePath }))
      process.env.PB_PDF_BRIDGE_PROBE_CONTROL = controlPath

      old = findPython()
      await waitFor(async () => {
        try { return await fsp.readFile(readyPath, 'utf8') }
        catch (error) { if (error.code === 'ENOENT') return null; throw error }
      }, 'A 解释器探测进入受控门闩')

      await store.setConfig({ python: interpreterAliases.B })
      resetPython()
      process.env.PB_PDF_BRIDGE_ID = 'B'
      const next = findPython()
      assert.notStrictEqual(next, old, 'reset 后不能复用 A 的旧 Promise')
      assert.equal((await next).python, interpreterAliases.B)

      await fsp.writeFile(releasePath, 'release')
      assert.equal((await old).python, interpreterAliases.A)
      assert.equal((await findPython()).python, interpreterAliases.B, 'A 完成后不能覆盖 B 的缓存')
      assert.equal((await callTool('identity', {
        value: 17,
        ready: path.join(root, 'identity-tool.json'),
      })).identity, 'B', '后续工具调用必须消费 B')
    } finally {
      await fsp.writeFile(releasePath, 'release')
      if (old) await old.catch(() => {})
      delete process.env.PB_PDF_BRIDGE_PROBE_CONTROL
      if (savedEnv.PB_PDF_BRIDGE_ID === undefined) delete process.env.PB_PDF_BRIDGE_ID
      else process.env.PB_PDF_BRIDGE_ID = savedEnv.PB_PDF_BRIDGE_ID
      await store.setConfig({ python: original.python })
      resetPython()
    }
  })

  await check('同一配置代际的并发 findPython 仍合并为一个 Promise', async () => {
    const original = await store.getConfig()
    const controlPath = path.join(root, 'probe-control-concurrent.json')
    const readyPath = path.join(root, 'probe-B-concurrent-ready')
    const releasePath = path.join(root, 'probe-B-concurrent-release')
    let pending
    try {
      await store.setConfig({ python: interpreterAliases.B })
      resetPython()
      process.env.PB_PDF_BRIDGE_ID = 'B'
      await fsp.writeFile(controlPath, JSON.stringify({ hold: 'B', ready: readyPath, release: releasePath }))
      process.env.PB_PDF_BRIDGE_PROBE_CONTROL = controlPath

      pending = findPython()
      await waitFor(async () => {
        try { return await fsp.readFile(readyPath, 'utf8') }
        catch (error) { if (error.code === 'ENOENT') return null; throw error }
      }, 'B 并发探测进入受控门闩')
      assert.strictEqual(findPython(), pending, '同代调用应共享在途探测')
    } finally {
      await fsp.writeFile(releasePath, 'release')
      if (pending) await pending.catch(() => {})
      delete process.env.PB_PDF_BRIDGE_PROBE_CONTROL
      if (savedEnv.PB_PDF_BRIDGE_ID === undefined) delete process.env.PB_PDF_BRIDGE_ID
      else process.env.PB_PDF_BRIDGE_ID = savedEnv.PB_PDF_BRIDGE_ID
      await store.setConfig({ python: original.python })
      resetPython()
    }
  })

  async function request(command, options = {}, onReady) {
    const readyFile = path.join(root, command + '.json')
    // 立即安装拒绝处理器，避免等待 ready 时出现未处理的 rejection。
    const pending = callTool(command, { value: 17, ready: readyFile }, { timeoutMs: 1500, ...options })
      .then(value => ({ value }), error => ({ error }))
    const ready = await waitFor(async () => {
      try { return JSON.parse(await fsp.readFile(readyFile, 'utf8')) } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
        throw error
      }
    }, command + ' ready')
    assert.equal(ready.command, command)
    assert.ok(Number.isInteger(ready.pid) && ready.pid > 0)
    pids.add(ready.pid)
    if (onReady) onReady(ready)
    const result = await pending
    await waitFor(() => !running(ready.pid), command + ' 子进程退出')
    pids.delete(ready.pid)
    if (options.signal) assert.equal(getEventListeners(options.signal, 'abort').length, 0, '完成后移除 abort listener')
    console.log('OBSERVE ' + JSON.stringify({ command, pid: ready.pid, childExited: true,
      ...result.value && { value: result.value },
      ...result.error && { error: { name: result.error.name, message: result.error.message } },
    }))
    return result
  }

  await check('成功退出 + 有效 JSON：返回原数据且 stdin payload 完整传递', async () => {
    assert.deepEqual((await request('valid-json')).value, { ok: true, value: 42, received: 17 })
  })
  await check('成功退出 + 日志前缀：仍接受最后一行 JSON', async () => {
    assert.deepEqual((await request('prefixed-json')).value, { ok: true, value: 42, received: 17 })
  })
  for (const command of ['protocol-error', 'protocol-exit7']) {
    await check(command + '：保留 ok:false 的中文协议错误', async () => {
      assert.equal((await request(command)).error?.message, '合成协议失败')
    })
  }
  await check('畸形 JSON：抛中文执行失败', async () => {
    assert.match((await request('malformed')).error?.message || '', /PDF 工具执行失败.*broken/)
  })
  await check('成功 JSON 后挂起：超时必须失败，不能接受提前输出', async () => {
    assert.match((await request('json-timeout')).error?.message || '', /PDF 工具执行失败.*超时/)
  })
  await check('成功 JSON 后 exit7：非零退出必须失败', async () => {
    assert.match((await request('json-exit7')).error?.message || '', /PDF 工具执行失败/)
  })
  await check('无 stdout 超时：保留中文超时错误', async () => {
    assert.match((await request('empty-timeout')).error?.message || '', /超时/)
  })
  await check('无 stdout 的 exit7：保留退出码错误', async () => {
    assert.match((await request('empty-exit7')).error?.message || '', /退出码 7/)
  })
  await check('stdout 超限：拒绝且终止子进程', async () => {
    assert.match((await request('oversized', { maxBytes: 1024 })).error?.message || '', /输出超过上限/)
  })
  await check('运行期取消：ready 后 abort，传播原 AbortError 并清理 listener/子进程', async () => {
    const controller = new AbortController()
    const reason = new DOMException('合成运行期取消', 'AbortError')
    const result = await request('abort', { signal: controller.signal }, ({ pid }) => {
      assert.equal(running(pid), true, '取消前必须确实仍在运行')
      controller.abort(reason)
    })
    assert.equal(result.error, reason)
  })
  await check('预先取消：传播原原因且不启动请求子进程', async () => {
    const controller = new AbortController()
    controller.abort()
    const ready = path.join(root, 'pre-abort.json')
    await assert.rejects(callTool('valid-json', { value: 17, ready }, { signal: controller.signal }),
      error => error === controller.signal.reason && error.name === 'AbortError')
    await assert.rejects(fsp.stat(ready), { code: 'ENOENT' })
  })
} finally {
  for (const pid of pids) {
    if (running(pid)) process.kill(pid)
    await waitFor(() => !running(pid), '清理本测试子进程 ' + pid)
  }
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await fsp.rm(root, { recursive: true, force: true })
}
console.log(`\n${passed} PASS / ${failed} FAIL / 0 SKIP`)
if (failed) process.exitCode = 1
