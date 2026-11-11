/**
 * 给原生会话里的 agent 用的 7 个工具。
 *
 * 为什么工具要写得这么"啰嗦"：面板不做独立对话，所有理解/翻译/整理都由会话里的
 * agent 完成；agent 只有通过这些工具才能读写文献库、PDF 内容与 Obsidian 卡片。
 * 因此 description 里必须写清"什么时候用"和"参数怎么给"。
 *
 * 返回形状沿用 dsh-git-forge 的裸定义：execute 返回 { text, isError }，
 * output.schema/render 负责把它渲染成一条文本。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { DATA_ROOT, readZh, writeZhAppend } from './store.js'

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' }, isError: { type: 'boolean' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

function ok(value) {
  return { text: typeof value === 'string' ? value : JSON.stringify(value, null, 2), isError: false }
}

function fail(message) {
  return { text: String(message), isError: true }
}

/** "1-5,8" / "all" / 3 → 页码数组；非法返回 null。 */
export function parsePages(spec, total) {
  if (spec === undefined || spec === null || spec === '') return null
  if (String(spec).toLowerCase() === 'all') {
    return Array.from({ length: Math.max(0, Math.min(total || 500, 200)) }, (_, index) => index + 1)
  }
  const pages = new Set()
  for (const part of String(spec).split(/[,，]/)) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part)
    if (range) {
      const from = Number(range[1])
      const to = Math.min(Number(range[2]), from + 50)
      for (let page = from; page <= to; page += 1) pages.add(page)
      continue
    }
    const single = /^\s*(\d+)\s*$/.exec(part)
    if (single) pages.add(Number(single[1]))
  }
  return pages.size > 0 ? [...pages].sort((a, b) => a - b) : null
}

function formatPage(page) {
  const lines = (page.blocks || []).map((block) => block.text).filter(Boolean)
  return '### p.' + page.n + '\n' + lines.join('\n')
}

function truncate(text, limit = 48000) {
  if (text.length <= limit) return text
  return text.slice(0, limit) + '\n\n…（内容过长已截断，请用 pages 参数分段读取）'
}

