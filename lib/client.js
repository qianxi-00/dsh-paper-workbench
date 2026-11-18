/**
 * 论文工作台的宿主布局：左侧阅读 iframe（reader-only） + 右侧 DSH 原生 conversation.content。
 * 会话历史、输入框、模型、思考程度、工具、权限、附件与队列均由宿主原生组件管理；
 * 插件仅负责论文范围关联、阅读定位同步、快捷提问投递与引用跳回。
 */
window.__ModuleLoader__.load({
  id: 'dsh-paper-workbench',
  factory: function (require) {
    'use strict'
    const React = require('react')
    const PANEL_ID = 'paper-workbench'
    const NATIVE_SLOT = 'paper-workbench.native'
    const APP_URL = '/paper-workbench/app?embed=1&native=1'
    const DEFAULT_WIDTH = 420
    const MIN_WIDTH = 320
    const MAX_WIDTH = 1200
    const MAX_INLINE_PROMPT_CHARS = 24000
    let clientCtx = null
    let slotMountError = ''

    function PanelIcon(props) {
      return React.createElement('svg', {
        width: props.size || 16, height: props.size || 16, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, 'data-dsh-panel-entry': PANEL_ID,
      }, React.createElement('path', { d: 'M4.5 1.5h5l3 3v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z M9.5 1.5v3h3 M9.6 8v4.6l1.2-.8 1.2.8V8z M5.5 8.5h2 M5.5 11h2' }))
    }

    async function rpc(method, args = {}) {
      const response = await fetch('/paper-workbench/api/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
      })
      const result = await response.json()
      if (!response.ok || result.ok === false) throw new Error(result.error?.message || result.error || '请求失败：' + method)
      return result.value ?? result
    }

    /** 引用只属于当前选定代次；收起或卸载视图仅 release 引用，绝不取消后台运行中的 Agent。 */
    function createNativeSessionBinding({ sessions, onState }) {
      let current = null
      let generation = 0
      function release(record) {
        if (!record || record.released) return
        record.released = true
        try { record.reference.release() } catch { /* 兼容旧宿主重复释放 */ }
      }
      function currentSessionId() {
        return current && !current.released ? current.sessionId : null
      }
      function select(rawId) {
        const sessionId = String(rawId || '').trim()
        if (!sessionId) { close(); return Promise.resolve(null) }
        if (current && current.sessionId === sessionId && !current.released) {
          if (current.ready) onState({ sessionId, reference: current.reference, loading: false, error: '' })
          return current.opening
        }
        const epoch = ++generation
        release(current)
        current = null
        onState({ sessionId, reference: null, loading: true, error: '' })
        let reference
        try { reference = sessions.retain(sessionId, { source: 'controllerOperation' }) }
        catch (error) {
          onState({ sessionId, reference: null, loading: false, error: error.message || String(error) })
          return Promise.resolve(null)
        }
        const record = { sessionId, reference, ready: false, released: false, opening: null }
        current = record
        record.opening = Promise.resolve(reference.ready).then(binding => {
          if (epoch !== generation || current !== record) return null
          if (binding !== reference.binding) throw new Error('会话引用代次不一致')
          record.ready = true
          onState({ sessionId, reference, loading: false, error: '' })
          return reference
        }).catch(error => {
          if (epoch !== generation || current !== record) return null
          release(record)
          current = null
          onState({ sessionId, reference: null, loading: false, error: error.message || String(error) })
          return null
        })
        return record.opening
      }
      function close() {
        generation += 1
        release(current)
        current = null
        onState({ sessionId: null, reference: null, loading: false, error: '' })
      }
      function submit(text, expectedSessionId, extra = {}) {
        if (!current || !current.ready || current.released) throw new Error('会话尚未就绪')
        if (expectedSessionId && current.sessionId !== expectedSessionId) throw new Error('对话已切换，请重新提问')
        if (typeof text !== 'string' || !text.trim()) throw new Error('问题是空的')
        const session = current.reference.binding?.session
        if (!session || typeof session.beginSubmission !== 'function' || typeof session.prompt !== 'function') {
          throw new Error('当前 DSH 版本的会话对象缺少提交接口（beginSubmission / prompt）')
        }
        const pendingAttachments = Array.isArray(extra.pendingAttachments) ? extra.pendingAttachments : []
        const contentParts = Array.isArray(extra.contentParts) && extra.contentParts.length
          ? extra.contentParts
          : [{ type: 'text', text }]
        const submission = session.beginSubmission({ mode: 'queue', text, attachments: pendingAttachments })
        // beginSubmission 仅建立原生队列回显；prompt 才把同一 requestId 发到宿主，且不触碰输入框草稿。
        return Promise.resolve().then(() => session.prompt(contentParts, 'queue', undefined, submission.requestId)).then(result => {
          if (!result || result.ok !== true) {
            if (typeof submission?.abandon === 'function') { try { submission.abandon() } catch {} }
            throw new Error(result?.error?.message || '发送未确认，请查看原生会话中的状态后再操作')
          }
          return { requestId: submission.requestId, ...result.value }
        }, error => {
          if (typeof submission?.abandon === 'function') { try { submission.abandon() } catch {} }
          throw error
        })
      }
      return { select, close, submit, currentSessionId }
    }

    function isReaderMessage(event, frame, origin) {
      return !!frame && event.source === frame.contentWindow && event.origin === origin &&
        event.data?.__pb === true && event.data.v === 2 &&
        ['reader-state', 'paper-ask', 'native-toggle'].includes(event.data.type)
    }

    function parsePaperLink(href, origin) {
      if (!href || typeof href !== 'string') return null
      let url
      try { url = new URL(href, origin) } catch { return null }
      if (url.origin !== origin || url.pathname !== '/paper-workbench/app') return null
      const paperId = url.searchParams.get('paper') || ''
      const page = Number(url.searchParams.get('page') || 1)
      if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(paperId) || !Number.isInteger(page) || page < 1 || page > 100000) return null
      return {
        paperId,
        page,
        blockId: (url.searchParams.get('block') || '').slice(0, 200),
        sectionId: (url.searchParams.get('section') || '').slice(0, 100),
        revision: (url.searchParams.get('revision') || '').slice(0, 100),
      }
    }

    /** 兼容历史对话里的旧式页码引用（如 `?page=5`、`#p.5` 或 `[p.5]` 标签）。 */
    function parseLegacyPageCitation(href, label) {
      const text = String(label || '').trim()
      const bracketMatch = /^\[?\s*(?:p\.?\s*|第\s*)(\d{1,5})\s*(?:页)?\s*\]?$/i.exec(text)
      if (bracketMatch) {
        const page = Number(bracketMatch[1])
        if (Number.isInteger(page) && page >= 1) return page
      }
      if (typeof href === 'string' && href) {
        const hashMatch = /^(?:#|\?)(?:p\.?|page=)(\d{1,5})$/i.exec(href.trim())
        if (hashMatch) {
          const page = Number(hashMatch[1])
          if (Number.isInteger(page) && page >= 1) return page
        }
      }
      return null
    }

    function detectVoiceCapability() {
      try {
        const entries = window.__DSH_BOOT__?.entries
        if (Array.isArray(entries) && entries.some(item => /voice|speech|dictat|stt|asr|whisper/i.test(String(item?.id || '')))) {
          return { installed: true, text: '已检测到宿主语音模块，可直接使用原生输入框的语音入口。' }
        }
      } catch {}
      return { installed: false, text: '当前宿主未安装或未启用语音输入插件（本工作台不额外接入付费语音服务）。' }
    }

    function NativeConversation(props) {
      const session = typeof props.useSession === 'function' ? props.useSession(value => value) : null
      const conversation = typeof props.useConversation === 'function' ? props.useConversation(value => value) : null
      const summaryBlank = typeof props.useSessions === 'function' ? props.useSessions(value => value?.byId?.[props.sessionId]?.blank) : undefined
      if (typeof props.renderFactorySlot !== 'function') {
        return React.createElement('div', { className: 'pb-native-empty', role: 'status' },
          '当前 DSH 版本未暴露 renderFactorySlot 接口，无法挂载原生 conversation.content。')
      }
      const activeCount = conversation?.activeTargets && typeof conversation.activeTargets.size === 'number' ? conversation.activeTargets.size : 0
      const active = !!session && (activeCount > 0 || !session.blank && !session.awaitingFirstTurn || session.running)
      const blank = !active && !session?.promptAttempted
      const settling = blank && session?.openState === 'loading' && summaryBlank !== true
      const hero = blank && (session?.openState === 'open' || summaryBlank === true)
      return props.renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : hero ? 'hero' : 'active',
        hero,
      })
    }

    const CSS = `
      .pb-native-workbench{display:flex;position:relative;width:100%;height:100%;min-height:0;min-width:0;background:var(--dsw-alias-bg-base, #14161a);color:var(--dsw-alias-label-primary, #e5e7eb)}
      .pb-native-reader{flex:1;min-width:0;min-height:0;border:0;height:100%;display:block}
      .pb-native-aside{display:flex;flex-direction:column;position:relative;flex:none;min-width:0;min-height:0;height:100%;border-left:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));background:var(--dsw-alias-bg-base, #14161a)}
      .pb-native-header{display:flex;flex-direction:column;gap:7px;padding:8px 11px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));font-size:12.5px;background:var(--dsw-alias-bg-layer-1, rgba(128,128,128,.04))}
      .pb-native-row{display:flex;align-items:center;gap:5px;width:100%;min-width:0}
      .pb-native-row select{flex:1;min-width:90px;max-width:100%;height:28px;padding:0 8px;border-radius:7px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base, transparent);border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24))}
      .pb-native-header button,.pb-native-empty button,.pb-native-opener,.pb-native-capabilities button,.pb-native-oversized button{font:inherit;color:inherit;background:var(--dsw-alias-bg-base, transparent);border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24));border-radius:7px;padding:4px 8px;cursor:pointer;line-height:1.35;white-space:nowrap;transition:background .12s,border-color .12s}
      .pb-native-header button:hover:not(:disabled),.pb-native-empty button:hover:not(:disabled),.pb-native-opener:hover,.pb-native-capabilities button:hover,.pb-native-oversized button:hover{background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))}
      .pb-native-header button:disabled,.pb-native-oversized button:disabled{opacity:.42;cursor:default}
      .pb-native-btn-primary{background:color-mix(in srgb,var(--dsw-alias-brand-primary, #2563eb) 14%,transparent)!important;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary, #2563eb) 42%,transparent)!important;font-weight:500}
      .pb-native-btn-danger{color:#ef4444!important;border-color:rgba(239,68,68,.35)!important}
      .pb-native-header button:focus-visible,.pb-native-row select:focus-visible,.pb-native-handle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, #2563eb);outline-offset:1px}
      .pb-native-scope{display:flex;align-items:center;gap:5px;flex-wrap:wrap;width:100%;font-size:12px;color:var(--dsw-alias-label-secondary, #9ca3af)}
      .pb-native-chip{display:inline-flex;align-items:center;max-width:100%;border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));border-radius:999px;background:var(--dsw-alias-bg-base, transparent);overflow:hidden}
      .pb-native-chip button{border:0!important;border-radius:0!important;padding:2px 7px!important;font-size:11.5px;background:transparent}
      .pb-native-chip-label{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pb-native-chip-remove{padding:2px 6px!important;color:var(--dsw-alias-label-secondary, #9ca3af)!important;border-left:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))!important}
      .pb-native-body{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}
      .pb-native-body>div{min-height:0}
      .pb-native-empty{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:28px 20px;line-height:1.65;font-size:13.5px;color:var(--dsw-alias-label-secondary, #9ca3af)}
      .pb-native-handle{position:absolute;z-index:12;width:8px;left:-4px;top:0;bottom:0;cursor:col-resize;touch-action:none}
      .pb-native-handle:hover,.pb-native-handle:focus-visible{background:color-mix(in srgb,var(--dsw-alias-brand-primary, #2563eb) 28%,transparent)}
      .pb-native-opener{position:absolute;right:18px;bottom:18px;z-index:15;font-size:12.5px;padding:6px 14px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.16)}
      .pb-native-toast{position:absolute;z-index:30;bottom:20px;left:50%;transform:translateX(-50%);max-width:calc(100% - 40px);padding:9px 14px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));border-radius:9px;background:var(--dsw-alias-bg-overlay, #1f242d);color:var(--dsw-alias-label-primary, #f3f4f6);font-size:12.5px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.22)}
      .pb-native-capabilities,.pb-native-oversized{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary, #9ca3af);padding:7px 11px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));background:var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05))}
      .pb-native-cap-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    `

    function Workbench(props) {
      const rootRef = React.useRef(null)
      const frameRef = React.useRef(null)
      const controllerRef = React.useRef(null)
      const alive = React.useRef(true)
      const latest = React.useRef({})
      const [ui, setUi] = React.useState({ open: true, width: DEFAULT_WIDTH, activeConv: null })
      const [ready, setReady] = React.useState(false)
      const [list, setList] = React.useState([])
      const [papers, setPapers] = React.useState([])
      const [reader, setReader] = React.useState(null)
      const [native, setNative] = React.useState({ reference: null, loading: false, error: '' })
      const [toast, setToast] = React.useState('')
      const [details, setDetails] = React.useState(false)
      const [oversized, setOversized] = React.useState(null)
      const [containerWidth, setContainerWidth] = React.useState(1200)
      const [busy, setBusy] = React.useState(false)
      const [retry, setRetry] = React.useState(0)
      const focusQueue = React.useRef(Promise.resolve())
      const navigation = React.useRef(0)
      const selectionVersion = React.useRef(0)
      const [scope, setScope] = React.useState({ available: false, reason: '正在连接论文范围…' })
      const selected = list.find(item => item.id === ui.activeConv) || null
      latest.current = { ui, list, papers, reader, selected }
      const post = data => frameRef.current?.contentWindow?.postMessage({ __pb: true, v: 2, ...data }, window.location.origin)
      const showError = error => { if (alive.current) setToast(error?.message || String(error)) }

      function setFocus(conv, paper) {
        const request = {
          conversationId: conv.id,
          paperId: paper && conv.paperIds.includes(paper.id) ? paper.id : null,
          page: paper?.page || 1,
          sectionId: paper?.sectionId || null,
          blockId: paper?.blockId || null,
          revision: paper?.revision || null,
        }
        const result = focusQueue.current.catch(() => {}).then(() => rpc('paper.context.set', request))
        focusQueue.current = result
        return result.then(value => {
          if (alive.current) {
            if (value && Object.hasOwn(value, 'paperContext')) {
              setList(previous => previous.map(item => item.id === conv.id ? { ...item, paperContext: value.paperContext } : item))
            }
            if (latest.current.ui.activeConv === conv.id) {
              setScope(value.scope || { available: false, reason: '宿主未返回论文范围状态' })
            }
          }
          return value
        })
      }

      function replaceConversation(conv) {
        setList(previous => [conv, ...previous.filter(item => item.id !== conv.id)])
      }

      async function selectConversation(id) {
        const conv = latest.current.list.find(item => item.id === id)
        if (!conv) return
        navigation.current += 1
        selectionVersion.current += 1
        setOversized(null)
        controllerRef.current?.close()
        setScope({ available: false, reason: '正在连接论文范围…' })
        setUi(previous => ({ ...previous, activeConv: id, open: true }))
        await rpc('conv.active', { id })
      }

      async function createConversation(initialIds) {
        setBusy(true)
        try {
          const paper = latest.current.reader
          const paperIds = Array.isArray(initialIds) ? initialIds : (paper ? [paper.id] : [])
          const title = paper && paperIds.includes(paper.id) ? '《' + paper.title + '》的对话' : '论文对话'
          const conv = await rpc('conv.create', { title, paperIds })
          if (!alive.current) return null
          navigation.current += 1
          selectionVersion.current += 1
          setOversized(null)
          controllerRef.current?.close()
          replaceConversation(conv)
          setScope({ available: false, reason: '正在连接论文范围…' })
          setUi(previous => ({ ...previous, activeConv: conv.id, open: true }))
          return conv
        } catch (error) {
          showError(error)
          return null
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      async function removeCurrentConversation() {
        const conv = latest.current.selected
        if (!conv) return
        setBusy(true)
        try {
          await rpc('conv.remove', { id: conv.id })
          if (!alive.current) return
          navigation.current += 1
          selectionVersion.current += 1
          setOversized(null)
          controllerRef.current?.close()
          const remaining = latest.current.list.filter(item => item.id !== conv.id)
          const nextId = remaining[0]?.id || null
          setList(remaining)
          setDetails(false)
          setScope({ available: false, reason: nextId ? '正在连接论文范围…' : '尚未选择对话' })
          setUi(previous => ({ ...previous, activeConv: nextId }))
          setToast('已从工作台移除该对话（DSH 原生历史未删除）')
        } catch (error) {
          showError(error)
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      function openFullSession() {
        const conv = latest.current.selected
        if (!conv) return
        try {
          const workspaceNav = clientCtx?.get?.('uiWorkspace')
          if (workspaceNav && typeof workspaceNav.openSession === 'function') {
            workspaceNav.openSession(conv.sessionId)
            return
          }
          const layout = clientCtx?.get?.('layout')
          if (layout && typeof layout.selectPanel === 'function') {
            layout.selectPanel('conversation')
            setToast('已切到会话主面板，可在「论文」工作区查看同一条会话')
            return
          }
        } catch (error) {
          showError(error)
          return
        }
        setToast('当前宿主未提供面板跳转接口，请在左侧「论文」工作区打开 ' + conv.title)
      }

      function openPluginSettings() {
        try {
          const layout = clientCtx?.get?.('layout')
          if (layout && typeof layout.selectPanel === 'function') {
            try { layout.selectPanel('plugin-market'); return } catch {}
            layout.selectPanel('settings')
            return
          }
        } catch {}
        setToast('请在 DSH 左下角「设置 → 插件」查看或启用语音等扩展能力')
      }

      async function updatePapers(ids) {
        const conv = latest.current.selected
        if (!conv) return
        setBusy(true)
        try {
          const next = await rpc('conv.update', { id: conv.id, paperIds: ids })
          if (!alive.current) return
          replaceConversation(next)
          await setFocus(next, latest.current.reader)
        } catch (error) { showError(error) }
        finally { if (alive.current) setBusy(false) }
      }

      /** 将超长选段转为目标会话的真实原生文件上传回执（绝不伪造或跨会话复用）；无原生上传服务时退回会话本地附件。 */
      async function sendOversizedAsAttachment(item) {
        if (!item) return
        const conv = latest.current.selected
        if (!conv || conv.id !== item.conversationId) {
          setOversized(null)
          showError(new Error('对话已切换，请重新选择原文提问'))
          return
        }
        const convId = conv.id
        const versionAtStart = selectionVersion.current
        const stillActive = () =>
          alive.current &&
          latest.current.ui.open &&
          latest.current.ui.activeConv === convId &&
          selectionVersion.current === versionAtStart
        setBusy(true)
        try {
          await rpc('session.prepare', { conversationId: conv.id })
          if (!stillActive()) {
            if (alive.current && !latest.current.ui.open) controllerRef.current?.close()
            throw new Error('对话状态已变化，请重新确认发送')
          }
          const controller = controllerRef.current
          if (!controller) throw new Error('当前宿主没有原生会话控制器')
          const reference = await controller.select(conv.sessionId)
          if (!reference || !stillActive()) {
            if (alive.current && !latest.current.ui.open) controller.close()
            throw new Error('原生会话尚未就绪或已切换')
          }
          const fileName = (item.paperId || 'paper') + '-p' + (item.page || 1) + '-excerpt.md'
          const uploader = clientCtx?.get?.('fileUpload')
          if (uploader && typeof uploader.upload === 'function' && typeof File === 'function') {
            const fileObj = new File([item.text], fileName, { type: 'text/markdown' })
            const uploaded = await uploader.upload(conv.sessionId, fileObj, fileName)
            if (!stillActive()) {
              if (alive.current && !latest.current.ui.open) controller.close()
              throw new Error('对话已切换，未发送旧上传回执')
            }
            if (!uploaded || uploaded.ok !== true || !uploaded.value?.receiptId) {
              throw new Error('原生附件上传失败：' + (uploaded?.error?.message || '未取得有效上传回执，未发送空附件'))
            }
            const summaryPrompt = item.headerPrompt || ('请结合随附的完整选段文件（' + fileName + '，共 ' + item.text.length + ' 字）进行深入讲解，并标注原文页码引用。')
            const pending = uploaded.value.file ? [{ type: 'file', value: uploaded.value.file }] : []
            await controller.submit(summaryPrompt, conv.sessionId, {
              pendingAttachments: pending,
              contentParts: [{ type: 'file', receiptId: uploaded.value.receiptId }, { type: 'text', text: summaryPrompt }],
            })
            if (alive.current) {
              setOversized(null)
              setToast('已将完整选段作为原生附件发送到当前会话')
            }
            return
          }
          // 旧版宿主无客户端 fileUpload 服务：落盘为当前对话关联文件并刷新上下文后提问
          const encoded = btoa(unescape(encodeURIComponent(item.text)))
          const attached = await rpc('conv.attach', { id: conv.id, name: fileName, dataBase64: encoded })
          if (attached?.conversation && alive.current) replaceConversation(attached.conversation)
          await setFocus(attached?.conversation || conv, latest.current.reader)
          if (!stillActive()) {
            if (alive.current && !latest.current.ui.open) controller.close()
            throw new Error('对话已切换，请重新发送')
          }
          const fallbackPrompt = '我已将完整选段（共 ' + item.text.length + ' 字）保存为本次对话附件「' + (attached?.attachment?.name || fileName) + '」，请用文件工具读取完整内容后深入讲解。'
          await controller.submit(fallbackPrompt, conv.sessionId)
          if (alive.current) {
            setOversized(null)
            setToast('已保存为对话本地资料并发送提问')
          }
        } catch (error) {
          showError(error)
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      async function sendOversizedInline(item) {
        if (!item) return
        const conv = latest.current.selected
        if (!conv || conv.id !== item.conversationId) {
          setOversized(null)
          showError(new Error('对话已切换，请重新提问'))
          return
        }
        const convId = conv.id
        const versionAtStart = selectionVersion.current
        const stillActive = () =>
          alive.current &&
          latest.current.ui.open &&
          latest.current.ui.activeConv === convId &&
          selectionVersion.current === versionAtStart
        setBusy(true)
        try {
          await rpc('session.prepare', { conversationId: conv.id })
          if (!stillActive()) {
            if (alive.current && !latest.current.ui.open) controllerRef.current?.close()
            throw new Error('对话状态已变化，请重新确认发送')
          }
          const controller = controllerRef.current
          if (!controller) throw new Error('当前宿主没有原生会话控制器')
          const reference = await controller.select(conv.sessionId)
          if (!reference || !stillActive()) {
            if (alive.current && !latest.current.ui.open) controller.close()
            throw new Error('原生会话尚未就绪或已切换')
          }
          await controller.submit(item.text, conv.sessionId)
          if (alive.current) {
            setOversized(null)
            setToast('已完整发送到当前原生会话')
          }
        } catch (error) {
          showError(error)
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      React.useEffect(function () {
        alive.current = true
        Promise.all([rpc('conv.list'), rpc('ui.get'), rpc('library.list')]).then(([chats, stored, library]) => {
          if (!alive.current) return
          const saved = stored.state?.nativeChat || {}
          const activeConv = chats.items.some(item => item.id === saved.activeConv) ? saved.activeConv : chats.activeId
          setList(chats.items)
          setPapers(library.items)
          setUi({ open: saved.open !== false, width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(saved.width) || DEFAULT_WIDTH)), activeConv })
          setReady(true)
        }).catch(showError)
        return function () {
          alive.current = false
          controllerRef.current?.close()
          controllerRef.current = null
        }
      }, [])

      React.useEffect(function () {
        if (controllerRef.current) return
        if (slotMountError) {
          setNative({ reference: null, error: slotMountError, loading: false })
          return
        }
        const sessions = clientCtx?.get?.('sessions')
        if (!sessions || typeof sessions.retain !== 'function') {
          setNative({ reference: null, error: '当前 DSH 版本没有公开 sessions.retain 服务，无法挂载原生会话', loading: false })
          return
        }
        controllerRef.current = createNativeSessionBinding({ sessions, onState: value => { if (alive.current) setNative(value) } })
      }, [retry])

      React.useEffect(function () {
        if (!ready) return
        const timer = window.setTimeout(() => rpc('ui.set', { state: { nativeChat: ui } }).catch(showError), 250)
        return () => window.clearTimeout(timer)
      }, [ready, ui])

      // pagehide 时持久化最后一次右栏几何与活动会话；草稿与消息由 DSH 原生管理。
      React.useEffect(function () {
        const save = () => {
          if (ready) fetch('/paper-workbench/api/ui.set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: { nativeChat: latest.current.ui } }),
            keepalive: true,
          }).catch(() => {})
        }
        window.addEventListener('pagehide', save)
        return () => { window.removeEventListener('pagehide', save); save() }
      }, [ready])

      React.useEffect(function () {
        const controller = controllerRef.current
        if (!ready || !controller) return
        const epoch = ++navigation.current
        if (!ui.open || !selected) { controller.close(); return }
        if (controller.currentSessionId() && controller.currentSessionId() !== selected.sessionId) {
          controller.close()
        }
        if (controller.currentSessionId() !== selected.sessionId) {
          setNative({ reference: null, sessionId: selected.sessionId, loading: true, error: '' })
        }
        rpc('session.prepare', { conversationId: selected.id }).then(value => {
          if (alive.current && epoch === navigation.current) {
            setScope(value.scope || { available: false, reason: '宿主未返回论文范围状态' })
            return controller.select(selected.sessionId)
          }
        }).catch(error => {
          if (alive.current && epoch === navigation.current) {
            controller.close()
            setNative({ reference: null, loading: false, error: error.message || String(error) })
          }
        })
        return () => { if (epoch === navigation.current) navigation.current += 1 }
      }, [ready, ui.open, selected?.sessionId, retry])

      React.useEffect(function () {
        post({ type: 'native-state', available: !!controllerRef.current, open: ui.open, conversationId: selected?.id || null })
      }, [reader, selected?.id, ui.open, ready])

      React.useEffect(function () {
        if (selected) setFocus(selected, reader).catch(error => {
          showError(error)
          if (alive.current && latest.current.ui.activeConv === selected.id) setScope({ available: false, reason: error.message || String(error) })
        })
      }, [reader, selected?.id, selected?.paperIds.join(',')])

      React.useEffect(function () {
        if (!toast) return
        const timer = window.setTimeout(() => setToast(''), 6500)
        return () => window.clearTimeout(timer)
      }, [toast])

      React.useEffect(function () {
        const observer = new ResizeObserver(entries => setContainerWidth(entries[0].contentRect.width))
        observer.observe(rootRef.current)
        return () => observer.disconnect()
      }, [])

      React.useEffect(function () {
        const pending = new Map()
        let queue = Promise.resolve()
        async function ask(data, target) {
          const text = typeof data.text === 'string' ? data.text : ''
          if (!text.trim()) throw new Error('没有要讲解的内容')
          const comparing = data.scope === 'papers'
          const general = data.scope === 'general'
          const paper = comparing || general ? null : latest.current.reader
          if (!comparing && !general && (!paper || paper.id !== data.paperId)) throw new Error('阅读中的论文已切换，请重新选择')
          const ids = comparing && Array.isArray(data.paperIds) ? [...new Set(data.paperIds)] : paper ? [paper.id] : []
          if (comparing) {
            if (ids.length < 2 || ids.length > 30) throw new Error('对比论文必须来自文献库，数量为 2–30 篇')
            const library = await rpc('library.list')
            if (target.conversationId !== null && (latest.current.ui.activeConv !== target.conversationId || selectionVersion.current !== target.version)) {
              throw new Error('对话已切换，请重新提问')
            }
            setPapers(library.items)
            if (ids.some(id => !library.items.some(item => item.id === id))) throw new Error('对比论文必须来自文献库，数量为 2–30 篇')
          }

          let conv = latest.current.selected
          let expectedVersion = target.version
          if (!conv) {
            if (target.conversationId !== null || selectionVersion.current !== target.version) {
              throw new Error('对话已切换，请重新提问')
            }
            // 无有效会话时，首次发起论文讲解自动创建并持久化一条会话
            const title = paper ? '《' + paper.title + '》的对话' : comparing ? '多篇论文对比综述' : '论文对话'
            conv = await rpc('conv.create', { title, paperIds: ids })
            if (!alive.current) throw new Error('界面已关闭')
            selectionVersion.current += 1
            expectedVersion = selectionVersion.current
            replaceConversation(conv)
            setUi(previous => ({ ...previous, activeConv: conv.id, open: true }))
            latest.current.selected = conv
            latest.current.ui = { ...latest.current.ui, activeConv: conv.id, open: true }
          } else if (conv.id !== target.conversationId || selectionVersion.current !== target.version) {
            throw new Error('对话已切换，请重新提问')
          }

          const originalId = conv.id
          const unchanged = () => alive.current && latest.current.ui.activeConv === originalId && selectionVersion.current === expectedVersion
          const associated = [...new Set([...conv.paperIds, ...ids])]
          if (associated.length > 30) throw new Error('对话最多关联 30 篇论文，请先移除不需要的论文')
          if (associated.length !== conv.paperIds.length) {
            conv = await rpc('conv.update', { id: conv.id, paperIds: associated })
            if (alive.current) replaceConversation(conv)
          }
          const samePaper = () => comparing || general || latest.current.reader?.id === paper.id
          if (!unchanged()) throw new Error('对话已切换，请重新提问')
          setUi(previous => ({ ...previous, open: true }))
          latest.current.ui = { ...latest.current.ui, open: true }
          const openReady = () => unchanged() && latest.current.ui.open
          const prepared = await rpc('session.prepare', { conversationId: conv.id })
          if (!openReady() || !samePaper()) {
            if (alive.current && !latest.current.ui.open) controllerRef.current?.close()
            throw new Error('对话或论文已切换，请重新提问')
          }
          const controller = controllerRef.current
          if (!controller) throw new Error('当前宿主没有原生会话控制器')
          const reference = await controller.select(conv.sessionId)
          if (!reference || !openReady()) {
            if (alive.current && !latest.current.ui.open) controller.close()
            throw new Error('会话未就绪或已切换')
          }
          if (!general) {
            const context = await setFocus(conv, comparing ? null : { ...paper, page: data.page, sectionId: data.sectionId, blockId: data.blockId, revision: data.revision })
            if (!openReady() || !samePaper()) {
              if (alive.current && !latest.current.ui.open) controller.close()
              throw new Error('对话或论文已切换，请重新提问')
            }
            if (context.scope?.available !== true) throw new Error('论文上下文尚不可用：' + (context.scope?.reason || '请重新连接后重试'))
          } else if (prepared?.scope) {
            setScope(prepared.scope)
          }
          // 超长选段：完整保留内容并在右栏提供「转为文本附件发送」选项，绝不静默截断
          if (text.length > MAX_INLINE_PROMPT_CHARS && data.forceInline !== true) {
            setOversized({
              conversationId: conv.id,
              paperId: paper?.id || ids[0] || 'paper',
              page: data.page || paper?.page || 1,
              text,
              headerPrompt: data.headerPrompt || '',
            })
            return '选段共 ' + text.length + ' 字（已完整保留），请在右侧点击「转为文本附件发送」或「直接发送全文」。'
          }
          await controller.submit(text, conv.sessionId)
          return '已发送到当前原生会话；忙碌时会自动加入队列。'
        }
        function onMessage(event) {
          if (!isReaderMessage(event, frameRef.current, window.location.origin)) return
          const data = event.data
          if (data.type === 'native-toggle') {
            const nextOpen = !latest.current.ui.open
            if (!nextOpen) controllerRef.current?.close()
            latest.current.ui = { ...latest.current.ui, open: nextOpen }
            setUi(previous => ({ ...previous, open: nextOpen }))
            return
          }
          if (data.type === 'reader-state') {
            const paper = data.paper
            setReader(paper && typeof paper.id === 'string' ? paper : null)
            post({ type: 'native-state', available: !!controllerRef.current, open: latest.current.ui.open, conversationId: latest.current.ui.activeConv })
            return
          }
          if (typeof data.requestId !== 'string' || data.requestId.length > 120) return
          if (pending.has(data.requestId)) return
          pending.set(data.requestId, true)
          if (pending.size > 200) pending.delete(pending.keys().next().value)
          const target = { conversationId: latest.current.ui.activeConv, version: selectionVersion.current }
          queue = queue.then(() => ask(data, target)).then(message => {
            if (alive.current) post({ type: 'paper-result', requestId: data.requestId, ok: true, message })
          }).catch(error => {
            showError(error)
            if (alive.current) post({ type: 'paper-result', requestId: data.requestId, ok: false, message: error.message || String(error) })
          })
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      const narrow = containerWidth < 760
      const width = narrow ? Math.max(280, containerWidth - 24) : Math.min(ui.width, Math.max(MIN_WIDTH, containerWidth - 300))
      const drag = React.useRef(null)
      const dragStart = event => {
        if (event.button !== 0) return
        drag.current = { x: event.clientX, width, next: width }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        event.preventDefault()
      }
      const dragMove = event => {
        if (!drag.current) return
        const next = drag.current.width + drag.current.x - event.clientX
        drag.current.next = next
        if (next >= 160) setUi(previous => ({ ...previous, width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next)) }))
      }
      const closeNativePane = () => {
        latest.current.ui = { ...latest.current.ui, open: false }
        controllerRef.current?.close()
        setUi(previous => ({ ...previous, open: false }))
      }

      const dragEnd = () => {
        if (drag.current?.next < 160) closeNativePane()
        drag.current = null
      }

      const resolveLegacyPaperId = () => {
        if (!selected) return reader?.id || ''
        if (selected.paperIds.length === 1) return selected.paperIds[0]
        if (reader?.id && selected.paperIds.includes(reader.id)) return reader.id
        if (selected.paperContext?.paperId && selected.paperIds.includes(selected.paperContext.paperId)) return selected.paperContext.paperId
        return ''
      }

      const onPaperLink = event => {
        const link = event.target?.closest?.('a[href]')
        if (link) {
          const href = link.getAttribute('href')
          const target = parsePaperLink(href, window.location.origin)
          if (target) {
            event.preventDefault()
            event.stopPropagation()
            post({ type: 'reader-navigate', ...target })
            if (narrow) closeNativePane()
            return
          }
          const legacyPage = parseLegacyPageCitation(href, link.textContent)
          if (legacyPage !== null && (!href || !/^https?:\/\//i.test(href))) {
            event.preventDefault()
            event.stopPropagation()
            const paperId = resolveLegacyPaperId()
            if (!paperId) {
              setToast('当前对话关联了多篇论文，请先点击下方目标论文标签后再定位旧版 [p.' + legacyPage + '] 引用')
              return
            }
            post({ type: 'reader-navigate', paperId, page: legacyPage, blockId: '', sectionId: '', revision: '' })
            if (narrow) closeNativePane()
          }
          return
        }
        // 兼容旧消息中未渲染成链接的 `<code>[p.5]</code>`
        const code = event.target?.closest?.('code')
        if (code) {
          const legacyPage = parseLegacyPageCitation('', code.textContent)
          if (legacyPage !== null) {
            const paperId = resolveLegacyPaperId()
            if (!paperId) {
              setToast('当前对话关联了多篇论文，请先点击下方目标论文标签后再定位 [p.' + legacyPage + ']')
              return
            }
            post({ type: 'reader-navigate', paperId, page: legacyPage, blockId: '', sectionId: '', revision: '' })
            if (narrow) closeNativePane()
          }
        }
      }

      const button = (text, onClick, extra = {}) => React.createElement('button', { type: 'button', onClick, ...extra }, text)
      const labelFor = id => papers.find(paper => paper.id === id)?.title || id
      const voice = detectVoiceCapability()
      const canMountProvider = typeof props.SessionProvider === 'function' && typeof props.renderSlot === 'function'

      return React.createElement('div', { ref: rootRef, className: 'pb-native-workbench' },
        React.createElement('style', null, CSS),
        React.createElement('iframe', { ref: frameRef, src: APP_URL, title: '论文工作台阅读器', className: 'pb-native-reader' }),
        ui.open ? React.createElement('aside', {
          className: 'pb-native-aside',
          'data-pb-native-chat': true,
          style: { width, ...(narrow ? { position: 'absolute', right: 0, top: 0, zIndex: 20, boxShadow: '-8px 0 28px rgba(0,0,0,.22)' } : {}) },
        },
          React.createElement('div', {
            className: 'pb-native-handle',
            role: 'separator',
            tabIndex: 0,
            title: '拖拽调整会话栏宽度 · 双击恢复默认宽度 · 向右拖到底收起',
            'aria-label': '调整会话宽度，向右拖至最小关闭',
            'aria-orientation': 'vertical',
            'aria-valuemin': MIN_WIDTH,
            'aria-valuemax': MAX_WIDTH,
            'aria-valuenow': Math.round(width),
            onPointerDown: dragStart,
            onPointerMove: dragMove,
            onPointerUp: dragEnd,
            onPointerCancel: () => { drag.current = null },
            onDoubleClick: () => setUi(previous => ({ ...previous, width: DEFAULT_WIDTH })),
            onKeyDown: event => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                setUi(previous => ({ ...previous, width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, previous.width + (event.key === 'ArrowLeft' ? 24 : -24))) }))
              } else if (event.key === 'Home') {
                event.preventDefault()
                setUi(previous => ({ ...previous, width: DEFAULT_WIDTH }))
              } else if (event.key === 'End') {
                closeNativePane()
              }
            },
          }),
          React.createElement('header', { className: 'pb-native-header' },
            React.createElement('div', { className: 'pb-native-row' },
              React.createElement('select', {
                'aria-label': '论文对话',
                value: ui.activeConv || '',
                onChange: event => selectConversation(event.target.value).catch(showError),
                disabled: !ready || busy,
              },
                React.createElement('option', { value: '', disabled: true }, list.length ? '选择论文对话' : '暂无对话（点右侧新建）'),
                ...list.map(conv => React.createElement('option', { key: conv.id, value: conv.id }, conv.title)),
              ),
              button('+ 新建', () => createConversation(), { className: 'pb-native-btn-primary', disabled: !ready || busy, title: '新建一条论文对话并关联当前论文' }),
              selected ? button('↗ 完整页', openFullSession, { disabled: busy, title: '在 DSH 完整会话视图中打开同一条会话（共享历史、草稿与运行状态）' }) : null,
              button('⋯', () => setDetails(value => !value), { title: '对话管理、附件与语音能力状态', 'aria-expanded': details }),
              button('×', closeNativePane, { title: '收起会话栏（正在运行的 Agent 任务会继续在后台执行）', 'aria-label': '收起会话' }),
            ),
            selected ? React.createElement('div', { className: 'pb-native-scope' },
              ...(selected.paperIds.length
                ? selected.paperIds.map(id => React.createElement('span', { key: id, className: 'pb-native-chip' },
                    button(labelFor(id), () => post({ type: 'reader-navigate', paperId: id, page: selected.paperContext?.paperId === id ? (selected.paperContext.page || 1) : 1, blockId: '', sectionId: '', revision: '' }), {
                      className: 'pb-native-chip-label',
                      title: '点击在左侧阅读器打开《' + labelFor(id) + '》',
                    }),
                    button('×', () => updatePapers(selected.paperIds.filter(value => value !== id)), {
                      className: 'pb-native-chip-remove',
                      disabled: busy,
                      'aria-label': '移除关联 ' + labelFor(id),
                      title: '从当前对话范围移除（不删除论文文件）',
                    }),
                  ))
                : [React.createElement('span', { key: 'empty' }, '未关联论文（普通问答可用）')]),
              reader && !selected.paperIds.includes(reader.id)
                ? button('+ 关联本篇', () => updatePapers([...selected.paperIds, reader.id]), { disabled: busy, title: '将左侧正在阅读的论文加入当前对话范围' })
                : null,
              selected.attachments?.length || selected.attachmentCount
                ? React.createElement('span', { title: '历史本地文件已保留在对话范围中，Agent 可通过文件工具直接读取' },
                    '· 本地资料 ' + (selected.attachments?.length || selected.attachmentCount) + ' 份')
                : null,
            ) : null,
          ),
          selected && !scope.available ? React.createElement('div', { className: 'pb-native-capabilities', role: 'status' },
            '论文上下文未启用：' + scope.reason + '。当前仍可进行普通对话；论文快捷提问将在上下文就绪后恢复。') : null,
          oversized && selected && oversized.conversationId === selected.id ? React.createElement('div', { className: 'pb-native-oversized', role: 'region', 'aria-label': '超长选段发送确认' },
            React.createElement('div', null, '当前选段较长（共 ' + oversized.text.length + ' 字，已完整保留未截断）。建议转为文本附件发送，保持对话整洁：'),
            React.createElement('div', { className: 'pb-native-cap-actions' },
              button('转为文本附件发送', () => sendOversizedAsAttachment(oversized), { className: 'pb-native-btn-primary', disabled: busy }),
              button('直接发送全文', () => sendOversizedInline(oversized), { disabled: busy }),
              button('取消', () => setOversized(null), { disabled: busy }),
            ),
          ) : null,
          details ? React.createElement('div', { className: 'pb-native-capabilities' },
            React.createElement('div', null, '• 模型 / 思考程度 / 权限 / 附件：直接使用下方原生输入框控件，上传回执归当前会话所有。'),
            React.createElement('div', null, '• 联网与链接读取：随目标会话已启用的工具与模型能力自动生效。'),
            React.createElement('div', null, '• 语音输入：' + voice.text),
            React.createElement('div', { className: 'pb-native-cap-actions' },
              button('打开插件管理', openPluginSettings),
              selected ? button('打开完整会话', openFullSession) : null,
              selected ? button('从工作台移除此对话', removeCurrentConversation, { className: 'pb-native-btn-danger', disabled: busy }) : null,
            ),
          ) : null,
          React.createElement('div', { className: 'pb-native-body', onClickCapture: onPaperLink },
            !canMountProvider
              ? React.createElement('div', { className: 'pb-native-empty', role: 'status' },
                  '当前 DSH 版本未提供 SessionProvider 公开槽位契约，无法内嵌原生会话组件。')
              : native.reference && selected && native.reference.sessionId === selected.sessionId
                ? React.createElement(props.SessionProvider, { session: native.reference }, props.renderSlot(NATIVE_SLOT, { sessionId: selected.sessionId }))
                : React.createElement('div', { className: 'pb-native-empty', role: 'status' },
                    React.createElement('div', null,
                      native.loading
                        ? '正在连接原生会话…'
                        : native.error || (ready ? '在左侧打开论文后，可新建一段对话，或直接双击段落 / 点击「总结全文」自动开启对话。' : '正在恢复论文对话…')),
                    !native.loading && !native.error && ready && !selected
                      ? button('开始论文对话', () => createConversation(), { className: 'pb-native-btn-primary', disabled: busy })
                      : null,
                    native.error
                      ? button('重连', () => { controllerRef.current?.close(); setRetry(value => value + 1) })
                      : null,
                  ),
          ),
        ) : button('打开论文对话', () => setUi(previous => ({ ...previous, open: true })), { className: 'pb-native-opener' }),
        toast ? React.createElement('div', { className: 'pb-native-toast', role: 'status' }, toast) : null,
      )
    }

    function apply(ctx) {
      clientCtx = ctx
      slotMountError = ''
      ctx.plugin({
        inject: ['slots'],
        apply(slotCtx) {
          slotCtx.effect(() => slotCtx.slots.inject('sidebar.panellist', () => slotCtx.slots.register({
            name: 'sidebar.panellist', id: PANEL_ID, order: 24, label: () => '论文工作台',
          }, PanelIcon)))
          slotCtx.effect(() => slotCtx.slots.inject('main', () => {
            try {
              const releaseMain = slotCtx.slots.register({
                name: 'main',
                key: PANEL_ID,
                children: { [NATIVE_SLOT]: { kind: 'single', scope: 'session' } },
              }, Workbench)
              const releaseNative = slotCtx.slots.register({ name: NATIVE_SLOT }, NativeConversation)
              return () => { releaseNative(); releaseMain() }
            } catch (error) {
              // 兼容不支持动态声明 session 子槽位的旧版 DSH：保住左侧论文阅读器与独立翻译，如实记录阻碍原因
              slotMountError = '当前 DSH 版本的槽位守卫不支持插件子会话挂载：' + (error?.message || String(error))
              return slotCtx.slots.register({ name: 'main', key: PANEL_ID }, Workbench)
            }
          }))
        },
      })
    }

    return { apply, createNativeSessionBinding, isReaderMessage, parsePaperLink, parseLegacyPageCitation, MAX_INLINE_PROMPT_CHARS }
  },
})
