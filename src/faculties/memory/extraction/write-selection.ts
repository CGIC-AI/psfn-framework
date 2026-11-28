import { createComponentLogger } from '../../../shared/logger.js';
import type { GroupMemoryWriteCapSettings } from '../../../system/config/group-memory-config.js';
import { selectGroupMemoryWriteCandidates } from './group-write-caps.js';
import { compareAcceptedFactCandidates } from './signals.js';
import type { RoutedAcceptedFactCandidate } from './fact-acceptance.js';
import type { GroupMemoryWriteCapSkip } from './types.js';

const log = createComponentLogger('Extraction');

export interface WriteCandidateSelectionInput {
  acceptedCandidates: RoutedAcceptedFactCandidate[];
  /** Direct-path ranked cap; group runs use the cap settings instead. */
  maxWrites: number;
  groupWriteCaps: GroupMemoryWriteCapSettings | undefined;
  groupWriteCapContext: {
    backfill?: boolean;
    recentTimeWindowWriteCount?: number;
  } | undefined;
  channelId: string;
  telemetryEnabled: boolean;
}

export interface WriteCandidateSelectionResult {
  selectedCandidates: RoutedAcceptedFactCandidate[];
  writeCapSkips: GroupMemoryWriteCapSkip[];
  /** Candidates dropped by either cap path; the caller folds this into the rejection breakdown. */
  writeCapSkippedCount: number;
}

export function selectExtractionWriteCandidates(
  input: WriteCandidateSelectionInput,
): WriteCandidateSelectionResult {
  if (input.groupWriteCaps) {
    const selection = selectGroupMemoryWriteCandidates({
      candidates: input.acceptedCandidates,
      settings: input.groupWriteCaps,
      ...(input.groupWriteCapContext?.backfill !== undefined
        ? { backfill: input.groupWriteCapContext.backfill }
        : {}),
      ...(input.groupWriteCapContext?.recentTimeWindowWriteCount !== undefined
        ? {
          recentTimeWindowWriteCount:
            input.groupWriteCapContext.recentTimeWindowWriteCount,
        }
        : {}),
    });
    const writeCapSkips = selection.telemetry.skips;
    if (selection.telemetry.skippedCount > 0) {
      // d5e0p.14: a cap drop discards gate-passing facts for good, so it is
      // reported at INFO whether or not detailed extraction telemetry is on.
      log.info('Extraction write cap dropped gate-passing facts', {
        channelId: input.channelId,
        extractionLane: 'group',
        droppedByWriteCap: selection.telemetry.skippedCount,
        selectedForWrite: selection.telemetry.selectedCount,
        acceptedBeforeCap: selection.telemetry.candidateCount,
        effectiveMaxWrites: selection.telemetry.effectiveMaxWrites,
        ...(input.telemetryEnabled ? { writeCapSkips } : {}),
      });
    }
    return {
      selectedCandidates: selection.selectedCandidates,
      writeCapSkips,
      writeCapSkippedCount: selection.telemetry.skippedCount,
    };
  }

  const rankedCandidates = input.acceptedCandidates
    .slice()
    .sort(compareAcceptedFactCandidates);
  const selectedCandidates = rankedCandidates.slice(0, input.maxWrites);
  const skippedByCap = rankedCandidates.length - selectedCandidates.length;
  if (skippedByCap > 0) {
    log.info('Extraction write cap dropped gate-passing facts', {
      channelId: input.channelId,
      extractionLane: 'direct',
      droppedByWriteCap: skippedByCap,
      selectedForWrite: selectedCandidates.length,
      acceptedBeforeCap: rankedCandidates.length,
      maxWrites: input.maxWrites,
    });
  }
  return {
    selectedCandidates,
    writeCapSkips: [],
    writeCapSkippedCount: skippedByCap,
  };
}
