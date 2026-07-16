import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { createPostgresPool, queryRows, withPostgresClient } from '../../persistence/postgres.js';
import { SHARED_SCHEMA_NAME } from '../../persistence/postgres/migrations.js';
import { ensureSharedWikiSchema } from '../../persistence/postgres/shared-schema.js';
import type {
  NormalizedSharedWorldWikiProposal,
  SharedWorldWikiApplyState,
  SharedWorldWikiProposal,
  SharedWorldWikiProposalListQuery,
  SharedWorldWikiProposalSubmissionResult,
  SharedWorldWikiRejectionCode,
  SharedWorldWikiReviewState,
} from './shared-world-caretaker-types.js';

interface SharedWorldWikiProposalRow extends QueryResultRow {
  proposal_id: string;
  site_id: string;
  document_id: string;
  actor_id: string;
  source_ref: string;
  title: string;
  body: string;
  tags_json: unknown;
  provenance_refs_json: unknown;
  sensitivity: string;
  content_digest: string;
  review_state: string;
  rejection_code: string | null;
  reviewed_by: string | null;
  reviewed_at_ms: string | number | null;
  apply_state: string;
  apply_lease_token: string | null;
  apply_lease_until_ms: string | number | null;
  applied_at_ms: string | number | null;
  applied_document_version: number | null;
  applied_body_sha256: string | null;
  projection_body_sha256: string | null;
  cleanup_checked_at_ms: string | number | null;
  revision: number;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

export interface SharedWorldWikiProposalStorePort {
  submit(
    proposal: NormalizedSharedWorldWikiProposal,
    nowMs: number,
  ): Promise<SharedWorldWikiProposalSubmissionResult>;
  list(query?: SharedWorldWikiProposalListQuery): Promise<SharedWorldWikiProposal[]>;
  get(proposalId: string): Promise<SharedWorldWikiProposal | null>;
  review(input: {
    proposalId: string;
    decision: 'approve' | 'reject';
    operatorActorId: string;
    rejectionCode?: SharedWorldWikiRejectionCode | undefined;
    nowMs: number;
  }): Promise<SharedWorldWikiProposal>;
  claimApproved(proposalId: string, nowMs: number): Promise<SharedWorldWikiProposal | null>;
  markApplied(input: {
    proposalId: string;
    leaseToken: string;
    documentVersion: number;
    bodySha256: string;
    nowMs: number;
  }): Promise<SharedWorldWikiProposal>;
  markRetryable(proposalId: string, leaseToken: string, nowMs: number): Promise<void>;
  listCleanupCandidates(limit: number): Promise<SharedWorldWikiProposal[]>;
  markCleanupChecked(input: {
    proposalId: string;
    projectionBodySha256?: string | undefined;
    nowMs: number;
  }): Promise<void>;
  close(): Promise<void>;
}

const STORE_BOUNDS = {
  defaultListLimit: 50,
  maxListLimit: 200,
  applyLeaseMs: 60_000,
  maxCleanupLimit: 100,
} as const;

const SELECT_PROPOSAL_COLUMNS = `
  proposal_id, site_id, document_id, actor_id, source_ref, title, body,
  tags_json, provenance_refs_json, sensitivity, content_digest, review_state,
  rejection_code, reviewed_by, reviewed_at_ms, apply_state, apply_lease_token,
  apply_lease_until_ms, applied_at_ms, applied_document_version,
  applied_body_sha256, projection_body_sha256, cleanup_checked_at_ms,
  revision, created_at_ms, updated_at_ms
`;

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`shared wiki proposal ${field} is malformed`);
  }
  return value;
}

function requireReviewState(value: string): SharedWorldWikiReviewState {
  if (value === 'pending' || value === 'approved' || value === 'rejected') return value;
  throw new Error(`shared wiki proposal has unknown review state "${value}"`);
}

