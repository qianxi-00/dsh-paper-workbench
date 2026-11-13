# 中文版 PDF（zhpdf）契约与实现

把已有译文写回原 PDF 的同一位置，产出 `papers/<id>/paper-zh.pdf`。只做覆盖，不做版面重排。

## 1. 数据流

```
doc.json（段落 hash + bbox + kind + 原文）
  + translations（workbench.db，hash -> 中文）
      -> lib/zhpdf.js: zhPagesFromDoc()
      -> pages: [{n, blocks:[{rect, text, source}]}]
      -> assets/pdf_tool.py: cmd_zhpdf
      -> papers/<id>/paper-zh.pdf
      -> /api/page?source=zh 渲染成页图
```

- `REPLACE_KINDS = {body, heading, caption, list, footnote}`：公式、图、表格不替换。
- `text` 是中文译文；`source` 是这一段原文，用来在 PDF 里逐行定位 —— **必须传**。
- `rect` 是版面模型给出的块 bbox（PDF pt，渲染坐标系），只作为兜底参考，实际擦除框由匹配到的行决定。

## 2. pdf_tool 的 `zhpdf` 命令

参数：`{path, out, pages, lineheight?}`，返回 `{ok, path, blocks, skipped, pages}`。

1. `_page_text_lines(page)`：`get_text("dict")` 取行级 `rect/text/size`（PDF 原生坐标）。
2. `_match_block_lines(source, lines, claimed)`：
   - 归一化（去空白、小写）后，用「行首 24 字符」在块原文里 `find` 到位置的行走作为起点；
   - 从起点往后逐行累加，长度 ≥0.6×目标后每步用 `difflib.SequenceMatcher.ratio()` 打分；
   - 取最高分（≥0.62 才认）；`claimed` 行跳过，保证一行只归一个块；按 y 从上到下调用。
3. 擦除框 = 认出行的并集（左右各 +1.2pt），并入同一基线的其它片断
   （`|center_y 差| ≤ max(2.5, 行高×0.25)`），因为大标题常被拆成多个 span。
4. 整页 `add_redact_annot(fill=None)` → `apply_redactions(images=PDF_REDACT_IMAGE_NONE, graphics=PDF_REDACT_LINE_ART_NONE)`。
5. 写字前 `draw_rect(fill=(1,1,1), overlay=True)` 铺白底（矢量路径标题擦不掉时的兜底）。
6. 字体：`_zh_font()` 依次找 `DSH_PAPER_ZH_FONT`、Windows `simhei.ttf`/`Deng.ttf`/`msyh.ttc`、
   macOS `PingFang.ttc`、Linux `Noto Sans CJK`；都没有才用内置 `china-s`。
   内置字体把拉丁字母画成全角（`G P T - 4`），所以系统字体优先。
7. 字号：`_fit_text()` 用临时页 probe，从原字号开始 6.5–13pt 递减；仍放不下就向下借 ≤28pt 空白。
8. 保存前 `subset_fonts()`（失败忽略），避免整份中文字体嵌进 PDF（1 页样例从 5 MB 降到 9 KB）。

## 3. RPC

| 方法 | 说明 |
| --- | --- |
| `zhpdf.status` | `{exists, at, size, stale}`；`stale` 按文件 mtime 与 `doc.json` 比对 |
| `zhpdf.build` | 生成；无译文 / 无文档 / pdf 工具报错都给中文原因；写任务日志 |
| `zhpdf.clear` | 删掉 `paper-zh.pdf` |

`/api/page?id=&page=&scale=&source=zh` 渲染中文版；缓存文件 `PAGES_DIR/<id>/zh-p<n>@<scale>.png`。

## 4. 已知限制

- 译文比原文长很多 → 字号被压小，仍放不下会压到下面的空白里（可能盖住下一行）。
- 矢量路径画的标题/艺术字，`redact` 擦不掉，只能靠白底盖住；个别字体会露一点边。
- 只替换有译文的段落；没翻译的图注、脚注、参考文献仍是英文。
- 不支持公式重排：公式块原样保留（KaTeX 排版只在对照视图里）。
- 生成是整篇一次（100 页约 1–2 秒的纯本地计算）；译文更新后需重新 build。

## 5. 测试

- `scripts/test-zhpdf.mjs`（20 项）：认领规则、payload 形状、status/stale、三种错误文案、clear。
- `assets/pdf_tool.py --self-test` 的 `zhpdf` 检查：替换 `Figure 1: sample image` → `图 1：示例图片`，
  断言英文消失、能渲染、文件大小合理（子集化生效）。

## 几个刻意的取舍

- **先试排、再擦除**：擦除不可逆，所以每一块先在草稿页上确认译文放得下（字号从原字号往下试，
  最多往下借 28pt 空白，且不会压到下一块）。放不下就整段跳过、保留英文，并计入 `skipped`；
  写回后再检查 `insert_textbox` 的返回值，负数也算跳过。
- **跨页段落不动**：`doc.js` 会把「上一页末尾没写完、下一页接着写」的段落合并成一个（`crossPage: true`），
  但它的 bbox 只覆盖第一页那几行，整段译文塞不进去。这类段落直接跳过并计入 `crossPage`，
  不做「塞一半」的处理，以免出现译文叠在下一段上。
- **坐标系**：输入 `rect` 是渲染坐标（和 `/page` 渲染出来的页图同系），内部先乘
  `page.derotation_matrix` 换回 PDF 原生坐标再定位文本行；旋转页（`/Rotate 90`）也成立。
- **同页重复文本**：先按块框收窄候选行，再按内容相似度 + 到块框中心的距离决胜，
  页眉、表头、重复图句不会把中文写到另一处去。
