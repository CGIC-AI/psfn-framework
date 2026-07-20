import { describe, expect, it } from 'vitest';
import {
  derivePartnerAffectAssertionBasis,
  guardPartnerAffectObservation,
} from './observation-guard.js';
import type { PartnerAffectShadowPolicy } from '../../../shared/contracts/partner-affect.js';

const NOW_MS = 1_800_000_000_000;
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
    allowedSignalFamilies: ['self_report', 'conversation', 'sleep', 'activity', 'presence'],
    directions: { 'sleep.total_sleep_hours': 'lower_supports_need' },
    sources: [
      {
        sourceId: 'edge-sleep-1',
        families: ['sleep', 'activity'],
        consentRef: 'consent-sleep-2026-01',
        sensitivity: 'relational_sensitive',
        revoked: false,
      },
      {
        sourceId: 'revoked-source',
        families: ['activity'],
        consentRef: 'consent-activity-2025-12',
        sensitivity: 'relational_sensitive',
        revoked: true,
      },
    ],
    maxRetainedObservations: 500,
    policyRevision: 'shadow-test-v1',
    ...overrides,
  };
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

function guard(
  payload: Record<string, unknown>,
  policy: PartnerAffectShadowPolicy = testPolicy(),
) {
  return guardPartnerAffectObservation({
    candidate: { payload, receivedAtMs: NOW_MS },
    policy,
    nowMs: NOW_MS,
  });
}

