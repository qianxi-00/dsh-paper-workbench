/**
 * lib/arxiv.js 科研主题订阅与 Feed 拉取离线自测脚本。
 *
 * 全部测试均使用本地固定 fixture 与注入 fetchImpl，绝不访问真实外网。
 * 运行：node scripts/test-arxiv-feed.mjs
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-test-arxiv-feed-'))
process.env.DSH_PAPER_WORKBENCH_DATA = TMP_DATA_DIR

import {
  ARXIV_DOMAINS,
  PRESET_TOPICS,
  normalizeTopicsConfig,
  resolveSubscribedTopics,
  parseArxivAtom,
  parseOpenAlexWorks,
  normalizeTitle,
  getItemTimestamp,
  buildArxivLatestQuery,
  buildArxivLatestUrl,
  buildOpenAlexLatestQuery,
  buildOpenAlexLatestUrl,
  mergeFeedItems,
  searchArxivLatest,
  searchOpenAlexLatest,
  fetchTopicFeed,
} from '../lib/arxiv.js'

const stats = { pass: 0, fail: 0 }

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

async function check(name, fn) {
  try {
    await fn()
    stats.pass += 1
    console.log('PASS  ' + name)
  } catch (error) {
    stats.fail += 1
    console.log('FAIL  ' + name)
    console.log('      ' + messageOf(error))
  }
}

// --- 固定离线 Fixture -----------------------------------------------------

const ARXIV_LATEST_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2611.10002v1</id>
    <updated>2026-11-17T18:30:00Z</updated>
    <published>2026-11-16T09:15:00Z</published>
    <title>Agentic Memory: Long-Horizon Tool Use in Dynamic Environments</title>
    <summary>Full arXiv abstract detailing hierarchical tool use and memory consolidation.</summary>
    <author><name>Alice Zhang</name></author>
    <author><name>Bob Li</name></author>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <arxiv:primary_category term="cs.CL"/>
    <arxiv:doi>10.48550/arXiv.2611.10002</arxiv:doi>
    <link href="http://arxiv.org/pdf/2611.10002v1" rel="related" type="application/pdf" title="pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2611.10001v1</id>
    <updated>2026-11-15T12:00:00Z</updated>
    <published>2026-11-15T12:00:00Z</published>
    <title>Baseline Document Layout Parser</title>
    <summary>Compact summary for document layout parsing.</summary>
    <author><name>Carol Wu</name></author>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
    <arxiv:primary_category term="cs.CV"/>
    <link href="http://arxiv.org/pdf/2611.10001v1" rel="related" type="application/pdf" title="pdf"/>
  </entry>
</feed>`

const OPENALEX_LATEST_FIXTURE = {
  meta: { count: 2, per_page: 15 },
  results: [
    {
      id: 'https://openalex.org/W4400000001',
      doi: 'https://doi.org/10.48550/arXiv.2611.10002',
      title: 'Agentic Memory — Long-Horizon Tool Use in Dynamic Environments.',
      publication_year: 2026,
      publication_date: '2026-11-16',
      updated_date: '2026-11-18T01:00:00',
      authorships: [{ author: { display_name: 'Alice Zhang' } }],
      primary_location: {
        landing_page_url: 'https://openreview.net/forum?id=agentic-mem',
        pdf_url: null,
        source: { display_name: 'ICLR 2027' },
      },
      best_oa_location: {
        landing_page_url: 'https://arxiv.org/abs/2611.10002',
        pdf_url: 'https://arxiv.org/pdf/2611.10002',
      },
      abstract_inverted_index: null,
    },
    {
      id: 'https://openalex.org/W4400000002',
      doi: 'https://doi.org/10.1145/3600000.3600009',
      title: 'Speculative KV Compression at Scale',
      publication_year: 2026,
      publication_date: '2026-11-18',
      updated_date: '2026-11-18T02:00:00',
      authorships: [
        { author: { display_name: 'Dave Chen' } },
        { author: { display_name: 'Eve Sun' } },
      ],
      primary_location: {
        landing_page_url: 'https://dl.acm.org/doi/10.1145/3600000.3600009',
        pdf_url: 'https://example.org/spec-kv.pdf',
        source: { display_name: 'SOSP 2026' },
      },
      best_oa_location: null,
      abstract_inverted_index: {
        cache: [1],
        KV: [0],
        'compression.': [2],
      },
    },
  ],
}

// --- 测试用例 -------------------------------------------------------------

await check('PRESET_TOPICS：涵盖 8 个方向且字段与分类完整', () => {
  const expected = {
    'llm-agents': ['cs.CL', 'cs.AI', 'cs.MA'],
    'multimodal-ocr': ['cs.CV', 'cs.CL'],
    'efficient-training': ['cs.LG', 'cs.DC'],
    'rag-retrieval': ['cs.IR', 'cs.CL'],
    'alignment-eval': ['cs.CL', 'cs.AI'],
    'robotics-vla': ['cs.RO', 'cs.CV'],
    'rl-reasoning': ['cs.LG', 'cs.AI'],
    'systems-infra': ['cs.DC', 'cs.PF'],
  }
  assert.ok(Array.isArray(PRESET_TOPICS) && PRESET_TOPICS.length >= 8)
  const byId = new Map(PRESET_TOPICS.map((t) => [t.id, t]))
  assert.equal(byId.size, PRESET_TOPICS.length, 'PRESET_TOPICS 存在重复 id')

  for (const [id, requiredCats] of Object.entries(expected)) {
    const topic = byId.get(id)
    assert.ok(topic, '缺少预设主题：' + id)
    assert.equal(typeof topic.label, 'string')
    assert.ok(topic.label.trim().length > 0, id + ' label 为空')
    assert.equal(typeof topic.desc, 'string')
    assert.ok(topic.desc.trim().length > 0, id + ' desc 为空')
    assert.ok(Array.isArray(topic.arxivCategories), id + ' arxivCategories 不是数组')
    for (const cat of requiredCats) {
      assert.ok(topic.arxivCategories.includes(cat), id + ' 缺少分类 ' + cat)
    }
    assert.equal(typeof topic.arxivQuery, 'string')
    assert.ok(topic.arxivQuery.trim().length > 0, id + ' arxivQuery 为空')
    assert.equal(typeof topic.openalexQuery, 'string')
    assert.ok(topic.openalexQuery.trim().length > 0, id + ' openalexQuery 为空')
  }
})

await check('parseArxivAtom 与 parseOpenAlexWorks：保留精确日期、分类与跨源标识', () => {
  const arxivItems = parseArxivAtom(ARXIV_LATEST_FIXTURE)
  assert.equal(arxivItems.length, 2)
  assert.equal(arxivItems[0].published, '2026-11-16T09:15:00Z')
  assert.equal(arxivItems[0].publishedAt, '2026-11-16T09:15:00Z')
  assert.equal(arxivItems[0].updatedAt, '2026-11-17T18:30:00Z')
  assert.deepEqual(arxivItems[0].categories, ['cs.CL', 'cs.AI'])
  assert.equal(arxivItems[0].doi, '10.48550/arXiv.2611.10002')

  const oaItems = parseOpenAlexWorks(OPENALEX_LATEST_FIXTURE)
  assert.equal(oaItems.length, 2)
  assert.equal(oaItems[0].published, '2026-11-16')
  assert.equal(oaItems[0].publishedAt, '2026-11-16')
  assert.equal(oaItems[0].updatedAt, '2026-11-18T01:00:00')
  assert.equal(oaItems[0].arxivId, '2611.10002')
  assert.equal(oaItems[0].venue, 'ICLR 2027')
  assert.equal(oaItems[1].arxivId, null)
  assert.equal(oaItems[1].abstract, 'KV cache compression.')
})

await check('buildArxivLatestQuery / buildArxivLatestUrl：分类组合与中英文/特殊字符转义', () => {
  // 1. 单分类 + 英文短语
  assert.equal(
    buildArxivLatestQuery({ categories: ['cs.CL'], keywords: 'vision language action' }),
    'cat:cs.CL AND all:"vision language action"',
  )

  // 2. 多分类 + 多关键词（含中文与破坏引号的字符）+ 拦截非法分类注入
  const q = buildArxivLatestQuery({
    categories: ['cs.CL', 'cs.AI', 'cs.CL', 'bad cat) OR all:evil'],
    keywords: ['大模型 "对齐"\n综述', 'KV\\cache (v2)', '大模型 "对齐"\n综述'],
  })
  assert.equal(q, '(cat:cs.CL OR cat:cs.AI) AND (all:"大模型 对齐 综述" OR all:"KV cache (v2)")')

  // 3. URL 参数完整性和往返解码一致性
  const url = buildArxivLatestUrl({
    categories: ['cs.CL', 'cs.MA'],
    keywords: ['大模型检索', 'tool "use"'],
    limit: 20,
  })
  const parsed = new URL(url)
  assert.equal(parsed.origin + parsed.pathname, 'https://export.arxiv.org/api/query')
  assert.equal(parsed.searchParams.get('sortBy'), 'submittedDate')
  assert.equal(parsed.searchParams.get('sortOrder'), 'descending')
  assert.equal(parsed.searchParams.get('max_results'), '20')
  assert.equal(
    parsed.searchParams.get('search_query'),
    '(cat:cs.CL OR cat:cs.MA) AND (all:"大模型检索" OR all:"tool use")',
  )
  // URL 中不能存在未编码空格、引号或中文字符
  assert.ok(!/[\s"\u4e00-\u9fff]/.test(url), 'URL 中包含未编码空白/引号/中文：' + url)

  // 4. 空或全非法分类抛中文错
  assert.throws(() => buildArxivLatestQuery({ categories: ['invalid category!'], keywords: '' }), /需要 categories 或 keywords/)
})

await check('buildOpenAlexLatestUrl：90 天窗口、publication_date 降序与多关键词组合', () => {
  const fixedNow = Date.UTC(2026, 10, 18, 3, 0, 0) // 2026-11-18T03:00:00Z
  const expectedSince = new Date(fixedNow - 90 * 86400 * 1000).toISOString().slice(0, 10) // 2026-08-20
  const url = buildOpenAlexLatestUrl({
    topicQueries: ['large language model agent'],
    keywords: ['大模型 "RAG"'],
    limit: 12,
    now: fixedNow,
  })
  const parsed = new URL(url)
  assert.equal(parsed.origin + parsed.pathname, 'https://api.openalex.org/works')
  assert.equal(parsed.searchParams.get('filter'), 'from_publication_date:' + expectedSince)
  assert.equal(parsed.searchParams.get('sort'), 'publication_date:desc')
  assert.equal(parsed.searchParams.get('per-page'), '12')
  assert.equal(parsed.searchParams.get('search'), '(large language model agent) OR (大模型 RAG)')
  assert.equal(buildOpenAlexLatestQuery({ keywords: 'KV cache' }), 'KV cache')
  assert.throws(() => buildOpenAlexLatestUrl({}), /需要 keywords 或 topicQueries/)
})

await check('mergeFeedItems：三键去重、双向顺序保留丰富元信息、按发布时间从新到旧排序', () => {
  const arxivEntry = {
    ...parseArxivAtom(ARXIV_LATEST_FIXTURE)[0],
    source: 'arxiv',
    topics: ['llm-agents'],
  }
  const openalexSameByIdAndTitle = {
    ...parseOpenAlexWorks(OPENALEX_LATEST_FIXTURE)[0],
    source: 'openalex',
    topics: ['rag-retrieval'],
  }
  const sameByNormalizedTitleOnly = {
    id: 'W999',
    arxivId: null,
    doi: null,
    title: 'baseline: document layout parser!',
    authors: ['Carol Wu', 'Second Author'],
    year: 2026,
    published: '2026-11-15',
    publishedAt: '2026-11-15',
    venue: 'CVPR Workshop',
    abstract: null,
    pdfUrl: null,
    source: 'openalex',
    topics: ['multimodal-ocr'],
  }
  const baselineEntry = {
    ...parseArxivAtom(ARXIV_LATEST_FIXTURE)[1],
    source: 'arxiv',
    topics: ['multimodal-ocr'],
  }
  const newestByYearOrUpdated = {
    id: 'W_NEWEST',
    title: 'Brand New Paper',
    publishedAt: '2026-11-18T10:00:00Z',
    source: 'openalex',
    topics: ['efficient-training'],
  }
  const fallbackUpdatedOnly = {
    id: 'W_UPDATED',
    title: 'Updated Only Paper',
    published: null,
    publishedAt: null,
    updatedAt: '2026-11-17T00:00:00Z',
    year: 2024,
    source: 'openalex',
  }
  const fallbackYearOnly = {
    id: 'W_YEAR',
    title: 'Year Only Paper',
    year: 2025,
    source: 'openalex',
  }
  const undated = {
    id: 'W_NODATE',
    title: 'Undated Paper',
    source: 'openalex',
  }

  // 故意让 OpenAlex 在前、arXiv 在后，验证不会因为顺序不同丢失 arXiv 的丰富抽象/精确时间戳/分类
  const merged = mergeFeedItems([
    undated,
    fallbackYearOnly,
    openalexSameByIdAndTitle,
    arxivEntry,
    fallbackUpdatedOnly,
    sameByNormalizedTitleOnly,
    baselineEntry,
    newestByYearOrUpdated,
  ])

  assert.equal(merged.length, 6, '两对重复论文应各自合并，总数为 6')

  // 排序检查：2026-11-18T10:00 > 2026-11-17(updatedAt) > 2026-11-16T09:15 > 2026-11-15T12:00 > 2025(year) > undated
  assert.deepEqual(
    merged.map((m) => m.title),
    [
      'Brand New Paper',
      'Updated Only Paper',
      'Agentic Memory: Long-Horizon Tool Use in Dynamic Environments',
      'Baseline Document Layout Parser',
      'Year Only Paper',
      'Undated Paper',
    ],
  )

  const agentic = merged[2]
  assert.equal(agentic.arxivId, '2611.10002')
  assert.equal(agentic.id, 'W4400000001')
  assert.equal(agentic.doi, '10.48550/arXiv.2611.10002')
  assert.equal(agentic.venue, 'ICLR 2027', '应保留来自 OpenAlex 的 venue')
  assert.equal(
    agentic.abstract,
    'Full arXiv abstract detailing hierarchical tool use and memory consolidation.',
    '应保留来自 arXiv 的完整摘要',
  )
  assert.equal(agentic.publishedAt, '2026-11-16T09:15:00Z', '应保留更高精度的时间戳')
  assert.deepEqual(agentic.authors, ['Alice Zhang', 'Bob Li'], '应保留更完整的作者列表')
  assert.deepEqual(agentic.categories, ['cs.CL', 'cs.AI'])
  assert.deepEqual(agentic.sources, ['openalex', 'arxiv'])
  assert.deepEqual(agentic.topics, ['rag-retrieval', 'llm-agents'])

  const layout = merged[3]
  assert.equal(layout.arxivId, '2611.10001', '按归一化标题合并后应保留 arxivId')
  assert.equal(layout.venue, 'CVPR Workshop', '按归一化标题合并后应补充 venue')
  assert.equal(layout.publishedAt, '2026-11-15T12:00:00Z')
  assert.equal(layout.pdfUrl, 'https://arxiv.org/pdf/2611.10001v1')

  // 原输入对象不应被原地改写
  assert.equal(openalexSameByIdAndTitle.abstract, null)
  assert.equal(normalizeTitle('VLA: A—Survey.'), 'vla a survey')
  assert.equal(getItemTimestamp({ publishedAt: 'bad', year: 2025 }), Date.UTC(2025, 0, 1))
})

await check('searchArxivLatest & searchOpenAlexLatest：注入 fetchImpl 与时间戳排序验证', async () => {
  const seenUrls = []
  const fakeFetch = async (url, init) => {
    seenUrls.push({ url: String(url), headers: init.headers })
    if (String(url).startsWith('https://export.arxiv.org/')) {
      return new Response(ARXIV_LATEST_FIXTURE, { status: 200 })
    }
    return new Response(JSON.stringify(OPENALEX_LATEST_FIXTURE), { status: 200 })
  }

  const fixedNow = Date.UTC(2026, 10, 18, 4, 0, 0)
  const arxivRes = await searchArxivLatest({
    categories: ['cs.CL'],
    keywords: 'agent',
    limit: 5,
    now: fixedNow,
    fetchImpl: fakeFetch,
  })
  assert.equal(arxivRes.source, 'arxiv')
  assert.equal(arxivRes.fetchedAt, '2026-11-18T04:00:00.000Z')
  assert.equal(arxivRes.items.length, 2)
  assert.ok(getItemTimestamp(arxivRes.items[0]) >= getItemTimestamp(arxivRes.items[1]))

  const oaRes = await searchOpenAlexLatest({
    keywords: 'KV compression',
    limit: 5,
    now: fixedNow,
    fetchImpl: fakeFetch,
  })
  assert.equal(oaRes.source, 'openalex')
  assert.equal(oaRes.fetchedAt, '2026-11-18T04:00:00.000Z')
  assert.equal(oaRes.items.length, 2)
  // OPENALEX_LATEST_FIXTURE 中第 2 条日期 2026-11-18 晚于第 1 条 2026-11-16，排序后应反过来
  assert.equal(oaRes.items[0].id, 'W4400000002')
  assert.equal(oaRes.items[1].id, 'W4400000001')
  assert.ok(seenUrls.every((entry) => /dsh-paper-workbench/.test(entry.headers['User-Agent'])))
})

await check('fetchTopicFeed：空订阅、双源合并去重排序与中文自定义关键词', async () => {
  let calls = 0
  const empty = await fetchTopicFeed({
    subscribed: [],
    custom: [],
    fetchImpl: async () => {
      calls += 1
      return new Response('', { status: 500 })
    },
  })
  assert.equal(calls, 0, '空订阅不应发起网络请求')
  assert.deepEqual(empty.topics, [])
  assert.deepEqual(empty.items, [])
  assert.deepEqual(empty.partialErrors, [])

  const requests = []
  const feedRes = await fetchTopicFeed({
    subscribed: ['llm-agents'],
    custom: ['大模型推理'],
    source: 'both',
    limit: 10,
    now: Date.UTC(2026, 10, 18, 5, 0, 0),
    fetchImpl: async (url) => {
      const target = String(url)
      requests.push(target)
      if (target.startsWith('https://export.arxiv.org/')) {
        return new Response(ARXIV_LATEST_FIXTURE, { status: 200 })
      }
      return new Response(JSON.stringify(OPENALEX_LATEST_FIXTURE), { status: 200 })
    },
  })

  assert.equal(requests.length, 4, '1 个预设 + 1 个自定义 × 双源 = 4 次请求')
  assert.ok(requests.some((u) => u.includes(encodeURIComponent('all:"大模型推理"'))))
  assert.equal(feedRes.partialErrors.length, 0)
  assert.deepEqual(
    feedRes.topics.map((t) => t.id),
    ['llm-agents', 'custom:大模型推理'],
  )
  // fixture 共 4 条记录，其中 2611.10002 在两个源重复，合并后应剩 3 条且按日期倒序
  assert.equal(feedRes.items.length, 3)
  assert.deepEqual(
    feedRes.items.map((x) => x.publishedAt),
    ['2026-11-18', '2026-11-16T09:15:00Z', '2026-11-15T12:00:00Z'],
  )
  assert.equal(feedRes.items[1].venue, 'ICLR 2027')
  assert.ok(feedRes.items[1].sources.includes('arxiv') && feedRes.items[1].sources.includes('openalex'))
})

await check('fetchTopicFeed：部分源或部分主题失败时记录 partialErrors 且不整页崩溃', async () => {
  const res = await fetchTopicFeed({
    subscribed: ['llm-agents', 'multimodal-ocr', 'non-existent-topic'],
    custom: ['KV cache'],
    source: 'both',
    limit: 18,
    fetchImpl: async (url) => {
      const target = String(url)
      // 模拟 OpenAlex 全面 429 限流
      if (target.startsWith('https://api.openalex.org/')) {
        return new Response('rate limited', { status: 429 })
      }
      // 模拟 multimodal-ocr 在 arXiv 网络异常
      if (target.includes('cs.CV')) {
        throw new Error('ECONNRESET')
      }
      return new Response(ARXIV_LATEST_FIXTURE, { status: 200 })
    },
  })

  assert.ok(res.items.length > 0, '部分失败时成功通道的结果仍应返回')
  assert.ok(res.partialErrors.some((e) => e.source === 'preset' && e.topicId === 'non-existent-topic'))
  assert.ok(res.partialErrors.some((e) => e.source === 'arxiv' && e.topicId === 'multimodal-ocr' && /ECONNRESET/.test(e.message)))
  assert.ok(res.partialErrors.some((e) => e.source === 'openalex' && /HTTP 429/.test(e.message)))
  assert.equal(res.partialErrors.filter((e) => e.source === 'openalex').length, 3)

  await assert.rejects(fetchTopicFeed({ subscribed: ['llm-agents'], source: 'unknown' }), /不支持的数据源/)
})

await check('mergeFeedItems：DOI 大小写无关去重与 limit 截断保留最新', () => {
  const deduped = mergeFeedItems(
    [
      {
        title: 'Paper Alpha',
        doi: '10.1145/1234.ABC',
        publishedAt: '2026-11-10',
        source: 'arxiv',
      },
      {
        title: 'Paper Alpha: Extended Edition',
        doi: 'https://doi.org/10.1145/1234.abc',
        venue: 'SIGIR',
        abstract: 'Detailed abstract from OpenAlex.',
        publishedAt: '2026-11-10T08:00:00Z',
        source: 'openalex',
      },
      {
        title: 'Paper Beta',
        publishedAt: '2026-11-18T12:00:00Z',
      },
      {
        title: 'Paper Gamma',
        publishedAt: '2026-11-01',
      },
    ],
    { limit: 2 },
  )
  assert.equal(deduped.length, 2)
  assert.equal(deduped[0].title, 'Paper Beta')
  assert.equal(deduped[1].venue, 'SIGIR')
  assert.equal(deduped[1].abstract, 'Detailed abstract from OpenAlex.')
  assert.equal(deduped[1].publishedAt, '2026-11-10T08:00:00Z')
})

await check('ARXIV_DOMAINS：完整覆盖官方 8 大学科领域与子分类编码', () => {
  const expectedDomains = {
    cs: ['cs.AI', 'cs.CL', 'cs.CV', 'cs.LG', 'cs.IR', 'cs.RO', 'cs.SE', 'cs.CR', 'cs.DB', 'cs.DC', 'cs.HC'],
    physics: ['quant-ph', 'cond-mat', 'astro-ph', 'hep-th', 'hep-ph', 'gr-qc', 'physics.optics'],
    math: ['math.OC', 'math.PR', 'math.NA', 'math.ST', 'math.CO', 'math.AG'],
    stat: ['stat.ML', 'stat.ME', 'stat.TH', 'stat.AP'],
    eess: ['eess.AS', 'eess.IV', 'eess.SP', 'eess.SY'],
    'q-bio': ['q-bio.NC', 'q-bio.GN', 'q-bio.BM', 'q-bio.QM'],
    'q-fin': ['q-fin.CP', 'q-fin.PM', 'q-fin.ST', 'q-fin.TR'],
    econ: ['econ.EM', 'econ.TH', 'econ.GN'],
  }

  assert.equal(ARXIV_DOMAINS.length, 8, 'ARXIV_DOMAINS 必须包含全部 8 大官方领域')
  assert.ok(Object.isFrozen(ARXIV_DOMAINS))
  const byId = new Map(ARXIV_DOMAINS.map((d) => [d.id, d]))
  assert.equal(byId.size, 8)

  for (const [id, codes] of Object.entries(expectedDomains)) {
    const dom = byId.get(id)
    assert.ok(dom, '缺少领域：' + id)
    assert.ok(typeof dom.label === 'string' && dom.label.length > 0)
    assert.ok(typeof dom.labelEn === 'string' && dom.labelEn.length > 0)
    assert.ok(Array.isArray(dom.categories) && dom.categories.length === codes.length)
    const actualCodes = dom.categories.map((c) => c.code)
    assert.deepEqual(actualCodes, codes)
    for (const c of dom.categories) {
      assert.ok(typeof c.label === 'string' && c.label.length > 0)
    }
  }
})

await check('normalizeTopicsConfig & resolveSubscribedTopics：旧版迁移、空数组尊重、新增非 AI 领域与编辑删除', () => {
  // 1. 默认初始化（未传 subscribed）：从 PRESET_TOPICS 播种 8 项，前 3 个默认主题启用
  const seeded = normalizeTopicsConfig({})
  assert.equal(seeded.items.length, PRESET_TOPICS.length)
  assert.deepEqual(seeded.subscribed, ['llm-agents', 'multimodal-ocr', 'efficient-training'])
  assert.equal(seeded.feedSource, 'arxiv')

  // 2. 兼容旧别名 efficient-sys 与旧版 custom 数组
  const migrated = normalizeTopicsConfig({
    subscribed: ['llm-agents', 'efficient-sys'],
    custom: ['拓扑量子计算'],
    feedSource: 'both',
  })
  assert.deepEqual(migrated.subscribed, ['llm-agents', 'efficient-training'])
  assert.deepEqual(migrated.customKeywords, ['拓扑量子计算'])
  assert.equal(migrated.feedSource, 'both')
  const resolvedMigrated = resolveSubscribedTopics(migrated)
  assert.deepEqual(
    resolvedMigrated.map((t) => t.id),
    ['llm-agents', 'efficient-training', 'custom:拓扑量子计算'],
  )

  // 3. 显式 subscribed: [] 必须保持全部关闭，不能被默认值覆盖
  const explicitEmpty = normalizeTopicsConfig({ subscribed: [] })
  assert.equal(explicitEmpty.items.length, PRESET_TOPICS.length)
  assert.deepEqual(explicitEmpty.subscribed, [])
  assert.ok(explicitEmpty.items.every((it) => it.enabled === false))
  assert.deepEqual(resolveSubscribedTopics(explicitEmpty), [])
  const explicitEmptyItems = normalizeTopicsConfig({ items: [], subscribed: [] })
  assert.deepEqual(explicitEmptyItems.items, [])
  assert.deepEqual(explicitEmptyItems.subscribed, [])
  assert.deepEqual(resolveSubscribedTopics(explicitEmptyItems), [])

  // 4. 自定义主题列表应保留每项的分类、关键词与启用状态
  const customEdited = normalizeTopicsConfig({
    items: [
      {
        id: 'quantum-ec',
        label: '量子纠错与表面码',
        domain: 'physics',
        categories: ['quant-ph', 'cond-mat'],
        keywords: ['quantum error correction', 'surface code'],
        enabled: true,
      },
      {
        id: 'quant-portfolio',
        label: '统计套利与微观结构',
        domain: 'q-fin',
        categories: ['q-fin.PM', 'q-fin.TR'],
        keywords: [],
        enabled: true,
      },
      {
        id: 'llm-agents',
        label: '智能体系统（自定义扩充）',
        domain: 'cs',
        categories: ['cs.AI', 'cs.SE'],
        keywords: 'autonomous coding, SWE-bench',
        enabled: false,
      },
    ],
    customKeywords: ['随机微分方程'],
    feedSource: 'arxiv',
  })

  assert.equal(customEdited.items.length, 3)
  assert.deepEqual(customEdited.subscribed, ['quantum-ec', 'quant-portfolio'])
  assert.deepEqual(customEdited.items[2].keywords, ['autonomous coding', 'SWE-bench'])

  // 模拟删除第一项并开启第三项
  const afterDelete = normalizeTopicsConfig({
    ...customEdited,
    items: [customEdited.items[1], { ...customEdited.items[2], enabled: true }],
    customKeywords: [],
  })
  assert.equal(afterDelete.items.length, 2)
  assert.deepEqual(afterDelete.subscribed, ['quant-portfolio', 'llm-agents'])
  const activeAfterDelete = resolveSubscribedTopics(afterDelete)
  assert.deepEqual(
    activeAfterDelete.map((t) => t.id),
    ['quant-portfolio', 'llm-agents'],
  )
  assert.deepEqual(activeAfterDelete[1].categories, ['cs.AI', 'cs.SE'])
})

await check('fetchTopicFeed：支持按 domainId（8 大领域）、category（子分类）、topicId 与自定义 items 拉取', async () => {
  const capturedUrls = []
  const mockFetch = async (url) => {
    const target = String(url)
    capturedUrls.push(target)
    if (target.startsWith('https://export.arxiv.org/')) {
      return new Response(ARXIV_LATEST_FIXTURE, { status: 200 })
    }
    return new Response(JSON.stringify(OPENALEX_LATEST_FIXTURE), { status: 200 })
  }

  // 1. 按 domainId = 'q-fin' 检索整个定量金融领域
  capturedUrls.length = 0
  const domainFeed = await fetchTopicFeed({
    domainId: 'q-fin',
    limit: 10,
    fetchImpl: mockFetch,
  })
  assert.equal(capturedUrls.length, 1)
  const domainQuery = new URL(capturedUrls[0]).searchParams.get('search_query')
  assert.equal(domainQuery, '(cat:q-fin.CP OR cat:q-fin.PM OR cat:q-fin.ST OR cat:q-fin.TR)')
  assert.equal(domainFeed.topics[0].id, 'domain:q-fin')
  assert.equal(domainFeed.topics[0].kind, 'domain')
  assert.equal(domainFeed.items.length, 2)

  // 2. 按具体子分类 category = 'quant-ph' 检索
  capturedUrls.length = 0
  const catFeed = await fetchTopicFeed({
    category: 'quant-ph',
    limit: 6,
    fetchImpl: mockFetch,
  })
  assert.equal(capturedUrls.length, 1)
  assert.equal(new URL(capturedUrls[0]).searchParams.get('search_query'), 'cat:quant-ph')
  assert.equal(catFeed.topics[0].id, 'cat:quant-ph')
  assert.equal(catFeed.topics[0].kind, 'category')

  // 3. 按自定义可编辑 items 与单主题 topicId 拉取非 AI 方向
  const myTopicsCfg = normalizeTopicsConfig({
    items: [
      {
        id: 'quantum-optics',
        label: '量子光学实验',
        domain: 'physics',
        categories: ['quant-ph', 'physics.optics'],
        keywords: ['photon entanglement'],
        enabled: true,
      },
      {
        id: 'econometrics-ml',
        label: '因果推断与计量经济',
        domain: 'econ',
        categories: ['econ.EM', 'stat.ME'],
        keywords: ['causal inference'],
        enabled: false,
      },
    ],
  })

  // 即使 econometrics-ml 为 enabled: false，点选单主题 pill (topicId) 仍可单独预览
  capturedUrls.length = 0
  const singleCustom = await fetchTopicFeed({
    topicsConfig: myTopicsCfg,
    topicId: 'econometrics-ml',
    fetchImpl: mockFetch,
  })
  assert.equal(capturedUrls.length, 1)
  assert.equal(
    new URL(capturedUrls[0]).searchParams.get('search_query'),
    '(cat:econ.EM OR cat:stat.ME) AND all:"causal inference"',
  )
  assert.equal(singleCustom.topics[0].id, 'econometrics-ml')

  // 不传 topicId 时只拉取 enabled: true 的主题（quantum-optics）
  capturedUrls.length = 0
  const allEnabledRes = await fetchTopicFeed({
    topicsConfig: myTopicsCfg,
    source: 'both',
    fetchImpl: mockFetch,
  })
  assert.equal(capturedUrls.length, 2, '1 个启用主题 × 双源 = 2 次请求')
  assert.deepEqual(
    allEnabledRes.topics.map((t) => t.id),
    ['quantum-optics'],
  )

  // 非法 domainId / category / topicId 抛清晰中文错误
  await assert.rejects(fetchTopicFeed({ domainId: 'unknown-domain', fetchImpl: mockFetch }), /未知的学科领域/)
  await assert.rejects(fetchTopicFeed({ category: 'bad category!', fetchImpl: mockFetch }), /无效的 arXiv 分类/)
  await assert.rejects(fetchTopicFeed({ topicId: 'missing-topic', fetchImpl: mockFetch }), /未找到主题/)
})

await fsp.rm(TMP_DATA_DIR, { recursive: true, force: true }).catch(() => {})

console.log('\n结果：PASS ' + stats.pass + ' / FAIL ' + stats.fail)
if (stats.fail > 0) {
  process.exitCode = 1
} else {
  console.log('ALL PASS')
}
