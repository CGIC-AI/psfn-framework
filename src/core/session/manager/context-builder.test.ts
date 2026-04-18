import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOrientationNoteTelemetry } from './context-builder.js';

describe('orientation context surface wiring', () => {
  it('threads orientation telemetry into continuity assembly without relying on legacy token-section labels', () => {
    const builderSource = readFileSync(resolve('src/core/session/manager/context-builder.ts'), 'utf-8');
    const manifestSource = readFileSync(resolve('src/core/session/context-manifest.ts'), 'utf-8');

    expect(builderSource).toContain('buildOrientationNoteTelemetry');
    expect(builderSource).toContain('params.turnSnapshot && !isInternalReflectionChannel(params.channelId)');
    expect(builderSource).toContain('continuitySectionText = orientationTelemetry.noteText');
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
});
