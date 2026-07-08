// ── Unit tests for the shared-schema companion presence store (W5a) ──
// Mocked-pool style (see participant-trend-store.test.ts): pins the SQL
// contract (upsert with since-preservation, place-indexed reads, delete) and
// the fail-closed input validation, without a live database. The live-DB
// behavior is covered by companion-presence.integration.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresCompanionPresenceStore } from './companion-presence-store.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';

const storeMocks = vi.hoisted(() => ({
  pool: { kind: 'pool', end: vi.fn(async () => undefined) },
  createPostgresPool: vi.fn(() => storeMocks.pool),
  ensureSharedSchema: vi.fn(async () => undefined),
  executeQuery: vi.fn(async () => ({ rowCount: 0 })),
  queryOne: vi.fn(async () => undefined as unknown),
  queryRows: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: storeMocks.createPostgresPool,
  executeQuery: storeMocks.executeQuery,
  queryOne: storeMocks.queryOne,
  queryRows: storeMocks.queryRows,
}));

vi.mock('./shared-schema.js', () => ({
  ensureSharedSchema: storeMocks.ensureSharedSchema,
}));

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-07-08T12:00:00.000Z');

const DB_ROW = {
  companion_id: COMPANION_ID,
  site_id: 'site.home',
  place_id: 'place.living-room',
  kind: 'physical',
  since: NOW,
  updated_at: NOW,
};

beforeEach(() => {
  storeMocks.createPostgresPool.mockClear();
  storeMocks.ensureSharedSchema.mockClear();
  storeMocks.executeQuery.mockClear();
  storeMocks.queryOne.mockClear();
  storeMocks.queryRows.mockClear();
  storeMocks.queryOne.mockResolvedValue(DB_ROW);
  storeMocks.queryRows.mockResolvedValue([DB_ROW]);
  storeMocks.executeQuery.mockResolvedValue({ rowCount: 1 });
});

async function connect(): Promise<PostgresCompanionPresenceStore> {
  return PostgresCompanionPresenceStore.connect('postgres://postgres:secret@localhost:5432/psfn');
}

describe('PostgresCompanionPresenceStore (W5a)', () => {
  it('pins the pool to the shared schema and provisions it before any access', async () => {
    await connect();
    expect(storeMocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      expect.objectContaining({ schema: SHARED_SCHEMA_NAME }),
    );
    expect(storeMocks.ensureSharedSchema).toHaveBeenCalledWith(storeMocks.pool);
  });

  it('upserts the own row preserving since across same-place refreshes', async () => {
    const store = await connect();
    const record = await store.upsertPresence({
      companionId: COMPANION_ID,
      siteId: 'site.home',
      placeId: 'place.living-room',
      kind: 'physical',
    });

    const [, sql, params] = storeMocks.queryOne.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain('INSERT INTO companion_presence');
    expect(sql).toContain('ON CONFLICT (companion_id) DO UPDATE');
    // Same-place refresh keeps `since`; a move resets it.
    expect(sql).toContain('THEN companion_presence.since');
    expect(sql).toContain('ELSE EXCLUDED.since');
    expect(params).toEqual([COMPANION_ID, 'site.home', 'place.living-room', 'physical']);
    expect(record).toEqual({
      companionId: COMPANION_ID,
      siteId: 'site.home',
      placeId: 'place.living-room',
      kind: 'physical',
      since: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it('fails closed on a non-UUID companion id and an unknown kind', async () => {
    const store = await connect();
    await expect(store.upsertPresence({
      companionId: 'flagship',
      siteId: 'site.home',
      placeId: 'place.living-room',
      kind: 'physical',
    })).rejects.toThrow('lowercase RFC-4122 UUID');
    await expect(store.upsertPresence({
      companionId: COMPANION_ID,
      siteId: 'site.home',
      placeId: 'place.living-room',
      kind: 'astral' as never,
    })).rejects.toThrow("kind must be 'physical' or 'virtual'");
    expect(storeMocks.queryOne).not.toHaveBeenCalled();
  });

  it('queries co-presence by (site_id, place_id)', async () => {
    const store = await connect();
    const rows = await store.listByPlace('site.home', 'place.living-room');
    const [, sql, params] = storeMocks.queryRows.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain('WHERE site_id = $1 AND place_id = $2');
    expect(params).toEqual(['site.home', 'place.living-room']);
    expect(rows).toHaveLength(1);
    expect(rows[0].companionId).toBe(COMPANION_ID);
  });

  it('lists all presence rows across the cluster', async () => {
    const store = await connect();
    const rows = await store.listAll();
    const [, sql] = storeMocks.queryRows.mock.calls[0] as [unknown, string];
    expect(sql).toContain('FROM companion_presence');
    expect(sql).not.toContain('WHERE');
    expect(rows).toHaveLength(1);
  });

  it('deletes the own row and reports whether one existed', async () => {
    const store = await connect();
    await expect(store.deletePresence(COMPANION_ID)).resolves.toBe(true);
    const [, sql, params] = storeMocks.executeQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain('DELETE FROM companion_presence');
    expect(params).toEqual([COMPANION_ID]);

    storeMocks.executeQuery.mockResolvedValue({ rowCount: 0 });
    await expect(store.deletePresence(COMPANION_ID)).resolves.toBe(false);
  });

  it('fails closed when a stored row carries an invalid kind', async () => {
    storeMocks.queryRows.mockResolvedValue([{ ...DB_ROW, kind: 'corrupted' }]);
    const store = await connect();
    await expect(store.listByPlace('site.home', 'place.living-room'))
      .rejects.toThrow("kind must be 'physical' or 'virtual'");
  });
});
