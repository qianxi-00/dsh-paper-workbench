# Changelog

## 1.0.0 (2026-11-18)

首个正式稳定版本（v1.0.0）发布。

### 新增与改进
- **有序并发翻译 & 宿主后台持久化**：设置中支持 `1–8` 翻译并发度，严格按文档段落 FIFO 顺序并发调度请求，加速整篇/整节翻译；翻译调度器常驻宿主后台，切换界面、切换论文、离开工作台或切换 DSH 会话均不中断翻译，仅在显式点击「`⏸ 暂停翻译`」后暂停，并支持重启恢复后从断点「`▶ 继续翻译`」。
- **整篇上下文深度讲解与工作区 Skills/Tools**：新增 `paper_explain` 工具（默认 120,000 字符大上下文预算 + 焦点章节/选段上下文 + 自动匹配同页及跨页引用图表与表格）；提升 `paper_doc` 预算；扩展 `paper_notes` 支持自动沉淀结构化「AI 讲解与研读笔记」；工作区自动部署专属 `AGENTS.md` 与 `paper-explainer` / `paper-deep-digest` / `paper-literature-synthesis` Skills。
- **对照阅读富原文标注**：支持在对照正文/译文上进行 5 色高亮、下划线、加粗、可折叠 `💬` 批注气泡与 `‹+›` 插入注释、点击弹窗编辑/删改、按段或全篇清除标注；持久化于数据库并镜像进 `notes.json`，同时保证 `[data-tex]` 数学公式与选区复制整洁不破坏。
- **清晰的 Obsidian 联动边界与导入导出**：新增 `obsidian.enabled` 开关（新用户默认关闭，已配 Vault 老用户自动迁移维持开启），关闭后界面隐藏「卡片」页签与 Obsidian 状态；提供通用的**递归目录批量导入 PDF（按子文件夹自动分类）**、**单篇研读归档导出 Markdown** 与 **全库/单篇 JSON 备份导入导出**。
- **在线订阅主题与最新论文 Feed**：设置内支持订阅 8 个预设科研方向及自定义关键词，在线检索页自动列出订阅主题标签与按时间倒序的最新论文 Feed。
- **零依赖多存储后端与一键迁移**：保持内置 SQLite（Node < 22.5 自动降级 JSON）默认零配置，同时新增纯 Node.js（`node:net`/`node:tls`/`node:crypto`）实现的 **PostgreSQL v3（SCRAM-SHA-256 / Extended Query）** 与 **MySQL v10（`mysql_native_password` / `caching_sha2_password`）** 驱动，支持连接与建表权限测试、一键跨库全量迁移与 JSON 快照备份恢复。
- **GitHub CI/CD & AI Agent 一键安装**：新增跨平台矩阵 CI（Ubuntu/Windows/macOS × Node 20/22）与 Tag 自动 Release 工作流；提供 `skills/install-dsh-paper-workbench/SKILL.md` 与跨平台 `scripts/install-agent.mjs` 安装器，支持复制 README 提示词交给任意 Coding Agent 自动安装。
- **工程与测试强化**：新增多数据库协议模拟测试、持久化并发翻译测试、深度讲解与工作区 Skills 测试、在线 Feed 测试、安装器测试与前端富标注 UI 综合测试；所有测试实现临时目录与合成 PDF 隔离，不依赖特定本地路径。
