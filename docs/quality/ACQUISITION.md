# 语料采集状态（2026-11-17）

- 来源：`docs/quality/candidates.json` 的固定 commit/URL 清单（24 dev / 6 holdout 预分配）。
- 缓存：`C:/Users/QianXi/AppData/Local/Temp/pb-quality-corpus-5b7bcee5`（不提交，仅在评测机器本地）。
- 结果：**30/30 篇下载成功，共 762 个物理页，70,693,890 字节**；`acquisition.json` 记录每篇的 SHA-256、实际 URL、字节数与实际页数。
- 人工 gold：**0 页**。`pages-to-review.json` 的每页状态仍为 `unannotated`、`verified_tags: []`；尚未生成任何质量分数，也不得把候选来源或自动解析结果当作人工真值。
- 采集器：`scripts/quality/collect.py`（标准库、只走 HTTPS、单文件/总预算限制、原子发布）；评测接口：`scripts/quality/evaluate.py`（无 gold 时输出 `not_evaluated`）。
