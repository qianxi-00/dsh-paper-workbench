# 多批 raw 离线回放修复计划

状态：active。日期：2026-11-26。范围：QIAN-69 / GitHub #7，负责人评论 01a215b0-a301-7e39-bcc3-f84647ef2133 放行的单次修复候选。

**Goal:** 多批版面离线回填和重建保持页来源、正文及不可变历史；无法唯一回放时发布前拒绝。

**Architecture:** 保留现有 schemaVersion 2 和 archive 发布机制。IR 保存传入页的 rawRef；layout.js 导出一个与 refill 共用的离线来源回放函数，重建 CLI 复用它。旧版取当前 revision 的 rawRef 批次范围及完整页绑定，不扫描 raw 目录，不修改旧 revision。

**Tech Stack:** Node 内置模块、现有零依赖脚本测试、Python/PyMuPDF 原探针。

## 已确认事实和方案取舍

- 基线 310fe96d6579a47e4b63c150ac37e658a0c4420d。原探针多批实际 exit 1。
- `runLayout` 已在 rawRef.page 保存批次起止；IR 丢弃页级引用，块级和顶层证据尚在。
- 只保存新字段无法兼容旧版；扫描目录或按局部页号 first-wins 无法保证身份；选共享、严格解析当前引用。
- 页面范围是 1-based 全局闭区间；raw 内页号须为完整、不重复的 1..批长，映射为 start+n-1。乱序允许。
- 无范围旧引用只有在当前版本提供完整、连续、唯一页绑定时才能恢复；来源冲突或缺失报错。不按正文相似度猜测。
- 不扩大到修复已损坏 current、VL 算法、并发发布、UI、broker 或真实库迁移。无法安全重放的来源明确拒绝。

## 文件和步骤

1. `scripts/test-layout-replay.mjs`：通过真实 runLayout/readLayout/refillText/archive 及 CLI 子进程验证多批 round trip、三批、旧页无 rawRef、空白、乱序和失败保护。只替换收费 OCR/PDF 提取边界；预期文字手写。先运行留红灯。
2. `lib/layout-ir.js`：在页对象保存 rawRef 的独立副本，包含空白页。
3. `lib/layout.js`：共享 `replayLayoutPages(layout, readRaw)` 校验页覆盖、当前引用、raw 完整性及唯一映射；refillV2 调用它，发布前完整性不依赖 PDF 空页壳。
4. `scripts/quality/rebuild-layout.mjs`：删除重复目录扫描，改用共享函数，失败不发布和不重写 doc。
5. `package.json`：将新回归纳入 npm test，并在脚本默认执行十轮，CI 自动得到十轮覆盖。
6. 验证：`node scripts/test-layout-replay.mjs`；IR/identity/archive/model/conservation/table/library-audit；完整 `npm test`（含 posttest）；未改原探针 batch 1/2 各十次。日志与退出码放证据目录，不提交临时数据。
7. 自查 diff 与调用方，提交候选，push 并创建 base=dev 的唯一 PR。读回 base/head 和 CI 实际状态；不合入/关单，交负责人安排非实现者。

## 恢复与验收

- 数据不做迁移或原地回填；成功只发布新 revision。候选撤销可还原代码，历史文件保持不变。
- 失败用例逐字节比较 current、layout.json、doc.json、raw/input/revision/PDF；成功验证历史不变和重复回填。
- 真实 UI、真实 OCR/VL、PG/MySQL、Vault、真实复杂论文以及并发 refill/clear 未测，不能把合成结果当成这些范围通过。
- dev 的已知 macOS/Node 22 CI 失败保留；候选 head CI 单独读回，无轮询等待。

## PR #10 R1/R2/S1 返修（2026-11-26）

固定退回点 f96a9953d506cfdb8448f67d07392bf4d578d322；沿用原分支和 PR，负责人评论 01a215e8-aab6-77ee-8170-570598ab3788 已授权。

- [x] 恢复工具并确认 clean 工作树、PR head/base；校验独立证据包。
- [x] 用独立测试的未经 base 回填档案先断言 ir-4、主模型、raw 范围及 service 角色，再复现 R1 拒绝和 R2 云端误分流；环境 EPERM 单列。
- [x] `scripts/test-layout-replay.mjs` 扩展主模型 runner 回归；`scripts/test-layout-legacy-replay.mjs` 用冻结真实旧档案测 runner/CLI/批量，纳入 npm test。未改产品时观察预期红灯。
- [x] `lib/layout.js` 将模型校验绑定到 layout.model，保留 service 角色、hash、范围及完整唯一映射检查。
- [x] `scripts/batch-layout.mjs` 仅显式离线回填接纳 ir-4，避免该分支先补跑收费 OCR；最终 published/derived 仍严格要求 ir-5。实际批量升级、零网络/零上传、未知 build 不放行及歧义保护回归默认十轮 80/0。
- [x] 同步 `docs/v7-quality.md` 当前 build、rawRef 及历史兼容；未修改原探针、CI 判定或云端轮询。

提交交付检查：在新精确 head 重跑原探针两种 batch 各十次、新旧回归和完整 npm/posttest；更新同一 PR 并读取 CI 当前状态，交回补验，不合入关单。精确 head、实际命令和结果记 QIAN-69 最终交付评论，不在文档中自引用本次提交 SHA。

## PR #10 R3/S2/S3 返修（2026-11-26）

固定退回点 46bff672fa6cfa201e0906cf38e3fecbba48df75；负责人评论 01a2161c-2f12-7308-b350-54782fa53efa 授权原分支续修。R1/R2 的正常路径独立通过仅属旧版本记录，整体验收仍为 request changes。

- [x] 审阅者未改反例实际复现：raw 缺失/hash 损坏被预检吞成 null；dry-run 报云端，实际各两次 provider POST 在传输前拦截。
- [x] 先补 ir-4/ir-5 × ENOENT/hash/EISDIR × dry-run/实际显式回填，未修产品观察六项失败和十二次 fetch 尝试。
- [x] 最小修改 published 的异常传播：仅显式非 force 回填拒绝来源读取错误；不放宽来源、build、范围、完整性校验；保留普通/force 分流。
- [x] 仅脱敏冻结档案的两处 source.path，保留原 producer/revision/raw/PDF；用固定 LF 的最终文件字节更新 SHA-256 与清单，回归验证摘要和相对路径。
- [x] 合成库假 token + 传输前拦截，验证零 provider/上传及全论文/PDF 哈希保护；审阅者独立 seed 单独复核；有效旧版、主模型、普通/force 与歧义保护继续通过。
- [ ] 新精确 head 的受影响回归、完整 npm/posttest、未改原探针两种 batch 各十次、CI 当前状态及新证据包交负责人补验补审；不合入关单。
