/**
 * Client-side GPS sampling for the Companion PWA (bead psfn-framework-7ang.8).
 *
 * The phone samples `navigator.geolocation` while the app is foregrounded and
 * reduces the raw stream to occasional `device.location` samples via a
 * significant-change filter (moved >= ~100m AND at least a minimum interval
 * since the last accepted sample). Raw coordinates are a client->hub payload
 * that TERMINATES AT THE HUB: the hub geofences them into place labels and
 * never forwards lat/lon toward PSFN.
 *
 * PRIVACY: nothing in this module logs raw coordinates. The only egress is the
 * injected `send` callback, which the transport layer must route exclusively to
 * a hub that terminates coordinates (never the PSFN gateway).
 */

/** A single reduced GPS sample. Carries raw coordinates only up to the hub. */
export interface DeviceLocationSample {
  /** Latitude in decimal degrees, [-90, 90]. */
  lat: number;
  /** Longitude in decimal degrees, [-180, 180]. */
  lon: number;
  /** Reported horizontal accuracy in metres, finite and >= 0. */
  accuracyM: number;
  /** Fix time as a Unix epoch millisecond integer. */
  timestamp: number;
}

/** ~100m: below this the position has not "significantly changed". */
export const DEFAULT_MIN_DISTANCE_M = 100;
/** 30s: never emit more often than this even while moving quickly. */
export const DEFAULT_MIN_INTERVAL_MS = 30_000;

const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two coordinates in metres (haversine). Both
 * inputs must already be valid coordinates.
 */
export function haversineMeters(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * True only for a fully-valid device location sample. Rejects NaN/Infinity,
 * out-of-range coordinates, negative accuracy, and non-integer timestamps —
 * the watcher drops anything that fails this rather than emitting a bad fix.
 */
export function isValidDeviceLocationSample(sample: DeviceLocationSample): boolean {
  return (
    Number.isFinite(sample.lat) &&
    sample.lat >= -90 &&
    sample.lat <= 90 &&
    Number.isFinite(sample.lon) &&
    sample.lon >= -180 &&
    sample.lon <= 180 &&
    Number.isFinite(sample.accuracyM) &&
    sample.accuracyM >= 0 &&
    Number.isSafeInteger(sample.timestamp) &&
    sample.timestamp > 0
  );
}

export interface SignificantChangeOptions {
  minDistanceM?: number;
  minIntervalMs?: number;
}

/**
 * Stateful significant-change gate. The first valid sample is always accepted;
 * a later sample is accepted only when it has moved at least `minDistanceM`
 * from the last accepted position AND at least `minIntervalMs` has elapsed.
 * Sitting still (no significant movement) never emits; moving fast is
 * rate-floored to `minIntervalMs`.
 */
export class SignificantChangeFilter {
  private readonly minDistanceM: number;
  private readonly minIntervalMs: number;
  private last: DeviceLocationSample | null = null;

  constructor(options: SignificantChangeOptions = {}) {
    this.minDistanceM = options.minDistanceM ?? DEFAULT_MIN_DISTANCE_M;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  /** Returns true and records the sample when it clears the change threshold. */
  accept(sample: DeviceLocationSample): boolean {
    if (!isValidDeviceLocationSample(sample)) {
      return false;
    }
    const previous = this.last;
    if (previous === null) {
      this.last = sample;
      return true;
    }
    const elapsed = sample.timestamp - previous.timestamp;
    if (elapsed < this.minIntervalMs) {
      return false;
    }
    const distance = haversineMeters(previous.lat, previous.lon, sample.lat, sample.lon);
    if (distance < this.minDistanceM) {
      return false;
    }
    this.last = sample;
    return true;
  }

  reset(): void {
    this.last = null;
  }
}

/**
 * The subset of the browser Geolocation API this watcher needs. Injected so the
 * controller is testable without a real navigator.
 */
export interface GeolocationLike {
  watchPosition(
    success: (position: GeolocationPosition) => void,
    error?: (error: GeolocationPositionError) => void,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
}

export interface DeviceLocationWatchOptions {
  geolocation: GeolocationLike;
  /** Egress sink for accepted samples. MUST route only to a coord-terminating hub. */
  send: (sample: DeviceLocationSample) => void;
  onError?: (error: GeolocationPositionError) => void;
  /** Called for every valid browser fix, including fixes filtered from egress. */
  onValidFix?: () => void;
  minDistanceM?: number;
  minIntervalMs?: number;
  enableHighAccuracy?: boolean;
  maximumAgeMs?: number;
}

export interface DeviceLocationWatch {
  stop(): void;
}

/**
 * Start a foreground GPS watch that feeds accepted samples to `send`. Callers
 * own the foreground-only lifecycle: start when visible + connected to a hub,
 * `stop()` on hide/disconnect/unmount. Invalid fixes are dropped silently; the
 * position error path forwards to `onError` without touching coordinates.
 */
export function startDeviceLocationWatch(options: DeviceLocationWatchOptions): DeviceLocationWatch {
  const filter = new SignificantChangeFilter({
    minDistanceM: options.minDistanceM,
    minIntervalMs: options.minIntervalMs,
  });
  let watchId: number | null = options.geolocation.watchPosition(
    (position) => {
      const sample: DeviceLocationSample = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracyM: position.coords.accuracy,
        timestamp: Math.trunc(position.timestamp),
      };
      if (isValidDeviceLocationSample(sample)) {
        options.onValidFix?.();
      }
      if (filter.accept(sample)) {
        options.send(sample);
      }
    },
    options.onError,
    {
      enableHighAccuracy: options.enableHighAccuracy ?? false,
      maximumAge: options.maximumAgeMs ?? 0,
    },
  );
  return {
    stop(): void {
      if (watchId !== null) {
        options.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
  };
}
