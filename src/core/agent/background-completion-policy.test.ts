import { describe, expect, it } from 'vitest';
import { decideBackgroundCompletionNotification } from './background-completion-policy.js';

const baseInput = {
  continuationId: 'action-1',
  sourceMessageId: 'deferred-tool-handoff:action-1',
  deliverySessionId: 'terminal:session-a',
  channelId: 'terminal:session-a',
  channelType: 'terminal',
  sourceTimestampMs: 100_000,
  taskKind: 'deferred_tool_handoff' as string | null,
  intent: 'dev' as string | null,
  responseContent: 'Done. I applied the patch.',
  completedAt: 110_000,
};

describe('decideBackgroundCompletionNotification', () => {
  it('notifies for user-facing deferred tool handoff completions', () => {
    const decision = decideBackgroundCompletionNotification(baseInput);
    expect(decision).toMatchObject({
      shouldNotify: true,
      reason: 'notify_deferred_user_task',
      context: {
        origin: 'user_delegated',
        urgency: 'normal',
        channelContext: 'session',
        stale: false,
        taskKind: 'deferred_tool_handoff',
        intent: 'dev',
      },
    });
    expect(decision.context.completionAgeMs).toBe(10_000);
  });

  it('suppresses when response content is empty', () => {
    const decision = decideBackgroundCompletionNotification({
      ...baseInput,
      responseContent: '   ',
    });
    expect(decision).toMatchObject({
      shouldNotify: false,
      reason: 'suppress_empty_response',
    });
  });

  it('suppresses internal-session completions', () => {
    const decision = decideBackgroundCompletionNotification({
      ...baseInput,
      deliverySessionId: 'internal:heartbeat',
    });
    expect(decision).toMatchObject({
      shouldNotify: false,
      reason: 'suppress_internal_session',
      context: {
        origin: 'internal',
        channelContext: 'internal',
      },
    });
  });

  it('suppresses stale completions even for user delegated tasks', () => {
    const decision = decideBackgroundCompletionNotification({
      ...baseInput,
      completedAt: baseInput.sourceTimestampMs + (16 * 60 * 1000),
    });
    expect(decision).toMatchObject({
      shouldNotify: false,
      reason: 'suppress_stale_completion',
      context: {
        stale: true,
      },
    });
    expect(decision.context.completionAgeMs).toBe(16 * 60 * 1000);
  });

  it('suppresses low-urgency delegated tasks by default', () => {
    const decision = decideBackgroundCompletionNotification({
      ...baseInput,
      taskKind: 'maintenance',
      intent: 'maintenance',
    });
    expect(decision).toMatchObject({
      shouldNotify: false,
      reason: 'suppress_low_urgency_task',
      context: {
        urgency: 'low',
      },
    });
  });

  it('suppresses non-user task origin by default', () => {
    const decision = decideBackgroundCompletionNotification({
      ...baseInput,
      sourceMessageId: 'heartbeat:tick-1',
    });
    expect(decision).toMatchObject({
      shouldNotify: false,
      reason: 'suppress_non_user_task',
      context: {
        origin: 'unknown',
      },
    });
  });

  it('does not reuse deferred completion notification semantics for arbitrary watcher sources', () => {
    const decision = decideBackgroundCompletionNotification({
      ...baseInput,
      sourceMessageId: 'process-watcher:job-7',
      taskKind: 'deferred_tool_handoff',
      intent: 'critical repair',
    });
    expect(decision).toMatchObject({
      shouldNotify: false,
      reason: 'suppress_non_user_task',
      context: {
        origin: 'unknown',
        urgency: 'high',
      },
    });
  });
});
