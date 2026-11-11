# dsh-paper-workbench

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：**论文工作台**。

左侧导航多一行「论文工作台」：左边是文献库，右边是 PDF 阅读器 + 中文版 + 笔记 + Obsidian 卡片。
插件**不做自己的 AI 对话**——所有「理解 / 翻译 / 整理」按钮都只是把一段带论文 id 的指令写进当前会话，
由会话里的 agent 调用插件注册的 `paper_*` 工具完成，结果落回本地库与你的 Obsidian 论文知识库。

> 状态：0.1.x，接口与数据结构仍可能变动。

## 能做什么

- **文献库**：按专题分组；上传 PDF、按本地路径导入、从 Obsidian 卡片反查原始 PDF 批量入库；删除进回收站。
- **阅读器**：整页渲染（按需渲染 + 预取下一页）、目录（PDF 书签，没有则按字号启发式）、全文检索、页内文本层可选可问、高亮笔记。
- **在线检索**：arXiv / OpenAlex，支持关键词、arXiv ID、DOI；一键下载开放 PDF 入库。
- **整本翻译**：agent 分批读原文、逐页翻译，用 `paper_translate` 写进 `zh.md`；面板「中文」页签边译边刷新。
- **理解与整理**：划词问 agent、双击段落解释、精读报告（摘要 / 方法 / 贡献 / 局限 / 可复现要点）、多篇勾选后生成对比综述。
- **Obsidian 联动**：直接读写已有「论文知识库」卡片；frontmatter **行级合并**（只改传入的键，保留未知字段、注释和书写风格），写前备份，幂等。

## 依赖

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| Python 3.10+ 与 `PyMuPDF`（`import fitz`） | 取文本/坐标、目录、渲页 | 仍能导入与阅读，但改为浏览器原生 PDF 查看器，无文本层/翻译 |
| Obsidian（CLI 在 PATH 上可选） | 定位 vault、打开卡片 | 「卡片」页签与写入功能不可用，其余照常 |

插件会自动探测 `F:\ProGramApp\Anaconda\python.exe` → `python` → `py`，也可在设置里手动指定路径。
不引入任何第三方 npm 依赖，客户端也不需要构建。

## 安装

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-paper-workbench
# 或在桌面端「插件」页添加本地包
```

安装后**重启桌面端**（宿主代码只在插件加载时执行一次；之后改代码需要重新启用插件或重启）。

## 用起来

1. 左栏点「论文工作台」。首次可以「按路径导入」一篇 PDF，或「在线检索」。
2. 选中论文：`原文` 看页图，`文本` 选字（浮出 问 agent / 翻译 / 高亮 / 复制），`中文` 看译文，`笔记` 管高亮，`卡片` 看 Obsidian 卡片。
3. 顶部按钮把指令写进**当前会话**输入框，回到对话点发送：
   - `精读整篇` → 七节报告 + 写入卡片「精读报告」
   - `整本翻译` → 分批读原文、逐页翻译、`paper_translate` 落盘
   - `导读` / `写入卡片` / `讲解本页` / `翻译本页`
4. 左栏勾选 ≥2 篇 → `对比综述` → 对比表 + 研究脉络，写入 `方向综述/`。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `paper_library` | 列/查/改/删文献库条目（`action=list/get/update/remove/topics`） |
| `paper_read` | 读正文（`pages="1-5"`）、目录、元数据 |
| `paper_import` | 按 `path` / `arxivId` / `doi` / `query` 入库 |
| `paper_search_online` | arXiv + OpenAlex 检索（不下载） |
| `paper_notes` | 读写高亮笔记 |
| `paper_obsidian` | 卡片 `status/scan/read/upsert/survey/search/open` |
| `paper_translate` | 把某一页译文追加到 `zh.md` |

## HTTP 接口

| 路由 | 说明 |
| --- | --- |
| `GET  /paper-workbench/app` | 工作台页面（主区 iframe 的内容） |
| `POST /paper-workbench/api/<method>` | JSON RPC，如 `library.list`、`pdf.text`、`vault.upsert` |
| `GET  /paper-workbench/api/page?id=&page=&scale=` | 页图 PNG（按需渲染，带磁盘缓存） |
| `GET  /paper-workbench/api/raw?id=` | 原始 PDF（支持单段 Range，供浏览器查看器） |
| `POST /paper-workbench/api/upload?name=` | 上传 PDF 原始字节 |

只接受本机 Host（localhost / 127.0.0.1 / [::1]）。

## 数据放在哪

```
~/.dsh/paper-workbench/
  config.json            # 设置（python 路径、vault/kb、存储方式）
  index.json             # 文献索引（原子写，保留 .bak）
  papers/<id>/           # 每篇一个目录
    meta.json
    paper.pdf            # storage=copy 时的库内副本
    text.json            # 文本块缓存（按源 PDF mtime+size 失效）
    notes.json           # 高亮
    zh.md                # 中文版（## p.N 分段）
  .pages/<id>/           # 页图缓存
  .trash/                # 回收站
```

- 默认 `storage=link`：只记原路径，不复制 PDF；可改成 `copy`。
- 写入 Obsidian 前会备份为 `<卡片名>.pb-backup.md`（只留一份），内容没变不落盘。
- 除你主动发起的 arXiv / OpenAlex 检索外，插件不向第三方发请求。

## 开发

```bash
npm run dev      # 独立调试服务器 http://127.0.0.1:57571/paper-workbench/app
npm run seed     # 塞几篇本机样例论文（幂等）
npm test         # 工具层 + Obsidian + arXiv + PDF 自检
npm run smoke -- http://127.0.0.1:57571   # 打一遍 HTTP 接口
```

`scripts/dev-server.mjs` 与宿主共用 `lib/server.js` + `createApi()`，因此这里调通的行为装进 DSH 后一致。

目录：

```
lib/index.js    宿主入口（路由 + API + 工具注册）
lib/server.js   HTTP 处理（宿主与 dev-server 共用）
lib/store.js    本地存储（索引/笔记/译文，原子写）
lib/pdf.js      PyMuPDF 子进程桥
lib/obsidian.js frontmatter 行级合并、卡片定位/写入、检索
lib/arxiv.js    arXiv Atom + OpenAlex 解析、PDF 下载
lib/tools.js    7 个 agent 工具（裸 JSON-Schema）
lib/client.js   左栏入口 + 主区 iframe 壳 + 把指令写入会话输入框
assets/app/     工作台 SPA（vanilla JS）
assets/pdf_tool.py  PyMuPDF 命令行协处理器
```

## 已知限制

- 扫描件（无文本层）不能翻译，也不做 OCR；阅读页图仍可用。
- 翻译目标是「可读」而非 PDF 版面重排，双栏与公式可能按行拆开。
- 只下载公开 PDF（arXiv / OpenAlex 开放获取），不绕过任何付费墙。
- 插件内部没有独立对话；会话里要有 agent 才能完成翻译/报告（这是设计选择，不是缺失）。
- 宿主代码改动不会热重载：改完需在插件页重新启用或重启桌面端。

## License

MIT
