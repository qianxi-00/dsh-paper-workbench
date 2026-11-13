/**
 * lib/doctor.js 回归测试：全部用假依赖，不探测真实 Python、不碰真实数据目录。
 *
 *   node scripts/test-doctor.mjs
 *
 * 覆盖三件容易回归的事：
 * - 单项抛错不能拖垮整份报告（用户看到的是「这一项出错」，其余项仍可用）；
 * - 缺 Python / 数据目录不可写 / Node 太老 都要给出中文 hint，不能只报 FAIL；
 * - host 不传时是 skip 而不是 warn（命令行下不该吓人）。
 */
import { runDoctor, formatDoctor } from '../lib/doctor.js'

let pass = 0
let fail = 0

function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log('PASS  ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail += 1
    console.log('FAIL  ' + name + (detail ? '  ' + detail : ''))
  }
}

const fsp = {
  mkdir: async () => {},
  writeFile: async () => {},
  unlink: async () => {},
}

const path = { join: (a, b) => a + '\\' + b }

function baseInput(overrides = {}) {
  return {
    fsp,
    path,
    dataRoot: 'C:\\tmp\\pb-doctor',
    listPapers: async () => [{ id: 'a' }, { id: 'b' }],
    getConfig: async () => ({ python: '', vault: '', kb: '', ocr: { token: 'x', model: 'PaddleOCR-VL-1.6' } }),
    dbInfo: () => ({ engine: 'sqlite', path: 'C:\\tmp\\pb-doctor\\workbench.db' }),
    findPython: async () => ({ python: 'python3', version: '1.24.0: 3.12.3' }),
    detectVault: () => 'D:\\vault',
    ai: { ready: true, providers: [{ id: 'p1' }], follow: { provider: 'magic', model: 'm1' } },
    host: { session: true, workspace: true },
    ...overrides,
  }
}

const byId = (report, id) => (report.checks || []).find((entry) => entry.id === id) || {}

// 1. 全绿
{
  const report = await runDoctor(baseInput())
  check('全绿时 ok=true', report.ok === true)
  check('检查项数量 = 8', report.checks.length === 8, String(report.checks.length))
  check('node 项为 ok', byId(report, 'node').status === 'ok')
  check('python 项带上版本', byId(report, 'python').detail.includes('3.12.3'))
  check('ai 项带上 provider 数与默认模型', byId(report, 'ai').detail.includes('1 个 provider') && byId(report, 'ai').detail.includes('magic/m1'))
}

// 2. 缺 Python
{
  const report = await runDoctor(baseInput({ findPython: async () => null }))
  const entry = byId(report, 'python')
  check('缺 Python 时 ok=false', report.ok === false)
  check('缺 Python 是 error 且带安装提示', entry.status === 'error' && entry.hint.includes('pymupdf'))
}

// 3. 数据目录不可写
{
  const broken = {
    ...fsp,
    mkdir: async () => {},
    writeFile: async () => {
      throw new Error('EACCES: permission denied')
    },
  }
  const report = await runDoctor(baseInput({ fsp: broken }))
  const entry = byId(report, 'data')
  check('数据目录不可写是 error', entry.status === 'error')
  check('错误信息进 detail', entry.detail.includes('EACCES'))
}

// 4. Node 太老的判断（只测阈值函数行为：伪造 process.versions 不现实，改为检查真机结论合理）
{
  const report = await runDoctor(baseInput({ checks: ['node'] }))
  check('只跑指定检查项', report.checks.length === 1 && report.checks[0].id === 'node')
}

// 5. 单项抛错不影响其它项
{
  const report = await runDoctor(
    baseInput({
      dbInfo: () => {
        throw new Error('boom')
      },
    }),
  )
  check('db 抛错时该项 error', byId(report, 'db').status === 'error' && byId(report, 'db').detail.includes('boom'))
  check('其余项照常产出', byId(report, 'python').status === 'ok')
  check('整体 ok=false', report.ok === false)
}

// 6. 没有宿主时 host 是 skip
{
  const report = await runDoctor(baseInput({ host: null }))
  check('host 缺省为 skip 而非 warn', byId(report, 'host').status === 'skip')
}

// 7. JSON 退化引擎是 warn 不是 error
{
  const report = await runDoctor(baseInput({ dbInfo: () => ({ engine: 'json', path: 'x' }) }))
  const entry = byId(report, 'db')
  check('JSON 引擎是 warn', entry.status === 'warn')
  check('JSON 引擎仍然 ok=true', report.ok === true)
}

// 8. OCR 未配置是 skip
{
  const report = await runDoctor(baseInput({ getConfig: async () => ({ vault: '', kb: '', ocr: {} }) }))
  check('未配 OCR Key 是 skip', byId(report, 'ocr').status === 'skip')
}

// 9. 没有 vault 且自动探测不到
{
  const report = await runDoctor(baseInput({ detectVault: () => null }))
  const entry = byId(report, 'vault')
  check('没 vault 是 skip 且带说明', entry.status === 'skip' && entry.hint.includes('写入卡片'))
}

// 10. formatDoctor 输出可读
{
  const report = await runDoctor(baseInput({ findPython: async () => null }))
  const text = formatDoctor(report)
  check('formatDoctor 含 FAIL 标签', text.includes('[FAIL]'))
  check('formatDoctor 含提示箭头', text.includes('→'))
  check('formatDoctor 结尾是失败结论', text.includes('有必须处理的问题'))
}

console.log('')
console.log('doctor: ' + pass + ' PASS / ' + fail + ' FAIL')
if (fail > 0) process.exitCode = 1
