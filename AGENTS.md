# AGENTS.md — dsh-paper-workbench 项目指南与持久化记忆

本文件是 `dsh-paper-workbench`（DeepSeek Harness 论文工作台插件）的权威工程指南与持久化维护记忆。任何接手本仓库的 Agent 或开发者在修改代码前，请先阅读本文件与 `docs/` 下对应的契约文档。

---

## 1. 项目定位与核心设计哲学

`dsh-paper-workbench` 是一个**零 npm 依赖、零构建步骤**的 DeepSeek Harness（DSH）桌面端插件，提供「文献管理 + 中英对照阅读 + 独立逐段翻译 + 原生 DSH Agent 会话联动 + Obsidian 知识库沉淀」的一体化科研工作流。

五大不可动摇的架构边界：
1. **零新增 npm 依赖 & 零构建**：服务端仅用 Node.js 20+ 内置模块（`node:sqlite` 在 < 22.5 时自动降级为同契约 JSON 引擎）；PDF 渲染与版面行提取通过 `assets/pdf_tool.py`（PyMuPDF `fitz`）子进程完成；客户端宿主层（`lib/client.js`）使用 DSH 运行时注入的 `react`，阅读器 SPA（`assets/app/`）为原生 ES/DOM（无打包器）。
2. **原生会话优先，绝不自绘冒充**：右侧对话栏通过 DSH 公开客户端契约（`slots.register` + `SessionProvider` + `renderFactorySlot('conversation.content', { variant: 'embedded', ... })` + `sessions.retain()`）直接挂载宿主原生会话组件。模型选择、思考程度、工具卡片、权限审批、原生文件/图片上传、排队、停止均由 DSH 原生管理；宿主缺失对应公开接口时如实报告原因，不以自绘聊天框冒充原生会话。
3. **翻译与对话严格物理隔离**：段落翻译、节翻译、整篇翻译、目录翻译和划词翻译一律走独立的 `/paper-workbench/ai/translate` SSE 通道，结果按段落/标题 hash 存入插件自有 SQLite（`workbench.db` 的 `translations` 表），**绝不写入聊天消息历史，也绝不污染 Agent 对话上下文**。
4. **精确会话归属与作用域隔离**：
   - 每个工作台对话（`c-*`）对应唯一宿主 `sessionId`（`pb-conv-*` 或已有历史 ID），切换阅读论文**不会**自动切换或新建会话。
   - 收起右侧会话栏或离开工作台仅 `release()` 界面引用，**绝不取消**后台正在运行的 Agent 任务。
   - 论文范围与当前阅读定位通过目标 Agent 的 `systemPrompt.context()` 动态注入（兼容 `agentPresets.serviceFor(agent, 'systemPrompt')` 与 `agent.ctx.get('systemPrompt')` 双路径），并严格校验 `assembly?.scope === agent`，确保普通手输提问也能感知关联论文，同时绝不泄漏到无关会话。
   - 论文标题、正文与附件内容一律标记为用户引用材料，`interpolate: false`，防止提示词注入提升为系统指令。
5. **跨版本 DSH 稳健兼容（≥ 3 个稳定世代）**：
   - **世代 A（当前 DSH Desktop）**：完整支持 `children` session scope、`SessionProvider`、`conversation.content` Factory、`sessions.retain`、`uiWorkspace.openSession`、`fileUpload.upload`、`agent.ctx.get('systemPrompt')`。
   - **世代 B（早期 Preset / Workspace 契约）**：兼容 `agentPresets.serviceFor(agent, 'systemPrompt')`、`workspaceRegistry` 缺席时回退 `workspaceController.create({ path })`、`llm.listModels` 缺席时回退手填模型、`rctx.effect` 缺席容错、以及 Node 20–22.4 无 `node:sqlite` 时自动回退 JSON 存储引擎。
   - **世代 C（精简宿主 / Headless / 独立调试页）**：宿主缺少客户端 `sessions` 或 `SessionProvider` 时在右栏展示清晰可操作的降级说明与重连入口，阅读器、PDF 页图、版面解析、中文版 PDF 与独立翻译仍 100% 可用；浏览器直开 `/paper-workbench/app`（无 `native=1`）保留独立调试能力。

---

## 2. 目录与模块地图

