// Proof that the Garden Blind Reviewer projection (psfn-framework-33xah) says
// something true about the reviewer without saying anything about the evidence:
// disabled, unwired, never-run and running are four DIFFERENT answers, the
// digest never leaves the service, the effective cadence is the max of the two
// owner-file intervals, and the change-gate preview follows the same order the
// lane's own gate uses.

import { describe, expect, it } from 'vitest';

import {
  createAdminBlindReviewService,
  type AdminBlindReviewReadPort,
  type AdminBlindReviewStateView,
} from './blind-review-service.js';
import { blindReviewTestConfig } from '../../../core/cogsec/blind-review/blind-review.test-support.js';
import type {
  BlindReviewGateSavings,
  BlindReviewLaneState,
} from '../../../core/cogsec/blind-review/contracts.js';

const NOW_MS = 1_800_000_000_000;

function readPort(
  state: Partial<BlindReviewLaneState>,
  rows: { total: number; pinned: number; unreviewed: number },
  savings: Partial<BlindReviewGateSavings> = {},
): AdminBlindReviewReadPort {
  return {
    readState: () => Promise.resolve({
      ingestedThroughMs: 0,
      lastBatchDigest: null,
      reviewAttempt: 0,
      retryNotBeforeMs: 0,
      updatedAtMs: 0,
      ...state,
    }),
    countRows: () => Promise.resolve(rows),
    readModelCallsAvoided: () => Promise.resolve({
      modelCallsAvoided: 0,
      lastAvoidedAtMs: 0,
      ...savings,
    }),
  };
}

/**
 * Every string this projection is allowed to carry is a closed enum label.
 * Anything else — a digest, a source ref, an excerpt — would be evidence
 * leaking through a surface whose whole contract is that it carries none.
 */
const ALLOWED_STRINGS: ReadonlySet<string> = new Set([
  'disabled', 'unwired', 'never_run', 'running',
  'no_evidence', 'undersized_items', 'eligible',
]);

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
  }
  return [];
}

function assertContentFree(view: AdminBlindReviewStateView): void {
  for (const found of stringsIn(view)) {
    expect(ALLOWED_STRINGS.has(found), `unexpected string in projection: ${found}`).toBe(true);
  }
}

const config = blindReviewTestConfig({
  root: { intervalMs: 3_600_000 },
  batch: { minItemsPerBatch: 4, maxItemsPerBatch: 24 },
  window: { maxRows: 100, maxPinnedRows: 10, retentionMs: 604_800_000 },
  retry: { maxAttempts: 3 },
});

describe('admin blind review projection: status is an answer, not an absence', () => {
  it('reports disabled without touching the store', async () => {
    let read = false;
    const view = await createAdminBlindReviewService({
      config: { ...config, enabled: false },
      backgroundMaintenanceIntervalMs: 300_000,
      reader: {
        readState: () => { read = true; throw new Error('must not read'); },
        countRows: () => { read = true; throw new Error('must not read'); },
        readModelCallsAvoided: () => { read = true; throw new Error('must not read'); },
      },
    }).getState(NOW_MS);
    expect(view.status).toBe('disabled');
    expect(view.enabled).toBe(false);
    expect(read).toBe(false);
  });

  it('reports unwired when enabled with no durable window', async () => {
    const view = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: null,
    }).getState(NOW_MS);
    expect(view.status).toBe('unwired');
    expect(view.enabled).toBe(true);
    expect(view.window.total).toBe(0);
  });

  it('distinguishes a wired reviewer that has never run from one that has', async () => {
    const neverRan = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort({}, { total: 0, pinned: 0, unreviewed: 0 }),
    }).getState(NOW_MS);
    expect(neverRan.status).toBe('never_run');

    const ran = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort(
        { updatedAtMs: NOW_MS - 60_000, ingestedThroughMs: NOW_MS - 90_000 },
        { total: 12, pinned: 0, unreviewed: 12 },
      ),
    }).getState(NOW_MS);
    expect(ran.status).toBe('running');
    expect(ran.updatedAtMs).toBe(NOW_MS - 60_000);
  });
});

describe('admin blind review projection: content-free', () => {
  it('reduces the batch digest to a boolean and never carries it', async () => {
    const view = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort(
        { updatedAtMs: NOW_MS, lastBatchDigest: 'a'.repeat(64) },
        { total: 8, pinned: 0, unreviewed: 0 },
      ),
    }).getState(NOW_MS);
    expect(view.hasReviewedBatch).toBe(true);
    expect(JSON.stringify(view)).not.toContain('a'.repeat(8));
    assertContentFree(view);
  });

  it('reports no review yet when the window has never been digested', async () => {
    const view = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort({ updatedAtMs: NOW_MS }, { total: 3, pinned: 0, unreviewed: 3 }),
    }).getState(NOW_MS);
    expect(view.hasReviewedBatch).toBe(false);
  });
});

