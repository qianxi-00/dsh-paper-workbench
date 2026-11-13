# dsh-paper-workbench

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：**论文工作台**。

左侧导航多一行「论文工作台」：左边是文献库，右边是**对照阅读**（原文段 + 中文译文逐段穿插）、
PDF 页图、笔记与 Obsidian 卡片，最右侧是**面板内对话**。

理解与翻译不再需要退出工作台：翻译走插件自己的 SSE 流，逐段落到原文下方；讲解与追问在右侧对话抽屉里流式回答
（可以选「本地」自绘对话，也可以切成**原生 DSH 会话**，关掉面板还能在主界面接着聊）。
模型从 DSH 已配置的模型里选（默认跟随当前会话模型），也可以用 `paper_*` 工具让会话里的 agent 处理整本级别的工作。
译文、任务日志、自检结果都落在插件自己的 SQLite 库里，重启、换端口都不丢。

> 状态：0.3.x，接口与数据结构仍可能变动。

## 能做什么

- **三栏布局**：文献库 / 目录 / 对话三栏都能拖宽、双击复位、拖到最窄自动收起；顶栏三个按钮随时重开，状态存在本地。
- **文献库**：按专题分组（默认全部收起）、记住展开状态；上传 PDF、按本地路径导入、从 Obsidian 卡片反查原始 PDF 批量入库；删除进回收站，**回收站可以恢复**（`🗑` 按钮）。
- **对照阅读**：默认视图。节标题 + 原文段 + 中文译文连续滚动，`目录` 点击只跳转（不过滤内容），滚动时自动高亮当前节。
  段落按 PDF 版面切：标题/正文/列表/图注/脚注分开（图里的文字标签、页眉页码不会混进正文），整篇「一节一大段」的问题没有了。
- **图表还原**：图注下方（或上方）那张图会被裁成图片贴回正文，**矢量图也能抽**（按图注两侧的空白带定位，再从渲染页裁），表格整页裁成一张图；点图看大图。
- **文内搜索**：`🔍`（或 `Ctrl/⌘+F`）搜当前文档模型的段落与标题，命中列表带上下文，点一条就滚到那一段并高亮。
- **PDF 深色**：`◐` 三档（关 / 柔和 / 强），只反相页图，文字层与译文不动，夜里看图不刺眼。
- **面板内翻译**：`译` 开关、`译本节`、`整篇翻译`、`目录翻译` 全在面板里完成，SSE 逐段推、可随时 `停止`；译文按段落 hash 缓存在 SQLite，重开直接显示。失败的段落有 `重试失败 N` 按钮。
- **翻译自检**：`自检` 检查空译文、明显截断、残留英文、公式残留、页码残留等可疑段落（静态规则 + 可选模型批检），点 `定位` 直接跳到那一段。
- **面板内对话**：右侧抽屉，流式回答，回答里的 `[p.N]` 点开原文页；`讲解本节` / `讲解选中段落` / `总结全文` 一键追问。默认落进**真实 DSH 会话**（标题显示「对话 · DSH 会话」），也可切回「本地」自绘（按论文存历史）。
- **任务日志**：`日志` 抽屉记录翻译 / OCR / 自检的进度与失败原因，2.5 秒轮询刷新，可清空。
- **模型可选**：设置 → AI 里给「翻译」和「对话」分别指定 DSH 模型（默认跟随当前模型），温度可调。
- **原文页**：整篇**上下滚动连续阅读**（页与页首尾相接，只加载视口附近的页图，页码随滚动更新，输入页码可跳转）、缩放；PDF 书签目录（没有则按字号启发式）。
- **对话（多篇论文 + 附件）**：对话抽屉顶部可以新建 / 切换 / 改名 / 删除对话；一个对话可以挂多篇论文（`＋ 论文`）和多个附件（`📎`，单个上限 40MB），多轮问答天然持久，关掉面板回主界面还能接着聊。
- **正文配图**：把 PDF 里的位图按「图 N / Figure N」挂到提到它的段落下方（矢量图抽不到，见已知限制）。
- **在线检索**：arXiv / OpenAlex，支持关键词、arXiv ID、DOI；一键下载开放 PDF 入库。
- **理解与整理**：划词问 agent、双击段落解释、精读报告（摘要 / 方法 / 贡献 / 局限 / 可复现要点）、多篇勾选后生成对比综述（这些仍走会话，结果落回本地库与 Obsidian）。
- **扫描件 OCR**：没有文本层的 PDF 可以调 PaddleOCR 云端接口（PaddleOCR-VL-1.6 / PP-StructureV3 / PP-OCRv6）识别成按页 Markdown，之后照常对照、翻译、检索、问答。
- **Obsidian 联动**：直接读写已有「论文知识库」卡片；frontmatter **行级合并**（只改传入的键，保留未知字段、注释和书写风格），写前备份，幂等。

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
5. 右侧对话直接问；`讲解本节` / `讲解选中段落` / `总结全文` 是快捷指令，回答里 `[p.N]` 可点。
6. 要把结果带回主会话：对话气泡上的 `插入到会话`，或用顶部仍保留的 `精读整篇` / `整本翻译` / `导读` / `写入卡片` 等会话指令。
7. 左栏勾选 ≥2 篇 → `对比综述` → 对比表 + 研究脉络，写入 `方向综述/`。

