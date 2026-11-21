# 四源分发检查与收录实施计划

状态：active（本地实施与验证交付，上游权限/政策及版本同步待接续）。日期：2026-11-20。任务：QIAN-25。基线：dev `e7c4616024d2553c9aad734172f16d80e55c741b`；目标正式版：1.2.0（已复核 GitHub latest 与 npm latest）。实际结果见 [任务记录](../tasks/2026-11-20-distribution-indexes.md)。

**目标：** 可重复确认四份公开 Format 1 索引的身份、版本和安装来源，并交付受上游规则约束的必要提案。

**方案：** 使用独立 Node 内置模块脚本，不导入插件运行时、不增加 npm 依赖。索引的实时观测与人工登记的审核/政策依赖分别输出；HTTP 或解析失败不能生成未收录结论。Scout 复用既有最终导出的兼容范围规则，贯通抓取、前筛及 npm 候选；不改变宿主 peer 判定、不扩大无范围收录政策。

**执行方式：** 按 issue 已授权的实施包在本轮顺序执行；验证后提交本仓库 PR 到 dev，必要的 Scout PR 到其 main。无新 npm/tag 发布、无上游合并、无 profile 或真实论文库变更。

## 1. 本仓库检查入口

文件：`scripts/check-distribution.mjs`、`scripts/test-distribution.mjs`、`package.json`。

- [x] 先以 `node:test` 验证检查边界：精确身份、旧版本、缺项、源错误、解析/网络失败、部分失败及输出摘要。
- [x] `node scripts/test-distribution.mjs` 观察失败，再实现最小入口并重跑。
- [x] 使用 `fetch` 的超时、响应体上限及固定 HTTPS 端点；外部索引只作为 JSON 数据，不执行内容，不转发任何身份凭据。
- [x] JSON 报告保存检查时间、HTTP/解析状态、响应字节 SHA-256、各身份匹配数、版本/source/engines 和标签；缺少 engines 保持缺失。
- [x] CLI 返回 0 表示四源均为目标 npm 条目，1 表示观测成功但存在收录/版本/来源缺口，2 表示获取或解析不完整。命令仅 GET，不提交申请、不发包。
- [x] 将离线测试接入已有 `npm test`，实网检查单独通过 `npm run distribution:check` 执行，避免 CI 依赖外部目录可用性。

## 2. Scout 上游提案

基线：`fegnze/dsh-plugin-scout@956d0e944734649feda0bc299adeed68d913e8c2`；既有讨论：[#1](https://github.com/fegnze/dsh-plugin-scout/issues/1)。

- [x] 完整读取 `crawl.mjs`、`verify.mjs`、`store.mjs`、`market.mjs` 与生成器的调用链。
- [x] engines-only 夹具必须经过真实 `normalizeNode` 与 `generateMarket`，让基线失败后修复；覆盖不兼容、无范围、workspace 范围及 engines 优先级。
- [x] 保留 engines 字段；将最终导出的范围判定复用于两个生成候选阶段；保留无范围排除，不从 target 合成兼容范围。
- [x] 在上游锁文件下禁用安装脚本安装开发依赖，执行上游 `npm test`（含 build）和官方 `parseMarketIndex` fixture。
- [ ] 提交最小 PR 并在 #1 补实质证据：已推送 `58d92d2`，当前 token 的 createPullRequest/addComment 均被拒绝；完整正文与比较页已交付，待有权限身份接续。

## 3. Bruce、Awesome、开放市场

- [x] 复核 Bruce `approved`、`packages`、star、90 天活跃门槛及生成 audit，运行现有校验。未达 5 stars 时只准备准确安装资料与映射形式，不提交不合规映射 PR。
- [x] 分别读取 Awesome #17123、源 YAML、`plugins.json`、主站 Format 1 与 dshmarket 镜像；请求失败单列，不能以 CI 或合并代替线上结果。
- [x] 开放市场保留现有 #552 登记与 1.2.0 精确审核；新版本不能继承旧版本审核标签。

## 4. 资料与交付

文件：`README.md`、根 `AGENTS.md`（仅入口）、`agent-docs/operations/release-and-distribution.md`、`agent-docs/memory/project-state.md`、`agent-docs/tasks/2026-11-20-maintenance-backlog.md`、本任务记录与小型 JSON 证据。

- [x] 用带时间与摘要的四源状态表、固定上游 SHA、提案链接及恢复条件替换过期渠道事实。
- [x] 使用临时 `DSH_PAPER_WORKBENCH_DATA`、空 `PADDLE_OCR_TOKEN`、`PB_FORCE_SYNTH_SAMPLE=1`、`PYTHONUTF8=1` 运行 `npm test`；逐项记录失败和 SKIP。
- [x] `npm pack --dry-run --json` 核对未把协作资料、索引或检查脚本带入发行包；`git diff --check` 与本地 Markdown 链接检查。
- [ ] 推送任务分支并创建到 dev 的 PR，不合并。CI 由已完成的 push/PR 触发，交付时报告状态，不等待外部队列。
- [ ] 在 Multica issue 评论交付 PR/commit、命令退出码、四源证据及外部恢复条件；metadata 保存 PR 与 waiting_on，维持真实待验状态。

恢复路径：本轮只修改源码与公开提案；本仓库合并前可关闭 PR，合并后可 revert 对应提交。未改变任何运行环境或已发布产物。
