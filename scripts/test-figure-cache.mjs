#!/usr/bin/env node
/** Generated PDFs only; assert real rendered pixels at listFigures / figurePath. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-figure-cache-'))
// Set every storage override before importing any production module.
process.env.DSH_PAPER_WORKBENCH_DATA = path.join(root, 'data')
process.env.PB_DB_PATH = path.join(root, 'test.db')
process.env.PADDLE_OCR_TOKEN = ''
process.env.PYTHONUTF8 = '1'
process.env.PYTHONIOENCODING = 'utf-8'
const python = process.env.DSH_PAPER_PYTHON || 'python'
const store = await import('../lib/store.js')
const figures = await import('../lib/figures.js')
const { LAYOUT_VERSION, LAYOUT_FILE } = await import('../lib/layout.js')

let passed = 0
let failed = 0
async function test(name, run) {
  try {
    await run()
    passed += 1
    console.log('PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name + ': ' + error.message)
  }
}

async function fixture(name) {
  const pdf = path.join(root, name + '.pdf')
  await exec(python, ['-c', `
import fitz, sys
with fitz.open() as doc:
    for left in [(1, 0, 0), (0, 1, 0)]:
        page = doc.new_page(width=400, height=300)
        page.draw_rect(fitz.Rect(40, 60, 140, 160), color=None, fill=left)
        page.draw_rect(fitz.Rect(220, 60, 320, 160), color=None, fill=(0, 0, 1))
    doc.save(sys.argv[1], expand=1)
`, pdf])
  await fsp.utimes(pdf, 1700000000, 1700000000)
  const { meta } = await store.addPaper({ title: name, srcPath: pdf })
  const stat = await fsp.stat(pdf)
  return { id: meta.id, pdf, source: { path: pdf, size: stat.size, mtimeMs: stat.mtimeMs } }
}

function region(x, page = 1) {
  return { page, kind: 'figure', bbox: { x, y: 60, width: 100, height: 100 } }
}

async function layout(item, boxes, at) {
  await store.writeJsonAtomic(store.paperFile(item.id, LAYOUT_FILE), {
    version: LAYOUT_VERSION, source: item.source, at, figures: boxes,
  })
  return figures.listFigures(item.id)
}

async function pixels(file) {
  const { stdout } = await exec(python, ['-c', `
import fitz, json, sys
p = fitz.Pixmap(sys.argv[1])
print(json.dumps({"width": p.width, "height": p.height, "center": p.pixel(p.width // 2, p.height // 2)}))
`, file])
  return JSON.parse(stdout)
}

async function expectColor(file, color) {
  assert.deepEqual(await pixels(file), { width: 200, height: 200, center: color })
}

try {
  await test('bbox-only revision returns the new blue crop', async () => {
    const item = await fixture('bbox')
    await layout(item, [region(40)], 'bbox-a')
    await expectColor(await figures.figurePath(item.id, 0), [255, 0, 0])
    await layout(item, [region(220)], 'bbox-b')
    await expectColor(await figures.figurePath(item.id, 0), [0, 0, 255])
  })
  await test('same layout timestamp cannot hide changed boxes', async () => {
    const item = await fixture('same-at')
    await layout(item, [region(40)], 'fixed-at')
    await expectColor(await figures.figurePath(item.id, 0), [255, 0, 0])
    await layout(item, [region(220)], 'fixed-at')
    await expectColor(await figures.figurePath(item.id, 0), [0, 0, 255])
  })
  await test('figure order changes select the matching rendered asset', async () => {
    const item = await fixture('order')
    await layout(item, [region(40), region(220)], 'order-a')
    const red = await figures.figurePath(item.id, 0)
    const blue = await figures.figurePath(item.id, 1)
    await expectColor(red, [255, 0, 0])
    await expectColor(blue, [0, 0, 255])
    await layout(item, [region(220), region(40)], 'order-b')
    await expectColor(await figures.figurePath(item.id, 0), [0, 0, 255])
    await expectColor(await figures.figurePath(item.id, 1), [255, 0, 0])
  })
  await test('page is part of the rendered asset identity', async () => {
    const item = await fixture('page')
    await layout(item, [region(40, 1)], 'page-a')
    await expectColor(await figures.figurePath(item.id, 0), [255, 0, 0])
    await layout(item, [region(40, 2)], 'page-b')
    await expectColor(await figures.figurePath(item.id, 0), [0, 255, 0])
  })
  await test('PDF content changes invalidate PNG even with identical size and mtime', async () => {
    const item = await fixture('content')
    await layout(item, [region(40)], 'content')
    const before = await figures.figurePath(item.id, 0)
    await expectColor(before, [255, 0, 0])
    // The generated stream is uncompressed: a same-length color replacement preserves size.
    const bytes = await fsp.readFile(item.pdf)
    const at = bytes.indexOf(Buffer.from('1 0 0 rg'))
    assert.ok(at >= 0, 'generated PDF must contain the red fill operator')
    Buffer.from('0 1 0 rg').copy(bytes, at)
    await fsp.writeFile(item.pdf, bytes)
    await fsp.utimes(item.pdf, 1700000000, 1700000000)
    const stat = await fsp.stat(item.pdf)
    assert.equal(stat.size, item.source.size)
    assert.equal(stat.mtimeMs, item.source.mtimeMs)
    const after = await figures.figurePath(item.id, 0)
    await expectColor(after, [0, 255, 0])
    assert.notEqual(after, before, 'content-addressed assets must not overwrite the old image')
    await expectColor(before, [255, 0, 0])
  })
  await test('legacy f0.png and stamp are rebuilt instead of trusted', async () => {
    const item = await fixture('legacy')
    await layout(item, [region(40)], 'legacy-a')
    const red = await figures.figurePath(item.id, 0)
    const dir = path.join(store.paperDir(item.id), '.figures')
    const legacy = path.join(dir, 'f0.png')
    await fsp.copyFile(red, legacy)
    const next = await layout(item, [region(220)], 'legacy-b')
    await store.writeJsonAtomic(path.join(dir, '.stamp'), {
      version: figures.FIGURES_VERSION, source: item.source,
      figures: next.map(row => [row.page, row.x, row.y, row.x2, row.y2]),
    })
    const current = await figures.figurePath(item.id, 0)
    await expectColor(current, [0, 0, 255])
    assert.notEqual(current, legacy)
    const stat = await fsp.stat(current)
    assert.equal(await figures.figurePath(item.id, 0), current)
    assert.equal((await fsp.stat(current)).mtimeMs, stat.mtimeMs, 'unchanged PNG is reused')
  })
  await test('concurrent cold requests all return complete matching PNGs', async () => {
    const item = await fixture('concurrent')
    await layout(item, [region(40)], 'concurrent')
    const outcomes = await Promise.allSettled(Array.from({ length: 16 }, async () => {
      const file = await figures.figurePath(item.id, 0)
      await expectColor(file, [255, 0, 0])
      return file
    }))
    assert.equal(outcomes.filter(row => row.status === 'rejected').length, 0,
      outcomes.filter(row => row.status === 'rejected').map(row => row.reason.message).join('\n'))
    assert.equal(new Set(outcomes.map(row => row.value)).size, 1)
  })
  await test('independent module instances publish the same complete PNG atomically', async () => {
    const item = await fixture('independent')
    await layout(item, [region(220)], 'independent')
    const instances = await Promise.all(Array.from({ length: 6 }, (_, i) => import('../lib/figures.js?cache-test=' + i)))
    const outcomes = await Promise.allSettled(instances.map(async instance => {
      const file = await instance.figurePath(item.id, 0)
      await expectColor(file, [0, 0, 255])
      return file
    }))
    assert.equal(outcomes.filter(row => row.status === 'rejected').length, 0,
      outcomes.filter(row => row.status === 'rejected').map(row => row.reason.message).join('\n'))
    assert.equal(new Set(outcomes.map(row => row.value)).size, 1)
    const files = await fsp.readdir(path.join(store.paperDir(item.id), '.figures'))
    assert.ok(!files.some(file => file.startsWith('.render-')), 'staging directories are cleaned')
  })
} finally {
  await fsp.rm(root, { recursive: true, force: true })
  console.log(`RESULT PASS ${passed} / FAIL ${failed}`)
  process.exitCode = failed ? 1 : 0
}
