# dsh-paper-workbench

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：**论文工作台**。

左侧导航多一行「论文工作台」：左边是文献库，右边是**对照阅读**（原文段 + 中文译文逐段穿插）、
PDF 页图、笔记与 Obsidian 卡片，最右侧是**面板内对话**。

理解与翻译不再需要退出工作台：翻译走插件自己的 SSE 流，逐段落到原文下方；讲解与追问在右侧对话抽屉里流式回答。
模型从 DSH 已配置的模型里选（默认跟随当前会话模型），也可以用 `paper_*` 工具让会话里的 agent 处理整本级别的工作。

> 状态：0.2.x，接口与数据结构仍可能变动。

## 能做什么

- **三栏布局**：文献库 / 目录 / 对话三栏都能拖宽、双击复位、拖到最窄自动收起；顶栏三个按钮随时重开，状态存在本地。
- **文献库**：按专题分组（默认全部收起）、记住展开状态；上传 PDF、按本地路径导入、从 Obsidian 卡片反查原始 PDF 批量入库；删除进回收站。
- **对照阅读**：默认视图。节标题 + 原文段 + 中文译文连续滚动，`目录` 点击只跳转（不过滤内容），滚动时自动高亮当前节。
- **面板内翻译**：`译` 开关、`译本节`、`整篇翻译`、`目录翻译` 全在面板里完成，SSE 逐段推、可随时 `停止`；译文按段落 hash 缓存在 `trans.json`，重开直接显示。
- **面板内对话**：右侧抽屉，流式回答，回答里的 `[p.N]` 点开原文页；`讲解本节` / `讲解选中段落` / `总结全文` 一键追问；历史按论文存在 `chat.json`。
- **模型可选**：设置 → AI 里给「翻译」和「对话」分别指定 DSH 模型（默认跟随当前模型），温度可调。
- **原文页**：整页渲染（按需渲染 + 预取下一页）、翻页/缩放、PDF 书签目录（没有则按字号启发式）。
- **在线检索**：arXiv / OpenAlex，支持关键词、arXiv ID、DOI；一键下载开放 PDF 入库。
- **理解与整理**：划词问 agent、双击段落解释、精读报告（摘要 / 方法 / 贡献 / 局限 / 可复现要点）、多篇勾选后生成对比综述（这些仍走会话，结果落回本地库与 Obsidian）。
- **扫描件 OCR**：没有文本层的 PDF 可以调 PaddleOCR 云端接口（PaddleOCR-VL-1.6 / PP-StructureV3 / PP-OCRv6）识别成按页 Markdown，之后照常对照、翻译、检索、问答。
- **Obsidian 联动**：直接读写已有「论文知识库」卡片；frontmatter **行级合并**（只改传入的键，保留未知字段、注释和书写风格），写前备份，幂等。

## 依赖

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| Python 3.10+ 与 `PyMuPDF`（`import fitz`） | 取文本/坐标、目录、渲页 | 仍能导入与阅读，但改为浏览器原生 PDF 查看器，无文本层/翻译 |
| Obsidian（CLI 在 PATH 上可选） | 定位 vault、打开卡片 | 「卡片」页签与写入功能不可用，其余照常 |
| PaddleOCR API Key（百度 AI Studio，可选） | 扫描件 OCR | 扫描件只能看页图，不能翻译/检索；其它 PDF 不受影响 |

插件会自动探测 `F:\ProGramApp\Anaconda\python.exe` → `python` → `py`，也可在设置里手动指定路径。
不引入任何第三方 npm 依赖，客户端也不需要构建。

## 安装

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-paper-workbench
# 或在桌面端「插件」页添加本地包
```

安装后**重启桌面端**（宿主代码只在插件加载时执行一次；之后改代码需要重新启用插件或重启）。

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
- **缓存**：译文按 hash 存 `trans.json`，默认不覆盖（想重翻按 `重新翻译`）；标题另存 `t:<hash>`，`目录翻译` 一次请求翻一批。
- **划词翻译**：选中原文点 `翻译`，译文**直接贴在那一段下面**（不经过对话）。它是独立小工具：每次都是全新的一次模型请求，
  读不到段落模型时（原文页 / 纯文本页）走 `/ai/translate` 的一次性通道，不写 `trans.json`、不写 `chat.json`、不进对话上下文。
- **对话**：每条问题带上当前节的原文上下文（必要时压缩），流式 SSE 返回；历史按论文存 `chat.json`（保留最近 200 条），`清空` 只清当前论文。
- **界面记忆**：当前论文、页签、页码、滚动位置、三栏宽度、文献树展开状态都记在浏览器本地；关掉面板再打开会回到离开时的位置。
- **停止**：翻译与对话都能中途停；停止后已收到的段落/片段保留。

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
| `POST /paper-workbench/api/<method>` | JSON RPC，如 `library.list`、`pdf.text`、`doc.get`、`ai.models`、`trans.get`、`chat.get`、`vault.upsert` |
| `POST /paper-workbench/ai/translate` | SSE 逐段翻译（事件 `start/delta/done/error/end`） |
| `POST /paper-workbench/ai/chat` | SSE 对话（事件 `delta/done/error/end`） |
| `POST /paper-workbench/ai/cancel` | 取消正在跑的流式请求（`{reqId}`） |
| `GET  /paper-workbench/api/page?id=&page=&scale=` | 页图 PNG（按需渲染，带磁盘缓存） |
| `GET  /paper-workbench/api/raw?id=` | 原始 PDF（支持单段 Range，供浏览器查看器） |
| `POST /paper-workbench/api/upload?name=` | 上传 PDF 原始字节 |

只接受本机 Host（localhost / 127.0.0.1 / [::1]）。

## 数据放在哪

```
~/.dsh/paper-workbench/
  config.json            # 设置（python 路径、vault/kb、存储方式）
  index.json             # 文献索引（原子写，保留 .bak）
  papers/<id>/           # 每篇一个目录
    meta.json
    paper.pdf            # storage=copy 时的库内副本
    text.json            # 文本块缓存（按源 PDF mtime+size 失效）
    doc.json             # 段落/分节模型（按 PDF sha1 缓存，段落 hash 是翻译的键）
    trans.json           # 段落译文缓存（正文段 + `t:<hash>` 标题）
    chat.json            # 面板内对话历史（最近 200 条）
    notes.json           # 高亮
    zh.md                # 中文版（## p.N 分段，会话侧翻译产物）
    ocr.md               # 扫描件 OCR 结果（## p.N 分段）
    ocr.json             # 最近一次 OCR 任务状态（进度/错误）
  .pages/<id>/           # 页图缓存
  .trash/                # 回收站
