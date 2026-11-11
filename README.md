# dsh-paper-workbench

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：**论文工作台**。左侧导航新增一行「论文工作台」，把文献库、PDF 阅读器、整本翻译与本地 Obsidian 论文知识库串成一条工作流；AI 能力复用原生会话（agent 通过插件注册的工具读论文、翻译、写笔记）。

> 当前状态：0.1.x 开发中，接口与数据结构可能变动。

## 能做什么

- **文献库**：按专题整理论文；支持上传 PDF、按本地路径导入、从 Obsidian 卡片批量发现已有 PDF；删除进回收站。
- **阅读器**：页图 + 可选中文本层、目录、页内搜索、缩放、高亮与笔记（全部落本地）。
- **在线检索**：arXiv / OpenAlex 关键词、arXiv ID、DOI 检索，一键下载入库。
- **整本翻译**：由会话里的 agent 逐段翻译并写回 `zh.md`，面板「中文」页签边译边显示，中英对照。
- **理解与整理**：划词提问、精读报告（摘要/方法/贡献/局限/可复现要点）、多篇对比与主题综述。
- **Obsidian 联动**：直接读写已有「论文知识库」卡片（保留未知 frontmatter 字段，兼容 dataview 队列）。

## 安装（开发期）

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-paper-workbench
```

或在桌面端「插件」页安装本地包后重启。插件不引入任何第三方 npm 依赖，也不需要构建。

## 数据放在哪

- 插件数据：`~/.dsh/paper-workbench/`（索引、页图缓存、笔记、译文；可整体拷走）
- Obsidian：只写入你配置的「论文知识库」目录；写入前留 `.pb-backup.md` 备份
- 插件不向任何第三方服务发请求，除了你在界面上主动发起的 arXiv / OpenAlex 检索

## 宿主接口

| 路由 | 说明 |
| --- | --- |
| `GET /paper-workbench/app` | 工作台页面（iframe 内容） |
| `POST /paper-workbench/api/<method>` | JSON 接口：文献库、PDF 取文/渲页、检索、Obsidian |
| `GET /paper-workbench/api/health` | 安装自检 |

## Agent 工具

`paper_library`、`paper_read`、`paper_import`、`paper_search_online`、`paper_notes`、`paper_obsidian`、`paper_translate`。

## 已知限制

- 扫描件（无文本层）无法翻译，插件会明确提示，不做 OCR。
- 翻译目标为「可读」而非「PDF 版面重排」；双栏与公式可能按行拆开。
- 只支持公开可下载的 PDF（arXiv 等），不绕过任何付费墙。

## License

MIT
