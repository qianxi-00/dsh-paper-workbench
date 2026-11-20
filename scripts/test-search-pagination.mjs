import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-test-search-pagination-'))
process.env.DSH_PAPER_WORKBENCH_DATA = TMP_DATA_DIR

import * as arxiv from '../lib/arxiv.js'

const atom = (ids) => `<feed>${ids.map((id) => `<entry><id>https://arxiv.org/abs/${id}</id><updated>2026-11-18T00:00:00Z</updated><published>2026-11-17T00:00:00Z</published><title>Paper ${id}</title><summary>Abstract ${id}</summary></entry>`).join('')}</feed>`

assert.equal(typeof arxiv.searchOnlinePage, 'function', 'searchOnlinePage must be exported')

const requests = []
const fetchImpl = async (url) => {
  const parsed = new URL(url)
  requests.push(parsed)
  const start = Number(parsed.searchParams.get('start') || 0)
  return new Response(atom(start === 0 ? ['2611.10001', '2611.10002'] : ['2611.10003']), { status: 200 })
}

const first = await arxiv.searchOnlinePage({ query: '  tool   use ', source: 'arxiv', limit: 2, fetchImpl })
assert.equal(requests[0].searchParams.get('start'), '0')
assert.equal(requests[0].searchParams.get('max_results'), '2')
assert.equal(first.items.length, 2)
assert.equal(first.hasMore, true)
assert.equal(typeof first.nextCursor, 'string')
assert.deepEqual(first.warnings, [])
assert.deepEqual(first.partialErrors, [])

const second = await arxiv.searchOnlinePage({ query: 'tool use', source: 'arxiv', limit: 2, cursor: first.nextCursor, fetchImpl })
assert.equal(requests[1].searchParams.get('start'), '2')
assert.equal(second.items.length, 1)
assert.equal(second.hasMore, false)
assert.equal(second.nextCursor, null)

console.log('PASS searchOnlinePage arXiv start/max_results cursor pagination')

const openAlexRequests = []
const openAlex = await arxiv.searchOnlinePage({
  query: 'retrieval', source: 'openalex', limit: 2,
  fetchImpl: async (url) => {
    const parsed = new URL(url)
    openAlexRequests.push(parsed)
    const page = Number(parsed.searchParams.get('page'))
    return new Response(JSON.stringify({ meta: { count: 3 }, results: [
      { id: `https://openalex.org/W${page}01`, title: `Retrieval ${page} A`, publication_year: 2026 },
      ...(page === 1 ? [{ id: 'https://openalex.org/W102', title: 'Retrieval 1 B', publication_year: 2026 }] : []),
    ] }), { status: 200 })
  },
})
assert.equal(openAlexRequests[0].searchParams.get('per-page'), '2')
assert.equal(openAlexRequests[0].searchParams.get('page'), '1')
assert.equal(openAlex.hasMore, true)
const openAlexNext = await arxiv.searchOnlinePage({
  query: 'retrieval', source: 'openalex', limit: 2, cursor: openAlex.nextCursor,
  fetchImpl: async (url) => {
    const parsed = new URL(url)
    openAlexRequests.push(parsed)
    return new Response(JSON.stringify({ meta: { count: 3 }, results: [
      { id: 'https://openalex.org/W201', title: 'Retrieval 2 A', publication_year: 2026 },
    ] }), { status: 200 })
  },
})
assert.equal(openAlexRequests[1].searchParams.get('page'), '2')
assert.equal(openAlexNext.hasMore, false)

const bothRequests = []
const both = await arxiv.searchOnlinePage({ query: 'balanced results', source: 'both', limit: 4, fetchImpl: async (url) => {
  const parsed = new URL(url)
  bothRequests.push(parsed)
  if (parsed.hostname === 'export.arxiv.org') return new Response(atom(['2611.10011', '2611.10012']), { status: 200 })
  return new Response(JSON.stringify({ results: [
    { id: 'https://openalex.org/W110', title: 'OpenAlex A', publication_year: 2026 },
    { id: 'https://openalex.org/W111', title: 'OpenAlex B', publication_year: 2026 },
  ] }), { status: 200 })
} })
assert.equal(both.items.length, 4)
assert.deepEqual(bothRequests.map((url) => url.searchParams.get('max_results') || url.searchParams.get('per-page')).sort(), ['2', '2'])
assert.equal(both.hasMore, true)

