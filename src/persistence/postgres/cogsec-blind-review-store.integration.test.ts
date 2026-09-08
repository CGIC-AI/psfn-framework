// Real-Postgres proof of the Blind Reviewer's durable half. The acceptance
// criteria this file owns are the ones that only mean something against a real
// database and a real restart: restart recovery, backpressure on a bounded
// rolling window, retention expiry, and pinning that holds alert evidence past
// the retention clock. Mode independence is asserted end-to-end here too, so
// the durable outcome — not only the in-memory control flow — is proven equal
// across all three CogSec modes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresCogSecBlindReviewStore } from './cogsec-blind-review-store.js';
import { POSTGRES_COGSEC_BLIND_REVIEW_MIGRATIONS } from './migrations.js';
import { BlindReviewLane } from '../../core/cogsec/blind-review/lane.js';
import {
  blindReviewTestConfig,
  blindReviewTestEvidence,
  blindReviewTestEvidenceRange,
} from '../../core/cogsec/blind-review/blind-review.test-support.js';
import { BLIND_REVIEW_PROCESSOR } from '../../core/cogsec/blind-review/contracts.js';
import type {
  BlindReviewEvidenceItem,
  BlindReviewFinding,
} from '../../core/cogsec/blind-review/contracts.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { COGSEC_MODES, type CogSecMode } from '../../shared/contracts/cogsec-mode.js';
import { resolveCogSecEventsPath } from '../layout.js';
import { createPostgresPool } from '../postgres.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_cogsec_blind_review';
// Just after the fixture evidence timestamps, so retention keeps fixture rows
// until a test deliberately advances the clock past the window.
const NOW_MS = 1_700_000_100_000;
const RETENTION_MS = 604_800_000;

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

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  const { databaseUrl } = await harness.createDatabase();
  const bootstrap = createPostgresPool(databaseUrl, {
    applicationName: 'cogsec-blind-review-bootstrap',
    allowExitOnIdle: true,
  });
  await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
  await bootstrap.end();
  return databaseUrl;
}

function laneOver(options: {
  store: PostgresCogSecBlindReviewStore;
  items: BlindReviewEvidenceItem[];
  finding: BlindReviewFinding;
  eventsRoot: string;
  mode?: CogSecMode;
  nowMs?: number;
  config?: ReturnType<typeof blindReviewTestConfig>;
}) {
  const review = vi.fn(async () => options.finding);
  const listEvidence = vi.fn(async (input: { sinceMs: number }) => (
    options.items.filter(item => item.occurredAtMs > input.sinceMs)
  ));
  const lane = new BlindReviewLane({
    config: options.config ?? blindReviewTestConfig({
      batch: { maxItemsPerBatch: 4, minItemsPerBatch: 2, minBlindedCharsPerBatch: 0 },
      cost: { maxReviewsPerRun: 1 },
      window: { retentionMs: RETENTION_MS },
    }),
    store: options.store,
    source: { listEvidence },
    reviewer: { review },
    readMode: () => options.mode ?? 'boundary',
    cogSecEvents: () => new CogSecEventStore(resolveCogSecEventsPath(options.eventsRoot)),
    now: () => options.nowMs ?? NOW_MS,
  });
  return { lane, review, listEvidence };
}

