#!/usr/bin/env node
/** 真实 API/持久化边界：历史只记录最小书目，不覆盖阅读状态。 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-history-'))
process.env.DSH_PAPER_WORKBENCH_DATA = root
const { createApi } = await import('../lib/index.js')
const { normalizeBrowseHistory, normalizeHistoryItem } = await import('../lib/history.js')
const api = createApi()
after(() => fs.rm(root, { recursive: true, force: true }))
const paper = { title: 'History paper', doi: '10.1234/demo', url: 'https://doi.org/10.1234/demo', source: 'openalex', abstract: 'MUST_NOT_PERSIST', items: [{ secret: 'MUST_NOT_PERSIST' }] }

test('浏览历史持久化、去重并与并发阅读状态更新共存', async () => {
  assert.equal(typeof api['history.record'], 'function', '需要实际记录论文的历史 API')
  await Promise.all([
    api['history.record']({ item: paper }),
    api['ui.set']({ state: { page: 7, tab: 'page', nativeChat: { activeConv: 'c-history-demo', width: 460 } } }),
  ])
  await api['history.record']({ item: { ...paper, doi: '10.1234/DEMO', title: 'Updated title' } })
  const { items } = await createApi()['history.list']({})
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Updated title')
  assert.equal(items[0].doi, '10.1234/demo')
  assert.ok(Number.isFinite(Date.parse(items[0].lastViewedAt)))
  assert.equal(items[0].abstract, undefined)
  const disk = await fs.readFile(path.join(root, 'ui.json'), 'utf8')
  assert.ok(!disk.includes('MUST_NOT_PERSIST'))
  const state = (await api['ui.get']()).state
  assert.equal(state.page, 7)
  assert.equal(state.nativeChat.activeConv, 'c-history-demo')
  assert.equal(state.browseHistory.length, 1)
})

test('历史拒绝危险链接和无标识项目，不接受任意字段', async () => {
  await assert.rejects(api['history.record']({ item: { title: 'Unsafe', url: 'javascript:alert(1)' } }), /链接|论文/)
  await assert.rejects(api['history.record']({ item: { title: 'Credential', url: 'https://fixture-user:fixture-pass@example.com/paper' } }), /链接|认证/)
  await assert.rejects(api['history.record']({ item: { title: 'No identity' } }), /标识|链接/)
  const { items } = await api['history.list']({})
  assert.equal(items.length, 1)
})

test('历史最多200条，删除清空保留其它界面状态', async () => {
  for (let i = 0; i < 203; i++) await api['history.record']({ item: { title: 'Paper ' + i, arxivId: '2611.' + String(i).padStart(5, '0'), url: 'https://arxiv.org/abs/2611.' + String(i).padStart(5, '0') } })
  let { items } = await api['history.list']({})
  assert.equal(items.length, 200)
  assert.equal(items[0].title, 'Paper 202')
  await api['history.remove']({ id: items[0].id })
  items = (await api['history.list']({})).items
  assert.equal(items.length, 199)
  assert.equal(items[0].title, 'Paper 201')
  await api['history.clear']({})
  assert.deepEqual((await createApi()['history.list']({})).items, [])
  assert.equal((await api['ui.get']()).state.page, 7)
})

test('历史按任一可信标识合并，补全书目字段并保留最近访问时间', () => {
  const newest = '2026-11-19T10:00:00.000Z'
  const older = '2026-11-18T10:00:00.000Z'
  const aliases = [
    [{ doi: '10.1234/ALIAS' }, { doi: '10.1234/alias' }],
    [{ arxivId: 'cs.AI/0701001v2' }, { arxivId: 'cs.ai/0701001' }],
    [{ url: 'https://example.invalid/paper?tracking=first#page=2' }, { url: 'https://example.invalid/paper?tracking=second' }],
    [{ paperId: 'paper-alias' }, { paperId: 'paper-alias' }],
  ]
  for (const [first, second] of aliases) {
    const items = normalizeBrowseHistory([
      { title: 'Older title', source: 'arxiv', ...first, lastViewedAt: older },
      { title: 'Newest title', ...second, lastViewedAt: newest },
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0].title, 'Newest title')
    assert.equal(items[0].lastViewedAt, newest)
    assert.equal(items[0].source, second.paperId ? 'library' : 'arxiv')
  }
  const upgraded = normalizeBrowseHistory([
    { title: 'New DOI title', doi: '10.1234/upgrade', arxivId: '2611.12345', lastViewedAt: newest },
    { title: 'Old arXiv title', arxivId: '2611.12345v2', url: 'https://arxiv.org/abs/2611.12345', source: 'arxiv', lastViewedAt: older },
  ])
  assert.equal(upgraded.length, 1)
  assert.equal(upgraded[0].id, 'doi:10.1234/upgrade')
  assert.equal(upgraded[0].url, 'https://arxiv.org/abs/2611.12345')
  assert.equal(upgraded[0].source, 'arxiv')
})

test('历史别名桥接合并所有重复条目，再按最近访问保留200篇', () => {
  const rows = Array.from({ length: 203 }, (_, i) => ({
    title: 'Bounded paper ' + i,
    arxivId: '2611.' + String(i).padStart(5, '0'),
    lastViewedAt: new Date(Date.UTC(2026, 10, 18, 0, 0, i)).toISOString(),
  }))
  rows.push(
    { title: 'Old DOI identity', doi: '10.1234/bridge', lastViewedAt: '2026-11-17T00:00:00.000Z' },
    { title: 'Bridge identity', doi: '10.1234/bridge', arxivId: '2611.00000', lastViewedAt: '2026-11-16T00:00:00.000Z' },
    { title: 'Most recent', doi: '10.1234/bridge', lastViewedAt: '2026-11-19T00:00:00.000Z' },
  )
  const items = normalizeBrowseHistory(rows)
  assert.equal(items.length, 200)
  assert.equal(items[0].title, 'Most recent')
  assert.equal(items[0].arxivId, '2611.00000')
  assert.equal(items[0].lastViewedAt, '2026-11-19T00:00:00.000Z')
  assert.equal(items.filter(item => item.doi === '10.1234/bridge' || item.arxivId === '2611.00000').length, 1)
  assert.equal(items.at(-1).arxivId, '2611.00004')
})

test('RPC别名升级和同标识重访保留已有字段', async () => {
  await api['history.clear']({})
  const first = { title: 'Arxiv first', arxivId: '2611.12345v2', url: 'https://arxiv.org/abs/2611.12345', source: 'arxiv' }
  await api['history.record']({ item: first })
  await api['history.record']({ item: { title: 'DOI upgraded', arxivId: '2611.12345', doi: '10.1234/upgrade', paperId: 'paper-upgrade' } })
  await api['history.record']({ item: { title: 'Latest visit', doi: '10.1234/upgrade', paperId: 'paper-upgrade' } })
  const { items } = await api['history.list']({})
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Latest visit')
  assert.equal(items[0].arxivId, '2611.12345')
  assert.equal(items[0].url, first.url)
  await api['history.clear']({})
})

test('URL仅保留origin和pathname，签名凭据、query与hash不落盘', async () => {
  const signedUrl = 'https://example.invalid/paper?X-Amz-Security-Token=SIGNED_FIXTURE_DO_NOT_PERSIST&token=QUERY_FIXTURE_DO_NOT_PERSIST#HASH_FIXTURE_DO_NOT_PERSIST'
  assert.equal(normalizeHistoryItem({ title: 'Signed link', url: signedUrl }).url, 'https://example.invalid/paper')
  await api['history.record']({ item: { title: 'Signed link', url: signedUrl } })
  const disk = await fs.readFile(path.join(root, 'ui.json'), 'utf8')
  assert.ok(!disk.includes('SIGNED_FIXTURE_DO_NOT_PERSIST'))
  assert.ok(!disk.includes('QUERY_FIXTURE_DO_NOT_PERSIST'))
  assert.ok(!disk.includes('HASH_FIXTURE_DO_NOT_PERSIST'))
  const latest = (await api['history.list']({})).items[0]
  assert.equal(latest.id, 'url:https://example.invalid/paper')
  assert.equal(latest.url, 'https://example.invalid/paper')
  await api['history.clear']({})
})

test('DOI解析器链接按标识去重，签名参数和片段不落盘', async () => {
  const doi = '10.1234/resolver-case'
  const resolverUrl = 'https://dx.doi.org/10.1234/Resolver-Case?signature=doi-query-fixture#doi-fragment-fixture'
  await api['history.record']({ item: { title: 'First visit', doi } })
  await api['history.record']({ item: { title: 'Second visit', doi: resolverUrl } })
  const { items } = await api['history.list']({})
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'doi:' + doi)
  assert.equal(items[0].doi, doi)
  assert.equal(items[0].title, 'Second visit')
  const disk = await fs.readFile(path.join(root, 'ui.json'), 'utf8')
  assert.ok(!disk.includes('doi-query-fixture'))
  assert.ok(!disk.includes('doi-fragment-fixture'))
  await assert.rejects(api['history.record']({ item: { title: 'Unsafe DOI', doi: 'https://fixture-user@doi.org/10.1234/resolver-case' } }), /认证/)
  await api['history.clear']({})
})
