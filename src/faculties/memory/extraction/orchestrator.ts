import { createComponentLogger } from '../../../shared/logger.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SessionEntry } from '../../../core/session/types.js';
import { resolveLatestTurnContext } from '../../../core/session/turn-provenance.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import type { TurnID } from '../../../shared/contracts/runtime.js';
import {
  EXTRACTION_PROMPT_KEY,
  getDefaultPromptText,
} from '../../../core/identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../../../core/identity/prompt-runtime.js';
import { classifyChannel } from '../../../system/trust/policy.js';
import { extractBoundaryFactsFromEntries } from '../boundary-log.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { ExtractedFact } from '../types.js';
import { MemoryWritePolicyError, type WriteResult } from '../writer.js';
import { parseFactsXml } from './parser.js';
import {
  buildExtractionEntryChunks,
  formatExtractionTranscript,
  isExtractionTranscriptEntry,
  mergeExtractedFactGroups,
} from './chunk-compose.js';
import {
  buildExtractionNamingGuidance,
  normalizeExtractedFactParticipantNames,
  type ExtractionParticipantNames,
} from './naming.js';
import {
  buildSpeakerRoutingContext,
  resolveFactRouting,
  type ExtractionFactRouting,
  type ExtractionSourceSpeaker,
  type FactRoutingDecision,
} from './speaker-routing.js';
import type { GroupMemoryWriteCapSettings } from '../../../system/config/group-memory-config.js';
import {
  selectGroupMemoryWriteCandidates,
} from './group-write-caps.js';
import {
  applyChannelImportanceCaps,
  buildExtractionSourceRef,
  compareAcceptedFactCandidates,
  computeFactValueScore,
  evaluateFactAcceptance,
  evaluateExtractionPreLlmGate,
} from './signals.js';
import { isNonConversationalSessionEntry } from '../../../core/session/manager-primitives.js';
import type {
  AcceptedFactCandidate,
  AcceptedFactWrite,
  ExtractionEndTelemetry,
  ExtractionGateConfig,
  ExtractionRejectionReason,
  ExtractionTriggerReason,
  GroupMemoryWriteCapSkip,
} from './types.js';
import { RECOVERY_CONTEXT_MESSAGE_LIMIT } from './types.js';

const log = createComponentLogger('Extraction');
const EXTRACTION_CHUNK_LLM_CONCURRENCY = 2;

type ExtractionIntegrityErrorStage = 'orchestration' | 'fact_processing';
type RoutedAcceptedFactCandidate = AcceptedFactCandidate & {
  routing: Extract<FactRoutingDecision, { status: 'route' }>;
};

export interface ExtractionIntegrityErrorContext {
  stage: ExtractionIntegrityErrorStage;
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  turnId?: TurnID;
  factIndex?: number;
  factType?: ExtractedFact['type'];
  sourceRef?: string;
}

export class ExtractionIntegrityError extends Error {
  readonly context: ExtractionIntegrityErrorContext;
  readonly cause: unknown;

  constructor(message: string, context: ExtractionIntegrityErrorContext, cause: unknown) {
    super(message);
    this.name = 'ExtractionIntegrityError';
    this.context = context;
    this.cause = cause;
  }
}

function extractionRejectionReasonForWritePolicy(
  error: MemoryWritePolicyError,
): ExtractionRejectionReason {
  return error.reason === 'novelty_below_threshold'
    ? 'low_novelty'
    : 'low_importance';
}

function createEmptyRejectionBreakdown(): Record<ExtractionRejectionReason, number> {
  return {
    low_importance: 0,
    low_confidence: 0,
    low_novelty: 0,
    low_signal: 0,
    ambiguous_speaker: 0,
    write_cap: 0,
  };
}