describe('PostgresCogSecBlindReviewStore', () => {
  it('resumes after a restart without re-paying for evidence it already reviewed', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const eventsRoot = mkdtempSync(join(tmpdir(), 'psfn-blind-review-restart-'));
    const items = blindReviewTestEvidenceRange(4);
    let store = await PostgresCogSecBlindReviewStore.connect(databaseUrl, { schema: SCHEMA });
    let firstDigest: string | null;
    try {
      const first = laneOver({ store, items, finding: CLEAN_FINDING, eventsRoot });
      const result = await first.lane.runOnce();
      expect(result.ingested).toBe(4);
      expect(result.modelCalls).toBe(1);
      expect(first.review).toHaveBeenCalledTimes(1);
      const state = await store.readState();
      firstDigest = state.lastBatchDigest;
      expect(firstDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(state.ingestedThroughMs).toBe(items[items.length - 1]?.occurredAtMs);
    } finally {
      await store.close();
    }

    // Restart: a new process, a new pool, the same durable window.
    store = await PostgresCogSecBlindReviewStore.connect(databaseUrl, { schema: SCHEMA });
    try {
      const recovered = await store.readState();
      expect(recovered.lastBatchDigest).toBe(firstDigest);
      const second = laneOver({ store, items, finding: CLEAN_FINDING, eventsRoot });
      const result = await second.lane.runOnce();
      expect(second.review).not.toHaveBeenCalled();
      expect(result.modelCalls).toBe(0);
      expect(result.batches).toEqual([{ kind: 'skipped', reason: 'no_evidence' }]);
      // Ingest is idempotent on evidence identity: no duplicate rows appeared.
      expect(await store.countRows()).toEqual({ total: 4, pinned: 0, unreviewed: 0 });
    } finally {
      await store.close();
      rmSync(eventsRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('holds the rolling window at its bound under sustained ingest without blocking the source', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const eventsRoot = mkdtempSync(join(tmpdir(), 'psfn-blind-review-backpressure-'));
    const store = await PostgresCogSecBlindReviewStore.connect(databaseUrl, { schema: SCHEMA });
    const config = blindReviewTestConfig({
      root: { maxIngestPerRun: 40 },
      batch: { maxItemsPerBatch: 4, minItemsPerBatch: 2, minBlindedCharsPerBatch: 0 },
      cost: { maxReviewsPerRun: 1 },
      window: { maxRows: 20, retentionMs: RETENTION_MS },
    });
    try {
      const first = laneOver({
        store,
        items: blindReviewTestEvidenceRange(40),
        finding: CLEAN_FINDING,
        eventsRoot,
        config,
      });
      const firstResult = await first.lane.runOnce();
      expect(firstResult.ingested).toBe(40);
      expect(firstResult.evicted).toBeGreaterThan(0);
      expect(firstResult.window.total).toBeLessThanOrEqual(20);

      const second = laneOver({
        store,
        items: blindReviewTestEvidenceRange(40, 41),
        finding: CLEAN_FINDING,
        eventsRoot,
        config,
      });
      const secondResult = await second.lane.runOnce();
      expect(secondResult.window.total).toBeLessThanOrEqual(20);
      // The source is polled, never pushed: exactly one read per pass, and it
      // was never asked to wait on the window.
      expect(first.listEvidence).toHaveBeenCalledTimes(1);
      expect(second.listEvidence).toHaveBeenCalledTimes(1);
      // The watermark still advanced past the newest evidence the run saw.
      const state = await store.readState();
      expect(state.ingestedThroughMs).toBe(blindReviewTestEvidence(80).occurredAtMs);
    } finally {
      await store.close();
      rmSync(eventsRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('expires unpinned evidence on the retention clock and keeps pinned evidence past it', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const eventsRoot = mkdtempSync(join(tmpdir(), 'psfn-blind-review-retention-'));
    const store = await PostgresCogSecBlindReviewStore.connect(databaseUrl, { schema: SCHEMA });
    const alerting = blindReviewTestEvidenceRange(4);
    try {
      const alerted = laneOver({ store, items: alerting, finding: CONCERNED_FINDING, eventsRoot });
      const result = await alerted.lane.runOnce();
      const [outcome] = result.batches;
      expect(outcome).toMatchObject({ kind: 'alerted', pinned: 4 });
      const caseId = outcome && outcome.kind === 'alerted' ? outcome.caseId : '';
      expect(caseId).toMatch(/^cogsec_blindreview_[a-f0-9]{32}$/u);

      // Unpinned evidence arrives afterwards.
      const ordinary = blindReviewTestEvidenceRange(4, 100);
      await store.appendEvidence(ordinary, NOW_MS);
      expect(await store.countRows()).toMatchObject({ total: 8, pinned: 4 });

      // Advance well past the retention window — far enough that every one of
      // the newer unpinned rows is also outside it: only the unpinned rows go.
      const pruned = await store.prune({
        nowMs: NOW_MS + RETENTION_MS + 60_000,
        retentionMs: RETENTION_MS,
        maxRows: 1_000,
      });
      expect(pruned.expired).toBe(4);
      expect(pruned.evicted).toBe(0);
      expect(await store.countRows()).toMatchObject({ total: 4, pinned: 4 });

      // The pinned rows are exactly the ones the operator alert points at, and
      // the case itself carries their provenance refs.
      const events = new CogSecEventStore(resolveCogSecEventsPath(eventsRoot)).listEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.caseId).toBe(caseId);
      expect(events[0]?.actions).toEqual([]);
      expect(events[0]?.sealedForensicPayloadRefs)
        .toEqual(alerting.map(item => item.sourceRef));
    } finally {
      await store.close();
      rmSync(eventsRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('refuses pins beyond the owner-file ceiling instead of unpinning older evidence', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const store = await PostgresCogSecBlindReviewStore.connect(databaseUrl, { schema: SCHEMA });
    try {
      const items = blindReviewTestEvidenceRange(6);
      await store.appendEvidence(items, NOW_MS);
      const first = await store.pinEvidence({
        evidenceIds: items.slice(0, 3).map(item => item.evidenceId),
        caseId: 'cogsec_blindreview_first',
        pinnedAtMs: NOW_MS,
        maxPinnedRows: 4,
      });
      expect(first).toEqual({ pinned: 3, refused: 0 });
      const second = await store.pinEvidence({
        evidenceIds: items.slice(3).map(item => item.evidenceId),
        caseId: 'cogsec_blindreview_second',
        pinnedAtMs: NOW_MS,
        maxPinnedRows: 4,
      });
      expect(second).toEqual({ pinned: 1, refused: 2 });
      expect(await store.countRows()).toMatchObject({ pinned: 4 });
    } finally {
      await store.close();
    }
  }, TIMEOUT_MS);

  it('produces the same durable outcome in every CogSec mode', async () => {
    const observed: { mode: CogSecMode; rows: unknown; digest: string | null }[] = [];
    for (const mode of COGSEC_MODES) {
      const databaseUrl = await freshDatabaseUrl();
      const eventsRoot = mkdtempSync(join(tmpdir(), `psfn-blind-review-${mode}-`));
      const store = await PostgresCogSecBlindReviewStore.connect(databaseUrl, { schema: SCHEMA });
      try {
        const { lane } = laneOver({
          store,
          items: blindReviewTestEvidenceRange(4),
          finding: CONCERNED_FINDING,
          eventsRoot,
          mode,
        });
        const result = await lane.runOnce();
        expect(result.mode).toBe(mode);
        expect(result.batches[0]).toMatchObject({ kind: 'alerted', pinned: 4 });
        const state = await store.readState();
        observed.push({ mode, rows: await store.countRows(), digest: state.lastBatchDigest });
      } finally {
        await store.close();
        rmSync(eventsRoot, { recursive: true, force: true });
      }
    }
    const [first, ...rest] = observed;
    expect(first).toBeDefined();
    for (const entry of rest) {
      expect(entry.rows).toEqual(first?.rows);
      expect(entry.digest).toBe(first?.digest);
    }
  }, TIMEOUT_MS);

  it('fails closed on a row whose stored shape no longer matches the contract', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'cogsec-blind-review-corruption',
      allowExitOnIdle: true,
      schema: SCHEMA,
    });
    const store = await PostgresCogSecBlindReviewStore.fromPool(pool);
    try {
      const [item] = blindReviewTestEvidenceRange(1);
      if (!item) throw new Error('fixture evidence is required');
      await store.appendEvidence([item], NOW_MS);
      await pool.query(
        'UPDATE cogsec_blind_review_evidence SET activity_json = $1::jsonb WHERE evidence_id = $2',
        [JSON.stringify({ toolCallCount: 'many' }), item.evidenceId],
      );
      await expect(store.listUnreviewed(10)).rejects.toThrow(/activity/u);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('rejects a structural-only row that carries text at the database boundary', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'cogsec-blind-review-constraint',
      allowExitOnIdle: true,
      schema: SCHEMA,
    });
    const store = await PostgresCogSecBlindReviewStore.fromPool(pool);
    try {
      const [item] = blindReviewTestEvidenceRange(1);
      if (!item) throw new Error('fixture evidence is required');
      await expect(store.appendEvidence(
        [{ ...item, disclosure: 'structural_only', blindedExcerpt: 'leaked private text' }],
        NOW_MS,
      )).rejects.toThrow();
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);
});


// ── Gate savings counter, migration and round trip (bead psfn-framework-33xah) ──
//
// The claim this block owns is the one a fresh-schema test cannot make: an
// EXISTING deployment, with lane state already in its columnar row, gains the
// counter in place — no backfill, no rewritten history, no lost watermark — and
// the counter then survives the whole-row `writeState` the lane performs every
// pass, plus a restart.
describe('cogsec_blind_review_state gate-savings counter', () => {
  it('upgrades a populated pre-counter table in place and round-trips the increment', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'cogsec-blind-review-upgrade',
      allowExitOnIdle: true,
      schema: SCHEMA,
    });
    try {
      // The schema as it stood before this bead: every statement in the chain
      // except the ones this bead appended.
      const preCounter = POSTGRES_COGSEC_BLIND_REVIEW_MIGRATIONS.filter(statement => (
        !statement.includes('model_calls_avoided')
      ));
      expect(preCounter.length).toBeLessThan(POSTGRES_COGSEC_BLIND_REVIEW_MIGRATIONS.length);
      for (const statement of preCounter) await pool.query(statement);
      await pool.query(`
        INSERT INTO cogsec_blind_review_state (
          processor, ingested_through_ms, last_batch_digest,
          review_attempt, retry_not_before_ms, updated_at_ms
        ) VALUES ($1, $2, NULL, 2, $3, $4)
      `, [BLIND_REVIEW_PROCESSOR, 1_700_000_000_000, 1_700_000_050_000, 1_700_000_060_000]);
      await expect(
        pool.query('SELECT model_calls_avoided FROM cogsec_blind_review_state'),
      ).rejects.toThrow();

      // The full chain over the populated old table: this is the upgrade.
      const store = await PostgresCogSecBlindReviewStore.fromPool(pool);
      expect(await store.readModelCallsAvoided())
        .toEqual({ modelCallsAvoided: 0, lastAvoidedAtMs: 0 });
      // Nothing the old row carried was disturbed.
      expect(await store.readState()).toEqual({
        ingestedThroughMs: 1_700_000_000_000,
        lastBatchDigest: null,
        reviewAttempt: 2,
        retryNotBeforeMs: 1_700_000_050_000,
        updatedAtMs: 1_700_000_060_000,
      });

      // Additive increments, then the whole-row state write the lane performs
      // every pass, which must not be able to reach the counter.
      await store.recordModelCallsAvoided(2, NOW_MS);
      await store.recordModelCallsAvoided(3, NOW_MS + 1_000);
      expect(await store.readModelCallsAvoided())
        .toEqual({ modelCallsAvoided: 5, lastAvoidedAtMs: NOW_MS + 1_000 });
      await store.writeState({
        ingestedThroughMs: NOW_MS,
        lastBatchDigest: null,
        reviewAttempt: 0,
        retryNotBeforeMs: 0,
        updatedAtMs: NOW_MS,
      });
      expect(await store.readModelCallsAvoided())
        .toEqual({ modelCallsAvoided: 5, lastAvoidedAtMs: NOW_MS + 1_000 });

      // Re-running the chain is idempotent: the constraints are dropped by name
      // and re-added, so a second startup neither errors nor resets anything.
      await PostgresCogSecBlindReviewStore.fromPool(pool);
      expect((await store.readModelCallsAvoided()).modelCallsAvoided).toBe(5);

      // The floor lives in the database, not only in TypeScript.
      await expect(pool.query(
        'UPDATE cogsec_blind_review_state SET model_calls_avoided = -1 WHERE processor = $1',
        [BLIND_REVIEW_PROCESSOR],
      )).rejects.toThrow();
      await expect(pool.query(
        'UPDATE cogsec_blind_review_state SET model_calls_avoided = 0 WHERE processor = $1',
        [BLIND_REVIEW_PROCESSOR],
      )).rejects.toThrow();
      await expect(store.recordModelCallsAvoided(0, NOW_MS)).rejects.toThrow(/positive integer/u);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('accumulates gate refusals across real lane passes and a restart', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const eventsRoot = mkdtempSync(join(tmpdir(), 'psfn-blind-review-savings-'));
    // One row against a floor of two: every pass refuses the batch, so every
    // pass is one model call the gate did not make.
    const items = blindReviewTestEvidenceRange(1);
    let store = await PostgresCogSecBlindReviewStore.connect(databaseUrl, { schema: SCHEMA });
    try {
      const first = laneOver({ store, items, finding: CLEAN_FINDING, eventsRoot });
      const result = await first.lane.runOnce();
      expect(first.review).not.toHaveBeenCalled();
      expect(result.modelCalls).toBe(0);
      expect(result.modelCallsAvoided).toBe(1);
      expect(result.batches).toEqual([{ kind: 'skipped', reason: 'undersized_items' }]);
      expect(await store.readModelCallsAvoided())
        .toEqual({ modelCallsAvoided: 1, lastAvoidedAtMs: NOW_MS });
    } finally {
      await store.close();
    }

    // Restart: a new process and a new pool over the same durable window. A
    // cumulative counter that reset here would be a per-process gauge.
    store = await PostgresCogSecBlindReviewStore.connect(databaseUrl, { schema: SCHEMA });
    try {
      expect((await store.readModelCallsAvoided()).modelCallsAvoided).toBe(1);
      const second = laneOver({
        store,
        items,
        finding: CLEAN_FINDING,
        eventsRoot,
        nowMs: NOW_MS + 5_000,
      });
      const result = await second.lane.runOnce();
      expect(result.modelCallsAvoided).toBe(1);
      expect(await store.readModelCallsAvoided())
        .toEqual({ modelCallsAvoided: 2, lastAvoidedAtMs: NOW_MS + 5_000 });
    } finally {
      await store.close();
      rmSync(eventsRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
