import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { wirePostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import { EventBus } from '../../shared/event-bus.js';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import { wirePostTurnRuntime } from '../scheduler/post-turn-runtime.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { InternalStateComputer } from '../self-model/state.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import { createIntentionAppraisalHooks } from './runtime-wiring.js';

describe('appraised follow-up destination binding', () => {
  it.each([
    { requestedChannel: 'human:contact-a:discord:dm-a', authorized: true },
    { requestedChannel: 'dm-a', authorized: true },
    { requestedChannel: 'human:foreign:discord:dm-a', authorized: false },
    { requestedChannel: 'unknown-dm', authorized: false },
    { requestedChannel: 'dm-b', authorized: true, sourceChannel: 'dm-b' },
    { requestedChannel: 'internal:reflection:social-outreach', authorized: true, internal: true },
  ])('binds $requestedChannel before pending and deferred queue writes ($internal)', async fixture => {
    const { requestedChannel, authorized } = fixture;
    const sourceChannel = fixture.sourceChannel ?? 'internal:reflection:social-outreach';
    const channelType = fixture.internal ? 'terminal' : 'discord';
    const expectedChannel = fixture.internal ? sourceChannel : fixture.sourceChannel ?? 'dm-a';
    const directory = mkdtempSync(join(tmpdir(), 'follow-up-binding-'));
    const persistencePath = join(directory, 'queue.json');
    const now = Date.now();
    const dueAt = now + 60_000;
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1000 });
    const { ports } = createTestPostgresIntentionPorts();
    const hooks = createIntentionAppraisalHooks(ports.concernStore, ports.pendingFollowUpStore);
    const inferers: PostTurnActionInferer[] = [];
    const agentLoop = {
      handleMessage: vi.fn(), followUp: vi.fn(), waitForIdle: async () => {},
      registerPostTurnActionInferer(inferer: PostTurnActionInferer) {
        inferers.push(inferer);
        return () => {};
      },
    };
    const postTurnActions = wirePostTurnActionRuntime({ eventBus, scheduler, agentLoop, persistencePath });
    const resolveDestination = vi.fn(async ({ channelId }: { channelId: string }) => (
      ['human:contact-a:discord:dm-a', 'dm-a'].includes(channelId)
        ? { channelId: 'dm-a', channelType: 'discord', contactId: 'contact-a' } : null
    ));
    const complete = vi.fn().mockResolvedValue({
      content: JSON.stringify({ decisions: [{
        type: 'followUp', priority: 'high', timing: 'scheduled', dueAt,
        reason: 'A future hello.',
        followUp: { content: 'How is your day going?', delivery: fixture.internal ? 'internal' : 'external',
          channelId: requestedChannel, channelType },
      }] }),
      model: 'test-model', inputTokens: 1, outputTokens: 1, toolCalls: [], stopReason: 'stop',
    });
    wirePostTurnRuntime({
      scheduler, agentLoop, sender: { send: vi.fn() }, templateRuntime: fromAny({}),
      runtimeOptions: fromAny({
        eventBus, postTurnActions, llmProvider: { complete },
        resolveIntentionFollowUpDestination: resolveDestination,
        onIntentionFollowUpDecision: hooks.onIntentionFollowUpDecision,
        getActiveConcerns: () => [{ title: 'A future hello.', status: 'active', dueAt: now }],
      }),
    });
    const internalState = new InternalStateComputer().computeState({
      emotionState: {
        vad: { valence: 0, arousal: 0.2, dominance: 0 },
        mood: { valence: 0, arousal: 0.2, dominance: 0 }, discrete: { concern: 0.7 }, confidence: 0.8,
      },
      activeConcerns: [], trustLevel: 'primary',
      sessionMetrics: { userMessageText: 'Consider outreach.', responseText: 'Later.',
        toolCallCount: 0, recentTurnCount: 4, lastSeenDeltaSeconds: 60 },
    });
    try {
      await inferers[0]!(fromAny({
        message: { id: 'social-decision-source', channelId: sourceChannel,
          channelType: fixture.sourceChannel ? 'discord' : 'terminal', authorId: 'system:social-outreach', authorName: 'Test Companion',
          content: 'Consider outreach.', timestamp: new Date(now) },
        response: { content: 'Later.', metadata: { internalState } },
        completedAt: now, turnMessages: [],
        canonicalContactKey: fixture.sourceChannel ? 'contact-b' : undefined,
        capturedSessionReads: { getRecentMessages: () => [] },
      }));
      // The inferer launches the appraisal task; the adapter's async reads are
      // drained before inspecting its durable writes, without running delivery.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(complete).toHaveBeenCalledOnce();
      const pending = await ports.pendingFollowUpStore.list();
      if (!authorized) {
        expect(pending).toEqual([]);
        expect(postTurnActions.listQueued()).toEqual([]);
        return;
      }
      expect(pending).toMatchObject([{
        channelId: expectedChannel, channelType,
        ...(!fixture.internal ? { contactId: fixture.sourceChannel ? 'contact-b' : 'contact-a' } : {}),
        content: 'How is your day going?', sourceMessageId: 'social-decision-source',
        dueAt: new Date(dueAt).toISOString(),
      }]);
      const queue = JSON.parse(readFileSync(persistencePath, 'utf8'));
      expect(queue.entries).toMatchObject([{
        action: { kind: fixture.internal ? 'intention.follow_up' : 'intention.outbound_message', payload: {
          channelId: expectedChannel, channelType, pendingFollowUpId: pending[0]!.id,
          content: 'How is your day going?',
        } },
        nextRunAt: dueAt,
      }]);
      expect(agentLoop.handleMessage).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
