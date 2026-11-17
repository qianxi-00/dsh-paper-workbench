# dsh-paper-workbench

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：**论文工作台**。

左侧导航多一行「论文工作台」：左区是**文献库 + 目录 + 双语学术阅读器**（支持 **双语 / 并排 / 原文 / 只看译文** 四种排版、PDF 原文页、高亮笔记与 Obsidian 卡片），右栏直接嵌入 **DSH 原生 Agent 会话**。

右栏复用宿主原生 `conversation.content` 组件：消息流、思考过程、工具调用、模型与思考程度、权限、附件、语音输入和排队均由 DSH 原生管理；插件只负责精确的会话绑定、论文范围关联、阅读定位与快捷提问（`导读` / `总结全文` / `讲解本节` / `讲解选中` / 双击段落）。点右栏顶部的 `↗ 完整页` 可跳到主界面同一条完整会话，历史、运行状态与附件完全一致。
翻译继续作为独立工具，通过 SSE 逐段生成并存入本地 SQLite（`workbench.db`），不进入聊天历史或污染对话上下文。

> 状态：0.8.0。已完成真实 DSH 桌面端公开 `Factory / SessionProvider / SystemPrompt.context` 挂载与作用域隔离验证，并兼容三代以上 DSH 宿主版本。

## 能做什么

- **宿主分栏与三栏阅读**：左侧文献库、目录与右侧原生会话均可拖拽调宽、双击分隔条复位（会话栏默认 420px）、一键收起/展开；窄窗口自动切换为覆盖抽屉，状态跨端口重启持久恢复。
- **四种学术对照排版**：`双语`（上英衬线 + 下中无衬线微缩进，拖选默认只复制干净英文原文）、`并排`（宽屏双栏对齐阅读）、`原文`（临时隐藏译文专注英文）、`只看译文`；正文与图注均支持行内/块级 KaTeX 公式排版与复制还原 `$...$`。
- **文献库**：按专题分组（默认全部收起）、记住展开状态；上传 PDF、按本地路径导入、从 Obsidian 卡片反查原始 PDF 批量入库；移出进回收站，**回收站可以恢复**（`🗑` 按钮）。
- **图表与表格还原**：版面或空白带定位自动裁剪正文图表（含矢量图），表格默认展示原图并可展开可复制的真表格结构；点击图片看高清大图。
- **文内搜索**：`🔍`（或阅读区 `Ctrl/⌘+F`，不抢占右侧原生输入框快捷键）检索段落与标题，点击命中平滑滚动定位并高亮。
- **PDF 深色**：`◐` 三档（关 / 柔和 / 强），只反相页图，文字层与译文不动，夜间看图不刺眼。
- **独立逐段翻译与自检**：`译` 开关、`译本节`、`整篇翻译` 在阅读器内流式推进、可随时 `停止`，失败段落一键 `重试失败 N`；右侧 `工具 ▾` 菜单收纳 `目录翻译`、`译文自检`、`版面解析`、`重填文字`、`版面质量` 与 `任务日志`，界面清爽不臃肿。
- **原生 Agent 深度联动**：`导读`（3 分钟把握痛点、核心直觉与阅读路线）、`总结全文`、`讲解本节`、划词 `发送到会话` / `解释公式/术语`、双击段落直接提问。选段 100% 完整保留；超过单条直发上限（>24,000 字符）时支持一键**转为原生文本附件发送**，绝不静默截断；忙时自动进入原生队列，绝不覆盖输入框草稿或待发附件。
- **精准论文引用跳回**：Agent 调用论文工具返回带 `paperId / page / blockId / revision / sectionId` 的引用链接（同时兼容旧 `[p.N]` 引用），点击直接定位到对应段落或章节；版本变更时自动降级定位到原文页并提示。

## 环境要求

| 需要 | 版本 | 没有会怎样 |
| --- | --- | --- |
| DeepSeek Harness 桌面端 | 带 `webServer` / `tools` / `sessionController` 的版本 | 装不上 |
| Node.js | ≥ 20（宿主自带） | 低于 22.5 时 `node:sqlite` 不可用，译文自动退化成 JSON 存储，功能不受影响 |
| Python 3.10+ 与 `PyMuPDF`（`import fitz`） | 推荐 | 页图、段落模型、对照、翻译都用不了，只能走浏览器原生 PDF 查看器 |
| Obsidian（桌面端） | 可选 | 「卡片」页签与写入不可用，其余照常 |
| PaddleOCR API Key（百度 AI Studio） | 可选 | 扫描件只能看页图，不能 OCR/翻译/检索；文本层正常的 PDF 不受影响 |

插件**零 npm 依赖**、不需要构建、不会动你的 `node_modules`；除了你主动发起的 arXiv/OpenAlex 检索与
PaddleOCR 识别，它不向第三方发请求。

### 多版本 DSH 兼容保障

插件对宿主公开接口做了分层探测与优雅降级，兼容至少三代稳定 DSH 版本：

