/**
 * 环境自检：把「装上就能用」需要的东西一次性探一遍，给出可操作的提示。
 *
 * 为什么单独一个模块：新用户第一次打开工作台，最常见的三个卡点是
 *   1) 没装 Python/PyMuPDF → 页图与段落模型都不可用，界面只显示降级提示；
 *   2) Node 太老（< 22.5）→ node:sqlite 不可用，译文退化成 JSON；
 *   3) 数据目录不可写 / 没配模型 → 保存失败或翻译直接报错。
 * 这三件事都能自动判断，不该让用户去翻文档猜。
 *
 * 设计：纯依赖注入（默认懒加载兄弟模块），不 import 任何第三方包；
 * 单项失败不影响其它项；绝不抛错（doctor 自己坏了就报一项 error）。
 */

const DEFAULT_CHECKS = ['node', 'data', 'db', 'python', 'vault', 'ai', 'host', 'ocr']

const checksById = {
  node: checkNode,
  data: checkData,
  db: checkDb,
  python: checkPython,
  vault: checkVault,
  ai: checkAi,
  host: checkHost,
  ocr: checkOcr,
}

/** 一项检查的结论。status: ok | warn | error | skip */
function item(id, label, status, detail, hint) {
  return { id, label, status, detail: String(detail == null ? '' : detail), hint: hint || '' }
}

function errorText(error) {
  if (!error) return ''
  return String(error.message || error).slice(0, 300)
}

async function checkNode() {
  const raw = String(process.versions.node || '0.0.0')
  const [major, minor] = raw.split('.').map((value) => Number(value) || 0)
  const ok = major > 22 || (major === 22 && minor >= 5)
  if (ok) return item('node', 'Node.js', 'ok', 'v' + raw)
  return item(
    'node',
    'Node.js',
    'warn',
    'v' + raw + '（低于 22.5，没有内置 node:sqlite）',
    '译文会退化成 JSON 文件存储；升级 DSH 桌面端/Node 到 22.5+ 即可用 SQLite。',
  )
}

async function checkData(runtime) {
  const fsp = runtime.fsp
  const root = runtime.dataRoot
  try {
    await fsp.mkdir(root, { recursive: true })
    const probe = runtime.path.join(root, '.doctor-probe')
    await fsp.writeFile(probe, 'ok')
    await fsp.unlink(probe)
    let papers = 0
    try {
      papers = (await runtime.listPapers()).length
    } catch {
      /* 库还没建，算 0 */
    }
    return item('data', '数据目录', 'ok', root + '（' + papers + ' 篇）')
  } catch (error) {
    return item('data', '数据目录', 'error', root + '：' + errorText(error), '确认目录存在且有写权限，或用 DSH_PAPER_WORKBENCH_DATA 指到别处。')
  }
}

async function checkDb(runtime) {
  try {
    const info = await runtime.dbInfo()
    const engine = String((info && info.engine) || 'unknown')
    const path = String((info && info.path) || runtime.dbPath || '')
    if (engine === 'sqlite') return item('db', '存储引擎', 'ok', 'SQLite · ' + path)
    if (engine === 'json') {
      return item('db', '存储引擎', 'warn', 'JSON 退化实现 · ' + path, '当前 Node 没有可用的 node:sqlite（或设了 PB_DB_ENGINE=json）；功能不受影响，只是没有事务与索引。')
    }
    return item('db', '存储引擎', 'warn', engine, '打开库失败时会自动退化，详细原因看任务日志。')
  } catch (error) {
    return item('db', '存储引擎', 'error', errorText(error), '删掉 workbench.db 可以让插件重建（会丢译文，先备份）。')
  }
}

async function checkPython(runtime) {
  try {
    const found = await runtime.findPython(true)
    if (found) return item('python', 'Python + PyMuPDF', 'ok', found.python + ' · ' + found.version)
    return item(
      'python',
      'Python + PyMuPDF',
      'error',
      '没找到能 import fitz 的解释器',
      '装一个 Python 3.10+ 再 pip install pymupdf；或在工作台设置里填解释器路径（也可用 DSH_PAPER_PYTHON）。装好后点「重新检测」。',
    )
  } catch (error) {
    return item('python', 'Python + PyMuPDF', 'error', errorText(error), '重新检测即可；仍失败就把解释器路径写进设置。')
  }
}

async function checkVault(runtime) {
  try {
    const config = await runtime.getConfig()
    const wanted = String(config.vault || '').trim()
    if (wanted) {
      const kb = String(config.kb || '').trim()
      return item('vault', 'Obsidian 知识库', 'ok', kb ? wanted + ' / ' + kb : wanted)
    }
    const detected = runtime.detectVault()
    if (detected) {
      return item('vault', 'Obsidian 知识库', 'ok', detected + '（自动探测）')
    }
    return item('vault', 'Obsidian 知识库', 'skip', '没找到 Obsidian 库', '只影响「写入卡片」与卡片页；其它功能照常。可在设置里手动指定 vault 路径。')
  } catch (error) {
    return item('vault', 'Obsidian 知识库', 'skip', errorText(error), '可选功能，不影响阅读与翻译。')
  }
}

