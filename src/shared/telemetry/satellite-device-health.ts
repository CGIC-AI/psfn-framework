import type { EventBus, ExternalTelemetryEvent } from '../event-bus.js';
import {
  satelliteAdmitsAuthenticatedTelemetryScope,
  type SatelliteDeviceDegradedReason,
  type SatelliteDeviceHealthState,
  type SatelliteRegistryConfig,
} from '../contracts/satellite-registry.js';
import { createComponentLogger } from '../logger.js';
import { resolveTelemetrySatelliteId } from './sensor-ingest-port.js';

const log = createComponentLogger('SatelliteDeviceHealth');

/** Telemetry event type carrying a hub device-health heartbeat. */
export const SATELLITE_HEARTBEAT_EVENT_TYPE = 'external.telemetry.heartbeat';

/**
 * Telemetry scope a device must have been granted before its heartbeats may
 * populate a health row. `health` is the registry's existing device-condition
 * scope; a device that was never granted it cannot assert its own liveness.
 */
const SATELLITE_HEALTH_TELEMETRY_SCOPE = 'health';

/** One satellite's last admitted heartbeat. Content-free by construction. */
export interface SatelliteDeviceHealthObservation {
  lastSeenAtMs: number;
  /** Device's own self-report, when it sent one. Absent means "did not say". */
  selfReported?: Extract<SatelliteDeviceDegradedReason, 'device_reported_unhealthy' | 'device_reported_offline'>;
}

/** Derived health of one satellite at a point in time. */
export interface SatelliteDeviceHealth {
  status: SatelliteDeviceHealthState;
  lastSeenAtMs?: number;
  ageMs?: number;
  reason?: SatelliteDeviceDegradedReason;
}

/** Read seam consumed by the Garden operator view and the world tool surface. */
export interface SatelliteDeviceHealthReader {
  /** Derived health of every registered satellite, keyed by satelliteId. */
  snapshot(nowMs: number): ReadonlyMap<string, SatelliteDeviceHealth>;
  /** Derived health of one satellite. Unknown ids read `not_observed`. */
  readStatus(satelliteId: string, nowMs: number): SatelliteDeviceHealth;
}

function readOptionalBoolean(
  payload: Record<string, unknown>,
  key: string,
): { ok: true; value: boolean | undefined } | { ok: false } {
  if (!(key in payload)) return { ok: true, value: undefined };
  const value = payload[key];
  // Fail closed: a device that sends a malformed health flag is not trusted to
  // have said anything, and its heartbeat is rejected outright.
  return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
}

/**
 * Bounded in-memory device-health heartbeat tracker (bead psfn-framework-s7wq3).
 *
 * Hub devices post `external.telemetry.heartbeat` through the authenticated
 * telemetry ingest; before this tracker those heartbeats were accepted and
 * discarded, so no surface could say whether a device was alive. The tracker
 * subscribes to the ingested-telemetry bus event and keeps exactly one
 * last-seen record per REGISTERED satellite — the registry bounds the map, so
 * an unknown or spoofed id can never grow it.
 *
 * Every rejection path is fail-closed and leaves the previous record untouched:
 * no authenticated origin, an id outside the registry, a device that was not
 * granted the `health` telemetry scope, or a malformed health flag all yield
 * `not_observed` (or the last good state) rather than `ok`.
 */
export class SatelliteDeviceHealthTracker implements SatelliteDeviceHealthReader {
  private readonly observations = new Map<string, SatelliteDeviceHealthObservation>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: {
    /** Re-read on every heartbeat so an operator registry edit takes effect. */
    readonly registry: () => SatelliteRegistryConfig | undefined;
    /** Heartbeat silence after which a satellite reads degraded. */
    readonly staleAfterMs: number;
  }) {}

  /** Subscribes to ingested telemetry. Idempotent. */
  subscribe(eventBus: Pick<EventBus, 'on'>): void {
    this.unsubscribe ??= eventBus.on(
      'external.telemetry.ingested',
      ({ event }) => { this.observe(event); },
    );
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Records one heartbeat if — and only if — it is an authenticated heartbeat
   * from a registered satellite that holds the `health` telemetry scope.
   */
  observe(event: ExternalTelemetryEvent): void {
    if (event.eventType !== SATELLITE_HEARTBEAT_EVENT_TYPE) return;
    const auth = event.auth;
    if (!auth) return;
    const satelliteId = resolveTelemetrySatelliteId(event);
    if (!satelliteId) return;
    const satellite = this.deps.registry()?.satellites
      .find(candidate => candidate.satelliteId === satelliteId);
    if (!satellite) return;
    if (!satelliteAdmitsAuthenticatedTelemetryScope(
      satellite,
      auth,
      SATELLITE_HEALTH_TELEMETRY_SCOPE,
    )) {
      return;
    }
    const healthy = readOptionalBoolean(event.payload, 'healthy');
    const online = readOptionalBoolean(event.payload, 'online');
    if (!healthy.ok || !online.ok) {
      log.warn('Rejected malformed satellite heartbeat health flags', { satelliteId });
      return;
    }
    const observedAtMs = Date.parse(event.receivedAt);
    if (!Number.isFinite(observedAtMs)) return;
    this.observations.set(satelliteId, {
      lastSeenAtMs: observedAtMs,
      ...(online.value === false
        ? { selfReported: 'device_reported_offline' as const }
        : healthy.value === false
          ? { selfReported: 'device_reported_unhealthy' as const }
          : {}),
    });
  }

  snapshot(nowMs: number): ReadonlyMap<string, SatelliteDeviceHealth> {
    const derived = new Map<string, SatelliteDeviceHealth>();
    for (const satellite of this.deps.registry()?.satellites ?? []) {
      derived.set(satellite.satelliteId, this.readStatus(satellite.satelliteId, nowMs));
    }
    return derived;
  }

  readStatus(satelliteId: string, nowMs: number): SatelliteDeviceHealth {
    const observation = this.observations.get(satelliteId);
    if (!observation) return { status: 'not_observed' };
    const ageMs = Math.max(0, nowMs - observation.lastSeenAtMs);
    const reason: SatelliteDeviceDegradedReason | undefined = observation.selfReported
      ?? (ageMs > this.deps.staleAfterMs ? 'heartbeat_stale' : undefined);
    return {
      status: reason ? 'degraded' : 'ok',
      lastSeenAtMs: observation.lastSeenAtMs,
      ageMs,
      ...(reason ? { reason } : {}),
    };
  }
}

/**
 * Bounded companion-facing device status for one physical place: `ok` when
 * every satellite bound to it is healthy, `degraded` when any is, and
 * `undefined` when none has been observed.
 *
 * Undefined is deliberate and load-bearing. The operator sees full device
 * health at all times; the companion sees at most two words, and only where a
 * place is already being weighed. A place with no admitted heartbeat renders
 * NOTHING rather than a guess — no absent-evidence `ok`, and no `degraded`
 * badge on every place in the world before hub-side emission exists. If she is
 * emanated into a degraded device she finds out by being there.
 */
export function resolvePlaceDeviceStatus(
  registry: SatelliteRegistryConfig | undefined,
  reader: SatelliteDeviceHealthReader,
  placeId: string,
  nowMs: number,
): 'ok' | 'degraded' | undefined {
  let observed: 'ok' | undefined;
  for (const satellite of registry?.satellites ?? []) {
    if (satellite.placeId !== placeId) continue;
    const status = reader.readStatus(satellite.satelliteId, nowMs).status;
    if (status === 'degraded') return 'degraded';
    if (status === 'ok') observed = 'ok';
  }
  return observed;
}
