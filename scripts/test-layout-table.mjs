/**
 * lib/layout-table.js 自测脚本（纯离线，无网络无 fs）。
 *
 * 覆盖：rowspan/colspan 展开成网格占位、表头识别、HTML 实体解码、<br> 换行、
 * 伪表拒绝、行列上限、PyMuPDF 网格构建、质量判定。至少 15 条断言。
 * 运行：node scripts/test-layout-table.mjs
 */
import assert from 'node:assert/strict'

import {
  buildTableModelFromHtml,
  buildTableModelFromGrid,
  tableModelQuality,
} from '../lib/layout-table.js'

const stats = { pass: 0, fail: 0 }
const RUNS = 10

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

/** 断言每一行的逻辑列数都等于 cols。 */
function assertRectangular(model) {
  assert.ok(model, '模型不应为 null')
  for (const row of model.rows) {
    assert.equal(row.cells.length, model.cols, '某行逻辑列数与 cols 不一致')
  }
}

async function run(attempt) {
  console.log('== 结构化表格模型（纯函数，第 ' + attempt + '/' + RUNS + ' 轮）==')

  await check('HTML：rowspan/colspan 展开成网格占位，每行列数一致', () => {
    const html = [
      '<table>',
      '<tr><th>A</th><th>B</th><th>C</th><th>D</th></tr>',
      '<tr><td rowspan="2">R</td><td colspan="2">S</td><td>4</td></tr>',
      '<tr><td>x</td><td>y</td><td>z</td></tr>',
      '</table>',
    ].join('')
    const model = buildTableModelFromHtml(html)
    assert.equal(model.cols, 4)
    assert.equal(model.rows.length, 3)
    assertRectangular(model)

    const r1 = model.rows[1].cells
    // 合并单元格左上角保留原文与跨度
    assert.equal(r1[0].text, 'R')
    assert.equal(r1[0].rowSpan, 2)
    assert.equal(r1[0].colSpan, 1)
    assert.equal(r1[1].text, 'S')
    assert.equal(r1[1].colSpan, 2)
    // 被 colspan 覆盖的位置是占位
    assert.equal(r1[2].placeholder, true)
    assert.equal(r1[3].text, '4')

    // rowspan 覆盖到下一行
    const r2 = model.rows[2].cells
    assert.equal(r2[0].placeholder, true)
    assert.equal(r2[1].text, 'x')
    assert.equal(r2[3].text, 'z')
  })

  await check('HTML：<th> 行识别为表头', () => {
    const model = buildTableModelFromHtml('<tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr>')
    assert.equal(model.headerRows, 1)
  })

  await check('HTML：实体解码（nbsp/lt/gt/quot/39/apos/amp）', () => {
    const model = buildTableModelFromHtml(
      '<tr><td>A&nbsp;B</td><td>&lt;x&gt; &quot;q&quot; &#39;s&#39; &apos;t&apos; &amp;</td></tr>' +
        '<tr><td>c</td><td>d</td></tr>',
    )
    assert.equal(model.rows[0].cells[0].text, 'A B')
    assert.equal(model.rows[0].cells[1].text, '<x> "q" \'s\' \'t\' &')
  })

  await check('HTML：十进制数字字符引用与 Unicode 文本等价', () => {
    const model = buildTableModelFromHtml(
      '<tr><td>&#945; &#8804; 0.05</td><td>Value</td></tr><tr><td>x</td><td>y</td></tr>',
    )
    assert.equal(model.rows[0].cells[0].text, 'α ≤ 0.05')
  })

  await check('HTML：十六进制数字字符引用与 Unicode 文本等价', () => {
    const model = buildTableModelFromHtml(
      '<tr><td>&#x03B1; &#x2264; 0.05</td><td>Value</td></tr><tr><td>x</td><td>y</td></tr>',
    )
    assert.equal(model.rows[0].cells[0].text, 'α ≤ 0.05')
  })

  await check('HTML：数字引用只解码一层且非法 Unicode 标量保持原文', () => {
    const model = buildTableModelFromHtml(
      '<tr><td>&amp;lt; &#38;lt;</td><td>&#xD800; &#1114112; &#xZZ; &#;</td></tr><tr><td>x</td><td>y</td></tr>',
    )
    assert.equal(model.rows[0].cells[0].text, '&lt; &lt;')
    assert.equal(model.rows[0].cells[1].text, '&#xD800; &#1114112; &#xZZ; &#;')
  })

  await check('HTML：<br> 转成换行', () => {
    const model = buildTableModelFromHtml('<tr><td>line1<br>line2</td><td>x</td></tr><tr><td>y</td><td>z</td></tr>')
    assert.equal(model.rows[0].cells[0].text, 'line1\nline2')
  })

  await check('HTML：没有 <tr> 返回 null', () => {
    assert.equal(buildTableModelFromHtml('<div>纯文本</div>'), null)
  })

  await check('伪表拒绝：单行表 / 单列表 / 整段文字塞一格', () => {
    const singleRow = buildTableModelFromHtml('<tr><td>a</td><td>b</td></tr>')
    assert.equal(singleRow.quality.ok, false)
    assert.ok(singleRow.quality.issues.some((issue) => issue.includes('行数不足')), '应提示行数不足')

    const singleCol = buildTableModelFromHtml('<tr><td>a</td></tr><tr><td>b</td></tr>')
    assert.equal(singleCol.quality.ok, false)
    assert.ok(singleCol.quality.issues.some((issue) => issue.includes('列数不足')), '应提示列数不足')

    const big = 'x'.repeat(500)
    const giant = buildTableModelFromHtml(
      '<tr><td>' + big + '</td><td>x</td></tr><tr><td>y</td><td>z</td></tr>',
    )
    assert.equal(giant.quality.ok, false)
    assert.ok(giant.quality.issues.some((issue) => issue.includes('整段文字')), '应提示整段文字')
  })

  await check('HTML：超过 400 行被截断并标记', () => {
    const row = '<tr><td>a</td><td>b</td></tr>'
    const model = buildTableModelFromHtml(row.repeat(401))
    assert.equal(model.rows.length, 400)
    assert.equal(model.quality.ok, false)
    assert.ok(model.quality.issues.some((issue) => issue.includes('行数超过上限')))
  })

  await check('HTML：超过 40 列被截断并标记', () => {
    const wide = '<tr>' + '<td>c</td>'.repeat(41) + '</tr>'
    const model = buildTableModelFromHtml(wide + wide)
    assert.equal(model.cols, 40)
    assert.equal(model.quality.ok, false)
    assert.ok(model.quality.issues.some((issue) => issue.includes('列数超过上限')))
  })

  await check('网格：二维数组 → 模型，headerRows 生效', () => {
    const model = buildTableModelFromGrid(
      [
        ['指标', '数值'],
        ['准确率', '0.9'],
        ['召回率', '0.8'],
      ],
      { headerRows: 1 },
    )
    assert.equal(model.cols, 2)
    assert.equal(model.rows.length, 3)
    assert.equal(model.headerRows, 1)
    assert.equal(model.source, 'pdf')
    assert.equal(model.rows[1].cells[0].text, '准确率')
    assert.equal(model.rows[1].cells[0].rowSpan, 1)
    assertRectangular(model)
  })

  await check('网格：全空输入与全空行返回 null', () => {
    assert.equal(buildTableModelFromGrid([]), null)
    assert.equal(buildTableModelFromGrid([['', ''], ['', '']]), null)
  })

  await check('质量：规整 2x2 模型判定 ok', () => {
    const model = buildTableModelFromGrid([['a', 'b'], ['c', 'd']])
    const quality = tableModelQuality(model)
    assert.equal(quality.ok, true)
    assert.deepEqual(quality.issues, [])
    assert.equal(model.quality.ok, true)
  })

  await check('质量：缺失模型判定失败', () => {
    const quality = tableModelQuality(null)
    assert.equal(quality.ok, false)
    assert.deepEqual(quality.issues, ['缺少表格模型'])
  })
}

try {
  for (let attempt = 1; attempt <= RUNS; attempt += 1) await run(attempt)
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
