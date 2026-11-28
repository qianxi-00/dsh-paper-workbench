# QIAN-115 / QIAN-107：配图清单内容身份

日期：2026-11-27。关联 [GitHub #23](https://github.com/qianxi-00/dsh-paper-workbench/issues/23)。
状态：实现与定向回归已验证，待精确 head 全套证据及非实现者验收；尚未合并或关单。
唯一实现 run：`01a21b3f-2bb9-714a-80e8-d4f82a38e77e`。
基线：`418ff419ebf8180044bee41423b47406e5d42313`，执行时官方 dev 与独立 checkout 一致。

## 根因与修改

`listFigures → resolveFigure → figurePath → pdf.callTool → pdf_tool.py render` 的清单缓存只比较 path/size/mtime，PNG descriptor 却记录当前 PDF 内容 hash。PDF 保持 stat 不变但位图移动后，形成当前 hash 与旧 bbox 的组合。图片入口、配图列表 RPC 和讲解模块均经过该共享路径。

`lib/figures.js` 在清单 source 中保存并比较现有流式 SHA-256 helper 的结果。旧清单没有该字段时重建一次；内容不变时继续复用。布局优先及其既有 stat/清除失效规则、PNG descriptor、原子发布、历史文件与失败清理逻辑保持原状。未增加依赖或改变接口。

`scripts/test-figure-cache.mjs` 新增真实合成位图位移回归：无布局文件，红图 x=140→340，相同 path/size/mtime；先访问默认图片入口，检查清单位置、红色像素、descriptor hash/bbox、稳定缓存不重写与历史 PNG 字节。

## 已验证证据

- QIAN-108 原附件校验：ZIP SHA-256 与交接一致，44/44 载荷长度及哈希一致；几何及边界探针未经修改。
- 原样 `probe-b-same-stat-geometry.mjs`：基线 exit1（自动 x=140、白色像素）；候选 exit0（自动 x=340、红色像素、正确 bbox）。refresh 只作诊断正对照。
- 新持久回归：旧实现 `8 PASS / 1 FAIL`、exit1，断言 `140 !== 340`；候选 `9 PASS / 0 FAIL`、exit0。
- `node scripts/test-figures.mjs`：38/0、exit0；原样边界探针：4/0、exit0。
- `node scripts/test-doc-layout.mjs`：13/0、exit0；`node scripts/test-explain-skills.mjs`：43/0、exit0。
- 修改文件的 `node --check` 与 `git diff --check`：exit0。无 lint/typecheck/build 脚本，本项目为原生 JS、零构建。
- 每个定向进程导入前设置独立临时数据与数据库路径、UTF-8、合成样本开关和空 OCR token。首次沙箱 spawn EPERM 与获准重跑证据分开保存。

最终 head、原样命令、全套 `npm test`/posttest 的实际结果和跳过项、CI 状态与原始日志在 QIAN-115 的证据附件及单一 base=dev PR 交付。负责人审阅后，由 QIAN-116 在独立 checkout 验收精确 head；QIAN-107 负责合并、合后验证及显式关单。

## 边界与回滚

流式内容校验每次读取 PDF，增加 O(PDF 字节数) I/O；大 PDF 性能未测。布局源内容身份的既有契约未扩展，不将本次无布局夹具外推为真实论文库、宿主 UI 或复杂论文验收。真实数据库、Vault、OCR/VL、屏幕阅读器及 CWV 未测。

未合并时撤回候选 PR 即可；合并后如需回滚，由负责人 revert 本任务提交并重新验证。旧 PNG 不删除；旧实现可忽略新增清单字段。无需迁移真实数据或清理用户缓存。
