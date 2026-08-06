import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  IcpAutonomyInvalidationConflictError,
  IcpOutstandingInvitationConflictError,
  IcpPermitRevocationConflictError,
  type IcpAutonomyInvalidationFence,
  type IcpPermitConsumptionInput,
  type IcpPermitConsumptionResult,
  type IcpSharedAutonomyStorePort,
  type IcpConversationTransitionInput,
} from '../../core/icp/autonomy-store-ports.js';
import {
  ICP_AUTONOMY_REASON_CODES,
  assertIcpConversationActivityTransition,
  assertIcpConversationStatusTransition,
  parseIcpAvailabilityLease,
  parseIcpConversationEpisode,
  parseIcpInitiationPermit,
  type IcpAutonomyReasonCode,
  type IcpAvailabilityLease,
  type IcpAvailabilitySource,
  type IcpConversationEpisode,
  type IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  createPostgresPool,
  executeQuery,
  queryOne,
  queryRows,
  withPostgresClient,
} from '../postgres.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';
import {
  requirePositiveSafeInteger as requirePositiveInteger,
  requireSafeInteger as safeInteger,
  requireUuid,
} from './row-guards.js';

interface AvailabilityRow extends QueryResultRow {
  companion_id: string;
  state: string;
  issued_at_ms: string | number;
  expires_at_ms: string | number;
  source: string;
  revision: string | number;
}

interface ConversationRow extends QueryResultRow {
  conversation_id: string;
  channel_id: string;
  participant_companion_ids: unknown;
  root_initiation_id: string;
  initiated_by_companion_id: string;
  initiation_source: string;
  provenance_ref: string;
  opened_at_ms: string | number;
  last_activity_at_ms: string | number;
  status: string;
  close_reason_code: string | null;
  revision: string | number;
}

interface PermitRow extends QueryResultRow {
  permit_id: string;
  candidate_id: string;
  conversation_id: string;
  sender_companion_id: string;
  recipient_companion_id: string;
  channel_id: string;
  provenance_ref: string;
  issued_at_ms: string | number;
  expires_at_ms: string | number;
  status: string;
  consumed_at_ms: string | number | null;
  revoked_at_ms: string | number | null;
  reason_code: string | null;
  revision: string | number;
}

interface InvalidationFenceRow extends QueryResultRow {
  companion_id: string;
  generation: string | number;
  invalidated_at_ms: string | number | null;
  last_reason_code: string | null;
}

const AVAILABILITY_COLUMNS =
  'companion_id, state, issued_at_ms, expires_at_ms, source, revision';
