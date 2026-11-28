# QIAN-111：Obsidian 首次并发创建候选

日期：2026-11-27。状态：in_progress（实现候选，等待精确 head 检查与独立验收）。

## 身份与范围

- 任务：QIAN-111（`01a21b34-b019-7604-a791-8d5adb3d0750`）；实现 run：`01a21b34-b039-749c-ac9f-50f4b3e9f5bd`；协调 QIAN-104。
- 来源轮：`Loop-01a21afd-62a0-72d1-9e92-920fd27f7cf4`；唯一实现键尾 `Close:Fix:GH22`。
- 业务问题：[GitHub #22](https://github.com/qianxi-00/dsh-paper-workbench/issues/22)。本任务不合入、不关业务 issue、不发版。
- 分支：`agent/qian104-gh22-obsidian-create`；基线及开工远端 dev：`418ff419ebf8180044bee41423b47406e5d42313`。
- 唯一产品写入 `lib/obsidian.js`，回归 `scripts/test-obsidian.mjs`；另两个本问题专属 plan/task 文档。index/tools/store、检索与其他在途修复只读。
- 方案和边界见[本问题计划](../plans/2026-11-27-qian111-obsidian-create.md)。

## 修复与契约

`upsertCard` 原先锁外生成首次创建整卡快照，`writeText` 仅串行发布；两份成功补丁会互相覆盖。现在新建和更新共用 `upsertCardFile → updateText`，锁内读取当前文件，不存在时才调用无副作用 `createCardContent`。实际 `created` 返回来自发布结果，而非调用前判断。

未改变外部 API/schema；保留原子 rename、写前逐字节备份、失败后队列继续、幂等及未受管用户内容。无数据库迁移，无新外部调用、依赖或生产日志/配置。仅同进程同目标路径串行；跨进程、路径别名和外部编辑器竞争不在本候选保证范围。旧内容仍可能在写前备份中，不能把原缺陷描述为所有副本永久灭失。

## 已验证的 red/green

- 原样 v2 模块 create、真实 createApi/vault.upsert create，在干净产品基线均 exit 1；两个成功响应、当前卡片丢 alpha。脚本 SHA-256 与线上 #22 正文及 Open 附件一致。
- 产品修改前，新增到既有脚本的回归为 23 PASS / 2 FAIL；失败为两个首次创建均返回 true（模块和真实 RPC）。
- 修复后，同一原样 create/existing/failure/serial 及 RPC create/existing 全部 exit 0；两份字段和受管小节均存在，创建标志为 true/false。
- 新增四项模块/RPC/数据安全回归，既有脚本合计 25 PASS / 0 FAIL。覆盖每次前像备份、BOM/CRLF、未知嵌套 frontmatter、注释、未受管正文、幂等、ENOSPC 和队列恢复、无孤立 tmp。失败注入不依赖两个调用的调度顺序。
- 相关 tools：16 PASS / 0 FAIL（未配置真实 Vault 的旧工具用例 SKIP）；safety：27 PASS / 0 FAIL；host-auth 通过。真实 vault.upsert 由新增隔离 RPC 用例实际执行，未以旧工具 SKIP 代替。
- `node --check lib/obsidian.js`、`node --check scripts/test-obsidian.mjs`、`git diff --check` 已通过。

## 完整回归、稳定性与接续

完整 `npm test`（自动 posttest）、最终提交的原样/相关回归与 CI 的逐项 UTC、PID、完整 SHA、退出码、PASS/FAIL/SKIP 和原日志，集中交付于 QIAN-111 唯一完整报告及其 SHA-256 附件，避免在源码文档复制瞬时 CI 状态或日志转储。报告的精确候选 head 才是独立验收输入，不沿用其他 head 的绿灯。

已读取任务根/仓库根 AGENTS 和既有 ci.yml；未见本地/CI 各连续十次规则。既有 CI 是三系统 × Node 20/22；旧 legacy 回放脚本内部十轮不视为十个独立进程或十次 CI。没有修改 workflow、测试门槛或旧断言。

完整套件先后发现验证夹具的 stdout 审计污染 CLI JSON，以及 mock-origin.test 逻辑域名被误当外部物理连接。原始失败日志保留；审计改写独立文件，并仅在仍受底层回环连接保护的已建立隧道上允许逻辑域名，代理用例重新 5/5 通过。产品代码、旧断言及 workflow 没有为此改变。本地启动前隔离数据根/APPDATA/假 home、拦截个人样本与真实外网；允许回环模拟服务。原样探针保留 Open 禁网器。既有远端 CI 的在线用例遵循原 workflow，不能把本地禁网收据扩为远端零外网证明。预期损坏 JSON 的负向场景 stderr、环境 SKIP 和目标测试结果分别记录。

下一 owner：QIAN-104 在候选交付后一次性安排非实现者精确 head 验收；后续才可能正常 dev merge、真实合后验证与显式 CLOSED/closedAt。实现者不自认独立验收；真实宿主 UI、真实 Vault、外网源可用性、数据库、OCR/VL、模型和生产 p95 未验收。
