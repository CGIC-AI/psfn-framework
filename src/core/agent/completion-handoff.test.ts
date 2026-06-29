import { describe, expect, it, beforeEach } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { SessionEntry } from '../session/types.js';
import {
  buildCompletionHandoff,
  emitCompletionHandoffToSessionStore,
  renderCompletionHandoffForContext,
  resetCompletionHandoffDedupeForTests,
} from './completion-handoff.js';

class MemorySessionSink {
  readonly entries: SessionEntry[] = [];

  getRecent(channelId: string, limit: number): SessionEntry[] {
    return this.entries
      .filter(entry => entry.channelId === channelId)
      .slice(-limit);
  }

  append(entry: Omit<SessionEntry, 'id'>): number {
    const id = this.entries.length + 1;
    this.entries.push({ ...entry, id });
    return id;
  }
}

describe('completion handoff emitter', () => {
  beforeEach(() => {
    resetCompletionHandoffDedupeForTests();
  });

  it('emits complete structured handoff context with required fields', async () => {
    const eventBus = new EventBus();
    const sessionStore = new MemorySessionSink();
    const events: unknown[] = [];
    eventBus.on('agent.completion_handoff', event => {
      events.push(event);
    });

    const result = await emitCompletionHandoffToSessionStore({
      eventBus,
      sessionStore,
      targetChannelId: 'api:parent',
      handoff: {
        source: 'subagent',
        taskId: 'subagent-1',
        taskLabel: 'research',
        subagentId: 'subagent-1',
        status: 'completed',
        resultSummary: 'Found the deploy blocker and wrote a short summary.',
        outputRefs: [{ kind: 'session', ref: 'subagent:subagent-1' }],
        validationPerformed: ['subagent_lifecycle_terminal', 'turns:1'],
        partialResult: false,
        recommendedNextAction: 'Review the result before writing a companion-authored update.',
        origin: {
          sourceChannelId: 'api:parent',
          sourceMessageId: 'msg-1',
          requestId: 'msg-1',
          turnId: 'turn-1',
          originatingBeadId: 'PSFNLIVE-hlh0',
        },
      },
    });

    expect(result.emitted).toBe(true);
    expect(sessionStore.entries).toHaveLength(1);
    expect(sessionStore.entries[0]).toMatchObject({
      role: 'system',
      authorId: 'system:completion-handoff',
      channelId: 'api:parent',
    });
    expect(JSON.parse(sessionStore.entries[0]?.metadata ?? '{}')).toMatchObject({
      type: 'completion_handoff',
      status: 'completed',
      partialResult: false,
    });
    expect(sessionStore.entries[0]?.content).toContain('"subagentId": "subagent-1"');
    expect(sessionStore.entries[0]?.content).toContain('"originatingBeadId": "PSFNLIVE-hlh0"');
    expect(events).toHaveLength(1);
  });

  it('guards duplicate and replayed handoffs by dedupe key', async () => {
    const eventBus = new EventBus();
    const sessionStore = new MemorySessionSink();
    const handoff = buildCompletionHandoff({
      source: 'shard',
      taskId: 'shard-1',
      shardId: 'shard-1',
      status: 'completed',
      resultSummary: 'Shard finished.',
      outputRefs: [{ kind: 'session', ref: 'shard:shard-1' }],
      validationPerformed: ['shard_lifecycle_terminal'],
      partialResult: false,
      recommendedNextAction: 'Review the shard handoff.',
      dedupeKey: 'dedupe-shard-1',
    });

    const first = await emitCompletionHandoffToSessionStore({
      eventBus,
      sessionStore,
      targetChannelId: 'api:parent',
      handoff,
    });
    resetCompletionHandoffDedupeForTests();
    const replay = await emitCompletionHandoffToSessionStore({
      eventBus,
      sessionStore,
      targetChannelId: 'api:parent',
      handoff,
    });

    expect(first.emitted).toBe(true);
    expect(replay).toMatchObject({ emitted: false, duplicate: true });
    expect(sessionStore.entries).toHaveLength(1);
  });

  it('marks partial interrupted handoffs without treating them as partner-facing text', () => {
    const handoff = buildCompletionHandoff({
      source: 'scheduled_loop',
      taskId: 'loop-1',
      status: 'interrupted',
      resultSummary: 'Partial analysis exists; final validation did not run.',
      outputRefs: [{ kind: 'partial_message', ref: 'loop-1:partial' }],
      validationPerformed: ['stream_partial_observed'],
      blocker: {
        reason: 'interrupted',
        error: 'abort_signal',
      },
      partialResult: true,
      recommendedNextAction: 'Resume from the partial result or retry with narrower scope.',
    });

    const rendered = renderCompletionHandoffForContext(handoff);

    expect(handoff.result.partial).toBe(true);
    expect(handoff.status).toBe('interrupted');
    expect(handoff.privacy).toEqual({
      visibility: 'internal_companion_context',
      partnerNotification: 'policy_gated_companion_authored',
      rawWorkerCompletionForPartner: 'not_allowed',
    });
    expect(rendered).toContain('not partner-authored speech');
  });
});
