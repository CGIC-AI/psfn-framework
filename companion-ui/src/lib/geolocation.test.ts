import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MIN_DISTANCE_M,
  SignificantChangeFilter,
  haversineMeters,
  isValidDeviceLocationSample,
  startDeviceLocationWatch,
  type DeviceLocationSample,
  type GeolocationLike,
} from './geolocation.js';

function sample(overrides: Partial<DeviceLocationSample> = {}): DeviceLocationSample {
  return { lat: 37.42, lon: -122.08, accuracyM: 10, timestamp: 1_700_000_000_000, ...overrides };
}

describe('haversineMeters', () => {
  it('is zero for identical coordinates', () => {
    expect(haversineMeters(37.42, -122.08, 37.42, -122.08)).toBe(0);
  });

  it('approximates a known short distance', () => {
    // ~111.2m per 0.001 degree of latitude near the equator.
    const meters = haversineMeters(0, 0, 0.001, 0);
    expect(meters).toBeGreaterThan(110);
    expect(meters).toBeLessThan(112);
  });
});

describe('isValidDeviceLocationSample', () => {
  it('accepts a well-formed sample', () => {
    expect(isValidDeviceLocationSample(sample())).toBe(true);
  });

  it.each([
    ['latitude above range', sample({ lat: 91 })],
    ['latitude NaN', sample({ lat: Number.NaN })],
    ['longitude below range', sample({ lon: -181 })],
    ['negative accuracy', sample({ accuracyM: -1 })],
    ['infinite accuracy', sample({ accuracyM: Number.POSITIVE_INFINITY })],
    ['non-integer timestamp', sample({ timestamp: 1.5 })],
    ['zero timestamp', sample({ timestamp: 0 })],
  ])('rejects %s', (_label, value) => {
    expect(isValidDeviceLocationSample(value)).toBe(false);
  });
});

describe('SignificantChangeFilter', () => {
  it('always accepts the first valid sample', () => {
    const filter = new SignificantChangeFilter();
    expect(filter.accept(sample())).toBe(true);
  });

  it('rejects invalid samples without recording them', () => {
    const filter = new SignificantChangeFilter();
    expect(filter.accept(sample({ lat: 999 }))).toBe(false);
    // The invalid sample was not recorded, so the next valid one is still "first".
    expect(filter.accept(sample())).toBe(true);
  });

  it('rejects a sample that has not moved far enough', () => {
    const filter = new SignificantChangeFilter({ minDistanceM: 100, minIntervalMs: 1_000 });
    expect(filter.accept(sample({ timestamp: 1_000 }))).toBe(true);
    // ~11m north, well under 100m, after enough time.
    expect(filter.accept(sample({ lat: 37.4201, timestamp: 60_000 }))).toBe(false);
  });

  it('rejects a large move that arrives before the minimum interval', () => {
    const filter = new SignificantChangeFilter({ minDistanceM: 100, minIntervalMs: 30_000 });
    expect(filter.accept(sample({ timestamp: 1_000 }))).toBe(true);
    // ~1.1km away but only 5s later — rate-floored out.
    expect(filter.accept(sample({ lat: 37.43, timestamp: 6_000 }))).toBe(false);
  });

  it('accepts a significant move after the minimum interval', () => {
    const filter = new SignificantChangeFilter({ minDistanceM: 100, minIntervalMs: 30_000 });
    expect(filter.accept(sample({ lat: 37.42, timestamp: 1_000 }))).toBe(true);
    expect(filter.accept(sample({ lat: 37.43, timestamp: 40_000 }))).toBe(true);
  });

  it('measures distance from the last accepted sample, not the last observed', () => {
    const filter = new SignificantChangeFilter({ minDistanceM: 100, minIntervalMs: 1_000 });
    expect(filter.accept(sample({ lat: 37.42, timestamp: 1_000 }))).toBe(true);
    // Small hop rejected; anchor stays at 37.42.
    expect(filter.accept(sample({ lat: 37.4205, timestamp: 3_000 }))).toBe(false);
    // Cumulative drift from the anchor now clears the threshold.
    expect(filter.accept(sample({ lat: 37.4215, timestamp: 5_000 }))).toBe(true);
  });

  it('defaults to a ~100m distance threshold', () => {
    const filter = new SignificantChangeFilter({ minIntervalMs: 0 });
    filter.accept(sample({ lat: 0, lon: 0, timestamp: 1 }));
    const justUnder = haversineMeters(0, 0, 0.0008, 0);
    expect(justUnder).toBeLessThan(DEFAULT_MIN_DISTANCE_M);
    expect(filter.accept(sample({ lat: 0.0008, lon: 0, timestamp: 2 }))).toBe(false);
  });
});

class FakeGeolocation implements GeolocationLike {
  public successHandlers: Array<(position: GeolocationPosition) => void> = [];
  public clearedIds: number[] = [];
  private nextId = 1;

  watchPosition(success: (position: GeolocationPosition) => void): number {
    this.successHandlers.push(success);
    return this.nextId++;
  }

  clearWatch(id: number): void {
    this.clearedIds.push(id);
  }

  emit(coords: { latitude: number; longitude: number; accuracy: number }, timestamp: number): void {
    for (const handler of this.successHandlers) {
      handler({ coords, timestamp } as unknown as GeolocationPosition);
    }
  }
}

describe('startDeviceLocationWatch', () => {
  it('sends only significant-change samples and clears the watch on stop', () => {
    const geolocation = new FakeGeolocation();
    const send = vi.fn();
    const watch = startDeviceLocationWatch({
      geolocation,
      send,
      minDistanceM: 100,
      minIntervalMs: 30_000,
    });

    geolocation.emit({ latitude: 37.42, longitude: -122.08, accuracy: 10 }, 1_000);
    geolocation.emit({ latitude: 37.4201, longitude: -122.08, accuracy: 10 }, 40_000); // ~11m, rejected
    geolocation.emit({ latitude: 37.43, longitude: -122.08, accuracy: 10 }, 80_000); // ~1.1km, accepted

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({
      lat: 37.43,
      lon: -122.08,
      accuracyM: 10,
      timestamp: 80_000,
    });

    watch.stop();
    expect(geolocation.clearedIds).toEqual([1]);

    // A double stop is a no-op (no second clearWatch).
    watch.stop();
    expect(geolocation.clearedIds).toEqual([1]);
  });

  it('drops invalid fixes rather than sending them', () => {
    const geolocation = new FakeGeolocation();
    const send = vi.fn();
    startDeviceLocationWatch({ geolocation, send });

    geolocation.emit({ latitude: 999, longitude: 0, accuracy: 10 }, 1_000);

    expect(send).not.toHaveBeenCalled();
  });
});
