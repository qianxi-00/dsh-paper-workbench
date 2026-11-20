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
| `zhpdf.status` | `{exists, at, size, stale}`；核对完成标记、源 PDF SHA-256、译文指纹及文档时间戳 |
| `zhpdf.inspect` | `{missingKeys, readyBlocks, crossPage, unlocated, issues}`；恢复可定位文字框并汇报覆盖率与具体页码。缺译走独立持久翻译，任务标记为 `purpose: zhpdf` |
| `zhpdf.prepare` | 创建或复用单论文持久任务，先等待已有翻译，再增量补缺，校验快照并生成。返回 `{job}` |
| `zhpdf.pause` / `zhpdf.resume` | 暂停或继续生成流程。仅暂停本流程拥有的补译任务，已有普通翻译继续运行 |
| `zhpdf.build` | 所有目标块均定位并具备译文后才渲染；核对可打开性、页数和写入数，漏段不发布，保存生成记录失败时恢复旧文件 |
| `zhpdf.clear` | 删掉 `paper-zh.pdf` |

`/api/page?id=&page=&scale=&source=zh` 渲染中文版；缓存文件 `PAGES_DIR/<id>/zh-p<n>@<scale>.png`。

## 4. 已知限制

任务文件为每篇论文下的 `zhpdf.job.json`，记录 `purpose`、阶段、补译任务 ID、模型、覆盖率及 PDF/文档/译文指纹。`zhpdf.status.job` 返回这些状态。宿主模型服务加载后自动接续运行中的任务，显式暂停的任务等待继续。前端重载后重新观察后台任务，仅在当前论文的原文页仍打开时自动切换。

- 译文比原文长很多时，先缩小字号，再尝试使用下一块之前的空白；仍放不下则报出页码，不发布新文件。
- 矢量路径画的标题/艺术字，`redact` 擦不掉，只能靠白底盖住；个别字体会露一点边。
- 跨页段落按页内原文框拆分；缺坐标时只接受本地文本层的唯一完整匹配。无法安全定位或排版时报告页码和原因，不发布新文件。
- 不支持公式重排：公式块原样保留（KaTeX 排版只在对照视图里）。
- 再次打开时会校验源 PDF、文档与译文；有变化需重新生成。

## 5. 测试

- `scripts/test-zhpdf.mjs`：认领规则、payload 形状、status/stale、三种错误文案、clear。
- `assets/pdf_tool.py --self-test` 的 `zhpdf` 检查：替换 `Figure 1: sample image` → `图 1：示例图片`，
  断言英文消失、能渲染、文件大小合理（子集化生效）。

## 几个刻意的取舍

- **先试排、再擦除**：每一块先确认译文放得下，最多向下借 28pt 可用空白；失败会记录页码和原因。写回后还会检查 `insert_textbox` 的返回值，任何漏段都会阻止发布。
- **跨页按原文位置写回**：文档模型保留每页的原文与坐标片段；生成时按片段分配完整译文。旧文档缺坐标时尝试用本地 PDF 文本层恢复；无法建立可靠对应关系时不发布。
- **坐标系**：输入 `rect` 是渲染坐标（和 `/page` 渲染出来的页图同系），内部先乘
  `page.derotation_matrix` 换回 PDF 原生坐标再定位文本行；旋转页（`/Rotate 90`）也成立。
- **同页重复文本**：先按块框收窄候选行，再按内容相似度 + 到块框中心的距离决胜，
  页眉、表头、重复图句不会把中文写到另一处去。
