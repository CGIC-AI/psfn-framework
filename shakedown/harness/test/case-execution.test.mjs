import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBSERVED_SUBAGENT_CHILD_TURN_P95_MS,
  SUBAGENT_STEP_TIMEOUT_MS,
  CaseConfigurationError,
  caseStatusAfterCleanupFailure,
  classifyCaseFailure,
  caseFailureStatus,
  isMatrixAbortStatus,
  probeKnownBusySettlement,
  resolveCaseCoverageHoleReason,
  resolveCaseTimeoutMs,
  runCaseWithTimeout,
  runCaseSetup,
  waitForAgentQuiescence,
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

test('agent_busy is case-local and the next case waits for explicit quiescence', async () => {
  let nowMs = 0;
  let busy = false;
  let nextCaseRan = false;
  const results = [];
  const cases = [
    async () => {
      busy = true;
      return 'agent_busy';
    },
    async () => {
      nextCaseRan = true;
      return 'ok';
    },
  ];

  for (const [index, run] of cases.entries()) {
    const quiescence = await waitForAgentQuiescence({
      timeoutMs: 20,
      pollIntervalMs: 5,
      now: () => nowMs,
      wait: async (delayMs) => {
        nowMs += delayMs;
        if (index === 1) busy = false;
      },
      probe: async () => ({
        reachable: true,
        busy,
        activeTurnIds: busy ? ['turn-still-settling'] : [],
      }),
    });
    assert.equal(quiescence.quiescent, true);
    const status = await run();
    results.push(status);
    if (isMatrixAbortStatus(status)) break;
  }

  assert.deepEqual(results, ['agent_busy', 'ok']);
  assert.equal(isMatrixAbortStatus('agent_busy'), false);
  assert.equal(nextCaseRan, true);
});

for (const status of ['runtime_stale', 'harness_error']) {
  test(`${status} is case-local and cannot abort the remaining matrix`, () => {
    assert.equal(isMatrixAbortStatus(status), false);
    assert.equal(caseStatusAfterCleanupFailure(status), status);
  });
}

test('cleanup failures fail a clean case without erasing an existing named failure', () => {
  assert.equal(caseStatusAfterCleanupFailure('ok'), 'semantic_failure');
  for (const status of ['case_timeout', 'agent_busy', 'runtime_stale', 'harness_error']) {
    assert.equal(caseStatusAfterCleanupFailure(status), status);
  }
});

test('quiescence names persistent busy separately from an unavailable admin probe', async () => {
  const run = async (probe) => {
    let nowMs = 0;
    return waitForAgentQuiescence({
      timeoutMs: 10,
      pollIntervalMs: 5,
      now: () => nowMs,
      wait: async (delayMs) => { nowMs += delayMs; },
      probe,
    });
  };

  assert.equal((await run(async () => ({ reachable: true, busy: true }))).reason, 'agent_busy');
  assert.equal((await run(async () => ({ reachable: false, busy: null }))).reason, 'admin_unreachable');
});

test('admin settlement probe finds the global busy turn outside the harness session', async () => {
  let backgroundCompletedAtMs = 90;
  const fetchJson = async (url) => {
    if (url.endsWith('/api/admin/settings/capabilities')) {
      return { ok: true, status: 200, body: { tier: 'nursery' } };
    }
    if (url.endsWith('/api/admin/sessions')) {
      return {
        ok: true,
        status: 200,
        body: { channels: [
          { sessionId: 'api:testing-harness', lastActivityAt: 200 },
          { sessionId: 'internal:heartbeat', lastActivityAt: 150 },
        ] },
      };
    }
    if (url.includes('api%3Atesting-harness')) {
      return {
        ok: true,
        status: 200,
        body: { turns: [
          { record: { turnId: 'harness-busy-rejection', startedAt: 101, completedAt: 105 } },
          { record: { turnId: 'harness-old', startedAt: 80, completedAt: 90 } },
        ] },
      };
    }
    return {
      ok: true,
      status: 200,
      body: { turns: [{
        record: {
          turnId: 'heartbeat-busy-owner',
          startedAt: 50,
          completedAt: backgroundCompletedAtMs,
        },
      }] },
    };
  };

  const input = {
    adminBase: 'http://admin.fixture',
    busyObservedAtMs: 100,
    fetchJson,
  };
  assert.equal((await probeKnownBusySettlement(input)).busy, true);
  backgroundCompletedAtMs = 110;
  assert.deepEqual(await probeKnownBusySettlement(input), {
    reachable: true,
    busy: false,
    controlPlaneStatus: 200,
    sessionListStatus: 200,
    checkedSessionCount: 2,
    latestCompletedAtMs: 110,
    sessionScanTruncated: false,
    settledTurnId: 'heartbeat-busy-owner',
    settledSessionId: 'internal:heartbeat',
  });
});

test('admin settlement probe treats recovery-only runtime state as still busy', async () => {
  const result = await probeKnownBusySettlement({
    adminBase: 'http://admin.fixture',
    busyObservedAtMs: 100,
    fetchJson: async (url) => (
      url.endsWith('/api/admin/settings/capabilities')
        ? { ok: true, status: 200, body: { tier: 'nursery' } }
        : { ok: false, status: 503, body: { error: 'only capability-tier recovery is admitted' } }
    ),
  });
  assert.equal(result.reachable, true);
  assert.equal(result.busy, true);
  assert.equal(result.sessionListStatus, 503);
});

test('admin settlement probe bounds heavyweight session detail reads', async () => {
  let detailCalls = 0;
  const result = await probeKnownBusySettlement({
    adminBase: 'http://admin.fixture',
    busyObservedAtMs: 100,
    fetchJson: async (url) => {
      if (url.endsWith('/api/admin/settings/capabilities')) {
        return { ok: true, status: 200, body: { tier: 'nursery' } };
      }
      if (url.endsWith('/api/admin/sessions')) {
        return {
          ok: true,
          status: 200,
          body: { channels: Array.from({ length: 20 }, (_, index) => ({
            sessionId: `session-${index}`,
            lastActivityAt: 200 - index,
          })) },
        };
      }
      detailCalls += 1;
      return { ok: true, status: 200, body: { turns: [] } };
    },
  });

  assert.equal(detailCalls, 12);
  assert.equal(result.checkedSessionCount, 12);
  assert.equal(result.sessionScanTruncated, true);
  assert.equal(result.busy, true);
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

test('an unexpected setup failure keeps its name but remains case-local', async () => {
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
  assert.equal(isMatrixAbortStatus(caught.status), false);
});

test('a target excluded by case variants is a named coverage hole', () => {
  assert.equal(resolveCaseCoverageHoleReason({
    id: 'backup_encryption_roundtrip',
    variants: ['local'],
  }, {
    target: 'kube',
    catalogToolNames: [],
  }), 'variant_excluded:target=kube;supported=local');
  assert.equal(resolveCaseCoverageHoleReason({
    id: 'backup_encryption_roundtrip',
    variants: ['local'],
  }, {
    target: 'local',
    catalogToolNames: [],
  }), null);
});

test('a requested suggested tool absent from the live catalog is a named coverage hole', () => {
  assert.equal(resolveCaseCoverageHoleReason({
    id: 'issue_create_update',
    variants: ['local', 'kube'],
    suggestTools: ['beads'],
  }, {
    target: 'local',
    catalogToolNames: ['memory', 'skill'],
  }), 'catalog_tool_missing:beads');
});
