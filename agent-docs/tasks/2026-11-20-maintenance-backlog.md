# 维护任务与已知边界

记录日期：2026-11-20。任务来源为用户本轮协作资料请求及项目调研；未请求的代码修复和外部市场操作只记录后续入口，不在本轮自动执行。执行规则见 [任务说明](README.md)，稳定状态见 [项目快照](../memory/project-state.md)。

## DOCS-001 · 分类协作资料与发布研究

- 状态：done。
- 目标：建立可 Git 同步的协作目录，补充根指南，记录远端目录、市场及 CI/CD 的真实证据。
- 范围：根 [AGENTS.md](../../AGENTS.md) 和 [agent-docs](../README.md)；关联 [计划](../plans/2026-11-20-agent-docs-and-release-audit.md)。
- 已完成：分类目录和十份配套文档、根指南接入、市场/发行物/工作流调研及交叉复核；首次文档提交 [4c86511d6b3f3cdd11bb048934a7326ab2f60634](https://github.com/qianxi-00/dsh-paper-workbench/commit/4c86511d6b3f3cdd11bb048934a7326ab2f60634) 已合入并推送 dev，GitHub 递归树核实根指南及全部十份资料，变更范围只有 Markdown。
- 本地验证：11 份文档、249 个本地链接、108 个唯一目标均有效；2 个 Bash 块和 1 个 PowerShell 块通过语法检查；Git 忽略检查无命中，`git diff --cached --check` 退出 0。`npm pack --dry-run --json` 退出 0，仍为 93 个包条目、0 个 agent-docs 条目；临时验证脚本未加入仓库。本轮未在本机重跑业务全套，既有回归证据单独保留。
- 远端验证：dev push 触发 [CI 44722475700](https://github.com/qianxi-00/dsh-paper-workbench/actions/runs/44722475700)，已完成且 6/6 矩阵成功，`gh run watch --exit-status` 退出 0；覆盖 Ubuntu/Windows/macOS × Node 20/22 的完整工作流。本条记录首次同步证据，随后收尾记录提交的 CI 按其 SHA 另查，不持续记录文档自己的新提交。
- 环境处理：首次 push 的本机 Git Forge 凭据辅助程序出现含空格路径解析错误；确认远端未变化、目标仍获允许后，通过已登录 GitHub CLI 的一次性凭据接口重试成功。没有修改宿主或全局凭据配置，没有保存凭据值。
- 后续：按下列独立任务按需继续；本次不发布版本、不修改市场 PR、不安装 profile。

## DIST-001 · 跟进社区目录 1.2.0 更新

- 状态：todo。
- 依据：[市场 PR #17123](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17123) 在核查时 OPEN；已合并的 [#16763](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16763) 对应 1.1.2。
- 下一步：重新查询 PR、目录 YAML 与公开索引；合并后分别检查 tarball 版本、索引版本及 npm 安装目标。只有出现实际不一致且用户请求处理时再修改上游。
- 验收：登记版本和实际安装来源一致；不要通过本仓库新 tag 反复触发既有版本发布来刷新市场。

## LAYOUT-001 · 验证多 raw 页身份

- 状态：todo；结论类型：静态推断，尚未复现。
- 范围：[IR](../../lib/layout-ir.js)、[refill](../../lib/layout.js)、[离线重建](../../scripts/quality/rebuild-layout.mjs)。
- 下一步：用临时库构造至少两批各自从 1 编号的 raw，并加入旧历史 raw；追踪全篇页号及 `rawRef` 如何进入 published IR、refill 和 rebuild。
- 验收：能够复现或排除错配；若需修复，验证多批、历史归档、旧版兼容与标注迁移，不调用真实付费云服务。

## LAYOUT-002 · 验证取消与缺页补充路径

- 状态：todo；结论类型：静态推断。
- 范围：[layout.js](../../lib/layout.js)、[ocr.js](../../lib/ocr.js)、[批处理](../../scripts/batch-layout.mjs)。
- 下一步：用注入的假 submit/poll/fetch 分别在各阶段取消；构造缺页响应确认普通 runner 的 VL 候选和页完整性门禁先后顺序。
- 验收：明确各入口实际取消范围和 VL 可达性；只有证据支持时才更新“全链路”说明。

## DOCS-002 · 修订历史版面契约漂移

- 状态：todo。
- 范围：[v4](../../docs/v4-layout.md)、[v7](../../docs/v7-quality.md)。
- 下一步：按当前源码核对渲染坐标、published layout 权威指针、多 raw/refill、needs_review/failed；关联 LAYOUT-001/002 的验证结果再写保证条件。
- 验收：契约说明与实现及测试一致，保留历史验收日期，不把既有问题改写为已修复。

## VALIDATE-001 · 环境相关验收

- 状态：todo；按后续任务需要选择执行。
- 范围：当前 DSH 原生 Factory、真实上传和图片附件、真实 PG/MySQL、复杂论文质量与人工 gold。
- 下一步：在用户提供或已经授权的对应环境中制定验证；先读 [验证边界](../memory/project-state.md) 和 [质量说明](../../docs/quality/README.md)。
- 验收：逐环境给实际证据及跳过项；真实文库、云端任务、数据库迁移或本机插件部署不能因为本文件有待办就自动获得执行授权。
