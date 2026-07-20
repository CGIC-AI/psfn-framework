import { createComponentLogger } from '../../../shared/logger.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { ExtractedFact } from '../types.js';
import { extractBoundaryFactsFromEntries } from '../boundary-log.js';
import { extractExplicitPreferenceFactsFromEntries } from './preference.js';
import { mergeExtractedFactGroups } from './chunk-compose.js';
import {
  normalizeExtractedFactParticipantNames,
  type ExtractionParticipantNames,
} from './naming.js';
import { normalizeExperientialSelfDirectedFact } from './self-directed.js';
import { applyChannelImportanceCaps } from './signals.js';
import type { ExtractionTriggerReason } from './types.js';

const log = createComponentLogger('Extraction');

export interface ExtractionFactNormalizationInput {
  mergedParsedFacts: ExtractedFact[];
  recentEntries: SessionEntry[];
  participantNames: ExtractionParticipantNames;
  /**
   * Set only for experiential self-directed sessions (invariant upheld by the
   * orchestrator); its presence switches per-fact grounding normalization on
   * and transcript boundary/preference inference off.
   */
  experientialCompanionName: string | undefined;
  channelVisibility: ChannelPrivacy;
  adjustFactForWrite: (fact: ExtractedFact) => ExtractedFact;
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  telemetryEnabled: boolean;
}

export interface ExtractionFactNormalizationResult {
  facts: ExtractedFact[];
  participantNameHygieneRejectedCount: number;
  boundaryFactCount: number;
  preferenceFactCount: number;
}

export function normalizeAndMergeExtractedFacts(
  input: ExtractionFactNormalizationInput,
): ExtractionFactNormalizationResult {
  const experientialCompanionName = input.experientialCompanionName;
  const parsedFacts: ExtractedFact[] = [];
  let participantNameHygieneRejectedCount = 0;
  for (const [index, fact] of input.mergedParsedFacts.entries()) {
    const normalized = normalizeExtractedFactParticipantNames(fact, input.participantNames);
    if (!normalized.accepted) {
      participantNameHygieneRejectedCount++;
      if (input.telemetryEnabled) {
        log.debug('Rejected extracted fact due to participant name hygiene', {
          channelId: input.channelId,
          triggerReason: input.triggerReason,
          factIndex: index,
          factType: fact.type,
          reason: normalized.reason,
        });
      }
      continue;
    }
    if (experientialCompanionName) {
      const selfDirected = normalizeExperientialSelfDirectedFact({
        fact: normalized.fact,
        entries: input.recentEntries,
        companionName: experientialCompanionName,
      });
      if (!selfDirected.accepted) {
        participantNameHygieneRejectedCount++;
        if (input.telemetryEnabled) {
          log.debug('Rejected ungrounded experiential self-memory fact', {
            channelId: input.channelId,
            triggerReason: input.triggerReason,
            factIndex: index,
            factType: fact.type,
            reason: selfDirected.reason,
          });
        }
        continue;
      }
      parsedFacts.push(selfDirected.fact);
    } else {
      parsedFacts.push(normalized.fact);
    }
  }
  const inferredBoundaryFacts = experientialCompanionName
    ? []
    : extractBoundaryFactsFromEntries(input.recentEntries, parsedFacts);
  const inferredPreferenceFacts = experientialCompanionName
    ? []
    : extractExplicitPreferenceFactsFromEntries(input.recentEntries, {
      fallbackSubjectName: input.participantNames.userName,
    });
  const facts = mergeExtractedFactGroups([parsedFacts, inferredBoundaryFacts, inferredPreferenceFacts])
    .map(fact => applyChannelImportanceCaps(input.adjustFactForWrite(fact), input.channelVisibility));

  if (inferredBoundaryFacts.length > 0 && input.telemetryEnabled) {
    log.info('Detected refusal-boundary facts from conversation transcript', {
      channelId: input.channelId,
      triggerReason: input.triggerReason,
      inferredCount: inferredBoundaryFacts.length,
    });
  }
  if (inferredPreferenceFacts.length > 0 && input.telemetryEnabled) {
    log.info('Detected explicit preference facts from conversation transcript', {
      channelId: input.channelId,
      triggerReason: input.triggerReason,
      inferredCount: inferredPreferenceFacts.length,
    });
  }

  return {
    facts,
    participantNameHygieneRejectedCount,
    boundaryFactCount: inferredBoundaryFacts.length,
    preferenceFactCount: inferredPreferenceFacts.length,
  };
}
