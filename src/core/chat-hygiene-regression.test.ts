import { describe, expect, it } from 'vitest';
import type { PromptComposer } from './identity/prompt-composer.js';
import {
  buildRuntimeDatetimeAnchorRetryPrompt,
  buildRuntimeDatetimeContradictionRefusal,
  detectRuntimeDatetimeContradiction,
} from './agent/substrate-agent/runtime-datetime-contradiction-guard.js';
import {
  buildStaticPromptSettingsHash,
  captureTurnPromptSnapshot,
  resolveStaticPromptPrefix,
} from './agent/substrate-agent/prompt-lifecycle.js';
import {
  isPendingFollowUpExpired,
  resolvePendingFollowUpExpiryMs,
} from './intention/pending-follow-ups.js';
import { applyTemporalSessionHistoryWindow } from './session/manager-primitives.js';
import { entriesToMessages } from './session/manager/context-support.js';
import {
  buildToolObservationMetadata,
  MASKED_TOOL_OBSERVATION_CONTENT,
  normalizeToolObservation,
} from './session/tool-observation.js';
import type { SessionEntry } from './session/types.js';
import { detectTurnObservabilityWarnings } from './turns/observability-warnings.js';
import type { TurnSnapshot } from './turns/snapshot.js';

function makeEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    id: 1,
    channelId: 'api:test',
    role: 'user',
    content: 'default',
    timestamp: Date.parse('2026-04-18T16:00:00.000Z'),
    ...overrides,
  };
}

function makeSnapshot(
  recentEntries: SessionEntry[],
  overrides: Partial<TurnSnapshot> = {},
): TurnSnapshot {
  return {
    turnId: 'turn-1',
    requestId: 'req-1',
    channelId: 'api:test',
    capturedAt: Date.parse('2026-04-18T16:00:00.000Z'),
    trustLevel: 'regular',
    sessionContext: {
      channelId: 'api:test',
      recentEntries,
      historySummaryEntryCount: recentEntries.length,
      compactionSummaryTexts: [],
      focusKnowledgeTexts: [],
      continuityEntries: [],
      versionPointer: 'session-v1',
    },
    ...overrides,
  };
}

function makePromptComposer(dynamicSuffix: string): PromptComposer {
  return {
    composeSplit: () => ({
      text: `BASE {{user}}\n\n${dynamicSuffix}`,
      hash: 'composed-hash',
      layerCount: 2,
      layerIds: ['base-1', 'values-1'],
      staticPrefix: 'BASE {{user}}',
      dynamicSuffix,
      staticHash: 'static-hash',
      dynamicHash: `dynamic-${dynamicSuffix.length}`,
      staticLayerIds: ['base-1'],
      dynamicLayerIds: ['values-1'],
    }),
  } as PromptComposer;
}

