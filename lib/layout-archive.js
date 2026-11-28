/** Immutable layout evidence and atomic current-revision publication. */
import { promises as fs, createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

const HASH = /^[a-f0-9]{64}$/
const REVISION = /^[a-z0-9][a-z0-9._-]{0,127}$/
const sha256 = value => createHash('sha256').update(value).digest('hex')
const encode = value => JSON.stringify(value, null, 2) + '\n'

export async function fingerprintPdf(file) {
  const resolved = path.resolve(file)
  const before = await fs.stat(resolved)
  if (!before.isFile()) throw new Error('PDF 路径不是文件')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(resolved)) digest.update(chunk)
  const after = await fs.stat(resolved)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('读取期间 PDF 已改变，请重新解析')
  return { path: resolved, sha256: digest.digest('hex'), size: after.size, mtimeMs: Math.round(after.mtimeMs) }
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try { await fs.writeFile(temp, data); await fs.rename(temp, file) }
  finally { await fs.rm(temp, { force: true }).catch(() => {}) }
}
async function immutable(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  try { await fs.writeFile(file, data, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if ((await fs.readFile(file, 'utf8')) !== data) throw new Error('不可变版面数据发生冲突：' + path.basename(file))
  }
}
function revisionId(value) {
  if (typeof value !== 'string' || !REVISION.test(value)) throw new Error('非法的版面版本 id')
  return value
}
function assertPublishable(layout) {
  revisionId(layout?.revision)
  if (!HASH.test(layout?.source?.sha256 || '')) throw new Error('版面缺少 PDF 内容 hash')
  const total = layout.pageCount
  if (!Number.isSafeInteger(total) || total <= 0 || !Array.isArray(layout.pages) || layout.pages.length !== total) {
    throw new Error('版面结果页数不完整，拒绝发布')
  }
  const ids = new Set(layout.pages.map(page => page.n))
  if (ids.size !== total || layout.pages.some(page => !Number.isSafeInteger(page.n) || page.n < 1 || page.n > total)) {
    throw new Error('版面结果页号重复或越界，拒绝发布')
  }
  if (!['passed', 'needs_review'].includes(layout.quality?.status)) throw new Error('版面质量校验失败，拒绝发布')
}

// An algorithm may rebuild identical evidence at a new wall-clock time. The
// original version stays immutable; timestamps alone must not fork its identity.
function semanticJson(value) {
  if (Array.isArray(value)) return value.map(semanticJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().filter(key => !['at', 'builtAt'].includes(key))
    .map(key => [key, semanticJson(value[key])]))
}

export function createLayoutArchive({ store } = {}) {
  if (typeof store?.paperFile !== 'function') throw new Error('版面归档需要 store 依赖')
  // 每次 RPC 都会 new 一个 archive；锁必须挂在进程级，否则两个并发 publish/clear
  // 各拿各的链，指针与兼容投影会互相覆盖。
  const chains = (globalThis.__pbLayoutArchiveChains ||= new Map())
  const root = id => store.paperFile(id, 'layout-data')
  const versionFile = (id, revision) => path.join(root(id), 'revisions', revisionId(revision) + '.json')
  const inputFile = (id, revision) => path.join(root(id), 'inputs', revisionId(revision) + '.json')
  const pointerFile = id => path.join(root(id), 'current.json')
  const lock = (id, task) => {
    const key = root(id)
    const pending = (chains.get(key) || Promise.resolve()).catch(() => {}).then(task)
    chains.set(key, pending)
    return pending.finally(() => { if (chains.get(key) === pending) chains.delete(key) })
  }

  async function saveRaw(id, text, metadata = {}) {
    if (typeof text !== 'string' || text === '') throw new Error('版面原始响应为空')
    const hash = sha256(text)
    const file = 'raw/' + hash + '.jsonl'
    await immutable(path.join(root(id), file), text)
    // Whitelist request metadata: never persist API tokens or auth headers.
    return { hash, file, page: metadata.page ?? null, model: metadata.model || '', jobId: metadata.jobId || '' }
  }
  async function readRaw(id, reference) {
    if (!HASH.test(reference?.hash || '')) throw new Error('非法的版面原始数据 hash')
    const text = await fs.readFile(path.join(root(id), 'raw', reference.hash + '.jsonl'), 'utf8')
    if (sha256(text) !== reference.hash) throw new Error('版面原始数据 hash 校验失败：内容损坏')
    return text
  }
  async function readRevision(id, revision) { return readJson(versionFile(id, revision)) }
  async function readInput(id, revision) { return readJson(inputFile(id, revision)) }
  async function readPublished(id) {
    const pointer = await readJson(pointerFile(id))
    if (pointer?.cleared === true) return null
    if (pointer) {
      const layout = await readRevision(id, pointer.revision)
      if (!layout) throw new Error('当前版面版本丢失：' + pointer.revision)
      return layout
    }
    // Compatibility is read-only. Legacy evidence is backed up on first publish.
    return readJson(store.paperFile(id, 'layout.json'))
  }
  async function publish(id, layout, input) {
    assertPublishable(layout)
    return lock(id, async () => {
      const previous = await readRevision(id, layout.revision)
      let selected = layout
      if (previous) {
        if (JSON.stringify(semanticJson(previous)) !== JSON.stringify(semanticJson(layout))) {
          throw new Error('不可变版面版本内容冲突：' + layout.revision)
        }
        selected = previous
      }
      const previousInput = await readInput(id, layout.revision)
      if ((previous || previousInput !== null) &&
          JSON.stringify(semanticJson(previousInput)) !== JSON.stringify(semanticJson(input))) {
        throw new Error('不可变版面输入内容冲突：' + layout.revision)
      }
      if (!previous) {
        // A failed revision write can leave valid immutable input to reuse.
        if (previousInput === null) await immutable(inputFile(id, layout.revision), encode(input))
        await immutable(versionFile(id, layout.revision), encode(layout))
      }
      const pointer = await readJson(pointerFile(id))
      if (!pointer) {
        const legacyFile = store.paperFile(id, 'layout.json')
        try {
          const legacy = await fs.readFile(legacyFile, 'utf8')
          await immutable(path.join(root(id), 'legacy', sha256(legacy) + '.json'), legacy)
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      // The pointer is authoritative. A failing compatibility projection cannot
      // invalidate a published immutable version or conceal it from new readers.
      await atomic(pointerFile(id), encode({ revision: selected.revision, sourceHash: selected.source.sha256 }))
      let projectionSynced = true
      try { await atomic(store.paperFile(id, 'layout.json'), encode(selected)) }
      catch { projectionSynced = false }
      return { revision: selected.revision, projectionSynced }
    })
  }
  /**
   * 派生修改（例如只重算表格结构）：内容变了必须产生新 revision，不能原地覆盖。
   * revision 直接由语义内容 hash 得到，所以同样的派生结果重复发布也幂等。
   */
  async function publishDerived(id, layout, input = {}) {
    const next = { ...layout }
    delete next.revision
    const revision = sha256(JSON.stringify(semanticJson(next)))
    next.revision = revision
    return publish(id, next, { ...input, derived: true, at: next.at })
  }

  async function clear(id) {
    return lock(id, async () => {
      await atomic(pointerFile(id), encode({ cleared: true }))
      await fs.rm(store.paperFile(id, 'layout.json'), { force: true })
    })
  }
  return { saveRaw, readRaw, readRevision, readInput, readPublished, publish, publishDerived, clear }
}
