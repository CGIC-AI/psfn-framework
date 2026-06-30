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

  it('hydrates active route sessions and skips retired logical sessions after restart', async () => {
    const refreshActiveMemoryContext = vi.fn()
      .mockResolvedValueOnce({ contextBlock: '<memory>fresh</memory>' })
      .mockResolvedValueOnce({ contextBlock: '<memory>recent</memory>' });
    const freshSessionId = 'discord:room:session:20260630T120000Z-fresh123';
    const sessionManager = {
      listSessionRoutes: vi.fn(() => [
        {
          sourceChannelId: 'discord:room',
          activeLogicalSessionId: freshSessionId,
          createdAt: '2026-06-30T12:00:00.000Z',
          updatedAt: '2026-06-30T12:00:00.000Z',
          routeGeneration: 1,
          mode: 'break_glass_quarantine' as const,
          actor: 'operator',
          reason: 'poisoned context reset',
          retiredSessions: [
            {
              logicalSessionId: 'discord:room',
              sourceChannelId: 'discord:room',
              retiredAt: '2026-06-30T12:00:00.000Z',
              routeGeneration: 1,
              mode: 'break_glass_quarantine' as const,
              actor: 'operator',
              reason: 'poisoned context reset',
              excludedContextClasses: ['recent_entries'],
            },
          ],
        },
      ]),
      isSessionRetiredOrQuarantined: vi.fn((logicalSessionId: string) => logicalSessionId === 'discord:room'),
      resolveStartupSessionMetadata: vi.fn(() => ({
        sessionId: 'discord:room',
        channelType: 'discord',
        timestamp: 1,
      })),
      listRecentSessions: vi.fn(() => [
        {
          channelId: 'discord:room',
          channelType: 'discord',
          messageCount: 30,
          lastActivityAt: 3,
          lastRole: 'assistant' as const,
        },
        {
          channelId: freshSessionId,
          channelType: 'discord',
          messageCount: 2,
          lastActivityAt: 2,
          lastRole: 'assistant' as const,
        },
        {
          channelId: 'discord:recent',
          channelType: 'discord',
          messageCount: 2,
          lastActivityAt: 1,
          lastRole: 'user' as const,
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
      channelId: freshSessionId,
      contextText: expect.stringContaining(`Answer in ${freshSessionId}`),
    }));
    expect(refreshActiveMemoryContext).toHaveBeenNthCalledWith(2, expect.objectContaining({
      channelId: 'discord:recent',
      contextText: expect.stringContaining('Answer in discord:recent'),
    }));
    expect(sessionManager.getRecentMessages).not.toHaveBeenCalledWith('discord:room', expect.any(Number));
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
