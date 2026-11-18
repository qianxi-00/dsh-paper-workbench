---
name: paper-explainer
description: Deeply explain a selected passage, section, equation, algorithm, or figure of a paper using full-paper context and surrounding visuals, then save structured study notes. Use when the user asks to explain, unpack, derive, or walk through a paper excerpt, section, formula, or figure.
---

# 逐段 / 逐节 / 选段科研精讲

针对用户选中的论文段落、单个公式、算法或某个章节，结合全篇定位与周边图表给出兼顾直觉与严谨度的深度讲解，并沉淀为研读笔记。

## 执行步骤

1. **取证与定坐标（先调工具，不凭空读）**
   - 调用 `paper_explain`（按需求传 `mode="selection"` 或 `mode="section"`，并传入 `sectionId` / `selectionText` / `page` / `blockId`），一次获取全篇骨架、聚焦上下文、关联标注与周边图表。
   - 若 `surroundingFigures` 中包含关联配图或复杂表格的 `pngPath`，调用看图工具检视图像上的模块流向、坐标轴刻度、图例与误差线。
   - 在回答开篇先用 1–2 句话标定当前内容在全篇中的**坐标**：解决主问题的哪一环、上游输入是什么、下游服务哪一步。

2. **直觉与类比破冰**
   - 先用日常工程、物理或几何直觉解释设计动机（「为什么必须这么做，而不能用更朴素的方案」），让读者建立心智模型后再进入形式化表达。

3. **符号、维度与公式逐项拆解**
   - 对焦点中的核心公式（含引用的 `Eq. (N)`）或算法步骤：
     - 列出关键符号、张量维度/集合域与上下标约定；
     - 逐项解释每一项算子（如正则项、缩放因子、门控、残差连接）的数学与物理角色；
     - 说明推导跳步或近似成立的条件，严格区分论文明写内容与你的补充推导。

4. **联动周边 `Fig. / Table / Algorithm` 实验印证**
   - 结合 `surroundingFigures` 里的图/表/算法，把文字机制对应到具体架构框图、伪代码行或消融对比指标上，点明该设计在实验上究竟带来多少收益及对应开销。

5. **边界条件、隐藏假设与失效模式**
   - 剖析该部分隐含的前提假设（分布假设、复杂度瓶颈、内存层级前提、数值稳定性或数据规模条件），指出何时该设计会退化或失效。

6. **沉淀研读笔记**
   - 调用 `paper_notes(action="save_study_note", ...)`，参照 `studyNoteTemplate` 生成精炼的中文研读笔记（覆盖「核心直觉」「符号与公式」「图表印证」「边界条件」「原文定位」），传入对应 `paperId`、`scope`、`sectionId`、`page`、`blockId` 与精炼标题；若该节已存在同主题笔记，以合并更新后的清晰版本替代重复碎片。

## 完成标准

- 全篇上下游坐标明确；
- 同时包含核心直觉与逐符号/维度拆解；
- 至少结合并核实 1 项相关的 `Fig./Table/Algorithm` 或公式上下文；
- 所有页码与图表引用使用同源 `[p.N](/paper-workbench/app?paper=...)` 链接；
- 已将结构化中文研读笔记写入工作台（用户明确要求仅简短口头追问时除外）。
