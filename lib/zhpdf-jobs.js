import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { RESTART_PAUSED_REASON } from './translate-jobs.js'

export const ZHPDF_JOB_FILE = 'zhpdf.job.json'

export function createZhPdfJobManager({ store, doc, zhpdf, translateJobs }) {
  const records = new Map()
  const runs = new Map()
  const chains = new Map()
  let loading

  function snapshot(record) {
    return record ? structuredClone(record) : null
  }

  async function save(record, patch) {
    Object.assign(record, patch, { updatedAt: new Date().toISOString() })
    await store.writeJsonAtomic(store.paperFile(record.paperId, ZHPDF_JOB_FILE), record)
    return snapshot(record)
  }

  function checkSource(record, check) {
    if (record.sourceHash && record.sourceHash !== check.sourceHash || record.docHash && record.docHash !== check.docHash) {
      throw new Error('源 PDF 或文档在生成流程中发生变化，请检查论文后重新生成中文版')
    }
  }

  async function inspect(record) {
    const built = await doc.getDoc(record.paperId)
    const check = await zhpdf.inspect(record.paperId, built.doc)
    checkSource(record, check)
    if (record.phase === 'generating' && record.transHash && record.transHash !== check.transHash) throw new Error('生成期间译文已更新，请重新生成中文版')
    const { missingKeys, ...coverage } = check
    await save(record, coverage)
    if (check.issues.length) {
      throw new Error(check.issues.slice(0, 8).map(issue => '第 ' + (issue.page || '?') + ' 页 ' + issue.reason).join('，'))
    }
    if (!check.readyBlocks && !check.missingKeys.length) throw new Error('没有可生成的文字，请检查文档与版面解析')
    return { check, document: built.doc }
  }

  function launch(record, resumeTranslation = false) {
    if (runs.has(record.paperId)) return
    const controller = new AbortController()
    const active = { controller, promise: null }
    runs.set(record.paperId, active)
    active.promise = (async () => {
      try {
        let { check, document } = await inspect(record)
        controller.signal.throwIfAborted()
        if (check.missingKeys.length) {
          let translation = await translateJobs.status(record.paperId)
          if (translation?.status === 'paused') {
            if (resumeTranslation || translation.purpose === 'zhpdf' && translation.error === RESTART_PAUSED_REASON) translation = await translateJobs.resumeJob(translation.id)
            else {
              await save(record, { status: 'paused', phase: 'translating', translationJobId: translation.id, error: '本篇翻译已暂停，点击继续生成中文版以接续' })
              return
            }
          }
          if (translation?.status !== 'running') {
            translation = await translateJobs.startJob({ id: record.paperId, keys: check.missingKeys, titles: true, purpose: 'zhpdf', target: 'zh', ...(record.requestedModel ? { model: record.requestedModel } : {}) })
            record.ownsTranslation = translation.purpose === 'zhpdf'
          } else record.ownsTranslation = translation.purpose === 'zhpdf'
          await save(record, { phase: 'translating', translationJobId: translation.id, model: translation.model || record.model || '' })
          for await (const frame of translateJobs.stream(translation.id, { signal: controller.signal })) {
            if (frame.data?.model) record.model = frame.data.model
            if (frame.event === 'paused') {
              await save(record, { status: 'paused', error: '翻译已暂停，可继续生成中文版' })
              return
            }
            if (frame.event === 'error' && frame.data?.fatal) throw new Error(frame.data.message || '模型翻译失败，请检查设置中的翻译模型')
          }
          controller.signal.throwIfAborted()
          const latest = await inspect(record)
          check = latest.check
          document = latest.document
          if (check.missingKeys.length) {
            const pending = await translateJobs.status(record.paperId)
            if (pending?.status !== 'done') throw new Error('本篇翻译尚未完成，请继续翻译后重试')
            const extra = await translateJobs.startJob({ id: record.paperId, keys: check.missingKeys, titles: true, purpose: 'zhpdf', target: 'zh', ...(record.requestedModel ? { model: record.requestedModel } : {}) })
            await save(record, { translationJobId: extra.id, ownsTranslation: extra.purpose === 'zhpdf' })
            for await (const frame of translateJobs.stream(extra.id, { signal: controller.signal })) {
              if (frame.data?.model) record.model = frame.data.model
              if (frame.event === 'paused') {
                await save(record, { status: 'paused', error: '翻译已暂停，可继续生成中文版' })
                return
              }
              if (frame.event === 'error' && frame.data?.fatal) throw new Error(frame.data.message || '模型翻译失败')
            }
            controller.signal.throwIfAborted()
            const final = await inspect(record)
            check = final.check
            document = final.document
            if (check.missingKeys.length) throw new Error('仍有 ' + check.missingKeys.length + ' 项缺译，请检查翻译任务后重试')
          }
        }
        controller.signal.throwIfAborted()
        await save(record, { phase: 'generating', error: '' })
        const result = await zhpdf.build(record.paperId, { doc: document, sourceHash: record.sourceHash, docHash: record.docHash, transHash: record.transHash, signal: controller.signal })
        const published = await zhpdf.status(record.paperId)
        if (!published.exists || published.stale) throw new Error('中文版产物校验失败，请重新生成')
        await save(record, { status: 'done', phase: 'done', result: { blocks: result.blocks, pages: result.pages }, missingCount: 0, error: '' })
      } catch (error) {
        await save(record, { status: controller.signal.aborted ? 'paused' : 'error', error: controller.signal.aborted ? '已暂停，可继续生成中文版' : error.message }).catch(persistError => {
          record.status = 'error'
          record.error = '任务状态保存失败，请检查磁盘权限 ' + persistError.message
        })
      } finally {
        if (runs.get(record.paperId) === active) runs.delete(record.paperId)
      }
    })()
  }

  async function ready() {
    if (!loading) loading = (async () => {
      const papers = await store.listPapers()
      for (const paper of papers) {
        const id = store.assertId(paper.id)
        let record
        try { record = JSON.parse(await fs.readFile(store.paperFile(id, ZHPDF_JOB_FILE), 'utf8')) }
        catch (error) { if (error.code === 'ENOENT') continue; throw error }
        if (record.version !== 1 || record.paperId !== id || record.purpose !== 'zhpdf') continue
        records.set(id, record)
        if (record.status === 'running') launch(record)
      }
    })()
    return loading
  }

  function serialize(id, operation) {
    const previous = chains.get(id) || Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    chains.set(id, next)
    void next.finally(() => { if (chains.get(id) === next) chains.delete(id) }).catch(() => {})
    return next
  }

  async function prepare(rawId, options = {}) {
    const id = store.assertId(rawId)
    await ready()
    return serialize(id, async () => {
      const current = records.get(id)
      if (runs.has(id) || current?.status === 'paused') return snapshot(current)
      if (current?.status === 'done') {
        const published = await zhpdf.status(id)
        if (published.exists && !published.stale) return snapshot(current)
      }
      const record = { version: 1, id: 'zj-' + randomUUID(), paperId: id, purpose: 'zhpdf', status: 'running', phase: 'checking', model: '', ...(options.model ? { requestedModel: options.model } : {}), createdAt: new Date().toISOString(), error: '' }
      await save(record)
      records.set(id, record)
      launch(record)
      return snapshot(record)
    })
  }

  async function status(rawId) {
    await ready()
    const id = store.assertId(rawId)
    const record = snapshot(records.get(id))
    if (record?.status === 'running' && record.translationJobId && record.phase === 'translating') {
      const translation = await translateJobs.status(record.translationJobId)
      if (translation) Object.assign(record, { model: translation.model || record.model, completed: translation.completed, total: translation.total })
    }
    return record
  }

  async function pause(rawId) {
    const id = store.assertId(rawId)
    await ready()
    return serialize(id, async () => {
      const record = records.get(id)
      if (!record || record.status !== 'running') return snapshot(record)
      const active = runs.get(id)
      active?.controller.abort()
      if (record.ownsTranslation && record.translationJobId) await translateJobs.pauseJob(record.translationJobId)
      await active?.promise
      if (record.status === 'done') return snapshot(record)
      return save(record, { status: 'paused', error: '已暂停，可继续生成中文版' })
    })
  }

  async function resume(rawId) {
    const id = store.assertId(rawId)
    await ready()
    return serialize(id, async () => {
      const record = records.get(id)
      if (!record) throw new Error('没有待继续的中文版任务，请点击生成中文版')
      if (runs.has(id)) return snapshot(record)
      await inspect(record)
      await save(record, { status: 'running', error: '' })
      launch(record, true)
      return snapshot(record)
    })
  }

  return { prepare, pause, resume, status, ready }
}
