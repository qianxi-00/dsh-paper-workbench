# QIAN-69 / GitHub #7 修复候选

日期：2026-11-26。状态：候选实现，待非实现者对精确 head 复测。基线：310fe96d6579a47e4b63c150ac37e658a0c4420d。仅此轮单缺陷候选授权，不代表新版 2+1 准入；占用、generation 和 unknown 保留。

## 变更与边界

- [IR](../../lib/layout-ir.js) 持久化页级 rawRef（空白页也保留）；IR 和文档缓存 build 同步为 ir-5，避免相同输入的旧 revision 内容冲突。
- [共享回放](../../lib/layout.js) 按当前页、块、被排除块、顶层 rawRef 取证，以 raw 批次范围恢复全局页号。没有范围时，要求完整连续的页绑定，或唯一整篇 raw；不扫描目录、不猜正文。
- [重建 CLI](../../scripts/quality/rebuild-layout.mjs) 和 refillV2 使用同一解析。重复/越界/缺页、当前来源冲突、引用丢失、hash 损坏均先拒绝，尚未进入 publishDerived 或文档写入。
- `source='vl'` 的补充来源暂明确拒绝安全回放；`source='service'` 的既有主模型按 `layout.model` 校验，包含以主模型运行的 PaddleOCR-VL-1.6。本轮不扩展 VL 算法，不将候选丢弃后发布。纯 PDF 模型维持原无操作语义。
- 不做真实库迁移或历史改写，不从历史目录自动修复已经损坏的 current；恢复证据不足需要人工选择正确历史版本，未在本轮实现。

## 回归及验证入口

新增 [test-layout-replay.mjs](../../scripts/test-layout-replay.mjs) 已纳入 npm test，默认每例十轮。通过真实 store/archive/runner 及重建 CLI 验证；只替换收费 OCR 和 runner 的 PDF 提取边界。CLI 成功路径实测无原 PDF 时的 lineAssignments 回退。

本轮先在未修复产品观察原探针指定正文断言 exit 1；新增回归第一轮记录红灯。初版新增回归 24 类 × 10 轮 = 240 PASS / 0 FAIL；覆盖三批/非首批、旧页无 rawRef、顶层/块级恢复、hash-only 兼容、相同 raw hash 跨批、空白、乱序、无关旧/坏 raw、重复/越界/缺页/坏行、全局范围错误、歧义、hash 损坏和丢失、补充来源拒绝、CLI dry-run/apply。最终自查补第 25 类：旧云端空白页丢失全部引用时明确拒绝，先观察 24 PASS / 1 FAIL，再加守卫；最终十轮结果随精确 head 交付。拒绝路径逐字节比较 current、兼容投影、doc、PDF、raw/input/revision；成功路径保留原历史。

已执行相关既有回归：页身份 8/0、IR 41/0、归档 7/0、模型 116/0、行守恒 7/0、表格 150/0、文库审计 13/0。文库审计首次沙箱 spawn EPERM 后，在获准环境重跑通过；环境失败不计产品失败或通过。

候选工作树的完整 npm test（含 posttest）exit 0，119.076 秒；新增回归 240/0、Python 质量 10/10、自检、中文 PDF 任务 5/0、批量版面 1/0 均实际执行。SKIP 为 Obsidian 配置、三项本机 PDF 样例、OpenAlex 在线检索（本轮接口失败）和真实 OCR（无 token）。stderr 保留有意损坏 JSON 的诊断及 fitz 弃用警告。首次完整回归因验证驱动把 TEMP 放在仓库内，安装器复制到自己的输出路径而超时，14/1；将证据与 TEMP 移出仓库后使用相同断言重跑通过，安装器 15/0、发布安全 24/0。未修改安装器或测试阈值。

精确候选 head 的原探针 20 轮、提交后回归、CI 回执和附件哈希由 QIAN-69 最终交付评论登记，不以本文的计划替代实际结果。

## 入口实测与未测

- 共享 runLayout/readLayout/refillText：实际集成回归。未改原探针另用真实 Python/PyMuPDF、合成扫描 PDF、假 OCR 验证。
- rebuild CLI：实际子进程 dry-run、--apply、歧义拒绝和历史保护。
- RPC `layout.refill`：已核对调用同一 runner，成功后才刷新派生文档；未做 RPC E2E。批量 `--refill-existing` 的实际入口覆盖见下方返修记录，旧候选的局部结果不代替它。
- 未测真实宿主 UI、OCR/VL、PG/MySQL、Vault、真实复杂论文、并发 refill/clear。候选提交、PR、独立复测、合入后复验和关单是不同阶段，本轮只交候选。

计划：[多批 raw 离线回放修复](../plans/2026-11-26-layout-raw-replay.md)。

## PR #10 R1/R2/S1 返修候选（2026-11-26）

独立复测/审查已将 f96a9953d506cfdb8448f67d07392bf4d578d322 判为 rejected / request changes，原六项 CI 不替代兼容性验收。负责人在原分支授权同一实现者返修，不合入关单；本节不覆盖前述历史运行记录。

- R1：共享回放由固定 PP 模型限制改为主模型一致性校验；补充角色与来源歧义仍拒绝。新模型的三批 runner 回归加入显式 VL 主模型。
- R2：批量初检只在显式 refill 且非 force 时接受 ir-4；最终产物和派生缓存仍严格要求 ir-5。已有有效版面的离线回填不再因扫描 PDF 缺 ocr.md 而先补跑收费 OCR。
- S1：v7 同步 ir-5、页级 rawRef、ir-4 兼容及主模型/补充角色边界；重建 CLI 注释同步。
- 新增冻结的真实 base runner/archive 产物，不是删当前字段模拟旧版；先断言原 build、主模型、raw 模型、范围、service 角色及原 PDF hash，再执行 runner、CLI dry-run/apply、批量 dry-run/实际升级和重复回填。网络在 transport 前拒绝并记录；空 token 下实际批量升级成功，manifest 云端 attempts=0，raw/input/revision/笔记/PDF 保持。
- 在未改产品前，新增主模型回归 25 PASS / 1 FAIL，旧版矩阵 3 PASS / 5 FAIL；修复后默认十轮分别为 260 PASS / 0 FAIL、80 PASS / 0 FAIL。保护项覆盖补充角色拒绝、主模型身份冲突、批量歧义发布前拒绝；未知 build、非 refill 和 force 不绕过 build 检查。
- 另以测试工程师 corrected-r1 的未经 base 回填原档与 original-ir4 原 revision 先复现两项差异，再验证 R1/R2 通过；真实合成扫描 PDF 的批量实际升级两次成功，无网络、无上传，旧证据逐项哈希保持。

以上为提交前实测；精确提交后的原探针 batch1/batch2 各十次、受影响回归、完整 npm/posttest、CI 回执及未测项以 QIAN-69 新候选交付评论和附件为准，不继承旧 head 结果。仍未测真实 provider/VL、宿主 UI/RPC、PG/MySQL、Vault、复杂论文、补充混合 VL、并发发布及长期性能。
