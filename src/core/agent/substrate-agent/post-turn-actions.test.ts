import { describe, expect, it, vi } from 'vitest';

import {
  runIntentionPostTurnHooks,
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
  it('propagates a failing hook while retaining receipts for earlier successful hooks', async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn()
      .mockRejectedValueOnce(new Error('transient intention failure'))
      .mockResolvedValue(undefined);
    const applied = new Set<string>();
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
      options: { propagateFailures: true, runEffect },
    };

    await expect(runIntentionPostTurnHooks(input)).rejects.toThrow('transient intention failure');
    await expect(runIntentionPostTurnHooks(input)).resolves.toBeUndefined();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(new Set(['intention-hook:0', 'intention-hook:1']));
  });
});
