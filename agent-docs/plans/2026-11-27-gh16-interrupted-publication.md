# QIAN-83 / #16：恢复中断后的语义等价归档发布

状态：实现与本地验证通过，待独立验收。基线：`dev@418ff419ebf8180044bee41423b47406e5d42313`。
Lane key：`QIAN83-01a21a97-75df-7e09-9265-81248982a13c:Open-B`。

范围仅为 `lib/layout-archive.js` 的共享 publish 路径、`scripts/test-layout-archive.mjs` 和本记录。独立分支 `agent/qian83-16-archive-retry` 不包含 #15 提交。不改定时、控制 metadata、schema、公开接口或依赖；不合并、关单。

- [x] 核对正文、评论增量、全部远端分支和开放 PR，未发现 B 的活动实现。同步 dev 并创建独立分支。
- [x] 正文原探针在基线独立进程三次均 `1 PASS / 1 FAIL`、exit 1：同时间戳对照正常，只有 at 不同时冲突。确认故障一次、input 存在、revision 不存在、旧 current 保留。
- [x] 检查 `publishDerived → publish → immutable/atomic`，以及 layout 的 refreshTables/refillV2 和离线 rebuild 调用方。既有完整 revision 已按去除 at/builtAt 后的语义判断，只有 input 的中断分支仍字节冲突。
- [x] 在现有归档回归通过真实 publishDerived 对指定 revision 写入注入一次 ENOSPC，立即恢复原 fs.writeFile，验证时间戳重试、旧 current、不可变原文件；`node scripts/test-layout-archive.mjs` 首次为 7 PASS / 1 FAIL、exit 1，最小修复后 8 PASS / 0 FAIL。
- [x] 统一完整发布和仅 input 留存时的既有语义检查。等价 input 不重写，缺失时仍使用原 immutable 写；真实冲突、损坏或不完整输入继续拒绝。保持 raw/hash、版本、质量和 current 校验。
- [x] 使用新 archive 实例重试，补 model、raw 来源、PDF 行、null/截断 input 及完整版本冲突保护；归档最终 14 PASS / 0 FAIL，正文原探针 2 PASS / 0 FAIL。focused：模型 116/0、页身份 32/0、行守恒 7/0、文库审计 13/0。
- [x] 离线 `npm test` 含 posttest 于 2026-11-27 01:59:07–02:05:09 UTC 跑完，exit 0。主回放 260/0、旧版 164/0、PDF 质量 10 项及自检通过；posttest 的发行状态 12、中文 PDF 任务 5、批量版面 1 项通过。轮次计数不相加为独立测试总数。
- [x] 按规范和 #16 契约自查限定 diff，两份代码 `node --check` 与 `git diff --check` 通过；提交前再查远端分支及全部同 head PR，均无已有 B 对象。提交/PR 的精确 head、diff、红绿收据与 CI 快照由 QIAN-83 指定线程记录，避免将自引用 SHA 写进提交。

环境与边界：Node v24.20.0 / Python 3.13.15；临时数据目录、合成 PDF、空 OCR token、命令局部外网拦截器（仅允许本地/既有 mock-origin 夹具）。11 个 SKIP 为在线 6、真实 Vault 1、本机 PDF 3、真实 OCR 1。文库审计首次在沙箱内因 `spawn EPERM` 阻断，获准以相同隔离参数在沙箱外重跑后 13/0；原错误保留。提交前的只读 Git 查询也在沙箱内遇到 `SEC_E_NO_CREDENTIALS`，获准沙箱外重跑读回 dev 未变、无 B 分支/PR。以上环境失败不计为初次全绿；无真实文库或付费 OCR 验收声明。

候选假设按证据排序：中断分支漏掉时间戳语义比较；输入字段排序不一致；残留锁/旧 current 阻塞。正文的仅 at 对照和 ENOSPC 精确窗口支持第一项；回归使用新 archive 实例重试，排除实例内状态依赖。只读已存证据并复用既有 semanticJson，不删除 input，不扩大被忽略字段，不弱化不可变约束。
