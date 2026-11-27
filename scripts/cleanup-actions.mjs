import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'qianxi-00/dsh-paper-workbench';
const CORE_BRANCHES = new Set(['dev', 'test', 'prod', 'main']);
const API_ROOT = 'https://api.github.com';

function newest(items) {
  return [...items].sort((left, right) => {
    const byDate = Date.parse(right.created_at) - Date.parse(left.created_at);
    return byDate || Number(right.id) - Number(left.id);
  })[0];
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function sortedIds(ids) {
  return [...ids].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function requireId(item, kind) {
  if (item.id === undefined || item.id === null || String(item.id) === '') {
    throw new Error(`${kind} is missing its GitHub ID; refusing to build a deletion plan.`);
  }
  return String(item.id);
}

export function planCleanup({ runs, artifacts, caches, openPullBranches, publishedReleaseTags }) {
  const keepRuns = new Set();
  const completedRuns = runs.filter((run) => run.status === 'completed');

  for (const run of runs) {
    const id = requireId(run, 'Workflow run');
    if (run.workflow_id === undefined || !run.created_at || !run.status) {
      throw new Error(`Workflow run ${id} is missing retention metadata; refusing to build a deletion plan.`);
    }
    if (!Number.isFinite(Date.parse(run.created_at))) {
      throw new Error(`Workflow run ${id} has an invalid creation time; refusing to build a deletion plan.`);
    }
    if (run.status !== 'completed') keepRuns.add(id);
  }
  for (const run of groupBy(completedRuns, (item) => item.workflow_id).values()) {
    keepRuns.add(requireId(newest(run), 'Workflow run'));
    const successful = run.filter((item) => item.conclusion === 'success');
    if (successful.length) keepRuns.add(requireId(newest(successful), 'Workflow run'));
  }

  const protectedBranches = new Set([...CORE_BRANCHES, ...openPullBranches]);
  for (const run of groupBy(
    completedRuns.filter((item) => (item.workflow_name ?? item.name) === 'CI' && protectedBranches.has(item.head_branch)),
    (item) => `${item.workflow_id}\0${item.head_branch}`,
  ).values()) {
    keepRuns.add(requireId(newest(run), 'Workflow run'));
    const successful = run.filter((item) => item.conclusion === 'success');
    if (successful.length) keepRuns.add(requireId(newest(successful), 'Workflow run'));
  }

  const publishedTags = new Set(publishedReleaseTags);
  for (const run of groupBy(
    completedRuns.filter((item) => (item.workflow_name ?? item.name) === 'Release' && publishedTags.has(item.head_branch)),
    (item) => `${item.workflow_id}\0${item.head_branch}`,
  ).values()) {
    keepRuns.add(requireId(newest(run), 'Workflow run'));
    const successful = run.filter((item) => item.conclusion === 'success');
    if (successful.length) keepRuns.add(requireId(newest(successful), 'Workflow run'));
  }

  const deleteRuns = completedRuns.filter((run) => !keepRuns.has(String(run.id)));
  const keepArtifacts = [];
  const deleteArtifacts = [];
  const keepArtifactReasons = {
    missingAssociation: [],
    runMissingFromSnapshot: [],
    activeRun: [],
    retainedRun: [],
  };
  const runsById = new Map(runs.map((run) => [String(run.id), run]));
  for (const artifact of artifacts) {
    const artifactId = requireId(artifact, 'Artifact');
    const runId = artifact.workflow_run?.id;
    if (runId === undefined || runId === null || String(runId) === '') {
      keepArtifacts.push(artifact);
      keepArtifactReasons.missingAssociation.push(artifactId);
      continue;
    }
    const associatedRunId = String(runId);
    const associatedRun = runsById.get(associatedRunId);
    if (!associatedRun) {
      keepArtifacts.push(artifact);
      keepArtifactReasons.runMissingFromSnapshot.push(artifactId);
    } else if (associatedRun.status !== 'completed') {
      keepArtifacts.push(artifact);
      keepArtifactReasons.activeRun.push(artifactId);
    } else if (!artifact.expired && keepRuns.has(associatedRunId)) {
      keepArtifacts.push(artifact);
      keepArtifactReasons.retainedRun.push(artifactId);
    } else {
      deleteArtifacts.push(artifact);
    }
  }
  for (const ids of Object.values(keepArtifactReasons)) {
    ids.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }

  const cachesByRef = groupBy(caches, (cache) => {
    if (!cache.ref || !cache.last_accessed_at) {
      throw new Error('A cache is missing its ref or last access time; refusing to build a deletion plan.');
    }
    if (!Number.isFinite(Date.parse(cache.last_accessed_at))) {
      throw new Error(`Cache ${cache.id ?? '(unknown)'} has an invalid access time; refusing to build a deletion plan.`);
    }
    return cache.ref;
  });
  const keepCaches = [];
  const deleteCaches = [];
  for (const group of cachesByRef.values()) {
    const ordered = [...group].sort((left, right) =>
      Date.parse(right.last_accessed_at) - Date.parse(left.last_accessed_at));
    keepCaches.push(ordered[0]);
    deleteCaches.push(...ordered.slice(1));
  }
  for (const cache of caches) requireId(cache, 'Cache');

  return {
    keepRunIds: sortedIds(keepRuns),
    deleteRunIds: sortedIds(deleteRuns.map((item) => requireId(item, 'Workflow run'))),
    keepArtifactIds: sortedIds(keepArtifacts.map((item) => requireId(item, 'Artifact'))),
    deleteArtifactIds: sortedIds(deleteArtifacts.map((item) => requireId(item, 'Artifact'))),
    keepArtifactReasons,
    keepCacheIds: sortedIds(keepCaches.map((item) => requireId(item, 'Cache'))),
    deleteCacheIds: sortedIds(deleteCaches.map((item) => requireId(item, 'Cache'))),
  };
}

async function githubRequest(token, path, method = 'GET') {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return response.status === 204 ? null : response.json();
}

async function listAll(token, path, property) {
  const items = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page += 1) {
    const response = await githubRequest(token, `${path}${separator}per_page=100&page=${page}`);
    const batch = Array.isArray(response) ? response : response[property];
    if (!Array.isArray(batch)) throw new Error(`GitHub API ${path} did not return ${property}.`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function snapshot(token) {
  const [runs, artifacts, caches, pulls, releases] = await Promise.all([
    listAll(token, `/repos/${REPOSITORY}/actions/runs`, 'workflow_runs'),
    listAll(token, `/repos/${REPOSITORY}/actions/artifacts`, 'artifacts'),
    listAll(token, `/repos/${REPOSITORY}/actions/caches`, 'actions_caches'),
    listAll(token, `/repos/${REPOSITORY}/pulls?state=open`, 'pulls'),
    listAll(token, `/repos/${REPOSITORY}/releases`, 'releases'),
  ]);
  return {
    runs,
    artifacts,
    caches,
    openPullBranches: pulls.map((pull) => pull.head?.ref).filter(Boolean),
    publishedReleaseTags: releases.filter((release) => !release.draft).map((release) => release.tag_name),
  };
}

function assertRuntime(env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY) {
    throw new Error(`This cleaner is restricted to ${REPOSITORY}.`);
  }
  if (!['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error(`Refusing cleanup for event ${env.GITHUB_EVENT_NAME ?? '(missing)'}.`);
  }
  if (!env.ACTIONS_TOKEN) throw new Error('ACTIONS_TOKEN is required.');
  if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') {
    throw new Error('DRY_RUN must be the string "true" or "false".');
  }
}

export function formatSummary({ before, plan, deleted }) {
  const lines = [
    '## Actions retention',
    '',
    `- Workflow runs: ${before.runs.length} before; ${plan.keepRunIds.length} retained; ${deleted.runs.length} deleted.`,
    `- Actions artifacts: ${before.artifacts.length} before; ${plan.keepArtifactIds.length} retained; ${deleted.artifacts.length} deleted.`,
    `- Actions caches: ${before.caches.length} before; ${plan.keepCacheIds.length} retained; ${deleted.caches.length} deleted.`,
    `- Planned deletions: ${plan.deleteRunIds.length} runs, ${plan.deleteArtifactIds.length} artifacts, ${plan.deleteCacheIds.length} caches.`,
    '- GitHub Releases, tags, and release assets are not modified.',
  ];
  lines.push('', '### Artifact retention reasons', '');
  for (const [reason, label] of Object.entries({
    missingAssociation: 'Artifact has no run association (kept conservatively)',
    runMissingFromSnapshot: 'Associated run is absent from this run snapshot (kept conservatively)',
    activeRun: 'Associated run is not completed (protected)',
    retainedRun: 'Associated completed run is retained by policy',
  })) {
    const ids = plan.keepArtifactReasons[reason];
    lines.push(`- ${label}: ${ids.length ? ids.join(', ') : 'None'}`);
  }
  for (const [label, ids] of Object.entries({
    'workflow runs': plan.keepRunIds,
    artifacts: plan.keepArtifactIds,
    caches: plan.keepCacheIds,
  })) {
    lines.push('', `### Retained ${label}`, '', ...(ids.length ? ids.map((id) => `- ${id}`) : ['- None']));
  }
  for (const [label, ids] of Object.entries(deleted)) {
    lines.push('', `### Deleted ${label}`, '', ...(ids.length ? ids.map((id) => `- ${id}`) : ['- None']));
  }
  return `${lines.join('\n')}\n`;
}

async function main(env = process.env) {
  assertRuntime(env);
  const before = await snapshot(env.ACTIONS_TOKEN);
  const plan = planCleanup(before);
  const dryRun = env.DRY_RUN === 'true';
  console.log(`Repository: ${REPOSITORY}`);
  console.log(`Mode: ${dryRun ? 'dry-run' : 'delete'}`);
  console.log(`Before: ${before.runs.length} runs, ${before.artifacts.length} artifacts, ${before.caches.length} caches.`);
  console.log(`Retained: ${plan.keepRunIds.length} runs, ${plan.keepArtifactIds.length} artifacts, ${plan.keepCacheIds.length} caches.`);
  console.log(`Planned deletions: ${plan.deleteRunIds.length} runs, ${plan.deleteArtifactIds.length} artifacts, ${plan.deleteCacheIds.length} caches.`);

  const deleted = { runs: [], artifacts: [], caches: [] };
  if (!dryRun) {
    for (const id of plan.deleteArtifactIds) {
      await githubRequest(env.ACTIONS_TOKEN, `/repos/${REPOSITORY}/actions/artifacts/${id}`, 'DELETE');
      deleted.artifacts.push(id);
      console.log(`Deleted artifact ${id}`);
    }
    for (const id of plan.deleteCacheIds) {
      await githubRequest(env.ACTIONS_TOKEN, `/repos/${REPOSITORY}/actions/caches/${id}`, 'DELETE');
      deleted.caches.push(id);
      console.log(`Deleted cache ${id}`);
    }
    for (const id of plan.deleteRunIds) {
      await githubRequest(env.ACTIONS_TOKEN, `/repos/${REPOSITORY}/actions/runs/${id}`, 'DELETE');
      deleted.runs.push(id);
      console.log(`Deleted workflow run ${id}`);
    }

    const after = await snapshot(env.ACTIONS_TOKEN);
    const remainingRuns = new Set(after.runs.map((run) => String(run.id)));
    const remainingArtifacts = new Set(after.artifacts.map((artifact) => String(artifact.id)));
    const remainingCaches = new Set(after.caches.map((cache) => String(cache.id)));
    const undeleted = [
      ...deleted.runs.filter((id) => remainingRuns.has(id)).map((id) => `run ${id}`),
      ...deleted.artifacts.filter((id) => remainingArtifacts.has(id)).map((id) => `artifact ${id}`),
      ...deleted.caches.filter((id) => remainingCaches.has(id)).map((id) => `cache ${id}`),
    ];
    if (undeleted.length) throw new Error(`Deleted records remain visible after cleanup: ${undeleted.join(', ')}`);
    console.log(`After: ${after.runs.length} runs, ${after.artifacts.length} artifacts, ${after.caches.length} caches.`);
  }

  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, formatSummary({ before, plan, deleted }), 'utf8');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
