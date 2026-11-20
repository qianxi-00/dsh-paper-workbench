import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { createZhPdf } from '../lib/zhpdf.js'
import { createTranslateJobManager } from '../lib/translate-jobs.js'
import { createZhPdfJobManager } from '../lib/zhpdf-jobs.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-zhpdf-jobs-'))
const paperDir = id => path.join(root, 'papers', id)
const store = {
  PAPERS_DIR: path.join(root, 'papers'),
  assertId(id) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(id)) throw new Error('非法的论文 id')
    return id
  },
  paperFile: (id, name) => path.join(paperDir(store.assertId(id)), name),
  async listPapers() { return (await fs.readdir(this.PAPERS_DIR)).map(id => ({ id })) },
  async resolvePdf(id) { return { path: this.paperFile(id, 'paper.pdf') } },
  async readTrans(id) {
    try { return JSON.parse(await fs.readFile(this.paperFile(id, 'trans.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return { entries: {} }; throw error }
  },
  async writeTrans(id, value) { await this.writeJsonAtomic(this.paperFile(id, 'trans.json'), value) },
  async writeJsonAtomic(file, value) {
    const tmp = file + '.tmp-' + Math.random().toString(36).slice(2)
    await fs.writeFile(tmp, JSON.stringify(value))
    await fs.rename(tmp, file)
  },
  async getConfig() { return { ai: { concurrency: 1 } } },
}
const docs = new Map()
const doc = { async getDoc(id) { return { doc: docs.get(id) } } }
const calls = []
const pdf = {
  async callTool(command, payload) {
    assert.equal(command, 'zhpdf')
    calls.push(payload)
    await fs.writeFile(payload.out, 'complete-pdf')
    return { ok: true, blocks: payload.pages.flatMap(page => page.blocks).length, skipped: 0, pages: 1 }
  },
}

async function paper(id, entries = {}) {
  await fs.mkdir(paperDir(id), { recursive: true })
  await fs.writeFile(store.paperFile(id, 'paper.pdf'), 'source-pdf')
  const value = {
    revision: 'revision-1',
    sections: [{ id: 's1', hash: 'title1', title: 'Introduction', page: 1 }],
    paragraphs: [{ id: 'p1', hash: 'body1', kind: 'body', text: 'A paragraph.', page: 1, bbox: [10, 20, 100, 40] }],
  }
  docs.set(id, value)
  await fs.writeFile(store.paperFile(id, 'doc.json'), JSON.stringify(value))
  await store.writeTrans(id, { entries })
}

function makeAi({ gate = null } = {}) {
  const requests = []
  return {
    requests,
    async *translate(body, { signal }) {
      requests.push({ ...body })
      yield { event: 'start', data: { total: body.keys.length, model: 'fake/model' } }
      if (gate) await Promise.race([gate, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))])
      if (signal.aborted) return
      const trans = await store.readTrans(body.id)
      for (const key of body.keys) {
        trans.entries[key] = { zh: key.startsWith('t:') ? '引言' : '一段正文。' }
        yield { event: 'done', data: { key, text: trans.entries[key].zh, model: 'fake/model' } }
      }
      await store.writeTrans(body.id, trans)
      yield { event: 'end', data: { ok: true, failed: 0 } }
    },
  }
}

function manager(ai = makeAi()) {
  const translation = createTranslateJobManager({ ai, store })
  const zhpdf = createZhPdf({ store, pdf })
  const jobs = createZhPdfJobManager({ store, doc, zhpdf, translateJobs: translation })
  return { jobs, translation, ai, zhpdf }
}

async function waitFor(jobs, id, predicate) {
  const deadline = Date.now() + 5000
  let value
  while (Date.now() < deadline) {
    value = await jobs.status(id)
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('等待中文版任务状态超时 ' + JSON.stringify(value))
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('目录标题与正文分别计算覆盖，后台补齐并发布', async () => {
  await paper('coverage')
  const { jobs, ai, zhpdf } = manager()
  const check = await zhpdf.inspect('coverage', docs.get('coverage'))
  assert.deepEqual(new Set(check.missingKeys), new Set(['body1', 't:title1']))
  assert.equal(check.targetCount, 2)
  assert.equal(check.missingTitleCount, 1)
  const started = await jobs.prepare('coverage')
  assert.equal(started.status, 'running')
  const result = await waitFor(jobs, 'coverage', value => value.status === 'done')
  assert.equal(result.phase, 'done')
  assert.equal(result.missingCount, 0)
  assert.equal(result.model, 'fake/model')
  assert.equal(ai.requests.length, 1)
  assert.equal(ai.requests[0].titles, true)
  assert.deepEqual(new Set(ai.requests[0].keys), new Set(['body1', 't:title1']))
  assert.equal((await zhpdf.status('coverage')).stale, false)
})

test('重复请求复用任务，暂停期间不发布，继续后完成', async () => {
  await paper('pause')
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { jobs, ai } = manager(makeAi({ gate }))
  const first = await jobs.prepare('pause')
  const again = await jobs.prepare('pause')
  assert.equal(first.id, again.id)
  await waitFor(jobs, 'pause', value => value.phase === 'translating')
  await jobs.pause('pause')
  assert.equal((await jobs.status('pause')).status, 'paused')
  await assert.rejects(fs.stat(store.paperFile('pause', 'paper-zh.pdf')), { code: 'ENOENT' })
  release()
  await jobs.resume('pause')
  await waitFor(jobs, 'pause', value => value.status === 'done')
  assert.equal(ai.requests.length, 2, JSON.stringify(ai.requests))
})

test('已有其它翻译任务时等待其结束，再仅补缺失项', async () => {
  await paper('existing')
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { jobs, ai, translation } = manager(makeAi({ gate }))
  const existing = await translation.startJob({ id: 'existing', keys: ['body1'] })
  const started = await jobs.prepare('existing')
  await waitFor(jobs, 'existing', value => value.translationJobId === existing.id)
  assert.equal(started.status, 'running')
  release()
  await waitFor(jobs, 'existing', value => value.status === 'done')
  assert.equal(ai.requests.length, 2)
  assert.deepEqual(ai.requests[1].keys, ['t:title1'])
})

test('源文件在补译期间变化时停止并保留旧文件', async () => {
  await paper('changed')
  await fs.writeFile(store.paperFile('changed', 'paper-zh.pdf'), 'old-pdf')
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { jobs } = manager(makeAi({ gate }))
  await jobs.prepare('changed')
  await waitFor(jobs, 'changed', value => value.phase === 'translating')
  await fs.writeFile(store.paperFile('changed', 'paper.pdf'), 'changed-pdf')
  release()
  const result = await waitFor(jobs, 'changed', value => value.status === 'error')
  assert.match(result.error, /源|文档/)
  assert.equal(await fs.readFile(store.paperFile('changed', 'paper-zh.pdf'), 'utf8'), 'old-pdf')
})

test('进程重启后接续已持久化生成阶段', async () => {
  await paper('restart', { body1: { zh: '一段正文。' }, 't:title1': { zh: '引言' } })
  const first = manager()
  const inspected = await first.zhpdf.inspect('restart', docs.get('restart'))
  await store.writeJsonAtomic(store.paperFile('restart', 'zhpdf.job.json'), {
    version: 1, id: 'zj-restart', paperId: 'restart', purpose: 'zhpdf', status: 'running', phase: 'generating',
    sourceHash: inspected.sourceHash, docHash: inspected.docHash, createdAt: new Date().toISOString(),
  })
  const second = manager()
  await second.jobs.ready()
  const done = await waitFor(second.jobs, 'restart', value => value.status === 'done')
  assert.equal(done.id, 'zj-restart')
  assert.equal(await fs.readFile(store.paperFile('restart', 'paper-zh.pdf'), 'utf8'), 'complete-pdf')
})
