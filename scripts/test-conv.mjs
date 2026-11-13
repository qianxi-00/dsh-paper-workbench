/**
 * v3.1 对话（多篇论文 + 附件）回归测试。
 *
 *   node scripts/test-conv.mjs
 *
 * 两块：
 *   1) lib/conv.js 的纯逻辑（id、归一化、范围提示词）—— 不碰磁盘；
 *   2) store 的对话 CRUD 与附件落盘 —— 全程指向 %TEMP% 的临时数据根，
 *      跑完整个目录删掉，绝不碰 ~/.dsh/paper-workbench。
 *
 * 为什么要测：
 *   - 对话 id 直接当宿主会话 id 用，脏字符会让 sessionController 建会话失败；
 *   - 范围提示词是「多篇论文一起问」的全部上下文，少一行模型就不知道在看哪几篇；
 *   - 附件删除必须限定在 chats/<id>/ 下，否则这个接口就成了任意文件删除器。
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const stamp = Date.now() + '-' + process.pid
const root = path.join(os.tmpdir(), 'pb-conv-test-' + stamp)
process.env.DSH_PAPER_WORKBENCH_DATA = root

const {
  buildScopePrompt,
  conversationSummary,
  makeConversation,
  mergeConversation,
  newConversationId,
  normalizeAttachments,
  normalizeChats,
  normalizePaperIds,
  normalizeTitle,
  sessionIdForConversation,
} = await import('../lib/conv.js')
const store = await import('../lib/store.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log('PASS  ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail += 1
    console.log('FAIL  ' + name + (detail ? '  ' + detail : ''))
  }
}

async function expectError(name, fn) {
  try {
    await fn()
    check(name, false, '没有抛错')
  } catch (error) {
    check(name, true, '「' + error.message + '」')
  }
}

async function main() {
  // ---- 纯逻辑：id 与会话 id
  const a = newConversationId(1700000000000, () => 0.5)
  const b = newConversationId(1700000000000, () => 0.25)
  check('会话 id 形状 c-<时间>-<随机>', /^c-[0-9a-z]+-[0-9a-z]{4}$/.test(a), a)
  check('随机数不同 → id 不同', a !== b, a + ' / ' + b)
  check('会话 id 符合 store 的 ID_RE', /^[a-z0-9][a-z0-9._-]{0,79}$/.test(a))
  check('宿主会话 id 加前缀', sessionIdForConversation('c-abc-1234') === 'pb-conv-c-abc-1234', sessionIdForConversation('c-abc-1234'))
  check('空 id 有兜底', sessionIdForConversation('') === 'pb-conv-conv', sessionIdForConversation(''))
  check('脏字符被替换', sessionIdForConversation('a b/c') === 'pb-conv-a-b-c', sessionIdForConversation('a b/c'))
  const longId = sessionIdForConversation('x'.repeat(200))
  check('宿主会话 id 不超过 64', longId.length <= 64, 'len=' + longId.length)

  // ---- 归一化
  check(
    '论文 id 去重 + 丢非法 + 保序',
    JSON.stringify(normalizePaperIds(['b', 'a', 'b', '', 'bad id', null, 'a'])) === JSON.stringify(['b', 'a']),
    JSON.stringify(normalizePaperIds(['b', 'a', 'b', '', 'bad id', null, 'a'])),
  )
  check('论文 id 最多 30 条', normalizePaperIds(Array.from({ length: 50 }, (_, i) => 'p' + i)).length === 30)
  const atts = normalizeAttachments([
    { name: 'a.pdf', path: 'C:/x/a.pdf', size: '12' },
    { path: 'C:/x/b.pdf' },
    { name: 'no-path' },
    null,
  ])
  check('附件：丢无 path、补 name、size 数字', atts.length === 2 && atts[1].name === 'b.pdf' && atts[0].size === 12, JSON.stringify(atts))
  check('标题去空白 + 截断', normalizeTitle('  hello   world  ') === 'hello world' && normalizeTitle('x'.repeat(100)).length === 80)
  check('标题空 → 兜底', normalizeTitle('   ', '新对话') === '新对话')

  // ---- 新建 / 合并 / 列表归一化
  const made = makeConversation({ title: '多篇', paperIds: ['p1', 'p2', 'p1'] }, { now: '2026-01-01T00:00:00.000Z', random: () => 0.5 })
  check('新建：字段齐 + sessionId 对齐', made.id && made.sessionId === sessionIdForConversation(made.id) && made.paperIds.length === 2, made.id)
  check('新建：时间戳一致', made.createdAt === '2026-01-01T00:00:00.000Z' && made.updatedAt === made.createdAt)
  const merged = mergeConversation(made, { title: '改名了', paperIds: ['p3'] }, { now: '2026-01-02T00:00:00.000Z' })
  check('合并：改标题与范围、保 createdAt', merged.title === '改名了' && merged.paperIds[0] === 'p3' && merged.createdAt === made.createdAt && merged.updatedAt === '2026-01-02T00:00:00.000Z')
  const chats = normalizeChats({
    version: 1,
    activeId: 'nope',
    items: [made, { id: 'bad id' }, made, null],
  })
  check('列表：丢坏条目 + 去重 + activeId 兜底', chats.items.length === 1 && chats.activeId === made.id, JSON.stringify(chats.activeId))

  // ---- 范围提示词
  const prompt = buildScopePrompt({
    conversation: made,
    papers: [
      { id: 'p1', title: '论文一', pages: 12, path: 'C:/x/a.pdf' },
      { id: 'p2', title: '论文二', pages: 0, path: '' },
    ],
    attachments: [{ name: 'notes.md', path: 'C:/x/notes.md' }],
  })
  check('提示词：论文范围标题', prompt.includes('【本次对话的论文范围】'))
  check('提示词：id 与页数', prompt.includes('id=p1') && prompt.includes('12 页'))
  check('提示词：PDF 路径', prompt.includes('PDF: C:/x/a.pdf'))
  check('提示词：没页数的论文不写 0 页', !prompt.includes('0 页'))
  check('提示词：附件段 + 路径', prompt.includes('【用户上传的附件】') && prompt.includes('notes.md：C:/x/notes.md'))
  check('提示词：要求标页码', prompt.includes('[p.N]'))
  check('提示词：没范围时为空串', buildScopePrompt({}) === '')
  check('摘要：带 attachmentCount', conversationSummary({ ...made, attachments: [{ name: 'a', path: 'p' }] }).attachmentCount === 1)

  // ---- store：CRUD
  await fsp.rm(root, { recursive: true, force: true })
  const c1 = await store.createConversation({ title: '对话一', paperIds: ['p1'] })
  const c2 = await store.createConversation({ title: '对话二', paperIds: ['p2', 'p3'] })
  let data = await store.listConversations()
  check('落盘：两条对话、新的在前', data.items.length === 2 && data.items[0].id === c2.id, 'activeId=' + data.activeId)
  check('落盘：activeId 指向最新', data.activeId === c2.id)
  check('落盘：chats.json 真存在', await fsp.stat(path.join(root, 'chats.json')).then(() => true, () => false))
  check('getConversation 命中', (await store.getConversation(c1.id)).title === '对话一')
  check('getConversation 未命中 → null', (await store.getConversation('c-nope-0000')) === null)

  const updated = await store.updateConversation(c1.id, { title: '改过', paperIds: ['p1', 'p2'] })
  check('更新：标题与范围', updated.title === '改过' && updated.paperIds.length === 2)
  check('更新：持久化', (await store.getConversation(c1.id)).title === '改过')
  await expectError('更新不存在的对话要报错', () => store.updateConversation('c-nope-0000', { title: 'x' }))

  await store.setActiveConversation(c1.id)
  check('切换 activeId', (await store.listConversations()).activeId === c1.id)

  // ---- store：附件
  const attached = await store.attachToConversation(c2.id, { name: 'a b/../note.txt', data: Buffer.from('hello attachment') })
  check('附件：落在 chats/<id>/files/', attached.attachment.path.includes(path.join('chats', c2.id, 'files')))
  check('附件：文件名去掉路径', attached.attachment.name === 'note.txt', attached.attachment.name)
  check('附件：大小正确', attached.attachment.size === 16)
  check('附件：写进清单', (await store.getConversation(c2.id)).attachments.length === 1)
  check('附件：文件真的在盘上', (await fsp.readFile(attached.attachment.path, 'utf8')) === 'hello attachment')
  const again = await store.attachToConversation(c2.id, { name: 'note.txt', data: Buffer.from('second') })
  check('附件：重名加 (2)', again.attachment.name === 'note (2).txt', again.attachment.name)
  await expectError('附件：空内容要报错', () => store.attachToConversation(c2.id, { name: 'empty.txt', data: Buffer.alloc(0) }))

  await expectError('附件：不允许删对话目录外的文件', () => store.detachFromConversation(c2.id, path.join(root, 'index.json')))
  const detached = await store.detachFromConversation(c2.id, attached.attachment.path)
  check('附件：移除后清单少一条', detached.conversation.attachments.length === 1)
  check('附件：文件被删', await fsp.stat(attached.attachment.path).then(() => false, () => true))

  // ---- store：删除对话
  const removed = await store.removeConversation(c2.id)
  data = await store.listConversations()
  check('删除：列表少一条', data.items.length === 1 && data.items[0].id === c1.id)
  check('删除：activeId 顺延', removed.activeId === c1.id)
  check('删除：附件目录被清掉', await fsp.stat(path.join(root, 'chats', c2.id)).then(() => false, () => true))
  await expectError('删除不存在的对话要报错', () => store.removeConversation(c2.id))

  // ---- 并发：chats.json 的读改写必须串行（曾实测 8 并发只记下 3 条附件）
  const c3 = await store.createConversation({ title: '并发附件' })
  const uploads = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      store.attachToConversation(c3.id, { name: 'p' + index + '.txt', data: Buffer.from('x' + index) })),
  )
  const kept = (await store.getConversation(c3.id)).attachments
  check('附件：6 个并发上传都记进清单', kept.length === 6, '记下 ' + kept.length + ' 条')
  check('附件：并发上传都落盘', (await Promise.all(kept.map((item) => fsp.stat(item.path).then(() => true, () => false)))).every(Boolean))
  check('附件：并发上传返回的是同一个对话', uploads.every((item) => item.attachment.path.includes(c3.id)))

  // 超过上限要报错，而不是「文件落盘了但清单里没有」
  for (let index = kept.length; index < 40; index += 1) {
    await store.attachToConversation(c3.id, { name: 'fill' + index + '.txt', data: Buffer.from('y') })
  }
  await expectError('附件：第 41 个要报错', () => store.attachToConversation(c3.id, { name: 'overflow.txt', data: Buffer.from('z') }))
  check('附件：报错后没有多出文件', (await store.getConversation(c3.id)).attachments.length === 40)

  // ---- 坏文件不影响启动
  await fsp.writeFile(path.join(root, 'chats.json'), '{ 这不是 JSON', 'utf8')
  const recovered = await store.listConversations()
  check('chats.json 坏了 → 空列表而不是崩', Array.isArray(recovered.items) && recovered.items.length === 0)

  console.log('')
  console.log(pass + ' PASS / ' + fail + ' FAIL')
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error('测试崩了：', error)
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  process.exit(1)
})
