#!/usr/bin/env node
/**
 * 接口冒烟测试：直接打 HTTP，覆盖面板真正会走的路径。
 *
 *   node scripts/smoke.mjs [baseUrl]
 *   默认 http://127.0.0.1:57571（scripts/dev-server.mjs）
 *   装进 DSH 后：node scripts/smoke.mjs http://127.0.0.1:57570
 *
 * 注意：会用样例 PDF 真正入库（写 ~/.dsh/paper-workbench），但不会往 Obsidian 写卡片。
 * v2 追加：段落模型（doc.*）、SSE 流式翻译与对话（ai.*）。没有可用模型时这几项退化为
 * 「路由活着 + 有中文错误提示」的检查，不会误报失败。
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:57571').replace(/\/+$/, '')
const API = BASE + '/paper-workbench/api/'
const STREAM = BASE + '/paper-workbench/ai/'
const SAMPLE = 'G:\\笔记\\LLM知识体系论文\\高效微调\\Prompt Tuning.pdf'

let pass = 0
let fail = 0

function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log('PASS  ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail += 1
    console.log('FAIL  ' + name + (detail ? '  ' + detail : ''))
  }
}

async function rpc(method, args = {}) {
  const response = await fetch(API + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const data = await response.json()
  if (!data.ok) throw new Error(method + '：' + data.error)
  return data.value
}

/** 读一条 SSE 流，按 `event:`/`data:` 切成事件数组。 */
async function sse(path, body, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(STREAM + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      const text = await response.text()
      throw new Error(path + ' HTTP ' + response.status + '：' + text.slice(0, 300))
    }
    const events = []
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        let event = 'message'
        let data = ''
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (data === '') continue
        let parsed = null
        try {
          parsed = JSON.parse(data)
        } catch {
          parsed = { raw: data }
        }
        events.push({ event, data: parsed })
      }
    }
    return events
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  console.log('BASE ' + BASE)

  const health = await rpc('health')
  check('health 返回插件信息', health.plugin === 'dsh-paper-workbench', 'phase=' + health.phase)
  check('PyMuPDF 可用', Boolean(health.pdf && health.pdf.ok), health.pdf && health.pdf.python)
  console.log('      vault: ' + (health.vault.ok ? health.vault.kb : health.vault.error))

  const imported = await rpc('library.importPath', { path: SAMPLE, topic: '高效微调' })
  check('导入本地 PDF', Boolean(imported.meta && imported.meta.id), 'id=' + (imported.meta && imported.meta.id))
  const id = imported.meta.id

  const list = await rpc('library.list')
  check('文献库列表包含刚导入的论文', list.items.some((item) => item.id === id), '共 ' + list.items.length + ' 篇')

  const detail = await rpc('library.get', { id })
  check('library.get 返回页数与文本标志', detail.meta.pageCount > 0, detail.meta.pageCount + ' 页')

  const text = await rpc('pdf.text', { id, pages: [1] })
  const blocks = (text.pages && text.pages[0] && text.pages[0].blocks) || []
  check('取第 1 页文本块', blocks.length > 0, blocks.length + ' 块')
  check('文本块带坐标与字号', blocks.length > 0 && blocks[0].x2 > blocks[0].x && blocks[0].size > 0)

  const search = await rpc('pdf.search', { id, query: 'prompt' })
  check('全文检索命中', search.hits.length > 0, search.hits.length + ' 处')

  const imageResponse = await fetch(API + 'page?id=' + encodeURIComponent(id) + '&page=1&scale=2')
  const imageBytes = Buffer.from(await imageResponse.arrayBuffer())
  check(
    '页面渲染返回 PNG',
    imageResponse.ok && imageBytes.subarray(1, 4).toString('latin1') === 'PNG',
    imageBytes.length + ' 字节',
  )

  const rawResponse = await fetch(API + 'raw?id=' + encodeURIComponent(id))
  const rawHead = Buffer.from((await rawResponse.arrayBuffer()).slice(0, 5)).toString('latin1')
  check('原始 PDF 端点可用', rawResponse.ok && rawHead === '%PDF-', rawHead)

  await rpc('notes.save', {
    id,
    highlights: [{ page: 1, text: '冒烟测试高亮', note: '', rects: [], color: 'note' }],
  })
  const notes = await rpc('notes.get', { id })
  check('高亮笔记写入并读回', notes.highlights.length === 1, notes.highlights.length + ' 条')

  const online = await rpc('search.online', { query: 'prompt tuning', source: 'arxiv', limit: 2 }).catch((error) => ({ error }))
  check('在线检索（arXiv）', Boolean(online.items && online.items.length > 0), online.error ? String(online.error.message) : (online.items || []).length + ' 条')

  const vault = await rpc('vault.status')
  check('Obsidian 论文知识库可识别', vault.ok === true, vault.ok ? vault.cards + ' 张卡片' : vault.error)

  // ── v2：段落模型 / 流式翻译 / 侧边对话 ─────────────────────────────
  const docValue = await rpc('doc.get', { id }).catch((error) => ({ error }))
  const doc = docValue.doc
  check(
    'doc.get 产出段落模型',
    Boolean(doc && Array.isArray(doc.paragraphs) && doc.paragraphs.length > 0),
    docValue.error ? String(docValue.error.message) : (doc.sections || []).length + ' 节 / ' + doc.paragraphs.length + ' 段 / 来源 ' + doc.source,
  )
  check(
    '段落 hash 为 16 位十六进制',
    Boolean(doc && doc.paragraphs[0] && /^[0-9a-f]{16}$/.test(doc.paragraphs[0].hash)),
    doc && doc.paragraphs[0] && doc.paragraphs[0].hash,
  )
  check(
    '每段都归属到某一节',
    Boolean(doc) && (doc.paragraphs || []).every((item) => typeof item.section === 'string'),
    doc ? (doc.paragraphs || []).filter((item) => !item.section).length + ' 段未归属' : '',
  )

  const aiModels = await rpc('ai.models').catch((error) => ({ error }))
  check(
    'ai.models 返回 provider/模型清单',
    Boolean(!aiModels.error && Array.isArray(aiModels.providers) && Array.isArray(aiModels.models)),
    aiModels.error ? String(aiModels.error.message) : (aiModels.providers || []).length + ' provider / ' + (aiModels.models || []).length + ' model',
  )
  check(
    'ai.models 带 ready 与原因',
    Boolean(!aiModels.error && typeof aiModels.ready === 'boolean'),
    aiModels.ready === undefined ? '' : 'ready=' + aiModels.ready + (aiModels.reason ? '（' + aiModels.reason + '）' : ''),
  )

  const aiSettings = await rpc('ai.settings.get').catch((error) => ({ error }))
  check(
    'ai.settings.get 返回 ai 配置',
    Boolean(!aiSettings.error && aiSettings.config && aiSettings.config.ai),
    aiSettings.error ? String(aiSettings.error.message) : JSON.stringify(aiSettings.config && aiSettings.config.ai),
  )

  // 划词翻译（ad-hoc）：只翻传进去的这一小段，且不写 trans.json、不进 chat.json
  const healthValue = await rpc('health').catch(() => ({}))
  check(
    'health 声明支持 ad-hoc 划词翻译',
    Boolean(healthValue && healthValue.ai && healthValue.ai.adhoc === true),
    healthValue && healthValue.ai ? 'adhoc=' + String(healthValue.ai.adhoc) : '没有 ai 段',
  )
  const transBefore = await rpc('trans.get', { id }).catch(() => ({ entries: {} }))
  const adhocEvents = await sse('translate', { id, text: 'Smoke test sentence about prompt tuning.', reqId: 'smoke-adhoc' }).catch(
    (error) => [{ event: 'error', data: { message: String(error.message) } }],
  )
  const adhocDone = adhocEvents.find((item) => item.event === 'done')
  const adhocEnd = [...adhocEvents].reverse().find((item) => item.event === 'end')
  check(
    '划词翻译走一次性通道并返回译文',
    Boolean(adhocDone && adhocDone.data.key === 'selection' && String(adhocDone.data.text || '').length > 0),
    adhocDone
      ? 'key=' + adhocDone.data.key + ' 长度 ' + String(adhocDone.data.text || '').length
      : JSON.stringify(adhocEvents[0] && adhocEvents[0].data),
  )
  check('划词翻译 end.ok', Boolean(adhocEnd && adhocEnd.data && adhocEnd.data.ok === true), adhocEnd ? JSON.stringify(adhocEnd.data) : '没有 end')
  const transAfter = await rpc('trans.get', { id }).catch(() => ({ entries: {} }))
  check(
    '划词翻译不写 trans.json',
    Object.keys(transAfter.entries || {}).length === Object.keys(transBefore.entries || {}).length,
    Object.keys(transBefore.entries || {}).length + ' → ' + Object.keys(transAfter.entries || {}).length,
  )

  // 界面状态：存服务端，桌面端重启换端口也能回到原处
  const uiSet = await rpc('ui.set', { state: { paperId: id, tab: 'compare', page: 2, scrollTop: 120 } }).catch((error) => ({ error }))
  check('ui.set 写入界面状态', Boolean(!uiSet.error && uiSet.ok), uiSet.error ? String(uiSet.error.message) : JSON.stringify(uiSet.state))
  const uiGet = await rpc('ui.get').catch((error) => ({ error }))
  check(
    'ui.get 读回同一份界面状态',
    Boolean(!uiGet.error && uiGet.state && uiGet.state.paperId === id && uiGet.state.page === 2),
    uiGet.error ? String(uiGet.error.message) : JSON.stringify(uiGet.state),
  )

  // 只翻一个正文段：够验证链路，又不会让冒烟测试跑很久
  const samplePara = (doc && (doc.paragraphs || []).find((item) => item.kind === 'body')) || null
  const translateEvents = await sse('translate', { id, keys: samplePara ? [samplePara.hash] : [], reqId: 'smoke-translate' }).catch(
    (error) => [{ event: 'error', data: { message: String(error.message) } }],
  )
  const translateNames = translateEvents.map((item) => item.event)
  const translateErrors = translateEvents.filter((item) => item.event === 'error')
  const translateDone = translateEvents.filter((item) => item.event === 'done')
  const translateEnd = translateEvents.find((item) => item.event === 'end')
  if (translateDone.length > 0) {
    check('翻译走 SSE 并逐段下发 done', translateDone.length > 0, translateDone.length + ' 段' + (translateEnd ? '，end ok=' + translateEnd.data.ok : ''))
    check(
      '翻译事件序列完整（start/done/end）',
      ['start', 'done', 'end'].every((name) => translateNames.includes(name)),
      'delta ' + translateNames.filter((name) => name === 'delta').length + ' 个',
    )
    const transValue = await rpc('trans.get', { id })
    const doneKey = translateDone[0].data && translateDone[0].data.key
    check(
      '译文写进 trans.json',
      Boolean(transValue.entries && transValue.entries[doneKey]),
      '共 ' + Object.keys(transValue.entries || {}).length + ' 条',
    )
    if (doneKey) {
      await rpc('trans.clear', { id, keys: [doneKey] })
      const after = await rpc('trans.get', { id })
      check('trans.clear 只删指定 key', !after.entries[doneKey], '剩 ' + Object.keys(after.entries || {}).length + ' 条')
    }
  } else {
    // 没有可用模型：只要路由活着、给出可读的中文原因就算通过
    check(
      '翻译路由可用（无模型时给中文提示）',
      translateErrors.length > 0 && typeof translateErrors[0].data.message === 'string' && translateErrors[0].data.message.length > 4,
      translateErrors.length > 0 ? translateErrors[0].data.message : translateNames.join(',') || '没有任何事件',
    )
  }

  const chatEvents = await sse('chat', {
    id,
    messages: [{ role: 'user', content: '用一句话概括这篇论文的研究问题。' }],
    scope: 'paper',
    reqId: 'smoke-chat',
  }).catch((error) => [{ event: 'error', data: { message: String(error.message) } }])
  const chatDone = chatEvents.find((item) => item.event === 'done')
  const chatDelta = chatEvents.filter((item) => item.event === 'delta')
  const chatEnd = chatEvents.find((item) => item.event === 'end')
  if (chatDone) {
    check('侧边对话走 SSE（delta 增量 + done + end）', chatDelta.length > 0 && Boolean(chatEnd), chatDelta.length + ' 个增量')
    check('对话回答非空', String(chatDone.data.text || '').length > 0, String(chatDone.data.text || '').slice(0, 40))
    const chatValue = await rpc('chat.get', { id })
    check('chat.get 返回消息数组', Array.isArray(chatValue.messages), (chatValue.messages || []).length + ' 条')
  } else {
    const chatError = chatEvents.find((item) => item.event === 'error')
    check(
      '对话路由可用（无模型时给中文提示）',
      Boolean(chatError) && typeof chatError.data.message === 'string' && chatError.data.message.length > 4,
      chatError ? chatError.data.message : chatEvents.map((item) => item.event).join(',') || '没有任何事件',
    )
  }

  const cancel = await fetch(STREAM + 'cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reqId: 'smoke-nonexistent' }),
  })
    .then((response) => response.json())
    .catch((error) => ({ ok: false, error: String(error.message) }))
  check('ai/cancel 对未知 reqId 返回可读错误', cancel.ok === false && typeof cancel.error === 'string', cancel.error)

  await rpc('library.remove', { id })
  const after = await rpc('library.list')
  check('删除后列表不再包含', !after.items.some((item) => item.id === id))

  console.log('')
  console.log('结果：PASS ' + pass + ' / FAIL ' + fail)
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('冒烟测试异常：' + (error && error.stack ? error.stack : error))
  process.exitCode = 1
})
