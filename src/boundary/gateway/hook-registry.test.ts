import { describe, expect, it } from 'vitest';
import { EventBus, type EventMap } from '../../shared/event-bus.js';
import {
  HOOK_SUBSCRIBABLE_EVENTS,
  HookMatcher,
  HookRegistry,
  isHookSubscribableEvent,
  type HookLifecycleEventEnvelope,
  type HookRegistration,
  type SyncDecisionHookRegistration,
} from './hook-registry.js';

function toolEndPayload(overrides?: Partial<EventMap['agent.tool.end']>): EventMap['agent.tool.end'] {
  return {
    channelId: 'channel-1',
    toolCallId: 'call-1',
    toolName: 'web.fetch',
    outcome: 'success',
    isError: false,
    ...overrides,
  };
}

function collectEnvelopes(): {
  envelopes: HookLifecycleEventEnvelope[];
  handler: (envelope: HookLifecycleEventEnvelope) => void;
  waitForCount: (count: number) => Promise<void>;
} {
  const envelopes: HookLifecycleEventEnvelope[] = [];
  let notify: (() => void) | null = null;
  return {
    envelopes,
    handler: (envelope) => {
      envelopes.push(envelope);
      notify?.();
    },
    waitForCount: async (count: number) => {
      const deadline = Date.now() + 2_000;
      while (envelopes.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${count} hook envelopes (got ${envelopes.length})`);
        }
        await new Promise<void>((resolveWait) => {
          notify = resolveWait;
          setTimeout(resolveWait, 10);
        });
      }
    },
  };
}

describe('HookMatcher', () => {
  it('matches exact subjects', () => {
    const matcher = new HookMatcher(['agent.tool.end']);
    expect(matcher.matches('agent.tool.end')).toBe(true);
    expect(matcher.matches('agent.tool.start')).toBe(false);
  });

  it('matches trailing wildcard segments without over-matching sibling prefixes', () => {
    const matcher = new HookMatcher(['agent.tool.*']);
    expect(matcher.matches('agent.tool.start')).toBe(true);
    expect(matcher.matches('agent.tool.end')).toBe(true);
    expect(matcher.matches('agent.toolcall.start')).toBe(false);
    expect(matcher.matches('agent.tool')).toBe(false);
  });

  it('rejects bare and embedded wildcards fail-closed', () => {
    expect(HookMatcher.validatePatterns(['*'])).not.toHaveLength(0);
    expect(HookMatcher.validatePatterns(['agent.*.end'])).not.toHaveLength(0);
    expect(HookMatcher.validatePatterns(['agent.tool*'])).not.toHaveLength(0);
    expect(HookMatcher.validatePatterns([])).not.toHaveLength(0);
    expect(HookMatcher.validatePatterns([' agent.tool.end'])).not.toHaveLength(0);
    expect(() => new HookMatcher(['*'])).toThrow(/unsupported wildcard/);
  });

  it('expands patterns against a candidate set and reports unmatched patterns', () => {
    const matcher = new HookMatcher(['agent.retry.*', 'session.compacted', 'no.such.event']);
    const { matched, unmatchedPatterns } = matcher.expand(HOOK_SUBSCRIBABLE_EVENTS);
    expect(matched).toEqual(
      expect.arrayContaining(['agent.retry.start', 'agent.retry.end', 'session.compacted']),
    );
    expect(matched).toHaveLength(3);
    expect(unmatchedPatterns).toEqual(['no.such.event']);
  });
});

describe('HookRegistry registration', () => {
  it('rejects non-allowlisted lifecycle events', () => {
    const registry = new HookRegistry();
    expect(() => registry.register({
      mode: 'async_lifecycle',
      name: 'bad-hook',
      sourcePath: 'test',
      // memory.retrieval is a real EventMap event but deliberately not
      // operator-subscribable.
      events: ['memory.retrieval' as never],
      handler: () => undefined,
    })).toThrow(/non-subscribable/);
    expect(registry.list()).toHaveLength(0);
  });

  it('rejects empty event lists and duplicate names', () => {
    const registry = new HookRegistry();
    expect(() => registry.register({
      mode: 'async_lifecycle',
      name: 'no-events',
      sourcePath: 'test',
      events: [],
      handler: () => undefined,
    })).toThrow(/no lifecycle events/);

    registry.register({
      mode: 'async_lifecycle',
      name: 'dup',
      sourcePath: 'test',
      events: ['agent.tool.end'],
      handler: () => undefined,
    });
    expect(() => registry.register({
      mode: 'async_lifecycle',
      name: 'dup',
      sourcePath: 'test',
      events: ['agent.tool.start'],
      handler: () => undefined,
    })).toThrow(/already registered/);
  });

  it('accepts and lists a sync_decision registration without executing it (7ym.3 forward-compat)', async () => {
    const registry = new HookRegistry();
    let syncInvoked = 0;
    // Type-level check: the registration model admits the second invocation
    // mode through the same HookRegistration union.
    const syncRegistration: SyncDecisionHookRegistration = {
      mode: 'sync_decision',
      name: 'future-pre-tool',
      sourcePath: 'test',
      matcher: new HookMatcher(['web.*']),
      // Async handler: the registry rejects bare-synchronous decision handlers
      // (bead 00z0) because they cannot yield to the evaluation timeout.
      handler: async () => {
        syncInvoked += 1;
        return { decision: 'allow' };
      },
    };
    const asUnion: HookRegistration = syncRegistration;
    registry.register(asUnion);

    expect(registry.list('sync_decision')).toHaveLength(1);
    expect(registry.list('async_lifecycle')).toHaveLength(0);

    const bus = new EventBus();
    registry.attachLifecycleConsumer(bus);
    await bus.emit('agent.tool.end', toolEndPayload());
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
    expect(syncInvoked).toBe(0);
    expect(registry.stats()[0]?.invocations).toBe(0);
  });
});

describe('HookRegistry lifecycle dispatch', () => {
  it('delivers a redacted payload for a subscribed event', async () => {
    const registry = new HookRegistry();
    const collector = collectEnvelopes();
    registry.register({
      mode: 'async_lifecycle',
      name: 'tool-watcher',
      sourcePath: 'test',
      events: ['agent.tool.end'],
      handler: collector.handler,
    });
    const bus = new EventBus();
    registry.attachLifecycleConsumer(bus);

    await bus.emit('agent.tool.end', toolEndPayload({
      outcome: 'execution_error',
      isError: true,
      errorMessage: 'secret partner content leaked into an error',
      shardId: 'shard-9',
    }));
    await collector.waitForCount(1);

    const envelope = collector.envelopes[0]!;
    expect(envelope.hook).toBe('tool-watcher');
    expect(envelope.event).toBe('agent.tool.end');
    expect(envelope.payload).toMatchObject({
      channelId: 'channel-1',
      toolCallId: 'call-1',
      toolName: 'web.fetch',
      outcome: 'execution_error',
      isError: true,
      hasErrorMessage: true,
    });
    // Redaction: forensic error text and shard identifiers never reach hooks.
    expect(envelope.payload).not.toHaveProperty('errorMessage');
    expect(envelope.payload).not.toHaveProperty('shardId');
  });

  it('redacts partner message content on turn lifecycle events', async () => {
    const registry = new HookRegistry();
    const collector = collectEnvelopes();
    registry.register({
      mode: 'async_lifecycle',
      name: 'turn-watcher',
      sourcePath: 'test',
      events: ['agent.turn.start'],
      handler: collector.handler,
    });
    const bus = new EventBus();
    registry.attachLifecycleConsumer(bus);

    await bus.emit('agent.turn.start', {
      message: {
        id: 'message-1',
        channelId: 'channel-1',
        channelType: 'discord',
        authorId: 'author-1',
        authorName: 'Partner Name',
        content: 'deeply private partner text',
        timestamp: new Date(),
      },
      turnId: 'turn-1',
    });
    await collector.waitForCount(1);

    const payload = collector.envelopes[0]!.payload;
    expect(payload).toMatchObject({
      channelId: 'channel-1',
      messageId: 'message-1',
      authorId: 'author-1',
      contentLength: 'deeply private partner text'.length,
      turnId: 'turn-1',
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('deeply private partner text');
    expect(serialized).not.toContain('Partner Name');
  });

  it('contains handler errors: throwing and rejecting hooks never break the emit pipeline', async () => {
    const registry = new HookRegistry();
    const collector = collectEnvelopes();
    registry.register({
      mode: 'async_lifecycle',
      name: 'throws-sync',
      sourcePath: 'test',
      events: ['agent.tool.end'],
      handler: () => {
        throw new Error('operator bug (sync)');
      },
    });
    registry.register({
      mode: 'async_lifecycle',
      name: 'rejects-async',
      sourcePath: 'test',
      events: ['agent.tool.end'],
      handler: async () => {
        throw new Error('operator bug (async)');
      },
    });
    registry.register({
      mode: 'async_lifecycle',
      name: 'healthy',
      sourcePath: 'test',
      events: ['agent.tool.end'],
      handler: collector.handler,
    });
    const bus = new EventBus();
    let downstreamRuns = 0;
    bus.on('agent.tool.end', () => {
      downstreamRuns += 1;
    });
    registry.attachLifecycleConsumer(bus);

    await expect(bus.emit('agent.tool.end', toolEndPayload())).resolves.toBeUndefined();
    await collector.waitForCount(1);
    // Other bus subscribers are unaffected.
    expect(downstreamRuns).toBe(1);

    // Failures are recorded per hook, not propagated.
    const deadline = Date.now() + 2_000;
    const failed = () => registry.stats().filter(stat => stat.failures > 0);
    while (failed().length < 2 && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    const stats = new Map(registry.stats().map(stat => [stat.name, stat]));
    expect(stats.get('throws-sync')?.failures).toBe(1);
    expect(stats.get('rejects-async')?.failures).toBe(1);
    expect(stats.get('rejects-async')?.lastError).toContain('operator bug (async)');
    expect(stats.get('healthy')?.failures).toBe(0);
  });

  it('never blocks the emitting pipeline on a hung handler', async () => {
    const registry = new HookRegistry();
    registry.register({
      mode: 'async_lifecycle',
      name: 'hangs-forever',
      sourcePath: 'test',
      events: ['agent.compaction.start'],
      handler: () => new Promise<void>(() => {
        // Never settles: a stuck operator hook must not delay the pipeline.
      }),
    });
    const bus = new EventBus();
    registry.attachLifecycleConsumer(bus);

    const startedAt = Date.now();
    await bus.emit('agent.compaction.start', {
      channelId: 'channel-1',
      reason: 'threshold',
      tokensBefore: 1_000,
      tokenBudget: 800,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(registry.stats()[0]?.invocations).toBe(1);
  });

  it('isolates payload mutation between hooks and from the bus payload', async () => {
    const registry = new HookRegistry();
    const collector = collectEnvelopes();
    registry.register({
      mode: 'async_lifecycle',
      name: 'a-mutator',
      sourcePath: 'test',
      events: ['agent.tool.end'],
      handler: (envelope) => {
        envelope.payload.toolName = 'tampered';
        collector.handler(envelope);
      },
    });
    registry.register({
      mode: 'async_lifecycle',
      name: 'b-observer',
      sourcePath: 'test',
      events: ['agent.tool.end'],
      handler: collector.handler,
    });
    const bus = new EventBus();
    registry.attachLifecycleConsumer(bus);

    const busPayload = toolEndPayload();
    await bus.emit('agent.tool.end', busPayload);
    await collector.waitForCount(2);

    const observed = collector.envelopes.find(envelope => envelope.hook === 'b-observer');
    expect(observed?.payload.toolName).toBe('web.fetch');
    expect(busPayload.toolName).toBe('web.fetch');
  });

  it('subscribes dynamically for hooks registered after attach, and detaches cleanly', async () => {
    const registry = new HookRegistry();
    const bus = new EventBus();
    registry.attachLifecycleConsumer(bus);
    expect(() => registry.attachLifecycleConsumer(bus)).toThrow(/already attached/);

    const collector = collectEnvelopes();
    registry.register({
      mode: 'async_lifecycle',
      name: 'late-arrival',
      sourcePath: 'test',
      events: ['agent.retry.end'],
      handler: collector.handler,
    });
    await bus.emit('agent.retry.end', { channelId: 'channel-1', success: true, attempt: 2 });
    await collector.waitForCount(1);
    expect(collector.envelopes[0]!.payload).toEqual({
      channelId: 'channel-1',
      success: true,
      attempt: 2,
    });

    registry.detachLifecycleConsumer();
    await bus.emit('agent.retry.end', { channelId: 'channel-1', success: false, attempt: 3 });
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
    expect(collector.envelopes).toHaveLength(1);
  });
});

describe('hook event allowlist', () => {
  it('exposes only the curated agent-bus lifecycle events', () => {
    expect([...HOOK_SUBSCRIBABLE_EVENTS]).toEqual([
      'agent.turn.start',
      'agent.turn.end',
      'agent.tool.start',
      'agent.tool.end',
      'agent.compaction.start',
      'agent.compaction.end',
      'agent.retry.start',
      'agent.retry.end',
      'session.compacted',
      'system.ready',
      'system.shutdown',
    ]);
    expect(isHookSubscribableEvent('agent.tool.end')).toBe(true);
    expect(isHookSubscribableEvent('memory.retrieval')).toBe(false);
    expect(isHookSubscribableEvent('message.received')).toBe(false);
  });
});
