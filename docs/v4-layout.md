# v4：版面模型契约（`layout.json`）

> 目的：把「PDF 里这一页有什么」交给版面模型判定，插件只负责把它翻译成文档模型。
> 这一版**不改** doc/api 的对外形状，只在 `doc.paragraphs[]` 上加了三个可选字段
> （`figureIndex` / `latex` / `html`），老前端读到不认识就忽略。

## 0. 共同约定

- 零新依赖：只有 `node:` 内置 + 现有 `pdf_tool.py`。
- 纯函数优先：`parseLayoutJsonl` / `normalizeLayout` / `joinLines` / `column` 都不碰 IO，
  网络与磁盘收在 `createLayout()` 里；测试不联网。
- 错误消息中文、可操作（「还没填 PaddleOCR 的 API Key：设置 → PaddleOCR 里填一次再试」）。
- 版面结果是**可选增强**：没有 `layout.json` / 与 PDF 指纹对不上 / 解析失败，一律退回文本层路线。

## 1. 数据来源

PaddleOCR AI Studio 任务接口（与 OCR 同一个 Key、同一个 job 服务）：

1. `POST https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`（multipart，`model=PP-StructureV3`）；
2. 轮询 `GET …/jobs/{jobId}` 直到 `state=done`，取 `data.resultUrl.jsonUrl`；
3. 下载 jsonl：**一行一页**；`result.layoutParsingResults[].prunedResult` 里是块级结果。

关键字段（实测）：

| 字段 | 说明 |
| --- | --- |
| `prunedResult.width/height` | 服务图片坐标系（如 1191×1684，对应 A4 595×842pt，比例 ≈2.0） |
| `parsing_res_list[]` | 块数组，**数组顺序就是阅读顺序** |
| `block_label` | `text` / `paragraph_title` / `figure_title` / `table` / `image` / `chart` / `formula` / `algorithm` / `footnote` / `header` / `footer` / `number` |
| `block_bbox` | `[x0,y0,x1,y1]`，服务坐标系 |
| `block_content` | 文本块的 OCR 文字；表格是 `<html>…<table>`；公式是裸 LaTeX |

服务端的 OCR 文字只当「结构证据 + 兜底」，正文一律回到 PDF 文本层抠（见 §3）。

## 2. `papers/<id>/layout.json`

```jsonc
{
  "version": 1,
  "at": "2026-11-13T07:19:27.783Z",
  "model": "PP-StructureV3",
  "jobId": "1146…",
  "source": { "size": 123456, "mtimeMs": 1763000000000, "path": "…/paper.pdf" },
  "pageCount": 5,
  "servicePages": 5,
  "warnings": ["第 2 页：服务端返回 1 页，与上传的 2 页不一致，按顺序对齐"],
  "blocks": [
    {
      "order": 0,                 // 全局顺序（0 基，与 doc.paragraphs[].order 一致）
      "page": 1,
      "label": "paragraph_title",
      "kind": "heading",          // doc 侧的 kind
      "level": 1,                 // 只对 heading 有，来自编号（2.1 → 2）
      "bbox": { "x": 45.5, "y": 47.5, "width": 511.3, "height": 38 },
      "text": "Paraformer: Fast and Accurate …"
    },
    { "order": 2, "page": 1, "label": "image", "kind": "figure", "figureIndex": 0, "bbox": { … }, "text": "" },
    { "order": 4, "page": 1, "label": "formula", "kind": "formula", "latex": "\\beta=…", "bbox": { … }, "text": "" },
    { "order": 6, "page": 3, "label": "table", "kind": "table", "figureIndex": 3, "html": "<table>…", "text": "a | b", "bbox": { … } }
  ],
  "figures": [
    {
      "index": 0,                 // 与 figures.json / figure?id=&index= 的位置一致
      "page": 1,
      "kind": "figure",           // figure | table
      "label": "image",
      "bbox": { "x": 72, "y": 170, "width": 460, "height": 200 },
      "caption": "Figure 1: Analysis of different error types …",
      "captionOrder": 3,          // 图注那个块的 order
      "blockIndex": 2             // 图块自己的 order（前端按它原位渲染）
    }
  ]
}
```

规则：

- **坐标单位是 PDF 点（pt）**，且已缩放到该页实际尺寸；旋转页（`/Rotate 90`）换到渲染坐标系，
  `figure?id=&index=` 直接用它裁图。
- `figureIndex` 指向 `figures[]` 的位置；`figures[]` 的顺序 = `figures.json` 的顺序，
  所以 `figurePath(id, index)` 不需要额外的映射。
- `captionOrder` 由「同页最近的 `figure_title`/`table_title`」决定，一条图注只归一张图；
  没有图注就是 `null`（图仍然原位显示）。
- `header` / `footer` / `number` / `seal` 直接丢弃，不进 `blocks`。

## 3. 文字回填（结构走模型、正文走文本层）

对每个需要文字的块：

1. 用 `pdf_tool page_lines` 取整页文本层行（`{x,y,x2,y2,text}`，原生坐标）；
2. 按「行与块 bbox 的面积覆盖率 ≥ 0.5」或「行中心落在块内」把行分配给块，**一行只归一个块**；
3. 补缝：版面框之间偶尔漏掉段首那一行 —— 如果某个块拿到的文字在服务端文字里不是从 0 开始
   （`missingHeadPosition`），就把块上方、文字属于服务端开头的那几行补进来。
   这条是用「服务端文字做证据」，不是猜——避免把邻段的行抢过来；
