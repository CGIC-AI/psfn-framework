import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '../../boundary/pi-agent/index.js';
import {
  createIntentionAppraisalHooks,
  createIntentionBehavioralPatternHooks,
  wireIntentionRuntimeStores,
  type IntentionRuntimeProviders,
  type IntentionRuntimeTarget,
  type IntentionRuntimeWiring,
} from './runtime-wiring.js';
import type { BehavioralPatternStorePort } from './behavioral-pattern-store-port.js';
import type { ConcernStorePort } from './concern-store-port.js';
import type { PendingFollowUpStorePort } from './pending-follow-up-store-port.js';
import type { ActiveConcern } from './concerns.js';
import { MAX_TEXT_CHARS as PENDING_FOLLOW_UP_MAX_TEXT_CHARS } from './pending-follow-ups.js';
import type { PendingFollowUp } from './pending-follow-ups.js';

type IntentionPostTurnHook = Parameters<
  NonNullable<IntentionRuntimeTarget['registerIntentionPostTurnHook']>
>[0];
type IntentionPostTurnContext = Parameters<IntentionPostTurnHook>[0];
type IntentionPostTurnEffects = Parameters<IntentionPostTurnHook>[1];

class FakeTarget implements IntentionRuntimeTarget {
  activeConcernProvider: IntentionRuntimeTarget['activeConcernProvider'] = null;
  pendingFollowUpProvider: IntentionRuntimeTarget['pendingFollowUpProvider'] = null;
  behavioralPatternProvider: IntentionRuntimeTarget['behavioralPatternProvider'] = null;
  tools: AgentTool<any>[] = [];
  registrations: Array<{ name: string; category: 'core' | 'extended' }> = [];
  intentionHooks: IntentionPostTurnHook[] = [];

  registerTool(tool: AgentTool<any>, category: 'core' | 'extended' = 'core'): void {
    this.tools.push(tool);
    this.registrations.push({ name: tool.name, category });
  }

  registerIntentionPostTurnHook(
    hook: IntentionPostTurnHook,
  ): () => void {
    this.intentionHooks.push(hook);
    return () => {};
  }
}

function makeConcern(overrides: Partial<ActiveConcern> = {}): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Check hydration reminder',
    priority: 'medium',
    source: 'appraisal',
    status: 'active',
    createdAt: '2026-03-06T11:00:00.000Z',
    expiresAt: '2026-03-07T11:00:00.000Z',
    salience: 0.5,
    sensitivity: 'personal',
    owner: 'companion',
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
    ...overrides,
  };
}

function makeConcernStore(overrides: Partial<ConcernStorePort> = {}): ConcernStorePort {
  return {
    create: vi.fn(async input => makeConcern({
      ...input,
      id: 'created-concern',
      createdAt: input.createdAt ?? '2026-03-06T12:00:00.000Z',
      expiresAt: input.expiresAt ?? '2026-03-07T12:00:00.000Z',
      priority: input.priority ?? 'medium',
      source: input.source ?? 'appraisal',
      status: input.status ?? 'active',
    })),
    getById: vi.fn(async () => null),
    getActiveConcerns: vi.fn(async () => []),
    list: vi.fn(async () => []),
    listRecentlyResolvedConcerns: vi.fn(async () => []),
    findRecentlyResolvedSimilarConcern: vi.fn(async () => null),
    resolveConcern: vi.fn(async () => null),
    transitionConcernStatus: vi.fn(async () => null),
    resolveStaleConcerns: vi.fn(async () => []),
    ...overrides,
  };
}

function makeFollowUp(overrides: Partial<PendingFollowUp> = {}): PendingFollowUp {
  return {
    id: 'follow-up-1',
    content: 'Check in tomorrow about medication.',
    priority: 'medium',
    timing: 'scheduled',
    createdAt: '2026-03-06T11:00:00.000Z',
    channelId: 'api:test',
    channelType: 'api',
    authorId: 'system:intention',
    authorName: 'Whisper',
    ...overrides,
  };
}

