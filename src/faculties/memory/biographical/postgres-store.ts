import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  ensurePostgresSchemaWithAdvisoryLock,
  executeQuery,
  queryOne,
  queryRows,
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

interface ClaimRow {
  claim_json: string;
}

interface GrantRow {
  grant_json: string;
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
  ) {}

  private async readClaim(id: string): Promise<BiographicalClaim> {
    const row = await queryOne<ClaimRow>(
      this.pool,
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
    const rows = await queryRows<GrantRow>(
      this.pool,
      `SELECT grant_json FROM biographical_grants
       WHERE claim_digest = $1 AND source_set_digest = $2`,
      [claimDigest, sourceSetDigest],
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
    await executeQuery(
      this.pool,
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
    await withPostgresClient(this.pool, async (client) => {
      const result = await client.query<ClaimRow>(
        `SELECT claim_json FROM biographical_claims
         WHERE claim_digest = $1 AND source_set_digest = $2 FOR UPDATE`,
        [claimDigest, sourceSetDigest],
      );
      const grants = await this.findGrantsByDigests(claimDigest, sourceSetDigest);
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
    const row = await queryOne<ClaimRow>(
      this.pool,
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
    let paginationClause = '';
    if (options.limit !== undefined) {
      params.push(options.limit);
      paginationClause = `LIMIT $${params.length}`;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await queryRows<ClaimRow>(
      this.pool,
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
    return await withPostgresClient(this.pool, async (client) => {
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
      const grants = await this.findGrantsByDigests(prepared.claimDigest, prepared.sourceSetDigest);
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
      await this.insertClaimRowClient(client, superseding, now);
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
    return await withPostgresClient(this.pool, async (client) => {
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
    await executeQuery(
      this.pool,
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
    await this.reevaluateClaimsForDigests(
      grant.claimDigest,
      grant.sourceSetDigest,
      input.now ?? new Date(),
    );
    return fullGrant;
  }

  async listGrantsForClaim(claimId: string): Promise<BiographicalSensitivityGrant[]> {
    const claim = await this.readClaim(claimId);
    return await this.findGrantsByDigests(claim.claimDigest, claim.sourceSetDigest);
  }

  async revokeGrant(
    grantId: string,
    input: BiographicalGrantRevokeInput,
  ): Promise<BiographicalSensitivityGrant> {
    const reason = input.reason.trim();
    if (reason.length === 0) throw new Error('revoke reason must be non-empty');
    const now = input.now ?? new Date();
    const revoked = await withPostgresClient(this.pool, async (client) => {
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
      return next;
    });
    // Re-evaluate matching claims after the grant row is durably revoked.
    await this.reevaluateClaimsForDigests(revoked.claimDigest, revoked.sourceSetDigest, now);
    return revoked;
  }

  async getGrant(grantId: string): Promise<BiographicalSensitivityGrant | undefined> {
    const row = await queryOne<{ grant_json: string }>(
      this.pool,
      'SELECT grant_json FROM biographical_grants WHERE id = $1',
      [grantId],
    );
    return row ? assertGrantRecord(row.grant_json) : undefined;
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
