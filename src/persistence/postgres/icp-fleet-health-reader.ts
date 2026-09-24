import type { Pool, QueryResultRow } from 'pg';

import {
  ICP_AVAILABILITY_STATES,
  type IcpAvailabilityState,
} from '../../shared/contracts/icp-autonomy.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import { createPostgresPool, queryRows } from '../postgres.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';

/**
 * Content-free, bounded read of the gateway-owned ICP control plane for the
 * Fleet page (h248l.4). It reads only shared-schema coordination rows —
 * availability leases, lifecycle fences, open episode participant sets, and
 * delivered-turn counts — and never a tenant schema, contact identifier,
 * permit/candidate ID, reason code, or transcript.
 */
const ICP_FLEET_HEALTH_READ_PROTOCOL = Object.freeze({
  maxCompanions: 256,
  maxOpenEpisodes: 1_024,
  // Every unordered pair of a maxCompanions roster: the grouped read cannot truncate.
  maxPairRows: 32_640,
});

interface IcpFleetHealthAvailability {
  readonly state: IcpAvailabilityState;
  readonly expiresAtMs: number;
}

interface IcpFleetHealthOpenEpisode {
  readonly participantCompanionIds: readonly string[];
}

interface IcpFleetHealthPairVolume {
  readonly firstCompanionId: string;
  readonly secondCompanionId: string;
  readonly deliveredTurns: number;
}

export interface IcpFleetHealthRead {
  readonly availability: ReadonlyMap<string, IcpFleetHealthAvailability>;
  readonly lifecycleFenced: ReadonlySet<string>;
  readonly openEpisodes: readonly IcpFleetHealthOpenEpisode[];
  /** True when more active episodes existed than the bounded read returned. */
  readonly openEpisodesTruncated: boolean;
  readonly pairVolume: readonly IcpFleetHealthPairVolume[];
}

export interface IcpFleetHealthReadPort {
  read(input: {
    readonly companionIds: readonly string[];
    readonly nowMs: number;
    readonly deliveredSinceMs: number;
  }): Promise<IcpFleetHealthRead>;
  close(): Promise<void>;
}

interface AvailabilityRow extends QueryResultRow {
  companion_id: unknown;
  state: unknown;
  expires_at_ms: unknown;
}

interface FenceRow extends QueryResultRow {
  companion_id: unknown;
}

interface EpisodeRow extends QueryResultRow {
  participant_companion_ids: unknown;
}

interface PairRow extends QueryResultRow {
  first_companion_id: unknown;
  second_companion_id: unknown;
  delivered_turns: unknown;
}

function uuid(value: unknown, field: string): string {
  if (!isRfc4122Uuid(value)) throw new Error(`ICP fleet health ${field} is not a companion UUID`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`ICP fleet health ${field} is not a non-negative integer`);
  }
  return parsed;
}

function availabilityState(value: unknown): IcpAvailabilityState {
  if (typeof value !== 'string'
    || !(ICP_AVAILABILITY_STATES as readonly string[]).includes(value)) {
    throw new Error('ICP fleet health availability state is invalid');
  }
  return value as IcpAvailabilityState;
}

function normalizeCompanionIds(input: readonly string[]): string[] {
  if (input.length === 0 || input.length > ICP_FLEET_HEALTH_READ_PROTOCOL.maxCompanions) {
    throw new Error('ICP fleet health read requires a bounded non-empty companion set');
  }
  const ids = new Set<string>();
  for (const id of input) ids.add(uuid(id, 'request companion'));
  return [...ids].sort();
}