function makePendingFollowUpStore(
  overrides: Partial<PendingFollowUpStorePort> = {},
): PendingFollowUpStorePort {
  return {
    enqueue: vi.fn(async input => makeFollowUp({
      ...input,
      id: 'created-follow-up',
      createdAt: input.createdAt ?? '2026-03-06T12:00:00.000Z',
      wakeConditions: input.wakeConditions ? [...input.wakeConditions] : undefined,
    })),
    peek: vi.fn(async () => null),
    dequeue: vi.fn(async id => makeFollowUp({ id })),
    quarantine: vi.fn(async input => ({
      id: 'quarantine-1',
      reason: input.reason,
      raw: input.raw,
      quarantinedAt: input.quarantinedAt ?? '2026-03-06T12:00:00.000Z',
    })),
    list: vi.fn(async () => []),
    listQuarantined: vi.fn(async () => []),
    ...overrides,
  };
}

function createRuntime(): {
  runtime: IntentionRuntimeWiring;
  providers: IntentionRuntimeProviders;
  behavioralPatternTracker: BehavioralPatternStorePort & {
    recordResponseStrategy: ReturnType<typeof vi.fn>;
  };
} {
  const concernStore = {} as ConcernStorePort;
  const pendingFollowUpStore = {} as PendingFollowUpStorePort;
  const behavioralPatternTracker = {
    setPromotionHook: vi.fn(),
    recordResponseStrategy: vi.fn(async input => ({
      id: 'sample-1',
      contactId: input.contactId,
      sourceMessageId: input.sourceMessageId,
      strategy: 'direct',
      responseExcerpt: input.responseContent,
      createdAt: input.createdAt ?? new Date('2026-01-01T00:00:00.000Z').toISOString(),
    })),
    recordOutcomeForSample: vi.fn(),
    tryRecordOutcomeForLatestPending: vi.fn(),
    listSamples: vi.fn(),
    listStrategySummaries: vi.fn(),
  } as unknown as BehavioralPatternStorePort & {
    recordResponseStrategy: ReturnType<typeof vi.fn>;
  };

  return {
    runtime: {
      concernStore,
      pendingFollowUpStore,
      behavioralPatternTracker,
    },
    providers: {
      concernProvider: { getActiveConcerns: () => [] },
      pendingFollowUpProvider: { getPendingFollowUps: () => [] },
      behavioralPatternProvider: { getBehavioralNotes: () => '' },
    },
    behavioralPatternTracker,
  };
}

