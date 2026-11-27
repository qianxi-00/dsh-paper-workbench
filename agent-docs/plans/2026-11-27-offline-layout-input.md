# 离线补表格输入身份修复计划

状态：completed（实现者候选交付，独立验收仍待 Close 组织）。日期：2026-11-27。范围：QIAN-98 / GitHub #19，基线 dev@418ff419。

目标：正常解析、重填和补表格能连续重复执行；语义相同复用 revision，真实表格变化产生新 revision，历史证据和冲突拒绝保持。

架构：修正 `createLayout().refreshTables` 的归档调用参数，继承当前 revision 的完整 input。复用 `readInput` / `publishDerived`，不修改 `lib/layout-archive.js`，不混入 #16 的中断恢复修复。Node 内置模块，零依赖与零迁移。

已确认：#19 正文 mixed 探针在本基线 exit1，tables-control exit0；重复 refill 和完整 input 对照通过。RPC 调用方位于 `lib/index.js`，离线重建 CLI 和 refillV2 已保留 input。当前错误发生于完整 revision 的输入语义校验。

允许修改：`lib/layout.js`、现有 `scripts/test-layout-replay.mjs` 和本计划。测试边界是正文授权的真实 runner / archive 集成层；仅合成 PDF/OCR，无真实论文库、网络或付费调用。

1. 在 `scripts/test-layout-replay.mjs` 的既有十轮夹具中加入正常重填→补表格→重复混合操作，检查 input 的 pageCount/batchPages、相同 revision 和旧证据字节。先运行 `PB_REPLAY_ROUNDS=1 node scripts/test-layout-replay.mjs`，应出现不可变输入冲突。
2. 在 `lib/layout.js` 的 unified 分支使用 `const input = layout.revision ? await archive.readInput(id, layout.revision) : null`，发布参数改为 `{ ...(input || {}), source: layout.source, model: layout.model, jobId: layout.jobId }`。损坏 input 不吞错；无归档 input 的旧数据维持已有空输入兼容。
3. 同一真实 runner 夹具覆盖表格网格变化、重复结果幂等、旧 raw/input/revision 不变，以及 model/raw/PDF 行真实输入冲突、坏 input 失败保留 current。网络和 OCR 次数必须不增加。
4. 原样 mixed / tables-control 探针各十次；现有 runner 十轮（CI 的 npm test 已包含）、archive/model/IR/table/conservation/identity/legacy replay；完整 `npm test`（含 posttest）。记录每个退出码和跳过原因；失败必须先诊断。
5. 自查 diff、语法与数据隔离；提交独立 dev PR，回传精确 head、日志和后续独立验收入口。不合入、不关单。最终包含 #18 的组合由 Close 协调验证。

恢复：回退本次 layout.js 调用参数改动；不原地修改或清理已有归档。任何失败都保留旧 current 与历史。精确 head 的实现者自测不代替非实现者独立验收；CI 和合后验证另由 Close 门禁记录。

执行证据与待验边界：[候选任务记录](../tasks/2026-11-27-offline-layout-input.md)。精确 head、PR 与原始日志附件在 QIAN-98 的本次交付评论统一读回。
