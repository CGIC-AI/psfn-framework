import { describe, expect, it, vi } from 'vitest';

import {
  runIntentionPostTurnHooks,
  type IntentionPostTurnHook,
  type IntentionPostTurnHookContext,
} from './post-turn-actions.js';

function makeContext(): IntentionPostTurnHookContext {
  return {
    message: {
      id: 'message-1',
      channelId: 'session-1',
      channelType: 'api',
      authorId: 'partner-1',
      authorName: 'Partner',
      content: 'hello',
      timestamp: new Date(100),
    },
    response: {
      content: 'hi',
      channelId: 'session-1',
      metadata: {
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
      },
    },
    turnMessages: [],
    turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
    completedAt: 100,
  };
}

describe('runIntentionPostTurnHooks', () => {
  it('does not cross the durable boundary when a hook fails before its sink', async () => {
    const hook = vi.fn(async () => {
      throw new Error('behavioral hook validation failed');
    });
    const crossBoundary = vi.fn(async () => undefined);
    const assertOwned = vi.fn(async () => undefined);
    const runEffect = vi.fn(async (
      _effectKey: string,
      operation: (crossBoundary: () => Promise<void>) => Promise<void>,
    ) => operation(crossBoundary));

    await expect(runIntentionPostTurnHooks({
      hooks: [hook],
      context: makeContext(),
      logger: { warn: vi.fn() },
      options: { propagateFailures: true, assertOwned, runEffect },
    })).rejects.toThrow('behavioral hook validation failed');

    expect(crossBoundary).not.toHaveBeenCalled();
  });

  it('propagates a failing hook while retaining receipts for earlier successful hooks', async () => {
    const first = vi.fn<IntentionPostTurnHook>(async (_context, effects) => {
      await effects.crossBoundary();
    });
    let secondAttempt = 0;
    const second = vi.fn<IntentionPostTurnHook>(async (_context, effects) => {
      secondAttempt += 1;
      if (secondAttempt === 1) throw new Error('transient intention failure');
      await effects.crossBoundary();
    });
    const applied = new Set<string>();
    const assertOwned = vi.fn(async () => undefined);
    const runEffect = vi.fn(async (
      effectKey: string,
      operation: (assertOwned: () => Promise<void>) => Promise<void>,
    ) => {
      if (applied.has(effectKey)) return;
      await operation(async () => undefined);
      applied.add(effectKey);
    });
    const input = {
      hooks: [first, second],
      context: makeContext(),
      logger: { warn: vi.fn() },
      options: { propagateFailures: true, assertOwned, runEffect },
    };

    await expect(runIntentionPostTurnHooks(input)).rejects.toThrow('transient intention failure');
    await expect(runIntentionPostTurnHooks(input)).resolves.toBeUndefined();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(new Set(['intention-hook:0', 'intention-hook:1']));
  });
});
