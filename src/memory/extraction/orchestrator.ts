import { createComponentLogger } from '../../logger.js';
import type { LLMProvider } from '../../agent/contracts.js';
import type { SessionManager } from '../../session/manager.js';
import type { SessionEntry } from '../../session/types.js';
import { resolveLatestTurnContext } from '../../session/turn-provenance.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import type { TurnID } from '../../types.js';
import {
  EXTRACTION_PROMPT_KEY,
  getDefaultPromptText,
} from '../../identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import { classifyChannel } from '../../trust/policy.js';
import { extractBoundaryFactsFromEntries } from '../boundary-log.js';
import type { MemoryStore } from '../store.js';
import type { ExtractedFact } from '../types.js';
import type { WriteResult } from '../writer.js';
import { parseFactsXml } from './parser.js';
import {
  buildExtractionEntryChunks,
  formatExtractionTranscript,
  mergeExtractedFactGroups,
} from './chunk-compose.js';
import {
  buildExtractionNamingGuidance,
  normalizeExtractedFactParticipantNames,
  type ExtractionParticipantNames,
} from './naming.js';
import {
  applyChannelImportanceCaps,
  buildExtractionSourceRef,
  compareAcceptedFactCandidates,
  computeFactValueScore,
  evaluateFactAcceptance,
} from './signals.js';
import type {
  AcceptedFactCandidate,
  AcceptedFactWrite,
  ExtractionEndTelemetry,
  ExtractionGateConfig,
  ExtractionRejectionReason,
  ExtractionTriggerReason,
} from './types.js';
import { RECOVERY_CONTEXT_MESSAGE_LIMIT } from './types.js';

const log = createComponentLogger('Extraction');

