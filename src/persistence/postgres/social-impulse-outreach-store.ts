import type { Pool, QueryResultRow } from 'pg';
import type {
  SocialImpulseDisposition,
  SocialImpulseOutreachDestination,
  SocialImpulseOutreachRecord,
  SocialImpulseOutreachState,
  SocialImpulseOutreachStorePort,
} from '../../core/emotion/social-impulse-outreach.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  ensurePostgresSchemaExists,
  queryOne,
} from '../postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';
import { requireSafeInteger } from './row-guards.js';

interface OutreachRow extends QueryResultRow {
  opportunity_id: string;
  schema_version: number;
  companion_id: string;
  impulse_dedupe_key: string;
  first_crossing_ms: string | number;
  fired_at_ms: string | number;
  mode_at_creation: string;
  state: string;
  disposition: string | null;
  destination_kind: string | null;
  destination_id: string | null;
  contact_id: string | null;
  display_label: string | null;
  channel_id: string | null;
  channel_type: string | null;
  dyad_id: string | null;
  binding_hash: string | null;
  reason_code: string | null;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

const COLUMNS = `
  opportunity_id, schema_version, companion_id, impulse_dedupe_key,
  first_crossing_ms, fired_at_ms, mode_at_creation, state, disposition,
  destination_kind, destination_id, contact_id, display_label, channel_id,
  channel_type, dyad_id, binding_hash, reason_code, created_at_ms, updated_at_ms
`;

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

  async createOpportunity(record: SocialImpulseOutreachRecord): Promise<{
    created: boolean;
    record: SocialImpulseOutreachRecord;
  }> {
    const row = await queryOne<OutreachRow>(this.pool, `
      INSERT INTO social_impulse_outreach_opportunities (
        opportunity_id, schema_version, companion_id, impulse_dedupe_key,
        first_crossing_ms, fired_at_ms, mode_at_creation, state, disposition,
        destination_kind, destination_id, contact_id, display_label, channel_id,
        channel_type, dyad_id, binding_hash, reason_code, created_at_ms, updated_at_ms
      ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, $8, $9, $9)
      ON CONFLICT (opportunity_id) DO NOTHING
      RETURNING ${COLUMNS}
    `, [
      record.opportunityId,
      record.companionId,
      record.impulseDedupeKey,
      record.firstCrossingMs,
      record.firedAtMs,
      record.modeAtCreation,
      record.state,
      record.reasonCode,
      record.createdAtMs,
    ]);
    if (row) return { created: true, record: mapRow(row) };
    const prior = await this.getOpportunity(record.opportunityId);
    if (!prior
      || prior.companionId !== record.companionId
      || prior.impulseDedupeKey !== record.impulseDedupeKey
      || prior.firstCrossingMs !== record.firstCrossingMs
      || prior.firedAtMs !== record.firedAtMs) {
      throw new Error('social impulse opportunity correlation collided with different source facts');
    }
    return { created: false, record: prior };
  }

  async getOpportunity(opportunityId: string): Promise<SocialImpulseOutreachRecord | null> {
    const row = await queryOne<OutreachRow>(this.pool, `
      SELECT ${COLUMNS}
      FROM social_impulse_outreach_opportunities
      WHERE opportunity_id = $1
    `, [opportunityId]);
    return row ? mapRow(row) : null;
  }

  async claimDisposition(input: {
    opportunityId: string;
    disposition: SocialImpulseDisposition;
    destination: SocialImpulseOutreachDestination | null;
    bindingHash: string;
    claimedAtMs: number;
  }): Promise<
    | { outcome: 'claimed' | 'replayed' | 'conflict'; record: SocialImpulseOutreachRecord }
    | { outcome: 'unavailable' }
  > {
    const destination = input.destination;
    const row = await queryOne<OutreachRow>(this.pool, `
      UPDATE social_impulse_outreach_opportunities SET
        state = 'chosen', disposition = $2, destination_kind = $3,
        destination_id = $4, contact_id = $5, display_label = $6,
        channel_id = $7, channel_type = $8, dyad_id = $9,
        binding_hash = $10, updated_at_ms = $11
      WHERE opportunity_id = $1 AND state = 'pending' AND binding_hash IS NULL
      RETURNING ${COLUMNS}
    `, [
      input.opportunityId,
      input.disposition,
      destination?.kind ?? null,
      destination?.destinationId ?? null,
      destination && 'contactId' in destination ? destination.contactId : null,
      destination?.displayLabel ?? null,
      destination?.channelId ?? null,
      destination?.channelType ?? null,
      destination?.dyadId ?? null,
      input.bindingHash,
      input.claimedAtMs,
    ]);
    if (row) return { outcome: 'claimed', record: mapRow(row) };
    const prior = await this.getOpportunity(input.opportunityId);
    if (!prior) return { outcome: 'unavailable' };
    return prior.bindingHash === input.bindingHash
      ? { outcome: 'replayed', record: prior }
      : { outcome: 'conflict', record: prior };
  }

