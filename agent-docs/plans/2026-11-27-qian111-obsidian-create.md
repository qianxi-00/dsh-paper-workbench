# QIAN-111 Obsidian 首次并发创建修复计划

状态：active；日期：2026-11-27。任务 QIAN-111，协调 QIAN-104，Related GitHub #22。

**Goal:** 两个首次创建同一卡片的成功请求，其独立字段和受管正文都保留在唯一当前文件。

**Architecture:** 复用 `updateText` 的按目标路径队列。锁内读取最新原文；不存在时才生成最小卡片，随后应用本次补丁、备份及原子发布。复用既有错误恢复，不增加锁层级。

**Tech Stack:** Node 内置模块；无新依赖、API 或数据格式变化。

## 已确认事实与假设

- 基线及开工时远端 dev：`418ff419ebf8180044bee41423b47406e5d42313`。
- Open 附件 SHA-256：`0ebbd7bf643165b6f5d5a3721685dfe6788c016354bffd079e7480118f8fde5b`；110 项清单通过校验；正文 v2 探针与附件一致。
- 原样模块 create 和真实 createApi/RPC create 已在干净基线上 exit 1：两个成功响应、当前文件丢 alpha；没有真实网络。
- 假设 1（最高）：锁外整卡快照导致覆盖；预测把判定和合并移到 `updateText` 内即可转绿。
- 假设 2：字段/受管小节合并器本身丢键；预测 existing/serial 正对照也会失败，可用原样探针排除。
- 假设 3：RPC 映射丢参；模块探针已在 RPC 之外复现，可排除其为唯一根因。
- `locateCard` 保持既有 source/sourceRelative/title 定位语义；实际文件的存在判定由目标路径锁内读取决定。仅保证同进程、同目标路径，不扩为跨进程或外部编辑器冲突保证。

## 文件与契约

- 产品：仅 `lib/obsidian.js`。读取 `lib/tools.js` → `lib/index.js` 的 `vault.upsert` → `upsertCard`，以及 `library.update` → `setStatus`；这些调用方和 store 不修改。
- 回归：`scripts/test-obsidian.mjs`，覆盖原有模块边界和真实 `createApi()['vault.upsert']` 边界。无需改 CI、package.json 或公共接口。
- 文档：本计划及同主题 QIAN-111 task 文件；不改共享 memory。
- 返回契约不变：仅实际创建请求 `created=true`，后续合并为 false；合法补丁不得被拒绝；幂等 `changed=false` 不触碰备份。
- 保留 BOM/CRLF/未知嵌套 frontmatter、注释和非受管正文；每次实际备份必须逐字节等于前像；失败显式 reject、队列继续、清理 tmp。

## 执行与验收

- [x] 校验证据、固定 dev、原样 create 模块/RPC red，保存命令、SHA、PID、UTC 和退出码。
- [x] 在产品修改前，将首次并发创建、失败恢复和真实 RPC 回归接入既有脚本并观察目标断言 red。
- [x] 在 `updateText` 回调内实现不存在时初始化，统一合并/写入；去掉锁外的创建快照写路径，避免嵌套取锁。
- [x] 同一 v2 探针 `create/existing/failure/serial` 和 RPC `create/existing` green；新增回归 25/25，记录 created、唯一文件、备份和幂等。最终 head 的重复独立进程收据由下列交付检查补齐。
- [ ] `node scripts/test-obsidian.mjs`、tools/safety/host-auth 相关回归、完整 `npm test`（含自动 posttest）、修改文件语法和 `git diff --check`。所有测试使用随机临时根、假 APPDATA/Vault、合成 PDF、空 OCR token，启动前拦截外网并允许 loopback 模拟服务。
- [ ] 自查标准与任务契约，提交单缺陷修复；授权范围内推送、建立目标 dev 的普通 PR（QIAN-111/QIAN-104/Related #22），auto-merge off；固定最终 head 执行验证及读取既有 CI。
- [ ] 打包原样脚本、red/green、完整原始收据、失败/SKIP 边界及 SHA-256 清单，只交一份完整 issue 报告。状态 in_review，等待非实现者独立验收；不合入、不发版、不关 #22。

## 稳定性出处与权限

已读取实际任务根 AGENTS 与仓库 AGENTS；未出现“新测试本地及 CI 各连续十次”条文。仓库 AGENTS 第 7 节要求隔离后相关/完整回归并报告跳过；第 9 节规定既有三系统 × Node 20/22 CI。保留两个源文件与 CI 原文供复核，不把矩阵任务等同独立连续轮次。

当前环境未提供 GitForge 工具（发现查询无匹配）。任务明确授权单缺陷推送与 dev PR；实际 `gh repo view --json viewerPermission` 为 ADMIN。使用既有认证，不修改凭据或 TLS。沙箱 Git Schannel 与 Node 子进程 EPERM 均保留原错误，按执行权限流程获准后复测。

恢复：回退本单一修复提交即可，不涉及数据迁移；测试只处理本任务夹具。
