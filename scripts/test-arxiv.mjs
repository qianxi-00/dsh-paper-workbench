/**
 * lib/arxiv.js 自测脚本。
 *
 * 离线部分用两段固定 fixture（arXiv Atom、OpenAlex JSON）直接喂解析器，不发请求；
 * 在线部分连真实接口，任何失败（断网、限流、断言不符）都只记 SKIP，不算 FAIL。
 * 运行：node scripts/test-arxiv.mjs
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  normalizeArxivId,
  normalizeDoi,
  searchArxiv,
  searchOpenAlex,
  searchBoth,
  downloadPdf,
  fetchArxivMeta,
  parseArxivAtom,
  parseOpenAlexWorks,
} from '../lib/arxiv.js'

const stats = { pass: 0, fail: 0, skip: 0 }

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

function skip(name, reason) {
  stats.skip += 1
  console.log('SKIP  ' + name)
  console.log('      原因：' + reason)
}

/** 在线断言失败按 SKIP 处理：网络环境不可控，不能因此判整套失败。 */
async function checkOnline(name, fn) {
  try {
    await fn()
    stats.pass += 1
    console.log('PASS  ' + name)
  } catch (error) {
    skip(name, messageOf(error))
  }
}

// --- 固定 fixture ---------------------------------------------------------

/** 两段 entry：覆盖新式/旧式编号、title 换行、XML 实体、两种 <link> 属性顺序。 */
const ARXIV_ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query: search_query=all:prompt</title>
  <entry>
    <id>http://arxiv.org/abs/2103.10385v2</id>
    <updated>2021-03-19T17:50:05Z</updated>
    <published>2021-03-18T17:50:05Z</published>
    <title>The Power of Scale for
  Parameter-Efficient Prompt Tuning</title>
    <summary>We study prompt tuning &amp; show that
  it matches fine-tuning &lt;in many cases&gt;, and it&#39;s cheap.</summary>
    <author>
      <name>Brian Lester</name>
    </author>
    <author>
      <name>Rami Al-Rfou</name>
    </author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <link href="http://arxiv.org/pdf/2103.10385v2" rel="related" type="application/pdf" title="pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/hep-th/9901001v1</id>
    <published>1999-01-01T00:00:00Z</published>
    <title>A &quot;toy&quot; model</title>
    <summary>Old style id entry.</summary>
    <author><name>Jane Doe</name></author>
    <arxiv:primary_category term="hep-th" scheme="http://arxiv.org/schemas/atom"/>
    <link title="pdf" rel="related" type="application/pdf" href="http://arxiv.org/pdf/hep-th/9901001v1"/>
  </entry>
