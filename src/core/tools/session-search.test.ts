import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../session/manager.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { fromPartial } from '@total-typescript/shoehorn';
import { createSessionTool } from './session.js';
import { buildCompactionSourceHashTag } from '../session/compaction-audit.js';
import type { TranscriptSearchOptions } from '../../persistence/sessions/transcript-projection-port.js';
import type { LLMProviderPort } from '../agent/contracts.js';

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 1000 },
    },
    ...overrides,
  };
}

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(entry => entry.text).join('');
}


class InMemoryTranscriptSearch {
  private readonly entries: Array<{
    messageId: number;
    channelId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    timestamp: number;
    channelVisibility: 'private' | 'invite_only' | 'public' | 'broadcast';
  }> = [];

  record(entry: {
    messageId: number;
    channelId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    timestamp: number;
    channelVisibility: 'private' | 'invite_only' | 'public' | 'broadcast';
  }): void {
    this.entries.push(entry);
  }

  async searchByKeywords(query: string, limit = 10, options: TranscriptSearchOptions = {}) {
    const needle = query.toLowerCase();
    return this.entries
      .filter(entry => (
        entry.content.toLowerCase().includes(needle)
        && (!options.channelId || entry.channelId === options.channelId)
        && (options.firstMessageId === undefined || entry.messageId >= options.firstMessageId)
        && (options.lastMessageId === undefined || entry.messageId <= options.lastMessageId)
      ))
      .slice(0, limit)
      .map((entry) => ({
        channelId: entry.channelId,
        messageId: entry.messageId,
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp,
        channelVisibility: entry.channelVisibility,
        score: 1,
        snippet: entry.content,
      }));
  }
}