## 翻译与对话（面板内，不占用会话）

- **走谁**：默认跟随 DSH 当前模型；`⚙ 设置 → AI` 可以给「翻译」和「对话」分别钉一个模型（列表来自 DSH 已配置的 provider/model），
  也可调温度（默认 0.2）。插件**不读也不存**任何 API Key，请求一律通过宿主 `ctx.llm`，用哪个 provider/model 由设置决定。
- **段落模型**：打开论文时按 PDF 文本层（扫描件用 OCR 结果）切段落、按目录分节，段落 hash 是缓存的键。
  公式/图表段不送翻译，只提示「见原文页 p.N」。
- **批量与容错**：一批最多 6 段、2000 字符；模型回的不是合法 JSON 时自动退化成逐段重发；被 `max-tokens` 截断就把预算翻倍重试一次。
- **缓存**：译文按 hash 存进 SQLite（`translations` 表），默认不覆盖（想重翻按 `重新翻译`）；标题另存 `t:<hash>`，`目录翻译` 一次请求翻一批。
- **划词翻译**：选中原文点 `翻译`，译文**直接贴在那一段下面**（不经过对话）。它是独立小工具：每次都是全新的一次模型请求，
  读不到段落模型时（原文页 / 纯文本页）走 `/ai/translate` 的一次性通道，不写译文库、不写对话、不进上下文。
- **公式卫生**：prompt 明确要求行内公式只写一次 `$...$`；返回的译文还会过一遍 `tidyMath`（去 MathML、`\(...\)`/`\[...\]` → `$...$`、公式内换行压平）。
- **对话**：每条问题带上当前节的原文上下文（必要时压缩），流式 SSE 返回。默认走**原生 DSH 会话**（见下节），切到「本地」时历史按论文存 `chat.json`（保留最近 200 条），`清空` 只清当前论文。
- **界面记忆**：当前论文、页签、页码、滚动位置、三栏宽度、文献树展开状态都记在浏览器本地，并同步一份到服务端（`ui.json`）；关掉面板再打开、甚至桌面端重启换了端口，都会回到离开时的位置。
- **停止**：翻译与对话都能中途停；停止后已收到的段落/片段保留。

## 原生会话（对话落进真正的 DSH 会话）

对话抽屉右上角有 `会话 / 本地` 切换：

- **会话**（默认，需要宿主提供 `sessionController`）：**一个对话 = 一条真实 DSH 会话**。
  对话可以同时挂多篇论文（`＋ 论文`）、上传附件（`📎`），多轮问答天然持久——关掉工作台面板，
  回主界面也能接着聊，agent 看得到整个对话的范围。
- **本地**：插件自绘对话，按论文存 `chat.json`，不写进任何会话。老宿主（没有 `sessionController`）会自动退回这一档。

### 对话（多篇论文 + 附件）

