import { createComponentLogger } from '../../../shared/logger.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { IntakeSinkGate } from '../../../core/cogsec/intake/sink-gates.js';
import type { IntakeEnvelopeSnapshot } from '../../../shared/contracts/intake-envelope.js';
import {
  INTAKE_SCREENING_METADATA_KEY,
  parseIntakeScreeningMetadata,
} from '../../../core/session/intake-screening-metadata.js';
import { evaluateCogSecMemoryCandidacy } from '../../../core/cogsec/memory-candidacy.js';
import type { ExtractedFact } from '../types.js';
import {
  resolveFactRouting,
  type FactRoutingDecision,
  type SpeakerRoutingContext,
} from './speaker-routing.js';
import { normalizeExperientialSelfDirectedFact } from './self-directed.js';
import {
  computeFactValueScore,
  evaluateFactAcceptance,
} from './signals.js';
import type {
  AcceptedFactCandidate,
  ExtractionGateConfig,
  ExtractionRejectionReason,
  ExtractionTriggerReason,
} from './types.js';
import { createEmptyRejectionBreakdown } from './rejection-breakdown.js';

const log = createComponentLogger('Extraction');

export type RoutedAcceptedFactCandidate = AcceptedFactCandidate & {
  routing: Extract<FactRoutingDecision, { status: 'route' }>;
};

// ── Intake sink-gate index (htm9.3) ──
//
// Maps session-entry ids to the intake-envelope snapshots persisted on their
// `intakeScreening` metadata, so each extracted fact can be gated at the
// memory_write sink against the envelopes covering its SOURCE entries
// (fact.attribution.sourceMessageIds) instead of re-deriving risk. Malformed
// metadata is unknowable screening state: it is tracked and fails closed in
// enforce mode.

interface ExtractionIntakeGateIndex {
  envelopesByEntryId: Map<number, readonly IntakeEnvelopeSnapshot[]>;
  malformedEntryIds: Set<number>;
  allEnvelopes: IntakeEnvelopeSnapshot[];
}

