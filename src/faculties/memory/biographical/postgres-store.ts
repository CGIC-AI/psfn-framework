import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  ensurePostgresSchemaWithAdvisoryLock,
  withPostgresClient,
} from '../../../persistence/postgres.js';
import {
  POSTGRES_BIOGRAPHICAL_PROFILE_MIGRATION_ADVISORY_LOCK,
  POSTGRES_BIOGRAPHICAL_PROFILE_MIGRATIONS,
} from '../../../persistence/postgres/biographical-profile-migrations.js';
import {
  deserializeClaim,
  finalizeBiographicalClaim,
  assertCompatibleSupersession,
  prepareBiographicalClaim,
  prepareBiographicalGrant,
  reevaluateClaimEffective,
  serializeClaim,
  type BiographicalClaimListOptions,
  type BiographicalClaimWriteInput,
  type BiographicalGrantRevokeInput,
  type BiographicalGrantWriteInput,
  type BiographicalProfileStorePort,
  type BiographicalSupersessionInput,
  type BiographicalSupersessionResult,
  type BiographicalTransitionInput,
  type PreparedBiographicalClaim,
  assertClaimTransition,
} from './store-port.js';
import {
  assertGrantRecord,
  BiographicalLifecycleError,
} from './kernel.js';
import type {
  BiographicalClaim,
  BiographicalClaimStatus,
  BiographicalSensitivityGrant,
  BiographicalSubjectRef,
} from './types.js';
import {
  computeBiographicalRebuildId,
  deserializeBiographicalRebuildRequest,
} from './lifecycle.js';
import type {
  BiographicalRebuildEnqueueInput,
  BiographicalRebuildEnqueueResult,
  BiographicalRebuildListOptions,
  BiographicalRebuildRequest,
} from './rebuild-contracts.js';
import {
  deserializeBiographicalReviewAudit,
  prepareBiographicalReviewAudit,
  type BiographicalReviewAuditInput,
  type BiographicalReviewAuditRecord,
} from './review-audit.js';

interface ClaimRow {
  claim_json: string;
}

interface GrantRow {
  grant_json: string;
}

interface RebuildRow {
  rebuild_json: unknown;
}

interface ReviewAuditRow {
  audit_json: unknown;
}

function subjectColumns(subject: BiographicalSubjectRef): {
  subjectKind: string;
  subjectId: string;
  subjectVersion: number;
} {
  return subject.kind === 'companion'
    ? {
      subjectKind: 'companion',
      subjectId: subject.companionId,
      subjectVersion: subject.subjectVersion,
    }
    : {
      subjectKind: 'contact',
      subjectId: subject.contactId,
      subjectVersion: subject.subjectVersion,
    };
}

/**
 * Postgres adapter for {@link BiographicalProfileStorePort}. All deterministic
 * validation/canonicalization/digest/sensitivity behavior is shared with the
 * in-memory adapter through the store-port helpers; this class is SQL storage.
 * The factory runs the idempotent {@link POSTGRES_BIOGRAPHICAL_PROFILE_MIGRATIONS}.
 */
