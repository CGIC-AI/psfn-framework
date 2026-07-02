import type { Pool } from 'pg';
import { queryOne, queryRows } from './connection.js';
import { toNumber } from './shared.js';
import type {
  WeightedThoughtListOptions,
  WeightedThoughtStorePortBackend,
} from '../weighted-thought-store-port.js';
import {
  resolveNudgeState,
  resolveThoughtClass,
  type ThoughtContextMultipliers,
  type ThoughtProvenance,
  type ThoughtWeight,
} from '../weighted-thoughts.js';
import { CHANNEL_TYPES, type ChannelType } from '../../../shared/contracts/runtime.js';

interface WeightedThoughtRow {
  id: string;
  content: string;
  source: string;
  thought_class: string;
  contact_id: string | null;
  base_weight: number | string;
  context_multipliers: unknown;
  accumulated_weight: number | string;
  reinforcement_count: number | string;
  decay_halflife_ms: number | string;
  created_at: string;
  last_reinforced_at: string;
  provenance: unknown;
  nudge_state: string;
  last_nudged_at: string | null;
  decline_count: number | string;
}

const SELECT_COLUMNS = `
  id, content, source, thought_class, contact_id, base_weight,
  context_multipliers, accumulated_weight, reinforcement_count,
  decay_halflife_ms, created_at, last_reinforced_at, provenance,
  nudge_state, last_nudged_at, decline_count
`;

function parseJson(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseContextMultipliers(value: unknown): ThoughtContextMultipliers {
  const raw = parseJson(value);
  return {
    repeat: toNumber(raw.repeat ?? 1) || 1,
    emotionalCharge: toNumber(raw.emotionalCharge ?? 1) || 1,
    relationship: toNumber(raw.relationship ?? 1) || 1,
  };
}

function parseChannelType(value: unknown): ChannelType | undefined {
  return typeof value === 'string' && CHANNEL_TYPES.includes(value as ChannelType)
    ? (value as ChannelType)
    : undefined;
}

function parseProvenance(value: unknown): ThoughtProvenance {
  const raw = parseJson(value);
  const provenance: ThoughtProvenance = {};
  if (typeof raw.concernId === 'string' && raw.concernId.trim()) provenance.concernId = raw.concernId.trim();
  if (typeof raw.pendingFollowUpId === 'string' && raw.pendingFollowUpId.trim()) {
    provenance.pendingFollowUpId = raw.pendingFollowUpId.trim();
  }
  if (typeof raw.sourceChannelId === 'string' && raw.sourceChannelId.trim()) {
    provenance.sourceChannelId = raw.sourceChannelId.trim();
  }
  const channelType = parseChannelType(raw.sourceChannelType);
  if (channelType) provenance.sourceChannelType = channelType;
  return provenance;
}

function mapRow(row: WeightedThoughtRow): ThoughtWeight {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    thoughtClass: resolveThoughtClass(row.thought_class),
    ...(row.contact_id ? { contactId: row.contact_id } : {}),
    baseWeight: toNumber(row.base_weight),
    contextMultipliers: parseContextMultipliers(row.context_multipliers),
    accumulatedWeight: toNumber(row.accumulated_weight),
    reinforcementCount: Math.max(0, Math.floor(toNumber(row.reinforcement_count))),
    decayHalflifeMs: toNumber(row.decay_halflife_ms),
    createdAt: row.created_at,
    lastReinforcedAt: row.last_reinforced_at,
    provenance: parseProvenance(row.provenance),
    nudgeState: resolveNudgeState(row.nudge_state),
    ...(row.last_nudged_at ? { lastNudgedAt: row.last_nudged_at } : {}),
    declineCount: Math.max(0, Math.floor(toNumber(row.decline_count))),
  };
}

export class PostgresWeightedThoughtStore implements WeightedThoughtStorePortBackend {
  private cache = new Map<string, ThoughtWeight>();

  constructor(private readonly pool: Pool) {}

  async hydrateCache(): Promise<void> {
    const rows = await queryRows<WeightedThoughtRow>(
      this.pool,
      `SELECT ${SELECT_COLUMNS} FROM weighted_thoughts`,
    );
    this.cache = new Map(rows.map((row) => {
      const thought = mapRow(row);
      return [thought.id, thought] as const;
    }));
  }

