# 论文工作台 · dsh-paper-workbench

[![Release](https://img.shields.io/github/v/release/qianxi-00/dsh-paper-workbench)](https://github.com/qianxi-00/dsh-paper-workbench/releases/latest)
[![npm](https://img.shields.io/npm/v/dsh-paper-workbench)](https://www.npmjs.com/package/dsh-paper-workbench)
[![CI](https://github.com/qianxi-00/dsh-paper-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/qianxi-00/dsh-paper-workbench/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**DeepSeek Harness 的论文检索与双语精读工作台。** 在 [DSH](https://github.com/deepseek-ai/deepseek-harness) 里找论文、管理文献库、对照阅读 PDF，并在同一界面向 Agent 询问引用的段落、公式或图表。

阅读器和 Agent 会话并排显示。右栏是 DSH 原生会话，使用宿主已有的模型、工具和附件；段落翻译则独立运行并保存到工作台，不写入聊天历史。你可以边翻译边读另一篇论文，也可以把右栏切到完整会话继续讨论。

[安装](#安装) · [快速开始](#快速开始) · [使用指南](docs/guide.md) · [版本记录](CHANGELOG.md)

## 核心功能

| 场景 | 功能 |
| --- | --- |
| 发现与入库 | arXiv / OpenAlex 搜索，arXiv 八大学科及自定义订阅，结果分页，找回打开过的论文，导入后手动分类。 |
| 阅读与翻译 | 双语、并排、原文、仅译文四种视图；整篇、章节和划词翻译；后台翻译可暂停、继续和重试。 |
| 原文与中文版 | 在 PDF 原文页选中文字、复制和引用；补齐译文并通过排版校验后，生成与原文页码对应的中文版 PDF。 |
| 原生 Agent 会话 | 从全文导读开始，也可把选段或框选的图表、公式作为上下文发送；原生会话可独立打开，不另起一份历史。 |
| 笔记与归档 | 原文高亮和批注、研读笔记、Markdown 导出、可选 Obsidian 联动。 |
| 扫描件与复杂版面 | 按需使用 PaddleOCR 识别扫描件、解析多栏和目录；保存处理结果与原始响应，便于断点续跑和离线重建。 |

## 安装

插件面向 DSH Desktop 和 Web，**零额外 npm 依赖、无需构建**。启用后在 DSH 侧栏打开 **论文工作台**。

### 方式一：让 Agent 一键安装

把下面这段发给能运行本机终端的 Agent（例如 DSH、Codex、Claude Code 或 Cursor）：

```text
请帮我安装或更新 DeepSeek Harness 的 dsh-paper-workbench 插件。
仓库：https://github.com/qianxi-00/dsh-paper-workbench
请先读取仓库内 skills/install-dsh-paper-workbench/SKILL.md，按系统选择一键安装脚本，先 dry-run 核对 DSH 安装根目录与 Desktop/Web profile，再安装最新正式发行版；如果已有本地源码且需要开发挂载，则用 install-agent.mjs 预览后安装。
完成后请检查 PyMuPDF，并告诉我安装到哪个 profile、如何重载插件、怎样打开论文工作台。不要改动已有论文库或其他插件配置。
```

Agent 可直接读取[安装技能](skills/install-dsh-paper-workbench/SKILL.md)。

### 方式二：在 DSH 设置或 CLI 安装

在 **设置 → 插件** 粘贴 `github:qianxi-00/dsh-paper-workbench`，或粘贴[正式 Release](https://github.com/qianxi-00/dsh-paper-workbench/releases/latest) 中 `.tgz` 附件的下载链接以安装确定版本。使用 Web profile 时，也可以运行：

```bash
dsh plugin --profile web add github:qianxi-00/dsh-paper-workbench
```

### 方式三：终端一行安装，无需克隆

Windows PowerShell 5.1+ / PowerShell 7：

```powershell
irm https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.ps1 | iex
```

macOS / Linux / Git Bash：

```bash
curl -fsSL https://raw.githubusercontent.com/qianxi-00/dsh-paper-workbench/main/scripts/install.sh | bash
```

脚本会探测 DSH 安装目录和 profile。安装前可[查看 PowerShell 脚本](scripts/install.ps1)、[查看 Bash 脚本](scripts/install.sh)，或按[安装技能](skills/install-dsh-paper-workbench/SKILL.md)中的命令预览、指定版本或 profile。

<details>
<summary>方式四：从源码安装或做本地开发</summary>

```bash
git clone https://github.com/qianxi-00/dsh-paper-workbench.git
cd dsh-paper-workbench
node scripts/install-agent.mjs --dry-run --json
node scripts/install-agent.mjs --json
npm run doctor
```

本地安装器默认链接源码；若要复制独立安装，使用 `--mode copy`。源码修改后的插件重载方法见[开发约定](AGENTS.md)。

</details>

### 环境要求

- **必需**：提供插件 HTTP 鉴权服务的 DSH，Node.js ≥ 20。原生右栏依赖 DSH 对应的会话服务，见[兼容说明](docs/v8-native-session.md)。
- **推荐**：Python 3.10+ 与 PyMuPDF（`import fitz`），用于页图、文本提取及中文版 PDF。启用后在 **论文工作台 → 设置 → 环境自检** 验证。
- **按需配置**：翻译模型、扫描识别 Token、网络代理和 Obsidian。云端识别会向所选服务发送待处理 PDF；不使用这些功能不需要配置相应服务。

## 快速开始

1. **找一篇论文**：导入本地 PDF，或在「在线检索」通过题名、关键词、DOI 或 arXiv ID 找到论文并入库。
2. **对照阅读**：打开论文，在「对照」中翻译目录或正文；也可以先读原文，再按段补译和批注。
3. **带着问题读**：从「全文导读」开始，或切到「原文页」框选一个公式或图表，再发给右栏 Agent。
4. **保留研究记录**：把结论存为研读笔记，导出 Markdown 或写到 Obsidian；需要离线阅读时可生成中文版 PDF。

## 文档与贡献

- [使用与配置](docs/guide.md)：任务、代理、存储、OCR 与备份。
- [原生会话](docs/v8-native-session.md) · [中文版 PDF](docs/v6-zhpdf.md) · [版面质量与离线重建](docs/v7-quality.md)。
- [开发与测试](AGENTS.md) · [报告问题](https://github.com/qianxi-00/dsh-paper-workbench/issues) · [变更记录](CHANGELOG.md)。

遇到问题时请附 DSH 和插件版本、复现步骤与脱敏日志，不要提交 API Key、会话历史或私有论文。贡献代码前请使用隔离的临时数据目录运行测试。

## 许可证

[MIT](LICENSE)