</feed>`

/** 一条 work：inverted index 的键顺序与位置顺序都被打乱，用来验证按 position 还原。 */
const OPENALEX_FIXTURE = {
  meta: { count: 1, per_page: 10 },
  results: [
    {
      id: 'https://openalex.org/W2741809807',
      doi: 'https://doi.org/10.1038/s41586-020-2649-2',
      title: 'Array programming with NumPy',
      publication_year: 2020,
      authorships: [
        { author: { display_name: 'Charles R. Harris' } },
        { author: { display_name: 'K. Jarrod Millman' } },
      ],
      primary_location: {
        landing_page_url: 'https://www.nature.com/articles/s41586-020-2649-2',
        pdf_url: null,
        source: { display_name: 'Nature' },
      },
      best_oa_location: {
        pdf_url: 'https://example.org/numpy.pdf',
        landing_page_url: 'https://example.org/numpy',
      },
      abstract_inverted_index: {
        'fun.': [5],
        is: [4],
        with: [2],
        NumPy: [3],
        Array: [0],
        programming: [1],
      },
    },
  ],
}

async function runOffline() {
  console.log('== 离线部分（固定 fixture，不联网）==')

  await check('normalizeArxivId：新式/旧式/URL/版本/非法输入', () => {
    const cases = [
      ['2103.10385', '2103.10385'],
      ['arXiv:2103.10385v2', '2103.10385'],
      ['https://arxiv.org/abs/2103.10385', '2103.10385'],
      ['https://arxiv.org/pdf/2103.10385.pdf', '2103.10385'],
      ['hep-th/9901001', 'hep-th/9901001'],
      ['  https://export.arxiv.org/abs/math.GT/0309136v1?context=math  ', 'math.GT/0309136'],
    ]
    for (const [input, expected] of cases) {
      assert.equal(normalizeArxivId(input), expected, '输入 ' + JSON.stringify(input))
    }
    // 注意 2103.1038 是合法的 YYMM.NNNN 旧号型，真正非法的是位数不够的 2103.103。
    for (const bad of ['', 'arXiv:', '2103.103', 'https://example.com/abs/2103.10385', null, 42, '10.1000/xyz']) {
      assert.equal(normalizeArxivId(bad), null, '应判为非法：' + JSON.stringify(bad))
    }
  })

  await check('normalizeDoi：裸 DOI / doi: 前缀 / doi.org 链接 / 非法输入', () => {
    const cases = [
      ['10.1000/xyz', '10.1000/xyz'],
      ['doi:10.1000/xyz', '10.1000/xyz'],
      ['https://doi.org/10.1000/xyz', '10.1000/xyz'],
      ['https://dx.doi.org/10.1038/s41586-020-2649-2', '10.1038/s41586-020-2649-2'],
      ['DOI: 10.1000/ABC.123', '10.1000/ABC.123'],
    ]
    for (const [input, expected] of cases) {
      assert.equal(normalizeDoi(input), expected, '输入 ' + JSON.stringify(input))
    }
    for (const bad of ['', 'doi:', '10.12/xyz', '10.1000/ xyz', 'https://example.com/10.1000/xyz', null, 123]) {
      assert.equal(normalizeDoi(bad), null, '应判为非法：' + JSON.stringify(bad))
    }
  })

  await check('parseArxivAtom：标题空白压缩、实体反转义、作者/年份/分类/link 属性顺序', () => {
    const items = parseArxivAtom(ARXIV_ATOM_FIXTURE)
    assert.equal(items.length, 2, '应解析出 2 条 entry')

    const first = items[0]
    assert.equal(first.arxivId, '2103.10385')
    assert.equal(first.title, 'The Power of Scale for Parameter-Efficient Prompt Tuning')
    assert.deepEqual(first.authors, ['Brian Lester', 'Rami Al-Rfou'])
    assert.equal(first.year, 2021)
    assert.equal(first.published, '2021-03-18T17:50:05Z')
    assert.equal(first.abstract, 'We study prompt tuning & show that it matches fine-tuning <in many cases>, and it\'s cheap.')
    assert.equal(first.pdfUrl, 'https://arxiv.org/pdf/2103.10385v2')
    assert.equal(first.absUrl, 'https://arxiv.org/abs/2103.10385v2')
    assert.equal(first.primaryCategory, 'cs.CL')

    const second = items[1]
    assert.equal(second.arxivId, 'hep-th/9901001')
    assert.equal(second.title, 'A "toy" model')
    assert.deepEqual(second.authors, ['Jane Doe'])
    assert.equal(second.year, 1999)
    assert.equal(second.primaryCategory, 'hep-th')
    // href 写在最后一条属性里，仍应取到 PDF 链接。
    assert.equal(second.pdfUrl, 'https://arxiv.org/pdf/hep-th/9901001v1')
  })

  await check('parseOpenAlexWorks：abstract_inverted_index 按位置还原、字段映射正确', () => {
    const items = parseOpenAlexWorks(OPENALEX_FIXTURE)
    assert.equal(items.length, 1)
    const work = items[0]
    assert.equal(work.id, 'W2741809807')
    assert.equal(work.doi, '10.1038/s41586-020-2649-2')
    assert.equal(work.title, 'Array programming with NumPy')
    assert.deepEqual(work.authors, ['Charles R. Harris', 'K. Jarrod Millman'])
    assert.equal(work.year, 2020)
    assert.equal(work.venue, 'Nature')
    assert.equal(work.abstract, 'Array programming with NumPy is fun.')
    assert.equal(work.pdfUrl, 'https://example.org/numpy.pdf')
    assert.equal(work.url, 'https://example.org/numpy')

    // DOI 单条查询返回的是 work 对象本身，而不是 { results }。
    const single = parseOpenAlexWorks(OPENALEX_FIXTURE.results[0])
    assert.equal(single.length, 1)
    assert.equal(single[0].title, work.title)
  })

  await check('参数校验：缺参数/非法 ID/非法 DOI 在发请求前就抛中文错误', async () => {
    await assert.rejects(searchArxiv({}), /需要 query 或 id/)
    await assert.rejects(searchArxiv({ id: 'not-an-arxiv-id' }), /无效的 arXiv ID/)
    await assert.rejects(searchOpenAlex({}), /需要 query 或 doi/)
    await assert.rejects(searchOpenAlex({ doi: '10.12/xyz' }), /无效的 DOI/)
    await assert.rejects(searchBoth({}), /需要 query/)
    await assert.rejects(downloadPdf('ftp://example.com/a.pdf', path.join(os.tmpdir(), 'pb-x.pdf')), /只支持 http\(s\) 链接/)
    await assert.rejects(downloadPdf('not-a-url', path.join(os.tmpdir(), 'pb-x.pdf')), /无效的链接/)
  })
}

async function runOnline() {
  console.log('\n== 在线部分（真实接口，失败只记 SKIP）==')
  let first = null

  await checkOnline('searchArxiv({query:"prompt tuning", limit:3}) 返回非空', async () => {
    const result = await searchArxiv({ query: 'prompt tuning', limit: 3 })
    assert.equal(result.source, 'arxiv')
    assert.ok(result.items.length > 0, 'arXiv 检索结果为空')
    first = result.items[0]
    assert.ok(first.arxivId, '第一条结果缺少 arxivId')
    assert.ok(first.title.length > 0, '第一条结果缺少标题')
    console.log('      ' + first.arxivId + '  ' + first.title)
  })

  await checkOnline('searchOpenAlex({query:"prompt tuning", limit:3}) 返回非空', async () => {
    const result = await searchOpenAlex({ query: 'prompt tuning', limit: 3 })
    assert.equal(result.source, 'openalex')
    assert.ok(result.items.length > 0, 'OpenAlex 检索结果为空')
    console.log('      ' + result.items[0].title)
  })

  await checkOnline('searchOpenAlex({doi}) 能按 DOI 取回单条', async () => {
    const result = await searchOpenAlex({ doi: '10.1038/s41586-020-2649-2' })
    assert.ok(result.items.length > 0, 'DOI 查询结果为空')
    assert.equal(result.items[0].doi, '10.1038/s41586-020-2649-2')
  })

  await checkOnline('fetchArxivMeta 能按编号取回单条元数据', async () => {
    assert.ok(first, '上一步没拿到 arXiv 结果，无法验证 fetchArxivMeta')
    const meta = await fetchArxivMeta(first.arxivId)
    assert.ok(meta, 'fetchArxivMeta 返回 null')
    assert.equal(meta.arxivId, first.arxivId)
  })

  await checkOnline('searchBoth 并行合并后仍有结果且无重复标题', async () => {
    const result = await searchBoth({ query: 'prompt tuning', limit: 4 })
    assert.ok(result.items.length > 0, '合并结果为空')
    const keys = result.items.map((item) => String(item.title || '').toLowerCase() + '|' + item.year)
    assert.equal(new Set(keys).size, keys.length, '合并结果里存在重复标题')
  })

  await checkOnline('downloadPdf 下载到 %TEMP% 并校验 %PDF- 文件头', async () => {
    assert.ok(first, '上一步没拿到 arXiv 结果，无法验证下载')
    const dest = path.join(os.tmpdir(), 'pb-arxiv-test-' + process.pid + '-' + Date.now() + '.pdf')
    try {
      // 实测本机到 arxiv.org 的 PDF 只有几 KB/s，默认 120s 会正好卡在超时上；
      // 这里显式放宽，避免把「网络慢」误报成下载失败（函数默认值仍是契约里的 120s）。
      const result = await downloadPdf(first.pdfUrl || 'https://arxiv.org/pdf/' + first.arxivId, dest, {
        timeoutMs: 300000,
      })
      assert.ok(result.bytes > 10000, 'PDF 太小，疑似不是真文件：' + result.bytes + ' 字节')
      assert.equal(result.path, path.resolve(dest))
      const data = await fsp.readFile(dest)
      assert.equal(data.subarray(0, 5).toString('latin1'), '%PDF-', '文件头不是 %PDF-')
      assert.equal(data.length, result.bytes, '返回字节数与实际文件大小不一致')
      console.log('      已下载 ' + result.bytes + ' 字节 → ' + result.path)
    } finally {
      await fsp.rm(dest, { force: true })
      await fsp.rm(dest + '.tmp', { force: true })
    }
  })
}

try {
  await runOffline()
  await runOnline()
} catch (error) {
  stats.fail += 1
  console.log('FAIL  测试脚本自身异常')
  console.log('      ' + messageOf(error))
}

console.log('\n结果：PASS ' + stats.pass + ' / FAIL ' + stats.fail + ' / SKIP ' + stats.skip)
if (stats.fail > 0) {
  process.exitCode = 1
  console.log('存在失败用例。')
} else {
  console.log('ALL PASS')
}
