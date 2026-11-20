# 项目状态与证据快照

核查日期：2026-11-20（Asia/Shanghai）。这里记录本轮调研基线、已验证结果和接续事项，不是远端状态的实时镜像。新任务先读根 [AGENTS.md](../../AGENTS.md)，再按 [资料维护规则](../README.md) 更新有变化的结论。

## 本地与远端

项目为公开仓库 [qianxi-00/dsh-paper-workbench](https://github.com/qianxi-00/dsh-paper-workbench)，默认分支 `main`。本轮开始时，GitHub 远端只有四个核心分支；本地另有未合并的 Agent 工作分支。不要因为远端分支较少就删除本地未合并工作。

| 远端分支 | 调研开始时的完整提交 | 用途 |
| --- | --- | --- |
| dev | `7a9d9e6a85559c941eceb7ee8cacb2a06ae812ae` | 日常开发集成 |
| test | `a057a55cea5fa91138d721823a13be4574b61fb8` | 由 dev 晋级的集成测试 |
| prod | `5365e51227cff98f7b4d95629d475919e0a50b1a` | v1.2.0 稳定发布点 |
| main | `b5aee8b8886c460f734edfc25dbb450c17a17992` | 默认展示分支，由 prod 同步 |

表中是文档同步前的基线。后续提交会改变分支头，实时位置用 `git ls-remote --heads origin` 或 GitHub API 复核；不要为了记录本文件自己的提交而反复修改快照。

- 本地 `agent/fix-retrieval-rate-limit@223e329` 比该 dev 基线多出检索限流修复，涉及 [arxiv.js](../../lib/arxiv.js) 和 [分页测试](../../scripts/test-search-pagination.mjs)，当时未推送。串行礼貌队列和新的退避策略属于该分支，不能声称它们已进入远端稳定版。
- 本次文档工作从 dev 建立 `agent/agent-memory-guide`，携带上一轮重写的根指南，避免把上述业务修复一并推送。该临时分支的最终合并与清理由本轮任务记录和 Git 状态核对。
- 开始核查时，本地与远端根目录均为 `.github / assets / docs / lib / scripts / skills` 等项目内容，远端没有 `agent-docs/`。新增目录负责源码开发协作；[论文工作区模板](../../assets/workspace-skills/) 仍属于插件部署材料。
- 包版本为 1.2.0。各核心分支、v1.2.0 与本地检索分支的工作流、包清单和安装入口在本轮核查时一致。远端目录、市场及运行链接集中在 [发布运维](../operations/release-and-distribution.md)。

## 已有验证与适用范围

2026-11-20，曾在本地 `223e329` 基线上以临时 `DSH_PAPER_WORKBENCH_DATA`、`PB_FORCE_SYNTH_SAMPLE=1`、`PYTHONUTF8=1` 和空 `PADDLE_OCR_TOKEN` 执行 `npm test`，包含 posttest，退出码 0。Python PDF 质量 10 个用例和协处理器自检通过；真实 arXiv/OpenAlex 检索及临时 PDF 下载成功。

该结果是历史业务回归证据，不是本次文档分支重新运行的结果。真实 OCR、真实 Obsidian Vault、部分本机论文样本有跳过；本机 DSH 原生 UI、真实 PG/MySQL 服务及复杂论文全库质量未验收。原生桥与数据库协议测试使用夹具或模拟服务，不能替代真实环境验证。

远端各核心分支的既有 CI 和 v1.2.0 Release 运行均核查为成功，详细运行 URL 见 [CI/CD 证据](../operations/release-and-distribution.md)。后续文档提交触发的新 CI 需单独查看，不能沿用这些成功记录。

## 当前已知边界

以下为源码调研得出的待核实事项，未在本轮修复；对应可执行任务见 [维护 backlog](../tasks/2026-11-20-maintenance-backlog.md)。

- **多 raw 页身份：静态风险。** [IR 构造器](../../lib/layout-ir.js) 的页对象未持久化 `rawRef`，而 [离线重建](../../scripts/quality/rebuild-layout.mjs) 和 [refill](../../lib/layout.js) 优先读取 `pages[].rawRef`；缺失时扫描 raw 目录并按批内局部页号 first-wins，可能跨批错配或混入旧 raw。尚未构造复现，不能定性为已发生故障，也不能承诺多批回放可靠。
- **取消与 VL 补页：待专项验证。** [OCR 客户端](../../lib/ocr.js) 支持 signal，普通版面 runner 未给所有 submit/poll/fetch 透传，批量 CLI 另有注入。正常 runner 又先要求服务页齐备，缺页 VL 路径的可达性尚未证明。
- **文档漂移。** [v4](../../docs/v4-layout.md) 的坐标描述及 [v7](../../docs/v7-quality.md) 的兼容读取、单 raw 和 refill 部分描述已滞后。以当前发布模型及源码为准，修订时保留历史语境。
- **质量证据边界。** 已有真实语料采集记录，但 [人工 gold](../../docs/quality/README.md) 未完成；行守恒、合成样本和算法 fixture 不能推导真实论文字符召回或表格质量达标。
- **市场版本滞后。** npm/GitHub 1.2.0 已发布，Awesome DSH Plugin 与三个 DSH Format 1 索引核查时仍为 1.1.2；1.2.0 更新 PR 未合并。不要把包发布成功写成所有市场已更新。

修复或重新验收后，用新的提交、命令或运行链接更新条目及任务状态；过期结论可以移入带日期的交接记录，当前入口只保留仍需关注的内容。
