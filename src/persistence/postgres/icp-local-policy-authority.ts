import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  IcpInitiationCapacityPolicyDecision,
} from '../../boundary/gateway/icp-initiation-policy-authority.js';
import type { IcpLocalInitiationCapacityInput } from '../../core/agent/fatigue/initiation-capacity.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import {
  parseIcpInitiationCandidateSharedMetadata,
  type IcpInitiationCandidateSharedMetadata,
} from '../../core/icp/initiation-candidate.js';
import {
  parseIcpLocalPolicyAcquireParams,
  parseIcpLocalPolicyInspectParams,
  parseIcpLocalPolicyReleaseParams,
  type IcpLocalPolicyAcquireParams,
  type IcpLocalPolicyAcquireResult,
  type IcpLocalPolicyInspectParams,
  type IcpLocalPolicyInspectResult,
  type IcpLocalPolicyReleaseParams,
  type IcpLocalPolicyReleaseResult,
} from '../../core/icp/local-policy-contract.js';
import {
  evaluateProactiveOutboundTimeGate,
  type ProactiveQuietHoursConfig,
} from '../../core/intention/proactive-time-gate.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { IcpAutonomyReasonCode } from '../../shared/contracts/icp-autonomy.js';
import { TRUST_LEVELS, trustAtLeast, type TrustLevel } from '../../system/trust/types.js';
import {
  VALID_RELATIONSHIP_TYPES,
  type RelationshipType,
} from '../../core/contacts/types.js';
import { resolveContactBlockListPath } from '../layout.js';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
} from '../postgres.js';
import { assertPostgresRelationColumns } from './relation-contract.js';

const log = createComponentLogger('IcpLocalPolicyAuthority');

interface CandidatePolicyRow extends QueryResultRow {
  candidate_id: string;
  root_initiation_id: string;
  local_companion_id: string;
  peer_contact_id: string;
  peer_companion_id: string;
  preferred_channel: string;
  source: string;
  provenance_ref: string;
  created_at_ms: string | number;
  expires_at_ms: string | number;
  status: string;
  reason_code: string | null;
  initiation_permit_id: string | null;
  revision: string | number;
}

interface ContactPolicyRow extends QueryResultRow {
  id: string;
  trust_level: string;
  relationship_type: string;
  is_machine_intelligence: boolean;
}

interface ContactIdentityPolicyRow extends QueryResultRow {
  channel_user_id: string;
}

interface LocalRelationship {
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
}

