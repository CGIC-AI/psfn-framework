import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  GatewayIcpInitiationPolicyAuthority,
  IcpInitiationHandoffPolicyDecision,
  IcpInitiationHandoffPolicyInput,
  IcpAuthorizedHandoffOperationResult,
  IcpInitiationCapacityPolicyAuthority,
  IcpInitiationCausalityAuthority,
  IcpInitiationPolicyAuthorityInput,
} from '../../boundary/gateway/icp-initiation-policy-authority.js';
import type { IcpInitiationPolicySnapshot } from '../../boundary/gateway/icp-autonomy-contract.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import { evaluateProactiveOutboundTimeGate, type ProactiveQuietHoursConfig } from '../../core/intention/proactive-time-gate.js';
import { resolveContactBlockListPath } from '../layout.js';
import {
  createPostgresPool,
  assertValidPostgresSchemaName,
  withPostgresClient,
} from '../postgres.js';
import { TRUST_LEVELS, trustAtLeast, type TrustLevel } from '../../system/trust/types.js';

interface FleetPolicyOwner {
  companionId: string;
  postgresSchema: string;
  companionDataDir: string;
}

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
  revision: string | number;
}

interface ContactPolicyRow extends QueryResultRow {
  id: string;
  trust_level: string;
  is_machine_intelligence: boolean;
}

interface ContactIdentityPolicyRow extends QueryResultRow {
  channel_user_id: string;
}

export interface PostgresIcpInitiationPolicyAuthorityOptions {
  fleet: readonly FleetPolicyOwner[];
  quietHours: ProactiveQuietHoursConfig;
  capacityAuthority?: IcpInitiationCapacityPolicyAuthority;
  causalityAuthority?: IcpInitiationCausalityAuthority;
  pool?: Pool;
}

function safeInteger(value: string | number): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function quoteSchema(value: string): string {
  return `"${assertValidPostgresSchemaName(value)}"`;
}

function parseTrustLevel(value: string): TrustLevel {
  if (!TRUST_LEVELS.includes(value as TrustLevel)) {
    throw new Error(`Unknown canonical contact trust level ${JSON.stringify(value)}`);
  }
  return value as TrustLevel;
}

