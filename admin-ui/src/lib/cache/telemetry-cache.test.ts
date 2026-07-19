import { describe, expect, it } from 'vitest';
import { normalizeGardenWebSocketMessage } from '$lib/events/envelope';
import type { GardenCacheStorage } from './indexeddb';
import { GardenTelemetryCache } from './telemetry-cache';

class MemoryGardenCacheStorage implements GardenCacheStorage {
  private readonly values = new Map<string, unknown>();

  async read(key: string): Promise<unknown> {
    return this.values.get(key);
  }

  async write(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe('GardenTelemetryCache', () => {
  it('persists a normalized websocket update for the next page reload', async () => {
    const storage = new MemoryGardenCacheStorage();
    const event = normalizeGardenWebSocketMessage(JSON.stringify({
      type: 'garden.queue.changed',
      timestamp: 1_700_000_000_000,
      correlation: { channelId: 'api:test' },
      data: { queue: 'confirmations' },
    }));
    expect(event).not.toBeNull();
    if (!event) throw new Error('Synthetic websocket event was rejected');

    await new GardenTelemetryCache(storage).write([event]);
    const reloaded = await new GardenTelemetryCache(storage).read();

    expect(reloaded).toEqual([event]);
  });

  it('fails closed and removes a malformed persisted telemetry snapshot', async () => {
    const storage = new MemoryGardenCacheStorage();
    await storage.write('companion:single-companion:telemetry:events', {
      schemaVersion: 1,
      savedAt: 1_700_000_000_000,
      events: [{ type: '', timestamp: 'bad' }],
    });

    await expect(new GardenTelemetryCache(storage).read()).resolves.toEqual([]);
    await expect(storage.read('companion:single-companion:telemetry:events'))
      .resolves.toBeUndefined();
  });

  it('keeps a queued pre-switch write bound to its captured companion key', async () => {
    const storage = new MemoryGardenCacheStorage();
    const event = normalizeGardenWebSocketMessage(JSON.stringify({
      type: 'garden.queue.changed',
      timestamp: 1_700_000_000_000,
      data: { queue: 'confirmations' },
    }));
    if (!event) throw new Error('Synthetic websocket event was rejected');
    const previousCompanionId = '11111111-1111-4111-8111-111111111111';

    await expect(new GardenTelemetryCache(storage).write(
      [event],
      previousCompanionId,
    )).rejects.toThrow(/Companion scope changed/u);
    await expect(storage.read(
      `companion:${previousCompanionId}:telemetry:events`,
    )).resolves.toBeDefined();
    await expect(storage.read(
      'companion:22222222-2222-4222-8222-222222222222:telemetry:events',
    )).resolves.toBeUndefined();
  });
});
