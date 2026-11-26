#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as store from '../lib/store.js'
import * as pdf from '../lib/pdf.js'
import * as ocr from '../lib/ocr.js'
import { createLayout, LAYOUT_BUILD, LAYOUT_PARTIAL } from '../lib/layout.js'
import { createLayoutArchive, fingerprintPdf } from '../lib/layout-archive.js'
import * as doc from '../lib/doc.js'
import * as figures from '../lib/figures.js'

const args = process.argv.slice(2)
const has = flag => args.includes(flag)
const work = path.join(store.DATA_ROOT, '.batch-layout')
const file = path.join(work, 'manifest.json')
const archive = createLayoutArchive({ store })
const controller = new AbortController()
const { signal } = controller
const pause = () => controller.abort()
const read = (id, name) => store.readJson(store.paperFile(id, name), null)
const numbers = pages => pages.map(page => page.n).sort((left, right) => left - right)
const complete = (pages, total) => pages.length === total && pages.every((page, index) => page === index + 1)
const fresh = () => ({ status: 'queued', stage: 'inspect', pdf: null, coveredPages: [], jobIds: [], attempts: 0, error: null })

async function published(id, source, allowLegacy = false) {
  try {
    const layout = await archive.readPublished(id)
    const pointer = await read(id, 'layout-data/current.json')
    if (layout?.schemaVersion !== 2 || !(layout.build === LAYOUT_BUILD || (allowLegacy && layout.build === 'ir-4')) || !pointer?.revision || layout.revision !== pointer.revision ||
        pointer.sourceHash !== source.sha256 || layout.source?.sha256 !== source.sha256 || layout.pageCount !== source.pages ||
        !complete(numbers(layout.pages), source.pages) || layout.pages.some(page => page.status === 'failed') ||
        !['passed', 'needs_review'].includes(layout.quality?.status) || !layout.rawRefs?.length) return null
    for (const ref of layout.rawRefs) await archive.readRaw(id, ref)
    return layout
  } catch { return null }
}

async function derived(id, layout, source) {
  const cached = await read(id, 'doc.json')
  const images = await read(id, 'figures.json')
  const projection = await read(id, 'layout.json')
  return JSON.stringify(projection) === JSON.stringify(layout) && cached?.version === doc.DOC_VERSION &&
    cached.source === 'layout' && cached.revision === layout.revision && cached.parserBuild === LAYOUT_BUILD &&
    cached.paragraphs?.length > 0 && Array.isArray(cached.sections) && images?.version === figures.FIGURES_VERSION &&
    Array.isArray(images.figures) && images.source?.size === source.size && Math.round(images.source?.mtimeMs) === source.mtimeMs &&
    (!layout.figures?.length || images.layoutAt === layout.at && images.figures.length === layout.figures.length)
}

