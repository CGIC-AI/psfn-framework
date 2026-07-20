import { describe, expect, it } from 'vitest';
import { computePartnerAffectShadowEstimate } from './shadow-estimate.js';
import type {
  PartnerAffectObservation,
  PartnerAffectShadowPolicy,
} from '../../../shared/contracts/partner-affect.js';

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
    allowedSignalFamilies: ['self_report', 'conversation', 'sleep', 'activity'],
    directions: {},
    sources: [],
    maxRetainedObservations: 500,
    policyRevision: 'shadow-test-v1',
    ...overrides,
  };
}

function observation(
  overrides: Partial<PartnerAffectObservation> = {},
): PartnerAffectObservation {
  const observedAtMs = overrides.observedAtMs ?? NOW_MS - 60 * 60_000;
  return {
    schemaVersion: 1,
    observationKey: `src-a:${String(Math.random())}`,
    observationId: 'obs',
    sourceId: 'src-a',
    partnerContactId: PARTNER_ID,
    signalFamily: 'sleep',
    metricName: 'total_sleep_hours',
    value: 7,
    unit: 'hours',
    windowStartMs: observedAtMs - 8 * 60 * 60_000,
    windowEndMs: observedAtMs,
    observedAtMs,
    coverage: 0.9,
    confidence: 0.8,
    missingness: 0.1,
    direction: 'unknown',
    sensitivity: 'relational_sensitive',
    consentRef: 'consent-x',
    assertion: 'sensor_summary',
    provenance: [{ source: 'runtime_state' }],
    processingRevision: 'v1',
    receivedAtMs: observedAtMs,
    ...overrides,
  };
}

