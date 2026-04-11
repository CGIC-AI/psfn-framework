import type { LLMProviderPort } from '../../agent/contracts.js';
import { countMessageTokens, countTokens } from '../../../primitives/llm/tokens.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { ContextMessage, LLMContext } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  resolveAdaptiveContextBudgetProfile,
  resolveMemoryRetrievalBudget,
  resolveSessionHistoryBudget,
  type ContextBudgetTurnCharacteristics,
} from '../../../shared/context-budget.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { PromptRegistryStatePort } from '../../identity/prompt-state-port.js';
import { resolveConfiguredCompanionDataDir } from '../../../persistence/layout.js';
import { wrapCompactionSummaryAsUntrustedContext } from '../../identity/prompt-composer.js';
import {
  orderPromptRuntimeSystemPromptSections,
  PromptRuntimeLayoutStore,
  resolvePromptRuntimeLayoutPath,
  type PromptRuntimeSystemPromptBlockId,
} from '../../identity/prompt-runtime.js';
import type { TurnSessionContextSnapshot } from '../../turns/snapshot.js';
import { cloneSessionEntry } from '../../turns/snapshot.js';
import type { SessionEntry } from '../types.js';
import { resolveSessionEntryTurnContext } from '../turn-provenance.js';
import {
  classifyChannel,
  type ChannelMeta,
} from '../../../system/trust/policy.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { CrossChannelContinuityPort } from '../cross-channel-continuity-port.js';
import type {
  ContextManifest,
  ContextManifestMemorySeed,
} from '../context-manifest.js';
import {
  collectRecentEntriesWithinTokenBudget,
  DEFAULT_CONTINUITY_CONTEXT_LIMIT,
  isUntrustedVisibility,
  parseChannelVisibility,
  resolveRoleName,
  wrapUntrustedContext,
} from '../manager-primitives.js';
import type { PreCompactionExtractionHandler } from './contracts.js';
import {
  countIntentionAppraisalArtifacts,
  entriesToMessages,
} from './context-support.js';
import { runAutoCompaction } from './compaction-service.js';
import { MASKED_TOOL_OBSERVATION_CONTENT } from '../tool-observation.js';
import { applyFocusCompactionRanges, type FocusCompactionRange } from '../focus-knowledge.js';
import { buildPromptSectionTelemetryList } from '../../identity/prompt-sections.js';

const log = createComponentLogger('ContextBuilder');
const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';
export const DEFAULT_ORIENTATION_IDLE_THRESHOLD_MS = 3 * 60 * 60 * 1000;
const ORIENTATION_SUMMARY_MAX_CHARS = 180;
const promptRuntimeLayoutStoreCache = new Map<string, PromptRuntimeLayoutStore>();

function getPromptRuntimeLayoutStore(config: SubstrateConfig): PromptRuntimeLayoutStore {
  const companionDataDir = resolveConfiguredCompanionDataDir(config);
  const filePath = resolvePromptRuntimeLayoutPath(companionDataDir);
  const cached = promptRuntimeLayoutStoreCache.get(filePath);
  if (cached) return cached;
  const created = new PromptRuntimeLayoutStore(filePath);
  promptRuntimeLayoutStoreCache.set(filePath, created);
  return created;
}

function isInternalJournalChannel(channelId: string): boolean {
  return channelId === 'internal:heartbeat' || channelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX);
}

export type OrientationNoteReason =
  | 'idle_gap_exceeded'
  | 'below_threshold'
  | 'no_previous_activity'
  | 'internal_channel';

export interface OrientationNoteTelemetry {
  fired: boolean;
  reason: OrientationNoteReason;
  observedAt: number;
  idleThresholdMs: number;
  lastActivityAt?: number;
  idleGapMs?: number;
  noteText?: string;
  sessionSummary?: string;
  continuitySummary?: string;
  sourceCounts: {
    session: number;
    continuity: number;
    focusKnowledge: number;
  };
}

