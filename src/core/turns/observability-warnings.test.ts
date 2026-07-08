import { describe, expect, it } from 'vitest';
import {
  buildToolObservationMetadata,
  normalizeToolObservation,
} from '../session/tool-observation.js';
import {
  detectTurnObservabilityWarnings,
  type TurnObservabilityWarningCode,
} from './observability-warnings.js';
import type { TurnSnapshot } from './snapshot.js';
import {
  createPromptPlan,
  createPromptPlanBlock,
} from '../agent/substrate-agent/turn-execution/prompt-plan.js';

function buildSnapshot(nowMs: number): TurnSnapshot {
  const staleObservation = normalizeToolObservation({
    toolName: 'orientation_dump',
    content: 'Orientation note: keep the trust policy lane isolated.',
  });

  return {
    turnId: 'turn-1',
    requestId: 'req-1',
    channelId: 'api:test',
    capturedAt: nowMs,
    trustLevel: 'regular',
    sessionContext: {
      channelId: 'api:test',
      recentEntries: [
        {
          id: 1,
          channelId: 'api:test',
          role: 'tool',
          content: staleObservation.content,
          timestamp: nowMs - (48 * 60 * 60 * 1000),
          metadata: buildToolObservationMetadata(undefined, staleObservation.metadata),
        },
        {
          id: 2,
          channelId: 'api:test',
          role: 'assistant',
          content: 'Checking in from yesterday.',
          timestamp: nowMs - (24 * 60 * 60 * 1000),
        },
        {
          id: 3,
          channelId: 'api:test',
          role: 'user',
          content: 'What changed just now?',
          timestamp: nowMs,
        },
      ],
      historySummaryEntryCount: 4,
      compactionSummaryTexts: [],
      focusKnowledgeTexts: [],
      continuityEntries: [
        {
          id: 4,
          channelId: 'discord:live',
          originChannelId: 'discord:live',
          role: 'assistant',
          content: 'Live continuity ping.',
          timestamp: nowMs - (5 * 60 * 1000),
        },
      ],
      versionPointer: 'session-v1',
    },
    memory: {
      channelId: 'api:test',
      contactEmotionalMemories: [],
      semanticCandidates: [
        {
          id: 'reflection-memory',
          text: 'It has been 3 days since we last heard from the user.',
          type: 'reflection',
          importance: 0.8,
          confidence: 0.9,
          emotionalValence: 0.1,
          salience: 0.7,
          sourceRef: 'reflection:journal',
          extractedAt: nowMs - (3 * 24 * 60 * 60 * 1000),
          lastAccessed: nowMs - (2 * 60 * 1000),
          accessCount: 1,
          tags: ['reflection'],
          sensitivity: 'personal',
          similarity: 0.91,
        },
      ],
      lexicalCandidates: [],
      proactiveCandidates: [],
      versionPointer: 'memory-v1',
    },
    plan: createPromptPlan({
      blocks: [
        createPromptPlanBlock({
          id: 'dynamic_suffix',
          layer: 'prompt_stack',
          volatility: 'turn',
          producer: 'identity.prompt-runtime',
          renderedText: [
            '[Companion-Derived Values Layer]',
            '- v7 @ 2026-04-17T22:00:00.000Z (companion_reflection; template=values-reflection; mode=agent):',
            '  We have not heard from the user in days, so continuity may be breaking down.',
          ].join('\n'),
        }),
      ],
      variables: {},
      messages: [],
      toolDefinitions: [],
      scope: {
        kind: 'group',
        channelId: 'api:test',
        recentSpeakers: [],
        key: 'room:api:test',
      },
    }),
  };
}

describe('detectTurnObservabilityWarnings', () => {
  it('emits the expected warning set and counters from a canned chat-turn fixture', () => {
    const nowMs = Date.parse('2026-04-18T16:00:00.000Z');
    const summary = detectTurnObservabilityWarnings({
      callType: 'chat',
      nowMs,
      maxHistorySpanMs: 36 * 60 * 60 * 1000,
      temporalRetrievalMode: true,
      snapshot: buildSnapshot(nowMs),
      retrievals: [
        {
          observedAt: nowMs,
          turnId: 'turn-1',
          requestId: 'req-1',
          channelId: 'api:test',
          callType: 'chat',
          purpose: 'memory.retrieval',
          count: 2,
          reason: 'ok',
          retrievalSource: 'embedding',
          data: {
            selectedTypes: {
              reflection: 2,
            },
          },
        },
      ],
    });

    const codes = summary.warnings.map(warning => warning.code).sort();
    expect(codes).toEqual([
      'history_span_exceeded',
      'stale_tool_observation_verbatim',
      'temporal_reflection_only_retrieval',
      'values_activity_contradiction',
    ] satisfies TurnObservabilityWarningCode[]);
    expect(summary.counters).toEqual({
      warningCount: 4,
      historySpanExceededCount: 1,
      temporalReflectionOnlyRetrievalCount: 2,
      staleToolObservationVerbatimCount: 1,
      valuesActivityContradictionCount: 2,
    });
    expect(summary.warnings.find(warning => warning.code === 'history_span_exceeded')?.details).toEqual(
      expect.objectContaining({
        actualSpanMs: 48 * 60 * 60 * 1000,
        overflowMs: 12 * 60 * 60 * 1000,
      }),
    );
    expect(summary.warnings.find(warning => warning.code === 'stale_tool_observation_verbatim')?.details).toEqual(
      expect.objectContaining({
        staleObservationCount: 1,
        toolNames: ['orientation_dump'],
      }),
    );
    expect(summary.warnings.find(warning => warning.code === 'values_activity_contradiction')?.details).toEqual(
      expect.objectContaining({
        contradictionCount: 2,
        claimSources: ['values_layer', 'reflection_memory'],
      }),
    );
  });

  it('fails closed to no warnings for non-chat turns', () => {
    const nowMs = Date.parse('2026-04-18T16:00:00.000Z');
    const summary = detectTurnObservabilityWarnings({
      callType: 'scheduled',
      nowMs,
      maxHistorySpanMs: 36 * 60 * 60 * 1000,
      temporalRetrievalMode: true,
      snapshot: buildSnapshot(nowMs),
      retrievals: [],
    });

    expect(summary).toEqual({
      warnings: [],
      counters: {},
    });
  });
});
