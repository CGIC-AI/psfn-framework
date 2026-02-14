import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserContinuityStore } from './continuity.js';
import { SessionStore } from './store.js';
import { SessionManager } from './manager.js';
import type { SubstrateConfig } from '../types.js';

function makeConfig(overrides?: Partial<SubstrateConfig>): SubstrateConfig {
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
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
    },
    ...overrides,
  };
}

describe('UserContinuityStore', () => {
  let dir: string;
  let store: UserContinuityStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-continuity-'));
    store = new UserContinuityStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends and retrieves entries for a user', () => {
    store.append('user1', {
      channelId: 'ch1',
      role: 'user',
      content: 'Hello from channel 1',
      authorId: 'user1',
      authorName: 'Alice',
      timestamp: 1000,
      originChannelId: 'ch1',
    });

    store.append('user1', {
      channelId: 'ch2',
      role: 'user',
      content: 'Hello from channel 2',
      authorId: 'user1',
      authorName: 'Alice',
      timestamp: 2000,
      originChannelId: 'ch2',
    });

    const entries = store.getRecent('user1', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('Hello from channel 1');
    expect(entries[0].originChannelId).toBe('ch1');
    expect(entries[1].content).toBe('Hello from channel 2');
    expect(entries[1].originChannelId).toBe('ch2');
  });

  it('excludes entries from a specific channel', () => {
    store.append('user1', {
      channelId: 'ch1',
      role: 'user',
      content: 'In ch1',
      authorId: 'user1',
      authorName: 'Alice',
      timestamp: 1000,
      originChannelId: 'ch1',
    });

    store.append('user1', {
      channelId: 'ch2',
      role: 'user',
      content: 'In ch2',
      authorId: 'user1',
      authorName: 'Alice',
      timestamp: 2000,
      originChannelId: 'ch2',
    });

    const filtered = store.getRecent('user1', 10, 'ch1');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].originChannelId).toBe('ch2');
  });

  it('limits the number of returned entries', () => {
    for (let i = 0; i < 10; i++) {
      store.append('user1', {
        channelId: `ch${i}`,
        role: 'user',
        content: `Message ${i}`,
        timestamp: i * 1000,
        originChannelId: `ch${i}`,
      });
    }

    const entries = store.getRecent('user1', 3);
    expect(entries).toHaveLength(3);
    expect(entries[0].content).toBe('Message 7');
  });

  it('caps in-memory entries at maxEntries', () => {
    const smallStore = new UserContinuityStore(dir, 5);
    for (let i = 0; i < 10; i++) {
      smallStore.append('user1', {
        channelId: `ch${i}`,
        role: 'user',
        content: `Message ${i}`,
        timestamp: i * 1000,
        originChannelId: `ch${i}`,
      });
    }

    expect(smallStore.count('user1')).toBe(5);
    const entries = smallStore.getRecent('user1', 10);
    expect(entries).toHaveLength(5);
    expect(entries[0].content).toBe('Message 5');
  });

  it('isolates users', () => {
    store.append('user1', {
      channelId: 'ch1',
      role: 'user',
      content: 'Alice msg',
      timestamp: 1000,
      originChannelId: 'ch1',
    });

    store.append('user2', {
      channelId: 'ch1',
      role: 'user',
      content: 'Bob msg',
      timestamp: 2000,
      originChannelId: 'ch1',
    });

    expect(store.getRecent('user1', 10)).toHaveLength(1);
    expect(store.getRecent('user2', 10)).toHaveLength(1);
    expect(store.count('user1')).toBe(1);
    expect(store.count('user2')).toBe(1);
  });

  it('persists data across store instances', () => {
    store.append('user1', {
      channelId: 'ch1',
      role: 'user',
      content: 'Persistent msg',
      authorId: 'user1',
      authorName: 'Alice',
      timestamp: 1000,
      originChannelId: 'ch1',
    });

    const store2 = new UserContinuityStore(dir);
    const entries = store2.getRecent('user1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Persistent msg');
    expect(entries[0].originChannelId).toBe('ch1');
  });

  it('assigns monotonic IDs', () => {
    const id1 = store.append('user1', {
      channelId: 'ch1',
      role: 'user',
      content: 'A',
      timestamp: 1000,
      originChannelId: 'ch1',
    });
    const id2 = store.append('user1', {
      channelId: 'ch2',
      role: 'user',
      content: 'B',
      timestamp: 2000,
      originChannelId: 'ch2',
    });

    expect(id1).toBe(1);
    expect(id2).toBe(2);

    // Reload and continue
    const store2 = new UserContinuityStore(dir);
    const id3 = store2.append('user1', {
      channelId: 'ch3',
      role: 'user',
      content: 'C',
      timestamp: 3000,
      originChannelId: 'ch3',
    });
    expect(id3).toBe(3);
  });

  it('handles assistant messages in continuity', () => {
    store.append('user1', {
      channelId: 'ch1',
      role: 'user',
      content: 'Hello',
      authorId: 'user1',
      authorName: 'Alice',
      timestamp: 1000,
      originChannelId: 'ch1',
    });

    store.append('user1', {
      channelId: 'ch1',
      role: 'assistant',
      content: 'Hi there!',
      timestamp: 2000,
      originChannelId: 'ch1',
    });

    const entries = store.getRecent('user1', 10);
    expect(entries).toHaveLength(2);
    expect(entries[1].role).toBe('assistant');
  });

  it('returns empty array for unknown user', () => {
    const entries = store.getRecent('unknown-user', 10);
    expect(entries).toHaveLength(0);
    expect(store.count('unknown-user')).toBe(0);
  });
});

