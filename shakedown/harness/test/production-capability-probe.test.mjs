#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const probePath = fileURLToPath(
  new URL('../lib/production-capability-probe.ts', import.meta.url),
);
const tsxPath = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

function runProbe(tier) {
  return JSON.parse(execFileSync(
    tsxPath,
    [probePath, '--tier', tier],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  ));
}

const apprentice = runProbe('apprentice');
assert.equal(apprentice.tier, 'apprentice');
assert.equal(apprentice.gates.length, 22);

const restart = apprentice.gates.find((entry) => entry.executionId === 'lifecycle_restart');
assert.deepEqual(restart.eligibility, {
  allowed: false,
  requiredTokens: ['lifecycle.restart'],
  missingTokens: ['lifecycle.restart'],
});
assert.equal(restart.handlerReached, false);
assert.deepEqual(restart.result.details, {
  isError: true,
  capabilityDenied: true,
  tier: 'apprentice',
  missingTokens: ['lifecycle.restart'],
});

const scratchpad = apprentice.gates.find((entry) => entry.executionId === 'memory_write');
assert.equal(scratchpad.eligibility.allowed, true);
assert.equal(scratchpad.handlerReached, true);

assert.deepEqual(apprentice.shardBackend, {
  method: 'shard.backend.request',
  callerTier: 'apprentice',
  authoritativeTier: 'apprentice',
  actual: 'policy_denied',
  code: -32002,
});

const autonomous = runProbe('autonomous');
const autonomousRestart = autonomous.gates.find(
  (entry) => entry.executionId === 'lifecycle_restart',
);
assert.equal(autonomousRestart.eligibility.allowed, true);
assert.equal(autonomousRestart.handlerReached, true);
assert.deepEqual(autonomous.shardBackend, {
  method: 'shard.backend.request',
  callerTier: 'autonomous',
  authoritativeTier: 'autonomous',
  actual: 'accepted_unavailable',
  code: null,
});

console.log('production capability probe tests passed');
