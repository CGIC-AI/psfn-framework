// fxt1 — gateway-side welfare grant verification.
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
// not a companionId, but a companion's rows live in ITS OWN store. In a
// single-companion deployment the gateway shares that one schema (possibly the
// default search_path) and reads it directly.
//
// psfn-framework-h248l.7: a FLEET deployment does not. The gateway holds no
// sibling background-work grant in an isolated-role topology, so the old
// fleet-schema map probed relations it could never read, the optional verifier
// went unavailable at readiness time, and every sibling companion's genuine
// welfare claim was silently stripped. Fleet verification is now a companion-
// local authority question asked over the authenticated reverse-RPC channel
// (`welfare.grant.verify`), the same seam `icp.policy.*` uses: the companion
// answers from its own store over its own connection, so a job id belonging to
// another companion is simply not found. The gateway needs no fleet schema
// map, no sibling privilege, and no dedicated verifier credential at all.
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
import { assertPostgresRelationColumns } from '../../persistence/postgres/relation-contract.js';
import {
  WELFARE_GRANT_VERIFY_METHOD,
  parseWelfareGrantVerifyResult,
} from './welfare-grant-contract.js';

const log = createComponentLogger('GatewayWelfareGrant');

/** JSON-RPC "Method not found" — an agent that predates this contract. */
const METHOD_NOT_FOUND_JSONRPC_CODE = -32601;

/**
 * Narrow read-only accessor the gateway RPC boundary calls to decide whether a
 * caller-asserted `preemptionProtected` is backed by a genuine welfare
 * escalation. Returns `true` only when `jobId` names a `welfare_claimed`,
 * `running` background-work row owned (schema-scoped) by `companionId`. May
 * throw on a database/verify error — the caller treats any throw as a strip
 * (fail closed) and logs it; the accessor never swallows.
 */
export interface WelfareGrantVerifier {
  assertReady(): Promise<void>;
  verify(jobId: string, companionId: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Single-companion scope: one companion, one schema (undefined ⇒ the default
 * search_path). A fleet never uses this — see
 * {@link CompanionAuthorityWelfareGrantVerifier}.
 */
export interface WelfareGrantVerifierScope {
  readonly mode: 'single';
  readonly schema?: string;
}

class PostgresWelfareGrantVerifier implements WelfareGrantVerifier {
  constructor(
    private readonly pool: Pool,
    private readonly scope: WelfareGrantVerifierScope,
  ) {}

  /** Privilege-safe catalog proof of every tenant relation/column consumed. */
  async assertReady(): Promise<void> {
    const schema = this.scope.schema;
    await assertPostgresRelationColumns(this.pool, {
      ...(schema ? { schema: assertValidPostgresSchemaName(schema) } : {}),
      relation: 'agent_background_work_jobs',
      columns: ['job_id', 'welfare_claimed', 'state'],
      privileges: ['SELECT'],
    });
  }

  async verify(jobId: string, companionId: string): Promise<boolean> {
    if (typeof jobId !== 'string' || jobId.trim().length === 0) return false;
    if (typeof companionId !== 'string' || companionId.trim().length === 0) return false;

    // Single indexed lookup (job_id is the PRIMARY KEY). The table is qualified
    // with the validated companion schema when present; the schema name is a
    // strictly-validated lowercase identifier (config guard + this re-check), so
    // interpolation is injection-safe.
    const qualifier = this.scope.schema
      ? `"${assertValidPostgresSchemaName(this.scope.schema)}".`
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Bounded, content-free evidence for a fleet verification that could not be
 * completed. Never carries the job id (a bearer-ish token) or any store detail.
 */
export type WelfareGrantVerifyFailureReason =
  | 'timeout'
  | 'method_unavailable'
  | 'malformed_response'
  | 'companion_mismatch'
  | 'authority_unavailable';

function classifyVerifyFailure(error: unknown): WelfareGrantVerifyFailureReason {
  const code = (error as { code?: unknown } | null)?.code;
  // JSON-RPC "Method not found": an agent older than this contract. Version
  // skew is evidence, not a silent success — the caller still strips.
  if (code === METHOD_NOT_FOUND_JSONRPC_CODE) return 'method_unavailable';
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/iu.test(message)) return 'timeout';
  return 'authority_unavailable';
}

/**
 * Fleet verification through the authenticated companion's own local authority.
 *
 * The gateway opens no tenant schema: it asks the companion named by the
 * connection, and the companion answers from its own background-work store over
 * its own database connection. That connection scoping IS the ownership binding
 * — companion B's job id is simply absent from companion A's store — and the
 * echoed companion id proves the answer came from the companion that was asked.
 *
 * Every failure mode (unknown companion, timeout, missing method, malformed
 * response, identity mismatch, store failure) resolves to a strip with bounded
 * evidence. Errors are normalized and rethrown, never swallowed: the RPC
 * boundary logs the reason code and proceeds preemptable.
 */
export class CompanionAuthorityWelfareGrantVerifier implements WelfareGrantVerifier {
  constructor(
    private readonly options: {
      readonly companionIds: ReadonlySet<string>;
      requestCompanionAgent(
        companionId: string,
        method: string,
        params: unknown,
      ): Promise<unknown>;
    },
  ) {}

  /**
   * Nothing to probe. The authority is each companion's own store, proven by
   * that companion at its own startup; the gateway holds no sibling grant and
   * must not require one to become ready.
   */
  async assertReady(): Promise<void> {
    return undefined;
  }

  async verify(jobId: string, companionId: string): Promise<boolean> {
    if (typeof jobId !== 'string' || jobId.trim().length === 0) return false;
    if (typeof companionId !== 'string' || companionId.trim().length === 0) return false;
    if (!this.options.companionIds.has(companionId)) {
      // Unknown companion: no authority to ask → fail closed. Never broadcast
      // the question to the fleet (that would let any companion borrow
      // another's welfare-claimed job id on a shared endpoint).
      log.debug('Welfare grant verify: no fleet authority for authenticated companion; stripping', {
        companionId,
      });
      return false;
    }

    let raw: unknown;
    try {
      raw = await this.options.requestCompanionAgent(
        companionId,
        WELFARE_GRANT_VERIFY_METHOD,
        { jobId: jobId.trim(), companionId },
      );
    } catch (error) {
      throw new Error(
        `Welfare grant verification is unavailable (${classifyVerifyFailure(error)})`,
        { cause: error },
      );
    }

    let result;
    try {
      result = parseWelfareGrantVerifyResult(raw);
    } catch (error) {
      throw new Error(
        'Welfare grant verification is unavailable (malformed_response)',
        { cause: error },
      );
    }
    if (result.companionId !== companionId) {
      throw new Error('Welfare grant verification is unavailable (companion_mismatch)');
    }
    return result.granted;
  }

  async close(): Promise<void> {
    return undefined;
  }
}

export interface WelfareGrantVerifierConfig {
  databaseUrl: string;
  /** Single-companion schema (undefined ⇒ default search_path). */
  postgresSchema?: string;
}

/**
 * Construct the Postgres-backed SINGLE-COMPANION welfare grant verifier over the
 * gateway's existing companion database. A fleet uses
 * {@link CompanionAuthorityWelfareGrantVerifier} instead and needs no credential. Read-only: a small dedicated pool that runs one
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

  const scope: WelfareGrantVerifierScope = {
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