let openAlexFail = true
const retryRequests = []
const partial = await arxiv.searchOnlinePage({ query: 'retry page', source: 'both', limit: 4, fetchImpl: async (url) => {
  const parsed = new URL(url)
  retryRequests.push(parsed)
  if (parsed.hostname === 'export.arxiv.org') return new Response(atom(['2611.10021', '2611.10022']), { status: 200 })
  if (openAlexFail) return new Response('limited', { status: 429 })
  return new Response(JSON.stringify({ results: [{ id: 'https://openalex.org/W120', title: 'OpenAlex retry', publication_year: 2026 }] }), { status: 200 })
} })
assert.equal(partial.items.length, 2)
assert.equal(partial.partialErrors.length, 1)
assert.equal(partial.hasMore, true)
openAlexFail = false
const retried = await arxiv.searchOnlinePage({ query: 'retry page', source: 'both', limit: 4, cursor: partial.nextCursor, fetchImpl: async (url) => {
  const parsed = new URL(url)
  retryRequests.push(parsed)
  if (parsed.hostname === 'export.arxiv.org') return new Response(atom(['2611.10023']), { status: 200 })
  return new Response(JSON.stringify({ results: [{ id: 'https://openalex.org/W120', title: 'OpenAlex retry', publication_year: 2026 }] }), { status: 200 })
} })
assert.equal(retryRequests[3].searchParams.get('page'), '1', 'failed provider cursor position must not advance')
assert.equal(retried.items.length, 2)

await assert.rejects(arxiv.searchOnlinePage({ query: 'x', source: 'typo', fetchImpl }), /不支持的数据源/)
await assert.rejects(arxiv.searchOnlinePage({ query: 'x', source: '', fetchImpl }), /不支持的数据源/)
await assert.rejects(arxiv.searchOnlinePage({ query: 'different', source: 'arxiv', limit: 2, cursor: first.nextCursor, fetchImpl }), /游标与当前查询/)
await assert.rejects(arxiv.searchOnlinePage({ query: 'tool use', source: 'arxiv', limit: 1, cursor: first.nextCursor, fetchImpl }), /游标与当前查询/)
await assert.rejects(arxiv.searchOnlinePage({ query: 'tool use', source: 'arxiv', cursor: 'v2.invalid', fetchImpl }), /游标无效或超出长度限制/)
await assert.rejects(arxiv.searchOnlinePage({ query: 'tool use', source: 'arxiv', cursor: 'v1.' + 'a'.repeat(16384), fetchImpl }), /游标无效或超出长度限制/)

const credentialError = await arxiv.searchOnlinePage({ query: 'credential redaction', source: 'arxiv', fetchImpl: async () => {
  throw new Error('request failed https://test-user@example.invalid/path')
} })
assert.ok(credentialError.partialErrors[0].message.includes('[redacted]'))
assert.ok(!credentialError.partialErrors[0].message.includes('test-user'))

assert.equal(typeof arxiv.fetchTopicFeedPage, 'function', 'fetchTopicFeedPage must be exported')
const feedRequests = []
const firstFeed = await arxiv.fetchTopicFeedPage({ category: 'cs.CL', source: 'arxiv', limit: 2, now: Date.UTC(2026, 10, 18), fetchImpl: async (url) => {
  const parsed = new URL(url)
  feedRequests.push(parsed)
  const start = Number(parsed.searchParams.get('start'))
  return new Response(atom(start === 0 ? ['2611.10101', '2611.10102'] : ['2611.10103']), { status: 200 })
} })
assert.equal(firstFeed.items.length, 2)
assert.equal(firstFeed.hasMore, true)
assert.equal(feedRequests[0].searchParams.get('start'), '0')
const nextFeed = await arxiv.fetchTopicFeedPage({ category: 'cs.CL', source: 'arxiv', limit: 2, cursor: firstFeed.nextCursor, fetchImpl: async (url) => {
  const parsed = new URL(url)
  feedRequests.push(parsed)
  return new Response(atom(['2611.10103']), { status: 200 })
} })
assert.equal(feedRequests[1].searchParams.get('start'), '2')
assert.equal(nextFeed.items.length, 1)
assert.equal(nextFeed.hasMore, false)
await assert.rejects(arxiv.fetchTopicFeedPage({ category: 'cs.CV', source: 'arxiv', limit: 2, cursor: firstFeed.nextCursor, fetchImpl }), /游标与当前主题/)
await assert.rejects(arxiv.fetchTopicFeedPage({ category: 'cs.CL', source: '', fetchImpl }), /不支持的数据源/)

