# 仓库、市场与发布运维

核查日期：2026-11-20（Asia/Shanghai）。本页结合本地源码、GitHub API、公开市场索引和发行包实物；市场与分支状态会变化，后续操作先复核。它记录维护流程，不授权自动发版、修改上游目录或安装用户 profile。

## 仓库与目录

公开仓库为 [qianxi-00/dsh-paper-workbench](https://github.com/qianxi-00/dsh-paper-workbench)，默认 `main`。本轮开始时远端仅有 `dev / test / prod / main`；各 SHA 见 [项目状态](../memory/project-state.md)。远端树以 [main@b5aee8b](https://github.com/qianxi-00/dsh-paper-workbench/tree/b5aee8b8886c460f734edfc25dbb450c17a17992) 为核查基线。

| 目录或文件 | 本地与远端职责 |
| --- | --- |
| [lib](../../lib/) | 宿主入口、客户端模块、业务服务与数据层 |
| [assets](../../assets/) | 原生阅读器、Python PDF 协处理器、部署给论文 Agent 的工作区模板 |
| [scripts](../../scripts/) | 开发、测试、安装、自检、审计、批处理与质量工具 |
| [docs](../../docs/) | 使用指南、版本契约、质量材料及历史计划 |
| [skills](../../skills/) | 仓库和发行包附带的安装技能；不代表另有技能市场上架记录 |
| [.github/workflows](../../.github/workflows/) | CI 与 Release 两条自动化工作流 |
| [package.json](../../package.json) / [cordis.patch.yml](../../cordis.patch.yml) | 包入口、发布白名单、DSH bundle 与客户端元数据 |
| [agent-docs](../README.md) | 本轮新增的开发协作资料；随 Git 同步，调研基线的远端尚无此目录 |

本轮逐文件核对：远端四个核心分支、`v1.2.0` 与初始本地 `223e329` 的两份 workflow、包清单、bundle patch、三个安装器及两份安装/发布测试的 Git blob 一致。初始本地检索修复没有进入远端，不能仅凭工作目录里的行为推断已发布包的行为。

Git 同步以跟踪文件和目标分支为准，不追踪空目录。[npm 白名单](../../package.json) 是另一层边界：当前不含本协作目录、工作流和测试脚本。源码 link/copy 或下载仓库源码仍可能带入协作资料，因此所有资料都必须可公开，不依赖 npm 白名单来隐藏隐私。

## 实际发布与市场收录

| 渠道 | 核查到的状态 | 更新方式与证据 |
| --- | --- | --- |
| GitHub Releases | 正式 `v1.2.0` 已发布 | 本仓库 Release workflow 生成 tarball 与 checksum；[正式版本](https://github.com/qianxi-00/dsh-paper-workbench/releases/tag/v1.2.0) |
| npm | `latest = 1.2.0`，核查时无 `next` | 同一 Release workflow 在配置发布凭据时推送；[registry](https://registry.npmjs.org/dsh-paper-workbench) |
| Awesome DSH Plugin | 作者首次投稿及 1.1.2 更新已合并；1.2.0 更新仍待合并 | [收录 PR #16657](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16657)、[更新 #16763](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16763)；[1.2.0 更新 #17123](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17123) 在 QIAN-25 核查时 OPEN，真实四源版本见下文 |
| dshmarket | 展示同一社区目录数据，不是本仓库另一条发布 job | [数据源说明](https://github.com/dsh-market/dsh-market/blob/b21cf7f1c3e2da777d8e4ecf9460589ed3e1a2e9/README.zh.md#L156)、[实际目录接口](https://awesome-dsh-plugin.com/plugins.json) |
| DSH「发现」可用索引 | 早期快照中的三个社区端点均为 1.1.2/npm；不代表全部索引源 | [jsDelivr](https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json)、[社区目录站](https://awesome-dsh-plugin.com/index.json)、[市场站](https://dshmarket.com/index.json)；QIAN-25 指定四源的最新实测统一见下文，未操作本机 profile |
| DSH Get | 有精确条目，标记 11 月 18 日收录、11 月 19 日同步，上游为 Awesome DSH Plugin | [公开条目](https://dshget.com/plugins/qianxi-00/dsh-paper-workbench)；未找到作者逐站投稿证据 |
| DSH Hub | 有精确条目，快照 1.0.0，兼容性待验证 | [公开条目](https://dshhub.org/zh-CN/plugins/qianxi-00/dsh-paper-workbench/)、[自动采集流程](https://github.com/coderPerseus/dsh-hub/blob/61c6e5c70df02efff181808e0f76d93c1a76cf13/docs/catalog-pipeline.md#L28-L50)；不能当作 1.2.0 已同步 |
| FindHarness | 有精确条目，镜像 README 为 v1.1.2，安装入口指向 GitHub | [公开条目](https://findharness.com/plugins/qianxi-00-dsh-paper-workbench)；未给出快照提交，未证实作者单独投稿 |

已确认的作者市场投递记录在 Awesome DSH Plugin。其 [登记 YAML](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/1e6061a96f673c38ce014472c711f2398ded823f/data/plugins/qianxi-00__dsh-paper-workbench.yml) 在核查时仍指向 1.1.2 固定 tarball；[公开详情](https://awesome-dsh-plugin.com/p/qianxi-00/dsh-paper-workbench/) 和 [JSON](https://awesome-dsh-plugin.com/plugins.json) 也仍为该版本，JSON 另提供 npm 包名。1.2.0 PR 的 head 为 `55d3043976322b49f8463aa18c3d25ec98c3b77b`，目录核查提交为 `1e6061a96f673c38ce014472c711f2398ded823f`。

社区目录通过合并后的生成流程及定时/手动 [站点构建](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/1e6061a96f673c38ce014472c711f2398ded823f/.github/workflows/build-site.yml) 刷新。固定 tarball、索引展示版本和 npm `latest` 是分别维护的对象，更新其中一个不能证明其余已更新。

DSH 官方公开 [插件索引契约](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/docs/user/guide/plugin-market.zh.md#L21-L34) 将此能力描述为实验性组合包，索引源按 profile 配置，无内置索引源。本轮依据公开契约与实际索引响应，未操作本机「发现」界面，也不能据此声称存在已验收的官方独立市场上架流程。

安装技能存在于 [本仓库](../../skills/install-dsh-paper-workbench/SKILL.md) 和 npm 实物。[Skills.sh 精确搜索](https://www.skills.sh/api/search?q=install-dsh-paper-workbench) 未命中；SkillsMP 探测 403、LobeHub 探测 404，不能证实这两个目录的收录情况。[DPharness 搜索](https://dpharness.com/api/plugins?q=dsh-paper-workbench&take=100) 未找到本仓库的精确 owner/name。以上是本轮查询边界，不是对整个互联网的排除结论。

## 四源检查与后续版本维护

QIAN-25 在 2026-11-20T11:44:52Z 启动四源实测，目标版仍为 1.2.0。小型 [JSON 证据](../tasks/2026-11-20-distribution-evidence.json) 保存响应时间、HTTP/解析状态、字节数、完整 SHA-256 和精确匹配条目；不保存完整索引。执行与交付证据见 [任务记录](../tasks/2026-11-20-distribution-indexes.md)，额外发行物及上游证据见 [补充 JSON](../tasks/2026-11-20-distribution-upstream-evidence.json)。

| 指定源与既有记录 | 线上观测 | 当前准入或同步依赖 |
| --- | --- | --- |
| [Scout](https://fegnze.github.io/dsh-plugin-scout/index.json) · [#1](https://github.com/fegnze/dsh-plugin-scout/issues/1) | not-listed；466 项，包名和仓库均零匹配 | 既有申请 OPEN 无回复；生成链路提案已在作者 fork，创建上游 PR 被当前 token 拒绝。无范围 bundle 的纳入政策及默认 target 0.2.1-rc.2 兼容证据仍待维护者处理 |
| [开放市场](https://dshopen.org/index.json) · [#552](https://github.com/polang233/dsh-plugin-index/issues/552) | verified-live；1.2.0/npm，knowledge，包含 verified 标签 | 已审核并关闭原申请；不重复投稿。未声明 DSH 范围，不能由 verified 标签反推宿主版本兼容 |
| [Bruce](https://bruc3van.com/dsh-plugins/index.json) · [#174](https://github.com/bruc3van/awesome-dsh-plugin-pro/issues/174) | not-listed；2629 项，包名和仓库均零匹配 | approved 已通过、packages 映射缺失；当前 1 star 未满足新增映射 ≥5 stars，且需快照前 90 天有 push。普通目录核准不构成豁免 |
| [Awesome / dshmarket](https://dshmarket.com/index.json) · [#17123](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17123) | outdated；1.1.2/npm，docs | 现有 PR 的固定 tarball 已改 1.2.0，但 PR 未合并。源 YAML、plugins.json、主站 Format 1 和镜像仍需分别刷新 |

命令在源码检出中运行，Node ≥20，无需安装 npm 依赖：

```bash
npm run distribution:check
node scripts/check-distribution.mjs --target-version 1.2.0 --output distribution-report.json
node scripts/test-distribution.mjs
```

默认目标取当前源码 `package.json.version`；后续发版先核对 GitHub 正式 release 与 npm latest，再显式指定已发布目标。`--output` 写 UTF-8 且拒绝覆盖已有文件，每次选新文件名。默认只向 stdout 输出 JSON；命令不导入插件运行时、不安装、不发包、不投稿。离线夹具已接入 `npm test` 的 posttest，实网检查不进 CI 门禁。

退出码：0 表示所有所查源均找到唯一的精确包名/仓库与目标版 npm 来源；1 表示读取完整但有缺项、旧版本、身份/来源不符或歧义；2 表示网络、HTTP、JSON/结构或体积上限导致观测不完整。报告保留所有成功源，错误源匹配数为 null；HTTP 失败与 `not-listed` 分开。`outdated` 表示目标版不在条目版本列表中，应查看报告的实际版本，不据此猜测任意新旧版本的兼容性。

`versions[].engines` 只记录索引声明，缺失就保留缺失，不填 `*`。`verified-live` 只确认索引条目和预期 npm registry，不验证包下载、签名或真实宿主兼容。`followUp.status=waiting-review/policy` 是附有 basisDate 的既有申请背景，不由脚本读取当前 GitHub 审核决定；执行外部操作前仍需刷新原线程。请求仅 GET、拒绝重定向、60 秒超时、每源解压后 12 MiB 上限；使用 Node 原生 fetch，受限网络失败时按环境排查并保留错误结果。

### Scout：兼容声明与生成规则

在上游 `956d0e944734649feda0bc299adeed68d913e8c2`，`slimManifest` 未保留 engines，生成器的仓库和 npm 候选两次使用 peer-only 判定，最终 exporter 却已优先采用 `engines.dsh`。提案将既有最终规则复用于前筛，并保留 engines；夹具经过真实 normalizeNode、generateMarket 和官方 Format 1 parser，覆盖 engines-only、目标不兼容、无范围、workspace 不合成范围及 engines 优先级。

提案位于 [作者 fork 分支](https://github.com/qianxi-00/dsh-plugin-scout/tree/agent/qian-25-market-compatibility)，提交 `58d92d2`。当前凭据创建上游 PR 返回 `GraphQL: Resource not accessible by personal access token (createPullRequest)`，在 #1 添加证据也被 `addComment` 权限拒绝；PR 与评论均未创建。可从 [已准备的比较页](https://github.com/fegnze/dsh-plugin-scout/compare/main...qianxi-00:agent/qian-25-market-compatibility?expand=1) 接续，正文与证据见任务记录。本项目仍无 DSH 范围，提案合并也不会直接使本项目被收录。

本项目没有直接 DSH npm 导入，不能为索引虚构 peer、添加无用依赖或填写未经验证的 `*`。既有 rc.5 真机记录不能证明兼容 Scout 的 rc.2 target。恢复条件是维护者明确无范围 bundle 的可持续纳入策略，或在隔离宿主上验证真实范围并走项目发布审批；此任务不触发新版本。手改会被生成覆盖的 index.json 不能作为方案。

### Bruce：审核、映射、门槛与实际入选

上游 `686ad0210c0ec8963be99ab3c723506fbf87255c` 的 `data/approved.json` 有本仓库，`data/packages.json` 没有。新增映射统一受 `scripts/mapping-gate.mjs` 的 ≥5 stars 与 90 天 push 门槛约束；SHOWCASE 的 >10 stars 是另一条作者自荐路径。未满足门槛时保持原申请，不创建映射 PR。

门槛满足后先查看每日 `fill-catalog-mappings.yml` 是否已补映射，再按 CONTRIBUTING 修改现有 `data/packages.json` 的 entries；不创建 data/plugins YAML。准备的 web npm 目标为 `dsh-paper-workbench@1.2.0`，安装命令与前提见 [README](../../README.md#安装)。提交时按当时已发布目标复核包与仓库归属。校验入口为 `node scripts/validate-packages.mjs`、`node scripts/validate-curated.mjs --from-snapshot`、`node scripts/host-market/validate-index.mjs`；host-market 依赖按自身锁文件用 `npm ci --ignore-scripts --prefix scripts/host-market` 安装。

本轮三项校验通过，packages 有 7 项既有警告，curated 有 3 项归档警告。Windows 检出若自动转 CRLF，会导致 showcase 标题和索引哈希校验失败；使用提交中的原始 LF 字节后通过，未改上游内容。线上 [audit.json](https://bruc3van.com/markets/dsh/audit.json) 的 indexSha256 与真实索引一致：2784 个合格候选，容量选择 2629，155 个未入选；本项目无映射，尚未进入这层候选。映射后仍须核对 audit 与线上 index，不能把已审核或已映射写成上线。

### Awesome 与开放市场：后续版本流程

1. 验证目标正式发行物：包名、仓库、版本、GitHub/npm 实物摘要。此次两份 1.2.0 tgz 都为 939030 bytes，SHA-256 `3eab6f1a789e39a87e87ce9e80bf6f232218db7e907b4dbdd8ee84e69f275b98`。
2. 重跑四源检查，读取既有申请/PR 的意见，确定各自缺少的是审核、映射、固定包还是镜像刷新。重跑检查不执行任何投稿。
3. Awesome 复用 #17123，分别查 `mergedAt`、源 YAML、公开 `plugins.json` 的 tarball、主站 `/index.json`、dshmarket `/index.json`。此次 YAML 和 plugins.json 仍是固定 1.1.2，主站和镜像也为 1.1.2；现有 PR head 已改固定 1.2.0。nightly 的 npm latest 探测与固定 tarball 分别生效，构建缓存、定时计划或 CI 绿色都不能代替线上 JSON。
4. 开放市场保留 #552 与现有 `data/sources.json` 登记。未 pin 的源跟随 npm latest；`data/maintainer-reviews.json` 的审核按精确版本/完整性绑定，新版本即使自动出现，也不能继承 1.2.0 的审核结论。
5. 完成后分别记录每个端点的时间、hash、目标版本/source、剩余依赖。维护者未回复时交付可复现成果与恢复条件，避免无新证据反复评论。包发布、公开索引和本机安装仍需分别验收。

## CI：什么时候验证、验证什么

定义：[ci.yml](../../.github/workflows/ci.yml)；[远端固定版本](https://github.com/qianxi-00/dsh-paper-workbench/blob/b5aee8b8886c460f734edfc25dbb450c17a17992/.github/workflows/ci.yml)。

- 触发：四个核心分支的 push、以它们为目标的 pull request，以及 `workflow_dispatch`。只推临时 `agent/*` 分支不会自动触发这条 push CI。
- 矩阵：Ubuntu / Windows / macOS × Node 20 / 22，共六个 job。Python 3.12，并在 runner 内安装 PyMuPDF。
- 每个 job 先配置临时 `DSH_PAPER_WORKBENCH_DATA`，然后检查 JS 语法、执行 `npm test`（含 posttest）、安装器回归、JSON 降级引擎回归、doctor 及 `npm pack --dry-run`。
- `permissions: contents: read`；同 ref 的并发组中，PR 运行可取消旧运行。常规分支提交与 PR 不触发 Release。
- exit 0 和六个 job 成功仍需结合 SKIP 阅读；真实 OCR、模型、真实 Vault、数据库与桌面原生 UI 不由这些夹具自动验收。

本轮核实的既有运行均为六个矩阵成功：

| 基线 | 运行 |
| --- | --- |
| dev `7a9d9e6` | [44669104721](https://github.com/qianxi-00/dsh-paper-workbench/actions/runs/44669104721) |
| test `a057a55` | [44669572676](https://github.com/qianxi-00/dsh-paper-workbench/actions/runs/44669572676) |
| prod `5365e51` | [44669910919](https://github.com/qianxi-00/dsh-paper-workbench/actions/runs/44669910919) |
| main `b5aee8b` | [44670038376](https://github.com/qianxi-00/dsh-paper-workbench/actions/runs/44670038376) |

这些运行不包含本轮新增文档；同步后的 CI 需要按新提交另查。

## Release：从标签到发行包

定义：[release.yml](../../.github/workflows/release.yml)；[v1.2.0 固定版本](https://github.com/qianxi-00/dsh-paper-workbench/blob/5365e51227cff98f7b4d95629d475919e0a50b1a/.github/workflows/release.yml)。

1. `v*` tag push 或手动运行触发。手动输入 tag 可省略，此时使用 `v<package.json version>`；发布 job 要求最终标签与包版本严格一致。
2. `verify` 在 Ubuntu / Node 22 / Python 3.12 上运行隔离的语法、完整测试、安装、发布安全及 JSON 后端回归，失败不会进入发布 job。
3. `release` 等待 verify 成功，以 `npm pack` 生成 `dist/*.tgz`，并生成 `SHA256SUMS.txt`。内容由包清单的 `files` 限定，没有额外打包构建步骤。
4. 配置仓库 Secret `NPM_TOKEN` 时发布 npm，授予 job `id-token: write` 以生成 provenance。registry 已有相同版本时必须匹配本地 SHA-512 才跳过；明确 `E404` 才创建版本，其他错误或内容冲突中止。临时 npmrc 用后删除，不改用户级配置。
5. 稳定包使用 npm `latest`，带连字符的预发布标签使用 `next`。没有 NPM_TOKEN 时跳过 npm 但继续 GitHub Release，因此绿色运行本身不能证明 npm 一定有该版本。
6. 生成中英文 Release 说明，由 `softprops/action-gh-release` 创建或更新正式页面，上传 tarball 和 checksum。工作流没有更新第三方市场目录、连接用户机器或安装桌面 profile 的步骤。

项目约定先 `dev → test → prod → main`，在 prod 发布点打 tag；当前工作流只校验版本，未强制标签必须来自 prod。核查时四核心分支 `protected: false`、仓库 rulesets 为空，流程约定不能误写成已经由 GitHub 强制执行的门禁。

### v1.2.0 实际产物证据

- tag 指向 `5365e51227cff98f7b4d95629d475919e0a50b1a`；[Release 运行 44669926090](https://github.com/qianxi-00/dsh-paper-workbench/actions/runs/44669926090) 为 tag push，第 1 次运行成功，verify 与 release job 均成功。
- [GitHub Release](https://github.com/qianxi-00/dsh-paper-workbench/releases/tag/v1.2.0) 发布于 `2026-11-20T03:47:33Z`。固定工作流产物是 [dsh-paper-workbench-1.2.0.tgz](https://github.com/qianxi-00/dsh-paper-workbench/releases/download/v1.2.0/dsh-paper-workbench-1.2.0.tgz) 与 [SHA256SUMS.txt](https://github.com/qianxi-00/dsh-paper-workbench/releases/download/v1.2.0/SHA256SUMS.txt)。后来补传的 RELEASE_VERIFICATION 文档不是工作流固定产物。
- npm 1.2.0 公开时间为 `2026-11-20T03:51:37.632Z`。分别读取两渠道 tarball 实物，均为 `939030` bytes，SHA-256 同为 `3eab6f1a789e39a87e87ce9e80bf6f232218db7e907b4dbdd8ee84e69f275b98`，与 GitHub digest 及 checksum 一致。
- [npm provenance 声明](https://registry.npmjs.org/-/npm/v1/attestations/dsh-paper-workbench@1.2.0) 指向相同 tag、SHA、workflow 和运行；本轮已比对公开声明，未独立验签。
- GitHub 有 v1.0.0 Release，但 npm 没有 1.0.0；v0.8.0/0.8.1 仅见 tag，没有对应 GitHub Release。历史 v1.1.0 曾有失败尝试后重跑成功，不能仅凭最终绿色结果推断没有失败历史。

## 安装部署与本机生效

- [PowerShell](../../scripts/install.ps1) / [Bash](../../scripts/install.sh) 一行安装器默认查询 GitHub 最新 Release，可退到 main 源码；显式版本只取对应 Release 或 tag 源码，并在替换前校验包名和版本。脚本本身从 main 获取与 payload 版本是两个选择，不等于两者都锁定。
- 这些安装器不自动校验 `SHA256SUMS.txt`。需要固定发行物时先下载指定版本及 checksum，核对 SHA-256 后安装刚校验的同一份包；不要再转交会重新下载或回退源码的一行脚本。不能用已校验某份 tgz 的 hash 证明另一条下载路径实际安装的内容，也不要把“检查包名版本”表述为“已校验发行物 hash”。
- 未锁版本的 Web 安装可调用 DSH CLI；直装会写目标 profile。[Node 安装器](../../scripts/install-agent.mjs) 面向本机桌面 profile，默认 link，可改 copy，支持 dry-run/JSON 报告；遇未注册或显式禁用会报告，不擅自启用。
- 包发布与目录刷新不会自动更新用户机器。确认实际 profile、link/copy 及运行进程加载路径后，按宿主能力启用/重载或重启，再在现有 DSH 地址检查原生会话、上传及阅读器。
- 本轮没有 environments/deployments，也没有安装主机的 job；正式包在 GitHub Releases/npm。本轮未安装或启用插件、未变更 profile、未触发新 Release，也未验证本机原生 UI。

## 维护时的查询入口

以下为只读查询，不输出凭据；`gh` 使用已配置身份，推送前另核对 Git Forge 策略。

```bash
gh repo view qianxi-00/dsh-paper-workbench --json defaultBranchRef,url
gh api repos/qianxi-00/dsh-paper-workbench/branches --jq '.[] | {name,sha:.commit.sha}'
gh run list --repo qianxi-00/dsh-paper-workbench --workflow ci.yml --limit 6 --json databaseId,headBranch,headSha,status,conclusion,url
gh release view v1.2.0 --repo qianxi-00/dsh-paper-workbench --json tagName,url,assets
npm view dsh-paper-workbench dist-tags --json --registry https://registry.npmjs.org
gh pr view 17123 --repo awesome-dsh-plugin/awesome-dsh-plugin --json state,mergedAt,url
```

发新版本前核对版本、prod 提交、CI、tag、npm 同版本内容及发布凭据的配置状态；不读取或记录凭据值。发完分别验 Release、npm、目录 PR 与公开索引，再按任务范围验证目标安装。跟进事项保存在 [维护 backlog](../tasks/2026-11-20-maintenance-backlog.md)。