  snapshotActiveThoughts(contactId?: string): ThoughtWeight[] {
    const normalizedContactId = contactId?.trim() || undefined;
    return [...this.cache.values()]
      .filter((thought) => thought.nudgeState !== 'accepted')
      .filter((thought) => (
        !normalizedContactId || !thought.contactId || thought.contactId === normalizedContactId
      ))
      .map((thought) => ({ ...thought }));
  }

  async save(thought: ThoughtWeight): Promise<ThoughtWeight> {
    const row = await queryOne<WeightedThoughtRow>(
      this.pool,
      `
        INSERT INTO weighted_thoughts (
          id, content, source, thought_class, contact_id, base_weight,
          context_multipliers, accumulated_weight, reinforcement_count,
          decay_halflife_ms, created_at, last_reinforced_at, provenance,
          nudge_state, last_nudged_at, decline_count
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16
        )
        ON CONFLICT (id) DO UPDATE SET
          content = excluded.content,
          source = excluded.source,
          thought_class = excluded.thought_class,
          contact_id = excluded.contact_id,
          base_weight = excluded.base_weight,
          context_multipliers = excluded.context_multipliers,
          accumulated_weight = excluded.accumulated_weight,
          reinforcement_count = excluded.reinforcement_count,
          decay_halflife_ms = excluded.decay_halflife_ms,
          last_reinforced_at = excluded.last_reinforced_at,
          provenance = excluded.provenance,
          nudge_state = excluded.nudge_state,
          last_nudged_at = excluded.last_nudged_at,
          decline_count = excluded.decline_count
        RETURNING ${SELECT_COLUMNS}
      `,
      [
        thought.id,
        thought.content,
        thought.source,
        thought.thoughtClass,
        thought.contactId ?? null,
        thought.baseWeight,
        JSON.stringify(thought.contextMultipliers),
        thought.accumulatedWeight,
        Math.max(0, Math.floor(thought.reinforcementCount)),
        thought.decayHalflifeMs,
        thought.createdAt,
        thought.lastReinforcedAt,
        JSON.stringify(thought.provenance),
        thought.nudgeState,
        thought.lastNudgedAt ?? null,
        Math.max(0, Math.floor(thought.declineCount)),
      ],
    );
    if (!row) {
      throw new Error(`Failed to persist weighted thought "${thought.id}"`);
    }
    const persisted = mapRow(row);
    this.cache.set(persisted.id, persisted);
    return persisted;
  }

  async getById(id: string): Promise<ThoughtWeight | null> {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const row = await queryOne<WeightedThoughtRow>(
      this.pool,
      `SELECT ${SELECT_COLUMNS} FROM weighted_thoughts WHERE id = $1`,
      [normalizedId],
    );
    if (!row) {
      this.cache.delete(normalizedId);
      return null;
    }
    const thought = mapRow(row);
    this.cache.set(thought.id, thought);
    return thought;
  }

  async list(options: WeightedThoughtListOptions = {}): Promise<ThoughtWeight[]> {
    const params: unknown[] = [];
    const whereClauses: string[] = [];
    if (options.activeOnly === true) {
      whereClauses.push(`nudge_state <> 'accepted'`);
    }
    const normalizedContactId = options.contactId?.trim();
    if (normalizedContactId) {
      params.push(normalizedContactId);
      whereClauses.push(`(contact_id IS NULL OR contact_id = $${params.length})`);
    }
    const limit = typeof options.limit === 'number' && options.limit > 0
      ? Math.floor(options.limit)
      : 200;
    params.push(limit);
    const rows = await queryRows<WeightedThoughtRow>(
      this.pool,
      `
        SELECT ${SELECT_COLUMNS}
        FROM weighted_thoughts
        ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
        ORDER BY accumulated_weight DESC, last_reinforced_at DESC, id ASC
        LIMIT $${params.length}
      `,
      params,
    );
    return rows.map(mapRow);
  }

  async delete(id: string): Promise<boolean> {
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    const row = await queryOne<{ id: string }>(
      this.pool,
      `DELETE FROM weighted_thoughts WHERE id = $1 RETURNING id`,
      [normalizedId],
    );
    this.cache.delete(normalizedId);
    return Boolean(row);
  }
}
