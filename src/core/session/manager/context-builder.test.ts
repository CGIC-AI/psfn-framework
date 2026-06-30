import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { __test as tokenTestUtils } from '../../../primitives/llm/tokens.js';
import type { LLMProviderPort } from '../../agent/contracts.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  assembleSessionHistoryForContextWithLlmSummary,
  buildOrientationNoteTelemetry,
  buildSessionContext,
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

describe('orientation context surface wiring', () => {
  it('threads orientation telemetry into a dedicated runtime prompt section', () => {
    const builderSource = readFileSync(resolve('src/core/session/manager/context-builder.ts'), 'utf-8');
    const manifestSource = readFileSync(resolve('src/core/session/context-manifest.ts'), 'utf-8');

    expect(builderSource).toContain('buildOrientationNoteTelemetry');
    expect(builderSource).toContain('params.turnSnapshot && !isInternalReflectionChannel(params.channelId)');
    expect(builderSource).toContain('buildContinuityAnchorLines({');
    expect(builderSource).toContain('<continuity_anchor authority="companion_context"');
    expect(builderSource).toContain('<cross_channel_continuity authority="retrieved_context"');
    expect(builderSource).toContain("id: 'session.orientation'");
    expect(builderSource).toContain("id: 'wake_orientation'");
    expect(manifestSource).toContain("| 'orientation'");
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

    const ctx = await buildSessionContext({
      channelId: 'api:main',
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
      focusKnowledgeTexts: [],
      focusCompactionRanges: [],
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
