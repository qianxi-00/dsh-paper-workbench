# 通用对照实现接口（2026-11-17）

本文件约束并行写范围。根代理负责 lib/layout.js、lib/doc.js、lib/index.js、存储/任务和总接线。现有 LAYOUT_VERSION=1 字段继续存在，新增 schemaVersion=2 表明来源/质量模型；兼容读取旧版但标 legacy。模型raw只存原数据，不改写。

## 统一纯构建器：lib/layout-ir.js

导出 `buildDocumentLayout(input)`（同步纯函数），input：

```js
{
 source: { sha256, path, size, mtimeMs },
 pageCount, pageSizes: [{n,w,h,rotation?,cropbox?,nativeToRendered?}],
 servicePages: [{n,width,height,blocks,raw?,pageIdentity?,rawRef?,status?}],
 pdfPages: [{page,width,height,lines:[{x,y,x2,y2,size,bold,text}],error?}],
 supplementaryPages: [{n,width,height,blocks,raw?,rawRef?}], // VL1.6候选，可空
 model, jobId, at, rawRefs: []
}
```

输出兼容既有layout：`{version:1,schemaVersion:2,build:'ir-1',revision,at,model,jobId,source,pageCount,servicePages:<count>,warnings:[],blocks:[],figures:[],pages:[],quality:{status,issues,metrics},rawRefs:[]}`。

- revision = 对source.sha256 + 输入语义/raw引用 + 构建器版本的稳定hash，不含at或随机值。source缺hash要明确拒绝v2构建。
- pages每页都有 `{n,pageId,width,height,status,quality,blockIds,lineAssignments,unassignedLineIds}`。缺页也占位，status `ready|needs_review|failed`，不能被整体数组省掉。
- blocks每项有旧字段 `{page,order,kind,label,text,bbox:{x,y,width,height},level?,latex?,html?,table?,figureIndex?}`，新增 `{blockId,pageId,sourceHash,candidates:[{source,text,lineIds?,score?,rawRef?}],selectedSource,selectionReason,fragments:[{page,bbox,lineIds}],quality:{status,issues:[]},sourceBlockIds:[]}`。
- blockId与文字内容分离，取PDF hash+页+服务block_id(有)/几何身份。sourceHash为归一化选定原文hash。保留原始块id/order作为来源。源文字调整保持身份，实际重新分块改变身份不虚假迁移。
- kinds兼容 body/heading/caption/formula/figure/table/list/footnote。页眉脚不能无记录删除，放page.lineAssignments/排除记录；未知label不能静默丢失。
- 文本行只能一对一拥有。几何与文字一致性共同评分，不依赖遍历顺序贪心；保留候选、覆盖率、未匹配行；图内文字/表内字与正文区分。缺失正文在独立保留块内呈现并标needs_review，不抛弃。低信心不能默认passed。
- 图注与正文适用同一候选择优，扫描无PDF文字可选服务/VL；乱码不能称准确。未知模型分数null，指标为可测指标不代表groundtruth准确率。
- 公式去重需几何+内容证据，保留excluded原块；清理只能一次且幂等。同页合并必须正向相邻/同栏；跨页保留fragments。
- figures每项兼容 `{index,page,kind,label,bbox,caption,captionOrder,blockIndex}`，新增assetId/blockId/captionBlockIds。一图多图注/多子图允许，类型/几何不足不硬配，issue说明。
- 页尺寸比例偏差/预处理角度无法对应时不硬缩放发布；标needs_review并fallback原页。保存实际变换。假数据缺尺寸不能冒称ready。
- 可使用现有layout.js纯helper(动态入口集成，避免新增依赖)，不修改它。表格暂透传raw HTML与单元格元信息，网格修复另任务集成。

## 原始与版本存储：lib/layout-archive.js（root）

原始响应保存到papers/<id>/layout-data/raw/<sha256>.json；任务与版本输入manifest存此子目录；版本产物到revisions/<revision>.json，current.json原子切换。兼容layout.json仅作投影；读取优先current，旧记录备份后迁移保留。清理只移除current引用不删raw/历史。原始response/解析失败文本也归档，不持久化token。

## 任务接口（root）

高质量任务默认单页并发2、显式maxCloudPages上限（主结构+最多一次VL补充/页）。源文档sha256+模型参数形成任务版本；提交前记录submitting状态，拿jobId立即落盘；重启优先poll。submitting无jobId=uncertain禁止盲目重提。存档后可离线rebuild，不云请求。统一锁覆盖start/run/refill/clear/tables。

## 图缓存（quality-pdf-assets）

figurePath(id,index)兼容；每PNG按生成时PDF内容hash+页+bbox+倍率+渲染版本标识，原子写并单飞，改变框/图序不能复用旧图。新增v2字段若未集成，返回契约建议给root。

## 测试

公共纯构建器/runner、真实临时存储、pdf_tool命令与RPC边界。模拟仅云网络与宿主。所有测试自身先初始化临时数据根再import。金标准手写固定文字/关系，不用被测构建器生成expect。质量语料unknown要保留unknown。
