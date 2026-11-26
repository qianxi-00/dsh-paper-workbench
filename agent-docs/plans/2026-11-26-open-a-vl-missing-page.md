# Open A：已知身份缺页的 VL 补充修复

状态：completed（本地修复与验证）。日期：2026-11-26。远端交付与独立验收以 QIAN-83 指定线程及本分支 PR 为准。

## 范围与基线

- GitHub #11；QIAN-83 lane key：`QIAN83-01a21733-9d22-786c-b0b5-ca303571577c:Open-A`。
- 从 `dev@76fb76d67cc48b02ca02f5013874f6501bc8f50d` 开始，使用本任务独立 checkout。
- 仅修复 `runLayout` 已配置的缺页补充路径；不改公开接口、取消流程、raw 离线回放或发布质量门槛。
- 不合并、关单、处理 #12、调整定时或访问真实文库/付费 OCR。

## 已确认事实与方案

- 现有 `scripts/test-page-identity.mjs` 8/8、`scripts/test-layout-model.mjs` 116/116 通过。
- `runLayout` 的批次完整性检查与补充循环前的 `donePages` 检查都会阻止缺页进入 VL 补充循环。
- 测试边界沿用 #11 指定的 `createLayout(...).runLayout(...)`，保持真实解析、IR、归档与发布读回，仅注入合成 PDF/OCR 适配器。
- 采用原有补充循环：只接纳无坏项、唯一且范围合法、全部显式声明页索引的短批次；补充关闭或主模型不是 PP-StructureV3 时仍拒绝。
- 补充目标由已验证页号的差集确定，受 `maxCloudPages` 限制；单页 VL 结果必须只有局部第 1 页、无坏项且有有效内容。覆盖不全或补充失败时拒绝发布。
- 保留 VL 的独立来源角色、raw 证据与现有质量校验；从主模型与补充页的并集读取 PDF 行。

备选是在每个批次内补充，需重复组织目标/预算/断点逻辑；不采用。直接放宽完整性或借 PDF 行填缺页会掩盖身份不明，不采用。

## 执行与验证

- [x] 在 `scripts/test-page-identity.mjs` 添加两页、显式 `page_index: 0`、`maxCloudPages: 1` 红测；断言只上传缺页及发布后正文/来源。
- [x] 运行 `node scripts/test-page-identity.mjs`，记录原始缺页错误及退出码。
- [x] 在 `lib/layout.js` 最小修改入口条件、补充结果校验与覆盖检查。
- [x] 添加未知/重复/越界身份、预算/关闭、坏/空/多页补充、发布保留回归；复核分批偏移和主模型隔离。
- [x] 运行页身份、版面模型、raw 回放等聚焦检查，再运行 `npm test`（含 posttest）；记录失败及跳过项。
- [x] 审查 diff、两份改动代码的 `node --check`、`git diff --check` 及 Git 状态。

每次测试先设置临时 `DSH_PAPER_WORKBENCH_DATA`、`PYTHONUTF8=1`、`PB_FORCE_SYNTH_SAMPLE=1`、空 `PADDLE_OCR_TOKEN`。本次自动化不代表真实云端、宿主 UI 或复杂论文质量验收。

## 本地证据与未测边界

- 红测：`node scripts/test-page-identity.mjs` 为 `8 PASS / 1 FAIL`、exit 1；错误为“第 1-2 页的版面结果不完整或页号不合法（返回 1/2 页，异常 0 项），未发布新结果”。
- 绿测：相同入口扩展为 `32 PASS / 0 FAIL`、exit 0；两页用例只提交主模型 1–2 页和 VL 2–2 页，发布后两页正文及来源正确。
- `node scripts/test-layout-model.mjs`：`116 PASS / 0 FAIL`。最终全套中 raw 回放 `260 PASS / 0 FAIL`、旧版回放 `164 PASS / 0 FAIL`；这些是脚本检查/重复运行输出，不相加成独立测试数。
- 最终 `npm test`（含 posttest）exit 0；Python PDF 质量 10 项通过，自检 `ok:true`；中文 PDF 任务 5 项及批量版面 1 项通过。
- 本地 Node v24.20.0、Python 3.13.15。Node 20/22 和三系统由新 PR 的 CI 验证，不继承旧 CI 结论。
- 最终全套使用仅本次命令加载的外网 preloader；没有修改产品网络实现、全局配置或测试断言。拦截外部 HTTP/HTTPS/CONNECT/fetch 的预检通过，本地代理测试 5/5 通过。拦截器与原始日志交 QIAN-83 附件，不进入产品包。
- 明确跳过：在线检索/元数据/下载 6 项、未配置真实 Vault 1 项、未提供本机 PDF 样本 3 项、真实 OCR 1 项。没有据此声称真实服务或论文质量已验收。
- 首次 raw 回放因沙箱 `spawnSync ... EPERM` 为 `240 PASS / 20 FAIL`；获准在沙箱外同样夹具重跑为 `260 PASS / 0 FAIL`。没有更换凭据或修改权限。
- 首次全套漏查在线 arXiv 用例，停止前曾临时下载 1 份 1,544,590 字节 PDF，已由用例清理并确认不存在；没有写入真实文库或调用付费 OCR/VL。该次运行中断、exit 1，不计为纯夹具通过；最终验证以带外网拦截的重跑为准。

## 远端交付要求

推送本任务分支，以 `dev` 为 base 创建引用 #11 和 lane key 的 PR；在 QIAN-83 指定线程交付 PR、精确 head、红绿证据及 CI 读回。候选仍需非实现者按精确 head 复测，再由 Close 流程合并、合后验证和关闭 #11；QIAN-83 整轮由部署工程师继续收口。