1. **现代桌面版 DSH（推荐）**：完整启用 `conversation.content`（`embedded`）、`SessionProvider`、`sessions.retain`、`fileUpload.upload`、`uiWorkspace.openSession` 以及 `agentPresets.serviceFor` / `agent.ctx.get('systemPrompt')` 双通道论文作用域注入。
2. **较早桌面版 DSH（无 `agentPresets` 或旧版路由）**：自动回退 `agent.ctx.get('systemPrompt')` 注册上下文、`layout.selectPanel('main.conversation')` 打开会话、`workspaceController` 解析跟随模型。
3. **精简 / 无原生会话组件的宿主（或独立 `dev-server`）**：诚实提示缺失的公开契约（绝不用自绘气泡伪装原生会话），同时保证文献库、阅读器、独立 SQLite/JSON 翻译、OCR 与设置页环境自检 100% 可用。

## 安装

装完插件记得在「插件」页把它**启用**，然后重启桌面端（宿主侧代码只在插件加载时执行一次）。

### 方式一：插件市场或 npm（推荐）

桌面端 → 设置 →「插件」→ 市场里搜 `paper-workbench`，或直接装 npm 包：

```bash
dsh plugin --profile desktop add dsh-paper-workbench
```

### 方式二：从 GitHub 装

```bash
dsh plugin --profile desktop add github:qianxi-00/dsh-paper-workbench
```

### 方式三：本地目录（开发、自用、改代码）

```bash
git clone https://github.com/qianxi-00/dsh-paper-workbench
dsh plugin --profile desktop add /absolute/path/to/dsh-paper-workbench
# 想边改边看效果用 link：dsh plugin --profile desktop add link:/absolute/path
```

也可以在桌面端「插件」页直接选本地包/链接。

> `dsh plugin` 只是把包装进 profile 的 `node_modules`；登记 bundle（`dsh.profile.bundles`）由桌面端的
> 插件页完成。命令行装完如果侧栏没出现「论文工作台」，去插件页启用一下即可。

### 装 Python 依赖

只有 PDF 取文本/渲页需要 Python，没有它插件照样能装、能开、能看页图（浏览器原生查看器）。

```bash
# Windows（PowerShell）
winget install --id Python.Python.3.12  # 或从 python.org 装，勾 Add to PATH
python -m pip install pymupdf

# macOS
brew install python && python3 -m pip install --user pymupdf

# Linux（Debian/Ubuntu）
sudo apt install python3 python3-pip && python3 -m pip install --user pymupdf
```

装好后不用重启：插件探测失败只缓存 30 秒，在设置里点「重新检测」或直接重开插件即可。

解释器按这个顺序找：设置里填的路径 → `DSH_PAPER_PYTHON` → `PYTHON` → `python3`/`py`/`python`
（Windows 上还有本机常见的 Anaconda 路径）。全部失败时 `doctor` 会告诉你差什么。

### 装完自检

```bash
npm run doctor    # 在源码目录里跑；从 npm 装的包也可以直接 node scripts/doctor.mjs
```

Windows 用户没有 `npm` 也没关系：桌面端 → 论文工作台 → `⚙ 设置` →「环境自检」按钮，报告是同一份
（Node 版本、数据目录可写、SQLite 引擎、Python/PyMuPDF、Obsidian vault、模型、DSH 宿主能力、OCR Key）。
它按 `ok / warn / FAIL / skip` 分级，每条都带一句「怎么办」。

## 配置

零配置可用：默认跟随 DSH 当前模型、自动探测 Python 与 Obsidian vault、数据放
`~/.dsh/paper-workbench`。要改的都在 `config.json`（设置页改的是同一份文件）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `storage` | `link` | `link` 只记 PDF 原路径；`copy` 把 PDF 复制进 `papers/<id>/paper.pdf` |
| `python` | `''` | 留空自动探测；填绝对路径可钉死解释器 |
| `vault` / `kb` | `''` | 留空自动从 Obsidian 配置里找 open 的 vault 与「论文知识库」目录 |
| `ocr.token` | `''` | PaddleOCR Key；写入后文件自动收紧到 0600，界面只回显示尾号 |
| `ocr.model` | `PaddleOCR-VL-1.6` | 也可 `PP-StructureV3` / `PP-OCRv6` |
| `ai.translateModel` / `ai.chatModel` | `null` | `null` = 跟随当前会话模型；也可钉 `{provider, model}` |
| `ai.temperature` | `0.2` | 翻译/对话温度 |
| `workspace.title` / `workspace.path` | `论文` / `<数据根>/论文` | 原生会话归属的工作区 |

环境变量（兜底用，适合多套数据或测试）：

| 变量 | 作用 |
| --- | --- |
| `DSH_PAPER_WORKBENCH_DATA` | 换数据根（默认 `~/.dsh/paper-workbench`） |
| `DSH_PAPER_PYTHON` / `PYTHON` | 指定 Python 解释器 |
| `PB_DB_PATH` / `PB_DB_ENGINE` | 换 SQLite 库位置 / 强制 `json` 退化引擎 |

## 用起来

