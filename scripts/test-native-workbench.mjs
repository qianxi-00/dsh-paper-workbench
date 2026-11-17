import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const origin = 'http://paper.test'
const reader = { id: 'paper-a', title: 'Paper A', revision: 'r1', page: 1, sectionId: 's1' }
const conversations = ['a', 'b'].map(id => ({ id, sessionId: 'session-' + id, title: id, paperIds: [reader.id] }))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const json = value => JSON.parse(JSON.stringify(value))

// Execute the registered Workbench unchanged. Only hooks, DOM events, RPC and native Session bindings are doubled.
async function fixture(options = {}) {
  const hooks = [], effects = [], listeners = new Map(), timers = new Map()
  const messages = [], calls = [], references = [], prompts = [], submissions = [], draftWrites = []
  const inputState = { draft: '尚未发送的用户草稿', occurrences: [{ id: 'chip-a', label: '参考文件' }], attachments: [{ id: 'upload-a' }] }
  let cursor = 0, dirty = true, root = null, Workbench = null, nextTimer = 0, disposed = false
  const frame = { contentWindow: { postMessage(data, targetOrigin) { messages.push({ data: json(data), origin: targetOrigin }) } } }
  const rootElement = {}
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const React = {
    useRef(value) { const index = cursor++; return hooks[index] ||= { current: value } },
    useState(value) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: typeof value === 'function' ? value() : value }
      return [hooks[index].value, update => {
        const next = typeof update === 'function' ? update(hooks[index].value) : update
        if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true }
      }]
    },
    useEffect(callback, deps) {
      const index = cursor++, previous = hooks[index]
      if (!previous || !sameDeps(previous.deps, deps)) effects.push(() => {
        previous?.cleanup?.()
        hooks[index] = { deps, cleanup: callback() }
      })
    },
    createElement(type, props, ...children) {
      if (props?.ref && !props.ref.current) props.ref.current = type === 'iframe' ? frame : rootElement
      return { type, props: props || {}, children: children.flat(Infinity) }
    },
  }
  function SessionProvider() {}
  const props = { SessionProvider, renderSlot() { return null } }
  const list = json(conversations)
  let createdSeq = 0
  const scope = { available: true, reason: null }
  async function defaultRpc(method, args) {
    switch (method) {
      case 'conv.list': return { items: list, activeId: 'a' }
      case 'ui.get': return { state: { nativeChat: options.stored || { open: true, activeConv: 'a', width: 440 } } }
      case 'library.list': return { items: [reader] }
      case 'session.prepare': return { scope }
      case 'paper.context.set': return { scope }
      case 'conv.active': return {}
      case 'ui.set': return {}
      case 'conv.update': {
        const item = list.find(conv => conv.id === args.id)
        assert.ok(item, 'conversation must exist')
        Object.assign(item, args)
        return item
      }
      case 'conv.create': {
        createdSeq += 1
        const created = {
          id: 'created-' + createdSeq,
          sessionId: 'pb-conv-created-' + createdSeq,
          title: args.title || '论文对话',
          paperIds: args.paperIds || [],
        }
        list.unshift(created)
        return created
      }
      case 'conv.remove': {
        const idx = list.findIndex(conv => conv.id === args.id)
        if (idx >= 0) list.splice(idx, 1)
        return { ok: true }
      }
      default: throw new Error('Unexpected RPC: ' + method)
    }
  }
  const fetch = async (url, init = {}) => {
    const method = url.split('/api/')[1]
    const args = init.body ? JSON.parse(init.body) : {}
    const call = { method, args: json(args), keepalive: init.keepalive === true }
    calls.push(call)
    const value = options.rpc ? await options.rpc(method, args, defaultRpc, calls) : await defaultRpc(method, args)
    return { ok: true, json: async () => ({ ok: true, value: json(value) }) }
  }
  const input = {
    state: { getSnapshot: () => inputState },
    setDraft(value) { draftWrites.push(value); inputState.draft = value },
    clear() { draftWrites.push('clear'); inputState.draft = ''; inputState.attachments = []; inputState.occurrences = [] },
  }
  const sessions = {
    retain(sessionId, retainOptions) {
      const record = { sessionId, options: retainOptions, releases: 0, cancels: 0 }
      const binding = { sessionId, session: {
        input,
        beginSubmission(value) { const requestId = 'native-' + (submissions.length + 1); submissions.push({ sessionId, requestId, ...json(value) }); return { requestId } },
        async prompt(content, mode, signal, requestId) {
          const call = { sessionId, content: json(content), mode, requestId }
          prompts.push(call)
          return options.prompt ? await options.prompt(call, prompts.length) : { ok: true, value: { accepted: true } }
        },
        cancel() { record.cancels++ },
      } }
      record.reference = { sessionId, binding, ready: Promise.resolve(binding), release() { record.releases++ } }
      references.push(record)
      return record.reference
    },
  }
  const openedSessions = []
  const uploads = []
  const services = {
    sessions,
    conversation: { input: { for: () => input } },
    uiWorkspace: { openSession(id) { openedSessions.push(id) } },
    ...(options.fileUpload ? { fileUpload: options.fileUpload(uploads) } : {}),
  }
  const slots = {
    inject(name, callback) { return callback() },
    register(spec, component) { if (spec.name === 'main') Workbench = component; return () => {} },
  }
  let exported
  const window = {
    location: { origin },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback) },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
    __ModuleLoader__: { load(definition) { exported = definition.factory(() => React) } },
  }
  vm.runInNewContext(source, { window, fetch, URL, File: globalThis.File, Blob: globalThis.Blob, btoa: globalThis.btoa, console, ResizeObserver: class { observe() {} disconnect() {} } }, { filename: 'lib/client.js' })
  exported.apply({ get: name => services[name], plugin: definition => definition.apply({ slots, effect: callback => callback() }) })
  assert.equal(typeof Workbench, 'function', 'apply must register the real main Workbench')
  async function settle() {
    for (let turn = 0; turn < 24; turn++) {
      if (dirty && !disposed) {
        dirty = false
        cursor = 0
        root = Workbench(props)
        while (effects.length) effects.shift()()
      }
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(dirty && !disposed, false, 'Workbench must settle without an effect loop')
  }
  function nodes(predicate, node = root, out = []) {
    if (!node || typeof node !== 'object') return out
    if (predicate(node)) out.push(node)
    for (const child of node.children || []) nodes(predicate, child, out)
    return out
  }
  function text(node = root) {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node !== 'object') return String(node)
    return (node.children || []).map(child => text(child)).join('')
  }
  function button(label) { const node = nodes(node => node.type === 'button' && text(node) === label)[0]; assert.ok(node, 'button: ' + label); return node }
  async function event(type, data) { for (const callback of listeners.get(type) || []) await callback(data); await settle() }
  async function receive(data, extra = {}) { await event('message', { source: frame.contentWindow, origin, data: { __pb: true, v: 2, ...data }, ...extra }) }
  async function choose(id) { await nodes(node => node.type === 'select')[0].props.onChange({ target: { value: id } }); await settle() }
  async function ask(requestId, question = '讲解这段选中的原文', extra = {}) {
    await receive({ type: 'paper-ask', requestId, text: question, scope: 'selection', paperId: reader.id, page: reader.page, sectionId: reader.sectionId, revision: reader.revision, ...extra })
  }
  async function dispose() {
    if (disposed) return
    disposed = true
    for (const hook of hooks) hook?.cleanup?.()
    await settle()
  }
  await settle()
  return { messages, calls, references, prompts, submissions, inputState, draftWrites, openedSessions, uploads, SessionProvider, settle, receive, choose, ask, event, nodes, text, button, dispose,
    nativeState: () => messages.filter(item => item.data.type === 'native-state').at(-1)?.data,
    result: id => messages.findLast(item => item.data.type === 'paper-result' && item.data.requestId === id)?.data,
  }
}