```

- 默认 `storage=link`：只记原路径，不复制 PDF；可改成 `copy`。
- 写入 Obsidian 前会备份为 `<卡片名>.pb-backup.md`（只留一份），内容没变不落盘。
- 除你主动发起的 arXiv / OpenAlex 检索与 PaddleOCR 识别外，插件不向第三方发请求。

## 开发

```bash
npm run dev       # 独立调试服务器 http://127.0.0.1:57571/paper-workbench/app
npm run dev:mock  # 同上，但翻译/对话用假模型（不烧 token，验证界面用）
npm run seed      # 塞几篇本机样例论文（幂等）
npm test          # store 并发 + 工具层 + 段落模型 + AI（假 llm）+ Obsidian + arXiv + OCR + PDF 自检
npm run smoke -- http://127.0.0.1:57571   # 打一遍 HTTP 接口（含 SSE 翻译/对话）
npm run fix:library                       # 干跑一次库体检（重复条目/文件名式标题），加 -- --apply 才动库
```

`scripts/dev-server.mjs` 与宿主共用 `lib/server.js` + `createApi()`，因此这里调通的行为装进 DSH 后一致。
`--mock-llm` 注入一个假 `llm`（按 prompt 标记回 JSON / 中文），不联网、不消耗配额。

目录：

```
lib/index.js    宿主入口（路由 + API + 工具注册 + 把 ctx.llm 注入 ai 层）
lib/server.js   HTTP 处理（宿主与 dev-server 共用，含 SSE 与取消）
lib/store.js    本地存储（索引/笔记/译文/对话/段落模型，原子写）
lib/doc.js      段落模型（块合并、分节、hash、按 sha1 缓存）
lib/ai.js       翻译与对话（批量、JSON 解析、退化重试、标题、SSE 事件）
lib/sse.js      SSE 输出（心跳、客户端断开即 abort）
lib/pdf.js      PyMuPDF 子进程桥
lib/obsidian.js frontmatter 行级合并、卡片定位/写入、检索
lib/arxiv.js    arXiv Atom + OpenAlex 解析、PDF 下载
lib/ocr.js      PaddleOCR 云端任务（提交/轮询/jsonl → 按页 Markdown）
lib/tools.js    9 个 agent 工具（裸 JSON-Schema）
lib/client.js   左栏入口 + 主区 iframe 壳 + 把指令写入会话输入框
assets/app/     工作台 SPA（vanilla JS，三栏 + 对照视图）
assets/pdf_tool.py  PyMuPDF 命令行协处理器
docs/v2-contracts.md  v2 的数据形状与接口契约（改这些先看它）
```

## 已知限制

- 扫描件要能读/译，得先走一次 OCR（「设置 → 扫描件 OCR」填 PaddleOCR Key）；OCR 结果是按页 Markdown，不还原图片位置。
- 对照阅读的粒度是「段落」，段落由 PDF 文本层切出来；双栏论文偶尔会把两栏并成一段，公式与表格段不送翻译（只给原文页跳转）。
- 面板内翻译是逐段"可读"译文，不做 PDF 版面重排；需要整版双语 PDF 的话本插件不提供（不做 BabelDOC/MinerU 那类子进程）。
- 面板内对话是插件自己的对话（按论文存历史），**不是** DSH 会话；要把结论带回主对话用气泡上的「插入到会话」。
- `精读整篇` / `整本翻译` / `对比综述` 这类整本活在主会话里跑（依赖 agent 与 `paper_*` 工具），且仍会往会话输入框写指令。
- 只下载公开 PDF（arXiv / OpenAlex 开放获取），不绕过任何付费墙。
- 宿主代码改动不会热重载：改完需在插件页重新启用或重启桌面端；`assets/app/` 是静态文件，刷新页面即可。

## License

MIT
