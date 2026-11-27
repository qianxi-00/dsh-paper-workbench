# QIAN-83 / #15：copy 安装保护同源目录

状态：本地回修验证通过，待新 head 独立验收。基线：`dev@418ff419ebf8180044bee41423b47406e5d42313`。远端与独立验收以 QIAN-83 本次线程和本分支 PR 为准。
Lane key：`QIAN83-01a21a97-75df-7e09-9265-81248982a13c:Open-A`。

范围仅为 `scripts/install-agent.mjs` 的同源判定及候选引入的入口回归、`scripts/test-install-agent.mjs` 及本记录。#16 在另一个从 dev 开始的独立分支处理。不调整定时、metadata、公开接口或依赖，不合并和关闭 issue。

## 已验证事实与方案

- 正文原探针已原样提取，在三个独立 Node 进程中均为 `1 PASS / 1 FAIL`、exit 1：精确同路径对照正常，Windows 大小写别名返回 `ok:true` 但删除源 package/哨兵，目标也无 package。
- 已检查 CLI `main → parseArgs → runInstall → copyPackageTree/safeRemovePath`；copy 分支对 plugins 和 node_modules 仅用 `path.resolve` 字符串判断同源，link 分支已使用 realpath。
- 优先假设是路径别名导致错误删除；若是复制过滤本身错误，普通不同目录对照也应失败；若是配置备份错误，不应只在别名源上丢失包文件。用实际源文件、真实 CLI 和不同源对照区分。
- 在 copy 和 link 的同源判定中复用一次异步 `fs.realpath` 得到的源身份，不对所有平台转小写；保留备份、用户字段、dry-run 和包校验。目标不存在时仍按普通复制处理；copy 的真实路径解析错误直接拒绝，link 的既有错误处理保持。

## 步骤与检查

- [x] 查现有分支、提交、开放 PR 和 lane key；均未发现本缺陷的活动实现。同步 dev 并创建 `agent/qian83-15-copy-source-identity`。
- [x] 正文原探针运行三次，保存原始命令、输出及 exit。
- [x] 在既有安装测试使用两个真实源位置（plugins/node_modules），覆盖精确路径、Windows 大小写和 junction/目录链接别名。断言源 package、普通哨兵及复制排除的本地文件均存活；安装目标 package 可解析。先运行 `node scripts/test-install-agent.mjs` 记录红测。
- [x] 最小修复同源判定；重新运行原探针和安装回归，验证不同源、dry-run、link、备份及用户字段现有用例仍通过。
- [x] 在导入前设置临时数据目录、空 OCR token、合成 PDF 和命令局部外网拦截器，执行离线 `npm test`（含 posttest）；逐项核对 SKIP 与环境错误。
- [x] 自查规范与 #15 契约、diff、两份代码的 `node --check`、`git diff --check`、Git 状态及提交身份；提交前再次查询未发现活动 PR。

## 实际验证与边界

- 安装回归初次红测：`17 PASS / 4 FAIL`、exit 1；两类源的大小写和 junction 均抓到源文件删除。同步 realpath 候选仅修好 junction，为 `19 PASS / 2 FAIL`；本机读回确认同步路径保留输入大小写，异步 realpath 返回规范同源路径。随后添加的 link/node_modules 大小写用例也为红（`19 PASS / 3 FAIL`）。保留全部原始失败收据，没有冒充初次全绿。
- 首个候选 `node scripts/test-install-agent.mjs` 为 `22 PASS / 0 FAIL`、exit 0；本机两个 junction 用例均实际执行，没有跳过。正文原探针为 `2 PASS / 0 FAIL`、exit 0，源包/哨兵与安装目标全部存在。
- 首个候选全套离线 `npm test` 于 2026-11-27 01:44:25–01:50:27 UTC 运行，exit 0；主回放 `260/0`、旧版回放 `164/0`、版面模型 `116/0`、页身份 `32/0`，Python 质量 10 项与自检通过；posttest 的发行状态 12 项、中文 PDF 任务 5 项、批量版面 1 项均通过。回放包含重复轮次，不相加为独立测试数。
- 全套跳过 11 项：在线检索/元数据/下载 6、未配置真实 Vault 1、本机 PDF 样本 3、真实 OCR 1。子进程测试已知沙箱不可用，本次直接在获准的沙箱外同样隔离执行，没有新增沙箱环境失败；这与前轮的 EPERM 收据区分。
- 本机 Node v24.20.0、Python 3.13.15。异步路径判定未增加依赖；三系统/Node 20、22 以新 PR CI 为准。测试均为临时假 Home/归档及合成 PDF，未访问真实文库或付费 OCR，不代表真实宿主已安装验证。

## Review 回修

QIAN-96 对首个 head `20d5e7083aadb26b5ccb3a65dfd94d41b33e891c` 发现 P2：移除 `realpathSync` 导入时遗漏末尾 isEntry 仍使用该绑定，CLI 经目录 junction 启动会 exit 0 却无输出。此前测试仅把别名传给 `--repo`，没有以别名启动 CLI；旧 head 六项 CI 通过不覆盖这个入口回归。

- [x] 在原安装回归通过真实 junction/目录链接路径启动 `--help --json`，先得到 `22 PASS / 1 FAIL`、exit 1（空 stdout 导致 JSON 解析失败）。正常路径正对照仍通过。
- [x] 仅恢复入口实际需要的 `realpathSync` 导入，保留异步同源判断；安装回归 `23 PASS / 0 FAIL`、exit 0，CLI 帮助 JSON 与正常路径一致，正文原探针仍 `2 PASS / 0 FAIL`、exit 0。本机新入口链接用例实际执行，无新增 SKIP。
- [x] 对回修代码重新执行两份语法检查、diff 检查及完整离线 `npm test`（含 posttest），2026-11-27 02:11:49–02:17:08 UTC、exit 0；主回放 260/0、旧版 164/0、模型 116/0、页身份 32/0、PDF 质量 10 项及自检通过，posttest 为 12、5、1 项通过。隔离参数与前次相同，仍为上述 11 个 SKIP。

远端交付沿既有 PR #17（base=dev）追加提交。新精确 head、diff、CI 快照及红绿日志回本轮指定评论；首个 head 被替代，旧 CI 或基线独立 red 不作为新 head 的独立 green。未知写入结果先对账并 hold。后续独立复测、合并及 Close 由部署流程负责。
