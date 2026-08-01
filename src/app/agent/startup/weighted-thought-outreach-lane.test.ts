import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { WeightedThoughtContradictionDamperDeps } from '../../../core/intention/weighted-thought-contradiction.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import { EventBus } from '../../../shared/event-bus.js';
import {
  DEFAULT_WEIGHTED_THOUGHT_OUTREACH_CONFIG,
  type EpisodicProcessingRestWindowConfig,
} from '../../../system/config/scheduler-config.js';
import {
  registerWeightedThoughtOutreachLane,
  type WeightedThoughtOutreachLaneDeps,
} from './weighted-thought-outreach-lane.js';

const restWindow: EpisodicProcessingRestWindowConfig = {
  enabled: true,
  startLocalTime: '01:00',
  endLocalTime: '06:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 180,
};

function makeDeps(enabled: boolean): WeightedThoughtOutreachLaneDeps {
  const eventBus = new EventBus();
  return {
    scheduler: new Scheduler(eventBus),
    schedulerConfig: {
      weightedThoughtOutreach: {
        ...DEFAULT_WEIGHTED_THOUGHT_OUTREACH_CONFIG,
        enabled,
      },
      episodicProcessing: restWindow,
    },
    eventBus,
    weightedThoughtStore: null,
    llmProvider: { complete: vi.fn(), stream: vi.fn() } as unknown as LLMProviderPort,
    companionName: 'TestCompanion',
    heartbeatChannelId: 'dm-primary',
    contactStore: { getById: vi.fn() } as unknown as WeightedThoughtOutreachLaneDeps['contactStore'],
    concernStore: {} as WeightedThoughtContradictionDamperDeps['concernStore'],
    icpWeightedThoughtCandidateAdapter: undefined,
  };
}

describe('registerWeightedThoughtOutreachLane composition prerequisites', () => {
  it('fails closed at boot when the lane is enabled but its durable store is missing', () => {
    expect(() => registerWeightedThoughtOutreachLane(makeDeps(true))).toThrow(
      /weightedThoughtOutreach\.enabled is true but no weighted-thought store/,
    );
  });

  it('allows a missing store while the lane is explicitly disabled', () => {
    expect(() => registerWeightedThoughtOutreachLane(makeDeps(false))).not.toThrow();
  });
});