async function readIcpFleetHealth(
  pool: Pool,
  input: Parameters<IcpFleetHealthReadPort['read']>[0],
): Promise<IcpFleetHealthRead> {
  const companionIds = normalizeCompanionIds(input.companionIds);
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.deliveredSinceMs)
    || input.deliveredSinceMs > input.nowMs) {
    throw new Error('ICP fleet health read requires an ordered integer time window');
  }
  const [availabilityRows, fenceRows, episodeRows, pairRows] = await Promise.all([
    queryRows<AvailabilityRow>(pool, `
      SELECT companion_id, state, expires_at_ms
      FROM icp_availability_leases
      WHERE companion_id = ANY($1::uuid[]) AND expires_at_ms > $2
    `, [companionIds, input.nowMs]),
    queryRows<FenceRow>(pool, `
      SELECT companion_id
      FROM icp_autonomy_invalidation_fences
      WHERE companion_id = ANY($1::uuid[]) AND lifecycle_fenced = TRUE
    `, [companionIds]),
    queryRows<EpisodeRow>(pool, `
      SELECT participant_companion_ids
      FROM icp_conversation_episodes
      WHERE status = 'active'
      ORDER BY last_activity_at_ms DESC, conversation_id
      LIMIT $1
    `, [ICP_FLEET_HEALTH_READ_PROTOCOL.maxOpenEpisodes + 1]),
    queryRows<PairRow>(pool, `
      SELECT LEAST(local_companion_id, peer_companion_id) AS first_companion_id,
             GREATEST(local_companion_id, peer_companion_id) AS second_companion_id,
             COUNT(*)::text AS delivered_turns
      FROM icp_fatigue_turn_reservations
      WHERE outcome = 'delivered'
        AND finalized_at_ms >= $1
        AND finalized_at_ms <= $2
        AND local_companion_id = ANY($3::uuid[])
        AND peer_companion_id = ANY($3::uuid[])
      GROUP BY 1, 2
      ORDER BY 1, 2
      LIMIT $4
    `, [
      input.deliveredSinceMs,
      input.nowMs,
      companionIds,
      ICP_FLEET_HEALTH_READ_PROTOCOL.maxPairRows,
    ]),
  ]);

  const availability = new Map<string, IcpFleetHealthAvailability>();
  for (const row of availabilityRows) {
    availability.set(uuid(row.companion_id, 'availability companion'), Object.freeze({
      state: availabilityState(row.state),
      expiresAtMs: nonNegativeInteger(row.expires_at_ms, 'availability expiry'),
    }));
  }
  const lifecycleFenced = new Set<string>();
  for (const row of fenceRows) lifecycleFenced.add(uuid(row.companion_id, 'fence companion'));

  const truncated = episodeRows.length > ICP_FLEET_HEALTH_READ_PROTOCOL.maxOpenEpisodes;
  const openEpisodes = episodeRows
    .slice(0, ICP_FLEET_HEALTH_READ_PROTOCOL.maxOpenEpisodes)
    .map((row): IcpFleetHealthOpenEpisode => {
      const participants = row.participant_companion_ids;
      if (!Array.isArray(participants) || participants.length < 2) {
        throw new Error('ICP fleet health episode participants are invalid');
      }
      return Object.freeze({
        participantCompanionIds: Object.freeze(
          participants.map(id => uuid(id, 'episode participant')),
        ),
      });
    });
  const pairVolume = pairRows.map((row): IcpFleetHealthPairVolume => Object.freeze({
    firstCompanionId: uuid(row.first_companion_id, 'pair companion'),
    secondCompanionId: uuid(row.second_companion_id, 'pair companion'),
    deliveredTurns: nonNegativeInteger(row.delivered_turns, 'delivered turns'),
  }));

  return Object.freeze({
    availability,
    lifecycleFenced,
    openEpisodes: Object.freeze(openEpisodes),
    openEpisodesTruncated: truncated,
    pairVolume: Object.freeze(pairVolume),
  });
}

export class PostgresIcpFleetHealthReader implements IcpFleetHealthReadPort {
  private constructor(private readonly pool: Pool) {}

  static connect(databaseUrl: string): PostgresIcpFleetHealthReader {
    return new PostgresIcpFleetHealthReader(createPostgresPool(databaseUrl, {
      applicationName: 'icp-fleet-health',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
    }));
  }

  async read(input: Parameters<IcpFleetHealthReadPort['read']>[0]): Promise<IcpFleetHealthRead> {
    return await readIcpFleetHealth(this.pool, input);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