async function backup(id) {
  const dir = path.join(work, 'backups', randomUUID(), store.assertId(id))
  for (const name of ['layout-data/current.json', 'layout.json', 'layout.partial.json', 'meta.json', 'doc.json', 'figures.json', 'ocr.md']) {
    const destination = path.join(dir, name)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    try { await fs.copyFile(store.paperFile(id, name), destination) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

async function main() {
  if (has('--help') || has('-h')) {
    console.log('用法：node scripts/batch-layout.mjs [--resume | --retry-failed] [--concurrency=2] [--refill-existing] [--force] [--no-upgrade-v1] [--dry-run] [--id=<id>]')
    return
  }
  const concurrency = Math.max(1, Math.min(16, Math.trunc(Number(args.find(arg => arg.startsWith('--concurrency='))?.slice(14)) || 2)))
  const ids = args.filter(arg => arg.startsWith('--id=')).map(arg => store.assertId(arg.slice(5)))
  const dry = has('--dry-run')
  let manifest
  try { manifest = JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('批次清单无法读取，请检查 ' + file); manifest = { version: 1, papers: {} } }
  if (manifest?.version !== 1 || !manifest.papers || typeof manifest.papers !== 'object' || Array.isArray(manifest.papers)) throw new Error('不支持的批次清单，请检查 ' + file)
  manifest.papers = Object.assign(Object.create(null), manifest.papers)
  const config = await store.getConfig()
  const token = String(config.ocr?.token || '').trim()
  const selected = (await store.listPapers()).filter(({ id }) => (!ids.length || ids.includes(id)) &&
    (!has('--resume') || Object.hasOwn(manifest.papers, id)) && (!has('--retry-failed') || manifest.papers[id]?.status === 'failed'))
  for (const { id } of selected) manifest.papers[store.assertId(id)] ??= fresh()
  let writes = Promise.resolve()
  const save = () => dry ? Promise.resolve() : (writes = writes.then(() => store.writeJsonAtomic(file, manifest)))
  process.on('SIGINT', pause)
  process.on('SIGTERM', pause)
  const cloud = Object.fromEntries(['submitJob', 'pollJob', 'fetchResults'].map(name => [name, options => ocr[name]({ ...options, maxRetries: 0, signal })]))
  let failed = 0

  async function processPaper({ id, hasText }) {
    let record = manifest.papers[id]
    try {
      const { path: pdfPath } = await store.resolvePdf(id)
      const source = await fingerprintPdf(pdfPath)
      source.pages = (await pdf.info(pdfPath)).pages
      if (!Number.isSafeInteger(source.pages) || source.pages < 1) throw new Error('无法确认 PDF 页数')
      const same = record.pdf?.sha256 === source.sha256 && record.pdf?.pages === source.pages
      if (!same) record = manifest.papers[id] = fresh()
      record.pdf = { sha256: source.sha256, pages: source.pages }
      const force = has('--force') || record.forcePending === true
      let layout = await published(id, source, has('--refill-existing') && !force)
      const refill = has('--refill-existing') && layout && !force
      const ocrReady = () => store.readOcr(id).then(text => complete([...text.matchAll(/^## p\.(\d+)\s*$/gm)].map(match => Number(match[1])), source.pages))
      const needsOcr = !refill && hasText === false && (!(record.ocrComplete || layout) || !(await ocrReady()))
      const finish = () => Object.assign(record, { status: 'done', stage: 'complete', error: null, forcePending: false,
        coveredPages: numbers(layout.pages), jobIds: [...new Set([...record.jobIds, ...layout.rawRefs.map(ref => ref.jobId).filter(Boolean)])] })
      if (!needsOcr && layout && !force && !refill && await derived(id, layout, source)) {
        finish(); console.log(`[跳过] ${id} · ${source.pages} 页已校验`); return
      }
      if (has('--no-upgrade-v1') && !force && (await archive.readPublished(id).catch(() => null))?.schemaVersion !== 2 && (await read(id, 'layout.json'))?.blocks) {
        record.status = 'skipped'; record.stage = 'legacy'; return
      }
      if (dry) { console.log(`[干跑] ${id} · ${source.pages} 页 · ${layout && !force ? '离线重建' : '云端解析'}`); return }
      if (record.status === 'failed' && !has('--retry-failed') && !has('--force')) { failed++; console.error(`[待重试] ${id} · ${record.error}`); return }
      signal.throwIfAborted()
      await backup(id)
      if (record.status === 'failed' || has('--force') || record.status === 'done') record.autoRetries = 0
      const partial = await read(id, LAYOUT_PARTIAL)
      const canResume = partial?.source?.sha256 === source.sha256 && !has('--force')
      record.coveredPages = layout ? numbers(layout.pages) : canResume && Array.isArray(partial.pages) ? numbers(partial.pages) : []
      record.status = 'running'
      record.error = null
      record.forcePending = force
      await save()
      const partialPath = store.paperFile(id, LAYOUT_PARTIAL)
      const runner = createLayout({ pdf, ocr: cloud, store: { ...store, async writeJsonAtomic(target, value) {
        if (target === partialPath) value.source = { ...value.source, sha256: source.sha256 }
        await store.writeJsonAtomic(target, value)
        if (target === partialPath) {
          record.coveredPages = numbers(value.pages)
          record.jobIds = [...new Set([...record.jobIds, ...(value.jobs || []), ...(value.pending?.jobId ? [value.pending.jobId] : [])])]
          await save()
        }
      } } })
      if (needsOcr || !layout || force) {
        record.stage = needsOcr ? 'ocr' : 'layout'
        if (!token) throw new Error('请在设置中填写 PaddleOCR Token 后重试')
        for (let retry = 0; ; retry++) {
          record.attempts++
          try {
            signal.throwIfAborted()
            if (needsOcr && !(record.ocrComplete && await ocrReady())) {
              record.stage = 'ocr'; await save()
              if (!record.ocrJobId) {
                const result = await cloud.submitJob({ token, filePath: pdfPath, model: config.ocr.model || ocr.DEFAULT_MODEL,
                  optionalPayload: { useDocOrientationClassify: Boolean(config.ocr.orient), useDocUnwarping: false } })
                record.ocrJobId = result.jobId; record.jobIds.push(result.jobId); await save()
              }
              const { jsonUrl } = await cloud.pollJob({ token, jobId: record.ocrJobId })
              const { pages } = await cloud.fetchResults({ jsonUrl, jobId: record.ocrJobId })
              if (!complete(numbers(pages), source.pages)) throw new Error('OCR 返回页覆盖不全，请检查云端结果')
              await store.writeOcr(id, ocr.pagesToMarkdown(pages).markdown)
              record.ocrComplete = true; await save()
            }
            if (!layout || force) {
              record.stage = 'layout'; await save()
              await runner.runLayout(id, { model: 'PP-StructureV3', resume: canResume || retry > 0, signal })
            }
            break
          } catch (error) {
            if (signal.aborted) throw error
            if (/^(OCR 任务失败（job |OCR 返回页覆盖不全|第 \d+-\d+ 页的版面结果不完整)/.test(error.message)) {
              if (record.stage === 'ocr') record.ocrJobId = null
              else {
                const partial = await runner.readPartial(id)
                if (partial?.pending) await store.writeJsonAtomic(partialPath, { ...partial, pending: null })
              }
            }
            if (record.autoRetries || retry >= 1) throw error
            record.autoRetries = 1; await save()
            console.log(`[自动重试] ${id} · ${record.stage}`)
          }
        }
      } else if (refill) {
        record.stage = 'refill'; await save(); await runner.refillText(id)
      }
      signal.throwIfAborted()
      record.stage = 'derived'; record.forcePending = false; await save()
      layout = await published(id, source)
      if (!layout) throw new Error('发布产物未通过 PDF 指纹、页覆盖或原始归档校验')
      if (JSON.stringify(await read(id, 'layout.json')) !== JSON.stringify(layout)) await store.writeJsonAtomic(store.paperFile(id, 'layout.json'), layout)
      await doc.getDoc(id, { rebuild: true })
      await figures.listFigures(id, { refresh: true })
      if (!await derived(id, layout, source)) throw new Error('文档或配图缓存校验失败，请重试')
      finish(); console.log(`[完成] ${id} · ${source.pages} 页`)
    } catch (error) {
      record.status = signal.aborted ? 'paused' : 'failed'
      const message = String(error.message || error)
      record.error = signal.aborted ? null : (token ? message.split(token).join('[已隐藏]') : message)
      if (!signal.aborted) { failed++; console.error(`[失败] ${id} · ${record.error}`) }
    } finally { await save() }
  }

  try {
    await save()
    console.log(`批次 ${selected.length} 篇 · 并发 ${concurrency} · 数据目录 ${store.DATA_ROOT}`)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      while (!signal.aborted && cursor < selected.length) await processPaper(selected[cursor++])
    }))
    if (signal.aborted) { console.log('批次已暂停，可用 --resume 继续'); process.exitCode = 130 }
    else if (failed) process.exitCode = 1
  } finally { process.off('SIGINT', pause); process.off('SIGTERM', pause) }
}

main().catch(error => { console.error('批量版面处理失败：' + error.message); process.exitCode = 1 })