```text
lib/
  index.js           宿主插件主入口：路由挂载、JSON RPC（createApi）、SSE 流（createStreams）、生命周期与服务注入
  client.js          DSH 客户端动态模块：左栏入口 + 主区分栏（左侧阅读 iframe + 右侧原生 conversation.content）
  paper-context.js   原生会话论文作用域：目标 Agent SystemPrompt.context 注册/隔离/释放、定位降级、UI 状态 v2 合并
  conv.js            对话纯逻辑：c-* / pb-conv-* ID 规则、论文关联列表、旧版路径附件兼容、论文范围提示词拼装
  session.js         宿主 sessionController / workspaceController 桥接（create/ensure/ask/follow + 帧宽容归一化）
  server.js          HTTP 路由与安全边界（仅放行本机 Host、静态资源防穿越、RPC 包装、SSE 转发与取消）
  store.js           本地持久化：config/index/chats/ui/meta/doc/text 原子写（.tmp -> rename + 写锁队列）、回收站
  db.js              SQLite 存储层（node:sqlite WAL 优先 + 同名 API 的 JSON 退化引擎）：译文、任务日志、自检结果
  doc.js             结构化文档模型：PDF 文本块/版面块合并、目录分节、段落/标题稳定 16 位 sha1 hash
  layout.js          PP-StructureV3 云端版面解析后台任务、分批断点续跑（layout.partial.json）、远端 jobId 续拉
  layout-ir.js       schemaVersion 2 统一版面 IR 纯构建器：坐标投影、行归属守恒、行救回、多源候选择优、质量分级
  layout-table.js    表格结构化：PyMuPDF 格线提取优先 + 服务端 HTML 安全转网格（rowspan/colspan）+ 可信度门槛
  layout-archive.js  原始响应 sha256 永久归档与不可变 revision 发布指针（支持免重传离线重建）
  figures.js         正文配图清单提取、图注绑定与按内容指纹缓存裁剪 PNG
  zhpdf.js           中文版 PDF 生成协调层：把已译段落匹配回原 PDF 行框擦除重写为 paper-zh.pdf
  ocr.js             扫描件 PaddleOCR 云端异步识别（全链路 AbortSignal 贯通）与按页 Markdown 解析
  ai.js              独立翻译引擎与独立模式对话：同节分批、JSON 深度括号提取、截断翻倍重试、逐段兜底、公式卫生 tidyMath
  review.js          翻译质量自检：7 条静态规则 + 可选 LLM 批量审校（模型异常自动降级静态检查）
  jobs.js            任务事件日志记录器（纯依赖注入，异常绝不阻断主流程）
  obsidian.js        Obsidian Vault 自动探测、frontmatter 行级无损合并、写前备份、卡片读写与方向综述输出
  arxiv.js           arXiv Atom + OpenAlex 在线检索与开放获取 PDF 安全流式入库
  pdf.js             Python + PyMuPDF 解释器自动探测与子进程 JSON 通信桥
  sse.js             SSE 响应流封装（心跳保活、断连自动 abort）
  doctor.js          环境自检核心逻辑（CLI 与前端设置页共用同一份报告）

assets/
  pdf_tool.py        PyMuPDF 协处理器（info / text / page_lines / clip_text / tables / outline / render / figures / split / zhpdf）
  app/
    index.html       阅读器 SPA 壳页面（本地打包 KaTeX，零外网 CDN 依赖）
    style.css        阅读器样式表（深浅色主题自适应、双语对照排版、图表公式卡片、紧凑工具栏）
    app.js           阅读器前端逻辑（含 native=1 原生阅读桥、对照/原文页/笔记/卡片/在线检索视图）

scripts/
  dev-server.mjs     独立本地开发服务器（复用 lib/server.js + lib/index.js；--mock-llm 使用隔离临时目录与假模型）
  doctor.mjs         CLI 环境自检入口（npm run doctor）
  smoke.mjs          HTTP 与 SSE 接口端到端冒烟脚本
  layout.mjs         命令行版面解析工具
  quality/           版面质量评测语料清单、评分与离线重建脚本（score-layout.mjs / rebuild-layout.mjs）
  test-*.mjs         29+ 个无宿主依赖的隔离自动化测试套件（全部使用 %TEMP% 临时目录，严禁触碰真实库）

docs/
  v2-contracts.md    v2 文档模型、翻译流与基础 HTTP 契约
  v3-contracts.md    v3 SQLite、配图、自检、任务日志与会话桥契约
  v4-layout.md       v4 PP-StructureV3 版面模型、表格结构与断点续跑契约
  v6-zhpdf.md        v6 中文版 PDF 原位擦除重写契约
  v7-quality.md      v7 schemaVersion 2 版面质量管线与不可变归档契约
  v8-native-session.md v8 原生 DSH Agent 会话接入、跨版本兼容与项目维护记忆
```

---

## 3. 开发、验证与真机调试命令

> **铁律**：运行任何测试时，必须确保 `DSH_PAPER_WORKBENCH_DATA` 指向临时目录（各 `scripts/test-*.mjs` 已内置 `mkdtemp`，外层也可显式传入），**绝不污染或清空用户真实的 `~/.dsh/paper-workbench` 数据目录**！

### PowerShell（`pwsh`，Windows 默认终端）
```powershell
# 1. 环境自检（检查 Node / SQLite / Python+PyMuPDF / Obsidian / OCR）
npm run doctor

# 2. 运行全量自动化测试套件（Node 单元/集成测试 + Python PDF 质量与自检）
$env:DSH_PAPER_WORKBENCH_DATA = Join-Path $env:TEMP "pb-test-$(Get-Random)"
$env:PYTHONUTF8 = "1"
npm test

# 3. 单独运行原生会话与阅读桥核心测试
node scripts/test-conv.mjs
node scripts/test-paper-context.mjs
node scripts/test-native-client.mjs
node scripts/test-reader-bridge.mjs
node scripts/test-native-workbench.mjs

# 4. 启动零污染独立调试服务器（假模型 + 临时数据目录）
npm run dev:mock
```

