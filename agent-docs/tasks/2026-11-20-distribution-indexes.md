# QIAN-25 · 四源收录、同步与持续验证

日期：2026-11-20。状态：本地实施与验证已交付，四源尚未全部上线；外部恢复条件见下表。目标正式版仍为 1.2.0，开始时分别刷新 GitHub latest 与 npm latest；本仓库从 dev `e7c4616024d2553c9aad734172f16d80e55c741b` 开分支 `agent/qian-25-distribution-indexes`。

## 可审查成果

- `scripts/check-distribution.mjs`：四个固定 HTTPS GET，精确包名及仓库双重匹配，时间/HTTP/解析/匹配数/版本/source/engines/标签/响应摘要，逐源失败与退出码。`--output` 拒绝覆盖文件；不触发投稿、发布或安装。
- `scripts/test-distribution.mjs`：12 项离线公共边界回归，覆盖身份仿冒、歧义、旧版本/缺项、npm registry、网络与解析错误、部分失败、响应上限/摘要、超时、版本参数及 CLI。
- `package.json`：增加 `distribution:check`，将离线测试接入已有 posttest。未加依赖、构建或发版工作流，版本仍为 1.2.0。
- README 增加精确 npm 安装目标和前提；根指南只保分发入口；发布运维、状态和 DIST-001 接入新的唯一事实源。
- [四源 JSON](2026-11-20-distribution-evidence.json) 与 [上游/发行物 JSON](2026-11-20-distribution-upstream-evidence.json)：仅保存必要事实和完整 SHA-256，不包含整份索引、凭据或真实用户数据。

## 四源状态与恢复条件

