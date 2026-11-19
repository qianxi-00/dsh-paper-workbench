# v8：原生 DSH Agent 会话接入、跨版本兼容与持久化记忆

本文档记录 0.8.x「论文工作台右栏接入 DSH 原生 Agent 会话」的已验证公开契约、桥接协议、跨版本兼容策略与交接记录。

---

## 1. 真机已验证的 DSH 公开契约

1. **宿主分栏与原生会话槽位挂载（`lib/client.js`）**
   - 主面板注册：`slots.register({ name: 'main', key: 'paper-workbench', children: { 'paper-workbench.native': { kind: 'single', scope: 'session' } } }, Workbench)`。
   - 声明 `scope: 'session'`（或 `'session-maybe'`）的子槽位后，渲染器自动向 `Workbench(props)` 注入 `props.SessionProvider`。
   - `SessionProvider` 的 `session` 属性必须传入 `sessions.retain(sessionId, { source: 'controllerOperation' })` 返回并等待 `ready` 完成后的精确 `reference` 句柄（含 `{ sessionId, binding }`）。
   - 子槽位组件内调用 `props.renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero })` 渲染完整的 DSH 原生消息流、思考折叠、工具卡、权限审批、模型与思考程度选择、原生附件与队列输入框。
   - 完整会话跳转：优先调用 `ctx.get('uiWorkspace')?.openSession?.(sessionId)` 导航到同一条原生会话，历史、运行状态与草稿完全一致。
   - 原生附件上传：超长选段转附件走 `ctx.get('fileUpload')?.upload(sessionId, file, name, signal)` 获取属于当前会话的真实 `receiptId`，绝不伪造或跨会话复用上传回执。

2. **目标 Agent 作用域上下文隔离（`lib/paper-context.js`）**
   - 服务获取双路径：`runtime.agentPresets?.serviceFor?.(agent, 'systemPrompt') || agent.ctx?.get?.('systemPrompt')`。
     > 真机验证记录（2026-11-17/18）：在 `ops-ptc` 等未在 preset 层单独重导出的预设下，`agentPresets.serviceFor` 返回空，而 `agent.ctx.get('systemPrompt')` 返回有效实例。
   - 作用域边界验证：在真实桌面端对目标会话执行手动 `assemble({ scope: agent })` 与真实对话轮次（`actual-turn`）实测确认：
     - 目标会话：`assembly.scope === agent` 为 `true`，成功注入论文范围；
     - 无作用域组装（`unscoped`）：未命中（`false`）；
     - 其他活跃会话（`other`）：未命中（`false`）；
     - 注销后（`dispose()`）：立即清理不残留。
   - 生命周期：同时监听串行事件 `agent/created`（覆盖 `startup` / `resume` / `clear` / `compact`）与插件挂载时已存活的 `agents.list()`，在 `agent/disposed`、对话删除（`conv.remove`）和插件卸载时幂等释放。

---

## 2. 阅读器 ↔ 宿主分栏 `postMessage` 桥接协议（v2）

所有消息均限制同源（`window.location.origin`）且校验 `event.source === iframe.contentWindow`（或 `window.parent`）及 `{ __pb: true, v: 2 }`：

| 方向 | `type` | 关键载荷 | 语义 |
| --- | --- | --- | --- |
| 阅读器 → 宿主 | `reader-state` | `{ paper: { id, title, revision, page, sectionId, blockId? } \| null }` | 阅读论文或页/节定位变化（仅用于当前已关联论文的焦点更新，不自动扩大论文关联范围） |
| 阅读器 → 宿主 | `paper-ask` | `{ requestId, text, scope: 'selection'\|'section'\|'paper'\|'papers'\|'general', paperId?, paperIds?, page?, sectionId?, blockId?, revision?, preferAttachment? }` | 发起快捷提问；宿主按请求去重、校验代次、必要时自动建会话/关联论文、同步上下文后通过 `beginSubmission` + `prompt(mode:'queue')` 入队 |
| 阅读器 → 宿主 | `native-toggle` | `{}` | 切换右侧原生会话栏展开/收起（收起仅 `release()` 视图引用，不中止后台运行任务） |
| 宿主 → 阅读器 | `native-state` | `{ available, open, conversationId, scopeAvailable? }` | 同步原生右栏连接与开关状态（阅读器就地更新按钮激活态与提示，不重绘打断划词选区） |
| 宿主 → 阅读器 | `paper-result` | `{ requestId, ok, message }` | 快捷提问入队成功或失败的明确回执 |
| 宿主 → 阅读器 | `reader-navigate` | `{ paperId, page, blockId?, sectionId?, revision? }` | 点击原生回复中的论文引用链接（或旧版 `[p.N]`）跳回阅读器对应段落/章节/页，版本失效时回退原页并提示 |

---

## 3. 数据兼容与持久化契约

1. **`chats.json`（向后兼容升级）**
   - 保留原有 `id`（`c-*`）、`sessionId`（`pb-conv-*` 或导入历史会话 ID）、`paperIds`、`attachments`（本地路径文件清单，作为会话资料路径提示保留，不伪造原生上传回执）。
   - 新增可选 `paperContext: { paperId, page, sectionId, blockId, revision } | null`。
