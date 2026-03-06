import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  createIntentionAppraisalHooks,
  wireIntentionRuntime,
  type IntentionRuntimeTarget,
} from './runtime-wiring.js';

class FakeTarget implements IntentionRuntimeTarget {
  activeConcernProvider: IntentionRuntimeTarget['activeConcernProvider'] = null;
  tools: AgentTool<any>[] = [];

  registerTool(tool: AgentTool<any>): void {
    this.tools.push(tool);
  }
}

describe('wireIntentionRuntime', () => {
  it('injects ActiveConcernStore and registers concern tools', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    const store = wireIntentionRuntime(target, db);

    expect(target.activeConcernProvider).toBe(store);
    expect(target.tools.map(tool => tool.name).sort()).toEqual([
      'create_concern',
      'list_concerns',
      'resolve_concern',
    ]);
  });

  it('prefers setActiveConcernProvider wiring surface when available', () => {
    const db = new Database(':memory:');
    const setActiveConcernProvider = vi.fn();
    const target = {
      activeConcernProvider: null,
      setActiveConcernProvider,
      registerTool: vi.fn(),
    } satisfies IntentionRuntimeTarget;

    const store = wireIntentionRuntime(target, db);

    expect(setActiveConcernProvider).toHaveBeenCalledWith(store);
    expect(target.activeConcernProvider).toBeNull();
  });

  it('builds appraisal hooks that expose active concerns and persist concern decisions', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();
    const store = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(store);

    store.create({
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

    const concerns = store.list({
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
    const store = wireIntentionRuntime(target, db);
    const hooks = createIntentionAppraisalHooks(store);

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
});

describe('entrypoint composition', () => {
  it('runtime.ts uses shared intention runtime wiring', () => {
    const runtimeSource = readFileSync(resolve('src/runtime.ts'), 'utf-8');
    expect(runtimeSource).toContain('wireIntentionRuntime(');
    expect(runtimeSource).toContain('createIntentionAppraisalHooks(');
    expect(runtimeSource).toContain('getActiveConcerns: intentionAppraisalHooks.getActiveConcerns');
    expect(runtimeSource).toContain('onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision');
  });

  it('agent-main.ts uses shared intention runtime wiring', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(source).toContain('wireIntentionRuntime(');
    expect(source).toContain('createIntentionAppraisalHooks(');
    expect(source).toContain('getActiveConcerns: intentionAppraisalHooks.getActiveConcerns');
    expect(source).toContain('onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision');
  });
});
