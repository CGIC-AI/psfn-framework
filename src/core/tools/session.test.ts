import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Value } from '@sinclair/typebox/value';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  readLastActiveSession,
  writeLastActiveSession,
} from '../../system/lifecycle/notifications.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../session/manager.js';
import { createSessionTool, type UnifiedSessionToolOptions } from './session.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';

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

function makeSessionToolForNewAction(
  dataDir: string,
  overrides: Partial<UnifiedSessionToolOptions> = {},
): ReturnType<typeof createSessionTool> {
  return createSessionTool({
    manager: {} as SessionManager,
    llmProvider: { complete: vi.fn() } as any,
    sessionsDir: join(dataDir, 'sessions'),
    dataDir,
    ...overrides,
  });
}

describe('session tool action=new', () => {
  it('creates a new session and switches active context', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'session-new-tool-'));
    try {
      writeLastActiveSession(dataDir, {
        sessionId: 'discord:old-session',
        channelType: 'discord',
        timestamp: 1_700_000_000_000,
      });

      const seeded: string[] = [];
      const setActiveSession = vi.fn();
      const tool = makeSessionToolForNewAction(dataDir, {
        now: () => 1_700_000_000_123,
        idFactory: () => 'api:session-test-01',
        seedSession: (sessionId) => {
          seeded.push(sessionId);
        },
        setActiveSession,
      });

      const result = await tool.execute('call-1', { action: 'new' });
      const details = result.details as {
        action: string;
        previousSessionId: string | null;
        newSessionId: string;
        newChannelType: string;
        switched: boolean;
      };

      expect(toolText(result as any)).toContain('session action="new": active context switched');
      expect(details.action).toBe('new');
      expect(details.previousSessionId).toBe('discord:old-session');
      expect(details.newSessionId).toBe('api:session-test-01');
      expect(details.newChannelType).toBe('api');
      expect(details.switched).toBe(true);
      expect(seeded).toEqual(['api:session-test-01']);
      expect(setActiveSession).toHaveBeenCalledWith('api:session-test-01');

      const active = readLastActiveSession(dataDir);
      expect(active?.sessionId).toBe('api:session-test-01');
      expect(active?.channelType).toBe('api');
      expect(active?.timestamp).toBe(1_700_000_000_123);
    } finally {
      await new Promise(resolve => setTimeout(resolve, 5));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('accepts previous session hint via metadata', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'session-new-tool-metadata-'));
    try {
      const tool = makeSessionToolForNewAction(dataDir, {
        now: () => 1_700_000_000_500,
        idFactory: () => 'api:session-test-02',
      });

      const result = await tool.execute('call-2', {
        action: 'new',
        metadata: {
          previousSessionId: 'api:hinted-session',
          previousChannelType: 'api',
          source: 'test',
        },
      });
      const details = result.details as {
        previousSessionId: string | null;
        previousChannelType: string | null;
        newSessionId: string;
      };

      expect(details.previousSessionId).toBe('api:hinted-session');
      expect(details.previousChannelType).toBe('api');
      expect(details.newSessionId).toBe('api:session-test-02');
    } finally {
      await new Promise(resolve => setTimeout(resolve, 5));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed when invoked from background continuation context', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'session-new-tool-background-'));
    try {
      const setActiveSession = vi.fn();
      const tool = makeSessionToolForNewAction(dataDir, {
        now: () => 1_700_000_000_900,
        idFactory: () => 'api:session-test-bg',
        setActiveSession,
      });

      const result = await runWithRequestContext(
        {
          callType: 'background',
          purpose: 'agent.background.continuation',
        },
        () => tool.execute('call-bg-1', { action: 'new' }),
      );

      expect(toolText(result as any)).toContain('session action="new" is unavailable during background continuation execution');
      expect((result.details as { isError?: boolean }).isError).toBe(true);
      expect(setActiveSession).not.toHaveBeenCalled();
    } finally {
      await new Promise(resolve => setTimeout(resolve, 5));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('session tool list/resume actions', () => {
  let dir: string;
  let store: SessionStore;
  let manager: SessionManager;

  function makeTool(overrides: Partial<UnifiedSessionToolOptions> = {}): ReturnType<typeof createSessionTool> {
    return createSessionTool({
      manager,
      llmProvider: { complete: vi.fn() } as any,
      sessionsDir: join(dir, 'sessions'),
      dataDir: dir,
      ...overrides,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-session-tools-'));
    store = new SessionStore(join(dir, 'sessions'));
    manager = new SessionManager(store, makeConfig({ dataDir: dir }));
  });

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  });

  it('session_list orders sessions by recent activity and includes metadata', async () => {
    store.append({
      channelId: 'api:b-session',
      role: 'assistant',
      content: 'B latest',
      timestamp: 3_000,
    });
    store.append({
      channelId: 'api:a-session',
      role: 'user',
      content: 'A latest',
      authorId: 'u1',
      authorName: 'Alice',
      timestamp: 3_000,
    });
    store.append({
      channelId: 'api:c-session',
      role: 'assistant',
      content: 'C older',
      timestamp: 1_000,
    });

    manager.setActiveContextSession('api:b-session');
    const tool = makeTool();
    const result = await tool.execute('list-1', { action: 'list', limit: 10 });
    const payload = JSON.parse(toolText(result)) as {
      activeSessionId: string | null;
      count: number;
      sessions: Array<{
        sessionId: string;
        lastActivityAt: number;
        messageCount: number;
        lastRole: string;
        lastAuthorName: string | null;
        lastMessagePreview: string;
        isActive: boolean;
      }>;
    };

    expect(payload.activeSessionId).toBe('api:b-session');
    expect(payload.count).toBe(3);
    expect(payload.sessions.map(session => session.sessionId)).toEqual([
      'api:a-session',
      'api:b-session',
      'api:c-session',
    ]);
    expect(payload.sessions[0].lastActivityAt).toBe(3_000);
    expect(payload.sessions[0].messageCount).toBe(1);
    expect(payload.sessions[0].lastRole).toBe('user');
    expect(payload.sessions[0].lastAuthorName).toBe('Alice');
    expect(payload.sessions[0].lastMessagePreview).toBe('A latest');
    expect(payload.sessions[1].isActive).toBe(true);
  });

  it('session_resume rejects unknown session IDs', async () => {
    const tool = makeTool();
    const result = await tool.execute('resume-1', { action: 'resume', sessionId: 'api:missing' });

    expect(toolText(result)).toContain('Session not found: api:missing');
    expect((result.details as { isError?: boolean }).isError).toBe(true);
  });

  it('session_resume switches active context and subsequent turns use the resumed session', async () => {
    store.append({
      channelId: 'api:session-one',
      role: 'assistant',
      content: 'session one',
      timestamp: 1_000,
    });
    store.append({
      channelId: 'api:session-two',
      role: 'assistant',
      content: 'session two',
      timestamp: 2_000,
    });
    manager.setActiveContextSession('api:session-one');

    const tool = makeTool({ now: () => 9_999 });
    const result = await tool.execute('resume-2', { action: 'resume', sessionId: 'api:session-two' });
    const payload = JSON.parse(toolText(result)) as {
      resumed: boolean;
      previousSessionId: string | null;
      session: { sessionId: string };
    };

    expect(payload.resumed).toBe(true);
    expect(payload.previousSessionId).toBe('api:session-one');
    expect(payload.session.sessionId).toBe('api:session-two');
    expect(manager.getActiveContextSession()).toBe('api:session-two');

    const persisted = readLastActiveSession(dir);
    expect(persisted?.sessionId).toBe('api:session-two');
    expect(persisted?.timestamp).toBe(9_999);

    manager.recordUserMessage('api:transient-incoming', 'continued turn', 'u1', 'User');
    expect(store.count('api:transient-incoming')).toBe(0);
    expect(store.getLastEntry('api:session-two')?.content).toBe('continued turn');
  });

  it('session_resume rejects background continuation context to avoid session leakage', async () => {
    store.append({
      channelId: 'api:session-one',
      role: 'assistant',
      content: 'session one',
      timestamp: 1_000,
    });
    store.append({
      channelId: 'api:session-two',
      role: 'assistant',
      content: 'session two',
      timestamp: 2_000,
    });
    manager.setActiveContextSession('api:session-one');

    const tool = makeTool({ now: () => 10_001 });
    const result = await runWithRequestContext(
      {
        callType: 'background',
        purpose: 'deferred_tool_handoff',
      },
      () => tool.execute('resume-bg-1', { action: 'resume', sessionId: 'api:session-two' }),
    );

    expect(toolText(result)).toContain('session action="resume" is unavailable during background continuation execution');
    expect((result.details as { isError?: boolean }).isError).toBe(true);
    expect(manager.getActiveContextSession()).toBe('api:session-one');
  });
});

describe('unified session tool', () => {

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

  let dir: string;
  let store: SessionStore;
  let manager: SessionManager;
  let transcriptSearch: InMemoryTranscriptSearch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-session-unified-tools-'));
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

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  });

  it('defaults to list and dispatches new/resume actions through one tool surface', async () => {
    store.append({
      channelId: 'api:session-one',
      role: 'assistant',
      content: 'session one',
      timestamp: 1_000,
    });
    store.append({
      channelId: 'api:session-two',
      role: 'assistant',
      content: 'session two',
      timestamp: 2_000,
    });
    manager.setActiveContextSession('api:session-one');
    writeLastActiveSession(dir, {
      sessionId: 'api:session-one',
      channelType: 'api',
      timestamp: 8_000,
    });

    const tool = createSessionTool({
      manager,
      llmProvider: {
        complete: vi.fn(async () => ({
          content: 'unused',
          toolCalls: [],
          model: 'mock',
          inputTokens: 1,
          outputTokens: 1,
          stopReason: 'stop',
        })),
      } as any,
      sessionsDir: join(dir, 'sessions'),
      dataDir: dir,
      now: () => 9_999,
      idFactory: () => 'api:session-unified-new',
      setActiveSession: (sessionId) => manager.setActiveContextSession(sessionId),
      seedSession: (sessionId) => {
        manager.appendSystemNote(sessionId, 'Session initialized via session action=new.');
      },
    });

    expect(tool.name).toBe('session');
    expect(tool.label).toBe('session');
    expect(tool.description).toContain('action=list returns exact sessionId values');
    expect(tool.description).toContain('action=search requires query');
    expect(tool.description).toContain('action=grep requires pattern');
    expect(tool.description).toContain('action=resume requires a sessionId from list/search');
    expect(tool.description).toContain('action=wake_return requires summary');
    expect(Value.Check((tool as any).parameters, { action: 'session_resume', sessionId: 'api:session-two' })).toBe(false);
    expect(Value.Check((tool as any).parameters, { action: 'focus_start', scope: 'diagnose' })).toBe(false);

    const listed = await tool.execute('session-list', {});
    const listedPayload = JSON.parse(toolText(listed)) as {
      activeSessionId: string | null;
      sessions: Array<{ sessionId: string }>;
    };
    expect(listedPayload.activeSessionId).toBe('api:session-one');
    expect(listedPayload.sessions.map((session) => session.sessionId)).toEqual([
      'api:session-two',
      'api:session-one',
    ]);

    const created = await tool.execute('session-new', { action: 'new' });
    const createdDetails = created.details as {
      newSessionId: string;
      previousSessionId: string | null;
    };
    expect(createdDetails.previousSessionId).toBe('api:session-one');
    expect(createdDetails.newSessionId).toBe('api:session-unified-new');
    expect(store.getLastEntry('api:session-unified-new')?.content).toBe('Session initialized via session action=new.');

    const resumed = await tool.execute('session-resume', {
      action: 'resume',
      sessionId: 'api:session-two',
    });
    const resumedPayload = JSON.parse(toolText(resumed)) as {
      resumed: boolean;
      previousSessionId: string | null;
      session: { sessionId: string };
    };
    expect(resumedPayload.resumed).toBe(true);
    expect(resumedPayload.previousSessionId).toBe('api:session-unified-new');
    expect(resumedPayload.session.sessionId).toBe('api:session-two');
    expect(manager.getActiveContextSession()).toBe('api:session-two');
  });

  it('records wake-return continuity artifacts through the unified tool', async () => {
    store.append({
      channelId: 'api:session-one',
      role: 'assistant',
      content: 'We paused mid-refactor.',
      timestamp: 1_000,
    });
    manager.setActiveContextSession('api:session-one');

    const tool = createSessionTool({
      manager,
      llmProvider: {
        complete: vi.fn(async () => ({
          content: 'unused',
          toolCalls: [],
          model: 'mock',
          inputTokens: 1,
          outputTokens: 1,
          stopReason: 'stop',
        })),
      } as any,
      sessionsDir: join(dir, 'sessions'),
      dataDir: dir,
      now: () => Date.parse('2026-04-01T12:00:00.000Z'),
    });

    expect(Value.Check((tool as any).parameters, {
      action: 'wake_return',
      summary: 'Paused mid-refactor with tests still pending.',
      nextAnchor: 'Resume with the runtime-context test.',
      facets: ['task'],
    })).toBe(true);

    const result = await tool.execute('session-wake-return', {
      action: 'wake_return',
      summary: 'Paused mid-refactor with tests still pending.',
      nextAnchor: 'Resume with the runtime-context test.',
      facets: ['task'],
    });
    const payload = JSON.parse(toolText(result)) as {
      action: string;
      recorded: boolean;
      artifact: {
        sessionId: string;
        kind: string;
        occasion: string;
        summary: string;
        nextAnchor: string;
        createdAt: string;
      };
    };

    expect(payload).toMatchObject({
      action: 'wake_return',
      recorded: true,
      artifact: {
        sessionId: 'api:session-one',
        kind: 'wake_return',
        occasion: 'return',
        summary: 'Paused mid-refactor with tests still pending.',
        nextAnchor: 'Resume with the runtime-context test.',
        createdAt: '2026-04-01T12:00:00.000Z',
      },
    });
    expect(manager.listSessionContinuityArtifacts('api:session-one', { kind: 'wake_return' })[0])
      .toMatchObject(payload.artifact);
  });

  it('dispatches transcript lookup actions through the unified tool', async () => {
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

    const runRipgrep = vi.fn(async () => ({
      matches: [{
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
      }],
      truncated: false,
    }));
    const llmProvider = {
      complete: vi.fn(async () => ({
        content: 'Scoped Orion summary.',
        toolCalls: [],
        model: 'mock',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      })),
    } as any;
    const tool = createSessionTool({
      manager,
      llmProvider,
      sessionsDir: join(dir, 'sessions'),
      runRipgrep,
      dataDir: dir,
    });

    const searchResult = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-search', {
        action: 'search',
        query: 'Project Orion',
        summarize: true,
      }),
    );
    const searchPayload = JSON.parse(toolText(searchResult)) as {
      totalHits: number;
      gatedOutCount: number;
      summary: string;
      hits: Array<{ channelId: string }>;
    };
    expect(searchPayload.totalHits).toBe(2);
    expect(searchPayload.gatedOutCount).toBe(1);
    expect(searchPayload.hits.map((hit) => hit.channelId)).toEqual(['api:public-session']);
    expect(searchPayload.summary).toBe('Scoped Orion summary.');

    const grepResult = await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn.prompt',
        channelId: 'api:public-search',
        viewerTrustLevel: 'regular',
        viewerChannelPrivacy: 'public',
      },
      () => tool.execute('session-grep', {
        action: 'grep',
        pattern: 'Orion launch date',
      }),
    );
    const grepPayload = JSON.parse(toolText(grepResult)) as {
      hits: Array<{ channelId: string; snippet: string }>;
    };
    expect(runRipgrep).toHaveBeenCalledTimes(1);
    expect(grepPayload.hits).toHaveLength(1);
    expect(grepPayload.hits[0]?.channelId).toBe('api:public-session');
    expect(grepPayload.hits[0]?.snippet).toContain('Orion launch date');
  });

  it('dispatches focus lifecycle actions through the unified tool', async () => {
    const llmProvider = {
      complete: vi.fn(async () => ({
        content: 'Focus Summary\n- Captured actionable findings from diagnostics.\nOpen questions: none',
        toolCalls: [],
        model: 'mock-context',
        inputTokens: 25,
        outputTokens: 30,
        stopReason: 'stop',
      })),
    } as any;
    const tool = createSessionTool({
      manager,
      llmProvider,
      sessionsDir: join(dir, 'sessions'),
      dataDir: dir,
    });

    store.append({
      channelId: 'api:focus-context',
      role: 'user',
      content: 'Pre-focus baseline context should remain.',
      authorId: 'u1',
      authorName: 'User',
      timestamp: 1_000,
    });

    const started = await runWithRequestContext(
      { callType: 'tool', purpose: 'agent.turn', channelId: 'api:focus-context' },
      () => tool.execute('focus-start', {
        action: 'start_focus',
        scope: 'Diagnose context compaction behavior',
      }),
    );
    expect(toolText(started as any)).toContain('start_focus: tracking');

    store.append({
      channelId: 'api:focus-context',
      role: 'assistant',
      content: 'Focus step finding to compact later.',
      timestamp: 2_000,
    });
    manager.recordFocusEvidence('api:focus-context', [{
      source: 'llm_query',
      query: 'compaction threshold',
      snippet: 'Compaction should aggressively collapse old context after focus completion.',
      resultCount: 1,
      timestamp: 3_000,
    }]);

    const completed = await runWithRequestContext(
      { callType: 'tool', purpose: 'agent.turn', channelId: 'api:focus-context', requestId: 'req-focus-2' },
      () => tool.execute('focus-complete', {
        action: 'complete_focus',
        conclusion: 'Persist the durable finding and compact the raw focused range.',
      }),
    );
    expect(toolText(completed as any)).toContain('complete_focus: persisted knowledge block');
    expect((llmProvider.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
