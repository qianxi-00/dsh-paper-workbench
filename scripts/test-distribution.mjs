#!/usr/bin/env node
// Public boundary: the read-only report must never verify an unrelated install target.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkDistribution, INDEX_SOURCES } from './check-distribution.mjs'

const plugin = (changes = {}) => ({
  name: 'dsh-paper-workbench',
  repository: { url: 'https://github.com/qianxi-00/dsh-paper-workbench' },
  metadata: { labels: ['verified'], category: 'knowledge' },
  versions: [{ version: '1.2.0', source: { type: 'npm' }, engines: {} }],
  ...changes,
})
const response = (plugins) => new Response(JSON.stringify({ format: 1, title: 'Fixture', plugins }))
const check = (plugins, options = {}) => checkDistribution({
  targetVersion: '1.2.0', sources: [INDEX_SOURCES[0]],
  fetchImpl: async () => response(plugins), ...options,
})

test('exact package and canonical owner/repo both identify the published install target', async () => {
  const report = await check([
    plugin({ repository: { url: 'https://github.com/other/dsh-paper-workbench' } }),
    plugin({ name: 'another-package' }),
    plugin({ repository: 'git+https://github.com/QianXi-00/dsh-paper-workbench.git' }),
  ])
  assert.equal(report.exitCode, 0)
  assert.equal(report.sources[0].status, 'verified-live')
  assert.deepEqual(report.sources[0].matches, { name: 2, repository: 2, both: 1 })
  assert.equal(report.sources[0].entries[0].versions[0].engines.dsh, undefined)
  assert.deepEqual(report.sources[0].entries[0].labels, ['verified'])
})

test('substring names, lookalike hosts, URL credentials and repository subpaths cannot verify identity', async () => {
  for (const repository of [
    'https://evilgithub.com/qianxi-00/dsh-paper-workbench',
    'https://github.com.evil/qianxi-00/dsh-paper-workbench',
    'https://user@example.com/qianxi-00/dsh-paper-workbench',
    'https://github.com/qianxi-00/dsh-paper-workbench/extra',
    'https://github.com/qianxi-00/dsh-paper-workbench?other=1',
  ]) {
    const r = await check([plugin({ repository })])
    assert.equal(r.sources[0].status, 'identity-mismatch', repository)
    assert.equal(r.sources[0].matches.both, 0)
  }
  assert.equal((await check([plugin({ name: 'dsh-paper-workbench-copy' })])).sources[0].status, 'identity-mismatch')
})

test('duplicate exact entries are ambiguous even if both declare the target version', async () => {
  const r = await check([plugin(), plugin()])
  assert.equal(r.sources[0].status, 'ambiguous')
  assert.equal(r.exitCode, 1)
})

test('missing and old versions are distinguished; later target versions in the list are examined', async () => {
  assert.equal((await check([])).sources[0].status, 'not-listed')
  const old = { version: '1.1.2', source: { type: 'npm' }, engines: {} }
  assert.equal((await check([plugin({ versions: [old] })])).sources[0].status, 'outdated')
  assert.equal((await check([plugin({ versions: [old, ...plugin().versions] })])).exitCode, 0)
  assert.equal((await check([plugin({ versions: [] })])).sources[0].status, 'invalid-entry')
})

test('absence and recorded review or policy follow-up are separate facts', async () => {
  const r = await check([])
  assert.equal(r.sources[0].status, 'not-listed')
  assert.equal(r.sources[0].followUp.status, 'waiting-review/policy')
  assert.equal(r.sources[0].followUp.basisDate, '2026-11-20')
  assert.equal(r.sources[0].followUp.record, 'https://github.com/fegnze/dsh-plugin-scout/issues/1')
  assert.equal((await check([plugin()])).sources[0].followUp, undefined)
})

