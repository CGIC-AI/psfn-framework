import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SubstrateConfig } from '../types.js';
import { SessionStore } from '../session/store.js';
import { SessionManager } from '../session/manager.js';
import { readLastActiveSession } from '../lifecycle/notifications.js';
import { createSessionListTool, createSessionResumeTool } from './session.js';

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
    memoryBudgetPct: 20,
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

describe('session tools', () => {
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
});
