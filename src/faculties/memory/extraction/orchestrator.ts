import { createComponentLogger } from '../../../shared/logger.js';
import type { LLMProviderPort, MemoryExtractionOutputs } from '../../../core/agent/contracts.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../../primitives/llm/work-spec.js';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  isExperientialSelfDirectedSessionId,
  isTestingSessionId,
} from '../../../core/session/session-id.js';
import { resolveLatestTurnContext } from '../../../core/session/turn-provenance.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import type { TurnID } from '../../../shared/contracts/runtime.js';
import {
  deriveChildIcpConversationCostCorrelation,
  type IcpConversationCorrelation,
} from '../../../shared/contracts/icp-autonomy.js';
import {
  EXTRACTION_PROMPT_KEY,
  getDefaultPromptText,
} from '../../../core/identity/prompt-registry.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import { decodeStoredChannelVisibility } from '../../../system/trust/types.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { ExtractedFact } from '../types.js';
import type { WriteResult } from '../writer.js';
import { ExtractionDrainRequeueError } from './drain-signal.js';
import { executeAcceptedFactWrites } from './write-execution.js';
import { runExtractionSideEffects } from './side-effects.js';
import {
  executeExtractionLlmPass,
  formatExistingFactsSection,
} from './llm-pass.js';
import { normalizeAndMergeExtractedFacts } from './fact-normalization.js';
import { buildAcceptedFactCandidates } from './fact-acceptance.js';
import { createEmptyRejectionBreakdown } from './rejection-breakdown.js';
import type { ExtractionParticipantNames } from './naming.js';
import {
  buildSpeakerRoutingContext,
  type ExtractionFactRouting,
  type ExtractionSourceSpeaker,
} from './speaker-routing.js';
import type { GroupMemoryWriteCapSettings } from '../../../system/config/group-memory-config.js';
import { selectExtractionWriteCandidates } from './write-selection.js';
import {
  buildExtractionSourceRef,
  evaluateExtractionPreLlmGate,
} from './signals.js';
import type {
  AcceptedFactWrite,
  ExtractionEndTelemetry,
  ExtractionGateConfig,
  ExtractionRejectionReason,
  ExtractionTriggerReason,
  ConcernCandidateExtractionSink,
} from './types.js';
import type { ExtractionSessionReader } from './session-port.js';
import { ExtractionIntegrityError } from './integrity-error.js';
import { selectExtractionRecentEntries } from './recovered-entries.js';

export { ExtractionIntegrityError, type ExtractionIntegrityErrorContext } from './integrity-error.js';

const log = createComponentLogger('Extraction');

function requireExperientialCompanionName(value: string | undefined): string {
  const companionName = value?.trim();
  if (!companionName) {
    throw new Error('Experiential self-directed extraction requires a companion name');
  }
  return companionName;
}

const CHANNEL_PRIVACY_RESTRICTIVENESS: Record<ChannelPrivacy, number> = {
  public: 0,
  invite_only: 1,
  private: 2,
};

/**
 * Resolve memory policy from the visibility persisted with the source turns.
 * Companion room ids do not encode public/private status, so classifying the
 * id alone would silently collapse both room kinds to the same default.
 * Mixed historical rows fail closed to the most restrictive valid value.
 */
export function resolveExtractionChannelVisibility(
  channelId: string,
  entries: readonly SessionEntry[],
): ChannelPrivacy {
  let resolved: ChannelPrivacy | undefined;
  for (const entry of entries) {
    const decoded = decodeStoredChannelVisibility(entry.channelVisibility);
    if (
      decoded
      && (!resolved
        || CHANNEL_PRIVACY_RESTRICTIVENESS[decoded] > CHANNEL_PRIVACY_RESTRICTIVENESS[resolved])
    ) {
      resolved = decoded;
    }
  }
  return resolved ?? classifyChannelDisclosure(channelId).channelPrivacy;
}

