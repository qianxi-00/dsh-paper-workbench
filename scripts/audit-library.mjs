#!/usr/bin/env node
/**
 * 默认只读、离线全库检查；stdout 始终为 JSON。不会调用云端解析/OCR。
 * node scripts/audit-library.mjs --data=<库目录> [--id=<id>] [--rebuild]
 * --rebuild 的逐篇备份及可恢复进度位于 <库>/.library-audit/，失败不删除历史 revision。
 */
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createLayoutArchive, fingerprintPdf } from '../lib/layout-archive.js'
import { qualitySummary } from '../lib/layout-ir.js'
import { LAYOUT_BUILD, LAYOUT_VERSION } from '../lib/layout.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/
const HASH = /^[a-f0-9]{64}$/
const args = process.argv.slice(2)
const options = { data: process.env.DSH_PAPER_WORKBENCH_DATA || path.join(os.homedir(), '.dsh', 'paper-workbench'), ids: [], rebuild: false }
let argumentError = ''
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if ((arg === '--data' || arg === '--id') && (!args[i + 1] || args[i + 1].startsWith('--'))) { argumentError = '参数缺少值：' + arg; break }
  if (arg === '--rebuild') options.rebuild = true
  else if (arg === '--help' || arg === '-h') options.help = true
  else if (arg === '--data') options.data = args[++i]
  else if (arg.startsWith('--data=')) options.data = arg.slice(7)
  else if (arg === '--id') options.ids.push(args[++i])
  else if (arg.startsWith('--id=')) options.ids.push(arg.slice(5))
  else { argumentError = '未知参数：' + arg; break }
}
const data = path.resolve(options.data || '')
process.env.DSH_PAPER_WORKBENCH_DATA = data
const { DOC_VERSION, buildDoc, buildLayoutDoc, outlineFingerprint, writeRebuiltDoc } = await import('../lib/doc.js')
const store = await import('../lib/store.js')
const paperFile = (id, name) => {
  if (!ID.test(id)) throw new Error('非法的论文 id：' + id)
  return path.join(data, 'papers', id, name)
}
const archive = createLayoutArchive({ store: { paperFile } })
async function read(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
const names = async dir => fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error })
const coverage = (values, total) => {
  const represented = [...new Set(values)].sort((a, b) => a - b)
  const missing = Array.from({ length: total }, (_, i) => i + 1).filter(n => !represented.includes(n))
  const invalid = values.filter(n => !Number.isSafeInteger(n) || n < 1 || n > total)
  return { expected: total, represented, missing, invalid, complete: total > 0 && missing.length === 0 && invalid.length === 0 }
}
async function sha1(file) {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function pdfCommand(file, action = 'info') {
  // lib/pdf.findPython() 读取配置时会 ensureDirs；审计走同一 Python CLI，避免隐式写入。
  const config = await read(path.join(data, 'config.json'), {})
  const candidates = [...new Set([process.env.DSH_PAPER_PYTHON, process.env.PYTHON, config.python, process.platform === 'win32' ? 'python' : 'python3', 'python'].filter(Boolean))]
  for (const command of candidates) {
    const result = spawnSync(command, [path.join(HERE, '..', 'assets', 'pdf_tool.py'), action], { input: JSON.stringify({ path: file }), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    if (result.status === 0) {
      const value = JSON.parse(result.stdout)
      if (value.ok && (action !== 'info' || Number.isSafeInteger(value.pages) && value.pages > 0)) return value
    }
  }
  throw new Error('无法离线读取 PDF 页数；请设置 DSH_PAPER_PYTHON 为安装了 PyMuPDF 的解释器')
}
async function auditPaper(id, indexed = {}) {
  const issues = []
  const add = (code, state = 'invalid', detail = '') => issues.push({ code, state, detail })
  const load = async (name, fallback = null) => {
    try { return await read(paperFile(id, name), fallback) }
    catch (error) { add('invalid-' + name, 'invalid', error.message); return fallback }
  }
  const storedMeta = await load('meta.json')
  const meta = storedMeta || indexed
  if (!storedMeta) add('missing-meta', 'missing')
  const pdf = { exists: false }
  for (const file of [paperFile(id, 'paper.pdf'), meta.srcPath && path.resolve(meta.srcPath)].filter(Boolean)) {
    const stat = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!stat?.isFile() || stat.size === 0) continue
    pdf.exists = true
    try {
      // PyMuPDF 也能识别非 PDF 格式；先确认来源确实是 PDF。
      const handle = await fs.open(file, 'r')
      try {
        const header = Buffer.alloc(1024)
        const { bytesRead } = await handle.read(header, 0, header.length, 0)
        if (!header.subarray(0, bytesRead).includes('%PDF-')) throw new Error('来源文件不是有效的 PDF，请补齐原件')
      } finally { await handle.close() }
      Object.assign(pdf, await fingerprintPdf(file), { sha1: await sha1(file), pages: (await pdfCommand(file)).pages })
    } catch (error) { add('invalid-pdf', 'invalid', error.message) }
    break
  }
  if (!pdf.exists) add('missing-pdf', 'missing')
  let layout = null
  try { layout = await archive.readPublished(id) } catch (error) { add('invalid-current-revision', 'invalid', error.message) }
  const pointer = await load('layout-data/current.json')
  const rawFiles = (await names(paperFile(id, 'layout-data/raw'))).filter(name => HASH.test(name.slice(0, -6)) && name.endsWith('.jsonl'))
  const revisions = (await names(paperFile(id, 'layout-data/revisions'))).filter(name => name.endsWith('.json'))
  const raw = { files: rawFiles.length, verified: [], errors: [] }
  const refs = [...new Set((layout?.pages || []).map(p => p.rawRef?.hash).filter(Boolean))]
  for (const hash of refs.length ? refs : rawFiles.map(name => name.slice(0, -6))) {
    try { await archive.readRaw(id, { hash }); raw.verified.push(hash) }
    catch (error) { raw.errors.push({ hash, error: error.message }); add('invalid-raw', 'invalid', hash + ': ' + error.message) }
  }
  if (!rawFiles.length) add('missing-raw', 'missing')
  const total = pdf.pages || Number(meta.pageCount) || layout?.pageCount || 0
  const layoutReport = { exists: Boolean(layout), schemaVersion: layout?.schemaVersion ?? null, build: layout?.build ?? null, revision: layout?.revision ?? null,
    current: pointer, revisions: revisions.length, raw, coverage: coverage((layout?.pages || []).map(p => p.n), total), quality: layout?.quality?.status || null }
  if (!layout) add('missing-layout', 'missing')
  else {
    if (layout.version !== LAYOUT_VERSION || layout.schemaVersion !== 2 || layout.build !== LAYOUT_BUILD) add('old-layout-build', 'stale')
    if (!layoutReport.coverage.complete || layout.pages.length !== total || layout.pageCount !== total || layout.pages.some(p => p.status === 'failed')) add('incomplete-layout-pages', 'invalid')
    if (pdf.sha256 && layout.source?.sha256 !== pdf.sha256) add('layout-pdf-mismatch', 'stale')
    if (pointer?.revision && pointer.sourceHash !== layout.source?.sha256) add('pointer-source-mismatch', 'invalid')
    if (!['passed', 'needs_review'].includes(layout.quality?.status)) add('invalid-layout-quality', 'invalid')
  }
  const doc = await load('doc.json')
  const docReport = { exists: Boolean(doc), source: doc?.source || null, version: doc?.version ?? null, revision: doc?.revision ?? null,
    coverage: coverage((doc?.paragraphs || []).map(p => p.page), total) }
  if (!doc) add('missing-doc', 'missing')
  else {
    if (doc.version !== DOC_VERSION || !['layout', 'pdf-text', 'ocr', 'synthetic'].includes(doc.source)) add('old-doc-version', 'stale')
    if (doc.parserBuild !== LAYOUT_BUILD) add('old-doc-parser', 'stale')
    if (doc.pdf?.sha1 && pdf.sha1 && doc.pdf.sha1 !== pdf.sha1) add('doc-pdf-mismatch', 'stale')
    if (doc.outlineHash !== outlineFingerprint(meta.outline)) add('old-doc-outline', 'stale')
    if (layout && (doc.source !== 'layout' || (doc.revision || null) !== (layout.revision || null) || doc.layoutBuild !== LAYOUT_BUILD)) add('old-doc-layout', 'stale')
    if (!Array.isArray(doc.paragraphs) || !doc.paragraphs.length || !Array.isArray(doc.sections)) add('invalid-doc-structure', 'invalid')
    if (!docReport.coverage.complete) add('doc-page-coverage-gap', 'informational', '跨页段落/纯图页也可能没有起始段落；缺页需对原页检查')
  }
  const quality = qualitySummary(layout?.quality?.issues || [])
  const status = ['invalid', 'missing', 'stale'].find(state => issues.some(i => i.state === state)) || (layout?.quality?.status === 'needs_review' ? 'needs_review' : 'complete')
  return { id, title: meta.title || '', status, pdf, layout: layoutReport, doc: docReport, issues, quality }
}
async function discover() {
  const indexed = await read(path.join(data, 'index.json'), { papers: [] })
  const records = new Map((indexed.papers || []).filter(p => ID.test(p.id)).map(p => [p.id, p]))
  const dirs = await fs.readdir(path.join(data, 'papers'), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  for (const dir of dirs) if (dir.isDirectory() && ID.test(dir.name) && !records.has(dir.name)) records.set(dir.name, { id: dir.name })
  for (const id of options.ids) {
    if (!ID.test(id)) throw new Error('非法的论文 id：' + id)
    if (!records.has(id)) records.set(id, { id })
  }
  return [...records].filter(([id]) => !options.ids.length || options.ids.includes(id)).sort(([a], [b]) => a.localeCompare(b))
}
const WORK = path.join(data, '.library-audit')
const MANIFEST = path.join(WORK, 'manifest.json')
const MUTABLE = ['layout-data/current.json', 'layout.json', 'doc.json', 'meta.json']
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex')
async function atomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try { await fs.writeFile(temp, bytes); await fs.rename(temp, file) }
  finally { await fs.rm(temp, { force: true }).catch(() => {}) }
}
const saveManifest = value => atomic(MANIFEST, JSON.stringify(value, null, 2) + '\n')
async function assertContained(file) {
  const root = await fs.realpath(data)
  let probe = path.resolve(file)
  while (true) {
    try {
      const resolved = await fs.realpath(probe)
      if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('路径越出所选库目录，拒绝重建：' + file)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(probe)
      if (parent === probe) throw error
      probe = parent
    }
  }
}
async function assertPaperScope(id) {
  for (const name of ['', 'layout-data', 'layout-data/raw', 'layout-data/revisions', 'layout-data/inputs', 'layout-data/legacy', ...MUTABLE]) await assertContained(paperFile(id, name))
  await assertContained(path.join(WORK, 'backups'))
}
async function backup(id) {
  await assertPaperScope(id)
  const dir = path.join('backups', randomUUID(), id), files = {}
  for (const name of MUTABLE) {
    const bytes = await fs.readFile(paperFile(id, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    files[name] = bytes === null ? { exists: false } : { exists: true, sha256: bytesHash(bytes) }
    if (bytes !== null) await atomic(path.join(WORK, dir, name), bytes)
  }
  return { dir, files, annotations: await store.readAnnotations(id) }
}
async function restore(id, saved) {
  await assertPaperScope(id)
  const dir = path.resolve(WORK, saved?.dir || '')
  if (!dir.startsWith(path.join(WORK, 'backups') + path.sep) || !saved?.files) throw new Error('恢复备份路径不合法，拒绝修改数据')
  await assertContained(dir)
  const buffers = new Map()
  for (const name of MUTABLE) {
    const file = saved.files[name]
    if (typeof file?.exists !== 'boolean') throw new Error('恢复清单不完整：' + name)
    const bytes = file.exists ? await fs.readFile(path.join(dir, name)) : null
    if (bytes !== null && bytesHash(bytes) !== file.sha256) throw new Error('恢复备份 hash 校验失败：' + name)
    buffers.set(name, bytes)
  }
  // 先校验全部备份，再恢复权威指针；历史 raw/revision 只增不删。
  for (const name of [...MUTABLE].reverse()) {
    const bytes = buffers.get(name)
    if (bytes === null) await fs.rm(paperFile(id, name), { force: true })
    else await atomic(paperFile(id, name), bytes)
  }
  if (Array.isArray(saved.annotations) && saved.annotations.length) await store.saveAnnotations(id, saved.annotations)
}
async function takeLock() {
  await assertContained(WORK)
  await fs.mkdir(WORK, { recursive: true })
  const file = path.join(WORK, 'lock.json')
  try { const handle = await fs.open(file, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close() }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const previous = await read(file)
    if (!Number.isSafeInteger(previous?.pid) || previous.pid <= 0) throw new Error('审计写锁损坏，请人工检查 .library-audit/lock.json')
    try { process.kill(previous.pid, 0); throw new Error('另一进程仍在重建文库：' + previous.pid) }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe }
    await fs.rm(file)
    return takeLock()
  }
  return () => fs.rm(file, { force: true })
}
async function rebuildPaper(paper, manifest) {
  const previous = manifest.papers[paper.id]
  const needsLayout = !paper.layout.exists || paper.layout.build !== LAYOUT_BUILD || paper.layout.schemaVersion !== 2 || !paper.layout.coverage.complete
  const needsDoc = !paper.doc.exists || paper.issues.some(i => /doc/.test(i.code) && i.state !== 'informational')
  let blocked = ''
  if (!paper.pdf.sha256) blocked = '原 PDF 缺失或无法校验，无法安全关联 raw'
  else if (paper.issues.some(i => i.code === 'layout-pdf-mismatch')) blocked = 'PDF 内容已改变，旧 raw 不能用于新 PDF；需云端重新解析'
  else if (!paper.layout.exists || paper.layout.schemaVersion !== 2) blocked = '缺少 schemaVersion 2 几何页证据，现有离线重建器不支持；需云端解析'
  else if (!paper.layout.raw.verified.length && !paper.layout.raw.errors.length) blocked = '缺少可校验的 raw，需云端重新解析，未执行任何云端请求'
  else if (!paper.layout.raw.files) blocked = '缺少 raw 文件，需云端重新解析，未执行任何云端请求'
  if (blocked) {
    const operation = { status: 'needs-cloud', reason: blocked, attempts: previous?.attempts || 0 }
    if (needsDoc && paper.pdf.sha256) {
      operation.status = 'running'
      operation.attempts += 1
      operation.backup = await backup(paper.id)
      manifest.papers[paper.id] = operation
      await saveManifest(manifest)
      try {
        const meta = await read(paperFile(paper.id, 'meta.json'), { id: paper.id })
        let text = await read(paperFile(paper.id, 'text.json')).catch(() => null)
        if (!text?.source || text.source.size !== paper.pdf.size || Math.round(text.source.mtimeMs) !== Math.round(paper.pdf.mtimeMs)) text = await pdfCommand(paper.pdf.path, 'text')
        const doc = buildDoc({ meta, text, outline: meta.outline || [], pdf: { path: paper.pdf.path, sha1: paper.pdf.sha1, bytes: paper.pdf.size, mtimeMs: paper.pdf.mtimeMs } })
        if (doc.source !== 'pdf-text' || doc.degraded || !doc.paragraphs.length) throw new Error('本地文本不足以建立文档；保留旧数据，未请求 OCR')
        if ((await fingerprintPdf(paper.pdf.path)).sha256 !== paper.pdf.sha256) throw new Error('补文档期间 PDF 已变化')
        await writeRebuiltDoc(paper.id, await store.readDoc(paper.id), doc)
        Object.assign(operation, { status: 'needs-cloud', docRebuilt: true, finishedAt: new Date().toISOString() })
        await saveManifest(manifest)
        return { ...await auditPaper(paper.id, meta), operation }
      } catch (error) {
        operation.error = error.message
        try { await restore(paper.id, operation.backup); operation.status = 'needs-cloud'; operation.rolledBack = true }
        catch (rollback) { operation.status = 'recovery-required'; operation.rollbackError = rollback.message }
      }
    }
    manifest.papers[paper.id] = { ...previous, ...operation, at: new Date().toISOString() }
    await saveManifest(manifest)
    return { ...paper, operation }
  }
  if (!needsLayout && !needsDoc) {
    if (!previous) {
      manifest.papers[paper.id] = { status: 'already-current', attempts: 0, at: new Date().toISOString() }
      await saveManifest(manifest)
    }
    return { ...paper, operation: { status: 'already-current' } }
  }
  const operation = { status: 'running', attempts: (previous?.attempts || 0) + 1, at: new Date().toISOString(), backup: await backup(paper.id) }
  manifest.papers[paper.id] = operation
  await saveManifest(manifest)
  try {
    if (paper.layout.raw.errors.length) throw new Error('raw 归档损坏，拒绝离线重建')
    if (needsLayout) {
      const result = spawnSync(process.execPath, [path.join(HERE, 'quality', 'rebuild-layout.mjs'), paper.id, '--data=' + data, '--apply'], { encoding: 'utf8', env: { ...process.env, DSH_PAPER_WORKBENCH_DATA: data, PYTHONUTF8: '1' }, timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
      if (result.status !== 0) throw new Error('离线重建失败：' + (result.stderr || result.error?.message || result.stdout || result.signal).trim())
    }
    const layout = await archive.readPublished(paper.id)
    const meta = await read(paperFile(paper.id, 'meta.json'))
    const currentSource = await fingerprintPdf(paper.pdf.path)
    if (currentSource.sha256 !== paper.pdf.sha256) throw new Error('重建期间 PDF 已变化，已停止发布文档')
    const doc = buildLayoutDoc({ layout, meta, pdf: { path: paper.pdf.path, sha1: paper.pdf.sha1, bytes: currentSource.size, mtimeMs: currentSource.mtimeMs } })
    if (!doc.paragraphs.length) throw new Error('重建文档没有正文段落，保留旧文档')
    await writeRebuiltDoc(paper.id, await store.readDoc(paper.id), doc)
    const after = await auditPaper(paper.id, meta)
    if (after.issues.some(i => i.state === 'invalid' || i.state === 'stale' || i.code === 'missing-doc')) throw new Error('重建后检查未通过：' + after.issues.map(i => i.code).join(', '))
    Object.assign(operation, { status: 'succeeded', revision: layout.revision, finishedAt: new Date().toISOString() })
    await saveManifest(manifest)
    return { ...after, operation }
  } catch (error) {
    operation.status = 'failed'
    operation.error = error.message
    try { await restore(paper.id, operation.backup); operation.rolledBack = true }
    catch (rollback) { operation.status = 'recovery-required'; operation.rollbackError = rollback.message }
    await saveManifest(manifest)
    return { ...paper, operation }
  }
}
async function main() {
  if (argumentError || !String(options.data || '').trim()) throw new Error(argumentError || '参数中的库目录不能为空')
  if (options.help) { console.log('用法：node scripts/audit-library.mjs --data=<目录> [--id=<id>] [--rebuild]；默认只读，始终离线。重建前请停止文库并发写入；进度和恢复备份位于 .library-audit。'); return }
  const papers = [], records = await discover()
  let release, manifest
  try {
    if (options.rebuild) {
      release = await takeLock()
      manifest = await read(MANIFEST, { version: 1, data, papers: {} })
      if (manifest.version !== 1 || manifest.data !== data || !manifest.papers || typeof manifest.papers !== 'object') throw new Error('审计进度清单不兼容，请检查 .library-audit/manifest.json')
    }
    for (const [id, meta] of records) {
      const pending = manifest?.papers[id]
      try {
        if (pending && ['running', 'recovery-required'].includes(pending.status)) {
          await restore(id, pending.backup)
          Object.assign(pending, { status: 'recovered', recoveredAt: new Date().toISOString() })
          await saveManifest(manifest)
        }
        const paper = await auditPaper(id, meta)
        papers.push(options.rebuild ? await rebuildPaper(paper, manifest) : paper)
      } catch (error) {
        const operation = { ...pending, status: pending && ['running', 'recovery-required'].includes(pending.status) ? 'recovery-required' : 'failed', attempts: pending?.attempts || 1, error: error.message }
        if (manifest) { manifest.papers[id] = operation; await saveManifest(manifest) }
        papers.push({ id, title: meta.title || '', status: 'invalid', issues: [{ code: 'paper-io-failure', state: 'invalid', detail: error.message }], quality: { blocking: 0, informational: 0 }, ...(manifest ? { operation } : {}) })
      }
    }
  } finally { if (release) await release() }
  const summary = { total: papers.length, states: {}, quality: { blocking: 0, informational: 0 }, findings: { blocking: 0, informational: 0 } }
  for (const paper of papers) {
    summary.states[paper.status] = (summary.states[paper.status] || 0) + 1
    summary.quality.blocking += paper.quality.blocking
    summary.quality.informational += paper.quality.informational
    for (const issue of paper.issues) summary.findings[issue.state === 'informational' ? 'informational' : 'blocking'] += 1
  }
  if (options.rebuild) {
    summary.operations = {}
    for (const paper of papers) summary.operations[paper.operation.status] = (summary.operations[paper.operation.status] || 0) + 1
    if (papers.some(p => ['failed', 'recovery-required', 'needs-cloud'].includes(p.operation.status))) process.exitCode = 1
  }
  console.log(JSON.stringify({ mode: options.rebuild ? 'rebuild' : 'audit', network: 'disabled', data, ...(options.rebuild ? { manifest: MANIFEST } : {}), expected: { layoutBuild: LAYOUT_BUILD, layoutVersion: LAYOUT_VERSION, docVersion: DOC_VERSION }, papers, summary }, null, 2))
}
main().catch(error => { console.log(JSON.stringify({ error: error.message, network: 'disabled' })); process.exitCode = 1 }).finally(() => store.closeDb())
