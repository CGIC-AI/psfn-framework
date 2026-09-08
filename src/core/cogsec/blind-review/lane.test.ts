// Behavioral proof of the passive Blind Reviewer lane against an in-memory
// window. The acceptance criteria this file owns: all three CogSec modes feed
// the same lane, unchanged/undersized batches make zero model calls, a slow or
// unavailable reviewer neither blocks nor disappears, alerts carry safe
// summaries and provenance and never a block/hold action, and alert evidence is
// pinned. Restart recovery, backpressure and retention expiry are proven
// end-to-end against real Postgres in the sibling integration test.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlindReviewLane, type BlindReviewRunResult } from './lane.js';
import {
  BLIND_REVIEW_ACTOR,
  BLIND_REVIEW_CHANNEL_ID,
  type BlindReviewEvidenceItem,
  type BlindReviewEvidenceSourcePort,
  type BlindReviewFinding,
} from './contracts.js';
import {
  InMemoryBlindReviewStore,
  blindReviewTestConfig,
  blindReviewTestEvidenceRange,
} from './blind-review.test-support.js';
import { CogSecEventStore } from '../events.js';
import { listAgentVisibleCogSecEvents, listOperatorVisibleCogSecEvents } from '../safe-log.js';
import { COGSEC_MODES } from '../../../shared/contracts/cogsec-mode.js';
import { resolveCogSecEventsPath } from '../../../persistence/layout.js';
import type { BlindReviewerConfig } from '../../../system/config/scheduler-config/blind-review.js';

// Just after the fixture evidence timestamps, so the default 7-day retention
// window keeps every fixture row rather than expiring it on the first prune.
const NOW_MS = 1_700_000_100_000;

const CLEAN_FINDING: BlindReviewFinding = {
  concernLevel: 'none',
  confidence: 0.9,
  safeSummary: 'Ordinary tool usage; nothing anomalous.',
  model: 'test-model',
};

const CONCERNED_FINDING: BlindReviewFinding = {
  concernLevel: 'high',
  confidence: 0.95,
  safeSummary: 'Repeated failing retrieval attempts diverge from the usual shape.',
  model: 'test-model',
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'psfn-blind-review-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixedSource(items: BlindReviewEvidenceItem[]): {
  source: BlindReviewEvidenceSourcePort;
  calls: () => number;
} {
  const listEvidence = vi.fn(async (input: { sinceMs: number }) => (
    items.filter(item => item.occurredAtMs > input.sinceMs)
  ));
  return { source: { listEvidence }, calls: () => listEvidence.mock.calls.length };
}

function buildLane(options: {
  items: BlindReviewEvidenceItem[];
  finding?: BlindReviewFinding;
  review?: () => Promise<BlindReviewFinding>;
  config?: BlindReviewerConfig;
  store?: InMemoryBlindReviewStore;
  now?: () => number;
}) {
  const store = options.store ?? new InMemoryBlindReviewStore();
  const review = vi.fn(options.review ?? (async () => options.finding ?? CLEAN_FINDING));
  const { source, calls } = fixedSource(options.items);
  const eventsPath = resolveCogSecEventsPath(root);
  const config = options.config ?? blindReviewTestConfig({
    root: { maxIngestPerRun: 64 },
    batch: { maxItemsPerBatch: 4, minItemsPerBatch: 2, minBlindedCharsPerBatch: 0 },
    cost: { maxReviewsPerRun: 1 },
  });
  const lane = new BlindReviewLane({
    config,
    store,
    source,
    reviewer: { review },
    readMode: () => 'shadow',
    cogSecEvents: () => new CogSecEventStore(eventsPath),
    now: options.now ?? (() => NOW_MS),
  });
  const readEvents = () => new CogSecEventStore(eventsPath).listEvents();
  return { lane, store, review, sourceCalls: calls, readEvents, eventsPath, config };
}

