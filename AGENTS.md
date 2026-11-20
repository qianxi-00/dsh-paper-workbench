# AGENTS.md — dsh-paper-workbench 工程指南

本文件约束本仓库的开发、验证与交接。先按任务定位源码，再读取对应契约；当前行为以源码和可复现的验证结果为依据。版本、依赖和脚本入口以 [package.json](package.json) 为准，发布沿革查 [CHANGELOG.md](CHANGELOG.md)。旧契约中的机器路径、协作记录和验收快照属于历史材料。

本文件管理插件仓库；[论文工作区 AGENTS 模板](assets/workspace-skills/AGENTS.md) 和 [配套技能模板](assets/workspace-skills/) 是插件部署给论文 Agent 的材料，两者职责不同。开发资料统一放在 [agent-docs](agent-docs/README.md)，随 Git 同步；若手中只有不含该目录的 npm 安装包，按对应分支或 tag 从 [源码仓库](https://github.com/qianxi-00/dsh-paper-workbench) 查阅。

## 1. 开工与交付

1. 确认实际工作目录、Git 分支和未提交修改；保留用户已有改动。机器路径、DSH 安装目录、profile 和论文库位置从当前环境确认。
2. 根据下表读入口、共享函数及其调用方，明确本次涉及的数据、会话和后台任务。修改前能说明触发条件、当前行为与预期行为。
3. 在最小共享路径上修改，匹配现有风格；复用已有能力，不附带重构。新增逻辑要有适当的可运行验证，文档改动核对事实、路径和命令。
4. 交付前检查最终 diff、验证退出码及跳过项；说明改了什么、依据是什么、哪些场景尚未验证。磁盘改动、自动化通过和宿主真机生效分别报告。

## 2. 项目边界

- **零 npm 依赖、零构建**：服务端使用 Node 内置模块；宿主客户端使用 DSH 注入的 React；阅读器使用原生 ES/DOM 和本地 KaTeX。PDF 操作由 Python + PyMuPDF 子进程完成。新增能力优先沿用这些边界。
- **原生会话**：右栏由 `sessions.retain()`、精确的 `SessionProvider` 引用和 `conversation.content` Factory 组成。模型、工具卡片、权限、上传、排队与停止交给宿主。接口缺失时展示能力诊断，不用自绘聊天冒充原生组件。
- **翻译隔离**：段落、章节、全文、标题和划词翻译使用独立 AI 通道，不写入 Agent 聊天历史。持久译文进入插件数据层；划词翻译不写段落译文缓存。保留独立调试模式的兼容聊天路径，不将它接到原生会话界面。
- **作用域隔离**：工作台对话和宿主会话一一关联。论文范围只注入目标 Agent，论文标题、正文和附件作为用户引用材料处理，使用 `interpolate: false`。
- **能力降级**：SQLite 不可用时使用同契约 JSON 引擎；模型、原生会话和云端服务分别按实际可用性工作。没有模型或 OCR 配置时应明确缺失能力，不承诺所有功能可用。

## 3. 按任务阅读

按任务范围选读下表；修改接口、模型或共享路径时，连同对应调用方和测试一起读。

| 修改范围 | 主要源码 | 契约与验证入口 |
| --- | --- | --- |
| 宿主加载、服务注入、RPC、SSE、认证 | [index.js](lib/index.js)、[server.js](lib/server.js)、[sse.js](lib/sse.js) | [v3](docs/v3-contracts.md)、[原生契约](docs/v8-native-session.md)；[认证测试](scripts/test-host-auth.mjs)、[安全测试](scripts/test-safety.mjs) |
| 原生会话、工作区、论文作用域 | [client.js](lib/client.js)、[conv.js](lib/conv.js)、[session.js](lib/session.js)、[paper-context.js](lib/paper-context.js) | [原生契约](docs/v8-native-session.md)；[作用域测试](scripts/test-paper-context.mjs)、[原生集成夹具](scripts/test-native-workbench.mjs) |
| 阅读器、选区、标注、PDF 交互 | [app.js](assets/app/app.js)、[样式](assets/app/style.css)、[页面壳](assets/app/index.html) | [使用指南](docs/guide.md)；[阅读桥测试](scripts/test-reader-bridge.mjs)、[标注与 UI 测试](scripts/test-annotations-and-ui.mjs) |
| 文献入库、配置、文件、数据库与迁移 | [store.js](lib/store.js)、[db.js](lib/db.js)、[db-backend.js](lib/db-backend.js)、[PG](lib/db-pg.js)、[MySQL](lib/db-mysql.js) | [v3](docs/v3-contracts.md)；[存储测试](scripts/test-store.mjs)、[数据库测试](scripts/test-db.mjs)、[协议与迁移测试](scripts/test-db-drivers.mjs) |
| PDF 提取、文档、目录、配图 | [pdf.js](lib/pdf.js)、[pdf_tool.py](assets/pdf_tool.py)、[doc.js](lib/doc.js)、[figures.js](lib/figures.js) | [v2](docs/v2-contracts.md)；[文档测试](scripts/test-doc.mjs)、[目录测试](scripts/test-toc-structure.mjs)、[PDF 质量测试](scripts/test-pdf-quality.py) |
| 云端 OCR、版面、坐标、归档、离线重建 | [ocr.js](lib/ocr.js)、[layout.js](lib/layout.js)、[layout-ir.js](lib/layout-ir.js)、[表格](lib/layout-table.js)、[归档](lib/layout-archive.js) | [v4](docs/v4-layout.md)、[v7](docs/v7-quality.md)、[质量评测说明](docs/quality/README.md)；[IR 测试](scripts/test-layout-ir.mjs)、[批次与恢复测试](scripts/test-layout.mjs) |
| 翻译、并发、恢复、自检与日志 | [ai.js](lib/ai.js)、[translate-jobs.js](lib/translate-jobs.js)、[review.js](lib/review.js)、[jobs.js](lib/jobs.js) | [v2](docs/v2-contracts.md)、[v3](docs/v3-contracts.md)；[AI 测试](scripts/test-ai.mjs)、[翻译任务测试](scripts/test-translate-jobs.mjs) |
| 中文版 PDF 与补译任务 | [zhpdf.js](lib/zhpdf.js)、[zhpdf-jobs.js](lib/zhpdf-jobs.js)、[pdf_tool.py](assets/pdf_tool.py) | [v6](docs/v6-zhpdf.md)；[生成测试](scripts/test-zhpdf.mjs)、[持久任务测试](scripts/test-zhpdf-jobs.mjs) |
| 讲解、Agent 工具、工作区技能、Obsidian | [explain.js](lib/explain.js)、[tools.js](lib/tools.js)、[workspace-skills.js](lib/workspace-skills.js)、[obsidian.js](lib/obsidian.js) | [工作区模板](assets/workspace-skills/)；[讲解与技能测试](scripts/test-explain-skills.mjs)、[Obsidian 测试](scripts/test-obsidian.mjs) |
| 检索、订阅、代理与浏览历史 | [arxiv.js](lib/arxiv.js)、[net.js](lib/net.js)、[history.js](lib/history.js) | [检索分页测试](scripts/test-search-pagination.mjs)、[代理测试](scripts/test-net-proxy.mjs)、[历史测试](scripts/test-browse-history.mjs)、[缓存安全测试](scripts/test-feed-cache-security.mjs) |
| 安装、自检、维护与发布 | [安装器](scripts/install-agent.mjs)、[自检核心](lib/doctor.js)、[文库审计](scripts/audit-library.mjs)、[批量版面](scripts/batch-layout.mjs) | [CI](.github/workflows/ci.yml)、[发布流水线](.github/workflows/release.yml)；[安装测试](scripts/test-install-agent.mjs)、[发布安全测试](scripts/test-release-safety.mjs) |

## 4. 状态、身份与持久化

| 身份或状态 | 归属与维护要求 |
| --- | --- |
| `paperId` | 文献库记录；本地默认 link，在线下载和上传使用 copy。入库按路径、内容 hash、arXiv ID、DOI 等查重；删除先进入回收站。 |
| `c-*` / `sessionId` | 工作台对话保存论文关联和权威宿主会话 ID，新会话通常为 `pb-conv-*`，保留已有历史 ID。切换阅读论文不自动切换或新建对话。 |
| 阅读定位 | 论文、页、节、`blockId`、revision；只允许指向对话已关联论文。块失效或 revision 不符时退回请求页，不猜相近块。 |
| 段落 / 标题 hash | 16 位 SHA-1 内容键。段落按 kind 和归一化文本计算，保留正文大小写，不包含页码和顺序；标题折叠大小写，译文标题键加 `t:`。 |
| `blockId` / revision | 前者定位版面块，后者标识版面版本；与译文内容键分开维护。文字修正可能改变译文键，重建不模糊搬迁旧译文。 |
| 后台任务 | 每篇翻译或中文 PDF 有自己的持久记录、阶段和控制器；界面订阅不是任务所有权。 |

- 默认数据目录为用户主目录下的 `.dsh/paper-workbench`，可由 `DSH_PAPER_WORKBENCH_DATA` 覆盖。该变量必须在导入存储模块之前设置，模块求值后目录已固定。
- 配置、索引、元信息、文档和 UI 状态等由文件层管理；译文、任务事件、自检、富标注和研读笔记由统一数据库后端管理。SQLite/JSON/PG/MySQL 保持业务契约一致，修改一层时核对全部适配器及迁移路径。
- 保留原子写与串行读改写；索引、配置、会话和 UI 的共享队列需跨模块重载生效。译文并发落盘用 `mergeTrans` 增量合并，完整替换另走显式快照接口。
- 文档缓存涉及 PDF 指纹、目录指纹、解析 build、layout revision 和标注锚点版本；版面正常读取仍有 size/mtime 判定，不能据“保存过 hash”推断所有缓存均做内容校验。旧模型降级返回时保留 `stale` 信息。
- 标注只在原文摘录全篇唯一、目标身份也唯一时自动迁移；重复、失踪和译文标注进入 `annotationReview`。保留最早已知旧 revision，不猜测覆盖。
- Obsidian 按整张卡片串行读改写，保留未知 frontmatter、注释、换行和未受管内容，写前备份。工作区技能只更新受管 marker 区和模板文件，保留用户在 marker 外的指令。

## 5. 子系统契约

### 原生会话与阅读桥

- `sessions.retain()` 返回的精确 reference 就绪后才能挂载 `SessionProvider`；切换、收起和卸载执行幂等 `release()`，不调用后台 Agent 取消。
- 快捷提交经 `session.prepare`、作用域设置和 session 选择后才发送。`beginSubmission` 与原生 `prompt` 使用同一 requestId，失败清理乐观提交，不自动重发可能已接收的提问。
- 系统提示词服务先尝试 `agentPresets.serviceFor(agent, 'systemPrompt')`，再尝试 `agent.ctx.get('systemPrompt')`；组装时严格检查 `assembly?.scope === agent`，并处理 Agent 创建、释放与宿主卸载。
- `postMessage` 两侧校验来源窗口、同源、`__pb === true`、`v === 2` 和消息类型白名单。generation / selectionVersion 是宿主异步选择与提交保护，不是所有消息自带的协议字段；跨 await 后继续核对论文、对话和目标 session。
- 原生文件上传 receipt 只交给对应 session；超长选段完整保留，由现有流程选择全文或附件。读图、裁剪、切论文等异步结果按 `openSeq` 和论文 ID 丢弃旧结果。

### 翻译与讲解

- 持久翻译按同节分批、文档 FIFO 派发；配置并发范围 1–100，默认 10。遇限流退避并缩小活动窗口，连续成功后逐步恢复；保留截断增额重试、JSON 提取和逐段兜底。
- 一篇论文同一时刻只运行一个持久翻译。页面断连和 `/translate/follow` 取消只退订；显式暂停才 abort。普通翻译冷启动由 running 转 paused，继续时只补缺译并保留原 scope。
- 划词翻译附所在段上下文消歧，不覆盖整段译文。翻译质量自检是静态规则加可选 LLM 审校；模型失败保留静态结果并报告降级。
- `paper_explain` 先组织焦点、全文和周围图表公式，再解析命中图片；默认预算 120000 字符，按优先级裁剪并显式报告 truncated。选区清洗恢复 `data-tex`，去除工具、另一语言侧和批注标签，保持公式源码。

### PDF、版面与中文版

- Python 桥使用 JSON 协议、超时、输出上限和取消控制；解释器先取配置，再探测环境候选。双栏、旋转、cropbox、跨页和数学 span 改动必须验证，坐标统一到渲染后的 PDF pt，避免对 PDF 行再次旋转。
- 版面 IR 是确定性纯构建器，汇合云端结构与本地 PDF 行证据。每行有唯一归属或带理由排除；保留 sourceBlocks、candidates、行账和图注关系。表格 HTML 转为数据网格，算法保留行与缩进。
- 云端批次先检查实际页数、唯一页号和范围，再更新断点。partial 保留远端 jobId 与完成页，尽量续拉而非重传；远端提交成功但 jobId 未落盘仍有重复提交窗口，不能承诺 exactly-once。
- raw 按 SHA-256 不可变归档并在读取时校验；输入与 revision 不原地覆盖，先写证据再原子切 current 指针。兼容投影失败不撤销权威版本，清除当前版面不删历史证据。
- 发布接受 `passed` 和 `needs_review`，拒绝 `failed`；blocking / informational 是问题分类，blocking 计数本身不是发布硬门槛。行守恒只证明证据归属，不等于文字和排版正确。
- 中文 PDF 按原文行框覆盖，不做自由重排；缺译、定位不唯一或无法完整写回就停止。body/heading/caption/list/footnote 需译文，作者行、公式、图片、表格和算法保留；目录标题另计覆盖。
- 中文 PDF 先暂存，要求写入块数等于预期、skipped 为 0、产物有效，并在生成前后检查源、文档和译文。全部通过才替换，记录保存失败回滚，回滚失败保留备份。其 running 任务启动后可恢复，与普通翻译重启暂停不同；显式 paused 等继续。

### 检索、历史与代理

- 分页 cursor 绑定查询、来源和批量大小；两源独立推进，失败源保留重试位置并返回部分失败原因。检索限流、礼貌队列及重试策略按当前分支源码核对；本地未合入修复与远端已发布行为的差别见 [项目状态](agent-docs/memory/project-state.md)，不得将工作分支能力写成稳定版保证。
- 未入库的检索与订阅结果不落盘；浏览历史仅保留有界的最小书目信息，拒绝凭据 URL，去掉 query/hash，并以 DOI/arXiv/url/paperId 别名去重。
- 网络统一走代理适配层，支持 auto/custom/direct、环境变量与系统代理。保留 loopback 绕过、跨源重定向移除凭据、TLS 校验、超时与取消；错误中脱敏代理认证信息。

## 6. 安全与用户数据

- DSH 路由的第一道边界是 `connection.requestRejection(req)`：仅 `undefined` 放行；401/403 保留，服务缺失、异常或其他拒绝值返回 503，在读取 body 前拒绝。Host/Origin 检查是额外边界，不能替代宿主认证。
- HTTP handler 保持 loopback Host、有 Origin 时为 HTTP loopback、Sec-Fetch-Site 约束、body 上限和静态路径防穿越。保留 GET/HEAD、PDF Range 和同 reqId 流取消的并发语义。
- 论文 ID 经 `store.assertId` 校验，当前模式为 `/^[a-z0-9][a-z0-9._-]{0,79}$/`；其他路径按所属根目录及必要的真实路径边界检查。RPC 元信息更新维持白名单，禁止借元信息重定向源文件或知识库路径。
- 外部 HTML 先解析为纯数据再安全渲染；凭据不进入源码、测试、日志、归档或前端配置。错误使用可操作的中文，代码标识符使用清晰英文，不向用户暴露裸堆栈。
- 测试、假模型和样本生成只使用临时库。真实云端处理、文库修复、数据库导入迁移在用户任务授权范围执行；先检查备份与恢复路径。外部数据库的连接测试会创建并删除探针表，不能当作纯只读查询。

## 7. 验证与本机调试

**先隔离数据，再运行命令。** 以下环境变量在导入前设置；空 OCR token 避免常规回归触发真实上传，合成样本开关用于可重复的 PDF 验证。

PowerShell：

```powershell
$env:DSH_PAPER_WORKBENCH_DATA = Join-Path $env:TEMP ("pb-test-" + [guid]::NewGuid().ToString("N"))
$env:PYTHONUTF8 = "1"
$env:PB_FORCE_SYNTH_SAMPLE = "1"
$env:PADDLE_OCR_TOKEN = ""
npm test
```

Bash（Windows 下由 Node 生成工具可识别的临时目录路径）：

```bash
export DSH_PAPER_WORKBENCH_DATA="$(node -e 'const o=require("node:os"),p=require("node:path"),c=require("node:crypto");process.stdout.write(p.join(o.tmpdir(),"pb-test-"+c.randomUUID()))')"
export PYTHONUTF8=1 PB_FORCE_SYNTH_SAMPLE=1 PADDLE_OCR_TOKEN=
npm test
```

- `npm test` 还会自动执行 `posttest`，包含中文 PDF 任务和批量版面回归；不维护易过期的测试套件总数。按改动先跑对应脚本，相关检查通过后再按范围跑全套。
- 环境诊断用 `npm run doctor`；独立假模型调试用 `npm run dev:mock`。后者仅在未显式配置数据目录时默认使用临时库，启动前仍检查 `DSH_PAPER_WORKBENCH_DATA`。独立服务器不证明 DSH 认证与原生会话接入成功。
- 全套中部分 arXiv/OpenAlex 用例会联网，失败可能记 SKIP；真实 OCR、真实 Vault 和本机论文样本也可能跳过。逐项阅读跳过原因，不将 exit 0 等同于所有外部能力已验收。
- 原生会话测试使用假宿主/轻量 DOM，数据库协议测试使用模拟服务；Python 质量测试真实执行 PyMuPDF，但主要使用合成 PDF。当前宿主 Factory、真实上传回执、模型附件、实际数据库及云版面分别需要对应环境验证。
- 真实论文质量评测按 [质量评测说明](docs/quality/README.md) 和 [gold schema](docs/quality/gold-schema.md) 区分 fixture 与人工 gold；未完成人工标注前，不报告真实字符召回率、表格质量等验收分数。
- 文库维护先用 `npm run library:audit` 做默认离线只读审计；`--rebuild`、批量云版面及其他 `--apply` 会改变数据或产生云调用，执行前读对应脚本参数、备份和中断恢复逻辑。离线修复缺证据时报告 needs-cloud，不自动调用付费服务。

## 8. Agent 资料、计划与交接

协作资料统一维护在 [agent-docs](agent-docs/README.md)，纳入 Git 并随开发分支同步到远端。会话开始先读目录入口与 [项目状态](agent-docs/memory/project-state.md)，按任务选读详细资料。

| 分类 | 入口与用途 |
| --- | --- |
| memory | [架构与源码索引](agent-docs/memory/architecture.md)、[项目状态与证据](agent-docs/memory/project-state.md)：稳定事实、决策依据、已知边界 |
| plans | [计划规则](agent-docs/plans/README.md)：多步骤工作的范围、依赖、方案与验收；[本轮计划](agent-docs/plans/2026-11-20-agent-docs-and-release-audit.md) |
| tasks | [任务规则](agent-docs/tasks/README.md)、[维护 backlog](agent-docs/tasks/2026-11-20-maintenance-backlog.md)：状态、阻塞、下一步、验证与交付证据 |
| handoffs | [交接规则](agent-docs/handoffs/README.md)、[接手快照](agent-docs/handoffs/2026-11-20-project-onboarding.md)：跨会话所需的当前目标、分支、未完事项和引用 |
| operations | [仓库、市场与发布运维](agent-docs/operations/release-and-distribution.md)：远端目录、收录渠道、CI/CD、打包和安装部署 |

- 跨会话或多阶段工作记录计划和任务；简单修改可补现有条目。稳定文件用固定名称，阶段记录用 `YYYY-MM-DD-topic.md`。完成时补命令、退出码、跳过项和交付位置；修复后更新当前状态。
- 事实、静态推断和待验证项分开，注明日期、分支/提交及来源。根指南保留约束与入口，详细事实只在对应文档维护，避免重复和历史堆积。
- 旧 [docs/plans](docs/plans/) 保留历史入口，新计划放新目录；接口契约仍归 docs，用户指南和 CHANGELOG 保持各自职责。不得把本目录自动部署进论文工作区。
- 只保存可公开资料，不存凭据、个人路径、聊天全文、论文正文、文库备份、日志转储或临时产物。当前 npm 白名单不含本目录，Git 同步与 npm 打包分别核对；源码安装仍可能带入这些公开文件。

## 9. 宿主加载、Git、市场与发布

- 查明插件通过 link 还是 copy 安装，确认运行进程实际加载的目录。静态阅读器文件通常刷新视图即可生效；服务端和客户端模块需重新加载 bundle 或重启宿主，再在现有 DSH 地址验证。
- 兼容依据是当前公开服务接口与能力检测。可选服务缺席时走已有 fallback，宿主认证缺席时拒绝访问；涉及 DSH API 先核对当前版本文档，不从仓库路径推断宿主安装布局。
- 核心分支为 `dev`、`test`、`prod`、`main`，合并方向 `dev → test → prod → main`；`main` 展示稳定发布。日常从 dev 开临时 `agent/<topic>`，不直接向 test/prod/main 提交。提交前核对身份 `Qian Xi <1964055097@qq.com>`，使用语义化前缀说明目的或根因。
- 本仓库 [CI](.github/workflows/ci.yml) 对四核心分支的 push、目标为这些分支的 PR 和手动运行执行三系统 × Node 20/22 验证。仅 push `agent/*` 不触发该 push CI；文档合入 dev 也会验证。
- [Release](.github/workflows/release.yml) 由 `v*` tag push 或手动运行触发，测试门后打包；有 NPM_TOKEN 时按版本查询与完整性结果决定是否发布 npm 并附 provenance，随后创建或更新 GitHub Release。tag 必须匹配包版本，约定在 prod 发布点打 tag；当前工作流不强制标签来源分支。
- **分发检查**：涉及市场登记、版本同步或收录结论时，先读 [发布运维](agent-docs/operations/release-and-distribution.md#四源检查与后续版本维护)，再运行其中的只读检查。各源登记方式、当前证据及恢复条件集中维护在那里。
- 包发布、市场索引刷新、用户机器安装与宿主重载分别验证。当前工作流没有自动更新第三方目录或部署用户 profile 的步骤；一行安装器和本地安装器的来源、版本锁定、link/copy 与校验范围见发布运维。
- 临时分支合并后清理自身 worktree 和本地/远端临时分支，保留用户未合并工作。推送先确认 Git Forge 授权及任务范围；提交、同步文档、版本发布与本机安装分别按用户授权执行。

## 10. 当前状态与验证记录

日期化基线、已知风险、真实验收边界和来源统一保存在 [项目状态](agent-docs/memory/project-state.md)，可执行后续项在 [维护任务](agent-docs/tasks/2026-11-20-maintenance-backlog.md)。涉及版面重建、取消/VL、原生 UI 或发行渠道时先核对相应条目及源码；历史通过记录不能替代本次变更的验证。