describe('wireIntentionRuntimeStores', () => {
  it('injects supplied providers and stores without registering separate concern tools', () => {
    const target = new FakeTarget();
    const { runtime, providers } = createRuntime();

    const wired = wireIntentionRuntimeStores(target, runtime, providers);

    expect(target.activeConcernProvider).toBe(providers.concernProvider);
    expect(target.pendingFollowUpProvider).toBe(providers.pendingFollowUpProvider);
    expect(target.behavioralPatternProvider).toBe(providers.behavioralPatternProvider);
    expect(wired.concernStore).toBe(runtime.concernStore);
    expect(wired.pendingFollowUpStore).toBe(runtime.pendingFollowUpStore);
    expect(wired.behavioralPatternTracker).toBe(runtime.behavioralPatternTracker);
    expect(target.tools).toHaveLength(0);
    expect(target.registrations).toHaveLength(0);
    expect(target.intentionHooks).toHaveLength(1);
  });

  it('prefers explicit provider setter surfaces when available', () => {
    const setActiveConcernProvider = vi.fn();
    const setPendingFollowUpProvider = vi.fn();
    const setBehavioralPatternProvider = vi.fn();
    const target = {
      activeConcernProvider: null,
      pendingFollowUpProvider: null,
      behavioralPatternProvider: null,
      setActiveConcernProvider,
      setPendingFollowUpProvider,
      setBehavioralPatternProvider,
      registerTool: vi.fn(),
    } satisfies IntentionRuntimeTarget;
    const { runtime, providers } = createRuntime();

    wireIntentionRuntimeStores(target, runtime, providers);

    expect(setActiveConcernProvider).toHaveBeenCalledWith(providers.concernProvider);
    expect(setPendingFollowUpProvider).toHaveBeenCalledWith(providers.pendingFollowUpProvider);
    expect(setBehavioralPatternProvider).toHaveBeenCalledWith(providers.behavioralPatternProvider);
    expect(target.activeConcernProvider).toBeNull();
    expect(target.pendingFollowUpProvider).toBeNull();
    expect(target.behavioralPatternProvider).toBeNull();
  });

  it('records response strategies through the registered post-turn hook', async () => {
    const target = new FakeTarget();
    const { runtime, providers, behavioralPatternTracker } = createRuntime();

    wireIntentionRuntimeStores(target, runtime, providers);
    await target.intentionHooks[0]!({
      message: {
        id: 'msg-turn-1',
        channelId: 'api:test',
      },
      response: {
        channelId: 'api:test',
        content: 'That makes sense, and your reaction is valid.',
      },
      turnMessages: [],
      turnId: 'turn-1',
      completedAt: Date.parse('2026-03-06T12:00:00.000Z'),
      canonicalContactKey: 'contact-a',
    } as IntentionPostTurnContext);

    expect(behavioralPatternTracker.recordResponseStrategy).toHaveBeenCalledWith({
      contactId: 'contact-a',
      sourceMessageId: 'msg-turn-1',
      responseContent: 'That makes sense, and your reaction is valid.',
      createdAt: '2026-03-06T12:00:00.000Z',
    });
  });

  it('hands the durable boundary to the response-strategy sink after hook validation', async () => {
    const target = new FakeTarget();
    const { runtime, providers, behavioralPatternTracker } = createRuntime();
    const crossBoundary = vi.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Callback API intentionally receives this Promise-returning lifecycle handler.
    behavioralPatternTracker.recordResponseStrategy.mockImplementationOnce(async (input, options) => {
      expect(crossBoundary).not.toHaveBeenCalled();
      await options?.crossEffectBoundary?.();
      return {
        id: 'sample-1',
        contactId: input.contactId,
        sourceMessageId: input.sourceMessageId,
        strategy: 'direct',
        responseExcerpt: input.responseContent,
        createdAt: input.createdAt ?? new Date('2026-01-01T00:00:00.000Z').toISOString(),
      };
    });

    wireIntentionRuntimeStores(target, runtime, providers);
    await target.intentionHooks[0]!({
      message: {
        id: 'msg-turn-boundary',
        channelId: 'api:test',
      },
      response: {
        channelId: 'api:test',
        content: 'The durable sink owns the crossing point.',
      },
      turnMessages: [],
      turnId: 'turn-boundary',
      completedAt: Date.parse('2026-03-06T12:00:00.000Z'),
      canonicalContactKey: 'contact-a',
    } as IntentionPostTurnContext, {
      assertOwned: vi.fn(async () => undefined),
      crossBoundary,
    } satisfies IntentionPostTurnEffects);

    expect(crossBoundary).toHaveBeenCalledTimes(1);
  });

  it('does not cross the durable boundary when response-strategy validation rejects', async () => {
    const target = new FakeTarget();
    const { runtime, providers, behavioralPatternTracker } = createRuntime();
    const crossBoundary = vi.fn(async () => undefined);

    wireIntentionRuntimeStores(target, runtime, providers);
    await expect(target.intentionHooks[0]!({
      message: {
        id: '   ',
        channelId: 'api:test',
      },
      response: {
        channelId: 'api:test',
        content: 'This must not reach the sink.',
      },
      turnMessages: [],
      turnId: 'turn-invalid',
      completedAt: Date.parse('2026-03-06T12:00:00.000Z'),
      canonicalContactKey: 'contact-a',
    } as IntentionPostTurnContext, {
      assertOwned: vi.fn(async () => undefined),
      crossBoundary,
    } satisfies IntentionPostTurnEffects)).rejects.toThrow(
      'Behavioral pattern turn recording requires sourceMessageId',
    );

    expect(behavioralPatternTracker.recordResponseStrategy).not.toHaveBeenCalled();
    expect(crossBoundary).not.toHaveBeenCalled();
  });
});

