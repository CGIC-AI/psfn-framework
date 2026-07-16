import type { GardenEventEnvelope } from '$lib/events/envelope';
import { normalizeGardenEventEnvelope } from '$lib/events/envelope';
import { getGardenCacheStorage, type GardenCacheStorage } from './indexeddb';
import { isFiniteNumber, isRecord } from './validation';

const TELEMETRY_CACHE_KEY = 'telemetry:events';
const TELEMETRY_CACHE_SCHEMA_VERSION = 1;
export const MAX_CACHED_GARDEN_EVENTS = 750;

function normalizeEventArray(value: unknown): GardenEventEnvelope[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: GardenEventEnvelope[] = [];
  for (const candidate of value) {
    const event = normalizeGardenEventEnvelope(candidate);
    if (!event) return null;
    normalized.push(event);
  }
  return normalized.slice(-MAX_CACHED_GARDEN_EVENTS);
}

export class GardenTelemetryCache {
  constructor(private readonly storage: GardenCacheStorage = getGardenCacheStorage()) {}

  async read(): Promise<GardenEventEnvelope[]> {
    const raw = await this.storage.read(TELEMETRY_CACHE_KEY);
    if (raw === undefined) return [];
    if (!isRecord(raw)
      || raw.schemaVersion !== TELEMETRY_CACHE_SCHEMA_VERSION
      || !isFiniteNumber(raw.savedAt)) {
      await this.storage.remove(TELEMETRY_CACHE_KEY);
      return [];
    }
    const events = normalizeEventArray(raw.events);
    if (!events) {
      await this.storage.remove(TELEMETRY_CACHE_KEY);
      return [];
    }
    return events;
  }

  async write(events: readonly GardenEventEnvelope[]): Promise<void> {
    const normalized = normalizeEventArray(events);
    if (!normalized || normalized.length !== Math.min(events.length, MAX_CACHED_GARDEN_EVENTS)) {
      throw new Error('Refusing to persist malformed Garden telemetry events');
    }
    await this.storage.write(TELEMETRY_CACHE_KEY, {
      schemaVersion: TELEMETRY_CACHE_SCHEMA_VERSION,
      savedAt: Date.now(),
      events: normalized,
    });
  }

  async clear(): Promise<void> {
    await this.storage.remove(TELEMETRY_CACHE_KEY);
  }
}
