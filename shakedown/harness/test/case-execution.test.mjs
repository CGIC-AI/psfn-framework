import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBSERVED_SUBAGENT_CHILD_TURN_P95_MS,
  SUBAGENT_STEP_TIMEOUT_MS,
  CaseConfigurationError,
  classifyCaseFailure,
  caseFailureStatus,
  isMatrixAbortStatus,
  resolveCaseTimeoutMs,
  runCaseWithTimeout,
  runCaseSetup,
  withTimeout,
} from '../lib/case-execution.mjs';
import { MissingEnvError } from '../lib/env.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('subagent steps absorb the observed child-turn P95 with explicit headroom', async () => {
  assert.equal(OBSERVED_SUBAGENT_CHILD_TURN_P95_MS, 174_000);
  assert.equal(SUBAGENT_STEP_TIMEOUT_MS, 240_000);
  assert.ok(SUBAGENT_STEP_TIMEOUT_MS > OBSERVED_SUBAGENT_CHILD_TURN_P95_MS);

  const result = await withTimeout('slow child', 40, async () => {
    await sleep(15);
    return 'completed';
  });
  assert.equal(result, 'completed');
});

test('case budget contains both post-abort recovery waits', async () => {
  const defaults = {
    fetchTimeoutMs: 6,
    turnMatchWaitMs: 2,
    turnSettleMs: 2,
    postAbortTurnWaitMs: 24,
    afterTimeoutMs: 4,
    caseOverheadTimeoutMs: 3,
  };
  const caseTimeoutMs = resolveCaseTimeoutMs({
    message: 'fixture',
    timeoutMs: 6,
  }, defaults);

  assert.equal(caseTimeoutMs, 65);
  const recovered = await withTimeout('case recovery', caseTimeoutMs, async () => {
    await sleep(6); // request timeout
    await sleep(24); // exact-turn recovery
    await sleep(24); // settlement recovery
    return 'recovered';
  });
  assert.equal(recovered, 'recovered');
});

test('a hung case is a local failure and does not abort the next case', async () => {
  const results = [];
  let nextCaseRan = false;
  for (const run of [
    (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    async () => {
      nextCaseRan = true;
      return 'ok';
    },
  ]) {
    try {
      results.push(await runCaseWithTimeout({
        label: 'fixture case',
        timeoutMs: 10,
        cancellationDrainTimeoutMs: 10,
        run,
      }));
    } catch (error) {
      const status = caseFailureStatus(error);
      results.push(status);
      if (isMatrixAbortStatus(status)) break;
    }
  }

  assert.deepEqual(results, ['case_timeout', 'ok']);
  assert.equal(nextCaseRan, true);
});

test('a setup MissingEnvError is a named coverage hole and does not abort later cases or tiers', async () => {
  const visitedTiers = [];
  const results = [];
  for (const tier of ['nursery', 'apprentice', 'autonomous']) {
    visitedTiers.push(tier);
    const cases = tier === 'nursery'
      ? [
          {
            id: 'missing-satellite-key',
            before: () => {
              throw new MissingEnvError('PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY');
            },
          },
          {
            id: 'invalid-policy-owner',
            before: () => {
              throw new CaseConfigurationError(
                'invalid_owner:intake-policy.json.mode',
                'intake-policy.json must use enforce mode',
              );
            },
          },
          { id: 'nursery-after-hole', before: () => 'configured' },
        ]
      : [{ id: `${tier}-case`, before: () => 'configured' }];

    for (const testCase of cases) {
      try {
        results.push({ id: testCase.id, value: await runCaseSetup(testCase, {}) });
      } catch (error) {
        const failure = classifyCaseFailure(error);
        results.push({ id: testCase.id, ...failure });
        if (isMatrixAbortStatus(failure.status)) break;
      }
    }
  }

  assert.deepEqual(visitedTiers, ['nursery', 'apprentice', 'autonomous']);
  assert.deepEqual(results, [
    {
      id: 'missing-satellite-key',
      status: 'coverage_hole',
      reason: 'missing_env:PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY',
    },
    {
      id: 'invalid-policy-owner',
      status: 'coverage_hole',
      reason: 'invalid_owner:intake-policy.json.mode',
    },
    { id: 'nursery-after-hole', value: 'configured' },
    { id: 'apprentice-case', value: 'configured' },
    { id: 'autonomous-case', value: 'configured' },
  ]);
});

test('an unexpected setup failure remains matrix-blocking', async () => {
  let caught;
  try {
    await runCaseSetup({
      id: 'mutating-setup',
      before: () => {
        throw new Error('telemetry reset failed after dispatch');
      },
    }, {});
  } catch (error) {
    caught = classifyCaseFailure(error);
  }

  assert.deepEqual(caught, { status: 'harness_error', reason: 'harness_error:Error' });
  assert.equal(isMatrixAbortStatus(caught.status), true);
});
