import { describe, expect, it, vi } from 'vitest';
import { EventBus, type ExternalTelemetryEvent } from '../../../shared/event-bus.js';
import { createPartnerAffectShadowIngestBridge } from './shadow-ingest-bridge.js';
import type {
  PartnerAffectObservation,
  PartnerAffectShadowPolicy,
  PartnerAffectShadowTelemetryEvent,
  PartnerAffectSuppressedObservation,
} from '../../../shared/contracts/partner-affect.js';
import type {
  PartnerAffectShadowStorePort,
} from './shadow-store-port.js';

const NOW_MS = Date.parse('2026-07-08T12:00:05.000Z');
const PARTNER_ID = 'contact-partner-1';

function testPolicy(overrides: Partial<PartnerAffectShadowPolicy> = {}): PartnerAffectShadowPolicy {
  return {
    enabled: true,
    partnerContactId: PARTNER_ID,
    staleAfterMs: 24 * 60 * 60_000,
    evidenceWindowMs: 72 * 60 * 60_000,
    minConfidence: 0.35,
    minIndependentFamilies: 2,
    conflictValueTolerance: 0.25,
    allowedSignalFamilies: ['self_report', 'conversation', 'sleep', 'activity'],
    directions: {},
    sources: [{
      sourceId: 'edge-sleep-1',
      families: ['sleep'],
      apiKeyPrincipalIds: ['api-key-fixture-shared'],
      metrics: [{
        family: 'sleep',
        metricName: 'total_sleep_hours',
        unit: 'hours',
        minValue: 0,
        maxValue: 24,
      }],
      consentRef: 'consent-sleep-2026-01',
      sensitivity: 'relational_sensitive',
      revoked: false,
    }],
    maxRetainedObservations: 500,
    policyRevision: 'shadow-test-v1',
    ...overrides,
  };
}

class FakeShadowStore implements PartnerAffectShadowStorePort {
  readonly accepted: PartnerAffectObservation[] = [];
  readonly suppressed: PartnerAffectSuppressedObservation[] = [];
  pruneCalls: number[] = [];
  failNextRecord = false;

  async recordAccepted(observation: PartnerAffectObservation) {
    if (this.failNextRecord) {
      this.failNextRecord = false;
      throw new Error('injected store failure');
    }
    if (this.accepted.some(existing => existing.observationKey === observation.observationKey)) {
      return { inserted: false };
    }
    this.accepted.push(observation);
    return { inserted: true };
  }

  async recordSuppressed(suppressed: PartnerAffectSuppressedObservation) {
    this.suppressed.push(suppressed);
  }

  async listAccepted() {
    return [...this.accepted];
  }

  async listSuppressed() {
    return [...this.suppressed];
  }

  async pruneToRetentionCap(maxRetained: number) {
    this.pruneCalls.push(maxRetained);
    return 0;
  }

  async close() {
    // no-op
  }
}

function observationEvent(
  payloadOverrides: Record<string, unknown> = {},
  eventOverrides: Partial<ExternalTelemetryEvent> = {},
): ExternalTelemetryEvent {
  return {
    id: 'event-1',
    source: 'edge-sleep-1',
    eventType: 'external.telemetry.partner_affect.observation',
    payload: {
      observationId: 'obs-001',
      sourceId: 'edge-sleep-1',
      partnerContactId: PARTNER_ID,
      signalFamily: 'sleep',
      metricName: 'total_sleep_hours',
      value: 7.4,
      unit: 'hours',
      windowStartMs: NOW_MS - 10 * 60 * 60_000,
      windowEndMs: NOW_MS - 60_000,
      coverage: 0.9,
      confidence: 0.8,
      provenance: [{ source: 'runtime_state', observedAtMs: NOW_MS - 60_000 }],
      processingRevision: 'adapter-v3',
      ...payloadOverrides,
    },
    occurredAt: '2026-07-08T12:00:00.000Z',
    receivedAt: '2026-07-08T12:00:01.000Z',
    nonce: 'nonce-12345678',
    auth: {
      principalId: 'api-key-fixture-shared',
      principalMode: 'api_key',
      satelliteScoped: false,
    },
    ...eventOverrides,
  };
}

function createHarness(policy = testPolicy()) {
  const eventBus = new EventBus();
  const store = new FakeShadowStore();
  const counters: PartnerAffectShadowTelemetryEvent[] = [];
  eventBus.on('emotion.partner_affect.shadow.telemetry', (event) => {
    counters.push(event);
  });
  const bridge = createPartnerAffectShadowIngestBridge({
    eventBus,
    policy,
    store,
    now: () => NOW_MS,
  });
  return { eventBus, store, counters, bridge };
}