- 对话列表在对话抽屉顶部（点标题展开）：切换、新建、改名、删除；对话正文不复制到插件里，
  它就在 DSH 会话里。
- **论文范围**：每个对话挂若干篇论文，标题下的一排 chip 就是这次对话的上下文。提问时插件会在
  你输入的话前面加一段「本次对话的论文范围」（标题 / id / 页数 / PDF 路径），并提示 agent
  用 `paper_read` / `paper_doc` 取正文，不要凭空猜。
- **附件**：`📎` 选本地文件（单个上限 40MB），文件复制到 `~/.dsh/paper-workbench/chats/<对话id>/files/`，
  提问时把**绝对路径**告诉 agent，让它用文件工具读。注意：宿主 `sessionController.prompt` 只接受文本，
  所以图片不能直接"看"，只能以文件形式交给 agent 读。
- 会话 id 是 `pb-conv-<对话id>`；对话元数据（标题、论文清单、附件清单）存在 `chats.json`，
  对话内容本身在 DSH 会话库里。

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

结构走模型、文字走文本层：模型只用来定「块在哪、是什么类型」，每个块的正文仍然按 bbox
从 PDF 文本层重新抠一遍（`pdf_tool clip_text/page_lines`）—— 服务端 OCR 认字有错
（`tokns`、`ReTRo[OF]`），原生 PDF 的文本层是准的，不能把错字带进对照视图和翻译。

跑一次：

```bash
# 命令行（会提示确认；PDF 会整本上传、按页计费）
node scripts/layout.mjs <论文 id>            # 结果写 papers/<id>/layout.json
```

面板里也有入口：对照工具栏的 **`版面`** 按钮（先弹确认，说明会上传 PDF、耗时与计费），
解析完自动重建文档模型与配图清单。设置页没有单独开关——**默认不解析**，
因为这是收费的第三方云调用，不应该在你不知情的时候发生。

解析后：

- 对照视图按模型的阅读顺序分段，图/表渲染在**自己原来的位置**（不再按「图 N」字样猜着挂）；
- 表格显示裁剪图，下面可以展开「表格文字」（HTML 转文本）；
- 公式显示 LaTeX 源码，不送翻译；
- `doc.get` 的 `source` 变成 `layout`，`layoutAt` 记录解析时间；PDF 换版本（size/mtime 变了）会自动退回文本层；
- 想退回文本层：调一次 `layout.clear`（或删掉 `layout.json`），下次打开会重建。

已知取舍：公式只显示 LaTeX 源码、不做 KaTeX 排版；表格是「图 + 文字」，不能逐格选中；
版面模型对双栏论文的段落切分仍可能把一段拆成两段（我们用「服务端文字做证据」把掉进块缝里的首行补回来，
但模型自己切错的地方补不了）。

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
| `POST /paper-workbench/api/<method>` | JSON RPC，如 `library.list`、`pdf.text`、`doc.get`、`ai.models`、`trans.get`、`chat.get`、`search.doc`、`figures.list`、`logs.list`、`review.run`、`trash.list`、`session.status`、`conv.list`、`vault.upsert`、`layout.status`、`layout.run`、`layout.clear` |
| `POST /paper-workbench/ai/translate` | SSE 逐段翻译（事件 `start/delta/done/error/end`） |
| `POST /paper-workbench/ai/chat` | SSE 对话（事件 `delta/done/error/end`） |
| `POST /paper-workbench/ai/cancel` | 取消正在跑的流式请求（`{reqId}`） |
| `GET  /paper-workbench/session/follow?conv=` | 原生 DSH 会话的事件流（SSE，事件 `frame`；`conv` 是对话 id，兼容旧的 `id=`） |
| `GET  /paper-workbench/api/page?id=&page=&scale=` | 页图 PNG（按需渲染，带磁盘缓存） |
| `GET  /paper-workbench/api/figure?id=&index=` | 正文配图 PNG（`figures.json` 的数组下标） |
| `GET  /paper-workbench/api/raw?id=` | 原始 PDF（支持单段 Range，供浏览器查看器） |
| `POST /paper-workbench/api/upload?name=` | 上传 PDF 原始字节 |

