import type { Pool, QueryResultRow } from 'pg';

import {
  assertSocialPotConfig,
  regenerateSocialPot,
  type SocialPotDrawInput,
  type SocialPotDrawResult,
  type SocialPotPort,
  type SocialPotReadInput,
  type SocialPotSnapshot,
} from '../../core/agent/fatigue/social-pot.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import { createPostgresPool, withPostgresClient } from '../postgres.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';
import { ensureSharedSchema } from './shared-schema.js';

interface SocialPotRow extends QueryResultRow {
  companion_id: string;
  balance: string | number;
  last_regen_at_ms: string | number;
  revision: string | number;
}

/**
 * Advisory-lock seed serializing per-companion pot mutations across processes.
 * Distinct from other fatigue locks so the two never contend on one another.
 */
const SOCIAL_POT_ADVISORY_LOCK_SEED = 2;

function requireCompanionId(companionId: string): string {
  if (!isRfc4122Uuid(companionId)) {
    throw new Error('socialPot.companionId must be an RFC 4122 UUID');
  }
  return companionId;
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function requirePositiveFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a finite number > 0`);
  }
  return value;
}

function finiteNumber(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a finite number`);
  }
  return parsed;
}

function safeInteger(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} must be a safe integer`);
  }
  return parsed;
}

/**
 * Durable Postgres authority for per-companion social pots (shared schema).
 *
 * Every mutation takes a transaction-scoped advisory lock keyed on the
 * companion id and a `SELECT ... FOR UPDATE`, so concurrent draws from multiple
 * channels/processes serialize against one another and regeneration is applied
 * exactly once per read. The store persists regeneration on every read so the
 * durable balance always reflects elapsed ticks — reboots lose nothing.
 */
export class PostgresSocialPotStore implements SocialPotPort {
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresSocialPotStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'companion-social-pot',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
    });
    try {
      await ensureSharedSchema(pool);
      return new PostgresSocialPotStore(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async readPot(input: SocialPotReadInput): Promise<SocialPotSnapshot> {
    const companionId = requireCompanionId(input.companionId);
    const nowMs = requireTimestamp(input.nowMs, 'socialPot.nowMs');
    const config = assertSocialPotConfig(input.config);
    if (this.closed) {
      throw new Error('social pot store is closed');
    }
    return await withPostgresClient(this.pool, async (client) => {
      await this.lock(client, companionId);
      const current = await this.loadOrInitialize(client, companionId, nowMs, config);
      const regenerated = regenerateSocialPot({
        balance: current.balance,
        lastRegenAtMs: current.lastRegenAtMs,
        nowMs,
        config,
      });
      const persisted = await this.persistIfChanged(
        client,
        companionId,
        current,
        regenerated.balance,
        regenerated.lastRegenAtMs,
      );
      return this.toSnapshot(companionId, persisted, config.capUnits);
    });
  }

  async draw(input: SocialPotDrawInput): Promise<SocialPotDrawResult> {
    const companionId = requireCompanionId(input.companionId);
    const nowMs = requireTimestamp(input.nowMs, 'socialPot.nowMs');
    const amount = requirePositiveFinite(input.amount, 'socialPot.amount');
    const config = assertSocialPotConfig(input.config);
    if (this.closed) {
      throw new Error('social pot store is closed');
    }
    return await withPostgresClient(this.pool, async (client) => {
      await this.lock(client, companionId);
      const current = await this.loadOrInitialize(client, companionId, nowMs, config);
      const regenerated = regenerateSocialPot({
        balance: current.balance,
        lastRegenAtMs: current.lastRegenAtMs,
        nowMs,
        config,
      });
      const sufficient = regenerated.balance >= amount;
      const nextBalance = sufficient ? regenerated.balance - amount : regenerated.balance;
      const persisted = await this.persistIfChanged(
        client,
        companionId,
        current,
        nextBalance,
        regenerated.lastRegenAtMs,
      );
      const before = this.toSnapshot(
        companionId,
        { balance: regenerated.balance, lastRegenAtMs: regenerated.lastRegenAtMs, revision: current.revision },
        config.capUnits,
      );
      const after = this.toSnapshot(companionId, persisted, config.capUnits);
      return {
        outcome: sufficient ? 'drawn' : 'insufficient',
        drawn: sufficient ? amount : 0,
        before,
        after,
      };
    });
  }

  private async lock(
    client: Pick<Pool, 'query'>,
    companionId: string,
  ): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(
        hashtextextended($1::text, ${SOCIAL_POT_ADVISORY_LOCK_SEED})
      )`,
      [companionId],
    );
  }

  private async loadOrInitialize(
    client: Pick<Pool, 'query'>,
    companionId: string,
    nowMs: number,
    config: { capUnits: number },
  ): Promise<{ balance: number; lastRegenAtMs: number; revision: number }> {
    const existing = await client.query<SocialPotRow>(
      `SELECT companion_id, balance, last_regen_at_ms, revision
       FROM companion_social_pot
       WHERE companion_id = $1
       FOR UPDATE`,
      [companionId],
    );
    const row = existing.rows.at(0);
    if (row) {
      return {
        balance: finiteNumber(row.balance, 'socialPot.balance'),
        lastRegenAtMs: safeInteger(row.last_regen_at_ms, 'socialPot.lastRegenAtMs'),
        revision: safeInteger(row.revision, 'socialPot.revision'),
      };
    }
    // A companion's first observation starts with a full pot at the current tick
    // boundary, so it begins with full social energy rather than empty.
    const inserted = await client.query<SocialPotRow>(
      `INSERT INTO companion_social_pot (companion_id, balance, last_regen_at_ms, revision)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (companion_id) DO NOTHING
       RETURNING companion_id, balance, last_regen_at_ms, revision`,
      [companionId, config.capUnits, nowMs],
    );
    const insertedRow = inserted.rows.at(0);
    if (insertedRow) {
      return {
        balance: finiteNumber(insertedRow.balance, 'socialPot.balance'),
        lastRegenAtMs: safeInteger(insertedRow.last_regen_at_ms, 'socialPot.lastRegenAtMs'),
        revision: safeInteger(insertedRow.revision, 'socialPot.revision'),
      };
    }
    // Lost the insert race (another lock holder created it first); re-read under
    // the row lock we already hold.
    const reread = await client.query<SocialPotRow>(
      `SELECT companion_id, balance, last_regen_at_ms, revision
       FROM companion_social_pot
       WHERE companion_id = $1
       FOR UPDATE`,
      [companionId],
    );
    const rereadRow = reread.rows.at(0);
    if (!rereadRow) {
      throw new Error(`social pot row missing after insert conflict for ${companionId}`);
    }
    return {
      balance: finiteNumber(rereadRow.balance, 'socialPot.balance'),
      lastRegenAtMs: safeInteger(rereadRow.last_regen_at_ms, 'socialPot.lastRegenAtMs'),
      revision: safeInteger(rereadRow.revision, 'socialPot.revision'),
    };
  }

  private async persistIfChanged(
    client: Pick<Pool, 'query'>,
    companionId: string,
    current: { balance: number; lastRegenAtMs: number; revision: number },
    nextBalance: number,
    nextLastRegenAtMs: number,
  ): Promise<{ balance: number; lastRegenAtMs: number; revision: number }> {
    if (nextBalance === current.balance && nextLastRegenAtMs === current.lastRegenAtMs) {
      return current;
    }
    const nextRevision = current.revision + 1;
    const updated = await client.query<SocialPotRow>(
      `UPDATE companion_social_pot
       SET balance = $2, last_regen_at_ms = $3, revision = $4
       WHERE companion_id = $1 AND revision = $5
       RETURNING companion_id, balance, last_regen_at_ms, revision`,
      [companionId, nextBalance, nextLastRegenAtMs, nextRevision, current.revision],
    );
    const row = updated.rows.at(0);
    if (!row) {
      throw new Error(`social pot concurrent revision conflict for ${companionId}`);
    }
    return {
      balance: finiteNumber(row.balance, 'socialPot.balance'),
      lastRegenAtMs: safeInteger(row.last_regen_at_ms, 'socialPot.lastRegenAtMs'),
      revision: safeInteger(row.revision, 'socialPot.revision'),
    };
  }

  private toSnapshot(
    companionId: string,
    state: { balance: number; lastRegenAtMs: number; revision: number },
    cap: number,
  ): SocialPotSnapshot {
    return {
      companionId,
      balance: state.balance,
      cap,
      lastRegenAtMs: state.lastRegenAtMs,
      revision: state.revision,
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.pool.end();
    return await this.closePromise;
  }
}