export interface ExtractionRunOptions {
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  canonicalContactId?: string;
  turnId?: TurnID;
  recoveredEntries?: SessionEntry[];
  resolveParticipantNames?: (
    recentEntries: readonly SessionEntry[],
    canonicalContactId?: string,
  ) => ExtractionParticipantNames;
  resolveSourceSpeakerContactId?: (speaker: ExtractionSourceSpeaker) => Promise<string | undefined>;
  llmClient: LLMProviderPort;
  sessionManager: SessionManager;
  memoryStore: MemoryStorePort;
  promptRegistry: PromptRegistryStatePort | null;
  gateConfig: ExtractionGateConfig;
  maxWrites: number;
  groupWriteCaps?: GroupMemoryWriteCapSettings;
  groupWriteCapContext?: {
    backfill?: boolean;
    recentTimeWindowWriteCount?: number;
  };
  telemetryEnabled: boolean;
  useCompositionalExtraction: boolean;
  isAcceptingExtractions: () => boolean;
  adjustFactForWrite?: (fact: ExtractedFact) => ExtractedFact;
  processFact: (
    fact: ExtractedFact,
    sourceRef: string,
    canonicalContactId?: string,
    routing?: ExtractionFactRouting,
  ) => Promise<WriteResult>;
  emitExtractionStart: (
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    turnId?: TurnID,
  ) => Promise<void>;
  emitExtractionEnd: (telemetry: ExtractionEndTelemetry) => Promise<void>;
  resolveCoveredUpToMessageId: (channelId: string, entries: SessionEntry[]) => number | null;
  recordExtractionMarker: (channelId: string, coveredUpToMessageId: number | null) => void;
  maybePersistEmotionalState: (
    canonicalContactId: string | undefined,
    acceptedFacts: ExtractedFact[],
    recentEntries: SessionEntry[],
  ) => void;
  maybeRefreshContactProfile: (
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string | undefined,
    acceptedWrites: AcceptedFactWrite[],
  ) => void;
}

