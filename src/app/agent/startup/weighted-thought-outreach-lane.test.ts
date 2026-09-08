import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { ActiveConcern } from '../../../core/intention/concerns.js';
import { concernWeightedThoughtId } from '../../../core/intention/concern-weighted-thought-producer.js';
import type { WeightedThoughtContradictionDamperDeps } from '../../../core/intention/weighted-thought-contradiction.js';
import {
  createInMemoryWeightedThoughtBackend,
  createWeightedThoughtStorePort,
} from '../../../core/intention/weighted-thought-store-port.js';
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

describe('registerWeightedThoughtOutreachLane concern producer wiring', () => {
  it('turns a reviewed concern into a concern-scoped weighted thought', async () => {
    const deps = makeDeps(false);
    const weightedThoughtStore = createWeightedThoughtStorePort(
      createInMemoryWeightedThoughtBackend(),
    );
    const concern = {
      id: 'concern-1',
      text: 'Morgan seemed stressed about the move',
      status: 'active',
      contactId: 'contact-v',
    } as ActiveConcern;

    registerWeightedThoughtOutreachLane({
      ...deps,
      weightedThoughtStore,
      concernStore: {
        getById: (id: string) => (id === concern.id ? concern : null),
      } as WeightedThoughtContradictionDamperDeps['concernStore'],
    });

    await deps.eventBus.emit('intention.concern_candidate.reviewed', {
      candidateCount: 1,
      outcomeCount: 1,
      outcomes: [{
        candidateId: 'candidate-1',
        action: 'create',
        status: 'created',
        reason: 'a live open thread',
        concernId: 'concern-1',
      }],
      timestamp: Date.now(),
    });

    const thought = await weightedThoughtStore.getById(concernWeightedThoughtId('concern-1'));
    expect(thought).toMatchObject({ contactId: 'contact-v', source: 'concern' });
    expect(thought?.provenance.concernId).toBe('concern-1');
  });
});
