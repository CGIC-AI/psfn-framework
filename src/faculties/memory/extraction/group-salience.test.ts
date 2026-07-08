import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  createDefaultGroupMemorySettings,
  type GroupMemorySalienceLowSignalRules,
  type GroupMemorySalienceReasonWeights,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import type { GroupMemoryRangeChunk } from './group-ranges.js';
import { selectGroupMemorySalienceCandidates } from './group-salience.js';

function makeEntry(id: number, content: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: 'discord-room',
    role: 'user',
    content,
    authorId: `user-${id % 4}`,
    authorName: `User ${id % 4}`,
    timestamp: id * 1_000,
    ...overrides,
  };
}

function makeChatterEntries(count: number): SessionEntry[] {
  const chatter = ['lol', 'ok', 'fr', 'same', 'yeah'];
  return Array.from({ length: count }, (_unused, index) => (
    makeEntry(index + 1, chatter[index % chatter.length])
  ));
}

function makeChunk(entries: SessionEntry[]): GroupMemoryRangeChunk {
  return {
    channelId: 'discord-room',
    policyVersion: 'group-memory:v1',
    spanStartMessageId: entries[0]?.id ?? 0,
    spanEndMessageId: entries.at(-1)?.id ?? 0,
    contextStartMessageId: entries[0]?.id ?? 0,
    contextEndMessageId: entries.at(-1)?.id ?? 0,
    entries,
    newEntries: entries,
    newEntryCount: entries.length,
    overlapEntryCount: 0,
    estimatedTokens: entries.length,
  };
}

type SalienceTestOverrides =
  Partial<Omit<GroupMemorySettings['salience'], 'reasonWeights' | 'lowSignalRules'>>
  & {
    reasonWeights?: Partial<GroupMemorySalienceReasonWeights>;
    lowSignalRules?: Partial<GroupMemorySalienceLowSignalRules>;
  };

function settings(overrides: SalienceTestOverrides = {}): GroupMemorySettings {
  const defaults = createDefaultGroupMemorySettings();
  return {
    ...defaults,
    salience: {
      ...defaults.salience,
      ...overrides,
      reasonWeights: {
        ...defaults.salience.reasonWeights,
        ...(overrides.reasonWeights ?? {}),
      },
      lowSignalRules: {
        ...defaults.salience.lowSignalRules,
        ...(overrides.lowSignalRules ?? {}),
      },
    },
  };
}

describe('group salience candidate selection', () => {
  it('keeps chatter-heavy 75-message chunks bounded while retaining durable signals', () => {
    const entries = makeChatterEntries(75);
    entries[9] = makeEntry(10, 'Carlini, I need you to remember that I hate blue cheese.');
    entries[19] = makeEntry(20, 'My favorite coffee is a cardamom latte.');
    entries[39] = makeEntry(40, "Please don't share my work schedule outside this room.");
    entries[49] = makeEntry(50, 'I will bring the monastery beer recipe tomorrow.');

    const selection = selectGroupMemorySalienceCandidates({
      chunk: makeChunk(entries),
      settings: settings({
        maxCandidateSpansPerChunk: 8,
        neighboringContextMessages: 1,
      }),
      companionNames: ['Carlini'],
    });

    const selectedIds = selection.candidateSpans.flatMap(span => span.sourceMessageIds);
    expect(selectedIds).toEqual(expect.arrayContaining([10, 20, 40, 50]));
    expect(selectedIds).not.toContain(1);
    expect(selection.candidateSpans.length).toBeLessThanOrEqual(8);
    expect(selection.telemetry.messagesConsidered).toBe(75);
    expect(selection.telemetry.skipReasons.low_signal).toBeGreaterThan(0);
    expect(selection.telemetry.selectedReasonCounts.companion_mention).toBeGreaterThan(0);
    expect(selection.telemetry.selectedReasonCounts.explicit_preference).toBeGreaterThan(0);
    expect(selection.telemetry.selectedReasonCounts.boundary_safety).toBeGreaterThan(0);
    expect(selection.telemetry.selectedReasonCounts.commitment).toBeGreaterThan(0);
  });

  it('selects important participant facts even when the companion was not addressed', () => {
    const entries = [
      makeEntry(1, 'lol'),
      makeEntry(2, 'My brother Vega is helping run moderation tonight.'),
      makeEntry(3, 'ok'),
    ];

    const selection = selectGroupMemorySalienceCandidates({
      chunk: makeChunk(entries),
      settings: settings({
        neighboringContextMessages: 0,
      }),
      companionNames: ['Carlini'],
    });

    expect(selection.candidateSpans).toHaveLength(1);
    expect(selection.candidateSpans[0].sourceMessageIds).toEqual([2]);
    expect(selection.candidateSpans[0].reasons).toEqual(
      expect.arrayContaining(['participant_fact', 'relationship_claim']),
    );
  });

  it('preserves configured neighboring context around selected messages', () => {
    const entries = [
      makeEntry(1, 'earlier setup'),
      makeEntry(2, 'My favorite tea is jasmine.'),
      makeEntry(3, 'ok'),
      makeEntry(4, 'unrelated'),
    ];

    const selection = selectGroupMemorySalienceCandidates({
      chunk: makeChunk(entries),
      settings: settings({
        neighboringContextMessages: 1,
      }),
    });

    expect(selection.candidateSpans).toHaveLength(1);
    expect(selection.candidateSpans[0].sourceMessageIds).toEqual([2]);
    expect(selection.candidateSpans[0].contextMessageIds).toEqual([1, 2, 3]);
  });

  it('honors non-default reason weights without code changes', () => {
    const entries = [
      makeEntry(1, 'My favorite coffee is a cardamom latte.'),
    ];
    const lowPreferenceWeight = selectGroupMemorySalienceCandidates({
      chunk: makeChunk(entries),
      settings: settings({
        minCandidateScore: 0.7,
        reasonWeights: {
          explicitPreference: 0.1,
        },
      }),
    });
    const highPreferenceWeight = selectGroupMemorySalienceCandidates({
      chunk: makeChunk(entries),
      settings: settings({
        minCandidateScore: 0.7,
        reasonWeights: {
          explicitPreference: 0.75,
        },
      }),
    });

    expect(lowPreferenceWeight.candidateSpans).toHaveLength(0);
    expect(lowPreferenceWeight.telemetry.skipReasons.below_threshold).toBe(1);
    expect(highPreferenceWeight.candidateSpans).toHaveLength(1);
    expect(highPreferenceWeight.candidateSpans[0].sourceMessageIds).toEqual([1]);
  });

  it('honors the configured candidate-span cap and reports capped spans', () => {
    const entries = [
      makeEntry(1, 'My favorite coffee is a cardamom latte.'),
      makeEntry(2, 'lol'),
      makeEntry(3, 'Please do not share my schedule.'),
      makeEntry(4, 'ok'),
      makeEntry(5, 'I will bring notes tomorrow.'),
    ];

    const selection = selectGroupMemorySalienceCandidates({
      chunk: makeChunk(entries),
      settings: settings({
        maxCandidateSpansPerChunk: 2,
        neighboringContextMessages: 0,
      }),
    });

    expect(selection.candidateSpans).toHaveLength(2);
    expect(selection.telemetry.skipReasons.candidate_cap).toBe(1);
  });
});