function requireApplyState(value: string): SharedWorldWikiApplyState {
  if (value === 'unreviewed' || value === 'ready' || value === 'applying'
    || value === 'retryable' || value === 'applied' || value === 'rejected') return value;
  throw new Error(`shared wiki proposal has unknown apply state "${value}"`);
}

function requireRejectionCode(value: string | null): SharedWorldWikiRejectionCode | undefined {
  if (value === null) return undefined;
  if (value === 'operator_rejected' || value === 'invalid_site'
    || value === 'non_public_sensitivity' || value === 'missing_provenance'
    || value === 'personal_memory_provenance' || value === 'personal_fact_content'
    || value === 'invalid_payload') return value;
  throw new Error(`shared wiki proposal has unknown rejection code "${value}"`);
}

function optionalNumber(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('shared wiki proposal timestamp is malformed');
  return parsed;
}

function requiredNumber(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('shared wiki proposal timestamp is malformed');
  return parsed;
}

function decodeProposal(row: SharedWorldWikiProposalRow): SharedWorldWikiProposal {
  if (row.sensitivity !== 'public') {
    throw new Error('shared wiki proposal sensitivity is not public');
  }
  return {
    proposalId: row.proposal_id,
    siteId: row.site_id,
    documentId: row.document_id,
    actorId: row.actor_id,
    sourceRef: row.source_ref,
    title: row.title,
    body: row.body,
    tags: requireStringArray(row.tags_json, 'tags'),
    provenanceRefs: requireStringArray(row.provenance_refs_json, 'provenance refs'),
    sensitivity: 'public',
    contentDigest: row.content_digest,
    reviewState: requireReviewState(row.review_state),
    rejectionCode: requireRejectionCode(row.rejection_code),
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAtMs: optionalNumber(row.reviewed_at_ms),
    applyState: requireApplyState(row.apply_state),
    applyLeaseToken: row.apply_lease_token ?? undefined,
    applyLeaseUntilMs: optionalNumber(row.apply_lease_until_ms),
    appliedAtMs: optionalNumber(row.applied_at_ms),
    appliedDocumentVersion: row.applied_document_version ?? undefined,
    appliedBodySha256: row.applied_body_sha256 ?? undefined,
    projectionBodySha256: row.projection_body_sha256 ?? undefined,
    cleanupCheckedAtMs: optionalNumber(row.cleanup_checked_at_ms),
    revision: row.revision,
    createdAtMs: requiredNumber(row.created_at_ms),
    updatedAtMs: requiredNumber(row.updated_at_ms),
  };
}

function clampListLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return STORE_BOUNDS.defaultListLimit;
  return Math.max(1, Math.min(STORE_BOUNDS.maxListLimit, Math.floor(value ?? 0)));
}