export interface ExtractionRunOptions {
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  canonicalContactId?: string;
  turnId?: TurnID;
  sourceSessionId?: string;
  /** Undefined permits foreground live-history lookup; an empty array is authoritative. */
  recoveredEntries?: SessionEntry[];
  icpCorrelation?: IcpConversationCorrelation;
  /**
   * mmo9.7.4: mark the extraction model call preemption-protected so a
   * welfare-escalated (aged, repeatedly-preempted) durable claim runs to
   * completion instead of being gate-preempted back into the defer loop.
   */
  preemptionProtected?: boolean;
  /**
   * fxt1: the background-work `jobId` that granted the welfare escalation.
   * Carried on the work spec so the gateway re-verifies it against the store
   * before honoring `preemptionProtected`. Set only alongside it.
   */
  welfareGrantJobId?: string;
  resolveParticipantNames?: (
    recentEntries: readonly SessionEntry[],
    canonicalContactId?: string,
  ) => ExtractionParticipantNames;
  resolveSourceSpeakerContactId?: (speaker: ExtractionSourceSpeaker) => Promise<string | undefined>;
  /** Current companion's channel-authoritative author ids for mention matching. */
  companionAuthorIds?: readonly string[];
  llmClient: LLMProviderPort;
  sessionManager: ExtractionSessionReader;
  memoryStore: MemoryStorePort;
  promptRegistry: PromptRegistryStatePort | null;
  /** Shared persona preamble service (E6.1). Prepends soft persona framing before the schema-bound task prompt. */
  personaPreamble?: PersonaPreamblePort | null;
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
  /**
   * True when the extractor is draining (stopping), as distinct from a stale
   * session route. Lets a durable, receipt-bound run (assertEffectAllowed present)
   * fail closed on a mid-flight drain instead of resolving as a covered no-op
   * that completes its effect receipt without writing (u5bv.11).
   */
  isDraining?: () => boolean;
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
  // These durable children are awaited inside the effect-guarded region so the
  // parent job receipt/fence stays open until they settle; each swallows its own
  // best-effort failures, so awaiting never fails the extraction effect.
  maybePersistEmotionalState: (
    canonicalContactId: string | undefined,
    acceptedFacts: ExtractedFact[],
    recentEntries: SessionEntry[],
  ) => Promise<string | undefined>;
  maybeRefreshContactProfile: (
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string | undefined,
    acceptedWrites: AcceptedFactWrite[],
  ) => Promise<void>;
  emitConcernCandidates?: ConcernCandidateExtractionSink;
  assertEffectAllowed?: () => Promise<void>;
}

function emptyExtractionOutputs(): MemoryExtractionOutputs {
  return { memoryIds: [], concernIds: [], contactIds: [] };
}

