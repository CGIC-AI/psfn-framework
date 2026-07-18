import { join } from 'node:path';

import { validateHubIdentityProof } from '../../lib/persisted-proofs.mjs';
import {
  artifactContainsEvent,
  envText,
  proof,
  requireCaseEnv,
  requireSatelliteEnv,
  sha256,
  sleep,
} from './common.mjs';

const GARDEN_AUDIT_FILE = 'garden-audit-history.jsonl';

async function postPresenceTelemetry(services, satelliteId, scope, payload, nonce) {
  return services.fetchJson(`${services.apiBase}/v1/telemetry/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: satelliteId,
      eventType: 'external.telemetry.status',
      timestamp: new Date().toISOString(),
      nonce,
      scope,
      payload: { satelliteId, ...payload },
    }),
  });
}

async function waitForInternalPlace(services, expectedPlaceId) {
  let internalState = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    [internalState] = await services.pgAll(
      `select state #>> '{situated,location,placeId}' as place_id
       from internal_state_snapshots where id = 'current';`,
    );
    if (internalState?.place_id === expectedPlaceId) break;
    await sleep(100);
  }
  return internalState;
}

export function buildHubIdentityCases(ctx, services, env) {
  const hubPrefix = 'PSFN_SHAKEDOWN_HUB_SATELLITE';
  const physicalPrefix = 'PSFN_SHAKEDOWN_PHYSICAL_SATELLITE';
  const hubPlaceId = envText(env, 'PSFN_SHAKEDOWN_HUB_PLACE_ID', 'kitchen');
  const restorePlaceId = envText(env, 'PSFN_SHAKEDOWN_PHYSICAL_PLACE_ID', 'living_room');
  const companionId = envText(env, 'COMPANION_ID');
  const requireSharedPresence = envText(env, 'PSFN_MULTI_COMPANION').toLowerCase() === 'true';

  return [{
    id: 's10_hub_identity_presence_follow',
    tier: 'nursery',
    variants: ['local'],
    feature: 'psfn-framework-vinz.14',
    sessionId: `s10-hub-identity-${ctx.runToken}`,
    message: 'Briefly acknowledge this hub identity enrollment and presence-follow probe.',
    proof: proof(
      'telemetry audit plus Postgres enrollment/audit/internal state/shared presence',
      'an enrolled opaque face claim resolves to the contact and moves presence to its satellite place',
    ),
    before: async () => {
      requireSatelliteEnv(env, hubPrefix, 's10_hub_identity_presence_follow');
      requireSatelliteEnv(env, physicalPrefix, 's10_hub_identity_presence_follow');
      requireCaseEnv(env, ['COMPANION_ID'], 's10_hub_identity_presence_follow');
      if (!ctx.primaryContactId) {
        throw new Error('s10_hub_identity_presence_follow requires a canonical primary contact');
      }

      const restoreSatelliteId = envText(env, `${physicalPrefix}_ID`);
      const resetTelemetry = await postPresenceTelemetry(
        services,
        restoreSatelliteId,
        'presence',
        { present: true, confidence: 1, occupancyCount: 1 },
        `s10-hub-reset-${sha256(ctx.runToken).slice(0, 24)}`,
      );
      if (resetTelemetry.status !== 202) {
        throw new Error(`hub precondition telemetry failed with HTTP ${String(resetTelemetry.status)}`);
      }
      const priorInternalState = await waitForInternalPlace(services, restorePlaceId);
      if (priorInternalState?.place_id !== restorePlaceId || restorePlaceId === hubPlaceId) {
        throw new Error('hub presence-follow requires distinct physical restore and hub destination places');
      }

      const hubIdentityId = envText(
        env,
        'PSFN_SHAKEDOWN_HUB_IDENTITY_ID',
        `s10-hub-${sha256(ctx.runToken).slice(0, 24)}`,
      );
      const enrollmentResponse = await services.fetchJson(
        `${services.adminBase}/api/admin/enrollments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hubIdentityId,
            canonicalContactId: ctx.primaryContactId,
            satelliteId: envText(env, `${hubPrefix}_ID`),
            endpointId: envText(env, `${hubPrefix}_ENDPOINT_ID`),
          }),
        },
      );
      if (enrollmentResponse.status !== 201) {
        throw new Error(`hub enrollment failed with HTTP ${String(enrollmentResponse.status)}`);
      }
      const telemetry = await postPresenceTelemetry(
        services,
        envText(env, `${hubPrefix}_ID`),
        'face',
        { identityClaim: { hubIdentityId, confidence: 1 } },
        `s10-hub-${sha256(`${ctx.runToken}:${hubIdentityId}`).slice(0, 32)}`,
      );
      if (telemetry.status !== 202) {
        await services.fetchJson(
          `${services.adminBase}/api/admin/enrollments/${encodeURIComponent(hubIdentityId)}`,
          { method: 'DELETE' },
        );
        throw new Error(`hub face telemetry failed with HTTP ${String(telemetry.status)}`);
      }
      return {
        hubIdentityId,
        telemetry: {
          status: telemetry.status,
          eventId: telemetry.body?.id ?? null,
        },
        priorPlaceId: priorInternalState.place_id,
      };
    },
    after: async ({ beforeChecks }) => {
      const hubIdentityId = beforeChecks?.hubIdentityId;
      if (typeof hubIdentityId !== 'string') {
        throw new Error('hub identity setup did not return its opaque handle');
      }
      let enrollment = null;
      let enrollmentAudit = null;
      let internalState = null;
      let presence = null;
      let gardenAuditFound = false;
      let cleanup = { revoked: false, restoredPlaceId: null };
      try {
        [enrollment] = await services.pgAll(
          `select hub_identity_id, contact_id, status
           from hub_identity_enrollments where hub_identity_id = $1;`,
          [hubIdentityId],
        );
        [enrollmentAudit] = await services.pgAll(
          `select action, actor from hub_identity_enrollment_audit
           where hub_identity_id = $1 order by id desc limit 1;`,
          [hubIdentityId],
        );
        for (let attempt = 0; attempt < 50; attempt += 1) {
          [internalState] = await services.pgAll(
            `select state #>> '{situated,location,placeId}' as place_id
             from internal_state_snapshots where id = 'current';`,
          );
          if (requireSharedPresence) {
            [presence] = await services.pgAll(
              `select companion_id::text, place_id from shared.companion_presence
               where companion_id = $1 order by updated_at desc limit 1;`,
              [companionId],
            );
          }
          if (
            internalState?.place_id === hubPlaceId
            && (!requireSharedPresence || presence?.place_id === hubPlaceId)
          ) {
            break;
          }
          await sleep(100);
        }
        const eventId = beforeChecks?.telemetry?.eventId;
        const auditPath = join(services.companionDataDir, GARDEN_AUDIT_FILE);
        for (let attempt = 0; attempt < 20 && !gardenAuditFound; attempt += 1) {
          gardenAuditFound = typeof eventId === 'string'
            && artifactContainsEvent(services.readJsonl(auditPath), eventId);
          if (!gardenAuditFound) await sleep(100);
        }
      } finally {
        const revoke = await services.fetchJson(
          `${services.adminBase}/api/admin/enrollments/${encodeURIComponent(hubIdentityId)}`,
          { method: 'DELETE' },
        );
        const restore = await postPresenceTelemetry(
          services,
          envText(env, `${physicalPrefix}_ID`),
          'presence',
          { present: true, confidence: 1, occupancyCount: 1 },
          `s10-hub-restore-${sha256(`${ctx.runToken}:${Date.now()}`).slice(0, 24)}`,
        );
        const restored = restore.status === 202
          ? await waitForInternalPlace(services, restorePlaceId)
          : null;
        cleanup = {
          revoked: revoke.status === 200,
          restoredPlaceId: restored?.place_id ?? null,
        };
      }
      return {
        hubIdentity: {
          expected: {
            hubIdentityId,
            contactId: ctx.primaryContactId,
            companionId,
            placeId: hubPlaceId,
            restorePlaceId,
            requireSharedPresence,
            priorPlaceId: beforeChecks?.priorPlaceId ?? null,
          },
          enrollment: enrollment
            ? {
              hubIdentityId: enrollment.hub_identity_id,
              contactId: enrollment.contact_id,
              status: enrollment.status,
            }
            : null,
          enrollmentAudit: enrollmentAudit
            ? { action: enrollmentAudit.action, actor: enrollmentAudit.actor }
            : null,
          internalState: { placeId: internalState?.place_id ?? null },
          presence: { placeId: presence?.place_id ?? null },
          telemetry: {
            ...(beforeChecks?.telemetry ?? {}),
            gardenAuditFound,
          },
          cleanup,
        },
      };
    },
    validatePersistedProof: validateHubIdentityProof,
  }];
}
