---
name: paper-deep-digest
description: Conduct an end-to-end six-step deep reading of an entire paper covering research question, baseline limits, method formalization, ablations, reproducibility, and knowledge-graph linking. Use when the user asks for a full-paper deep dive, structured paper digest, or Obsidian paper card.
---

# 整篇论文深度精读六步法

对单篇论文执行系统化的全篇精读，产出高密度、可核查、可复现评估的科研报告，并同步沉淀到工作台笔记与 Obsidian 知识库。

## 执行步骤

1. **全篇与视觉资料拉通**
   - 调用 `paper_explain(mode="paper")` 获取论文元信息、完整目录、全篇核心正文及关键图表清单。
   - 对核心架构图（`Fig. 1/2`）和主实验结果表，使用 `surroundingFigures` 中的 `pngPath` 调看图工具核实细节；若需查看正文被折叠的次要章节或附录证明，用 `paper_doc(sectionId=...)` 补读。

2. **第一步：Research Question 与 Baseline 局限**
   - 提炼论文要解决的核心科学/工程问题，以及问题成立的关键场景约束。
   - 拆解已有 Baseline 究竟在**机制、假设或复杂度**的哪一步卡住了（给出原文依据与 `[p.N](...)`）。

3. **第二步：Method 机制与数学形式化**
   - 端到端梳理输入 → 核心模块 → 优化目标/损失函数 → 输出的数据流与计算路径。
   - 提取最关键的形式化公式与伪代码逻辑，补齐时间/空间/通信复杂度量级分析。

4. **第三步：实验设计与消融（Ablation）拆解**
   - 核对主实验基准、数据集与对比基线是否对齐（参数量、算力预算、训练步数/数据量）。
   - 逐项分析消融实验：哪个组件贡献了主要增益？哪个组件边际收益低或对超参数极度敏感？

5. **第四步：真实可复现性与工程评估**
   - 评估代码/模型/数据集开源情况、训练与推理资源门槛、超参敏感性及论文未重点讨论的局限、工程 trick 或失败条件。

6. **第五步：知识图谱卡片建议 & 第六步：双端沉淀**
   - 给出 3–5 个可关联的概念节点（`[[概念/方法]]`）、上下游前驱/对比论文关系及主题标签建议。
   - **工作台笔记沉淀**：调用 `paper_notes(action="save_study_note", scope="paper", ...)` 写入全篇六步精读笔记（使用结构化二级标题）。
   - **Obsidian 知识卡沉淀（如环境可用且用户需要）**：先调 `paper_obsidian(action="status")` 与 `read` 查看现有卡片，再用 `paper_obsidian(action="upsert", ...)` 保留用户已有字段并更新精读报告与核心字段。

## 完成标准

- 覆盖研究问题、Baseline 局限、方法形式化、消融拆解、可复现性评估与知识图谱关联六大板块；
- 所有关键数字、公式与表内结论附带 `[p.N](/paper-workbench/app?paper=...)` 原文链接，未在材料中出现的指标明确标记为缺失；
- 已保存结构化全篇研读笔记到工作台。