function buildExtractionIntakeGateIndex(
  entries: readonly SessionEntry[],
  channelId: string,
): ExtractionIntakeGateIndex {
  const index: ExtractionIntakeGateIndex = {
    envelopesByEntryId: new Map(),
    malformedEntryIds: new Set(),
    allEnvelopes: [],
  };
  const marker = `"${INTAKE_SCREENING_METADATA_KEY}"`;
  for (const entry of entries) {
    if (!entry.metadata || !entry.metadata.includes(marker)) continue;
    try {
      const screening = parseIntakeScreeningMetadata(entry.metadata);
      if (!screening) continue;
      index.envelopesByEntryId.set(entry.id, screening.envelopes);
      index.allEnvelopes.push(...screening.envelopes);
    } catch (error) {
      log.error('Malformed intake screening metadata on extraction source entry; treated as gate-denied in enforce mode', {
        channelId,
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
      index.malformedEntryIds.add(entry.id);
    }
  }
  return index;
}

function resolveFactIntakeEnvelopes(
  index: ExtractionIntakeGateIndex,
  fact: ExtractedFact,
): { envelopes: readonly IntakeEnvelopeSnapshot[]; coversMalformedEntry: boolean } {
  const sourceIds = fact.attribution?.sourceMessageIds;
  if (sourceIds && sourceIds.length > 0) {
    const envelopes: IntakeEnvelopeSnapshot[] = [];
    let coversMalformedEntry = false;
    for (const id of sourceIds) {
      envelopes.push(...(index.envelopesByEntryId.get(id) ?? []));
      if (index.malformedEntryIds.has(id)) coversMalformedEntry = true;
    }
    return { envelopes, coversMalformedEntry };
  }
  // An unattributed fact may derive from any entry in the window: it inherits
  // every envelope in the window (fail closed — derivation never launders
  // provenance away).
  return {
    envelopes: index.allEnvelopes,
    coversMalformedEntry: index.malformedEntryIds.size > 0,
  };
}

export interface FactAcceptanceStageInput {
  facts: ExtractedFact[];
  recentEntries: SessionEntry[];
  /** Existing memory texts seeding the novelty corpus; accepted facts extend a local copy. */
  existingMemoryTexts: readonly string[];
  gateConfig: ExtractionGateConfig;
  /** htm9.3: memory_write sink gate over the upstream intake envelopes. */
  intakeSinkGate: IntakeSinkGate | null;
  experientialCompanionName: string | undefined;
  speakerRouting: SpeakerRoutingContext | undefined;
  canonicalContactId: string | undefined;
  /** Deduplicated companion aliases handed to fact routing. */
  companionNames: string[];
  companionAuthorIds: readonly string[];
  /** Group-room routing must prove direct address from structured journal metadata. */
  requireStructuredAddressing?: boolean;
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  telemetryEnabled: boolean;
}

export interface FactAcceptanceStageResult {
  acceptedCandidates: RoutedAcceptedFactCandidate[];
  rejectionBreakdown: Record<ExtractionRejectionReason, number>;
  ambiguousSpeakerSkippedCount: number;
  ambiguousSpeakerSkipReasons: Record<string, number>;
}

export function buildAcceptedFactCandidates(
  input: FactAcceptanceStageInput,
): FactAcceptanceStageResult {
  const rejectionBreakdown = createEmptyRejectionBreakdown();
  const noveltyCorpus = [...input.existingMemoryTexts];
  let ambiguousSpeakerSkippedCount = 0;
  const ambiguousSpeakerSkipReasons: Record<string, number> = {};
  const acceptedCandidates: RoutedAcceptedFactCandidate[] = [];
  const intakeGateIndex = input.intakeSinkGate
    ? buildExtractionIntakeGateIndex(input.recentEntries, input.channelId)
    : null;
  for (const [index, fact] of input.facts.entries()) {
    const decision = evaluateFactAcceptance(fact, noveltyCorpus, input.gateConfig);
    if (!decision.accepted) {
      if (decision.reason) rejectionBreakdown[decision.reason]++;
      if (input.telemetryEnabled) {
        log.debug('Rejected extracted fact', {
          channelId: input.channelId,
          reason: decision.reason,
          novelty: decision.novelty,
          minNovelty: input.gateConfig.minNovelty,
          importance: fact.importance,
          minImportance: input.gateConfig.minImportance,
          confidence: fact.confidence,
          minConfidence: input.gateConfig.minConfidence,
        });
      }
      continue;
    }

    let intakeGateDecision;
    if (input.intakeSinkGate && intakeGateIndex) {
      const factIntake = resolveFactIntakeEnvelopes(intakeGateIndex, fact);
      if (factIntake.coversMalformedEntry && input.intakeSinkGate.mode === 'enforce') {
        // Unknowable screening state on a source entry fails closed.
        rejectionBreakdown.cogsec_risk++;
        log.warn('Rejected extracted fact: source entry carries malformed intake screening metadata', {
          channelId: input.channelId,
          triggerReason: input.triggerReason,
          factIndex: index,
          factType: fact.type,
        });
        continue;
      }
      intakeGateDecision = input.intakeSinkGate.evaluate('memory_write', factIntake.envelopes, {
        channelId: input.channelId,
        triggerReason: input.triggerReason,
        factIndex: index,
        factType: fact.type,
      }, {
        correlationRef: `fact:${String(index)}`,
        sourceChannelId: input.channelId,
      });
    }

    const cogSecCandidacy = evaluateCogSecMemoryCandidacy({
      text: fact.text,
      type: fact.type,
      tags: fact.tags,
      ...(intakeGateDecision ? { intakeGateDecision } : {}),
    });
    if (cogSecCandidacy.disposition !== 'allow') {
      rejectionBreakdown.cogsec_risk++;
      if (input.telemetryEnabled) {
        log.info('Rejected extracted fact by CogSec memory candidacy gate', {
          channelId: input.channelId,
          triggerReason: input.triggerReason,
          factIndex: index,
          factType: fact.type,
          riskClass: cogSecCandidacy.riskClass,
          disposition: cogSecCandidacy.disposition,
          reasonCodes: cogSecCandidacy.reasonCodes,
        });
      }
      continue;
    }

    let routing: FactRoutingDecision;
    if (input.experientialCompanionName) {
      const selfDirected = normalizeExperientialSelfDirectedFact({
        fact,
        entries: input.recentEntries,
        companionName: input.experientialCompanionName,
      });
      if (!selfDirected.accepted) {
        rejectionBreakdown.low_signal++;
        continue;
      }
      routing = selfDirected.routing;
    } else {
      if (!input.speakerRouting) {
        throw new Error('Speaker routing context is required for conversational extraction');
      }
      routing = resolveFactRouting(
        fact,
        input.speakerRouting,
        input.canonicalContactId,
        {
          companionNames: input.companionNames,
          companionAuthorIds: input.companionAuthorIds,
          requireStructuredAddressing: input.requireStructuredAddressing,
        },
      );
    }
    if (routing.status === 'skip') {
      ambiguousSpeakerSkippedCount++;
      ambiguousSpeakerSkipReasons[routing.reason] =
        (ambiguousSpeakerSkipReasons[routing.reason] ?? 0) + 1;
      rejectionBreakdown.ambiguous_speaker++;
      if (input.telemetryEnabled) {
        log.debug('Skipped extracted fact due to ambiguous group-room speaker ownership', {
          channelId: input.channelId,
          triggerReason: input.triggerReason,
          factIndex: index,
          factType: fact.type,
          routingReason: routing.reason,
          triggerContactId: input.canonicalContactId,
          sourceSpeakerName: routing.sourceSpeakerName,
          speakerCount: input.speakerRouting?.speakers.length ?? 0,
        });
      }
      continue;
    }

    acceptedCandidates.push({
      fact,
      routing,
      novelty: decision.novelty,
      valueScore: computeFactValueScore(fact, decision.novelty),
      index,
    });
    noveltyCorpus.push(fact.text);
  }

  return {
    acceptedCandidates,
    rejectionBreakdown,
    ambiguousSpeakerSkippedCount,
    ambiguousSpeakerSkipReasons,
  };
}
