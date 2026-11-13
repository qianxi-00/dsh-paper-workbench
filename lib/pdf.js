/**
 * PDF 能力桥：把 Python(PyMuPDF) 当成一个"命令行协处理器"。
 *
 * 为什么用子进程而不是纯 JS：
 *   - DSH 是 Windows 桌面端，chokidar/pdfjs 之外没有现成的 PDF 取字/渲页依赖；
 *   - 本机 Anaconda 已带 PyMuPDF，取文本 + 取坐标 + 渲页是一条命令的事；
 *   - 子进程坏了只会降级（改走浏览器原生 PDF 查看器），不会拖垮插件。
 *
 * 协议：python assets/pdf_tool.py <command> < payload.json > {"ok":true,...}
 */
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getConfig } from './store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
export const TOOL = path.join(ROOT, 'assets', 'pdf_tool.py')

const IS_WIN = process.platform === 'win32'

/**
 * 解释器候选顺序：环境变量 → 设置里填的路径 → 常见命令名。
 * 跨平台：macOS/Linux 上没有 `python`（只有 `python3`），Windows 上 `py` 是官方启动器。
 * `F:\ProGramApp\Anaconda\python.exe` 只是本机开发者的习惯路径，别的机器上探测失败会自动跳过。
 */
const CANDIDATES = [
  process.env.DSH_PAPER_PYTHON,
  process.env.PYTHON,
  IS_WIN ? 'F:\\ProGramApp\\Anaconda\\python.exe' : null,
  IS_WIN ? 'py' : 'python3',
  'python',
  'python3',
].filter((value, index, list) => Boolean(value) && list.indexOf(value) === index)

/** 探测失败的结果只缓存 30 秒：用户刚 pip install 完不用重启插件。 */
const MISS_TTL_MS = 30 * 1000
let pythonCache = null // { at, value }
let pythonInflight = null


function run(command, args, { input = '', timeoutMs = 60000, maxBytes = 96 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const out = []
    const err = []
    let size = 0
    let done = false
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
        /* 已经退出 */
      }
      finish({ code: -1, stdout: Buffer.concat(out).toString('utf8'), stderr: '超时 ' + timeoutMs + 'ms' })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        finish({ code: -2, stdout: '', stderr: '输出超过上限' })
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => finish({ code: -3, stdout: '', stderr: error.message }))
    child.on('close', (code) => finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }))

    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** 探测一个解释器能否 import fitz；能就返回它。 */
async function probe(command) {
  const result = await run(command, ['-c', 'import fitz,sys;print(fitz.__doc__.split()[1], sys.version.split()[0])'], {
    timeoutMs: 20000,
  })
  if (result.code === 0) return { python: command, version: result.stdout.trim() }
  return null
}

/** 结果缓存：探测一次要 ~200ms，不值得每个请求都探；失败结果只缓存 30 秒。 */
export function findPython(force = false) {
  const now = Date.now()
  if (!force && pythonCache && (pythonCache.value !== null || now - pythonCache.at < MISS_TTL_MS)) {
    return Promise.resolve(pythonCache.value)
  }
  if (pythonInflight) return pythonInflight
  pythonInflight = (async () => {
    try {
      const configured = (await getConfig()).python
      const list = [configured, ...CANDIDATES].filter(Boolean)
      for (const candidate of list) {
        const found = await probe(candidate)
        if (found) {
          pythonCache = { at: Date.now(), value: found }
          return found
        }
      }
      pythonCache = { at: Date.now(), value: null }
      return null
    } finally {
      pythonInflight = null
    }
  })()
  return pythonInflight
}

/** 设置里换了 Python 路径后清掉缓存，下一次调用立刻重新探测。 */
export function resetPython() {
  pythonCache = null
}

/** 调一次 Python 工具；返回解析后的 JSON，失败抛中文错误。 */
export async function callTool(command, payload, options = {}) {
  const found = await findPython()
  if (!found) {
    throw new Error(
      '没找到可用的 Python + PyMuPDF。请安装 Python 依赖（pip install pymupdf），或在插件设置里指定 python 路径。',
    )
  }
  const result = await run(found.python, [TOOL, command], {
    input: JSON.stringify(payload || {}),
    timeoutMs: options.timeoutMs || 60000,
    maxBytes: options.maxBytes || 96 * 1024 * 1024,
  })
  const text = String(result.stdout || '').trim()
  let parsed = null
  if (text) {
    try {
      // 工具约定只输出一行 JSON；万一混了日志，取最后一行的 { 开头片段
      const line = text.slice(text.lastIndexOf('\n{') + 1)
      parsed = JSON.parse(line.startsWith('{') ? line : text)
    } catch {
      parsed = null
    }
  }
  if (parsed === null) {
    const detail = [result.stderr, text].filter(Boolean).join(' ').slice(0, 500)
    throw new Error('PDF 工具执行失败（' + command + '）：' + (detail || '退出码 ' + result.code))
  }
  if (parsed.ok === false) throw new Error(parsed.error || 'PDF 工具返回失败')
  return parsed
}

export async function info(pdfPath) {
  const value = await callTool('info', { path: pdfPath }, { timeoutMs: 30000 })
  return value
}

export async function extractText(pdfPath) {
  const value = await callTool('text', { path: pdfPath, pages: 'all' }, { timeoutMs: 120000, maxBytes: 192 * 1024 * 1024 })
  return value
}

export async function outline(pdfPath) {
  const value = await callTool('outline', { path: pdfPath }, { timeoutMs: 45000 })
  return value
}

export async function renderPage(pdfPath, page, outPath, scale = 2) {
  const value = await callTool(
    'render',
    { path: pdfPath, page, scale, out: outPath },
    { timeoutMs: 45000 },
  )
  return value
}

/** 读缓存文本；缓存按源 PDF 的 mtime+size 失效。 */
export async function loadText(meta, pdfPath, cacheRead, cacheWrite) {
  const stat = await fsp.stat(pdfPath)
  const cached = await cacheRead()
  if (cached && cached.source && cached.source.size === stat.size && cached.source.mtimeMs === stat.mtimeMs) {
    return cached
  }
  const value = await extractText(pdfPath)
  const next = { ...value, source: { path: pdfPath, size: stat.size, mtimeMs: stat.mtimeMs } }
  await cacheWrite(next)
  return next
}

/** 在已缓存的块里做大小写不敏感的全文检索，返回页码与命中块。 */
export function searchText(cached, query, limit = 60) {
  const needle = String(query || '').toLowerCase().trim()
  if (!needle) return []
  const hits = []
  for (const page of cached.pages || []) {
    for (const block of page.blocks || []) {
      const text = String(block.text || '')
      const at = text.toLowerCase().indexOf(needle)
      if (at < 0) continue
      hits.push({
        page: page.n,
        text: text.length > 240 ? text.slice(Math.max(0, at - 80), at + 160) + '…' : text,
        rect: { x: block.x, y: block.y, x2: block.x2, y2: block.y2 },
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