1. 左栏点「论文工作台」。首次可以「按路径导入」一篇 PDF，或「在线检索」。
2. 选中论文后默认进入 `对照`：滚轮往下就是全文，原文段下面跟着中文（点 `译` 或 `译本节` 才翻，不自动烧钱）。
3. 目录点一下只跳到那一节；想翻哪节就按那一行右侧的 `译` / `讲`。
4. `整篇翻译` 会先告诉你「N 节 · M 段」，确认后按节串行推进，状态栏显示进度，`停止` 立即中断并保留已翻部分。
5. 右侧新建或选一条对话，点 `＋ 本篇` 关联论文后可直接手输问题；目录的 `讲` 与划词动作也会自动关联本篇。论文引用链接可跳回对应原页或段落。
6. `精读整篇` / `导读` / `写入卡片` 等快捷操作同样送到右侧当前会话，执行状态、工具调用和结果在原生界面里查看。
7. 左栏勾选 ≥2 篇 → `对比综述` → 对比表 + 研究脉络，写入 `方向综述/`。

## 翻译（独立请求，不进入会话）

- **走谁**：默认跟随 DSH 当前模型；`⚙ 设置 → AI` 可以给「翻译」和「对话」分别钉一个模型（列表来自 DSH 已配置的 provider/model），
  也可调温度（默认 0.2）。插件**不读也不存**任何 API Key，请求一律通过宿主 `ctx.llm`，用哪个 provider/model 由设置决定。
- **段落模型**：打开论文时按 PDF 文本层（扫描件用 OCR 结果）切段落、按目录分节，段落 hash 是缓存的键。
  公式/图表段不送翻译，只提示「见原文页 p.N」。
- **批量与容错**：一批最多 6 段、2000 字符；模型回的不是合法 JSON 时自动退化成逐段重发；被 `max-tokens` 截断就把预算翻倍重试一次。
- **缓存**：译文按 hash 存进 SQLite（`translations` 表），默认不覆盖（想重翻按 `重新翻译`）；标题另存 `t:<hash>`，`目录翻译` 一次请求翻一批。
- **名单不翻**：作者/机构那一行（带 `†`、逗号连排人名、没有句末标点）不进翻译请求；模型把原文原样返回时记为 `skipped`，不会在英文下面再贴一遍英文。
- **版面解析后可以「重填文字」**：`PP-StructureV3` 的 OCR 文字有错字（`rnibenoder` 这类），我们只借它的结构、正文一律回填 PDF 文本层；早期解析出来的 `layout.json` 用工具栏的「重填文字」（`layout.refill`）就地换掉，不上传、不花配额。
- **划词翻译**：选中原文点 `翻译`，译文**直接贴在那一段下面**（不经过对话）。它是独立小工具：每次都是全新的一次模型请求，
  读不到段落模型时（原文页 / 纯文本页）走 `/ai/translate` 的一次性通道，不写译文库、不写对话、不进上下文。
- **公式卫生**：prompt 明确要求行内公式只写一次 `$...$`；返回的译文还会过一遍 `tidyMath`（去 MathML、`\(...\)`/`\[...\]` → `$...$`、公式内换行压平）。
- **对话与翻译分开**：原生聊天使用所选会话的模型与历史。此处的 AI 翻译设置仅控制翻译工具；独立打开旧阅读页面时仍保留旧聊天模式，嵌入 DSH 的阅读器不会启动旧聊天流。
- **界面记忆**：当前论文、页签、页码、滚动位置、三栏宽度、文献树展开状态都记在浏览器本地，并同步一份到服务端（`ui.json`）；关掉面板再打开、甚至桌面端重启换了端口，都会回到离开时的位置。
- **停止**：翻译与对话都能中途停；停止后已收到的段落/片段保留。

## 原生会话与论文联动

宿主主区左侧保留阅读 iframe，右侧通过 `conversation.content` 的 `embedded` 模式挂载原生会话。插件只提供论文关联、定位和快捷提问，原生消息流、工具卡片、输入框与模型选择均由 DSH 管理。

- **精确绑定**：只连接顶部选定的 `pb-conv-*` 会话，不猜最近会话。切换或退出释放对应引用；关闭会话栏不取消后台 Agent。新建对话准备宿主会话时不发送空消息。
- **论文范围**：标题下的论文标签是当前关联范围。范围通过目标 Agent 的上下文扩展提供，普通手输问题也能使用；阅读一篇未关联论文不会把它悄悄加入对话。上下文不可用时显示原因并阻止论文快捷发送，普通聊天仍可使用。
- **完整选段**：正文内容作为用户引用材料发送，保留完整文字、页码和版本定位。点目录中另一节的 `讲` 始终以该节为准。快捷发送进入原生队列，不覆盖输入框里尚未发送的草稿或附件。
- **引用回读**：链接携带论文 id、页码，以及可用的 blockId / revision；点击后在中间阅读器定位。段落版本已变更时回到原页并提示，不把旧引用指向另一段。
- **恢复与兼容**：继续使用 `chats.json` 中已有的会话 id；新 UI 状态按版本写入 `ui.json`，同时保存阅读位置、会话选择、会话栏宽度与开关。旧 `chat.json`、旧附件和 SQLite 译文均保留。

