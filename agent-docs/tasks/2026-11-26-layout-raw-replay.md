# QIAN-69 / GitHub #7 修复候选

日期：2026-11-26。状态：候选实现，待非实现者对精确 head 复测。基线：310fe96d6579a47e4b63c150ac37e658a0c4420d。仅此轮单缺陷候选授权，不代表新版 2+1 准入；占用、generation 和 unknown 保留。

## 变更与边界

- [IR](../../lib/layout-ir.js) 持久化页级 rawRef（空白页也保留）；IR 和文档缓存 build 同步为 ir-5，避免相同输入的旧 revision 内容冲突。
- [共享回放](../../lib/layout.js) 按当前页、块、被排除块、顶层 rawRef 取证，以 raw 批次范围恢复全局页号。没有范围时，要求完整连续的页绑定，或唯一整篇 raw；不扫描目录、不猜正文。
- [重建 CLI](../../scripts/quality/rebuild-layout.mjs) 和 refillV2 使用同一解析。重复/越界/缺页、当前来源冲突、引用丢失、hash 损坏均先拒绝，尚未进入 publishDerived 或文档写入。
- 非 PP-StructureV3 的补充来源暂明确拒绝安全回放；本轮不扩展 VL 算法，不将候选丢弃后发布。纯 PDF 模型维持原无操作语义。
- 不做真实库迁移或历史改写，不从历史目录自动修复已经损坏的 current；恢复证据不足需要人工选择正确历史版本，未在本轮实现。

## 回归及验证入口

新增 [test-layout-replay.mjs](../../scripts/test-layout-replay.mjs) 已纳入 npm test，默认每例十轮。通过真实 store/archive/runner 及重建 CLI 验证；只替换收费 OCR 和 runner 的 PDF 提取边界。CLI 成功路径实测无原 PDF 时的 lineAssignments 回退。

本轮先在未修复产品观察原探针指定正文断言 exit 1；新增回归第一轮记录红灯。修复后新增回归 24 类 × 10 轮 = 240 PASS / 0 FAIL；包括三批/非首批、旧页无 rawRef、顶层/块级恢复、hash-only 兼容、相同 raw hash 跨批、空白、乱序、无关旧/坏 raw、重复/越界/缺页/坏行、全局范围错误、歧义、hash 损坏和丢失、补充来源拒绝、CLI dry-run/apply。拒绝路径逐字节比较 current、兼容投影、doc、PDF、raw/input/revision；成功路径保留原历史。

已执行相关既有回归：页身份 8/0、IR 41/0、归档 7/0、模型 116/0、行守恒 7/0、表格 150/0、文库审计 13/0。文库审计首次沙箱 spawn EPERM 后，在获准环境重跑通过；环境失败不计产品失败或通过。

候选工作树的完整 npm test（含 posttest）exit 0，119.076 秒；新增回归 240/0、Python 质量 10/10、自检、中文 PDF 任务 5/0、批量版面 1/0 均实际执行。SKIP 为 Obsidian 配置、三项本机 PDF 样例、OpenAlex 在线检索（本轮接口失败）和真实 OCR（无 token）。stderr 保留有意损坏 JSON 的诊断及 fitz 弃用警告。首次完整回归因验证驱动把 TEMP 放在仓库内，安装器复制到自己的输出路径而超时，14/1；将证据与 TEMP 移出仓库后使用相同断言重跑通过，安装器 15/0、发布安全 24/0。未修改安装器或测试阈值。

精确候选 head 的原探针 20 轮、提交后回归、CI 回执和附件哈希由 QIAN-69 最终交付评论登记，不以本文的计划替代实际结果。

## 入口实测与未测

- 共享 runLayout/readLayout/refillText：实际集成回归。未改原探针另用真实 Python/PyMuPDF、合成扫描 PDF、假 OCR 验证。
- rebuild CLI：实际子进程 dry-run、--apply、歧义拒绝和历史保护。
- RPC `layout.refill`、批量 `--refill`：已核对都调用同一 runner，成功后才刷新派生文档；本轮不声称完整 RPC/批量入口 E2E 通过。既有批量脚本回归随 posttest 执行。
- 未测真实宿主 UI、OCR/VL、PG/MySQL、Vault、真实复杂论文、并发 refill/clear。候选提交、PR、独立复测、合入后复验和关单是不同阶段，本轮只交候选。

计划：[多批 raw 离线回放修复](../plans/2026-11-26-layout-raw-replay.md)。
