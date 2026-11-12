# v3 契约：搜索 / 配图 / 自检 / 任务日志 / 原生会话 / SQLite 存储

本文件是并行开发的唯一接口约定。**谁写哪个文件**见 §7，越界改动一律回退。

## 0. 共同约定

- 纯 ESM，`import ... from './x.js'`；不新增任何 npm 依赖；不联网（测试除外）。
- 注释与报错文案用中文；错误一律 `throw new Error('中文说明')`，不要把绝对路径、token 拼进用户可见文案。
- 数据目录 `DATA_ROOT = ~/.dsh/paper-workbench`；论文目录 `papers/<id>/`。
- 每个模块都要能在**不启动 DSH** 的情况下被 `node scripts/test-xxx.mjs` 直接 import 测试。
- 测试脚本自己建临时目录（`%TEMP%` 下），结束时清理；**绝不写真实库**（`~/.dsh/paper-workbench`）。
- 跑测试：`node scripts/test-xxx.mjs`，最后打印 `PASS n / FAIL m`，`process.exitCode = m ? 1 : 0`。
- 本机 `ops_bash` 坏了。跑命令用 `terminal_open(type:'shell')`（PowerShell），**命令要短**，结果
  `> $env:TEMP\x.txt 2>&1`，再用 `ops_inspect_local_file` 读；否则 PTY 会重放历史输入、输出爆炸。

## 1. `lib/db.js` — SQLite 存储（db-dev）

存储引擎：优先 `node:sqlite` 的 `DatabaseSync`（本机 Node 24 已验证可用）；**若 import 失败**，
退化成同名 API 的 JSON 文件实现（`workbench.json`），并在 `dbInfo().engine` 里如实返回 `'json'`。
两种实现必须共用同一套导出与行为。

```js
export function dbPath()                 // process.env.PB_DB_PATH || path.join(DATA_ROOT, 'workbench.db')
export function getDb()                  // 懒打开；首次建表；PRAGMA journal_mode=WAL, synchronous=NORMAL
export function closeDb()                // 关闭（测试用）
export function dbInfo()                 // { engine:'sqlite'|'json', path, rows:{translations,job_events,reviews} }
export function transAll(paperId)        // → { version:1, target:'zh', model:'', updatedAt:'ISO', entries:{ [key]: text } }
export function transPut(paperId, entries, opts) // opts {target='zh', model=''}; entries 是 {key:text}；返回写入条数
export function transDelete(paperId, keys)       // 返回删除条数
export function transClear(paperId)              // 返回删除条数
export function jobAppend(paperId, event)        // event {level, kind, message, extra?}; 返回 seq
export function jobList(paperId, opts)           // opts {after=0, limit=200} → { events:[{seq,at,level,kind,message,extra}], lastSeq }
export function jobClear(paperId)                // 返回删除条数
export function reviewPut(paperId, review)       // review {at, mode, issues:[], stats:{}}
export function reviewGet(paperId)               // → review | null
export function migrateTransJson(paperId, legacy) // legacy 是 trans.json 内容；库里该论文为空时才导入；返回导入条数
```

表结构（schema v1，写在 `meta(k,v)` 里记 `schema=1`）：

```sql
CREATE TABLE IF NOT EXISTS translations (
  paper_id TEXT NOT NULL, target TEXT NOT NULL, key TEXT NOT NULL,
  text TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY (paper_id, target, key));
CREATE TABLE IF NOT EXISTS job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, paper_id TEXT NOT NULL, at TEXT NOT NULL,
  level TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, extra TEXT);
CREATE TABLE IF NOT EXISTS reviews (
  paper_id TEXT PRIMARY KEY, at TEXT NOT NULL, mode TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```

约束：所有写入用事务（`BEGIN IMMEDIATE`/`COMMIT`，失败 `ROLLBACK`）；`extra`/`payload` 用 JSON 字符串；
`updatedAt` 用 ISO 字符串；`jobList` 的 `after` 是 seq 游标（`WHERE seq > ?`）。

测试 `scripts/test-db.mjs`：临时 `PB_DB_PATH`；覆盖 建表幂等、写入/覆盖/读回、按 key 删、清空、
`jobList` 游标与 limit、`reviewPut/Get`、`migrateTransJson` 只导一次、`dbInfo` 计数、关闭后重开数据仍在。

## 2. `lib/figures.js` + `assets/pdf_tool.py` 的 `figures` 命令（figures-dev）

`pdf_tool.py` 新增命令（保持 stdin/stdout 单行 JSON 契约，不破坏现有 info/text/outline/render）：

