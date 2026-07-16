import type { Pool } from 'pg';
import type {
  HubDeviceAssertionReplayAuditContext,
  HubDeviceAssertionReplayStore,
} from '../../../boundary/fleet-auth/hub-device-assertion.js';
import { FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_NAME } from './hub-device-assertion-replay-sql.js';

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
    const result = await this.pool.query<{ outcome: string }>(`
      SELECT ${FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_NAME}(
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14
      ) AS outcome
    `, [
      input.issuer,
      input.jti,
      input.assertionDigest,
      input.deviceId,
      input.enrollmentVersion,
      input.expiresAt,
      input.auditContext.issuerDigest,
      input.auditContext.keyIdDigest,
      input.auditContext.audienceDigest,
      input.auditContext.companionIdDigest,
      input.auditContext.deviceIdDigest,
      input.auditContext.sessionIdDigest,
      input.auditContext.enrollmentVersionDigest,
      input.auditContext.jtiDigest,
    ]);
    const outcome = result.rows.at(0)?.outcome;
    if (outcome !== 'consumed' && outcome !== 'replayed' && outcome !== 'mismatch') {
      throw new Error('Hub device assertion replay procedure returned an invalid outcome');
    }
    return { outcome };
  }
}
