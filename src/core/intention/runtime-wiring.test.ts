import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '../../boundary/pi-agent/index.js';
import {
  wireIntentionRuntimeStores,
  type IntentionRuntimeProviders,
  type IntentionRuntimeTarget,
  type IntentionRuntimeWiring,
} from './runtime-wiring.js';
import type { BehavioralPatternStorePort } from './behavioral-pattern-store-port.js';
import type { ConcernStorePort } from './concern-store-port.js';
import type { PendingFollowUpStorePort } from './pending-follow-up-store-port.js';

class FakeTarget implements IntentionRuntimeTarget {
  activeConcernProvider: IntentionRuntimeTarget['activeConcernProvider'] = null;
  pendingFollowUpProvider: IntentionRuntimeTarget['pendingFollowUpProvider'] = null;
  behavioralPatternProvider: IntentionRuntimeTarget['behavioralPatternProvider'] = null;
  tools: AgentTool<any>[] = [];
  registrations: Array<{ name: string; category: 'core' | 'extended' }> = [];
  intentionHooks: Array<Parameters<NonNullable<IntentionRuntimeTarget['registerIntentionPostTurnHook']>>[0]> = [];

  registerTool(tool: AgentTool<any>, category: 'core' | 'extended' = 'core'): void {
    this.tools.push(tool);
    this.registrations.push({ name: tool.name, category });
  }

  registerIntentionPostTurnHook(
    hook: Parameters<NonNullable<IntentionRuntimeTarget['registerIntentionPostTurnHook']>>[0],
  ): () => void {
    this.intentionHooks.push(hook);
    return () => {};
  }
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
    } as Parameters<NonNullable<IntentionRuntimeTarget['registerIntentionPostTurnHook']>>[0] extends (
      context: infer TContext
    ) => unknown ? TContext : never);

    expect(behavioralPatternTracker.recordResponseStrategy).toHaveBeenCalledWith({
      contactId: 'contact-a',
      sourceMessageId: 'msg-turn-1',
      responseContent: 'That makes sense, and your reaction is valid.',
      createdAt: '2026-03-06T12:00:00.000Z',
    });
  });
});
