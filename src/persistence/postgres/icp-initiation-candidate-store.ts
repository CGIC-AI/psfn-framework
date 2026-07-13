import type { Pool, QueryResultRow } from 'pg';

import type {
  IcpInitiationCandidateListOptions,
  IcpInitiationCandidateStorePort,
  IcpInitiationCandidateTransitionInput,
} from '../../core/icp/autonomy-store-ports.js';
import {
  ICP_INITIATION_CANDIDATE_STATUSES,
  assertIcpInitiationCandidateStatusTransition,
  parseIcpInitiationCandidate,
  type IcpInitiationCandidate,
} from '../../core/icp/initiation-candidate.js';
import { ICP_AUTONOMY_REASON_CODES } from '../../shared/contracts/icp-autonomy.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  ensurePostgresSchemaExists,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';

interface CandidateRow extends QueryResultRow {
  candidate_id: string;
  root_initiation_id: string;
  local_companion_id: string;
  peer_contact_id: string;
  peer_companion_id: string;
  preferred_channel: string;
  source: string;
  provenance_ref: string;
  reason_summary: string;
  continuation_task_kind: string | null;
  created_at_ms: string | number;
  expires_at_ms: string | number;
  status: string;
  reason_code: string | null;
  revision: string | number;
}

const CANDIDATE_COLUMNS = `
  candidate_id, root_initiation_id, local_companion_id, peer_contact_id,
  peer_companion_id, preferred_channel, source, provenance_ref, reason_summary,
  continuation_task_kind, created_at_ms, expires_at_ms, status, reason_code, revision
`;

function safeInteger(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} must be a safe integer`);
  return parsed;
}

function requireUuid(value: string, field: string): string {
  if (!isRfc4122Uuid(value)) throw new Error(`${field} must be a lowercase RFC-4122 UUID`);
  return value;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function mapCandidate(row: CandidateRow): IcpInitiationCandidate {
  return parseIcpInitiationCandidate({
    candidateId: row.candidate_id,
    rootInitiationId: row.root_initiation_id,
    localCompanionId: row.local_companion_id,
    peerContactId: row.peer_contact_id,
    peerCompanionId: row.peer_companion_id,
    preferredChannel: row.preferred_channel,
    source: row.source,
    provenanceRef: row.provenance_ref,
    reasonSummary: row.reason_summary,
    ...(row.continuation_task_kind !== null
      ? { continuationTaskKind: row.continuation_task_kind }
      : {}),
    createdAtMs: safeInteger(row.created_at_ms, 'candidate.createdAtMs'),
    expiresAtMs: safeInteger(row.expires_at_ms, 'candidate.expiresAtMs'),
    status: row.status,
    ...(row.reason_code !== null ? { reasonCode: row.reason_code } : {}),
    revision: safeInteger(row.revision, 'candidate.revision'),
  });
}

export class PostgresIcpInitiationCandidateStore implements IcpInitiationCandidateStorePort {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    databaseUrl: string,
    options: { schema: string },
  ): Promise<PostgresIcpInitiationCandidateStore> {
    if (typeof options.schema !== 'string' || options.schema.trim().length === 0) {
      throw new Error('ICP initiation candidate store requires a companion-local Postgres schema');
    }
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-initiation-candidates',
      allowExitOnIdle: true,
      schema: options.schema,
    });
    try {
      await ensurePostgresSchemaExists(pool, options.schema);
      await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS);
      return new PostgresIcpInitiationCandidateStore(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async createCandidate(candidateInput: IcpInitiationCandidate): Promise<IcpInitiationCandidate> {
    const candidate = parseIcpInitiationCandidate(candidateInput);
    if (candidate.status !== 'pending' || candidate.revision !== 1) {
      throw new Error('A new ICP initiation candidate must start pending at revision 1');
    }
    const row = await queryOne<CandidateRow>(this.pool, `
      INSERT INTO icp_initiation_candidates (
        candidate_id, root_initiation_id, local_companion_id, peer_contact_id,
        peer_companion_id, preferred_channel, source, provenance_ref, reason_summary,
        continuation_task_kind, created_at_ms, expires_at_ms, status, reason_code, revision
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING ${CANDIDATE_COLUMNS}
    `, [
      candidate.candidateId,
      candidate.rootInitiationId,
      candidate.localCompanionId,
      candidate.peerContactId,
      candidate.peerCompanionId,
      candidate.preferredChannel,
      candidate.source,
      candidate.provenanceRef,
      candidate.reasonSummary,
      candidate.continuationTaskKind ?? null,
      candidate.createdAtMs,
      candidate.expiresAtMs,
      candidate.status,
      candidate.reasonCode ?? null,
      candidate.revision,
    ]);
    if (!row) throw new Error(`Failed to create ICP candidate ${candidate.candidateId}`);
    return mapCandidate(row);
  }

  async getCandidate(candidateId: string): Promise<IcpInitiationCandidate | null> {
    const row = await queryOne<CandidateRow>(this.pool, `
      SELECT ${CANDIDATE_COLUMNS}
      FROM icp_initiation_candidates
      WHERE candidate_id = $1
    `, [requireUuid(candidateId, 'candidateId')]);
    return row ? mapCandidate(row) : null;
  }

  async listCandidates(
    options: IcpInitiationCandidateListOptions = {},
  ): Promise<IcpInitiationCandidate[]> {
    const statuses = options.statuses ? [...options.statuses] : [];
    for (const status of statuses) {
      if (!ICP_INITIATION_CANDIDATE_STATUSES.includes(status)) {
        throw new Error(`Unknown ICP candidate status ${status}`);
      }
    }
    const limit = options.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('ICP candidate list limit must be an integer between 1 and 1000');
    }
    const rows = await queryRows<CandidateRow>(this.pool, `
      SELECT ${CANDIDATE_COLUMNS}
      FROM icp_initiation_candidates
      WHERE ($1::text[] IS NULL OR status = ANY($1::text[]))
      ORDER BY created_at_ms DESC, candidate_id ASC
      LIMIT $2
    `, [statuses.length > 0 ? statuses : null, limit]);
    return rows.map(mapCandidate);
  }

  async transitionCandidate(
    input: IcpInitiationCandidateTransitionInput,
  ): Promise<IcpInitiationCandidate> {
    assertIcpInitiationCandidateStatusTransition(input.expectedStatus, input.status);
    if (input.reasonCode !== undefined && !ICP_AUTONOMY_REASON_CODES.includes(input.reasonCode)) {
      throw new Error(`Unknown ICP candidate reason code ${input.reasonCode}`);
    }
    const row = await queryOne<CandidateRow>(this.pool, `
      UPDATE icp_initiation_candidates
      SET status = $4, reason_code = $5, revision = revision + 1
      WHERE candidate_id = $1 AND status = $2 AND revision = $3
      RETURNING ${CANDIDATE_COLUMNS}
    `, [
      requireUuid(input.candidateId, 'candidateId'),
      input.expectedStatus,
      requirePositiveInteger(input.expectedRevision, 'expectedRevision'),
      input.status,
      input.reasonCode ?? null,
    ]);
    if (!row) throw new Error(`ICP candidate transition conflict for ${input.candidateId}`);
    return mapCandidate(row);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