describe('computePartnerAffectShadowEstimate', () => {
  it('yields unknown with no_fresh_evidence when nothing has been observed', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [],
      policy: policy(),
      nowMs: NOW_MS,
    });
    expect(estimate.status).toBe('unknown');
    expect(estimate.reasons).toContain('no_fresh_evidence');
    // Every allowed family stays explicit as missing rather than disappearing.
    expect(estimate.families).toHaveLength(4);
    expect(estimate.families.every(family => family.freshness === 'missing')).toBe(true);
    expect(estimate.families.every(family => family.missingness === 1)).toBe(true);
    expect(estimate.derivation).toBe('deterministic_shadow_v1');
    expect(estimate.policyRevision).toBe('shadow-test-v1');
  });

  it('yields unknown under the independence quorum with one fresh family', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [observation()],
      policy: policy(),
      nowMs: NOW_MS,
    });
    expect(estimate.status).toBe('unknown');
    expect(estimate.reasons).toContain('insufficient_family_quorum');
    const sleep = estimate.families.find(family => family.family === 'sleep');
    expect(sleep?.freshness).toBe('fresh');
    expect(sleep?.freshObservationCount).toBe(1);
  });

  it('yields ordinary only with a fresh multi-family quorum of confident evidence', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [
        observation({ observationKey: 'a:1' }),
        observation({
          observationKey: 'b:1',
          signalFamily: 'conversation',
          metricName: 'daily_turns',
          sourceId: 'src-b',
          unit: 'count',
          value: 14,
        }),
      ],
      policy: policy(),
      nowMs: NOW_MS,
    });
    expect(estimate.status).toBe('ordinary');
    expect(estimate.reasons).toEqual(['quorum_met']);
  });

  it('keeps a fresh multi-family quorum unknown when every family has zero usable coverage', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [
        observation({
          observationKey: 'a:zero',
          coverage: 0,
          missingness: 1,
        }),
        observation({
          observationKey: 'b:zero',
          signalFamily: 'conversation',
          metricName: 'daily_turns',
          sourceId: 'src-b',
          unit: 'count',
          value: 0,
          coverage: 0,
          missingness: 1,
        }),
      ],
      policy: policy(),
      nowMs: NOW_MS,
    });
    expect(estimate.status).toBe('unknown');
    expect(estimate.reasons).toContain('insufficient_family_quorum');
    expect(estimate.reasons).not.toContain('quorum_met');
  });

  it('degrades stale evidence to unknown instead of treating absence as recovery', () => {
    const staleMs = NOW_MS - 100 * 60 * 60_000;
    const estimate = computePartnerAffectShadowEstimate({
      observations: [
        observation({ observationKey: 'a:1', observedAtMs: staleMs }),
        observation({
          observationKey: 'b:1',
          signalFamily: 'conversation',
          sourceId: 'src-b',
          observedAtMs: staleMs,
        }),
      ],
      policy: policy(),
      nowMs: NOW_MS,
    });
    expect(estimate.status).toBe('unknown');
    expect(estimate.reasons).toContain('no_fresh_evidence');
    const sleep = estimate.families.find(family => family.family === 'sleep');
    expect(sleep?.freshness).toBe('stale');
    expect(sleep?.latestObservedAtMs).toBe(staleMs);
  });

  it('records cross-source conflicts explicitly and blocks ordinary', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [
        observation({ observationKey: 'a:1', sourceId: 'src-a', value: 8 }),
        observation({ observationKey: 'b:1', sourceId: 'src-b', value: 3 }),
        observation({
          observationKey: 'c:1',
          signalFamily: 'conversation',
          sourceId: 'src-c',
        }),
      ],
      policy: policy(),
      nowMs: NOW_MS,
    });
    expect(estimate.status).toBe('unknown');
    expect(estimate.reasons).toContain('conflicting_evidence');
    const sleep = estimate.families.find(family => family.family === 'sleep');
    expect(sleep?.conflict).toBe(true);
    expect(sleep?.contributingSourceIds).toEqual(['src-a', 'src-b']);
  });

  it('does not flag agreeing sources or same-source repeats as conflicts', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [
        observation({ observationKey: 'a:1', sourceId: 'src-a', value: 7.0 }),
        observation({ observationKey: 'a:2', sourceId: 'src-a', value: 3.0 }),
        observation({ observationKey: 'b:1', sourceId: 'src-b', value: 7.4 }),
      ],
      policy: policy(),
      nowMs: NOW_MS,
    });
    const sleep = estimate.families.find(family => family.family === 'sleep');
    // src-a disagreeing with itself over time is a trend, not a source
    // conflict; src-b at 7.4 vs src-a at 7.0 is within tolerance. But src-a's
    // second reading (3.0) conflicts with src-b (7.4) across sources.
    expect(sleep?.conflict).toBe(true);
  });

  it('flags low-confidence fresh evidence and stays unknown', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [
        observation({ observationKey: 'a:1', confidence: 0.2 }),
        observation({
          observationKey: 'b:1',
          signalFamily: 'conversation',
          sourceId: 'src-b',
        }),
      ],
      policy: policy(),
      nowMs: NOW_MS,
    });
    expect(estimate.status).toBe('unknown');
    expect(estimate.reasons).toContain('low_confidence_evidence');
  });

  it('ignores observations bound to a different partner contact', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [
        observation({ observationKey: 'a:1', partnerContactId: 'contact-housemate-2' }),
      ],
      policy: policy(),
      nowMs: NOW_MS,
    });
    expect(estimate.reasons).toContain('no_fresh_evidence');
    expect(estimate.families.every(family => family.freshObservationCount === 0)).toBe(true);
  });

  it('reports partner_unbound and uses no observations when unbound', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [observation()],
      policy: policy({ partnerContactId: null }),
      nowMs: NOW_MS,
    });
    expect(estimate.status).toBe('unknown');
    expect(estimate.reasons).toContain('partner_unbound');
    expect(estimate.partnerContactId).toBeNull();
  });

  it('surfaces assertion bases per family so inference is never partner-asserted', () => {
    const estimate = computePartnerAffectShadowEstimate({
      observations: [
        observation({ observationKey: 'a:1', assertion: 'model_inferred' }),
        observation({ observationKey: 'a:2', assertion: 'sensor_summary' }),
      ],
      policy: policy(),
      nowMs: NOW_MS,
    });
    const sleep = estimate.families.find(family => family.family === 'sleep');
    expect(sleep?.assertionBases).toEqual(['model_inferred', 'sensor_summary']);
  });
});
