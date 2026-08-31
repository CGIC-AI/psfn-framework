import { join } from 'node:path';

import { validateWorldReadProof } from '../../lib/persisted-proofs.mjs';
import {
  artifactContainsEvent,
  envText,
  proof,
  requireSatelliteEnv,
  sleep,
} from './common.mjs';

const GARDEN_AUDIT_FILE = 'garden-audit-history.jsonl';

export function buildWorldCases(ctx, services, env) {
  const physicalPrefix = 'PSFN_SHAKEDOWN_PHYSICAL_SATELLITE';
  const physicalPlaceId = envText(env, 'PSFN_SHAKEDOWN_PHYSICAL_PLACE_ID', 'living_room');

  return [{
    id: 's10_world_read_telemetry',
    tier: 'apprentice',
    variants: ['local', 'kube'],
    feature: 'psfn-framework-vinz.10',
    sessionId: `s10-world-read-${ctx.runToken}`,
    expectedTools: ['world'],
    message:
      `Use world with action "list", placeId "${physicalPlaceId}". `
      + `Then use world with action "perceive", placeId "${physicalPlaceId}". `
      + 'Do not use action "control".',
    proof: proof(
      'Garden audit plus TurnRecord.toolCalls',
      'synthetic telemetry has a Garden eventId and persisted world list/perceive calls',
    ),
    before: async ({ signal }) => {
      requireSatelliteEnv(env, physicalPrefix, 's10_world_read_telemetry');
      const nonce = `s10-world-${ctx.runToken}`;
      const telemetry = await services.fetchJson(`${services.apiBase}/v1/telemetry/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 's10-shakedown-synthetic',
          eventType: 'external.telemetry.status',
          timestamp: new Date().toISOString(),
          nonce,
          scope: 'presence',
          payload: {
            satelliteId: envText(env, `${physicalPrefix}_ID`, 's10-synthetic'),
            present: true,
            confidence: 1,
            occupancyCount: 1,
          },
        }),
        signal,
      });
      return {
        telemetry: {
          status: telemetry.status,
          eventId: telemetry.body?.id ?? null,
        },
      };
    },
    after: async ({ beforeChecks, signal }) => {
      const eventId = beforeChecks?.telemetry?.eventId;
      const auditPath = join(services.companionDataDir, GARDEN_AUDIT_FILE);
      let gardenAuditFound = false;
      for (let attempt = 0; attempt < 20 && !gardenAuditFound; attempt += 1) {
        gardenAuditFound = typeof eventId === 'string'
          && artifactContainsEvent(services.readJsonl(auditPath), eventId);
        if (!gardenAuditFound) await sleep(100, signal);
      }
      return {
        world: {
          telemetry: beforeChecks?.telemetry ?? null,
          gardenAuditFound,
        },
      };
    },
    validatePersistedProof: validateWorldReadProof,
  }];
}
