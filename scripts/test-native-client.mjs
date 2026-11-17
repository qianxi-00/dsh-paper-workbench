import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let exported
vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { exported = definition.factory(() => ({})) } } },
  console,
})
assert.equal(typeof exported.createNativeSessionBinding, 'function', '客户端应提供实际使用的会话引用控制器')

let passed = 0
async function check(name, run) {
  await run()
  passed += 1
  console.log('PASS  ' + name)
}
function fixture() {
  const acquired = []
  const states = []
  const sessions = {
    retain(sessionId, options) {
      let resolve, reject
      const ready = new Promise((yes, no) => { resolve = yes; reject = no })
      const sent = []
      const record = { sessionId, options, releases: 0, cancels: 0, sent, prompts: [] }
      const binding = { sessionId, session: {
        beginSubmission(input) { sent.push(input); return { requestId: 'request-' + sent.length } },
        async prompt(content, mode, signal, requestId) { record.prompts.push({ content, mode, signal, requestId }); return { ok: true, value: { accepted: true } } }, 
        cancel() { record.cancels += 1 },
      } }
      Object.assign(record, { resolve: () => resolve(binding), reject, binding,
        reference: { sessionId, binding, ready, release() { record.releases += 1 } },
      })
      acquired.push(record)
      return record.reference
    },
  }
  return { acquired, states, controller: exported.createNativeSessionBinding({ sessions, onState: state => states.push(state) }) }
}

await check('等待 ready 后只公开 retain 返回的精确 reference', async () => {
  const f = fixture()
  const opening = f.controller.select('paper-session-a')
  assert.equal(f.states.at(-1).loading, true)
  assert.equal(f.states.at(-1).reference, null)
  f.acquired[0].resolve()
  await opening
  assert.equal(f.states.at(-1).reference, f.acquired[0].reference)
  assert.equal(f.acquired[0].options.source, 'controllerOperation')
  f.controller.close()
})
await check('快速换会话忽略旧 ready，旧引用恰好释放一次', async () => {
  const f = fixture()
  const old = f.controller.select('a')
  const next = f.controller.select('b')
  f.acquired[1].resolve()
  await next
  f.acquired[0].resolve()
  await old
  assert.equal(f.states.at(-1).sessionId, 'b')
  assert.equal(f.states.at(-1).reference, f.acquired[1].reference)
  assert.equal(f.acquired[0].releases, 1)
  f.controller.close()
  assert.equal(f.acquired[1].releases, 1)
})
await check('重复选择不重复 retain；关闭只释放，不取消 Agent', async () => {
  const f = fixture()
  const a = f.controller.select('a')
  const same = f.controller.select('a')
  assert.equal(f.acquired.length, 1)
  f.acquired[0].resolve()
  await Promise.all([a, same])
  f.controller.close()
  f.controller.close()
  assert.equal(f.acquired[0].releases, 1)
  assert.equal(f.acquired[0].cancels, 0)
})
await check('初始化失败释放引用、显示错误，不能发送到主会话', async () => {
  const f = fixture()
  const opening = f.controller.select('a')
  f.acquired[0].reject(new Error('history unavailable'))
  await opening
  assert.equal(f.states.at(-1).reference, null)
  assert.match(f.states.at(-1).error, /history unavailable/)
  assert.equal(f.acquired[0].releases, 1)
  assert.throws(() => f.controller.submit('explain'), /会话尚未就绪/)
  f.controller.close()
})
await check('快捷提问保持完整文本，queue 提交且不操作原生草稿或附件', async () => {
  const f = fixture()
  const opening = f.controller.select('a')
  f.acquired[0].resolve()
  await opening
  const text = '完整选段：' + '正文与公式 $x^2$\n'.repeat(300)
  const result = await f.controller.submit(text)
  assert.equal(f.acquired[0].prompts.length, 1, '本地 pending 回显之后必须实际调用原生 prompt')
  assert.equal(f.acquired[0].prompts[0].content[0].text, text)
  assert.equal(f.acquired[0].prompts[0].requestId, result.requestId)
  assert.equal(f.acquired[0].prompts[0].mode, 'queue')
  assert.equal(result.requestId, 'request-1')
  assert.equal(f.acquired[0].sent.length, 1)
  assert.equal(f.acquired[0].sent[0].text, text)
  assert.equal(f.acquired[0].sent[0].mode, 'queue')
  assert.equal(f.acquired[0].sent[0].attachments.length, 0)
  f.controller.close()
  assert.throws(() => f.controller.submit('again'), /会话尚未就绪/)
})
await check('prompt 失败时自动 abandon 乐观提交，并支持携带原生文件回执', async () => {
  let abandoned = 0
  let promptMode = 'fail'
  const prompts = []
  const sessions = {
    retain(sessionId) {
      const binding = {
        sessionId,
        session: {
          beginSubmission() { return { requestId: 'req-att', abandon() { abandoned += 1 } } },
          async prompt(content, mode, signal, requestId) {
            prompts.push({ content, mode, requestId })
            if (promptMode === 'fail') return { ok: false, error: { message: 'upload rejected' } }
            return { ok: true, value: { accepted: true } }
          },
        },
      }
      return { sessionId, binding, ready: Promise.resolve(binding), release() {} }
    },
  }
  const controller = exported.createNativeSessionBinding({ sessions, onState() {} })
  await controller.select('s-att')
  await assert.rejects(() => controller.submit('hello'), /upload rejected/)
  assert.equal(abandoned, 1, 'prompt 返回 ok:false 时应清理乐观 pending 项')
  promptMode = 'ok'
  await controller.submit('see file', 's-att', {
    pendingAttachments: [{ type: 'file', value: { name: 'excerpt.md' } }],
    contentParts: [{ type: 'file', receiptId: 'rcpt-1' }, { type: 'text', text: 'see file' }],
  })
  assert.equal(prompts.at(-1).content[0].receiptId, 'rcpt-1')
  controller.close()
})
console.log(`\nPASS ${passed} / FAIL 0`)
