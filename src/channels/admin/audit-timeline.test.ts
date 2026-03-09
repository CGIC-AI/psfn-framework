import { describe, expect, it, vi } from 'vitest';
import { AdminAuditTimelineStore, ADMIN_AUDIT_ACTION_TYPES } from './audit-timeline.js';
import type { EventBus } from '../../event-bus.js';
import { DEFAULT_COMPANION_NAME } from '../../identity/companion-naming.js';
import type { AdminAuditActor } from './types.js';
import { registerAuditTimelineSources, type AuditTimelineAppender } from './services/audit-event-collector.js';

describe('AdminAuditTimelineStore', () => {
  it('parses filters with sane defaults', () => {
    const store = new AdminAuditTimelineStore();
    const filters = store.parseFilters(new URLSearchParams());
    expect(filters).toEqual({
      actionType: 'all',
      decision: 'all',
      timeRange: '24h',
    });
  });

  it('falls back when unknown filters are provided', () => {
    const store = new AdminAuditTimelineStore();
    const filters = store.parseFilters(new URLSearchParams({
      actionType: 'not-a-type',
      decision: 'maybe',
      timeRange: 'forever',
    }));
    expect(filters).toEqual({
      actionType: 'all',
      decision: 'all',
      timeRange: '24h',
    });
  });

  it('filters by action type and decision', () => {
    const store = new AdminAuditTimelineStore();
    store.append({
      actionType: 'tool_invocation',
      decision: 'allowed',
      narrative: 'Allowed tool call',
    });
    store.append({
      actionType: 'memory_mutation',
      decision: 'denied',
      narrative: 'Denied memory mutation',
    });

    const filtered = store.list({
      actionType: 'memory_mutation',
      decision: 'denied',
      timeRange: 'all',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].narrative).toContain('Denied memory mutation');
  });

  it('filters by time range', () => {
    const store = new AdminAuditTimelineStore();
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_700_000_000_000);
    store.append({
      actionType: 'tool_invocation',
      decision: 'allowed',
      narrative: 'Old event',
    });

    nowSpy.mockReturnValue(1_700_000_000_000 + (2 * 60 * 60 * 1_000));
    store.append({
      actionType: 'tool_invocation',
      decision: 'allowed',
      narrative: 'Recent event',
    });

    const recentOnly = store.list({
      actionType: 'all',
      decision: 'all',
      timeRange: '1h',
    });
    expect(recentOnly).toHaveLength(1);
    expect(recentOnly[0].narrative).toContain('Recent event');

    const all = store.list({
      actionType: 'all',
      decision: 'all',
      timeRange: 'all',
    });
    expect(all).toHaveLength(2);

    nowSpy.mockRestore();
  });

  it('includes settings_change in action types', () => {
    expect(ADMIN_AUDIT_ACTION_TYPES).toContain('settings_change');
  });

  it('parses settings_change as a valid action type filter', () => {
    const store = new AdminAuditTimelineStore();
    const filters = store.parseFilters(new URLSearchParams({
      actionType: 'settings_change',
    }));
    expect(filters.actionType).toBe('settings_change');
  });

  it('filters by settings_change action type', () => {
    const store = new AdminAuditTimelineStore();
    store.append({
      actionType: 'settings_change',
      decision: 'allowed',
      narrative: 'Operator updated runtime settings.',
      actor: 'operator',
    });
    store.append({
      actionType: 'tool_invocation',
      decision: 'allowed',
      narrative: `${DEFAULT_COMPANION_NAME} completed tool "think".`,
      actor: 'companion',
    });

    const settingsOnly = store.list({
      actionType: 'settings_change',
      decision: 'all',
      timeRange: 'all',
    });
    expect(settingsOnly).toHaveLength(1);
    expect(settingsOnly[0].narrative).toContain('Operator updated');
    expect(settingsOnly[0].actor).toBe('operator');
  });

  it('preserves actor attribution on appended entries', () => {
    const store = new AdminAuditTimelineStore();

    const operatorEntry = store.append({
      actionType: 'identity_edit',
      decision: 'allowed',
      narrative: 'Operator updated identity field "name".',
      actor: 'operator',
    });
    expect(operatorEntry.actor).toBe('operator');

    const companionEntry = store.append({
      actionType: 'identity_edit',
      decision: 'allowed',
      narrative: `${DEFAULT_COMPANION_NAME} edited identity via "prompt_layer_update".`,
      actor: 'companion',
    });
    expect(companionEntry.actor).toBe('companion');

    const noActorEntry = store.append({
      actionType: 'external_action',
      decision: 'allowed',
      narrative: 'Legacy event without actor.',
    });
    expect(noActorEntry.actor).toBeUndefined();
  });

  it('identity edit from admin API records operator actor', () => {
    const store = new AdminAuditTimelineStore();
    store.append({
      actionType: 'identity_edit',
      decision: 'allowed',
      narrative: 'Operator updated identity field "name".',
      details: 'field=name version=2',
      actor: 'operator',
    });

    const entries = store.list({ actionType: 'identity_edit', decision: 'all', timeRange: 'all' });
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('operator');
    expect(entries[0].narrative).toContain('Operator');
    expect(entries[0].details).toContain('field=name');
  });

  it('settings change records operator actor', () => {
    const store = new AdminAuditTimelineStore();
    store.append({
      actionType: 'settings_change',
      decision: 'allowed',
      narrative: 'Operator updated runtime settings.',
      details: 'fields=primaryModel,extractionModel',
      actor: 'operator',
    });

    const entries = store.list({ actionType: 'settings_change', decision: 'all', timeRange: 'all' });
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('operator');
    expect(entries[0].details).toContain('primaryModel');
  });
});

