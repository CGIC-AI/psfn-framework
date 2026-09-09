import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresHumanEscalationStore } from './human-escalation-store.js';
import {
  createHumanEscalationControlPlane,
  type HumanEscalationRoutingPolicy,
} from '../../shared/escalation/control-plane.js';
import type {
  HumanEscalationFacts,
  HumanEscalationLedgerBounds,
  HumanEscalationLedgerSaturation,
} from '../../shared/escalation/contracts.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const NOW_MS = 1_800_000_000_000;
const DAY_MS = 86_400_000;

const BOUNDS: HumanEscalationLedgerBounds = {
  resolvedRetentionMs: 7 * DAY_MS,
  maxResolvedRowsPerKind: 3,
  maxAttemptsPerEscalation: 2,
  maxOpenRowsPerKind: 2,
};

const GARDEN_ONLY_ROUTING: HumanEscalationRoutingPolicy = {
  runtime_incident: { sink: 'garden_only', cooldownMs: 0 },
  operator_confirmation: { sink: 'garden_only', cooldownMs: 0 },
  cogsec_quarantine: { sink: 'garden_only', cooldownMs: 0 },
};

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

function facts(overrides: Partial<HumanEscalationFacts> = {}): HumanEscalationFacts {
  return {
    kind: 'cogsec_quarantine',
    severity: 'degraded',
    owner: { kind: 'system' },
    dedupeKey: 'condition-1',
    sourceRef: 'ref-1',
    labels: ['quarantine'],
    evidence: { attemptCount: 1 },
    detailPath: '/cogsec',
    raisedAtMs: NOW_MS,
    ...overrides,
  };
}

async function withStore<T>(
  run: (input: {
    pool: Pool;
    store: PostgresHumanEscalationStore;
    saturations: HumanEscalationLedgerSaturation[];
    setNow: (value: number) => void;
  }) => Promise<T>,
  bounds: HumanEscalationLedgerBounds = BOUNDS,
): Promise<T> {
  if (!harness) throw new Error('postgres harness not started');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'human-escalation-store-test',
    allowExitOnIdle: true,
  });
  try {
    const saturations: HumanEscalationLedgerSaturation[] = [];
    let nowMs = NOW_MS;
    const store = await PostgresHumanEscalationStore.fromPool(pool, {
      bounds,
      onSaturated: saturation => saturations.push(saturation),
      now: () => nowMs,
    });
    return await run({
      pool,
      store,
      saturations,
      setNow: (value: number) => { nowMs = value; },
    });
  } finally {
    await pool.end();
  }
}

async function countRows(pool: Pool, table: string): Promise<number> {
  const result = await pool.query<{ total: string }>(`SELECT COUNT(*)::bigint AS total FROM ${table}`);
  return Number(result.rows.at(0)?.total ?? '0');
}

