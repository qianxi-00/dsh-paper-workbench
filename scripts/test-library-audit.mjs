/** Public CLI artifacts only; PDFs, raw archives, manifests and backups all live in temp. */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-library-audit-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root
process.env.PYTHONUTF8 = '1'
const { findPython } = await import('../lib/pdf.js')
const { createLayoutArchive, fingerprintPdf } = await import('../lib/layout-archive.js')
const { buildDocumentLayout } = await import('../lib/layout-ir.js')
const { LAYOUT_BUILD } = await import('../lib/layout.js')
const { buildLayoutDoc } = await import('../lib/doc.js')
const python = (await findPython()).python
const cli = fileURLToPath(new URL('./audit-library.mjs', import.meta.url))
after(async () => { await fs.rm(root, { recursive: true, force: true }) })
const json = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n') }
const digest = value => createHash('sha256').update(value).digest('hex')
async function snapshot(dir, prefix = '') {
  const result = []
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(prefix, entry.name), file = path.join(dir, entry.name)
    const stat = await fs.stat(file)
    result.push([name, entry.isDirectory() ? 'directory' : digest(await fs.readFile(file)), stat.mtimeMs])
    if (entry.isDirectory()) result.push(...await snapshot(file, name))
  }
  return result
}
async function fixture(name, build = 'ir-old') {
  const data = path.join(root, name), id = 'paper-one', dir = path.join(data, 'papers', id)
  await fs.mkdir(dir, { recursive: true })
  const pdfPath = path.join(dir, 'paper.pdf')
  const made = spawnSync(python, ['-c', 'import fitz,sys; d=fitz.open(); p=d.new_page(width=400,height=600); p.insert_text((40,100),"Preserved offline evidence.",fontsize=10); d.save(sys.argv[1]); d.close()', pdfPath], { encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const meta = { id, title: 'Offline fixture', pageCount: 1, hasText: true }
  await json(path.join(dir, 'meta.json'), meta)
  await json(path.join(data, 'index.json'), { version: 1, papers: [meta] })
  const source = await fingerprintPdf(pdfPath)
  const store = { paperFile: (paperId, file) => path.join(data, 'papers', paperId, file) }
  const archive = createLayoutArchive({ store })
  const servicePage = { page_index: 0, width: 400, height: 600, parsing_res_list: [{ block_id: 1, block_label: 'text', block_content: 'Preserved offline evidence.', block_bbox: [35, 80, 360, 120] }] }
  const raw = await archive.saveRaw(id, JSON.stringify({ result: { layoutParsingResults: [servicePage] } }) + '\n')
  const layout = buildDocumentLayout({ source, pageCount: 1, pageSizes: [{ n: 1, w: 400, h: 600 }],
    servicePages: [{ n: 1, width: 400, height: 600, rawRef: raw, blocks: servicePage.parsing_res_list }],
    pdfPages: [{ page: 1, width: 400, height: 600, lines: [{ text: 'Preserved offline evidence.', x: 40, y: 89, x2: 180, y2: 103 }] }] })
  layout.pages.forEach(page => { page.rawRef = raw })
  layout.build = build
  layout.revision = 'original-' + name
  layout.quality = { status: 'needs_review', issues: [{ code: 'text-conflict', page: 1 }, { code: 'unverified-model-text', page: 1 }] }
  await archive.publish(id, layout, { rawRefs: [raw] })
  await json(path.join(dir, 'doc.json'), buildLayoutDoc({ layout, meta, pdf: { path: pdfPath, bytes: source.size, mtimeMs: source.mtimeMs, sha1: createHash('sha1').update(await fs.readFile(pdfPath)).digest('hex') } }))
  return { data, id, dir, archive, source, raw, layout }
}
function run(data, ...args) {
  const result = spawnSync(process.execPath, [cli, '--data=' + data, ...args], { encoding: 'utf8', env: { ...process.env, DSH_PAPER_PYTHON: python }, timeout: 120000 })
  assert.equal(result.signal, null, result.stderr)
  let report
  try { report = JSON.parse(result.stdout) } catch { assert.fail('审计 CLI 应返回 JSON：' + result.stderr + result.stdout) }
  return { ...result, report }
}

test('offline rebuild backs up current/doc/meta, publishes raw-derived IR and resumes idempotently', async () => {
  const item = await fixture('rebuild')
  const oldMeta = await fs.readFile(path.join(item.dir, 'meta.json'), 'utf8')
  const oldDoc = await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8')
  const first = run(item.data, '--rebuild')
  assert.equal(first.status, 0, first.stdout)
  assert.equal(first.report.papers[0].operation.status, 'succeeded')
  const current = await item.archive.readPublished(item.id)
  assert.equal(current.build, LAYOUT_BUILD)
  assert.notEqual(current.revision, item.layout.revision)
  assert.ok(current.blocks.some(b => b.text === 'Preserved offline evidence.'))
  const doc = JSON.parse(await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8'))
  assert.equal(doc.revision, current.revision)
  assert.equal(doc.source, 'layout')
  const manifestFile = path.join(item.data, '.library-audit', 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  const entry = manifest.papers[item.id]
  assert.equal(entry.status, 'succeeded')
  assert.equal(entry.attempts, 1)
  assert.equal(await fs.readFile(path.join(item.data, '.library-audit', entry.backup.dir, 'doc.json'), 'utf8'), oldDoc)
  assert.equal(await fs.readFile(path.join(item.data, '.library-audit', entry.backup.dir, 'meta.json'), 'utf8'), oldMeta)
  assert.equal(await fs.readFile(path.join(item.dir, 'meta.json'), 'utf8'), oldMeta)
  assert.equal((await item.archive.readRevision(item.id, item.layout.revision)).revision, item.layout.revision)
  const before = await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8')
  const second = run(item.data, '--rebuild')
  assert.equal(second.status, 0, second.stdout)
  assert.equal(second.report.papers[0].operation.status, 'already-current')
  assert.equal((await item.archive.readPublished(item.id)).revision, current.revision)
  assert.equal(await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8'), before)
  assert.equal(JSON.parse(await fs.readFile(manifestFile, 'utf8')).papers[item.id].attempts, 1)
})

test('missing raw is explicitly needs-cloud and preserves all paper artifacts', async () => {
  const item = await fixture('no-raw')
  await fs.rm(path.join(item.dir, 'layout-data', 'raw', item.raw.hash + '.jsonl'))
  const before = await snapshot(item.dir)
  const result = run(item.data, '--rebuild')
  assert.equal(result.status, 1)
  assert.equal(result.report.papers[0].operation.status, 'needs-cloud')
  assert.deepEqual(await snapshot(item.dir), before)
  assert.equal((await item.archive.readPublished(item.id)).revision, item.layout.revision)
})

test('raw parse failure is recorded and retry can resume after evidence is repaired', async () => {
  const item = await fixture('broken-raw')
  const raw = await item.archive.saveRaw(item.id, '{"unsupported":true}\n')
  const broken = { ...item.layout, pages: item.layout.pages.map(p => ({ ...p, rawRef: raw })) }
  await json(path.join(item.dir, 'layout-data', 'revisions', item.layout.revision + '.json'), broken)
  const before = await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8')
  const result = run(item.data, '--rebuild')
  assert.equal(result.status, 1)
  assert.equal(result.report.papers[0].operation.status, 'failed')
  assert.equal(result.report.papers[0].operation.rolledBack, true)
  assert.equal(await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8'), before)
  assert.equal((await item.archive.readPublished(item.id)).revision, item.layout.revision)
  await json(path.join(item.dir, 'layout-data', 'revisions', item.layout.revision + '.json'), item.layout)
  const resumed = run(item.data, '--rebuild')
  assert.equal(resumed.status, 0, resumed.stdout)
  assert.equal(resumed.report.papers[0].operation.attempts, 2)
})

test('interrupted publication restores checked backups before retrying', async () => {
  const item = await fixture('interrupted')
  const first = run(item.data, '--rebuild')
  assert.equal(first.status, 0, first.stdout)
  const file = path.join(item.data, '.library-audit', 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
  manifest.papers[item.id].status = 'running'
  await json(file, manifest)
  await fs.writeFile(path.join(item.dir, 'doc.json'), 'interrupted write')
  const next = run(item.data, '--rebuild')
  assert.equal(next.status, 0, next.stdout)
  assert.equal(next.report.papers[0].operation.attempts, 2)
  const doc = JSON.parse(await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8'))
  assert.equal(doc.revision, (await item.archive.readPublished(item.id)).revision)
})

test('missing layout/raw still gains a local PDF-text doc without claiming layout completion', async () => {
  const item = await fixture('local-doc')
  await fs.rm(path.join(item.dir, 'layout-data'), { recursive: true })
  await fs.rm(path.join(item.dir, 'layout.json'))
  await fs.rm(path.join(item.dir, 'doc.json'))
  const result = run(item.data, '--rebuild')
  assert.equal(result.status, 1)
  const paper = result.report.papers[0]
  assert.equal(paper.operation.status, 'needs-cloud')
  assert.equal(paper.operation.docRebuilt, true)
  assert.equal(paper.layout.exists, false)
  const doc = JSON.parse(await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8'))
  assert.equal(doc.source, 'pdf-text')
  assert.equal(doc.parserBuild, LAYOUT_BUILD)
  assert.ok(doc.paragraphs.some(p => p.text === 'Preserved offline evidence.'))
  assert.equal(await fs.stat(path.join(item.dir, 'layout.json')).catch(() => null), null)
})

test('corrupt raw keeps old pointer and doc and records a failed repair', async () => {
  const item = await fixture('corrupt-raw')
  await fs.writeFile(path.join(item.dir, 'layout-data', 'raw', item.raw.hash + '.jsonl'), 'corrupt bytes')
  const before = await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8')
  const result = run(item.data, '--rebuild')
  assert.equal(result.status, 1)
  assert.equal(result.report.papers[0].operation.status, 'failed')
  assert.equal((await item.archive.readPublished(item.id)).revision, item.layout.revision)
  assert.equal(await fs.readFile(path.join(item.dir, 'doc.json'), 'utf8'), before)
})

test('rebuild refuses a paper directory junction escaping the selected data root', async () => {
  const item = await fixture('junction')
  const outside = path.join(root, 'outside-paper')
  await fs.rename(item.dir, outside)
  await fs.symlink(outside, item.dir, process.platform === 'win32' ? 'junction' : 'dir')
  const before = await snapshot(outside)
  const result = run(item.data, '--rebuild')
  assert.equal(result.status, 1)
  assert.match(JSON.stringify(result.report), /库目录|越界|范围/)
  assert.deepEqual(await snapshot(outside), before)
})

test('PDF changes are stale and never reuse raw for different source bytes', async () => {
  const item = await fixture('pdf-changed')
  await fs.appendFile(path.join(item.dir, 'paper.pdf'), '\n% changed source\n')
  const result = run(item.data)
  assert.ok(result.report.papers[0].issues.some(i => i.code === 'layout-pdf-mismatch'))
  const next = run(item.data, '--rebuild')
  assert.equal(next.status, 1)
  assert.equal(next.report.papers[0].operation.status, 'needs-cloud')
  assert.equal((await item.archive.readPublished(item.id)).revision, item.layout.revision)
})

test('a per-paper backup failure is journaled and does not abort other papers', async () => {
  const item = await fixture('mixed-failure')
  const bad = path.join(item.data, 'papers', 'paper-bad')
  await fs.cp(item.dir, bad, { recursive: true })
  await json(path.join(bad, 'meta.json'), { id: 'paper-bad', title: 'Bad cache', pageCount: 1 })
  await fs.rm(path.join(bad, 'doc.json'))
  await fs.mkdir(path.join(bad, 'doc.json'))
  const result = run(item.data, '--rebuild')
  assert.equal(result.status, 1)
  assert.equal(result.report.papers.length, 2)
  assert.equal(result.report.papers.find(p => p.id === 'paper-bad').operation.status, 'failed')
  assert.equal(result.report.papers.find(p => p.id === item.id).operation.status, 'succeeded')
  const manifest = JSON.parse(await fs.readFile(path.join(item.data, '.library-audit', 'manifest.json'), 'utf8'))
  assert.equal(manifest.papers['paper-bad'].status, 'failed')
  assert.equal(manifest.papers[item.id].status, 'succeeded')
})

test('an explicitly selected unknown id is reported missing without writes', async () => {
  const item = await fixture('unknown-id')
  const before = await snapshot(item.data)
  const result = run(item.data, '--id=not-present')
  assert.equal(result.status, 0)
  assert.equal(result.report.papers.length, 1)
  assert.equal(result.report.papers[0].status, 'missing')
  assert.deepEqual(await snapshot(item.data), before)
})

test('missing CLI option values fail before any data write', async () => {
  const item = await fixture('invalid-option')
  const before = await snapshot(item.data)
  const result = run(item.data, '--data')
  assert.equal(result.status, 1)
  assert.match(result.report.error, /参数|目录/)
  assert.deepEqual(await snapshot(item.data), before)
})

test('a non-PDF source is reported as invalid rather than a missing Python interpreter', async () => {
  const item = await fixture('invalid-pdf')
  await fs.writeFile(path.join(item.dir, 'paper.pdf'), '<html>Download unavailable</html>')
  const { status, report } = run(item.data)
  assert.equal(status, 0)
  const issue = report.papers[0].issues.find(i => i.code === 'invalid-pdf')
  assert.match(issue?.detail, /不是有效的 PDF/)
  assert.doesNotMatch(issue.detail, /解释器/)
})

test('default audit is byte/mtime read-only and separates stale from complete needs_review', async () => {
  const current = await fixture('readonly', LAYOUT_BUILD)
  const before = await snapshot(current.data)
  const { status, report } = run(current.data)
  assert.equal(status, 0)
  assert.deepEqual(await snapshot(current.data), before)
  assert.equal(report.mode, 'audit')
  assert.equal(report.network, 'disabled')
  assert.equal(report.papers[0].status, 'needs_review')
  assert.equal(report.papers[0].layout.coverage.complete, true)
  assert.equal(report.summary.quality.blocking, 1)
  assert.equal(report.summary.quality.informational, 1)
  const old = await fixture('stale')
  assert.equal(run(old.data).report.papers[0].status, 'stale')
})