describe('guardPartnerAffectObservation', () => {
  it('accepts a well-formed observation and normalizes every contract field', () => {
    const decision = guard(validPayload());
    expect(decision.status).toBe('accepted');
    if (decision.status !== 'accepted') return;
    const observation = decision.observation;
    expect(observation.observationKey).toBe('edge-sleep-1:obs-001');
    expect(observation.partnerContactId).toBe(PARTNER_ID);
    expect(observation.signalFamily).toBe('sleep');
    expect(observation.metricName).toBe('total_sleep_hours');
    expect(observation.value).toBe(7.4);
    expect(observation.unit).toBe('hours');
    // Direction comes from partner-specific policy, never the source payload.
    expect(observation.direction).toBe('lower_supports_need');
    // Consent and sensitivity are stamped from the authorized-source registry.
    expect(observation.consentRef).toBe('consent-sleep-2026-01');
    expect(observation.sensitivity).toBe('relational_sensitive');
    // Missingness defaults to 1 - coverage and stays explicit.
    expect(observation.missingness).toBeCloseTo(0.1, 4);
    expect(observation.observedAtMs).toBe(NOW_MS - 60_000);
    expect(observation.assertion).toBe('sensor_summary');
    expect(observation.processingRevision).toBe('adapter-v3');
    expect(observation.provenance).toHaveLength(1);
  });

  it('marks model/classifier provenance as model_inferred, never partner-asserted', () => {
    const decision = guard(validPayload({
      provenance: [{ source: 'self_report', classifier: 'affect-cls-v2' }],
    }));
    expect(decision.status).toBe('accepted');
    if (decision.status !== 'accepted') return;
    expect(decision.observation.assertion).toBe('model_inferred');
  });

  it('marks pure self-report provenance as partner_asserted', () => {
    expect(derivePartnerAffectAssertionBasis([{ source: 'self_report' }])).toBe('partner_asserted');
    expect(derivePartnerAffectAssertionBasis([{ source: 'self_report', model: 'm' }])).toBe('model_inferred');
    expect(derivePartnerAffectAssertionBasis([{ source: 'runtime_state' }])).toBe('sensor_summary');
  });

  it('fails closed on non-whitelisted payload keys (raw-sensitive smuggling)', () => {
    for (const extra of [
      { gpsLatitude: 52.1, gpsLongitude: 4.3 },
      { heartRateSeries: [61, 62, 64, 66, 70, 72, 75, 71] },
      { messageBody: 'private text the estimator must never see' },
      { lineItems: [{ sku: 'x', price: 12 }] },
    ]) {
      const decision = guard(validPayload(extra));
      expect(decision.status).toBe('suppressed');
      if (decision.status !== 'suppressed') return;
      expect(decision.suppressed.reasons).toContain('raw_sensitive_payload');
      // The suppressed audit record never echoes the offending content.
      const serialized = JSON.stringify(decision.suppressed);
      expect(serialized).not.toContain('gpsLatitude');
      expect(serialized).not.toContain('private text');
      expect(serialized).not.toContain('sku');
    }
  });

  it('fails closed on provenance entries with unexpected keys', () => {
    const decision = guard(validPayload({
      provenance: [{ source: 'runtime_state', faceVector: [0.1, 0.2] }],
    }));
    expect(decision.status).toBe('suppressed');
    if (decision.status !== 'suppressed') return;
    expect(decision.suppressed.reasons).toContain('raw_sensitive_payload');
  });

  it('suppresses observations naming a different contact as wrong_partner', () => {
    const decision = guard(validPayload({ partnerContactId: 'contact-housemate-2' }));
    expect(decision.status).toBe('suppressed');
    if (decision.status !== 'suppressed') return;
    expect(decision.suppressed.reasons).toContain('wrong_partner');
  });

  it('suppresses when no canonical partner is bound', () => {
    const decision = guard(validPayload(), testPolicy({ enabled: false, partnerContactId: null }));
    expect(decision.status).toBe('suppressed');
    if (decision.status !== 'suppressed') return;
    expect(decision.suppressed.reasons).toEqual(
      expect.arrayContaining(['partner_unbound', 'shadow_disabled']),
    );
  });

  it('suppresses stale observations with an explicit reason', () => {
    const staleMs = NOW_MS - 25 * 60 * 60_000;
    const decision = guard(validPayload({
      windowStartMs: staleMs - 60_000,
      windowEndMs: staleMs,
      observedAtMs: staleMs,
    }));
    expect(decision.status).toBe('suppressed');
    if (decision.status !== 'suppressed') return;
    expect(decision.suppressed.reasons).toContain('stale_observation');
  });

  it('suppresses future-dated observations beyond clock skew', () => {
    const future = NOW_MS + 10 * 60_000;
    const decision = guard(validPayload({
      windowStartMs: future - 60_000,
      windowEndMs: future,
      observedAtMs: future,
    }));
    expect(decision.status).toBe('suppressed');
    if (decision.status !== 'suppressed') return;
    expect(decision.suppressed.reasons).toContain('future_observation');
  });

  it('suppresses inverted observation windows', () => {
    const decision = guard(validPayload({
      windowStartMs: NOW_MS,
      windowEndMs: NOW_MS - 60_000,
    }));
    expect(decision.status).toBe('suppressed');
    if (decision.status !== 'suppressed') return;
    expect(decision.suppressed.reasons).toContain('invalid_window');
  });

  it('suppresses low-confidence observations against the policy floor', () => {
    const decision = guard(validPayload({ confidence: 0.1 }));
    expect(decision.status).toBe('suppressed');
    if (decision.status !== 'suppressed') return;
    expect(decision.suppressed.reasons).toContain('low_confidence');
  });

  it('suppresses unregistered, revoked, and non-consented sources', () => {
    const unregistered = guard(validPayload({ sourceId: 'never-registered' }));
    expect(unregistered.status).toBe('suppressed');
    if (unregistered.status === 'suppressed') {
      expect(unregistered.suppressed.reasons).toContain('unregistered_source');
    }

    const revoked = guard(validPayload({ sourceId: 'revoked-source', signalFamily: 'activity' }));
    expect(revoked.status).toBe('suppressed');
    if (revoked.status === 'suppressed') {
      expect(revoked.suppressed.reasons).toContain('revoked_source');
    }

    const wrongFamily = guard(validPayload({ signalFamily: 'presence' }));
    expect(wrongFamily.status).toBe('suppressed');
    if (wrongFamily.status === 'suppressed') {
      expect(wrongFamily.suppressed.reasons).toContain('family_not_consented');
    }
  });

  it('suppresses families outside policy and unknown families', () => {
    const notAllowed = guard(
      validPayload({ signalFamily: 'personal_operations' }),
      testPolicy({
        sources: [{
          sourceId: 'edge-sleep-1',
          families: ['personal_operations'],
          consentRef: 'consent-ops',
          sensitivity: 'relational_sensitive',
          revoked: false,
        }],
      }),
    );
    expect(notAllowed.status).toBe('suppressed');
    if (notAllowed.status === 'suppressed') {
      expect(notAllowed.suppressed.reasons).toContain('family_not_allowed');
    }

    const unknown = guard(validPayload({ signalFamily: 'astrology' }));
    expect(unknown.status).toBe('suppressed');
    if (unknown.status === 'suppressed') {
      expect(unknown.suppressed.reasons).toContain('unknown_signal_family');
    }
  });

  it('suppresses consentRef mismatches against the registry', () => {
    const decision = guard(validPayload({ consentRef: 'consent-forged' }));
    expect(decision.status).toBe('suppressed');
    if (decision.status !== 'suppressed') return;
    expect(decision.suppressed.reasons).toContain('consent_mismatch');
  });

  it('requires non-empty concrete provenance', () => {
    const missing = guard(validPayload({ provenance: [] }));
    expect(missing.status).toBe('suppressed');
    if (missing.status === 'suppressed') {
      expect(missing.suppressed.reasons).toContain('missing_provenance');
    }

    const vague = guard(validPayload({ provenance: [{ source: 'unknown' }] }));
    expect(vague.status).toBe('suppressed');
    if (vague.status === 'suppressed') {
      expect(vague.suppressed.reasons).toContain('missing_provenance');
    }
  });

  it('rejects non-scalar values and out-of-range quality fields as malformed', () => {
    for (const bad of [
      { value: [1, 2, 3] },
      { value: 'seven' },
      { value: Number.NaN },
      { coverage: 1.4 },
      { confidence: -0.1 },
      { metricName: 'x'.repeat(200) },
      { unit: 'contains spaces and a very long smuggled sentence' },
    ]) {
      const decision = guard(validPayload(bad));
      expect(decision.status).toBe('suppressed');
      if (decision.status !== 'suppressed') return;
      expect(decision.suppressed.reasons).toContain('malformed_observation');
    }
  });

  it('collects every applicable suppression reason for the explanation record', () => {
    const decision = guard(validPayload({
      partnerContactId: 'someone-else',
      confidence: 0.05,
      extraBlob: { anything: true },
    }));
    expect(decision.status).toBe('suppressed');
    if (decision.status !== 'suppressed') return;
    expect(decision.suppressed.reasons).toEqual(
      expect.arrayContaining(['wrong_partner', 'low_confidence', 'raw_sensitive_payload']),
    );
    expect(decision.suppressed.observationKey).toBe('edge-sleep-1:obs-001');
    expect(decision.suppressed.sourceId).toBe('edge-sleep-1');
    expect(decision.suppressed.signalFamily).toBe('sleep');
  });
});
