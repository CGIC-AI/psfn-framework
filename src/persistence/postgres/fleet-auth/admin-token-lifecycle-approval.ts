import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { denyLifecycleMutation } from './authority-lifecycle-mutation-contract.js';
import {
  ADMIN_TOKEN_OPERATOR_LIFECYCLE_ACTIONS,
  adminTokenLifecycleApprovalAction,
  type VerifiedFleetAuthLifecycleDecision,
} from './authority-lifecycle-types.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

/**
 * Durable approval evidence for the audited ADMIN_TOKEN operator acting as the
 * approving authority of a fleet-auth lifecycle ceremony (psfn-framework-ja7n0).
 *
 * The row is written BEFORE the decision executes, under the authority lock,
 * and binds the exact decision id, ceremony, lifecycle action, companion and
 * authority snapshot. The lifecycle store re-reads it inside the decision
 * transaction; a missing, mismatched or stale row denies the transition, and
 * the authority epoch bump of a successful transition makes it single-use.
 */
const APPROVAL_AUDIT = Object.freeze({
  actorKind: 'admin_token_operator',
  boundary: 'fleet_auth_lifecycle',
  principalId: 'admin-token-operator',
  reasonCode: 'admin_token_lifecycle_approval_allowed',
});

type OperatorLifecycleAction = typeof ADMIN_TOKEN_OPERATOR_LIFECYCLE_ACTIONS[number];

export interface AdminTokenLifecycleApprovalRecord {
  authorizationEventId: string;
  authorityGeneration: number;
  globalAuthEpoch: number;
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid admin-token lifecycle approval ${field}`);
  }
  return parsed;
}

function isOperatorLifecycleAction(value: string): value is OperatorLifecycleAction {
  return (ADMIN_TOKEN_OPERATOR_LIFECYCLE_ACTIONS as readonly string[]).includes(value);
}

export async function recordAdminTokenLifecycleApproval(
  pool: Pool,
  input: {
    decisionId: string;
    ceremonyId: string;
    companionId: string;
    lifecycleAction: OperatorLifecycleAction;
  },
): Promise<AdminTokenLifecycleApprovalRecord> {
  if (!isOperatorLifecycleAction(input.lifecycleAction)) {
    throw new Error('ADMIN_TOKEN operator cannot approve this lifecycle action');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const authority = await client.query<{
      authority_generation: string;
      global_auth_epoch: string;
    }>(`SELECT authority_generation, global_auth_epoch FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()`);
    const row = authority.rows.at(0);
    if (!row) throw new Error('fleet_auth authority_state singleton is missing');
    const authorityGeneration = positiveInteger(row.authority_generation, 'authority_generation');
    const globalAuthEpoch = positiveInteger(row.global_auth_epoch, 'global_auth_epoch');
    const authorizationEventId = randomUUID();
    const inserted = await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         companion_id, principal_id, authority_generation, global_auth_epoch,
         occurred_at, ceremony_id, decision_context)
      VALUES ($1, $2::jsonb, $3, $4, 'allow', $5, $6, NULL, $7, $8,
              clock_timestamp(), $9, $10::jsonb)
    `, [
      authorizationEventId,
      JSON.stringify({
        kind: APPROVAL_AUDIT.actorKind,
        boundary: APPROVAL_AUDIT.boundary,
        principalId: APPROVAL_AUDIT.principalId,
      }),
      adminTokenLifecycleApprovalAction(input.lifecycleAction),
      `companion:${input.companionId}:fleet-auth-lifecycle`,
      APPROVAL_AUDIT.reasonCode,
      input.companionId,
      authorityGeneration,
      globalAuthEpoch,
      input.ceremonyId,
      JSON.stringify({
        schemaVersion: 1,
        lifecycleDecisionId: input.decisionId,
        lifecycleAction: input.lifecycleAction,
      }),
    ]);
    if (inserted.rowCount !== 1) {
      throw new Error('Admin-token lifecycle approval audit insert failed');
    }
    await client.query('COMMIT');
    return Object.freeze({ authorizationEventId, authorityGeneration, globalAuthEpoch });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Inside the decision transaction: the operator approval row must match the
 * decision exactly. Anything else denies (fail closed). The audit table is
 * append-only, so the row needs no lock; the authority lock and epoch check
 * already serialize the decision.
 */
export async function lockAndValidateAdminTokenLifecycleApproval(
  client: PoolClient,
  decision: VerifiedFleetAuthLifecycleDecision,
): Promise<void> {
  const operator = decision.operator;
  if (!operator || !isOperatorLifecycleAction(decision.action) || !('companionId' in decision)) {
    denyLifecycleMutation('operator_approval_invalid');
  }
  const result = await client.query(`
    SELECT event_id
    FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
    WHERE event_id = $1
      AND actor_context ->> 'kind' = $2
      AND actor_context ->> 'boundary' = $3
      AND decision = 'allow'
      AND reason_code = $4
      AND action = $5
      AND companion_id = $6
      AND resource = $7
      AND authority_generation = $8
      AND global_auth_epoch = $9
      AND ceremony_id = $10
      AND decision_context ->> 'lifecycleDecisionId' = $11
      AND decision_context ->> 'lifecycleAction' = $12
  `, [
    operator.authorizationEventId,
    APPROVAL_AUDIT.actorKind,
    APPROVAL_AUDIT.boundary,
    APPROVAL_AUDIT.reasonCode,
    adminTokenLifecycleApprovalAction(decision.action),
    decision.companionId,
    `companion:${decision.companionId}:fleet-auth-lifecycle`,
    decision.authorityGeneration,
    decision.globalAuthEpoch,
    decision.ceremonyId,
    decision.decisionId,
    decision.action,
  ]);
  if (result.rowCount !== 1) denyLifecycleMutation('operator_approval_audit_invalid');
}

/** Audit actor context for a lifecycle decision approved by the operator door. */
export function adminTokenLifecycleActorContext(authorizationEventId: string): Record<string, string> {
  return {
    kind: APPROVAL_AUDIT.actorKind,
    boundary: APPROVAL_AUDIT.boundary,
    principalId: APPROVAL_AUDIT.principalId,
    authorizationEventId,
  };
}
