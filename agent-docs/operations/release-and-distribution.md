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
| Awesome DSH Plugin | 作者首次投稿及 1.1.2 更新已合并；目录仍为 1.1.2 | [收录 PR #16657](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16657)、[更新 #16763](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16763)；[1.2.0 更新 #17123](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17123) 核查时 OPEN |
| dshmarket | 展示同一社区目录数据，不是本仓库另一条发布 job | [数据源说明](https://github.com/dsh-market/dsh-market/blob/b21cf7f1c3e2da777d8e4ecf9460589ed3e1a2e9/README.zh.md#L156)、[实际目录接口](https://awesome-dsh-plugin.com/plugins.json) |
| DSH「发现」可用索引 | 三个 Format 1 端点均有本项目，记录版本 1.1.2，`source.type=npm` | [jsDelivr](https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json)、[社区目录站](https://awesome-dsh-plugin.com/index.json)、[市场站](https://dshmarket.com/index.json)；读取公开索引不等于本机 profile 已添加索引源 |
| DSH Get | 有精确条目，标记 11 月 18 日收录、11 月 19 日同步，上游为 Awesome DSH Plugin | [公开条目](https://dshget.com/plugins/qianxi-00/dsh-paper-workbench)；未找到作者逐站投稿证据 |
| DSH Hub | 有精确条目，快照 1.0.0，兼容性待验证 | [公开条目](https://dshhub.org/zh-CN/plugins/qianxi-00/dsh-paper-workbench/)、[自动采集流程](https://github.com/coderPerseus/dsh-hub/blob/61c6e5c70df02efff181808e0f76d93c1a76cf13/docs/catalog-pipeline.md#L28-L50)；不能当作 1.2.0 已同步 |
| FindHarness | 有精确条目，镜像 README 为 v1.1.2，安装入口指向 GitHub | [公开条目](https://findharness.com/plugins/qianxi-00-dsh-paper-workbench)；未给出快照提交，未证实作者单独投稿 |

已确认的作者市场投递记录在 Awesome DSH Plugin。其 [登记 YAML](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/1e6061a96f673c38ce014472c711f2398ded823f/data/plugins/qianxi-00__dsh-paper-workbench.yml) 在核查时仍指向 1.1.2 固定 tarball；[公开详情](https://awesome-dsh-plugin.com/p/qianxi-00/dsh-paper-workbench/) 和 [JSON](https://awesome-dsh-plugin.com/plugins.json) 也仍为该版本，JSON 另提供 npm 包名。1.2.0 PR 的 head 为 `55d3043976322b49f8463aa18c3d25ec98c3b77b`，目录核查提交为 `1e6061a96f673c38ce014472c711f2398ded823f`。

社区目录通过合并后的生成流程及定时/手动 [站点构建](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/1e6061a96f673c38ce014472c711f2398ded823f/.github/workflows/build-site.yml) 刷新。固定 tarball、索引展示版本和 npm `latest` 是分别维护的对象，更新其中一个不能证明其余已更新。

DSH 官方公开 [插件索引契约](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/docs/user/guide/plugin-market.zh.md#L21-L34) 将此能力描述为实验性组合包，索引源按 profile 配置，无内置索引源。本轮依据公开契约与实际索引响应，未操作本机「发现」界面，也不能据此声称存在已验收的官方独立市场上架流程。

安装技能存在于 [本仓库](../../skills/install-dsh-paper-workbench/SKILL.md) 和 npm 实物。[Skills.sh 精确搜索](https://www.skills.sh/api/search?q=install-dsh-paper-workbench) 未命中；SkillsMP 探测 403、LobeHub 探测 404，不能证实这两个目录的收录情况。[DPharness 搜索](https://dpharness.com/api/plugins?q=dsh-paper-workbench&take=100) 未找到本仓库的精确 owner/name。以上是本轮查询边界，不是对整个互联网的排除结论。

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