describe('intention runtime port hooks', () => {
  it('maps concern snapshots and persists concern decisions through the active port', async () => {
    const active = makeConcern();
    const resolved = makeConcern({
      id: 'concern-resolved',
      status: 'resolved',
      resolvedAt: '2026-03-06T11:30:00.000Z',
      resolutionOutcome: 'Handled already',
    });
    const concernStore = makeConcernStore({
      getActiveConcerns: vi.fn(async () => [active]),
      listRecentlyResolvedConcerns: vi.fn(async () => [resolved]),
    });
    const hooks = createIntentionAppraisalHooks(concernStore);

    await expect(hooks.getActiveConcerns({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
    })).resolves.toEqual([expect.objectContaining({
      id: active.id,
      title: active.text,
      status: 'active',
    })]);
    await expect(hooks.getRecentResolvedConcerns({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
    })).resolves.toEqual([expect.objectContaining({
      id: resolved.id,
      status: 'resolved',
      summary: 'Handled already',
    })]);

    await hooks.onIntentionConcernDecision({
      decision: {
        type: 'concern',
        priority: 'high',
        reason: 'User asked for a follow-up reminder.',
        timing: 'soon',
        concern: {
          title: 'Follow up on medication',
          summary: 'Ping tomorrow morning',
          priority: 'high',
        },
      },
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-1',
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(concernStore.create).toHaveBeenCalledWith({
      text: 'Follow up on medication: Ping tomorrow morning',
      priority: 'high',
      source: 'appraisal',
      status: 'active',
      contactId: 'contact-a',
      evidenceRefs: [{ kind: 'message', ref: 'msg-1' }],
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    await expect(hooks.onIntentionConcernDecision({
      decision: {
        type: 'concern',
        priority: 'medium',
        reason: 'invalid',
        timing: 'soon',
        concern: {},
      },
      channelId: 'api:test',
      sourceMessageId: 'msg-invalid',
    })).rejects.toThrow('Concern decision must include title or summary');
  });

  it('maps follow-up decisions and activation through the active port', async () => {
    const pendingFollowUpStore = makePendingFollowUpStore();
    const hooks = createIntentionAppraisalHooks(makeConcernStore(), pendingFollowUpStore);

    const followUpId = await hooks.onIntentionFollowUpDecision({
      decision: {
        type: 'followUp',
        priority: 'medium',
        reason: 'Keep this reminder out of live context until it is due.',
        timing: 'scheduled',
        followUp: {
          content: 'Check in tomorrow about medication.',
          channelType: 'api',
          contextSummary: 'Medication follow-up context.',
          wakeConditions: ['next_user_turn'],
        },
      },
      channelId: 'api:test',
      channelType: 'api',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-follow-up',
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    expect(followUpId).toBe('created-follow-up');
    expect(pendingFollowUpStore.enqueue).toHaveBeenCalledWith({
      content: 'Check in tomorrow about medication.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-follow-up',
      contextSummary: 'Medication follow-up context.',
      wakeConditions: ['next_user_turn'],
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    await expect(hooks.onIntentionFollowUpActivated({
      pendingFollowUpId: followUpId!,
      activationReason: 'post_turn_action',
    })).resolves.toBe(true);
    expect(pendingFollowUpStore.dequeue).toHaveBeenCalledWith('created-follow-up', {
      activationReason: 'post_turn_action',
    });
  });

  it('bounds over-long follow-up content to the enqueue contract (psfn-framework-ktvo)', async () => {
    const pendingFollowUpStore = makePendingFollowUpStore();
    const hooks = createIntentionAppraisalHooks(makeConcernStore(), pendingFollowUpStore);

    const overLongContent = 'x'.repeat(PENDING_FOLLOW_UP_MAX_TEXT_CHARS + 250);
    const followUpId = await hooks.onIntentionFollowUpDecision({
      decision: {
        type: 'followUp',
        priority: 'medium',
        reason: 'Long model-authored follow-up must not throw at the enqueue guard.',
        timing: 'scheduled',
        followUp: {
          content: overLongContent,
          channelType: 'api',
        },
      },
      channelId: 'api:test',
      channelType: 'api',
      sourceMessageId: 'msg-follow-up-long',
    });

    expect(followUpId).toBe('created-follow-up');
    expect(pendingFollowUpStore.enqueue).toHaveBeenCalledTimes(1);
    const enqueuedContent = vi.mocked(pendingFollowUpStore.enqueue).mock.calls[0]![0].content;
    // Bounded to the consumer contract, with a clear truncation marker, so the
    // fail-closed enqueue guard (normalizeRequiredText → MAX_TEXT_CHARS) accepts it.
    expect(enqueuedContent.length).toBe(PENDING_FOLLOW_UP_MAX_TEXT_CHARS);
    expect(enqueuedContent.endsWith('...')).toBe(true);
  });

  it('resurfaces only eligible follow-ups for the active channel', async () => {
    const now = Date.parse('2026-03-26T12:00:00.000Z');
    const pendingFollowUpStore = makePendingFollowUpStore({
      list: vi.fn(async () => [
        makeFollowUp({ id: 'due', dueAt: new Date(now - 1_000).toISOString() }),
        makeFollowUp({ id: 'future', dueAt: new Date(now + 60_000).toISOString() }),
        makeFollowUp({ id: 'other-channel', channelId: 'api:other', dueAt: new Date(now - 1_000).toISOString() }),
        makeFollowUp({ id: 'current-message', sourceMessageId: 'msg-current', dueAt: new Date(now - 1_000).toISOString() }),
      ]),
    });
    const hooks = createIntentionAppraisalHooks(makeConcernStore(), pendingFollowUpStore);

    const surfaced = await hooks.getPendingFollowUpsForResurfacing({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-current',
      isBackgroundTurn: false,
      now,
      currentMoodValence: 0,
    });

    expect(surfaced.map(followUp => followUp.id)).toEqual(['due']);
    expect(pendingFollowUpStore.list).toHaveBeenCalledWith({
      contactId: 'contact-a',
      includeActivated: false,
      includeExpired: false,
      asOf: '2026-03-26T12:00:00.000Z',
    });
  });

  it('maps emotion snapshots into behavioral outcome updates', async () => {
    const tryRecordOutcomeForLatestPending = vi.fn(async () => null);
    const tracker = {
      setPromotionHook: vi.fn(),
      recordResponseStrategy: vi.fn(),
      recordOutcomeForSample: vi.fn(),
      tryRecordOutcomeForLatestPending,
      listSamples: vi.fn(),
      listStrategySummaries: vi.fn(),
    } as unknown as BehavioralPatternStorePort;
    const hooks = createIntentionBehavioralPatternHooks(tracker);

    await hooks.onBehavioralPatternOutcome({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-outcome',
      emotionSnapshot: {
        vad: { valence: 0.6, arousal: 0.2, dominance: 0.1 },
        mood: { valence: 0.4, arousal: 0.1, dominance: 0.1 },
        discrete: { relief: 0.5 },
        confidence: 0.8,
      },
      observedAtMs: Date.parse('2026-03-06T12:01:00.000Z'),
    });

    expect(tryRecordOutcomeForLatestPending).toHaveBeenCalledTimes(1);
    expect(tryRecordOutcomeForLatestPending.mock.calls[0]?.[0]).toMatchObject({
      contactId: 'contact-a',
      observedAt: '2026-03-06T12:01:00.000Z',
      outcomeSourceMessageId: 'msg-outcome',
    });
    expect(tryRecordOutcomeForLatestPending.mock.calls[0]?.[0]?.outcomeScore).toBeCloseTo(0.53, 5);
  });
});
