# Open B：主版面 OCR 取消透传

状态：completed（本地修复与验证）。日期：2026-11-26。远端交付与独立验收以 QIAN-83 本次指定线程及本分支 PR 为准。

- 来源：GitHub #12 / QIAN-83，lane key `QIAN83-01a21733-9d22-786c-b0b5-ca303571577c:Open-B`。
- 基线经官方 GitHub CLI 和 fetch 核对为当前 `dev@d6a0a9d06c7338d6c743f38da99364df6afc8864`。分派中的 `76fb76d` 是 Open A 合入前提交；新分支保留已验收的 Open A。
- 只改 `lib/layout.js` 主 OCR 调用边界及现有 `scripts/test-ocr-cancel.mjs` 回归；不改 OCR 协议、raw/发布质量校验、定时或 QIAN-70 配置，不合并/关闭 #12。
- 已检查 `runLayout` 调用方及 `lib/ocr.js`：三个 OCR helper 已支持 signal；runner 缺少透传。先以 caller signal 中断各活动阶段，再检查不进入后续 OCR、旧发布/partial 保留及 resume。

## 执行计划

- [x] 在既有取消回归中，通过真实 `createLayout().runLayout` → OCR helper → 假传输，分别复现提交、轮询和下载期间取消；有确定截止与清理，不遗留挂起操作。
- [x] 先记录红测；仅为主调用补齐 `opts.signal`，未修改 helper 或另加取消逻辑。
- [x] 运行取消回归、版面模型、页身份及回放；全套 `npm test` 沿用本任务的外网拦截器、隔离数据目录、合成样本与空 OCR token，记录跳过项。
- [x] 自查规范与 #12 契约、最终 diff、两份改动代码的 `node --check`、`git diff --check`、提交身份及分支。

## 本地验证结果

- `node scripts/test-ocr-cancel.mjs`：改生产代码前为 `PASS 10 / FAIL 3`、exit 1，三个新增用例分别报“取消后 runLayout 仍挂起：submit / poll / fetch”；透传后为 `PASS 13 / FAIL 0`、exit 0。
- 三个 runner 用例还校验同一 caller signal、后续 OCR 调用未发生、原 current 指针/兼容投影/正文不变、pending jobId 保留，以及新 signal 续跑；已知 jobId 时只 poll/fetch，不重新 submit。
- `test-layout-model.mjs` 为 `116 PASS / 0 FAIL`，包含早期有效批次 partial 和远端 jobId 续跑；`test-page-identity.mjs` 为 `32 PASS / 0 FAIL`，保留 Open A 及失败结果拒绝发布回归。
- 主回放 `260 PASS / 0 FAIL`，旧版回放 `164 PASS / 0 FAIL (legacy replay; zero OCR/network calls)`；这是包含重复轮次的脚本检查数，不相加为独立测试总数。OCR helper 常规回归 `13 PASS / 0 FAIL / 1 SKIP`。
- `npm test`（含 posttest）exit 0，运行时间 2026-11-26 12:34:20–12:39:17 UTC。Python 质量测试 10 项通过、自检 `ok:true`，中文 PDF 任务 5 项和批量版面 1 项通过。
- 全套明确跳过 11 项：在线检索/元数据/下载 6、未配置真实 Vault 1、缺少本机 PDF 样本 3、真实 OCR 1。未使用真实文库、付费 OCR/VL 或 QIAN-70 配置。
- 命令局部外网拦截器 SHA-256 为 `b3aa9dce89b4a64364992d70a7a4dc1fed6f65745fa0077397b096d10f76e457`，仅作为 QIAN-83 验证附件交付，不进入产品或运行配置。
- 首次主回放在沙箱因 `spawnSync node.exe EPERM` 为 `240 PASS / 20 FAIL`；获准在沙箱外使用相同隔离和拦截重跑后为 `260 PASS / 0 FAIL`。保留原始失败日志，不将其混为产品红测。
- 本地 Node v24.20.0、Python 3.13.15；Node 20/22 与三系统等待新 PR 的 CI，不继承 Open A 的 CI。

## 远端交付要求

推送 `agent/qian83-open-b-layout-cancel`，以 `dev` 为 base 创建引用 #12 和 lane key 的 PR，在 QIAN-83 本次指定评论下交付精确 head、验证与 CI 状态。由部署工程师独立复测、合并、合后验证和关闭 #12；本候选不执行这些步骤，QIAN-83 保持本轮实际状态。

不使用真实 OCR/VL 或文库；不将自动化夹具通过当成真实服务验收。远端写入结果不明时先读回，不盲目重试。
