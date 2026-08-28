import { createComponentLogger } from '../../../shared/logger.js';
import type { TurnID } from '../../../shared/contracts/runtime.js';
import type { ExtractedFact } from '../types.js';
import { MemoryWritePolicyError, type WriteResult } from '../writer.js';
import type { ExtractionFactRouting, FactRoutingDecision } from './speaker-routing.js';
import type { RoutedAcceptedFactCandidate } from './fact-acceptance.js';
import { ExtractionIntegrityError } from './integrity-error.js';
import { createEmptyRejectionBreakdown } from './rejection-breakdown.js';
import type {
  AcceptedFactWrite,
  ExtractionRejectionReason,
  ExtractionTriggerReason,
} from './types.js';
import { resolveIcpExtractionLineage } from './icp-lineage.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';

const log = createComponentLogger('Extraction');

function extractionRejectionReasonForWritePolicy(
  error: MemoryWritePolicyError,
): ExtractionRejectionReason {
  return error.reason === 'novelty_below_threshold'
    ? 'low_novelty'
    : 'low_importance';
}

export function buildExtractionFactRoutingTelemetry(
  routing: Extract<FactRoutingDecision, { status: 'route' }>,
  canonicalContactId: string | undefined,
): ExtractionFactRouting {
  return {
    ...(canonicalContactId ? { triggerContactId: canonicalContactId } : {}),
    ...(routing.contactId ? { routedContactId: routing.contactId } : {}),
    ...(routing.sourceContactId ? { sourceContactId: routing.sourceContactId } : {}),
    ...(routing.sourceAuthorId ? { sourceAuthorId: routing.sourceAuthorId } : {}),
    ...(routing.sourceSpeakerName ? { sourceSpeakerName: routing.sourceSpeakerName } : {}),
    ...(routing.subjectContactId ? { subjectContactId: routing.subjectContactId } : {}),
    ...(routing.subjectName ? { subjectName: routing.subjectName } : {}),
    ...(routing.addressMode ? { addressMode: routing.addressMode } : {}),
    ...(routing.scopeRef ? { scopeRef: routing.scopeRef } : {}),
    ...(routing.scopeTags ? { scopeTags: routing.scopeTags } : {}),
    ...(routing.sourceMessageIds ? { sourceMessageIds: routing.sourceMessageIds } : {}),
    ...(routing.sourceSpanStartMessageId
      ? { sourceSpanStartMessageId: routing.sourceSpanStartMessageId }
      : {}),
    ...(routing.sourceSpanEndMessageId
      ? { sourceSpanEndMessageId: routing.sourceSpanEndMessageId }
      : {}),
    ...(routing.sourceConversationAt !== undefined
      ? { sourceConversationAt: routing.sourceConversationAt }
      : {}),
    routingReason: routing.reason,
  };
}

export function appendAcceptedFactForContact(
  groups: Map<string | undefined, ExtractedFact[]>,
  contactId: string | undefined,
  fact: ExtractedFact,
): void {
  const existing = groups.get(contactId);
  if (existing) {
    existing.push(fact);
    return;
  }
  groups.set(contactId, [fact]);
}

export interface FactWriteExecutionInput {
  selectedCandidates: RoutedAcceptedFactCandidate[];
  sourceRef: string;
  canonicalContactId: string | undefined;
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  turnId: TurnID | undefined;
  sourceEntries: readonly SessionEntry[];
  icpCorrelation?: IcpConversationCorrelation;
  telemetryEnabled: boolean;
  isAcceptingExtractions: () => boolean;
  processFact: (
    fact: ExtractedFact,
    sourceRef: string,
    canonicalContactId?: string,
    routing?: ExtractionFactRouting,
  ) => Promise<WriteResult>;
}

export interface FactWriteExecutionResult {
  acceptedCount: number;
  writeCount: number;
  deduplicatedCount: number;
  supersededCount: number;
  routedFactCount: number;
  acceptedWrites: AcceptedFactWrite[];
  durableMemoryIds: Set<string>;
  acceptedFactsForConcernCandidates: ExtractedFact[];
  acceptedFactsByContact: Map<string | undefined, ExtractedFact[]>;
  routedContactIds: Set<string>;
  sourceSpeakerNames: Set<string>;
  /** Write-policy rejections during the loop; the caller folds these into the rejection breakdown. */
  writePolicyRejections: Record<ExtractionRejectionReason, number>;
}

