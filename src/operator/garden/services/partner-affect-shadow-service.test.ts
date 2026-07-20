import { describe, expect, it } from 'vitest';
import { AdminPartnerAffectShadowDataService } from './partner-affect-shadow-service.js';
import type {
  PartnerAffectObservation,
  PartnerAffectShadowPolicy,
  PartnerAffectSuppressedObservation,
} from '../../../shared/contracts/partner-affect.js';
import type {
  PartnerAffectObservationListOptions,
  PartnerAffectShadowStorePort,
  PartnerAffectSuppressionListOptions,
} from '../../../core/emotion/partner-affect/shadow-store-port.js';

const NOW_MS = 1_800_000_000_000;
const PARTNER_ID = 'contact-partner-1';

function policy(overrides: Partial<PartnerAffectShadowPolicy> = {}): PartnerAffectShadowPolicy {
  return {
    enabled: true,
    partnerContactId: PARTNER_ID,
    staleAfterMs: 24 * 60 * 60_000,
    evidenceWindowMs: 72 * 60 * 60_000,
    minConfidence: 0.35,
    minIndependentFamilies: 2,
    conflictValueTolerance: 0.25,
    allowedSignalFamilies: ['self_report', 'sleep'],
    directions: {},
    sources: [
      {
        sourceId: 'edge-sleep-1',
        families: ['sleep'],
        consentRef: 'consent-sleep-2026-01',
        sensitivity: 'relational_sensitive',
        revoked: false,
      },
      {
        sourceId: 'revoked-1',
        families: ['sleep'],
        consentRef: 'consent-old',
        sensitivity: 'relational_sensitive',
        revoked: true,
      },
    ],
    maxRetainedObservations: 500,
    policyRevision: 'shadow-test-v1',
    ...overrides,
  };
}

function observation(overrides: Partial<PartnerAffectObservation> = {}): PartnerAffectObservation {
  const observedAtMs = overrides.observedAtMs ?? NOW_MS - 60_000;
  return {
    schemaVersion: 1,
    observationKey: 'edge-sleep-1:obs-001',
    observationId: 'obs-001',
    sourceId: 'edge-sleep-1',
    partnerContactId: PARTNER_ID,
    signalFamily: 'sleep',
    metricName: 'total_sleep_hours',
    value: 7.4,
    unit: 'hours',
    windowStartMs: observedAtMs - 8 * 60 * 60_000,
    windowEndMs: observedAtMs,
    observedAtMs,
    coverage: 0.9,
    confidence: 0.8,
    missingness: 0.1,
    direction: 'unknown',
    sensitivity: 'relational_sensitive',
    consentRef: 'consent-sleep-2026-01',
    assertion: 'sensor_summary',
    provenance: [{ source: 'runtime_state' }],
    processingRevision: 'v1',
    receivedAtMs: observedAtMs,
    ...overrides,
  };
}

class FakeStore implements PartnerAffectShadowStorePort {
  listAcceptedCalls: PartnerAffectObservationListOptions[] = [];
  listSuppressedCalls: PartnerAffectSuppressionListOptions[] = [];

  constructor(
    private readonly accepted: PartnerAffectObservation[],
    private readonly suppressed: PartnerAffectSuppressedObservation[] = [],
  ) {}

  async recordAccepted() {
    return { inserted: true };
  }

  async recordSuppressed() {
    // unused in service tests
  }

  async listAccepted(options: PartnerAffectObservationListOptions) {
    this.listAcceptedCalls.push(options);
    return this.accepted.filter(entry => entry.partnerContactId === options.partnerContactId);
  }

  async listSuppressed(options: PartnerAffectSuppressionListOptions = {}) {
    this.listSuppressedCalls.push(options);
    return [...this.suppressed];
  }

  async pruneToRetentionCap() {
    return 0;
  }

  async close() {
    // no-op
  }
}

describe('AdminPartnerAffectShadowDataService', () => {
  it('summarizes policy without leaking full source registry details and computes the estimate', async () => {
    const store = new FakeStore([observation()]);
    const service = new AdminPartnerAffectShadowDataService({
      store,
      loadPolicy: () => policy(),
      now: () => NOW_MS,
    });

    const snapshot = await service.getShadowSnapshot();
    expect(snapshot.policy.partnerContactId).toBe(PARTNER_ID);
    expect(snapshot.policy.sourceCount).toBe(2);
    expect(snapshot.policy.revokedSourceCount).toBe(1);
    expect(snapshot.policy.policyRevision).toBe('shadow-test-v1');
    // Only one fresh family (sleep) => quorum of 2 unmet => unknown.
    expect(snapshot.estimate.status).toBe('unknown');
    expect(snapshot.estimate.reasons).toContain('insufficient_family_quorum');
    expect(store.listAcceptedCalls[0]).toEqual({
      partnerContactId: PARTNER_ID,
      sinceMs: NOW_MS - 72 * 60 * 60_000,
      limit: 1_000,
    });
  });

  it('yields an unknown, partner_unbound estimate without touching the store when unbound', async () => {
    const store = new FakeStore([observation()]);
    const service = new AdminPartnerAffectShadowDataService({
      store,
      loadPolicy: () => policy({ enabled: false, partnerContactId: null }),
      now: () => NOW_MS,
    });
    const snapshot = await service.getShadowSnapshot();
    expect(snapshot.estimate.status).toBe('unknown');
    expect(snapshot.estimate.reasons).toContain('partner_unbound');
    expect(store.listAcceptedCalls).toHaveLength(0);
  });

  it('pages accepted and suppressed records with a bounded limit', async () => {
    const suppressed: PartnerAffectSuppressedObservation = {
      schemaVersion: 1,
      observationKey: null,
      sourceId: null,
      signalFamily: null,
      partnerContactId: PARTNER_ID,
      reasons: ['missing_authenticated_origin'],
      detail: 'telemetry event lacks an authenticated ingress origin context',
      receivedAtMs: NOW_MS,
    };
    const store = new FakeStore([observation()], [suppressed]);
    const service = new AdminPartnerAffectShadowDataService({
      store,
      loadPolicy: () => policy(),
      now: () => NOW_MS,
    });
    const page = await service.listObservations(25);
    expect(page.accepted).toHaveLength(1);
    expect(page.suppressed).toHaveLength(1);
    expect(store.listAcceptedCalls[0]).toEqual({ partnerContactId: PARTNER_ID, limit: 25 });
    // Suppression audit is scoped to the bound partner, matching listAccepted.
    expect(store.listSuppressedCalls[0]).toEqual({ partnerContactId: PARTNER_ID, limit: 25 });

    await expect(service.listObservations(0)).rejects.toThrow(/limit/);
    await expect(service.listObservations(10_000)).rejects.toThrow(/limit/);
  });

  it('does not pass a partner filter to listSuppressed when the lane is unbound', async () => {
    const store = new FakeStore([]);
    const service = new AdminPartnerAffectShadowDataService({
      store,
      loadPolicy: () => policy({ enabled: false, partnerContactId: null }),
      now: () => NOW_MS,
    });
    await service.listObservations(10);
    expect(store.listAcceptedCalls).toHaveLength(0);
    expect(store.listSuppressedCalls[0]).toEqual({ limit: 10 });
  });
});
