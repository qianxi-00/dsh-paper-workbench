---
name: paper-explainer
description: Deeply explain any selected passage, section, equation, algorithm, experiment table, or conceptual argument of a paper using 120k full-paper context, surrounding visuals, and unified content-adaptive analytical depth, then persist structured study notes. Use when the user asks to explain, unpack, derive, analyze, or walk through any paper excerpt, section, formula, algorithm, or figure/table.
---

# 自适应深度科研精讲（选段 / 章节 / 公式 / 算法 / 实验统一标准）

不再将讲解割裂为「普通文段浅讲」与「单看公式推导」两套孤立模式，而是基于 120k 全篇上下文与周边图表，按焦点内容特征自动组合深度分析维度，兼顾第一性原理直觉与形式化严谨度，并将结论沉淀为研读笔记。

## 执行步骤

1. **取证与全篇定坐标（先调工具，不凭记忆猜）**
   - 调用 `paper_explain`（按需求传 `mode="selection"` 或 `mode="section"`，并传入 `sectionId` / `selectionText` / `page` / `blockId`），一次获取 120k 全篇骨架、聚焦邻域、周边图表及自适应 `explainGuide`。
   - 若 `surroundingFigures` 中包含关联架构图、曲线图或复杂表格的 `pngPath`，调用视觉看图工具检视模块流向、坐标轴刻度、图例与关键数值。
   - 在回答开篇先用 1–2 句话标定当前内容在整篇论文问题链中的**上下游坐标**：解决核心瓶颈的哪一环、输入承接自哪一节、输出服务下游哪一步。

2. **第一性直觉破冰**
   - 先用清晰的工程、物理或几何直觉讲透设计动机（「朴素基线究竟卡在哪里，为什么必须引入这一机制」），建立心智模型后再进入严格拆解。

3. **按焦点内容特征自适应深度拆解（命中多项时组合展开）**
   - **当包含公式与数学符号（`hasFormula`）**：
     - 给出**逐符号物理/数学含义表**（符号、张量形状/定义域、上下标约定）；
     - 拆解**公式推导直觉与每一项算子的设计目的**（缩放项、门控、正则项或近似条件各自起什么作用，显式区分原文结论与补充跳步推导）；
     - 阐明**与前后节推导及架构框图的衔接关系**。
   - **当包含算法、伪代码或复杂度（`hasAlgorithm`）**：
     - 执行**输入输出与张量/数据流追踪**（标清输入输出规格、中间状态及寄存器/SRAM/HBM/内存层级搬运路径）；
     - **核心步骤拆解**（逐阶段剖析分块策略、循环不变量、并行调度或关键分支）；
     - 量化**相比基线的复杂度与 IO 收益**（时间、空间、通信或访存复杂度对比）。
   - **当包含实验表、消融或评测指标（`hasTableOrMetric`）**：
     - 核查**实验设定公平性**（数据集、参数规模、算力预算、硬件与对比基线口径是否对齐）；
     - 剖析**核心指标增益来源**（哪个子任务/序列长度/配置下增益最大及内在原因）；
     - 提炼**消融实验证明了什么**（各核心组件的独立贡献、耦合关系与超参敏感性）以及**边界与局限**。
   - **当聚焦概念论述、研究动机或讨论（`concept`）**：
     - 精确界定核心概念与问题边界，对比本文范式与相关工作的本质分野，指出隐含假设及在后文方法/实验中的验证锚点。

4. **联动周边 `Fig. / Table / Algorithm` 交叉印证与边界剖析**
   - 将文字机制与 `surroundingFigures` 中的架构图、伪代码行或实验主表一一对齐印证，并点明该设计在何种分布、规模或硬件前提下会退化或失效。

5. **同源精确引用与研读笔记沉淀**
   - 回答与笔记中所有页码、段落、公式与图表引用一律保留同源可点击链接 `[p.N](/paper-workbench/app?paper=...)`（完整保留 `block`、`revision`、`section` 参数）。
   - 实质性章节/方法/选段讲解完成后，调用 `paper_notes(action="save_study_note", ...)` 参照 `studyNoteTemplate` 保存或合并更新结构化中文研读笔记（避免重复水贴）。

## 完成标准

- 全篇上下游坐标与设计直觉清晰；
- 按焦点命中的公式 / 算法 / 实验 / 概念维度完成全要素深度拆解，无浮泛套话；
- 至少结合并核实 1 项相关的 `Fig./Table/Algorithm` 或跨节公式上下文；
- 所有页码与图表引用使用同源 `[p.N](/paper-workbench/app?paper=...)` 可点击链接；
- 已将结构化中文研读笔记持久化写入工作台（用户明确要求仅简短口头追问时除外）。