const CONVERSATION_COLUMNS = `
  conversation_id, channel_id, participant_companion_ids, root_initiation_id,
  initiated_by_companion_id, initiation_source, provenance_ref, opened_at_ms,
  last_activity_at_ms, status, close_reason_code, revision
`;
const PERMIT_COLUMNS = `
  permit_id, candidate_id, conversation_id, sender_companion_id,
  recipient_companion_id, channel_id, provenance_ref, issued_at_ms,
  expires_at_ms, status, consumed_at_ms, revoked_at_ms, reason_code, revision
`;
const INVALIDATION_FENCE_COLUMNS = `
  companion_id, generation, invalidated_at_ms, last_reason_code
`;
const PUBLISH_AVAILABILITY_SQL = `
  INSERT INTO icp_availability_leases (
    companion_id, state, issued_at_ms, expires_at_ms, source, revision
  )
  SELECT $1::uuid, $2::text, $3::bigint, $4::bigint, $5::text, $6::bigint
  WHERE $6::bigint = 1 OR EXISTS (
    SELECT 1 FROM icp_availability_leases
    WHERE companion_id = $1
      AND (
        (
          revision + 1 = $6
          AND (
            $5::text = 'operator'
            OR source <> 'operator'
            OR expires_at_ms <= $3
          )
        )
        OR (
          $5::text = 'operator'
          AND source <> 'operator'
          AND revision = $6
        )
      )
  )
  ON CONFLICT (companion_id) DO UPDATE SET
    state = EXCLUDED.state,
    issued_at_ms = EXCLUDED.issued_at_ms,
    expires_at_ms = EXCLUDED.expires_at_ms,
    source = EXCLUDED.source,
    revision = CASE
      WHEN icp_availability_leases.revision = EXCLUDED.revision
        THEN icp_availability_leases.revision + 1
      ELSE EXCLUDED.revision
    END
  WHERE (
      icp_availability_leases.revision + 1 = EXCLUDED.revision
      AND (
        EXCLUDED.source = 'operator'
        OR icp_availability_leases.source <> 'operator'
        OR icp_availability_leases.expires_at_ms <= EXCLUDED.issued_at_ms
      )
    )
    OR (
      EXCLUDED.source = 'operator'
      AND icp_availability_leases.source <> 'operator'
      AND icp_availability_leases.revision = EXCLUDED.revision
    )
  RETURNING ${AVAILABILITY_COLUMNS}
`;
const CLEAR_AVAILABILITY_SQL = `
  DELETE FROM icp_availability_leases
  WHERE companion_id = $1 AND revision = $2
    AND (
      $3::text = 'operator'
      OR source <> 'operator'
      OR expires_at_ms <= $4
    )
`;

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer timestamp`);
  return value;
}

function requireReasonCode(value: IcpAutonomyReasonCode, field: string): IcpAutonomyReasonCode {
  if (!ICP_AUTONOMY_REASON_CODES.includes(value)) throw new Error(`${field} is not a known ICP reason code`);
  return value;
}

function normalizeKnownCompanionIds(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values)) {
    throw new Error('ICP shared autonomy store requires knownCompanionIds');
  }
  const known = new Set(values.map((value, index) => requireUuid(value, `knownCompanionIds[${index}]`)));
  if (known.size < 2) {
    throw new Error('ICP shared autonomy store requires at least two known companion IDs');
  }
  if (known.size !== values.length) {
    throw new Error('ICP shared autonomy store knownCompanionIds must not contain duplicates');
  }
  return known;
}

function mapAvailability(row: AvailabilityRow): IcpAvailabilityLease {
  return parseIcpAvailabilityLease({
    companionId: row.companion_id,
    state: row.state,
    issuedAtMs: safeInteger(row.issued_at_ms, 'availability.issuedAtMs'),
    expiresAtMs: safeInteger(row.expires_at_ms, 'availability.expiresAtMs'),
    source: row.source,
    revision: safeInteger(row.revision, 'availability.revision'),
  });
}

function mapConversation(
  row: ConversationRow,
  knownCompanionIds: ReadonlySet<string>,
): IcpConversationEpisode {
  return parseIcpConversationEpisode({
    conversationId: row.conversation_id,
    channelId: row.channel_id,
    participantCompanionIds: row.participant_companion_ids,
    rootInitiationId: row.root_initiation_id,
    initiatedByCompanionId: row.initiated_by_companion_id,
    initiationSource: row.initiation_source,
    provenanceRef: row.provenance_ref,
    openedAtMs: safeInteger(row.opened_at_ms, 'episode.openedAtMs'),
    lastActivityAtMs: safeInteger(row.last_activity_at_ms, 'episode.lastActivityAtMs'),
    status: row.status,
    ...(row.close_reason_code !== null ? { closeReasonCode: row.close_reason_code } : {}),
    revision: safeInteger(row.revision, 'episode.revision'),
  }, { knownCompanionIds });
}

function mapPermit(row: PermitRow): IcpInitiationPermit {
  return parseIcpInitiationPermit({
    permitId: row.permit_id,
    candidateId: row.candidate_id,
    conversationId: row.conversation_id,
    senderCompanionId: row.sender_companion_id,
    recipientCompanionId: row.recipient_companion_id,
    channelId: row.channel_id,
    provenanceRef: row.provenance_ref,
    issuedAtMs: safeInteger(row.issued_at_ms, 'permit.issuedAtMs'),
    expiresAtMs: safeInteger(row.expires_at_ms, 'permit.expiresAtMs'),
    status: row.status,
    ...(row.consumed_at_ms !== null
      ? { consumedAtMs: safeInteger(row.consumed_at_ms, 'permit.consumedAtMs') }
      : {}),
    ...(row.revoked_at_ms !== null
      ? { revokedAtMs: safeInteger(row.revoked_at_ms, 'permit.revokedAtMs') }
      : {}),
    ...(row.reason_code !== null ? { reasonCode: row.reason_code } : {}),
    revision: safeInteger(row.revision, 'permit.revision'),
  });
}

function validateConsumptionBinding(input: IcpPermitConsumptionInput): void {
  requireUuid(input.permitId, 'permitId');
  requireUuid(input.conversationId, 'conversationId');
  requireUuid(input.senderCompanionId, 'senderCompanionId');
  requireUuid(input.recipientCompanionId, 'recipientCompanionId');
  requireTimestamp(input.consumedAtMs, 'consumedAtMs');
  const parsed = parseCompanionChannelId(input.channelId);
  if (!parsed) throw new Error('channelId must be a canonical companion channel');
  if (input.senderCompanionId === input.recipientCompanionId) {
    throw new Error('permit consumption requires distinct companions');
  }
  if (parsed.kind === 'dm') {
    const pair = [input.senderCompanionId, input.recipientCompanionId].sort();
    if (parsed.participants[0] !== pair[0] || parsed.participants[1] !== pair[1]) {
      throw new Error('permit consumption binding does not match the DM channel');
    }
  }
}

function permitMatches(permit: IcpInitiationPermit, input: IcpPermitConsumptionInput): boolean {
  return permit.conversationId === input.conversationId
    && permit.senderCompanionId === input.senderCompanionId
    && permit.recipientCompanionId === input.recipientCompanionId
    && permit.channelId === input.channelId;
}

function normalizeFence(
  input: unknown,
  firstCompanionId: string,
  secondCompanionId: string,
): IcpAutonomyInvalidationFence {
  const pair = [
    requireUuid(firstCompanionId, 'firstCompanionId'),
    requireUuid(secondCompanionId, 'secondCompanionId'),
  ].sort();
  if (pair[0] === pair[1]) throw new Error('Invalidation fence requires distinct companions');
  if (!isRecord(input) || !Array.isArray(input.companions) || input.companions.length !== 2) {
    throw new Error('expectedInvalidationFence must contain exactly two companions');
  }
  const entries = input.companions.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`expectedInvalidationFence.companions[${index}] must be an object`);
    }
    return {
      companionId: requireUuid(entry.companionId, `expectedInvalidationFence.companions[${index}].companionId`),
      generation: requireNonNegativeInteger(
        entry.generation,
        `expectedInvalidationFence.companions[${index}].generation`,
      ),
    };
  }).sort((left, right) => left.companionId.localeCompare(right.companionId));
  if (entries[0]?.companionId !== pair[0] || entries[1]?.companionId !== pair[1]) {
    throw new Error('expectedInvalidationFence does not match permit participants');
  }
  return { companions: [entries[0], entries[1]] };
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function mapFenceRows(rows: readonly InvalidationFenceRow[]): IcpAutonomyInvalidationFence {
  if (rows.length !== 2) throw new Error('ICP invalidation fence is missing a companion row');
  const entries = rows.map(row => ({
    companionId: requireUuid(row.companion_id, 'invalidationFence.companionId'),
    generation: safeInteger(row.generation, 'invalidationFence.generation'),
  })).sort((left, right) => left.companionId.localeCompare(right.companionId));
  return { companions: [entries[0]!, entries[1]!] };
}

function fenceConflictReason(
  expected: IcpAutonomyInvalidationFence,
  actualRows: readonly InvalidationFenceRow[],
): IcpAutonomyReasonCode | null {
  const actual = new Map(actualRows.map(row => [
    row.companion_id,
    {
      generation: safeInteger(row.generation, 'invalidationFence.generation'),
      reasonCode: row.last_reason_code,
    },
  ]));
  for (const entry of expected.companions) {
    const current = actual.get(entry.companionId);
    if (!current) throw new Error(`ICP invalidation fence missing companion ${entry.companionId}`);
    if (current.generation === entry.generation) continue;
    if (!current.reasonCode || !ICP_AUTONOMY_REASON_CODES.includes(current.reasonCode as IcpAutonomyReasonCode)) {
      throw new Error(`ICP invalidation fence has invalid reason for ${entry.companionId}`);
    }
    return current.reasonCode as IcpAutonomyReasonCode;
  }
  return null;
}

async function lockInvalidationFence(
  client: PoolClient,
  expectedInput: IcpAutonomyInvalidationFence,
  firstCompanionId: string,
  secondCompanionId: string,
): Promise<IcpAutonomyReasonCode | null> {
  const expected = normalizeFence(expectedInput, firstCompanionId, secondCompanionId);
  const ids = expected.companions.map(entry => entry.companionId);
  const result = await client.query<InvalidationFenceRow>(`
    SELECT ${INVALIDATION_FENCE_COLUMNS}
    FROM icp_autonomy_invalidation_fences
    WHERE companion_id = ANY($1::uuid[])
    ORDER BY companion_id
    FOR UPDATE
  `, [ids]);
  if (result.rows.length !== 2) throw new Error('ICP invalidation fence is missing a companion row');
  return fenceConflictReason(expected, result.rows);
}

async function invalidateCompanionWithClient(
  client: PoolClient,
  companionId: string,
  revokedAtMs: number,
  reasonCode: IcpAutonomyReasonCode,
): Promise<IcpInitiationPermit[]> {
  const fenceResult = await client.query<InvalidationFenceRow>(`
    UPDATE icp_autonomy_invalidation_fences
    SET generation = generation + 1,
        invalidated_at_ms = $2,
        last_reason_code = $3
    WHERE companion_id = $1
    RETURNING ${INVALIDATION_FENCE_COLUMNS}
  `, [companionId, revokedAtMs, reasonCode]);
  if (!fenceResult.rows.at(0)) {
    throw new Error(`ICP invalidation fence missing companion ${companionId}`);
  }
  const permitResult = await client.query<PermitRow>(`
    UPDATE icp_initiation_permits
    SET status = 'revoked', revoked_at_ms = GREATEST($2, issued_at_ms),
        reason_code = $3, revision = revision + 1
    WHERE status = 'issued'
      AND (sender_companion_id = $1 OR recipient_companion_id = $1)
    RETURNING ${PERMIT_COLUMNS}
  `, [companionId, revokedAtMs, reasonCode]);
  return permitResult.rows.map(mapPermit);
}

export class PostgresIcpSharedAutonomyStore implements IcpSharedAutonomyStorePort {
  private constructor(
    private readonly pool: Pool,
    private readonly knownCompanionIds: ReadonlySet<string>,
  ) {}

  static async connect(
    databaseUrl: string,
    options: { knownCompanionIds: readonly string[] },
  ): Promise<PostgresIcpSharedAutonomyStore> {
    const knownCompanionIds = normalizeKnownCompanionIds(options.knownCompanionIds);
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-autonomy-shared',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
    });
    try {
      const store = new PostgresIcpSharedAutonomyStore(pool, knownCompanionIds);
      await executeQuery(pool, `
        INSERT INTO icp_autonomy_invalidation_fences (companion_id, generation)
        SELECT companion_id, 0
        FROM unnest($1::uuid[]) AS companion_id
        ON CONFLICT (companion_id) DO NOTHING
      `, [[...knownCompanionIds]]);
      await store.revokeOutstandingPermitsOutsideFleet(
        [...knownCompanionIds],
        Date.now(),
      );
      return store;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async publishAvailability(leaseInput: IcpAvailabilityLease): Promise<IcpAvailabilityLease> {
    const lease = parseIcpAvailabilityLease(leaseInput);
    const row = await queryOne<AvailabilityRow>(this.pool, PUBLISH_AVAILABILITY_SQL, [
      lease.companionId,
      lease.state,
      lease.issuedAtMs,
      lease.expiresAtMs,
      lease.source,
      lease.revision,
    ]);
    if (!row) throw new Error(`ICP availability revision conflict for ${lease.companionId}`);
    return mapAvailability(row);
  }

  async publishAvailabilityAndInvalidate(
    leaseInput: IcpAvailabilityLease,
    reasonCodeInput: IcpAutonomyReasonCode,
  ): Promise<{ lease: IcpAvailabilityLease; revokedPermits: IcpInitiationPermit[] }> {
    const lease = parseIcpAvailabilityLease(leaseInput);
    const reasonCode = requireReasonCode(reasonCodeInput, 'reasonCode');
    return await withPostgresClient(this.pool, async client => {
      const revokedPermits = await invalidateCompanionWithClient(
        client,
        lease.companionId,
        lease.issuedAtMs,
        reasonCode,
      );
      const result = await client.query<AvailabilityRow>(PUBLISH_AVAILABILITY_SQL, [
        lease.companionId,
        lease.state,
        lease.issuedAtMs,
        lease.expiresAtMs,
        lease.source,
        lease.revision,
      ]);
      const row = result.rows.at(0);
      if (!row) throw new Error(`ICP availability revision conflict for ${lease.companionId}`);
      return { lease: mapAvailability(row), revokedPermits };
    });
  }

  async getAvailability(companionId: string): Promise<IcpAvailabilityLease | null> {
    const normalizedId = requireUuid(companionId, 'companionId');
    const row = await queryOne<AvailabilityRow>(this.pool, `
      SELECT ${AVAILABILITY_COLUMNS}
      FROM icp_availability_leases
      WHERE companion_id = $1
    `, [normalizedId]);
    return row ? mapAvailability(row) : null;
  }

  async clearAvailability(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilitySource; nowMs: number },
  ): Promise<boolean> {
    const result = await executeQuery(this.pool, CLEAR_AVAILABILITY_SQL, [
      requireUuid(companionId, 'companionId'),
      requirePositiveInteger(expectedRevision, 'expectedRevision'),
      request.source,
      requireTimestamp(request.nowMs, 'nowMs'),
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async clearAvailabilityAndInvalidate(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilitySource; nowMs: number },
    reasonCodeInput: IcpAutonomyReasonCode,
  ): Promise<{ cleared: boolean; revokedPermits: IcpInitiationPermit[] }> {
    const normalizedCompanionId = requireUuid(companionId, 'companionId');
    const normalizedExpectedRevision = requirePositiveInteger(expectedRevision, 'expectedRevision');
    const normalizedNowMs = requireTimestamp(request.nowMs, 'nowMs');
    const reasonCode = requireReasonCode(reasonCodeInput, 'reasonCode');
    return await withPostgresClient(this.pool, async client => {
      const fenceResult = await client.query<InvalidationFenceRow>(`
        SELECT ${INVALIDATION_FENCE_COLUMNS}
        FROM icp_autonomy_invalidation_fences
        WHERE companion_id = $1
        FOR UPDATE
      `, [normalizedCompanionId]);
      if (!fenceResult.rows.at(0)) {
        throw new Error(`ICP invalidation fence missing companion ${normalizedCompanionId}`);
      }
      const clearResult = await client.query(CLEAR_AVAILABILITY_SQL, [
        normalizedCompanionId,
        normalizedExpectedRevision,
        request.source,
        normalizedNowMs,
      ]);
      if ((clearResult.rowCount ?? 0) === 0) return { cleared: false, revokedPermits: [] };
      const revokedPermits = await invalidateCompanionWithClient(
        client,
        normalizedCompanionId,
        normalizedNowMs,
        reasonCode,
      );
      return { cleared: true, revokedPermits };
    });
  }

  async createEpisode(episodeInput: IcpConversationEpisode): Promise<IcpConversationEpisode> {
    const episode = parseIcpConversationEpisode(episodeInput, {
      knownCompanionIds: this.knownCompanionIds,
    });
    if (episode.status !== 'invited' || episode.revision !== 1) {
      throw new Error('A new ICP conversation episode must start invited at revision 1');
    }
    const row = await queryOne<ConversationRow>(this.pool, `
      INSERT INTO icp_conversation_episodes (
        conversation_id, channel_id, participant_companion_ids, root_initiation_id,
        initiated_by_companion_id, initiation_source, provenance_ref, opened_at_ms,
        last_activity_at_ms, status, close_reason_code, revision
      ) VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING ${CONVERSATION_COLUMNS}
    `, [
      episode.conversationId,
      episode.channelId,
      episode.participantCompanionIds,
      episode.rootInitiationId,
      episode.initiatedByCompanionId,
      episode.initiationSource,
      episode.provenanceRef,
      episode.openedAtMs,
      episode.lastActivityAtMs,
      episode.status,
      episode.closeReasonCode ?? null,
      episode.revision,
    ]);
    if (!row) throw new Error(`Failed to create ICP conversation ${episode.conversationId}`);
    return mapConversation(row, this.knownCompanionIds);
  }

  async getEpisode(conversationId: string): Promise<IcpConversationEpisode | null> {
    const row = await queryOne<ConversationRow>(this.pool, `
      SELECT ${CONVERSATION_COLUMNS}
      FROM icp_conversation_episodes
      WHERE conversation_id = $1
    `, [requireUuid(conversationId, 'conversationId')]);
    return row ? mapConversation(row, this.knownCompanionIds) : null;
  }

  async transitionEpisode(input: IcpConversationTransitionInput): Promise<IcpConversationEpisode> {
    assertIcpConversationStatusTransition(input.expectedStatus, input.status);
    assertIcpConversationActivityTransition(
      input.expectedLastActivityAtMs,
      input.lastActivityAtMs,
    );
    const reasonCode = input.closeReasonCode === undefined
      ? null
      : requireReasonCode(input.closeReasonCode, 'closeReasonCode');
    const row = await queryOne<ConversationRow>(this.pool, `
      UPDATE icp_conversation_episodes
      SET status = $5,
          last_activity_at_ms = $6,
          close_reason_code = $7,
          revision = revision + 1
      WHERE conversation_id = $1 AND status = $2 AND revision = $3
        AND last_activity_at_ms = $4
        AND $6 >= last_activity_at_ms
      RETURNING ${CONVERSATION_COLUMNS}
    `, [
      requireUuid(input.conversationId, 'conversationId'),
      input.expectedStatus,
      requirePositiveInteger(input.expectedRevision, 'expectedRevision'),
      requireTimestamp(input.expectedLastActivityAtMs, 'expectedLastActivityAtMs'),
      input.status,
      requireTimestamp(input.lastActivityAtMs, 'lastActivityAtMs'),
      reasonCode,
    ]);
    if (!row) throw new Error(`ICP conversation transition conflict for ${input.conversationId}`);
    return mapConversation(row, this.knownCompanionIds);
  }

  async captureInvalidationFence(
    firstCompanionId: string,
    secondCompanionId: string,
  ): Promise<IcpAutonomyInvalidationFence> {
    const first = requireUuid(firstCompanionId, 'firstCompanionId');
    const second = requireUuid(secondCompanionId, 'secondCompanionId');
    if (first === second) throw new Error('Invalidation fence requires distinct companions');
    const rows = await queryRows<InvalidationFenceRow>(this.pool, `
      SELECT ${INVALIDATION_FENCE_COLUMNS}
      FROM icp_autonomy_invalidation_fences
      WHERE companion_id = ANY($1::uuid[])
      ORDER BY companion_id
    `, [[first, second]]);
    return mapFenceRows(rows);
  }

  async issuePermit(input: {
    permit: IcpInitiationPermit;
    expectedInvalidationFence: IcpAutonomyInvalidationFence;
  }): Promise<IcpInitiationPermit> {
    const permit = parseIcpInitiationPermit(input.permit);
    if (permit.status !== 'issued' || permit.revision !== 1) {
      throw new Error('A new ICP initiation permit must start issued at revision 1');
    }
    return await withPostgresClient(this.pool, async client => {
      const invalidationReason = await lockInvalidationFence(
        client,
        input.expectedInvalidationFence,
        permit.senderCompanionId,
        permit.recipientCompanionId,
      );
      if (invalidationReason) throw new IcpAutonomyInvalidationConflictError(invalidationReason);
      // Lazy expiry and issuance share the same pair fence lock. The partial
      // unique index then makes opposite-direction invitations race-safe.
      await client.query(`
        UPDATE icp_initiation_permits
        SET status = 'expired', reason_code = 'permit_expired', revision = revision + 1
        WHERE status = 'issued' AND expires_at_ms <= $3
          AND LEAST(sender_companion_id, recipient_companion_id) = LEAST($1::uuid, $2::uuid)
          AND GREATEST(sender_companion_id, recipient_companion_id) = GREATEST($1::uuid, $2::uuid)
      `, [permit.senderCompanionId, permit.recipientCompanionId, permit.issuedAtMs]);
      const result = await client.query<PermitRow>(`
        INSERT INTO icp_initiation_permits (
          permit_id, candidate_id, conversation_id, sender_companion_id,
          recipient_companion_id, channel_id, provenance_ref, issued_at_ms,
          expires_at_ms, status, consumed_at_ms, revoked_at_ms, reason_code, revision
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, NULL, $11
        FROM icp_conversation_episodes
        WHERE conversation_id = $3
          AND channel_id = $6
          AND participant_companion_ids @> ARRAY[$4::uuid, $5::uuid]
          AND status = 'invited'
        ON CONFLICT DO NOTHING
        RETURNING ${PERMIT_COLUMNS}
      `, [
        permit.permitId,
        permit.candidateId,
        permit.conversationId,
        permit.senderCompanionId,
        permit.recipientCompanionId,
        permit.channelId,
        permit.provenanceRef,
        permit.issuedAtMs,
        permit.expiresAtMs,
        permit.status,
        permit.revision,
      ]);
      const row = result.rows.at(0);
      if (!row) {
        const sameCandidate = await client.query<PermitRow>(`
          SELECT ${PERMIT_COLUMNS}
          FROM icp_initiation_permits
          WHERE candidate_id = $1
          LIMIT 1
        `, [permit.candidateId]);
        if (sameCandidate.rows.at(0)) throw new IcpOutstandingInvitationConflictError();
        const outstanding = await client.query<PermitRow>(`
          SELECT ${PERMIT_COLUMNS}
          FROM icp_initiation_permits
          WHERE status = 'issued' AND issued_at_ms <= $3 AND expires_at_ms > $3
            AND LEAST(sender_companion_id, recipient_companion_id) = LEAST($1::uuid, $2::uuid)
            AND GREATEST(sender_companion_id, recipient_companion_id) = GREATEST($1::uuid, $2::uuid)
          LIMIT 1
        `, [permit.senderCompanionId, permit.recipientCompanionId, permit.issuedAtMs]);
        if (outstanding.rows.at(0)) throw new IcpOutstandingInvitationConflictError();
        throw new Error('ICP permit conversation/channel/participant/candidate binding mismatch');
      }
      return mapPermit(row);
    });
  }

  async createEpisodeAndIssuePermit(input: {
    episode: IcpConversationEpisode;
    permit: IcpInitiationPermit;
    expectedInvalidationFence: IcpAutonomyInvalidationFence;
  }): Promise<{ episode: IcpConversationEpisode; permit: IcpInitiationPermit }> {
    const episode = parseIcpConversationEpisode(input.episode, {
      knownCompanionIds: this.knownCompanionIds,
    });
    const permit = parseIcpInitiationPermit(input.permit);
    if (episode.status !== 'invited' || episode.revision !== 1) {
      throw new Error('A new ICP conversation episode must start invited at revision 1');
    }
    if (permit.status !== 'issued' || permit.revision !== 1) {
      throw new Error('A new ICP initiation permit must start issued at revision 1');
    }
    if (permit.conversationId !== episode.conversationId
      || permit.channelId !== episode.channelId
      || permit.senderCompanionId !== episode.initiatedByCompanionId
      || !episode.participantCompanionIds.includes(permit.senderCompanionId)
      || !episode.participantCompanionIds.includes(permit.recipientCompanionId)
      || permit.provenanceRef !== episode.provenanceRef
      || permit.issuedAtMs !== episode.openedAtMs) {
      throw new Error('ICP atomic episode/permit binding mismatch');
    }

    return await withPostgresClient(this.pool, async client => {
      const invalidationReason = await lockInvalidationFence(
        client,
        input.expectedInvalidationFence,
        permit.senderCompanionId,
        permit.recipientCompanionId,
      );
      if (invalidationReason) throw new IcpAutonomyInvalidationConflictError(invalidationReason);
      await client.query(`
        UPDATE icp_initiation_permits
        SET status = 'expired', reason_code = 'permit_expired', revision = revision + 1
        WHERE status = 'issued' AND expires_at_ms <= $3
          AND LEAST(sender_companion_id, recipient_companion_id) = LEAST($1::uuid, $2::uuid)
          AND GREATEST(sender_companion_id, recipient_companion_id) = GREATEST($1::uuid, $2::uuid)
      `, [permit.senderCompanionId, permit.recipientCompanionId, permit.issuedAtMs]);

      const episodeResult = await client.query<ConversationRow>(`
        INSERT INTO icp_conversation_episodes (
          conversation_id, channel_id, participant_companion_ids, root_initiation_id,
          initiated_by_companion_id, initiation_source, provenance_ref, opened_at_ms,
          last_activity_at_ms, status, close_reason_code, revision
        ) VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING ${CONVERSATION_COLUMNS}
      `, [
        episode.conversationId,
        episode.channelId,
        episode.participantCompanionIds,
        episode.rootInitiationId,
        episode.initiatedByCompanionId,
        episode.initiationSource,
        episode.provenanceRef,
        episode.openedAtMs,
        episode.lastActivityAtMs,
        episode.status,
        episode.closeReasonCode ?? null,
        episode.revision,
      ]);

      const permitResult = await client.query<PermitRow>(`
        INSERT INTO icp_initiation_permits (
          permit_id, candidate_id, conversation_id, sender_companion_id,
          recipient_companion_id, channel_id, provenance_ref, issued_at_ms,
          expires_at_ms, status, consumed_at_ms, revoked_at_ms, reason_code, revision
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, NULL, $11
        FROM icp_conversation_episodes
        WHERE conversation_id = $3
          AND channel_id = $6
          AND participant_companion_ids @> ARRAY[$4::uuid, $5::uuid]
          AND status = 'invited'
        ON CONFLICT DO NOTHING
        RETURNING ${PERMIT_COLUMNS}
      `, [
        permit.permitId,
        permit.candidateId,
        permit.conversationId,
        permit.senderCompanionId,
        permit.recipientCompanionId,
        permit.channelId,
        permit.provenanceRef,
        permit.issuedAtMs,
        permit.expiresAtMs,
        permit.status,
        permit.revision,
      ]);
      const permitRow = permitResult.rows.at(0);
      if (!permitRow) {
        const sameCandidateResult = await client.query<PermitRow>(`
          SELECT ${PERMIT_COLUMNS}
          FROM icp_initiation_permits
          WHERE candidate_id = $1
          LIMIT 1
        `, [permit.candidateId]);
        if (sameCandidateResult.rows.at(0)) {
          throw new IcpOutstandingInvitationConflictError();
        }
        const outstandingResult = await client.query<PermitRow>(`
          SELECT ${PERMIT_COLUMNS}
          FROM icp_initiation_permits
          WHERE status = 'issued' AND issued_at_ms <= $3 AND expires_at_ms > $3
            AND LEAST(sender_companion_id, recipient_companion_id) = LEAST($1::uuid, $2::uuid)
            AND GREATEST(sender_companion_id, recipient_companion_id) = GREATEST($1::uuid, $2::uuid)
          LIMIT 1
        `, [permit.senderCompanionId, permit.recipientCompanionId, permit.issuedAtMs]);
        if (outstandingResult.rows.at(0)) {
          throw new IcpOutstandingInvitationConflictError();
        }
        throw new Error('ICP permit conversation/channel/participant/candidate binding mismatch');
      }
      const episodeRow = episodeResult.rows.at(0);
      if (!episodeRow) throw new Error('Failed to create ICP conversation episode atomically');
      return {
        episode: mapConversation(episodeRow, this.knownCompanionIds),
        permit: mapPermit(permitRow),
      };
    });
  }

  async getPermit(permitId: string): Promise<IcpInitiationPermit | null> {
    const row = await queryOne<PermitRow>(this.pool, `
      SELECT ${PERMIT_COLUMNS}
      FROM icp_initiation_permits
      WHERE permit_id = $1
    `, [requireUuid(permitId, 'permitId')]);
    return row ? mapPermit(row) : null;
  }

  async getPermitByCandidate(candidateId: string): Promise<IcpInitiationPermit | null> {
    const row = await queryOne<PermitRow>(this.pool, `
      SELECT ${PERMIT_COLUMNS}
      FROM icp_initiation_permits
      WHERE candidate_id = $1
    `, [requireUuid(candidateId, 'candidateId')]);
    return row ? mapPermit(row) : null;
  }

  async consumePermit(input: IcpPermitConsumptionInput): Promise<IcpPermitConsumptionResult> {
    validateConsumptionBinding(input);
    return await withPostgresClient(this.pool, async client => {
      const invalidationReason = await lockInvalidationFence(
        client,
        input.expectedInvalidationFence,
        input.senderCompanionId,
        input.recipientCompanionId,
      );
      if (!invalidationReason) {
        const result = await client.query<PermitRow>(`
          UPDATE icp_initiation_permits
          SET status = 'consumed', consumed_at_ms = $6, revision = revision + 1
          WHERE permit_id = $1 AND status = 'issued'
            AND conversation_id = $2
            AND sender_companion_id = $3
            AND recipient_companion_id = $4
            AND channel_id = $5
            AND issued_at_ms <= $6
            AND expires_at_ms > $6
          RETURNING ${PERMIT_COLUMNS}
        `, [
          input.permitId,
          input.conversationId,
          input.senderCompanionId,
          input.recipientCompanionId,
          input.channelId,
          input.consumedAtMs,
        ]);
        const consumedRow = result.rows.at(0);
        if (consumedRow) return { outcome: 'consumed', permit: mapPermit(consumedRow) };
      }

      const existingResult = await client.query<PermitRow>(`
        SELECT ${PERMIT_COLUMNS}
        FROM icp_initiation_permits
        WHERE permit_id = $1
      `, [input.permitId]);
      const existingRow = existingResult.rows.at(0);
      if (!existingRow) return { outcome: 'not_found', permit: null };
      let existing = mapPermit(existingRow);
      if (!permitMatches(existing, input)) {
        return { outcome: 'mismatch', permit: existing, reasonCode: 'permit_mismatch' };
      }
      if (existing.status === 'revoked') {
        return { outcome: 'revoked', permit: existing, reasonCode: 'permit_revoked' };
      }
      if (invalidationReason) {
        throw new IcpAutonomyInvalidationConflictError(invalidationReason);
      }
      if (existing.status === 'consumed') {
        return { outcome: 'replayed', permit: existing, reasonCode: 'permit_replayed' };
      }
      if (existing.status === 'expired' || existing.expiresAtMs <= input.consumedAtMs) {
        if (existing.status === 'issued') {
          const expiredResult = await client.query<PermitRow>(`
            UPDATE icp_initiation_permits
            SET status = 'expired', reason_code = 'permit_expired', revision = revision + 1
            WHERE permit_id = $1 AND status = 'issued' AND revision = $2 AND expires_at_ms <= $3
            RETURNING ${PERMIT_COLUMNS}
          `, [existing.permitId, existing.revision, input.consumedAtMs]);
          const expiredRow = expiredResult.rows.at(0);
          if (expiredRow) existing = mapPermit(expiredRow);
        }
        return { outcome: 'expired', permit: existing, reasonCode: 'permit_expired' };
      }
      return { outcome: 'mismatch', permit: existing, reasonCode: 'permit_mismatch' };
    });
  }

  async revokePermit(
    permitId: string,
    expectedRevision: number,
    revokedAtMs: number,
    reasonCodeInput: IcpAutonomyReasonCode,
  ): Promise<IcpInitiationPermit> {
    const reasonCode = requireReasonCode(reasonCodeInput, 'reasonCode');
    const row = await queryOne<PermitRow>(this.pool, `
      UPDATE icp_initiation_permits
      SET status = 'revoked', revoked_at_ms = $3, reason_code = $4, revision = revision + 1
      WHERE permit_id = $1 AND revision = $2 AND status = 'issued'
        AND issued_at_ms <= $3
      RETURNING ${PERMIT_COLUMNS}
    `, [
      requireUuid(permitId, 'permitId'),
      requirePositiveInteger(expectedRevision, 'expectedRevision'),
      requireTimestamp(revokedAtMs, 'revokedAtMs'),
      reasonCode,
    ]);
    if (!row) throw new IcpPermitRevocationConflictError();
    return mapPermit(row);
  }

  async findOutstandingPermitBetween(
    firstCompanionId: string,
    secondCompanionId: string,
    nowMs: number,
  ): Promise<IcpInitiationPermit | null> {
    const first = requireUuid(firstCompanionId, 'firstCompanionId');
    const second = requireUuid(secondCompanionId, 'secondCompanionId');
    if (first === second) throw new Error('Outstanding permit lookup requires distinct companions');
    const now = requireTimestamp(nowMs, 'nowMs');
    await executeQuery(this.pool, `
      UPDATE icp_initiation_permits
      SET status = 'expired', reason_code = 'permit_expired', revision = revision + 1
      WHERE status = 'issued' AND expires_at_ms <= $3
        AND LEAST(sender_companion_id, recipient_companion_id) = LEAST($1::uuid, $2::uuid)
        AND GREATEST(sender_companion_id, recipient_companion_id) = GREATEST($1::uuid, $2::uuid)
    `, [first, second, now]);
    const row = await queryOne<PermitRow>(this.pool, `
      SELECT ${PERMIT_COLUMNS}
      FROM icp_initiation_permits
      WHERE status = 'issued' AND issued_at_ms <= $3 AND expires_at_ms > $3
        AND LEAST(sender_companion_id, recipient_companion_id) = LEAST($1::uuid, $2::uuid)
        AND GREATEST(sender_companion_id, recipient_companion_id) = GREATEST($1::uuid, $2::uuid)
      LIMIT 1
    `, [first, second, now]);
    return row ? mapPermit(row) : null;
  }

  async revokeOutstandingPermitsForCompanion(
    companionId: string,
    revokedAtMs: number,
    reasonCodeInput: IcpAutonomyReasonCode,
  ): Promise<IcpInitiationPermit[]> {
    const reasonCode = requireReasonCode(reasonCodeInput, 'reasonCode');
    const normalizedCompanionId = requireUuid(companionId, 'companionId');
    const normalizedRevokedAtMs = requireTimestamp(revokedAtMs, 'revokedAtMs');
    return await withPostgresClient(this.pool, async client =>
      await invalidateCompanionWithClient(
        client,
        normalizedCompanionId,
        normalizedRevokedAtMs,
        reasonCode,
      ));
  }

  async revokeOutstandingPermitsOutsideFleet(
    knownCompanionIdsInput: readonly string[],
    revokedAtMs: number,
  ): Promise<IcpInitiationPermit[]> {
    const knownCompanionIds = normalizeKnownCompanionIds(knownCompanionIdsInput);
    const normalizedRevokedAtMs = requireTimestamp(revokedAtMs, 'revokedAtMs');
    return await withPostgresClient(this.pool, async client => {
      const outsideResult = await client.query<{ companion_id: string }>(`
        SELECT DISTINCT companion_id
        FROM (
          SELECT companion_id
          FROM icp_autonomy_invalidation_fences
          WHERE companion_id <> ALL($1::uuid[])
          UNION
          SELECT sender_companion_id AS companion_id
          FROM icp_initiation_permits
          WHERE status = 'issued' AND sender_companion_id <> ALL($1::uuid[])
          UNION
          SELECT recipient_companion_id AS companion_id
          FROM icp_initiation_permits
          WHERE status = 'issued' AND recipient_companion_id <> ALL($1::uuid[])
        ) AS outside_fleet
        ORDER BY companion_id
      `, [[...knownCompanionIds]]);
      const outsideIds = outsideResult.rows.map(row => requireUuid(row.companion_id, 'outsideFleetCompanionId'));
      if (outsideIds.length > 0) {
        await client.query(`
          INSERT INTO icp_autonomy_invalidation_fences (companion_id, generation)
          SELECT companion_id, 0
          FROM unnest($1::uuid[]) AS companion_id
          ON CONFLICT (companion_id) DO NOTHING
        `, [outsideIds]);
        await client.query(`
          SELECT companion_id
          FROM icp_autonomy_invalidation_fences
          WHERE companion_id = ANY($1::uuid[])
          ORDER BY companion_id
          FOR UPDATE
        `, [outsideIds]);
        await client.query(`
          UPDATE icp_autonomy_invalidation_fences
          SET generation = generation + 1,
              invalidated_at_ms = $2,
              last_reason_code = 'unknown_participant'
          WHERE companion_id = ANY($1::uuid[])
        `, [outsideIds, normalizedRevokedAtMs]);
      }
      const permitResult = await client.query<PermitRow>(`
        UPDATE icp_initiation_permits
        SET status = 'revoked', revoked_at_ms = GREATEST($2, issued_at_ms),
            reason_code = 'unknown_participant', revision = revision + 1
        WHERE status = 'issued'
          AND NOT (
            sender_companion_id = ANY($1::uuid[])
            AND recipient_companion_id = ANY($1::uuid[])
          )
        RETURNING ${PERMIT_COLUMNS}
      `, [[...knownCompanionIds], normalizedRevokedAtMs]);
      return permitResult.rows.map(mapPermit);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
