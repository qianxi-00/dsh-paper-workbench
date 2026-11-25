# 项目任务与失败运行现状快照 · QIAN-66

## 一句话

**已验证：现存 35 个项目任务中，18 个已终结、9 个待审核、7 个目标仍在进行、1 个阻塞；历史单缺陷闭环已收口，当前独立 Open-A / Open-B / Close 首轮及其 1500 秒周期尚未准入。** 本轮只形成记忆和证据索引，没有删除任务、改调度、补历史槽或重放旧任务。

核查日期：2026-11-25，Asia/Shanghai。任务、运行和 wakeup 的集中采集窗口为 **08:51:44–08:52:07 UTC（16:51:44–16:52:07 上海时间）**；关键评论与三个 Autopilot 的后续核对截至 08:54:02 UTC。不同请求不是数据库原子快照，接手时应重新查询。

交付前补充：09:01 UTC 再读项目列表仍为 35 个任务，生命周期数量未变化；部署工程师于 09:01:24 UTC 在 QIAN-66 交付只读核对，结论仍为当前不可启用。其 08:59:14 UTC 复核的 QIAN-64 仍 running，具体见下方来源。运行总数与逐项运行列继续保留上述集中采集窗口，不混用后来发生的成员收尾。

- 任务来源：[QIAN-66](https://multica.ai/qian-xi/issues/QIAN-66)，指派评论 `01a211e4-32dd-78f2-9749-1dddb3446d07`，2026-11-25 08:48:17 UTC。
- 仓库基线：本轮 checkout 的 `HEAD`、`origin/dev` 以及 GitHub `commits/dev` 读回均为 `9fb33140a09147b26cee045d4d06860a6ca832ad`。包清单仍为 1.2.0。
- 文档归属：根 [工程指南](../../AGENTS.md) 第 8 节要求工程记忆放在 `agent-docs`；本报告没有新建与之并列的 `doc` 目录。
- **已验证**表示本轮读回的平台字段、评论、附件哈希或 GitHub 状态；**来源报告**表示已读取原执行者的结论，未在本轮重做其测试；**待确认**表示缺少当前实现、实际运行或验收证据。原执行者的测试通过不能转写成本轮亲自通过。

## 五分钟版

| 事项 | 本轮事实及证据等级 |
| --- | --- |
| 任务覆盖 | **已验证**：项目过滤的 issue list 返回 `total=35`、35 个唯一 ID、`has_more=false`；35 个任务均读取线程摘要、完整 runs 返回和 wakeup 配置。 |
| 任务生命周期 | **已验证**：`done=18`、`in_review=9`、`in_progress=7`、`blocked=1`。进行中的目标不等于都有活跃执行。 |
| 执行生命周期 | **已验证**：294 个唯一 execution ID；175 completed、109 failed、7 cancelled、3 running。活跃运行分属 QIAN-64 一条、QIAN-66 两条。 |
| 失败分布 | **已验证**：64 次上游 503、34 次 20 轮上限、5 次 10 轮上限、5 次 `waitForChildren`、1 次 Responses / Chat Completions 不匹配。它们是运行错误分类，不是 109 个产品缺陷。 |
| 真正重复的任务 | **已验证**：35 个任务的 `duplicate_of` 均为空。**待确认**：本轮未认定可删除的内容重复任务；续接索引、不同 Review 时槽、失败回调和历史归档不能仅因主题相同就合并删除。 |
| 历史单缺陷闭环 | **已验证**：GitHub #5 CLOSED、PR #6 MERGED 到 dev；QIAN-27/29/30/31/32 已 done。**来源报告**：独立复测、合入后验证及关闭回读见 QIAN-27/32 的收口评论。此记录只计一次。 |
| 当前首轮 2+1 | **来源报告并经附件核对**：QIAN-62 只验了固定离线包，QIAN-63 只交接线规格；真实身份、可信采集及写入/回执适配仍 missing。QIAN-64 尚在执行，不能预写 accepted。 |
| 当前定时状态 | **已验证**：一个新 Review Autopilot active；旧 Open 和旧 Review paused。32 条现存 issue wakeup 均 `enabled=false`，包括已消费的结果等待。 |
| 本轮处置 | **已验证**：未归档或删除任何平台记录，未改状态、配置或认领；本报告按类别保留证据。QIAN-66 总目标尚包含首轮与定时启用，不能因盘点交付就结束整单。 |

## 深挖

### 1. 现存任务逐项分类

下表状态均来自集中采集窗口。运行列顺序为 **completed / failed / cancelled / running**，`0/0/0/0` 只表示该 issue 自身没有 execution 返回。每个任务链接是重新读取 description、评论、附件索引和 runs 的入口；变更日为 `updated_at` 的 UTC 日期。

| 任务与范围 | 平台状态 | 变更日 | 运行 C/F/X/R | 归类及保留依据 |
| --- | --- | --- | --- | --- |
| [QIAN-16](https://multica.ai/qian-xi/issues/QIAN-16) · 项目全景接手 | in_review | 11-21 | 13/0/0/0 | 待复核：8 个子项已验收，源头报告仍待用户验收；不随 QIAN-26 阻塞改写。 |
| [QIAN-17](https://multica.ai/qian-xi/issues/QIAN-17) · 阅读器与原生会话 | done | 11-20 | 1/0/0/0 | 已终结的调研，保留原报告。 |
| [QIAN-18](https://multica.ai/qian-xi/issues/QIAN-18) · Agent 论文作用域与沉淀 | done | 11-20 | 1/0/0/0 | 已终结的调研，保留原报告。 |
| [QIAN-19](https://multica.ai/qian-xi/issues/QIAN-19) · 隔离回归与真实验收基线 | done | 11-20 | 1/0/0/0 | 已终结的调研；夹具和真实环境的验收边界继续有效。 |
| [QIAN-20](https://multica.ai/qian-xi/issues/QIAN-20) · 加载入口与源码接手 | done | 11-20 | 1/0/0/0 | 已终结的调研，保留原报告。 |
| [QIAN-21](https://multica.ai/qian-xi/issues/QIAN-21) · 科研用户旅程 | done | 11-20 | 1/0/0/0 | 已终结的调研，保留原报告。 |
| [QIAN-22](https://multica.ai/qian-xi/issues/QIAN-22) · 导入、存储与翻译 | done | 11-20 | 1/0/0/0 | 已终结的调研，保留原报告。 |
| [QIAN-23](https://multica.ai/qian-xi/issues/QIAN-23) · 版面与中文 PDF | done | 11-20 | 0/1/0/0 | 已终结但有收尾失败：报告先交付，DSH 后报错；父任务已验收，不重跑调研。 |
| [QIAN-24](https://multica.ai/qian-xi/issues/QIAN-24) · CI、发行与安装证据 | done | 11-20 | 1/0/0/0 | 已终结的调研；发行、索引和本机生效分别验证。 |
| [QIAN-25](https://multica.ai/qian-xi/issues/QIAN-25) · 四源分发维护 | in_review | 11-20 | 1/0/0/0 | 待复核：PR #4 仍 OPEN；已有交付、依赖和附件，不可当无用任务。 |
| [QIAN-26](https://multica.ai/qian-xi/issues/QIAN-26) · DSH 收尾兼容 | blocked | 11-21 | 1/0/0/0 | 明确阻塞：隔离补丁证据存在，正式部署及有/无 child 平台验收未完成。 |
| [QIAN-27](https://multica.ai/qian-xi/issues/QIAN-27) · 旧单缺陷 Loop | done | 11-21 | 10/3/0/0 | 已终结：用户要求与 QIAN-33 校准后收口；失败历史保留，不另计一次闭环。 |
| [QIAN-28](https://multica.ai/qian-xi/issues/QIAN-28) · 旧最小 Loop 调研 | done | 11-21 | 0/2/1/0 | 已终结但有收尾失败/取消；方案已交、负责人验收，不能据失败删除方案。 |
| [QIAN-29](https://multica.ai/qian-xi/issues/QIAN-29) · 发现 GitHub #5 | done | 11-21 | 1/0/0/0 | 已终结，属于旧 #5 闭环的发现环节。 |
| [QIAN-30](https://multica.ai/qian-xi/issues/QIAN-30) · 修复 #5 / PR #6 | done | 11-21 | 2/0/0/0 | 已终结；返修和畸形数字引用的红绿证据保留。 |
| [QIAN-31](https://multica.ai/qian-xi/issues/QIAN-31) · 独立复测 #5 | done | 11-21 | 2/0/0/0 | 已终结；两轮复测是不同 head 的过程，不是重复闭环。 |
| [QIAN-32](https://multica.ai/qian-xi/issues/QIAN-32) · 合入、复验、关闭 #5 | done | 11-21 | 1/0/0/0 | 已终结；保留 merge SHA、合入后回归、关闭时间及首次 EPERM。 |
| [QIAN-33](https://multica.ai/qian-xi/issues/QIAN-33) · 持续 Loop 策略与历史索引 | in_progress | 11-25 | 60/76/5/0 | 目标未收口、当前无活跃 run；旧回调与多次失败是历史，不恢复其周期。 |
| [QIAN-34](https://multica.ai/qian-xi/issues/QIAN-34) · Open R1 / GitHub #7 | done | 11-21 | 0/0/0/0 | 有意建立的既有发现归档，原 run/附件在 QIAN-33；发现完成不等于 #7 修复。 |
| [QIAN-35](https://multica.ai/qian-xi/issues/QIAN-35) · 并发配置丢写 / #8 | in_review | 11-21 | 2/0/0/0 | 待复核：发现交付及监护在，#8 仍 OPEN，无修复 PR。 |
| [QIAN-36](https://multica.ai/qian-xi/issues/QIAN-36) · 旧 22:00 Review | done | 11-25 | 2/0/0/0 | 已终结的独立时槽；没有候选也是有效交付，不重放。 |
| [QIAN-37](https://multica.ai/qian-xi/issues/QIAN-37) · 1500 秒派发与两单认领 | in_progress | 11-25 | 2/0/0/0 | 实施链未收口；后续固定源码、锁修复、broker 交付散见 QIAN-33/57/59，不只看本 issue 旧评论。 |
| [QIAN-38](https://multica.ai/qian-xi/issues/QIAN-38) · 旧 00:00 Review | done | 11-25 | 1/0/0/0 | 已终结的独立时槽，carry_over 留档。 |
| [QIAN-39](https://multica.ai/qian-xi/issues/QIAN-39) · 旧 02:00 Review | done | 11-25 | 1/0/0/0 | 已终结的独立时槽，carry_over 留档。 |
| [QIAN-56](https://multica.ai/qian-xi/issues/QIAN-56) · 11-25 12:00 Review | in_review | 11-25 | 1/1/0/0 | 首 run 协议失败，后续已交 no_releasable_change；已消费等待不重建。 |
| [QIAN-57](https://multica.ai/qian-xi/issues/QIAN-57) · 续接 QIAN-33 | in_progress | 11-25 | 24/4/1/0 | 历史续接索引，含锁修复及独立复验；目前无活跃 run，旧监护禁用。 |
| [QIAN-58](https://multica.ai/qian-xi/issues/QIAN-58) · 11-25 14:00 Review | in_review | 11-25 | 1/0/0/0 | 待复核：已交 no_releasable_change，与其他时槽分开保留。 |
| [QIAN-59](https://multica.ai/qian-xi/issues/QIAN-59) · 续接与曾提出的自动摘要 | in_progress | 11-25 | 37/22/0/0 | 历史协调和激活索引；skills 已被用户暂缓，失败及能力报告保留。 |
| [QIAN-60](https://multica.ai/qian-xi/issues/QIAN-60) · 一次 leader 检查与交接 | in_review | 11-25 | 1/0/0/0 | 待复核：执行契约已交付；不在此任务继续下一轮检查。 |
| [QIAN-61](https://multica.ai/qian-xi/issues/QIAN-61) · 用户当前续接入口 | in_progress | 11-25 | 1/0/0/0 | 总目标未收口；原 run 完成仅表示交接结束，保留现有 QIAN-60/64 分工。 |
| [QIAN-62](https://multica.ai/qian-xi/issues/QIAN-62) · 固定 broker 包独立验收 | in_review | 11-25 | 1/0/0/0 | 待复核：测试工程师交本地合成非实现者结果，真实服务未准入。 |
| [QIAN-63](https://multica.ai/qian-xi/issues/QIAN-63) · 三项真实接线契约 | in_review | 11-25 | 1/0/0/0 | 待复核：规格和 schema 已交；三项接口未实现，非部署交付。 |
| [QIAN-64](https://multica.ai/qian-xi/issues/QIAN-64) · 本轮 leader 独立复核 | in_progress | 11-25 | 0/0/0/1 | 确有在途运行；核对 QIAN-62/63，保留原执行者，不能重复启动或预写结论。 |
| [QIAN-65](https://multica.ai/qian-xi/issues/QIAN-65) · 11-25 16:00 Review | in_review | 11-25 | 1/0/0/0 | 待复核：no_releasable_change，#7/#8/PR #4 carry_over。 |
| [QIAN-66](https://multica.ai/qian-xi/issues/QIAN-66) · 本次盘点与后续启用总目标 | in_progress | 11-25 | 1/0/0/2 | 文档盘点、部署条件只读核对并行；后续首轮/定时目标未达，不由本报告结束整单。 |

### 2. 失败、中断与交付不能互相替代

**已验证**的 109 次 failed 按错误签名汇总如下。分类仅使用 error 中的明确文本，没有据 stderr 中的模型名称推断新的根因。

| 错误签名 | 次数 | 所属任务 | 当前证据含义 |
| --- | --- | --- | --- |
| `API Error: 503 ... Service temporarily unavailable` | 64 | QIAN-33 | 上游不可用历史；没有证明这些失败各自产生业务交付。 |
| `session_turn_limit_exceeded` / `20 turns` | 34 | QIAN-33 9、QIAN-57 4、QIAN-59 21 | 会话限额错误；新 issue 的存在不证明供应商预算已清零。 |
| `This conversation has reached 10 turns` | 5 | QIAN-27 3、QIAN-33 2 | 较早的会话限额历史，与后来的 20 轮记录分别计数。 |
| `DSH_RUNTIME_ERROR: subagents?.waitForChildren is not a function` | 5 | QIAN-23 1、QIAN-28 2、QIAN-33 1、QIAN-59 1 | 部分发生于有效报告交付后；正式兼容问题保留在 QIAN-26。 |
| `requires Responses for tool calls; ... only supports Chat Completions` | 1 | QIAN-56 | 首次 Review 执行失败；后续另一条 completed run 已有审查结果。 |

7 次 cancelled 分属 QIAN-28 一条、QIAN-33 五条、QIAN-57 一条。本轮没有取消任务，也不把 cancelled 推断成具体的人为原因或未执行过任何动作。平台没有返回名为 interrupted 的状态，故不另造中断数量。

需要特别保留的证据：

- **QIAN-23：报告与失败并存。** 报告评论 `01a1f8bb-390d-7504-a58e-74a282f05594` 于 11-20 11:33:01 UTC 发布，原 run `01a1f8b4-1614-7ad6-9856-5de7c2fb8bed` 于 11:33:52 failed。QIAN-16 评论 `01a1f8bf-622a-7614-8fe5-9e33a39b3687` 保留报告，后续 `01a1f8ed-b2f7-71af-bb43-8b3b22f68d20` 记录第一阶段验收。不能通过重跑或删除掩盖收尾错误。
- **QIAN-28：方案和验收并存于失败历史中。** 方案评论 `01a1fcc6-4597-70bc-b0c9-f1b5580c1c83` 与验收补记 `01a1fcc9-27b5-7d9a-82dc-e5d4bd4d76ef` 都在，两个 failed 和一个 cancelled 继续保留。
- **QIAN-26：阻塞不是缺少用户授权。** QIAN-16 11-21 的授权及部署回帖证明已授权，但共享 profile 写入曾因 `EPERM` 失败，目标 DSH 空闲与真实平台双场景验收未证实。本轮只核对记录，未尝试共享路径、重载或权限恢复；不能说现机问题已修复。
- **QIAN-56：Autopilot 与任务后续结果不同。** source Autopilot run `01a210dc-afc9-7330-96d0-60f8be7d6880` 仍 failed；issue 的后续审查已交付 `no_releasable_change`。修正后的任务状态不改写原 run 失败。
- **QIAN-59：失败调查仍有成果。** 自动摘要能力报告曾从 failed DSH run 恢复；只读能力审验及接受评论分别为 `01a21177-0a8f-7b20-b741-84c0839b292c`、`01a2117a-92d2-764f-bbb1-fb0df595ed73`。实现/安装/启用及端到端均未成立，之后用户明确暂缓，不能写为技能已完成。
- **QIAN-62：业务测试通过与采集器失败同时保留。** 来源报告记录首次自建采集器 exit 1、20 个 fixture 初始化错误及一次解压助手 SyntaxError；修的是采集器，不是删除或放宽原断言。本轮没有重跑这些测试。

### 3. 已终结记录、续接索引与重复判断

**已验证：** 本轮不操作平台归档或删除。18 个 done 作为已终结历史保存；9 个 in_review 仍有验收意义；7 个 in_progress 中 QIAN-33/37/57/59/61 的目标与续接链尚未收口，即使各自没有活跃 run，也不自动关闭。

QIAN-33 → QIAN-57 → QIAN-59 → QIAN-61 是续接关系，保留各阶段的评论、附件和错误证据。QIAN-60 与 QIAN-64 是两个有限的 leader 检查，不是两个长期总任务。QIAN-34 的 description 明确是把 QIAN-33 R1 原 run `01a1fe17-f2bb-7ebd-9f1f-69205645e6b1` 及附件 `01a1fe29-eb1e-7949-99e2-3f9dc65ffc7f` 建成独立归档，因此该 issue 自身零 runs、零评论不表示空壳。

**历史来源报告：** QIAN-33 评论 `01a2109c-2863-7039-87f0-7ef2ee4213ca`（11-25 02:49:59 UTC）记录 QIAN-40–QIAN-54 已由技术负责人删除，删除前 dry-run、删除后读回失败。本轮完整列表也未返回这些记录，但没有重新逐项读取已删除对象；它们的历史删除依据不等于本轮重新验证删除操作。旧 Review 的执行历史仍保留 15 条 failed，部分 issue/task 引用为 null，不能据空引用恢复旧任务或补历史槽。

**待确认：** 本轮没有足够证据认定新的“确有重复、可删除”任务。重复错误消息、同日标题、不同 Review 时槽、同一问题的发现/修复/复测任务均不等同于重复业务记录。

### 4. 历史闭环与当前首轮的区别

**已验证的当前 GitHub 状态：** #5 CLOSED，关闭时间 `2026-11-21T08:48:13Z`；PR #6 MERGED 到 dev，merge 时间 `2026-11-21T08:37:25Z`，批准 head `30682d3d4c941857d4ba18da667773d1a10bcac8`，merge SHA `9fb33140a09147b26cee045d4d06860a6ca832ad`。QIAN-27 收口评论 `01a1fe21-c622-790c-b992-097ec3f1f538` 与 QIAN-32 交付 `01a1fd51-50ba-759f-8db1-be6385871a48` 给出人工可追溯的同一单缺陷闭环。本轮没有重跑其中的回归。

**已验证：** #7 和 #8 仍 OPEN、`closedAt=null`、assignees 为空；唯一 OPEN PR 是 QIAN-25 的 PR #4，head 为 `5b9f0f249ab57f01858a5cfa6fe140b93764e197`，现有六项 CI 均 SUCCESS。**来源报告：** QIAN-65 明确 PR #4 不修 #7/#8，仍缺独立复测/审核和当前 dev 集成。因此“无 assignee”或“有六项绿 CI”不能代替两单认领或准入证明。

QIAN-63 的真实 provider 样本还指出 #5 / #6 的 GitHub 双向 closing 引用为空。旧人工收口证据可以保留，但不能把无关联的 CLOSED issue 与 MERGED PR 拼成自动 broker 所需的目标映射，也不能将旧闭环替代当前独立双 Open、两单 Close 的首轮验收。

### 5. 当前首轮准入门槛

下列顺序来自 QIAN-60 执行契约、QIAN-61 用户要求与 QIAN-64 验收范围；不是本报告新增实施方案。

| 门槛 | 已有证据 | 当前判断 |
| --- | --- | --- |
| 固定锁修复与固定 broker 包的非实现者验收 | QIAN-62 正式报告存在且哈希匹配。来源报告：原 19/19、完整 29/29、九探针 9/9，broker 十轮 200/200、额外探针十轮 50/50；各组互有重叠，不能相加成独立用例数。 | **已验证交付，结果为来源报告**；只覆盖本地合成 DB/假 CLI，CI=not_run。本轮未复跑。 |
| 真实 broker 适配与共同持久权威 | QIAN-63 接线契约已交：mTLS peer 到平台 task/run/移交权限；可信 GitHub/Multica 完整采集和 unknown 对账；白名单参数、marker、写回执/查询及 dispatch 接线。 | **待确认/未准入**：三项真实接缝均 missing，`write_adapters` 默认空，当前业务写 operation 数为 0，`transport_ready=false`。 |
| 不可旁路写权限与强制 fencing | 契约要求 worker 无权直接改 DB、调用旧 coordinator 或直接业务写；共享 owner/generation/task/run 和 unknown hold 必须跨真实执行者成立。 | **待确认/未准入**：同账号 wrapper、本机合作锁、占位 Compose 或方法接口不构成实际隔离。Docker Linux 引擎恢复是来源记录中的运行能力阻塞，本轮没有重试。 |
| 一次真实独立 Open-A / Open-B / Close 完整闭环 | 每 lane 必须全新 issue/task，保留 slot/trigger/run/issue/task/executor；双 Open 真实并行，两单 Close 获原子全有或全无许可，随后独立复测、精确 head CI、合入 dev、合入后验证及显式关闭读回。 | **待确认/未执行成功**：派工、空 Close、串行同任务、schema 示例及旧 #5 闭环都不能替代。 |
| 未来周期与观察 | 首轮全部通过后才开未来固定锚点 1500 秒 2+1，并观察 168 小时。 | **当前不允许启用**：前置真实适配、隔离与首轮证据未齐；QIAN-64 结果尚在途。 |

QIAN-64 的实际 execution 为 `01a211c1-e363-747c-8641-ba95e1c67764`，技术负责人执行，采集时 `running`、attempt 1/2。激活来源是 QIAN-63 结果及一次 wakeup `01a211ac-a936-7b5d-9a30-9a91b19543d7`，不是业务时槽；`source_slot_utc` / `source_autopilot_trigger_id` 均为 null。不能将平台单个 execution ID 直接复制成 broker 要求的 task_id/run_id 两种身份，不能据新 issue 推定模型会话限额重置。

### 6. Autopilot 与 wakeup 实际状态

**已验证：** 当前项目共有三个 Autopilot，均为 `create_issue`。以下 cron 的时区均为 Asia/Shanghai。

| 配置 | 实际状态 | trigger 与最近结果 | 解释 |
| --- | --- | --- | --- |
| 新两小时 Review `33b798e0-517a-4748-a467-d03114589215` | active；原技术负责人 | trigger `a72b8732-44e4-4ec1-9f41-12aba979b26e` enabled，`0 */2 * * *`。最近 QIAN-65 completed；下次 `2026-11-25T10:00:00Z`，即上海 18:00。 | 时钟已在工作；最近三次 source run 为 failed/completed/completed，分别对应 QIAN-56/58/65。Review 成功不等于业务 Loop 成功。 |
| 旧两小时 Review `ffde2c30-d7be-4ace-8f97-c2dc1a7e31a3` | paused | trigger `59062095-8231-40be-9b5c-adc31aa84db1` 仍 enabled，`0 */2 * * *`，保留过期 next=`2026-11-23T02:00:00Z`。18 条历史 run：3 completed、15 failed。 | Autopilot paused 优先于 trigger 残留字段；不由 enabled 或过期 next 推断仍在调度，不恢复旧时槽。 |
| 旧半小时 Open `a5aed33e-60b9-4c55-a181-8beed7d3d8c2` | paused | trigger `f28e0314-47a5-42db-aeb5-59c8c93750a1` disabled，`0,30 * * * *`；唯一历史 run 对应 QIAN-35，completed。 | 旧单 Open 交付保留，不计作新双 Open 首轮。 |

32 条现存 issue wakeup 全部 `enabled=false`。旧规则仍可能保留过期 `next_fire_at`；判断是否启用须读 enabled，不以 next 字段单独下结论。

| 关键 wakeup | 本轮读回 | 保留含义 |
| --- | --- | --- |
| QIAN-57 旧监护 `01a210ff-5ac5-7ec7-80df-5c7fcf6dcf38` | disabled；fire_count=4 / max_fires=332；last task failed | 不恢复父 issue 长任务周期。 |
| QIAN-59 旧监护 `01a21156-42a6-7e44-b756-a62555a98d8f` | disabled；fire_count=3 / max_fires=328；last task failed | 不因重复失败再逐条确认或重放。 |
| QIAN-56 结果等待 `01a210f6-b2af-7558-93d0-699daf53080d` | disabled；fire_count=1；next=null | 已消费，不重建。 |
| QIAN-60 结果等待 `01a2118a-7d05-7960-9b36-444e29f3f34d` | disabled；fire_count=1；next=null | 已消费，不重建。 |
| QIAN-62 结果等待 `01a211a0-9a2c-7ae2-a554-c11848e6af4a` | disabled；fire_count=1；next=null | 已消费，不重建。 |
| QIAN-63 结果等待 `01a211ac-a936-7b5d-9a30-9a91b19543d7` | disabled；fire_count=1；next=null | 已消费并激活既有 QIAN-64，不再次激活。 |

QIAN-59 最新激活交付记录当前检查余额 **324**，QIAN-64 的一轮预留已消费；旧规则的 3/328 保留为历史，不改成新预算。原截止为 `2026-12-02T02:39:39.916977Z`。**来源报告明确：该余额记账不是已部署的周期配额控制。** 旧周期停用也不能证明评论自动回流链被关闭。

### 7. 通过门槛后允许执行的定时契约

本节描述既有批准边界内的条件性行为，**没有执行配置**。配置单写者仍为部署工程师。

- **业务时钟：** 仅在真实首轮通过后，以不可变 UTC 锚点产生未来每 1500 秒的 Open-A、Open-B、Close，三者各新建 issue/task，前轮在途不吞下一槽。激活水位/epoch 排除历史槽、预建 pending 和旧 Review 意图；不能直接运行会带入这些意图的旧 serve。
- **节拍：** 五字段 `*/25` cron 的跨小时间隔不是固定 1500 秒；同 issue 的 every/wakeup 也不能代替每槽新 issue/task。现有离线内核不等于真实有界派发已部署。
- **Close：** 当槽真实查询不足两条可认领 OPEN issue 时可以记录空批次；要证明首轮成功，须有真实两单全有或全无认领、竞争败方未开工、owner/generation/task/run fencing、unknown 持续 hold 及最终逐单闭环。labels、assignee 和先读后写不作为锁。
- **Review 与 leader 检查：** 保留现有两小时 Review 的 create_issue 与原执行者。每轮 leader 检查也须独立新任务；不重启 QIAN-57/59 的长 issue 周期充当检查。截止和剩余额度必须由实际可执行机制约束，不能用无界 Autopilot 代替原有界监护。
- **观察：** 首轮通过后才开始未来周期和 168 小时观察。原监护截止已经不足以覆盖从本快照时刻起的完整新 168 小时，不能把旧期限/余额或配置文本写成观察窗口已安排。本轮没有延长期限、重置余额或承诺观察已开始。
- **微信：** 真实发行与官方通道均满足门槛后另建通知任务，按实际版本 + 完整提交 SHA + 官方通道身份去重；sending/unknown 先对账，发送与送达分开记录。当前无新发行和送达证据，不能发送或将 issue 评论当微信汇报。
- **持续状态：** `version_scope=1.2.x`、既有认领、去重、generation 和 unknown hold 全部保留，不因重启、移交、commit 或任务迁移清零。

### 8. 来源、附件与复核方法

本轮实际运行 Multica CLI 0.12.1，认证主体为当前工作区用户。查询成功记录均保留在本次工作目录的私有采集材料；没有把原始聊天、个人绝对路径或日志转储写入仓库。随 QIAN-66 评论交付的 `evidence-summary.json` 保存经过筛选的任务、execution、线程、wakeup 和 Autopilot ID/状态及采集日期，便于重新计算计数；它不包含原始错误堆栈。

| 来源 | 日期 UTC | 本轮核对范围 |
| --- | --- | --- |
| 项目 issue list + 35 份 runs / roots / wakeups | 11-25 08:51:44–08:52:07 | **已验证**完整分页、唯一 ID、状态与分类统计；不是 workspace 全量任务，也不覆盖已删除任务的原始日志。 |
| QIAN-16 两条验收/授权线程 | 11-20 至 11-21 | **已验证评论**：全景报告、子项验收、QIAN-26 已授权但实际权限/平台验收未齐。 |
| QIAN-27 / QIAN-32 收口评论 | 11-21 12:43:08 / 08:55:27 | **已验证评论**及本轮 GitHub 状态；旧测试为来源报告，不是本轮重跑。 |
| QIAN-33 最新策略和历史删除交接 | 11-21 至 11-25 | **已验证评论**：固定 1500 秒、双 Open、独立任务、保留旧交付，不补历史。 |
| QIAN-59 激活交付 `01a211c5-5674-7f0e-b9b5-ca586c23c216` | 11-25 08:14:35 | **已验证评论、metadata 与 runs**：QIAN-64 仅激活一次、余额 324、真实准入仍关闭。 |
| QIAN-61 description 及续接交付 | 11-25 07:15:53 | **已验证用户要求和评论**：skills 暂缓，Open/Close/leader/微信各新任务，保留现有分工。 |
| QIAN-62 交付 `01a211a5-2780-7d1a-b8d2-f9091efc733c` | 11-25 07:39:25 | **已验证报告附件和哈希**；测试结论为来源报告，未下载并复跑整个测试包。 |
| QIAN-63 交付 `01a211bc-9f21-7d16-badd-1782a6bdf86f` | 11-25 08:05:03 | **已验证契约附件、哈希和相关条款**；未将 synthetic 示例当线上证据。 |
| QIAN-65 交付 `01a211c3-4f59-7222-9a42-d8f4e05ddfd1` | 11-25 08:12:22 | **已验证评论**及 GitHub OPEN/CI 状态；未重跑产品/broker 测试。 |
| QIAN-66 部署侧核对 `01a211f0-34d6-724e-baf0-a6951ce828df` | 11-25 09:01:24 | **已验证评论**：真实首轮未准入、没有已验证的安全周期启用命令。部署报告附件为 [原件](https://multica.ai/api/attachments/01a211f0-2fa5-7b0b-925f-e15fe2464691/download)，未宣称已合入远端。 |

三个实际下载并通过 SHA-256 比对的附件如下；这里只引用原件身份，没有复制整份报告或固定源码包到仓库。

| 原件 | Attachment ID | SHA-256 |
| --- | --- | --- |
| QIAN-60 Loop 执行契约 | `01a21196-9763-7e41-87fd-a77441318daa` | `4b7d8df767526cb3a7144f447b505c808a1531004bfb0d76969420467d159f59` |
| QIAN-62 REPORT.md | `01a211a5-2155-7b21-a4c6-47cff16fdb2b` | `60c0973d03cc51945028ccba18b577ef6f288d7a85c9612f7395483966673ec3` |
| QIAN-63 真实接线契约 | `01a211bc-97f3-782c-9e80-776235e520e7` | `c30b5f55968a49f1937699ceeac3545ee53aa1c383516fd23b3ccf256e6d1303` |

可复核的只读命令（使用当前 daemon 指定的 CLI，不从 PATH 解析旧版本）：

```powershell
& "$env:MULTICA_CLI_PATH" issue list --project ac2c53e0-5eca-479c-898b-9ff2796f3633 --sort created_at --direction asc --limit 100 --offset 0 --output json
& "$env:MULTICA_CLI_PATH" issue comment list 01a211ce-6c50-7aa4-860b-ee2ce5935c92 --roots-only --summary --compact --output json
& "$env:MULTICA_CLI_PATH" issue comment list 01a211ce-6c50-7aa4-860b-ee2ce5935c92 --thread 01a211e4-32dd-78f2-9749-1dddb3446d07 --tail 30 --compact --output json
& "$env:MULTICA_CLI_PATH" issue runs 01a2119e-29a6-7e9d-a792-c2ad1973fe95 --output json
& "$env:MULTICA_CLI_PATH" issue wakeup list 01a2114e-406d-77f0-b752-0c9c04898f7d --output json
& "$env:MULTICA_CLI_PATH" autopilot get 33b798e0-517a-4748-a467-d03114589215 --output json
& "$env:MULTICA_CLI_PATH" autopilot runs 33b798e0-517a-4748-a467-d03114589215 --limit 100 --offset 0 --output json
gh issue list --repo qianxi-00/dsh-paper-workbench --state all --limit 100 --json number,state,closedAt,url,assignees
gh pr list --repo qianxi-00/dsh-paper-workbench --state all --limit 100 --json number,state,headRefOid,baseRefName,mergedAt,url
gh api repos/qianxi-00/dsh-paper-workbench/commits/dev --jq .sha
```

issue list 若返回更多页，按实际返回条数递增 offset 并继续读取，不能沿用本次 35 的计数。issue 的评论先扫描 roots，再展开相关线程；本轮展开了 20 条相关线程，每条最多 root + 最新 30 个回复，未声称读完全部历史正文。运行统计没有重复相加 Autopilot source run 与其对应的 issue execution。

**本轮验证边界：** 只读 CLI、附件哈希、Git/GitHub 状态、文档事实/路径/diff。`git ls-remote` 曾因 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` 失败，远端 dev 使用已认证 `gh api` 读回；没有改 Git/凭据配置。当前 dev checkout 不包含 `scripts/loop-coordinator.py` 或 `scripts/loop-broker.py`，不能把附件里的候选源码写成已合入 dev。未跑 npm/Python 产品测试、CI、Docker/WSL、真实业务/论文库/数据库/OCR/模型、微信或发行；没有新的产品验收结论。

### 9. 追加补记：QIAN-64 失败及既有协调接收 · 2026-11-25

补记核查时间：**2026-11-25 09:37:48 UTC（上海时间 17:37:48）**。本节仅追加原快照之后的事实；上文 08:51:44–08:52:07 UTC 的 **294 条执行统计及各任务运行列保持不变**，不把后续终态回填到历史统计。

- **已验证：** 本轮 `issue runs` 读回 QIAN-64 唯一 execution `01a211c1-e363-747c-8641-ba95e1c67764` 已于 `2026-11-25T09:10:58Z` 终态 `failed`，`result=null`、attempt=1/max_attempts=2；`issue runs --active` 返回空列表，目前没有其他活跃执行。attempt 上限本身不证明存在待执行重试。
- **已验证错误文本：** `gpt-6.1-sol requires Responses for tool calls; this account only supports Chat Completions`。这是本次运行记录中的工具调用协议不匹配错误，不等同于此前的 20 轮限额，也不能据此判定候选产品故障。
- **来源报告：** [QIAN-59](https://multica.ai/qian-xi/issues/QIAN-59) 失败接收评论 `01a211fe-16b6-7a5a-b1a6-09504d7c7e17`（`2026-11-25T09:16:34Z`）确认平台无自动重试待执行，独立复核未完成；已有部分完整性成果和恢复文件已保留，审计脚本对补丁格式的断言失败不能写成产品测试失败或后续组已通过。原接收附件为 `01a211fe-15b8-780d-a452-a47a83400b02`；本次文档补记未下载或执行恢复脚本，也没有重跑审计、产品测试或 CI。
- **已验证接收链：** QIAN-59 已有协调 execution `01a211fe-16e4-74e7-95f0-adac3d4e3f0a` 接手，开始于 `2026-11-25T09:16:38Z`，本轮读回已于 `2026-11-25T09:36:00Z` `completed`。这只证明该次协调运行结束，不代替 QIAN-64 的正式独立复核结论；本任务没有重复派发或恢复该复核。
- **本次范围依据：** QIAN-66 指派评论 `01a21210-64ad-7b4f-a735-3064f23ff2fe`（`2026-11-25T09:36:33Z`）要求原作者仅提交三份既有记忆文档并追加本节。QIAN-66 保持进行中；固定修复与 broker 独立验收、真实身份/共同权威/不可旁路隔离及适配、真实独立 Open-A/Open-B/Close 完整闭环、未来 1500 秒周期及 168 小时观察的门禁不变。
