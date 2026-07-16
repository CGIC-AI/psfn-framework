// psfn-framework-fxt1 — gateway-side welfare grant verification.
//
// `preemptionProtected` on an autonomous LLMWorkSpec is consumed at the
// gateway-side ModelCallGate (`model-call-gate.ts` — a protected call is not
// preemptable). Welfare authority is dynamic runtime state that lives ONLY in
// the agent's background-work store (`agent_background_work_jobs.welfare_claimed`
// set by the sanctioned supervisor path); no lane, transport identity, or
// self-signed token a caller presents can manufacture it. So the gateway
// re-verifies the wire-carried `welfareGrantJobId` against that store before
// honoring the flag, and strips it on any failure (fail closed → preemptable).
//
// Companion ownership (design §8): background-work rows carry `logical_session_id`,
// not a companionId, but a fleet companion's rows live in ITS OWN Postgres schema
// (`config.postgresSchema`, distinct per companion — see composition.ts). Scoping
// the verify query to the authenticated companion's schema IS the ownership
// binding: companion A's connection resolves to companion A's schema, so a job id
// from companion B's schema is simply not found → strip. A single-companion
// deployment has one schema (possibly the default search_path).
//
// Law 12.4: this is not a second admission/credential system. The caller declares
// `preemptionProtected`; the gateway re-verifies against the single authority (the
// store's `welfare_claimed`), exactly the d8vq.2 declare-then-reverify pattern
// applied to `lane`. No TTL tokens, nonces, or keyring.

import type { Pool } from 'pg';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
  queryOne,
} from '../../persistence/postgres.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('GatewayWelfareGrant');

/**
 * Narrow read-only accessor the gateway RPC boundary calls to decide whether a
 * caller-asserted `preemptionProtected` is backed by a genuine welfare
 * escalation. Returns `true` only when `jobId` names a `welfare_claimed`,
 * `running` background-work row owned (schema-scoped) by `companionId`. May
 * throw on a database/verify error — the caller treats any throw as a strip
 * (fail closed) and logs it; the accessor never swallows.
 */
export interface WelfareGrantVerifier {
  verify(jobId: string, companionId: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * How the verifier resolves an authenticated companion to the Postgres schema
 * holding its background-work rows.
 *  - `single`: one companion; one schema (undefined ⇒ default search_path).
 *  - `fleet`: strict companionId → schema map; an unknown companion fails closed.
 */
export type WelfareGrantVerifierScope =
  | { readonly mode: 'single'; readonly schema?: string }
  | { readonly mode: 'fleet'; readonly schemaByCompanionId: ReadonlyMap<string, string> };

type ResolvedSchema =
  | { readonly ok: true; readonly schema: string | undefined }
  | { readonly ok: false };

class PostgresWelfareGrantVerifier implements WelfareGrantVerifier {
  constructor(
    private readonly pool: Pool,
    private readonly scope: WelfareGrantVerifierScope,
  ) {}

  async verify(jobId: string, companionId: string): Promise<boolean> {
    if (typeof jobId !== 'string' || jobId.trim().length === 0) return false;
    if (typeof companionId !== 'string' || companionId.trim().length === 0) return false;

    const resolved = this.resolveSchema(companionId);
    if (!resolved.ok) {
      // Unknown fleet companion: no schema to scope to → fail closed. Never
      // query an unscoped table (that would let any companion borrow another's
      // welfare-claimed job id on a shared endpoint).
      log.debug('Welfare grant verify: no schema for authenticated companion; stripping', {
        companionId,
      });
      return false;
    }

    // Single indexed lookup (job_id is the PRIMARY KEY). The table is qualified
    // with the validated companion schema when present; the schema name is a
    // strictly-validated lowercase identifier (config guard + this re-check), so
    // interpolation is injection-safe.
    const qualifier = resolved.schema
      ? `"${assertValidPostgresSchemaName(resolved.schema)}".`
      : '';
    const row = await queryOne<{ granted: boolean }>(
      this.pool,
      `SELECT EXISTS (
         SELECT 1 FROM ${qualifier}agent_background_work_jobs
         WHERE job_id = $1
           AND welfare_claimed = true
           AND state = 'running'
       ) AS granted`,
      [jobId.trim()],
    );
    return row?.granted === true;
  }

  private resolveSchema(companionId: string): ResolvedSchema {
    if (this.scope.mode === 'single') {
      return { ok: true, schema: this.scope.schema };
    }
    const schema = this.scope.schemaByCompanionId.get(companionId);
    if (schema === undefined) return { ok: false };
    return { ok: true, schema };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface WelfareGrantVerifierConfig {
  databaseUrl: string;
  /** Single-companion schema (undefined ⇒ default search_path). Ignored when `fleet` is set. */
  postgresSchema?: string;
  /** Fleet companions; when present, verification is strict per-companion-schema. */
  fleet?: ReadonlyArray<{ companionId: string; postgresSchema: string }>;
}

/**
 * Construct the Postgres-backed welfare grant verifier over the gateway's
 * existing companion database. Read-only: a small dedicated pool that runs one
 * indexed SELECT per verify. Returns `undefined` when there is no database URL
 * to bind — the caller then strips every asserted `preemptionProtected` (fail
 * closed), losing only the anti-starvation optimization.
 */
export function createWelfareGrantVerifier(
  config: WelfareGrantVerifierConfig,
): WelfareGrantVerifier | undefined {
  const databaseUrl = config.databaseUrl.trim();
  if (!databaseUrl) return undefined;

  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-welfare-verify',
    allowExitOnIdle: true,
    max: 4,
  });

  const scope: WelfareGrantVerifierScope = config.fleet
    ? {
        mode: 'fleet',
        schemaByCompanionId: new Map(
          config.fleet.map(companion => [companion.companionId, companion.postgresSchema]),
        ),
      }
    : {
        mode: 'single',
        ...(config.postgresSchema?.trim() ? { schema: config.postgresSchema.trim() } : {}),
      };

  return new PostgresWelfareGrantVerifier(pool, scope);
}

/** Test seam: build a verifier over an already-constructed pool + scope. */
export function createWelfareGrantVerifierForPool(
  pool: Pool,
  scope: WelfareGrantVerifierScope,
): WelfareGrantVerifier {
  return new PostgresWelfareGrantVerifier(pool, scope);
}