interface RetainedPolicyHold {
  client: PoolClient;
  payloadDigest: string;
  nonce: string;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface IcpLocalPolicyCapacityAuthority {
  resolve(input: IcpLocalInitiationCapacityInput): Promise<IcpInitiationCapacityPolicyDecision>;
}

export interface PostgresIcpLocalPolicyAuthorityOptions {
  companionId: string;
  postgresSchema: string;
  postgresRole?: string;
  companionDataDir: string;
  quietHours: ProactiveQuietHoursConfig;
  policyHolds: {
    ttlMs: number;
    maxOutstanding: number;
  };
  capacityAuthority: IcpLocalPolicyCapacityAuthority;
  pool?: Pool;
  now?: () => number;
  randomUuid?: () => string;
}

function safeInteger(value: string | number): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseTrustLevel(value: string): TrustLevel {
  if (!TRUST_LEVELS.includes(value as TrustLevel)) {
    throw new Error(`Unknown canonical contact trust level ${JSON.stringify(value)}`);
  }
  return value as TrustLevel;
}

function parseRelationshipType(value: string): RelationshipType {
  if (!VALID_RELATIONSHIP_TYPES.includes(value as RelationshipType)) {
    throw new Error(`Unknown canonical contact relationship type ${JSON.stringify(value)}`);
  }
  return value as RelationshipType;
}

function candidateMatches(
  row: CandidatePolicyRow,
  candidate: IcpInitiationCandidateSharedMetadata,
): boolean {
  return row.candidate_id === candidate.candidateId
    && row.root_initiation_id === candidate.rootInitiationId
    && row.local_companion_id === candidate.localCompanionId
    && row.peer_companion_id === candidate.peerCompanionId
    && row.preferred_channel === candidate.preferredChannel
    && row.source === candidate.source
    && row.provenance_ref === candidate.provenanceRef
    && safeInteger(row.created_at_ms) === candidate.createdAtMs
    && safeInteger(row.expires_at_ms) === candidate.expiresAtMs
    && row.status === candidate.status
    && (row.reason_code ?? undefined) === candidate.reasonCode
    && safeInteger(row.revision) === candidate.revision;
}

function sharedCandidateFromRow(row: CandidatePolicyRow): IcpInitiationCandidateSharedMetadata {
  const createdAtMs = safeInteger(row.created_at_ms);
  const expiresAtMs = safeInteger(row.expires_at_ms);
  const revision = safeInteger(row.revision);
  if (createdAtMs === null || expiresAtMs === null || revision === null) {
    throw new Error('Canonical ICP candidate contains an invalid integer field');
  }
  return parseIcpInitiationCandidateSharedMetadata({
    candidateId: row.candidate_id,
    rootInitiationId: row.root_initiation_id,
    localCompanionId: row.local_companion_id,
    peerCompanionId: row.peer_companion_id,
    preferredChannel: row.preferred_channel,
    source: row.source,
    provenanceRef: row.provenance_ref,
    createdAtMs,
    expiresAtMs,
    status: row.status,
    ...(row.reason_code !== null
      ? { reasonCode: row.reason_code }
      : {}),
    revision,
  });
}

/** Companion-owned ICP policy authority. No query can address another tenant schema. */
export class PostgresIcpLocalPolicyAuthority {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly blockList: ContactBlockListStore;
  private readonly holds = new Map<string, RetainedPolicyHold>();
  private readonly usedNonces = new Map<string, number>();
  private ready = false;
  private closed = false;