function compactPromptText(value: string, maxChars = ORIENTATION_SUMMARY_MAX_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function summarizeConversationEntries(
  entries: SessionEntry[],
  characterName?: string,
  maxItems = 2,
): string {
  const relevant = entries.filter(entry => entry.role === 'user' || entry.role === 'assistant');
  if (relevant.length === 0) return '';

  const recent = relevant.slice(-maxItems);
  const roleNames = { charName: characterName };
  return recent.map((entry) => {
    const speaker = entry.role === 'assistant'
      ? resolveRoleName('assistant', roleNames)
      : entry.authorName ?? resolveRoleName('user', roleNames);
    return `${speaker}: ${compactPromptText(entry.content)}`;
  }).join(' / ');
}

function formatIdleGap(idleGapMs: number): string {
  const normalized = Math.max(0, Math.floor(idleGapMs));
  const totalMinutes = Math.max(0, Math.floor(normalized / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes > 0
      ? `${hours} hour${hours === 1 ? '' : 's'} ${minutes} minute${minutes === 1 ? '' : 's'}`
      : `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0
    ? `${days} day${days === 1 ? '' : 's'} ${remainingHours} hour${remainingHours === 1 ? '' : 's'}`
    : `${days} day${days === 1 ? '' : 's'}`;
}

export function buildOrientationNoteTelemetry(params: {
  channelId: string;
  recentActivityEntries: SessionEntry[];
  continuityEntries: SessionEntry[];
  focusKnowledgeTexts: string[];
  characterName?: string;
  nowMs?: number;
  idleThresholdMs?: number;
}): OrientationNoteTelemetry {
  const observedAt = params.nowMs ?? Date.now();
  const idleThresholdMs = Math.max(
    0,
    Math.floor(params.idleThresholdMs ?? DEFAULT_ORIENTATION_IDLE_THRESHOLD_MS),
  );
  const sourceCounts = {
    session: params.recentActivityEntries.filter(entry => entry.role === 'user' || entry.role === 'assistant').length,
    continuity: params.continuityEntries.filter(entry => entry.role === 'user' || entry.role === 'assistant').length,
    focusKnowledge: params.focusKnowledgeTexts.filter(text => text.trim().length > 0).length,
  };

  if (isInternalJournalChannel(params.channelId)) {
    return {
      fired: false,
      reason: 'internal_channel',
      observedAt,
      idleThresholdMs,
      sourceCounts,
    };
  }

  const relevantRecentEntries = params.recentActivityEntries.filter(
    entry => entry.role === 'user' || entry.role === 'assistant',
  );
  if (relevantRecentEntries.length <= 1) {
    return {
      fired: false,
      reason: 'no_previous_activity',
      observedAt,
      idleThresholdMs,
      sourceCounts,
    };
  }

  const priorEntries = relevantRecentEntries.slice(0, -1);
  const lastActivityAt = priorEntries.at(-1)?.timestamp;
  if (!lastActivityAt || !Number.isFinite(lastActivityAt) || lastActivityAt <= 0) {
    return {
      fired: false,
      reason: 'no_previous_activity',
      observedAt,
      idleThresholdMs,
      sourceCounts,
    };
  }

  const idleGapMs = Math.max(0, observedAt - lastActivityAt);
  if (idleGapMs < idleThresholdMs) {
    return {
      fired: false,
      reason: 'below_threshold',
      observedAt,
      idleThresholdMs,
      lastActivityAt,
      idleGapMs,
      sourceCounts,
    };
  }

  const sessionSummary = summarizeConversationEntries(priorEntries, params.characterName);
  const continuitySummary = summarizeConversationEntries(params.continuityEntries, params.characterName);

  const noteParts = [
    '[Welcome back]',
    `It has been about ${formatIdleGap(idleGapMs)} since this channel was last active.`,
  ];
  if (sessionSummary) {
    noteParts.push(`Last time here: ${sessionSummary}.`);
  }
  if (continuitySummary) {
    noteParts.push(`Recent continuity: ${continuitySummary}.`);
  }

  return {
    fired: true,
    reason: 'idle_gap_exceeded',
    observedAt,
    idleThresholdMs,
    lastActivityAt,
    idleGapMs,
    noteText: noteParts.join('\n').trim(),
    sessionSummary,
    continuitySummary,
    sourceCounts,
  };
}

interface BuildSessionContextParams {
  channelId: string;
  systemPrompt: string;
  coreMemoryBlock: string;
  memoriesBlock: string;
  compactionPromptText?: string;
  llmProvider?: LLMProviderPort;
  userId?: string;
  channelMeta?: ChannelMeta;
  continuityFallbackUserIds: string[];
  store: SessionStore;
  config: SubstrateConfig;
  eventBus: EventBus | null;
  promptRegistry: PromptRegistryStatePort | null;
  preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  onCompactionComplete?: (event: {
    channelId: string;
    originalContext: string;
    compressedContext: string;
    capturedAt: number;
  }) => void;
  crossChannelContinuity: CrossChannelContinuityPort;
  /** Character name from identity card (e.g. 'Companion'). Used for display labels. */
  characterName?: string;
  turnSnapshot?: TurnSessionContextSnapshot;
  focusKnowledgeTexts: string[];
  focusCompactionRanges: FocusCompactionRange[];
  memoryManifestSeed?: ContextManifestMemorySeed;
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
}

export async function buildSessionContext(params: BuildSessionContextParams): Promise<LLMContext> {
  const channelVisibility = classifyChannel(params.channelId, params.channelMeta);
  const adaptiveBudgetProfile = resolveAdaptiveContextBudgetProfile(
    params.config,
    params.turnBudgetCharacteristics,
  );
  const historyBudget = resolveSessionHistoryBudget(params.config, {
    ...(params.turnBudgetCharacteristics ? { turn: params.turnBudgetCharacteristics } : {}),
    adaptiveProfile: adaptiveBudgetProfile,
  });
  const memoryBudget = resolveMemoryRetrievalBudget(params.config, {
    ...(params.turnBudgetCharacteristics ? { turn: params.turnBudgetCharacteristics } : {}),
    adaptiveProfile: adaptiveBudgetProfile,
  });
  const collectedRecent = params.turnSnapshot
    ? null
    : collectRecentEntriesWithinTokenBudget({
      store: params.store,
      channelId: params.channelId,
      estimatedCount: historyBudget.estimatedCount,
      tokenBudget: historyBudget.tokenBudget,
    });
  let recent = params.turnSnapshot
    ? params.turnSnapshot.recentEntries.map(cloneSessionEntry)
    : collectedRecent!.entries;
  const sourceEntryCount = params.turnSnapshot
    ? recent.length
    : collectedRecent!.sourceCount;
  const focusCompaction = applyFocusCompactionRanges(
    recent,
    params.focusCompactionRanges,
  );
  recent = focusCompaction.entries;
  const trimmedEntryCount = Math.max(0, sourceEntryCount - recent.length);
  const intentionAppraisalArtifactCount = countIntentionAppraisalArtifacts(recent);
  const masking = applyObservationMasking(
    recent,
    params.config.observationMaskingWindow ?? DEFAULT_OBSERVATION_MASKING_WINDOW,
  );
  recent = masking.entries;
  let compactionSummaryTexts = params.turnSnapshot
    ? [...params.turnSnapshot.compactionSummaryTexts]
    : params.store.getCompactionSummaries(params.channelId).map(summary => summary.summary);
  const focusKnowledgeTexts = params.turnSnapshot
    ? [...params.turnSnapshot.focusKnowledgeTexts]
    : [...params.focusKnowledgeTexts];
  const baseSystemTokenCount = countTokens(params.systemPrompt);
  const hasCoreMemorySection = params.coreMemoryBlock.trim().length > 0;
  const coreMemorySectionText = hasCoreMemorySection ? params.coreMemoryBlock : '';
  const coreMemoryTokenCount = countTokens(coreMemorySectionText);
  const memoryTokenCount = countTokens(params.memoriesBlock);
  const compactionThresholdTokenBudget = Math.floor(
    historyBudget.contextWindow * (params.config.compactionThresholdPct / 100),
  );
  const sessionMessageTokens = countMessageTokens(
    entriesToMessages(recent, channelVisibility, false),
  );
  let compactionManifest = {
    triggered: false,
    compactedEntryCount: 0,
    totalTokensBefore: baseSystemTokenCount + coreMemoryTokenCount + memoryTokenCount + sessionMessageTokens,
    totalTokensAfter: baseSystemTokenCount + coreMemoryTokenCount + memoryTokenCount + sessionMessageTokens,
  };

  // Explicit compaction remains available for callers that opt into it.
  if (params.llmProvider) {
    const systemTokens = baseSystemTokenCount + coreMemoryTokenCount + memoryTokenCount;
    const preCompactionEntryCount = recent.length;
    const result = await runAutoCompaction({
      channelId: params.channelId,
      recent,
      channelVisibility,
      systemTokens,
      compactionPromptText: params.compactionPromptText ?? params.turnSnapshot?.compactionPromptText,
      llmProvider: params.llmProvider,
      store: params.store,
      config: params.config,
      eventBus: params.eventBus,
      promptRegistry: params.promptRegistry,
      preCompactionExtractionHandler: params.preCompactionExtractionHandler,
      onCompactionComplete: params.onCompactionComplete,
      userId: params.userId,
    });
    recent = result.recent;
    if (result.compactionSummaryText) {
      compactionSummaryTexts = [
        ...compactionSummaryTexts,
        wrapCompactionSummaryAsUntrustedContext(result.compactionSummaryText),
      ];
    }
    const postCompactionMessageTokens = countMessageTokens(
      entriesToMessages(recent, channelVisibility, false),
    );
    const newSummaryTokenCount = result.compactionSummaryText
      ? countTokens(wrapCompactionSummaryAsUntrustedContext(result.compactionSummaryText))
      : 0;
    compactionManifest = {
      triggered: result.compacted,
      compactedEntryCount: result.compacted
        ? Math.max(0, preCompactionEntryCount - recent.length)
        : 0,
      totalTokensBefore: systemTokens + sessionMessageTokens,
      totalTokensAfter: systemTokens + postCompactionMessageTokens + newSummaryTokenCount,
    };
  }

  // Build system prompt with memories
  let fullSystem = params.systemPrompt;
  const hasMemorySection = params.memoriesBlock.trim().length > 0;
  const memorySectionText = hasMemorySection ? params.memoriesBlock : '';

  // Prepend compaction summaries as context
  let compactionSummarySectionText = '';
  if (compactionSummaryTexts.length > 0) {
    const summaryBlock = compactionSummaryTexts.join('\n\n');
    compactionSummarySectionText = '[Previous conversation summary]\n' + summaryBlock;
  }

  let focusKnowledgeSectionText = '';
  if (focusKnowledgeTexts.length > 0) {
    focusKnowledgeSectionText = '[Focus knowledge]\n' + focusKnowledgeTexts.join('\n');
  }

  // Cross-channel continuity: include recent activity from other channels
  const rawCrossChannel = params.turnSnapshot
    ? params.turnSnapshot.continuityEntries.map(cloneSessionEntry)
    : params.userId
      ? params.crossChannelContinuity.getMerged({
        canonicalUserId: params.userId,
        limit: params.config.continuityMessageLimit ?? DEFAULT_CONTINUITY_CONTEXT_LIMIT,
        fallbackUserIds: params.continuityFallbackUserIds,
        channelId: params.channelId,
        channelMeta: params.channelMeta,
      })
      : [];
  const crossChannel = rawCrossChannel.filter(entry => !isInternalJournalChannel(entry.originChannelId ?? entry.channelId));
  const orientationTelemetry = params.turnSnapshot?.orientation ?? buildOrientationNoteTelemetry({
    channelId: params.channelId,
    recentActivityEntries: params.store.getRecent(params.channelId, 6),
    continuityEntries: crossChannel,
    focusKnowledgeTexts,
    characterName: params.characterName,
  });

  let continuitySectionText = '';
  if (orientationTelemetry.fired && orientationTelemetry.noteText) {
    continuitySectionText = orientationTelemetry.noteText;
  }
  if (crossChannel.length > 0) {
    const roleNames = { charName: params.characterName };
    const continuityBlock = crossChannel
      .map(e => {
        const sourceChannelId = (e.originChannelId ?? e.channelId).trim();
        const origin = sourceChannelId ? ` [from ${sourceChannelId}]` : '';
        const speaker = e.role === 'user'
          ? (e.authorName ?? resolveRoleName('user', roleNames))
          : resolveRoleName('assistant', roleNames);
        const rawContent = `${speaker}${origin}: ${e.content}`;
        const originVisibility = parseChannelVisibility(e.channelVisibility)
          ?? classifyChannel(e.originChannelId ?? e.channelId);
        if (!isUntrustedVisibility(originVisibility)) {
          return rawContent;
        }
        return wrapUntrustedContext(rawContent);
      })
      .join('\n');
    continuitySectionText = continuitySectionText.length > 0
      ? `${continuitySectionText}\n\n[Recent activity from other channels]\n${continuityBlock}`
      : '[Recent activity from other channels]\n' + continuityBlock;
  }

  const promptRuntimeLayout = getPromptRuntimeLayoutStore(params.config);
  const orderedRuntimeSections = orderPromptRuntimeSystemPromptSections([
    {
      id: 'memory.core' as PromptRuntimeSystemPromptBlockId,
      content: coreMemorySectionText,
    },
    {
      id: 'memory.retrieval' as PromptRuntimeSystemPromptBlockId,
      content: memorySectionText,
    },
    {
      id: 'session.compaction_summary' as PromptRuntimeSystemPromptBlockId,
      content: compactionSummarySectionText,
    },
    {
      id: 'session.focus_knowledge' as PromptRuntimeSystemPromptBlockId,
      content: focusKnowledgeSectionText,
    },
    {
      id: 'session.continuity' as PromptRuntimeSystemPromptBlockId,
      content: continuitySectionText,
    },
  ], promptRuntimeLayout);
  for (const section of orderedRuntimeSections) {
    const trimmed = section.content.trim();
    if (!trimmed) continue;
    fullSystem += '\n\n' + trimmed;
  }

  // Convert session entries to LLM messages
  const messages: ContextMessage[] = entriesToMessages(recent, channelVisibility);
  const sessionMessageTokenCount = countMessageTokens(messages);
  const memoryIncludedCount = params.memoryManifestSeed?.returnedCount ?? 0;
  const seededMemoryHardLimit = params.memoryManifestSeed?.retrievalLimitMode === 'hard_limit'
    ? params.memoryManifestSeed.retrievalLimit
    : undefined;
  const manifest: ContextManifest = {
    channelId: params.channelId,
    generatedAt: Date.now(),
    session: {
      sourceEntryCount,
      trimmedEntryCount,
      maskedEntryCount: masking.maskedCount,
      compactedEntryCount: compactionManifest.compactedEntryCount,
      intentionAppraisalArtifactCount,
      finalEntryCount: recent.length,
      finalMessageCount: messages.length,
      compactionSummaryCount: compactionSummaryTexts.length,
      continuityEntryCount: crossChannel.length,
    },
    memory: {
      includedCount: memoryIncludedCount,
      includedTypes: { ...(params.memoryManifestSeed?.selectedTypes ?? {}) },
      includedTokenCount: memoryTokenCount,
      reason: params.memoryManifestSeed?.reason ?? (memorySectionText ? 'seed_missing' : 'empty_input'),
      ...(params.memoryManifestSeed?.retrievalSource
        ? { retrievalSource: params.memoryManifestSeed.retrievalSource }
        : {}),
      candidateCount: params.memoryManifestSeed?.candidateCount ?? 0,
      policyAllowedCount: params.memoryManifestSeed?.policyAllowedCount ?? 0,
      rankedCount: params.memoryManifestSeed?.rankedCount ?? 0,
      returnedCount: memoryIncludedCount,
      excluded: {
        ...(params.memoryManifestSeed?.contactScopeRejectedCount !== undefined
          ? { contactScopeRejectedCount: params.memoryManifestSeed.contactScopeRejectedCount }
          : {}),
        sensitivityRejectedCount: params.memoryManifestSeed?.sensitivityRejectedCount ?? 0,
        policyRejectedCount: params.memoryManifestSeed?.policyRejectedCount ?? 0,
        ...(params.memoryManifestSeed?.policyRejectedReasonTags
          ? { policyRejectedReasonTags: { ...params.memoryManifestSeed.policyRejectedReasonTags } }
          : {}),
        ...(params.memoryManifestSeed?.withheldCount !== undefined
          ? { withheldCount: params.memoryManifestSeed.withheldCount }
          : {}),
        ...(params.memoryManifestSeed?.withheldReasonCounts
          ? { withheldReasonCounts: { ...params.memoryManifestSeed.withheldReasonCounts } }
          : {}),
        scoreRejectedCount: params.memoryManifestSeed?.scoreRejectedCount ?? 0,
        budgetCappedCount: params.memoryManifestSeed?.budgetCappedCount ?? 0,
      },
      retrieval: {
        mode: params.memoryManifestSeed?.retrievalLimitMode ?? memoryBudget.mode,
        budgetPct: params.memoryManifestSeed?.retrievalBudgetPct ?? memoryBudget.budgetPct,
        tokenBudget: params.memoryManifestSeed?.retrievalTokenBudget ?? memoryBudget.tokenBudget,
        limit: params.memoryManifestSeed?.retrievalLimit ?? memoryBudget.estimatedCount,
        ...(params.memoryManifestSeed?.compositionalMode
          ? { compositionalMode: params.memoryManifestSeed.compositionalMode }
          : {}),
      },
    },
    budgets: {
      contextWindow: historyBudget.contextWindow,
      adaptive: {
        enabled: adaptiveBudgetProfile.enabled,
        source: adaptiveBudgetProfile.source,
        category: adaptiveBudgetProfile.category,
      },
      sessionHistory: {
        mode: historyBudget.mode,
        budgetPct: historyBudget.budgetPct,
        tokenBudget: historyBudget.tokenBudget,
        estimatedCount: historyBudget.estimatedCount,
        ...(historyBudget.hardLimit !== undefined ? { hardLimit: historyBudget.hardLimit } : {}),
        actualCount: recent.length,
        actualTokenCount: sessionMessageTokenCount,
      },
      memoryRetrieval: {
        mode: params.memoryManifestSeed?.retrievalLimitMode ?? memoryBudget.mode,
        budgetPct: params.memoryManifestSeed?.retrievalBudgetPct ?? memoryBudget.budgetPct,
        tokenBudget: params.memoryManifestSeed?.retrievalTokenBudget ?? memoryBudget.tokenBudget,
        estimatedCount: memoryBudget.estimatedCount,
        ...(seededMemoryHardLimit !== undefined
          ? { hardLimit: seededMemoryHardLimit }
          : memoryBudget.hardLimit !== undefined
            ? { hardLimit: memoryBudget.hardLimit }
            : {}),
        actualCount: memoryIncludedCount,
        actualTokenCount: memoryTokenCount,
      },
      sections: [
        { section: 'system_prompt', tokenCount: baseSystemTokenCount },
        { section: 'core_memory', tokenCount: coreMemoryTokenCount },
        { section: 'memories', tokenCount: memoryTokenCount },
        {
          section: 'compaction_summary',
          tokenCount: countTokens(compactionSummarySectionText) + countTokens(focusKnowledgeSectionText),
        },
        { section: 'continuity', tokenCount: countTokens(continuitySectionText) },
        { section: 'session_history', tokenCount: sessionMessageTokenCount },
      ],
    },
    compaction: {
      triggered: compactionManifest.triggered,
      thresholdPct: params.config.compactionThresholdPct,
      tokenBudget: compactionThresholdTokenBudget,
      totalTokensBefore: compactionManifest.totalTokensBefore,
      totalTokensAfter: compactionManifest.totalTokensAfter,
    },
  };
  log.debug('Built context manifest', manifest);

  const systemPromptSections = buildPromptSectionTelemetryList([
    {
      id: 'pre_session_prompt',
      title: 'Pre-Session Prompt',
      content: params.systemPrompt,
    },
    {
      id: 'core_memory',
      title: 'Core Memory',
      content: coreMemorySectionText,
    },
    {
      id: 'retrieved_memory',
      title: 'Retrieved Memory',
      content: memorySectionText,
    },
    {
      id: 'previous_conversation_summary',
      title: 'Previous Conversation Summary',
      content: compactionSummarySectionText,
    },
    {
      id: 'focus_knowledge',
      title: 'Focus Knowledge',
      content: focusKnowledgeSectionText,
    },
  ]);

  return {
    systemPrompt: fullSystem,
    messages,
    manifest,
    systemPromptSections,
  };
}

export const DEFAULT_OBSERVATION_MASKING_WINDOW = 10;

export function applyObservationMasking(
  entries: SessionEntry[],
  window: number,
): { entries: SessionEntry[]; maskedCount: number } {
  const normalizedWindow = Number.isFinite(window)
    ? Math.max(0, Math.floor(window))
    : DEFAULT_OBSERVATION_MASKING_WINDOW;
  if (entries.length === 0) {
    return { entries, maskedCount: 0 };
  }

  const unmaskedTurnIds = new Set<string>();
  if (normalizedWindow > 0) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.role === 'system') continue;
      const turnContext = resolveSessionEntryTurnContext(entry);
      unmaskedTurnIds.add(turnContext.turnId);
      if (unmaskedTurnIds.size >= normalizedWindow) {
        break;
      }
    }
  }

  let maskedCount = 0;
  const maskedEntries = entries.map((entry) => {
    if (entry.role !== 'tool') return entry;
    const turnContext = resolveSessionEntryTurnContext(entry);
    if (unmaskedTurnIds.has(turnContext.turnId)) {
      return entry;
    }
    maskedCount += 1;
    return {
      ...entry,
      content: MASKED_TOOL_OBSERVATION_CONTENT,
    };
  });

  return {
    entries: maskedEntries,
    maskedCount,
  };
}