export function createTools(api) {
  return [
    {
      name: 'paper_library',
      description:
        '论文工作台的本地文献库。列出/查看/更新/删除已入库的论文。' +
        '返回的每篇论文带 id，其他 paper_* 工具都用这个 id。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'update', 'remove', 'topics'],
            description: 'list=列全部；get=看单篇详情；update=改状态/优先级/标签/主题；remove=移入回收站',
          },
          id: { type: 'string', description: '论文 id（list 可省略）' },
          patch: {
            type: 'object',
            description: 'update 时的字段补丁，如 {"status":"read","priority":"high","topics":["RAG"]}',
            additionalProperties: true,
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        try {
          const action = String(args.action || 'list')
          if (action === 'list') {
            const value = await api['library.list']({})
            return ok({
              total: value.items.length,
              topics: value.topics,
              papers: value.items.map((item) => ({
                id: item.id,
                title: item.title,
                year: item.year,
                authors: item.authors,
                topics: item.topics,
                tags: item.tags,
                status: item.status,
                pageCount: item.pageCount,
                hasText: item.hasText,
                zhPages: item.zhPages,
                vaultCard: item.vaultCard,
              })),
            })
          }
          if (action === 'topics') {
            const value = await api['library.list']({})
            return ok(value.topics)
          }
          if (action === 'get') {
            const value = await api['library.get']({ id: args.id })
            return ok({
              meta: value.meta,
              outline: value.outline,
              hasText: value.hasText,
              notes: value.notes && value.notes.highlights ? value.notes.highlights.length : 0,
              zhChars: value.zhChars,
            })
          }
          if (action === 'update') {
            const value = await api['library.update']({ id: args.id, patch: args.patch || {} })
            return ok(value.meta)
          }
          if (action === 'remove') {
            return ok(await api['library.remove']({ id: args.id }))
          }
          return fail('未知 action：' + action)
        } catch (error) {
          return fail('paper_library 失败：' + error.message)
        }
      },
    },

    {
      name: 'paper_read',
      description:
        '读论文正文。mode=text 返回指定页的文本块（默认第 1-3 页，用 pages 指定范围，如 "1-5" 或 "all"）；' +
        'mode=outline 返回目录；mode=meta 返回元数据。读整本请分批，避免一次输出过长。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '论文 id' },
          pages: { type: 'string', description: '页码，如 "1-4" / "all"，默认 "1-3"' },
          mode: { type: 'string', enum: ['text', 'outline', 'meta'], description: '默认 text' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        try {
          const mode = String(args.mode || 'text')
          if (mode === 'outline') {
            const value = await api['pdf.outline']({ id: args.id })
            return ok(
              value.items.length === 0
                ? '这篇 PDF 没有书签，也没能启发式抽出标题；可以直接按页阅读。'
                : value.items.map((item) => '  '.repeat(Math.max(0, (item.level || 1) - 1)) + 'p.' + item.page + '  ' + item.title).join('\n'),
            )
          }
          if (mode === 'meta') {
            const value = await api['library.get']({ id: args.id })
            return ok(value.meta)
          }
          const meta = (await api['library.get']({ id: args.id })).meta
          const spec = args.pages === undefined ? '1-3' : args.pages
          const pages = parsePages(spec, meta.pageCount)
          if (pages === null) return fail('pages 参数看不懂：' + spec + '（示例 "1-5" 或 "all"）')
          const value = await api['pdf.text']({ id: args.id, pages })
          const body = (value.pages || []).map(formatPage).join('\n\n')
          const header = '《' + meta.title + '》 共 ' + meta.pageCount + ' 页，本次读取 ' + pages.join(',')
          return ok(truncate(header + '\n\n' + (body || '（这些页没有可提取文本，可能是扫描件）')))
        } catch (error) {
          return fail('paper_read 失败：' + error.message)
        }
      },
    },

    {
      name: 'paper_import',
      description:
        '把论文加入文献库。三种来源：path=本地 PDF 绝对路径；arxivId/doi=按编号抓取元数据并下载；' +
        'query=先在 arXiv/OpenAlex 搜一篇再入库（会自动取第一条）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地 PDF 绝对路径' },
          arxivId: { type: 'string', description: 'arXiv 编号，如 2205.14135' },
          doi: { type: 'string', description: 'DOI' },
          query: { type: 'string', description: '关键词：自动检索并入库第一条结果' },
          topic: { type: 'string', description: '归入的专题（可选）' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        try {
          if (args.path) {
            const value = await api['library.importPath']({ path: args.path, topic: args.topic })
            return ok({ id: value.meta.id, title: value.meta.title, existed: value.existed })
          }
          if (args.query) {
            const found = await api['search.online']({ query: args.query, source: 'both', limit: 5 })
            if (!found.items || found.items.length === 0) return fail('没有搜到「' + args.query + '」')
            const item = found.items[0]
            if (!item.pdfUrl) return fail('第一条结果没有开放获取 PDF：' + item.title)
            const value = await api['search.import']({ item, topic: args.topic })
            return ok({ id: value.meta.id, title: value.meta.title, arxivId: value.meta.arxivId })
          }
          const arxiv = await import('./arxiv.js')
          const meta = args.arxivId
            ? await arxiv.fetchArxivMeta(args.arxivId)
            : args.doi
              ? (await arxiv.searchOpenAlex({ doi: args.doi, limit: 1 })).items[0]
              : null
          if (!meta) return fail('需要 path / query / arxivId / doi 之一')
          const value = await api['search.import']({ item: meta, topic: args.topic })
          return ok({ id: value.meta.id, title: value.meta.title })
        } catch (error) {
          return fail('paper_import 失败：' + error.message)
        }
      },
    },

    {
      name: 'paper_search_online',
      description: '在 arXiv 与 OpenAlex 检索论文（不下载）。用于找论文、核对标题/作者/年份/DOI。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词 / arXiv ID / DOI' },
          source: { type: 'string', enum: ['both', 'arxiv', 'openalex'], description: '默认 both' },
          limit: { type: 'number', description: '条数，默认 8，最多 25' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        try {
          const value = await api['search.online']({
            query: args.query,
            source: args.source || 'both',
            limit: Math.min(25, Math.max(1, Number(args.limit) || 8)),
          })
          return ok(
            value.items.map((item, index) => ({
              n: index + 1,
              title: item.title,
              year: item.year,
              authors: item.authors,
              venue: item.venue,
              arxivId: item.arxivId,
              doi: item.doi,
              pdfUrl: item.pdfUrl,
              url: item.url || item.absUrl,
            })),
          )
        } catch (error) {
          return fail('paper_search_online 失败：' + error.message)
        }
      },
    },

    {
      name: 'paper_notes',
      description: '读写论文的高亮/笔记。action=list 列出；action=add 追加一条（text 必填）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '论文 id' },
          action: { type: 'string', enum: ['list', 'add'], description: '默认 list' },
          text: { type: 'string', description: 'add 时的高亮原文或笔记内容' },
          page: { type: 'number', description: 'add 时所在页码' },
          note: { type: 'string', description: 'add 时的备注' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        try {
          const action = String(args.action || 'list')
          const notes = await api['notes.get']({ id: args.id })
          if (action === 'list') return ok(notes)
          const highlights = (notes.highlights || []).concat([
            {
              page: Number(args.page) || 1,
              text: String(args.text || ''),
              note: String(args.note || ''),
              rects: [],
              color: 'note',
              at: new Date().toISOString(),
            },
          ])
          await api['notes.save']({ id: args.id, highlights })
          return ok('已保存，共 ' + highlights.length + ' 条')
        } catch (error) {
          return fail('paper_notes 失败：' + error.message)
        }
      },
    },

    {
      name: 'paper_translate',
      description:
        '把某一页译文追加到论文的中文版（面板「中文」页签会显示）。' +
        '调用前先用 paper_read 读该页原文，译文保留公式与术语，页面用 "## p.N" 分隔。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '论文 id' },
          page: { type: 'number', description: '页码' },
          markdown: { type: 'string', description: '该页中文译文（Markdown）' },
          mode: { type: 'string', enum: ['append', 'replace'], description: '默认 append' },
        },
        required: ['id', 'markdown'],
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        try {
          const id = String(args.id || '')
          const markdown = String(args.markdown || '').trim()
          if (!markdown) return fail('markdown 不能为空')
          const page = Number(args.page) || 0
          const chunk = (page > 0 ? '## p.' + page + '\n\n' : '') + markdown + '\n\n'
          if (args.mode === 'replace') {
            await fsp.writeFile(path.join(DATA_ROOT, 'papers', id, 'zh.md'), chunk, 'utf8')
          } else {
            await writeZhAppend(id, chunk)
          }
          const full = await readZh(id)
          const pages = (full.match(/^## p\.\d+/gm) || []).length
          return ok('已写入 ' + (page > 0 ? 'p.' + page : '译文') + '，当前中文版共 ' + pages + ' 页 / ' + full.length + ' 字')
        } catch (error) {
          return fail('paper_translate 失败：' + error.message)
        }
      },
    },

    {
      name: 'paper_obsidian',
      description:
        '与 Obsidian「论文知识库」交互。action=status/scan 看库状态；read 读某篇卡片；' +
        'upsert 把字段与报告写进卡片（frontmatter 行级合并，只改传入的键）；' +
        'survey 写方向综述；search 在库里搜；open 在 Obsidian 打开。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'scan', 'read', 'upsert', 'survey', 'search', 'open'],
          },
          id: { type: 'string', description: 'upsert/read 时的论文 id' },
          path: { type: 'string', description: 'read/open 时的卡片绝对路径' },
          report: { type: 'string', description: 'upsert 时写入「精读报告」小节的 Markdown 全文' },
          sections: {
            type: 'object',
            description: 'upsert 时的字段，如 {"一句话结论":"…","研究问题":"…"}',
            additionalProperties: true,
          },
          fields: {
            type: 'object',
            description: 'upsert 时的 frontmatter 补丁，如 {"paper_status":"read","paper_priority":"high"}',
            additionalProperties: true,
          },
          topic: { type: 'string', description: 'survey 的主题名' },
          markdown: { type: 'string', description: 'survey 的综述全文' },
          query: { type: 'string', description: 'search 的关键词' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        try {
          const action = String(args.action || 'status')
          if (action === 'status') return ok(await api['vault.status']({}))
          if (action === 'scan') return ok(await api['vault.scan']({}))
          if (action === 'read') {
            const value = await api['vault.read']({ id: args.id, path: args.path })
            return ok(truncate(value.frontmatter ? JSON.stringify(value.frontmatter) + '\n\n' + value.body : value.body))
          }
          if (action === 'upsert') {
            const value = await api['vault.upsert']({
              id: args.id,
              report: args.report,
              sections: args.sections,
              fields: args.fields,
            })
            return ok(value)
          }
          if (action === 'survey') {
            return ok(await api['vault.survey']({ topic: args.topic, markdown: args.markdown }))
          }
          if (action === 'search') return ok(await api['vault.search']({ query: args.query }))
          if (action === 'open') return ok(await api['vault.open']({ path: args.path }))
          return fail('未知 action：' + action)
        } catch (error) {
          return fail('paper_obsidian 失败：' + error.message)
        }
      },
    },
  ]
}

/** 把工具注册进宿主；返回注销函数数组。 */
export function registerTools(ctx, api) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    console.error('[paper-workbench] tools 服务不可用，agent 工具未注册')
    return []
  }
  const disposers = []
  for (const tool of createTools(api)) {
    try {
      const dispose = ctx.tools.register(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      console.error('[paper-workbench] 注册工具 ' + tool.name + ' 失败：' + error.message)
    }
  }
  console.log('[paper-workbench] 已注册 ' + disposers.length + ' 个 agent 工具')
  return disposers
}
