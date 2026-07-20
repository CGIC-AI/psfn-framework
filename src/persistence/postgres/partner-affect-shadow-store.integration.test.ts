import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresPartnerAffectShadowStore } from './partner-affect-shadow-store.js';
import type {
  PartnerAffectObservation,
  PartnerAffectSuppressedObservation,
} from '../../shared/contracts/partner-affect.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const PARTNER_ID = 'contact-partner-1';
const NOW_MS = 1_800_000_000_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

function observation(overrides: Partial<PartnerAffectObservation> = {}): PartnerAffectObservation {
  const observedAtMs = overrides.observedAtMs ?? NOW_MS - 60_000;
  const observationId = overrides.observationId ?? 'obs-001';
  const sourceId = overrides.sourceId ?? 'edge-sleep-1';
  return {
    schemaVersion: 1,
    observationKey: `${sourceId}:${observationId}`,
    observationId,
    sourceId,
    partnerContactId: PARTNER_ID,
    signalFamily: 'sleep',
    metricName: 'total_sleep_hours',
    value: 7.4,
    unit: 'hours',
    windowStartMs: observedAtMs - 8 * 60 * 60_000,
    windowEndMs: observedAtMs,
    observedAtMs,
    coverage: 0.9,
    confidence: 0.8,
    missingness: 0.1,
    direction: 'lower_supports_need',
    sensitivity: 'relational_sensitive',
    consentRef: 'consent-sleep-2026-01',
    assertion: 'sensor_summary',
    provenance: [{ source: 'runtime_state', observedAtMs }],
    processingRevision: 'adapter-v3',
    receivedAtMs: NOW_MS,
    ...overrides,
  };
}

function suppression(
  overrides: Partial<PartnerAffectSuppressedObservation> = {},
): PartnerAffectSuppressedObservation {
  return {
    schemaVersion: 1,
    observationKey: 'edge-sleep-1:obs-bad',
    sourceId: 'edge-sleep-1',
    signalFamily: 'sleep',
    partnerContactId: PARTNER_ID,
    reasons: ['wrong_partner'],
    detail: 'observation names a contact other than the bound canonical partner',
    receivedAtMs: NOW_MS,
    ...overrides,
  };
}

async function withDatabase<T>(
  run: (pool: Pool, databaseUrl: string) => Promise<T>,
): Promise<T> {
  if (!harness) throw new Error('postgres harness not started');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'partner-affect-shadow-store-test',
    allowExitOnIdle: true,
  });
  try {
    return await run(pool, database.databaseUrl);
  } finally {
    await pool.end();
  }
}