### DSH 桌面端真机加载注意事项
- 本机 DSH 主目录 `$DSH_HOME = F:\ProGramApp\DSH`（注意：`~/.dsh` 即 `C:\Users\QianXi\.dsh` 仅存放插件运行数据 `paper-workbench/` 与 `server-deck` 数据）。
- 桌面端 profile（`F:\ProGramApp\DSH\profiles\desktop\package.json`）通过 `link:F:/ProGram/dsh-paper-workbench` 链接本仓库。
- 修改 `assets/app/*` 静态文件后，刷新工作台视图即可生效；修改 `lib/*.js`（宿主服务端或 `lib/client.js` 客户端模块）后，需在 DSH「插件」管理页对 `dsh-paper-workbench` bundle 执行一次「停用 → 启用」或重启 DSH 桌面端以重新挂载模块，不可把「磁盘文件已改」等同于「运行中进程已生效」。

---

## 4. 编码与工程纪律

- **语言与文案**：注释、日志与抛给前端的 `Error` 消息一律使用自然、可操作的中文（说明「出了什么问题 + 下一步怎么处理」），禁止向用户暴露裸堆栈或敏感凭据；代码标识符使用清晰英文。
- **最小改动与根因修复**：修改共享函数前先检索全仓调用点；不引入未使用的状态字段、死分支或重复样式规则；任何临时诊断探针必须在提交前彻底删除。
- **安全红线**：
  - 所有文件落盘路径必须经过 `store.js` 的 `ID_RE`（`/^[a-z0-9][a-z0-9._-]{0,79}$/`）或安全路径解析校验，严禁将未校验外部参数直接拼入 `path.join` 读写文件。
  - `postMessage` 桥接必须同时校验 `event.origin === window.location.origin`、`event.source` 引用、`__pb === true`、`v === 2` 以及会话代次（generation / selectionVersion）。
  - 外部 HTML（如版面识别表格 HTML）严禁直接赋给 `innerHTML`，必须解析为纯数据结构后由 DOM API 安全渲染。
  - 严禁在代码、测试或文档中硬编码任何 API Key / Token。

---

## 5. Git 分支模型与维护约定

本仓库本地与远端（`origin`：`https://github.com/qianxi-00/dsh-paper-workbench.git`）**仅保留四个核心分支**：

| 分支 | 职责 |
| --- | --- |
| `dev` | 日常功能演进与开发验证分支 |
| `test` | 集成测试与回归验证分支（仅由 `dev` 合并进入） |
| `prod` | 生产稳定发布分支（仅由 `test` 合并进入，每次发布打版本 tag） |
| `main` | 仓库首页展示与稳定发布同步分支（由 `prod` 合并更新） |

- **分支卫生**：临时开发分支统一使用 `agent/<topic>`，任务完成并合入核心分支后，**必须及时清理本地 worktree 及本地/远端临时分支**，保持仓库整洁，只留 `dev`、`test`、`prod`、`main`。
- **Git 提交身份**（GitHub 仓库）：`user.name = "Qian Xi"`，`user.email = "1964055097@qq.com"`。
- **提交信息规范**：使用语义化前缀（`feat:` / `fix:` / `docs:` / `refactor:` / `chore:` / `test:`），聚焦说明改动目的与解决的根因，一次提交聚焦一件事。

---

## 6. 历史交接与持久化项目记忆（2026-11）

- **v0.1 – v0.6（基础工作台 → 版面与中文 PDF）**：完成文献库、PyMuPDF 文本提取与连续滚页阅读、SQLite 译文/日志/自检库（`v3`）、PaddleOCR 扫描识别、`PP-StructureV3` 版面解析与断点续跑（`v4`）、原位覆盖式中文版 PDF（`v6`）、Obsidian 卡片行级合并联动。
- **v0.7（schemaVersion 2 对照质量管线）**：落地 `lib/layout-ir.js` 逐页 IR、原始 JSONL 内容寻址永久归档（`lib/layout-archive.js`）、离线免重传重建（`scripts/quality/rebuild-layout.mjs`）、块上方漏行救回与图表短标签过滤、质量报告分级（`blocking` vs `informational`）。
- **v0.8（原生 DSH Agent 会话全面接入 & 体验精修）**：
  - 接续前任会话（`session-126a3e1c-f068-40ce-8c03-01d8894fe8e2`）完成最后真机门槛验证：实测确认部分预设（如 `ops-ptc`）下 `agentPresets.serviceFor(agent, 'systemPrompt')` 为空，而 `agent.ctx.get('systemPrompt')` 可稳定取得目标 Agent 专属系统提示词服务，且真实对话轮次组装时 `assembly.scope === agent` 严格成立、不污染全局或其他会话。
  - 右栏彻底切换为宿主原生 `conversation.content`（`embedded` 模式），补齐打开完整会话、删除对话、空状态自动建会话、超长选段转原生文件附件、引用与旧版 `[p.N]` 跳回定位、真实能力检测入口，并全面升级学术翻译/精读提示词与阅读器视觉交互体验。
