import { describe, expect, it, beforeEach, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import {
  buildCompletionHandoff,
  emitCompletionHandoff,
  resetCompletionHandoffDedupeForTests,
} from './completion-handoff.js';
import {
  CompletionNoticeBuffer,
  renderBackgroundCompletionsBlock,
} from './completion-notices.js';

describe('completion handoff emitter', () => {
  beforeEach(() => {
    resetCompletionHandoffDedupeForTests();
  });

  it('emits the structured handoff on the event bus and never writes session entries', async () => {
    const eventBus = new EventBus();
    const notices = new CompletionNoticeBuffer();
    const events: unknown[] = [];
    eventBus.on('agent.completion_handoff', event => {
      events.push(event);
    });

    const result = await emitCompletionHandoff({
      eventBus,
      notices,
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
    expect(result.noticeBuffered).toBe(true);
    expect(events).toHaveLength(1);
    const buffered = notices.peek('api:parent');
    expect(buffered).toHaveLength(1);
    expect(buffered[0]).toMatchObject({
      source: 'subagent',
      taskId: 'subagent-1',
      label: 'research',
      status: 'completed',
      resultRefs: [{ kind: 'session', ref: 'subagent:subagent-1' }],
    });
  });

  it('buffers a compact two-line notice that drains exactly once', async () => {
    const eventBus = new EventBus();
    const notices = new CompletionNoticeBuffer();
    await emitCompletionHandoff({
      eventBus,
      notices,
      targetChannelId: 'api:parent',
      handoff: {
        source: 'shard',
        taskId: 'shard-1',
        shardId: 'shard-1',
        taskLabel: 'fold-review',
        status: 'completed',
        resultSummary: 'Shard finished. '.repeat(40),
        outputRefs: [{ kind: 'session', ref: 'shard:shard-1' }],
        validationPerformed: ['shard_lifecycle_terminal'],
        partialResult: false,
        recommendedNextAction: 'Review the shard handoff.',
        dedupeKey: 'dedupe-shard-notice',
      },
    });

    const drained = notices.drain('api:parent');
    expect(drained).toHaveLength(1);
    const block = renderBackgroundCompletionsBlock(drained);
    expect(block).toContain('<background_completions>');
    expect(block).toContain('[shard completion] fold-review — completed [task=shard-1]');
    expect(block).toContain('[result refs: session=shard:shard-1]');
    // Two lines per notice, compact summary.
    const noticeLines = block.split('\n').filter(line => line.includes('fold-review') || line.startsWith('Shard finished.'));
    expect(noticeLines).toHaveLength(2);
    expect(noticeLines[1]!.length).toBeLessThanOrEqual(160);
    // Render-once: the buffer is empty after draining.
    expect(notices.drain('api:parent')).toHaveLength(0);
  });

  it('only routes terminal subagent and shard results into companion context', async () => {
    const eventBus = new EventBus();
    const notices = new CompletionNoticeBuffer();
    const events: Array<{ noticeBuffered?: boolean }> = [];
    eventBus.on('agent.completion_handoff', event => {
      events.push(event as { noticeBuffered?: boolean });
    });

    const result = await emitCompletionHandoff({
      eventBus,
      notices,
      targetChannelId: '1313001762793197678',
      handoff: {
        source: 'post_turn_action',
        taskId: 'action-1',
        taskLabel: 'memory.near-turn.run',
        status: 'completed',
        resultSummary: 'Post-turn action "memory.near-turn.run" succeeded.',
        outputRefs: [],
        validationPerformed: ['post_turn_action_handler_completed'],
        partialResult: false,
        recommendedNextAction: 'None.',
      },
    });

    expect(result.emitted).toBe(true);
    expect(result.noticeBuffered).toBe(false);
    expect(events[0]?.noticeBuffered).toBe(false);
    expect(notices.peek('1313001762793197678')).toHaveLength(0);

    const progress = await emitCompletionHandoff({
      eventBus,
      notices,
      targetChannelId: 'api:parent',
      handoff: {
        source: 'subagent',
        taskId: 'automata-progress',
        status: 'progress',
        resultSummary: 'One turn finished.',
        partialResult: true,
        recommendedNextAction: 'Wait.',
      },
    });
    expect(progress.noticeBuffered).toBe(false);

    const blocked = await emitCompletionHandoff({
      eventBus,
      notices,
      targetChannelId: 'api:parent',
      handoff: {
        source: 'shard',
        taskId: 'shard-blocked',
        shardId: 'shard-blocked',
        status: 'blocked',
        resultSummary: 'The shard could not read the requested file.',
        partialResult: false,
        recommendedNextAction: 'Inspect the blocker.',
      },
    });
    expect(blocked.noticeBuffered).toBe(true);
    const blockedAutomata = await emitCompletionHandoff({
      eventBus,
      notices,
      targetChannelId: 'api:parent',
      handoff: {
        source: 'subagent',
        taskId: 'automata-blocked',
        subagentId: 'automata-blocked',
        status: 'blocked',
        resultSummary: 'The automata could not access the requested input.',
        partialResult: false,
        recommendedNextAction: 'Inspect the blocker.',
      },
    });
    expect(blockedAutomata.noticeBuffered).toBe(true);
    expect(notices.peek('api:parent')).toHaveLength(2);
  });

  it('delivers an allowlisted result through the parent-orchestration port', async () => {
    const deliver = vi.fn().mockResolvedValue('active_nudge' as const);
    const result = await emitCompletionHandoff({
      eventBus: new EventBus(),
      noticeDelivery: { deliver },
      targetChannelId: 'discord:origin',
      handoff: {
        source: 'subagent',
        taskId: 'automata-delivery',
        subagentId: 'automata-delivery',
        status: 'completed',
        resultSummary: 'The requested summary is ready.',
        outputRefs: [{ kind: 'session', ref: 'subagent:automata-delivery' }],
        partialResult: false,
        recommendedNextAction: 'Review the result.',
        origin: {
          sourceChannelId: 'discord:origin',
          logicalSessionId: 'session:captured-origin',
        },
      },
    });

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      sourceChannelId: 'discord:origin',
      logicalSessionId: 'session:captured-origin',
      notice: expect.objectContaining({ taskId: 'automata-delivery' }),
    }));
    expect(result).toMatchObject({
      noticeBuffered: false,
      noticeDelivery: 'active_nudge',
    });
  });

  it('does not burn the dedupe key when a critical lifecycle guard rejects emission', async () => {
    const eventBus = new EventBus();
    let attempts = 0;
    eventBus.guard('agent.completion_handoff', () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('durable lifecycle sink unavailable');
      }
      return true;
    });
    const handoff = buildCompletionHandoff({
      source: 'subagent',
      taskId: 'guard-retry',
      subagentId: 'guard-retry',
      status: 'completed',
      resultSummary: 'Finished.',
      partialResult: false,
      dedupeKey: 'guard-retry-dedupe',
    });

    await expect(emitCompletionHandoff({ eventBus, handoff }))
      .rejects.toThrow('durable lifecycle sink unavailable');
    await expect(emitCompletionHandoff({ eventBus, handoff }))
      .resolves.toMatchObject({ emitted: true });
    expect(attempts).toBe(2);
  });

  it('guards duplicate handoffs by dedupe key', async () => {
    const eventBus = new EventBus();
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

    const first = await emitCompletionHandoff({ eventBus, targetChannelId: 'api:parent', handoff });
    const replay = await emitCompletionHandoff({ eventBus, targetChannelId: 'api:parent', handoff });

    expect(first.emitted).toBe(true);
    expect(replay).toMatchObject({ emitted: false, duplicate: true });
  });

  it('keeps distinct child results even when their human-readable labels match', async () => {
    const notices = new CompletionNoticeBuffer();
    const eventBus = new EventBus();
    for (let index = 0; index < 3; index++) {
      await emitCompletionHandoff({
        eventBus,
        notices,
        targetChannelId: 'api:parent',
        handoff: {
          source: 'subagent',
          taskId: `task-${index}`,
          taskLabel: 'recurring-check',
          status: 'completed',
          resultSummary: `Run ${index} finished.`,
          outputRefs: [],
          validationPerformed: [],
          partialResult: false,
          recommendedNextAction: 'None.',
          dedupeKey: `recurring-${index}`,
        },
      });
    }
    const drained = notices.drain('api:parent');
    expect(drained).toHaveLength(3);
    expect(drained.map(notice => notice.taskId)).toEqual(['task-0', 'task-1', 'task-2']);
  });

  it('replaces an older terminal update for the same child task', async () => {
    const notices = new CompletionNoticeBuffer();
    const eventBus = new EventBus();
    for (const [status, dedupeKey] of [['blocked', 'blocked-1'], ['completed', 'completed-1']] as const) {
      await emitCompletionHandoff({
        eventBus,
        notices,
        targetChannelId: 'api:parent',
        handoff: {
          source: 'subagent',
          taskId: 'same-task',
          taskLabel: 'recurring-check',
          status,
          resultSummary: `${status} result`,
          partialResult: false,
          recommendedNextAction: 'Review.',
          dedupeKey,
        },
      });
    }
    expect(notices.drain('api:parent')).toMatchObject([
      { taskId: 'same-task', status: 'completed' },
    ]);
  });

  it('bounds and expires an offline completion backlog', async () => {
    const notices = new CompletionNoticeBuffer();
    const eventBus = new EventBus();
    for (let index = 0; index < 10; index++) {
      await emitCompletionHandoff({
        eventBus,
        notices,
        targetChannelId: 'api:parent',
        handoff: {
          source: 'subagent',
          taskId: `offline-${index}`,
          status: 'completed',
          resultSummary: `Offline result ${index}`,
          partialResult: false,
          recommendedNextAction: 'Review.',
          createdAt: index === 2 ? 1 : 100,
          dedupeKey: `offline-dedupe-${index}`,
        },
      });
    }

    expect(notices.peek('api:parent')).toHaveLength(8);
    expect(notices.drain('api:parent', 24 * 60 * 60 * 1000 + 2))
      .toHaveLength(7);
  });

  it('keeps the first result lookup visible while bounding long references', async () => {
    const notices = new CompletionNoticeBuffer();
    const eventBus = new EventBus();
    await emitCompletionHandoff({
      eventBus,
      notices,
      targetChannelId: 'api:parent',
      handoff: {
        source: 'subagent',
        taskId: 'long-reference',
        status: 'completed',
        resultSummary: 'The delegated work returned a usable result.',
        outputRefs: [{ kind: 'session', ref: `subagent:${'x'.repeat(500)}` }],
        partialResult: false,
        recommendedNextAction: 'Review the result.',
      },
    });

    const [notice] = notices.peek('api:parent');
    expect(notice.resultRefs[0]?.ref).toBe(`subagent:${'x'.repeat(500)}`);
    const block = renderBackgroundCompletionsBlock(notices.drain('api:parent'));
    const detailLine = block.split('\n').find(line => line.includes('[result refs:'));
    expect(detailLine).toContain('[result refs: session=');
    expect(detailLine).not.toContain('subagent');
    expect(detailLine?.length).toBeLessThanOrEqual(160);
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

    expect(handoff.result.partial).toBe(true);
    expect(handoff.status).toBe('interrupted');
    expect(handoff.privacy).toEqual({
      visibility: 'internal_companion_context',
      partnerNotification: 'companion_mediated_only',
      rawWorkerCompletionForPartner: 'not_allowed',
    });
  });
});