describe('PostgresPartnerAffectShadowStore', () => {
  it('inserts idempotently on (sourceId, observationId) and reports replays', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresPartnerAffectShadowStore.fromPool(pool);
      const first = await store.recordAccepted(observation());
      expect(first.inserted).toBe(true);
      const replay = await store.recordAccepted(observation({ value: 9.9 }));
      expect(replay.inserted).toBe(false);

      const rows = await store.listAccepted({ partnerContactId: PARTNER_ID });
      expect(rows).toHaveLength(1);
      // First accepted record stays authoritative for the same key.
      expect(rows[0].value).toBe(7.4);
      expect(rows[0].provenance).toEqual([{ source: 'runtime_state', observedAtMs: NOW_MS - 60_000 }]);
      await store.close();
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('scopes reads to exactly one partner contact and orders newest first', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresPartnerAffectShadowStore.fromPool(pool);
      await store.recordAccepted(observation({ observationId: 'a', observedAtMs: NOW_MS - 3_000 }));
      await store.recordAccepted(observation({ observationId: 'b', observedAtMs: NOW_MS - 1_000 }));
      await store.recordAccepted(observation({
        observationId: 'c',
        partnerContactId: 'contact-housemate-2',
        observedAtMs: NOW_MS - 500,
      }));

      const rows = await store.listAccepted({ partnerContactId: PARTNER_ID });
      expect(rows.map(row => row.observationId)).toEqual(['b', 'a']);
      // No cross-contact leakage in either direction.
      expect(rows.every(row => row.partnerContactId === PARTNER_ID)).toBe(true);
      const other = await store.listAccepted({ partnerContactId: 'contact-housemate-2' });
      expect(other.map(row => row.observationId)).toEqual(['c']);

      const since = await store.listAccepted({
        partnerContactId: PARTNER_ID,
        sinceMs: NOW_MS - 2_000,
      });
      expect(since.map(row => row.observationId)).toEqual(['b']);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('persists suppression audit records and rejects empty reason sets', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresPartnerAffectShadowStore.fromPool(pool);
      await store.recordSuppressed(suppression());
      await store.recordSuppressed(suppression({
        observationKey: null,
        sourceId: null,
        signalFamily: null,
        reasons: ['missing_authenticated_origin'],
        receivedAtMs: NOW_MS + 1_000,
      }));
      const rows = await store.listSuppressed();
      expect(rows).toHaveLength(2);
      expect(rows[0].reasons).toEqual(['missing_authenticated_origin']);
      expect(rows[1].reasons).toEqual(['wrong_partner']);
      await expect(store.recordSuppressed(suppression({ reasons: [] }))).rejects.toThrow(/reason/);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('scopes the suppression audit to the bound partner and excludes prior-binding rows', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresPartnerAffectShadowStore.fromPool(pool);
      // Rows recorded under the current binding, a different binding, and while
      // unbound (null partner) all coexist in the table.
      await store.recordSuppressed(suppression({ partnerContactId: PARTNER_ID }));
      await store.recordSuppressed(suppression({ partnerContactId: 'contact-previous-partner' }));
      await store.recordSuppressed(suppression({
        partnerContactId: null,
        observationKey: null,
        sourceId: null,
        signalFamily: null,
        reasons: ['missing_authenticated_origin'],
      }));

      const scoped = await store.listSuppressed({ partnerContactId: PARTNER_ID });
      expect(scoped).toHaveLength(1);
      expect(scoped[0].partnerContactId).toBe(PARTNER_ID);

      // A re-bind to the previous partner never surfaces this partner's rows.
      const other = await store.listSuppressed({ partnerContactId: 'contact-previous-partner' });
      expect(other.map(row => row.partnerContactId)).toEqual(['contact-previous-partner']);

      // The unscoped audit still returns everything for operator diagnostics.
      expect(await store.listSuppressed()).toHaveLength(3);

      await expect(store.listSuppressed({ partnerContactId: '  ' })).rejects.toThrow(/partnerContactId/);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('survives restart: a fresh store instance over the same database reads prior rows', async () => {
    await withDatabase(async (pool, databaseUrl) => {
      const first = await PostgresPartnerAffectShadowStore.fromPool(pool);
      await first.recordAccepted(observation());
      await first.close();

      const reopened = await PostgresPartnerAffectShadowStore.connect(databaseUrl);
      try {
        const rows = await reopened.listAccepted({ partnerContactId: PARTNER_ID });
        expect(rows).toHaveLength(1);
        expect(rows[0].observationKey).toBe('edge-sleep-1:obs-001');
      } finally {
        await reopened.close();
      }
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('prunes both tables to the retention cap, oldest first', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresPartnerAffectShadowStore.fromPool(pool);
      for (let index = 0; index < 5; index += 1) {
        await store.recordAccepted(observation({
          observationId: `obs-${String(index)}`,
          observedAtMs: NOW_MS - (5 - index) * 1_000,
        }));
        await store.recordSuppressed(suppression({ receivedAtMs: NOW_MS + index }));
      }
      const removed = await store.pruneToRetentionCap(2);
      expect(removed).toBe(6);
      const rows = await store.listAccepted({ partnerContactId: PARTNER_ID });
      expect(rows.map(row => row.observationId)).toEqual(['obs-4', 'obs-3']);
      expect(await store.listSuppressed()).toHaveLength(2);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('rejects unbounded or invalid list limits', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresPartnerAffectShadowStore.fromPool(pool);
      await expect(store.listAccepted({ partnerContactId: PARTNER_ID, limit: 0 }))
        .rejects.toThrow(/limit/);
      await expect(store.listAccepted({ partnerContactId: PARTNER_ID, limit: 10_001 }))
        .rejects.toThrow(/limit/);
      await expect(store.listAccepted({ partnerContactId: '  ' }))
        .rejects.toThrow(/partnerContactId/);
      await expect(store.listSuppressed({ limit: -1 })).rejects.toThrow(/limit/);
      await expect(store.pruneToRetentionCap(0)).rejects.toThrow(/positive integer/);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
