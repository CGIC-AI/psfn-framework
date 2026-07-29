// ── Redaction projection-drift fail-closed contract (bead 6oott) ──
//
// Real-Postgres reproduction of the charter Law 22/6.23 leak: a CogSec
// redaction's projection DELETE fails, the original content row SURVIVES in
// session_messages_projection, and — before this fix — searchByKeywords would
// serve the redacted content until an operator ran
// transcript-projection-repair. The contract under test:
//
//   1. the surviving row is provably still in the table (the leak mechanism),
//   2. search fails closed for the channel instead of serving it,
//   3. the drift record is DURABLE: a fresh adapter over the same database
//      (process restart) stays fail-closed with no in-memory carryover,
//   4. a successful canon replacement (what repair runs) clears the record and
//      search serves the channel again without the redacted content,
//   5. ordinary append failures keep their best-effort semantics.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { createDefaultPostgresSessionAdapters } from './postgres-adapters.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
let harness: PostgresTestHarness | null = null;
const tempDirs: string[] = [];

function newSessionsDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

interface FailureInjector {
  /** SQL fragments that should fail while `active` is true. */
  active: boolean;
  matches: (sql: string, values: readonly unknown[]) => boolean;
}

/**
 * Wraps a real pg Pool so statements matched by the injector fail exactly like
 * a database error inside the projection's write transaction, while every
 * other statement (migrations, search, unrelated channels) runs for real.
 */