| 能力 | 使用方式与边界 |
| --- | --- |
| 模型、思考程度、工具与权限 | 使用原生控件，具体可选项以当前会话、模型和 Agent 配置为准 |
| 文件与图片 | 使用原生附件入口；格式、大小及视觉能力遵循宿主和模型限制，上传回执归属于接收它的会话 |
| 阅读链接、联网搜索 | 在原生会话中提交链接或问题；目标会话需要相应工具，插件不假定每个 provider 都有 DeepSeek 专有工具 |
| 语音输入 | 宿主安装并启用语音能力后使用原生入口；本插件不自动安装语音包，不提供语音合成 |
| 旧附件 | 继续作为已存本地文件引用，不转换或跨会话复用原生上传回执 |

DeepSeek 的 [Chatbot 指南](https://api-docs.deepseek.com/zh-cn/guides/build_a_chatbot) 用于参考交互层次；最终渲染和能力来源是当前安装的 DSH 原生组件。

### 工作区：所有会话都在「论文」下

DSH 侧栏按会话的工作目录分组。插件不再按每篇 PDF 所在目录各建一个工作区，而是把所有
会话都挂到同一个**「论文」工作区**（默认目录 `<数据根>/论文`，即
`~/.dsh/paper-workbench/论文`）。想换位置或改标题，在 `config.json` 里加：

```json
{ "workspace": { "title": "论文", "path": "G:\\笔记\\LLM知识体系论文" } }
```

改完重开插件生效。注意：**改动前已经建好的会话**其工作目录是旧的，仍会留在原来的分组里
（宿主的会话头不可改写）；之后新开的对话都会落到「论文」下。

## 存储（SQLite）

译文、任务日志、自检结果存在 `~/.dsh/paper-workbench/workbench.db`（Node 22.5+ 的 `node:sqlite`，WAL 模式）：

| 表 | 内容 |
| --- | --- |
| `translations` | 段落译文（`paper_id` + `key` + 文本 + 模型），标题键是 `t:<hash>` |
| `job_events` | 任务日志（翻译 / OCR / 自检的开始、进度、结束、失败） |
| `reviews` | 自检结果（issues + 统计） |
| `meta` | schema 版本 |

- 老版本的 `papers/<id>/trans.json` 会在第一次读取时**自动迁移**进库，并把原文件改名成 `trans.json.migrated`。
- 用 `PB_DB_PATH` 可以换库位置；`PB_DB_ENGINE=json` 强制走 JSON 退化实现（Node < 22.5 或想手工看内容时）。
- 备份/拷贝/清理前先让插件关库（`closeDb()`），WAL 会在库旁边留 `-wal` / `-shm`。

## 版面解析（可选，PP-StructureV3）

文本层切段落是「按字号/缩进猜」：单栏论文一章可能只有一两段，图里的标签会被当正文，
整页表格会变成几百个脚注。**版面解析**把 PDF 交给 PaddleOCR 的版面模型
（`PP-StructureV3`），直接拿它的块级结果：阅读顺序、`paragraph_title`/`text`/`figure_title`/
`table`/`formula`/`footnote` 标签、每个块的 bbox。图表位置、公式 LaTeX、表格 HTML 都在里面。

结构走模型、文字走文本层：模型只用来定「块在哪、是什么类型」，每个块的正文由统一
IR（`lib/layout-ir.js`）从 service / PaddleOCR-VL / PDF 文本层三类候选里逐块择优——
服务端 OCR 认字有错（`tokns`、`ReTRo[OF]`），原生 PDF 的文本层是准的，不能把错字
带进对照视图和翻译。

每次解析的**原始响应会按内容 sha256 永久归档**（`papers/<id>/layout-data/raw/`），发布结果
是**不可变版本**（`layout-data/revisions/<revision>.json` + `current.json` 指针），
`layout.json` 只是兼容投影；以后规则改进可以离线重放，不必重新上传/付费。每页都会带
`status: ready|needs_review|failed` 和问题清单：`failed` 的页不发布新版本，`needs_review`
的页在工具栏的 **`质量`** 按钮里报告出来，点页号直接跳原页核对。

跑一次：

```bash
# 命令行（会提示确认；PDF 会整本上传、按页计费）
node scripts/layout.mjs <论文 id>            # 结果写 papers/<id>/layout.json
```

面板里也有入口：对照工具栏的 **`版面`** 按钮（先弹确认，说明会上传 PDF、耗时与计费），
解析完自动重建文档模型与配图清单。设置页没有单独开关——**默认不解析**，
因为这是收费的第三方云调用，不应该在你不知情的时候发生。

解析是**后台任务**，不是「一次请求干到底」：点完按钮请求立刻返回，进度用
`layout.status` 轮询，面板关掉、切到别的论文、甚至刷新页面都不会把它带走；
已经跑完的批次逐批落盘（`layout.partial.json`），断网/崩溃/手动取消之后
按钮会变成 **`续跑版面 N 页`**，只补没跑完的页，**已完成的页不会重新上传、不会重复计费**。
如果断在「已经提交、还没轮询到结果」的窗口，断点里会保存云端 `jobId`，下次优先续拉同一个任务，而不是重传这一批。
取消只是停在这一批结束，已经拿到的结果保留。

解析后：

- 对照视图按模型的阅读顺序分段，图/表渲染在**自己原来的位置**（不再按「图 N」字样猜着挂）；
- 表格显示裁剪图，下面可以展开「表格纯文本」和「表格结构」（真表格：可选中、可复制、超宽横向滚动）；
  格子按 PDF 的格线切（PyMuPDF），没有格线的表才退回版面模型的表格 HTML；两者都要过可信度门槛，
  过不了就只给裁剪图 + 纯文本，不硬画一张错的表；
- 公式用 **KaTeX** 排版显示（打包在插件里，不连外网 CDN；加载失败只退回源码），不送翻译；
- `doc.get` 的 `source` 变成 `layout`，`layoutAt` 记录解析时间；PDF 换版本（size/mtime 变了）会自动退回文本层；
- 想退回文本层：调一次 `layout.clear`（或删掉 `layout.json`），下次打开会重建。
- 只补表格结构（不重新上传、不花额度）：`layout.tables`，给老的 `layout.json` 回填。
- 查看质量报告：`layout.report`（或工具栏「质量」按钮），列出每页状态、问题数和被排除的块。
- 规则升级后想就地重建：`node scripts/quality/rebuild-layout.mjs <论文 id>`（默认 dry-run，不重新上传、不花额度；加 `--apply` 才发布为新 revision，旧版本保留）。
- 缺页兜底：`layout.start({maxCloudPages:N})` 且 PP-StructureV3 整页缺失时，才用 `PaddleOCR-VL-1.6` 补一轮（默认 0，不额外计费）。

已知取舍：被模型标成正文、其实是一整行公式的块，仍会按普通文字显示（符号顺序可能错，
可点「见原文页」对照）；表格默认是「图 + 文字」，结构要展开才能逐格选中；
版面模型对双栏论文的段落切分仍可能把一段拆成两段（我们用「服务端文字做证据」把掉进块缝里的首行补回来，
但模型自己切错的地方补不了）。

## 中文版 PDF（把译文写回原版面）

对照视图的右栏是「重排后的阅读稿」：段落、图、公式都在，但行宽和换行跟原页不是一一对应的。
想要**跟原版一眼对得上**的中文，可以把译文直接写回 PDF 的同一位置，生成
`papers/<id>/paper-zh.pdf`，原文页切到「中文版」就渲染它 —— 左边原图、右边中文版，
逐页对齐（这就是参考项目用 BabelDOC 做的事，代价小得多，也完全本地）。

怎么用：

- 先有译文（几句也行，整篇也行）。工具栏 **`中文版`** 按钮 → 确认（说明纯本地、不上传）→
  几秒后按钮变 `中文版 ✓`，原文页开始渲染中文版；再点一次切回原 PDF。
- 命令行等价物：`POST /paper-workbench/api/zhpdf.build {"id":"<论文 id>"}`。
- 只替换**有译文**的段落；没译的段落保留英文。公式、图、表格原样不动。

做法（`assets/pdf_tool.py` 的 `zhpdf` 命令）：

1. 用 PDF 自己的文本行给每个块定位 —— 不直接信版面模型的 bbox（实测有十几 pt 偏移，
   照 bbox 擦会留下半行英文），而是拿块原文逐行比对（`difflib` 相似度 ≥0.62），
   认到的行并集才是擦除/绘制的框；一行只归一个块。
2. `redact` 掉这些行（`PDF_REDACT_IMAGE_NONE` + `PDF_REDACT_LINE_ART_NONE`：图片和
   矢量图都不动），先铺一层白底（有些 PDF 把标题画成了路径，`redact` 擦不掉），
   再用中文重写。
3. 中文字体优先用系统字体（Windows 的 `simhei`/`Deng`、macOS 的 `PingFang`、
   Linux 的 `Noto Sans CJK`；`DSH_PAPER_ZH_FONT` 可指定），这样英文单词不会变成
   「G P T - 4」；找不到才退回 PyMuPDF 内置的 `china-s`。字号从原字号开始试，
   放不下就往下借空白，再不行才缩小。

已知取舍：译文比原文长很多时字号会被压小；矢量路径画成的标题可能有残字（已铺白底，
个别字体仍会露一点）；只写了译文的段落，未翻译的图注/脚注仍是英文；合并单元格的表格
不会有结构（表格本来就是原图，不动）。

## 扫描件 OCR（PaddleOCR 云端接口）

扫描件（整页是图片）没有文本层，读不了、译不了、搜不了。工作台把这类 PDF 送到 **PaddleOCR 官方
AISTUDIO 任务接口**（`https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`）识别，结果按页存成
`ocr.md`（`## p.N` 分段，与 `zh.md` 同一种格式），之后翻译、检索、问答都能用。

1. **填 Key**：`⚙ 设置 → 扫描件 OCR`，粘贴 AI Studio 的 API Key 并保存。
   Key 只写进本机 `~/.dsh/paper-workbench/config.json`（自动收紧到仅本人可读写），
   界面只回显 `4148…c5f0` 这样的尾号，**不回传明文、不进日志、不进仓库**。
2. **跑 OCR**：打开扫描件，`文本` 页会提示「没有文本层」，点 `OCR 识别整篇`（顶部也有 `OCR 识别` 按钮）。
   提交后按页轮询进度，完成后自动切到文本页按页显示识别结果。
3. **换模型**：`PaddleOCR-VL-1.6`（默认，版面 Markdown，公式/表格/图片位置保留得最好）、
   `PP-StructureV3`（结构化版面）、`PP-OCRv6`（纯文字，最快最省）。

会话里的 agent 也能做同样的事：`paper_ocr action=start` 提交 → `action=status` 轮询 →
`action=read` / `action=pages` 读结果；此后 `paper_read` 在这些页上会自动改读 OCR 文本。

注意：OCR 是**收费/限量的第三方云服务**，PDF 会上传到百度 AI Studio；敏感或未公开的材料别这么送。
默认 `storage=link` 不影响这一点——上传的是 PDF 文件本身。识别时间与页数成正比（通常每页数秒），
页数多时建议先 `pages` 抽几页看质量。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `paper_library` | 列/查/改/删文献库条目（`action=list/get/update/remove/topics`） |
| `paper_read` | 读正文（`pages="1-5"`）、目录、元数据；扫描件自动改读 OCR 文本 |
| `paper_doc` | 读结构化段落（`id` / `sectionId` / `pages` / `maxChars`），按节输出 `[p.N](段落hash)`，供整本理解与翻译 |
| `paper_ocr` | 扫描件 OCR：`action=start/status/read/pages`（PaddleOCR 云端） |
| `paper_import` | 按 `path` / `arxivId` / `doi` / `query` 入库 |
| `paper_search_online` | arXiv + OpenAlex 检索（不下载） |
| `paper_notes` | 读写高亮笔记 |
| `paper_obsidian` | 卡片 `status/scan/read/upsert/survey/search/open` |
| `paper_translate` | 把某一页译文追加到 `zh.md` |

## HTTP 接口

| 路由 | 说明 |
| --- | --- |
| `GET  /paper-workbench/app` | 工作台页面（主区 iframe 的内容） |
| `POST /paper-workbench/api/<method>` | JSON RPC，如 `library.list`、`pdf.text`、`doc.get`、`ai.models`、`trans.get`、`chat.get`、`search.doc`、`figures.list`、`logs.list`、`review.run`、`trash.list`、`session.status`、`session.prepare`、`paper.context.get`、`paper.context.set`、`ui.get`、`ui.set`、`conv.list`、`vault.upsert`、`layout.status`、`layout.run`、`layout.clear`、`layout.refill`、`layout.tables`、`zhpdf.status`、`zhpdf.build`、`zhpdf.clear` |
| `POST /paper-workbench/ai/translate` | SSE 逐段翻译（事件 `start/delta/done/error/end`） |
| `POST /paper-workbench/ai/chat` | 独立阅读页的旧 SSE 对话接口；原生嵌入模式不调用 |
| `POST /paper-workbench/ai/cancel` | 取消正在跑的流式请求（`{reqId}`） |
| `GET  /paper-workbench/session/follow?conv=` | 兼容独立阅读页的会话事件流；嵌入模式由原生组件管理订阅 |
| `GET  /paper-workbench/api/page?id=&page=&scale=&source=` | 页图 PNG（按需渲染，带磁盘缓存；`source=zh` 渲染中文版 PDF） |
| `GET  /paper-workbench/api/figure?id=&index=` | 正文配图 PNG（`figures.json` 的数组下标） |
| `GET  /paper-workbench/api/raw?id=` | 原始 PDF（支持单段 Range，供浏览器查看器） |
| `POST /paper-workbench/api/upload?name=` | 上传 PDF 原始字节 |

只接受本机 Host（localhost / 127.0.0.1 / [::1]）。

## 结果都存在哪（不会重复跑）

工作台把「算出来的东西」全部落盘，关掉 DSH、重启、换端口都不会重算：

| 结果 | 存在哪 | 什么时候失效 |
|---|---|---|
| 文本块 | `papers/<id>/text.json` | 源 PDF 的 size/mtime 变了 |
| 对照文档模型（段落/分节/公式/表格/配图索引） | `papers/<id>/doc.json` | PDF 换了版本，或版面解析结果换了 |
| 版面解析 | `papers/<id>/layout.json` | 手动 `layout.clear`，或 PDF 换版本 |
| 版面断点 | `papers/<id>/layout.partial.json` | 解析成功后被清掉；PDF 换版本后下次续跑会丢弃 |
| 配图清单与裁剪图 | `papers/<id>/figures.json`、`.figures/*.png` | PDF 换了版本，或版面结果变了 |
| 中文版 PDF | `papers/<id>/paper-zh.pdf` | 手动 `zhpdf.clear`；重新翻译后可再生成一次（覆盖） |
| 译文 | `workbench.db` 的 `translations` 表 | 手动清除；段落 hash 变了（重新切段）就对不上旧译文 |
| 任务日志 / 自检 | `workbench.db` 的 `job_events` / `reviews` 表 | 手动清除 |

最后一行是唯一要注意的：译文按「段落文字 hash」存，重新跑版面解析会换一套分段，
旧译文还在库里但不会再贴到新段落上（贴之前先确认要不要重译）。

## 数据放在哪

```
~/.dsh/paper-workbench/
  config.json            # 设置（python 路径、vault/kb、存储方式、OCR、AI 模型）
  workbench.db           # SQLite：译文 / 任务日志 / 自检结果（WAL，旁边有 -wal/-shm）
  index.json             # 文献索引（原子写，保留 .bak）
  chats.json             # 对话清单（标题 / 论文范围 / 附件清单；对话正文在 DSH 会话里）
  chats/<对话id>/files/  # 对话附件（提问时把绝对路径告诉 agent）
  ui.json                # 界面记忆（服务端副本，跨端口不丢）
  论文/                  # 原生会话的「论文」工作区目录（可在 config.workspace.path 改）
  papers/<id>/           # 每篇一个目录
    meta.json
    paper.pdf            # storage=copy 时的库内副本
    text.json            # 文本块缓存（按源 PDF mtime+size 失效）
    doc.json             # 段落/分节模型（按 PDF sha1 + 目录指纹缓存，段落 hash 是翻译的键）
    figures.json         # 正文配图清单（页、bbox、图注、label；有 layout.json 时来自版面模型）
    layout.json          # 版面解析结果（PP-StructureV3 的块、图表 bbox、公式/表格；可选）
    layout.partial.json  # 版面解析的断点（逐批落盘的页；完成或被清掉后不在了）
    layout.job.json      # 后台任务状态（阶段 / 页数 / 失败原因；面板据此显示进度与「续跑」）
    trans.json.migrated  # 老版本的译文文件（迁移进库后归档）
    chat.json            # 「本地」对话历史（最近 200 条）
    notes.json           # 高亮
    zh.md                # 中文版（## p.N 分段，会话侧翻译产物）
    ocr.md               # 扫描件 OCR 结果（## p.N 分段）
    .figures/.stamp      # 配图缓存指纹：figures.json 变了就重裁 PNG
    ocr.json             # 最近一次 OCR 任务状态（进度/错误）
    .figures/            # 配图 PNG 缓存
  .pages/<id>/           # 页图缓存
  .trash/                # 回收站（可恢复 / 彻底删除）
```

- 默认 `storage=link`：只记原路径，不复制 PDF；可改成 `copy`。
- 写入 Obsidian 前会备份为 `<卡片名>.pb-backup.md`（只留一份），内容没变不落盘。
- 除你主动发起的 arXiv / OpenAlex 检索与 PaddleOCR 识别外，插件不向第三方发请求。

## 开发

```bash
npm run dev       # 独立调试服务器 http://127.0.0.1:57571/paper-workbench/app（读真实库）
npm run dev:mock  # 同上，但翻译/对话用假模型，数据目录也换到 %TEMP%\pb-dev-mock（不污染真实库）
npm run seed      # 塞几篇本机样例论文（幂等）
npm test          # store 并发 + SQLite + 安全（回收站/并发写）+ 对话 + 工具层 + 段落模型 + AI + 自检 + 日志 + 配图 + 会话桥 + Obsidian + arXiv + OCR + 环境自检 + PDF 自检
npm run doctor    # 环境自检：Node/数据目录/SQLite/Python/Obsidian/OCR/模型/宿主
npm run smoke -- http://127.0.0.1:57571   # 打一遍 HTTP 接口（含 SSE 翻译/对话、搜索、配图、日志、自检、回收站）
npm run fix:library                       # 干跑一次库体检（重复条目/文件名式标题），加 -- --apply 才动库
```

`scripts/dev-server.mjs` 与宿主共用 `lib/server.js` + `createApi()` + `createStreams()`。原生 Factory、会话引用和 Agent 上下文还必须在真实 DSH 中验收，开发服务器不能替代这部分验证。
`--mock-llm` 注入一个假 `llm`（按 prompt 标记回 JSON / 中文），不联网、不消耗配额，也不会把假译文写进你的真实库。

目录：

```
lib/index.js    宿主入口（路由 + API + 工具注册 + 把 ctx.llm/sessionController 注入各层）
lib/server.js   HTTP 处理（宿主与 dev-server 共用，含 SSE 与取消）
lib/store.js    本地存储（索引/笔记/段落模型落文件，译文/日志/自检落 SQLite，原子写）
lib/db.js       SQLite 存储层（node:sqlite + 同名 JSON 退化实现）
lib/doc.js      段落模型（块合并、分节、hash、按 sha1 + 目录指纹缓存）
lib/ai.js       翻译与对话（批量、JSON 解析、退化重试、标题、公式卫生、SSE 事件）
lib/sse.js      SSE 输出（心跳、客户端断开即 abort）
lib/session.js  原生 DSH 会话桥（create/prompt/follow + 帧归一化）
lib/conv.js     对话形状、论文关联、兼容附件与范围提示词
lib/paper-context.js  Agent 作用域上下文、定位校验与版本化 UI 状态合并
lib/jobs.js     任务日志（开始/进度/结束/失败，纯依赖注入）
lib/review.js   译文自检（静态规则 + 模型批检）
lib/figures.js  正文配图（抽位图、按「图 N」挂段落、缓存 PNG）
lib/pdf.js      PyMuPDF 子进程桥
lib/obsidian.js frontmatter 行级合并、卡片定位/写入、检索
lib/arxiv.js    arXiv Atom + OpenAlex 解析、PDF 下载
lib/ocr.js      PaddleOCR 云端任务（提交/轮询/jsonl → 按页 Markdown）
lib/tools.js    9 个 agent 工具（裸 JSON-Schema）
lib/client.js   左栏入口 + 阅读 iframe / 原生会话分栏 + 精确会话绑定与联动
assets/app/     工作台 SPA（vanilla JS，三栏 + 对照视图 + 搜索/日志/回收站/自检/配图）
assets/pdf_tool.py  PyMuPDF 命令行协处理器（text / outline / render / clip / figures）
AGENTS.md             架构契约、安全红线、测试要求与持久化维护记忆
docs/v2-contracts.md  v2 的数据形状与接口契约
docs/v3-contracts.md  v3 新增模块（db / jobs / review / figures / session）的契约
docs/v8-native-session.md  v8 原生会话挂载、v2 桥接协议与多版本兼容契约
```

## 已知限制

- 扫描件要能读/译，得先走一次 OCR（「设置 → 扫描件 OCR」填 PaddleOCR Key）；OCR 结果是按页 Markdown，不还原图片位置。
- 对照阅读的粒度是「段落」。默认由 PDF 文本层按栏内顺序切；开了「版面解析」就按 PP-StructureV3 的块切，双栏/图表/公式都更准，代价是上传 PDF 与按页计费。
- 公式块用 KaTeX 排版显示，不送翻译；少数被版面模型标成正文的公式行仍按文字显示（符号顺序可能错）。
- 表格默认显示**原文裁剪图**；展开「表格结构」可以按行列选中/复制。结构来自 PDF 的格线（其次版面模型的 HTML），
  合并单元格、整列并进一格这类情况会被画错列——所以它默认折叠、旁边写着「以原图为准」。
- 配图裁剪靠「图注 + 空白带 + 绘图簇」，图注缺失或图与正文贴得极近时可能裁偏；极端情况宁可不贴图，也不把正文裁进去。
- 「中文版 PDF」是**覆盖式**的：把译文写回原页的同一位置（不重排版面、不下载 BabelDOC）。
  只替换有译文的段落，译文过长时字号会被压小；尽量先试排、放不下就整段跳过（保留英文，不会擦完留白）。
  跨页合并的段落（上一页末尾没写完、下一页接着写）暂不替换，同样保留英文；极少数矢量标题可能残留原字母。
- PDF 深色是**反相滤镜**，不是重新排版；彩色图会跟着变色，想要原色就切回「关」。
- 翻译自检是启发式：静态规则会误报（短标题、刻意省略），模型批检也可能漏；它只提示，不改你的译文。
- 原生嵌入依赖宿主的 `sessions`、`SessionProvider`、`conversation.content` Factory 与 `sessionController`；缺失时会显示错误，不把自绘聊天当作原生界面。单独打开阅读页仍兼容旧聊天。
- 论文快捷提问依赖目标 Agent 的作用域上下文。未完成隔离验证或服务不可用时，快捷提问会停止并显示原因；普通原生聊天、阅读和独立翻译仍可使用。
- 附件是否能直接被模型理解取决于宿主处理方式、模型能力和该会话的工具。旧版路径附件保留为本地文件，不会自动变为原生上传回执。
- 一个对话对应一条 DSH 会话，对话删掉只从工作台移除，DSH 里的会话记录仍在（要清理请去会话列表删）。
- 旧版路径附件上限为 40 个、单个 40 MB；新版原生附件使用宿主自身的限制。
- 回收站里的「彻底删除」除了 PDF 和元数据，还会删掉这篇的译文 / 任务日志 / 自检结果；恢复不了。
- `精读整篇` / `对比综述` 等 Agent 操作在当前选定的原生会话中执行，依赖 `paper_*` 工具。逐段或整篇翻译使用独立翻译工具，不写进会话输入框或历史。
- 只下载公开 PDF（arXiv / OpenAlex 开放获取），不绕过任何付费墙。
- 宿主代码改动不会热重载：改完需在插件页重新启用或重启桌面端；`assets/app/` 是静态文件，刷新页面即可。

## License

MIT