describe('PostgresHumanEscalationStore bounds', () => {
  it('refuses to open a ledger without a declared owner-file bound', async () => {
    if (!harness) throw new Error('postgres harness not started');
    const database = await harness.createDatabase();
    const pool = createPostgresPool(database.databaseUrl, {
      applicationName: 'human-escalation-store-unbounded-test',
      allowExitOnIdle: true,
    });
    try {
      await expect(PostgresHumanEscalationStore.fromPool(pool, {
        bounds: { ...BOUNDS, maxResolvedRowsPerKind: 0 },
      })).rejects.toThrow(/positive owner-file maxResolvedRowsPerKind/);
    } finally {
      await pool.end();
    }
  });

  it('never evicts an open escalation, however far past every bound the ledger runs', async () => {
    await withStore(async ({ pool, store, setNow }) => {
      const openIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const record = await store.openOrReopen(facts({
          dedupeKey: `open-${String(index)}`,
          sourceRef: `ref-${String(index)}`,
        }));
        openIds.push(record.escalationId);
      }
      // Far past both the per-kind resolved cap and the retention window.
      setNow(NOW_MS + 400 * DAY_MS);
      await store.openOrReopen(facts({ dedupeKey: 'open-tail', sourceRef: 'ref-tail' }));

      const counts = await store.countByState();
      expect(counts.open).toBe(7);
      for (const escalationId of openIds) {
        expect(await store.getById(escalationId)).not.toBeNull();
      }
      expect(await countRows(pool, 'human_escalations')).toBe(7);
    });
  });

  it('evicts answered rows past the per-kind cap, newest kept', async () => {
    await withStore(async ({ store }) => {
      const resolvedIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const record = await store.openOrReopen(facts({
          dedupeKey: `answered-${String(index)}`,
          sourceRef: `ref-${String(index)}`,
          raisedAtMs: NOW_MS + index,
        }));
        const resolved = await store.applyResolution({
          escalationId: record.escalationId,
          expectedState: 'open',
          resolution: {
            state: 'resolved',
            reason: 'handled',
            actor: 'operator',
            resolvedAtMs: NOW_MS + index,
          },
        });
        expect(resolved).not.toBeNull();
        resolvedIds.push(record.escalationId);
      }

      const counts = await store.countByState();
      expect(counts.resolved).toBe(BOUNDS.maxResolvedRowsPerKind);
      // The three newest survive; the two oldest were evicted.
      expect(await store.getById(resolvedIds[0]!)).toBeNull();
      expect(await store.getById(resolvedIds[1]!)).toBeNull();
      expect(await store.getById(resolvedIds[4]!)).not.toBeNull();
    });
  });

  it('expires answered rows past the owner-file retention window', async () => {
    await withStore(async ({ store, setNow }) => {
      const aged = await store.openOrReopen(facts({ dedupeKey: 'aged', sourceRef: 'ref-aged' }));
      await store.applyResolution({
        escalationId: aged.escalationId,
        expectedState: 'open',
        resolution: {
          state: 'dismissed',
          reason: 'expected',
          actor: 'operator',
          resolvedAtMs: NOW_MS,
        },
      });
      expect(await store.getById(aged.escalationId)).not.toBeNull();

      setNow(NOW_MS + BOUNDS.resolvedRetentionMs + 1);
      await store.openOrReopen(facts({ dedupeKey: 'fresh', sourceRef: 'ref-fresh' }));

      expect(await store.getById(aged.escalationId)).toBeNull();
    });
  });

  it('bounds the delivery-attempt ledger per escalation, newest kept', async () => {
    await withStore(async ({ pool, store }) => {
      const record = await store.openOrReopen(facts({ dedupeKey: 'attempts' }));
      for (let index = 0; index < 5; index += 1) {
        const claim = await store.claimAttempt({
          idempotencyKey: `attempts.${String(index)}`,
          escalationId: record.escalationId,
          sink: 'garden_only',
          outcome: 'recorded',
          attemptedAtMs: NOW_MS + index,
        });
        expect(claim.claimed).toBe(true);
      }

      expect(await countRows(pool, 'human_escalation_attempts'))
        .toBe(BOUNDS.maxAttemptsPerEscalation);
      expect(await store.findAttempt('attempts.4')).not.toBeNull();
      expect(await store.findAttempt('attempts.0')).toBeNull();
    });
  });

  it('never evicts an attempt whose sink call is still out, and converges once it settles',
    async () => {
      await withStore(async ({ pool, store }) => {
        const record = await store.openOrReopen(facts({ dedupeKey: 'burst' }));
        // A burst: three raises about one condition, each claiming before it
        // dispatches and none settled yet. The ring used to exclude only the
        // key being claimed, so the third claim evicted the first caller's row
        // while that caller's sink call was still out — and its settle then
        // failed with "not in the ledger", losing the record of a page that had
        // already reached a human (psfn-framework-2xt9c).
        for (let index = 0; index < 3; index += 1) {
          const claim = await store.claimAttempt({
            idempotencyKey: `burst.${String(index)}`,
            escalationId: record.escalationId,
            sink: 'operator_alert',
            outcome: 'delivery_failed',
            attemptedAtMs: NOW_MS + index,
          }, { awaitingSettlement: true });
          expect(claim.claimed).toBe(true);
        }

        // Above the cap on purpose: overshooting a bound is recoverable,
        // deleting the record of a delivered page is not.
        expect(await countRows(pool, 'human_escalation_attempts')).toBe(3);

        // Every one of the three sinks answers, and not one settle throws.
        for (let index = 0; index < 3; index += 1) {
          await expect(store.settleAttempt({
            idempotencyKey: `burst.${String(index)}`,
            expectedOutcome: 'delivery_failed',
            outcome: 'delivered',
          })).resolves.toBeUndefined();
        }

        // Settled rows are ordinary ring candidates again, so the next claim
        // brings the ledger back to the owner-file cap.
        await store.claimAttempt({
          idempotencyKey: 'burst.3',
          escalationId: record.escalationId,
          sink: 'operator_alert',
          outcome: 'recorded',
          attemptedAtMs: NOW_MS + 3,
        });
        expect(await countRows(pool, 'human_escalation_attempts'))
          .toBe(BOUNDS.maxAttemptsPerEscalation);
        expect(await store.findAttempt('burst.3')).not.toBeNull();
      });
    });

  it('holds the ring exactly for a caller that settles nothing', async () => {
    await withStore(async ({ pool, store }) => {
      const record = await store.openOrReopen(facts({ dedupeKey: 'terminal' }));
      // A `garden_only` route claims a TERMINAL outcome and never settles, so
      // its rows stay ordinary eviction candidates — the in-flight exemption
      // must not become a way to grow the ledger without bound.
      for (let index = 0; index < 5; index += 1) {
        await store.claimAttempt({
          idempotencyKey: `terminal.${String(index)}`,
          escalationId: record.escalationId,
          sink: 'garden_only',
          outcome: 'recorded',
          attemptedAtMs: NOW_MS + index,
        });
      }

      expect(await countRows(pool, 'human_escalation_attempts'))
        .toBe(BOUNDS.maxAttemptsPerEscalation);
    });
  });

  it('reports content-free saturation once the open half reaches its cap', async () => {
    await withStore(async ({ store, saturations }) => {
      await store.openOrReopen(facts({ dedupeKey: 'saturating-1' }));
      expect(saturations).toEqual([]);
      await store.openOrReopen(facts({ dedupeKey: 'saturating-2' }));

      expect(saturations).toEqual([{
        kind: 'cogsec_quarantine',
        openRows: 2,
        maxOpenRowsPerKind: 2,
      }]);
    });
  });

  it('keeps a sinkless crash loop to one open row when the condition id is stable', async () => {
    await withStore(async ({ pool, store }) => {
      const plane = createHumanEscalationControlPlane({
        ledger: store,
        routing: () => GARDEN_ONLY_ROUTING,
        sinks: [],
      });
      // Every "boot" restates the same condition under the same boot-independent
      // dedupe key, and mints its attempt key from the ledger's own raise count
      // rather than from process-local state.
      for (let boot = 0; boot < 25; boot += 1) {
        const dedupeKey = 'operator-alert-sinks-unconfigured';
        const raiseCount = await plane.raiseCount('runtime_incident', dedupeKey);
        const result = await plane.raise({
          kind: 'runtime_incident',
          severity: 'critical',
          owner: { kind: 'system' },
          dedupeKey,
          idempotencyKey: `${dedupeKey}.${String(raiseCount + 1)}`,
          sourceRef: dedupeKey,
          labels: ['operator_alerting'],
          evidence: { configuredSinkCount: 0 },
          detailPath: '/incidents',
          raisedAtMs: NOW_MS + boot,
          notice: null,
        });
        expect(result.status).toBe('recorded');
      }

      const counts = await store.countByState();
      expect(counts.open).toBe(1);
      expect(await countRows(pool, 'human_escalations')).toBe(1);
      // The attempt ledger a 25-cycle crash loop wrote is bounded too.
      expect(await countRows(pool, 'human_escalation_attempts'))
        .toBe(BOUNDS.maxAttemptsPerEscalation);
    });
  });

  it('ranks the answered ring by answer time, so a long-open row survives being answered', async () => {
    await withStore(async ({ store }) => {
      // Raised FIRST and left open while everything else came and went, so it
      // is the oldest row in the table by raise time and the newest by answer
      // time. Ranking the ring by raise time would evict it in the very
      // statement that recorded the operator's decision.
      const longOpen = await store.openOrReopen(facts({
        dedupeKey: 'long-open',
        sourceRef: 'ref-long-open',
        raisedAtMs: NOW_MS,
      }));
      for (let index = 0; index < 3; index += 1) {
        const record = await store.openOrReopen(facts({
          dedupeKey: `later-${String(index)}`,
          sourceRef: `ref-later-${String(index)}`,
          raisedAtMs: NOW_MS + 1_000 + index,
        }));
        await store.applyResolution({
          escalationId: record.escalationId,
          expectedState: 'open',
          resolution: {
            state: 'resolved',
            reason: 'handled',
            actor: 'operator',
            resolvedAtMs: NOW_MS + 2_000 + index,
          },
        });
      }

      const answered = await store.applyResolution({
        escalationId: longOpen.escalationId,
        expectedState: 'open',
        resolution: {
          state: 'resolved',
          reason: 'handled',
          actor: 'operator',
          resolvedAtMs: NOW_MS + 9_000,
        },
      });

      expect(answered).not.toBeNull();
      // The row the caller was just handed is still there to be read back.
      expect(await store.getById(longOpen.escalationId)).not.toBeNull();
      const counts = await store.countByState();
      expect(counts.resolved).toBe(BOUNDS.maxResolvedRowsPerKind);
    });
  });

  it('refuses a settle whose attempt row already moved on', async () => {
    await withStore(async ({ store }) => {
      const record = await store.openOrReopen(facts({ dedupeKey: 'settle' }));
      await store.claimAttempt({
        idempotencyKey: 'settle.1',
        escalationId: record.escalationId,
        sink: 'operator_alert',
        outcome: 'delivery_failed',
        attemptedAtMs: NOW_MS,
      });
      await store.settleAttempt({
        idempotencyKey: 'settle.1',
        expectedOutcome: 'delivery_failed',
        outcome: 'delivered',
      });

      // The compare-and-set is in the database, so a slow settle from the same
      // provisional claim cannot demote a delivery the ledger already proved.
      await expect(store.settleAttempt({
        idempotencyKey: 'settle.1',
        expectedOutcome: 'delivery_failed',
        outcome: 'unconfigured',
      })).rejects.toThrow(/holds outcome delivered/u);
      expect(await store.findAttempt('settle.1')).toMatchObject({ outcome: 'delivered' });

      await expect(store.settleAttempt({
        idempotencyKey: 'settle.absent',
        expectedOutcome: 'delivery_failed',
        outcome: 'delivered',
      })).rejects.toThrow(/is not in the ledger/u);
    });
  });
});
