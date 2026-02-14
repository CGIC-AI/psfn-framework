import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './store.js';
import { SessionManager } from './manager.js';
import type { SubstrateConfig } from '../types.js';
import type { LLMProvider } from '../agent-loop.js';

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
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 1000 },
    },
    ...overrides,
  };
}

function makeMockLLM(): LLMProvider {
  return {
    stream: async () => ({ content: '', model: 'test', inputTokens: 0, outputTokens: 0, toolCalls: [], stopReason: 'end_turn' }),
    complete: async () => ({ content: 'Summary of old messages.', model: 'test', inputTokens: 0, outputTokens: 0, toolCalls: [], stopReason: 'end_turn' }),
  };
}

describe('SessionManager', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-mgr-'));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildContext returns system prompt and messages', async () => {
    const config = makeConfig();
    const mgr = new SessionManager(store, config);
    mgr.recordUserMessage('ch1', 'Hello', 'u1', 'User');
    mgr.recordAssistantMessage('ch1', 'Hi there');

    const ctx = await mgr.buildContext('ch1', 'System prompt', '');
    expect(ctx.systemPrompt).toBe('System prompt');
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].role).toBe('user');
    expect(ctx.messages[1].role).toBe('assistant');
  });

  it('buildContext includes memories in system prompt', async () => {
    const config = makeConfig();
    const mgr = new SessionManager(store, config);
    mgr.recordUserMessage('ch1', 'Hello', 'u1', 'User');

    const ctx = await mgr.buildContext('ch1', 'System', 'Memory block');
    expect(ctx.systemPrompt).toContain('Memory block');
  });

  it('auto-compacts when context exceeds threshold', async () => {
    // contextWindow=1000, compactionThresholdPct=70 → budget=700 tokens
    // 700 tokens ≈ 2800 chars. Fill with enough messages to exceed.
    const config = makeConfig({ compactionThresholdPct: 70 });
    const mgr = new SessionManager(store, config);
    const mockLLM = makeMockLLM();

    // Each message ~400 chars = ~100 tokens. Need ~8 messages to exceed 700 tokens.
    for (let i = 0; i < 10; i++) {
      mgr.recordUserMessage('ch1', 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', 'B'.repeat(400));
    }

    const ctx = await mgr.buildContext('ch1', 'Sys', '', mockLLM);

    // After compaction, fewer messages should be returned
    // Original: 20 messages. Compacted ~half. Should have ~10 messages.
    expect(ctx.messages.length).toBeLessThan(20);
    // Compaction summary should be in system prompt
    expect(ctx.systemPrompt).toContain('Previous conversation summary');
  });

  it('skips compaction when no llmProvider given', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const mgr = new SessionManager(store, config);

    for (let i = 0; i < 10; i++) {
      mgr.recordUserMessage('ch1', 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', 'B'.repeat(400));
    }

    const ctx = await mgr.buildContext('ch1', 'Sys', '');
    // Without LLM provider, no compaction — all 20 messages (merged to alternating pairs)
    expect(ctx.messages.length).toBe(20);
  });

  it('appendSystemNote adds a system entry to the session', async () => {
    const config = makeConfig();
    const mgr = new SessionManager(store, config);
    mgr.recordUserMessage('ch1', 'Hello', 'u1', 'User');
    mgr.appendSystemNote('ch1', 'Agent performed self-check');
    mgr.recordAssistantMessage('ch1', 'All good');

    // System notes should appear in context as user-role messages with [System note] prefix
    const ctx = await mgr.buildContext('ch1', 'Sys', '');
    const allContent = ctx.messages.map(m => m.content).join('\n');
    expect(allContent).toContain('[System note] Agent performed self-check');
  });

  it('system notes are visible in getRecentMessages', () => {
    const config = makeConfig();
    const mgr = new SessionManager(store, config);
    mgr.recordUserMessage('ch1', 'Hello', 'u1', 'User');
    mgr.appendSystemNote('ch1', 'A note');

    const recent = mgr.getRecentMessages('ch1');
    expect(recent).toHaveLength(2);
    expect(recent[1].role).toBe('system');
    expect(recent[1].content).toBe('A note');
  });

  it('skips compaction when context is under threshold', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const mgr = new SessionManager(store, config);
    const mockLLM = makeMockLLM();

    mgr.recordUserMessage('ch1', 'Hi', 'u1', 'User');
    mgr.recordAssistantMessage('ch1', 'Hello');

    const ctx = await mgr.buildContext('ch1', 'Sys', '', mockLLM);
    expect(ctx.messages.length).toBe(2);
    expect(ctx.systemPrompt).not.toContain('Previous conversation summary');
  });
});
