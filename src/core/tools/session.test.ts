import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  readLastActiveSession,
  writeLastActiveSession,
} from '../../system/lifecycle/notifications.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../session/manager.js';
import {
  createSessionListTool,
  createSessionNewTool,
  createSessionResumeTool,
} from './session.js';
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

describe('session_new tool', () => {
  it('exposes expected metadata', () => {
    const tool = createSessionNewTool({ dataDir: '/tmp' });
    expect(tool.name).toBe('session_new');
    expect(tool.label).toBe('session_new');
    expect(tool.description.toLowerCase()).toContain('session');
    expect(tool.parameters).toBeDefined();
  });

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
      const tool = createSessionNewTool({
        dataDir,
        now: () => 1_700_000_000_123,
        idFactory: () => 'api:session-test-01',
        seedSession: (sessionId) => {
          seeded.push(sessionId);
        },
        setActiveSession,
      });

      const result = await tool.execute('call-1', {});
      const details = result.details as {
        previousSessionId: string | null;
        newSessionId: string;
        newChannelType: string;
        switched: boolean;
      };

      expect(toolText(result as any)).toContain('session_new: active context switched');
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
      const tool = createSessionNewTool({
        dataDir,
        now: () => 1_700_000_000_500,
        idFactory: () => 'api:session-test-02',
      });

      const result = await tool.execute('call-2', {
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
      const tool = createSessionNewTool({
        dataDir,
        now: () => 1_700_000_000_900,
        idFactory: () => 'api:session-test-bg',
        setActiveSession,
      });

      const result = await runWithRequestContext(
        {
          callType: 'background',
          purpose: 'agent.background.continuation',
        },
        () => tool.execute('call-bg-1', {}),
      );

      expect(toolText(result as any)).toContain('session_new is unavailable during background continuation execution');
      expect((result.details as { isError?: boolean }).isError).toBe(true);
      expect(setActiveSession).not.toHaveBeenCalled();
    } finally {
      await new Promise(resolve => setTimeout(resolve, 5));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('session list/resume tools', () => {
  let dir: string;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-session-tools-'));
    store = new SessionStore(join(dir, 'sessions'));
    manager = new SessionManager(store, makeConfig({ dataDir: dir }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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
    const tool = createSessionListTool(manager, { dataDir: dir });
    const result = await tool.execute('list-1', { limit: 10 });
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
    const tool = createSessionResumeTool(manager, { dataDir: dir });
    const result = await tool.execute('resume-1', { sessionId: 'api:missing' });

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

    const tool = createSessionResumeTool(manager, { dataDir: dir, now: () => 9_999 });
    const result = await tool.execute('resume-2', { sessionId: 'api:session-two' });
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

    const tool = createSessionResumeTool(manager, { dataDir: dir, now: () => 10_001 });
    const result = await runWithRequestContext(
      {
        callType: 'background',
        purpose: 'deferred_tool_handoff',
      },
      () => tool.execute('resume-bg-1', { sessionId: 'api:session-two' }),
    );

    expect(toolText(result)).toContain('session_resume is unavailable during background continuation execution');
    expect((result.details as { isError?: boolean }).isError).toBe(true);
    expect(manager.getActiveContextSession()).toBe('api:session-one');
  });
});
