import { describe, expect, it, vi } from 'vitest';
import { createEventBusSensorIngestPort } from './sensor-ingest-port.js';

describe('createEventBusSensorIngestPort', () => {
  it('emits normalized telemetry ingress events and returns a receipt', async () => {
    const emit = vi.fn(async () => undefined);
    const port = createEventBusSensorIngestPort({ emit });
    const event = {
      id: 'ext-1',
      source: 'sensor-a',
      eventType: 'external.telemetry.heartbeat',
      payload: { status: 'ok' },
      occurredAt: '2026-03-28T00:00:00.000Z',
      receivedAt: '2026-03-28T00:00:01.000Z',
      nonce: 'nonce-1',
      channelId: 'ops-room',
      scope: 'cluster-a',
    };

    await expect(port.ingestTelemetry(event)).resolves.toEqual({
      id: 'ext-1',
      acceptedEventType: 'external.telemetry.heartbeat',
      event,
    });
    expect(emit).toHaveBeenCalledWith('external.telemetry.ingested', { event });
  });
});