- `figures`：`{"cmd":"figures","path":"..."}` → `{"ok":true,"figures":[{page,x,y,x2,y2,width,height,index,caption,label}]}`
  - 用 PyMuPDF `page.get_image_info()`（或 `get_images` + `get_image_rects`）取每页图片的 bbox；
  - 过滤：宽或高 < 60pt、面积占页面 < 1.5% 的丢弃（去 logo/图标）；
  - `caption`：从该页文本块里找离图片最近、且匹配 `^(图|圖|Figure|Fig\.?)\s*([0-9]+|[IVX]+)` 的行；
  - `label`：规范化成 `Figure N` / `图 N` 的数字，取不到为 `null`；
  - `index`：该页内从 1 开始。
- `render` 增加可选 `"clip":[x,y,w,h]`（页面坐标系 pt）：只渲染该区域，用于裁剪配图。
- `--self-test` 必须继续通过（可用无图 PDF，允许 `figures: []`）。

`lib/figures.js`：

```js
export async function listFigures(id, opts)   // opts {refresh=false}；读/写 papers/<id>/figures.json；无 PDF 返回 []
export function normalizeLabel(text)          // '图 3' / 'Figure 3' / 'Fig. 3' → 3；失败 null
export function assignFigures(doc, figures)   // → { byParagraph:{ [paragraphKey]: Figure[] }, used:number, unmatched:Figure[] }
export async function figureBuffer(id, index) // 按 figures.json 的 bbox 调 pdf_tool render(clip) → PNG Buffer
export async function figurePath(id, index)   // 缓存到 papers/<id>/.figures/f<index>.png，返回绝对路径
```

`assignFigures` 规则：正文段落文本里出现 `图 3` / `Figure 3` / `Fig. 3` 且该图 `label` 相等 → 归到该段；
同一图只归第一次出现的段落；没有 label 的图按「页码相同的最近段落」兜底。

测试 `scripts/test-figures.mjs`：用真实 PDF `G:\笔记\LLM知识体系论文\加速训练\FlashAttention.pdf`
（只读），断言 figures 数量 > 0、至少一条有 caption、`normalizeLabel` 各种写法、`assignFigures` 能命中至少一段、
`figureBuffer` 返回以 `\x89PNG` 开头的字节且 > 5KB；再用一个临时目录断言无 PDF 时返回空数组不抛错。

## 3. `lib/review.js` — 翻译自检（review-dev）

```js
export function staticIssues(doc, trans)      // (doc, entries) → [{key, code, severity:'warn'|'error', message}]
export function buildReviewPrompt(batch)      // batch [{key, source, zh}] → {system, user}
export function parseReviewReply(text)        // → [{key, severity, issue, suggest}]；坏 JSON 返回 []
export function createReview({store, getServices}) → { run(paperId, opts) }
```

`run(paperId, {mode='both', limit=80, signal})`：

1. `doc = await store.readDoc(paperId)`（没有就抛 `还没有文档模型，先打开一次论文`）；
2. `trans = await store.readTrans(paperId)`；只检查 `kind==='body'` 且已翻译的段落；
3. 静态检查（`mode!=='llm'` 时必跑）：
   - `empty`：译文为空；
   - `english-left`：译文里 ASCII 字母占非空白字符 > 55% 且长度 > 40；
   - `truncated`：译文以 `，` `、` `,` `and` `the` `of` 结尾；
   - `same-as-source`：译文与原文去掉空白后相同；
   - `page-ref`：译文里出现 `p.\d+` / `第 \d+ 页` 这类页码残留；
   - `dollar-odd`：`$` 出现奇数次；
   - `too-short`：译文长度 < 原文长度 × 0.15 且原文 > 80 字符。
4. LLM 检查（`mode!=='static'` 且 `getServices().llm` 可用）：每批 ≤8 段、≤4000 字符，
   用 `llm.stream({provider, model, messages:[{role:'user',content:[{type:'text',text:user}]}], system, temperature:0, maxTokens:1200})`，
   provider/model 取 `getServices().agentDefaultModel.currentSelection()`；
   `parseReviewReply` 只接受已知 key 的条目；模型不可用/报错时把 `llmError` 放进结果，**不抛**；
5. 结果 `{ at, mode, issues:[...], stats:{paragraphs, checked, staticIssues, llmIssues, llmError?} }`，
   通过 `store.writeReview(paperId, result)` 落盘（由 Lead 在 store 里接到 db）。

测试 `scripts/test-review.mjs`：造假 doc/entries 覆盖 7 种静态问题各一条（含不误报的正常译文），
`parseReviewReply` 正常/坏 JSON/未知 key 三种，`createReview().run` 用假 llm 断言 issues 合并与 llmError 降级。

## 4. `lib/jobs.js` — 任务日志（jobs-dev）