4. `joinLines` 拼段：行尾连字符去空格（`text-` + `only` → `text-only`），中文之间不插空格。

其它规则：

- 图注优先用**服务端文字**（PDF 文本层在部分排版里会丢词间空格，`Figure3: Anillustrationof`）；
- 正文用文本层，但若文本层明显是废字（>50% 是单字符 token，如 `P f F t d A t`）则退回服务端文字；
- 空文字的正文块直接丢；图/表/公式块允许空文字（它们靠 bbox 渲染）。

## 4. doc 侧契约变化

`doc.get` 返回的 `doc` 多两个字段：

- `source`: `'layout' | 'pdf-text' | 'ocr' | 'degenerate'`；
- `layoutAt`: 版面结果的 `at`（非 layout 路线没有）。

`doc.paragraphs[]` 增加可选字段：

| 字段 | 何时有 | 含义 |
| --- | --- | --- |
| `figureIndex` | `kind` 是 `figure` / `table` | 指向 `figures.list` 的位置 |
| `latex` | `kind === 'formula'` | 公式源码（`text` 同一份，用于 hash/检索） |
| `html` | `kind === 'table'` | 表格 HTML（前端只展示纯文本，HTML 留给以后） |

`kind` 现在取值：`heading` / `body` / `list` / `caption` / `footnote` / `formula` / `figure` / `table`。

**缓存失效**：`doc.json` 里存 `layoutAt`；`layout.at` 变了、或 `layout.source` 与 PDF 的
`size/mtime` 不一致、或走 `rebuild`，都会重建。`layout.run` 完成后服务端会**等** `doc.json` 删除
再返回（删盘是异步的，不等会出现「刚解析完还是旧文本」）。

## 4.5 表格结构（`block.table` / `doc.paragraphs[].table`）

版面模型只说「这块是表格、在哪」，格子从 PDF 自己要：`pdf_tool tables` 用 PyMuPDF
的 `find_tables()` 按格线切（没有格线再按文字对齐试一次），返回二维文本。抽不到才退回
版面模型的表格 HTML（`block.html`）。

```jsonc
// layout.json 的 table 块上多一个字段
{
  "kind": "table",
  "table": {
    "rows": [
      { "cells": [{ "text": "Model", "header": true, "colspan": 1, "rowspan": 1 }], "header": true }
    ],
    "cols": 3,
    "headerRows": 1,
    "source": "pdf"          // pdf | service
  }
}
```

规则：

- 服务端 HTML 先转数据（`htmlToTableModel`：剥标签、`<br>` 当换行、解实体、保留
  `colspan/rowspan`），绝不把 HTML 交给前端 `innerHTML`；前端只用 `h()` 建 `<td>/<th>`。
- 可信度门槛 `tableQuality`：行数 ≥2、列数 ≥2、每行列数（含 colspan）一致率 ≥60%、
  非空格子 ≥30%、没有格子塞整段文字（>400 字符）。服务端 HTML 另加一条：
  「有格子里挤了 3 个以上数字」的比例 >30% 判为合并列，不用。
- 过不了门槛就不写 `table`——前端只显示裁剪图 + 纯文本，不硬画一张错的表。
- 想只补表格（不重新上传 PDF、不花额度）：RPC `layout.tables` →
  `createLayout().refreshTables(id)`，重算表格并清 doc 缓存。

前端：裁剪图是主体（原文），表格结构放在**折叠块**里（`<details>`），标题写明「识别可能有错，
以原图为准」，表头 sticky、超宽横向滚动、单元格可选中复制。这样即使某个表的结构不准，
也不会让人以为那就是原文。

## 5. 翻译与配图

- 翻译池过滤：`formula` / `figure` / `table` 不送翻译（图块只有占位文字，表格是行数据）。
- `figures.list` 优先读 `layout.json`：图注、bbox、`attachOrder` 都来自模型；
  此时前端不再按「图 N」字样猜挂载，`attachOrder` 直接指向图块自己的段落。
- 没有 `layout.json` 时行为与 v3 完全一致（PyMuPDF 规则 + 图注认领）。

## 6. 测试

| 文件 | 覆盖 |
| --- | --- |
| `scripts/test-layout-model.mjs` | 标签映射、坐标缩放、图注认领、公式清洗、表格 HTML→文本、行回填/补缝、分片页号、假依赖跑通 `runLayout`、没 Key 的中文提示 |
| `scripts/test-doc-layout.mjs` | `doc.get` 走 layout（kind/figureIndex/latex/html/节归属）、缓存命中、hash 稳定、`figures.list` 用版面清单、指纹不一致自动退回文本层 |
| `scripts/test-layout.mjs` | 没有版面的文本层路线不回归（段落/图表/双栏），`tables` 在真实大表上切出 ≥2×2 |
| `scripts/test-layout-model.mjs` | 表格 HTML → 结构、可信度门槛、跑版面时补表格、`refreshTables` 不重传 |
| `assets/pdf_tool.py --self-test` | `page_lines` / `clip_text` / `split` / 旋转页坐标 |
