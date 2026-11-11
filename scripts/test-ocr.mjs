/**
 * lib/ocr.js 自测脚本。
 *
 * 离线部分全程用假 fetchImpl / sleepImpl，不联网、不读真实 token：把提交（multipart 与
 * URL 两种模式）、轮询状态机、取结果、解析、拼文档都覆盖一遍，其中鉴权失败/缺字段等
 * 负向用例顺便验证「错误消息里不出现 token」。
 * 真机联调只在环境变量 PADDLE_OCR_TOKEN 存在时跑：用 %TEMP% 下现场生成的一页 PDF
 * （不上传资料库里的真实论文），任何失败只记 SKIP 并打印状态码，绝不打印 token。
 * 运行：node scripts/test-ocr.mjs
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_JOB_URL,
  OCR_MODELS,
  DEFAULT_MODEL,
  submitJob,
  pollJob,
  parseJsonl,
  fetchResults,
  pagesToMarkdown,
  runOcr,
} from '../lib/ocr.js'

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

/** 假响应：只要 fetchImpl 不该真发请求，这个形状就够用（带 ok，贴近真实 Response）。 */
function jsonResponse(payload, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(payload) }
}

function textResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => body }
}

// --- 固定 fixture ---------------------------------------------------------

/** 2 页版面结果（VL/Structure 的形状）：中间夹空行，第 1 页带 images 与 outputImages。 */
const LAYOUT_FIXTURE = [
  JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text: '# 标题\n\n第一页正文',
            images: { 'imgs/a.png': 'https://cdn.example/a.png', 'imgs/bad.png': null },
          },
          outputImages: { layout: 'https://cdn.example/p1-layout.png' },
        },
      ],
    },
  }),
  '',
  JSON.stringify({
    result: {
      layoutParsingResults: [{ markdown: { text: '第二页正文', images: {} }, outputImages: {} }],
    },
  }),
  '',
].join('\n')

/** PP-OCRv6 的形状：没有 markdown，只有 ocrImage 与 prunedResult.rec_texts。 */
const OCR_FIXTURE = [
  JSON.stringify({
    result: {
      ocrResults: [
        { ocrImage: 'https://cdn.example/o1.png', prunedResult: { rec_texts: ['第一行', '第二行'] } },
        { ocrImage: 'https://cdn.example/o2.png' },
      ],
    },
  }),
].join('\n')

/** 用作假 token 的字面量：断言它不会出现在任何错误消息里。 */
const FAKE_TOKEN = 'pb-test-token-9f3c1d'

