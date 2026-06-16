import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { __test as tokenTestUtils } from '../../../primitives/llm/tokens.js';
import { assembleSessionHistoryForContext, buildOrientationNoteTelemetry } from './context-builder.js';
import { collectRecentEntriesWithinHistorySpan } from '../manager-primitives.js';
import type { SessionEntry } from '../types.js';

describe('orientation context surface wiring', () => {
  it('threads orientation telemetry into a dedicated runtime prompt section', () => {
    const builderSource = readFileSync(resolve('src/core/session/manager/context-builder.ts'), 'utf-8');
    const manifestSource = readFileSync(resolve('src/core/session/context-manifest.ts'), 'utf-8');

    expect(builderSource).toContain('buildOrientationNoteTelemetry');
    expect(builderSource).toContain('params.turnSnapshot && !isInternalReflectionChannel(params.channelId)');
    expect(builderSource).toContain('buildStructuredWakeOrientationBlock(orientationTelemetry)');
    expect(builderSource).toContain('<wake_orientation authority="idle_gap_context"');
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
      nowMs: currentAt,
    });
    expect(reflectionTelemetry).toMatchObject({
      fired: true,
      reason: 'idle_gap_exceeded',
      continuitySummary: expect.stringContaining('The API thread still needs the recovery notes.'),
    });
    expect(reflectionTelemetry.noteText).toContain('Welcome back');
  });

  it('summarizes older in-window history while keeping a recent verbatim tail for a 7-day session', () => {
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

      const assembled = assembleSessionHistoryForContext({
        entries: spanBound.entries,
        channelVisibility: 'private',
        tokenBudget: 150,
        characterName: 'Companion',
      });

      expect(assembled.summaryText).toContain('[History summary]');
      expect(assembled.summaryText).toContain('m01xxxxx');
      expect(assembled.summaryText).not.toContain('outside-old-01');
      expect(assembled.summarizedEntryCount).toBeGreaterThan(0);
      expect(assembled.verbatimEntries.length).toBeGreaterThanOrEqual(5);
      expect(assembled.messages[0]).toMatchObject({ role: 'system' });
      expect(assembled.messages.some(message => message.content.includes('m10xxxxx'))).toBe(true);
    } finally {
      tokenTestUtils.resetTokenizerState();
    }
  });
});
