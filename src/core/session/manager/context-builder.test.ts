import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { __test as tokenTestUtils } from '../../../primitives/llm/tokens.js';
import type { LLMProviderPort } from '../../agent/contracts.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { CogSecEvent } from '../../cogsec/events.js';
import {
  assembleSessionHistoryForContextWithLlmSummary,
  buildOrientationNoteTelemetry,
  buildSessionContext,
  captureTurnSessionContext,
} from './context-builder.js';
import { collectRecentEntriesWithinHistorySpan } from '../manager-primitives.js';
import type { SessionEntry } from '../types.js';

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
    sessionHistoryBudgetPct: 50,
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
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 2000 },
    },
    ...overrides,
  };
}

function makeSummaryProvider(
  complete: LLMProviderPort['complete'],
): LLMProviderPort {
  return {
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
}

function makeCogSecEvent(overrides: Partial<CogSecEvent> = {}): CogSecEvent {
  return {
    caseId: 'cogsec_20260701T000000Z_context',
    type: 'memory_poisoning',
    severity: 'high',
    status: 'applied',
    sourceChannelId: 'discord-channel-1',
    affectedLogicalSessionIds: ['logical-session-1'],
    affectedMessageRanges: [{
      sourceChannelId: 'discord-channel-1',
      logicalSessionId: 'logical-session-1',
      startEntryId: 3,
      endEntryId: 4,
    }],
    sealedForensicPayloadRefs: ['cogsec-forensic://cogsec_20260701T000000Z_context/SMOKE_DIRTY_CONTEXT_TEXT.json'],
    sealedForensicPayloadHashes: [`sha256:${'c'.repeat(64)}`],
    tombstonedL0RowCount: 2,
    affectedArtifacts: {
      memories: {
        ids: ['memory-dirty'],
        count: 1,
      },
    },
    actions: ['seal', 'tombstone', 'search_exclude', 'revoke', 'regenerate'],
    actor: 'operator',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:03.000Z',
    appliedAt: '2026-07-01T00:00:03.000Z',
    safeAgentSummary: 'Unsafe instruction-like content was sealed and removed from active cognition.',
    resultCounters: {
      tombstonedL0Rows: 2,
      revokedArtifacts: 1,
      regeneratedArtifacts: 1,
    },
    epochCuts: [],
    ...overrides,
  };
}

describe('orientation context surface wiring', () => {
  it('excludes the exact current entry before consecutive user history is merged', async () => {
    const recentEntries: SessionEntry[] = [
      {
        id: 41,
        channelId: 'api:main',
        role: 'user',
        content: 'first message intentionally received no reply',
        authorId: 'u1',
        authorName: 'Vega',
        timestamp: 1_700_000_000_000,
      },
      {
        id: 42,
        channelId: 'api:main',
        role: 'user',
        content: 'second message should be prompted once',
        authorId: 'u1',
        authorName: 'Vega',
        timestamp: 1_700_000_001_000,
      },
    ];
    const context = await buildSessionContext({
      channelId: 'api:main',
      systemPrompt: 'System prompt.',
      coreMemoryBlock: '',
      memoriesBlock: '',
      userId: 'u1',
      continuityFallbackUserIds: [],
      store: {
        getRecent: () => recentEntries,
        getCompactionSummaries: () => [],
      } as never,
      config: makeConfig(),
      eventBus: null,
      promptRegistry: null,
      preCompactionExtractionHandler: null,
      crossChannelContinuity: { getMerged: () => [] },
      wakeReturnArtifacts: [],
      turnSessionContext: {
        channelId: 'api:main',
        recentEntries,
        sourceEntryCount: recentEntries.length,
        compactionSummaryTexts: [],
        focusKnowledgeTexts: [],
        continuityEntries: [],
        versionPointer: 'test-current-entry-exclusion',
      },
      excludeSessionEntryId: 42,
    });

    expect(context.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'first message intentionally received no reply',
      }),
    ]);
    expect(context.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining('second message should be prompted once') }),
    ]));
    expect(context.manifest?.session).toMatchObject({
      sourceEntryCount: 1,
      finalEntryCount: 1,
      finalMessageCount: 1,
    });
  });

  it('excludes the exact current entry before history-budget summarization', async () => {
    const currentContent = 'CURRENT_ENTRY_MUST_NOT_ENTER_SUMMARY';
    const recentEntries: SessionEntry[] = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      channelId: 'api:main',
      role: 'user' as const,
      content: index === 11
        ? currentContent
        : `Earlier message ${index + 1} with enough detail to consume the deliberately tiny history budget.`,
      authorId: 'u1',
      authorName: 'Vega',
      timestamp: 1_700_000_000_000 + index,
    }));
    const store = {
      getRecent: () => recentEntries,
      getCompactionSummaries: () => [],
    } as never;
    const snapshot = await captureTurnSessionContext({
      channelId: 'api:main',
      sourceChannelId: 'api:main',
      userId: 'u1',
      continuityFallbackUserIds: [],
      config: makeConfig({
        defaultContextWindow: 256,
        sessionHistoryBudgetPct: 20,
        modelRoster: {
          chat: { model: 'test-model', provider: 'test', maxTokens: 128, contextWindow: 256 },
        },
      }),
      store,
      activityStore: store,
      crossChannelContinuity: { getMerged: () => [] },
      focusCompactionRanges: [],
      focusKnowledgeTexts: [],
      wakeReturnArtifacts: [],
      compactionPromptText: 'Summarize history.',
      promptRegistry: null,
      excludeSessionEntryId: 12,
    });

    expect(JSON.stringify(snapshot)).not.toContain(currentContent);
    expect(snapshot.sourceEntryCount).toBe(11);
  });

  it('measures orientation from the latest prior activity after excluding the current turn', async () => {
    const nowMs = Date.now();
    const latestPriorActivityAt = nowMs - (4 * 60 * 60 * 1000);
    const currentContent = 'CURRENT_ORIENTATION_ENTRY_MUST_BE_EXCLUDED';
    const recentEntries: SessionEntry[] = [
      {
        id: 21,
        channelId: 'api:main',
        role: 'user',
        content: 'Earlier user activity.',
        timestamp: latestPriorActivityAt - 60_000,
      },
      {
        id: 22,
        channelId: 'api:main',
        role: 'assistant',
        content: 'Latest prior assistant activity.',
        timestamp: latestPriorActivityAt,
      },
      {
        id: 23,
        channelId: 'api:main',
        role: 'user',
        content: currentContent,
        timestamp: nowMs,
      },
    ];
    const store = {
      getRecent: () => recentEntries,
      getCompactionSummaries: () => [],
    } as never;

    const snapshot = await captureTurnSessionContext({
      channelId: 'api:main',
      sourceChannelId: 'api:main',
      userId: 'u1',
      continuityFallbackUserIds: [],
      config: makeConfig(),
      store,
      activityStore: store,
      crossChannelContinuity: { getMerged: () => [] },
      focusCompactionRanges: [],
      focusKnowledgeTexts: [],
      wakeReturnArtifacts: [],
      compactionPromptText: 'Summarize history.',
      promptRegistry: null,
      excludeSessionEntryId: 23,
    });

    expect(snapshot.orientation).toMatchObject({
      fired: true,
      reason: 'idle_gap_exceeded',
      lastActivityAt: latestPriorActivityAt,
    });
    expect(snapshot.orientation?.lastUserMessage).toBeUndefined();
    expect(snapshot.orientation?.idleGapMs).toBeGreaterThanOrEqual(4 * 60 * 60 * 1000);
    expect(JSON.stringify(snapshot)).not.toContain(currentContent);
  });

  it('can orient from one prior intentional-no-reply user turn without relabeling it as current', async () => {
    const priorActivityAt = 1_710_000_000_000;
    const observedAt = priorActivityAt + (4 * 60 * 60 * 1000);
    const orientation = buildOrientationNoteTelemetry({
      channelId: 'api:main',
      recentActivityEntries: [{
        id: 31,
        channelId: 'api:main',
        role: 'user',
        content: 'A prior turn that intentionally received no reply.',
        timestamp: priorActivityAt,
      }],
      currentTurnEntryExcluded: true,
      continuityEntries: [],
      focusKnowledgeTexts: [],
      nowMs: observedAt,
    });

    expect(orientation).toMatchObject({
      fired: true,
      reason: 'idle_gap_exceeded',
      lastActivityAt: priorActivityAt,
      idleGapMs: observedAt - priorActivityAt,
    });
    expect(orientation.lastUserMessage).toBeUndefined();

    const context = await buildSessionContext({
      channelId: 'api:main',
      systemPrompt: 'System prompt.',
      coreMemoryBlock: '',
      memoriesBlock: '',
      userId: 'u1',
      continuityFallbackUserIds: [],
      store: {
        getRecent: () => [],
        getCompactionSummaries: () => [],
      } as never,
      config: makeConfig(),
      eventBus: null,
      promptRegistry: null,
      preCompactionExtractionHandler: null,
      crossChannelContinuity: { getMerged: () => [] },
      wakeReturnArtifacts: [],
      turnSessionContext: {
        channelId: 'api:main',
        recentEntries: [],
        sourceEntryCount: 1,
        compactionSummaryTexts: [],
        focusKnowledgeTexts: [],
        continuityEntries: [],
        orientation,
        versionPointer: 'test-intentional-no-reply-orientation',
      },
    });
    expect(context.systemPrompt).not.toContain('<current_turn_user_message>');
  });

  it('threads orientation telemetry into a dedicated runtime prompt section', () => {
    const builderSource = readFileSync(resolve('src/core/session/manager/context-builder.ts'), 'utf-8');
    const manifestSource = readFileSync(resolve('src/core/session/context-manifest.ts'), 'utf-8');

    expect(builderSource).toContain('buildOrientationNoteTelemetry');
    expect(builderSource).toContain('!isInternalReflectionChannel(params.channelId)');
    expect(builderSource).toContain('captureTurnSessionContext');
    expect(builderSource).toContain('buildContinuityAnchorLines({');
    expect(builderSource).toContain('<continuity_anchor authority="companion_context"');
    expect(builderSource).toContain('<cross_channel_continuity authority="retrieved_context"');
    expect(builderSource).toContain("id: 'session.orientation'");
    expect(builderSource).toContain("id: 'session.cogsec_notices'");
    expect(builderSource).toContain("id: 'wake_orientation'");
    expect(manifestSource).toContain("| 'orientation'");
    expect(manifestSource).toContain("| 'cogsec_notices'");
  });

  it('includes relevant safe CogSec notices without sealed refs or dirty text', async () => {
    const relevantEvent = makeCogSecEvent();
    const unrelatedEvent = makeCogSecEvent({
      caseId: 'cogsec_20260701T000000Z_unrelated',
      sourceChannelId: 'discord-channel-2',
      affectedLogicalSessionIds: ['logical-session-9'],
      affectedMessageRanges: [{
        sourceChannelId: 'discord-channel-2',
        logicalSessionId: 'logical-session-9',
      }],
      updatedAt: '2026-07-01T00:00:04.000Z',
    });

    const ctx = await buildSessionContext({
      channelId: 'logical-session-1',
      sourceChannelId: 'discord-channel-1',
      systemPrompt: 'System prompt.',
      coreMemoryBlock: '',
      memoriesBlock: '',
      userId: 'u1',
      continuityFallbackUserIds: [],
      store: {
        getRecent: () => [],
        getCompactionSummaries: () => [],
      } as never,
      config: makeConfig(),
      eventBus: null,
      promptRegistry: null,
      preCompactionExtractionHandler: null,
      crossChannelContinuity: {
        getMerged: () => [],
      },
      wakeReturnArtifacts: [],
      characterName: 'Companion',
      turnSessionContext: {
        channelId: 'logical-session-1',
        recentEntries: [],
        sourceEntryCount: 0,
        compactionSummaryTexts: [],
        focusKnowledgeTexts: [],
        continuityEntries: [],
        versionPointer: 'test-snapshot',
      },
      cogSecEvents: [unrelatedEvent, relevantEvent],
    });

    expect(ctx.systemPrompt).toContain('<cogsec_notices>');
    expect(ctx.systemPrompt).toContain('cogsec_20260701T000000Z_context');
    expect(ctx.systemPrompt).toContain('Unsafe instruction-like content was sealed');
    expect(ctx.systemPrompt).not.toContain('cogsec_20260701T000000Z_unrelated');
    expect(ctx.systemPrompt).not.toContain('SMOKE_DIRTY_CONTEXT_TEXT');
    expect(ctx.systemPrompt).not.toContain('cogsec-forensic://');
    expect(ctx.systemPrompt).not.toMatch(/\bpayload\b/iu);
    expect(ctx.manifest?.budgets.sections.some(section => section.section === 'cogsec_notices')).toBe(true);

    const cogSecSection = ctx.systemPromptSections?.find(section => section.id === 'cogsec_notices');
    expect(cogSecSection?.content).toContain('cogsec_20260701T000000Z_context');
    expect(cogSecSection?.content).not.toContain('SMOKE_DIRTY_CONTEXT_TEXT');
    expect(cogSecSection?.content).not.toContain('cogsec-forensic://');
    expect(cogSecSection?.provenance).toMatchObject({
      kind: 'system_note',
      sourceAuthor: 'system',
      transformedBy: 'redaction',
      wording: 'redacted',
      safeAsPartnerSpeech: false,
    });
  });

  it('keeps heartbeat internal while allowing reflection orientation telemetry', () => {
    const previousAt = 1_700_000_000_000;
    const currentAt = previousAt + (4 * 60 * 60 * 1000);
    const recentReflectionEntries = [
      {
        id: 1,
        channelId: 'internal:reflection:daily',
        role: 'user' as const,
        content: 'Reflect on the last week.',
        timestamp: previousAt,
        originChannelId: 'internal:reflection:daily',
      },
      {
        id: 2,
        channelId: 'internal:reflection:daily',
        role: 'assistant' as const,
        content: 'Last week centered on recovery.',
        timestamp: currentAt,
        originChannelId: 'internal:reflection:daily',
      },
    ];
    const continuityEntries = [
      {
        id: 3,
        channelId: 'api:main',
        role: 'assistant' as const,
        content: 'The API thread still needs the recovery notes.',
        timestamp: currentAt - 1_000,
        originChannelId: 'api:main',
      },
    ];

    const heartbeatTelemetry = buildOrientationNoteTelemetry({
      channelId: 'internal:heartbeat',
      recentActivityEntries: recentReflectionEntries,
      continuityEntries,
      focusKnowledgeTexts: [],
      nowMs: currentAt,
    });
    expect(heartbeatTelemetry).toMatchObject({
      fired: false,
      reason: 'internal_channel',
    });

    const reflectionTelemetry = buildOrientationNoteTelemetry({
      channelId: 'internal:reflection:daily',
      recentActivityEntries: recentReflectionEntries,
      continuityEntries,
      focusKnowledgeTexts: [],
      continuitySummary: 'The API thread still needs the recovery notes.',
      nowMs: currentAt,
    });
    expect(reflectionTelemetry).toMatchObject({
      fired: true,
      reason: 'idle_gap_exceeded',
      continuitySummary: expect.stringContaining('The API thread still needs the recovery notes.'),
    });
    expect(reflectionTelemetry.noteText).toContain('Welcome back');
  });

  it('uses the LLM recent-summary service for older in-window history while keeping a verbatim tail', async () => {
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: (text: string) => ({ length: text.length }),
    }));
    try {
      const currentAt = 1_710_000_000_000;
      const hourMs = 60 * 60 * 1000;
      const allEntries: SessionEntry[] = [
        {
          id: 1,
          channelId: 'api:main',
          role: 'user',
          content: 'outside-old-01',
          authorId: 'u1',
          authorName: 'User',
          timestamp: currentAt - (7 * 24 * hourMs),
        },
        {
          id: 2,
          channelId: 'api:main',
          role: 'assistant',
          content: 'outside-old-02',
          authorName: 'Companion',
          timestamp: currentAt - (6 * 24 * hourMs),
        },
        {
          id: 3,
          channelId: 'api:main',
          role: 'user',
          content: 'm01xxxxx',
          authorId: 'u1',
          authorName: 'User',
          timestamp: currentAt - (30 * hourMs),
        },
        {
          id: 4,
          channelId: 'api:main',
          role: 'assistant',
          content: 'm02xxxxx',
          authorName: 'Companion',
          timestamp: currentAt - (28 * hourMs),
        },
        {
          id: 5,
          channelId: 'api:main',
          role: 'user',
          content: 'm03xxxxx',
          authorId: 'u1',
          authorName: 'User',
          timestamp: currentAt - (24 * hourMs),
        },
        {
          id: 6,
          channelId: 'api:main',
          role: 'assistant',
          content: 'm04xxxxx',
          authorName: 'Companion',
          timestamp: currentAt - (20 * hourMs),
        },
        {
          id: 7,
          channelId: 'api:main',
          role: 'user',
          content: 'm05xxxxx',
          authorId: 'u1',
          authorName: 'User',
          timestamp: currentAt - (16 * hourMs),
        },
        {
          id: 8,
          channelId: 'api:main',
          role: 'assistant',
          content: 'm06xxxxx',
          authorName: 'Companion',
          timestamp: currentAt - (12 * hourMs),
        },
        {
          id: 9,
          channelId: 'api:main',
          role: 'user',
          content: 'm07xxxxx',
          authorId: 'u1',
          authorName: 'User',
          timestamp: currentAt - (8 * hourMs),
        },
        {
          id: 10,
          channelId: 'api:main',
          role: 'assistant',
          content: 'm08xxxxx',
          authorName: 'Companion',
          timestamp: currentAt - (6 * hourMs),
        },
        {
          id: 11,
          channelId: 'api:main',
          role: 'user',
          content: 'm09xxxxx',
          authorId: 'u1',
          authorName: 'User',
          timestamp: currentAt - (3 * hourMs),
        },
        {
          id: 12,
          channelId: 'api:main',
          role: 'assistant',
          content: 'm10xxxxx',
          authorName: 'Companion',
          timestamp: currentAt - (1 * hourMs),
        },
      ];

      const spanBound = collectRecentEntriesWithinHistorySpan({
        store: {
          getRecent: (_channelId: string, limit: number) => allEntries.slice(-limit),
        },
        channelId: 'api:main',
        estimatedCount: 5,
        maxHistorySpanMs: 36 * hourMs,
        nowMs: currentAt,
      });

      expect(spanBound.entries.some(entry => entry.content === 'outside-old-01')).toBe(false);

      const complete = vi.fn<LLMProviderPort['complete']>().mockImplementation(async (context, purpose) => {
        expect(purpose).toBe('background');
        expect(context.correlation).toMatchObject({
          channelId: 'api:main',
          callType: 'summary',
          purpose: 'session.recent.summary',
          originStage: 'session.recent.summary.history_budget',
        });
        expect(context.messages[0]?.content).toContain('m03xxxxx');
        expect(context.messages[0]?.content).not.toContain('outside-old-01');
        return {
          content: 'm03-m06 context.',
          model: 'test',
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: [],
          stopReason: 'end_turn',
        };
      });

      const assembled = await assembleSessionHistoryForContextWithLlmSummary({
        entries: spanBound.entries,
        channelVisibility: 'private',
        tokenBudget: 180,
        characterName: 'Companion',
        renderGroupUserAttribution: false,
        channelId: 'api:main',
        llmProvider: makeSummaryProvider(complete),
        promptRegistry: null,
      });

      expect(complete).toHaveBeenCalledTimes(1);
      expect(assembled.summaryText).toContain('[History summary]');
      expect(assembled.summaryText).toContain('m03-m06 context.');
      expect(assembled.summaryText).not.toContain('outside-old-01');
      expect(assembled.summaryText).not.toContain('User said:');
      expect(assembled.summaryText).not.toContain('[Tool result:');
      expect(assembled.summarizedEntryCount).toBeGreaterThan(0);
      expect(assembled.verbatimEntries.length).toBeGreaterThanOrEqual(5);
      expect(assembled.messages[0]).toMatchObject({ role: 'system' });
      expect(assembled.messages[0]?.provenance).toMatchObject({
        kind: 'compaction_summary',
        detailLoss: 'possible',
        emotionalTexture: 'may_be_flattened',
        safeAsPartnerSpeech: false,
      });
      expect(assembled.messages[0]?.provenance?.sourceSpanCount).toBe(assembled.summarizedEntryCount);
      expect(assembled.messages.some(message => message.content.includes('m10xxxxx'))).toBe(true);
    } finally {
      tokenTestUtils.resetTokenizerState();
    }
  });

  it('uses the same recent-summary service for wake orientation summaries', async () => {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    const recentEntries: SessionEntry[] = [
      {
        id: 1,
        channelId: 'api:main',
        role: 'user',
        content: 'Before the break we chose the shared summary service.',
        authorId: 'u1',
        authorName: 'Vega',
        timestamp: now - (5 * hourMs),
      },
      {
        id: 2,
        channelId: 'api:main',
        role: 'assistant',
        content: 'I queued the prompt registry and context-builder tests.',
        authorName: 'Companion',
        timestamp: now - (4 * hourMs),
      },
      {
        id: 3,
        channelId: 'api:main',
        role: 'user',
        content: 'I am back.',
        authorId: 'u1',
        authorName: 'Vega',
        timestamp: now,
      },
    ];
    const continuityEntries: SessionEntry[] = [
      {
        id: 10,
        channelId: 'api:side',
        originChannelId: 'api:side',
        role: 'user',
        content: 'Any update on the prompt registry review?',
        authorId: 'u2',
        authorName: 'Sam',
        timestamp: now - (3 * hourMs),
      },
      {
        id: 11,
        channelId: 'api:side',
        originChannelId: 'api:side',
        role: 'assistant',
        content: 'The side channel is waiting on prompt registry review.',
        authorName: 'Companion',
        timestamp: now - (2 * hourMs),
      },
    ];
    const complete = vi.fn<LLMProviderPort['complete']>().mockImplementation(async (context) => {
      const originStage = context.correlation?.originStage;
      return {
        content: originStage === 'session.recent.summary.wake_continuity'
          ? 'The side channel was waiting on prompt registry review.'
          : 'Before the pause, Vega and Companion chose the shared summary service and queued tests.',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        stopReason: 'end_turn',
      };
    });

    // Live orientation enrichment (wake summaries) runs on the
    // internal-reflection consumption branch; non-internal channels consume
    // the orientation captured once in captureTurnSessionContext (E2.2).
    const ctx = await buildSessionContext({
      channelId: 'internal:reflection:daily',
      systemPrompt: 'System prompt.',
      coreMemoryBlock: '',
      memoriesBlock: '',
      llmProvider: makeSummaryProvider(complete),
      userId: 'u1',
      continuityFallbackUserIds: [],
      store: {
        getRecent: (_channelId: string, _limit: number) => recentEntries,
        getCompactionSummaries: () => [],
      } as never,
      config: makeConfig(),
      eventBus: null,
      promptRegistry: null,
      preCompactionExtractionHandler: null,
      crossChannelContinuity: {
        getMerged: () => continuityEntries,
      },
      wakeReturnArtifacts: [],
      characterName: 'Companion',
      turnSessionContext: {
        channelId: 'internal:reflection:daily',
        recentEntries,
        sourceEntryCount: recentEntries.length,
        compactionSummaryTexts: [],
        focusKnowledgeTexts: [],
        continuityEntries,
        versionPointer: 'test-snapshot',
      },
      recentSummaryMode: 'foreground',
    });

    const originStages = complete.mock.calls.map(([context]) => context.correlation?.originStage);
    expect(originStages).toContain('session.recent.summary.wake_session');
    expect(originStages).toContain('session.recent.summary.wake_continuity');
    expect(ctx.systemPrompt).toContain('Before the pause, Vega and Companion chose the shared summary service');
    expect(ctx.systemPrompt).toContain('The side channel was waiting on prompt registry review.');
    expect(ctx.systemPrompt).not.toContain('Before the break we chose the shared summary service. /');
  });
});

