import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../session/manager.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { createSessionGrepTool, createSessionSearchTool } from './session-search.js';

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
    channelId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    timestamp: number;
    channelVisibility: 'private' | 'invite_only' | 'public' | 'broadcast';
  }> = [];

  record(entry: {
    channelId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    timestamp: number;
    channelVisibility: 'private' | 'invite_only' | 'public' | 'broadcast';
  }): void {
    this.entries.push(entry);
  }

  async searchByKeywords(query: string, limit = 10) {
    const needle = query.toLowerCase();
    return this.entries
      .filter(entry => entry.content.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((entry, index) => ({
        channelId: entry.channelId,
        messageId: index + 1,
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
      transcriptSearch.record({
        channelId: entry.channelId,
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp,
        channelVisibility: entry.channelVisibility,
      });
      return originalAppend(entry);
    }) as SessionStore['append'];
    manager = new SessionManager(store, makeConfig({ dataDir: dir }), undefined, undefined, transcriptSearch);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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

    const llmProvider = {
      complete: vi.fn(async () => ({
        content: 'Model summary should not be used.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    } as any;
    const tool = createSessionSearchTool(manager, llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-search-1', { query: 'Project Orion' }),
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
      channelId: 'api:cogsec-search',
      role: 'user',
      content: '[CogSec redaction: cogsec_20260701T000000Z_search]',
      timestamp: 1_000,
      channelVisibility: 'public',
    });
    transcriptSearch.record({
      channelId: 'api:normal-search',
      role: 'assistant',
      content: 'Normal CogSec planning note without a tombstone marker.',
      timestamp: 2_000,
      channelVisibility: 'public',
    });

    const llmProvider = {
      complete: vi.fn(async () => ({
        content: 'Model summary should not be used.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    } as any;
    const tool = createSessionSearchTool(manager, llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-search-cogsec', { query: 'CogSec' }),
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

    const llmProvider = {
      complete: vi.fn(async () => ({
        content: 'Scoped Pegasus summary.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    } as any;
    const tool = createSessionSearchTool(manager, llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:private-search',
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-2', {
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

  it('session_search accepts keyword as an alias for query', async () => {
    store.append({
      channelId: 'api:alias-test',
      role: 'assistant',
      content: 'Matrix verification note for alias coverage.',
      timestamp: 5_000,
      channelVisibility: 'private',
    });

    const llmProvider = {
      complete: vi.fn(async () => ({
        content: 'Alias summary should not be used.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    } as any;
    const tool = createSessionSearchTool(manager, llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:alias-search',
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-3', { keyword: 'Matrix verification' }),
    );
    const payload = JSON.parse(toolText(result)) as {
      totalHits: number;
      hits: Array<{ channelId: string; snippet: string }>;
    };

    expect(payload.totalHits).toBe(1);
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0]?.channelId).toBe('api:alias-test');
    expect(payload.hits[0]?.snippet).toContain('Matrix');
    expect(payload.hits[0]?.snippet).toContain('verification');
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

    const llmProvider = {
      complete: vi.fn(async () => ({
        content: 'Route audit summary.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    } as any;
    const tool = createSessionSearchTool(manager, llmProvider);

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: sourceChannelId,
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-search-routes', { query: 'Route audit needle', limit: 5 }),
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
    const tool = createSessionGrepTool({
      sessionsDir: join(dir, 'sessions'),
      runRipgrep,
    });

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-grep-1', { pattern: 'Orion launch date' }),
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
    const tool = createSessionGrepTool({
      sessionsDir: join(dir, 'sessions'),
      runRipgrep,
    });

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-grep-cogsec', { pattern: 'CogSec' }),
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
    const tool = createSessionGrepTool({
      sessionsDir: join(dir, 'sessions'),
      runRipgrep,
      sessionRouteState: manager,
    });

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: sourceChannelId,
        viewerTrustLevel: 'primary',
        viewerChannelPrivacy: 'private',
      },
      () => tool.execute('session-grep-routes', { pattern: 'Grep route needle' }),
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
    const tool = createSessionGrepTool({
      sessionsDir: join(dir, 'sessions'),
      runRipgrep: vi.fn(async () => {
        throw new Error('rg executable not found');
      }),
    });

    const result = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-grep-2', { pattern: 'Orion' }),
    );

    expect(toolText(result)).toContain('session_grep failed: rg executable not found');
    expect((result.details as { isError?: boolean }).isError).toBe(true);
  });
});
