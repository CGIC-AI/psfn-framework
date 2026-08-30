import fs from "node:fs";

export interface HubLocationZone {
  placeId: string;
  label: string;
  lat: number;
  lon: number;
  radiusM: number;
}

export interface HubLocationConfig {
  schemaVersion: 1;
  debounceMs: number;
  maxAccuracyM: number;
  zones: HubLocationZone[];
}

export interface DeviceLocationSample {
  lat: number;
  lon: number;
  accuracyM: number;
  timestamp: number;
}

export interface LocationTransition {
  kind: "left" | "arrived";
  placeId: string;
  placeLabel: string;
  responseMode: "observe" | "respond";
}

export interface SituatedLocationContext {
  placeId: string | null;
  contextNotes: Array<{ key: string; text: string }>;
}

export type GeofenceObservation =
  | { status: "ignored"; reason: "low_accuracy" }
  | {
    status: "accepted";
    context: SituatedLocationContext;
    transitions: LocationTransition[];
  };

interface DeviceGeofenceState {
  zonePlaceId: string | null;
  nearestPlaceId: string;
  pending?: {
    zonePlaceId: string | null;
    nearestPlaceId: string;
    sinceMs: number;
  };
}

const PLACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const LABEL_PATTERN = /^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}]{1,80}$/u;
const EARTH_RADIUS_M = 6_371_000;

export function loadHubLocationConfig(filePath: string | undefined): HubLocationConfig | null {
  if (!filePath) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return parseHubLocationConfig(raw);
}

export function parseHubLocationConfig(value: unknown): HubLocationConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Hub location config must use schemaVersion 1");
  }
  const allowedFields = new Set(["schemaVersion", "debounceMs", "maxAccuracyM", "zones"]);
  rejectUnknownFields(value, allowedFields, "Hub location config");
  if (!Number.isSafeInteger(value.debounceMs) || Number(value.debounceMs) < 0) {
    throw new Error("Hub location config debounceMs must be a non-negative integer");
  }
  if (!isPositiveFinite(value.maxAccuracyM)) {
    throw new Error("Hub location config maxAccuracyM must be a positive finite number");
  }
  if (!Array.isArray(value.zones) || value.zones.length === 0) {
    throw new Error("Hub location config must contain at least one zone");
  }
  const zones = value.zones.map((zone, index) => parseZone(zone, index));
  assertUnique(zones, "placeId", zone => zone.placeId);
  return {
    schemaVersion: 1,
    debounceMs: Number(value.debounceMs),
    maxAccuracyM: value.maxAccuracyM,
    zones,
  };
}

/**
 * Hub-local geofence state. Raw samples are used only during this synchronous
 * classification call and are never retained in state or returned to callers.
 */
export class HubLocationGeofence {
  private readonly states = new Map<string, DeviceGeofenceState>();

  constructor(
    private readonly config: HubLocationConfig,
    private readonly now: () => number = Date.now,
  ) {}

  observe(deviceId: string, sample: DeviceLocationSample): GeofenceObservation {
    validateDeviceId(deviceId);
    validateLocationSample(sample);
    if (sample.accuracyM > this.config.maxAccuracyM) {
      return { status: "ignored", reason: "low_accuracy" };
    }

    const classified = classify(sample, this.config.zones);
    const existing = this.states.get(deviceId);
    if (!existing) {
      const initial: DeviceGeofenceState = {
        zonePlaceId: classified.zone?.placeId ?? null,
        nearestPlaceId: classified.nearest.placeId,
      };
      this.states.set(deviceId, initial);
      return {
        status: "accepted",
        context: contextForState(initial, this.config.zones),
        transitions: [],
      };
    }

    const candidatePlaceId = classified.zone?.placeId ?? null;
    if (candidatePlaceId === existing.zonePlaceId) {
      existing.nearestPlaceId = classified.nearest.placeId;
      delete existing.pending;
      return {
        status: "accepted",
        context: contextForState(existing, this.config.zones),
        transitions: [],
      };
    }

    const observedAtMs = this.now();
    if (!existing.pending || existing.pending.zonePlaceId !== candidatePlaceId) {
      existing.pending = {
        zonePlaceId: candidatePlaceId,
        nearestPlaceId: classified.nearest.placeId,
        sinceMs: observedAtMs,
      };
      if (this.config.debounceMs > 0) {
        return {
          status: "accepted",
          context: contextForState(existing, this.config.zones),
          transitions: [],
        };
      }
    } else {
      existing.pending.nearestPlaceId = classified.nearest.placeId;
    }

    const pending = existing.pending;
    if (!pending || observedAtMs - pending.sinceMs < this.config.debounceMs) {
      return {
        status: "accepted",
        context: contextForState(existing, this.config.zones),
        transitions: [],
      };
    }

    const previous = findZone(this.config.zones, existing.zonePlaceId);
    const next = findZone(this.config.zones, pending.zonePlaceId);
    existing.zonePlaceId = pending.zonePlaceId;
    existing.nearestPlaceId = pending.nearestPlaceId;
    delete existing.pending;
    return {
      status: "accepted",
      context: contextForState(existing, this.config.zones),
      transitions: [
        ...(previous ? [{
          kind: "left" as const,
          placeId: previous.placeId,
          placeLabel: previous.label,
          responseMode: "observe" as const,
        }] : []),
        ...(next ? [{
          kind: "arrived" as const,
          placeId: next.placeId,
          placeLabel: next.label,
          responseMode: "respond" as const,
        }] : []),
      ],
    };
  }
}