describe('Sprint 8 chat hygiene regressions', () => {
  it('keeps temporal turns anchored to same-day history while dropping prior-day context', () => {
    const now = new Date('2026-04-18T12:00:00.000-04:00');
    const filtered = applyTemporalSessionHistoryWindow([
      makeEntry({
        id: 1,
        content: 'Late last night we discussed the deadline.',
        timestamp: Date.parse('2026-04-17T23:50:00.000-04:00'),
      }),
      makeEntry({
        id: 2,
        role: 'assistant',
        content: 'Earlier this morning we checked the schedule.',
        timestamp: Date.parse('2026-04-18T08:15:00.000-04:00'),
      }),
      makeEntry({
        id: 3,
        content: 'what time is it right now?',
        timestamp: now.getTime(),
      }),
    ], {
      messageText: 'what time is it right now?',
    }, now);

    expect(filtered.map(entry => entry.content)).toEqual([
      'Earlier this morning we checked the schedule.',
      'what time is it right now?',
    ]);
  });

  it('does not warn when recent history sits exactly on the wall-clock cap', () => {
    const nowMs = Date.parse('2026-04-18T16:00:00.000Z');
    const maxHistorySpanMs = 36 * 60 * 60 * 1000;
    const summary = detectTurnObservabilityWarnings({
      callType: 'chat',
      nowMs,
      maxHistorySpanMs,
      temporalRetrievalMode: false,
      snapshot: makeSnapshot([
        makeEntry({
          id: 1,
          content: 'Oldest in-window turn.',
          timestamp: nowMs - maxHistorySpanMs,
        }),
        makeEntry({
          id: 2,
          role: 'assistant',
          content: 'Newest turn.',
          timestamp: nowMs,
        }),
      ]),
      retrievals: [],
    });

    expect(summary).toEqual({
      warnings: [],
      counters: {},
    });
  });

  it('treats masked stale tool observations as hygienic and keeps raw payloads out of context', () => {
    const staleFullObservation = normalizeToolObservation({
      toolName: 'orientation_dump',
      content: 'Orientation note: keep the trust policy lane isolated.',
    });
    const maskedJsonObservation = normalizeToolObservation({
      toolName: 'session_search',
      content: JSON.stringify({
        status: 'ok',
        results: [{ id: 'a' }, { id: 'b' }],
        secret: 'sk-live-1234567890abcdefghijkl',
      }),
    });

    const warningSummary = detectTurnObservabilityWarnings({
      callType: 'chat',
      nowMs: Date.parse('2026-04-18T16:00:00.000Z'),
      maxHistorySpanMs: 36 * 60 * 60 * 1000,
      temporalRetrievalMode: false,
      snapshot: makeSnapshot([
        makeEntry({
          id: 1,
          role: 'tool',
          content: MASKED_TOOL_OBSERVATION_CONTENT,
          timestamp: Date.parse('2026-04-16T16:00:00.000Z'),
          metadata: buildToolObservationMetadata(undefined, staleFullObservation.metadata),
        }),
      ]),
      retrievals: [],
    });
    expect(warningSummary).toEqual({
      warnings: [],
      counters: {},
    });

    const messages = entriesToMessages([
      makeEntry({
        id: 3,
        role: 'tool',
        content: MASKED_TOOL_OBSERVATION_CONTENT,
        metadata: buildToolObservationMetadata(undefined, maskedJsonObservation.metadata),
      }),
    ], 'private');

    expect(messages).toEqual([
      {
        role: 'system',
        content: '[Tool result: session_search] Returned JSON object: status=ok; results=2.',
      },
    ]);
    expect(messages[0]?.content).not.toContain('sk-live-');
    expect(messages[0]?.content).not.toContain('"secret"');
    expect(messages[0]?.content).not.toContain('{"status"');
  });

  it('expires pending follow-ups from the later of age expiry and dueAt grace expiry', () => {
    const followUp = {
      priority: 'low',
      createdAt: '2026-03-25T00:00:00.000Z',
      dueAt: '2026-03-25T12:00:00.000Z',
    } as const;

    expect(resolvePendingFollowUpExpiryMs(followUp)).toBe(
      Date.parse('2026-03-25T20:00:00.000Z'),
    );
    expect(isPendingFollowUpExpired(
      followUp,
      Date.parse('2026-03-25T19:59:59.999Z'),
    )).toBe(false);
    expect(isPendingFollowUpExpired(
      followUp,
      Date.parse('2026-03-25T20:00:00.000Z'),
    )).toBe(true);
  });

  it('keeps companion-derived values in the dynamic suffix without churning the static prompt cache', () => {
    const firstValuesSuffix = [
      '[Companion-Derived Values Layer]',
      '- v7 @ 2026-04-17T22:00:00.000Z (companion_reflection; template=values-reflection; mode=agent):',
      '  We have not heard from the user in days, so continuity may be breaking down.',
    ].join('\n');
    const secondValuesSuffix = [
      '[Companion-Derived Values Layer]',
      '- v8 @ 2026-04-18T09:30:00.000Z (companion_reflection; template=values-reflection; mode=agent):',
      '  We have heard from the user today, so stay grounded in live activity.',
    ].join('\n');

    const firstSnapshot = captureTurnPromptSnapshot({
      promptComposer: makePromptComposer(firstValuesSuffix),
      composeContext: { channelType: 'api' },
      systemPrompt: 'fallback',
    });
    const secondSnapshot = captureTurnPromptSnapshot({
      promptComposer: makePromptComposer(secondValuesSuffix),
      composeContext: { channelType: 'api' },
      systemPrompt: 'fallback',
    });

    expect(firstSnapshot.staticPrefixTemplate).toBe('BASE {{user}}');
    expect(firstSnapshot.staticPrefixTemplate).not.toContain('[Companion-Derived Values Layer]');
    expect(firstSnapshot.dynamicSuffixTemplate).toContain('[Companion-Derived Values Layer]');
    expect(firstSnapshot.staticHash).toBe('static-hash');
    expect(secondSnapshot.staticHash).toBe(firstSnapshot.staticHash);
    expect(secondSnapshot.versionPointer).not.toBe(firstSnapshot.versionPointer);
    expect(firstSnapshot.sectionCacheability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          section: 'dynamicSuffixTemplate',
          cacheability: 'session_stable',
        }),
      ]),
    );

    const settingsHashA = buildStaticPromptSettingsHash({
      user: 'Operator',
      now_iso: '2026-04-18T12:00:00.000-04:00',
    });
    const settingsHashB = buildStaticPromptSettingsHash({
      now_iso: '2026-04-18T12:30:00.000-04:00',
      user: 'Operator',
    });
    expect(settingsHashB).toBe(settingsHashA);

    const cache = new Map<string, { renderedPrefix: string; staticHash: string; settingsHash: string }>();
    const renderedPrefixA = resolveStaticPromptPrefix({
      cache,
      cacheKey: 'api:test::api::contact-1',
      staticPrefixTemplate: firstSnapshot.staticPrefixTemplate,
      staticHash: firstSnapshot.staticHash,
      settingsHash: settingsHashA,
      now: new Date('2026-04-18T12:00:00.000-04:00'),
      variables: {
        user: 'Operator',
        now_iso: '2026-04-18T12:00:00.000-04:00',
      },
    });
    const renderedPrefixB = resolveStaticPromptPrefix({
      cache,
      cacheKey: 'api:test::api::contact-1',
      staticPrefixTemplate: secondSnapshot.staticPrefixTemplate,
      staticHash: secondSnapshot.staticHash,
      settingsHash: settingsHashB,
      now: new Date('2026-04-18T12:30:00.000-04:00'),
      variables: {
        user: 'Operator',
        now_iso: '2026-04-18T12:30:00.000-04:00',
      },
    });

    expect(renderedPrefixA).toBe('BASE Operator');
    expect(renderedPrefixB).toBe(renderedPrefixA);
    expect(cache.size).toBe(1);
  });

  it('guards runtime datetime contradictions only when an authoritative anchor is present', () => {
    expect(detectRuntimeDatetimeContradiction(
      { runtimeContext: 'No authoritative clock block here.' },
      'The clock is off and that cannot be right.',
    )).toEqual({
      anchorDetected: false,
      contradictionDetected: false,
      matchedSignals: [],
    });

    expect(detectRuntimeDatetimeContradiction(
      {
        runtimeContextSections: [
          {
            id: 'current_datetime',
            content: '<current_datetime>2026-03-18T09:30:00.000-04:00</current_datetime>',
          },
        ],
      },
      'The clock is off. Are you sure that cannot be right?',
    )).toEqual({
      anchorDetected: true,
      contradictionDetected: true,
      matchedSignals: ['clock_is_off', 'cannot_be_right', 'are_you_sure'],
    });

    expect(buildRuntimeDatetimeAnchorRetryPrompt('Base system prompt')).toContain(
      '<runtime_datetime_guard>',
    );
    expect(buildRuntimeDatetimeAnchorRetryPrompt('Base system prompt')).toContain(
      'The runtime current_datetime block is authoritative for this turn.',
    );
    expect(buildRuntimeDatetimeContradictionRefusal()).toBe(
      'I cannot treat the authoritative runtime datetime anchor as wrong. I will answer from the runtime current_datetime block instead.',
    );
  });
});