2. **`ui.json`（`version: 2` 服务端持久化，跨端口恢复）**
   - 通过 `mergeUiState(previous, patch)` 串行合并：同时保留阅读器字段（`paperId`, `tab`, `page`, `scrollTop`, `sectionId`, `layout`, `expanded`）与宿主右栏字段 `nativeChat: { open: true, width: 420, activeConv: null }`，互不覆盖。
3. **独立 SQLite 翻译库（`workbench.db`）**
   - 译文（`translations`）、任务日志（`job_events`）、翻译自检（`reviews`）保持完全独立，不随会话切换或删除而变动，翻译请求绝不进入原生会话消息历史。

---

## 4. 跨版本 DSH 兼容矩阵（按能力分层）

v1.1.1 起，宿主工作台 HTTP 入口必须经过 `connection.requestRejection(req)`；下表中的会话和阅读降级不放宽认证要求。缺少必需服务时插件不挂载或被宿主卸载；已挂载 handler 内的认证服务查询、方法调用或结果异常默认拒绝。已核对官方 `dsh-v0.2.2-rc.3` 与 `dsh-v0.2.2-rc.5` 的同步准入契约，返回 `undefined` 才放行。独立调试服务器属于另一种启动方式，不能据此断言真实宿主认证通过。

v1.1.2 修复 rc.5 的严格注入作用域兼容：`ctx.inject(['agents'])` 回调不直接读取未声明的 `agentPresets` 属性，而是通过 `get('agentPresets')` 可选解析；预设服务缺席时继续使用目标 `agent.ctx.get('systemPrompt')`。回归夹具对未声明属性读取主动抛错，避免初始化回调在注册论文上下文之前中断。

| 能力面 | 新版 DSH Desktop（世代 1） | 中期 DSH 版本（世代 2） | 已认证但缺会话组件的宿主 / 独立调试页 |
| --- | --- | --- | --- |
| 原生会话挂载 | `SessionProvider` + `renderFactorySlot('conversation.content', { variant: 'embedded', ... })` | 兼容无 `useSessions` / 简化 Factory 参数回退调用 | 缺 `sessions` / `SessionProvider` 时显示明确缺失接口诊断，阅读与翻译不受影响；独立直开 `/app` 保留内置会话页 |
| Agent 上下文服务 | `agent.ctx.get('systemPrompt')` | `agentPresets.serviceFor(agent, 'systemPrompt')` | 服务缺席时 `scope.available=false` 并如实提示原因，阻止过期范围静默发送，普通聊天仍可用 |
| 工作区归属 | `workspaceRegistry.list/create` + `setTitle` | `workspaceController.create({ path })` | 无工作区服务时退回 `sessionController.create({ sessionId, cwd })` |
| 完整会话跳转 | `uiWorkspace.openSession(sessionId)` | `layout.selectPanel('conversation')` | 按钮置灰或提示在左侧会话栏按标题打开 |
| 超长选段附件 | `fileUpload.upload(sessionId, ...)` 原生上传回执 | 退回 `conv.attach` 存为会话本地资料并在上下文声明路径 | 保留完整文本直接提交或明确提示上限 |
| 本地结构化存储 | Node ≥ 22.5 `node:sqlite`（WAL 事务） | Node 20.0 – 22.4 自动退化为同 API `workbench.json` | 两种引擎无缝切换，`doctor` 明确报告当前引擎 |

---

## 5. 安全边界与生命周期加固记录（v0.8 审查回归）

1. **防止提示词注入越权读取本机文件**：
   - `library.update` 与 `paper_library(action="update")` 严格采用可编辑元数据白名单，禁止外部调用修改 `srcPath`、`originPath`、`storage`、`vaultCard`。
   - `vault.read` 与 `vault.open`（`paper_obsidian(action="open")`）统一强制校验目标路径位于当前配置的 `vault.kb` / `vault` 目录内且扩展名为 `.md`。
   - `paper_translate(mode="replace")` 统一经由 `store.writeZh(id, chunk)`（`ID_RE` 校验 + 原子落盘），禁止拼接裸路径。
   - `library.openPdf` 按平台直接调用 `explorer.exe` / `open` / `xdg-open` 并监听 `error` 事件，杜绝 `cmd /c start` 下的 `&` / `%ENV%` 命令注入与进程未捕获异常。
2. **原生会话 `retain` 句柄零泄漏**：
   - 切换对话、新建对话、移除对话、`session.prepare` 失败、收起右栏（`×` / 拖窄 / `native-toggle` / 窄屏点引用）以及超长选段异步上传中途切换状态时，均同步或即时校验代次并调用 `controller.close()` 释放 `sessions.retain` 引用。
   - `select(sessionId)` 命中同会话已就绪缓存时主动同步 `onState`，避免自动建会话与被动 `useEffect` 交错时界面停留在加载态。
3. **增量译文写盘与公式选区还原**：
   - `ai.translate()` 仅将本轮新产出的 `dirtyEntries` 合并写入 SQLite，避免长流式任务用旧快照覆盖并发修改或清空操作。
   - 阅读器划词选区提取（`extractCleanSelection`）自动剔除对照译文层（`.para-zh`）并还原行内/块级 KaTeX 节点的 `data-tex` 源码，划词点击 `翻译` 在选区塌缩后仍按快照精确命中目标段落。
