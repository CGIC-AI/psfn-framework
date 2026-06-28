import { describe, expect, it } from 'vitest';
import {
  createDefaultGroupMemorySettings,
  type GroupMemoryWriteCapSettings,
} from '../../../system/config/group-memory-config.js';
import type { ExtractedFact, GroupMemoryAddressMode } from '../types.js';
import {
  computeGroupMemoryWriteCandidateScore,
  selectGroupMemoryWriteCandidates,
  type GroupMemoryWriteCandidate,
} from './group-write-caps.js';

function writeCaps(
  overrides: Partial<GroupMemoryWriteCapSettings> = {},
): GroupMemoryWriteCapSettings {
  const defaults = createDefaultGroupMemorySettings().writeCaps;
  return {
    ...defaults,
    ...overrides,
    rankingWeights: {
      ...defaults.rankingWeights,
      ...(overrides.rankingWeights ?? {}),
    },
    addressModeWeights: {
      ...defaults.addressModeWeights,
      ...(overrides.addressModeWeights ?? {}),
    },
  };
}

function candidate(params: {
  index: number;
  contactId?: string;
  sourceContactId?: string;
  subjectContactId?: string;
  importance?: number;
  confidence?: number;
  novelty?: number;
  emotionalValence?: number;
  type?: ExtractedFact['type'];
  tags?: string[];
  addressMode?: GroupMemoryAddressMode;
}): GroupMemoryWriteCandidate {
  const fact: ExtractedFact = {
    text: `fact-${params.index}`,
    type: params.type ?? 'semantic',
    importance: params.importance ?? 0.8,
    confidence: params.confidence ?? 0.9,
    novelty: params.novelty ?? 0.8,
    emotionalValence: params.emotionalValence ?? 0,
    tags: params.tags ?? [],
  };
  return {
    fact,
    novelty: params.novelty ?? 0.8,
    valueScore: fact.importance + fact.confidence + (params.novelty ?? 0.8),
    index: params.index,
    routing: {
      ...(params.contactId ? { contactId: params.contactId } : {}),
      ...(params.sourceContactId ? { sourceContactId: params.sourceContactId } : {}),
      ...(params.subjectContactId ? { subjectContactId: params.subjectContactId } : {}),
      ...(params.addressMode ? { addressMode: params.addressMode } : {}),
    },
  };
}