describe('audit event collector actor attribution', () => {
  function createMockEventBus() {
    const handlers = new Map<string, Array<(event: unknown) => void>>();
    return {
      on(event: string, handler: (event: unknown) => void) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
      emit(event: string, payload: unknown) {
        for (const handler of handlers.get(event) ?? []) {
          handler(payload);
        }
      },
    } as unknown as EventBus;
  }

  it('tool invocations from event bus have companion actor', () => {
    const eventBus = createMockEventBus();
    const entries: Array<{
      actionType: string;
      decision: string;
      narrative: string;
      details?: Array<string | null | undefined>;
      actor?: AdminAuditActor;
    }> = [];
    const appender: AuditTimelineAppender = (actionType, decision, narrative, details, actor) => {
      entries.push({ actionType, decision, narrative, details, actor });
    };

    registerAuditTimelineSources({
      eventBus,
      activeToolInvocations: new Map(),
      appendAuditTimelineEntry: appender,
    });

    // Simulate a tool end event
    (eventBus as unknown as { emit: (e: string, p: unknown) => void }).emit('agent.tool.end', {
      toolCallId: 'call-1',
      toolName: 'think',
      channelId: 'discord:general',
      isError: false,
    });

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const toolEntry = entries.find(e => e.actionType === 'tool_invocation');
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.actor).toBe('companion');
  });

  it('identity edit tool invocations from event bus have companion actor', () => {
    const eventBus = createMockEventBus();
    const entries: Array<{
      actionType: string;
      decision: string;
      narrative: string;
      actor?: AdminAuditActor;
    }> = [];
    const appender: AuditTimelineAppender = (actionType, decision, narrative, _details, actor) => {
      entries.push({ actionType, decision, narrative, actor });
    };

    registerAuditTimelineSources({
      eventBus,
      activeToolInvocations: new Map(),
      appendAuditTimelineEntry: appender,
    });

    (eventBus as unknown as { emit: (e: string, p: unknown) => void }).emit('agent.tool.end', {
      toolCallId: 'call-2',
      toolName: 'prompt_layer_update',
      channelId: 'discord:general',
      isError: false,
    });

    const identityEntry = entries.find(e => e.actionType === 'identity_edit');
    expect(identityEntry).toBeDefined();
    expect(identityEntry!.actor).toBe('companion');
    expect(identityEntry!.narrative).toContain('Companion');
  });

  it('memory extraction events have companion actor', () => {
    const eventBus = createMockEventBus();
    const entries: Array<{
      actionType: string;
      actor?: AdminAuditActor;
    }> = [];
    const appender: AuditTimelineAppender = (actionType, _decision, _narrative, _details, actor) => {
      entries.push({ actionType, actor });
    };

    registerAuditTimelineSources({
      eventBus,
      activeToolInvocations: new Map(),
      appendAuditTimelineEntry: appender,
    });

    (eventBus as unknown as { emit: (e: string, p: unknown) => void }).emit('memory.extraction.end', {
      channelId: 'discord:general',
      writeCount: 3,
      acceptedCount: 3,
      rejectedCount: 0,
      deduplicatedCount: 0,
      supersededCount: 0,
    });

    const memEntry = entries.find(e => e.actionType === 'memory_mutation');
    expect(memEntry).toBeDefined();
    expect(memEntry!.actor).toBe('companion');
  });

  it('message.sent events have companion actor', () => {
    const eventBus = createMockEventBus();
    const entries: Array<{
      actionType: string;
      actor?: AdminAuditActor;
    }> = [];
    const appender: AuditTimelineAppender = (actionType, _decision, _narrative, _details, actor) => {
      entries.push({ actionType, actor });
    };

    registerAuditTimelineSources({
      eventBus,
      activeToolInvocations: new Map(),
      appendAuditTimelineEntry: appender,
    });

    (eventBus as unknown as { emit: (e: string, p: unknown) => void }).emit('message.sent', {
      response: {
        channelId: 'discord:general',
        content: 'Hello',
        metadata: { model: 'test', durationMs: 100 },
      },
    });

    const extEntry = entries.find(e => e.actionType === 'external_action');
    expect(extEntry).toBeDefined();
    expect(extEntry!.actor).toBe('companion');
  });
});
