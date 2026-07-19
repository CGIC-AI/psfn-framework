import { describe, expect, it } from 'vitest';
import type { HumanAttentionPressureConfig } from '../../../shared/contracts/charge-policy.js';
import {
  buildHumanAttentionBoundaryAlert,
  DeterministicHumanAttentionPressure,
  type HumanAttentionPressureEvent,
  type HumanAttentionPressureStore,
} from './human-attention-pressure.js';

const POLICY: HumanAttentionPressureConfig = {
  enabled: true,
  windowMs: 10 * 60_000,
  boundaryCooldownMs: 30 * 60_000,
  trustThresholds: {
    public: 3,
    regular: 6,
    trusted: 12,
    primary: 20,
  },
  relationshipToleranceBonus: {
    stranger: 0,
    acquaintance: 1,
    friend: 3,
    family: 4,
    partner: 6,
    ai_companion: 0,
  },
  channelWeights: {
    directMessage: 1,
    directMention: 2,
    ambientGroupMessage: 0,
  },
};

class MemoryStore implements HumanAttentionPressureStore {
  readonly events: HumanAttentionPressureEvent[] = [];

  listHumanAttentionPressureEvents(input: {
    localCompanionId: string;
    contactId: string;
    channelId: string;
    sinceMs: number;
  }): HumanAttentionPressureEvent[] {
    return this.events.filter(event => (
      event.localCompanionId === input.localCompanionId
      && event.contactId === input.contactId
      && event.channelId === input.channelId
      && event.timestampMs >= input.sinceMs
    ));
  }

  recordHumanAttentionPressureEvent(event: HumanAttentionPressureEvent): void {
    this.events.push(event);
  }
}

function evaluate(
  pressure: DeterministicHumanAttentionPressure,
  overrides: Partial<Parameters<DeterministicHumanAttentionPressure['evaluate']>[0]> = {},
) {
  return pressure.evaluate({
    localCompanionId: 'purrsephone',
    contactId: 'human-low-trust',
    channelId: 'group-a',
    trustLevel: 'public',
    relationshipType: 'stranger',
    channelContext: 'direct_mention',
    timestampMs: 1_000_000,
    ...overrides,
  });
}

describe('DeterministicHumanAttentionPressure', () => {
  it('alerts on repeated low-trust direct mentions without suppressing the human turn', () => {
    const pressure = new DeterministicHumanAttentionPressure(new MemoryStore(), POLICY);

    expect(evaluate(pressure).decision).toBe('clear');
    const alert = evaluate(pressure, { timestampMs: 1_001_000 });

    expect(alert).toMatchObject({
      decision: 'boundary_alert',
      reason: 'threshold_reached',
      pressureInWindow: 4,
      threshold: 3,
      suppressTurn: false,
    });
  });

  it('gives primary and trusted relationships materially higher tolerance', () => {
    const pressure = new DeterministicHumanAttentionPressure(new MemoryStore(), POLICY);

    for (let index = 0; index < 8; index += 1) {
      const event = evaluate(pressure, {
        contactId: 'primary-human',
        channelId: 'dm-primary',
        trustLevel: 'primary',
        relationshipType: 'partner',
        channelContext: 'direct_message',
        timestampMs: 2_000_000 + index * 1_000,
      });
      expect(event.decision).toBe('clear');
    }
  });

  it('isolates pressure by contact and channel and applies a boundary cooldown', () => {
    const store = new MemoryStore();
    const pressure = new DeterministicHumanAttentionPressure(store, POLICY);

    evaluate(pressure);
    expect(evaluate(pressure, { timestampMs: 1_001_000 }).decision).toBe('boundary_alert');
    expect(evaluate(pressure, { timestampMs: 1_002_000 }).decision).toBe('cooldown');
    expect(evaluate(pressure, {
      contactId: 'other-human',
      timestampMs: 1_003_000,
    }).decision).toBe('clear');
    expect(evaluate(pressure, {
      channelId: 'group-b',
      timestampMs: 1_004_000,
    }).decision).toBe('clear');
  });

  it('honors a boundary cooldown that is longer than the pressure window', () => {
    const pressure = new DeterministicHumanAttentionPressure(new MemoryStore(), POLICY);

    evaluate(pressure);
    const boundaryAt = 1_001_000;
    expect(evaluate(pressure, { timestampMs: boundaryAt }).decision).toBe('boundary_alert');
    expect(evaluate(pressure, {
      timestampMs: boundaryAt + 11 * 60_000,
    })).toMatchObject({
      decision: 'cooldown',
      reason: 'boundary_cooldown_active',
      cooldownUntilMs: boundaryAt + POLICY.boundaryCooldownMs,
    });
    expect(evaluate(pressure, {
      timestampMs: boundaryAt + POLICY.boundaryCooldownMs,
    }).decision).toBe('clear');
  });

  it('renders internal permission, not hardcoded partner-facing boundary wording', () => {
    const pressure = new DeterministicHumanAttentionPressure(new MemoryStore(), POLICY);
    evaluate(pressure);
    const event = evaluate(pressure, { timestampMs: 1_001_000 });
    const alert = buildHumanAttentionBoundaryAlert(event);

    expect(alert).toContain('visibility="internal"');
    expect(alert).toContain('in your own voice');
    expect(alert).toContain('You may also continue normally');
    expect(alert).not.toContain('Please stop messaging me');
    expect(buildHumanAttentionBoundaryAlert({ ...event, decision: 'clear' })).toBe('');
  });
});
