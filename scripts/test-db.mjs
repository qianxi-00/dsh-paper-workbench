/**
 * lib/db.js 自测（v3 契约 §1）。
 *
 * 全部跑在 %TEMP%\pb-db-test-<随机> 下，结束整目录删掉，**绝不碰真实库**
 * （~/.dsh/paper-workbench）。本机默认用 sqlite 引擎；如果在子进程里以
 * PB_DB_ENGINE=json 跑一遍，则覆盖 JSON 退化实现（两套引擎共用同一套用例）。
 *
 * 运行：node scripts/test-db.mjs
 *      PB_DB_ENGINE=json node scripts/test-db.mjs   # 只验退化实现
 */
import { spawnSync } from 'node:child_process'
import { existsSync, promises as fsp, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

// 必须先定好环境变量再 import：db.js 在模块加载时探测引擎，库路径则随环境变量变化重开。
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-db-test-'))
// 子进程（PB_TEST_CHILD=1）由父进程指定库路径，这里不能覆盖，否则父进程没法检查落盘文件。
const externalDbPath = process.env.PB_TEST_CHILD === '1' ? String(process.env.PB_DB_PATH || '') : ''
process.env.PB_DB_PATH = externalDbPath !== '' ? externalDbPath : path.join(tmpRoot, 'workbench.db')

const db = await import('../lib/db.js')

let passed = 0
let failed = 0

function ok(condition, message) {
  if (!condition) throw new Error(message)
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
}

function eq(actual, expected, message) {
  if (!deepEqual(actual, expected)) {
    throw new Error((message ? message + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
  }
}

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + (error && error.message ? error.message : String(error)))
  }
}

