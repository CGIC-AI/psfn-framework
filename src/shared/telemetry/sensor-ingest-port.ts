import type { EventBus, ExternalTelemetryEvent } from '../event-bus.js';
import {
  satelliteAdmitsAuthenticatedTelemetryScope,
  type SatelliteRegistryConfig,
  type SatelliteTelemetryScope,
} from '../contracts/satellite-registry.js';
import type { CompanionId } from '../routing/companion-id.js';
import { isRecord } from '../utils/types.js';

export interface SensorIngestReceipt {
  id: string;
  acceptedEventType: string;
  event: ExternalTelemetryEvent;
}

export interface SensorIngestPort {
  ingestTelemetry(event: ExternalTelemetryEvent): Promise<SensorIngestReceipt>;
}

export interface SharedSatelliteObservationDelivery {
  companionId: CompanionId;
  scope: SatelliteTelemetryScope;
  event: ExternalTelemetryEvent;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function resolveSatelliteId(event: ExternalTelemetryEvent): string | undefined {
  const direct = readNonEmptyString(event.payload, ['satelliteId', 'satellite_id']);
  if (direct) return direct;
  for (const key of ['origin', 'satellite', 'site', 'sensor']) {
    const nested = event.payload[key];
    if (!isRecord(nested)) continue;
    const satelliteId = readNonEmptyString(nested, ['satelliteId', 'satellite_id', 'id']);
    if (satelliteId) return satelliteId;
  }
  return event.source.trim() || undefined;
}

function copyScalar(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      target[key] = value;
      return;
    }
  }
}

/**
 * Resolve exact recipients and strip a shared-device observation to the
 * minimum normalized fields cognition consumes. Raw payload keys, room
 * history, and unrelated scopes never cross the companion routing boundary.
 */
export function resolveSharedSatelliteObservationDeliveries(input: {
  event: ExternalTelemetryEvent;
  registry: SatelliteRegistryConfig;
}): SharedSatelliteObservationDelivery[] | null {
  if (!input.registry.enabled) return [];
  const satelliteId = resolveSatelliteId(input.event);
  const satellite = input.registry.satellites.find(
    candidate => candidate.satelliteId === satelliteId,
  );
  const rawScope = input.event.scope?.trim();
  const isPresenceOrLocation = rawScope === 'face'
    || rawScope === 'presence'
    || rawScope === 'location';
  if (!satellite) return isPresenceOrLocation ? [] : null;
  const scope: SatelliteTelemetryScope | undefined = rawScope === 'face'
    ? 'presence'
    : rawScope === 'presence' || rawScope === 'location'
      ? rawScope
      : undefined;
  if (!scope) return [];
  if (!satellite.sharedDevice) return [];
  if (!input.event.auth
    || !satelliteAdmitsAuthenticatedTelemetryScope(satellite, input.event.auth, scope)) {
    return [];
  }

  const payload: Record<string, unknown> = { satelliteId: satellite.satelliteId };
  if (satellite.placeId) payload.placeId = satellite.placeId;
  if (rawScope === 'face') {
    copyScalar(payload, input.event.payload, ['type', 'kind', 'event', 'eventType', 'action']);
    const rawClaim = input.event.payload.identityClaim
      ?? input.event.payload.identity_claim
      ?? input.event.payload.claim;
    if (isRecord(rawClaim)) {
      const claim: Record<string, unknown> = {};
      copyScalar(claim, rawClaim, ['hubIdentityId', 'hub_identity_id']);
      copyScalar(claim, rawClaim, ['confidence', 'score', 'probability']);
      payload.claim = claim;
    } else {
      const claim: Record<string, unknown> = {};
      copyScalar(claim, input.event.payload, ['hubIdentityId', 'hub_identity_id']);
      copyScalar(claim, input.event.payload, ['confidence', 'score', 'probability']);
      payload.claim = claim;
    }
  } else if (scope === 'presence') {
    copyScalar(payload, input.event.payload, ['action', 'state', 'status', 'presence']);
    copyScalar(payload, input.event.payload, ['present', 'detected', 'occupied']);
    copyScalar(payload, input.event.payload, ['confidence', 'score', 'probability']);
    copyScalar(payload, input.event.payload, ['occupancyCount', 'occupancy_count', 'count']);
  }

  const event: ExternalTelemetryEvent = {
    ...input.event,
    payload,
    channelId: `satellite-observation:${satellite.satelliteId}`,
    scope: rawScope === 'face' ? 'face' : scope,
  };
  return satellite.sharedDevice.observationRecipients
    .filter(recipient => recipient.scopes.includes(scope))
    .map(recipient => ({ companionId: recipient.companionId, scope, event }));
}

export function createEventBusSensorIngestPort(
  eventBus: Pick<EventBus, 'emit'>,
): SensorIngestPort {
  return {
    async ingestTelemetry(event) {
      await eventBus.emit('external.telemetry.ingested', { event });
      return {
        id: event.id,
        acceptedEventType: event.eventType,
        event,
      };
    },
  };
}
