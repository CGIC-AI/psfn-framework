import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  createIntentionAppraisalHooks,
  createIntentionBehavioralPatternHooks,
  wireIntentionRuntime,
  type IntentionRuntimeTarget,
} from './runtime-wiring.js';

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

describe('wireIntentionRuntime', () => {
  it('injects concern + behavioral stores without registering separate concern tools', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    const runtime = wireIntentionRuntime(target, db);

    expect(target.activeConcernProvider).not.toBeNull();
    expect(target.pendingFollowUpProvider).not.toBeNull();
    expect(target.behavioralPatternProvider).not.toBeNull();
    expect(runtime.concernStore).not.toBe(target.activeConcernProvider);
    expect(runtime.pendingFollowUpStore).not.toBe(target.pendingFollowUpProvider);
    expect(runtime.behavioralPatternTracker).not.toBe(target.behavioralPatternProvider);
    expect(target.tools).toHaveLength(0);
    expect(target.registrations).toHaveLength(0);
    expect(target.intentionHooks).toHaveLength(1);
  });

  it('prefers explicit provider setter surfaces when available', () => {
    const db = new Database(':memory:');
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

    const runtime = wireIntentionRuntime(target, db);

    const [activeProvider] = setActiveConcernProvider.mock.calls[0] ?? [];
    const [pendingProvider] = setPendingFollowUpProvider.mock.calls[0] ?? [];
    const [behavioralProvider] = setBehavioralPatternProvider.mock.calls[0] ?? [];
    expect(activeProvider).toBeTruthy();
    expect(pendingProvider).toBeTruthy();
    expect(behavioralProvider).toBeTruthy();
    expect(activeProvider).not.toBe(runtime.concernStore);
    expect(pendingProvider).not.toBe(runtime.pendingFollowUpStore);
    expect(behavioralProvider).not.toBe(runtime.behavioralPatternTracker);
    expect(target.activeConcernProvider).toBeNull();
    expect(target.pendingFollowUpProvider).toBeNull();
    expect(target.behavioralPatternProvider).toBeNull();
  });

  it('builds appraisal hooks that expose active concerns and persist concern decisions', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(runtime.concernStore, runtime.pendingFollowUpStore);

    await runtime.concernStore.create({
      text: 'Check hydration reminder',
      contactId: 'contact-a',
      source: 'agent',
    });

    const active = await hooks.getActiveConcerns({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
    });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      title: 'Check hydration reminder',
      status: 'active',
      priority: 'medium',
    });
    expect(typeof active[0]?.dueAt).toBe('number');

    const resolved = await runtime.concernStore.create({
      text: 'Recently resolved cleanup',
      contactId: 'contact-a',
      source: 'heartbeat',
    });
    await runtime.concernStore.resolveConcern(resolved.id, {
      outcome: 'Handled already',
      resolvedAt: new Date().toISOString(),
    });
    const recentResolved = await hooks.getRecentResolvedConcerns({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
    });
    expect(recentResolved[0]).toMatchObject({
      title: 'Recently resolved cleanup',
      status: 'resolved',
      summary: 'Handled already',
    });
    expect(typeof recentResolved[0]?.resolvedAt).toBe('number');

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
          dueAt: Date.now() + 30_000,
        },
      },
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-1',
    });

    const concerns = await runtime.concernStore.list({
      contactId: 'contact-a',
      includeExpired: false,
      includeResolved: false,
      limit: 10,
    });
    expect(concerns).toHaveLength(2);
    const appraisalConcern = concerns.find(concern => concern.source === 'appraisal');
    expect(appraisalConcern).toBeDefined();
    expect(appraisalConcern).toMatchObject({
      priority: 'high',
      contactId: 'contact-a',
      text: 'Follow up on medication: Ping tomorrow morning',
    });

    const pendingFollowUpId = await hooks.onIntentionFollowUpDecision({
      decision: {
        type: 'followUp',
        priority: 'medium',
        reason: 'Keep this reminder out of the live context until it is due.',
        timing: 'scheduled',
        dueAt: Date.now() + 60_000,
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
      sourceMessageId: 'msg-3',
    });
    expect(pendingFollowUpId).toBeTruthy();

    const pending = await runtime.pendingFollowUpStore.list({ contactId: 'contact-a' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: pendingFollowUpId,
      content: 'Check in tomorrow about medication.',
      priority: 'medium',
      timing: 'scheduled',
      contactId: 'contact-a',
      sourceMessageId: 'msg-3',
      contextSummary: 'Medication follow-up context.',
      wakeConditions: ['next_user_turn'],
    });

    await hooks.onIntentionFollowUpActivated({
      pendingFollowUpId: pendingFollowUpId!,
      activationReason: 'post_turn_action',
    });
    const activated = await runtime.pendingFollowUpStore.peek(pendingFollowUpId!);
    expect(activated?.activatedAt).toBeTruthy();
    expect(activated?.activationReason).toBe('post_turn_action');
  });

  it('includes recently resolved concerns in appraisal snapshots and suppresses near-duplicate recreation', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(runtime.concernStore);

    const resolved = await runtime.concernStore.create({
      text: 'Clean up the profile synthesis reminder',
      contactId: 'contact-a',
      source: 'heartbeat',
    });
    await runtime.concernStore.resolveConcern(resolved.id, {
      outcome: 'Fixed during this session',
      resolvedAt: new Date(Date.now() - (10 * 60 * 1000)).toISOString(),
    });

    const snapshots = await hooks.getRecentResolvedConcerns({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
    });
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: resolved.id,
        title: 'Clean up the profile synthesis reminder',
        status: 'resolved',
        summary: 'Fixed during this session',
      }),
    ]));

    await hooks.onIntentionConcernDecision({
      decision: {
        type: 'concern',
        priority: 'medium',
        reason: 'same issue recurred',
        timing: 'soon',
        concern: {
          title: 'Clean up the profile synthesis reminder',
          summary: 'same issue recurred',
        },
      },
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-suppress-1',
    });

    const concerns = await runtime.concernStore.list({
      contactId: 'contact-a',
      includeResolved: true,
      includeExpired: true,
      limit: 10,
    });
    expect(concerns).toHaveLength(1);
    expect(concerns[0]?.resolvedAt).toBeDefined();
  });

  it('allows concern recreation when the prior resolution is outside the suppression window', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(runtime.concernStore);

    const resolved = await runtime.concernStore.create({
      text: 'Check back on the deployment cleanup',
      contactId: 'contact-a',
      source: 'heartbeat',
    });
    await runtime.concernStore.resolveConcern(resolved.id, {
      outcome: 'Handled long ago',
      resolvedAt: '2026-01-01T00:00:00.000Z',
    });

    await hooks.onIntentionConcernDecision({
      decision: {
        type: 'concern',
        priority: 'medium',
        reason: 'issue came back',
        timing: 'soon',
        concern: {
          title: 'Check back on the deployment cleanup',
          summary: 'issue came back',
        },
      },
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-allow-1',
    });

    const concerns = await runtime.concernStore.list({
      contactId: 'contact-a',
      includeResolved: true,
      includeExpired: true,
      limit: 10,
    });
    expect(concerns).toHaveLength(2);
    expect(concerns.some(concern => concern.source === 'appraisal' && !concern.resolvedAt)).toBe(true);
  });

  it('fails closed when concern decision payload omits title and summary', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(runtime.concernStore, runtime.pendingFollowUpStore);

    await expect(hooks.onIntentionConcernDecision({
      decision: {
        type: 'concern',
        priority: 'medium',
        reason: 'invalid',
        timing: 'soon',
        concern: {},
      } as any,
      channelId: 'api:test',
      sourceMessageId: 'msg-2',
    })).rejects.toThrow('Concern decision must include title or summary');
  });

  it('surfaces eligible pending follow-ups through appraisal hooks', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(runtime.concernStore, runtime.pendingFollowUpStore);
    const now = Date.parse('2026-03-26T12:00:00.000Z');
    const createdAt = new Date(now - 60_000).toISOString();

    const due = await runtime.pendingFollowUpStore.enqueue({
      content: 'Due follow-up',
      priority: 'medium',
      timing: 'scheduled',
      createdAt,
      dueAt: new Date(now - 1_000).toISOString(),
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-due',
    });
    const wakeOnUserTurnId = await hooks.onIntentionFollowUpDecision({
      decision: {
        type: 'followUp',
        priority: 'low',
        reason: 'Wake once the user returns.',
        timing: 'soon',
        followUp: {
          content: 'Wake on user turn',
          channelType: 'discord',
          wakeConditions: ['next_user_turn'],
        },
      },
      channelId: 'discord:primary',
      channelType: 'discord',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-wake-user',
    });
    expect(wakeOnUserTurnId).toBeTruthy();
    await runtime.pendingFollowUpStore.enqueue({
      content: 'Future follow-up',
      priority: 'medium',
      timing: 'scheduled',
      createdAt,
      dueAt: new Date(now + 60_000).toISOString(),
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-future',
    });
    await runtime.pendingFollowUpStore.enqueue({
      content: 'Wrong channel',
      priority: 'medium',
      timing: 'scheduled',
      createdAt,
      dueAt: new Date(now - 1_000).toISOString(),
      channelId: 'discord:other',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-other-channel',
    });
    await runtime.pendingFollowUpStore.enqueue({
      content: 'Wrong contact',
      priority: 'medium',
      timing: 'scheduled',
      createdAt,
      dueAt: new Date(now - 1_000).toISOString(),
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-b',
      sourceMessageId: 'msg-other-contact',
    });

    const surfaced = await hooks.getPendingFollowUpsForResurfacing({
      channelId: 'discord:primary',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-current',
      isBackgroundTurn: false,
      now,
      currentMoodValence: 0,
    });

    expect(surfaced.map(followUp => followUp.id)).toEqual([
      due.id,
      wakeOnUserTurnId,
    ]);
  });

  it('suppresses concern creation when a similar concern was just resolved', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(runtime.concernStore);

    const resolved = await runtime.concernStore.create({
      text: 'Clean up the profile synthesis follow-up',
      contactId: 'contact-a',
      source: 'heartbeat',
    });
    await runtime.concernStore.resolveConcern(resolved.id, {
      outcome: 'Handled during the current run',
      resolvedAt: new Date().toISOString(),
    });

    await hooks.onIntentionConcernDecision({
      decision: {
        type: 'concern',
        priority: 'medium',
        reason: 'cleanup still seems relevant',
        timing: 'soon',
        concern: {
          title: 'Clean up the profile synthesis follow-up',
        },
      },
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-3',
    });

    const concerns = await runtime.concernStore.list({
      contactId: 'contact-a',
      includeResolved: true,
      includeExpired: true,
      limit: 10,
    });
    expect(concerns).toHaveLength(1);
    expect(concerns[0]?.resolvedAt).toBeDefined();
  });

  it('records response strategies via registered intention post-turn hook', async () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);

    expect(target.intentionHooks).toHaveLength(1);
    await target.intentionHooks[0]!({
      message: {
        id: 'msg-turn-1',
        channelId: 'api:test',
      },
      response: {
        channelId: 'api:test',
        content: 'That makes sense, and your reaction is completely valid.',
      },
      turnMessages: [],
      turnId: 'turn-1',
      completedAt: Date.parse('2026-03-06T12:00:00.000Z'),
      canonicalContactKey: 'contact-a',
    } as any);

    const samples = await runtime.behavioralPatternTracker.listSamples({
      contactId: 'contact-a',
      includePending: true,
      limit: 5,
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      sourceMessageId: 'msg-turn-1',
      strategy: 'validation',
    });
  });

  it('maps emotion snapshots to outcome updates through behavioral hooks', async () => {
    const db = new Database(':memory:');
    const runtime = wireIntentionRuntime(new FakeTarget(), db);
    const behavioralHooks = createIntentionBehavioralPatternHooks(runtime.behavioralPatternTracker);
    await runtime.behavioralPatternTracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-turn-1',
      responseContent: 'I hear you, and I am here with you.',
      strategy: 'empathy',
    });

    await behavioralHooks.onBehavioralPatternOutcome({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-turn-2',
      emotionSnapshot: {
        vad: { valence: 0.6, arousal: 0.2, dominance: 0.1 },
        mood: { valence: 0.4, arousal: 0.1, dominance: 0.1 },
        discrete: { relief: 0.5 },
        confidence: 0.8,
      },
      observedAtMs: Date.parse('2026-03-06T12:01:00.000Z'),
    });

    const samples = await runtime.behavioralPatternTracker.listSamples({
      contactId: 'contact-a',
      includePending: true,
      limit: 5,
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]?.outcomeScore).toBeCloseTo(0.53, 5);
    expect(samples[0]?.outcomeSourceMessageId).toBe('msg-turn-2');
  });
});
