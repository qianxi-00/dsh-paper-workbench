/**
 * lib/ocr.js 取消与结果体上限自测脚本（全离线）。
 *
 * 目的：验证 AbortSignal 从提交 → 轮询（含 sleep 中途）→ 取结果整条链路都能被外部取消，
 * 且取结果时有响应体大小上限。全部用假 fetchImpl / sleepImpl，不联网、不读真实 token。
 * 运行：node scripts/test-ocr-cancel.mjs
 */
import assert from 'node:assert/strict'

import { submitJob, pollJob, fetchResults } from '../lib/ocr.js'

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

const FAKE_TOKEN = '{{SECRET_cancel7t2}}'

/** 假响应：生成一个只有 text() 的成功响应（贴近真实 Response 的最小形状）。 */
function textResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => body }
}

/** 假响应：带 arrayBuffer()，用来验证真 fetch 的字节级读取与上限。 */
function bufferResponse(buffer, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => buffer,
    text: async () => Buffer.from(buffer).toString('utf8'),
  }
}

/** 一个会挂起直到 signal 被 abort 的 fetch：模拟真实 fetch 在取消时 reject。 */
function abortableFetch(counter) {
  return async function fetchImpl(url, init) {
    if (counter) counter.calls += 1
    const signal = init && init.signal
    return new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      if (!signal) return
      if (signal.aborted) return fail()
      signal.addEventListener('abort', fail, { once: true })
    })
  }
}

/** 渲染之后 body 读取阶段才被取消的 fetch：fetch 立刻成功，arrayBuffer 挂起直到 abort。 */
function downloadAbortableFetch(counter) {
  return async function fetchImpl(url, init) {
    if (counter) counter.calls += 1
    const signal = init && init.signal
    return {
      status: 200,
      ok: true,
      arrayBuffer: () =>
        new Promise((resolve, reject) => {
          const fail = () => reject(Object.assign(new Error('stream aborted'), { name: 'AbortError' }))
          if (signal && signal.aborted) return fail()
          if (signal) signal.addEventListener('abort', fail, { once: true })
        }),
    }
  }
}

