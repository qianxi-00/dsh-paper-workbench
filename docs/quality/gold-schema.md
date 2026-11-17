# 人工gold标注协议草案 v1

状态：待实际人工执行。没有任何真实页面因为本文档而成为gold。

## 身份、坐标和版本

document保存doc_id、family_id、固定源版本、source_sha256、split及合成父文档。page保存page_id、0基物理页号、纸面页码标签、width_pt/height_pt、rotation、渲染器版本、渲染DPI和render_sha256。坐标统一为应用页面rotation之后、左上原点、pt；同时保存原PDF坐标到此坐标系的仿射变换。禁止把页面旋转前后的坐标混用。

所有gold字段有标注规范版本。机器检测只能标 `draft`，真实人工核验后才可标 `independently_reviewed`。顶层冻结记录guideline_version、冻结时间、gold SHA-256。两名独立人员的annotator_id/reviewer_id必须不同；记录分歧和裁决，不用模型替代签名。

## Page、word与区域

page记录layout_tags、excluded_regions/原因、illegible_regions。无法辨认的文字不得猜测；排除要在测试输出前固定且纳入报告。正文、页眉页脚、参考文献是否纳入主指标需预先明确，同一页仍保留完整标注，按role切片计算。

region字段：region_id、type、polygon_pt、bbox_normalized、parent_region_id、column_id、spans_columns、text_raw、text_normalized、normalization_profile。type至少覆盖title/heading/paragraph/figure/caption/table/formula/code/list/footnote/header/footer/reference。

word字段：word_id、region_id、line_id、text、bbox_pt、char_start/char_end、physical_hyphen/semantic_hyphen、legibility、annotator_id/reviewer_id。保留硬换行与语义连字的区分；原始文本与规则化文本并存。全局规则使用NFC，数学内容不做盲目NFKC。

## Reading order

以区域和词为节点，保存有类型有方向的边：precedes、next、continues_on_page。跨页边指向包含文档和页标识的稳定ID。主线阅读顺序、图注内部顺序、表内顺序分别标注，不能只按坐标排序生成真值。存在多种合理次序时保存optional_sequences或unordered_groups以及歧义原因。评测只比较规定可比较的节点。

## Caption、figure与子图

caption保存caption_id、region_id、原文、target_ids、target_type、subfigure_labels、association_evidence。figure包含各子图bbox/polygon和标签，图中文字与正文角色区分。图注跨页时允许多个region构成一个caption。不能因发现“Figure 2”文本就推断它必定是图注，它也可能是正文引用。

## Table

table保存table_id、caption_id、page_fragments。每个cell保存cell_id、row_start/row_end_exclusive、col_start/col_end_exclusive、polygon_pt、text、is_header、role。显式记录空单元格；合并单元格只有一个cell且跨度>1。跨页表共享table_id，保存片段之间continuation_edges和重复表头的repeated_header_links。连续页面上标题相似的两张表不能自动合成一个表。

边指标至少区分水平/垂直邻接、表头关联、跨页续接；结构和文本分别评分。错误单元格跨度可影响多个邻接关系，但仍需单独报告跨度正确率，当前CLI没有实现后者。

## Formula

formula保存formula_id、region_id、inline_or_display、equation_label、transcription_latex、accepted_equivalent_forms、symbol_spans和baseline/script/fraction/root关系。公式结构由对照页面的人工确定；LaTeX源码可以辅助但不保证渲染一致。LaTeX字符串不同不必然代表公式不同，等价候选由独立裁决者确认。当前CLI仅能对已标注并人工对齐的formula_edges做关系指标，不具备公式等价性判断。

## 评测口径

CER=(替换+删除+插入)/gold字符数，不截断。缺页按空预测计算。词召回使用位置+文本的一对一匹配，重复率只计多余预测实例，不能把合法重复表头算错。阅读顺序主指标为直接相邻边next的P/R/F1，另加可比较节点对的先后准确率。图注、表格和公式各自报告区域召回、文本与结构分数，避免一个指标替代全部。

没有某个维度gold时标not_evaluated，不能当作100%。已标注为空集合的维度，在没有正例时recall为null；有多余预测仍计false positive。边列表重复项不得用set静默去重后抹去错误。按文档family聚类统计置信区间，原生/扫描/编码变体分别报告。80+20页是目标，不是完成值。

## 冻结与盲测

每份原作及所有变体继承同一family/split。实现方不得使用holdout gold调参；实看PDF作标注的人与优化系统的人应分工。先冻结开发过程、代码版本、配置、指标，再由独立人员运行盲测。盲测成绩暴露后不能继续当作未见测试集，下一轮应换新的留出页。
