import { describe, expect, it } from 'vitest';
import type { ExtractedFact } from '../types.js';
import { createDefaultGroupMemorySettings } from '../../../system/config/group-memory-config.js';
import {
  selectExtractionWriteCandidates,
  type WriteCandidateSelectionInput,
} from './write-selection.js';
import type { RoutedAcceptedFactCandidate } from './fact-acceptance.js';

function candidate(
  index: number,
  valueScore: number,
  overrides: Partial<RoutedAcceptedFactCandidate> = {},
): RoutedAcceptedFactCandidate {
  const fact: ExtractedFact = {
    text: `fact ${index}`,
    type: 'semantic',
    importance: 0.8,
    emotionalValence: 0,
    confidence: 0.9,
    tags: [],
  };
  return {
    fact,
    novelty: 1,
    valueScore,
    index,
    routing: {
      status: 'route',
      contactId: `contact-${index}`,
      reason: 'single_speaker_transcript',
    },
    ...overrides,
  };
}

function buildInput(
  overrides: Partial<WriteCandidateSelectionInput> = {},
): WriteCandidateSelectionInput {
  return {
    acceptedCandidates: [],
    maxWrites: 2,
    groupWriteCaps: undefined,
    groupWriteCapContext: undefined,
    channelId: 'api:test',
    telemetryEnabled: false,
    ...overrides,
  };
}

describe('selectExtractionWriteCandidates', () => {
  describe('direct path (no group caps)', () => {
    it('ranks candidates by value score and keeps the top maxWrites', () => {
      const low = candidate(0, 0.2);
      const high = candidate(1, 0.9);
      const mid = candidate(2, 0.5);
      const result = selectExtractionWriteCandidates(buildInput({
        acceptedCandidates: [low, high, mid],
        maxWrites: 2,
      }));
      expect(result.selectedCandidates).toEqual([high, mid]);
      expect(result.writeCapSkippedCount).toBe(1);
      expect(result.writeCapSkips).toEqual([]);
    });

    it('does not reorder the caller-owned candidate list', () => {
      const candidates = [candidate(0, 0.2), candidate(1, 0.9)];
      selectExtractionWriteCandidates(buildInput({ acceptedCandidates: candidates }));
      expect(candidates.map(c => c.index)).toEqual([0, 1]);
    });

    it('breaks value-score ties by source order', () => {
      const first = candidate(0, 0.5);
      const second = candidate(1, 0.5);
      const result = selectExtractionWriteCandidates(buildInput({
        acceptedCandidates: [second, first],
        maxWrites: 1,
      }));
      expect(result.selectedCandidates).toEqual([first]);
    });

    it('reports zero skips when everything fits under the cap', () => {
      const result = selectExtractionWriteCandidates(buildInput({
        acceptedCandidates: [candidate(0, 0.5)],
        maxWrites: 2,
      }));
      expect(result.selectedCandidates).toHaveLength(1);
      expect(result.writeCapSkippedCount).toBe(0);
    });
  });

  describe('group path', () => {
    it('applies the group run cap and surfaces structured skip telemetry', () => {
      const writeCaps = {
        ...createDefaultGroupMemorySettings().writeCaps,
        maxWritesPerRun: 1,
      };
      const result = selectExtractionWriteCandidates(buildInput({
        acceptedCandidates: [candidate(0, 0.9), candidate(1, 0.5)],
        maxWrites: 99,
        groupWriteCaps: writeCaps,
      }));
      expect(result.selectedCandidates).toHaveLength(1);
      expect(result.writeCapSkippedCount).toBe(1);
      expect(result.writeCapSkips.map(skip => skip.reason)).toContain('run_cap');
    });

    it('ignores the direct maxWrites cap when group caps are active', () => {
      const writeCaps = {
        ...createDefaultGroupMemorySettings().writeCaps,
        maxWritesPerRun: 5,
      };
      const result = selectExtractionWriteCandidates(buildInput({
        acceptedCandidates: [candidate(0, 0.9), candidate(1, 0.5), candidate(2, 0.4)],
        maxWrites: 1,
        groupWriteCaps: writeCaps,
      }));
      expect(result.selectedCandidates).toHaveLength(3);
      expect(result.writeCapSkippedCount).toBe(0);
    });

    it('enforces the tighter backfill cap when the run is a backfill', () => {
      const writeCaps = {
        ...createDefaultGroupMemorySettings().writeCaps,
        maxWritesPerRun: 5,
        maxWritesPerBackfillRun: 1,
      };
      const acceptedCandidates = [candidate(0, 0.9), candidate(1, 0.5)];
      const normalRun = selectExtractionWriteCandidates(buildInput({
        acceptedCandidates,
        groupWriteCaps: writeCaps,
        groupWriteCapContext: { backfill: false },
      }));
      expect(normalRun.selectedCandidates).toHaveLength(2);
      const backfillRun = selectExtractionWriteCandidates(buildInput({
        acceptedCandidates,
        groupWriteCaps: writeCaps,
        groupWriteCapContext: { backfill: true },
      }));
      expect(backfillRun.selectedCandidates).toHaveLength(1);
      expect(backfillRun.writeCapSkips.map(skip => skip.reason)).toContain('backfill_cap');
    });

    it('counts recent time-window writes against the window cap', () => {
      const writeCaps = {
        ...createDefaultGroupMemorySettings().writeCaps,
        maxWritesPerRun: 5,
        maxWritesPerTimeWindow: 2,
      };
      const result = selectExtractionWriteCandidates(buildInput({
        acceptedCandidates: [candidate(0, 0.9), candidate(1, 0.5)],
        groupWriteCaps: writeCaps,
        groupWriteCapContext: { recentTimeWindowWriteCount: 1 },
      }));
      expect(result.selectedCandidates).toHaveLength(1);
      expect(result.writeCapSkips.map(skip => skip.reason)).toContain('time_window_cap');
    });
  });
});