type ExtractionIntegrityErrorStage = 'orchestration' | 'fact_processing';

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
  llmClient: LLMProvider;
  sessionManager: SessionManager;
  memoryStore: MemoryStore;
  promptRegistry: PromptRegistryStore | null;
  gateConfig: ExtractionGateConfig;
  maxWrites: number;
  telemetryEnabled: boolean;
  useCompositionalExtraction: boolean;
  isAcceptingExtractions: () => boolean;
  adjustFactForWrite?: (fact: ExtractedFact) => ExtractedFact;
  processFact: (fact: ExtractedFact, sourceRef: string, canonicalContactId?: string) => Promise<WriteResult>;
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
    const recentEntries = (options.recoveredEntries && options.recoveredEntries.length > 0
      ? options.recoveredEntries
      : options.sessionManager.getRecentMessages(options.channelId, 10)
    ).slice(-RECOVERY_CONTEXT_MESSAGE_LIMIT);
    const latestTurnContext = resolveLatestTurnContext(recentEntries);
    const turnId = options.turnId ?? latestTurnContext?.turnId;
    resolvedTurnId = turnId;
    const requestId = latestTurnContext?.requestId ?? `memory-extraction:${options.channelId}:${options.triggerReason}`;
    await options.emitExtractionStart(options.channelId, options.triggerReason, turnId);

    const channelVisibility = classifyChannel(options.channelId);
    const sourceRef = buildExtractionSourceRef(options.channelId, recentEntries, channelVisibility, turnId);
    const coveredUpToMessageId = options.resolveCoveredUpToMessageId(options.channelId, recentEntries);
    const participantNames = options.resolveParticipantNames?.(recentEntries, options.canonicalContactId) ?? {};

    const existing = options.memoryStore.getMemoriesByChannel(options.channelId, 30);
    const noveltyCorpus = existing.map(m => m.text);
    const existingFacts = existing
      .map(m => `- [${m.type}] ${m.text}`)
      .join('\n') || '(none yet)';

    const extractionPrompt = options.promptRegistry?.getPrompt(EXTRACTION_PROMPT_KEY)
      ?? getDefaultPromptText(EXTRACTION_PROMPT_KEY);
    const entryChunks = options.useCompositionalExtraction
      ? buildExtractionEntryChunks(recentEntries)
      : [recentEntries];
    const compositionalMode = options.useCompositionalExtraction ? 'chunk_compose' : 'legacy';
    const parsedFactGroups: ExtractedFact[][] = [];
    for (const [index, chunkEntries] of entryChunks.entries()) {
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

      parsedFactGroups.push(parseFactsXml(response.content));
    }
    const rawParsedFactCount = parsedFactGroups
      .reduce((total, group) => total + group.length, 0);
    const parsedFacts = mergeExtractedFactGroups(parsedFactGroups)
      .map(fact => normalizeExtractedFactParticipantNames(fact, participantNames));
    const crossChunkDeduplicatedCount = Math.max(0, rawParsedFactCount - parsedFacts.length);
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
        parsedCount: facts.length,
        acceptedCount: 0,
        rejectedCount: 0,
        writeCount: 0,
        deduplicatedCount: 0,
        supersededCount: 0,
        rejectionBreakdown: {
          low_importance: 0,
          low_confidence: 0,
          low_novelty: 0,
          low_signal: 0,
          write_cap: 0,
        },
        compositionalMode,
        chunkCount: entryChunks.length,
        mergedFactCount: parsedFacts.length,
        crossChunkDeduplicatedCount,
        boundaryFactCount: inferredBoundaryFacts.length,
      });
      return;
    }

    const rejectionBreakdown: Record<ExtractionRejectionReason, number> = {
      low_importance: 0,
      low_confidence: 0,
      low_novelty: 0,
      low_signal: 0,
      write_cap: 0,
    };

    const acceptedCandidates: AcceptedFactCandidate[] = [];
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

      acceptedCandidates.push({
        fact,
        novelty: decision.novelty,
        valueScore: computeFactValueScore(fact, decision.novelty),
        index,
      });
      noveltyCorpus.push(fact.text);
    }

    const rankedCandidates = acceptedCandidates
      .slice()
      .sort(compareAcceptedFactCandidates);
    const selectedCandidates = rankedCandidates.slice(0, options.maxWrites);
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

    let acceptedCount = 0;
    let writeCount = 0;
    let deduplicatedCount = 0;
    let supersededCount = 0;
    const acceptedWrites: AcceptedFactWrite[] = [];

    for (const candidate of selectedCandidates) {
      const { fact } = candidate;
      try {
        const result = await options.processFact(fact, sourceRef, options.canonicalContactId);
        acceptedCount++;

        switch (result.action) {
          case 'created':
            writeCount++;
            acceptedWrites.push({
              memoryId: result.memory.id,
              importance: fact.importance,
              confidence: fact.confidence,
            });
            break;
          case 'superseded':
            writeCount++;
            supersededCount++;
            acceptedWrites.push({
              memoryId: result.memory.id,
              importance: fact.importance,
              confidence: fact.confidence,
            });
            break;
          case 'deduplicated':
            deduplicatedCount++;
            break;
        }
      } catch (error) {
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

    const rejectedCount = facts.length - acceptedCount;
    const telemetry: ExtractionEndTelemetry = {
      channelId: options.channelId,
      count: acceptedCount,
      ...(turnId ? { turnId } : {}),
      triggerReason: options.triggerReason,
      coveredUpToMessageId: coveredUpToMessageId ?? undefined,
      parsedCount: facts.length,
      acceptedCount,
      rejectedCount,
      writeCount,
      deduplicatedCount,
      supersededCount,
      rejectionBreakdown,
      compositionalMode,
      chunkCount: entryChunks.length,
      mergedFactCount: parsedFacts.length,
      crossChunkDeduplicatedCount,
      boundaryFactCount: inferredBoundaryFacts.length,
    };

    if (options.telemetryEnabled) {
      log.info('Extraction completed', { ...telemetry, maxWrites: options.maxWrites });
    }
    options.recordExtractionMarker(options.channelId, coveredUpToMessageId);
    await options.emitExtractionEnd(telemetry);
    options.maybePersistEmotionalState(
      options.canonicalContactId,
      acceptedCandidates.map(candidate => candidate.fact),
      recentEntries,
    );
    options.maybeRefreshContactProfile(
      options.channelId,
      options.triggerReason,
      options.canonicalContactId,
      acceptedWrites,
    );
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
