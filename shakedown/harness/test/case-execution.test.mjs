import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBSERVED_SUBAGENT_CHILD_TURN_P95_MS,
  SUBAGENT_STEP_TIMEOUT_MS,
  caseFailureStatus,
  isMatrixAbortStatus,
  resolveCaseTimeoutMs,
  runCaseWithTimeout,
  withTimeout,
} from '../lib/case-execution.mjs';

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
