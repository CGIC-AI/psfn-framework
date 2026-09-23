import type { Pool, QueryResultRow } from 'pg';
import {
  SOCIAL_IMPULSE_LEDGER_STATES,
  type SocialImpulseLedgerRecord,
  type SocialImpulseLedgerState,
  type SocialImpulseOutreachMode,
  type SocialImpulseOutreachStorePort,
} from '../../core/emotion/social-impulse-outreach.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  ensurePostgresSchemaExists,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';
import { requireSafeInteger } from './row-guards.js';
import type { SocialOutreachHealthSummary } from '../../shared/contracts/companion-system-monitor.js';

interface LedgerRow extends QueryResultRow {
  impulse_id: string;
  companion_id: string;
  first_crossing_ms: string | number;
  fired_at_ms: string | number;
  confidence: string | number;
  mode_at_receipt: string;
  state: string;
  boosted_contact_count: string | number;
  reason_code: string | null;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

const COLUMNS = `
  impulse_id, companion_id, first_crossing_ms, fired_at_ms, confidence,
  mode_at_receipt, state, boosted_contact_count, reason_code, created_at_ms, updated_at_ms
`;

/** Content-free ledger of EmoSim impulses and the per-contact pressure they raised. */
export class PostgresSocialImpulseOutreachStore implements SocialImpulseOutreachStorePort {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string },
  ): Promise<PostgresSocialImpulseOutreachStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'social-impulse-outreach',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    try {
      if (options.schema) await ensurePostgresSchemaExists(pool, options.schema);
      await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS);
      return new PostgresSocialImpulseOutreachStore(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async recordImpulse(record: SocialImpulseLedgerRecord): Promise<{
    created: boolean;
    record: SocialImpulseLedgerRecord;
  }> {
    const row = await queryOne<LedgerRow>(this.pool, `
      INSERT INTO social_impulse_outreach_ledger (
        impulse_id, companion_id, first_crossing_ms, fired_at_ms, confidence,
        mode_at_receipt, state, boosted_contact_count, reason_code, created_at_ms, updated_at_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      ON CONFLICT (impulse_id) DO NOTHING
      RETURNING ${COLUMNS}
    `, [
      record.impulseId,
      record.companionId,
      record.firstCrossingMs,
      record.firedAtMs,
      record.confidence,
      record.modeAtReceipt,
      record.state,
      record.boostedContactCount,
      record.reasonCode,
      record.createdAtMs,
    ]);
    if (row) return { created: true, record: mapRow(row) };
    const prior = await queryOne<LedgerRow>(this.pool, `
      SELECT ${COLUMNS} FROM social_impulse_outreach_ledger WHERE impulse_id = $1
    `, [record.impulseId]);
    if (!prior) throw new Error('social impulse ledger lost a conflicting impulse row');
    const existing = mapRow(prior);
    if (existing.companionId !== record.companionId
      || existing.firstCrossingMs !== record.firstCrossingMs) {
      throw new Error('social impulse correlation collided with different source facts');
    }
    return { created: false, record: existing };
  }

  async settleImpulse(input: {
    impulseId: string;
    state: Exclude<SocialImpulseLedgerState, 'received'>;
    boostedContactCount: number;
    reasonCode?: string;
    settledAtMs: number;
  }): Promise<SocialImpulseLedgerRecord> {
    const row = await queryOne<LedgerRow>(this.pool, `
      UPDATE social_impulse_outreach_ledger SET
        state = $2, boosted_contact_count = $3, reason_code = $4,
        updated_at_ms = GREATEST(created_at_ms, $5)
      WHERE impulse_id = $1 AND state = 'received'
      RETURNING ${COLUMNS}
    `, [
      input.impulseId,
      input.state,
      input.boostedContactCount,
      input.reasonCode ?? null,
      input.settledAtMs,
    ]);
    if (!row) throw new Error('social impulse settlement lost its received ledger row');
    return mapRow(row);
  }

  async getHealthSummary(companionId: string): Promise<SocialOutreachHealthSummary> {
    const rows = await queryRows<{
      state: string; count: string; updated_at: string; fired_at: string;
    }>(this.pool, `
      SELECT state, COUNT(*)::text AS count, MAX(updated_at_ms)::text AS updated_at,
        MAX(fired_at_ms)::text AS fired_at
      FROM social_impulse_outreach_ledger WHERE companion_id = $1
      GROUP BY state ORDER BY state
    `, [companionId]);
    const states = rows.map(row => ({
      state: parseState(row.state),
      count: requireSafeInteger(row.count, 'socialImpulse.health.count'),
      lastUpdatedAtMs: requireSafeInteger(row.updated_at, 'socialImpulse.health.updatedAt'),
    }));
    return {
      total: states.reduce((total, state) => total + state.count, 0),
      states,
      lastFiredAtMs: rows.length
        ? Math.max(...rows.map(row => requireSafeInteger(row.fired_at, 'socialImpulse.health.firedAt')))
        : null,
      // Deliveries are recorded by the durable outreach outbox, not this
      // ledger; the composition root joins them into the monitor summary.
      lastDeliveredAtMs: null,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function mapRow(row: LedgerRow): SocialImpulseLedgerRecord {
  if (!isRfc4122Uuid(row.companion_id)) throw new Error('persisted social impulse companion_id is invalid');
  const confidence = Number(row.confidence);
  if (!Number.isFinite(confidence)) throw new Error('persisted social impulse confidence is invalid');
  return {
    impulseId: row.impulse_id,
    companionId: row.companion_id,
    firstCrossingMs: requireSafeInteger(row.first_crossing_ms, 'socialImpulse.firstCrossingMs'),
    firedAtMs: requireSafeInteger(row.fired_at_ms, 'socialImpulse.firedAtMs'),
    confidence,
    modeAtReceipt: parseMode(row.mode_at_receipt),
    state: parseState(row.state),
    boostedContactCount: requireSafeInteger(row.boosted_contact_count, 'socialImpulse.boostedContactCount'),
    reasonCode: row.reason_code,
    createdAtMs: requireSafeInteger(row.created_at_ms, 'socialImpulse.createdAtMs'),
    updatedAtMs: requireSafeInteger(row.updated_at_ms, 'socialImpulse.updatedAtMs'),
  };
}

function parseState(value: string): SocialImpulseLedgerState {
  if (!(SOCIAL_IMPULSE_LEDGER_STATES as readonly string[]).includes(value)) {
    throw new Error(`unknown social impulse ledger state ${value}`);
  }
  return value as SocialImpulseLedgerState;
}

function parseMode(value: string): SocialImpulseOutreachMode {
  if (value !== 'off' && value !== 'shadow' && value !== 'on') {
    throw new Error(`unknown social impulse outreach mode ${value}`);
  }
  return value;
}