export function validateLocationSample(value: unknown): asserts value is DeviceLocationSample {
  if (!isRecord(value)) throw new Error("Device location payload must be an object");
  rejectUnknownFields(value, new Set(["type", "lat", "lon", "accuracyM", "timestamp"]), "Device location payload");
  if (value.type !== undefined && value.type !== "device.location") {
    throw new Error("Device location payload type is invalid");
  }
  if (!isFiniteInRange(value.lat, -90, 90)) {
    throw new Error("Device location latitude is invalid");
  }
  if (!isFiniteInRange(value.lon, -180, 180)) {
    throw new Error("Device location longitude is invalid");
  }
  if (!isFiniteInRange(value.accuracyM, 0, 1_000_000)) {
    throw new Error("Device location accuracy is invalid");
  }
  if (!Number.isSafeInteger(value.timestamp) || Number(value.timestamp) < 1) {
    throw new Error("Device location timestamp is invalid");
  }
}

function parseZone(value: unknown, index: number): HubLocationZone {
  if (!isRecord(value)) throw new Error(`Hub location zones[${index}] must be an object`);
  rejectUnknownFields(value, new Set(["placeId", "label", "lat", "lon", "radiusM"]), `Hub location zones[${index}]`);
  const placeId = requireString(value.placeId, `Hub location zones[${index}].placeId`);
  if (!PLACE_ID_PATTERN.test(placeId)) {
    throw new Error(`Hub location zones[${index}].placeId has an invalid format`);
  }
  const label = requireString(value.label, `Hub location zones[${index}].label`);
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`Hub location zones[${index}].label must be a single bounded printable line`);
  }
  if (!isFiniteInRange(value.lat, -90, 90)) {
    throw new Error(`Hub location zones[${index}].lat is invalid`);
  }
  if (!isFiniteInRange(value.lon, -180, 180)) {
    throw new Error(`Hub location zones[${index}].lon is invalid`);
  }
  if (!isPositiveFinite(value.radiusM)) {
    throw new Error(`Hub location zones[${index}].radiusM must be a positive finite number`);
  }
  return { placeId, label, lat: value.lat, lon: value.lon, radiusM: value.radiusM };
}

function classify(
  sample: DeviceLocationSample,
  zones: readonly HubLocationZone[],
): { zone: HubLocationZone | null; nearest: HubLocationZone } {
  const byDistance = zones
    .map(zone => ({ zone, distanceM: haversineDistanceM(sample.lat, sample.lon, zone.lat, zone.lon) }))
    .sort((left, right) => left.distanceM - right.distanceM);
  const nearest = byDistance[0];
  if (!nearest) throw new Error("Hub location config did not contain a zone");
  return {
    nearest: nearest.zone,
    zone: nearest.distanceM <= nearest.zone.radiusM ? nearest.zone : null,
  };
}

function contextForState(
  state: DeviceGeofenceState,
  zones: readonly HubLocationZone[],
): SituatedLocationContext {
  if (state.zonePlaceId) {
    return { placeId: state.zonePlaceId, contextNotes: [] };
  }
  const nearest = findZone(zones, state.nearestPlaceId);
  if (!nearest) throw new Error("Hub geofence state references an unknown nearest zone");
  return {
    placeId: null,
    contextNotes: [{ key: "location", text: `Out, near ${nearest.label}.` }],
  };
}

function findZone(zones: readonly HubLocationZone[], placeId: string | null): HubLocationZone | null {
  if (!placeId) return null;
  return zones.find(zone => zone.placeId === placeId) ?? null;
}

function haversineDistanceM(latA: number, lonA: number, latB: number, lonB: number): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (latB - latA) * radians;
  const longitudeDelta = (lonB - lonA) * radians;
  const firstLatitude = latA * radians;
  const secondLatitude = latB * radians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

function validateDeviceId(value: string): void {
  if (!PLACE_ID_PATTERN.test(value)) throw new Error("Device location device id is invalid");
}

function assertUnique<T>(items: readonly T[], field: string, select: (item: T) => string): void {
  const values = items.map(select);
  if (new Set(values).size !== values.length) {
    throw new Error(`Hub location config zones must use unique ${field} values`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${field} has unknown fields: ${unknown.join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