describe('selectGroupMemoryWriteCandidates', () => {
  it('can write more than two memories from a normal group chunk when config allows it', () => {
    const candidates = [
      candidate({ index: 1, contactId: 'contact-a', importance: 0.92 }),
      candidate({ index: 2, contactId: 'contact-a', importance: 0.84 }),
      candidate({ index: 3, contactId: 'contact-b', importance: 0.9 }),
      candidate({ index: 4, contactId: 'contact-b', importance: 0.82 }),
      candidate({ index: 5, contactId: 'contact-c', importance: 0.88 }),
      candidate({ index: 6, contactId: 'contact-c', importance: 0.8 }),
    ];

    const selection = selectGroupMemoryWriteCandidates({
      candidates,
      settings: writeCaps({
        maxWritesPerRun: 5,
        maxWritesPerChunk: 5,
        maxWritesPerContact: 2,
        maxWritesPerSubject: 2,
        maxLowSalienceWritesPerRun: 5,
      }),
    });

    expect(selection.selectedCandidates).toHaveLength(5);
    expect(selection.selectedCandidates.length).toBeGreaterThan(2);
    expect(selection.telemetry.skips).toEqual([
      expect.objectContaining({
        reason: 'run_cap',
        skippedCount: 1,
        configuredLimit: 5,
      }),
    ]);
  });

  it('prevents one loud participant from consuming writes for the whole group', () => {
    const selection = selectGroupMemoryWriteCandidates({
      candidates: [
        candidate({ index: 1, contactId: 'contact-loud', importance: 0.99 }),
        candidate({ index: 2, contactId: 'contact-loud', importance: 0.98 }),
        candidate({ index: 3, contactId: 'contact-loud', importance: 0.97 }),
        candidate({ index: 4, contactId: 'contact-quiet-a', importance: 0.74 }),
        candidate({ index: 5, contactId: 'contact-quiet-b', importance: 0.73 }),
      ],
      settings: writeCaps({
        maxWritesPerRun: 4,
        maxWritesPerChunk: 4,
        maxWritesPerContact: 1,
        maxWritesPerSubject: 2,
        maxLowSalienceWritesPerRun: 4,
      }),
    });

    expect(selection.selectedCandidates.map(item => item.routing.contactId)).toEqual([
      'contact-loud',
      'contact-quiet-a',
      'contact-quiet-b',
    ]);
    expect(selection.telemetry.skips).toEqual([
      expect.objectContaining({
        reason: 'contact_cap',
        skippedCount: 2,
        configuredLimit: 1,
        affectedContactIds: ['contact-loud'],
      }),
    ]);
  });

  it('caps repeated facts about the same subject separately from source contact', () => {
    const selection = selectGroupMemoryWriteCandidates({
      candidates: [
        candidate({
          index: 1,
          sourceContactId: 'contact-speaker-a',
          subjectContactId: 'contact-subject',
          importance: 0.9,
        }),
        candidate({
          index: 2,
          sourceContactId: 'contact-speaker-b',
          subjectContactId: 'contact-subject',
          importance: 0.88,
        }),
        candidate({
          index: 3,
          sourceContactId: 'contact-speaker-c',
          subjectContactId: 'contact-other',
          importance: 0.86,
        }),
      ],
      settings: writeCaps({
        maxWritesPerRun: 3,
        maxWritesPerChunk: 3,
        maxWritesPerContact: 3,
        maxWritesPerSubject: 1,
        maxLowSalienceWritesPerRun: 3,
      }),
    });

    expect(selection.selectedCandidates.map(item => item.routing.subjectContactId)).toEqual([
      'contact-subject',
      'contact-other',
    ]);
    expect(selection.telemetry.skips).toEqual([
      expect.objectContaining({
        reason: 'subject_cap',
        skippedCount: 1,
        configuredLimit: 1,
        affectedSubjectContactIds: ['contact-subject'],
      }),
    ]);
  });

  it('keeps low-salience facts tightly capped', () => {
    const selection = selectGroupMemoryWriteCandidates({
      candidates: [
        candidate({ index: 1, contactId: 'contact-a', importance: 0.9 }),
        candidate({ index: 2, contactId: 'contact-b', importance: 0.49 }),
        candidate({ index: 3, contactId: 'contact-c', importance: 0.48 }),
        candidate({ index: 4, contactId: 'contact-d', importance: 0.47 }),
      ],
      settings: writeCaps({
        maxWritesPerRun: 4,
        maxWritesPerChunk: 4,
        maxWritesPerContact: 4,
        maxWritesPerSubject: 4,
        maxLowSalienceWritesPerRun: 1,
        lowSalienceThreshold: 0.5,
      }),
    });

    expect(selection.selectedCandidates.map(item => item.index)).toEqual([1, 2]);
    expect(selection.telemetry.skips).toEqual([
      expect.objectContaining({
        reason: 'low_salience_cap',
        skippedCount: 2,
        configuredLimit: 1,
        affectedClasses: ['low_salience'],
      }),
    ]);
  });

  it('uses the configured backfill cap for catch-up runs', () => {
    const selection = selectGroupMemoryWriteCandidates({
      candidates: [
        candidate({ index: 1, contactId: 'contact-a' }),
        candidate({ index: 2, contactId: 'contact-b' }),
        candidate({ index: 3, contactId: 'contact-c' }),
        candidate({ index: 4, contactId: 'contact-d' }),
        candidate({ index: 5, contactId: 'contact-e' }),
      ],
      settings: writeCaps({
        maxWritesPerRun: 8,
        maxWritesPerChunk: 8,
        maxWritesPerContact: 8,
        maxWritesPerSubject: 8,
        maxLowSalienceWritesPerRun: 8,
        maxWritesPerBackfillRun: 3,
      }),
      backfill: true,
    });

    expect(selection.selectedCandidates).toHaveLength(3);
    expect(selection.telemetry.effectiveMaxWrites).toBe(3);
    expect(selection.telemetry.skips).toEqual([
      expect.objectContaining({
        reason: 'backfill_cap',
        skippedCount: 2,
        configuredLimit: 3,
      }),
    ]);
  });

  it('honors the configured rolling time-window write cap', () => {
    const selection = selectGroupMemoryWriteCandidates({
      candidates: [
        candidate({ index: 1, contactId: 'contact-a' }),
        candidate({ index: 2, contactId: 'contact-b' }),
        candidate({ index: 3, contactId: 'contact-c' }),
      ],
      settings: writeCaps({
        maxWritesPerRun: 8,
        maxWritesPerChunk: 8,
        maxWritesPerContact: 8,
        maxWritesPerSubject: 8,
        maxLowSalienceWritesPerRun: 8,
        maxWritesPerTimeWindow: 3,
        timeWindowMs: 1_800_000,
      }),
      recentTimeWindowWriteCount: 2,
    });

    expect(selection.selectedCandidates).toHaveLength(1);
    expect(selection.telemetry.effectiveMaxWrites).toBe(1);
    expect(selection.telemetry.skips).toEqual([
      expect.objectContaining({
        reason: 'time_window_cap',
        skippedCount: 2,
        configuredLimit: 3,
        affectedClasses: ['window:1800000ms'],
      }),
    ]);
  });

  it('changes ranking when non-default JSON config changes weights', () => {
    const direct = candidate({
      index: 1,
      contactId: 'contact-direct',
      importance: 0.6,
      addressMode: 'direct_to_companion',
    });
    const overheard = candidate({
      index: 2,
      contactId: 'contact-overheard',
      importance: 0.9,
      addressMode: 'overheard_room_context',
    });
    const importanceWeighted = writeCaps({
      rankingWeights: {
        importance: 1,
        novelty: 0,
        confidence: 0,
        addressMode: 0,
        relationshipRelevance: 0,
        emotionalIntensity: 0,
        perContactCoverage: 0,
      },
    });
    const addressWeighted = writeCaps({
      rankingWeights: {
        importance: 0,
        novelty: 0,
        confidence: 0,
        addressMode: 1,
        relationshipRelevance: 0,
        emotionalIntensity: 0,
        perContactCoverage: 0,
      },
      addressModeWeights: {
        directToCompanion: 1,
        mentionOfCompanion: 0,
        replyToUser: 0,
        overheardRoomContext: 0,
        systemApi: 0,
      },
    });

    expect(
      computeGroupMemoryWriteCandidateScore(overheard, importanceWeighted),
    ).toBeGreaterThan(
      computeGroupMemoryWriteCandidateScore(direct, importanceWeighted),
    );
    expect(
      computeGroupMemoryWriteCandidateScore(direct, addressWeighted),
    ).toBeGreaterThan(
      computeGroupMemoryWriteCandidateScore(overheard, addressWeighted),
    );
    expect(selectGroupMemoryWriteCandidates({
      candidates: [direct, overheard],
      settings: importanceWeighted,
    }).selectedCandidates[0].index).toBe(2);
    expect(selectGroupMemoryWriteCandidates({
      candidates: [direct, overheard],
      settings: addressWeighted,
    }).selectedCandidates[0].index).toBe(1);
  });
});
