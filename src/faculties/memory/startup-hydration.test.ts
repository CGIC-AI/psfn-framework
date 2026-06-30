import { describe, expect, it, vi } from 'vitest';
import { hydrateStartupActiveMemoryContexts } from './startup-hydration.js';

describe('hydrateStartupActiveMemoryContexts', () => {
  it('warms restored and recent session active memory contexts', async () => {
    const refreshActiveMemoryContext = vi.fn()
      .mockResolvedValueOnce({ contextBlock: '<memory>restored</memory>' })
      .mockResolvedValueOnce({ contextBlock: '<memory>recent</memory>' });
    const sessionManager = {
      resolveStartupSessionMetadata: vi.fn(() => ({
        sessionId: 'discord:restored',
        channelType: 'discord',
        timestamp: 1,
      })),
      listRecentSessions: vi.fn(() => [
        {
          channelId: 'discord:restored',
          channelType: 'discord',
          messageCount: 2,
          lastActivityAt: 2,
          lastRole: 'user' as const,
        },
        {
          channelId: 'discord:recent',
          channelType: 'discord',
          messageCount: 2,
          lastActivityAt: 1,
          lastRole: 'assistant' as const,
        },
      ]),
      getRecentMessages: vi.fn((channelId: string) => [
        {
          id: 1,
          channelId,
          role: 'user' as const,
          content: `Question in ${channelId}`,
          timestamp: 1,
        },
        {
          id: 2,
          channelId,
          role: 'assistant' as const,
          content: `Answer in ${channelId}`,
          timestamp: 2,
        },
      ]),
    };

    const result = await hydrateStartupActiveMemoryContexts({
      memoryProvider: { retrieve: vi.fn(), refreshActiveMemoryContext },
      sessionManager,
      recentSessionLimit: 3,
    });

    expect(result).toEqual({ attempted: 2, hydrated: 2, degraded: [] });
    expect(refreshActiveMemoryContext).toHaveBeenCalledTimes(2);
    expect(refreshActiveMemoryContext).toHaveBeenNthCalledWith(1, expect.objectContaining({
      channelId: 'discord:restored',
      trustLevel: 'regular',
      contextText: expect.stringContaining('Question in discord:restored'),
    }));
    expect(refreshActiveMemoryContext).toHaveBeenNthCalledWith(2, expect.objectContaining({
      channelId: 'discord:recent',
      trustLevel: 'regular',
      contextText: expect.stringContaining('Answer in discord:recent'),
    }));
  });

  it('records degraded channels without throwing', async () => {
    const refreshActiveMemoryContext = vi.fn().mockRejectedValue(new Error('embedding unavailable'));
    const sessionManager = {
      resolveStartupSessionMetadata: vi.fn(() => ({
        sessionId: 'discord:restored',
        channelType: 'discord',
        timestamp: 1,
      })),
      listRecentSessions: vi.fn(() => []),
      getRecentMessages: vi.fn(() => [
        {
          id: 1,
          channelId: 'discord:restored',
          role: 'user' as const,
          content: 'Need context.',
          timestamp: 1,
        },
      ]),
    };

    const result = await hydrateStartupActiveMemoryContexts({
      memoryProvider: { retrieve: vi.fn(), refreshActiveMemoryContext },
      sessionManager,
    });

    expect(result).toEqual({
      attempted: 1,
      hydrated: 0,
      degraded: [{ channelId: 'discord:restored', error: 'embedding unavailable' }],
    });
  });
});
