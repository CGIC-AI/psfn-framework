import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './store.js';
import { UserContinuityStore } from './continuity.js';
import { SessionManager } from './manager.js';
import { EventBus } from '../event-bus.js';
import type { SubstrateConfig } from '../types.js';
import type { LLMProvider } from '../agent-loop.js';
import { PromptRegistryStore, COMPACTION_SUMMARY_PROMPT_KEY } from '../identity/prompt-registry.js';

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
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 1000 },
    },
    ...overrides,
  };
}

function makeMockLLM(): LLMProvider {
  const complete = vi.fn<LLMProvider['complete']>().mockResolvedValue({
    content: 'Summary of old messages.',
    model: 'test',
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: [],
    stopReason: 'end_turn',
  });
  return {
    stream: async () => ({ content: '', model: 'test', inputTokens: 0, outputTokens: 0, toolCalls: [], stopReason: 'end_turn' }),
    complete,
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

  it('uses context-budgeted history when hard override is unset', async () => {
    const budgetConfig = makeConfig({
      sessionMessageLimit: undefined,
      sessionHistoryBudgetPct: 6,
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 4_000 },
      },
    });
    const overrideConfig = makeConfig({
      sessionMessageLimit: 40,
      sessionHistoryBudgetPct: 6,
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 4_000 },
      },
    });

    const budgetMgr = new SessionManager(store, budgetConfig);
    const overrideStore = new SessionStore(join(dir, 'override-sessions'));
    const overrideMgr = new SessionManager(overrideStore, overrideConfig);

    for (let i = 0; i < 20; i++) {
      const userText = `User ${i} ` + 'A'.repeat(220);
      const assistantText = `Assistant ${i} ` + 'B'.repeat(220);
      budgetMgr.recordUserMessage('ch-budget', userText, 'u1', 'User');
      budgetMgr.recordAssistantMessage('ch-budget', assistantText);
      overrideMgr.recordUserMessage('ch-override', userText, 'u1', 'User');
      overrideMgr.recordAssistantMessage('ch-override', assistantText);
    }

    const budgetCtx = await budgetMgr.buildContext('ch-budget', 'Sys', '');
    const overrideCtx = await overrideMgr.buildContext('ch-override', 'Sys', '');

    expect(budgetCtx.messages.length).toBeLessThan(overrideCtx.messages.length);
  });

  it('prefers hard session limit over budget percentage', async () => {
    const config = makeConfig({
      sessionMessageLimit: 8,
      sessionHistoryBudgetPct: 1,
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 2_000 },
      },
    });
    const mgr = new SessionManager(store, config);
    for (let i = 0; i < 5; i++) {
      mgr.recordUserMessage('ch1', `U${i}`, 'u1', 'User');
      mgr.recordAssistantMessage('ch1', `A${i}`);
    }

    const ctx = await mgr.buildContext('ch1', 'Sys', '');
    expect(ctx.messages.length).toBe(8);
  });

  it('indexes continuity by canonical contact key when provided', () => {
    const config = makeConfig();
    const mgr = new SessionManager(store, config);
    mgr.continuityStore = new UserContinuityStore(dir);

    mgr.recordUserMessage('api:ch1', 'Hello', 'discord-user-1', 'User', false, 'contact-canonical-1');

    expect(mgr.continuityStore.count('discord-user-1')).toBe(0);
    expect(mgr.continuityStore.count('contact-canonical-1')).toBe(1);
  });

  it('buildContext merges continuity from canonical and fallback ids', async () => {
    const config = makeConfig();
    const mgr = new SessionManager(store, config);
    const continuityStore = new UserContinuityStore(dir);
    mgr.continuityStore = continuityStore;

    continuityStore.append('contact-canonical-1', {
      channelId: 'api:origin-1',
      role: 'user',
      content: 'Canonical continuity message',
      authorId: 'contact-canonical-1',
      authorName: 'Canonical',
      timestamp: 1000,
      originChannelId: 'api:origin-1',
      channelVisibility: 'private',
    });

    continuityStore.append('legacy-discord-id', {
      channelId: 'api:origin-2',
      role: 'assistant',
      content: 'Legacy continuity message',
      timestamp: 2000,
      originChannelId: 'api:origin-2',
      channelVisibility: 'private',
    });

    mgr.recordUserMessage('api:current', 'Current turn', 'legacy-discord-id', 'User');

    const ctx = await mgr.buildContext(
      'api:current',
      'System',
      '',
      undefined,
      'contact-canonical-1',
      { isDirectMessage: true },
      ['legacy-discord-id'],
    );

    expect(ctx.systemPrompt).toContain('Canonical continuity message');
    expect(ctx.systemPrompt).toContain('Legacy continuity message');
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

  it('emits compaction start/end events with token stats', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const eventBus = new EventBus();
    const mgr = new SessionManager(store, config, eventBus);
    const mockLLM = makeMockLLM();
    const compactionStart: Array<{ channelId: string; tokensBefore: number; tokenBudget: number }> = [];
    const compactionEnd: Array<{ channelId: string; tokensBefore: number; tokensAfter: number }> = [];

    eventBus.on('agent.compaction.start', (data) => { compactionStart.push(data); });
    eventBus.on('agent.compaction.end', (data) => { compactionEnd.push(data); });

    for (let i = 0; i < 10; i++) {
      mgr.recordUserMessage('ch1', 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', 'B'.repeat(400));
    }

    await mgr.buildContext('ch1', 'Sys', '', mockLLM);

    expect(compactionStart).toHaveLength(1);
    expect(compactionStart[0].channelId).toBe('ch1');
    expect(compactionStart[0].tokensBefore).toBeGreaterThan(compactionStart[0].tokenBudget);

    expect(compactionEnd).toHaveLength(1);
    expect(compactionEnd[0].channelId).toBe('ch1');
    expect(compactionEnd[0].tokensBefore).toBeGreaterThan(compactionEnd[0].tokensAfter);
  });

  it('emits retry start/end events when compaction summary retries', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const eventBus = new EventBus();
    const mgr = new SessionManager(store, config, eventBus);
    const retryStart: Array<{ attempt: number; maxAttempts: number; error: string }> = [];
    const retryEnd: Array<{ success: boolean; attempt: number }> = [];

    eventBus.on('agent.retry.start', (data) => {
      retryStart.push({ attempt: data.attempt, maxAttempts: data.maxAttempts, error: data.error });
    });
    eventBus.on('agent.retry.end', (data) => {
      retryEnd.push({ success: data.success, attempt: data.attempt });
    });

    const complete = vi.fn<LLMProvider['complete']>()
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValue({
        content: 'Summary after retry.',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        stopReason: 'end_turn',
      });

    const mockLLM: LLMProvider = {
      stream: async () => ({
        content: '',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        stopReason: 'end_turn',
      }),
      complete,
    };

    for (let i = 0; i < 10; i++) {
      mgr.recordUserMessage('ch1', 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', 'B'.repeat(400));
    }

    await mgr.buildContext('ch1', 'Sys', '', mockLLM);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(retryStart).toHaveLength(1);
    expect(retryStart[0].attempt).toBe(2);
    expect(retryStart[0].maxAttempts).toBe(3);
    expect(retryStart[0].error).toContain('429');
    expect(retryEnd).toEqual([{ success: true, attempt: 2 }]);
  });

  it('reads compaction prompt from prompt registry', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const promptRegistry = new PromptRegistryStore(
      join(dir, 'prompt-registry.json'),
      join(dir, 'prompt-registry-history.jsonl'),
    );
    const customPrompt = 'Compress this conversation excerpt into a compact timeline with key facts.';
    promptRegistry.update(COMPACTION_SUMMARY_PROMPT_KEY, customPrompt, 'test');

    const mgr = new SessionManager(store, config, undefined, promptRegistry);
    const mockLLM = makeMockLLM();

    for (let i = 0; i < 10; i++) {
      mgr.recordUserMessage('ch1', 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', 'B'.repeat(400));
    }

    await mgr.buildContext('ch1', 'Sys', '', mockLLM);

    expect(mockLLM.complete).toHaveBeenCalled();
    const call = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as { systemPrompt: string };
    expect(call.systemPrompt).toBe(customPrompt);
  });
});