describe('session search tools', () => {
  let dir: string;
  let store: SessionStore;
  let manager: SessionManager;
  let transcriptSearch: InMemoryTranscriptSearch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-session-search-tools-'));
    store = new SessionStore(join(dir, 'sessions'));
    transcriptSearch = new InMemoryTranscriptSearch();
    const originalAppend = store.append.bind(store);
    store.append = ((entry: Parameters<SessionStore['append']>[0]) => {
      const messageId = originalAppend(entry);
      transcriptSearch.record({
        messageId,
        channelId: entry.channelId,
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp,
        channelVisibility: entry.channelVisibility,
      });
      return messageId;
    }) as SessionStore['append'];
    manager = new SessionManager(store, makeConfig({ dataDir: dir }), undefined, undefined, transcriptSearch);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeTool(
    llmProvider: LLMProviderPort,
    runRipgrep?: Parameters<typeof createSessionTool>[0]['runRipgrep'],
  ): ReturnType<typeof createSessionTool> {
    return createSessionTool({
      manager,
      llmProvider,
      sessionsDir: join(dir, 'sessions'),
      dataDir: dir,
      ...(runRipgrep ? { runRipgrep } : {}),
    });
  }

  function seedAddressableCompaction(channelId: string): {
    firstMessageId: number;
    lastMessageId: number;
    outsideMessageId: number;
  } {
    const firstMessageId = store.append({
      channelId,
      role: 'user',
      content: 'Bounded needle inside the compacted source.',
      timestamp: 1_000,
      channelVisibility: 'private',
    });
    store.append({
      channelId,
      role: 'assistant',
      content: 'A reply inside the compacted source.',
      timestamp: 2_000,
      channelVisibility: 'private',
    });
    store.append({
      channelId,
      role: 'tool',
      content: 'Tool detail inside the compacted source.',
      timestamp: 3_000,
      channelVisibility: 'private',
    });
    const lastMessageId = store.append({
      channelId,
      role: 'assistant',
      content: 'The final compacted-source reply.',
      timestamp: 4_000,
      channelVisibility: 'private',
    });
    const sourceEntries = store.getEntriesInRange(channelId, firstMessageId, lastMessageId);
    store.insertCompaction(
      channelId,
      `Durable summary.\n\n${buildCompactionSourceHashTag(sourceEntries)}`,
      lastMessageId,
    );
    const outsideMessageId = store.append({
      channelId,
      role: 'user',
      content: 'Bounded needle after the compacted source.',
      timestamp: 6_000,
      channelVisibility: 'private',
    });
    return { firstMessageId, lastMessageId, outsideMessageId };
  }

  it('searches only the verified latest compaction source for the active channel', async () => {
    const channelId = 'api:bounded-search';
    const range = seedAddressableCompaction(channelId);
    const tool = makeTool(fromPartial({ complete: vi.fn() }));

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId,
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-bounded', {
        action: 'search',
        query: 'Bounded needle',
        within: 'latest_compaction_source',
      }),
    );
    const payload = JSON.parse(toolText(result)) as {
      within: string;
      source: { firstMessageId: number; lastMessageId: number; verified: boolean };
      hits: Array<{ messageId: number; snippet: string }>;
    };

    expect(payload.within).toBe('latest_compaction_source');
    expect(payload.source).toMatchObject({
      firstMessageId: range.firstMessageId,
      lastMessageId: range.lastMessageId,
      verified: true,
    });
    expect(payload.hits.map(hit => hit.messageId)).toEqual([range.firstMessageId]);
    expect(payload.hits.some(hit => hit.messageId === range.outsideMessageId)).toBe(false);
  });

  it('filters raw grep matches to the same verified compaction source range', async () => {
    const channelId = 'api:bounded-grep';
    const range = seedAddressableCompaction(channelId);
    const asMatch = (id: number, matchedChannelId = channelId) => ({
      filePath: 'bounded.jsonl',
      lineNumber: id,
      lineText: JSON.stringify({
        type: 'message',
        id,
        channelId: matchedChannelId,
        role: 'user',
        content: 'Bounded needle raw match.',
        timestamp: id * 1_000,
        channelVisibility: 'private',
      }),
    });
    const runRipgrep = vi.fn(async () => ({
      matches: [
        asMatch(range.firstMessageId),
        asMatch(range.outsideMessageId),
        asMatch(range.firstMessageId, 'api:other'),
      ],
      truncated: false,
    }));
    const tool = makeTool(fromPartial({ complete: vi.fn() }), runRipgrep);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId,
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-grep-bounded', {
        action: 'grep',
        pattern: 'Bounded needle',
        within: 'latest_compaction_source',
      }),
    );
    const payload = JSON.parse(toolText(result)) as {
      source: { verified: boolean };
      hits: Array<{ channelId: string; messageId: number }>;
    };

    expect(runRipgrep).toHaveBeenCalledWith(expect.objectContaining({
      channelId,
      firstMessageId: range.firstMessageId,
      lastMessageId: range.lastMessageId,
    }));
    expect(payload.source.verified).toBe(true);
    expect(payload.hits).toEqual([
      expect.objectContaining({ channelId, messageId: range.firstMessageId }),
    ]);
  });

  it('denies cross-channel latest-compaction source requests before search', async () => {
    seedAddressableCompaction('api:other-source');
    const tool = makeTool(fromPartial({ complete: vi.fn() }));

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:current-source',
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-cross-channel', {
        action: 'search',
        query: 'Bounded needle',
        channelId: 'api:other-source',
        within: 'latest_compaction_source',
      }),
    );
    const payload = JSON.parse(toolText(result)) as { sourceStatus: string; hits: unknown[] };

    expect(payload.sourceStatus).toBe('access_denied');
    expect(payload.hits).toEqual([]);
    expect((result.details as { isError?: boolean }).isError).toBe(true);
  });

  it('reports legacy latest summaries without searching a wider range', async () => {
    const channelId = 'api:legacy-source';
    const coveredUpTo = store.append({
      channelId,
      role: 'user',
      content: 'Legacy bounded needle.',
      timestamp: 1_000,
      channelVisibility: 'private',
    });
    store.insertCompaction(channelId, 'Legacy summary.', coveredUpTo);
    const tool = makeTool(fromPartial({ complete: vi.fn() }));

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId,
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-legacy', {
        action: 'search',
        query: 'Legacy bounded needle',
        within: 'latest_compaction_source',
      }),
    );
    const payload = JSON.parse(toolText(result)) as { sourceStatus: string; hits: unknown[] };

    expect(payload.sourceStatus).toBe('legacy_metadata');
    expect(payload.hits).toEqual([]);
  });

  it('session_search uses the indexed transcript path and gates hits by caller privacy', async () => {
    store.append({
      channelId: 'api:public-session',
      role: 'assistant',
      content: 'Project Orion is on the public roadmap.',
      timestamp: 1_000,
      channelVisibility: 'public',
    });
    store.append({
      channelId: 'api:private-session',
      role: 'assistant',
      content: 'Project Orion includes private deployment details.',
      timestamp: 2_000,
      channelVisibility: 'private',
    });

    const llmProvider = fromPartial({
      complete: vi.fn(async () => ({
        content: 'Model summary should not be used.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    });
    const tool = makeTool(llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-search-1', { action: 'search', query: 'Project Orion' }),
    );
    const payload = JSON.parse(toolText(result)) as {
      totalHits: number;
      gatedOutCount: number;
      summary: string;
      hits: Array<{ channelId: string; snippet: string }>;
    };

    expect(payload.totalHits).toBe(2);
    expect(payload.gatedOutCount).toBe(1);
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0]?.channelId).toBe('api:public-session');
    expect(payload.hits[0]?.snippet).toContain('Orion');
    expect(payload.summary).toContain('Found 1 transcript matches');
    expect(llmProvider.complete).not.toHaveBeenCalled();
  });

  it('session_search excludes CogSec tombstone hits even when the search port returns them', async () => {
    transcriptSearch.record({
      messageId: 1,
      channelId: 'api:cogsec-search',
      role: 'user',
      content: '[CogSec redaction: cogsec_20260701T000000Z_search]',
      timestamp: 1_000,
      channelVisibility: 'public',
    });
    transcriptSearch.record({
      messageId: 2,
      channelId: 'api:normal-search',
      role: 'assistant',
      content: 'Normal CogSec planning note without a tombstone marker.',
      timestamp: 2_000,
      channelVisibility: 'public',
    });

    const llmProvider = fromPartial({
      complete: vi.fn(async () => ({
        content: 'Model summary should not be used.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    });
    const tool = makeTool(llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-search-cogsec', { action: 'search', query: 'CogSec' }),
    );
    const payload = JSON.parse(toolText(result)) as {
      totalHits: number;
      hits: Array<{ channelId: string; snippet: string }>;
    };

    expect(payload.totalHits).toBe(1);
    expect(payload.hits).toEqual([
      expect.objectContaining({
        channelId: 'api:normal-search',
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain('cogsec_20260701T000000Z_search');
  });

  it('session_search can summarize and scope to a specific channel', async () => {
    store.append({
      channelId: 'api:alpha',
      role: 'assistant',
      content: 'Pegasus alpha note with sensitive rollout details.',
      timestamp: 3_000,
      channelVisibility: 'private',
    });
    store.append({
      channelId: 'api:beta',
      role: 'assistant',
      content: 'Pegasus beta note that should be filtered by channel scope.',
      timestamp: 4_000,
      channelVisibility: 'private',
    });

    const llmProvider = fromPartial({
      complete: vi.fn(async () => ({
        content: 'Scoped Pegasus summary.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    });
    const tool = makeTool(llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:private-search',
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-2', {
        action: 'search',
        query: 'Pegasus',
        channelId: 'api:alpha',
        summarize: true,
      }),
    );
    const payload = JSON.parse(toolText(result)) as {
      totalHits: number;
      gatedOutCount: number;
      summary: string;
      hits: Array<{ channelId: string }>;
    };

    expect(payload.totalHits).toBe(1);
    expect(payload.gatedOutCount).toBe(0);
    expect(payload.hits.map(hit => hit.channelId)).toEqual(['api:alpha']);
    expect(payload.summary).toBe('Scoped Pegasus summary.');
    expect(llmProvider.complete).toHaveBeenCalledTimes(1);
  });

  it('propagates turn cancellation through a running session-search summary', async () => {
    store.append({
      channelId: 'api:abortable-search',
      role: 'assistant',
      content: 'Needle for a deliberately long session summary.',
      timestamp: 5_000,
      channelVisibility: 'private',
    });

    let markCompletionStarted: () => void = () => {};
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    const llmProvider = fromPartial({
      complete: vi.fn(async (
        _context: unknown,
        _purpose: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        markCompletionStarted();
        await new Promise<never>((_resolve, reject) => {
          const rejectAborted = (): void => reject(
            options?.signal?.reason ?? new Error('summary aborted'),
          );
          if (options?.signal?.aborted) {
            rejectAborted();
            return;
          }
          options?.signal?.addEventListener('abort', rejectAborted, { once: true });
        });
      }),
    });
    const tool = makeTool(llmProvider);
    const controller = new AbortController();
    const budgetError = new Error('parent turn continuation budget exhausted');

    const resultPromise = runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:abortable-search',
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-abort', {
        action: 'search',
        query: 'deliberately long',
        summarize: true,
      }, controller.signal),
    );

    await completionStarted;
    controller.abort(budgetError);

    await expect(resultPromise).rejects.toBe(budgetError);
    expect(llmProvider.complete).toHaveBeenCalledTimes(1);
    // mmo9.7.1: the summary now also carries a work spec + correlation alongside
    // the caller signal in the completion options.
    expect(llmProvider.complete.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('session_search requires a non-empty query through the canonical surface', async () => {
    const llmProvider = fromPartial({
      complete: vi.fn(),
    });
    const tool = makeTool(llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:alias-search',
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-3', { action: 'search' }),
    );

    expect(toolText(result)).toContain('session_search requires a non-empty query.');
    expect((result.details as { isError?: boolean }).isError).toBe(true);
    expect(llmProvider.complete).not.toHaveBeenCalled();
  });

  it('session_search labels retired and active logical session route hits for audit', async () => {
    const sourceChannelId = 'discord:garden:room';
    manager.recordUserMessage(sourceChannelId, 'Route audit needle before reset.', 'vega-id', 'Vega', false);
    const reset = manager.resetSourceChannelSession({
      sourceChannelId,
      actor: 'operator',
      reason: 'audit label test',
      mode: 'break_glass_quarantine',
    });
    manager.recordUserMessage(sourceChannelId, 'Route audit needle after reset.', 'vega-id', 'Vega', false);

    const llmProvider = fromPartial({
      complete: vi.fn(async () => ({
        content: 'Route audit summary.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    });
    const tool = makeTool(llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: sourceChannelId,
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-routes', { action: 'search', query: 'Route audit needle', limit: 5 }),
    );
    const payload = JSON.parse(toolText(result)) as {
      hits: Array<{
        channelId: string;
        sessionRoute?: {
          sourceChannelId: string;
          activeLogicalSessionId: string;
          status: 'active' | 'retired';
          mode?: string;
          retiredAt?: string;
        };
      }>;
    };

    const oldHit = payload.hits.find(hit => hit.channelId === sourceChannelId);
    const freshHit = payload.hits.find(hit => hit.channelId === reset.newLogicalSessionId);
    expect(oldHit?.sessionRoute).toMatchObject({
      sourceChannelId,
      activeLogicalSessionId: reset.newLogicalSessionId,
      status: 'retired',
      mode: 'break_glass_quarantine',
    });
    expect(oldHit?.sessionRoute?.retiredAt).toBeTruthy();
    expect(freshHit?.sessionRoute).toMatchObject({
      sourceChannelId,
      activeLogicalSessionId: reset.newLogicalSessionId,
      status: 'active',
      mode: 'break_glass_quarantine',
    });
  });

  it('session_grep filters raw journal hits by caller privacy and returns structured matches', async () => {
    const runRipgrep = vi.fn(async () => ({
      matches: [
        {
          filePath: '20260325_api-public_user_000001.jsonl',
          lineNumber: 10,
          lineText: JSON.stringify({
            type: 'message',
            id: 7,
            channelId: 'api:public-session',
            role: 'assistant',
            content: 'Exact Orion launch date is still public.',
            timestamp: 5_000,
            channelVisibility: 'public',
            authorName: 'Purrsephone',
          }),
        },
        {
          filePath: '20260325_api-private_user_000002.jsonl',
          lineNumber: 14,
          lineText: JSON.stringify({
            type: 'message',
            id: 8,
            channelId: 'api:private-session',
            role: 'assistant',
            content: 'Exact Orion launch date and private checklist.',
            timestamp: 6_000,
            channelVisibility: 'private',
            authorName: 'Purrsephone',
          }),
        },
        {
          filePath: '20260325_api-public_user_000001.jsonl',
          lineNumber: 20,
          lineText: JSON.stringify({
            type: 'compaction',
            id: 9,
            channelId: 'api:public-session',
            summary: 'ignore this',
            timestamp: 6_500,
          }),
        },
      ],
      truncated: false,
    }));
    const tool = makeTool(fromPartial({ complete: vi.fn() }), runRipgrep);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-grep-1', { action: 'grep', pattern: 'Orion launch date' }),
    );
    const payload = JSON.parse(toolText(result)) as {
      truncated: boolean;
      scannedMatchCount: number;
      gatedOutCount: number;
      hits: Array<{ channelId: string; authorName?: string; snippet: string }>;
    };

    expect(runRipgrep).toHaveBeenCalledWith(expect.objectContaining({
      pattern: 'Orion launch date',
      mode: 'literal',
      caseSensitive: false,
      maxMatches: 60,
    }));
    expect(payload.truncated).toBe(false);
    expect(payload.scannedMatchCount).toBe(2);
    expect(payload.gatedOutCount).toBe(1);
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0]?.channelId).toBe('api:public-session');
    expect(payload.hits[0]?.authorName).toBe('Purrsephone');
    expect(payload.hits[0]?.snippet).toContain('Orion launch date');
  });

  it('session_grep excludes CogSec tombstone rows from normal companion results', async () => {
    const runRipgrep = vi.fn(async () => ({
      matches: [
        {
          filePath: '20260701_api-cogsec_user_000001.jsonl',
          lineNumber: 3,
          lineText: JSON.stringify({
            type: 'message',
            id: 1,
            channelId: 'api:cogsec-grep',
            role: 'user',
            content: '[CogSec redaction: cogsec_20260701T000000Z_grep]',
            metadata: JSON.stringify({
              kind: 'cogsec_l0_tombstone',
              caseId: 'cogsec_20260701T000000Z_grep',
              redactedAt: '2026-07-01T00:00:00.000Z',
            }),
            timestamp: 1_000,
            channelVisibility: 'public',
          }),
        },
        {
          filePath: '20260701_api-normal_user_000002.jsonl',
          lineNumber: 8,
          lineText: JSON.stringify({
            type: 'message',
            id: 2,
            channelId: 'api:normal-grep',
            role: 'assistant',
            content: 'Normal CogSec planning note without a tombstone marker.',
            timestamp: 2_000,
            channelVisibility: 'public',
          }),
        },
      ],
      truncated: false,
    }));
    const tool = makeTool(fromPartial({ complete: vi.fn() }), runRipgrep);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-grep-cogsec', { action: 'grep', pattern: 'CogSec' }),
    );
    const payload = JSON.parse(toolText(result)) as {
      scannedMatchCount: number;
      hits: Array<{ channelId: string; snippet: string }>;
    };

    expect(payload.scannedMatchCount).toBe(1);
    expect(payload.hits).toEqual([
      expect.objectContaining({
        channelId: 'api:normal-grep',
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain('cogsec_20260701T000000Z_grep');
  });

  it('session_grep labels retired logical session route hits for audit', async () => {
    const sourceChannelId = 'discord:garden:grep-room';
    const reset = manager.resetSourceChannelSession({
      sourceChannelId,
      actor: 'operator',
      reason: 'grep audit label test',
      mode: 'break_glass_quarantine',
    });
    const runRipgrep = vi.fn(async () => ({
      matches: [
        {
          filePath: '20260325_discord_garden_grep-room_000001.jsonl',
          lineNumber: 4,
          lineText: JSON.stringify({
            type: 'message',
            id: 4,
            channelId: sourceChannelId,
            role: 'user',
            content: 'Grep route needle before reset.',
            timestamp: 7_000,
            channelVisibility: 'private',
            authorName: 'Vega',
          }),
        },
      ],
      truncated: false,
    }));
    const tool = makeTool(fromPartial({ complete: vi.fn() }), runRipgrep);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: sourceChannelId,
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-grep-routes', { action: 'grep', pattern: 'Grep route needle' }),
    );
    const payload = JSON.parse(toolText(result)) as {
      hits: Array<{
        channelId: string;
        sessionRoute?: {
          sourceChannelId: string;
          activeLogicalSessionId: string;
          status: 'active' | 'retired';
          mode?: string;
          retiredAt?: string;
        };
      }>;
    };

    expect(payload.hits[0]?.sessionRoute).toMatchObject({
      sourceChannelId,
      activeLogicalSessionId: reset.newLogicalSessionId,
      status: 'retired',
      mode: 'break_glass_quarantine',
    });
    expect(payload.hits[0]?.sessionRoute?.retiredAt).toBeTruthy();
  });

  it('session_grep reports runner failures as tool errors', async () => {
    const tool = makeTool(fromPartial({ complete: vi.fn() }), vi.fn(async () => {
      throw new Error('rg executable not found');
    }));

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-grep-2', { action: 'grep', pattern: 'Orion' }),
    );

    expect(toolText(result)).toContain('session_grep failed: rg executable not found');
    expect((result.details as { isError?: boolean }).isError).toBe(true);
  });
});
