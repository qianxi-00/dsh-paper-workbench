# v2 内部契约（宿主 ↔ SPA ↔ 测试）

> 这份文件是 v2 并行开发时唯一的接口约定。改动契约要同步改这里，并通知 lead。
> 写作用域（谁只碰哪些文件）见文末，越界写会覆盖别人的改动。

## 1. 运行环境与代码风格

- ESM（`"type": "module"`），Node 20+，**不新增任何 npm 依赖**。
- 宿主侧（`lib/*.js`）跑在 DSH 进程里：不引 React，不发网络请求（除已有的 arXiv/OCR），所有 LLM 调用走 `ctx.llm`。
- 前端（`assets/app/*`）是 vanilla JS，无构建步骤，`document.createElement` 手写 DOM（`h()` 工具见 `assets/app/app.js:47`）。
- 注释与提示文案用中文；函数命名用英文。错误消息要能直接给用户看（说清原因 + 下一步怎么办）。
- 非平凡逻辑必须留一个可执行检查（`scripts/test-*.mjs`）。

## 2. 数据文件形状

数据根：`DATA_ROOT = process.env.DSH_PAPER_WORKBENCH_DATA || ~/.dsh/paper-workbench`，每篇论文一个目录 `papers/<id>/`。

### 2.1 `doc.json`（`lib/doc.js` 产出，可随时重建）

```jsonc
{
  "version": 1,
  "source": "pdf-text",              // 或 "ocr"
  "builtAt": "2026-11-11T07:20:00.000Z",
  "pdf": { "sha1": "…", "bytes": 1234567, "mtimeMs": 0 },
  "sections": [
    { "id": "s3", "order": 3, "title": "3.2 Method", "level": 2, "page": 5,
      "hash": "9f3c1a2b4c5d6e7f", "startParagraph": 42 }
  ],
  "paragraphs": [
    { "id": "p0042", "order": 42, "page": 5, "section": "s3",
      "kind": "body",                // heading | body | list | caption | formula
      "level": 0,                    // 仅 heading 有：1..3
      "text": "…", "hash": "a1b2c3d4e5f6a7b8",
      "bbox": [72, 120, 520, 180], "size": 10.2, "crossPage": false }
  ]
}
```

- `paragraphs[].hash` = `paragraphHash(kind, text)`：**16 位十六进制**，与页码/顺序解耦。
- `sections[].hash` = `titleHash(title)`，用于标题译文缓存。
- `order` 从 0 连续递增；`startParagraph` = 该节第一个段落的 `order`（目录跳转用）。
- 扫描件（没有文本层）走 `source: "ocr"`，段落来自 `ocr.md` 的 `## p.N` 分段。

### 2.2 `trans.json`

```jsonc
{ "version": 1, "target": "zh", "model": { "provider": "hannian", "model": "deepseek-v4-flash" },
  "updatedAt": "…",
  "entries": {
    "a1b2c3d4e5f6a7b8": { "zh": "…", "at": "…", "model": "hannian/deepseek-v4-flash" },
    "t:9f3c1a2b4c5d6e7f": { "zh": "方法", "at": "…", "model": "…" }
  } }
```

- 段落键 = `paragraphs[].hash`；节标题键 = `"t:" + sections[].hash`。
- 键大小写不敏感（统一小写）。

### 2.3 `chat.json`

```jsonc
{ "version": 1, "model": { "provider": "…", "model": "…" }, "updatedAt": "…",
  "messages": [
    { "id": "m17", "role": "user", "content": "…", "at": "2026-11-11T…",
      "context": { "sectionId": "s3", "page": 5, "selection": "…" } },
    { "id": "m18", "role": "assistant", "content": "…", "at": "…", "model": "hannian/…" }
  ] }
```

- 只保留最近 200 条（写入时裁剪）。

## 3. `lib/store.js`（已由 lead 实现，直接用）

```js
export async function readDoc(id)            // doc.json | null
export async function writeDoc(id, doc)      // 原子写，返回写入值
export async function removeDoc(id)
export async function readTrans(id)          // 恒返回 { version, target, model, entries }
export async function writeTrans(id, trans)   // 补齐 version/target/updatedAt 后原子写
export async function readChat(id)            // 恒返回 { version, model, messages }
export async function writeChat(id, chat)     // messages 自动裁剪到最近 200 条
export async function readTextCache(id)       // text.json（pages[].blocks[]，可能为 null）
export async function readOcr(id)             // ocr.md（没有则 ''）
export async function getMeta(id)             // meta.json（含 outline/pageCount/title…）
export async function resolvePdf(id)          // { path, sha1?, bytes, mtimeMs }，失败抛错
export async function getConfig() / setConfig(patch)
export async function writeJsonAtomic(file, value) / readJson(file, fallback)
export function paperFile(id, name)           // papers/<id>/<name> 的绝对路径
```

