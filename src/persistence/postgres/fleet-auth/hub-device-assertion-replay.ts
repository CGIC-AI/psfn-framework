import type { Pool } from 'pg';
import type { HubDeviceAssertionReplayStore } from '../../../boundary/fleet-auth/hub-device-assertion.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

interface ReplayRow {
  assertion_digest: string;
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
