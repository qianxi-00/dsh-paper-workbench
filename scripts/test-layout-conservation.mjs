// These cases prevent content deletion or cross-column/distant paragraph joins.
import assert from 'node:assert/strict'
import { cleanLayoutBlocks } from '../lib/layout.js'
let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name) }
  catch (error) { fail++; console.error('FAIL ' + name + ': ' + error.message) }
}
const body = (order, text, x, y, width = 100, height = 16) => ({ order, page: 1, kind: 'body', text, bbox: { x, y, width, height } })
const formula = (order, latex, x, y) => ({ order, page: 1, kind: 'formula', text: '', latex, bbox: { x, y, width: 100, height: 16 } })
check('页底段落与页顶段落不因负间距被合并', () => {
  const r = cleanLayoutBlocks([body(0, 'first unfinished', 10, 400), body(1, 'another paragraph.', 10, 20)])
  assert.equal(r.blocks.length, 2)
  assert.equal(r.merged, 0)
})
check('横向仅重叠40%的不同栏不拼接', () => {
  const r = cleanLayoutBlocks([body(0, 'first unfinished', 10, 10), body(1, 'another column.', 70, 30)])
  assert.equal(r.blocks.length, 2)
})
check('公式附近不同内容不能删除', () => {
  const r = cleanLayoutBlocks([body(0, 'a = b + c', 10, 30), formula(1, 'x = y + z', 10, 50)])
  assert.equal(r.dropped, 0)
  assert.equal(r.blocks[0].text, 'a = b + c')
})
check('可证明重复的公式文本可以排除，但保留理由和原块', () => {
  const r = cleanLayoutBlocks([body(0, 'x = y + z', 10, 30), formula(1, 'x = y + z', 10, 40)])
  assert.equal(r.dropped, 1)
  assert.equal(r.blocks.length, 1)
  assert.equal(r.excluded[0].reason, 'duplicate-formula')
  assert.equal(r.excluded[0].block.text, 'x = y + z')
  assert.equal(r.orderMap.get(0), 0)
})
check('跨段连接保留全部来源顺序，清理重复执行不再改变内容', () => {
  const input = [body(0, 'The sentence starts', 10, 10), body(1, 'and continues', 10, 30), body(2, 'until its end.', 10, 50)]
  const copy = structuredClone(input)
  const once = cleanLayoutBlocks(input)
  assert.equal(once.blocks.length, 1)
  assert.equal(once.blocks[0].text, 'The sentence starts and continues until its end.')
  assert.deepEqual(once.blocks[0].sourceOrders, [0, 1, 2])
  assert.deepEqual([once.orderMap.get(0), once.orderMap.get(1), once.orderMap.get(2)], [0, 0, 0])
  assert.deepEqual(cleanLayoutBlocks(once.blocks).blocks, once.blocks)
  assert.deepEqual(input, copy)
})
check('接回连字符换行不擅自删除词内连字符', () => {
  const r = cleanLayoutBlocks([body(0, 'The text-', 10, 10), body(1, 'only model works.', 10, 30)])
  assert.equal(r.blocks[0].text, 'The text-only model works.')
})
// buildLayoutDoc is a presentation projection, not a second destructive cleanup.
const { buildLayoutDoc } = await import('../lib/doc.js')
check('文档投影不得二次合并已发布的两个布局块', () => {
  const layout = { blocks: [body(0, 'First block has its own identity', 10, 10), body(1, 'another accepted block.', 10, 30)], figures: [] }
  const doc = buildLayoutDoc({ meta: { title: 'Fixture' }, layout, pdf: { pages: 1 } })
  assert.deepEqual(doc.paragraphs.map(p => p.text), ['First block has its own identity', 'another accepted block.'])
})
console.log(`${pass} PASS / ${fail} FAIL`)
process.exitCode = fail ? 1 : 0
