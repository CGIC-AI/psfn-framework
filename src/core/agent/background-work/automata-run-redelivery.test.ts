import { describe, expect, it } from 'vitest';

import type { AutomataRedeliveryCandidate } from '../../../faculties/automata/run-registry.js';
import {
  createBackgroundWorkRunRedeliveryOracle,
  intentionPostTurnHooksRunId,
  type BackgroundWorkRunLinkageJob,
  type BackgroundWorkRunLinkageKeys,
} from './automata-run-redelivery.js';
import { BACKGROUND_WORK_LEASE_EXPIRY_LIMIT } from './types.js';

const NOW_MS = 1_000_000;

function job(overrides: Partial<BackgroundWorkRunLinkageJob> = {}): BackgroundWorkRunLinkageJob {
  return {
    jobId: 'bgw_public_example',
    kind: 'memory_extraction',
    state: 'queued',
    sourceRequestId: 'request-public-example',
    sourceTurnId: 'turn-public-example',
    attemptCount: 0,
    leaseExpiryCount: 0,
    boundaryCrossed: false,
    ...overrides,
  };
}

function oracleOver(jobs: BackgroundWorkRunLinkageJob[], seenKeys: BackgroundWorkRunLinkageKeys[] = []) {
  return createBackgroundWorkRunRedeliveryOracle({
    async listNonTerminalJobsForRunLinkage(keys) {
      seenKeys.push(keys);
      return jobs;
    },
  });
}

function memory(...lineageRunIds: string[]): AutomataRedeliveryCandidate {
  return { automatonClass: 'memory.extraction', lineageRunIds };
}

describe('background-work Automata run redelivery oracle', () => {
  it('vouches for nothing when no live job exists', async () => {
    const redelivered = await oracleOver([]).findRedeliveredRunIds(
      [memory('turn-public-example:memory-extraction'), memory('request-public-example')],
      NOW_MS,
    );
    expect([...redelivered]).toEqual([]);
  });

  it('matches every run id a memory extraction job can re-enter and queries by exact identity keys', async () => {
    const seenKeys: BackgroundWorkRunLinkageKeys[] = [];
    const candidates = [
      memory('request-public-example'),
      memory('bgw_public_example'),
      memory('turn-public-example:memory-extraction'),
      memory('unrelated-request'),
    ];
    const redelivered = await oracleOver([job()], seenKeys).findRedeliveredRunIds(candidates, NOW_MS);
    expect([...redelivered].sort()).toEqual([
      'bgw_public_example',
      'request-public-example',
      'turn-public-example:memory-extraction',
    ]);
    expect(seenKeys).toHaveLength(1);
    expect(seenKeys[0]!.sourceTurnIds).toEqual(['turn-public-example']);
    expect(seenKeys[0]!.sourceRequestIds).toContain('unrelated-request');
  });

  it('binds intention hooks runs to the job attempt that will re-enter them', async () => {
    const current = intentionPostTurnHooksRunId('request-public-example', 2);
    const previous = intentionPostTurnHooksRunId('request-public-example', 1);
    const seenKeys: BackgroundWorkRunLinkageKeys[] = [];
    const redelivered = await oracleOver([
      job({ kind: 'intention_post_turn_hooks', state: 'retry_wait', attemptCount: 2 }),
    ], seenKeys).findRedeliveredRunIds([
      { automatonClass: 'background.intention_post_turn_hooks', lineageRunIds: [current] },
      { automatonClass: 'background.intention_post_turn_hooks', lineageRunIds: [previous] },
    ], NOW_MS);
    expect([...redelivered]).toEqual([current]);
    expect(seenKeys[0]!.sourceRequestIds).toEqual(['request-public-example']);
  });

  it('never lets a job of another kind vouch for a run with a colliding id', async () => {
    // The memory job derives `request-public-example`, but the run is an
    // intention hooks run: only a job of the run's own kind re-enters it.
    const redelivered = await oracleOver([job()]).findRedeliveredRunIds([
      { automatonClass: 'background.intention_post_turn_hooks', lineageRunIds: ['request-public-example'] },
      memory('unrelated-request'),
    ], NOW_MS);
    expect([...redelivered]).toEqual([]);
  });

  it('mirrors the lease-expiry sweep for running jobs', async () => {
    const running = (overrides: Partial<BackgroundWorkRunLinkageJob>) => job({
      state: 'running',
      leaseExpiresAtMs: NOW_MS - 1,
      ...overrides,
    });
    const decide = async (candidate: BackgroundWorkRunLinkageJob) => (
      await oracleOver([candidate]).findRedeliveredRunIds([memory('request-public-example')], NOW_MS)
    ).has('request-public-example');

    // A lease that may still belong to a live previous process is kept.
    expect(await decide(running({ leaseExpiresAtMs: NOW_MS + 1, boundaryCrossed: true }))).toBe(true);
    // Re-leased to retry_wait by the sweep.
    expect(await decide(running({ leaseExpiryCount: BACKGROUND_WORK_LEASE_EXPIRY_LIMIT - 2 }))).toBe(true);
    // Dead-lettered by the sweep: expiry budget exhausted or unknown outcome.
    expect(await decide(running({ leaseExpiryCount: BACKGROUND_WORK_LEASE_EXPIRY_LIMIT - 1 }))).toBe(false);
    expect(await decide(running({ boundaryCrossed: true }))).toBe(false);
    // Terminal rows never redeliver even if a store returns them.
    expect(await decide(job({ state: 'failed' }))).toBe(false);
    for (const state of ['queued', 'deferred', 'retry_wait'] as const) {
      expect(await decide(job({ state }))).toBe(true);
    }
  });

  it('owns no run for kinds without a run derivation and rejects classes without a queue owner', async () => {
    const oracle = oracleOver([job({ kind: 'emotion_appraisal' })]);
    expect([...await oracle.findRedeliveredRunIds([
      { automatonClass: 'background.emotion_appraisal', lineageRunIds: ['request-public-example'] },
    ], NOW_MS)]).toEqual([]);
    await expect(oracle.findRedeliveredRunIds([
      { automatonClass: 'subagent.bounded', lineageRunIds: ['request-public-example'] },
    ], NOW_MS)).rejects.toThrow('no background-work redelivery owner');
    await expect(oracleOver([job({ kind: 'mystery' })]).findRedeliveredRunIds(
      [memory('request-public-example')],
      NOW_MS,
    )).rejects.toThrow('Unknown background-work kind');
  });
});