describe('admin blind review projection: cadence and gate', () => {
  it('reports the effective cadence as the max of both owner-file intervals', async () => {
    const slowTick = await createAdminBlindReviewService({
      config: { ...config, intervalMs: 60_000 },
      backgroundMaintenanceIntervalMs: 900_000,
      reader: readPort({ updatedAtMs: NOW_MS }, { total: 0, pinned: 0, unreviewed: 0 }),
    }).getState(NOW_MS);
    expect(slowTick.cadence.effectiveIntervalMs).toBe(900_000);
    expect(slowTick.cadence.intervalMs).toBe(60_000);
    expect(slowTick.cadence.backgroundMaintenanceIntervalMs).toBe(900_000);

    const slowLane = await createAdminBlindReviewService({
      config: { ...config, intervalMs: 3_600_000 },
      backgroundMaintenanceIntervalMs: 900_000,
      reader: readPort({ updatedAtMs: NOW_MS }, { total: 0, pinned: 0, unreviewed: 0 }),
    }).getState(NOW_MS);
    expect(slowLane.cadence.effectiveIntervalMs).toBe(3_600_000);
  });

  it('previews the gate in the same order the lane applies it', async () => {
    const gateFor = async (unreviewed: number) => (
      await createAdminBlindReviewService({
        config,
        backgroundMaintenanceIntervalMs: 300_000,
        reader: readPort({ updatedAtMs: NOW_MS }, { total: unreviewed, pinned: 0, unreviewed }),
      }).getState(NOW_MS)
    ).gate.nextPassGate;

    expect(await gateFor(0)).toBe('no_evidence');
    expect(await gateFor(3)).toBe('undersized_items');
    expect(await gateFor(4)).toBe('eligible');
    expect(await gateFor(400)).toBe('eligible');
  });

  it('carries the cumulative gate savings and the time of the last refusal', async () => {
    const view = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort(
        { updatedAtMs: NOW_MS },
        { total: 8, pinned: 0, unreviewed: 8 },
        { modelCallsAvoided: 47, lastAvoidedAtMs: NOW_MS - 120_000 },
      ),
    }).getState(NOW_MS);
    expect(view.gate.modelCallsAvoided).toBe(47);
    expect(view.gate.modelCallsAvoidedAtMs).toBe(NOW_MS - 120_000);
    // A cumulative counter is a number and a clock reading; neither can carry
    // evidence, and the content-free walk proves nothing else came with them.
    assertContentFree(view);
  });

  it('reports a gate that has never refused a call as zero and never', async () => {
    const view = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort({ updatedAtMs: NOW_MS }, { total: 0, pinned: 0, unreviewed: 0 }),
    }).getState(NOW_MS);
    expect(view.gate.modelCallsAvoided).toBe(0);
    expect(view.gate.modelCallsAvoidedAtMs).toBe(0);
  });

  it('reports zero savings for a disabled or unwired reviewer without reading', async () => {
    for (const status of ['disabled', 'unwired'] as const) {
      const view = await createAdminBlindReviewService({
        config: status === 'disabled' ? { ...config, enabled: false } : config,
        backgroundMaintenanceIntervalMs: 300_000,
        reader: status === 'disabled'
          ? readPort({}, { total: 0, pinned: 0, unreviewed: 0 }, { modelCallsAvoided: 9 })
          : null,
      }).getState(NOW_MS);
      expect(view.status).toBe(status);
      expect(view.gate.modelCallsAvoided).toBe(0);
      expect(view.gate.modelCallsAvoidedAtMs).toBe(0);
    }
  });

  it('reports a batch ceiling below the floor as permanently undersized', async () => {
    const view = await createAdminBlindReviewService({
      // A ceiling under the floor can never admit a batch; the preview must say
      // so rather than calling a large backlog eligible.
      config: blindReviewTestConfig({ batch: { minItemsPerBatch: 8, maxItemsPerBatch: 4 } }),
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort({ updatedAtMs: NOW_MS }, { total: 50, pinned: 0, unreviewed: 50 }),
    }).getState(NOW_MS);
    expect(view.gate.nextPassGate).toBe('undersized_items');
  });
});

describe('admin blind review projection: pressure and retry', () => {
  it('flags the row and pin ceilings once they are reached', async () => {
    const view = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort({ updatedAtMs: NOW_MS }, { total: 100, pinned: 10, unreviewed: 40 }),
    }).getState(NOW_MS);
    expect(view.window.atRowCeiling).toBe(true);
    expect(view.window.atPinCeiling).toBe(true);
    assertContentFree(view);
  });

  it('reports backoff only while the retry window is still in the future', async () => {
    const backingOff = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort(
        { updatedAtMs: NOW_MS, reviewAttempt: 2, retryNotBeforeMs: NOW_MS + 60_000 },
        { total: 8, pinned: 0, unreviewed: 8 },
      ),
    }).getState(NOW_MS);
    expect(backingOff.retry).toMatchObject({
      attempt: 2, maxAttempts: 3, backingOff: true, attemptsExhausted: false,
    });

    const elapsed = await createAdminBlindReviewService({
      config,
      backgroundMaintenanceIntervalMs: 300_000,
      reader: readPort(
        { updatedAtMs: NOW_MS, reviewAttempt: 3, retryNotBeforeMs: NOW_MS - 1 },
        { total: 8, pinned: 0, unreviewed: 8 },
      ),
    }).getState(NOW_MS);
    expect(elapsed.retry).toMatchObject({ backingOff: false, attemptsExhausted: true });
  });
});
