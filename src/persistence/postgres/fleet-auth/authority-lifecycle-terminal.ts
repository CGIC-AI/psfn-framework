import type { PoolClient } from 'pg';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

export async function acquireLifecycleDecisionLock(
  client: PoolClient,
  decisionId: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_lock(hashtextextended($1::text, 0))',
    [decisionId],
  );
}

export async function releaseLifecycleDecisionLock(
  client: PoolClient,
  decisionId: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_unlock(hashtextextended($1::text, 0))',
    [decisionId],
  );
}

export async function lifecycleDecisionIsTerminal(
  client: PoolClient,
  decisionId: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
      WHERE decision_id = $1
    ) AS present
  `, [decisionId]);
  return result.rows[0]?.present === true;
}