let passed = 0
async function check(name, run) { await run(); console.log('PASS  ' + name); passed++ }
async function withFixture(options, run) { const f = await fixture(options); try { await run(f) } finally { await f.dispose() } }

await check('registered Workbench mounts the exact retained native SessionProvider', async () => {
  await withFixture({}, async f => {
    assert.equal(f.references.length, 1)
    const provider = f.nodes(node => node.type === f.SessionProvider)[0]
    assert.ok(provider)
    assert.equal(provider.props.session, f.references[0].reference)
    assert.equal(f.references[0].options.source, 'controllerOperation')
    assert.equal(f.calls.some(call => /session\.ask|chat\./.test(call.method)), false)
  })
})

await check('native toggle immediately syncs open state without resetting paper focus', async () => {
  await withFixture({}, async f => {
    await f.receive({ type: 'reader-state', paper: reader })
    const focusCount = f.calls.filter(call => call.method === 'paper.context.set').length
    assert.equal(f.nativeState().open, true)
    await f.receive({ type: 'native-toggle' })
    assert.equal(f.nativeState().open, false)
    assert.ok(f.button('打开论文对话'))
    assert.equal(f.calls.filter(call => call.method === 'paper.context.set').length, focusCount)
    assert.equal(f.references[0].releases, 1)
    assert.equal(f.references[0].cancels, 0)
    await f.receive({ type: 'native-toggle' })
    assert.equal(f.nativeState().open, true)
    assert.equal(f.calls.filter(call => call.method === 'paper.context.set').length, focusCount)
  })
})