describe('createPartnerAffectShadowIngestBridge', () => {
  it('records an accepted observation from the real ingest spine and emits an accepted counter', async () => {
    const { eventBus, store, counters, bridge } = createHarness();
    expect(bridge.active).toBe(true);

    await eventBus.emit('external.telemetry.ingested', { event: observationEvent() });

    expect(store.accepted).toHaveLength(1);
    expect(store.accepted[0].observationKey).toBe('edge-sleep-1:obs-001');
    expect(store.accepted[0].partnerContactId).toBe(PARTNER_ID);
    expect(store.pruneCalls).toEqual([500]);
    expect(counters).toHaveLength(1);
    expect(counters[0].counter).toBe('accepted');
  });

  it('ignores telemetry of other event types entirely', async () => {
    const { eventBus, store, counters } = createHarness();
    await eventBus.emit('external.telemetry.ingested', {
      event: observationEvent({}, { eventType: 'external.telemetry.status' }),
    });
    expect(store.accepted).toHaveLength(0);
    expect(store.suppressed).toHaveLength(0);
    expect(counters).toHaveLength(0);
  });

  it('records suppression with reasons when the guard rejects the payload', async () => {
    const { eventBus, store, counters } = createHarness();
    await eventBus.emit('external.telemetry.ingested', {
      event: observationEvent({ partnerContactId: 'contact-housemate-2' }),
    });
    expect(store.accepted).toHaveLength(0);
    expect(store.suppressed).toHaveLength(1);
    expect(store.suppressed[0].reasons).toContain('wrong_partner');
    expect(counters[0].counter).toBe('suppressed');
    expect(counters[0].reasons).toContain('wrong_partner');
  });

  it('fails closed on telemetry without an authenticated ingress origin', async () => {
    const { eventBus, store, counters } = createHarness();
    const event = observationEvent();
    delete event.auth;
    await eventBus.emit('external.telemetry.ingested', { event });
    expect(store.accepted).toHaveLength(0);
    expect(store.suppressed).toHaveLength(1);
    expect(store.suppressed[0].reasons).toEqual(['missing_authenticated_origin']);
    expect(counters[0].counter).toBe('suppressed');
  });

  it('fails closed when an authenticated API principal is not authorized for the claimed source', async () => {
    const { eventBus, store, counters } = createHarness();
    await eventBus.emit('external.telemetry.ingested', {
      event: observationEvent({}, {
        auth: {
          principalId: 'api-key-for-another-source',
          principalMode: 'api_key',
          satelliteScoped: false,
        },
      }),
    });
    expect(store.accepted).toHaveLength(0);
    expect(store.suppressed).toHaveLength(1);
    expect(store.suppressed[0].reasons).toEqual(['missing_authenticated_origin']);
    expect(counters[0].counter).toBe('suppressed');
  });

  it('reports replayed observation keys as duplicates without double-recording', async () => {
    const { eventBus, store, counters } = createHarness();
    await eventBus.emit('external.telemetry.ingested', { event: observationEvent() });
    await eventBus.emit('external.telemetry.ingested', {
      event: observationEvent({}, { id: 'event-2' }),
    });
    expect(store.accepted).toHaveLength(1);
    expect(counters.map(entry => entry.counter)).toEqual(['accepted', 'duplicate']);
  });

  it('emits a store_error counter when persistence fails instead of swallowing it silently', async () => {
    const { store, counters } = createHarness();
    const warn = vi.fn();
    // Re-create with a logger spy to assert the failure is surfaced.
    const eventBus2 = new EventBus();
    const counters2: PartnerAffectShadowTelemetryEvent[] = [];
    eventBus2.on('emotion.partner_affect.shadow.telemetry', event => void counters2.push(event));
    createPartnerAffectShadowIngestBridge({
      eventBus: eventBus2,
      policy: testPolicy(),
      store,
      logger: { warn },
      now: () => NOW_MS,
    });
    store.failNextRecord = true;
    await eventBus2.emit('external.telemetry.ingested', { event: observationEvent() });
    expect(warn).toHaveBeenCalled();
    expect(counters2[0].counter).toBe('store_error');
    expect(counters).toHaveLength(0);
  });

  it('is fully inert when the shadow policy is disabled', async () => {
    const { eventBus, store, counters, bridge } = createHarness(
      testPolicy({ enabled: false, partnerContactId: null }),
    );
    expect(bridge.active).toBe(false);
    await eventBus.emit('external.telemetry.ingested', { event: observationEvent() });
    expect(store.accepted).toHaveLength(0);
    expect(store.suppressed).toHaveLength(0);
    expect(counters).toHaveLength(0);
  });

  it('stops observing after unsubscribe', async () => {
    const { eventBus, store, bridge } = createHarness();
    bridge.unsubscribe();
    await eventBus.emit('external.telemetry.ingested', { event: observationEvent() });
    expect(store.accepted).toHaveLength(0);
  });
});