async function main() {
  const dbFile = db.dbPath()
  const engine = db.dbInfo().engine
  console.log('临时库：' + dbFile)
  console.log('引擎：' + engine)

  // ---------------------------------------------------------------- 打开与建表
  await check('dbPath 用 PB_DB_PATH 覆盖，dbInfo() 报出路径与引擎', () => {
    eq(db.dbPath(), path.resolve(process.env.PB_DB_PATH))
    const info = db.dbInfo()
    eq(info.path, db.dbPath())
    ok(info.engine === 'sqlite' || info.engine === 'json', 'engine 只能是 sqlite / json：' + info.engine)
    eq(info.engine, process.env.PB_DB_ENGINE === 'json' ? 'json' : info.engine)
    eq(info.rows, { translations: 0, job_events: 0, reviews: 0 })
    ok(existsSync(dbFile), '打开后库文件应该真的存在')
  })

  await check('建表幂等：重复 getDb / closeDb 后重开都不报错、不会清数据', () => {
    db.getDb()
    db.getDb()
    db.closeDb()
    db.getDb()
    db.closeDb()
    db.getDb()
    eq(db.dbInfo().rows, { translations: 0, job_events: 0, reviews: 0 })
  })

  await check('closeDb 在没打开过时是安全空操作', () => {
    db.closeDb()
    eq(db.closeDb(), false)
    ok(db.getDb() !== null, 'getDb 应能重新打开')
  })

  // ---------------------------------------------------------------- 译文
  await check('transAll 空库返回契约里的默认形状', () => {
    eq(db.transAll('p-empty'), { version: 1, target: 'zh', model: '', updatedAt: null, entries: {} })
  })

  await check('transPut 写入并按 key 读回（updatedAt 是 ISO）', () => {
    eq(db.transPut('p-trans', { h1: '第一段译文', h2: '第二段译文' }), 2)
    const all = db.transAll('p-trans')
    eq(all.version, 1)
    eq(all.target, 'zh')
    eq(all.model, '')
    ok(typeof all.updatedAt === 'string' && !Number.isNaN(Date.parse(all.updatedAt)), 'updatedAt 应是 ISO 字符串：' + all.updatedAt)
    eq(all.entries, { h1: '第一段译文', h2: '第二段译文' })
  })

  await check('transPut 覆盖同一 key：条数不变、文本更新、model 对象能往返', () => {
    eq(db.transPut('p-trans', { h1: '改过的译文' }, { model: { provider: 'mock', model: 'mock-translate' } }), 1)
    const all = db.transAll('p-trans')
    eq(Object.keys(all.entries).length, 2, '覆盖不应新增行')
    eq(all.entries.h1, '改过的译文')
    eq(all.model, { provider: 'mock', model: 'mock-translate' }, 'model 存的是 JSON 文本，读回应还原成对象')
  })

  await check('transPut 支持自定义 target / model 字符串', () => {
    eq(db.transPut('p-target', { k: 'hello' }, { target: 'en', model: 'gpt-x' }), 1)
    const all = db.transAll('p-target')
    eq(all.target, 'en')
    eq(all.model, 'gpt-x')
    eq(all.entries, { k: 'hello' })
  })

  await check('transPut 写空字符串也照写（用户显式清空某个 key）', () => {
    eq(db.transPut('p-target', { k: '' }), 1)
    eq(db.transAll('p-target').entries, { k: '' })
  })

  await check('transDelete 只删指定 key，返回真正删掉的行数', () => {
    eq(db.transDelete('p-trans', ['h2']), 1)
    eq(db.transAll('p-trans').entries, { h1: '改过的译文' })
    eq(db.transDelete('p-trans', ['不存在的']), 0)
    eq(db.transDelete('p-trans', []), 0)
  })

  await check('transClear 清空整篇并返回删除条数', () => {
    eq(db.transPut('p-clear', { a: '1', b: '2', c: '3' }), 3)
    eq(db.transClear('p-clear'), 3)
    eq(db.transAll('p-clear').entries, {})
    eq(db.transClear('p-clear'), 0)
  })

  // ---------------------------------------------------------------- 迁移老 trans.json
  await check('migrateTransJson 兼容老格式 { zh, at, model }，只导非空条目', () => {
    const legacy = {
      version: 1,
      target: 'zh',
      model: { provider: 'mock', model: 'mock-translate' },
      updatedAt: '2026-11-11T07:53:49.362Z',
      entries: {
        a: { zh: '甲段译文', at: '2026-11-11T07:38:46.663Z', model: 'mock/mock-translate' },
        b: { zh: '乙段译文' },
        c: '',
        d: null,
      },
    }
    eq(db.migrateTransJson('p-legacy', legacy), 2, '空译文和 null 不应导入')
    const all = db.transAll('p-legacy')
    eq(all.entries, { a: '甲段译文', b: '乙段译文' })
    eq(all.target, 'zh')
    eq(all.model, { provider: 'mock', model: 'mock-translate' })
  })

  await check('migrateTransJson 库里有译文时不再导入，重复调用幂等', () => {
    const legacy = { target: 'zh', entries: { a: { zh: '老文件里的旧译文' }, z: { zh: '新条目' } } }
    eq(db.transPut('p-legacy', { a: '用户后来改的译文' }), 1)
    eq(db.migrateTransJson('p-legacy', legacy), 0, '库里已有该论文的译文，应直接放弃导入')
    eq(db.transAll('p-legacy').entries, { a: '用户后来改的译文', b: '乙段译文' })
  })

  await check('migrateTransJson 空 / 坏输入不抛错、不写入', () => {
    eq(db.migrateTransJson('p-legacy-2', null), 0)
    eq(db.migrateTransJson('p-legacy-2', { entries: null }), 0)
    eq(db.migrateTransJson('p-legacy-2', { entries: { x: { 无关字段: 1 } } }), 0)
    eq(db.transAll('p-legacy-2').entries, {})
  })

  // ---------------------------------------------------------------- 任务日志
  await check('jobAppend 返回递增 seq，事件字段与 extra 完整往返', () => {
    const s1 = db.jobAppend('p-jobs', { level: 'info', kind: 'start', message: '开始翻译' })
    const s2 = db.jobAppend('p-jobs', { level: 'warn', kind: 'progress', message: '进度 50%', extra: { done: 5, total: 10 } })
    const s3 = db.jobAppend('p-jobs', { level: 'error', kind: 'error', message: '失败了', extra: { code: 'X' } })
    ok(s2 === s1 + 1 && s3 === s2 + 1, 'seq 应逐条 +1，实际 ' + [s1, s2, s3].join(','))
    const page = db.jobList('p-jobs', { after: 0 })
    eq(page.events.length, 3)
    eq(page.lastSeq, s3)
    const [first, second] = page.events
    eq(first.seq, s1)
    eq(first.level, 'info')
    eq(first.kind, 'start')
    eq(first.message, '开始翻译')
    eq(first.extra, null)
    ok(typeof first.at === 'string' && !Number.isNaN(Date.parse(first.at)), 'at 应是 ISO 时间：' + first.at)
    eq(second.extra, { done: 5, total: 10 }, 'extra 应按 JSON 还原成对象')
    eq(page.events[2].level, 'error')
  })

  await check('jobList 游标：after 只返回更大的 seq，末尾 lastSeq 回显 after', () => {
    const all = db.jobList('p-jobs', { after: 0 })
    const seqs = all.events.map((event) => event.seq)
    eq(db.jobList('p-jobs', { after: seqs[1] }).events.map((event) => event.seq), [seqs[2]])
    const none = db.jobList('p-jobs', { after: seqs[2] + 100 })
    eq(none.events, [])
    eq(none.lastSeq, seqs[2] + 100, '没有新事件时 lastSeq 应回显传入的 after')
  })

  await check('jobList limit 截断，lastSeq 指向最后一条返回事件（分页不跳）', () => {
    const first = db.jobList('p-jobs', { after: 0, limit: 1 })
    eq(first.events.length, 1)
    eq(first.lastSeq, first.events[0].seq)
    const second = db.jobList('p-jobs', { after: first.lastSeq, limit: 1 })
    eq(second.events.length, 1)
    eq(second.lastSeq, second.events[0].seq)
    ok(second.events[0].seq > first.events[0].seq, '第二页应接着第一页')
  })

  await check('jobAppend 归一化：非法 level 记 info、缺 kind 记 log、坏 extra 抛错且不落盘', () => {
    db.jobAppend('p-jobs-norm', { level: 'debug', message: '没有 level' })
    const { events } = db.jobList('p-jobs-norm')
    eq(events[0].level, 'info')
    eq(events[0].kind, 'log')
    const before = db.dbInfo().rows.job_events
    const circular = {}
    circular.self = circular
    let message = ''
    try {
      db.jobAppend('p-jobs-norm', { message: '坏 extra', extra: circular })
    } catch (error) {
      message = error.message
    }
    ok(/extra/.test(message), '循环引用应抛中文错误，实际：' + message)
    eq(db.dbInfo().rows.job_events, before, '失败的写入不应留下半条数据')
  })

  await check('jobClear 清空并返回条数；seq 不复用（AUTOINCREMENT 语义）', () => {
    const before = db.jobList('p-jobs', { after: 0 })
    eq(db.jobClear('p-jobs'), before.events.length)
    eq(db.jobList('p-jobs').events, [])
    eq(db.jobList('p-jobs').lastSeq, 0)
    const again = db.jobAppend('p-jobs', { message: '清空后重新开始' })
    ok(again > before.lastSeq, 'seq 应继续递增，实际 ' + again + ' 不大于 ' + before.lastSeq)
    eq(db.jobList('p-jobs').events.length, 1)
  })

  // ---------------------------------------------------------------- 自检结果
  await check('reviewGet 空库返回 null；reviewPut / reviewGet 往返', () => {
    eq(db.reviewGet('p-review'), null)
    const issues = [{ key: 'k1', code: 'empty', severity: 'warn', message: '译文为空' }]
    const saved = db.reviewPut('p-review', {
      at: '2026-11-12T00:00:00.000Z',
      mode: 'static',
      issues,
      stats: { paragraphs: 10, checked: 8, staticIssues: 1 },
    })
    eq(saved.mode, 'static')
    const got = db.reviewGet('p-review')
    eq(got.at, '2026-11-12T00:00:00.000Z')
    eq(got.mode, 'static')
    eq(got.issues, issues)
    eq(got.stats, { paragraphs: 10, checked: 8, staticIssues: 1 })
  })

  await check('reviewPut 覆盖旧结果，额外字段（llmError）原样带上', () => {
    db.reviewPut('p-review', { mode: 'both', issues: [], stats: { paragraphs: 3 }, llmError: '模型不可用' })
    const again = db.reviewGet('p-review')
    eq(again.mode, 'both')
    eq(again.issues, [])
    eq(again.stats, { paragraphs: 3 })
    eq(again.llmError, '模型不可用', '契约之外的字段也不该被吞掉')
    ok(typeof again.at === 'string' && !Number.isNaN(Date.parse(again.at)), '没传 at 时应补当前时间')
  })

  // ---------------------------------------------------------------- 计数与隔离
  await check('dbInfo().rows 随写入准确变化', () => {
    const before = db.dbInfo().rows
    db.transPut('p-count', { a: 'x' })
    db.jobAppend('p-count', { message: 'y' })
    db.reviewPut('p-count', { issues: [], stats: {} })
    const after = db.dbInfo().rows
    eq(after.translations, before.translations + 1)
    eq(after.job_events, before.job_events + 1)
    eq(after.reviews, before.reviews + 1)
  })

  await check('论文之间互相隔离：日志 / 译文 / 自检都按 paperId 分开', () => {
    const seq = db.jobAppend('p-other', { message: '别人的日志' })
    ok(seq > 0)
    eq(db.jobList('p-other').events.length, 1)
    eq(db.jobList('p-jobs').events.length, 1, 'p-jobs 只有清空后那一条')
    db.transPut('p-other', { k: 'only-other' })
    eq(db.transAll('p-trans').entries, { h1: '改过的译文' }, 'p-trans 应保持自己的条目')
    eq(db.transAll('p-other').entries, { k: 'only-other' })
    eq(db.transAll('p-jobs').entries, {}, '没写过译文的论文仍应为空')
    eq(db.reviewGet('p-other'), null)
  })

  // ---------------------------------------------------------------- 关闭 / 重开 / 路径
  await check('closeDb 之后重开，译文 / 日志 / 自检都还在', () => {
    const transBefore = db.transAll('p-legacy')
    const jobsBefore = db.jobList('p-jobs', { after: 0 })
    const reviewBefore = db.reviewGet('p-review')
    ok(db.closeDb(), 'closeDb 应返回 true')
    const info = db.dbInfo()
    eq(info.path, dbFile)
    eq(db.transAll('p-legacy'), transBefore)
    eq(db.jobList('p-jobs', { after: 0 }).events, jobsBefore.events)
    eq(db.reviewGet('p-review'), reviewBefore)
    ok(info.rows.job_events > 0 && info.rows.translations > 0 && info.rows.reviews > 0)
  })

  await check('没设 PB_DB_PATH 时落在数据根下（sqlite: workbench.db / json: workbench.json）', () => {
    const saved = process.env.PB_DB_PATH
    const root = path.join(tmpRoot, 'data-root')
    const name = engine === 'sqlite' ? 'workbench.db' : 'workbench.json'
    process.env.DSH_PAPER_WORKBENCH_DATA = root
    delete process.env.PB_DB_PATH
    try {
      eq(db.dbPath(), path.join(root, name))
      db.jobAppend('p-default', { message: '默认路径' })
      ok(existsSync(path.join(root, name)), '默认路径下应真的建出文件')
      eq(db.dbInfo().rows.job_events, 1)
    } finally {
      process.env.DSH_PAPER_WORKBENCH_DATA = tmpRoot
      process.env.PB_DB_PATH = saved
    }
    eq(db.dbPath(), dbFile, '恢复 PB_DB_PATH 后应切回原库')
    ok(existsSync(dbFile))
    ok(db.dbInfo().rows.job_events > 1, '切回后应还是原来那个库')
  })

  // ---------------------------------------------------------------- 参数校验
  await check('参数校验：空 paperId / 坏 entries 抛中文错误且不写入', () => {
    const cases = [
      ['transAll', () => db.transAll('')],
      ['jobList', () => db.jobList(null)],
      ['transPut', () => db.transPut('   ', {})],
      ['reviewGet', () => db.reviewGet(undefined)],
    ]
    for (const [name, fn] of cases) {
      let message = ''
      try {
        fn()
      } catch (error) {
        message = error.message
      }
      ok(/论文 id/.test(message), name + ' 应抛「论文 id 不能为空」，实际：' + message)
    }
    let badEntries = ''
    try {
      db.transPut('p-bad', { k: { 无关字段: 1 } })
    } catch (error) {
      badEntries = error.message
    }
    ok(/译文条目/.test(badEntries), '坏的 entries 应抛中文错误，实际：' + badEntries)
    let badShape = ''
    try {
      db.transPut('p-bad', ['a', 'b'])
    } catch (error) {
      badShape = error.message
    }
    ok(/entries/.test(badShape), '数组 entries 应抛中文错误，实际：' + badShape)
    eq(db.transAll('p-bad').entries, {}, '校验失败不应写入任何数据')
  })

  // ---------------------------------------------------------------- JSON 退化引擎
  if (process.env.PB_TEST_CHILD !== '1' && engine === 'sqlite') {
    await check('JSON 退化引擎：整套用例在子进程里再跑一遍并通过', () => {
      const childRoot = path.join(tmpRoot, 'json-engine')
      const childScript = fileURLToPath(new URL('./test-db.mjs', import.meta.url))
      const result = spawnSync(process.execPath, [childScript], {
        encoding: 'utf8',
        timeout: 180000,
        env: {
          ...process.env,
          PB_DB_ENGINE: 'json',
          PB_DB_PATH: path.join(childRoot, 'workbench.db'),
          DSH_PAPER_WORKBENCH_DATA: path.join(childRoot, 'data'),
          PB_TEST_CHILD: '1',
        },
      })
      const output = String(result.stdout || '') + String(result.stderr || '')
      ok(result.status === 0, 'JSON 引擎子进程退出码 ' + result.status + '：\n' + output.slice(-1600))
      ok(/FAIL 0\b/.test(output), 'JSON 引擎子进程应 FAIL 0：\n' + output.slice(-1600))
      // 退化实现要真的写 JSON 文件（而不是悄悄退回 sqlite）。
      const jsonPath = path.join(childRoot, 'workbench.db')
      ok(existsSync(jsonPath), 'JSON 引擎应把数据写进 PB_DB_PATH 指向的文件')
      const raw = JSON.parse(readFileSync(jsonPath, 'utf8'))
      ok(Array.isArray(raw.job_events) && raw.job_events.length > 0, 'JSON 文件里应有 job_events')
      ok(Array.isArray(raw.translations) && raw.translations.length > 0, 'JSON 文件里应有 translations')
      ok(Array.isArray(raw.reviews) && raw.reviews.length > 0, 'JSON 文件里应有 reviews')
      ok(Number(raw.seq) > 0, 'JSON 文件里应记着 seq 计数（清空后不复用）')
    })
  }
}

try {
  await main()
} catch (error) {
  failed += 1
  console.log('FAIL  测试脚本异常终止 -> ' + (error && error.stack ? error.stack : String(error)))
} finally {
  try {
    db.closeDb()
  } catch {
    /* 关闭失败不影响清理 */
  }
  try {
    await fsp.rm(tmpRoot, { recursive: true, force: true })
  } catch {
    // Windows 上偶尔还有句柄没释放；临时目录残留不影响结论。
  }
}

console.log('')
console.log('PASS ' + passed + ' / FAIL ' + failed)
process.exitCode = failed ? 1 : 0