export async function executeAcceptedFactWrites(
  input: FactWriteExecutionInput,
): Promise<FactWriteExecutionResult> {
  const { selectedCandidates, canonicalContactId, sourceRef } = input;
  let acceptedCount = 0;
  let writeCount = 0;
  let deduplicatedCount = 0;
  let supersededCount = 0;
  let routedFactCount = 0;
  const acceptedWrites: AcceptedFactWrite[] = [];
  const durableMemoryIds = new Set<string>();
  const acceptedFactsForConcernCandidates: ExtractedFact[] = [];
  const acceptedFactsByContact = new Map<string | undefined, ExtractedFact[]>();
  const routedContactIds = new Set<string>();
  const sourceSpeakerNames = new Set<string>();
  const writePolicyRejections = createEmptyRejectionBreakdown();

  for (const candidate of selectedCandidates) {
    if (!input.isAcceptingExtractions()) {
      log.debug('Stopping fact writes after extraction route changed or extractor stopped', {
        channelId: input.channelId,
        remainingCandidateCount: selectedCandidates.length - acceptedCount,
        triggerReason: input.triggerReason,
      });
      break;
    }
    const { fact } = candidate;
    const { routing } = candidate;

    const routingTelemetry = buildExtractionFactRoutingTelemetry(routing, canonicalContactId);
    const icpLineage = resolveIcpExtractionLineage({
      channelId: input.channelId,
      entries: input.sourceEntries,
      ...(routing.sourceMessageIds ? { sourceMessageIds: routing.sourceMessageIds } : {}),
      ...(input.icpCorrelation ? { currentCorrelation: input.icpCorrelation } : {}),
    });

    try {
      const result = await input.processFact(fact, sourceRef, routing.contactId, {
        ...routingTelemetry,
        ...icpLineage,
      });
      durableMemoryIds.add(result.memory.id);
      for (const supersededMemoryId of result.supersededMemoryIds ?? []) {
        durableMemoryIds.add(supersededMemoryId);
      }
      acceptedCount++;
      const routedToDifferentContact = Boolean(
        routing.contactId
          && canonicalContactId
          && routing.contactId !== canonicalContactId,
      );
      if (routedToDifferentContact) routedFactCount++;
      if (routing.contactId) routedContactIds.add(routing.contactId);
      if (routing.sourceSpeakerName) sourceSpeakerNames.add(routing.sourceSpeakerName);
      appendAcceptedFactForContact(acceptedFactsByContact, routing.contactId, fact);
      acceptedFactsForConcernCandidates.push(fact);

      switch (result.action) {
        case 'created':
        case 'updated':
        case 'negated':
        case 'conflict':
          writeCount++;
          acceptedWrites.push({
            memoryId: result.memory.id,
            importance: fact.importance,
            confidence: fact.confidence,
            ...(routing.contactId ? { contactId: routing.contactId } : {}),
            ...(routing.sourceContactId ? { sourceContactId: routing.sourceContactId } : {}),
            ...(routing.subjectContactId ? { subjectContactId: routing.subjectContactId } : {}),
            ...(canonicalContactId ? { triggerContactId: canonicalContactId } : {}),
            ...(routing.sourceSpeakerName ? { sourceSpeakerName: routing.sourceSpeakerName } : {}),
            ...(routing.scopeRef ? { scopeRef: routing.scopeRef } : {}),
          });
          break;
        case 'superseded':
          writeCount++;
          supersededCount++;
          acceptedWrites.push({
            memoryId: result.memory.id,
            importance: fact.importance,
            confidence: fact.confidence,
            ...(routing.contactId ? { contactId: routing.contactId } : {}),
            ...(routing.sourceContactId ? { sourceContactId: routing.sourceContactId } : {}),
            ...(routing.subjectContactId ? { subjectContactId: routing.subjectContactId } : {}),
            ...(canonicalContactId ? { triggerContactId: canonicalContactId } : {}),
            ...(routing.sourceSpeakerName ? { sourceSpeakerName: routing.sourceSpeakerName } : {}),
            ...(routing.scopeRef ? { scopeRef: routing.scopeRef } : {}),
          });
          break;
        case 'deduplicated':
          deduplicatedCount++;
          break;
      }
    } catch (error) {
      if (error instanceof MemoryWritePolicyError) {
        const reason = extractionRejectionReasonForWritePolicy(error);
        writePolicyRejections[reason]++;
        if (input.telemetryEnabled) {
          log.info('Skipped extracted fact rejected by memory write policy', {
            channelId: input.channelId,
            triggerReason: input.triggerReason,
            factIndex: candidate.index,
            factType: fact.type,
            reason: error.reason,
            sensitivity: error.sensitivity,
            salience: error.salience,
            minSalience: error.minSalience,
            novelty: error.novelty,
            minNovelty: error.minNovelty,
          });
        }
        continue;
      }
      throw new ExtractionIntegrityError(
        `Failed to process extracted fact at index ${candidate.index}`,
        {
          stage: 'fact_processing',
          channelId: input.channelId,
          triggerReason: input.triggerReason,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          factIndex: candidate.index,
          factType: fact.type,
          sourceRef,
        },
        error,
      );
    }
  }

  return {
    acceptedCount,
    writeCount,
    deduplicatedCount,
    supersededCount,
    routedFactCount,
    acceptedWrites,
    durableMemoryIds,
    acceptedFactsForConcernCandidates,
    acceptedFactsByContact,
    routedContactIds,
    sourceSpeakerNames,
    writePolicyRejections,
  };
}
