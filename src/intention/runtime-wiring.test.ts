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
    const setBehavioralPatternProvider = vi.fn();
    const target = {
      activeConcernProvider: null,
      behavioralPatternProvider: null,
      setActiveConcernProvider,
      setBehavioralPatternProvider,
      registerTool: vi.fn(),
    } satisfies IntentionRuntimeTarget;

    const runtime = wireIntentionRuntime(target, db);

    expect(setActiveConcernProvider).toHaveBeenCalledWith(runtime.concernStore);
    expect(setBehavioralPatternProvider).toHaveBeenCalledWith(runtime.behavioralPatternTracker);
    expect(target.activeConcernProvider).toBeNull();
    expect(target.behavioralPatternProvider).toBeNull();
  });

  it('builds appraisal hooks that expose active concerns and persist concern decisions', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(runtime.concernStore);

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
  });

  it('fails closed when concern decision payload omits title and summary', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const runtime = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(runtime.concernStore);

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
    expect(runtimeSource).toContain('onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision');
    expect(runtimeSource).toContain('onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome');
  });

  it('agent-main.ts uses shared intention runtime wiring', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(source).toContain('wireIntentionRuntime(');
    expect(source).toContain('createIntentionAppraisalHooks(');
    expect(source).toContain('createIntentionBehavioralPatternHooks(');
    expect(source).toContain('setPromotionHook(');
    expect(source).toContain('getActiveConcerns: intentionAppraisalHooks.getActiveConcerns');
    expect(source).toContain('onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision');
    expect(source).toContain('onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome');
  });
});
