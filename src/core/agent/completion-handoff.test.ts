import { describe, expect, it, beforeEach } from 'vitest';
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
    expect(buffered[0]).toMatchObject({ label: 'research', status: 'completed' });
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
    expect(block).toContain('[background completion] fold-review — completed');
    // Two lines per notice, compact summary.
    const noticeLines = block.split('\n').filter(line => line.includes('fold-review') || line.startsWith('Shard finished.'));
    expect(noticeLines).toHaveLength(2);
    expect(noticeLines[1]!.length).toBeLessThanOrEqual(160);
    // Render-once: the buffer is empty after draining.
    expect(notices.drain('api:parent')).toHaveLength(0);
  });

  it('omits notices entirely when no buffer is passed (bookkeeping emissions)', async () => {
    const eventBus = new EventBus();
    const events: Array<{ noticeBuffered?: boolean }> = [];
    eventBus.on('agent.completion_handoff', event => {
      events.push(event as { noticeBuffered?: boolean });
    });

    const result = await emitCompletionHandoff({
      eventBus,
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

  it('replaces stacked notices for the same task label instead of accumulating', async () => {
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
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ summary: 'Run 2 finished.' });
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
      partnerNotification: 'policy_gated_companion_authored',
      rawWorkerCompletionForPartner: 'not_allowed',
    });
  });
});
