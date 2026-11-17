# PDF 质量语料与独立评测

当前文件是候选来源与工具，**不是已经完成的质量基准**。30 篇原论文分为 24 dev / 6 holdout，RETRO 在 dev。出版目录中 29 篇共 719 页，RETRO 目录页数 unknown；实际采集的页数以缓存 acquisition.json 为准。当前（2026-11-17）缓存已有 30/30 篇、762 个物理页、约 70.7 MB，明细见 [ACQUISITION.md](ACQUISITION.md)。候选类别全部待人工视觉核验。80 页开发 gold 与 20 页盲测 gold 尚未完成，不能报告真实质量分数。

## 来源与许可

[candidates.json](candidates.json) 记录每篇固定 PDF URL、元数据页、许可来源、证据级别、family 与 split。[build_manifest.py](../../scripts/quality/build_manifest.py) 保存生成过程，默认拒绝覆盖已存在 manifest，避免重新生成时静默丢弃人工修订。

- JMLR v24 官方仓库固定 commit `585343b06f82ed9684c4dfc2731b7212a9b322f6`；[作者出版政策](https://www.jmlr.org/author-info.html#Publication)要求 CC BY。LiNGAM / HiClass / Benchmarking GNNs 首页已确认 CC BY 4.0，其他 JMLR 行保留 `CC-BY-version-unverified`，不能当作逐篇许可核验完成。
- PMLR v235 固定 commit `a6e7a82d46bf2f2e91bbb1f611453b53041007ef`；[FAQ](https://proceedings.mlr.press/faq.html)要求出版协议，[协议第2条](https://proceedings.mlr.press/pmlr-license-agreement.pdf)授予 CC BY 4.0，第3条要求原出版引用和链接。当前是出版政策级证据，未看到每篇已签署授权表。
- [RETRO arXiv 2112.04426v3](https://arxiv.org/abs/2112.04426v3)明确 CC BY 4.0。FlashAttention 2205.14135v2 与 Paraformer 2206.08317v3 的 arXiv 页面为 nonexclusive-distrib，未放进开放许可清单。
- Benchmarking GNNs 的 PDF 首页版权为2022、归属链接指向v23，而官网为2023/v24；保留这项差异，不自行纠正原始版权文本。

再分发前补齐署名（完整作者列表、标题、原出版链接和许可声明）；修改或合成时明示修改，保留原作归属。代码许可不能代替论文许可。本语料集中于英文机器学习论文，不能代表所有学科、语言和出版社。

## 采集命令

采集器本身只用 Python 标准库。页数计数可选调用本机已安装的 PyMuPDF 子进程，不会安装依赖；不可用时记录 `actual_page_count:null` 和原因，绝不借用目录页数。`--page-counter none` 可完全关闭此可选步骤。

从仓库根目录运行（PowerShell）：

```powershell
# 只检查计划，不创建缓存、不联网。
python scripts/quality/collect.py

# 已授权的公开语料下载；不会访问用户文献库。
python scripts/quality/collect.py --download --resume `
  --cache C:/Users/QianXi/AppData/Local/Temp/pb-quality-corpus-5b7bcee5 `
  --max-total-bytes 150000000 --max-file-bytes 25000000

# 只重试某几个候选。
python scripts/quality/collect.py --download --resume --ids jmlr-21-0321,pmlr-abhyankar24a

# 完全离线、自造小fixture验证；不运行HTTP服务。
python scripts/quality/test_cli.py
```

默认代理 `http://127.0.0.1:7897`，可用 `--proxy` 明确覆盖。只接受 HTTPS，重定向降级到 HTTP 会拒绝。每篇顺序请求，超时默认30秒；失败不自动紧密重试，应检查错误并遵守服务的重试要求后显式重跑。

预算使用十进制字节：150 MB 总缓存、25 MB 单文件。总量包括缓存内已有PDF；先检查 Content-Length，再流式限制实际字节。MIME 与 `%PDF-` 都检查，期望hash存在时必须匹配。首次成功文件记录 SHA-256、实际 URL、大小、页数方法与时间。已存在 PDF 必须有匹配 ledger，`--resume` 重算 SHA-256；无记录、hash冲突或源URL变化均拒绝覆盖。完成的文件可恢复跳过，断开的网络传输从头重试，不进行不安全的字节续传。文件先写唯一 `.part`，再用不覆盖的原子硬链接发布；失败清理自己的 `.part`。

同一缓存使用排他锁，崩溃后的 `.collect.lock` 需确认对应进程已停止再人工移除。发布PDF成功但ledger尚未记录就崩溃的情况会保守拒绝后续覆盖，必须人工核对。不要把缓存指向用户库。PDF本体、采集ledger与页清单均保留在独立缓存，不提交到仓库。

缓存输出：

- `acquisition.json`：实际获取的证据；不是人工版式核验。
- `last-collection.json`：本轮成功/失败明细。
- `pages-to-review.json`：由已测得页数生成的逐页清单。每页 `status:unannotated`，`verified_tags:[]`，没有伪造人工标签。**此文件会重新生成，人工标注应另存，不要编辑它。**


## 本地基线（不是人工 gold）

`node scripts/quality/score-layout.mjs <paperId> [--data=<数据根>]` 用 PDF 文本层做参照，输出字符比、行覆盖率、重复率与质量状态；实测记录见 [BASELINE.md](BASELINE.md)。它只用于同一篇论文不同版本的相对比较，不能替代本页下面的人工 gold 评测。

规则改进后可以用已归档的原始响应离线重建：`node scripts/quality/rebuild-layout.mjs <paperId>`（默认 dry-run；`--apply` 才发布为新 revision，不重新上传、不产生费用）。

## 人工采样与盲测

先确认30份原论文和至少240个不同原始物理页。使用 `source_sha256 + page_index_0based` 去重；扫描、编码变体不能额外计入独立论文数或原始页数。按整篇family切分，所有相邻页与变体必须继承split。候选预先固定24 dev / 6 holdout；盲测只表示预留，尚未建立或运行盲测gold。

推荐80 dev / 20 holdout的主类别配额分别为：单栏16/4、双栏16/4、跨栏12/3、公式12/3、矢量多子图8/2、复杂表8/2、合成扫描4/1、合成编码异常4/1。类别可有次标签，但不重复计算主配额。自然跨页表和合并单元格目前是明确缺口，需要视觉核验；找不到就补来源，不用推测标签凑数。跨页表以完整相邻页组处理。

可优先实看 HiClass p2、p4–5、p7–10、p12–15；Benchmarking GNNs p3、p14–21、p24–35、p40、p43–45、p48。这些是自动解析得到的图表线索，尚未作人工gold。单纯检测绘图路径不能证明整图是矢量或已正确分割子图。

合成扫描记录渲染器版本、DPI、噪声/旋转参数、随机种子和父页hash。编码变体记录具体ToUnicode变更，并核验渲染外观一致。所有合成项 `synthetic:true`，保留父family，单独报告结果。不能把合成跨页表当作自然跨页表的覆盖。

每页由一人对照渲染页标注，第二人独立核验并记录分歧裁决。实现方输出不能未经检查成为gold，两个解析器一致也不能视为正确。冻结guideline、gold文件hash、采样和匹配规则后才运行盲测。作者、复核者身份声明需要实际审计；CLI无法验证某人确实看过页面。

## Gold 与评测接口

[gold-schema.md](gold-schema.md) 是完整人工标注建议。当前 [evaluate.py](../../scripts/quality/evaluate.py) 实现最小只读基线：页级NFC字符CER、词实例召回/精度/重复率，以及已人工对齐ID后的阅读顺序、图注、表格、公式关系边P/R/F1。**尚未实现自动区域对齐、公式等价判定、LaTeX树比较、table-span独立评分、论文聚类bootstrap置信区间。**不提供一个掩盖缺失维度的综合质量分数。

CLI读取gold和prediction，仅向stdout写JSON。无gold输出 `not_evaluated` 且无metrics；`--require-gold`使该情况非零退出。gold不是独立人工/未冻结/空页集/缺少独立复核人都会拒绝评估。缺预测页进入分母并以空输出惩罚；重复page_id、预测源hash不符或多出未知页会报错。关系gold缺失与空列表含义不同：缺失→不评测，空列表→确实已标注无关系。未独立复核ID对齐时关系指标不出分。

```powershell
python scripts/quality/evaluate.py --predictions C:/path/predictions.json
python scripts/quality/evaluate.py --gold C:/path/frozen-gold.json `
  --predictions C:/path/predictions.json --require-gold
```

最小gold结构（这里只是字段说明，不是gold）：顶层 `kind:independent_human_gold`、`status:frozen`、`guideline_version`、`pages`。每页必须有 `page_id`、`source_sha256`、`status:independently_reviewed`、不同的 `annotator_id`/`reviewer_id`、`text`。可选 `words:[{text,bbox:[x0,y0,x1,y1]}]`、`reading_order_edges`/`caption_edges`/`table_edges`/`formula_edges`，边为 `[from_id, relation, to_id]`。坐标为已旋转后的页面左上原点pt，预测与gold使用同一坐标系。

prediction每页使用同样 `page_id`、`source_sha256`、`text`、words与关系数组。关系节点必须已独立映射到gold ID，并带 `alignment_reviewed_by`；不能仅把模型声称的对应关系当真值。文本CER不依赖节点ID。正文归一化仅NFC与CRLF→LF，公式符号不做NFKC折叠；词匹配要求归一化文字一致与IoU>=0.5，一对一最大匹配后多余同位预测计重复。相同文字但不同位置的合法实例不会被当重复。

自造fixture测试中的名字、文字与数值仅验证算法和失败分支，绝不计入真实人工页数或基准成绩。真实评测应按类别与原生/合成分别报告，再按论文family计算统计置信区间；目前工具只输出逐页与总体CER基础统计，不能冒称已完成整个评测协议。
