#!/usr/bin/env node

import assert from 'node:assert/strict';
import { runHostCleanupSteps } from '../lib/host-cleanup.mjs';

const calls = [];
const result = await runHostCleanupSteps([
  {
    name: 'approval',
    failureLabel: 'approval cleanup failed',
    run: async () => {
      calls.push('approval');
      throw new Error('queue unavailable');
    },
  },
  {
    name: 'branch',
    failureLabel: 'branch cleanup failed',
    run: async () => {
      calls.push('branch');
      return { status: 'not_created' };
    },
  },
  {
    name: 'issues',
    failureLabel: 'issue cleanup failed',
    run: async () => {
      calls.push('issues');
      return [];
    },
  },
]);

assert.deepEqual(calls, ['approval', 'branch', 'issues']);
assert.deepEqual(result.cleanup, {
  branch: { status: 'not_created' },
  issues: [],
});
assert.deepEqual(result.cleanupErrors, [
  'approval cleanup failed: queue unavailable',
]);

console.log('host cleanup controller tests passed');
