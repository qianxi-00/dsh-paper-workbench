/** Native paper-chat scope. Storage and Host services are injected; no model calls. */
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const optionalText = (value, maxLen = 200) => {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\r\n\u0000]+/g, ' ').trim().slice(0, maxLen)
  return cleaned ? cleaned : null
}

export function normalizePaperContext(value, paperIds = []) {
  if (!object(value) || !paperIds.includes(value.paperId)) return null
  return {
    paperId: value.paperId,
    page: Number.isSafeInteger(value.page) && value.page > 0 ? value.page : 1,
    sectionId: optionalText(value.sectionId, 120),
    blockId: optionalText(value.blockId, 200),
    revision: optionalText(value.revision, 120),
  }
}

export function paperCitation({ paperId, page = 1, blockId, sectionId, revision } = {}) {
  const params = new URLSearchParams({ paper: String(paperId || ''), page: String(Number.isSafeInteger(page) && page > 0 ? page : 1) })
  if (optionalText(blockId) && optionalText(revision)) {
    params.set('block', blockId.trim())
    params.set('revision', revision.trim())
  } else if (optionalText(sectionId)) {
    params.set('section', sectionId.trim())
  }
  return '/paper-workbench/app?' + params
}

export function mergeUiState(previous, patch = {}) {
  const base = object(previous) ? previous : {}
  const next = { ...base, version: 2 }
  const update = object(patch) ? patch : {}
  for (const key of ['paperId', 'tab', 'page', 'scrollTop', 'sectionId', 'layout', 'expanded']) {
    if (Object.hasOwn(update, key)) next[key] = update[key]
  }
  const native = { open: true, width: 420, activeConv: null }
  for (const value of [base.nativeChat, update.nativeChat]) {
    if (!object(value)) continue
    if (typeof value.open === 'boolean') native.open = value.open
    if (typeof value.width === 'number' && Number.isFinite(value.width)) native.width = Math.min(1200, Math.max(320, value.width))
    if (value.activeConv === null || typeof value.activeConv === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value.activeConv)) native.activeConv = value.activeConv
  }
  next.nativeChat = native
  return next
}

function resolveFocus(focus, sources = {}) {
  if (!focus) return null
  const { layout, doc, text } = sources
  const blocks = Array.isArray(layout?.blocks) ? layout.blocks : []
  const paragraphs = Array.isArray(doc?.paragraphs) ? doc.paragraphs : []
  const currentRevision = optionalText(layout?.revision)
  let reason = sources.reason || null
  let selected = null
  let resolution = 'page'
  if (focus.blockId && !reason) {
    if (!focus.revision || focus.revision !== currentRevision) reason = 'stale-revision'
    else {
      selected = blocks.find(block => block.blockId === focus.blockId && block.page === focus.page)
      if (selected) resolution = 'block'
      else reason = 'missing-block'
    }
  }
  let material = ''
  let source = null
  let sectionId = focus.sectionId
  const blockText = block => String(block.kind === 'formula' ? block.latex || block.text || '' : block.text || '')
  if (selected) {
    material = blockText(selected)
    source = 'layout'
  } else {
    // An old/missing block falls back to the requested page, never a guessed block.
    const section = !reason && sectionId && paragraphs.filter(p => p.section === sectionId)
    if (section?.length && (!layout || doc?.revision === currentRevision)) {
      material = section.map(p => String(p.text || '')).join('\n\n')
      resolution = 'section'
      source = 'doc'
    } else {
      if (sectionId && !reason) reason = 'missing-section'
      sectionId = null
      const pageBlocks = blocks.filter(block => block.page === focus.page)
      if (pageBlocks.length) {
        material = pageBlocks.map(blockText).join('\n\n')
        source = 'layout'
      } else if (paragraphs.some(p => p.page === focus.page) && (!layout || doc?.revision === currentRevision)) {
        material = paragraphs.filter(p => p.page === focus.page).map(p => String(p.text || '')).join('\n\n')
        source = 'doc'
      } else {
        const page = text?.pages?.find(p => p.n === focus.page)
        if (page) { material = (page.blocks || []).map(block => String(block.text || '')).join('\n\n'); source = 'pdf-text' }
      }
    }
  }
  const result = { ...focus, sectionId, blockId: selected ? focus.blockId : null, revision: selected ? currentRevision : null,
    resolution: material.trim() ? resolution : 'unavailable', reason: reason || (material.trim() ? null : 'text-unavailable'), source, text: material }
  result.url = paperCitation(result)
  return result
}