export class SharedWorldWikiProposalStore implements SharedWorldWikiProposalStorePort {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-shared-wiki-caretaker',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
    });
    this.ready = ensureSharedWikiSchema(this.pool);
    void this.ready.catch(() => undefined);
  }

  async submit(
    proposal: NormalizedSharedWorldWikiProposal,
    nowMs: number,
  ): Promise<SharedWorldWikiProposalSubmissionResult> {
    await this.ready;
    return withPostgresClient(this.pool, async (client) => {
      const proposalId = randomUUID();
      const inserted = await client.query<SharedWorldWikiProposalRow>(`
        INSERT INTO shared_wiki_proposals (
          proposal_id, site_id, document_id, actor_id, source_ref, title, body,
          tags_json, provenance_refs_json, sensitivity, content_digest,
          review_state, apply_state, revision, created_at_ms, updated_at_ms
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,'pending','unreviewed',1,$12,$12)
        ON CONFLICT (site_id, content_digest) DO NOTHING
        RETURNING ${SELECT_PROPOSAL_COLUMNS}
      `, [
        proposalId,
        proposal.siteId,
        proposal.documentId,
        proposal.actorId,
        proposal.sourceRef,
        proposal.title,
        proposal.body,
        JSON.stringify(proposal.tags),
        JSON.stringify(proposal.provenanceRefs),
        proposal.sensitivity,
        proposal.contentDigest,
        nowMs,
      ]);
      const insertedRow = inserted.rows.at(0);
      if (insertedRow) return { proposal: decodeProposal(insertedRow), deduplicated: false };
      const existing = await client.query<SharedWorldWikiProposalRow>(`
        SELECT ${SELECT_PROPOSAL_COLUMNS} FROM shared_wiki_proposals
        WHERE site_id = $1 AND content_digest = $2
      `, [proposal.siteId, proposal.contentDigest]);
      const existingRow = existing.rows.at(0);
      if (!existingRow) throw new Error('shared wiki proposal dedup conflict vanished');
      return { proposal: decodeProposal(existingRow), deduplicated: true };
    });
  }

  async list(query: SharedWorldWikiProposalListQuery = {}): Promise<SharedWorldWikiProposal[]> {
    await this.ready;
    const limit = clampListLimit(query.limit);
    const rows = query.state
      ? await queryRows<SharedWorldWikiProposalRow>(this.pool, `
          SELECT ${SELECT_PROPOSAL_COLUMNS} FROM shared_wiki_proposals
          WHERE review_state = $1 ORDER BY created_at_ms ASC, proposal_id ASC LIMIT $2
        `, [query.state, limit])
      : await queryRows<SharedWorldWikiProposalRow>(this.pool, `
          SELECT ${SELECT_PROPOSAL_COLUMNS} FROM shared_wiki_proposals
          ORDER BY created_at_ms ASC, proposal_id ASC LIMIT $1
        `, [limit]);
    return rows.map(decodeProposal);
  }

  async get(proposalId: string): Promise<SharedWorldWikiProposal | null> {
    await this.ready;
    const rows = await queryRows<SharedWorldWikiProposalRow>(this.pool, `
      SELECT ${SELECT_PROPOSAL_COLUMNS} FROM shared_wiki_proposals WHERE proposal_id = $1
    `, [proposalId]);
    const row = rows.at(0);
    return row ? decodeProposal(row) : null;
  }

  async review(input: {
    proposalId: string;
    decision: 'approve' | 'reject';
    operatorActorId: string;
    rejectionCode?: SharedWorldWikiRejectionCode | undefined;
    nowMs: number;
  }): Promise<SharedWorldWikiProposal> {
    await this.ready;
    return withPostgresClient(this.pool, async (client) => {
      const locked = await client.query<SharedWorldWikiProposalRow>(`
        SELECT ${SELECT_PROPOSAL_COLUMNS} FROM shared_wiki_proposals
        WHERE proposal_id = $1 FOR UPDATE
      `, [input.proposalId]);
      const currentRow = locked.rows.at(0);
      if (!currentRow) throw new Error('shared wiki proposal not found');
      const current = decodeProposal(currentRow);
      const targetState: SharedWorldWikiReviewState = input.decision === 'approve' ? 'approved' : 'rejected';
      if (current.reviewState === targetState) return current;
      if (current.reviewState !== 'pending') {
        throw new Error(`shared wiki proposal is already ${current.reviewState}`);
      }
      const rejectionCode = input.decision === 'reject'
        ? (input.rejectionCode ?? 'operator_rejected')
        : null;
      const applyState: SharedWorldWikiApplyState = input.decision === 'approve' ? 'ready' : 'rejected';
      const updated = await client.query<SharedWorldWikiProposalRow>(`
        UPDATE shared_wiki_proposals SET
          review_state = $2, rejection_code = $3, reviewed_by = $4,
          reviewed_at_ms = $5, apply_state = $6, revision = revision + 1,
          updated_at_ms = $5
        WHERE proposal_id = $1
        RETURNING ${SELECT_PROPOSAL_COLUMNS}
      `, [input.proposalId, targetState, rejectionCode, input.operatorActorId, input.nowMs, applyState]);
      const row = updated.rows.at(0);
      if (!row) throw new Error('shared wiki proposal review update failed');
      return decodeProposal(row);
    });
  }

  async claimApproved(proposalId: string, nowMs: number): Promise<SharedWorldWikiProposal | null> {
    await this.ready;
    const leaseToken = randomUUID();
    const leaseUntilMs = nowMs + STORE_BOUNDS.applyLeaseMs;
    const rows = await queryRows<SharedWorldWikiProposalRow>(this.pool, `
      UPDATE shared_wiki_proposals SET
        apply_state = 'applying', apply_lease_token = $2, apply_lease_until_ms = $3,
        revision = revision + 1, updated_at_ms = $4
      WHERE proposal_id = $1 AND review_state = 'approved' AND (
        apply_state IN ('ready', 'retryable')
        OR (apply_state = 'applying' AND apply_lease_until_ms < $4)
      )
      RETURNING ${SELECT_PROPOSAL_COLUMNS}
    `, [proposalId, leaseToken, leaseUntilMs, nowMs]);
    const row = rows.at(0);
    return row ? decodeProposal(row) : null;
  }

  async markApplied(input: {
    proposalId: string;
    leaseToken: string;
    documentVersion: number;
    bodySha256: string;
    nowMs: number;
  }): Promise<SharedWorldWikiProposal> {
    await this.ready;
    const rows = await queryRows<SharedWorldWikiProposalRow>(this.pool, `
      UPDATE shared_wiki_proposals SET
        apply_state = 'applied', apply_lease_token = NULL, apply_lease_until_ms = NULL,
        applied_at_ms = COALESCE(applied_at_ms, $3), applied_document_version = $4,
        applied_body_sha256 = $5, projection_body_sha256 = $5,
        cleanup_checked_at_ms = $3, revision = revision + 1, updated_at_ms = $3
      WHERE proposal_id = $1 AND apply_state = 'applying' AND apply_lease_token = $2
      RETURNING ${SELECT_PROPOSAL_COLUMNS}
    `, [input.proposalId, input.leaseToken, input.nowMs, input.documentVersion, input.bodySha256]);
    const row = rows.at(0);
    if (!row) throw new Error('shared wiki proposal apply lease was lost');
    return decodeProposal(row);
  }

  async markRetryable(proposalId: string, leaseToken: string, nowMs: number): Promise<void> {
    await this.ready;
    await this.pool.query(`
      UPDATE shared_wiki_proposals SET
        apply_state = 'retryable', apply_lease_token = NULL, apply_lease_until_ms = NULL,
        revision = revision + 1, updated_at_ms = $3
      WHERE proposal_id = $1 AND apply_state = 'applying' AND apply_lease_token = $2
    `, [proposalId, leaseToken, nowMs]);
  }

  async listCleanupCandidates(limit: number): Promise<SharedWorldWikiProposal[]> {
    await this.ready;
    const boundedLimit = Math.max(1, Math.min(STORE_BOUNDS.maxCleanupLimit, Math.floor(limit)));
    const rows = await queryRows<SharedWorldWikiProposalRow>(this.pool, `
      SELECT ${SELECT_PROPOSAL_COLUMNS} FROM shared_wiki_proposals
      WHERE review_state = 'approved' AND apply_state = 'applied'
      ORDER BY cleanup_checked_at_ms ASC NULLS FIRST, proposal_id ASC LIMIT $1
    `, [boundedLimit]);
    return rows.map(decodeProposal);
  }

  async markCleanupChecked(input: {
    proposalId: string;
    projectionBodySha256?: string | undefined;
    nowMs: number;
  }): Promise<void> {
    await this.ready;
    await this.pool.query(`
      UPDATE shared_wiki_proposals SET
        cleanup_checked_at_ms = $2,
        projection_body_sha256 = COALESCE($3, projection_body_sha256),
        updated_at_ms = $2
      WHERE proposal_id = $1 AND review_state = 'approved' AND apply_state = 'applied'
    `, [input.proposalId, input.nowMs, input.projectionBodySha256 ?? null]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