describe('blind review lane: mode independence', () => {
  it.each(COGSEC_MODES)('produces identical review work in %s mode', async (mode) => {
    const items = blindReviewTestEvidenceRange(4);
    const store = new InMemoryBlindReviewStore();
    const review = vi.fn(async () => CLEAN_FINDING);
    const config = blindReviewTestConfig({
      batch: { maxItemsPerBatch: 4, minItemsPerBatch: 2, minBlindedCharsPerBatch: 0 },
      cost: { maxReviewsPerRun: 1 },
    });
    const lane = new BlindReviewLane({
      config,
      store,
      source: fixedSource(items).source,
      reviewer: { review },
      readMode: () => mode,
      cogSecEvents: () => new CogSecEventStore(resolveCogSecEventsPath(root)),
      now: () => NOW_MS,
    });
    const result = await lane.runOnce();
    expect(result.mode).toBe(mode);
    expect(result.ingested).toBe(4);
    expect(result.modelCalls).toBe(1);
    expect(result.batches).toEqual([{ kind: 'clean' }]);
    // The mode reaches the reviewer as provenance and changes nothing else.
    expect(review.mock.calls[0]?.[0]).toMatchObject({ mode, items });
  });

  it('reaches the same alert decision in every mode', async () => {
    const outcomes: { mode: string; batches: BlindReviewRunResult['batches'] }[] = [];
    for (const mode of COGSEC_MODES) {
      const modeRoot = mkdtempSync(join(tmpdir(), `psfn-blind-review-${mode}-`));
      const lane = new BlindReviewLane({
        config: blindReviewTestConfig({
          batch: { maxItemsPerBatch: 4, minItemsPerBatch: 2, minBlindedCharsPerBatch: 0 },
          cost: { maxReviewsPerRun: 1 },
        }),
        store: new InMemoryBlindReviewStore(),
        source: fixedSource(blindReviewTestEvidenceRange(4)).source,
        reviewer: { review: async () => CONCERNED_FINDING },
        readMode: () => mode,
        cogSecEvents: () => new CogSecEventStore(resolveCogSecEventsPath(modeRoot)),
        now: () => NOW_MS,
      });
      const result = await lane.runOnce();
      outcomes.push({ mode, batches: result.batches });
      rmSync(modeRoot, { recursive: true, force: true });
    }
    const [first, ...rest] = outcomes;
    expect(first).toBeDefined();
    for (const outcome of rest) {
      expect(outcome.batches).toEqual(first?.batches);
    }
  });
});

