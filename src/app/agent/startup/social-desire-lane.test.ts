// ── Composition-level wiring tests for the social-desire lane (hrmrq.85) ──
// The deep-reasoner verdict on hrmrq.85: an enabled lane whose source store has
// no production writer is a silent no-op that reports itself healthy. These
// tests pin the composition contract: enabling the lane REQUIRES the felt-signal
// writer to be composed, and a missing store refuses to boot.

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import { SOCIAL_DESIRE_OUTREACH_TASK_ID } from '../../../core/scheduler/social-desire-outreach-lane.js';
import {
  createInMemorySocialDesireBackend,
  createSocialDesireStorePort,
} from '../../../core/intention/social-desire-store-port.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import {
  DEFAULT_SOCIAL_DESIRE_CONFIG,
  type EpisodicProcessingRestWindowConfig,
} from '../../../system/config/scheduler-config.js';
import { registerSocialDesireLane, type SocialDesireLaneDeps } from './social-desire-lane.js';

const restWindow: EpisodicProcessingRestWindowConfig = {
  enabled: true,
  startLocalTime: '01:00',
  endLocalTime: '06:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 180,
};

function makeDeps(overrides: Partial<SocialDesireLaneDeps> = {}): SocialDesireLaneDeps {
  const eventBus = new EventBus();
  return {
    schedulerConfig: {
      socialDesire: { ...DEFAULT_SOCIAL_DESIRE_CONFIG, enabled: true },
      episodicProcessing: restWindow,
    },
    scheduler: new Scheduler(eventBus, { tickIntervalMs: 1_000, heartbeatIntervalMs: 5_000 }),
    postTurnActions: { enqueue: vi.fn(() => 'queued' as const) },
    eventBus,
    log: createComponentLogger('SocialDesireLaneTest'),
    socialDesireStore: createSocialDesireStorePort(createInMemorySocialDesireBackend()),
    outreachOutbox: { countSentSince: () => 0 },
    heartbeatChannel: { channelId: 'dm-primary', channelType: 'discord' },
    contactStore: { getById: async () => undefined },
    icpPeers: undefined,
    localCompanionId: undefined,
    llmProvider: { complete: vi.fn(), stream: vi.fn() } as unknown as LLMProviderPort,
    companionName: 'TestCompanion',
    attachFeltSignalWriter: vi.fn(),
    ...overrides,
  };
}

describe('registerSocialDesireLane composition wiring (psfn-framework-hrmrq.85)', () => {
  it('an enabled lane composes and attaches the felt-signal writer AND registers the task', () => {
    const attachFeltSignalWriter = vi.fn();
    const deps = makeDeps({ attachFeltSignalWriter });

    const result = registerSocialDesireLane(deps);

    // The production writer for the lane's source store exists and was handed
    // to the composition seam (the emotion/appraisal post-turn path).
    expect(attachFeltSignalWriter).toHaveBeenCalledTimes(1);
    expect(result.socialDesireFeltSignals).toBeDefined();
    expect(attachFeltSignalWriter).toHaveBeenCalledWith(result.socialDesireFeltSignals);
    // And the consent-moment task is live in the scheduler.
    expect(deps.scheduler.getTask(SOCIAL_DESIRE_OUTREACH_TASK_ID)).toBeDefined();
  });

  it('fails closed at boot when the lane is enabled but the store is missing', () => {
    const deps = makeDeps({ socialDesireStore: undefined });
    expect(() => registerSocialDesireLane(deps)).toThrow(/socialDesire\.enabled is true but no social-desire store/);
  });

  it('a disabled lane wires nothing and attaches no writer', () => {
    const attachFeltSignalWriter = vi.fn();
    const deps = makeDeps({
      schedulerConfig: {
        socialDesire: { ...DEFAULT_SOCIAL_DESIRE_CONFIG, enabled: false },
        episodicProcessing: restWindow,
      },
      attachFeltSignalWriter,
    });

    const result = registerSocialDesireLane(deps);
    expect(attachFeltSignalWriter).not.toHaveBeenCalled();
    expect(result.socialDesireFeltSignals).toBeUndefined();
    expect(deps.scheduler.getTask(SOCIAL_DESIRE_OUTREACH_TASK_ID)).toBeUndefined();
  });

  it('the composed writer actually accumulates into the lane store (end-to-end producer proof)', async () => {
    const store = createSocialDesireStorePort(createInMemorySocialDesireBackend());
    const deps = makeDeps({
      socialDesireStore: store,
      contactStore: {
        getById: async (id: string) => (id === 'contact-1'
          ? {
            id: 'contact-1',
            displayName: 'Vee',
            trustLevel: 'primary' as const,
            relationshipType: 'partner' as const,
            firstSeen: '2026-01-01T00:00:00.000Z',
            lastSeen: '2026-07-30T00:00:00.000Z',
          }
          : undefined),
      },
    });
    const result = registerSocialDesireLane(deps);
    const writer = result.socialDesireFeltSignals!;

    const outcome = await writer.record({
      schemaVersion: 1,
      emotional: {
        vad: { valence: 0.6, arousal: 0.2, dominance: 0 },
        mood: { valence: 0.1, arousal: 0, dominance: 0 },
        discreteEmotions: {},
        confidence: 1,
        telemetry: { status: 'trusted', source: 'classifier_inferred', reasons: [], weight: 1 },
      },
      cognitive: { certaintyLevel: 0.5, topicEngagement: 0.5, processingQuality: 'fluent' },
      attention: { activeConcernCount: 0, salientEntityCount: 0, conversationTrajectory: 'stable' },
      relational: { contactId: 'contact-1', trustLevel: 'primary', moodDrift: 0 },
    }, { sourceRef: 'test-turn', nowMs: Date.parse('2026-07-30T12:00:00.000Z') });

    expect(outcome?.outcome).toBe('created');
    expect(store.snapshotDesires()).toHaveLength(1);
  });
});