export async function runExtractionOrchestration(
  options: ExtractionRunOptions,
): Promise<MemoryExtractionOutputs> {
  let resolvedTurnId: TurnID | undefined = options.turnId;
  try {
    if (
      isTestingSessionId(options.channelId)
      || (options.sourceSessionId !== undefined && isTestingSessionId(options.sourceSessionId))
    ) {
      log.debug('Skipping durable extraction orchestration for testing session', {
        channelId: options.channelId,
        sourceSessionId: options.sourceSessionId,
        triggerReason: options.triggerReason,
      });
      return emptyExtractionOutputs();
    }
    const recentEntries = selectExtractionRecentEntries({
      recoveredEntries: options.recoveredEntries,
      fetchLiveHistory: () => options.sessionManager.getRecentMessages(options.channelId, 10),
      groupRecoveredRange: Boolean(options.groupWriteCaps),
    });
    const experientialSelfDirected = isExperientialSelfDirectedSessionId(options.channelId);
    // A reflection may have a grounding contact, but its first-person
    // experiential output is companion-owned. Never let that grounding contact
    // leak into memory subject/provenance or downstream profile refreshes.
    const canonicalContactId = experientialSelfDirected
      ? undefined
      : options.canonicalContactId;
    const latestTurnContext = resolveLatestTurnContext(recentEntries);
    const turnId = options.turnId ?? latestTurnContext?.turnId;
    resolvedTurnId = turnId;
    const requestId = latestTurnContext?.requestId ?? `memory-extraction:${options.channelId}:${options.triggerReason}`;
    await options.emitExtractionStart(options.channelId, options.triggerReason, turnId);

    const channelVisibility = resolveExtractionChannelVisibility(options.channelId, recentEntries);
    // The low-signal pre-LLM gate runs unconditionally, including for tracked
    // contacts (psfn-framework-2tmg). The former `if (!options.canonicalContactId)`
    // exemption had no documented rationale (introduced without comment or test
    // coverage in 3b9a1d85) and bypassed the gate for nearly all real 1:1
    // traffic, spending extraction LLM calls on filler streaks from known
    // contacts — exactly the case the gate exists to prevent.
    const preLlmGate = evaluateExtractionPreLlmGate(
      recentEntries,
      experientialSelfDirected ? { signalRole: 'assistant' } : {},
    );
    if (!preLlmGate.allowed) {
      if (options.telemetryEnabled) {
        log.debug('Skipping extraction LLM for low-signal turn', {
          channelId: options.channelId,
          triggerReason: options.triggerReason,
          ...(canonicalContactId ? { triggerContactId: canonicalContactId } : {}),
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
        ...(canonicalContactId ? { triggerContactId: canonicalContactId } : {}),
        parsedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        writeCount: 0,
        deduplicatedCount: 0,
        supersededCount: 0,
        rejectionBreakdown: createEmptyRejectionBreakdown(),
        compositionalMode: options.useCompositionalExtraction ? 'chunk_compose' : 'single_pass',
        chunkCount: 0,
        mergedFactCount: 0,
        crossChunkDeduplicatedCount: 0,
        boundaryFactCount: 0,
        preLlmGateSkipped: true,
        preLlmGateReason: preLlmGate.reason,
        preLlmGateSignalScore: preLlmGate.signalScore,
        preLlmGateSignalCount: preLlmGate.signalCount,
      });
      return emptyExtractionOutputs();
    }

    const sourceRef = buildExtractionSourceRef(
      options.channelId,
      recentEntries,
      channelVisibility,
      options.triggerReason,
      turnId,
      options.sourceSessionId,
    );
    const coveredUpToMessageId = options.resolveCoveredUpToMessageId(options.channelId, recentEntries);
    const participantNames = options.resolveParticipantNames?.(recentEntries, canonicalContactId) ?? {};
    const experientialCompanionName = experientialSelfDirected
      ? requireExperientialCompanionName(
        participantNames.companionName ?? options.sessionManager.characterName,
      )
      : undefined;
    const speakerRouting = experientialSelfDirected
      ? undefined
      : await buildSpeakerRoutingContext(
        recentEntries,
        options.resolveSourceSpeakerContactId,
      );

    const existing = await options.memoryStore.getMemoriesByChannel(options.channelId, 30);
    const noveltyCorpus = existing.map(m => m.text);

    const extractionPrompt = options.promptRegistry?.getPrompt(EXTRACTION_PROMPT_KEY)
      ?? getDefaultPromptText(EXTRACTION_PROMPT_KEY);
    const compositionalMode = options.useCompositionalExtraction ? 'chunk_compose' : 'single_pass';
    const llmPass = await executeExtractionLlmPass({
      recentEntries,
      useCompositionalExtraction: options.useCompositionalExtraction,
      promptContext: {
        extractionPrompt,
        existingFacts: formatExistingFactsSection(existing),
        participantNames,
        characterName: options.sessionManager.characterName,
        experientialCompanionName,
        personaPreamble: options.personaPreamble,
      },
      requestId,
      completeChunk: createExtractionChunkCompleter(options, turnId),
    });
    const { mergedParsedFacts, crossChunkDeduplicatedCount } = llmPass;
    const normalization = normalizeAndMergeExtractedFacts({
      mergedParsedFacts,
      recentEntries,
      participantNames,
      experientialCompanionName,
      channelVisibility,
      adjustFactForWrite: options.adjustFactForWrite ?? ((fact: ExtractedFact) => fact),
      channelId: options.channelId,
      triggerReason: options.triggerReason,
      telemetryEnabled: options.telemetryEnabled,
    });
    const { facts, participantNameHygieneRejectedCount } = normalization;

    if (!options.isAcceptingExtractions()) {
      // u5bv.11: a durable, receipt-bound run (assertEffectAllowed present) that
      // began draining mid-flight must not resolve as a covered no-op — that
      // would complete its effect receipt and advance coverage without ever
      // writing a fact (silent durable memory loss). Fail closed (retryable) so
      // the exact snapshot re-runs. No fact has been written yet at this point,
      // so requeuing cannot duplicate a durable effect. A stale session route
      // (isDraining false) keeps the intentional normal skip, as do
      // foreground/manual/group drains (no receipt).
      if (options.assertEffectAllowed && options.isDraining?.()) {
        throw new ExtractionDrainRequeueError(options.channelId, options.triggerReason);
      }
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
        chunkCount: llmPass.chunkCount,
        mergedFactCount: mergedParsedFacts.length,
        crossChunkDeduplicatedCount,
        boundaryFactCount: normalization.boundaryFactCount,
      });
      return emptyExtractionOutputs();
    }

    const acceptance = buildAcceptedFactCandidates({
      facts,
      recentEntries,
      existingMemoryTexts: noveltyCorpus,
      gateConfig: options.gateConfig,
      intakeSinkGate: options.sessionManager.intakeSinkGate,
      experientialCompanionName,
      speakerRouting,
      canonicalContactId,
      companionNames: [
        ...new Set([
          participantNames.companionName,
          options.sessionManager.characterName,
        ].filter((name): name is string => Boolean(name))),
      ],
      companionAuthorIds: options.companionAuthorIds ?? [],
      requireStructuredAddressing: Boolean(options.groupWriteCaps),
      channelId: options.channelId,
      triggerReason: options.triggerReason,
      telemetryEnabled: options.telemetryEnabled,
    });
    const { acceptedCandidates, ambiguousSpeakerSkippedCount, ambiguousSpeakerSkipReasons } = acceptance;
    const rejectionBreakdown = acceptance.rejectionBreakdown;
    rejectionBreakdown.low_signal += participantNameHygieneRejectedCount;

    const selection = selectExtractionWriteCandidates({
      acceptedCandidates,
      maxWrites: options.maxWrites,
      groupWriteCaps: options.groupWriteCaps,
      groupWriteCapContext: options.groupWriteCapContext,
      channelId: options.channelId,
      telemetryEnabled: options.telemetryEnabled,
    });
    const { selectedCandidates, writeCapSkips } = selection;
    rejectionBreakdown.write_cap += selection.writeCapSkippedCount;

    const writeExecution = await executeAcceptedFactWrites({
      selectedCandidates,
      sourceRef,
      canonicalContactId,
      channelId: options.channelId,
      triggerReason: options.triggerReason,
      turnId,
      telemetryEnabled: options.telemetryEnabled,
      isAcceptingExtractions: options.isAcceptingExtractions,
      processFact: options.processFact,
    });
    for (const [reason, count] of Object.entries(writeExecution.writePolicyRejections)) {
      rejectionBreakdown[reason as ExtractionRejectionReason] += count;
    }
    const {
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
    } = writeExecution;

    const rejectedCount = facts.length - acceptedCount + participantNameHygieneRejectedCount;
    const telemetry: ExtractionEndTelemetry = {
      channelId: options.channelId,
      count: acceptedCount,
      ...(turnId ? { turnId } : {}),
      triggerReason: options.triggerReason,
      ...(canonicalContactId ? { triggerContactId: canonicalContactId } : {}),
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
      chunkCount: llmPass.chunkCount,
      mergedFactCount: mergedParsedFacts.length,
      crossChunkDeduplicatedCount,
      boundaryFactCount: normalization.boundaryFactCount,
    };

    if (options.telemetryEnabled) {
      log.info('Extraction completed', { ...telemetry, maxWrites: options.maxWrites });
    }
    await options.assertEffectAllowed?.();
    options.recordExtractionMarker(options.channelId, coveredUpToMessageId);
    await options.emitExtractionEnd(telemetry);
    const sideEffects = await runExtractionSideEffects({
      channelId: options.channelId,
      triggerReason: options.triggerReason,
      canonicalContactId,
      turnId,
      sourceRef,
      recentEntries,
      existingMemories: existing,
      acceptedFactsForConcernCandidates,
      acceptedWrites,
      acceptedFactsByContact,
      emitConcernCandidates: options.emitConcernCandidates,
      maybePersistEmotionalState: options.maybePersistEmotionalState,
      maybeRefreshContactProfile: options.maybeRefreshContactProfile,
      assertEffectAllowed: options.assertEffectAllowed,
    });
    return {
      memoryIds: [...durableMemoryIds],
      concernIds: [...new Set(sideEffects.concernIds)],
      contactIds: [...new Set(sideEffects.contactIds)],
    };
  } catch (error) {
    // Durable drain requeues and model-call preemptions are intentional
    // retryable control signals, not integrity failures. Surface them unwrapped
    // so the post-turn seam can defer the job and its receipt for a later run
    // (u5bv.11, hrmrq.90).
    if (error instanceof ExtractionDrainRequeueError) throw error;
    if (error instanceof Error && error.name === 'ModelCallPreemptedError') throw error;
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

/**
 * Builds the per-chunk model-call port handed to the LLM pass stage. Kept in
 * this module so the durable work-spec construction (including the sanctioned
 * preemptionProtected / welfareGrantJobId welfare forwarding) stays on the
 * enforcement-scanned path.
 */
function createExtractionChunkCompleter(
  options: ExtractionRunOptions,
  turnId: TurnID | undefined,
): (prompt: string, chunkRequestId: string) => Promise<string> {
  return async (prompt, chunkRequestId) => {
    const response = await completeWithWorkSpec(
      options.llmClient,
      {
        systemPrompt: prompt,
        messages: [{ role: 'user', content: 'Extract facts from the conversation above.' }],
      },
      buildLLMWorkSpec({
        purpose: 'extraction',
        durable: true,
        ...(options.preemptionProtected
          ? {
              preemptionProtected: true,
              ...(options.welfareGrantJobId
                ? { welfareGrantJobId: options.welfareGrantJobId }
                : {}),
            }
          : {}),
        correlation: {
          requestId: chunkRequestId,
          ...(turnId ? { turnId } : {}),
          channelId: options.channelId,
          callType: 'memory',
          purpose: 'memory.extraction',
          ...(options.icpCorrelation
            ? {
                icpCorrelation: deriveChildIcpConversationCostCorrelation(
                  options.icpCorrelation,
                  {
                    requestId: chunkRequestId,
                    costPurpose: 'extraction',
                    costOriginStage: 'post_turn',
                  },
                ),
              }
            : {}),
        },
      }),
    );
    return response.content;
  };
}