export class PostgresBiographicalProfileStore implements BiographicalProfileStorePort {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly client?: PoolClient,
  ) {}

  private async queryRows<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await (this.client ?? this.pool).query<T>(text, [...values]);
    return result.rows;
  }

  private async queryOne<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T | undefined> {
    return (await this.queryRows<T>(text, values))[0];
  }

  private async inTransaction<T>(
    operation: (store: PostgresBiographicalProfileStore, client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (this.client !== undefined) return await operation(this, this.client);
    return await withPostgresClient(this.pool, async client => await operation(
      new PostgresBiographicalProfileStore(this.pool, this.now, client),
      client,
    ));
  }

  private async readClaim(id: string): Promise<BiographicalClaim> {
    const row = await this.queryOne<ClaimRow>(
      'SELECT claim_json FROM biographical_claims WHERE id = $1',
      [id],
    );
    if (!row) throw new Error(`biographical claim not found: ${id}`);
    return deserializeClaim(row.claim_json);
  }

  private async findGrantsByDigests(
    claimDigest: string,
    sourceSetDigest: string,
  ): Promise<BiographicalSensitivityGrant[]> {
    const rows = await this.queryRows<GrantRow>(
      `SELECT grant_json FROM biographical_grants
       WHERE claim_digest = $1 AND source_set_digest = $2`,
      [claimDigest, sourceSetDigest],
    );
    return rows.map(row => assertGrantRecord(row.grant_json));
  }

  private async findGrantsByClaimDigest(
    claimDigest: string,
  ): Promise<BiographicalSensitivityGrant[]> {
    const rows = await this.queryRows<GrantRow>(
      'SELECT grant_json FROM biographical_grants WHERE claim_digest = $1',
      [claimDigest],
    );
    return rows.map(row => assertGrantRecord(row.grant_json));
  }

  private async projectClaimAtReadTime(claim: BiographicalClaim, now: Date): Promise<BiographicalClaim> {
    const grants = await this.findGrantsByDigests(claim.claimDigest, claim.sourceSetDigest);
    return reevaluateClaimEffective(claim, grants, now);
  }

  private async insertClaimRow(claim: BiographicalClaim, now: Date): Promise<void> {
    const { subjectKind, subjectId, subjectVersion } = subjectColumns(claim.subject);
    const nowIso = now.toISOString();
    await (this.client ?? this.pool).query(
      `INSERT INTO biographical_claims
        (id, claim_digest, source_set_digest, schema_version, subject_kind,
         subject_id, subject_version, kind, status, effective_sensitivity,
         supersedes_claim_id, claim_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)`,
      [
        claim.id,
        claim.claimDigest,
        claim.sourceSetDigest,
        claim.schemaVersion,
        subjectKind,
        subjectId,
        subjectVersion,
        claim.kind,
        claim.status,
        claim.effectiveSensitivity,
        claim.supersedesClaimId ?? null,
        serializeClaim(claim),
        nowIso,
        nowIso,
      ],
    );
  }

  private async reevaluateClaimsForDigests(
    claimDigest: string,
    sourceSetDigest: string,
    now: Date,
  ): Promise<void> {
    await this.inTransaction(async (store, client) => {
      const result = await client.query<ClaimRow>(
        `SELECT claim_json FROM biographical_claims
         WHERE claim_digest = $1 AND source_set_digest = $2 FOR UPDATE`,
        [claimDigest, sourceSetDigest],
      );
      const grants = await store.findGrantsByDigests(claimDigest, sourceSetDigest);
      for (const row of result.rows) {
        const claim = deserializeClaim(row.claim_json);
        const updated = reevaluateClaimEffective(claim, grants, now);
        if (updated !== claim) {
          await client.query(
            `UPDATE biographical_claims SET
               status = $2, effective_sensitivity = $3, claim_json = $4::jsonb, updated_at = $5
             WHERE id = $1`,
            [
              updated.id,
              updated.status,
              updated.effectiveSensitivity,
              serializeClaim(updated),
              now.toISOString(),
            ],
          );
        }
      }
    });
  }

  async writeClaim(input: BiographicalClaimWriteInput): Promise<BiographicalClaim> {
    const now = input.now ?? new Date();
    const prepared: PreparedBiographicalClaim = prepareBiographicalClaim(input);
    const grants = await this.findGrantsByDigests(prepared.claimDigest, prepared.sourceSetDigest);
    const claim = finalizeBiographicalClaim(prepared, grants, now);
    await this.insertClaimRow(claim, now);
    return claim;
  }

  async getClaim(id: string): Promise<BiographicalClaim | undefined> {
    const row = await this.queryOne<ClaimRow>(
      'SELECT claim_json FROM biographical_claims WHERE id = $1',
      [id],
    );
    return row
      ? await this.projectClaimAtReadTime(deserializeClaim(row.claim_json), this.now())
      : undefined;
  }

  async listClaims(options: BiographicalClaimListOptions = {}): Promise<BiographicalClaim[]> {
    return await this.listClaimsWithBindings(options);
  }

  private async listClaimsWithBindings(
    options: BiographicalClaimListOptions,
  ): Promise<BiographicalClaim[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.subject !== undefined) {
      const { subjectKind, subjectId, subjectVersion } = subjectColumns(options.subject);
      params.push(subjectKind, subjectId, subjectVersion);
      conditions.push(
        `subject_kind = $${params.length - 2}
         AND subject_id = $${params.length - 1}
         AND subject_version = $${params.length}`,
      );
    }
    if (options.relatedSubject !== undefined) {
      const { subjectKind, subjectId, subjectVersion } = subjectColumns(options.relatedSubject);
      params.push(subjectKind, subjectId, subjectVersion);
      const idField = options.relatedSubject.kind === 'companion' ? 'companionId' : 'contactId';
      conditions.push(
        `claim_json->'relatedSubject'->>'kind' = $${params.length - 2}
         AND claim_json->'relatedSubject'->>'${idField}' = $${params.length - 1}
         AND (claim_json->'relatedSubject'->>'subjectVersion')::bigint = $${params.length}`,
      );
    }
    if (options.kind !== undefined) {
      params.push(options.kind);
      conditions.push(`kind = $${params.length}`);
    }
    if (options.status !== undefined) {
      params.push(options.status);
      conditions.push(`status = $${params.length}`);
    }
    if (options.includeTerminal !== true) {
      conditions.push(`status NOT IN ('superseded', 'revoked')`);
    }
    if (
      options.limit !== undefined
      && (!Number.isSafeInteger(options.limit) || options.limit < 1)
    ) {
      throw new Error('biographical claim list limit must be a positive integer');
    }
    if (
      options.offset !== undefined
      && (!Number.isSafeInteger(options.offset) || options.offset < 0)
    ) {
      throw new Error('biographical claim list offset must be a non-negative integer');
    }
    let paginationClause = '';
    if (options.limit !== undefined) {
      params.push(options.limit);
      paginationClause = `LIMIT $${params.length}`;
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
      paginationClause += ` OFFSET $${params.length}`;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.queryRows<ClaimRow>(
      `SELECT claim_json FROM biographical_claims ${where}
       ORDER BY created_at ASC, id ASC ${paginationClause}`,
      params,
    );
    const readAt = this.now();
    return await Promise.all(
      rows.map(async row => await this.projectClaimAtReadTime(deserializeClaim(row.claim_json), readAt)),
    );
  }

  async supersedeClaim(
    input: BiographicalSupersessionInput,
  ): Promise<BiographicalSupersessionResult> {
    const now = input.now ?? new Date();
    return await this.inTransaction(async (store, client) => {
      const priorRow = await client.query<ClaimRow>(
        'SELECT claim_json FROM biographical_claims WHERE id = $1 FOR UPDATE',
        [input.supersededClaimId],
      );
      const prior = priorRow.rows.at(0);
      if (!prior) throw new Error(`biographical claim not found: ${input.supersededClaimId}`);
      const priorClaim = deserializeClaim(prior.claim_json);
      if (priorClaim.status === 'superseded' || priorClaim.status === 'revoked') {
        throw new BiographicalLifecycleError(
          `claim ${input.supersededClaimId} is already terminal (${priorClaim.status})`,
        );
      }
      const prepared = prepareBiographicalClaim({
        id: randomUUID(),
        subject: input.subject,
        ...(input.relatedSubject !== undefined ? { relatedSubject: input.relatedSubject } : {}),
        kind: input.kind,
        value: input.value,
        basis: input.basis,
        ...(input.proposedSensitivity !== undefined
          ? { proposedSensitivity: input.proposedSensitivity }
          : {}),
        confidence: input.confidence,
        sources: input.sources,
        ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
        ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
        ...(input.depthDecision !== undefined ? { depthDecision: input.depthDecision } : {}),
        status: 'candidate',
        supersedesClaimId: input.supersededClaimId,
        now,
      });
      assertCompatibleSupersession(priorClaim, prepared);
      const grants = await store.findGrantsByDigests(prepared.claimDigest, prepared.sourceSetDigest);
      const superseding = finalizeBiographicalClaim(prepared, grants, now);
      const superseded: BiographicalClaim = {
        ...priorClaim,
        status: 'superseded' as BiographicalClaimStatus,
        lastSourceValidatedAt: now.toISOString(),
      };
      await client.query(
        `UPDATE biographical_claims SET
           status = $2, claim_json = $3::jsonb, updated_at = $4
         WHERE id = $1`,
        [
          superseded.id,
          superseded.status,
          serializeClaim(superseded),
          now.toISOString(),
        ],
      );
      await store.insertClaimRowClient(client, superseding, now);
      return { superseded, superseding };
    });
  }

  private async insertClaimRowClient(
    client: PoolClient,
    claim: BiographicalClaim,
    now: Date,
  ): Promise<void> {
    const { subjectKind, subjectId, subjectVersion } = subjectColumns(claim.subject);
    const nowIso = now.toISOString();
    await client.query(
      `INSERT INTO biographical_claims
        (id, claim_digest, source_set_digest, schema_version, subject_kind,
         subject_id, subject_version, kind, status, effective_sensitivity,
         supersedes_claim_id, claim_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)`,
      [
        claim.id,
        claim.claimDigest,
        claim.sourceSetDigest,
        claim.schemaVersion,
        subjectKind,
        subjectId,
        subjectVersion,
        claim.kind,
        claim.status,
        claim.effectiveSensitivity,
        claim.supersedesClaimId ?? null,
        serializeClaim(claim),
        nowIso,
        nowIso,
      ],
    );
  }

  async transitionClaim(input: BiographicalTransitionInput): Promise<BiographicalClaim> {
    const now = input.now ?? new Date();
    return await this.inTransaction(async (_store, client) => {
      const row = await client.query<ClaimRow>(
        'SELECT claim_json FROM biographical_claims WHERE id = $1 FOR UPDATE',
        [input.claimId],
      );
      const current = row.rows.at(0);
      if (!current) throw new Error(`biographical claim not found: ${input.claimId}`);
      const claim = deserializeClaim(current.claim_json);
      assertClaimTransition(claim, input.to, now);
      const updated: BiographicalClaim = {
        ...claim,
        status: input.to,
        lastSourceValidatedAt: now.toISOString(),
      };
      await client.query(
        `UPDATE biographical_claims SET
           status = $2, claim_json = $3::jsonb, updated_at = $4
         WHERE id = $1`,
        [updated.id, updated.status, serializeClaim(updated), now.toISOString()],
      );
      return updated;
    });
  }

  async recordGrant(input: BiographicalGrantWriteInput): Promise<BiographicalSensitivityGrant> {
    const { id, grant } = prepareBiographicalGrant(input);
    const fullGrant: BiographicalSensitivityGrant = { id, ...grant };
    await this.inTransaction(async (store, client) => {
      await client.query(
        `INSERT INTO biographical_grants
          (id, claim_digest, source_set_digest, schema_version, policy_version,
           granted_sensitivity, granted_at, expires_at, revoked_at, grant_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9::jsonb)`,
        [
          id,
          grant.claimDigest,
          grant.sourceSetDigest,
          grant.schemaVersion,
          grant.policyVersion,
          grant.grantedSensitivity,
          grant.grantedAt,
          grant.expiresAt ?? null,
          JSON.stringify(fullGrant),
        ],
      );
      await store.reevaluateClaimsForDigests(
        grant.claimDigest,
        grant.sourceSetDigest,
        input.now ?? new Date(),
      );
    });
    return fullGrant;
  }

  async listGrantsForClaim(claimId: string): Promise<BiographicalSensitivityGrant[]> {
    const claim = await this.readClaim(claimId);
    return await this.findGrantsByClaimDigest(claim.claimDigest);
  }

  async revokeGrant(
    grantId: string,
    input: BiographicalGrantRevokeInput,
  ): Promise<BiographicalSensitivityGrant> {
    const reason = input.reason.trim();
    if (reason.length === 0) throw new Error('revoke reason must be non-empty');
    const now = input.now ?? new Date();
    return await this.inTransaction(async (store, client) => {
      const row = await client.query<{ grant_json: string }>(
        'SELECT grant_json FROM biographical_grants WHERE id = $1 FOR UPDATE',
        [grantId],
      );
      const current = row.rows.at(0);
      if (!current) throw new Error(`biographical grant not found: ${grantId}`);
      const grant = assertGrantRecord(current.grant_json);
      if (grant.revokedAt !== undefined) {
        throw new Error(`biographical grant ${grantId} is already revoked`);
      }
      const next: BiographicalSensitivityGrant = {
        ...grant,
        revokedAt: now.toISOString(),
        revokedReason: reason,
      };
      await client.query(
        `UPDATE biographical_grants SET revoked_at = $2, grant_json = $3::jsonb WHERE id = $1`,
        [grantId, next.revokedAt, JSON.stringify(next)],
      );
      await store.reevaluateClaimsForDigests(next.claimDigest, next.sourceSetDigest, now);
      return next;
    });
  }

  async getGrant(grantId: string): Promise<BiographicalSensitivityGrant | undefined> {
    const row = await this.queryOne<{ grant_json: string }>(
      'SELECT grant_json FROM biographical_grants WHERE id = $1',
      [grantId],
    );
    return row ? assertGrantRecord(row.grant_json) : undefined;
  }

  async enqueueRebuild(
    input: BiographicalRebuildEnqueueInput,
  ): Promise<BiographicalRebuildEnqueueResult> {
    if (!Number.isSafeInteger(input.maxPending) || input.maxPending < 1) {
      throw new Error('biographical rebuild maxPending must be a positive integer');
    }
    const id = computeBiographicalRebuildId({
      claimId: input.claim.id,
      reason: input.reason,
      ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
      priorSourceSetDigest: input.claim.sourceSetDigest,
      ...(input.currentSourceSetDigest !== undefined
        ? { currentSourceSetDigest: input.currentSourceSetDigest }
        : {}),
      ...(input.targetSubject !== undefined ? { targetSubject: input.targetSubject } : {}),
    });
    return await this.inTransaction(async (store, client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('biographical-rebuild-queue'), hashtext('capacity'))`,
      );
      const existing = await store.queryOne<RebuildRow>(
        'SELECT rebuild_json FROM biographical_rebuild_queue WHERE id = $1',
        [id],
      );
      if (existing !== undefined) {
        return {
          status: 'coalesced',
          request: deserializeBiographicalRebuildRequest(existing.rebuild_json),
        };
      }
      const pending = await store.queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM biographical_rebuild_queue WHERE status = 'pending'`,
      );
      if (Number(pending?.count ?? '0') >= input.maxPending) {
        return { status: 'capacity-exhausted' };
      }
      const request: BiographicalRebuildRequest = {
        id,
        claimId: input.claim.id,
        subject: input.claim.subject,
        kind: input.claim.kind,
        reason: input.reason,
        ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
        priorSourceSetDigest: input.claim.sourceSetDigest,
        ...(input.currentSourceSetDigest !== undefined
          ? { currentSourceSetDigest: input.currentSourceSetDigest }
          : {}),
        ...(input.targetSubject !== undefined ? { targetSubject: input.targetSubject } : {}),
        status: 'pending',
        queuedAt: input.now.toISOString(),
      };
      const { subjectKind, subjectId, subjectVersion } = subjectColumns(request.subject);
      await client.query(
        `INSERT INTO biographical_rebuild_queue
          (id, claim_id, subject_kind, subject_id, subject_version, kind, reason,
           status, rebuild_json, queued_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb, $9, NULL)`,
        [
          id,
          request.claimId,
          subjectKind,
          subjectId,
          subjectVersion,
          request.kind,
          request.reason,
          JSON.stringify(request),
          request.queuedAt,
        ],
      );
      return { status: 'queued', request };
    });
  }

  async listRebuilds(options: BiographicalRebuildListOptions): Promise<BiographicalRebuildRequest[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error('biographical rebuild list limit must be a positive integer');
    }
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (options.status !== undefined) {
      params.push(options.status);
      conditions.push(`status = $${params.length}`);
    }
    if (options.claimId !== undefined) {
      params.push(options.claimId);
      conditions.push(`claim_id = $${params.length}`);
    }
    const whereClause = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    params.push(options.limit);
    const rows = await this.queryRows<RebuildRow>(
      `SELECT rebuild_json FROM biographical_rebuild_queue ${whereClause}
       ORDER BY queued_at ASC, id ASC LIMIT $${params.length}`,
      params,
    );
    return rows.map(row => deserializeBiographicalRebuildRequest(row.rebuild_json));
  }

  async completeRebuild(
    id: string,
    completion: NonNullable<BiographicalRebuildRequest['completion']>,
    now: Date,
  ): Promise<BiographicalRebuildRequest> {
    return await this.inTransaction(async (_store, client) => {
      const result = await client.query<RebuildRow>(
        'SELECT rebuild_json FROM biographical_rebuild_queue WHERE id = $1 FOR UPDATE',
        [id],
      );
      const stored = result.rows.at(0)?.rebuild_json;
      if (stored === undefined) throw new Error(`biographical rebuild not found: ${id}`);
      const current = deserializeBiographicalRebuildRequest(stored);
      if (current.status !== 'pending') {
        throw new Error(`biographical rebuild ${id} is already completed`);
      }
      const completed: BiographicalRebuildRequest = {
        ...current,
        status: 'completed',
        completion,
        completedAt: now.toISOString(),
      };
      await client.query(
        `UPDATE biographical_rebuild_queue
         SET status = 'completed', rebuild_json = $2::jsonb, completed_at = $3
         WHERE id = $1`,
        [id, JSON.stringify(completed), completed.completedAt],
      );
      return completed;
    });
  }

  async runClaimTransaction<T>(
    subject: BiographicalSubjectRef,
    kind: BiographicalClaim['kind'],
    operation: (store: BiographicalProfileStorePort) => Promise<T>,
  ): Promise<T> {
    if (this.client !== undefined) return await operation(this);
    const columns = subjectColumns(subject);
    const subjectKey = `${columns.subjectKind}:${columns.subjectId}:${columns.subjectVersion}`;
    return await this.inTransaction(async (store, client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [subjectKey, '*'],
      );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [subjectKey, kind],
      );
      return await operation(store);
    });
  }

  async recordReviewAudit(
    input: BiographicalReviewAuditInput,
  ): Promise<BiographicalReviewAuditRecord> {
    const record = prepareBiographicalReviewAudit(input);
    await (this.client ?? this.pool).query(
      `INSERT INTO biographical_review_audits
        (id, claim_id, claim_digest, source_set_digest, action, decision, reason,
         audit_json, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        record.id,
        record.claimId,
        record.claimDigest,
        record.sourceSetDigest,
        record.action,
        record.decision,
        record.reason,
        JSON.stringify(record),
        record.recordedAt,
      ],
    );
    return record;
  }

  async listReviewAudits(
    claimId: string,
    limit: number,
  ): Promise<BiographicalReviewAuditRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('biographical review audit limit must be a positive integer');
    }
    const rows = await this.queryRows<ReviewAuditRow>(
      `SELECT audit_json FROM biographical_review_audits
       WHERE claim_id = $1 ORDER BY recorded_at ASC, id ASC LIMIT $2`,
      [claimId, limit],
    );
    return rows.map(row => deserializeBiographicalReviewAudit(row.audit_json));
  }

  async runSubjectTransaction<T>(
    subject: BiographicalSubjectRef,
    operation: (store: BiographicalProfileStorePort) => Promise<T>,
  ): Promise<T> {
    if (this.client !== undefined) return await operation(this);
    const columns = subjectColumns(subject);
    const subjectKey = `${columns.subjectKind}:${columns.subjectId}:${columns.subjectVersion}`;
    return await this.inTransaction(async (store, client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [subjectKey, '*'],
      );
      return await operation(store);
    });
  }
}

/**
 * Create a {@link PostgresBiographicalProfileStore}, running the idempotent
 * biographical-profile migrations against the pool first. Self-contained so a
 * later tracer can wire it into composition without changing prompt behavior.
 */
export async function createPostgresBiographicalProfileStore(
  pool: Pool,
): Promise<PostgresBiographicalProfileStore> {
  await ensurePostgresSchemaWithAdvisoryLock(
    pool,
    POSTGRES_BIOGRAPHICAL_PROFILE_MIGRATIONS,
    POSTGRES_BIOGRAPHICAL_PROFILE_MIGRATION_ADVISORY_LOCK,
  );
  return new PostgresBiographicalProfileStore(pool);
}