  constructor(
    databaseUrl: string,
    private readonly options: PostgresIcpLocalPolicyAuthorityOptions,
  ) {
    assertValidPostgresSchemaName(options.postgresSchema);
    if (!Number.isSafeInteger(options.policyHolds.ttlMs) || options.policyHolds.ttlMs < 1
      || !Number.isSafeInteger(options.policyHolds.maxOutstanding)
      || options.policyHolds.maxOutstanding < 1) {
      throw new Error('ICP local policy hold settings must be positive safe integers');
    }
    this.pool = options.pool ?? createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-local-policy',
      allowExitOnIdle: true,
      schema: options.postgresSchema,
      ...(options.postgresRole ? { role: options.postgresRole } : {}),
      max: options.policyHolds.maxOutstanding,
    });
    this.ownsPool = options.pool === undefined;
    this.now = options.now ?? (() => Date.now());
    this.randomUuid = options.randomUuid ?? randomUUID;
    this.blockList = new ContactBlockListStore(
      resolveContactBlockListPath(options.companionDataDir),
    );
  }

  async assertReady(): Promise<void> {
    this.requireOpen();
    for (const relation of [
      {
        name: 'icp_initiation_candidates',
        columns: [
          'candidate_id', 'root_initiation_id', 'local_companion_id', 'peer_contact_id',
          'peer_companion_id', 'preferred_channel', 'source', 'provenance_ref',
          'created_at_ms', 'expires_at_ms', 'status', 'reason_code',
          'initiation_permit_id', 'revision',
        ],
      },
      {
        name: 'contacts',
        columns: ['id', 'trust_level', 'relationship_type', 'is_machine_intelligence'],
      },
      {
        name: 'contact_channel_ids',
        columns: ['contact_id', 'channel', 'channel_user_id'],
      },
    ] as const) {
      await assertPostgresRelationColumns(this.pool, {
        schema: this.options.postgresSchema,
        relation: relation.name,
        columns: relation.columns,
        privileges: ['SELECT', 'UPDATE'],
      });
    }
    this.ready = true;
  }

  async inspect(inputValue: IcpLocalPolicyInspectParams): Promise<IcpLocalPolicyInspectResult> {
    const input = parseIcpLocalPolicyInspectParams(inputValue);
    this.requireLocalRole(input);
    if (!this.ready || this.closed) return { role: input.role, ready: false };
    if (input.role === 'recipient') {
      const relationship = await this.resolveContact(
        this.pool,
        null,
        input.senderCompanionId,
        false,
      );
      return {
        role: 'recipient',
        ready: true,
        canonicalPeerContact: relationship !== null,
        trustAllows: relationship !== null && trustAtLeast(relationship.trustLevel, 'regular'),
        blocksPeer: this.isBlocked(input.senderCompanionId, input.channelId),
      };
    }
    const candidateRow = await this.readCandidate(this.pool, input.candidate.candidateId, false);
    const canonicalCandidate = candidateRow !== null
      && candidateMatches(candidateRow, input.candidate);
    const relationship = candidateRow
      ? await this.resolveContact(
          this.pool,
          candidateRow.peer_contact_id,
          input.recipientCompanionId,
          false,
        )
      : null;
    const capacity = relationship
      ? await this.options.capacityAuthority.resolve({
          senderCompanionId: input.senderCompanionId,
          candidate: input.candidate,
          channelId: input.channelId,
          nowMs: input.nowMs,
          relationshipPressure: input.relationshipPressure,
          senderRelationship: relationship,
        })
      : this.closedCapacity();
    const createdAtMs = candidateRow ? safeInteger(candidateRow.created_at_ms) : null;
    const expiresAtMs = candidateRow ? safeInteger(candidateRow.expires_at_ms) : null;
    return {
      role: 'sender',
      ready: true,
      canonicalPeerContact: canonicalCandidate && relationship !== null,
      trustAllows: relationship !== null && trustAtLeast(relationship.trustLevel, 'regular'),
      blocksPeer: this.isBlocked(input.recipientCompanionId, input.channelId),
      quietHours: !evaluateProactiveOutboundTimeGate({
        nowMs: input.nowMs,
        quietHours: this.options.quietHours,
      }).allowed,
      provenanceFresh: canonicalCandidate
        && candidateRow?.status === 'pending'
        && createdAtMs !== null
        && createdAtMs <= input.nowMs
        && expiresAtMs !== null
        && expiresAtMs > input.nowMs,
      ...capacity,
    };
  }

  async acquire(inputValue: IcpLocalPolicyAcquireParams): Promise<IcpLocalPolicyAcquireResult> {
    const input = parseIcpLocalPolicyAcquireParams(inputValue);
    this.requireLocalRole(input);
    this.requireReady();
    this.cleanupUsedNonces();
    if (this.usedNonces.has(input.nonce)) {
      return { acquired: false, reasonCode: 'permit_mismatch' };
    }
    if (this.holds.size >= this.options.policyHolds.maxOutstanding) {
      return { acquired: false, reasonCode: 'peer_busy' };
    }
    const expiresAtMs = Math.min(
      input.expiresAtMs,
      input.nowMs + this.options.policyHolds.ttlMs,
    );
    if (expiresAtMs <= this.now()) {
      return { acquired: false, reasonCode: 'stale_provenance' };
    }
    const client = await this.pool.connect();
    let retained = false;
    try {
      await client.query('BEGIN');
      const decision = await this.authorizeAcquire(client, input);
      if (decision !== null) {
        await client.query('ROLLBACK');
        return { acquired: false, reasonCode: decision };
      }
      const holdId = this.randomUuid();
      if (this.holds.has(holdId)) throw new Error('ICP local policy hold identity collision');
      const timer = setTimeout(() => {
        void this.expireHold(holdId).catch((error: unknown) => {
          log.error('Failed to expire an ICP local policy hold', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, Math.max(0, expiresAtMs - this.now()));
      timer.unref();
      this.holds.set(holdId, {
        client,
        payloadDigest: input.payloadDigest,
        nonce: input.nonce,
        expiresAtMs,
        timer,
      });
      this.usedNonces.set(input.nonce, expiresAtMs);
      retained = true;
      return { acquired: true, holdId, expiresAtMs };
    } catch (error) {
      if (!retained) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'ICP local policy acquire and rollback both failed',
          );
        }
      }
      throw error;
    } finally {
      if (!retained) client.release();
    }
  }

  async release(inputValue: IcpLocalPolicyReleaseParams): Promise<IcpLocalPolicyReleaseResult> {
    const input = parseIcpLocalPolicyReleaseParams(inputValue);
    const hold = this.holds.get(input.holdId);
    if (!hold) throw new Error('ICP local policy hold is unknown or already released');
    if (hold.payloadDigest !== input.payloadDigest || hold.nonce !== input.nonce) {
      throw new Error('ICP local policy release binding mismatch');
    }
    await this.releaseHold(input.holdId, hold);
    return { released: true };
  }

  async releaseAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const [holdId, hold] of [...this.holds]) {
      try {
        await this.releaseHold(holdId, hold);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to release every ICP local policy hold');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    let releaseError: unknown;
    try {
      await this.releaseAll();
    } catch (error) {
      releaseError = error;
    }
    if (this.ownsPool) await this.pool.end();
    if (releaseError) throw releaseError;
  }

  private async authorizeAcquire(
    client: PoolClient,
    input: IcpLocalPolicyAcquireParams,
  ): Promise<IcpAutonomyReasonCode | null> {
    let candidateRow: CandidatePolicyRow | null = null;
    if (input.role === 'sender') {
      const candidateId = input.phase === 'issue'
        ? input.candidate!.candidateId
        : input.permit!.candidateId;
      candidateRow = await this.readCandidate(client, candidateId, true);
      if (!candidateRow) return 'invalid_identity';
      if (input.phase === 'issue') {
        if (!candidateMatches(candidateRow, input.candidate!)
          || candidateRow.status !== 'pending') return 'stale_provenance';
      } else if (candidateRow.root_initiation_id !== input.rootInitiationId
        || candidateRow.local_companion_id !== input.senderCompanionId
        || candidateRow.peer_companion_id !== input.recipientCompanionId
        || candidateRow.provenance_ref !== input.permit!.provenanceRef
        || candidateRow.initiation_permit_id !== input.permit!.permitId
        || !(
          (input.permit!.status === 'issued' && candidateRow.status === 'permitted')
          || (input.permit!.status === 'consumed' && candidateRow.status === 'consumed')
        )) {
        return 'permit_mismatch';
      }
    }
    const peerCompanionId = input.role === 'sender'
      ? input.recipientCompanionId
      : input.senderCompanionId;
    const relationship = await this.resolveContact(
      client,
      input.role === 'sender' ? candidateRow!.peer_contact_id : null,
      peerCompanionId,
      true,
    );
    if (!relationship) return 'invalid_identity';
    if (!trustAtLeast(relationship.trustLevel, 'regular')) return 'policy_denied';
    if (this.isBlocked(peerCompanionId, input.channelId)) return 'peer_blocked';
    if (input.role === 'recipient') return null;
    if (!evaluateProactiveOutboundTimeGate({
      nowMs: input.nowMs,
      quietHours: this.options.quietHours,
    }).allowed) return 'quiet_hours';
    const capacity = await this.options.capacityAuthority.resolve({
      senderCompanionId: input.senderCompanionId,
      candidate: input.phase === 'issue'
        ? input.candidate!
        : sharedCandidateFromRow(candidateRow!),
      channelId: input.channelId,
      nowMs: input.nowMs,
      relationshipPressure: input.relationshipPressure!,
      senderRelationship: relationship,
    });
    if (!capacity.socialPressureAllows || !capacity.chargeAllows) return 'charge_pressure';
    if (!capacity.fatigueAllows) return 'fatigue_exhausted';
    if (!capacity.costAllows) return 'cost_hard_stop';
    return null;
  }

  private async readCandidate(
    query: Pool | PoolClient,
    candidateId: string,
    lock: boolean,
  ): Promise<CandidatePolicyRow | null> {
    const result = await query.query<CandidatePolicyRow>(`
      SELECT candidate_id, root_initiation_id, local_companion_id, peer_contact_id,
        peer_companion_id, preferred_channel, source, provenance_ref, created_at_ms,
        expires_at_ms, status, reason_code, initiation_permit_id, revision
      FROM icp_initiation_candidates
      WHERE candidate_id = $1
      ${lock ? 'FOR SHARE' : ''}
    `, [candidateId]);
    return result.rows.at(0) ?? null;
  }

  private async resolveContact(
    query: Pool | PoolClient,
    expectedContactId: string | null,
    peerCompanionId: string,
    lock: boolean,
  ): Promise<LocalRelationship | null> {
    const contactResult = await query.query<ContactPolicyRow>(`
      SELECT c.id, c.trust_level, c.relationship_type, c.is_machine_intelligence
      FROM contacts AS c
      WHERE c.id = CASE
        WHEN $2::text IS NOT NULL THEN $2
        ELSE (
          SELECT identity.contact_id
          FROM contact_channel_ids AS identity
          WHERE identity.channel = 'companion' AND identity.channel_user_id = $1
        )
      END
      ${lock ? 'FOR UPDATE OF c' : ''}
    `, [peerCompanionId, expectedContactId]);
    const contact = contactResult.rows.at(0);
    if (!contact || !contact.is_machine_intelligence) return null;
    const identityResult = await query.query<ContactIdentityPolicyRow>(`
      SELECT identity.channel_user_id
      FROM contact_channel_ids AS identity
      WHERE identity.contact_id = $1 AND identity.channel = 'companion'
      ORDER BY identity.channel_user_id
      ${lock ? 'FOR SHARE OF identity' : ''}
    `, [contact.id]);
    if (identityResult.rows.length !== 1
      || identityResult.rows[0]?.channel_user_id !== peerCompanionId) return null;
    return {
      trustLevel: parseTrustLevel(contact.trust_level),
      relationshipType: parseRelationshipType(contact.relationship_type),
    };
  }

  private requireLocalRole(input: {
    role: 'sender' | 'recipient';
    senderCompanionId: string;
    recipientCompanionId: string;
  }): void {
    const expected = input.role === 'sender'
      ? input.senderCompanionId
      : input.recipientCompanionId;
    if (expected !== this.options.companionId) {
      throw new Error('ICP local policy request does not target this companion authority');
    }
  }

  private isBlocked(peerCompanionId: string, channelId: string): boolean {
    return this.blockList.evaluate({
      channelType: 'companion',
      contactId: peerCompanionId,
      isDirectMessage: channelId.startsWith('companion-dm:'),
    }).action !== 'allow';
  }

  private closedCapacity(): IcpInitiationCapacityPolicyDecision {
    return {
      socialPressureAllows: false,
      chargeAllows: false,
      fatigueAllows: false,
      costAllows: false,
    };
  }

  private cleanupUsedNonces(): void {
    const nowMs = this.now();
    for (const [nonce, expiresAtMs] of this.usedNonces) {
      if (expiresAtMs <= nowMs) this.usedNonces.delete(nonce);
    }
  }

  private async expireHold(holdId: string): Promise<void> {
    const hold = this.holds.get(holdId);
    if (!hold || hold.expiresAtMs > this.now()) return;
    await this.releaseHold(holdId, hold);
  }

  private async releaseHold(holdId: string, hold: RetainedPolicyHold): Promise<void> {
    if (this.holds.get(holdId) !== hold) return;
    this.holds.delete(holdId);
    clearTimeout(hold.timer);
    try {
      await hold.client.query('ROLLBACK');
    } finally {
      hold.client.release();
    }
  }

  private requireReady(): void {
    this.requireOpen();
    if (!this.ready) throw new Error('ICP local policy authority is not ready');
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('ICP local policy authority is closed');
  }
}
