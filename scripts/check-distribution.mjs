#!/usr/bin/env node
// Public index observations only: no plugin imports, credentials, installs or submissions.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const INDEX_SOURCES = [
  { id: 'scout', url: 'https://fegnze.github.io/dsh-plugin-scout/index.json', record: 'https://github.com/fegnze/dsh-plugin-scout/issues/1' },
  { id: 'open', url: 'https://dshopen.org/index.json', record: 'https://github.com/polang233/dsh-plugin-index/issues/552' },
  { id: 'bruce', url: 'https://bruc3van.com/dsh-plugins/index.json', record: 'https://github.com/bruc3van/awesome-dsh-plugin-pro/issues/174' },
  { id: 'dshmarket', url: 'https://dshmarket.com/index.json', record: 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17123' },
]
const NAME = 'dsh-paper-workbench'
const REPOSITORY = 'qianxi-00/dsh-paper-workbench'
const NUMBER = '(?:0|[1-9]\\d*)'
const PRE = `(?:${NUMBER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`
const VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${PRE}(?:\\.${PRE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)
const INCOMPLETE = new Set(['network-error', 'http-error', 'parse-error', 'invalid-index', 'response-too-large'])

function githubSlug(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string') return null
  const match = raw.match(/^(?:(?:git\+)?https?:\/\/github\.com\/|git@github\.com:|github:)?([a-z0-9-]{1,39})\/([a-z0-9_.-]{1,100}?)(?:\.git)?\/?(?:#[^\s]*)?$/i)
  return match && !['.', '..'].includes(match[2]) ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

// Only public URL components are included in evidence, even for a malformed registry.
function publicUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return url.origin + url.pathname
  } catch { return null }
}

function entrySummary(plugin) {
  return {
    name: plugin.name, repository: REPOSITORY,
    category: typeof plugin.metadata?.category === 'string' ? plugin.metadata.category : null,
    labels: Array.isArray(plugin.metadata?.labels) ? plugin.metadata.labels.filter(v => typeof v === 'string') : [],
    versions: (Array.isArray(plugin.versions) ? plugin.versions : []).map(v => ({
      version: typeof v?.version === 'string' ? v.version : null,
      source: { type: typeof v?.source?.type === 'string' ? v.source.type : null,
        ...(v?.source?.registry !== undefined ? { registry: publicUrl(v.source.registry) } : {}) },
      engines: Object.fromEntries(Object.entries(v?.engines && typeof v.engines === 'object' ? v.engines : {}).filter(([, value]) => typeof value === 'string')),
    })),
  }
}

function expectedNpm(version) {
  if (version?.source?.type !== 'npm') return false
  if (version.source.registry === undefined) return true
  try {
    const url = new URL(version.source.registry)
    return url.href === 'https://registry.npmjs.org/' && !url.username && !url.password
  } catch { return false }
}

async function checkSource(source, options) {
  const result = { ...source, checkedAt: new Date().toISOString(), httpStatus: null, parseStatus: 'not-attempted',
    bytes: null, sha256: null, totalPlugins: null, matches: null, entries: [], status: 'network-error' }
  let response
  try {
    response = await options.fetchImpl(source.url, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs), headers: { accept: 'application/json', 'user-agent': 'dsh-paper-workbench-distribution-check' } })
    result.httpStatus = response.status
    if (!response.ok) {
      await response.body?.cancel()
      return { ...result, status: 'http-error' }
    }
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > options.maxBytes) {
        return { ...result, status: 'response-too-large' }
      }
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    result.bytes = bytes
    result.sha256 = createHash('sha256').update(body).digest('hex')
    let index
    try { index = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, '')); result.parseStatus = 'ok' }
    catch { return { ...result, status: 'parse-error', parseStatus: 'error' } }
    if (index?.format !== 1 || !Array.isArray(index.plugins)) return { ...result, status: 'invalid-index' }
    result.totalPlugins = index.plugins.length
    const rows = index.plugins.filter(p => p && typeof p === 'object')
    const exact = rows.filter(p => p.name === NAME && githubSlug(p.repository) === REPOSITORY)
    result.matches = {
      name: rows.filter(p => p.name === NAME).length,
      repository: rows.filter(p => githubSlug(p.repository) === REPOSITORY).length,
      both: exact.length,
    }
    result.entries = exact.map(entrySummary)
    if (!exact.length) result.status = result.matches.name || result.matches.repository ? 'identity-mismatch' : 'not-listed'
    else if (exact.length !== 1) result.status = 'ambiguous'
    else {
      const versions = Array.isArray(exact[0].versions) ? exact[0].versions : []
      const targets = versions.filter(v => v?.version === options.targetVersion)
      result.status = !versions.length ? 'invalid-entry' : !targets.length ? 'outdated'
        : targets.every(expectedNpm) ? 'verified-live' : 'source-mismatch'
    }
    return result
  } catch {
    // Native errors can contain proxy credentials. The endpoint/status identify the failed read.
    return { ...result, status: 'network-error' }
  }
}

/** Dependency injection is only for offline fixtures; the CLI always reads the four fixed HTTPS URLs. */
export async function checkDistribution({ targetVersion, sources = INDEX_SOURCES, fetchImpl = globalThis.fetch,
  timeoutMs = 60000, maxBytes = 12 * 1024 * 1024 } = {}) {
  if (!targetVersion) targetVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  if (typeof targetVersion !== 'string' || !VERSION.test(targetVersion)) throw new Error('target-version must be an exact version')
  if (!Array.isArray(sources) || !sources.length) throw new Error('sources must not be empty')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid read limits')
  const checkedAt = new Date().toISOString()
  const results = await Promise.all(sources.map(source => checkSource(source, { targetVersion, fetchImpl, timeoutMs, maxBytes })))
  for (const result of results) {
    if (result.status === 'not-listed' && ['scout', 'bruce'].includes(result.id)) {
      result.followUp = { status: 'waiting-review/policy', basisDate: '2026-11-20', record: result.record,
        note: 'Recorded application context only; refresh the existing thread and source policy before acting.' }
    }
  }
  const summary = {}
  for (const result of results) summary[result.status] = (summary[result.status] || 0) + 1
  return { checkedAt, target: { name: NAME, repository: REPOSITORY, version: targetVersion }, sources: results, summary,
    exitCode: results.some(r => INCOMPLETE.has(r.status)) ? 2 : results.every(r => r.status === 'verified-live') ? 0 : 1 }
}

async function main(args) {
  let targetVersion
  let output
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') {
      console.log('Usage: node scripts/check-distribution.mjs [--target-version 1.2.0] [--output report.json]\nRead-only GETs; JSON on stdout (or --output). Exit: 0 all current, 1 distribution gaps, 2 incomplete reads. No installation or host compatibility test.')
      return
    }
    if (!['--target-version', '--output'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown or incomplete option; use --help')
    if (args[i] === '--target-version') targetVersion = args[++i]
    else output = args[++i]
  }
  const report = await checkDistribution({ targetVersion })
  const json = JSON.stringify(report, null, 2) + '\n'
  if (output) await writeFile(output, json, { flag: 'wx' })
  else process.stdout.write(json)
  process.exitCode = report.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    console.error('Distribution check failed: invalid options or output path; use --help. Existing output files are preserved.')
    process.exitCode = 2
  })
}