let feedFailOnce = true
const feedRetryRequests = []
const feedPartial = await arxiv.fetchTopicFeedPage({ category: 'cs.CL', source: 'both', limit: 2, fetchImpl: async (url) => {
  const parsed = new URL(url)
  feedRetryRequests.push(parsed)
  if (parsed.hostname === 'export.arxiv.org') return new Response(atom(['2611.10201']), { status: 200 })
  if (feedFailOnce) return new Response('limited', { status: 429 })
  return new Response(JSON.stringify({ meta: { count: 2 }, results: [{ id: 'https://openalex.org/W220', title: 'OpenAlex feed retry', publication_year: 2026 }] }), { status: 200 })
} })
assert.equal(feedPartial.items.length, 1)
assert.equal(feedPartial.partialErrors.length, 1)
assert.equal(feedPartial.warnings.length, 1)
assert.equal(feedPartial.hasMore, true)
feedFailOnce = false
const feedRetried = await arxiv.fetchTopicFeedPage({ category: 'cs.CL', source: 'both', limit: 2, cursor: feedPartial.nextCursor, fetchImpl: async (url) => {
  const parsed = new URL(url)
  feedRetryRequests.push(parsed)
  if (parsed.hostname === 'export.arxiv.org') return new Response(atom(['2611.10202']), { status: 200 })
  return new Response(JSON.stringify({ meta: { count: 2 }, results: [{ id: 'https://openalex.org/W220', title: 'OpenAlex feed retry', publication_year: 2026 }] }), { status: 200 })
} })
assert.equal(feedRetryRequests[3].searchParams.get('page'), '1', 'failed Feed source position must remain unchanged')
assert.equal(feedRetryRequests[2].searchParams.get('start'), '1', 'successful Feed source position must advance')
assert.equal(feedRetried.partialErrors.length, 0)

const rotatingCalls = []
const rotatingFeed = { category: 'cs.CL', source: 'both', limit: 1, fetchImpl: async (url) => {
  const parsed = new URL(url)
  if (parsed.hostname === 'export.arxiv.org') {
    const start = Number(parsed.searchParams.get('start'))
    rotatingCalls.push(['arxiv', start])
    return new Response(atom(start >= 2 ? [] : ['2611.1030' + (start + 1)]))
  }
  const page = Number(parsed.searchParams.get('page'))
  rotatingCalls.push(['openalex', page])
  return new Response(JSON.stringify({ meta: { count: 2 }, results: [{
    id: 'https://openalex.org/W330' + page, title: 'Rotating feed ' + page, publication_year: 2026,
  }] }))
} }
let rotatingCursor
const rotatingItems = []
for (let i = 0; i < 5; i += 1) {
  const page = await arxiv.fetchTopicFeedPage({ ...rotatingFeed, cursor: rotatingCursor })
  rotatingItems.push(...page.items)
  rotatingCursor = page.nextCursor
}
assert.deepEqual(rotatingCalls, [['arxiv', 0], ['openalex', 1], ['arxiv', 1], ['openalex', 2], ['arxiv', 2]])
assert.equal(rotatingItems.length, 4)
assert.equal(rotatingCursor, null)

const abortController = new AbortController()
abortController.abort()
let abortedFetches = 0
const abortedSearch = await arxiv.searchOnlinePage({ query: 'cancel this', source: 'arxiv', limit: 2, signal: abortController.signal, fetchImpl: async () => {
  abortedFetches += 1
  return new Response(atom([]), { status: 200 })
} })
assert.equal(abortedFetches, 0)
assert.equal(abortedSearch.hasMore, true)
assert.equal(abortedSearch.partialErrors[0].message, '检索失败：请求已取消')

const openAlexBoundaryCursor = JSON.parse(Buffer.from(openAlex.nextCursor.slice(3), 'base64url').toString('utf8'))
openAlexBoundaryCursor.providers.openalex.position = 1000
const boundaryCursor = 'v1.' + Buffer.from(JSON.stringify(openAlexBoundaryCursor), 'utf8').toString('base64url')
const boundary = await arxiv.searchOnlinePage({ query: 'retrieval', source: 'openalex', limit: 2, cursor: boundaryCursor, fetchImpl: async (url) => {
  assert.equal(new URL(url).searchParams.get('page'), '1000')
  return new Response(JSON.stringify({ results: [
    { id: 'https://openalex.org/W9991', title: 'Boundary A', publication_year: 2026 },
    { id: 'https://openalex.org/W9992', title: 'Boundary B', publication_year: 2026 },
  ] }), { status: 200 })
} })
assert.equal(boundary.hasMore, false)
assert.match(boundary.warnings.join(' '), /10000 条/)

await fsp.rm(TMP_DATA_DIR, { recursive: true, force: true })
console.log('PASS searchOnlinePage / fetchTopicFeedPage provider and Feed pagination')