```js
export function createJobLogger({append, list, clear}) → {
  start(paperId, kind, meta) → jobId,     // kind: 'translate'|'ocr'|'doc'|'review'|'figures'
  log(jobId, level, message, extra),      // level: 'info'|'warn'|'error'
  progress(jobId, {done, total}),
  finish(jobId, status, extra),           // status: 'ok'|'failed'|'cancelled'
  fail(jobId, error),
  list(paperId, opts),
  clear(paperId),
  active(),                               // 正在跑的 job 摘要数组
}
```

依赖注入：`append(paperId, event)`、`list(paperId, opts)`、`clear(paperId)` 由调用方传（Lead 接 db）。
事件形状 `{level, kind, message, extra?}`，其中 `kind` 在 job 生命周期里用 `start|progress|end|error|log`。
`log()` 在 jobId 未知时也不抛，转成 `kind:'log'` 记在 paperId 下（paperId 从 jobId 里解析，
jobId 形如 `<paperId>#<n>`）。同一 job 的 `finish` 只记一次。

测试 `scripts/test-jobs.mjs`：内存版 append/list 假实现，覆盖 start→log→progress→finish 顺序、
未知 jobId 不抛、finish 幂等、active() 只含未结束 job、clear 清空。

## 5. `lib/session.js` — 原生 DSH 会话桥（session-dev）

宿主服务（`ctx.inject(['webServer','sessionController','workspaceController','llm','agentDefaultModel'], ...)`）：

- `sessionController.create({sessionId, workspaceId} | {sessionId, cwd})`
- `sessionController.prompt({sessionId, content:[{type:'text',text}], requestId}, signal)`
- `sessionController.follow({address:{kind:'session',sessionId}, maxMessages:200, assistantStream:true}, signal)` → async iterable of frames
- `workspaceController.create({path})` → `{workspace:{workspaceId}}`

```js
export function sessionIdFor(paperId)          // `pb-${paperId}`，只留 [a-zA-Z0-9._-]
export function createSessionBridge({getServices, dataRoot}) → {
  available(),                                  // sessionController 是否可用
  ensure(paperId, {cwd}),                       // 建/复用会话，返回 {sessionId}
  ask(paperId, text, {signal, cwd}),            // 先 ensure，再 prompt，返回 {sessionId, requestId}
  follow(paperId, {signal, maxMessages}),       // async iterable，原样 yield frame
  normalizeFrame(frame),                        // → {kind, role?, text?, at?, raw}
}
```

`normalizeFrame` 要**宽容**：frame 可能是 `{kind:'message', message:{role, content:[{type:'text',text}]}}`、
`{type:'message', ...}`、`{kind:'assistant-delta', text}`、`{event:'...'}` 等形态；
能取到 role+文本就返回 `{kind:'message', role, text}`；能取到增量文本返回 `{kind:'delta', text}`；
能取到 `finish`/`done` 返回 `{kind:'done'}`；其余 `{kind:'other', raw}`。**绝不抛错**。
`available()` 为 false 时 `ask/follow` 抛 `原生会话不可用（这个宿主没有 sessionController）`。

测试 `scripts/test-session.mjs`：假 sessionController/workspaceController，覆盖 sessionId 清洗、
ensure 复用、prompt 参数形状（content 数组、requestId 非空、signal 透传）、follow 透传与 abort、
`normalizeFrame` 的 6 种输入形态、服务缺失时的报错文案。

## 6. Lead 负责的接线（不要改这些文件）

`lib/index.js`、`lib/store.js`、`lib/ai.js`、`lib/server.js`、`lib/tools.js`、`lib/client.js`、
`assets/app/app.js`、`assets/app/style.css`、`README.md`、`scripts/smoke.mjs`、`package.json`。

Lead 会新增这些 RPC（供 SPA 用，队友无需实现）：

| RPC / 路由 | 说明 |
|---|---|
| `search.doc {id, query, limit}` | 在 doc 模型段落里搜，返回 `{hits:[{key,sectionId,page,text,before,after}]}` |
| `figures.list {id}` | 配图清单（含 caption/label/page） |
| `GET /paper-workbench/figure?id&index` | 裁剪后的 PNG |
| `review.run {id, mode}` / `review.get {id}` | 自检 |
| `logs.list {id, after}` / `logs.clear {id}` | 任务日志 |
| `trash.list {}` / `trash.restore {name}` | 回收站 |
| `GET /paper-workbench/session/follow?id` | 原生会话 SSE |
| `session.ask {id, text}` | 往原生会话发一条 |

## 7. 写作用域

| 角色 | 文件 |
|---|---|
| db-dev | `lib/db.js`、`scripts/test-db.mjs` |
| figures-dev | `assets/pdf_tool.py`、`lib/figures.js`、`scripts/test-figures.mjs` |
| review-dev | `lib/review.js`、`scripts/test-review.mjs` |
| jobs-dev | `lib/jobs.js`、`scripts/test-jobs.mjs` |
| session-dev | `lib/session.js`、`scripts/test-session.mjs` |
| lead | 其余全部 |