async function runOffline() {
  console.log('== 离线部分（假 fetchImpl / sleepImpl，不联网）==')

  await check('常量导出：默认地址、模型清单与默认模型', () => {
    assert.equal(DEFAULT_JOB_URL, 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs')
    assert.deepEqual(OCR_MODELS, ['PaddleOCR-VL-1.6', 'PP-StructureV3', 'PP-OCRv6'])
    assert.equal(DEFAULT_MODEL, 'PaddleOCR-VL-1.6')
  })

  await check('parseJsonl：2 页版面结果（含空行/图片映射）解析正确', () => {
    const parsed = parseJsonl(LAYOUT_FIXTURE)
    assert.equal(parsed.skipped, 0)
    assert.equal(parsed.pages.length, 2)

    const first = parsed.pages[0]
    assert.equal(first.n, 1)
    assert.equal(first.markdown, '# 标题\n\n第一页正文')
    // text 是去掉标记的纯文本视图。
    assert.equal(first.text, '标题\n\n第一页正文')
    // images 只保留字符串地址，null 之类的脏值被丢掉。
    assert.deepEqual(first.images, { 'imgs/a.png': 'https://cdn.example/a.png' })
    assert.deepEqual(first.outputImages, { layout: 'https://cdn.example/p1-layout.png' })

    const second = parsed.pages[1]
    assert.equal(second.n, 2)
    assert.equal(second.markdown, '第二页正文')
    assert.deepEqual(second.images, {})
    assert.deepEqual(second.outputImages, {})
  })

  await check('parseJsonl：ocrResults + prunedResult.rec_texts 拼纯文本，无文字页留空', () => {
    const parsed = parseJsonl(OCR_FIXTURE)
    assert.equal(parsed.pages.length, 2)

    const first = parsed.pages[0]
    assert.equal(first.markdown, '')
    assert.equal(first.text, '第一行\n第二行')
    assert.deepEqual(first.images, {})
    // PP-OCRv6 没有版面图，整页图并入 outputImages 便于前端复用取图路径。
    assert.deepEqual(first.outputImages, { ocrImage: 'https://cdn.example/o1.png' })

    const second = parsed.pages[1]
    assert.equal(second.markdown, '')
    assert.equal(second.text, '')
  })

  await check('parseJsonl：空行跳过、坏行只计 skipped 不整体失败', () => {
    const bad = parseJsonl(['{"result":{"layoutParsingResults":[{"markdown":{"text":"好页"}}]}}', '{坏行', '', 'null', '[]'].join('\n'))
    assert.equal(bad.pages.length, 1)
    assert.equal(bad.skipped, 3)
    assert.equal(bad.pages[0].n, 1)
    assert.equal(bad.pages[0].markdown, '好页')
  })

  await check('pagesToMarkdown：含 ## p.1/## p.2 且顺序正确，空页仍占号', () => {
    const out = pagesToMarkdown([
      { n: 1, markdown: '第一页', text: '第一页' },
      { n: 2, markdown: '', text: '' },
      { n: 3, markdown: '第三页', text: '第三页' },
    ])
    assert.equal(out.pagesWithText, 2)
    assert.equal(out.markdown, '## p.1\n\n第一页\n\n## p.2\n\n## p.3\n\n第三页')
    assert.ok(out.markdown.indexOf('## p.1') < out.markdown.indexOf('## p.2'), '页码顺序不对')
  })

  await check('空 token：submitJob 抛中文错误且一个请求都不发', async () => {
    let touched = 0
    const fetchImpl = async () => {
      touched += 1
      return jsonResponse({})
    }
    await assert.rejects(
      submitJob({ token: '   ', filePath: 'no-such-file.pdf', fetchImpl }),
      /未配置 PaddleOCR 的 API Key/,
    )
    assert.equal(touched, 0, '空 token 时不该调用 fetch')
  })

  await check('提交失败：401 带状态码与服务端正文，正文里的 token 被替换成 ***', async () => {
    const fetchImpl = async () => ({
      status: 401,
      ok: false,
      text: async () => JSON.stringify({ code: 'PERMISSION_DENIED', message: 'invalid key ' + FAKE_TOKEN }),
    })
    await assert.rejects(
      submitJob({ token: FAKE_TOKEN, fileUrl: 'https://example.org/paper.pdf', fetchImpl }),
      (error) => {
        assert.match(error.message, /OCR 提交失败/)
        assert.match(error.message, /HTTP 401/)
        assert.ok(!error.message.includes(FAKE_TOKEN), '错误消息里泄露了 token：' + error.message)
        assert.match(error.message, /\*\*\*/)
        return true
      },
    )
  })

  await check('提交失败：200 但缺 data.jobId → 中文错误；响应非 JSON 也报中文错', async () => {
    await assert.rejects(
      submitJob({ token: FAKE_TOKEN, fileUrl: 'https://example.org/paper.pdf', fetchImpl: async () => jsonResponse({ data: {} }) }),
      /OCR 提交失败：响应里缺少 data\.jobId/,
    )
    await assert.rejects(
      submitJob({ token: FAKE_TOKEN, fileUrl: 'https://example.org/paper.pdf', fetchImpl: async () => textResponse('<html>gateway</html>') }),
      /OCR 提交失败：响应不是合法 JSON/,
    )
  })

  await check('提交：本地文件走 multipart（file/model/optionalPayload 三个字段）', async () => {
    const pdfPath = path.join(os.tmpdir(), 'pb-ocr-test-' + process.pid + '.pdf')
    await fsp.writeFile(pdfPath, Buffer.from('%PDF-1.4\n% fixture\n'))
    try {
      let captured = null
      const fetchImpl = async (url, init) => {
        captured = { url, init }
        return jsonResponse({ data: { jobId: 'job-multipart' } })
      }
      const created = await submitJob({ token: FAKE_TOKEN, filePath: pdfPath, fetchImpl })
      assert.equal(created.jobId, 'job-multipart')
      assert.equal(captured.url, DEFAULT_JOB_URL)
      assert.equal(captured.init.method, 'POST')
      assert.equal(captured.init.headers.Authorization, 'bearer ' + FAKE_TOKEN)
      assert.ok(captured.init.body instanceof FormData, '本地文件应走 multipart/form-data')
      assert.equal(captured.init.body.get('model'), DEFAULT_MODEL)
      assert.equal(captured.init.body.get('optionalPayload'), '{}')
      const uploaded = captured.init.body.get('file')
      assert.equal(uploaded.name, path.basename(pdfPath))
    } finally {
      await fsp.rm(pdfPath, { force: true })
    }
  })

  await check('轮询：pending → running → done，onProgress 3 次、jsonUrl 与 polls 正确', async () => {
    const states = [
      { state: 'pending' },
      { state: 'running', extractProgress: { totalPages: 2, extractedPages: 1 } },
      {
        state: 'done',
        extractProgress: { extractedPages: 2, startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:00:30Z' },
        resultUrl: { jsonUrl: 'https://cdn.example/out.jsonl' },
      },
    ]
    let calls = 0
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url, init })
      const payload = { data: states[calls] }
      calls += 1
      return jsonResponse(payload)
    }
    const progress = []
    const sleeps = []
    const result = await pollJob({
      token: FAKE_TOKEN,
      jobId: 'job-1',
      intervalMs: 1000,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
      onProgress: (info) => progress.push(info),
    })

    assert.equal(result.state, 'done')
    assert.equal(result.jsonUrl, 'https://cdn.example/out.jsonl')
    assert.equal(result.polls, 3)
    assert.equal(calls, 3)
    assert.equal(seen[0].url, DEFAULT_JOB_URL + '/job-1')
    assert.equal(seen[0].init.method, 'GET')
    assert.equal(seen[0].init.headers.Authorization, 'bearer ' + FAKE_TOKEN)

    assert.equal(progress.length, 3)
    assert.deepEqual(
      progress.map((info) => info.state),
      ['pending', 'running', 'done'],
    )
    assert.equal(progress[0].totalPages, null)
    assert.equal(progress[0].extractedPages, null)
    assert.equal(progress[1].totalPages, 2)
    assert.equal(progress[1].extractedPages, 1)
    assert.equal(progress[2].extractedPages, 2)
    // done 的 extractProgress 里没有 totalPages，沿用上一次已知值，进度条不会回退。
    assert.equal(progress[2].totalPages, 2)
    assert.deepEqual(sleeps, [1000, 1000])
  })

  await check('轮询：state=failed → 抛含 errorMsg 的中文错误', async () => {
    const fetchImpl = async () => jsonResponse({ data: { state: 'failed', errorMsg: '页数超过上限 1000' } })
    await assert.rejects(
      pollJob({ token: FAKE_TOKEN, jobId: 'job-2', fetchImpl, sleepImpl: async () => {} }),
      (error) => {
        assert.match(error.message, /OCR 任务失败/)
        assert.match(error.message, /页数超过上限 1000/)
        return true
      },
    )
  })

  await check('取结果：jsonl 下载不带 Authorization，坏行计入 skipped', async () => {
    let captured = null
    const fetchImpl = async (url, init) => {
      captured = { url, init }
      return textResponse(LAYOUT_FIXTURE + '\n{坏行\n')
    }
    const out = await fetchResults({ jsonUrl: 'https://cdn.example/out.jsonl', fetchImpl })
    assert.equal(out.pages.length, 2)
    assert.equal(out.skipped, 1)
    assert.equal(captured.url, 'https://cdn.example/out.jsonl')
    assert.equal(captured.init.headers.Authorization, undefined, '对象存储直链不该带鉴权头')
    await assert.rejects(fetchResults({ jsonUrl: '  ', fetchImpl }), /缺少 jsonUrl/)
  })

  await check('runOcr：submit + poll + fetch + parse 串起来，返回契约里的字段', async () => {
    const fetchImpl = async (url, init) => {
      if (url === DEFAULT_JOB_URL && init.method === 'POST') {
        const body = JSON.parse(init.body)
        assert.equal(body.fileUrl, 'https://example.org/paper.pdf')
        assert.equal(body.model, DEFAULT_MODEL)
        return jsonResponse({ data: { jobId: 'job-run' } })
      }
      if (url === DEFAULT_JOB_URL + '/job-run') {
        return jsonResponse({
          data: { state: 'done', extractProgress: { extractedPages: 2 }, resultUrl: { jsonUrl: 'https://cdn.example/run.jsonl' } },
        })
      }
      if (url === 'https://cdn.example/run.jsonl') return textResponse(LAYOUT_FIXTURE)
      throw new Error('未预期的请求：' + url)
    }
    const result = await runOcr({
      token: FAKE_TOKEN,
      fileUrl: 'https://example.org/paper.pdf',
      fetchImpl,
      sleepImpl: async () => {},
    })
    assert.equal(result.jobId, 'job-run')
    assert.equal(result.model, DEFAULT_MODEL)
    assert.equal(result.pages.length, 2)
    assert.equal(result.pagesWithText, 2)
    assert.equal(result.markdown, '## p.1\n\n# 标题\n\n第一页正文\n\n## p.2\n\n第二页正文')
    assert.ok(result.elapsedMs >= 0)
  })
}