for (const returnToOriginal of [false, true]) {
  await check('queued paper-ask stays bound to receipt conversation during ' + (returnToOriginal ? 'A → B → A' : 'A → B'), async () => {
    const first = deferred()
    await withFixture({ prompt: async (call, index) => { if (index === 1) await first.promise; return { ok: true, value: { accepted: true } } } }, async f => {
      await f.receive({ type: 'reader-state', paper: reader })
      await f.ask('q1', 'first question for A')
      assert.equal(f.prompts.length, 1)
      await f.ask('q2', 'second question for A')
      assert.equal(f.prompts.length, 1, 'second request should wait for the first acknowledgement')
      await f.choose('b')
      if (returnToOriginal) await f.choose('a')
      first.resolve()
      await f.settle()
      assert.deepEqual(f.prompts.map(call => call.sessionId), ['session-a'])
      assert.equal(f.result('q1').ok, true)
      assert.equal(f.result('q2').ok, false)
      assert.match(f.result('q2').message, /切换/)
    })
  })
}

await check('prepare failure exposes a reconnect action that prepares before retaining', async () => {
  let prepareCount = 0
  await withFixture({ rpc: async (method, args, fallback) => {
    if (method === 'session.prepare' && ++prepareCount === 1) throw new Error('prepare unavailable')
    return fallback(method, args)
  } }, async f => {
    assert.match(f.text(), /prepare unavailable/)
    assert.equal(f.references.length, 0)
    await f.button('重连').props.onClick()
    await f.settle()
    assert.equal(prepareCount, 2)
    assert.equal(f.references.length, 1)
    assert.ok(f.nodes(node => node.type === f.SessionProvider)[0])
    assert.equal(f.prompts.length, 0)
  })
})

await check('unavailable paper scope is visible and blocks quick questions', async () => {
  await withFixture({ rpc: async (method, args, fallback) => {
    if (method === 'paper.context.set' || method === 'session.prepare') return { scope: { available: false, reason: 'scope marker missing' } }
    return fallback(method, args)
  } }, async f => {
    await f.receive({ type: 'reader-state', paper: reader })
    assert.match(f.text(), /scope marker missing/)
    assert.ok(f.nodes(node => node.props.role === 'status' && f.text(node).includes('scope marker missing')).length)
    await f.ask('scope-failed')
    assert.equal(f.result('scope-failed').ok, false)
    assert.match(f.result('scope-failed').message, /scope marker missing/)
    assert.equal(f.prompts.length, 0)
    assert.equal(f.submissions.length, 0)
  })
})

await check('full quick question queues once while preserving the native draft, chips and attachments', async () => {
  await withFixture({}, async f => {
    await f.receive({ type: 'reader-state', paper: reader })
    const before = json(f.inputState)
    const question = '  选段原文 $x^2$。\n'.repeat(350) + '  '
    await f.ask('long-question', question)
    await f.ask('long-question', question)
    assert.equal(f.result('long-question').ok, true)
    assert.equal(f.prompts.length, 1)
    assert.equal(f.prompts[0].content[0].text, question)
    assert.equal(f.prompts[0].mode, 'queue')
    assert.equal(f.prompts[0].requestId, f.submissions[0].requestId)
    assert.equal(f.submissions[0].text, question)
    assert.deepEqual(f.submissions[0].attachments, [])
    assert.deepEqual(f.inputState, before)
    assert.deepEqual(f.draftWrites, [])
  })
})

