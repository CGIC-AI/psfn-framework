import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HUMAN_ESCALATION_CONFIG,
  validateHumanEscalationConfig,
} from './human-escalation.js';

const SOURCE = '/owner/scheduler.json';
const CROSS_CHECKS = { incidentRealertCooldownMs: 3_600_000 };

function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    routes: structuredClone(DEFAULT_HUMAN_ESCALATION_CONFIG.routes),
    listLimit: DEFAULT_HUMAN_ESCALATION_CONFIG.listLimit,
    ...overrides,
  };
}

function routes(overrides: Record<string, unknown>): Record<string, unknown> {
  return block({
    routes: { ...structuredClone(DEFAULT_HUMAN_ESCALATION_CONFIG.routes), ...overrides },
  });
}

describe('human escalation owner-file routing', () => {
  it('accepts the canonical defaults', () => {
    expect(validateHumanEscalationConfig(block(), SOURCE, CROSS_CHECKS))
      .toEqual(DEFAULT_HUMAN_ESCALATION_CONFIG);
  });

  it('rejects a kind with no routing entry rather than raising it into silence', () => {
    const raw = block();
    delete (raw.routes as Record<string, unknown>).cogsec_quarantine;

    expect(() => validateHumanEscalationConfig(raw, SOURCE, CROSS_CHECKS))
      .toThrow(/humanEscalation\.routes\.cogsec_quarantine is required/);
  });

  it('rejects an unknown kind', () => {
    expect(() => validateHumanEscalationConfig(
      routes({ made_up_kind: { sink: 'garden_only', cooldownMs: 0 } }),
      SOURCE,
      CROSS_CHECKS,
    )).toThrow(/made_up_kind/);
  });

  it('rejects an unknown sink', () => {
    expect(() => validateHumanEscalationConfig(
      routes({ cogsec_quarantine: { sink: 'pagerduty', cooldownMs: 0 } }),
      SOURCE,
      CROSS_CHECKS,
    )).toThrow(/sink must be one of operator_alert, garden_only/);
  });

  it('rejects a second cooldown competing with the incident re-alert clock', () => {
    expect(() => validateHumanEscalationConfig(
      routes({ runtime_incident: { sink: 'operator_alert', cooldownMs: 60_000 } }),
      SOURCE,
      CROSS_CHECKS,
    )).toThrow(/must be 0 \(got 60000\).*realertCooldownMs \(3600000\)/s);
  });

  it('refuses to silence runtime incidents onto a page nobody is watching', () => {
    expect(() => validateHumanEscalationConfig(
      routes({ runtime_incident: { sink: 'garden_only', cooldownMs: 0 } }),
      SOURCE,
      CROSS_CHECKS,
    )).toThrow(/must be operator_alert/);
  });

  it('rejects a cooldown on a route that sends nothing', () => {
    expect(() => validateHumanEscalationConfig(
      routes({ operator_confirmation: { sink: 'garden_only', cooldownMs: 60_000 } }),
      SOURCE,
      CROSS_CHECKS,
    )).toThrow(/must be 0 when the route sink is garden_only/);
  });

  it('rejects a list limit past the ledger read ceiling', () => {
    expect(() => validateHumanEscalationConfig(
      block({ listLimit: 5_000 }),
      SOURCE,
      CROSS_CHECKS,
    )).toThrow(/structural read ceiling/);
  });

  it('rejects unknown keys in the block', () => {
    expect(() => validateHumanEscalationConfig(
      block({ quietHours: { enabled: true } }),
      SOURCE,
      CROSS_CHECKS,
    )).toThrow(/quietHours/);
  });
});