describe('blind review lane: zero model calls behind the deterministic gates', () => {
  it('makes no call when the window is empty', async () => {
    const { lane, review } = buildLane({ items: [] });
    const result = await lane.runOnce();
    expect(review).not.toHaveBeenCalled();
    expect(result.modelCalls).toBe(0);
    expect(result.batches).toEqual([{ kind: 'skipped', reason: 'no_evidence' }]);
  });

  it('makes no call for an undersized batch', async () => {
    const { lane, review } = buildLane({ items: blindReviewTestEvidenceRange(1) });
    const result = await lane.runOnce();
    expect(review).not.toHaveBeenCalled();
    expect(result.batches).toEqual([{ kind: 'skipped', reason: 'undersized_items' }]);
  });

  it('makes no second call when nothing new has arrived', async () => {
    const { lane, review } = buildLane({ items: blindReviewTestEvidenceRange(4) });
    await lane.runOnce();
    expect(review).toHaveBeenCalledTimes(1);
    const second = await lane.runOnce();
    expect(review).toHaveBeenCalledTimes(1);
    expect(second.modelCalls).toBe(0);
    expect(second.batches).toEqual([{ kind: 'skipped', reason: 'no_evidence' }]);
  });

  it('retires a re-offered batch whose digest was already answered', async () => {
    const items = blindReviewTestEvidenceRange(4);
    const store = new InMemoryBlindReviewStore();
    const { lane, review } = buildLane({ items, store });
    await lane.runOnce();
    // Simulate the same evidence re-entering the unreviewed head (a replayed
    // ingest): the digest is unchanged, so it must cost nothing.
    await store.writeState({
      ...(await store.readState()),
      ingestedThroughMs: 0,
    });
    const fresh = new InMemoryBlindReviewStore();
    await fresh.appendEvidence(items, NOW_MS);
    await fresh.writeState(await store.readState());
    const { lane: replayLane, review: replayReview } = buildLane({ items: [], store: fresh });
    const result = await replayLane.runOnce();
    expect(replayReview).not.toHaveBeenCalled();
    expect(result.batches).toEqual([{ kind: 'skipped', reason: 'unchanged_digest' }]);
    expect((await fresh.countRows()).unreviewed).toBe(0);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it('holds the per-run model-call ceiling even when evidence floods in', async () => {
    const { lane, review } = buildLane({
      items: blindReviewTestEvidenceRange(40),
      config: blindReviewTestConfig({
        batch: { maxItemsPerBatch: 4, minItemsPerBatch: 2, minBlindedCharsPerBatch: 0 },
        cost: { maxReviewsPerRun: 2 },
      }),
    });
    const result = await lane.runOnce();
    expect(review).toHaveBeenCalledTimes(2);
    expect(result.modelCalls).toBe(2);
  });
});

describe('blind review lane: a slow or unavailable reviewer', () => {
  it('contains the failure, records a durable retry, and never throws', async () => {
    const store = new InMemoryBlindReviewStore();
    const { lane } = buildLane({
      items: blindReviewTestEvidenceRange(4),
      review: async () => {
        throw new Error('provider unavailable');
      },
      store,
    });
    const result = await lane.runOnce();
    expect(result.batches).toEqual([{ kind: 'failed', error: 'provider unavailable' }]);
    // The evidence is still in the window, unreviewed, and the retry budget moved.
    expect((await store.countRows()).unreviewed).toBe(4);
    const state = await store.readState();
    expect(state.reviewAttempt).toBe(1);
    expect(state.retryNotBeforeMs).toBeGreaterThan(NOW_MS);
  });

  it('spends no model call while the owner-file backoff is in effect', async () => {
    const store = new InMemoryBlindReviewStore();
    const failing = buildLane({
      items: blindReviewTestEvidenceRange(4),
      review: async () => {
        throw new Error('provider unavailable');
      },
      store,
    });
    await failing.lane.runOnce();
    const retry = buildLane({ items: blindReviewTestEvidenceRange(4), store });
    const result = await retry.lane.runOnce();
    expect(retry.review).not.toHaveBeenCalled();
    expect(result.modelCalls).toBe(0);
  });

  it('abandons the batch once the retry budget is exhausted rather than wedging', async () => {
    const store = new InMemoryBlindReviewStore();
    let nowMs = NOW_MS;
    const config = blindReviewTestConfig({
      batch: { maxItemsPerBatch: 4, minItemsPerBatch: 2, minBlindedCharsPerBatch: 0 },
      cost: { maxReviewsPerRun: 1 },
      retry: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 2_000 },
    });
    const build = () => buildLane({
      items: blindReviewTestEvidenceRange(4),
      review: async () => {
        throw new Error('provider unavailable');
      },
      store,
      config,
      now: () => nowMs,
    });
    await build().lane.runOnce();
    nowMs += 60_000;
    await build().lane.runOnce();
    expect((await store.countRows()).unreviewed).toBe(0);
    const state = await store.readState();
    expect(state.reviewAttempt).toBe(0);
    expect(state.retryNotBeforeMs).toBe(0);
  });

  it('aborts a reviewer that outlives its owner-file deadline', async () => {
    // The lane hands the deadline to the reviewer; a reviewer that honors it by
    // rejecting is treated exactly like any other failure — contained, retried.
    const { lane } = buildLane({
      items: blindReviewTestEvidenceRange(4),
      review: async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        throw new Error('deadline exceeded');
      },
    });
    await expect(lane.runOnce()).resolves.toMatchObject({
      batches: [{ kind: 'failed', error: 'deadline exceeded' }],
    });
  });
});

