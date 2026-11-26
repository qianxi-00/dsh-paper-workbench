# 对照稿质量管线（schemaVersion 2）

本文记录 2026-11-17 批准的「通用对照质量提升」落地结构。目标是让每一篇论文都走同一条
可验证的管线，而不是按论文名打补丁。

## 数据流

```
PDF
 ├─ page_lines（PyMuPDF）—— 每页文本层的行级证据（渲染坐标）
 ├─ split → PP-StructureV3（按批上传，最多 50 页/批）—— 结构：块类型/阅读顺序/bbox/表格 HTML
 │    └─ raw jsonl 按内容 sha256 不可变归档（layout-data/raw/<sha>.jsonl）
 ├─ buildDocumentLayout（lib/layout-ir.js，纯函数）
 │    ├─ 每页把服务块投影到 PDF 坐标（记录实际变换；比例不符/旋转未知 → needs_review + 原页回退）
 │    ├─ PDF 行与块一对一归属（几何 + 文字一致性评分；未匹配行保留为有记录的块）
 │    ├─ 每块从 service / vl / pdf 候选中选文字（PDF 文本层优先；乱码/冲突标 needs_review）
 │    ├─ 图注按类型 + 几何绑定；公式去重必须有内容等价证据并保留 excluded 原块
 │    └─ 逐页 quality（passed / needs_review / failed）+ 整篇 quality
 ├─ attachTables（PyMuPDF 格线优先，服务端 HTML 兜底）
 └─ createLayoutArchive.publish —— 不可变 revision + current.json 指针 + layout.json 投影
```

`layout.json` 仍是现有 `doc.js` / `figures.js` 的读取入口，内容为 schemaVersion 2 的
统一 IR；旧版 layout.json 仍按 legacy 读取（首次发布前备份到 `layout-data/legacy/`）。

## IR 契约（schemaVersion 2）

- `version: 1`、`schemaVersion: 2`、`build: 'ir-5'`、`revision`（输入语义 hash，不含时间戳）。
- `source: {sha256, path, size, mtimeMs}`：发行版本必须绑定 PDF 内容 hash。
- `pages[]`：`{n, pageId, width, height, rawRef, status: ready|needs_review|failed, quality, blockIds, lineAssignments, fallback?}`。
  每页都有记录，缺页不压缩页号。`failed` 页保留 `fallback: {kind:'original-page', page:n}`。
  `rawRef` 是主服务 raw 的独立副本，含 `{hash, file?, page, model?, jobId?}`；`page` 为 1-based 全局批次闭区间（如 `3-4`），空白服务页也保留，纯 PDF 页为 `null`。
- `blocks[]`：旧字段 `{page, order, kind, label, text, bbox:{x,y,width,height}, level?, latex?, html?, table?, figureIndex?}`
  + 证据字段 `{blockId, pageId, sourceHash, candidates[], selectedSource, selectionReason, fragments[], quality, sourceBlockIds[]}`。
  `blockId` 只由 PDF hash + 页 + 服务块身份决定，文字修正不改变它；`sourceHash` 随文字变化。
- `figures[]`：`{index, page, kind, label, bbox, caption, captionOrder, blockIndex, assetId, blockId, captionBlockIds}`。
- `excluded[]`：被排除的块（页眉页脚、重复公式）连同原始块保留，不静默丢弃。
- `quality: {status, issues[], metrics:{pdfLines, assignedLines, excludedLines, unassignedLines}}`。

## 原始响应与版本

`lib/layout-archive.js`：

- `layout-data/raw/<sha256>.jsonl`：原始响应永久保留，内容寻址；同一内容重复写入不报错，内容不同但同 hash 报错。
- `layout-data/revisions/<revision>.json`：不可变版本；`layout-data/inputs/<revision>.json`：产生该版本的输入清单。
- `layout-data/current.json`：原子切换的当前版本指针；`layout.json` 只是兼容投影。
- `layout-data/legacy/<sha>.json`：第一次发布前备份旧版 layout.json。
- `clear` 只清指针与投影，不删除 raw/历史；原始证据可用于离线重放。

`getDoc` 重建时通过 `writeRebuiltDoc(id, previous, doc)` 保存新模型。拆段导致旧段落键失效时，只有原文摘录在全文逐字出现一次、且目标是可标注的唯一段落时才迁移定位。重复、缺失及译文标注保留原摘录和旧键，可按 `doc.annotationReview` 中的 `{id, revision, reason}` 提示复核。旧模型没有可核对的 revision 时记 `null`。历次重建保留待复核项的最早已知 revision，旧译文继续按原键保存。

### 离线重建（不重新上传）

模型改进或正文投影规则升级后，可以用已归档的 raw JSONL 在本地重建同一篇的 schemaVersion 2 版面，
不调用云端、不产生费用。默认只打印摘要，`--apply` 才发布为新 revision（旧 revision 永久保留）：

```bash
node scripts/quality/rebuild-layout.mjs <paperId>            # dry-run
node scripts/quality/rebuild-layout.mjs <paperId> --apply    # 发布新 revision
```

离线重建与 schemaVersion 2 回填共用当前 revision 的 raw 来源解析：页级 `rawRef` 保留上传批次范围，旧版可从块级或顶层引用恢复。支持多批及乱序结果，只读取当前版本引用的归档，不扫描目录中的旧 raw。局部页号必须完整且唯一；来源缺失、范围冲突或无法唯一恢复时在发布前拒绝，保留 current、兼容投影和历史。合法空白页及 `needs_review` 仍按原质量规则处理；其他模型的补充来源暂不支持安全回放时明确拒绝，不丢弃候选后发布。