test('target npm version and registry must agree; registry credentials are never written into evidence', async () => {
  for (const source of [{ type: 'git' }, { type: 'npm', registry: 'https://other.example/' },
    { type: 'npm', registry: 'https://user:fixture-password@registry.npmjs.org/' }, { type: 'npm', registry: 'javascript:alert(1)' }]) {
    const r = await check([plugin({ versions: [{ version: '1.2.0', source }] })])
    assert.equal(r.sources[0].status, 'source-mismatch')
    assert.ok(!JSON.stringify(r).includes('fixture-password'))
  }
  const r = await check([plugin({ versions: [{ version: '1.2.0', source: { type: 'npm', registry: 'https://registry.npmjs.org/' }, engines: { dsh: '>=0.2.2-rc.5' } }] })])
  assert.equal(r.exitCode, 0)
  assert.equal(r.sources[0].entries[0].versions[0].engines.dsh, '>=0.2.2-rc.5')
})

test('a failed source never hides successful sources or turns unknown identity counts into zero', async () => {
  const r = await checkDistribution({ targetVersion: '1.2.0', fetchImpl: async url => {
    if (url === INDEX_SOURCES[0].url) throw new Error('proxy https://fixture-user:fixture-password@example.com')
    if (url === INDEX_SOURCES[1].url) return response([plugin()])
    if (url === INDEX_SOURCES[2].url) return response([])
    return response([plugin({ versions: [{ version: '1.1.2', source: { type: 'npm' } }] })])
  } })
  assert.deepEqual(r.sources.map(s => s.status), ['network-error', 'verified-live', 'not-listed', 'outdated'])
  assert.equal(r.sources[0].matches, null)
  assert.equal(r.sources[0].httpStatus, null)
  assert.equal(r.exitCode, 2)
  assert.equal(r.summary['verified-live'], 1)
  assert.ok(!JSON.stringify(r).includes('fixture-password'))
})

test('HTTP errors, invalid JSON and wrong schemas are not absence evidence', async () => {
  for (const [res, status, parseStatus] of [
    [new Response('Not found', { status: 404 }), 'http-error', 'not-attempted'],
    [new Response('{ broken JSON'), 'parse-error', 'error'],
    [new Response('{"format":2,"plugins":[]}'), 'invalid-index', 'ok'],
    [new Response('{"format":1,"plugins":null}'), 'invalid-index', 'ok'],
  ]) {
    const r = await check([], { fetchImpl: async () => res })
    assert.equal(r.sources[0].status, status)
    assert.equal(r.sources[0].parseStatus, parseStatus)
    assert.equal(r.sources[0].matches, null)
    assert.equal(r.exitCode, 2)
  }
})

test('evidence hashes response bytes and bounds reads without retaining whole indexes', async () => {
  const text = '\uFEFF' + JSON.stringify({ format: 1, plugins: [plugin()] })
  const r = await check([], { fetchImpl: async () => new Response(text) })
  assert.equal(r.sources[0].sha256, createHash('sha256').update(text).digest('hex'))
  assert.equal(r.sources[0].bytes, Buffer.byteLength(text))
  assert.ok(Number.isFinite(Date.parse(r.sources[0].checkedAt)))
  assert.equal((await check([plugin()], { maxBytes: 4 })).sources[0].status, 'response-too-large')
})

test('requests use GET, no redirects or credentials, and have a working timeout', async () => {
  const r = await check([], { timeoutMs: 10, fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, undefined)
    return new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout did not abort')), 500)
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason) }, { once: true })
    })
  } })
  assert.equal(r.sources[0].status, 'network-error')
  assert.equal(r.exitCode, 2)
})

test('invalid caller arguments fail before reading any source', async () => {
  for (const options of [{ targetVersion: 'latest' }, { targetVersion: '1.2.0-01' }, { timeoutMs: 0 }, { maxBytes: -1 }, { sources: [] }]) {
    await assert.rejects(checkDistribution({ targetVersion: '1.2.0', ...options, fetchImpl: () => { throw new Error('must not read') } }))
  }
})

test('CLI help and bad options are offline and have explicit exit codes', () => {
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./check-distribution.mjs', import.meta.url)), ...args], { encoding: 'utf8' })
  const help = run('--help')
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /Exit: 0/)
  const bad = run('--target-version')
  assert.equal(bad.status, 2, bad.stderr)
  assert.equal(bad.stdout, '')
})
