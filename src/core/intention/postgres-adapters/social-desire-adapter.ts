import type { Pool } from 'pg';
import { queryOne, queryRows } from './connection.js';
import { toNumber } from './shared.js';
import type {
  SocialDesireSettlementInput,
  SocialDesireSettlementOutcome,
  SocialDesireStorePortBackend,
} from '../social-desire-store-port.js';
import {
  SOCIAL_DESIRE_ACCUMULATING_TIERS,
  applySocialDesireDampening,
  releaseSocialDesirePressure,
  type SocialDesire,
  type SocialDesireAccumulatingTier,
} from '../social-desire.js';

// Postgres backend for per-contact durable social desires (bead oth4.1).
// contact_id is the PRIMARY KEY: the one-desire-per-contact coalescing
// invariant is enforced by the schema itself, not just by callers. Pressure and
// its anchor timestamp persist so decay is deterministic across restart; the
// cache hydrates on connect (9vi.13 pattern, same as weighted thoughts).

interface SocialDesireRow {
  contact_id: string;
  warm_pressure: number | string;
  repair_pressure: number | string;
  pressure_anchor_at: string;
  last_warm_felt_at: string | null;
  last_repair_felt_at: string | null;
  last_warm_tick_at: string | null;
  last_repair_tick_at: string | null;
  tick_count: number | string;
  absorbed_signal_count: number | string;
  tier_at_last_tick: string;
  reinforced_concern_ids: unknown;
  created_at: string;
}

const SELECT_COLUMNS = `
  contact_id, warm_pressure, repair_pressure, pressure_anchor_at,
  last_warm_felt_at, last_repair_felt_at, last_warm_tick_at,
  last_repair_tick_at, tick_count, absorbed_signal_count,
  tier_at_last_tick, reinforced_concern_ids, created_at
`;

function parseTier(value: string): SocialDesireAccumulatingTier {
  if (!SOCIAL_DESIRE_ACCUMULATING_TIERS.includes(value as SocialDesireAccumulatingTier)) {
    throw new Error(`Persisted social desire has invalid tier_at_last_tick "${value}"`);
  }
  return value as SocialDesireAccumulatingTier;
}