`getConfig().ai` 默认值：

```js
{ translateModel: null, chatModel: null, target: 'zh', concurrency: 1, temperature: 0.2 }
```

`null` = 跟随 DSH 当前模型。

## 4. `lib/doc.js`（doc-dev 产出）

```js
/** 纯函数：段落 hash，16 位十六进制。 */
export function paragraphHash(kind, text)
/** 纯函数：标题 hash，16 位十六进制。 */
export function titleHash(title)
/** 纯函数：把 text.json 的 pages[].blocks[] 合成段落（可单测，不读盘）。 */
export function mergeBlocks(pages, opts)                  // → paragraphs[]
/** 纯函数：把段落分配到节（有 outline 用 outline，没有就启发式）。 */
export function assignSections(paragraphs, outline, opts) // → { sections, paragraphs }
/** 组装完整 doc 对象（纯函数）。 */
export function buildDoc({ meta, text, outline, ocrMarkdown, pdf })
/** 对外入口：读缓存、校验 pdf.sha1、必要时重建、写盘。 */
export async function getDoc(id, { rebuild = false } = {})
// 返回 { doc, built: boolean, stale?: boolean, ms }
export function invalidateDocCache(id)   // 测试与导入后清缓存
```

约定：`opts` 允许注入 `bodySize` 之类参数以便测试；任何解析异常都要回落到"每页一段"的退化模型，**不能抛给上层**。

## 5. `lib/ai.js`（ai-dev 产出）

```js
/**
 * 入参 runtime 由 lead 注入：
 *   { getServices: () => ({ llm, agentDefaultModel }) }，任一服务可能为 null。
 */
export function createAi({ store, getServices })

// 返回 { providers: [{id,name}], models: [{provider,id,name}], follow: {provider,model} | null,
//        translateModel: {provider,model} | null, chatModel: {provider,model} | null,
//        ready: boolean, reason?: string }
// provider 无 listModels 时 models 里给该 provider 一条 { id: '', name: '手填模型名' } 标记。
async function models()

// 逐段翻译：AsyncIterable<Event>（事件形状见 §7.2）
// body: { id, sectionIds?: string[], keys?: string[], retranslate?: boolean, target?: 'zh' }
async function* translate(body, { signal })

// 侧边对话：AsyncIterable<Event>
// body: { id, messages: [{role:'user'|'assistant', content}], context?: {sectionId?,page?,selection?},
//         scope?: 'section'|'paper', model?: {provider,model} }
async function* chat(body, { signal })
```

`createAi` 返回 `{ models, translate, chat }`。要求：

- `translate` 每个段落至少 emit `start` → (`delta`*) → `done`；批请求失败要退化为逐段，**仍失败才 emit `error`**。翻译结果落 `trans.json`（每节结束/每 1 秒节流 flush，中断也保留已得部分）。
- 已翻译且 `retranslate !== true` 的键直接 emit `done`（带缓存文本），不发请求。
- `chat` emit `delta` 增量与最后 `done`，并把这一轮 user+assistant 追加进 `chat.json`。
- 所有 `llm.stream` 都必须透传 `signal`；`finish.reason.kind === 'error'` 时把 `failure.message` 作为错误文案。
- prompt 与纯函数（`clampMaxTokens`、`buildTranslatePrompt`、`parseTranslateReply`、`chunkItems`、`buildChatContext`）单独导出，供 `scripts/test-ai.mjs` 单测。

## 6. `lib/sse.js`（ai-dev 产出）

```js
/** 把 AsyncIterable<{event, data}> 写成 SSE；处理心跳、客户端断开 abort、尾部 end 帧。 */
export async function pipeSse(req, res, iterable, { heartbeatMs = 15000 } = {})
/** 只为非流式错误兜底：在开始流之前用普通 JSON 响应。 */
export function sseError(res, status, message)
```