// Live-verified on DSH Desktop: assembly.scope === agent during both assemble() and actual turns,
// without leaking to unscoped assemblies or other active sessions.
export const paperScopeBoundary = {
  matches: (assembly, agent) => assembly?.scope === agent,
  verified: true,
}

function resolveSystemPromptService(runtime, agent) {
  try {
    const fromPreset = runtime?.agentPresets?.serviceFor?.(agent, 'systemPrompt')
    if (fromPreset && typeof fromPreset.context === 'function') return fromPreset
  } catch { /* Preset layer may be absent or not expose systemPrompt on this DSH version. */ }
  try {
    const fromAgentCtx = agent?.ctx?.get?.('systemPrompt')
    if (fromAgentCtx && typeof fromAgentCtx.context === 'function') return fromAgentCtx
  } catch { /* Agent ctx getter may throw on torn-down fibers. */ }
  return null
}

export function createPaperContext({ getConversation, listConversations, updateConversation, loadPaper, loadSources, buildPrompt, scopeBoundary = paperScopeBoundary }) {
  const snapshots = new Map()
  const registrations = new Map()
  const registrationErrors = new Map()
  let runtime = null
  let runtimeRevision = 0
  let chain = Promise.resolve()
  function serialize(task) {
    const run = chain.then(task, task)
    chain = run.then(() => undefined, () => undefined)
    return run
  }
  async function conversation(id) {
    if (typeof id !== 'string' || !id) throw new Error('缺少 conversationId')
    const value = await getConversation(id)
    if (!value) throw new Error('对话不存在：' + id)
    return value
  }
  function release(sessionId) {
    const entry = registrations.get(sessionId)
    registrationErrors.delete(sessionId)
    if (entry) { registrations.delete(sessionId); entry.dispose() }
  }
  function register(agent) {
    if (!agent || !snapshots.has(agent.id) || runtime?.agents?.get(agent.id) !== agent) return
    const old = registrations.get(agent.id)
    if (old?.agent === agent) return
    release(agent.id)
    try {
      const service = resolveSystemPromptService(runtime, agent)
      if (!service) return
      const dispose = service.context({
        name: 'paper-workbench:' + agent.id,
        order: 100,
        interpolate: false,
        text: assembly => {
          if (!runtime || runtime.agents.get(agent.id) !== agent || !scopeBoundary.matches(assembly, agent)) return ''
          const snapshot = snapshots.get(agent.id)
          return snapshot ? buildPrompt({ conversation: snapshot.conversation, papers: snapshot.papers, context: snapshot.context }) : ''
        },
      })
      if (typeof dispose !== 'function') throw new Error('systemPrompt.context 未返回注销函数')
      registrations.set(agent.id, { agent, dispose })
    } catch (error) {
      registrationErrors.set(agent.id, error.message || String(error))
    }
  }
  function scope(sessionId) {
    if (!runtime?.agents) return { available: false, reason: '宿主 agents / systemPrompt 服务未接入' }
    if (!runtime.agents.get(sessionId)) return { available: false, reason: '目标原生会话尚未启动；请先 session.prepare' }
    if (!registrations.has(sessionId)) return { available: false, reason: registrationErrors.get(sessionId) || '目标会话的 systemPrompt.context 不可用' }
    if (!scopeBoundary.verified) return { available: false, registered: true, reason: 'systemPrompt.context 已登记；Host scope 隔离尚未完成真机验证' }
    return { available: true, registered: true, reason: null }
  }
  function runtimeReady() {
    return Boolean(runtime?.agents && scopeBoundary.verified)
  }
  async function hydrate(conv) {
    const papers = await Promise.all(conv.paperIds.map(async id => {
      try {
        const paper = await loadPaper(id)
        if (paper) return paper
      } catch { /* A missing paper must not prevent other conversations from loading. */ }
      return { id, title: id, pages: 0, path: '', available: false }
    }))
    const focus = normalizePaperContext(conv.paperContext, conv.paperIds)
    let sources = {}
    if (focus) sources = await loadSources(focus.paperId).catch(() => ({}))
    const current = focus ? resolveFocus(focus, sources) : null
    for (const [sessionId, snapshot] of snapshots) {
      if (snapshot.conversation.id === conv.id && sessionId !== conv.sessionId) {
        snapshots.delete(sessionId)
        release(sessionId)
      }
    }
    snapshots.set(conv.sessionId, { conversation: conv, papers, context: current })
    const agent = runtime?.agents?.get(conv.sessionId)
    if (agent) register(agent)
    return { conversationId: conv.id, sessionId: conv.sessionId, paperIds: [...conv.paperIds], papers, context: current, scope: scope(conv.sessionId) }
  }
  function refresh(id) { return serialize(async () => hydrate(await conversation(id))) }
  function get(args = {}) {
    return serialize(async () => {
      const conv = await conversation(args.conversationId)
      if (args.paperId != null && !conv.paperIds.includes(args.paperId)) throw new Error('论文未关联到此对话：' + args.paperId)
      return hydrate(conv)
    })
  }
  function set(args = {}) {
    return serialize(async () => {
      const conv = await conversation(args.conversationId)
      if (!Object.hasOwn(args, 'paperId')) throw new Error('缺少 paperId（传 null 清除当前上下文）')
      let focus = null
      if (args.paperId !== null) {
        if (!conv.paperIds.includes(args.paperId)) throw new Error('论文未关联到此对话：' + args.paperId)
        const paper = await loadPaper(args.paperId)
        if (!paper) throw new Error('论文不存在：' + args.paperId)
        if (args.page !== undefined && (!Number.isSafeInteger(args.page) || args.page < 1 || paper.pages > 0 && args.page > paper.pages)) throw new Error('page 必须是论文范围内的正整数')
        for (const key of ['sectionId', 'blockId', 'revision']) {
          if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'string') throw new Error(key + ' 必须是字符串或 null')
        }
        focus = normalizePaperContext(args, conv.paperIds)
      }
      return hydrate(await updateConversation(conv.id, { paperContext: focus }))
    })
  }
  function mutate(task, id) {
    return serialize(async () => {
      const value = await task()
      const changedId = id || value?.id || value?.conversation?.id
      if (changedId) await hydrate(await conversation(changedId))
      return value
    })
  }
  function remove(id, task) {
    return serialize(async () => {
      const conv = await conversation(id)
      const value = await task()
      snapshots.delete(conv.sessionId)
      release(conv.sessionId)
      return value
    })
  }
  function dispose() {
    runtimeRevision += 1
    runtime = null
    for (const sessionId of registrations.keys()) release(sessionId)
    snapshots.clear()
  }
  function setRuntime(next) {
    const revision = ++runtimeRevision
    return serialize(async () => {
      if (revision !== runtimeRevision) return
      for (const sessionId of registrations.keys()) release(sessionId)
      runtime = next || null
      snapshots.clear()
      if (runtime) {
        const chats = await listConversations()
        for (const conv of chats.items) {
          if (revision !== runtimeRevision) return
          await hydrate(conv)
        }
        for (const agent of runtime?.agents?.list() || []) register(agent)
      }
    })
  }
  function onAgentCreated(agent) {
    return serialize(async () => {
      if (!runtime) return
      const chats = await listConversations()
      const conv = chats.items.find(c => c.sessionId === agent?.id)
      if (conv) { await hydrate(conv); register(agent) }
    })
  }
  function onAgentDisposed(agent) {
    if (registrations.get(agent?.id)?.agent === agent) release(agent.id)
  }
  return { get, set, refresh, mutate, remove, setRuntime, onAgentCreated, onAgentDisposed, dispose, runtimeReady }
}