describe('blind review lane: alerts', () => {
  it('raises an operator-only case with a safe summary, provenance, and no action', async () => {
    const items = blindReviewTestEvidenceRange(4);
    const { lane, store, readEvents } = buildLane({ items, finding: CONCERNED_FINDING });
    const result = await lane.runOnce();
    const [outcome] = result.batches;
    expect(outcome).toMatchObject({ kind: 'alerted', pinned: 4 });

    const [event] = readEvents();
    expect(event).toBeDefined();
    expect(event?.type).toBe('blind_review');
    expect(event?.severity).toBe('high');
    expect(event?.status).toBe('open');
    expect(event?.actor).toBe(BLIND_REVIEW_ACTOR);
    expect(event?.sourceChannelId).toBe(BLIND_REVIEW_CHANNEL_ID);
    // Never a block or hold: a Blind Reviewer case carries no CogSec action.
    expect(event?.actions).toEqual([]);
    expect(event?.safeAgentSummary).toContain(CONCERNED_FINDING.safeSummary);
    expect(event?.safeAgentSummary).toContain('shadow mode');
    expect(event?.sealedForensicPayloadRefs).toEqual(items.map(item => item.sourceRef));
    // Provenance is a pointer set, never evidence text.
    expect(event?.sealedForensicPayloadRefs.every(ref => ref.startsWith('turn://'))).toBe(true);

    for (const item of items) {
      expect(store.pinnedCaseIdFor(item.evidenceId)).toBe(event?.caseId);
    }
  });

  it('keeps the case out of the companion context and in the operator view', async () => {
    const { lane, readEvents } = buildLane({
      items: blindReviewTestEvidenceRange(4),
      finding: CONCERNED_FINDING,
    });
    await lane.runOnce();
    const events = readEvents();
    expect(listAgentVisibleCogSecEvents(events)).toEqual([]);
    expect(listOperatorVisibleCogSecEvents(events)).toHaveLength(1);
  });

  it('does not alert below the owner-file confidence floor', async () => {
    const { lane, readEvents } = buildLane({
      items: blindReviewTestEvidenceRange(4),
      finding: { ...CONCERNED_FINDING, confidence: 0.1 },
    });
    const result = await lane.runOnce();
    expect(result.batches).toEqual([{ kind: 'clean' }]);
    expect(readEvents()).toEqual([]);
  });

  it('reports a duplicate rather than a second alert for the same batch', async () => {
    const items = blindReviewTestEvidenceRange(4);
    const store = new InMemoryBlindReviewStore();
    const first = buildLane({ items, finding: CONCERNED_FINDING, store });
    await first.lane.runOnce();
    // Same evidence, same digest, re-offered to a lane whose state was reset:
    // the deterministic case id must collapse to one case.
    await store.writeState({
      ingestedThroughMs: 0,
      lastBatchDigest: null,
      reviewAttempt: 0,
      retryNotBeforeMs: 0,
      updatedAtMs: NOW_MS,
    });
    const replayStore = new InMemoryBlindReviewStore();
    await replayStore.appendEvidence(items, NOW_MS);
    const second = new BlindReviewLane({
      config: first.config,
      store: replayStore,
      source: { listEvidence: async () => [] },
      reviewer: { review: async () => CONCERNED_FINDING },
      readMode: () => 'strict',
      cogSecEvents: () => new CogSecEventStore(first.eventsPath),
      now: () => NOW_MS,
    });
    const result = await second.runOnce();
    expect(result.batches[0]).toMatchObject({ kind: 'duplicate' });
    expect(first.readEvents()).toHaveLength(1);
  });

  it('still alerts when the reviewer wording trips the CogSec safe-text filter', async () => {
    const { lane, readEvents } = buildLane({
      items: blindReviewTestEvidenceRange(4),
      finding: { ...CONCERNED_FINDING, safeSummary: 'Pattern resembles a sandbox bypass attempt.' },
    });
    const result = await lane.runOnce();
    expect(result.batches[0]).toMatchObject({ kind: 'alerted' });
    const [event] = readEvents();
    expect(event?.safeAgentSummary).not.toContain('bypass');
    expect(event?.safeAgentSummary).toContain('high concern');
  });

  it('writes nothing to the CogSec store on a clean review', async () => {
    const { lane, eventsPath } = buildLane({ items: blindReviewTestEvidenceRange(4) });
    await lane.runOnce();
    expect(() => readFileSync(eventsPath, 'utf8')).toThrow();
  });
});
