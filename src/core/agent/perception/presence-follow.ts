// Shared-satellite presence observation boundary.
//
// Presence is neutral information, not a summons. This module intentionally
// owns no movement target and exposes no handoff method. It replaces the old
// physical auto-follow decorator with a scope check that delivers normalized
// presence observations only to exact satellites.json recipients.

import type {
  SatelliteRegistryConfig,
  SatelliteTelemetryScope,
} from '../../../shared/contracts/satellite-registry.js';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import type { ResolvedPresence, ResolvedPresenceSink } from './identity-claim-resolver.js';
import type {
  PerceptionEvent,
  PerceptionEventSink,
} from './sensor-cognition-bridge.js';

export type SharedSatellitePresenceSink = ResolvedPresenceSink & PerceptionEventSink;

export interface SharedSatellitePresenceSinkOptions {
  inner: SharedSatellitePresenceSink;
  companionId?: CompanionId;
  satelliteRegistry?: SatelliteRegistryConfig;
}

function observationScope(event: PerceptionEvent): SatelliteTelemetryScope {
  // Face claims are reduced to an opaque identity handle by the sensor bridge.
  // They are a presence observation, never a grant of biometric/vision access.
  return event.scope === 'face' ? 'presence' : event.scope;
}

/**
 * Deliver only observations the local companion is explicitly allowed to
 * receive. Non-shared satellites preserve the single-companion note path.
 * Shared satellites fail closed if the local companion is not an exact
 * recipient for the normalized event scope.
 */
export function createSharedSatellitePresenceSink(
  options: SharedSatellitePresenceSinkOptions,
): SharedSatellitePresenceSink {
  function authorize(event: PerceptionEvent): SatelliteTelemetryScope | null {
    const satellite = options.satelliteRegistry?.satellites.find(
      candidate => candidate.satelliteId === event.satelliteId,
    );
    if (!satellite?.sharedDevice) return observationScope(event);
    if (!options.companionId) return null;
    const scope = observationScope(event);
    const recipient = satellite.sharedDevice.observationRecipients.find(
      candidate => candidate.companionId === options.companionId,
    );
    return recipient?.scopes.includes(scope) ? scope : null;
  }

  return {
    async handleResolvedPresence(presence: ResolvedPresence): Promise<void> {
      const scope = authorize(presence.event);
      if (!scope) return;
      await options.inner.handleResolvedPresence(presence);
    },
    async handlePerceptionEvent(event: PerceptionEvent): Promise<void> {
      const scope = authorize(event);
      if (!scope) return;
      await options.inner.handlePerceptionEvent(event);
    },
  };
}
