/**
 * dsh-paper-workbench 客户端。
 *
 * 形态：DSH web 的手写模块（window.__ModuleLoader__.load），无需打包。
 * 贡献两处官方槽位：
 *   - sidebar.panellist：左侧导航新增一行「论文工作台」
 *   - main：key=paper-workbench 的主区页面，内部用 iframe 承载工作台 SPA
 *
 * 与原生会话的桥：iframe 通过 postMessage 发来 { type:'insert-prompt', text }，
 * 这里把文本写进「当前会话」的输入框（不自动发送）。写入方式与
 * dsh-better-sidebar 的 conversation-draft.ts 一致：
 *   ctx.sessions.scope(sessionId) -> ctx.get('conversation').input.for(scope).setDraft(...)
 * 输入框里已有引用 chip 时拒绝写入（setDraft 会把 chip 压平成纯文本）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-paper-workbench',
  factory: function (require) {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const PANEL_ID = 'paper-workbench'
    const PANEL_ORDER = 24
    const APP_URL = '/paper-workbench/app?embed=1'
    const LAST_SESSION_KEY = 'dsh-paper-workbench:last-session'

    /** 客户端根上下文，apply 时填入；写入输入框时使用。 */
    let clientCtx = null

    /** 左侧导航行的字形：文档 + 书签，与官方 outline 图标同风格。 */
    function PanelIcon(props) {
      const size = props && props.size ? props.size : 16
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          'data-dsh-panel-entry': PANEL_ID,
        },
        React.createElement('path', {
          d: 'M4.5 1.5h5l3 3v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z',
        }),
        React.createElement('path', { d: 'M9.5 1.5v3h3' }),
        React.createElement('path', { d: 'M9.6 8v4.6l1.2-.8 1.2.8V8z' }),
        React.createElement('path', { d: 'M5.5 8.5h2' }),
        React.createElement('path', { d: 'M5.5 11h2' }),
      )
    }

    /** 从 sessions 服务的各种可能快照形状里挑出活动会话 id。 */
    function pickSessionFromSnapshot(snap) {
      if (!snap || typeof snap !== 'object') return null
      if (typeof snap.activeSessionId === 'string') return snap.activeSessionId
      if (typeof snap.currentSessionId === 'string') return snap.currentSessionId
      if (typeof snap.sessionId === 'string') return snap.sessionId
      if (snap.active && typeof snap.active === 'object' && typeof snap.active.id === 'string') return snap.active.id
      const lists = [snap.items, snap.sessions]
      for (const list of lists) {
        if (!Array.isArray(list)) continue
        const hit = list.find(function (item) {
          return item && (item.active === true || item.isActive === true || item.selected === true) && typeof item.id === 'string'
        })
        if (hit) return hit.id
      }
      return null
    }

    /** 解析「当前会话」：会话服务快照 → URL 里的 uuid → 上次用过的会话。 */
    function resolveSessionId(ctx) {
      try {
        const sessions = ctx && ctx.get ? ctx.get('sessions') : undefined
        if (sessions) {
          const candidates = []
          if (typeof sessions.getSnapshot === 'function') candidates.push(sessions.getSnapshot())
          if (sessions.state && typeof sessions.state.getSnapshot === 'function') candidates.push(sessions.state.getSnapshot())
          if (sessions.list && typeof sessions.list.getSnapshot === 'function') candidates.push(sessions.list.getSnapshot())
          for (const snap of candidates) {
            const found = pickSessionFromSnapshot(snap)
            if (found) return found
          }
        }
      } catch (error) {
        console.warn('[paper-workbench] 读取会话服务失败：', error && error.message ? error.message : error)
      }
      // 主区切到本插件后没有「当前会话」可读；会话列表按最近更新排序，取最新的普通会话。
      try {
        const sessions = ctx && ctx.get ? ctx.get('sessions') : undefined
        const snap = sessions && sessions.list && sessions.list.getSnapshot()
        const ids = (snap && snap.ids) || []
        const byId = (snap && snap.byId) || {}
        // 优先主区正在显示的那条（retainedBy.mainView）；ids[0] 只是排序第一，
        // 可能是别的会话，写进去用户会以为「没反应」。
        const mainView = ids.find((id) => {
          const summary = byId[id]
          return summary && summary.retainedBy && summary.retainedBy.mainView === true && summary.origin !== 'subagent'
        })
        if (mainView) return mainView
        for (const id of ids) {
          const summary = byId[id]
          if (!summary || summary.origin === 'subagent') continue
          return id
        }
      } catch (error) {
        console.warn('[paper-workbench] 读取会话列表失败：', error && error.message ? error.message : error)
      }
      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(
        String(location.pathname || '') + String(location.hash || '') + String(location.search || ''),
      )
      if (uuid) return uuid[0]
      try {
        return localStorage.getItem(LAST_SESSION_KEY) || null
      } catch {
        return null
      }
    }

    /** 把一段文本写进当前会话输入框；返回给 SPA 的结果对象。 */
    async function insertPrompt(rawText) {
      const text = String(rawText || '')
      if (text.trim() === '') return { ok: false, reason: 'empty', message: '指令为空。' }
      const ctx = clientCtx
      if (!ctx) return { ok: false, reason: 'no-context', message: '客户端上下文尚未就绪。' }
      const sessionId = resolveSessionId(ctx)
      if (!sessionId) {
        return {
          ok: false,
          reason: 'no-session',
          message: '没有找到当前会话：请先在左侧打开一个对话，再回到论文工作台重试（指令已复制到剪贴板）。',
        }
      }
      try {
        const sessions = ctx.get('sessions')
        if (!sessions || typeof sessions.scope !== 'function') {
          return { ok: false, reason: 'no-sessions', message: '会话服务不可用（指令已复制到剪贴板）。' }
        }
        let actx = sessions.scope(sessionId)
        let opened = false
        if (actx === undefined) {
          // 面板顶替了对话页，会话可能已不再挂载：先把会话打开，再等输入框可用。
          const ui = ctx.get('uiWorkspace')
          if (!ui || typeof ui.openSession !== 'function') {
            return { ok: false, reason: 'no-scope', message: '会话作用域不可用（指令已复制到剪贴板）。' }
          }
          try {
            ui.openSession(sessionId)
            opened = true
          } catch (error) {
            return {
              ok: false,
              reason: 'no-open',
              message: '打开会话失败：' + (error && error.message ? error.message : String(error)),
            }
          }
          for (let i = 0; i < 25 && actx === undefined; i += 1) {
            await new Promise(function (resolve) {
              window.setTimeout(resolve, 120)
            })
            actx = sessions.scope(sessionId)
          }
          if (actx === undefined) {
            return { ok: false, reason: 'no-scope', message: '会话已打开，但输入框暂不可用（指令已复制到剪贴板）。' }
          }
        }
        const conversation = ctx.get('conversation')
        if (!conversation || !conversation.input) {
          return { ok: false, reason: 'no-conversation', message: '对话服务不可用（指令已复制到剪贴板）。' }
        }
        const input = conversation.input.for(actx)
        const snapshot = input.state.getSnapshot()
        const occurrences = snapshot.occurrences || []
        if (occurrences.length > 0) {
          return {
            ok: false,
            reason: 'chips',
            message: '输入框里已经有引用卡片，请先发送或清空，再重试（指令已复制到剪贴板）。',
          }
        }
        const draft = String(snapshot.draft || '')
        const next = draft.trim() === '' ? text : draft.replace(/\s+$/, '') + '\n\n' + text
        input.setDraft(next)
        try {
          localStorage.setItem(LAST_SESSION_KEY, sessionId)
        } catch {
          /* localStorage 不可用时忽略 */
        }
        return {
          ok: true,
          sessionId,
          opened,
          message: opened ? '已打开最近一次会话，指令已写进输入框，按发送即可。' : '已写入当前会话的输入框，按发送即可。',
        }
      } catch (error) {
        return {
          ok: false,
          reason: 'error',
          message: '写入会话失败：' + (error && error.message ? error.message : String(error)),
        }
      }
    }

    /** 主区页面：一个填满容器的工作台 iframe + 轻量提示条。 */
    function Workbench() {
      const frameRef = React.useRef(null)
      const [toast, setToast] = React.useState(null)
      const toastTimer = React.useRef(0)

      React.useEffect(
        function () {
          function show(text, kind) {
            setToast({ text: text, kind: kind || 'info' })
            window.clearTimeout(toastTimer.current)
            toastTimer.current = window.setTimeout(function () {
              setToast(null)
            }, 9000)
          }

          async function onMessage(event) {
            if (event.origin !== window.location.origin) return
            const data = event.data
            if (!data || data.__pb !== true) return
            if (data.type !== 'insert-prompt') return
            const text = String(data.text || '')
            const result = await insertPrompt(text)
            let copied = false
            if (!result.ok && text) {
              try {
                const clipboard = navigator.clipboard
                if (clipboard && typeof clipboard.writeText === 'function') {
                  await clipboard.writeText(text)
                  copied = true
                }
              } catch {
                copied = false // 剪贴板不可用（没权限/非安全上下文）时不能提示「已复制」
              }
            }
            if (!result.ok && text && !copied) {
              result.message = (result.message || '写入失败。') +
                '（剪贴板也不可用，请在浏览器里允许剪贴板权限后重试）'
            }
            if (!result.ok && copied) result.message = (result.message || '写入失败。') + '已复制到剪贴板。'
            show(result.message || (result.ok ? '已写入会话输入框。' : '写入失败。'), result.ok ? 'ok' : 'warn')
            const frame = frameRef.current
            if (frame && frame.contentWindow) {
              frame.contentWindow.postMessage(Object.assign({ __pb: true, type: 'inserted' }, result), window.location.origin)
            }
          }

          window.addEventListener('message', onMessage)
          return function () {
            window.removeEventListener('message', onMessage)
            window.clearTimeout(toastTimer.current)
          }
        },
        [],
      )

      const toastStyle = {
        position: 'absolute',
        left: '50%',
        bottom: 18,
        transform: 'translateX(-50%)',
        maxWidth: 'min(720px, calc(100% - 32px))',
        padding: '9px 14px',
        borderRadius: 10,
        fontSize: 13,
        lineHeight: 1.45,
        color: toast && toast.kind === 'warn' ? '#ffd8a8' : '#d3f9d8',
        background: toast && toast.kind === 'warn' ? 'rgba(64, 32, 6, 0.96)' : 'rgba(16, 42, 24, 0.96)',
        border: '1px solid ' + (toast && toast.kind === 'warn' ? 'rgba(255, 169, 77, 0.45)' : 'rgba(105, 219, 124, 0.4)'),
        boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
        zIndex: 30,
        pointerEvents: 'none',
      }

      return React.createElement(
        'div',
        {
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            minHeight: 0,
            background: 'var(--bg-layer-1, #14161a)',
          },
        },
        React.createElement('iframe', {
          ref: frameRef,
          src: APP_URL,
          title: '论文工作台',
          style: { flex: '1 1 auto', width: '100%', height: '100%', minHeight: 0, border: 0, display: 'block' },
        }),
        toast ? React.createElement('div', { style: toastStyle }, toast.text) : null,
      )
    }

    function apply(ctx) {
      clientCtx = ctx

      // 两个槽位都由 shell 插件声明，用 inject 等它们就绪；未声明时安静缺席，不阻塞启动。
      ctx.plugin({
        inject: ['slots'],
        apply(slotCtx) {
          // 生效/清理都挂在 slotCtx 上：挂父 ctx 会在子插件卸载时留下监听
          slotCtx.effect(function () {
            return slotCtx.slots.inject('sidebar.panellist', function () {
              return slotCtx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: PANEL_ORDER,
                  label: function () {
                    return '论文工作台'
                  },
                },
                PanelIcon,
              )
            })
          })
          slotCtx.effect(function () {
            return slotCtx.slots.inject('main', function () {
              return slotCtx.slots.register({ name: 'main', key: PANEL_ID }, Workbench)
            })
          })
        },
      })
    }

    exports.apply = apply
    return module.exports
  },
})
