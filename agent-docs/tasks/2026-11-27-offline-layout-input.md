# 离线重填后补表格输入身份候选

日期：2026-11-27。任务：QIAN-98 / [GitHub #19](https://github.com/qianxi-00/dsh-paper-workbench/issues/19)。状态：in_progress（实现者验证通过，等待非实现者候选验收与 Close 门禁）。基线：dev@418ff419ebf8180044bee41423b47406e5d42313。

正常解析的归档 input 包含 pageCount/batchPages；refill 保留它们，refreshTables 原先只提供 source/model/jobId。相同派生结果命中同一 revision 时，归档正确拒绝被收缩的输入。修正只在 `lib/layout.js` 的 refreshTables 继承完整 input，再覆盖实际 source/model/jobId；读取错误向上传递，旧数据缺少 input 时维持原空输入兼容。API、schema、归档不可变校验与网络行为均未改变，没有数据迁移。

回归扩充既有 `scripts/test-layout-replay.mjs`，通过真实 runner、真实归档与磁盘读回，覆盖混合/独立重复操作、真实表格网格变化、旧 raw/input/revision 字节保留、model/raw/PDF 行/pageCount 的真实冲突拒绝、损坏 input 失败保护，以及缺 input 的兼容。仅替换外部 PDF/OCR 适配器，禁止网络，离线阶段 fake OCR 提交数保持不变；默认十轮已经由既有 npm test / CI 入口执行。

## 实现者验证

环境：Windows、Node v24.20.0、Python 3.13.15；先设置随机临时 DSH_PAPER_WORKBENCH_DATA、TEMP/TMP、PYTHONUTF8=1、PB_FORCE_SYNTH_SAMPLE=1、空 PADDLE_OCR_TOKEN，再启动每个测试进程。未使用真实论文库或付费 OCR。

| 命令 | 结果 |
| --- | --- |
| #19 原样正文 mixed / tables-control 探针，修正前 | mixed exit1，输入冲突；独立补表格 exit0，完整 input 差分对照成功 |
| `PB_REPLAY_ROUNDS=1 node scripts/test-layout-replay.mjs`，修正前 | 沙箱内 24/3（含两项子进程 EPERM）；获准同配置重跑 26/1，仅新增 mixed 用例失败 |
| `node scripts/test-layout-replay.mjs`，修正后默认十轮 | 310 PASS / 0 FAIL，exit0 |
| #19 原样 mixed / tables-control 各十次 | 20 个独立 Node 进程均 exit0；每夹具初次 fake submit=1，离线不重传 |
| archive / model / table / conservation / page-identity | 分别 7/0、116/0、150/0、7/0、32/0，均 exit0 |
| IR / library-audit | 均 exit0；Node test runner 的 fail=0 |
| legacy-replay 默认十轮及完整形状矩阵 | 164 PASS / 0 FAIL，exit0，零 OCR/网络 |
| `node scripts/test-layout.mjs` | exit0，0 PASS / 0 FAIL，3 项本机 PDF 样本检查 SKIP |
| 完整 `npm test`（含 posttest） | exit0；Obsidian Vault 未配置、三项本机 PDF 样本检查和真实 OCR 联调 SKIP；arXiv 在线部分 11/0/0 |
| 两个修改 JS/MJS 的 `node --check`、`git diff --check` | exit0 |

原探针、命令记录器、逐次日志、退出码、源码 SHA-256 与候选精确 head 由 QIAN-98 交付评论及附件提供；临时数据与原始日志不进入 Git。以上均为实现者证据，不能替代独立验收。

下一步：由 Close 组织非实现者验证候选精确 head，读回 CI，再按授权正常合入并做包含 #18 修复的 dev 组合验证及显式关单。该候选没有混入 #15/#16 的实现或修改其 PR，未合入或关单。真实宿主 UI/RPC、真实 OCR/VL、生产 p95、并发离线操作及真实复杂论文质量未测。

计划：[离线补表格输入身份修复](../plans/2026-11-27-offline-layout-input.md)。
