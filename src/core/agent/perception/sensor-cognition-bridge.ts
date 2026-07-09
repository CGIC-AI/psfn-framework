// Sensor-to-cognition perception bridge.
//
// This module is intentionally a bridge only: it normalizes selected external
// telemetry into typed PerceptionEvent values and hands them to a
// PerceptionEventSink. Delivery into session notes, memory, contact resolution,
// proactive wakeups, or active-emanation handoff belongs to later workstreams.
// The explicit sink port below is the seam those follow-up beads plug into.

import type {
  EventBus,
  ExternalTelemetryEvent,
  PerceptionBridgeTelemetryCounter,
} from '../../../shared/event-bus.js';
import type {
  PlaceConfig,
  PlacesRegistryConfig,
} from '../../../shared/contracts/places-registry.js';
import type {
  SatelliteConfig,
  SatelliteRegistryConfig,
} from '../../../shared/contracts/satellite-registry.js';
import { satelliteAdmitsAuthenticatedOrigin } from '../../../shared/contracts/satellite-registry.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';

const log = createComponentLogger('SensorCognitionBridge');
const MAX_SEEN_EVENT_KEYS = 1_024;
const RAW_BIOMETRIC_KEYS = new Set([
  'biometricTemplate',
  'biometric_template',
  'descriptor',
  'embedding',
  'faceDescriptor',
  'face_descriptor',
  'faceEmbedding',
  'face_embedding',
  'frame',
  'image',
  'imageBytes',
  'image_bytes',
  'photo',
  'template',
]);

type PerceptionScope = 'presence' | 'face';

interface ResolvedTelemetryOrigin {
  satellite: SatelliteConfig;
  place: PlaceConfig;
  satelliteId: string;
  placeId: string;
  siteId: string;
  channelId?: string;
  affordanceId?: string;
}

interface PerceptionEventBase {
  eventId: string;
  rawEventType: string;
  source: string;
  occurredAt: string;
  receivedAt: string;
  scope: PerceptionScope;
  satelliteId: string;
  siteId: string;
  placeId: string;
  placeDisplayName: string;
  channelId?: string;
  affordanceId?: string;
}

export interface PresencePerceptionEvent extends PerceptionEventBase {
  kind: 'presence';
  action: 'detected' | 'cleared';
  confidence?: number;
  occupancyCount?: number;
}

export interface IdentityClaimPerceptionEvent extends PerceptionEventBase {
  kind: 'identity_claim';
  action: 'observed';
  hubIdentityId: string;
  confidence: number;
  claimSource: 'face';
}

export type PerceptionEvent =
  | PresencePerceptionEvent
  | IdentityClaimPerceptionEvent;

export interface PerceptionEventSink {
  handlePerceptionEvent(event: PerceptionEvent): void | Promise<void>;
}

export const NOOP_PERCEPTION_EVENT_SINK: PerceptionEventSink = Object.freeze({
  handlePerceptionEvent: () => undefined,
});

export function createNoopPerceptionEventSink(): PerceptionEventSink {
  return NOOP_PERCEPTION_EVENT_SINK;
}

export type PerceptionNormalizationFailureKind = 'ignored' | 'malformed' | 'unrecognized';

export interface PerceptionNormalizationFailure {
  ok: false;
  kind: PerceptionNormalizationFailureKind;
  reason: string;
  satelliteId?: string;
  placeId?: string;
}

export type PerceptionNormalizationResult =
  | { ok: true; event: PerceptionEvent }
  | PerceptionNormalizationFailure;

export interface SensorCognitionBridgeOptions {
  eventBus: EventBus;
  satelliteRegistry?: SatelliteRegistryConfig;
  placesRegistry?: PlacesRegistryConfig;
  sink?: PerceptionEventSink;
  logger?: Pick<typeof log, 'warn'>;
  now?: () => number;
}

export interface SensorCognitionBridge {
  readonly active: boolean;
  unsubscribe(): void;
  handleTelemetryEvent(event: ExternalTelemetryEvent): Promise<void>;
}

