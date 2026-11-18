// 通过真实 RPC 方法和隔离数据目录验证订阅缓存。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('订阅缓存安全', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-test-feed-cache-'))
  process.env.DSH_PAPER_WORKBENCH_DATA = root
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const { createApi } = await import('../lib/index.js')

  const cacheFile = path.join(root, '.tmp', 'feed-cache.json')
  const username = 'fixture-' + randomUUID()
  const passwordA = randomUUID()
  const passwordB = randomUUID()
  const proxyConfig = (password) => ({ mode: 'custom', proxyUrl: `http://${username}:${password}@proxy.invalid:8080` })
  const networkA = proxyConfig(passwordA)
  const networkB = proxyConfig(passwordB)
  const emptyArgs = { items: [], customKeywords: [], source: 'arxiv' }
  const feedArgs = { category: 'cs.AI', source: 'arxiv' }
  const feed = (title) => ({ items: [{ title }] })

  const setNetwork = (api, network) => api['settings.set']({ patch: { network } })
  const assertCacheRemoved = () => assert.rejects(fsp.stat(cacheFile), { code: 'ENOENT' }, '缓存文件应已删除')

  async function seedLegacyCache() {
    const key = JSON.stringify({
      topics: { items: [], customKeywords: [], subscribed: [], feedSource: 'arxiv' },
      topicId: '',
      domainId: '',
      category: '',
      source: 'arxiv',
      limit: 18,
      network: networkA,
    })
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true })
    await fsp.writeFile(cacheFile, JSON.stringify({ key, savedAt: Date.now(), value: feed('旧缓存') }))
  }

  await t.test('丢弃仍可命中的明文旧缓存，空结果也删除缓存文件', async () => {
    const api = createApi()
    await setNetwork(api, networkA)
    await seedLegacyCache()

    const result = await api['search.latest'](emptyArgs)
    assert.equal(result.cached, false, '不能命中仍含明文网络配置的旧缓存')
    assert.deepEqual(result.items, [])
    await assertCacheRemoved()
  })

  await t.test('强制刷新失败时也删除明文旧缓存', async () => {
    const api = createApi()
    await setNetwork(api, networkA)
    await seedLegacyCache()

    await assert.rejects(api['search.latest']({ ...emptyArgs, force: true, source: 'invalid-source' }), /不支持的数据源/)
    await assertCacheRemoved()
  })

  await t.test('非空 Feed 的缓存不保存网络配置明文', async () => {
    const api = createApi({ fetchTopicFeed: async () => feed('代理 A') })
    await setNetwork(api, networkA)

    const result = await api['search.latest'](feedArgs)
    assert.equal(result.cached, false)
    assert.deepEqual(result.items, feed('代理 A').items)
    const text = await fsp.readFile(cacheFile, 'utf8')
    for (const credential of [username, passwordA, new URL(networkA.proxyUrl).host]) {
      assert.equal(text.includes(credential), false, '缓存文件泄漏代理地址或凭据')
    }
    const hit = await api['search.latest'](feedArgs)
    assert.equal(hit.cached, true)
    assert.deepEqual(hit.items, result.items)
  })

  await t.test('切换代理密码后不命中旧请求晚写的缓存', async () => {
    let signalStarted
    let releaseA
    const started = new Promise((resolve) => { signalStarted = resolve })
    const pendingA = new Promise((resolve) => { releaseA = resolve })
    let holdA = false
    const api = createApi({
      fetchTopicFeed: async ({ networkConfig }) => {
        const password = new URL(networkConfig.proxyUrl).password
        if (password === passwordA) {
          if (!holdA) return feed('代理 A 的预热缓存')
          signalStarted()
          await pendingA
          return feed('代理 A 的晚到结果')
        }
        assert.ok(password === passwordB, '应使用切换后的代理配置')
        return feed('代理 B')
      },
    })
    await setNetwork(api, networkA)
    await api['search.latest'](feedArgs)
    assert.ok((await fsp.stat(cacheFile)).isFile())

    holdA = true
    const inFlight = api['search.latest']({ ...feedArgs, force: true })
    try {
      await Promise.race([started, inFlight.then(() => assert.fail('A 应停在下载层'))])
      await setNetwork(api, networkB)
      await assertCacheRemoved()
    } finally {
      releaseA()
      await inFlight
    }

    const lateCache = JSON.parse(await fsp.readFile(cacheFile, 'utf8'))
    assert.deepEqual(lateCache.value.items, feed('代理 A 的晚到结果').items)
    const result = await api['search.latest'](feedArgs)
    assert.deepEqual(result, { ...feed('代理 B'), cached: false })
    assert.deepEqual(await api['search.latest'](feedArgs), { ...feed('代理 B'), cached: true })
  })
})