async function run() {
  console.log('== OCR 取消 / 结果体上限（假 fetchImpl，不联网）==')

  await check('submitJob：进入即已取消 → 抛「OCR 任务已取消」且不发请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const counter = { calls: 0 }
    await assert.rejects(
      submitJob({
        token: FAKE_TOKEN,
        fileUrl: 'https://example.org/paper.pdf',
        fetchImpl: abortableFetch(counter),
        signal: controller.signal,
      }),
      /OCR 任务已取消/,
    )
    assert.equal(counter.calls, 0, '已取消时不该发起任何网络请求')
  })

  await check('submitJob：请求进行中被取消 → 抛取消错误而不是网络错误', async () => {
    const controller = new AbortController()
    const pending = submitJob({
      token: FAKE_TOKEN,
      fileUrl: 'https://example.org/paper.pdf',
      fetchImpl: abortableFetch(),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, (error) => {
      assert.match(error.message, /OCR 任务已取消/)
      assert.ok(!error.message.includes(FAKE_TOKEN), '错误消息里泄露了 token')
      return true
    })
  })

  await check('pollJob：已取消 → 不发轮询请求，直接抛取消错误', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await assert.rejects(
      pollJob({
        token: FAKE_TOKEN,
        jobId: 'job-precancel',
        fetchImpl: async () => {
          calls += 1
          return textResponse(JSON.stringify({ data: { state: 'pending' } }))
        },
        sleepImpl: async () => {},
        signal: controller.signal,
      }),
      /OCR 任务已取消/,
    )
    assert.equal(calls, 0, '已取消时不该发起轮询请求')
  })

  await check('pollJob：sleep 中途取消 → 立刻返回取消错误，不等满 interval', async () => {
    const controller = new AbortController()
    let pollCalls = 0
    // 每次都返回 pending，保证一定会进入 sleep；sleep 永不 resolve，只能靠 abort 打断。
    const fetchImpl = async () => {
      pollCalls += 1
      return textResponse(JSON.stringify({ data: { state: 'pending' } }))
    }
    const startedAt = Date.now()
    const pending = pollJob({
      token: FAKE_TOKEN,
      jobId: 'job-sleep',
      intervalMs: 600000, // 极长：若 sleep 不可中断，这里会挂死
      timeoutMs: 900000,
      fetchImpl,
      sleepImpl: () => new Promise(() => {}),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 15)
    await assert.rejects(pending, /OCR 任务已取消/)
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 2000, '取消应在毫秒级返回，实际耗时 ' + elapsed + 'ms')
    assert.ok(pollCalls >= 1, '至少应完成一次轮询后进入 sleep')
  })

  await check('pollJob：失败消息带 jobId 上下文（且不含 token）', async () => {
    await assert.rejects(
      pollJob({
        token: FAKE_TOKEN,
        jobId: 'job-ctx-9',
        fetchImpl: async () =>
          textResponse(JSON.stringify({ data: { state: 'failed', errorMsg: 'bad ' + FAKE_TOKEN } })),
        sleepImpl: async () => {},
      }),
      (error) => {
        assert.match(error.message, /OCR 任务失败/)
        assert.match(error.message, /job-ctx-9/)
        assert.ok(!error.message.includes(FAKE_TOKEN), '错误消息里泄露了 token')
        return true
      },
    )
  })

  await check('fetchResults：下载阶段被取消 → 抛取消错误而不是读取失败', async () => {
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = fetchResults({
      jsonUrl: 'https://cdn.example/out.jsonl',
      jobId: 'job-download',
      fetchImpl: downloadAbortableFetch(),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, (error) => {
      assert.match(error.message, /OCR 任务已取消/)
      assert.ok(!error.message.includes('job-download'))
      return true
    })
    assert.ok(Date.now() - startedAt < 2000, '取消应立即返回')
  })

  await check('fetchResults：已取消 → 不发起下载请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const counter = { calls: 0 }
    await assert.rejects(
      fetchResults({
        jsonUrl: 'https://cdn.example/out.jsonl',
        fetchImpl: downloadAbortableFetch(counter),
        signal: controller.signal,
      }),
      /OCR 任务已取消/,
    )
    assert.equal(counter.calls, 0, '已取消时不该发起下载请求')
  })

  await check('fetchResults：text 形状响应超过上限 → 中文错误且带 jobId', async () => {
    const big = 'x'.repeat(4096)
    await assert.rejects(
      fetchResults({
        jsonUrl: 'https://cdn.example/out.jsonl',
        jobId: 'job-big',
        maxResultBytes: 1024,
        fetchImpl: async () => textResponse(big),
      }),
      (error) => {
        assert.match(error.message, /结果体超过上限/)
        assert.match(error.message, /job-big/)
        return true
      },
    )
  })

  await check('fetchResults：arrayBuffer 真实字节超过上限 → 中文错误', async () => {
    const buffer = Buffer.alloc(4096, 0x61)
    await assert.rejects(
      fetchResults({
        jsonUrl: 'https://cdn.example/out.jsonl',
        maxResultBytes: 1024,
        fetchImpl: async () => bufferResponse(buffer),
      }),
      /结果体超过上限/,
    )
  })

  await check('fetchResults：正常大小结果照常解析（上限不误伤）', async () => {
    const body = JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: '正常一页' } }] } })
    const out = await fetchResults({
      jsonUrl: 'https://cdn.example/out.jsonl',
      maxResultBytes: 1024 * 1024,
      fetchImpl: async () => textResponse(body),
    })
    assert.equal(out.pages.length, 1)
    assert.equal(out.pages[0].markdown, '正常一页')
  })
}

try {
  await run()
} catch (error) {
  stats.fail += 1
  console.log('FAIL  测试脚本自身异常')
  console.log('      ' + messageOf(error))
}

console.log('\n结果：PASS ' + stats.pass + ' / FAIL ' + stats.fail)
if (stats.fail > 0) {
  process.exitCode = 1
  console.log('存在失败用例。')
} else {
  console.log('ALL PASS')
}
