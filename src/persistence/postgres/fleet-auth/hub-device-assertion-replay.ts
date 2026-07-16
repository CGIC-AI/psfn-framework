import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { v5 as uuidv5 } from 'uuid';
import type {
  HubDeviceAssertionReplayAuditContext,
  HubDeviceAssertionReplayStore,
} from '../../../boundary/fleet-auth/hub-device-assertion.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

interface ReplayRow {
  assertion_digest: string;
}

const MUTATED_REPLAY_AUDIT_NAMESPACE = uuidv5(
  'psfn:fleet-auth:hub-device-assertion:mutated-replay',
  uuidv5.URL,
);

function mutatedReplayCorrelationId(input: {
  issuer: string;
  jti: string;
  acceptedAssertionDigest: string;
  mutatedAssertionDigest: string;
}): string {
  return createHash('sha256').update(JSON.stringify([
    input.issuer,
    input.jti,
    input.acceptedAssertionDigest,
    input.mutatedAssertionDigest,
  ])).digest('hex');
}

export class PostgresHubDeviceAssertionReplayStore implements HubDeviceAssertionReplayStore {
  constructor(private readonly pool: Pool) {}

  async consume(input: {
    issuer: string;
    jti: string;
    assertionDigest: string;
    deviceId: string;
    enrollmentVersion: number;
    expiresAt: Date;
    auditContext: HubDeviceAssertionReplayAuditContext;
  }): Promise<{ outcome: 'consumed' | 'replayed' | 'mismatch' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.hub_device_assertion_replays
         WHERE expires_at <= clock_timestamp()`,
      );
      const inserted = await client.query<{ assertion_digest: string }>(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.hub_device_assertion_replays
           (issuer, jti, assertion_digest, device_id, enrollment_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (issuer, jti) DO NOTHING
         RETURNING assertion_digest`,
        [
          input.issuer,
          input.jti,
          input.assertionDigest,
          input.deviceId,
          input.enrollmentVersion,
          input.expiresAt,
        ],
      );
      if (inserted.rows.length === 1) {
        await client.query('COMMIT');
        return { outcome: 'consumed' };
      }
      const existing = await client.query<ReplayRow>(
        `SELECT assertion_digest
         FROM ${FLEET_AUTH_SCHEMA_NAME}.hub_device_assertion_replays
         WHERE issuer = $1 AND jti = $2
         FOR UPDATE`,
        [input.issuer, input.jti],
      );
      const digest = existing.rows.at(0)?.assertion_digest;
      if (!digest) throw new Error('Hub device assertion replay ledger conflict was not readable');
      const outcome = digest === input.assertionDigest ? 'replayed' : 'mismatch';
      if (outcome === 'replayed') {
        await client.query(
          `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.hub_device_assertion_replays
           SET replay_count = replay_count + 1,
               last_replayed_at = clock_timestamp()
           WHERE issuer = $1 AND jti = $2`,
          [input.issuer, input.jti],
        );
      } else {
        await client.query(
          `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.hub_device_assertion_replays
           SET mismatch_count = mismatch_count + 1,
               last_mismatch_digest = $3,
               last_mismatch_at = clock_timestamp()
           WHERE issuer = $1 AND jti = $2`,
          [input.issuer, input.jti, input.assertionDigest],
        );
        const correlationId = mutatedReplayCorrelationId({
          issuer: input.issuer,
          jti: input.jti,
          acceptedAssertionDigest: digest,
          mutatedAssertionDigest: input.assertionDigest,
        });
        const eventId = uuidv5(correlationId, MUTATED_REPLAY_AUDIT_NAMESPACE);
        const decisionContext = {
          ...input.auditContext,
          schemaVersion: 1,
          acceptedAssertionDigest: digest,
          mutatedAssertionDigest: input.assertionDigest,
        };
        const insertedAudit = await client.query<{ event_id: string }>(
          `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
             (event_id, actor_context, action, resource, decision, reason_code,
              authority_generation, global_auth_epoch, correlation_id,
              occurred_at, decision_context)
           SELECT $1, '{"kind":"hub_device_assertion"}'::jsonb,
                  'hub_device_assertion.verify', 'hub-device-assertion-replay',
                  'deny', 'mutated_replay', authority.authority_generation,
                  authority.global_auth_epoch, $2, clock_timestamp(), $3::jsonb
           FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority
           WHERE authority.singleton = TRUE
           ON CONFLICT DO NOTHING
           RETURNING event_id`,
          [eventId, correlationId, JSON.stringify(decisionContext)],
        );
        if (insertedAudit.rows.length === 0) {
          const existingAudit = await client.query<{ compatible: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
               WHERE event_id = $1::uuid
                 AND correlation_id = $2
                 AND actor_context = '{"kind":"hub_device_assertion"}'::jsonb
                 AND action = 'hub_device_assertion.verify'
                 AND resource = 'hub-device-assertion-replay'
                 AND decision = 'deny'
                 AND reason_code = 'mutated_replay'
                 AND companion_id IS NULL
                 AND principal_id IS NULL
                 AND decision_id IS NULL
                 AND ceremony_id IS NULL
                 AND reason_digest IS NULL
                 AND decision_context = $3::jsonb
             ) AS compatible`,
            [eventId, correlationId, JSON.stringify(decisionContext)],
          );
          if (existingAudit.rows.at(0)?.compatible !== true) {
            throw new Error('Hub device assertion mutated-replay audit conflict was not compatible');
          }
        }
      }
      await client.query('COMMIT');
      return { outcome };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