  async finalize(input: {
    opportunityId: string;
    bindingHash: string;
    state: Exclude<SocialImpulseOutreachState, 'pending' | 'chosen'>;
    reasonCode?: string;
    finalizedAtMs: number;
  }): Promise<SocialImpulseOutreachRecord> {
    const row = await queryOne<OutreachRow>(this.pool, `
      UPDATE social_impulse_outreach_opportunities SET
        state = $3, reason_code = $4, updated_at_ms = $5
      WHERE opportunity_id = $1 AND binding_hash = $2
        AND state IN ('chosen', $3)
      RETURNING ${COLUMNS}
    `, [
      input.opportunityId,
      input.bindingHash,
      input.state,
      input.reasonCode ?? null,
      input.finalizedAtMs,
    ]);
    if (!row) throw new Error('social impulse disposition finalization lost its durable claim');
    return mapRow(row);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function mapRow(row: OutreachRow): SocialImpulseOutreachRecord {
  const state = parseState(row.state);
  const disposition = row.disposition === null ? null : parseDisposition(row.disposition);
  return {
    schemaVersion: 1,
    opportunityId: row.opportunity_id,
    companionId: requireUuid(row.companion_id, 'companion_id'),
    impulseDedupeKey: row.impulse_dedupe_key,
    firstCrossingMs: requireSafeInteger(row.first_crossing_ms, 'socialImpulse.firstCrossingMs'),
    firedAtMs: requireSafeInteger(row.fired_at_ms, 'socialImpulse.firedAtMs'),
    modeAtCreation: parseMode(row.mode_at_creation),
    state,
    disposition,
    destination: mapDestination(row),
    bindingHash: row.binding_hash,
    reasonCode: row.reason_code,
    createdAtMs: requireSafeInteger(row.created_at_ms, 'socialImpulse.createdAtMs'),
    updatedAtMs: requireSafeInteger(row.updated_at_ms, 'socialImpulse.updatedAtMs'),
  };
}

function mapDestination(row: OutreachRow): SocialImpulseOutreachDestination | null {
  if (row.destination_kind === null) return null;
  if (!row.destination_id || !row.display_label || !row.channel_type) {
    throw new Error('persisted social impulse destination is incomplete');
  }
  switch (row.destination_kind) {
    case 'human_dm':
      if (!row.contact_id || !row.channel_id || row.channel_type !== 'discord') {
        throw new Error('persisted human destination is incomplete');
      }
      return {
        kind: 'human_dm', destinationId: row.destination_id, contactId: row.contact_id,
        displayLabel: row.display_label, channelId: row.channel_id,
        channelType: 'discord',
        dyadId: null,
      };
    case 'open_companion_dyad':
      if (!row.contact_id || !row.channel_id || row.channel_type !== 'companion' || !row.dyad_id) {
        throw new Error('persisted open companion destination is incomplete');
      }
      if (parseCompanionChannelId(row.channel_id)?.kind !== 'dm') {
        throw new Error('persisted open companion destination is not a companion DM');
      }
      return {
        kind: 'open_companion_dyad', destinationId: row.destination_id,
        contactId: row.contact_id, displayLabel: row.display_label,
        channelId: row.channel_id, channelType: 'companion',
        dyadId: requireUuid(row.dyad_id, 'dyad_id'),
      };
    case 'companion_first_contact':
      if (!row.contact_id || row.channel_id !== null || row.channel_type !== 'companion') {
        throw new Error('persisted first-contact destination is incomplete');
      }
      return {
        kind: 'companion_first_contact', destinationId: row.destination_id,
        contactId: row.contact_id, displayLabel: row.display_label,
        channelId: null, channelType: 'companion', dyadId: null,
      };
    case 'room':
      if (!row.channel_id || (row.channel_type !== 'discord' && row.channel_type !== 'buzz')) {
        throw new Error('persisted room destination is incomplete');
      }
      return {
        kind: 'room', destinationId: row.destination_id, displayLabel: row.display_label,
        channelId: row.channel_id, channelType: row.channel_type, dyadId: null,
      };
    default:
      throw new Error(`unknown social impulse destination kind ${row.destination_kind}`);
  }
}

function parseState(value: string): SocialImpulseOutreachState {
  const states: readonly SocialImpulseOutreachState[] = [
    'pending', 'chosen', 'off', 'ignore', 'defer', 'other',
    'would_send', 'delivered', 'suppressed',
  ];
  if (!states.includes(value as SocialImpulseOutreachState)) {
    throw new Error(`unknown social impulse outreach state ${value}`);
  }
  return value as SocialImpulseOutreachState;
}

function parseDisposition(value: string): SocialImpulseDisposition {
  const dispositions: readonly SocialImpulseDisposition[] = [
    'ignore', 'defer', 'contact-human', 'contact-companion', 'join-room', 'other',
  ];
  if (!dispositions.includes(value as SocialImpulseDisposition)) {
    throw new Error(`unknown social impulse disposition ${value}`);
  }
  return value as SocialImpulseDisposition;
}

function parseMode(value: string): 'off' | 'shadow' | 'on' {
  if (value !== 'off' && value !== 'shadow' && value !== 'on') {
    throw new Error(`unknown social impulse outreach mode ${value}`);
  }
  return value;
}

function requireUuid(value: string, field: string): string {
  if (!isRfc4122Uuid(value)) throw new Error(`persisted social impulse ${field} is invalid`);
  return value;
}
