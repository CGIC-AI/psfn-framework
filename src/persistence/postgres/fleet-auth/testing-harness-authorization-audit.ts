import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  GardenDoorAuthorizationAuditPort,
  GardenDoorAuthorizationAuditResult,
} from '../../../boundary/gateway/testing-harness-garden-door.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid Garden door authorization ${field}`);
  }
  return parsed;
}

const DOOR_AUDIT_LABELS = {
  testing_harness: {
    actorKind: 'testing_harness',
    reasonCode: 'testing_harness_garden_authorization_allowed',
    authorizationSource: 'gateway_testing_harness',
    correlationDomain: 'testing-harness-garden-correlation-v1',
  },
  admin_token: {
    actorKind: 'admin_token_operator',
    reasonCode: 'admin_token_garden_authorization_allowed',
    authorizationSource: 'gateway_admin_token',
    correlationDomain: 'admin-token-garden-correlation-v1',
  },
} as const;

/**
 * Persists a synthetic Garden door authorization (testing harness or the
 * ADMIN_TOKEN operator) before a request capability can be minted. The authority lock makes the audit row and the
 * capability's authority versions one atomic snapshot.
 */
export class PostgresGardenDoorAuthorizationAudit
implements GardenDoorAuthorizationAuditPort {
  constructor(private readonly options: {
    pool: Pool;
    sessionPepper: string;
    now?: () => Date;
  }) {}

  async record(
    input: Parameters<GardenDoorAuthorizationAuditPort['record']>[0],
  ): Promise<GardenDoorAuthorizationAuditResult> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const authorizationEventId = randomUUID();
      const occurredAt = this.options.now?.() ?? new Date();
      const labels = DOOR_AUDIT_LABELS[input.provider];
      const correlationDigest = createHmac('sha256', this.options.sessionPepper)
        .update(`${labels.correlationDomain}\0`)
        .update(input.correlationId)
        .digest('hex');
      const result = await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
          (event_id, actor_context, action, resource, decision, reason_code,
           companion_id, principal_id, authority_generation, global_auth_epoch,
           correlation_id, occurred_at, decision_id, decision_context)
        VALUES ($1, $2::jsonb, $3, $4, 'allow', $11,
                $5, NULL, $6, $7, $8, $9, $1, $10::jsonb)
      `, [
        authorizationEventId,
        JSON.stringify({
          kind: labels.actorKind,
          boundary: 'fleet_sso_router',
          provider: input.provider,
          principalId: input.principalId,
        }),
        input.action,
        `companion:${input.companionId}:garden`,
        input.companionId,
        authority.authorityGeneration,
        authority.globalAuthEpoch,
        correlationDigest,
        occurredAt,
        JSON.stringify({
          schemaVersion: 1,
          authorizationSource: labels.authorizationSource,
          principalId: input.principalId,
          provider: input.provider,
        }),
        labels.reasonCode,
      ]);
      if (result.rowCount !== 1) {
        throw new Error(`Garden door authorization audit insert failed (${input.provider})`);
      }
      await client.query('COMMIT');
      return Object.freeze({
        authorizationEventId,
        authorityGeneration: authority.authorityGeneration,
        globalAuthEpoch: authority.globalAuthEpoch,
        occurredAt,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockAuthority(client: PoolClient): Promise<{
    authorityGeneration: number;
    globalAuthEpoch: number;
  }> {
    const result = await client.query<{
      authority_generation: string;
      global_auth_epoch: string;
    }>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
    `);
    const row = result.rows.at(0);
    if (!row) throw new Error('fleet_auth authority_state singleton is missing');
    return {
      authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
      globalAuthEpoch: positiveInteger(row.global_auth_epoch, 'global_auth_epoch'),
    };
  }
}
