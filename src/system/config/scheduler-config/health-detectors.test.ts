import { describe, expect, it } from 'vitest';
import { MAX_HEALTH_EVENT_LIST_LIMIT } from '../../../shared/observability/health-event-stream.js';
import {
  DEFAULT_HEALTH_DETECTORS_CONFIG,
  validateHealthDetectorsConfig,
} from './health-detectors.js';

const SOURCE = '/owner/scheduler.json';

function withIncidentAlerts(overrides: Record<string, unknown>): unknown {
  const raw = structuredClone(DEFAULT_HEALTH_DETECTORS_CONFIG) as Record<string, unknown>;
  raw.incidentAlerts = {
    ...DEFAULT_HEALTH_DETECTORS_CONFIG.incidentAlerts,
    ...overrides,
  };
  return raw;
}

describe('healthDetectors.incidentAlerts owner-file contract', () => {
  it('accepts the canonical defaults', () => {
    const config = validateHealthDetectorsConfig(
      structuredClone(DEFAULT_HEALTH_DETECTORS_CONFIG),
      SOURCE,
    );
    expect(config.incidentAlerts).toEqual(DEFAULT_HEALTH_DETECTORS_CONFIG.incidentAlerts);
  });

  it('requires the block rather than defaulting a runtime into silence', () => {
    const raw = structuredClone(DEFAULT_HEALTH_DETECTORS_CONFIG) as Record<string, unknown>;
    delete raw.incidentAlerts;
    expect(() => validateHealthDetectorsConfig(raw, SOURCE))
      .toThrow(/incidentAlerts must be an object/u);
  });

  it('rejects an unknown key instead of ignoring an operator edit', () => {
    expect(() => validateHealthDetectorsConfig(withIncidentAlerts({ escalate: true }), SOURCE))
      .toThrow(/escalate/u);
  });

  it('refuses a re-alert cooldown shorter than the detector cooldown', () => {
    expect(() => validateHealthDetectorsConfig(
      withIncidentAlerts({ realertCooldownMs: DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs - 1 }),
      SOURCE,
    )).toThrow(/must be at least healthDetectors\.cooldownMs/u);
  });

  it('accepts a re-alert cooldown exactly at the detector cooldown', () => {
    const config = validateHealthDetectorsConfig(
      withIncidentAlerts({ realertCooldownMs: DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs }),
      SOURCE,
    );
    expect(config.incidentAlerts.realertCooldownMs)
      .toBe(DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs);
  });

  it('refuses a bundle window larger than the stream can read', () => {
    expect(() => validateHealthDetectorsConfig(
      withIncidentAlerts({ bundleEventLimit: MAX_HEALTH_EVENT_LIST_LIMIT + 1 }),
      SOURCE,
    )).toThrow(/structural read ceiling/u);
  });

  it('requires a positive bundle window and ledger capacity', () => {
    expect(() => validateHealthDetectorsConfig(withIncidentAlerts({ bundleEventLimit: 0 }), SOURCE))
      .toThrow(/bundleEventLimit/u);
    expect(() => validateHealthDetectorsConfig(withIncidentAlerts({ ledgerCapacity: 0 }), SOURCE))
      .toThrow(/ledgerCapacity/u);
  });

  it('requires closeNotice to be a boolean', () => {
    expect(() => validateHealthDetectorsConfig(withIncidentAlerts({ closeNotice: 'yes' }), SOURCE))
      .toThrow(/closeNotice/u);
  });
});