function wrapPoolWithFailureInjection(pool: Pool, injector: FailureInjector): Pool {
  const wrapClient = (client: PoolClient): PoolClient => new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (...args: unknown[]) => {
          const [text, values] = args as [unknown, readonly unknown[] | undefined];
          if (injector.active && typeof text === 'string' && injector.matches(text, values ?? [])) {
            return Promise.reject(new Error('injected projection write failure'));
          }
          return (target.query as (...inner: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async () => wrapClient(await target.connect());
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function tombstoneEntry(channelId: string, id: number, caseId: string): {
  id: number;
  channelId: string;
  role: 'user';
  content: string;
  metadata: string;
  timestamp: number;
} {
  return {
    id,
    channelId,
    role: 'user',
    content: `[CogSec redaction: ${caseId}]`,
    metadata: JSON.stringify({
      kind: 'cogsec_l0_tombstone',
      caseId,
      redactedAt: '2026-07-22T00:00:00.000Z',
    }),
    timestamp: 1_000,
  };
}

describe('transcript projection redaction drift (real Postgres)', () => {
  it('fails closed on a failed redaction DELETE, survives restart, and recovers through repair', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const database = await harness.createDatabase();
    const sessionsDir = newSessionsDir('psfn-projection-redaction-drift-pg-');
    const targetChannel = 'api:redaction-leak-target';
    const otherChannel = 'api:redaction-leak-other';
    const caseId = 'cogsec_20260722T000000Z_leak';

    const injector: FailureInjector = {
      active: false,
      matches: (sql, values) => (
        sql.includes('DELETE FROM session_messages_projection')
        && values[0] === targetChannel
      ),
    };
    const basePool = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-redaction-drift-test',
      allowExitOnIdle: true,
      max: 4,
    });
    const wrappedPool = wrapPoolWithFailureInjection(basePool, injector);
    const verifyPool = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-redaction-drift-verify',
      allowExitOnIdle: true,
      max: 2,
    });

    try {
      const adapters = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
        sessionsDir,
        pool: wrappedPool,
      });

      adapters.transcriptProjection.upsertSessionEntry({
        id: 1,
        channelId: targetChannel,
        role: 'user',
        content: 'the secret payload phrase',
        timestamp: 1_000,
      });
      adapters.transcriptProjection.upsertSessionEntry({
        id: 2,
        channelId: targetChannel,
        role: 'assistant',
        content: 'ordinary chatter in target',
        timestamp: 2_000,
      });
      adapters.transcriptProjection.upsertSessionEntry({
        id: 1,
        channelId: otherChannel,
        role: 'user',
        content: 'healthy other-channel needle',
        timestamp: 3_000,
      });
      await adapters.transcriptProjection.flushPendingWrites?.();

      // Red baseline for the leak repro: before the redaction, the content is
      // served — this is exactly what a surviving row would keep serving.
      await expect(adapters.transcriptSearch.searchByKeywords('secret payload')).resolves.toEqual([
        expect.objectContaining({ channelId: targetChannel, messageId: 1 }),
      ]);

      // Fail the redaction's projection DELETE (both the attempt and the
      // bounded retry) — the leak mechanism from the bead.
      injector.active = true;
      adapters.transcriptProjection.upsertSessionEntry(tombstoneEntry(targetChannel, 1, caseId));
      await adapters.transcriptProjection.flushPendingWrites?.();
      injector.active = false;

      // The original content row SURVIVED in Postgres...
      const surviving = await verifyPool.query(
        'SELECT content FROM session_messages_projection WHERE channel_id = $1 AND message_id = 1',
        [targetChannel],
      );
      expect(surviving.rows).toHaveLength(1);
      expect(surviving.rows[0].content).toBe('the secret payload phrase');

      // ...but search fails closed for the channel instead of serving it,
      // while unrelated channels keep serving.
      await expect(adapters.transcriptSearch.searchByKeywords('secret payload')).resolves.toEqual([]);
      await expect(adapters.transcriptSearch.searchByKeywords('ordinary chatter')).resolves.toEqual([]);
      await expect(adapters.transcriptSearch.searchByKeywords('healthy needle')).resolves.toEqual([
        expect.objectContaining({ channelId: otherChannel }),
      ]);

      // The drift record is durable and redaction-kind.
      const driftRows = await verifyPool.query(
        'SELECT kind FROM session_projection_drift WHERE channel_id = $1',
        [targetChannel],
      );
      expect(driftRows.rows).toEqual([{ kind: 'redaction' }]);

      // "Restart": a fresh adapter over the same database, no in-memory
      // carryover and no failure injection. The durable record alone must keep
      // search fail-closed.
      const restartPool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-redaction-drift-restarted',
        allowExitOnIdle: true,
        max: 4,
      });
      const restarted = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
        sessionsDir,
        pool: restartPool,
      });
      expect(restarted.transcriptProjection.listProjectionDrift()).toEqual([
        expect.objectContaining({ channelId: targetChannel, kind: 'redaction' }),
      ]);
      await expect(restarted.transcriptSearch.searchByKeywords('secret payload')).resolves.toEqual([]);

      // Repair: transcript-projection-repair rebuilds the channel from canon
      // via replaceChannelEntries. A successful replacement clears the durable
      // record and search serves the channel again — without redacted content.
      restarted.transcriptProjection.replaceChannelEntries(targetChannel, [
        tombstoneEntry(targetChannel, 1, caseId),
        {
          id: 2,
          channelId: targetChannel,
          role: 'assistant',
          content: 'ordinary chatter in target',
          timestamp: 2_000,
        },
      ]);
      await restarted.transcriptProjection.flushPendingWrites?.();

      expect(restarted.transcriptProjection.listProjectionDrift()).toEqual([]);
      const clearedDrift = await verifyPool.query(
        'SELECT channel_id FROM session_projection_drift WHERE channel_id = $1',
        [targetChannel],
      );
      expect(clearedDrift.rows).toEqual([]);
      await expect(restarted.transcriptSearch.searchByKeywords('secret payload')).resolves.toEqual([]);
      await expect(restarted.transcriptSearch.searchByKeywords('ordinary chatter')).resolves.toEqual([
        expect.objectContaining({ channelId: targetChannel, messageId: 2 }),
      ]);
      const repairedRows = await verifyPool.query(
        'SELECT message_id FROM session_messages_projection WHERE channel_id = $1 ORDER BY message_id',
        [targetChannel],
      );
      expect(repairedRows.rows).toEqual([{ message_id: '2' }]);
    } finally {
      await verifyPool.end();
      await basePool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps ordinary append failures best-effort: sync drift, channel still searchable', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const database = await harness.createDatabase();
    const sessionsDir = newSessionsDir('psfn-projection-sync-drift-pg-');
    const channelId = 'api:best-effort-channel';

    const injector: FailureInjector = {
      active: false,
      matches: (sql, values) => (
        sql.includes('INSERT INTO session_messages_projection')
        && values[0] === channelId
      ),
    };
    const basePool = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-sync-drift-test',
      allowExitOnIdle: true,
      max: 4,
    });
    const wrappedPool = wrapPoolWithFailureInjection(basePool, injector);

    try {
      const adapters = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
        sessionsDir,
        pool: wrappedPool,
      });

      adapters.transcriptProjection.upsertSessionEntry({
        id: 1,
        channelId,
        role: 'user',
        content: 'existing best effort needle',
        timestamp: 1_000,
      });
      await adapters.transcriptProjection.flushPendingWrites?.();

      injector.active = true;
      adapters.transcriptProjection.upsertSessionEntry({
        id: 2,
        channelId,
        role: 'assistant',
        content: 'append that will be lost',
        timestamp: 2_000,
      });
      await adapters.transcriptProjection.flushPendingWrites?.();
      injector.active = false;

      // Best-effort drift is tracked but does NOT fail search closed.
      expect(adapters.transcriptProjection.listProjectionDrift()).toEqual([
        expect.objectContaining({ channelId, kind: 'sync' }),
      ]);
      await expect(adapters.transcriptSearch.searchByKeywords('best effort needle')).resolves.toEqual([
        expect.objectContaining({ channelId, messageId: 1 }),
      ]);
    } finally {
      await basePool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
