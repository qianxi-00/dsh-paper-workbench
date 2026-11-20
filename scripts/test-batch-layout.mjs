import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const temp = await fs.realpath(os.tmpdir())
const root = await fs.mkdtemp(path.join(temp, 'pb-batch-layout-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root
process.env.PYTHONUTF8 = '1'
const { findPython } = await import('../lib/pdf.js')
const python = (await findPython())?.python
assert.ok(python, '批次集成测试需要 PyMuPDF')
const cli = fileURLToPath(new URL('./batch-layout.mjs', import.meta.url))
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const write = (file, value) => fs.writeFile(file, JSON.stringify(value))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const paperFile = (data, id, name) => path.join(data, 'papers', id, name)
const manifest = data => json(path.join(data, '.batch-layout', 'manifest.json'))
const requests = async data => (await fs.readFile(path.join(data, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
after(async () => {
  assert.equal(path.dirname(await fs.realpath(root)), temp)
  assert.match(path.basename(root), /^pb-batch-layout-/)
  await fs.rm(root, { recursive: true, force: true })
})

async function fakeCloud() {
  const files = await import('node:fs')
  const { join } = await import('node:path')
  const log = join(process.env.DSH_PAPER_WORKBENCH_DATA, 'requests.jsonl')
  const mode = process.env.PB_TEST_CLOUD
  const record = value => files.appendFileSync(log, JSON.stringify(value) + '\n')
  globalThis.fetch = async (url, options) => {
    const target = new URL(url)
    if (options.method === 'POST' && target.pathname.endsWith('/ocr/jobs')) {
      const model = options.body.get('model')
      const jobId = (model === 'PP-StructureV3' ? 'layout-' : 'ocr-') + crypto.randomUUID()
      record({ action: 'submit', jobId, model })
      if (mode === 'unavailable') return new Response('测试服务暂时不可用', { status: 503 })
      return Response.json({ data: { jobId } })
    }
    if (options.method === 'GET' && target.pathname.includes('/ocr/jobs/')) {
      const jobId = target.pathname.split('/').pop()
      record({ action: 'poll', jobId })
      if (mode === 'pause' || mode === 'pause-ocr') {
        if (process.platform === 'win32') process.emit(mode === 'pause' ? 'SIGTERM' : 'SIGINT')
        else process.kill(process.pid, mode === 'pause' ? 'SIGTERM' : 'SIGINT')
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) { reject(new Error('测试轮询已暂停')); return }
          const timer = setTimeout(resolve, 400)
          options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('测试轮询已暂停')) }, { once: true })
        })
      }
      return Response.json({ data: { state: 'done', resultUrl: { jsonUrl: 'https://batch-fixture.invalid/result/' + jobId } } })
    }
    if (options.method === 'GET' && target.hostname === 'batch-fixture.invalid') {
      const jobId = target.pathname.split('/').pop()
      record({ action: 'fetch', jobId })
      const rows = (mode === 'short' ? [0] : [0, 1]).map(index => {
        const text = 'A complete paragraph for the offline batch layout fixture on page ' + (index + 1) + '.'
        return JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text }, prunedResult: {
          width: 600, height: 800, page_index: index,
          parsing_res_list: [{ block_label: 'text', block_bbox: [20, 20, 590, 70], block_content: text }],
        } }] } })
      })
      return new Response(rows.join('\n'))
    }
    throw new Error('测试禁止访问未模拟的地址 ' + target.origin)
  }
}
const preload = 'data:text/javascript,' + encodeURIComponent('await (' + fakeCloud.toString() + ')()')
const sample = path.join(root, 'sample.pdf')
const made = spawnSync(python, ['-c', 'import fitz,sys\nd=fitz.open()\nfor index in range(2):\n p=d.new_page(width=600,height=800);p.insert_text((25,50),"A complete paragraph for the offline batch layout fixture on page %s."%(index+1))\nd.save(sys.argv[1]);d.close()', sample], { encoding: 'utf8' })
assert.equal(made.status, 0, made.stderr)
async function fixture(ids = ['sample']) {
  const data = await fs.mkdtemp(path.join(root, 'library-'))
  const papers = []
  for (const id of ids) {
    await fs.mkdir(path.dirname(paperFile(data, id, 'paper.pdf')), { recursive: true })
    await fs.copyFile(sample, paperFile(data, id, 'paper.pdf'))
    const meta = { id, title: id, pageCount: 99, hasText: true }
    await write(paperFile(data, id, 'meta.json'), meta)
    papers.push(meta)
  }
  await write(path.join(data, 'index.json'), { version: 1, papers })
  await write(path.join(data, 'config.json'), { python, ocr: { token: randomUUID() } })
  return data
}
function run(data, args = [], mode = 'ok') {
  assert.equal(path.dirname(data), root)
  const result = spawnSync(process.execPath, ['--import', preload, cli, ...args], {
    encoding: 'utf8', timeout: 90000, windowsHide: true,
    env: { ...process.env, DSH_PAPER_WORKBENCH_DATA: data, DSH_PAPER_PYTHON: python, PB_TEST_CLOUD: mode },
  })
  assert.ifError(result.error)
  return { code: result.status, output: result.stdout + result.stderr }
}

test('修复空版面、暂停后按已有 jobId 续拉两页，重复执行免上传', async () => {
  const data = await fixture()
  await write(paperFile(data, 'sample', 'layout.json'), { version: 1, schemaVersion: 2, pages: [], blocks: [] })
  const paused = run(data, [], 'pause')
  assert.equal(paused.code, 130, paused.output)
  const pending = (await manifest(data)).papers.sample
  assert.equal(pending.status, 'paused')
  assert.equal(pending.jobIds[0], (await json(paperFile(data, 'sample', 'layout.partial.json'))).pending.jobId)
  const first = run(data, ['--resume'])
  assert.equal(first.code, 0, first.output)
  assert.equal((await requests(data)).filter(item => item.action === 'submit').length, 1, first.output)
  const saved = await manifest(data)
  const record = saved.papers.sample
  assert.equal(saved.version, 1)
  assert.equal(record.status, 'done')
  assert.equal(record.pdf.sha256, digest(await fs.readFile(sample)))
  assert.equal(record.pdf.pages, 2)
  assert.deepEqual(record.coveredPages, [1, 2])
  assert.equal(record.attempts, 2)
  assert.equal(record.jobIds.length, 1)
  const pointer = await json(paperFile(data, 'sample', 'layout-data/current.json'))
  assert.equal((await json(paperFile(data, 'sample', 'doc.json'))).revision, pointer.revision)
  assert.deepEqual((await json(paperFile(data, 'sample', 'figures.json'))).figures, [])
  const before = await requests(data)
  const next = run(data)
  assert.equal(next.code, 0, next.output)
  assert.deepEqual(await requests(data), before)
  assert.equal((await manifest(data)).papers.sample.attempts, 2)
})
