import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { hydrateStartupContinuity } from './startup-continuity.js';

const WIKI_HYDRATION_TUNING = {
  recentSessionLimit: 4,
  recentMessageLimit: 18,
  maxContextChars: 6_000,
};

describe('hydrateStartupContinuity', () => {
  it('aborts startup when active-memory hydration degrades', async () => {
    const sessionManager = {
      resolveStartupSessionMetadata: vi.fn(() => ({
        sessionId: 'discord:restored',
        channelType: 'discord' as const,
        timestamp: 1,
      })),
      listRecentSessions: vi.fn(() => []),
      getRecentMessages: vi.fn(() => [{
        id: 1,
        channelId: 'discord:restored',
        role: 'user' as const,
        content: 'Restore my context.',
        timestamp: 1,
      }]),
      renderActiveCoreMemoryBlock: vi.fn(() => '<core-memory>restored</core-memory>'),
    };

    await expect(hydrateStartupContinuity({
      memoryProvider: {
        retrieve: vi.fn(),
        refreshActiveMemoryContext: vi.fn().mockRejectedValue(new Error('embedding unavailable')),
      },
      wikiRetrieval: null,
      sessionManager,
      wikiHydrationTuning: WIKI_HYDRATION_TUNING,
    })).rejects.toThrow(
      'Startup continuity hydration failed: active memory [discord:restored: embedding unavailable]',
    );
  });

  it('completes both continuity warmups during a healthy startup', async () => {
    const refreshActiveMemoryContext = vi.fn().mockResolvedValue({
      contextBlock: '<memory>restored</memory>',
    });
    const renderActiveCoreMemoryBlock = vi.fn(() => '<core-memory>restored</core-memory>');
    const sessionManager = {
      resolveStartupSessionMetadata: vi.fn(() => ({
        sessionId: 'discord:restored',
        channelType: 'discord' as const,
        timestamp: 1,
      })),
      listRecentSessions: vi.fn(() => [{
        channelId: 'discord:restored',
        channelType: 'discord' as const,
        messageCount: 1,
        lastActivityAt: 1,
        lastRole: 'user' as const,
      }]),
      getRecentMessages: vi.fn(() => [{
        id: 1,
        channelId: 'discord:restored',
        role: 'user' as const,
        content: 'Restore my context.',
        timestamp: 1,
      }]),
      renderActiveCoreMemoryBlock,
    };

    const refreshWikiContextBlock = vi.fn().mockResolvedValue({
      key: 'channel:discord:restored|class:dm|scope:',
      block: '## Reference Wiki',
      refreshStatus: 'ready',
    });

    await expect(hydrateStartupContinuity({
      memoryProvider: { retrieve: vi.fn(), refreshActiveMemoryContext },
      wikiRetrieval: {
        getWikiContextBlock: vi.fn(() => null),
        refreshWikiContextBlock,
      },
      sessionManager,
      wikiHydrationTuning: WIKI_HYDRATION_TUNING,
    })).resolves.toBeUndefined();

    expect(refreshActiveMemoryContext).toHaveBeenCalledOnce();
    expect(renderActiveCoreMemoryBlock).toHaveBeenCalledWith('discord:restored');
    expect(refreshWikiContextBlock).toHaveBeenCalledOnce();
  });

  it('does not abort startup when only wiki hydration degrades (supplemental, best-effort)', async () => {
    const refreshActiveMemoryContext = vi.fn().mockResolvedValue({
      contextBlock: '<memory>restored</memory>',
    });
    const sessionManager = {
      resolveStartupSessionMetadata: vi.fn(() => ({
        sessionId: 'discord:restored',
        channelType: 'discord' as const,
        timestamp: 1,
      })),
      listRecentSessions: vi.fn(() => []),
      getRecentMessages: vi.fn(() => [{
        id: 1,
        channelId: 'discord:restored',
        role: 'user' as const,
        content: 'Restore my context.',
        timestamp: 1,
      }]),
      renderActiveCoreMemoryBlock: vi.fn(() => '<core-memory>restored</core-memory>'),
    };

    await expect(hydrateStartupContinuity({
      memoryProvider: { retrieve: vi.fn(), refreshActiveMemoryContext },
      wikiRetrieval: {
        getWikiContextBlock: vi.fn(() => null),
        refreshWikiContextBlock: vi.fn().mockRejectedValue(new Error('pgvector down')),
      },
      sessionManager,
      wikiHydrationTuning: WIKI_HYDRATION_TUNING,
    })).resolves.toBeUndefined();
  });

  it('aborts startup when active core-memory hydration degrades', async () => {
    const sessionManager = {
      resolveStartupSessionMetadata: vi.fn(() => null),
      listRecentSessions: vi.fn(() => [{
        channelId: 'discord:restored',
        channelType: 'discord' as const,
        messageCount: 1,
        lastActivityAt: 1,
        lastRole: 'user' as const,
      }]),
      getRecentMessages: vi.fn(() => []),
      renderActiveCoreMemoryBlock: vi.fn(() => {
        throw new Error('core-memory store unreadable');
      }),
    };

    await expect(hydrateStartupContinuity({
      memoryProvider: null,
      wikiRetrieval: null,
      sessionManager,
      wikiHydrationTuning: WIKI_HYDRATION_TUNING,
    })).rejects.toThrow(
      'Startup continuity hydration failed: active core memory [discord:restored: core-memory store unreadable]',
    );
  });

  it('is awaited by the agent entrypoint before later runtime wiring', () => {
    const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const hydrationIndex = mainSource.indexOf('await hydrateStartupContinuity({');
    const internalStateWiringIndex = mainSource.indexOf('agentLoop.setInternalStateStore(');

    expect(hydrationIndex).toBeGreaterThan(-1);
    expect(hydrationIndex).toBeLessThan(internalStateWiringIndex);
    expect(mainSource).not.toContain("log.warn('Startup active memory hydration failed'");
    expect(mainSource).not.toContain("log.warn('Startup active core-memory hydration failed'");
    expect(mainSource).toContain(
      'wikiHydrationTuning: requireWikiStartupHydrationTuning(',
    );
  });
});