只接受本机 Host（localhost / 127.0.0.1 / [::1]）。

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

`scripts/dev-server.mjs` 与宿主共用 `lib/server.js` + `createApi()` + `createStreams()`，因此这里调通的行为装进 DSH 后一致。
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
lib/conv.js     对话形状与「本次对话的论文范围」提示词（纯逻辑）
lib/jobs.js     任务日志（开始/进度/结束/失败，纯依赖注入）
lib/review.js   译文自检（静态规则 + 模型批检）
lib/figures.js  正文配图（抽位图、按「图 N」挂段落、缓存 PNG）
lib/pdf.js      PyMuPDF 子进程桥
lib/obsidian.js frontmatter 行级合并、卡片定位/写入、检索
lib/arxiv.js    arXiv Atom + OpenAlex 解析、PDF 下载
lib/ocr.js      PaddleOCR 云端任务（提交/轮询/jsonl → 按页 Markdown）
lib/tools.js    9 个 agent 工具（裸 JSON-Schema）
lib/client.js   左栏入口 + 主区 iframe 壳 + 把指令写入会话输入框
assets/app/     工作台 SPA（vanilla JS，三栏 + 对照视图 + 搜索/日志/回收站/自检/配图）
assets/pdf_tool.py  PyMuPDF 命令行协处理器（text / outline / render / clip / figures）
docs/v2-contracts.md  v2 的数据形状与接口契约
docs/v3-contracts.md  v3 新增模块（db / jobs / review / figures / session）的契约
```

## 已知限制

- 扫描件要能读/译，得先走一次 OCR（「设置 → 扫描件 OCR」填 PaddleOCR Key）；OCR 结果是按页 Markdown，不还原图片位置。
- 对照阅读的粒度是「段落」。默认由 PDF 文本层按栏内顺序切；开了「版面解析」就按 PP-StructureV3 的块切，双栏/图表/公式都更准，代价是上传 PDF 与按页计费。
- 公式块显示 LaTeX 源码（不做 KaTeX 排版），也不送翻译；表格按整块图贴出（可展开纯文本），文字不能逐格选中。
- 配图裁剪靠「图注 + 空白带 + 绘图簇」，图注缺失或图与正文贴得极近时可能裁偏；极端情况宁可不贴图，也不把正文裁进去。
- 面板内翻译是逐段"可读"译文，不做 PDF 版面重排；需要整版双语 PDF 的话本插件不提供（不做 BabelDOC/MinerU 那类子进程）。
- PDF 深色是**反相滤镜**，不是重新排版；彩色图会跟着变色，想要原色就切回「关」。
- 翻译自检是启发式：静态规则会误报（短标题、刻意省略），模型批检也可能漏；它只提示，不改你的译文。
- 原生会话依赖宿主的 `sessionController`；没有就自动退回「本地」自绘对话，功能不受影响，只是不落进主会话。
- 对话里的附件是以**文件路径**交给 agent 的：宿主 `sessionController.prompt` 只收文本，所以图片不能被"直接看见"，只能由 agent 用文件工具读（能读文字类文件；图片取决于 agent 有没有读图工具）。
- 一个对话对应一条 DSH 会话，对话删掉只从工作台移除，DSH 里的会话记录仍在（要清理请去会话列表删）。
- 对话附件上限 40 个、单个 40 MB；附件以路径交给 agent，不会内联进提示词（避免一次塞爆上下文）。
- 回收站里的「彻底删除」除了 PDF 和元数据，还会删掉这篇的译文 / 任务日志 / 自检结果；恢复不了。
- `精读整篇` / `整本翻译` / `对比综述` 这类整本活在主会话里跑（依赖 agent 与 `paper_*` 工具），且仍会往会话输入框写指令。
- 只下载公开 PDF（arXiv / OpenAlex 开放获取），不绕过任何付费墙。
- 宿主代码改动不会热重载：改完需在插件页重新启用或重启桌面端；`assets/app/` 是静态文件，刷新页面即可。

## License

MIT