历史 `ir-4` 没有页级 `rawRef`，仍可从当前归档的完整、唯一批次引用离线升级为 `ir-5`，不改旧 revision/input/raw。`source='service'` 的既有主模型（包括以主模型运行的 PaddleOCR-VL-1.6）按 `layout.model` 与引用模型一致性校验；它与 `source='vl'` 的补充候选是不同角色，后者仍明确拒绝安全回放。

批量 `node scripts/batch-layout.mjs --refill-existing` 在未 force 时也接纳通过 PDF 指纹、页覆盖、质量及 raw hash 校验的 `ir-4`，走共享离线回填，不补跑收费 OCR、不重传；dry-run 显示“离线重建”。来源歧义由回放校验拒绝，不能失败后转云端。发布后的版面及派生文档仍严格要求当前 `ir-5`；未知 build、不带回填选项或显式 force 不通过这条旧版兼容分支。

## 质量语义

- 服务模型的块框偶尔从第二行开始；`assignLines` 会把块框上方 28pt 内、文字高度相似且水平对齐的 PDF 行救回该块，并记 `rescued-pdf-line`，避免正文被拆成孤立块。

- 任务「跑完」不等于质量「通过」：`layout.status` / `layout.report` 单独返回 `quality`。
- `passed`：所有页的块文字都能和 PDF 文本层核对（或有等价证据）。
- `needs_review`：有页/块只能依赖模型文字（扫描页、乱码、坐标不可换算），前端提示看原页。
- `failed`：源页失败/缺页/缺尺寸，整篇不发布新版本，旧版本保留。
- 未匹配 PDF 行的短标签/页码/水印/邮箱只保留在质量报告与 `blocks[].quality` 里，不投影到正文；长句仍作为正文保留并标 `needs_review`。
- 每个问题的 `code` 可追踪：`missing-layout-page`、`missing-page-dimensions`、`unknown-coordinate-transform`、
  `unverified-model-text`、`garbled-candidate`、`text-conflict`、`ambiguous-line-owner`、`unmatched-pdf-line`、`rescued-pdf-line`、
  `duplicate-formula`、`unlinked-caption`、`caption-type-conflict`、`formula-text-conflict` 等。

## RPC

- `layout.status`：`layout` 附加 `schemaVersion/revision/quality/pages[{n,status,issues,summary,fallback}]`；`summary` 区分 `blocking`（需要人工判断）和 `informational`（候选冲突、行救回等提示，不单独阻塞阅读）。
- `layout.report`：只读质量报告（页状态、问题清单、`summary`、被排除块）。
- `layout.start` / `layout.run`：**默认续跑**（同一 PDF + 同一模型才认断点，已完成的批次整批跳过、不重复上传）；只有显式传 `resume:false` 才丢弃断点。
- `layout.cancel` / `layout.refill` / `layout.tables` / `layout.clear`：`refill` 对带 raw 的 schemaVersion 2 离线重建并发布新 revision，不重新上传；纯 PDF 模型无云端证据可回放时保持无操作。`layout.clear` 同时清断点与任务状态。

## 已知边界（不得冒称达标）

- 30 篇候选语料已全部下载（`C:/Users/QianXi/AppData/Local/Temp/pb-quality-corpus-5b7bcee5`，30 篇 / 762 页 / 70.7 MB，见 `docs/quality/ACQUISITION.md`）；80 页开发 gold 与 20 页盲测 gold **尚未人工标注**，因此没有真实质量分数。
- PaddleOCR-VL-1.6 作为扫描页补充候选已接入 `runLayout`：只有 PP-StructureV3 完全缺页时才补，且必须在 `layout.start` 传 `maxCloudPages>0`（或 `config.json` 的 `ocr.maxCloudPages`）才启用，默认 0 不额外计费。
- 公式结构化（LaTeX 正确性）、表格合并单元格、双栏复杂表格仍按原图核对；质量报告会指到原页。
- 现有测试只证明契约与回归；质量目标（页身份 100%、字符召回 ≥99.5% 等）需要用人工 gold 评测后再报告。

## 测试

- `scripts/test-page-identity.mjs`：页号/坏行/缺页/越界上传不发布。
- `scripts/test-layout-conservation.mjs`：文本守恒、清理只做一次、连字符、排除记录。
- `scripts/test-layout-ir.mjs`：38 条纯 fixture（坐标、候选、行归属、图注、公式、质量、数学字形、行救回与图内标签）。
- `scripts/test-layout-archive.mjs`：原始归档、不可变版本、旧版备份、指针切换。
- `scripts/test-layout-table.mjs`：HTML rowspan/colspan 网格、表头、伪表拒绝。
- `scripts/test-ocr-cancel.mjs`：OCR 提交/轮询/下载的 AbortSignal 与错误文本。
- `scripts/test-layout-model.mjs`：runner 命令顺序、分片、断点续跑、远端 jobId 续拉、清理规则。
- `scripts/test-pdf-quality.py`：`order_blocks` 双栏/单栏/表格。
- `scripts/test-figure-cache.mjs`：内容键 PNG 缓存与并发。
