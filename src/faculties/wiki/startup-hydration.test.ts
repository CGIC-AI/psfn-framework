import { describe, expect, it, vi } from 'vitest';
import { hydrateStartupWikiContexts } from './startup-hydration.js';

describe('hydrateStartupWikiContexts', () => {
  it('warms restored and recent session wiki contexts off the foreground path', async () => {
    const refreshWikiContextBlock = vi.fn()
      .mockResolvedValueOnce({ block: '## Reference Wiki\n\nrestored', refreshStatus: 'ready' })
      .mockResolvedValueOnce({ block: '## Reference Wiki\n\nrecent', refreshStatus: 'ready' });
    const sessionManager = {
      resolveStartupSessionMetadata: vi.fn(() => ({
        sessionId: 'discord:restored',
        channelType: 'discord' as const,
        timestamp: 1,
      })),
      listRecentSessions: vi.fn(() => [
        {
          channelId: 'discord:restored',
          channelType: 'discord' as const,
          messageCount: 2,
          lastActivityAt: 2,
          lastRole: 'user' as const,
        },
        {
          channelId: 'discord:recent',
          channelType: 'discord' as const,
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

    const result = await hydrateStartupWikiContexts({
      wikiRetrieval: {
        getWikiContextBlock: vi.fn(() => null),
        refreshWikiContextBlock,
      },
      sessionManager,
      recentSessionLimit: 3,
    });

    expect(result).toEqual({ attempted: 2, hydrated: 2, degraded: [] });
    expect(refreshWikiContextBlock).toHaveBeenCalledTimes(2);
    expect(refreshWikiContextBlock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      channelId: 'discord:restored',
      focusActive: false,
      queryText: expect.stringContaining('Question in discord:restored'),
    }));
  });

  it('is a no-op when no wiki retrieval provider is wired (opt-in, default off)', async () => {
    const result = await hydrateStartupWikiContexts({
      wikiRetrieval: null,
      sessionManager: {
        resolveStartupSessionMetadata: vi.fn(() => null),
        listRecentSessions: vi.fn(() => []),
        getRecentMessages: vi.fn(() => []),
      },
    });
    expect(result).toEqual({ attempted: 0, hydrated: 0, degraded: [] });
  });

  it('records degraded channels without throwing (best-effort priming)', async () => {
    const refreshWikiContextBlock = vi.fn().mockRejectedValue(new Error('pgvector down'));
    const sessionManager = {
      resolveStartupSessionMetadata: vi.fn(() => ({
        sessionId: 'discord:restored',
        channelType: 'discord' as const,
        timestamp: 1,
      })),
      listRecentSessions: vi.fn(() => []),
      getRecentMessages: vi.fn(() => [
        {
          id: 1,
          channelId: 'discord:restored',
          role: 'user' as const,
          content: 'Need reference context.',
          timestamp: 1,
        },
      ]),
    };

    const result = await hydrateStartupWikiContexts({
      wikiRetrieval: {
        getWikiContextBlock: vi.fn(() => null),
        refreshWikiContextBlock,
      },
      sessionManager,
    });

    expect(result).toEqual({
      attempted: 1,
      hydrated: 0,
      degraded: [{ channelId: 'discord:restored', error: 'pgvector down' }],
    });
  });
});