function parseConcernIds(value: unknown): string[] {
  const raw = typeof value === 'string' ? safeJsonParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapRow(row: SocialDesireRow): SocialDesire {
  return {
    contactId: row.contact_id,
    warmPressure: toNumber(row.warm_pressure),
    repairPressure: toNumber(row.repair_pressure),
    pressureAnchorAt: row.pressure_anchor_at,
    ...(row.last_warm_felt_at ? { lastWarmFeltAt: row.last_warm_felt_at } : {}),
    ...(row.last_repair_felt_at ? { lastRepairFeltAt: row.last_repair_felt_at } : {}),
    ...(row.last_warm_tick_at ? { lastWarmTickAt: row.last_warm_tick_at } : {}),
    ...(row.last_repair_tick_at ? { lastRepairTickAt: row.last_repair_tick_at } : {}),
    tickCount: Math.max(0, Math.floor(toNumber(row.tick_count))),
    absorbedSignalCount: Math.max(0, Math.floor(toNumber(row.absorbed_signal_count))),
    tierAtLastTick: parseTier(row.tier_at_last_tick),
    reinforcedConcernIds: parseConcernIds(row.reinforced_concern_ids),
    createdAt: row.created_at,
  };
}

export class PostgresSocialDesireStore implements SocialDesireStorePortBackend {
  private cache = new Map<string, SocialDesire>();

  constructor(private readonly pool: Pool) {}

  async hydrateCache(): Promise<void> {
    const rows = await queryRows<SocialDesireRow>(
      this.pool,
      `SELECT ${SELECT_COLUMNS} FROM social_desires`,
    );
    this.cache = new Map(rows.map((row) => {
      const desire = mapRow(row);
      return [desire.contactId, desire] as const;
    }));
  }

  snapshotDesires(): SocialDesire[] {
    return [...this.cache.values()].map((desire) => ({
      ...desire,
      reinforcedConcernIds: [...desire.reinforcedConcernIds],
    }));
  }

  async save(desire: SocialDesire): Promise<SocialDesire> {
    const row = await queryOne<SocialDesireRow>(
      this.pool,
      `
        INSERT INTO social_desires (
          contact_id, warm_pressure, repair_pressure, pressure_anchor_at,
          last_warm_felt_at, last_repair_felt_at, last_warm_tick_at,
          last_repair_tick_at, tick_count, absorbed_signal_count,
          tier_at_last_tick, reinforced_concern_ids, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13
        )
        ON CONFLICT (contact_id) DO UPDATE SET
          warm_pressure = excluded.warm_pressure,
          repair_pressure = excluded.repair_pressure,
          pressure_anchor_at = excluded.pressure_anchor_at,
          last_warm_felt_at = excluded.last_warm_felt_at,
          last_repair_felt_at = excluded.last_repair_felt_at,
          last_warm_tick_at = excluded.last_warm_tick_at,
          last_repair_tick_at = excluded.last_repair_tick_at,
          tick_count = excluded.tick_count,
          absorbed_signal_count = excluded.absorbed_signal_count,
          tier_at_last_tick = excluded.tier_at_last_tick,
          reinforced_concern_ids = excluded.reinforced_concern_ids
        RETURNING ${SELECT_COLUMNS}
      `,
      [
        desire.contactId,
        desire.warmPressure,
        desire.repairPressure,
        desire.pressureAnchorAt,
        desire.lastWarmFeltAt ?? null,
        desire.lastRepairFeltAt ?? null,
        desire.lastWarmTickAt ?? null,
        desire.lastRepairTickAt ?? null,
        Math.max(0, Math.floor(desire.tickCount)),
        Math.max(0, Math.floor(desire.absorbedSignalCount)),
        desire.tierAtLastTick,
        JSON.stringify(desire.reinforcedConcernIds),
        desire.createdAt,
      ],
    );
    if (!row) {
      throw new Error(`Failed to persist social desire for contact "${desire.contactId}"`);
    }
    const persisted = mapRow(row);
    this.cache.set(persisted.contactId, persisted);
    return persisted;
  }

  async getByContactId(contactId: string): Promise<SocialDesire | null> {
    const normalizedId = contactId.trim();
    if (!normalizedId) return null;
    const row = await queryOne<SocialDesireRow>(
      this.pool,
      `SELECT ${SELECT_COLUMNS} FROM social_desires WHERE contact_id = $1`,
      [normalizedId],
    );
    if (!row) {
      this.cache.delete(normalizedId);
      return null;
    }
    const desire = mapRow(row);
    this.cache.set(desire.contactId, desire);
    return desire;
  }

  async list(): Promise<SocialDesire[]> {
    const rows = await queryRows<SocialDesireRow>(
      this.pool,
      `
        SELECT ${SELECT_COLUMNS}
        FROM social_desires
        ORDER BY (warm_pressure + repair_pressure) DESC, contact_id ASC
      `,
    );
    return rows.map(mapRow);
  }

  async delete(contactId: string): Promise<boolean> {
    const normalizedId = contactId.trim();
    if (!normalizedId) return false;
    const row = await queryOne<{ contact_id: string }>(
      this.pool,
      `DELETE FROM social_desires WHERE contact_id = $1 RETURNING contact_id`,
      [normalizedId],
    );
    this.cache.delete(normalizedId);
    return Boolean(row);
  }

  async settle(input: SocialDesireSettlementInput): Promise<SocialDesireSettlementOutcome> {
    const settlementId = input.settlementId.trim();
    const contactId = input.contactId.trim();
    if (!settlementId || !contactId) {
      throw new Error('Social desire settlement requires stable identities');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const desireResult = await client.query<SocialDesireRow>(
        `SELECT ${SELECT_COLUMNS} FROM social_desires WHERE contact_id = $1 FOR UPDATE`,
        [contactId],
      );
      const row = desireResult.rows.at(0);
      if (!row) {
        await client.query('COMMIT');
        this.cache.delete(contactId);
        return 'missing';
      }

      const markerResult = await client.query<{
        settlement_id: string;
        contact_id: string;
        disposition: string;
      }>(
        `
          INSERT INTO social_desire_settlements (
            settlement_id, contact_id, disposition, settled_at
          ) VALUES ($1, $2, $3, $4)
          ON CONFLICT (settlement_id) DO NOTHING
          RETURNING settlement_id, contact_id, disposition
        `,
        [settlementId, contactId, input.disposition, new Date(input.nowMs).toISOString()],
      );
      if (!markerResult.rows.at(0)) {
        const existingResult = await client.query<{ contact_id: string; disposition: string }>(
          `SELECT contact_id, disposition FROM social_desire_settlements WHERE settlement_id = $1`,
          [settlementId],
        );
        const existing = existingResult.rows.at(0);
        if (!existing || existing.contact_id !== contactId || existing.disposition !== input.disposition) {
          throw new Error(`Social desire settlement "${settlementId}" was replayed with conflicting provenance`);
        }
        await client.query('COMMIT');
        const current = mapRow(row);
        this.cache.set(contactId, current);
        return 'already_settled';
      }

      const desire = mapRow(row);
      const settled = input.disposition === 'sent'
        ? releaseSocialDesirePressure(desire, input.lifecycle, input.nowMs)
        : applySocialDesireDampening(desire, input.lifecycle, input.nowMs);
      const updateResult = await client.query<SocialDesireRow>(
        `
          UPDATE social_desires SET
            warm_pressure = $2,
            repair_pressure = $3,
            pressure_anchor_at = $4,
            last_warm_felt_at = $5,
            last_repair_felt_at = $6,
            last_warm_tick_at = $7,
            last_repair_tick_at = $8,
            tick_count = $9,
            absorbed_signal_count = $10,
            tier_at_last_tick = $11,
            reinforced_concern_ids = $12::jsonb
          WHERE contact_id = $1
          RETURNING ${SELECT_COLUMNS}
        `,
        [
          settled.contactId,
          settled.warmPressure,
          settled.repairPressure,
          settled.pressureAnchorAt,
          settled.lastWarmFeltAt ?? null,
          settled.lastRepairFeltAt ?? null,
          settled.lastWarmTickAt ?? null,
          settled.lastRepairTickAt ?? null,
          settled.tickCount,
          settled.absorbedSignalCount,
          settled.tierAtLastTick,
          JSON.stringify(settled.reinforcedConcernIds),
        ],
      );
      const persistedRow = updateResult.rows.at(0);
      if (!persistedRow) {
        throw new Error(`Failed to settle social desire for contact "${contactId}"`);
      }
      await client.query('COMMIT');
      const persisted = mapRow(persistedRow);
      this.cache.set(contactId, persisted);
      return input.disposition === 'sent' ? 'released' : 'dampened';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
