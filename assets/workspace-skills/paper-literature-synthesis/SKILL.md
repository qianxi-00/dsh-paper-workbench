---
name: paper-literature-synthesis
description: Synthesize and compare multiple papers into a quantitative comparison matrix, method lineage tree, root-cause reconciliation of conflicting findings, and open research questions. Use when the user asks to compare papers, build a literature review, trace method evolution, or resolve conflicting results across papers.
---

# 多篇论文对比与文献综述

跨多篇文献建立统一坐标系的对比分析：杜绝按篇流水账罗列，聚焦演进脉络、量化对齐与矛盾归因。

## 执行步骤

1. **清点范围与逐篇取证**
   - 确认目标论文清单（可用 `paper_library(action="list")` 或结合 `paper_obsidian(action="search")` 检查本地已沉淀笔记）。
   - 对每篇核心论文分别调用 `paper_explain(mode="paper")`（必要时配合 `paper_doc` 精读关键方法/实验节与看图工具核对主表），确保同一维度指标来自原文实测而非二手转述。

2. **构建横向量化对比表**
   - 围绕同一组对比轴绘制 Markdown 对比表：
     - **核心假设与切入点**
     - **关键机制 / 架构创新**
     - **理论复杂度（时间 / 显存 / 通信）**
     - **评测基准与关键指标数值**（标明数据集、指标口径与规模）
     - **主要代价与适用边界**
   - 若各论文评测基准、模型规模或硬件口径不同，在表中显式标注并加上口径注释，不强行跨口径直接比大小。

3. **梳理方法谱系演变树**
   - 按「问题 → 瓶颈 → 分叉解法」画出技术演进树（可用层级缩进列表或 Mermaid 流程/演化图），阐明每一代工作消除了上一代的什么前提限制，又引入了什么新权衡。

4. **矛盾结论溯源**
   - 识别不同论文间的表面冲突（例如某技巧在 A 论文有效而在 B 论文失效或负提升）。
   - 下钻对比实验设置、数据分布、基线实现细节、正则/学习率调度或规模效应，给出有原文证据支撑的差异归因。

5. **凝练开放研究问题与沉淀**
   - 总结当前方向尚未解决的 2–4 个核心技术缺口与可检验的新研究假设。
   - 若面向专题做系统梳理，调用 `paper_obsidian(action="survey", topic=..., markdown=...)` 生成方向综述（或在单篇内补充交叉对比 `paper_notes(action="save_study_note", ...)`），全文所有指标均保留对应论文的 `[p.N](/paper-workbench/app?paper=...)` 同源引用。

## 完成标准

- 包含统一字段的横向量化对比表（且注明了口径差异）；
- 具备清晰的方法谱系演进脉络，而非逐篇摘要堆砌；
- 针对至少一处跨论文差异或权衡给出原文级溯源解释；
- 列出具体、可验证的开放研究问题，并完成对应引用标注。
