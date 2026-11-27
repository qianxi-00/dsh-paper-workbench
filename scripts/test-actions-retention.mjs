import assert from 'node:assert/strict';
import { planCleanup } from './cleanup-actions.mjs';

const run = (id, workflowId, workflowName, headBranch, createdAt, status, conclusion) => ({
  id: String(id),
  workflow_id: workflowId,
  name: workflowName,
  head_branch: headBranch,
  created_at: createdAt,
  status,
  conclusion,
});

const plan = planCleanup({
  runs: [
    run(101, 1, 'CI', 'dev', '2025-01-01T00:00:00Z', 'completed', 'success'),
    run(103, 1, 'CI', 'dev', '2025-01-02T00:00:00Z', 'completed', 'success'),
    run(102, 1, 'CI', 'dev', '2025-01-03T00:00:00Z', 'completed', 'failure'),
    run(203, 1, 'CI', 'feature/pr', '2025-01-01T00:00:00Z', 'completed', 'success'),
    run(202, 1, 'CI', 'feature/pr', '2025-01-02T00:00:00Z', 'completed', 'success'),
    run(201, 1, 'CI', 'feature/pr', '2025-01-03T00:00:00Z', 'completed', 'failure'),
    run(301, 1, 'CI', 'merged-branch', '2025-01-02T12:00:00Z', 'completed', 'success'),
    run(401, 2, 'Release', 'v1.2.0', '2025-01-01T00:00:00Z', 'completed', 'success'),
    run(402, 2, 'Release', 'v1.2.0', '2025-01-02T00:00:00Z', 'completed', 'failure'),
    run(501, 2, 'Release', 'draft-tag', '2025-01-03T00:00:00Z', 'completed', 'success'),
    run(601, 1, 'CI', 'old-runner', '2024-12-31T00:00:00Z', 'in_progress', null),
  ],
  artifacts: [
    { id: 71, expired: false, workflow_run: { id: 103 } },
    { id: 72, expired: false, workflow_run: { id: 101 } },
    { id: 73, expired: true, workflow_run: { id: 102 } },
    { id: 74, expired: false },
  ],
  caches: [
    { id: 81, ref: 'refs/heads/main', last_accessed_at: '2025-01-01T00:00:00Z' },
    { id: 82, ref: 'refs/heads/main', last_accessed_at: '2025-01-02T00:00:00Z' },
    { id: 83, ref: 'refs/heads/feature', last_accessed_at: '2025-01-01T00:00:00Z' },
  ],
  openPullBranches: ['feature/pr'],
  publishedReleaseTags: ['v1.2.0'],
});

assert.deepEqual(plan.keepRunIds, ['102', '103', '201', '202', '301', '401', '402', '501', '601']);
assert.deepEqual(plan.deleteRunIds, ['101', '203']);
assert.deepEqual(plan.keepArtifactIds, ['71', '74']);
assert.deepEqual(plan.deleteArtifactIds, ['72', '73']);
assert.deepEqual(plan.keepCacheIds, ['82', '83']);
assert.deepEqual(plan.deleteCacheIds, ['81']);

console.log('Actions retention policy checks passed.');