// ── wake_continuity floor + config-owned wake budgets (psfn-framework-67ka) ──

describe('wake_continuity entry floor', () => {
  const hourMs = 60 * 60 * 1000;

  function makeWakeFixtures(now: number): {
    recentEntries: SessionEntry[];
    continuityEntries: SessionEntry[];
  } {
    return {
      recentEntries: [
        {
          id: 1,
          channelId: 'api:main',
          role: 'user',
          content: 'Before the break we chose the shared summary service.',
          authorId: 'u1',
          authorName: 'Vega',
          timestamp: now - (5 * hourMs),
        },
        {
          id: 2,
          channelId: 'api:main',
          role: 'assistant',
          content: 'I queued the prompt registry and context-builder tests.',
          authorName: 'Companion',
          timestamp: now - (4 * hourMs),
        },
        {
          id: 3,
          channelId: 'api:main',
          role: 'user',
          content: 'I am back.',
          authorId: 'u1',
          authorName: 'Vega',
          timestamp: now,
        },
      ],
      continuityEntries: [
        {
          id: 10,
          channelId: 'api:side',
          originChannelId: 'api:side',
          role: 'assistant',
          content: 'The side channel is waiting on prompt registry review.',
          authorName: 'Companion',
          timestamp: now - (2 * hourMs),
        },
      ],
    };
  }

  async function buildWakeContext(params: {
    complete: ReturnType<typeof vi.fn<LLMProviderPort['complete']>>;
    wakeSummaryConfig?: {
      sessionSummaryMaxTokens: number;
      continuitySummaryMaxTokens: number;
      continuityMinEntries: number;
    };
  }): Promise<void> {
    const now = Date.now();
    const { recentEntries, continuityEntries } = makeWakeFixtures(now);
    await buildSessionContext({
      channelId: 'internal:reflection:daily',
      systemPrompt: 'System prompt.',
      coreMemoryBlock: '',
      memoriesBlock: '',
      llmProvider: makeSummaryProvider(params.complete),
      userId: 'u1',
      continuityFallbackUserIds: [],
      store: {
        getRecent: (_channelId: string, _limit: number) => recentEntries,
        getCompactionSummaries: () => [],
      } as never,
      config: makeConfig(),
      eventBus: null,
      promptRegistry: null,
      preCompactionExtractionHandler: null,
      crossChannelContinuity: {
        getMerged: () => continuityEntries,
      },
      wakeReturnArtifacts: [],
      characterName: 'Companion',
      turnSessionContext: {
        channelId: 'internal:reflection:daily',
        recentEntries,
        sourceEntryCount: recentEntries.length,
        compactionSummaryTexts: [],
        focusKnowledgeTexts: [],
        continuityEntries,
        versionPointer: 'test-snapshot',
      },
      recentSummaryMode: 'foreground',
      ...(params.wakeSummaryConfig ? { wakeSummaryConfig: params.wakeSummaryConfig } : {}),
    });
  }

  function makeWakeComplete(): ReturnType<typeof vi.fn<LLMProviderPort['complete']>> {
    return vi.fn<LLMProviderPort['complete']>().mockImplementation(async () => ({
      content: 'Summary text.',
      model: 'test',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      stopReason: 'end_turn',
    }));
  }

  it('skips the wake_continuity LLM call when continuity entries are below the default floor', async () => {
    const complete = makeWakeComplete();
    await buildWakeContext({ complete });

    // One conversational continuity entry < default floor (2): the
    // wake_session lane still fires; the wake_continuity lane must not.
    const originStages = complete.mock.calls.map(([context]) => context.correlation?.originStage);
    expect(originStages).toContain('session.recent.summary.wake_session');
    expect(originStages).not.toContain('session.recent.summary.wake_continuity');
  });

  it('reads the continuity floor and wake budgets from config-owned wakeSummary settings', async () => {
    const complete = makeWakeComplete();
    await buildWakeContext({
      complete,
      wakeSummaryConfig: {
        sessionSummaryMaxTokens: 96,
        continuitySummaryMaxTokens: 80,
        continuityMinEntries: 1,
      },
    });

    // Floor lowered to 1 by config: both wake lanes fire again.
    const originStages = complete.mock.calls.map(([context]) => context.correlation?.originStage);
    expect(originStages).toContain('session.recent.summary.wake_session');
    expect(originStages).toContain('session.recent.summary.wake_continuity');
  });
});
