import { join } from 'node:path';

import { CaseConfigurationError } from '../../lib/case-execution.mjs';
import { validateSituatedPresenceProof } from '../../lib/persisted-proofs.mjs';
import {
  envText,
  issueHubDeviceAssertionHeaders,
  proof,
  requireSatelliteDispatchAuth,
  requireSatelliteEnv,
  satelliteHeaders,
} from './common.mjs';

const PLACES_REGISTRY_FILE = 'places.json';

function requireMindspaceFixture(registry, placeId, mirrorsPlaceId) {
  const places = Array.isArray(registry?.places) ? registry.places : [];
  const place = places.find((entry) => entry?.placeId === placeId);
  if (place?.kind !== 'virtual' || place?.mirrorsPlaceId !== mirrorsPlaceId) {
    throw new CaseConfigurationError(
      'missing_fixture:places.json.mindspace',
      `s10_mindspace_virtual requires virtual place ${placeId} mirroring ${mirrorsPlaceId}`,
    );
  }
  return registry;
}

export function buildPresenceCases(ctx, services, env) {
  const physicalPrefix = 'PSFN_SHAKEDOWN_PHYSICAL_SATELLITE';
  const placelessPrefix = 'PSFN_SHAKEDOWN_PLACELESS_SATELLITE';
  const physicalPlaceId = envText(env, 'PSFN_SHAKEDOWN_PHYSICAL_PLACE_ID', 'living_room');
  const physicalPlaceLabel = envText(env, 'PSFN_SHAKEDOWN_PHYSICAL_PLACE_LABEL', 'Living Room');
  const physicalAffordanceLabel = envText(
    env,
    'PSFN_SHAKEDOWN_PHYSICAL_AFFORDANCE_LABEL',
    'Living Room Presence',
  );
  const mindspacePlaceId = envText(env, 'PSFN_SHAKEDOWN_MINDSPACE_PLACE_ID', 'living_room_twin');
  const mindspaceMirrorId = envText(env, 'PSFN_SHAKEDOWN_MINDSPACE_MIRROR_ID', 'living_room');
  const placesPath = join(services.systemDataDir, PLACES_REGISTRY_FILE);
  const physicalHeaders = satelliteHeaders(env, physicalPrefix);

  return [
    {
      id: 's10_places_physical',
      tier: 'all',
      variants: ['local', 'kube'],
      feature: 'psfn-framework-vinz.19',
      sessionId: `s10-places-physical-${ctx.runToken}`,
      headers: physicalHeaders,
      resolveDispatchAuth: () => requireSatelliteDispatchAuth(
        env,
        physicalPrefix,
        's10_places_physical',
      ),
      resolveAttemptHeaders: () => issueHubDeviceAssertionHeaders({
        services, env, prefix: physicalPrefix, caseId: 's10_places_physical',
      }),
      message: 'Briefly acknowledge this physical-room presence probe.',
      proof: proof(
        'TurnRecord.observability.snapshot.promptContext.runtimeContextSections',
        'runtime_situated_presence carries the physical place and configured affordance',
      ),
      before: async () => {
        requireSatelliteEnv(env, physicalPrefix, 's10_places_physical');
        requireSatelliteDispatchAuth(env, physicalPrefix, 's10_places_physical');
        return { placesRegistry: services.readJsonIfExists(placesPath) };
      },
      validatePersistedProof: ({ turnRecord }) => validateSituatedPresenceProof({
        turnRecord,
        expected: {
          mode: 'physical',
          placeId: physicalPlaceId,
          placeLabel: physicalPlaceLabel,
          affordanceLabel: physicalAffordanceLabel,
        },
      }),
    },
    {
      id: 's10_places_placeless',
      tier: 'all',
      variants: ['local', 'kube'],
      feature: 'psfn-framework-vinz.19',
      sessionId: `s10-places-placeless-${ctx.runToken}`,
      headers: satelliteHeaders(env, placelessPrefix),
      resolveDispatchAuth: () => requireSatelliteDispatchAuth(
        env,
        physicalPrefix,
        's10_places_placeless',
      ),
      resolveAttemptHeaders: () => issueHubDeviceAssertionHeaders({
        services, env, prefix: placelessPrefix, caseId: 's10_places_placeless',
      }),
      message: 'Briefly acknowledge this deliberately placeless endpoint probe.',
      proof: proof(
        'TurnRecord.observability.snapshot.promptContext.runtimeContextSections',
        'a registered endpoint with no place emits no situated-presence block',
      ),
      before: async () => {
        requireSatelliteEnv(env, placelessPrefix, 's10_places_placeless');
        requireSatelliteDispatchAuth(env, physicalPrefix, 's10_places_placeless');
        return {};
      },
      validatePersistedProof: ({ turnRecord }) => validateSituatedPresenceProof({
        turnRecord,
        expected: { mode: 'placeless' },
      }),
    },
    {
      id: 's10_mindspace_virtual',
      tier: 'all',
      variants: ['local', 'kube'],
      feature: 'psfn-framework-vinz.29',
      sessionId: `s10-mindspace-${ctx.runToken}`,
      message: 'Briefly acknowledge this plain-channel shared-mindspace probe.',
      proof: proof(
        'TurnRecord runtime_situated_presence plus system-data/places.json',
        'plain-channel dual presence names the virtual room and its physical mirror',
      ),
      before: async () => ({
        placesRegistry: requireMindspaceFixture(
          services.readJsonIfExists(placesPath),
          mindspacePlaceId,
          mindspaceMirrorId,
        ),
      }),
      validatePersistedProof: ({ turnRecord, beforeChecks }) => validateSituatedPresenceProof({
        turnRecord,
        expected: {
          mode: 'mindspace',
          placeId: mindspacePlaceId,
          mirrorsPlaceId: mindspaceMirrorId,
          placesRegistry: beforeChecks?.placesRegistry,
        },
      }),
    },
    {
      id: 's10_mindspace_physical_precedence',
      tier: 'all',
      variants: ['local', 'kube'],
      feature: 'psfn-framework-vinz.29',
      sessionId: `s10-mindspace-physical-${ctx.runToken}`,
      headers: physicalHeaders,
      resolveDispatchAuth: () => requireSatelliteDispatchAuth(
        env,
        physicalPrefix,
        's10_mindspace_physical_precedence',
      ),
      resolveAttemptHeaders: () => issueHubDeviceAssertionHeaders({
        services, env, prefix: physicalPrefix,
        caseId: 's10_mindspace_physical_precedence',
      }),
      message: 'Briefly acknowledge this classified physical-presence precedence probe.',
      proof: proof(
        'TurnRecord runtime_situated_presence and location',
        'classified satellite presence is physical and suppresses the mindspace fallback',
      ),
      before: async () => {
        requireSatelliteEnv(env, physicalPrefix, 's10_mindspace_physical_precedence');
        requireSatelliteDispatchAuth(
          env,
          physicalPrefix,
          's10_mindspace_physical_precedence',
        );
        return {};
      },
      validatePersistedProof: ({ turnRecord }) => validateSituatedPresenceProof({
        turnRecord,
        expected: {
          mode: 'physical',
          placeId: physicalPlaceId,
          placeLabel: physicalPlaceLabel,
        },
      }),
    },
  ];
}