export async function runExtractionOrchestration(options: ExtractionRunOptions): Promise<void> {
  let resolvedTurnId: TurnID | undefined = options.turnId;
  try {
    const recoveredEntries = (options.recoveredEntries && options.recoveredEntries.length > 0
      ? options.recoveredEntries
      : options.sessionManager.getRecentMessages(options.channelId, 10)
    )
      .filter(entry => !isNonConversationalSessionEntry(entry));
    const recentEntries = options.groupWriteCaps
      ? recoveredEntries
      : recoveredEntries.slice(-RECOVERY_CONTEXT_MESSAGE_LIMIT);
    const latestTurnContext = resolveLatestTurnContext(recentEntries);
    const turnId = options.turnId ?? latestTurnContext?.turnId;
    resolvedTurnId = turnId;
    const requestId = latestTurnContext?.requestId ?? `memory-extraction:${options.channelId}:${options.triggerReason}`;
    await options.emitExtractionStart(options.channelId, options.triggerReason, turnId);

    const channelVisibility = classifyChannel(options.channelId);
    if (!options.canonicalContactId) {
      const preLlmGate = evaluateExtractionPreLlmGate(recentEntries);
      if (!preLlmGate.allowed) {
        if (options.telemetryEnabled) {
          log.debug('Skipping extraction LLM for low-signal turn', {
            channelId: options.channelId,
            triggerReason: options.triggerReason,
            reason: preLlmGate.reason,
            signalScore: preLlmGate.signalScore,
            signalCount: preLlmGate.signalCount,
            recentEntryCount: preLlmGate.recentEntryCount,
            userEntryCount: preLlmGate.userEntryCount,
          });
        }

        await options.emitExtractionEnd({
          channelId: options.channelId,
          count: 0,
          ...(turnId ? { turnId } : {}),
          triggerReason: options.triggerReason,
          parsedCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          writeCount: 0,
          deduplicatedCount: 0,
          supersededCount: 0,
          rejectionBreakdown: createEmptyRejectionBreakdown(),
          compositionalMode: options.useCompositionalExtraction ? 'chunk_compose' : 'legacy',
          chunkCount: 0,
          mergedFactCount: 0,
          crossChunkDeduplicatedCount: 0,
          boundaryFactCount: 0,
          preLlmGateSkipped: true,
          preLlmGateReason: preLlmGate.reason,
          preLlmGateSignalScore: preLlmGate.signalScore,
          preLlmGateSignalCount: preLlmGate.signalCount,
        });
        return;
      }
    }

    const sourceRef = buildExtractionSourceRef(
      options.channelId,
      recentEntries,
      channelVisibility,
      options.triggerReason,
      turnId,
    );
    const coveredUpToMessageId = options.resolveCoveredUpToMessageId(options.channelId, recentEntries);
    const participantNames = options.resolveParticipantNames?.(recentEntries, options.canonicalContactId) ?? {};
    const speakerRouting = await buildSpeakerRoutingContext(
      recentEntries,
      options.resolveSourceSpeakerContactId,
    );

    const existing = await options.memoryStore.getMemoriesByChannel(options.channelId, 30);
    const noveltyCorpus = existing.map(m => m.text);
    const existingFacts = existing
      .map(m => `- [${m.type}] ${m.text}`)
      .join('\n') || '(none yet)';

    const extractionPrompt = options.promptRegistry?.getPrompt(EXTRACTION_PROMPT_KEY)
      ?? getDefaultPromptText(EXTRACTION_PROMPT_KEY);
    const transcriptEntries = recentEntries.filter(isExtractionTranscriptEntry);
    const entryChunks = options.useCompositionalExtraction
      ? buildExtractionEntryChunks(transcriptEntries)
      : [transcriptEntries];
    const compositionalMode = options.useCompositionalExtraction ? 'chunk_compose' : 'legacy';
    const parsedFactGroups = await mapWithConcurrency(
      entryChunks,
      EXTRACTION_CHUNK_LLM_CONCURRENCY,
      async (chunkEntries, index): Promise<ExtractedFact[]> => {
        const renderedPrompt = injectPromptRuntimeTokens(extractionPrompt)
          .replace('{existing_facts}', existingFacts)
          .replace('{recent_messages}', formatExtractionTranscript(chunkEntries, {
            charName: participantNames.companionName ?? options.sessionManager.characterName,
            userName: participantNames.userName,
          }));
        const namingGuidance = buildExtractionNamingGuidance(participantNames);
        const prompt = namingGuidance
          ? `${renderedPrompt}\n\n${namingGuidance}`
          : renderedPrompt;
        const chunkRequestId = entryChunks.length > 1
          ? `${requestId}:chunk:${index + 1}`
          : requestId;

        const response = await options.llmClient.complete(
          {
            systemPrompt: prompt,
            messages: [{ role: 'user', content: 'Extract facts from the conversation above.' }],
            correlation: {
              requestId: chunkRequestId,
              ...(turnId ? { turnId } : {}),
              channelId: options.channelId,
              callType: 'memory',
              purpose: 'memory.extraction',
            },
          },
          'extraction',
        );

        return parseFactsXml(response.content);
      },
    );
    const rawParsedFactCount = parsedFactGroups
      .reduce((total, group) => total + group.length, 0);
    const mergedParsedFacts = mergeExtractedFactGroups(parsedFactGroups);
    const crossChunkDeduplicatedCount = Math.max(0, rawParsedFactCount - mergedParsedFacts.length);
    const parsedFacts: ExtractedFact[] = [];
    let participantNameHygieneRejectedCount = 0;
    for (const [index, fact] of mergedParsedFacts.entries()) {
      const normalized = normalizeExtractedFactParticipantNames(fact, participantNames);
      if (!normalized.accepted) {
        participantNameHygieneRejectedCount++;
        if (options.telemetryEnabled) {
          log.debug('Rejected extracted fact due to participant name hygiene', {
            channelId: options.channelId,
            triggerReason: options.triggerReason,
            factIndex: index,
            factType: fact.type,
            reason: normalized.reason,
            textPreview: fact.text.slice(0, 120),
          });
        }
        continue;
      }
      parsedFacts.push(normalized.fact);
    }
    const inferredBoundaryFacts = extractBoundaryFactsFromEntries(recentEntries, parsedFacts);
    const adjustFactForWrite = options.adjustFactForWrite ?? ((fact: ExtractedFact) => fact);
    const facts = mergeExtractedFactGroups([parsedFacts, inferredBoundaryFacts])
      .map(fact => applyChannelImportanceCaps(adjustFactForWrite(fact), channelVisibility));

    if (inferredBoundaryFacts.length > 0 && options.telemetryEnabled) {
      log.info('Detected refusal-boundary facts from conversation transcript', {
        channelId: options.channelId,
        triggerReason: options.triggerReason,
        inferredCount: inferredBoundaryFacts.length,
      });
    }

    if (!options.isAcceptingExtractions()) {
      log.debug('Skipping fact writes while extractor is stopping', {
        channelId: options.channelId,
        factCount: facts.length,
        triggerReason: options.triggerReason,
      });
      await options.emitExtractionEnd({
        channelId: options.channelId,
        count: 0,
        ...(turnId ? { turnId } : {}),
        triggerReason: options.triggerReason,
        parsedCount: facts.length + participantNameHygieneRejectedCount,
        acceptedCount: 0,
        rejectedCount: participantNameHygieneRejectedCount,
        writeCount: 0,
        deduplicatedCount: 0,
        supersededCount: 0,
        rejectionBreakdown: {
          ...createEmptyRejectionBreakdown(),
          low_signal: participantNameHygieneRejectedCount,
        },
        compositionalMode,
        chunkCount: entryChunks.length,
        mergedFactCount: mergedParsedFacts.length,
        crossChunkDeduplicatedCount,
        boundaryFactCount: inferredBoundaryFacts.length,
      });
      return;
    }

    const rejectionBreakdown: Record<ExtractionRejectionReason, number> = createEmptyRejectionBreakdown();
    rejectionBreakdown.low_signal = participantNameHygieneRejectedCount;

    let ambiguousSpeakerSkippedCount = 0;
    const ambiguousSpeakerSkipReasons: Record<string, number> = {};
    const acceptedCandidates: RoutedAcceptedFactCandidate[] = [];
    for (const [index, fact] of facts.entries()) {
      const decision = evaluateFactAcceptance(fact, noveltyCorpus, options.gateConfig);
      if (!decision.accepted) {
        if (decision.reason) rejectionBreakdown[decision.reason]++;
        if (options.telemetryEnabled) {
          log.debug('Rejected extracted fact', {
            channelId: options.channelId,
            reason: decision.reason,
            novelty: decision.novelty,
            minNovelty: options.gateConfig.minNovelty,
            importance: fact.importance,
            minImportance: options.gateConfig.minImportance,
            confidence: fact.confidence,
            minConfidence: options.gateConfig.minConfidence,
            textPreview: fact.text.slice(0, 120),
          });
        }
        continue;
      }

      const routing = resolveFactRouting(
        fact,
        speakerRouting,
        options.canonicalContactId,
        {
          companionNames: [
            ...new Set([
              participantNames.companionName,
              options.sessionManager.characterName,
            ].filter((name): name is string => Boolean(name))),
          ],
        },
      );
      if (routing.status === 'skip') {
        ambiguousSpeakerSkippedCount++;
        ambiguousSpeakerSkipReasons[routing.reason] =
          (ambiguousSpeakerSkipReasons[routing.reason] ?? 0) + 1;
        rejectionBreakdown.ambiguous_speaker++;
        if (options.telemetryEnabled) {
          log.debug('Skipped extracted fact due to ambiguous group-room speaker ownership', {
            channelId: options.channelId,
            triggerReason: options.triggerReason,
            factIndex: index,
            factType: fact.type,
            routingReason: routing.reason,
            triggerContactId: options.canonicalContactId,
            sourceSpeakerName: routing.sourceSpeakerName,
            speakerCount: speakerRouting.speakers.length,
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

    let selectedCandidates: RoutedAcceptedFactCandidate[];
    let writeCapSkips: GroupMemoryWriteCapSkip[] = [];
    if (options.groupWriteCaps) {
      const selection = selectGroupMemoryWriteCandidates({
        candidates: acceptedCandidates,
        settings: options.groupWriteCaps,
        ...(options.groupWriteCapContext?.backfill !== undefined
          ? { backfill: options.groupWriteCapContext.backfill }
          : {}),
        ...(options.groupWriteCapContext?.recentTimeWindowWriteCount !== undefined
          ? {
            recentTimeWindowWriteCount:
              options.groupWriteCapContext.recentTimeWindowWriteCount,
          }
          : {}),
      });
      selectedCandidates = selection.selectedCandidates;
      writeCapSkips = selection.telemetry.skips;
      rejectionBreakdown.write_cap += selection.telemetry.skippedCount;
      if (selection.telemetry.skippedCount > 0 && options.telemetryEnabled) {
        log.debug('Skipped extracted facts due to group write caps', {
          channelId: options.channelId,
          skippedByCap: selection.telemetry.skippedCount,
          acceptedBeforeCap: selection.telemetry.candidateCount,
          selectedAfterCap: selection.telemetry.selectedCount,
          effectiveMaxWrites: selection.telemetry.effectiveMaxWrites,
          writeCapSkips,
        });
      }
    } else {
      const rankedCandidates = acceptedCandidates
        .slice()
        .sort(compareAcceptedFactCandidates);
      selectedCandidates = rankedCandidates.slice(0, options.maxWrites);
      const skippedByCap = rankedCandidates.length - selectedCandidates.length;
      if (skippedByCap > 0) {
        rejectionBreakdown.write_cap += skippedByCap;
        if (options.telemetryEnabled) {
          log.debug('Skipped extracted facts due to write cap', {
            channelId: options.channelId,
            maxWrites: options.maxWrites,
            skippedByCap,
            acceptedBeforeCap: rankedCandidates.length,
          });
        }
      }
    }

    let acceptedCount = 0;
    let writeCount = 0;
    let deduplicatedCount = 0;
    let supersededCount = 0;
    let routedFactCount = 0;
    const acceptedWrites: AcceptedFactWrite[] = [];
    const acceptedFactsByContact = new Map<string | undefined, ExtractedFact[]>();
    const routedContactIds = new Set<string>();
    const sourceSpeakerNames = new Set<string>();

    for (const candidate of selectedCandidates) {
      const { fact } = candidate;
      const { routing } = candidate;

      const routingTelemetry: ExtractionFactRouting = {
        ...(options.canonicalContactId ? { triggerContactId: options.canonicalContactId } : {}),
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
        routingReason: routing.reason,
      };

      try {
        const result = await options.processFact(fact, sourceRef, routing.contactId, routingTelemetry);
        acceptedCount++;
        const routedToDifferentContact = Boolean(
          routing.contactId
            && options.canonicalContactId
            && routing.contactId !== options.canonicalContactId,
        );
        if (routedToDifferentContact) routedFactCount++;
        if (routing.contactId) routedContactIds.add(routing.contactId);
        if (routing.sourceSpeakerName) sourceSpeakerNames.add(routing.sourceSpeakerName);
        appendAcceptedFactForContact(acceptedFactsByContact, routing.contactId, fact);

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
              ...(options.canonicalContactId ? { triggerContactId: options.canonicalContactId } : {}),
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
              ...(options.canonicalContactId ? { triggerContactId: options.canonicalContactId } : {}),
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
          rejectionBreakdown[reason]++;
          if (options.telemetryEnabled) {
            log.info('Skipped extracted fact rejected by memory write policy', {
              channelId: options.channelId,
              triggerReason: options.triggerReason,
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
            channelId: options.channelId,
            triggerReason: options.triggerReason,
            ...(turnId ? { turnId } : {}),
            factIndex: candidate.index,
            factType: fact.type,
            sourceRef,
          },
          error,
        );
      }
    }

    const rejectedCount = facts.length - acceptedCount + participantNameHygieneRejectedCount;
    const telemetry: ExtractionEndTelemetry = {
      channelId: options.channelId,
      count: acceptedCount,
      ...(turnId ? { turnId } : {}),
      triggerReason: options.triggerReason,
      ...(options.canonicalContactId ? { triggerContactId: options.canonicalContactId } : {}),
      ...(routedContactIds.size > 0 ? { routedContactIds: [...routedContactIds].sort() } : {}),
      ...(sourceSpeakerNames.size > 0 ? { sourceSpeakerNames: [...sourceSpeakerNames].sort() } : {}),
      coveredUpToMessageId: coveredUpToMessageId ?? undefined,
      parsedCount: facts.length + participantNameHygieneRejectedCount,
      acceptedCount,
      rejectedCount,
      writeCount,
      deduplicatedCount,
      supersededCount,
      rejectionBreakdown,
      routedFactCount,
      ambiguousSpeakerSkippedCount,
      ...(Object.keys(ambiguousSpeakerSkipReasons).length > 0
        ? { ambiguousSpeakerSkipReasons }
        : {}),
      ...(writeCapSkips.length > 0 ? { writeCapSkips } : {}),
      compositionalMode,
      chunkCount: entryChunks.length,
      mergedFactCount: mergedParsedFacts.length,
      crossChunkDeduplicatedCount,
      boundaryFactCount: inferredBoundaryFacts.length,
    };

    if (options.telemetryEnabled) {
      log.info('Extraction completed', { ...telemetry, maxWrites: options.maxWrites });
    }
    options.recordExtractionMarker(options.channelId, coveredUpToMessageId);
    await options.emitExtractionEnd(telemetry);
    const emotionalFactGroups = acceptedFactsByContact.size > 0
      ? acceptedFactsByContact
      : new Map<string | undefined, ExtractedFact[]>([[options.canonicalContactId, []]]);
    for (const [contactId, acceptedFacts] of emotionalFactGroups.entries()) {
      options.maybePersistEmotionalState(
        contactId,
        acceptedFacts,
        recentEntries,
      );
    }

    const refreshGroups = groupAcceptedWritesByContact(acceptedWrites, options.canonicalContactId);
    for (const [contactId, writes] of refreshGroups.entries()) {
      options.maybeRefreshContactProfile(
        options.channelId,
        options.triggerReason,
        contactId,
        writes,
      );
    }
  } catch (error) {
    const wrapped = error instanceof ExtractionIntegrityError
      ? error
      : new ExtractionIntegrityError(
        'Extraction orchestration failed',
        {
          stage: 'orchestration',
          channelId: options.channelId,
          triggerReason: options.triggerReason,
          ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
        },
        error,
      );
    log.error('Extraction integrity failure', {
      context: wrapped.context,
      error: toErrorMessage(wrapped),
      cause: toErrorMessage(wrapped.cause),
    });
    throw wrapped;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);

  async function worker(): Promise<void> {
    while (nextIndex < items.length && firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError !== undefined) throw firstError;
  return results;
}

function appendAcceptedFactForContact(
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

function groupAcceptedWritesByContact(
  writes: readonly AcceptedFactWrite[],
  fallbackContactId: string | undefined,
): Map<string | undefined, AcceptedFactWrite[]> {
  const groups = new Map<string | undefined, AcceptedFactWrite[]>();
  if (writes.length === 0) {
    groups.set(fallbackContactId, []);
    return groups;
  }

  for (const write of writes) {
    const contactIds = resolveProfileRefreshContactIds(write, fallbackContactId);
    for (const contactId of contactIds) {
      const profileWrite = write.contactId === contactId
        ? write
        : { ...write, contactId };
      const existing = groups.get(contactId);
      if (existing) {
        existing.push(profileWrite);
        continue;
      }
      groups.set(contactId, [profileWrite]);
    }
  }
  return groups;
}

function resolveProfileRefreshContactIds(
  write: AcceptedFactWrite,
  fallbackContactId: string | undefined,
): string[] {
  const contactIds = new Set<string>();
  if (write.contactId) contactIds.add(write.contactId);
  if (write.subjectContactId) contactIds.add(write.subjectContactId);
  if (contactIds.size === 0 && !write.scopeRef && fallbackContactId) {
    contactIds.add(fallbackContactId);
  }
  return [...contactIds];
}
