import type { Pool, QueryResultRow } from 'pg';
import { createPostgresPool, executeQuery, queryOne, queryRows } from '../postgres.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';
import { ensureSharedSchema } from './shared-schema.js';
import {
  COMPANION_PRESENCE_COMPANION_ID_PATTERN,
  type CompanionPresenceRecord,
  type CompanionPresenceStorePort,
  type CompanionPresenceUpsertInput,
} from '../../core/agent/companion-presence-store-port.js';
import type { PlaceKind } from '../../shared/contracts/places-registry.js';

// ── Shared-schema companion presence store (sprint 10, W5a) ──
//
// Backed by `shared.companion_presence`. Schema addressing goes exclusively
// through the validated shared-schema path: the pool is pinned to
// SHARED_SCHEMA_NAME via `createPostgresPool({ schema })`, which fail-closed
// validates the identifier before it reaches the connection options — no query
// below interpolates a schema or any other identifier.

const MAX_ID_CHARS = 256;

interface CompanionPresenceRow extends QueryResultRow {
  companion_id: string;
  site_id: string;
  place_id: string;
  kind: string;
  since: Date | string;
  updated_at: Date | string;
}

function normalizeCompanionId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Companion presence companionId must be a string');
  }
  const normalized = value.trim();
  if (!COMPANION_PRESENCE_COMPANION_ID_PATTERN.test(normalized)) {
    throw new Error(
      `Companion presence companionId must be a lowercase RFC-4122 UUID, got ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

function normalizeIdText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Companion presence ${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Companion presence ${fieldName} must be a non-empty string`);
  }
  if (normalized.length > MAX_ID_CHARS) {
    throw new Error(`Companion presence ${fieldName} must be ${MAX_ID_CHARS} characters or fewer`);
  }
  return normalized;
}

function normalizeKind(value: unknown): PlaceKind {
  if (value !== 'physical' && value !== 'virtual') {
    throw new Error(
      `Companion presence kind must be 'physical' or 'virtual', got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function normalizeTimestamp(value: Date | string, fieldName: string): string {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Companion presence ${fieldName} is not a valid timestamp`);
  }
  return new Date(parsed).toISOString();
}

function mapRow(row: CompanionPresenceRow): CompanionPresenceRecord {
  return {
    companionId: normalizeCompanionId(row.companion_id),
    siteId: normalizeIdText(row.site_id, 'siteId'),
    placeId: normalizeIdText(row.place_id, 'placeId'),
    kind: normalizeKind(row.kind),
    since: normalizeTimestamp(row.since, 'since'),
    updatedAt: normalizeTimestamp(row.updated_at, 'updatedAt'),
  };
}

export class PostgresCompanionPresenceStore implements CompanionPresenceStorePort {
  private constructor(private readonly pool: Pool) {}

  /**
   * Connect a shared-schema-pinned pool and provision the shared schema (the
   * provisioning is advisory-lock serialized, so N agents connecting
   * concurrently are safe) before any presence access.
   */
  static async connect(databaseUrl: string): Promise<PostgresCompanionPresenceStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-companion-presence',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
    });
    await ensureSharedSchema(pool);
    return new PostgresCompanionPresenceStore(pool);
  }

  async upsertPresence(input: CompanionPresenceUpsertInput): Promise<CompanionPresenceRecord> {
    const companionId = normalizeCompanionId(input.companionId);
    const siteId = normalizeIdText(input.siteId, 'siteId');
    const placeId = normalizeIdText(input.placeId, 'placeId');
    const kind = normalizeKind(input.kind);

    // Same-place refresh keeps `since` (arrival time at the current place);
    // a move resets it. `updated_at` always bumps — it is the freshness beat
    // readers key their staleness TTL off.
    const row = await queryOne<CompanionPresenceRow>(this.pool, `
      INSERT INTO companion_presence (companion_id, site_id, place_id, kind, since, updated_at)
      VALUES ($1, $2, $3, $4, now(), now())
      ON CONFLICT (companion_id) DO UPDATE SET
        site_id = EXCLUDED.site_id,
        place_id = EXCLUDED.place_id,
        kind = EXCLUDED.kind,
        since = CASE
          WHEN companion_presence.site_id = EXCLUDED.site_id
            AND companion_presence.place_id = EXCLUDED.place_id
          THEN companion_presence.since
          ELSE EXCLUDED.since
        END,
        updated_at = EXCLUDED.updated_at
      RETURNING companion_id, site_id, place_id, kind, since, updated_at
    `, [companionId, siteId, placeId, kind]);
    if (!row) {
      throw new Error(`Failed to upsert companion presence for "${companionId}"`);
    }
    return mapRow(row);
  }

  async listByPlace(siteId: string, placeId: string): Promise<CompanionPresenceRecord[]> {
    const rows = await queryRows<CompanionPresenceRow>(this.pool, `
      SELECT companion_id, site_id, place_id, kind, since, updated_at
      FROM companion_presence
      WHERE site_id = $1 AND place_id = $2
      ORDER BY since ASC, companion_id ASC
    `, [normalizeIdText(siteId, 'siteId'), normalizeIdText(placeId, 'placeId')]);
    return rows.map(mapRow);
  }

  async listAll(): Promise<CompanionPresenceRecord[]> {
    const rows = await queryRows<CompanionPresenceRow>(this.pool, `
      SELECT companion_id, site_id, place_id, kind, since, updated_at
      FROM companion_presence
      ORDER BY site_id ASC, place_id ASC, since ASC, companion_id ASC
    `);
    return rows.map(mapRow);
  }

  async deletePresence(companionId: string): Promise<boolean> {
    const result = await executeQuery(this.pool, `
      DELETE FROM companion_presence
      WHERE companion_id = $1
    `, [normalizeCompanionId(companionId)]);
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
