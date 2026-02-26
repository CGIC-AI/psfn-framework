import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SessionStore } from './store.js';
import { UserContinuityStore } from './continuity.js';
import { SessionManager } from './manager.js';
import { EventBus } from '../event-bus.js';
import type { SubstrateConfig } from '../types.js';
import type { LLMProvider } from '../agent-loop.js';
import { PromptRegistryStore, COMPACTION_SUMMARY_PROMPT_KEY } from '../identity/prompt-registry.js';
import { MemoryStore } from '../memory/store.js';
import { MemoryExtractor } from '../memory/extraction.js';
import { __test as tokenTestUtils } from '../llm/tokens.js';
import {
  buildCompactionSourceBlock,
  computeCompactionSourceSha256,
  parseCompactionSourceHashTag,
} from './compaction-audit.js';

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
    compactionEmotionalSalienceThresholdPct: 75,
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
    tokenTestUtils.resetTokenizerState();
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

  it('loads verified session history without unverified tags', async () => {
    const config = makeConfig();
    const keyring = {
      activeVersion: 'v1',
      keys: { v1: 'trusted-integrity-key' },
    };

    const writer = new SessionStore(dir, { integrityKeyring: keyring });
    writer.append({
      channelId: 'dm:verified',
      role: 'user',
      content: 'Verified history line',
      authorId: 'u1',
      authorName: 'User',
      timestamp: Date.now(),
    });

    const reader = new SessionStore(dir, { integrityKeyring: keyring });
    const mgr = new SessionManager(reader, config);

    const ctx = await mgr.buildContext('dm:verified', 'Sys', '', undefined, undefined, { isDirectMessage: true });
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('Verified history line');
    expect(ctx.messages[0].content).not.toContain('<unverified_history>');
  });

  it('wraps failed integrity history in unverified_history tags', async () => {
    const config = makeConfig();
    const signerKeyring = {
      activeVersion: 'v1',
      keys: { v1: 'signing-key' },
    };
    const mismatchedKeyring = {
      activeVersion: 'v1',
      keys: { v1: 'different-verifier-key' },
    };

    const writer = new SessionStore(dir, { integrityKeyring: signerKeyring });
    writer.append({
      channelId: 'dm:tampered',
      role: 'user',
      content: 'This line should fail verification',
      authorId: 'u1',
      authorName: 'User',
      timestamp: Date.now(),
    });

    const reader = new SessionStore(dir, { integrityKeyring: mismatchedKeyring });
    const mgr = new SessionManager(reader, config);

    const ctx = await mgr.buildContext('dm:tampered', 'Sys', '', undefined, undefined, { isDirectMessage: true });
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('<unverified_history>');
    expect(ctx.messages[0].content).toContain('This line should fail verification');
  });

  it('wraps public channel history in untrusted_context tags', async () => {
    const config = makeConfig();
    const mgr = new SessionManager(store, config);

    mgr.recordUserMessage('twitter:room', 'Public user message', 'u1', 'User', false);
    mgr.recordAssistantMessage('twitter:room', 'Public assistant reply', 'u1', false);

    const ctx = await mgr.buildContext('twitter:room', 'Sys', '', undefined, undefined, { isDirectMessage: false });
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].content).toContain('<untrusted_context source="public">');
    expect(ctx.messages[0].content).toContain('Public user message');
    expect(ctx.messages[1].content).toContain('<untrusted_context source="public">');
    expect(ctx.messages[1].content).toContain('Public assistant reply');
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

  it('mirrors related messages into other active sessions with mirror metadata', () => {
    const config = makeConfig({
      sessionMirrorEnabled: true,
      sessionMirrorMaxChars: 80,
      sessionMirrorActiveWindowMs: 60_000,
    });
    const mgr = new SessionManager(store, config);
    mgr.continuityStore = new UserContinuityStore(dir);

    mgr.recordUserMessage(
      'api:target',
      'target bootstrap',
      'discord-user-1',
      'Alice',
      undefined,
      'contact-1',
      { trustLevel: 'primary' },
    );
    mgr.recordAssistantMessage(
      'api:source',
      'This is a mirrored assistant response that should be clipped if too long.',
      'discord-user-1',
      undefined,
      'contact-1',
      { trustLevel: 'primary' },
    );
    mgr.recordUserMessage(
      'api:source',
      'And this mirrored user message should also appear in target.',
      'discord-user-1',
      'Alice',
      undefined,
      'contact-1',
      { trustLevel: 'primary' },
    );

    const targetEntries = store.getRecent('api:target', 10);
    const mirrors = targetEntries.filter(entry => entry.role === 'system' && entry.metadata?.includes('"type":"mirror"'));
    expect(mirrors).toHaveLength(2);
    expect(mirrors[0].content).toContain('[from api:source]');
    expect(mirrors[1].content).toContain('[from api:source]');
  });

  it('applies trust filtering before writing mirrors', () => {
    const config = makeConfig({
      sessionMirrorEnabled: true,
      sessionMirrorActiveWindowMs: 60_000,
    });
    const mgr = new SessionManager(store, config);
    mgr.continuityStore = new UserContinuityStore(dir);

    mgr.recordUserMessage(
      'api:target',
      'target bootstrap',
      'discord-user-1',
      'Alice',
      undefined,
      'contact-1',
      { trustLevel: 'primary' },
    );

    mgr.recordAssistantMessage(
      'api:source',
      'private mirror candidate',
      'discord-user-1',
      undefined,
      'contact-1',
      { trustLevel: 'regular' },
    );

    const targetEntries = store.getRecent('api:target', 10);
    const mirrors = targetEntries.filter(entry => entry.role === 'system' && entry.metadata?.includes('"type":"mirror"'));
    expect(mirrors).toHaveLength(0);
  });

  it('supports global and per-channel mirror toggles', () => {
    const disabledConfig = makeConfig({
      sessionMirrorEnabled: false,
      sessionMirrorActiveWindowMs: 60_000,
    });
    const disabledStore = new SessionStore(join(dir, 'mirrors-disabled'));
    const globallyDisabled = new SessionManager(disabledStore, disabledConfig);
    globallyDisabled.continuityStore = new UserContinuityStore(join(dir, 'mirrors-disabled'));

    globallyDisabled.recordUserMessage(
      'api:target',
      'bootstrap',
      'discord-user-1',
      'Alice',
      undefined,
      'contact-1',
      { trustLevel: 'primary' },
    );
    globallyDisabled.recordAssistantMessage(
      'api:source',
      'should not mirror',
      'discord-user-1',
      undefined,
      'contact-1',
      { trustLevel: 'primary' },
    );
    expect(disabledStore.getRecent('api:target', 10).some(entry => entry.metadata?.includes('"type":"mirror"'))).toBe(false);

    const overrideConfig = makeConfig({
      sessionMirrorEnabled: true,
      sessionMirrorChannelOverrides: { 'api:target': false },
      sessionMirrorActiveWindowMs: 60_000,
    });
    const overrideStore = new SessionStore(join(dir, 'mirrors-overrides'));
    const perChannelDisabled = new SessionManager(overrideStore, overrideConfig);
    perChannelDisabled.continuityStore = new UserContinuityStore(join(dir, 'mirrors-overrides'));

    perChannelDisabled.recordUserMessage(
      'api:target',
      'bootstrap',
      'discord-user-1',
      'Alice',
      undefined,
      'contact-1',
      { trustLevel: 'primary' },
    );
    perChannelDisabled.recordAssistantMessage(
      'api:source',
      'should also not mirror',
      'discord-user-1',
      undefined,
      'contact-1',
      { trustLevel: 'primary' },
    );
    expect(overrideStore.getRecent('api:target', 10).some(entry => entry.metadata?.includes('"type":"mirror"'))).toBe(false);
  });

  it('imports legacy chat and bootstraps extraction in bounded token chunks', async () => {
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: (text: string) => ({ length: text.length }),
    }));

    const config = makeConfig();
    const mgr = new SessionManager(store, config);
    const sourcePath = join(dir, 'legacy-bootstrap-source.json');
    const records = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${index}:${'x'.repeat(68)}`,
      timestamp: 1_700_100_000_000 + index,
    }));
    writeFileSync(sourcePath, JSON.stringify(records), 'utf-8');

    const seenChunkIds: number[][] = [];
    mgr.setPreCompactionExtractionHandler(async ({ entries, canonicalContactId }) => {
      expect(canonicalContactId).toBe('contact-legacy');
      const approxTokens = entries.reduce((sum, entry) => sum + entry.content.length, 0);
      expect(approxTokens).toBeLessThanOrEqual(140);
      seenChunkIds.push(entries.map(entry => entry.id));
    });

    const result = await mgr.importLegacyChatFromFile({
      channelId: 'api:import-bootstrap',
      sourcePath,
      canonicalContactId: 'contact-legacy',
      bootstrapMaxChunkTokens: 140,
    });

    expect(result.importResult.manifest.importedRecordCount).toBe(10);
    expect(result.bootstrapResult).not.toBeNull();
    expect(result.bootstrapResult?.chunkCount).toBeGreaterThan(1);
    expect(result.bootstrapResult?.processedChunks).toBe(result.bootstrapResult?.chunkCount);
    expect(result.bootstrapResult?.chunks.every(chunk => chunk.approxTokens <= 140)).toBe(true);

    expect(seenChunkIds.length).toBe(result.bootstrapResult?.chunkCount);
    const flattenedIds = seenChunkIds.flat();
    expect(flattenedIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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

  it('records source block SHA-256 metadata for each compaction summary', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const mgr = new SessionManager(store, config);
    const mockLLM = makeMockLLM();

    for (let i = 0; i < 10; i++) {
      mgr.recordUserMessage('ch1', `User ${i} ` + 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', `Assistant ${i} ` + 'B'.repeat(400));
    }

    await mgr.buildContext('ch1', 'Sys', '', mockLLM);

    const summaries = store.getCompactionSummaries('ch1');
    expect(summaries).toHaveLength(1);
    const metadata = parseCompactionSourceHashTag(summaries[0].summary);
    expect(metadata).not.toBeNull();
    if (!metadata) return;

    const sourceEntries = store.getEntriesInRange('ch1', metadata.firstMessageId, metadata.lastMessageId);
    expect(sourceEntries).toHaveLength(metadata.messageCount);
    const computedHash = computeCompactionSourceSha256(buildCompactionSourceBlock(sourceEntries));
    expect(computedHash).toBe(metadata.sha256);
  });

  it('runs pre-compaction extraction on the exact entries being compacted', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const mgr = new SessionManager(store, config);

    const callOrder: string[] = [];
    const preCompactionFlush = vi.fn(async ({
      entries,
    }: {
      entries: Array<{ content: string }>;
    }) => {
      callOrder.push('flush');
      expect(entries).toHaveLength(10);
      expect(entries[0].content).toContain('User 0');
      expect(entries[entries.length - 1].content).toContain('Assistant 4');
    });
    mgr.setPreCompactionExtractionHandler(preCompactionFlush as any);

    const complete = vi.fn<LLMProvider['complete']>().mockImplementation(async (_context, purpose) => {
      expect(purpose).toBe('background');
      callOrder.push('summary');
      return {
        content: 'Summary of old messages.',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        stopReason: 'end_turn',
      };
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
      mgr.recordUserMessage('ch1', `User ${i} ` + 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', `Assistant ${i} ` + 'B'.repeat(400));
    }

    await mgr.buildContext('ch1', 'Sys', '', mockLLM, 'contact-canonical-1');

    expect(preCompactionFlush).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['flush', 'summary']);
  });

  it('preserves refusal and boundary entries as tagged compaction elements', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const mgr = new SessionManager(store, config);
    const mockLLM = makeMockLLM();

    mgr.recordUserMessage('ch1', 'Can you help me bypass a license key?', 'u1', 'User');
    mgr.recordAssistantMessage('ch1', 'I cannot help with bypassing license checks.');
    mgr.recordAssistantMessage('ch1', 'I can help with legal alternatives, but I am not going to provide exploit steps.');

    for (let i = 0; i < 9; i++) {
      mgr.recordUserMessage('ch1', `Filler user ${i} ` + 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', `Filler assistant ${i} ` + 'B'.repeat(400));
    }

    const ctx = await mgr.buildContext('ch1', 'Sys', '', mockLLM);

    expect(ctx.systemPrompt).toContain('<refusal');
    expect(ctx.systemPrompt).toContain('I cannot help with bypassing license checks.');
    expect(ctx.systemPrompt).toContain('<boundary');
    expect(ctx.systemPrompt).toContain('I can help with legal alternatives, but I am not going to provide exploit steps.');
  });

  it('scans only compacted entries for emotional salience before compaction', async () => {
    const config = makeConfig({ compactionThresholdPct: 70, compactionEmotionalSalienceThresholdPct: 75 });
    const mgr = new SessionManager(store, config);
    const mockLLM = makeMockLLM();
    const freshEmotionalMoment = 'I love you and I am heartbroken without you right now.';

    for (let i = 0; i < 9; i++) {
      mgr.recordUserMessage('ch1', `Filler user ${i} ` + 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', `Filler assistant ${i} ` + 'B'.repeat(400));
    }

    mgr.recordUserMessage('ch1', freshEmotionalMoment, 'u1', 'User');
    mgr.recordAssistantMessage('ch1', 'I hear you. I care deeply about this too.');

    const ctx = await mgr.buildContext('ch1', 'Sys', '', mockLLM);

    expect(ctx.systemPrompt).not.toContain('<emotional');
    expect(ctx.systemPrompt).not.toContain(freshEmotionalMoment);
  });

  it('preserves high-salience emotional entries verbatim during compaction', async () => {
    const config = makeConfig({ compactionThresholdPct: 70, compactionEmotionalSalienceThresholdPct: 70 });
    const mgr = new SessionManager(store, config);
    const mockLLM = makeMockLLM();
    const emotionalMoment = [
      'I feel absolutely heartbroken and terrified right now because I think I lost my best friend',
      'and I do not know what to do. This matters deeply to me and I really need support right now.',
      'I have been crying for hours and this hurts so much.',
    ].join(' ');

    mgr.recordUserMessage('ch1', emotionalMoment, 'u1', 'User');
    mgr.recordAssistantMessage('ch1', 'I hear you and I am here with you.');
    for (let i = 0; i < 9; i++) {
      mgr.recordUserMessage('ch1', `Filler user ${i} ` + 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', `Filler assistant ${i} ` + 'B'.repeat(400));
    }

    const ctx = await mgr.buildContext('ch1', 'Sys', '', mockLLM);

    expect(ctx.systemPrompt).toContain('<emotional');
    expect(ctx.systemPrompt).toContain('salience_score="');
    expect(ctx.systemPrompt).toContain(emotionalMoment);
  });

  it('honors configurable emotional salience thresholds', async () => {
    const moderateEmotionalMoment = 'I feel sad and anxious about this situation right now.';
    const highThresholdStore = new SessionStore(join(dir, 'high-threshold'));
    const lowThresholdStore = new SessionStore(join(dir, 'low-threshold'));
    const highThresholdManager = new SessionManager(
      highThresholdStore,
      makeConfig({
        compactionThresholdPct: 70,
        compactionEmotionalSalienceThresholdPct: 95,
      }),
    );
    const lowThresholdManager = new SessionManager(
      lowThresholdStore,
      makeConfig({
        compactionThresholdPct: 70,
        compactionEmotionalSalienceThresholdPct: 40,
      }),
    );
    const mockLLM = makeMockLLM();

    for (const manager of [highThresholdManager, lowThresholdManager]) {
      manager.recordUserMessage('ch1', moderateEmotionalMoment, 'u1', 'User');
      manager.recordAssistantMessage('ch1', 'Thank you for sharing this with me.');
      for (let i = 0; i < 9; i++) {
        manager.recordUserMessage('ch1', `Filler user ${i} ` + 'A'.repeat(400), 'u1', 'User');
        manager.recordAssistantMessage('ch1', `Filler assistant ${i} ` + 'B'.repeat(400));
      }
    }

    const highThresholdContext = await highThresholdManager.buildContext('ch1', 'Sys', '', mockLLM);
    const lowThresholdContext = await lowThresholdManager.buildContext('ch1', 'Sys', '', mockLLM);

    expect(highThresholdContext.systemPrompt).not.toContain('<emotional');
    expect(lowThresholdContext.systemPrompt).toContain('<emotional');
    expect(lowThresholdContext.systemPrompt).toContain(moderateEmotionalMoment);
  });

  it('flushes memories from compacted entries into L2 before compaction', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const eventBus = new EventBus();
    const mgr = new SessionManager(store, config, eventBus);
    const callOrder: string[] = [];
    let flushCompleted = false;

    const extractionComplete = vi.fn<LLMProvider['complete']>().mockImplementation(async (context, purpose) => {
      if (purpose === 'background' && context.systemPrompt.includes('Kyoto trip in April')) {
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          content: `<response>
<fact>
<text>User is planning a Kyoto trip in April.</text>
<type>episodic</type>
<importance>0.92</importance>
<emotional_valence>0.2</emotional_valence>
<confidence>0.95</confidence>
<tags>travel,plans</tags>
<sensitivity>personal</sensitivity>
</fact>
</response>`,
          model: 'test',
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: [],
          stopReason: 'end_turn',
        };
      }

      return {
        content: '<response></response>',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        stopReason: 'end_turn',
      };
    });
    const extractionLLM: LLMProvider = {
      stream: async () => ({
        content: '',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        stopReason: 'end_turn',
      }),
      complete: extractionComplete,
    };
    const compactionComplete = vi.fn<LLMProvider['complete']>().mockImplementation(async () => {
      expect(flushCompleted).toBe(true);
      callOrder.push('compaction-summary');
      return {
        content: 'Summary of old messages.',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        stopReason: 'end_turn',
      };
    });
    const compactionLLM: LLMProvider = {
      stream: async () => ({
        content: '',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        stopReason: 'end_turn',
      }),
      complete: compactionComplete,
    };
    const embeddingService = {
      embed: vi.fn().mockResolvedValue(new Float32Array(8)),
      embedBatch: vi.fn(),
      dims: 8,
    } as any;

    const dbPath = join(dir, 'compaction-memory.sqlite');
    const db = new Database(dbPath);
    try {
      const memoryStore = new MemoryStore(db, 8);
      const extractor = new MemoryExtractor(
        extractionLLM,
        mgr,
        memoryStore,
        embeddingService,
        eventBus,
        { extractionInterval: 5 },
      );

      mgr.setPreCompactionExtractionHandler(async ({ channelId, entries, canonicalContactId }) => {
        await extractor.queueCompactionExtraction(channelId, entries, canonicalContactId);
        flushCompleted = true;
        callOrder.push('flush-complete');
      });

      mgr.recordUserMessage('ch1', 'I am planning a Kyoto trip in April.', 'u1', 'User');
      mgr.recordAssistantMessage('ch1', 'That sounds exciting.');
      for (let i = 0; i < 9; i++) {
        mgr.recordUserMessage('ch1', `Filler user ${i} ` + 'A'.repeat(400), 'u1', 'User');
        mgr.recordAssistantMessage('ch1', `Filler assistant ${i} ` + 'B'.repeat(400));
      }

      await mgr.buildContext('ch1', 'Sys', '', compactionLLM, 'contact-canonical-1');

      const memories = memoryStore.getMemoriesByChannel('ch1', 10);
      expect(callOrder).toEqual(['flush-complete', 'compaction-summary']);
      expect(store.getCompactionSummaries('ch1')).toHaveLength(1);
      expect(memories.some(memory => memory.text.includes('Kyoto trip in April'))).toBe(true);
      expect(extractionComplete).toHaveBeenCalled();
      expect(compactionComplete).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('uses framed message token counting for compaction thresholds', async () => {
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: (text: string) => ({ length: text.length }),
    }));

    const config = makeConfig({
      compactionThresholdPct: 50,
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 80 },
      },
    });
    const mgr = new SessionManager(store, config);
    const mockLLM = makeMockLLM();

    for (let i = 0; i < 3; i++) {
      mgr.recordUserMessage('ch1', 'x', 'u1', 'User');
      mgr.recordAssistantMessage('ch1', 'y');
    }

    await mgr.buildContext('ch1', 'S', '', mockLLM);

    expect(mockLLM.complete).toHaveBeenCalledTimes(1);
    expect(mockLLM.complete).toHaveBeenCalledWith(expect.anything(), 'background');
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

  it('injects runtime datetime tokens in compaction prompts', async () => {
    const config = makeConfig({ compactionThresholdPct: 70 });
    const promptRegistry = new PromptRegistryStore(
      join(dir, 'prompt-registry.json'),
      join(dir, 'prompt-registry-history.jsonl'),
    );
    promptRegistry.update(
      COMPACTION_SUMMARY_PROMPT_KEY,
      'Summarize at {{current_datetime}} with key facts only.',
      'test',
    );

    const mgr = new SessionManager(store, config, undefined, promptRegistry);
    const mockLLM = makeMockLLM();

    for (let i = 0; i < 10; i++) {
      mgr.recordUserMessage('ch1', 'A'.repeat(400), 'u1', 'User');
      mgr.recordAssistantMessage('ch1', 'B'.repeat(400));
    }

    await mgr.buildContext('ch1', 'Sys', '', mockLLM);

    const call = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as { systemPrompt: string };
    expect(call.systemPrompt).not.toContain('{{current_datetime}}');
    expect(call.systemPrompt).toMatch(/Summarize at \d{4}-\d{2}-\d{2}T/);
  });
});