async function checkAi(runtime) {
  const ai = runtime.ai || null
  if (!ai) return item('ai', '模型', 'skip', '宿主没提供模型服务（开发服务器可加 --mock-llm）', '在 DSH 里配好 provider 后重开插件。')
  if (ai.ready) {
    const providers = Array.isArray(ai.providers) ? ai.providers.length : 0
    const follow = ai.follow || {}
    const followText = follow.provider ? follow.provider + '/' + (follow.model || 'default') : '跟随当前会话'
    return item('ai', '模型', 'ok', providers + ' 个 provider · 默认 ' + followText)
  }
  return item('ai', '模型', 'warn', '没有可用的 provider', '在 DSH 设置里登录/配置一个模型 provider，然后重开插件。')
}

async function checkHost(runtime) {
  if (!runtime.host) {
    return item('host', 'DSH 宿主能力', 'skip', '命令行下不检查（不在 DSH 里运行）', '在 DSH 里打开工作台后，这一项会显示原生会话与工作区是否可用。')
  }
  const host = runtime.host
  const parts = []
  parts.push(host.session ? '原生会话可用' : '原生会话不可用（退回本地对话）')
  parts.push(host.workspace ? '工作区可用' : '工作区不可用（会话按 cwd 归属）')
  const status = host.session ? 'ok' : 'warn'
  return item('host', 'DSH 宿主能力', status, parts.join(' · '), host.session ? '' : '讲解/对话仍能用「本地」模式；要落进真实会话请用桌面端的完整 DSH。')
}

async function checkOcr(runtime) {
  const config = await runtime.getConfig().catch(() => ({}))
  const ocr = (config && config.ocr) || {}
  if (ocr.token) return item('ocr', '扫描件 OCR', 'ok', String(ocr.model || 'PaddleOCR-VL-1.6') + ' · Key 已配置')
  return item('ocr', '扫描件 OCR', 'skip', '没配 PaddleOCR Key', '只影响扫描件；文本层正常的 PDF 不需要它。设置 → 扫描件 OCR 可填 Key。')
}

async function buildRuntime(input) {
  const store = input.store || (await import('./store.js'))
  const fsp = input.fsp || (await import('node:fs/promises')).default
  const path = input.path || (await import('node:path')).default
  const runtime = {
    fsp,
    path,
    dataRoot: input.dataRoot || store.DATA_ROOT,
    dbPath: input.dbPath || '',
    listPapers: input.listPapers || store.listPapers,
    getConfig: input.getConfig || store.getConfig,
    detectVault: input.detectVault || null,
    dbInfo: input.dbInfo || null,
    findPython: input.findPython || null,
    ai: input.ai || null,
    host: input.host || null,
  }
  if (!runtime.dbInfo) {
    const db = await import('./db.js').catch(() => null)
    runtime.dbInfo = db ? db.dbInfo : async () => ({ engine: 'unavailable', path: '' })
  }
  if (!runtime.detectVault) {
    const obsidian = await import('./obsidian.js').catch(() => null)
    runtime.detectVault = obsidian ? obsidian.detectVault : () => null
  }
  if (!runtime.findPython) {
    const pdf = await import('./pdf.js').catch(() => null)
    runtime.findPython = pdf ? pdf.findPython : async () => null
  }
  return runtime
}

/**
 * 跑环境自检。
 * @param {object} input 可覆盖任意依赖：{ store, dbInfo, findPython, detectVault, ai, host, dataRoot, checks }
 * @returns {Promise<{ok:boolean, at:string, checks:Array<{id,label,status,detail,hint}>}>}
 */
export async function runDoctor(input = {}) {
  const checks = []
  let runtime = null
  try {
    runtime = await buildRuntime(input)
  } catch (error) {
    return {
      ok: false,
      at: new Date().toISOString(),
      checks: [item('runtime', '自检运行环境', 'error', errorText(error), '插件内部模块加载失败，重开插件试试。')],
    }
  }
  const wanted = Array.isArray(input.checks) && input.checks.length ? input.checks : DEFAULT_CHECKS
  for (const id of wanted) {
    const fn = checksById[id]
    if (!fn) continue
    try {
      checks.push(await fn(runtime))
    } catch (error) {
      checks.push(item(id, id, 'error', errorText(error), '这一项自检本身出错了，其余项仍可参考。'))
    }
  }
  const ok = checks.every((entry) => entry.status !== 'error')
  return { ok, at: new Date().toISOString(), checks }
}

const LABELS = { ok: ' ok ', warn: 'warn', error: 'FAIL', skip: 'skip' }

/** 把自检结果排成终端友好的纯文本（CLI 与日志共用）。 */
export function formatDoctor(report) {
  const lines = []
  for (const entry of (report && report.checks) || []) {
    const tag = LABELS[entry.status] || entry.status
    lines.push('[' + tag + '] ' + entry.label + '：' + entry.detail)
    if (entry.hint) lines.push('        → ' + entry.hint)
  }
  lines.push('')
  lines.push(report && report.ok ? '环境自检通过。' : '有必须处理的问题，见上面的 FAIL 项。')
  return lines.join('\n')
}
