import { describe, expect, it } from 'vitest';
import type { ExternalTelemetryEvent } from '../../shared/event-bus.js';
import { sanitizeExternalTelemetryIngested } from './server-telemetry-transport.js';

function telemetryEvent(payload: Record<string, unknown>): ExternalTelemetryEvent {
  return {
    id: 'ext-1',
    source: 'sensor-a',
    eventType: 'external.telemetry.status',
    payload,
    occurredAt: '2026-07-09T12:00:00.000Z',
    receivedAt: '2026-07-09T12:00:01.000Z',
    nonce: 'nonce-12345678',
    scope: 'presence',
    channelId: 'ops-room',
    auth: {
      principalId: 'api-key-a',
      principalMode: 'api_key',
      satelliteScoped: true,
    },
  };
}

describe('sanitizeExternalTelemetryIngested (Sprint-10 H5 defense-in-depth)', () => {
  it('projects a legit payload to the allowlisted, scalar field set', () => {
    const sanitized = sanitizeExternalTelemetryIngested(
      telemetryEvent({ satelliteId: 'sat-a', present: true, confidence: 0.9 }),
    );

    expect(sanitized).toMatchObject({
      id: 'ext-1',
      source: 'sensor-a',
      eventType: 'external.telemetry.status',
      occurredAt: '2026-07-09T12:00:00.000Z',
      receivedAt: '2026-07-09T12:00:01.000Z',
      scope: 'presence',
      channelId: 'ops-room',
      auth: { principalId: 'api-key-a', principalMode: 'api_key', satelliteScoped: true },
      payload: { satelliteId: 'sat-a', present: true, confidence: 0.9 },
    });
    expect(sanitized.payloadTruncated).toBeUndefined();
  });

  it('never forwards a raw biometric blob verbatim', () => {
    const sanitized = sanitizeExternalTelemetryIngested(
      telemetryEvent({
        present: true,
        faceVector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
        image: 'data:image/png;base64,AAAA',
        claim: { hubIdentityId: 'hub-1', confidence: 0.8 },
      }),
    );

    const payload = sanitized.payload as Record<string, unknown>;
    // Scalar-only projection: nested object (claim), array (faceVector), and
    // biometric/media keys are all stripped.
    expect(payload).toEqual({ present: true });
    expect(payload.faceVector).toBeUndefined();
    expect(payload.image).toBeUndefined();
    expect(payload.claim).toBeUndefined();
    expect(sanitized.payloadTruncated).toBe(true);
  });

  it('truncates oversized string fields rather than forwarding them', () => {
    const huge = 'x'.repeat(4096);
    const sanitized = sanitizeExternalTelemetryIngested(telemetryEvent({ detail: huge }));
    const payload = sanitized.payload as Record<string, unknown>;
    expect(typeof payload.detail).toBe('string');
    expect((payload.detail as string).length).toBeLessThan(huge.length);
    expect((payload.detail as string).length).toBeLessThanOrEqual(257);
  });
});