function candidateMatches(row: CandidatePolicyRow, input: IcpInitiationPolicyAuthorityInput): boolean {
  const candidate = input.candidate;
  return row.candidate_id === candidate.candidateId
    && row.root_initiation_id === candidate.rootInitiationId
    && row.local_companion_id === input.senderCompanionId
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

/**
 * Production gateway authority. It reads only content-free candidate columns,
 * canonical contact identity/trust, and the two companion-owned block lists.
 * Capacity and causal-root owners are explicit ports; absent owners deny.
 */
export class PostgresIcpInitiationPolicyAuthority implements GatewayIcpInitiationPolicyAuthority {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly fleet = new Map<string, FleetPolicyOwner>();
  private readonly blockLists = new Map<string, ContactBlockListStore>();

  constructor(
    databaseUrl: string,
    private readonly options: PostgresIcpInitiationPolicyAuthorityOptions,
  ) {
    for (const owner of options.fleet) {
      if (this.fleet.has(owner.companionId)) {
        throw new Error(`Duplicate ICP policy owner ${owner.companionId}`);
      }
      quoteSchema(owner.postgresSchema);
      this.fleet.set(owner.companionId, owner);
      this.blockLists.set(
        owner.companionId,
        new ContactBlockListStore(resolveContactBlockListPath(owner.companionDataDir)),
      );
    }
    if (this.fleet.size < 2) {
      throw new Error('ICP initiation policy authority requires at least two fleet companions');
    }
    this.pool = options.pool ?? createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-initiation-policy',
      allowExitOnIdle: true,
    });
    this.ownsPool = options.pool === undefined;
  }

  async resolve(input: IcpInitiationPolicyAuthorityInput): Promise<IcpInitiationPolicySnapshot> {
    const sender = this.requireOwner(input.senderCompanionId);
    const peer = this.requireOwner(input.candidate.peerCompanionId);
    const candidateResult = await this.pool.query<CandidatePolicyRow>(`
      SELECT candidate_id, root_initiation_id, local_companion_id, peer_contact_id,
        peer_companion_id, preferred_channel, source, provenance_ref, created_at_ms,
        expires_at_ms, status, reason_code, revision
      FROM ${quoteSchema(sender.postgresSchema)}.icp_initiation_candidates
      WHERE candidate_id = $1
    `, [input.candidate.candidateId]);
    const candidateRow = candidateResult.rows.at(0);
    const canonicalCandidate = candidateRow !== undefined && candidateMatches(candidateRow, input);

    const [senderContact, peerContact] = candidateRow
      ? await Promise.all([
          this.resolveContact(
            this.pool,
            sender,
            candidateRow.peer_contact_id,
            input.candidate.peerCompanionId,
          ),
          this.resolveContact(this.pool, peer, null, input.senderCompanionId),
        ])
      : [null, null];
    const canonicalPeerContact = canonicalCandidate
      && senderContact !== null
      && peerContact !== null;
    const trustAllows = canonicalPeerContact
      && trustAtLeast(senderContact.trustLevel, 'regular')
      && trustAtLeast(peerContact.trustLevel, 'regular');
    const isDirectMessage = input.channelId.startsWith('companion-dm:');
    const senderBlocksPeer = this.isBlocked(
      input.senderCompanionId,
      input.candidate.peerCompanionId,
      isDirectMessage,
    );
    const peerBlocksSender = this.isBlocked(
      input.candidate.peerCompanionId,
      input.senderCompanionId,
      isDirectMessage,
    );
    const quietHours = !evaluateProactiveOutboundTimeGate({
      nowMs: input.nowMs,
      quietHours: this.options.quietHours,
    }).allowed;
    const candidateCreatedAtMs = candidateRow ? safeInteger(candidateRow.created_at_ms) : null;
    const candidateExpiresAtMs = candidateRow ? safeInteger(candidateRow.expires_at_ms) : null;
    const provenanceFresh = canonicalCandidate
      && candidateRow.status === 'pending'
      && candidateCreatedAtMs !== null
      && candidateCreatedAtMs <= input.nowMs
      && candidateExpiresAtMs !== null
      && candidateExpiresAtMs > input.nowMs;
    const independentRoot = canonicalCandidate && this.options.causalityAuthority
      ? await this.options.causalityAuthority.isIndependentRoot(input)
      : false;
    const capacity = this.options.capacityAuthority
      ? await this.options.capacityAuthority.resolve(input)
      : {
          socialPressureAllows: false,
          chargeAllows: false,
          fatigueAllows: false,
          costAllows: false,
        };

    return {
      canonicalPeerContact,
      trustAllows,
      senderBlocksPeer,
      peerBlocksSender,
      quietHours,
      provenanceFresh,
      recursiveMiOnlyRoot: !independentRoot,
      ...capacity,
    };
  }

  async authorizeHandoff(
    input: IcpInitiationHandoffPolicyInput,
  ): Promise<IcpInitiationHandoffPolicyDecision> {
    return await this.authorizeHandoffWithQuery(this.pool, input, false);
  }

  async runAuthorizedHandoff<T>(
    input: IcpInitiationHandoffPolicyInput,
    operation: () => Promise<T>,
  ): Promise<IcpAuthorizedHandoffOperationResult<T>> {
    return await withPostgresClient(this.pool, async client => {
      const decision = await this.authorizeHandoffWithQuery(client, input, true);
      if (!decision.eligible) {
        return {
          decision: {
            eligible: false,
            ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
          },
        };
      }
      const result = await operation();
      return { decision: { eligible: true }, result };
    });
  }

  private async authorizeHandoffWithQuery(
    query: Pool | PoolClient,
    input: IcpInitiationHandoffPolicyInput,
    lockCanonicalRows: boolean,
  ): Promise<IcpInitiationHandoffPolicyDecision> {
    const sender = this.requireOwner(input.senderCompanionId);
    const peer = this.requireOwner(input.permit.recipientCompanionId);
    const candidateResult = await query.query<CandidatePolicyRow>(`
      SELECT candidate_id, root_initiation_id, local_companion_id, peer_contact_id,
        peer_companion_id, preferred_channel, source, provenance_ref, created_at_ms,
        expires_at_ms, status, reason_code, revision
      FROM ${quoteSchema(sender.postgresSchema)}.icp_initiation_candidates
      WHERE candidate_id = $1
      ${lockCanonicalRows ? 'FOR SHARE' : ''}
    `, [input.permit.candidateId]);
    const candidate = candidateResult.rows.at(0);
    if (!candidate
      || candidate.candidate_id !== input.permit.candidateId
      || candidate.local_companion_id !== input.senderCompanionId
      || candidate.peer_companion_id !== input.permit.recipientCompanionId
      || candidate.peer_contact_id !== input.peerContactId
      || candidate.provenance_ref !== input.permit.provenanceRef) {
      return { eligible: false, reasonCode: 'invalid_identity' };
    }
    const candidateExpiresAtMs = safeInteger(candidate.expires_at_ms);
    if (!['pending', 'permitted'].includes(candidate.status)
      || candidateExpiresAtMs === null
      || (input.permit.status === 'issued' && candidateExpiresAtMs <= input.nowMs)) {
      return { eligible: false, reasonCode: 'stale_provenance' };
    }

    const [senderContact, peerContact] = await Promise.all([
      this.resolveContact(
        query,
        sender,
        input.peerContactId,
        input.permit.recipientCompanionId,
        lockCanonicalRows,
      ),
      this.resolveContact(query, peer, null, input.senderCompanionId, lockCanonicalRows),
    ]);
    if (!senderContact || !peerContact) {
      return { eligible: false, reasonCode: 'invalid_identity' };
    }
    if (!trustAtLeast(senderContact.trustLevel, 'regular')
      || !trustAtLeast(peerContact.trustLevel, 'regular')) {
      return { eligible: false, reasonCode: 'policy_denied' };
    }
    const isDirectMessage = input.permit.channelId.startsWith('companion-dm:');
    if (this.isBlocked(
      input.senderCompanionId,
      input.permit.recipientCompanionId,
      isDirectMessage,
    ) || this.isBlocked(
      input.permit.recipientCompanionId,
      input.senderCompanionId,
      isDirectMessage,
    )) {
      return { eligible: false, reasonCode: 'peer_blocked' };
    }
    return { eligible: true };
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private requireOwner(companionId: string): FleetPolicyOwner {
    const owner = this.fleet.get(companionId);
    if (!owner) throw new Error(`Unknown ICP policy companion ${companionId}`);
    return owner;
  }

  private async resolveContact(
    query: Pool | PoolClient,
    owner: FleetPolicyOwner,
    expectedContactId: string | null,
    peerCompanionId: string,
    lockCanonicalRows = false,
  ): Promise<{ trustLevel: TrustLevel } | null> {
    // A final authorization takes FOR UPDATE on the canonical parent contact.
    // The channel-identity FK takes FOR KEY SHARE for inserts, so this parent
    // lock prevents a second companion identity from appearing until the
    // authorized operation commits. The follow-up read must still require
    // exact cardinality because ambiguity committed before the lock is valid.
    const contactResult = await query.query<ContactPolicyRow>(`
      SELECT c.id, c.trust_level, c.is_machine_intelligence
      FROM ${quoteSchema(owner.postgresSchema)}.contacts AS c
      WHERE c.id = CASE
        WHEN $2::text IS NOT NULL THEN $2
        ELSE (
          SELECT identity.contact_id
          FROM ${quoteSchema(owner.postgresSchema)}.contact_channel_ids AS identity
          WHERE identity.channel = 'companion' AND identity.channel_user_id = $1
        )
      END
      ${lockCanonicalRows ? 'FOR UPDATE OF c' : ''}
    `, [peerCompanionId, expectedContactId]);
    const contact = contactResult.rows.at(0);
    if (!contact || !contact.is_machine_intelligence) return null;

    const identityResult = await query.query<ContactIdentityPolicyRow>(`
      SELECT identity.channel_user_id
      FROM ${quoteSchema(owner.postgresSchema)}.contact_channel_ids AS identity
      WHERE identity.contact_id = $1 AND identity.channel = 'companion'
      ORDER BY identity.channel_user_id
      ${lockCanonicalRows ? 'FOR SHARE OF identity' : ''}
    `, [contact.id]);
    if (identityResult.rows.length !== 1
      || identityResult.rows[0]?.channel_user_id !== peerCompanionId) {
      return null;
    }
    return { trustLevel: parseTrustLevel(contact.trust_level) };
  }

  private isBlocked(companionId: string, peerCompanionId: string, isDirectMessage: boolean): boolean {
    const blockList = this.blockLists.get(companionId);
    if (!blockList) throw new Error(`Missing canonical block list for ${companionId}`);
    return blockList.evaluate({
      channelType: 'companion',
      contactId: peerCompanionId,
      isDirectMessage,
    }).action !== 'allow';
  }
}
