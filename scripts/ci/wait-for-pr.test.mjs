import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForPr } from './wait-for-pr.mjs';

const HEAD = '1111111111111111111111111111111111111111';
const DRAFT_RUN_ID = 31113704535;
const READY_RUN_ID = 31113708722;

function ciRun(runId, {
  status = 'COMPLETED',
  conclusion = 'SUCCESS',
  startedAt = '',
  completedAt = '',
} = {}) {
  return {
    name: 'ci-required',
    status,
    conclusion,
    startedAt,
    completedAt,
    detailsUrl: `https://github.com/CGIC-AI/psfn-framework/actions/runs/${runId}/job/${runId}`,
  };
}

function draftRun() {
  return ciRun(DRAFT_RUN_ID, {
    conclusion: 'SKIPPED',
    startedAt: '2026-08-06T15:00:25Z',
    completedAt: '2026-08-06T15:00:18Z',
  });
}

function pr(checks, headRefOid = HEAD) {
  return {
    number: 381,
    headRefOid,
    labels: [],
    statusCheckRollup: checks,
  };
}

test('follows the newer queued same-name Actions run regardless of rollup ordering', async () => {
  let reads = 0;
  const queuedReadyRun = ciRun(READY_RUN_ID, {
    status: 'QUEUED',
    conclusion: '',
  });

  await waitForPr({
    reference: '381',
    expectedHead: HEAD,
    intervalMs: 1,
    read: () => {
      reads += 1;
      return reads === 1
        ? pr([draftRun(), queuedReadyRun])
        : pr([
            ciRun(READY_RUN_ID, {
              startedAt: '2026-08-06T15:04:07Z',
              completedAt: '2026-08-06T15:04:10Z',
            }),
            draftRun(),
          ]);
    },
    sleep: async () => {},
  });

  assert.equal(reads, 2);
});

test('fails closed when the newer same-name Actions run does not succeed', async () => {
  for (const conclusion of ['SKIPPED', 'CANCELLED', 'FAILURE']) {
    await assert.rejects(
      waitForPr({
        reference: '381',
        expectedHead: HEAD,
        read: () => pr([
          ciRun(READY_RUN_ID, {
            conclusion,
            startedAt: '2026-08-06T15:04:07Z',
            completedAt: '2026-08-06T15:04:10Z',
          }),
          ciRun(DRAFT_RUN_ID, {
            startedAt: '2026-08-06T15:00:25Z',
            completedAt: '2026-08-06T15:00:18Z',
          }),
        ]),
      }),
      new RegExp(`ci-required concluded ${conclusion}`, 'i'),
    );
  }
});

test('fails closed when duplicate check-run recency metadata is ambiguous', async () => {
  await assert.rejects(
    waitForPr({
      reference: '381',
      expectedHead: HEAD,
      read: () => pr([
        { name: 'ci-required', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'ci-required', status: 'QUEUED', conclusion: '' },
      ]),
    }),
    /ci-required concluded AMBIGUOUS/i,
  );
});

test('accepts exact duplicate observations without inventing ambiguity', async () => {
  const duplicate = { name: 'ci-required', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const result = await waitForPr({
    reference: '381',
    expectedHead: HEAD,
    read: () => pr([duplicate, { ...duplicate }]),
  });

  assert.equal(result.number, 381);
});

test('timeout names the newer active run instead of the stale duplicate', async () => {
  let nowMs = 0;
  await assert.rejects(
    waitForPr({
      reference: '381',
      expectedHead: HEAD,
      timeoutMs: 10,
      intervalMs: 5,
      now: () => nowMs,
      read: () => pr([
        draftRun(),
        ciRun(READY_RUN_ID, { status: 'QUEUED', conclusion: '' }),
      ]),
      sleep: async (durationMs) => {
        nowMs += durationMs;
      },
    }),
    /Timed out.*Last observed state: ci-required has not completed\./i,
  );
});

test('rejects a changed exact SHA before accepting duplicate check-run history', async () => {
  await assert.rejects(
    waitForPr({
      reference: '381',
      expectedHead: HEAD,
      read: () => pr([
        draftRun(),
        ciRun(READY_RUN_ID, {
          startedAt: '2026-08-06T15:04:07Z',
          completedAt: '2026-08-06T15:04:10Z',
        }),
      ], `3${HEAD.slice(1)}`),
    }),
    /PR head changed.*while waiting/i,
  );
});

test('fails loudly when the only required check is skipped', async () => {
  await assert.rejects(
    waitForPr({
      reference: '381',
      expectedHead: HEAD,
      read: () => pr([ciRun(READY_RUN_ID, { conclusion: 'SKIPPED' })]),
    }),
    /ci-required concluded SKIPPED/i,
  );
});
