## GitHub Actions 历史保留运维

`../.github/workflows/cleanup-actions.yml` 每日 `03:17 UTC`（Asia/Shanghai `11:17`）运行，并提供手动 `workflow_dispatch`，手动入口默认 `dry_run=true`。清理脚本固定只访问 `qianxi-00/dsh-paper-workbench`；工作流仅授予 `actions: write` 和 `contents: read`，使用不可取消并发组。定时任务和手动入口必须先进入默认分支 `main` 才能实际启用；进入 `dev` 或 `test` 不会启用它们。

保留按组计算，不承诺全仓只留一条：各 workflow 保留最近完成结果和最近成功结果；核心分支、开放 PR 分支的 CI 及已发布 tag 的 Release 运行分别保留最近结果和最近成功结果。所有未完成运行受保护。每个 ref 按最近访问时间只留一个 Actions cache，同 ref 的其他 cache key 可能冷启动。脚本不调用 GitHub Releases、tag 或 release-asset 删除接口。

运行列表与产物列表不是原子快照。没有 workflow run 关联、关联 run 不在本次快照，或关联 run 仍未完成的产物一律保留；summary 按原因列出 ID。仅有已知且已完成关联 run 的产物才可能按过期和运行保留策略删除。

Actions 存储占用（运行记录/产物与 cache）和执行分钟数是不同的用量项。删除历史不会返还已经消耗的执行分钟数。本次候选只做测试和 GET-only dry-run，不执行删除，故实际释放存储量为 0；仓库 API 未提供可读的账户分钟用量，实际方案限额及配额刷新时间待账户用量页面确认，不以 dry-run 推断已释放额度。

启用后先在 `main` 手动选择 `dry_run=true`，核对运行摘要的快照计数、保留 ID、删除计划及 artifact 保留原因，再按独立授权处理真实清理。检查入口：

```powershell
gh workflow run cleanup-actions.yml --repo qianxi-00/dsh-paper-workbench --ref main -f dry_run=true
gh run list --repo qianxi-00/dsh-paper-workbench --workflow cleanup-actions.yml --limit 5 --json databaseId,event,headBranch,headSha,status,conclusion,url
```