await check('paper links route to the reader while external links keep their default behavior', async () => {
  await withFixture({}, async f => {
    const body = f.nodes(node => node.props.className === 'pb-native-body')[0]
    function click(href) {
      const event = { prevented: false, stopped: false, target: { closest: () => ({ getAttribute: () => href }) },
        preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
      body.props.onClickCapture(event)
      return event
    }
    const internal = click('/paper-workbench/app?paper=paper-a&page=3&block=b-two&revision=r1')
    assert.equal(internal.prevented, true)
    assert.equal(internal.stopped, true)
    assert.deepEqual(f.messages.at(-1).data, { __pb: true, v: 2, type: 'reader-navigate', paperId: 'paper-a', page: 3, blockId: 'b-two', sectionId: '', revision: 'r1' })
    const count = f.messages.length
    assert.equal(click('https://outside.example/paper-workbench/app?paper=paper-a&page=3').prevented, false)
    assert.equal(click('/paper-workbench/app?paper=../outside&page=3').prevented, false)
    assert.equal(f.messages.length, count)
  })
})

await check('restored native conversation geometry is saved on pagehide', async () => {
  await withFixture({ stored: { open: false, width: 512, activeConv: 'b' } }, async f => {
    assert.equal(f.nativeState().open, false)
    assert.equal(f.nativeState().conversationId, 'b')
    assert.equal(f.references.length, 0)
    await f.event('pagehide', {})
    const save = f.calls.findLast(call => call.method === 'ui.set' && call.keepalive)
    assert.deepEqual(save.args.state.nativeChat, { open: false, width: 512, activeConv: 'b' })
  })
})

await check('library comparison associates all selected papers with the receipt conversation', async () => {
  await withFixture({ rpc: async (method, args, next) => method === 'library.list' ? { items: [reader, { id: 'paper-b', title: 'Paper B' }] } : next(method, args) }, async f => {
    await f.receive({ type: 'reader-state', paper: null })
    await f.ask('compare', 'Compare paper-a and paper-b', { scope: 'papers', paperId: null, paperIds: ['paper-a', 'paper-b'] })
    await f.settle()
    assert.equal(f.result('compare').ok, true)
    assert.deepEqual(f.calls.findLast(call => call.method === 'conv.update').args.paperIds, ['paper-a', 'paper-b'])
    assert.equal(f.prompts.at(-1).sessionId, conversations[0].sessionId)
    await f.ask('unknown', 'Compare arbitrary IDs', { scope: 'papers', paperIds: ['paper-a', 'unknown'] })
    await f.settle()
    assert.equal(f.result('unknown').ok, false)
    assert.equal(f.prompts.length, 1)
  })
})

await check('comparison refreshes newly imported papers and still rejects a switched conversation', async () => {
  let libraryCalls = 0
  const refresh = deferred()
  await withFixture({ rpc: async (method, args, next) => {
    if (method !== 'library.list') return next(method, args)
    libraryCalls++
    if (libraryCalls === 1) return { items: [reader] }
    if (libraryCalls === 3) await refresh.promise
    return { items: [reader, { id: 'paper-b', title: 'Newly imported B' }] }
  } }, async f => {
    await f.ask('fresh-library', 'Compare A with newly imported B', { scope: 'papers', paperId: null, paperIds: ['paper-a', 'paper-b'] })
    assert.equal(f.result('fresh-library')?.ok, true, 'new imports must be usable without remounting the Workbench')
    assert.equal(libraryCalls, 2)
    assert.equal(f.prompts.length, 1)
    await f.ask('switch-during-refresh', 'Compare A and B again', { scope: 'papers', paperId: null, paperIds: ['paper-a', 'paper-b'] })
    await f.choose('b')
    refresh.resolve()
    await f.settle()
    assert.equal(f.result('switch-during-refresh')?.ok, false)
    assert.match(f.result('switch-during-refresh').message, /切换/)
    assert.equal(f.prompts.length, 1, 'a library refresh must not retarget the queued question')
  })
})

await check('first paper ask auto-creates conversation when empty, opens full session, and deletes cleanly', async () => {
  await withFixture({
    stored: { open: true, width: 420, activeConv: null },
    rpc: async (method, args, next) => method === 'conv.list' ? { items: [], activeId: null } : next(method, args),
  }, async f => {
    assert.ok(f.button('开始论文对话'))
    await f.receive({ type: 'reader-state', paper: reader })
    await f.ask('first-auto', '总结这篇论文的核心贡献')
    assert.equal(f.result('first-auto')?.ok, true)
    assert.equal(f.prompts.at(-1).sessionId, 'pb-conv-created-1')
    await f.button('↗ 完整页').props.onClick()
    assert.deepEqual(f.openedSessions, ['pb-conv-created-1'])
    await f.button('⋯').props.onClick()
    await f.settle()
    await f.button('从工作台移除此对话').props.onClick()
    await f.settle()
    assert.ok(f.calls.some(c => c.method === 'conv.remove' && c.args.id === 'created-1'))
    assert.ok(f.references[0].releases >= 1)
  })
})

await check('oversized selection preserves full text, uploads native file receipt, and rejects failed upload safely', async () => {
  let uploadOk = false
  await withFixture({
    fileUpload: (uploads) => ({
      async upload(sessionId, file, name) {
        const content = await file.text()
        uploads.push({ sessionId, name, length: content.length })
        if (!uploadOk) return { ok: false, error: { message: 'file too large for model' } }
        return { ok: true, value: { receiptId: 'rcpt-native-1', file: { name, size: content.length } } }
      },
    }),
  }, async f => {
    await f.receive({ type: 'reader-state', paper: reader })
    const huge = '完整超长选段 $E=mc^2$\n'.repeat(2000)
    await f.ask('huge-q', huge)
    assert.equal(f.result('huge-q')?.ok, true)
    assert.equal(f.prompts.length, 0, 'oversized prompt waits for explicit attachment or inline action')
    await f.button('转为文本附件发送').props.onClick()
    await f.settle()
    assert.equal(f.prompts.length, 0, 'failed upload must never send an empty attachment')
    assert.match(f.text(), /file too large for model/)
    uploadOk = true
    await f.button('转为文本附件发送').props.onClick()
    await f.settle()
    assert.equal(f.uploads.at(-1).length, huge.length)
    assert.equal(f.uploads.at(-1).sessionId, 'session-a')
    assert.equal(f.prompts.length, 1)
    assert.equal(f.prompts[0].content[0].type, 'file')
    assert.equal(f.prompts[0].content[0].receiptId, 'rcpt-native-1')
  })
})

await check('legacy [p.N] citations route to unequivocally associated paper and refuse ambiguous multi-paper guesses', async () => {
  await withFixture({
    rpc: async (method, args, defaultRpc) => {
      if (method === 'conv.list') {
        return {
          activeId: 'a',
          items: [
            { id: 'a', sessionId: 'session-a', title: 'Single', paperIds: ['paper-a'] },
            { id: 'b', sessionId: 'session-b', title: 'Multi', paperIds: ['paper-a', 'paper-b'] },
          ],
        }
      }
      return defaultRpc(method, args)
    },
  }, async f => {
    const clickCode = label => {
      const body = f.nodes(node => node.props.className === 'pb-native-body')[0]
      body.props.onClickCapture({
        target: { closest: selector => selector === 'code' ? { textContent: label } : null },
        preventDefault() {},
        stopPropagation() {},
      })
    }
    clickCode('[p.7]')
    assert.equal(f.messages.at(-1).data.type, 'reader-navigate')
    assert.equal(f.messages.at(-1).data.paperId, 'paper-a')
    assert.equal(f.messages.at(-1).data.page, 7)

    // Multi-paper conversation without active reader or focus must refuse guessing; once Paper B is active in reader, [p.9] routes to Paper B
    await f.choose('b')
    const beforeCount = f.messages.filter(m => m.data.type === 'reader-navigate').length
    clickCode('[p.9]')
    await f.settle()
    assert.equal(f.messages.filter(m => m.data.type === 'reader-navigate').length, beforeCount)
    assert.match(f.text(), /多篇论文/)
    await f.receive({ type: 'reader-state', paper: { id: 'paper-b', title: 'Paper B', page: 2, sectionId: 's1', revision: 'rev-b' } })
    clickCode('[p.9]')
    assert.equal(f.messages.at(-1).data.paperId, 'paper-b')
    assert.equal(f.messages.at(-1).data.page, 9)
  })
})

console.log(`\nPASS ${passed} / FAIL 0`)