interface RegistryIndexes {
  satelliteById: Map<string, SatelliteConfig>;
  placeById: Map<string, PlaceConfig>;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function readFiniteNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function readRecord(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  return undefined;
}

function normalizeScope(scope: string | undefined): PerceptionScope | undefined {
  const normalized = scope?.trim();
  return normalized === 'presence' || normalized === 'face' ? normalized : undefined;
}

function buildRegistryIndexes(input: {
  satelliteRegistry?: SatelliteRegistryConfig;
  placesRegistry?: PlacesRegistryConfig;
}): RegistryIndexes {
  return {
    satelliteById: new Map((input.satelliteRegistry?.satellites ?? []).map(satellite => [
      satellite.satelliteId,
      satellite,
    ])),
    placeById: new Map((input.placesRegistry?.places ?? []).map(place => [
      place.placeId,
      place,
    ])),
  };
}

function hasActiveBridgeConfig(input: {
  satelliteRegistry?: SatelliteRegistryConfig;
  placesRegistry?: PlacesRegistryConfig;
}): boolean {
  if (input.satelliteRegistry?.enabled !== true) return false;
  if (!input.placesRegistry || input.placesRegistry.places.length === 0) return false;
  return input.satelliteRegistry.satellites.some((satellite) => {
    if (!satellite.placeId) return false;
    return input.placesRegistry?.places.some(place => place.placeId === satellite.placeId) === true;
  });
}

function containsRawBiometricPayload(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(value)) {
    return value.some(entry => containsRawBiometricPayload(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (RAW_BIOMETRIC_KEYS.has(key)) return true;
    if (containsRawBiometricPayload(nested, depth + 1)) return true;
  }
  return false;
}

function readOriginRecord(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return readRecord(payload, ['origin', 'satellite', 'site', 'sensor']);
}

function resolveTelemetryOrigin(
  event: ExternalTelemetryEvent,
  indexes: RegistryIndexes,
): ResolvedTelemetryOrigin | PerceptionNormalizationFailure {
  const payload = event.payload;
  const origin = readOriginRecord(payload);
  const satelliteId = readString(payload, ['satelliteId', 'satellite_id'])
    ?? (origin ? readString(origin, ['satelliteId', 'satellite_id', 'id']) : undefined)
    ?? (indexes.satelliteById.has(event.source) ? event.source : undefined);
  if (!satelliteId) {
    return { ok: false, kind: 'malformed', reason: 'missing_satellite_origin' };
  }

  const satellite = indexes.satelliteById.get(satelliteId);
  if (!satellite) {
    return { ok: false, kind: 'malformed', reason: 'unregistered_satellite_origin', satelliteId };
  }

  // Sprint-10 04-M1: the payload-claimed satellite origin is only honored
  // when the credential that authenticated the ingest request is admitted by
  // that satellite's registered endpoint auth (principal binding, and cert
  // binding for mTLS endpoints). Telemetry without an authenticated origin
  // context fails closed.
  if (!event.auth) {
    return { ok: false, kind: 'malformed', reason: 'missing_authenticated_origin', satelliteId };
  }
  if (!satelliteAdmitsAuthenticatedOrigin(satellite, event.auth)) {
    return { ok: false, kind: 'malformed', reason: 'satellite_origin_not_authorized_for_principal', satelliteId };
  }

  if (!satellite.placeId) {
    return { ok: false, kind: 'malformed', reason: 'satellite_has_no_place_binding', satelliteId };
  }

  const place = indexes.placeById.get(satellite.placeId);
  if (!place) {
    return {
      ok: false,
      kind: 'malformed',
      reason: 'satellite_place_binding_unresolved',
      satelliteId,
      placeId: satellite.placeId,
    };
  }

  const claimedPlaceId = readString(payload, ['placeId', 'place_id'])
    ?? (origin ? readString(origin, ['placeId', 'place_id']) : undefined);
  if (claimedPlaceId && claimedPlaceId !== satellite.placeId) {
    return {
      ok: false,
      kind: 'malformed',
      reason: 'claimed_place_does_not_match_satellite_binding',
      satelliteId,
      placeId: claimedPlaceId,
    };
  }

  const claimedSiteId = readString(payload, ['siteId', 'site_id'])
    ?? (origin ? readString(origin, ['siteId', 'site_id']) : undefined);
  if (claimedSiteId && claimedSiteId !== place.siteId) {
    return {
      ok: false,
      kind: 'malformed',
      reason: 'claimed_site_does_not_match_bound_place',
      satelliteId,
      placeId: place.placeId,
    };
  }

  return {
    satellite,
    place,
    satelliteId,
    placeId: place.placeId,
    siteId: place.siteId,
    channelId: event.channelId,
    affordanceId: readString(payload, ['affordanceId', 'affordance_id'])
      ?? (origin ? readString(origin, ['affordanceId', 'affordance_id']) : undefined),
  };
}

function normalizePresenceAction(event: ExternalTelemetryEvent): 'detected' | 'cleared' | undefined {
  const payload = event.payload;
  const present = readBoolean(payload, ['present', 'detected', 'occupied']);
  if (present === true) return 'detected';
  if (present === false) return 'cleared';

  const tokens = [
    readString(payload, ['action', 'state', 'status', 'presence']),
    readString(payload, ['event', 'eventType', 'type', 'kind']),
    event.eventType,
  ].filter((token): token is string => Boolean(token));

  for (const token of tokens) {
    const normalized = token.trim().toLowerCase().replaceAll('_', '-');
    if ([
      'detected',
      'entered',
      'occupied',
      'present',
      'presence-detected',
      'presence.detected',
      'external.telemetry.presence-detected',
    ].includes(normalized)) {
      return 'detected';
    }
    if ([
      'absent',
      'cleared',
      'exited',
      'not-present',
      'unoccupied',
      'presence-cleared',
      'presence.cleared',
      'external.telemetry.presence-cleared',
    ].includes(normalized)) {
      return 'cleared';
    }
  }
  return undefined;
}

function normalizePresenceEvent(
  event: ExternalTelemetryEvent,
  scope: PerceptionScope,
  origin: ResolvedTelemetryOrigin,
): PerceptionNormalizationResult {
  const action = normalizePresenceAction(event);
  if (!action) {
    return {
      ok: false,
      kind: 'unrecognized',
      reason: 'unrecognized_presence_event_shape',
      satelliteId: origin.satelliteId,
      placeId: origin.placeId,
    };
  }

  const confidence = readFiniteNumber(event.payload, ['confidence', 'score', 'probability']);
  const occupancyCount = readFiniteNumber(event.payload, ['occupancyCount', 'occupancy_count', 'count']);
  return {
    ok: true,
    event: {
      kind: 'presence',
      action,
      eventId: event.id,
      rawEventType: event.eventType,
      source: event.source,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      scope,
      satelliteId: origin.satelliteId,
      siteId: origin.siteId,
      placeId: origin.placeId,
      placeDisplayName: origin.place.displayName,
      ...(origin.channelId ? { channelId: origin.channelId } : {}),
      ...(origin.affordanceId ? { affordanceId: origin.affordanceId } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(occupancyCount !== undefined ? { occupancyCount } : {}),
    },
  };
}

function normalizeIdentityClaimShape(
  payload: Record<string, unknown>,
): { hubIdentityId: string; confidence: number } | undefined {
  const claim = readRecord(payload, ['identityClaim', 'identity_claim', 'claim']) ?? payload;
  const hubIdentityId = readString(claim, ['hubIdentityId', 'hub_identity_id']);
  const confidence = readFiniteNumber(claim, ['confidence', 'score', 'probability']);
  if (!hubIdentityId || confidence === undefined) return undefined;
  return { hubIdentityId, confidence };
}

function normalizeIdentityClaimEvent(
  event: ExternalTelemetryEvent,
  scope: PerceptionScope,
  origin: ResolvedTelemetryOrigin,
): PerceptionNormalizationResult {
  if (scope !== 'face') {
    return {
      ok: false,
      kind: 'unrecognized',
      reason: 'identity_claim_requires_face_scope',
      satelliteId: origin.satelliteId,
      placeId: origin.placeId,
    };
  }
  if (containsRawBiometricPayload(event.payload)) {
    return {
      ok: false,
      kind: 'malformed',
      reason: 'raw_biometric_payload_rejected',
      satelliteId: origin.satelliteId,
      placeId: origin.placeId,
    };
  }

  const claim = normalizeIdentityClaimShape(event.payload);
  if (!claim) {
    return {
      ok: false,
      kind: 'unrecognized',
      reason: 'unrecognized_identity_claim_event_shape',
      satelliteId: origin.satelliteId,
      placeId: origin.placeId,
    };
  }

  return {
    ok: true,
    event: {
      kind: 'identity_claim',
      action: 'observed',
      eventId: event.id,
      rawEventType: event.eventType,
      source: event.source,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      scope,
      satelliteId: origin.satelliteId,
      siteId: origin.siteId,
      placeId: origin.placeId,
      placeDisplayName: origin.place.displayName,
      ...(origin.channelId ? { channelId: origin.channelId } : {}),
      ...(origin.affordanceId ? { affordanceId: origin.affordanceId } : {}),
      hubIdentityId: claim.hubIdentityId,
      confidence: claim.confidence,
      claimSource: 'face',
    },
  };
}

function looksLikeIdentityClaim(event: ExternalTelemetryEvent): boolean {
  const payload = event.payload;
  if (readRecord(payload, ['identityClaim', 'identity_claim', 'claim'])) return true;
  if (readString(payload, ['hubIdentityId', 'hub_identity_id'])) return true;
  const token = readString(payload, ['type', 'kind', 'event', 'eventType', 'action']);
  if (!token) return false;
  const normalized = token.trim().toLowerCase().replaceAll('_', '-');
  return normalized === 'identity-claim'
    || normalized === 'identity-claim.observed'
    || normalized === 'face.identity-claim'
    || normalized === 'face.identity-claim.observed';
}

export function normalizeExternalTelemetryToPerceptionEvent(input: {
  event: ExternalTelemetryEvent;
  satelliteRegistry?: SatelliteRegistryConfig;
  placesRegistry?: PlacesRegistryConfig;
}): PerceptionNormalizationResult {
  const { event } = input;
  const scope = normalizeScope(event.scope);
  if (!scope) {
    return { ok: false, kind: 'ignored', reason: 'scope_not_relevant_to_perception' };
  }
  if (!isRecord(event.payload)) {
    return { ok: false, kind: 'malformed', reason: 'payload_must_be_object' };
  }

  const indexes = buildRegistryIndexes(input);
  const origin = resolveTelemetryOrigin(event, indexes);
  if ('ok' in origin) return origin;

  if (scope === 'presence') {
    return normalizePresenceEvent(event, scope, origin);
  }
  if (looksLikeIdentityClaim(event)) {
    return normalizeIdentityClaimEvent(event, scope, origin);
  }
  return {
    ok: false,
    kind: 'unrecognized',
    reason: 'unrecognized_face_event_shape',
    satelliteId: origin.satelliteId,
    placeId: origin.placeId,
  };
}

function telemetryCounterForFailure(kind: PerceptionNormalizationFailureKind): PerceptionBridgeTelemetryCounter {
  if (kind === 'malformed') return 'malformed';
  if (kind === 'unrecognized') return 'unrecognized';
  return 'unrecognized';
}

class DefaultSensorCognitionBridge implements SensorCognitionBridge {
  readonly active = true;
  private readonly eventBus: EventBus;
  private readonly satelliteRegistry?: SatelliteRegistryConfig;
  private readonly placesRegistry?: PlacesRegistryConfig;
  private readonly sink: PerceptionEventSink;
  private readonly logger: Pick<typeof log, 'warn'>;
  private readonly now: () => number;
  private readonly seenEventKeys: string[] = [];
  private readonly seenEventKeySet = new Set<string>();
  private readonly unsubscribeHandler: () => void;

  constructor(options: Required<Pick<SensorCognitionBridgeOptions, 'eventBus' | 'sink' | 'logger' | 'now'>>
    & Pick<SensorCognitionBridgeOptions, 'satelliteRegistry' | 'placesRegistry'>) {
    this.eventBus = options.eventBus;
    this.satelliteRegistry = options.satelliteRegistry;
    this.placesRegistry = options.placesRegistry;
    this.sink = options.sink;
    this.logger = options.logger;
    this.now = options.now;
    this.unsubscribeHandler = this.eventBus.on('external.telemetry.ingested', async ({ event }) => {
      await this.handleTelemetryEvent(event);
    });
  }

  unsubscribe(): void {
    this.unsubscribeHandler();
  }

  async handleTelemetryEvent(event: ExternalTelemetryEvent): Promise<void> {
    try {
      await this.handleTelemetryEventUnsafe(event);
    } catch (error) {
      this.logger.warn('Sensor cognition bridge subscriber failed', {
        error: toErrorMessage(error),
        eventId: event.id,
        rawEventType: event.eventType,
        source: event.source,
        scope: event.scope,
      });
      await this.emitTelemetry({
        counter: 'sink_error',
        reason: 'subscriber_exception',
        event,
      });
    }
  }

  private async handleTelemetryEventUnsafe(event: ExternalTelemetryEvent): Promise<void> {
    const result = normalizeExternalTelemetryToPerceptionEvent({
      event,
      satelliteRegistry: this.satelliteRegistry,
      placesRegistry: this.placesRegistry,
    });
    if (!result.ok) {
      if (result.kind === 'ignored') return;
      this.logger.warn('Sensor cognition bridge dropped telemetry event', {
        reason: result.reason,
        eventId: event.id,
        rawEventType: event.eventType,
        source: event.source,
        scope: event.scope,
        satelliteId: result.satelliteId,
        placeId: result.placeId,
      });
      await this.emitTelemetry({
        counter: telemetryCounterForFailure(result.kind),
        reason: result.reason,
        event,
        satelliteId: result.satelliteId,
        placeId: result.placeId,
      });
      return;
    }

    const seenKey = `${result.event.kind}:${result.event.eventId}`;
    if (this.hasSeen(seenKey)) {
      await this.emitTelemetry({
        counter: 'duplicate',
        reason: 'duplicate_perception_event',
        event,
        perception: result.event,
      });
      return;
    }
    this.markSeen(seenKey);

    try {
      await this.sink.handlePerceptionEvent(result.event);
    } catch (error) {
      this.logger.warn('Sensor cognition bridge sink failed', {
        error: toErrorMessage(error),
        eventId: event.id,
        rawEventType: event.eventType,
        source: event.source,
        scope: event.scope,
        satelliteId: result.event.satelliteId,
        placeId: result.event.placeId,
        perceptionKind: result.event.kind,
      });
      await this.emitTelemetry({
        counter: 'sink_error',
        reason: 'sink_failed',
        event,
        perception: result.event,
      });
      return;
    }

    await this.emitTelemetry({
      counter: 'delivered',
      reason: 'perception_event_delivered',
      event,
      perception: result.event,
    });
  }

  private hasSeen(key: string): boolean {
    return this.seenEventKeySet.has(key);
  }

  private markSeen(key: string): void {
    this.seenEventKeySet.add(key);
    this.seenEventKeys.push(key);
    if (this.seenEventKeys.length <= MAX_SEEN_EVENT_KEYS) return;
    const removed = this.seenEventKeys.shift();
    if (removed) this.seenEventKeySet.delete(removed);
  }

  private async emitTelemetry(input: {
    counter: PerceptionBridgeTelemetryCounter;
    reason: string;
    event: ExternalTelemetryEvent;
    perception?: PerceptionEvent;
    satelliteId?: string;
    placeId?: string;
  }): Promise<void> {
    try {
      const satelliteId = input.perception?.satelliteId ?? input.satelliteId;
      const placeId = input.perception?.placeId ?? input.placeId;
      await this.eventBus.emit('agent.perception.bridge.telemetry', {
        counter: input.counter,
        reason: input.reason,
        eventId: input.event.id,
        rawEventType: input.event.eventType,
        source: input.event.source,
        ...(input.event.scope ? { scope: input.event.scope } : {}),
        ...(input.event.channelId ? { channelId: input.event.channelId } : {}),
        ...(satelliteId ? { satelliteId } : {}),
        ...(placeId ? { placeId } : {}),
        ...(input.perception ? { perceptionKind: input.perception.kind } : {}),
        timestamp: this.now(),
      });
    } catch (error) {
      this.logger.warn('Sensor cognition bridge telemetry emit failed', {
        error: toErrorMessage(error),
        eventId: input.event.id,
        counter: input.counter,
      });
    }
  }
}

class InactiveSensorCognitionBridge implements SensorCognitionBridge {
  readonly active = false;

  unsubscribe(): void {
    // No-op: absent/off registry config is byte-identical to no bridge.
  }

  async handleTelemetryEvent(): Promise<void> {
    // No-op: absent/off registry config is byte-identical to no bridge.
  }
}

export function createSensorCognitionBridge(options: SensorCognitionBridgeOptions): SensorCognitionBridge {
  if (!hasActiveBridgeConfig(options)) {
    return new InactiveSensorCognitionBridge();
  }
  return new DefaultSensorCognitionBridge({
    eventBus: options.eventBus,
    satelliteRegistry: options.satelliteRegistry,
    placesRegistry: options.placesRegistry,
    sink: options.sink ?? NOOP_PERCEPTION_EVENT_SINK,
    logger: options.logger ?? log,
    now: options.now ?? Date.now,
  });
}