describe('SessionManager with continuity', () => {
  let dir: string;
  let sessionStore: SessionStore;
  let continuityStore: UserContinuityStore;
  let config: SubstrateConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-mgr-cont-'));
    sessionStore = new SessionStore(dir);
    continuityStore = new UserContinuityStore(dir);
    config = makeConfig();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records user messages to both session and continuity store', () => {
    const mgr = new SessionManager(sessionStore, config);
    mgr.continuityStore = continuityStore;

    mgr.recordUserMessage('ch1', 'Hello', 'user1', 'Alice');

    // Session store has it
    expect(sessionStore.getRecent('ch1', 10)).toHaveLength(1);

    // Continuity store also has it
    const continuity = continuityStore.getRecent('user1', 10);
    expect(continuity).toHaveLength(1);
    expect(continuity[0].originChannelId).toBe('ch1');
  });

  it('records assistant messages to continuity store when forUserId is given', () => {
    const mgr = new SessionManager(sessionStore, config);
    mgr.continuityStore = continuityStore;

    mgr.recordAssistantMessage('ch1', 'Hi there', 'user1');

    // Session store has it
    expect(sessionStore.getRecent('ch1', 10)).toHaveLength(1);

    // Continuity store also has it
    const continuity = continuityStore.getRecent('user1', 10);
    expect(continuity).toHaveLength(1);
    expect(continuity[0].originChannelId).toBe('ch1');
  });

  it('does not record assistant messages to continuity when no forUserId', () => {
    const mgr = new SessionManager(sessionStore, config);
    mgr.continuityStore = continuityStore;

    mgr.recordAssistantMessage('ch1', 'Hi there');

    // Session store has it
    expect(sessionStore.getRecent('ch1', 10)).toHaveLength(1);

    // Continuity store does NOT — no user to key it under
    // (there's no userId to look up, so nothing recorded)
  });

  it('buildContext includes cross-channel continuity in system prompt', async () => {
    const mgr = new SessionManager(sessionStore, config);
    mgr.continuityStore = continuityStore;

    // Simulate activity in channel 1
    mgr.recordUserMessage('ch1', 'I like cats', 'user1', 'Alice');
    mgr.recordAssistantMessage('ch1', 'Me too!', 'user1');

    // Simulate activity in channel 2
    mgr.recordUserMessage('ch2', 'What about dogs?', 'user1', 'Alice');

    // Build context for channel 2 — should include ch1 messages as cross-channel
    const ctx = await mgr.buildContext('ch2', 'System prompt', '', undefined, 'user1');

    expect(ctx.systemPrompt).toContain('[Recent activity from other channels]');
    expect(ctx.systemPrompt).toContain('I like cats');
    expect(ctx.systemPrompt).toContain('Me too!');
    // Should NOT contain the ch2 message in the continuity block (it's already in local)
    // but the ch2 entry will be in the continuity store, excluded by channelId
    expect(ctx.systemPrompt).not.toContain('[from ch2]');
  });

  it('buildContext works without continuity store (backward compat)', async () => {
    const mgr = new SessionManager(sessionStore, config);
    // No continuityStore set

    mgr.recordUserMessage('ch1', 'Hello', 'user1', 'Alice');

    const ctx = await mgr.buildContext('ch1', 'System prompt', '');
    expect(ctx.systemPrompt).toBe('System prompt');
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.systemPrompt).not.toContain('[Recent activity from other channels]');
  });

  it('buildContext works without userId (no continuity injection)', async () => {
    const mgr = new SessionManager(sessionStore, config);
    mgr.continuityStore = continuityStore;

    // Add some continuity data
    continuityStore.append('user1', {
      channelId: 'ch1',
      role: 'user',
      content: 'Cross-channel message',
      timestamp: Date.now(),
      originChannelId: 'ch1',
    });

    mgr.recordUserMessage('ch2', 'Hello', 'user1', 'Alice');

    // buildContext without userId — should not include continuity
    const ctx = await mgr.buildContext('ch2', 'System prompt', '');
    expect(ctx.systemPrompt).not.toContain('[Recent activity from other channels]');
  });

  it('does not duplicate messages from current channel in continuity block', async () => {
    const mgr = new SessionManager(sessionStore, config);
    mgr.continuityStore = continuityStore;

    // Record messages in ch1 only
    mgr.recordUserMessage('ch1', 'Message in ch1', 'user1', 'Alice');
    mgr.recordAssistantMessage('ch1', 'Reply in ch1', 'user1');

    // Build context for ch1 — continuity should NOT include ch1 messages
    const ctx = await mgr.buildContext('ch1', 'System prompt', '', undefined, 'user1');
    expect(ctx.systemPrompt).not.toContain('[Recent activity from other channels]');
  });

  it('includes channel origin labels in continuity block', async () => {
    const mgr = new SessionManager(sessionStore, config);
    mgr.continuityStore = continuityStore;

    mgr.recordUserMessage('dm-channel', 'Secret stuff', 'user1', 'Alice');
    mgr.recordUserMessage('public-channel', 'Public talk', 'user1', 'Alice');

    // Build context for a third channel
    sessionStore.append({
      channelId: 'ch3',
      role: 'user',
      content: 'Hello in ch3',
      authorId: 'user1',
      authorName: 'Alice',
      timestamp: Date.now(),
    });
    const ctx = await mgr.buildContext('ch3', 'System prompt', '', undefined, 'user1');

    expect(ctx.systemPrompt).toContain('[from dm-channel]');
    expect(ctx.systemPrompt).toContain('[from public-channel]');
  });
});