- 头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-store`、`Connection: keep-alive`、`X-Accel-Buffering: no`。
- 事件格式：`event: <name>\ndata: <单行 JSON>\n\n`；JSON 里的换行已由 `JSON.stringify` 转义。
- `req.on('close')` → abort 传入的 `signal`；写完必须结束响应。

## 7. HTTP 契约（lead 在 `lib/server.js` 实现）

### 7.1 非流式 RPC（`POST /paper-workbench/api/<method>`，沿用 `{ ok, result }` 包装）

| method | 入参 | 出参 `result` |
|---|---|---|
| `doc.get` | `{ id, rebuild? }` | `{ doc, trans, stale? }` |
| `doc.build` | `{ id }` | `{ sections, paragraphs, ms }` |
| `ai.models` | `{}` | §5 的 models() 返回值 |
| `ai.settings.get` | `{}` | `{ config }`（模型与温度，不含密钥） |
| `ai.settings.set` | `{ patch }` | `{ config }` |
| `trans.get` | `{ id }` | `{ entries, model }` |
| `trans.clear` | `{ id, keys? }` | `{ ok: true }` |
| `chat.get` | `{ id }` | `{ messages, model }` |
| `chat.clear` | `{ id }` | `{ ok: true }` |

### 7.2 流式路由（原生 SSE）

- `POST /paper-workbench/ai/translate`，body 同 `translate(body)`
- `POST /paper-workbench/ai/chat`，body 同 `chat(body)`
- `POST /paper-workbench/ai/cancel`，body `{ reqId }` → `{ ok: true }`（前端也直接断连接）

事件名与 data（翻译）：

```
event: start  data: {"key":"a1b2…","kind":"body","cached":false}
event: delta  data: {"key":"a1b2…","text":"部分中文"}
event: done   data: {"key":"a1b2…","text":"完整中文","model":"p/m","cached":false}
event: error  data: {"key":"a1b2…","message":"…"}
event: end    data: {"ok":true,"done":37,"failed":1}
```

对话：

```
event: delta  data: {"text":"增量"}
event: done   data: {"text":"完整回答","model":"p/m","usage":{…}}
event: error  data: {"message":"…"}
event: end    data: {"ok":true}
```

约定：`key` 一律小写；`done.cached=true` 表示命中 `trans.json` 未发请求；`end` 一定发（客户端用它收尾）。

## 8. SPA 契约（spa-dev）

- 数据来源只用 §7 的接口；`insertPrompt` postMessage 通道保留但只用于「插入到会话」。
- 本地状态存 `localStorage`：`pb.layout.v1`（三栏宽度与开关）、`pb.tree.v1`（展开的分组）、`pb.ai.v1`（翻译开关、只看译文、对话是否打开）。
- 视图：`对照`（默认，连续阅读）/`原文页`/`笔记`/`卡片`；`只看译文` 是对照视图内的开关。
- 节的 DOM 锚点 id：`sec-<sectionId>`；段落 id：`para-<paragraphId>`，供目录跳转与对话定位用。
- 翻译事件处理要做幂等：同一 key 重复 `done` 只覆盖一次，`error` 不覆盖已有译文。
- 失败提示必须给下一步（例如「没有可用模型 → 去设置里选一个」），不能只弹 `undefined`。

## 9. 测试约定

- 新增 `scripts/test-doc.mjs`、`scripts/test-ai.mjs`；`npm test` 会串起来跑（lead 改 package.json）。
- 测试脚本风格照 `scripts/test-obsidian.mjs`：自造 `pass/fail/skip` 计数，最后打印 `PASS n / FAIL n / SKIP n` 与 `RC`。
- `test-ai.mjs` 用假 llm：

```js
function fakeLlm(chunks) {
  return { listProviders: () => [{ id: 'fake', name: 'Fake' }],
           listModels: async () => [{ provider: 'fake', id: 'm1', name: 'M1' }],
           stream: (options) => (async function* () { for (const c of chunks) yield c })() }
}
```

chunk 形状必须与宿主一致：`{ type:'text-delta', index:0, text }`、`{ type:'finish', reason:{ kind:'stop' } }`、错误用 `{ type:'finish', reason:{ kind:'error', failure:{ message:'boom' } } }`。
- 假 `agentDefaultModel`：`{ currentSelection: () => ({ provider:'fake', model:'m1' }) }`。
- 测试必须能在**没有 DSH 宿主**的情况下跑通（`node scripts/test-ai.mjs` 单独可跑）。

## 10. 写作用域（互斥）

| 谁 | 只写这些 |
|---|---|
| doc-dev | `lib/doc.js`、`scripts/test-doc.mjs` |
| ai-dev | `lib/ai.js`、`lib/sse.js`、`scripts/test-ai.mjs` |
| spa-dev | `assets/app/index.html`、`assets/app/style.css`、`assets/app/app.js` |
| lead | `lib/store.js`、`lib/index.js`、`lib/server.js`、`lib/tools.js`、`scripts/dev-server.mjs`、`package.json`、`README.md`、`docs/*` |

需要别的作用域里的改动时，发消息给 lead，不要直接改。