/** 现场生成一页最小合法 PDF：不碰资料库里的真实论文，也能验证真实接口。 */
function buildSamplePdf(title) {
  const header = '%PDF-1.4\n'
  const content = 'BT /F1 24 Tf 72 760 Td (' + title + ') Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(content, 'latin1') + ' >>\nstream\n' + content + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = ''
  const offsets = []
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(header + body, 'latin1'))
    body += i + 1 + ' 0 obj\n' + objects[i] + '\nendobj\n'
  }
  const xrefAt = Buffer.byteLength(header + body, 'latin1')
  let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
  for (const offset of offsets) xref += String(offset).padStart(10, '0') + ' 00000 n \n'
  const trailer = 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n'
  return Buffer.from(header + body + xref + trailer, 'latin1')
}

async function runLive() {
  console.log('\n== 真机联调（真实接口，失败只记 SKIP）==')
  const token = typeof process.env.PADDLE_OCR_TOKEN === 'string' ? process.env.PADDLE_OCR_TOKEN.trim() : ''
  if (token === '') {
    skip('真机联调', '未设置 PADDLE_OCR_TOKEN')
    return
  }
  // 生成一页临时 PDF 再上传：绝不把资料库里的真实论文送去第三方服务。
  const file = path.join(os.tmpdir(), 'pb-ocr-live-' + process.pid + '.pdf')
  await fsp.writeFile(file, buildSamplePdf('Hello OCR'))
  // 任何打印都必须先过脱敏，防止底层错误把 token 带出来。
  const redact = (text) => String(text).split(token).join('***')
  try {
    const result = await runOcr({ token, filePath: file, intervalMs: 5000, timeoutMs: 600000 })
    assert.ok(typeof result.jobId === 'string' && result.jobId !== '', '缺少 jobId')
    assert.ok(result.pages.length >= 1, '返回 0 页')
    stats.pass += 1
    console.log('PASS  真机联调：jobId=' + result.jobId + '，页数 ' + result.pages.length + '，Markdown ' + result.markdown.length + ' 字符')
    console.log('      ' + redact(result.markdown.slice(0, 120).replace(/\s+/g, ' ')))
  } catch (error) {
    const message = redact(messageOf(error))
    const status = /HTTP (\d{3})/.exec(message)
    skip('真机联调', '状态码 ' + (status ? status[1] : '无') + '：' + message)
  } finally {
    await fsp.rm(file, { force: true })
  }
}

try {
  await runOffline()
  await runLive()
} catch (error) {
  stats.fail += 1
  console.log('FAIL  测试脚本自身异常')
  console.log('      ' + messageOf(error))
}

console.log('\n结果：PASS ' + stats.pass + ' / FAIL ' + stats.fail + (stats.skip > 0 ? ' / SKIP ' + stats.skip : ''))
if (stats.fail > 0) {
  process.exitCode = 1
  console.log('存在失败用例。')
} else {
  console.log('ALL PASS')
}