完整端点、维护流程和准入规则集中见 [发布运维](../operations/release-and-distribution.md#四源检查与后续版本维护)。以下摘要来自 2026-11-20T11:44:52Z 开始的真实 JSON 请求，均 HTTP 200 / parse ok。

| 来源 / 既有记录 | 实际版本与来源 | 本轮动作与剩余条件 |
| --- | --- | --- |
| Scout [#1](https://github.com/fegnze/dsh-plugin-scout/issues/1) | 未收录，466 项零匹配 | 生成一致性提案已提交并推送作者 fork；创建上游 PR 与在 #1 补充评论均被 token 权限拒绝。需有权限的身份提交现成提案，维护者决定无范围 bundle 政策，并明确旧 target 的真实兼容证据 |
| 开放市场 [#552](https://github.com/polang233/dsh-plugin-index/issues/552) | 1.2.0/npm，verified-live，knowledge/verified | 复核原申请 CLOSED 和维护者精确 1.2.0 审核；未重复投递。后续版本重新核对审核绑定 |
| Bruce [#174](https://github.com/bruc3van/awesome-dsh-plugin-pro/issues/174) | Format 1 未收录，2629 项零匹配 | approved 已过、packages 未映射；1 star <5，未提交不合规映射 PR。达到门槛且近 90 天活跃后先查每日映射，必要时最小 packages PR，再验容量/audit/线上索引 |
| Awesome [#17123](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17123) / dshmarket | 1.1.2/npm，outdated，docs | 复用原 PR，OPEN、mergedAt=null、2 个检查 SUCCESS，head 已改 tarball 1.2.0。源 YAML、plugins.json、主站 Format 1 与镜像仍为 1.1.2；待维护者合并及各自构建/缓存/镜像刷新 |

开放市场和 dshmarket 的 engines 对象为空，这是声明缺失，不补成 `*`。Scout/Bruce 的 `waiting-review/policy` 是独立的、注明日期的申请背景，不替代实时 `not-listed`。公开条目通过与本机安装/真实宿主兼容分别验收。

## Scout 提案与权限阻塞

- 上游基线：`fegnze/dsh-plugin-scout@956d0e944734649feda0bc299adeed68d913e8c2`。
- 已推送提交：[58d92d2](https://github.com/qianxi-00/dsh-plugin-scout/commit/58d92d2)，分支 `agent/qian-25-market-compatibility`；[比较并创建 PR](https://github.com/fegnze/dsh-plugin-scout/compare/main...qianxi-00:agent/qian-25-market-compatibility?expand=1)。没有已创建 PR，也没有已发送评论。
- 4 个文件：`src/core/crawl.mjs`、`src/core/market.mjs`、`scripts/generate-market.mjs`、`test/generate-market.test.mjs`。保留 engines 并将既有最终导出范围判定复用于两个候选阶段；host peer-only 规则与 no-range 排除政策保持不变。
- 基线新增 fixture 出现两个预期失败：engines-only 在 npm 查询前候选为 0，最终拒绝空目录；engines-over-peer 预期纳入而实际被前筛排除。修复后真实 normalizeNode → generateMarket → 官方 parseMarketIndex 全链通过。
- 现有声明未变更：本项目没有 DSH peer/engines 范围；默认 target 0.2.1-rc.2 未改；历史 rc.5 记录不证明旧 target 兼容。提案合并后本项目仍需政策/真实验证与单独批准的发布路径。
- `gh pr create` 返回 `GraphQL: Resource not accessible by personal access token (createPullRequest)`；`gh issue comment 1` 返回 `GraphQL: Resource not accessible by personal access token (addComment)`。未切换身份、未尝试绕过；分支和审查材料已公开可读。

供有权限的维护者接续的 PR 标题：`fix: align catalog prefilters with exported compatibility ranges`。正文要点：

> The generator rejects engines-only bundles before npm lookup and applies a peer-only rule again before publication-time lookup, although the final exporter already accepts a real engines.dsh range. Preserve engines during discovery and use the exporter's existing publishable-range decision consistently. Do not change host peer compatibility, target runtime, no-range policy or published data. Fixtures cover normalization through generation and the official Format 1 parser, incompatible targets, absent/workspace ranges and engines precedence. npm test including pretest build: 81 pass, 0 fail, 1 optional installed-host bridge skip. Related to #1; this change is not an inclusion exemption for dsh-paper-workbench or evidence of rc.2 runtime compatibility.

## Bruce 安装映射准备

准确的包名、仓库归属和安装前提已进入 README。达到政策条件后可在当时 upstream 的 `data/packages.json.entries` 准备以下形式；这是待复核材料，未写入上游、未宣称 readme-verified 映射已获维护者审核：

```json
{
  "qianxi-00/dsh-paper-workbench": {
    "packages": [{
      "profile": "web",
      "source": "npm:dsh-paper-workbench@1.2.0",
      "command": "dsh plugin --profile web add dsh-paper-workbench@1.2.0",
      "install": "dsh-paper-workbench@1.2.0"
    }],
    "status": "readme-verified",
    "verified_date": "2026-11-20",
    "verified_via": "README@agent/qian-25-distribution-indexes"
  }
}
```

提交前改用已合并 README 的固定 SHA、当前日期和目标版，遵循上游对来源 spec 的具体约定。当前无映射意味着本项目尚未进入 format-1 候选；不能把 audit 中的 cutoffStars=4 当作新增映射门槛被放宽。

## 本轮验证

| 命令或检查 | 退出码与证据 |
| --- | --- |
| 本仓库 `npm test` | 0，含 posttest；新增 12/12，Python PDF 质量 10 项及协处理器 self-test 通过，中文 PDF 后台任务 5/5、批量版面 1/1 |
| `node --check scripts/check-distribution.mjs` 与 `node --check scripts/test-distribution.mjs` | 均 0 |
| `node scripts/check-distribution.mjs --target-version 1.2.0 --output …` | 1（符合当前发行缺口）；四源均完整读取，summary 为 not-listed=2、verified-live=1、outdated=1 |
| `npm pack --dry-run --json --ignore-scripts` | 0，93 项，agent-docs 与 distribution 脚本/证据均 0 项 |
| `git diff --check` | 0 |
| 本地 Markdown 链接核对 | 7 份变更文档，183 个本地路径引用，0 个失效目标；命令输出已检查 |
| Scout 锁文件安装及 `npm test` | 均 0；81 pass / 0 fail / 1 skip，含 pretest build；官方 parser 来自固定 0.2.1-rc.2 |
| Bruce `validate-packages.mjs` | 0；3192 entries / 3452 packages，7 项既有警告 |
| Bruce `validate-curated.mjs --from-snapshot` | 0；3 项归档警告（lengmoXXL/dsh-git、openplancc/dsh-fuse、youbuwei/dsh-zhipu-mcp） |
| Bruce `host-market/validate-index.mjs` | 0；2629 插件 / 4840605 bytes，报告摘要、排序、来源和容量校验通过；155 个合格候选因容量未入选 |
| GitHub/npm 1.2.0 实物 | 两份均 HTTP 200、939030 bytes、SHA-256 一致，见补充 JSON；未重新发包 |

本仓库全套在 import 前设置随机临时 `DSH_PAPER_WORKBENCH_DATA`，`PYTHONUTF8=1`、`PB_FORCE_SYNTH_SAMPLE=1`、空 `PADDLE_OCR_TOKEN`。跳过：未配置真实 Obsidian Vault；本机 RETRO/FlashAttention 及单栏样本；真实 OCR token 未设置；合成样本模式的 paper_search_online 不触发外网。另有现成在线 arXiv/OpenAlex 用例实际成功。未验证原生宿主 UI、真实 PG/MySQL、复杂论文全库或付费云服务；夹具通过不替代这些验收。

Scout 跳过 optional installed official HTTP bridge，因为 `SCOUT_CONNECTION_MODULE` 未设置。Bruce 最初在 Windows CRLF 检出下出现四个标题缺失和索引摘要失败，已核对 Git blob SHA-256 与报告一致并以原始 LF 字节重跑通过；不把检出差异记成上游源码缺陷。Awesome plugins.json 的 Node 请求曾超时，系统 curl 的后续读取成功；证据保留 priorAttempts 并分别记录最终读取。

本轮没有生产、测试环境、profile 或真实文库变更，没有发布 npm/tag，没有合并上游 PR。合并前关闭本仓库提案即可撤销；合并后按对应提交 revert。恢复条件满足后重用既有 issue/PR 继续，不自动重复申请。
