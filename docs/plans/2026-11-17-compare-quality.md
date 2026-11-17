# PDF 对照质量提升实施计划

用户在 2026-11-17 批准：统一按页解析、按块选源、保留证据、逐页验收。基线为 dev 的 727f81acc57f5a659931393454c70b34aa480979；隔离分支 agent/compare-quality-v2。本计划涵盖完整交付，不能把确定 bug 修复当作全部完成。

## 验收与约束

- 单一通用流程，不按论文名/id 写特殊规则。原 PDF 是视觉核对基准，对照稿为可追溯的语义重排。
- PP-StructureV3 主结构 + 可靠 PDF 文本候选；扫描/乱码/证据冲突用已配置 PaddleOCR-VL-1.6 至多追加一轮。模型分数缺失是未知，不能编造。
- 高质量使用单页云任务并发 2，以本地提交清单确定页身份；明确本次云调用上限，不自动处理整库、不读取/输出 token。关闭面板不停止任务，保存 jobId 并优先恢复已有远端任务。
- 原始响应不可变保留；记录模型/参数、pageId/blockId、坐标与候选来源、质量状态、排除/合并理由。原始数据不随断点删除。
- 原文有变更的旧译文保留历史并标 stale，不能错误贴回；稳定块 ID 与文本 hash 分离。图缓存绑定 PDF hash/page/bbox/scale/render version。
- 新产物校验成功后才发布版本，失败不覆盖旧成功产物；没有可靠结构的页展示原页/原区域并标 needs_review。执行完成不等于质量通过。
- 迁移有备份、兼容旧数据；原始响应缺失的旧布局标 legacy，不擅自重新上传。所有写入测试使用临时库，禁止清理真实文献或全库缓存。
- 基准目标：30 份可合法获取 PDF、至少240页；至少80页有人工核验标注，20页留作未参与调参的验收集。不得把自动生成的标签冒称人工标注。
- 页身份100%；原生文本字符召回≥99.5%/重复≤0.2%；扫描CER目标≤2%；标注相邻块和跨栏关系正确率≥99%；图表召回及图注正确率≥98%。按类别分别报告，结构化公式/表格准确率与覆盖率/回退率一并报告。未实测不能报达标；必需语料缺失要失败。

## 分阶段工作

1. 安全基线与确定缺陷：构建临时库测试入口；修坏JSON页号压缩、双栏读序、非相邻段落合并、重复清理及PNG缓存。先失败测试再修改。
2. 数据基础：保存原始响应及清单，统一带来源的页/块中间模型；采用不可变版本产物和原子发布指针，保留兼容读接口，建立旧布局迁移与备份。
3. 模型协作与构建：按页预检、受限云任务队列、恢复/取消/预算；约束行到块的匹配，核算未匹配文字；统一初建/重填/离线重放；图注关系、跨页片段、公式重复证据及合并表格占位网格。
4. 接线与阅读：layout.start(mode/pages/maxCloudPages)、layout.status(quality/revision)、layout.refill(offline)、layout.report(readonly)、doc.get/figures.list版本与稳定ID；高质量单入口、问题定位及原页高亮；译文版本关联与中文PDF一致性。
5. 评测与验证：纯逻辑/故障测试、保存原始响应的离线评测、有限真实API与浏览器验证；更新配置/迁移文档；独立规格审查后代码质量审查。
6. 完整审查与集成：全量测试、质量前后对比与未达项报告；合入dev、按GitForge授权推送；清理自建测试服务。

## 已确认的实现问题

- lib/layout.js parseLayoutJsonl 遇坏行跳过并按 pages.length 编页；runLayout 又按 start+index 赋页号，错误进入 donePages。
- cleanLayoutBlocks 用布尔 overlapsHorizontally 再 >=0.5，间距只检查 <=6；远距离页底/页顶也合并。公式去重只有90pt距离无文本等价证据。
- lib/doc.js 又执行一次 cleanLayoutBlocks；一整篇选来源，局部缺失无回退。
- assets/pdf_tool.py order_blocks 无全宽块时直接(y,x)排序；scripts/test-layout.mjs错误验证整页y单调。
- lib/figures.js 在生成新PNG之前改stamp，新stamp与新清单相等但旧PNG可继续复用。
- 模型raw被丢、标题/图注候选固定选择、回填无未分配行台账；初建与重填算法分岔。

## 测试边界（已随方案批准）

现有公开纯函数/构建器、pdf_tool命令(JSON输入输出)、layout/doc/figures RPC、最终DOM/原页定位。只模拟收费网络及宿主服务，保留真实文件和构建行为；质量期望来自独立手工核验标注，不能用构建器生成自身期望。

## 实施记录

- 2026-11-17：建立隔离工作树；开始在单独临时数据根执行原有 npm test。未操作用户库、未调用收费API。

- 2026-11-17：完成阶段1/2核心。`lib/layout-ir.js` 统一纯构建器 34 条 fixture 全过；`lib/layout-archive.js` 原始归档/不可变版本/兼容投影 7 条全过；`parseLayoutJsonl` 页身份、`cleanLayoutBlocks` 守恒与 doc 去二次清理已修（8+7 条）；`order_blocks` 双栏（8 条）、图缓存内容键（8 条）已修复。`runLayout` 已改为：每批原始 jsonl 归档 → 每页取 `page_lines` → `buildDocumentLayout` → attachTables → `archive.publish`（版本化）→ layout.json 投影。`refillText` 对 schemaVersion 2 只读返回。RPC 增 `layout.report`，`layout.status` 增 quality/revision/pages；SPA 工具栏加「质量」报告（未就绪页可跳原页）。全量测试见提交说明。
- 未完成（当时）：PaddleOCR-VL-1.6 自动补充候选（IR 接口已留 `supplementaryPages`，主流程未接）；`lib/layout-table.js` 与 OCR 取消（task-6 子代理进行中）；语料只下载 15/30，gold 0 页；需要人工标注后才能报告质量指标。

### 最终状态（2026-11-17）

- PaddleOCR-VL-1.6 已按 `maxCloudPages` 接入缺页补充（默认 0，不额外计费）；`layout-table.js`、OCR 取消、远端 jobId 续拉、离线 raw 重建、质量汇总均已完成。
- 语料 30/30 篇、762 页、70,693,890 字节（`docs/quality/ACQUISITION.md`）；人工 gold 仍 **0 页**，20 页盲测未建立。
- 全量测试：**679 PASS / 0 FAIL**（隔离数据根，`python scripts/test-pdf-quality.py` 9 tests + `pdf_tool --self-test` 13 checks 通过）。
- 质量基线（`docs/quality/BASELINE.md`）：Paraformer 正式 layout 字符召回 97.62% / 行覆盖率 94.66%；归档 raw 离线重建后字符召回 99.15%、字符多重集召回 99.39%、行覆盖率 95.65%，`quality` 仍 `needs_review`。**未达到 99.5% 验收线，不能宣称达标**。
- 真实云端复解析曾在轮询阶段超时，已终止且没有发布新 revision；线上仍是旧 revision，离线重建 CLI 可 `--apply` 发布，但未对用户真实库自动执行。
- 当前代码已合入 `dev` 并推送 `origin/dev`；最近质量提交见 `git log`（`db49287`）。
