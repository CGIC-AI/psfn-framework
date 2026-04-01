import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  careReminderProvider: IntentionRuntimeTarget['careReminderProvider'] = null;
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
  it('injects concern + behavioral stores and registers concern tools', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    const runtime = wireIntentionRuntime(target, db);

    expect(target.activeConcernProvider).toBe(runtime.concernStore);
    expect(target.pendingFollowUpProvider).toBe(runtime.pendingFollowUpStore);
    expect(target.careReminderProvider).toBe(runtime.careReminderStore);
    expect(target.behavioralPatternProvider).toBe(runtime.behavioralPatternTracker);
    expect(target.tools.map(tool => tool.name).sort()).toEqual([
      'create_concern',
      'list_concerns',
      'resolve_concern',
    ]);
    const createTool = target.tools.find(tool => tool.name === 'create_concern') as any;
    const listTool = target.tools.find(tool => tool.name === 'list_concerns') as any;
    const resolveTool = target.tools.find(tool => tool.name === 'resolve_concern') as any;
    expect(createTool).toBeDefined();
    expect(listTool).toBeDefined();
    expect(resolveTool).toBeDefined();
    expect(target.registrations).toEqual(expect.arrayContaining([
      { name: 'create_concern', category: 'core' },
      { name: 'list_concerns', category: 'core' },
      { name: 'resolve_concern', category: 'core' },
    ]));
    expect(target.intentionHooks).toHaveLength(1);
  });

  it('prefers explicit provider setter surfaces when available', () => {
    const db = new Database(':memory:');
    const setActiveConcernProvider = vi.fn();
    const setPendingFollowUpProvider = vi.fn();
    const setCareReminderProvider = vi.fn();
    const setBehavioralPatternProvider = vi.fn();
    const target = {
      activeConcernProvider: null,
      pendingFollowUpProvider: null,
      careReminderProvider: null,
      behavioralPatternProvider: null,
      setActiveConcernProvider,
      setPendingFollowUpProvider,
      setCareReminderProvider,
      setBehavioralPatternProvider,
      registerTool: vi.fn(),
    } satisfies IntentionRuntimeTarget;

    const runtime = wireIntentionRuntime(target, db);

    expect(setActiveConcernProvider).toHaveBeenCalledWith(runtime.concernStore);
    expect(setPendingFollowUpProvider).toHaveBeenCalledWith(runtime.pendingFollowUpStore);
    expect(setCareReminderProvider).toHaveBeenCalledWith(runtime.careReminderStore);
    expect(setBehavioralPatternProvider).toHaveBeenCalledWith(runtime.behavioralPatternTracker);
    expect(target.activeConcernProvider).toBeNull();
    expect(target.pendingFollowUpProvider).toBeNull();
    expect(target.careReminderProvider).toBeNull();
    expect(target.behavioralPatternProvider).toBeNull();
  });

  it('builds appraisal hooks that expose active concerns and persist concern decisions', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(
      runtime.concernStore,
      runtime.pendingFollowUpStore,
      runtime.careReminderStore,
    );

    runtime.concernStore.create({
      text: 'Check hydration reminder',
      contactId: 'contact-a',
      source: 'agent',
    });

    const active = hooks.getActiveConcerns({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
    });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      title: 'Check hydration reminder',
      status: 'open',
      priority: 'medium',
    });
    expect(typeof active[0]?.dueAt).toBe('number');

    const resolved = runtime.concernStore.create({
      text: 'Recently resolved cleanup',
      contactId: 'contact-a',
      source: 'heartbeat',
    });
    runtime.concernStore.resolveConcern(resolved.id, {
      outcome: 'Handled already',
      resolvedAt: new Date().toISOString(),
    });
    const recentResolved = hooks.getRecentResolvedConcerns({
      channelId: 'api:test',
      canonicalContactKey: 'contact-a',
    });
    expect(recentResolved[0]).toMatchObject({
      title: 'Recently resolved cleanup',
      status: 'resolved',
      summary: 'Handled already',
    });
    expect(typeof recentResolved[0]?.resolvedAt).toBe('number');

    hooks.onIntentionConcernDecision({
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

    const concerns = runtime.concernStore.list({
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

    const pendingFollowUpId = hooks.onIntentionFollowUpDecision({
      decision: {
        type: 'followUp',
        priority: 'medium',
        reason: 'Keep this reminder out of the live context until it is due.',
        timing: 'scheduled',
        dueAt: Date.now() + 60_000,
        followUp: {
          content: 'Check in tomorrow about medication.',
          channelType: 'api',
        },
      },
      channelId: 'api:test',
      channelType: 'api',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-3',
    });
    expect(pendingFollowUpId).toBeTruthy();

    const pending = runtime.pendingFollowUpStore.getPendingFollowUps('contact-a');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: pendingFollowUpId,
      content: 'Check in tomorrow about medication.',
      priority: 'medium',
      timing: 'scheduled',
      contactId: 'contact-a',
      sourceMessageId: 'msg-3',
    });

    hooks.onIntentionFollowUpActivated({
      pendingFollowUpId: pendingFollowUpId!,
      activationReason: 'post_turn_action',
    });
    const activated = runtime.pendingFollowUpStore.getById(pendingFollowUpId!);
    expect(activated?.activatedAt).toBeTruthy();
    expect(activated?.activationReason).toBe('post_turn_action');

    const reminderId = hooks.onIntentionReminderDecision({
      decision: {
        type: 'reminder',
        priority: 'high',
        reason: 'Store the birthday so it survives quiet periods.',
        timing: 'scheduled',
        dueAt: Date.parse('2026-04-01T09:00:00.000Z'),
        reminder: {
          kind: 'important_date',
          classification: 'birthday',
          title: 'Alex birthday',
          content: 'Remember Alex birthday and plan a warm check-in.',
          schedule: 'annual',
        },
      },
      channelId: 'api:test',
      channelType: 'api',
      canonicalContactKey: 'contact-a',
      sourceMessageId: 'msg-4',
    });
    expect(reminderId).toBeTruthy();

    const reminders = runtime.careReminderStore.getActiveCareReminders('contact-a');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      id: reminderId,
      kind: 'important_date',
      classification: 'birthday',
      schedule: 'annual',
      provenanceSource: 'companion_appraisal',
      provenanceReason: 'Store the birthday so it survives quiet periods.',
      contactId: 'contact-a',
      sourceMessageId: 'msg-4',
    });

    const triggered = hooks.onIntentionReminderTriggered({
      reminderId: reminderId!,
    });
    expect(triggered).toMatchObject({
      reminderId,
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      content: 'Remember Alex birthday and plan a warm check-in.',
    });
    const advanced = runtime.careReminderStore.getById(reminderId!);
    expect(advanced?.activationCount).toBe(1);
    expect(advanced?.dueAt).not.toBe('2026-04-01T09:00:00.000Z');
  });

  it('includes recently resolved concerns in appraisal snapshots and suppresses near-duplicate recreation', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(
      runtime.concernStore,
      runtime.pendingFollowUpStore,
      runtime.careReminderStore,
    );

    const resolved = runtime.concernStore.create({
      text: 'Clean up the profile synthesis reminder',
      contactId: 'contact-a',
      source: 'heartbeat',
    });
    runtime.concernStore.resolveConcern(resolved.id, {
      outcome: 'Fixed during this session',
      resolvedAt: new Date(Date.now() - (10 * 60 * 1000)).toISOString(),
    });

    const snapshots = hooks.getRecentResolvedConcerns({
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

    hooks.onIntentionConcernDecision({
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

    const concerns = runtime.concernStore.list({
      contactId: 'contact-a',
      includeResolved: true,
      includeExpired: true,
      limit: 10,
    });
    expect(concerns).toHaveLength(1);
    expect(concerns[0]?.resolvedAt).toBeDefined();
  });

  it('allows concern recreation when the prior resolution is outside the suppression window', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(
      runtime.concernStore,
      runtime.pendingFollowUpStore,
      runtime.careReminderStore,
    );

    const resolved = runtime.concernStore.create({
      text: 'Check back on the deployment cleanup',
      contactId: 'contact-a',
      source: 'heartbeat',
    });
    runtime.concernStore.resolveConcern(resolved.id, {
      outcome: 'Handled long ago',
      resolvedAt: '2026-01-01T00:00:00.000Z',
    });

    hooks.onIntentionConcernDecision({
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

    const concerns = runtime.concernStore.list({
      contactId: 'contact-a',
      includeResolved: true,
      includeExpired: true,
      limit: 10,
    });
    expect(concerns).toHaveLength(2);
    expect(concerns.some(concern => concern.source === 'appraisal' && !concern.resolvedAt)).toBe(true);
  });

  it('fails closed when concern decision payload omits title and summary', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(
      runtime.concernStore,
      runtime.pendingFollowUpStore,
      runtime.careReminderStore,
    );

    expect(() => hooks.onIntentionConcernDecision({
      decision: {
        type: 'concern',
        priority: 'medium',
        reason: 'invalid',
        timing: 'soon',
        concern: {},
      } as any,
      channelId: 'api:test',
      sourceMessageId: 'msg-2',
    })).toThrow('Concern decision must include title or summary');
  });

  it('suppresses concern creation when a similar concern was just resolved', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(
      runtime.concernStore,
      runtime.pendingFollowUpStore,
      runtime.careReminderStore,
    );

    const resolved = runtime.concernStore.create({
      text: 'Clean up the profile synthesis follow-up',
      contactId: 'contact-a',
      source: 'heartbeat',
    });
    runtime.concernStore.resolveConcern(resolved.id, {
      outcome: 'Handled during the current run',
      resolvedAt: new Date().toISOString(),
    });

    hooks.onIntentionConcernDecision({
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

    const concerns = runtime.concernStore.list({
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

    const samples = runtime.behavioralPatternTracker.listSamples({
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
    runtime.behavioralPatternTracker.recordResponseStrategy({
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

    const samples = runtime.behavioralPatternTracker.listSamples({
      contactId: 'contact-a',
      includePending: true,
      limit: 5,
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]?.outcomeScore).toBeCloseTo(0.53, 5);
    expect(samples[0]?.outcomeSourceMessageId).toBe('msg-turn-2');
  });
});

describe('entrypoint composition', () => {
  it('runtime.ts uses shared intention runtime wiring', () => {
    const runtimeSource = readFileSync(resolve('src/runtime.ts'), 'utf-8');
    expect(runtimeSource).toContain('wireIntentionRuntime(');
    expect(runtimeSource).toContain('createIntentionAppraisalHooks(');
    expect(runtimeSource).toContain('createIntentionBehavioralPatternHooks(');
    expect(runtimeSource).toContain('setPromotionHook(');
    expect(runtimeSource).toContain('getActiveConcerns: intentionAppraisalHooks.getActiveConcerns');
    expect(runtimeSource).toContain('getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns');
    expect(runtimeSource).toContain('onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision');
    expect(runtimeSource).toContain('onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision');
    expect(runtimeSource).toContain('onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated');
    expect(runtimeSource).toContain('onIntentionReminderDecision: intentionAppraisalHooks.onIntentionReminderDecision');
    expect(runtimeSource).toContain('onIntentionReminderTriggered: intentionAppraisalHooks.onIntentionReminderTriggered');
    expect(runtimeSource).toContain('onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome');
  });

  it('agent-main.ts uses shared intention runtime wiring', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(source).toContain('wireIntentionRuntime(');
    expect(source).toContain('createIntentionAppraisalHooks(');
    expect(source).toContain('createIntentionBehavioralPatternHooks(');
    expect(source).toContain('setPromotionHook(');
    expect(source).toContain('getActiveConcerns: intentionAppraisalHooks.getActiveConcerns');
    expect(source).toContain('getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns');
    expect(source).toContain('onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision');
    expect(source).toContain('onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision');
    expect(source).toContain('onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated');
    expect(source).toContain('onIntentionReminderDecision: intentionAppraisalHooks.onIntentionReminderDecision');
    expect(source).toContain('onIntentionReminderTriggered: intentionAppraisalHooks.onIntentionReminderTriggered');
    expect(source).toContain('onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome');
  });
});
