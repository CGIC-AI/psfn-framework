import type { LLMProvider } from '../../agent/contracts.js';
import { countMessageTokens, countTokens } from '../../llm/tokens.js';
import { createComponentLogger } from '../../logger.js';
import type { ContextMessage, LLMContext, SubstrateConfig } from '../../types.js';
import {
  resolveAdaptiveContextBudgetProfile,
  resolveMemoryRetrievalBudget,
  resolveSessionHistoryBudget,
  type ContextBudgetTurnCharacteristics,
} from '../../context-budget.js';
import type { EventBus } from '../../event-bus.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import { wrapCompactionSummaryAsUntrustedContext } from '../../identity/prompt-composer.js';
import type { TurnSessionContextSnapshot } from '../../turns/snapshot.js';
import { cloneSessionEntry } from '../../turns/snapshot.js';
import type { SessionEntry } from '../types.js';
import { resolveSessionEntryTurnContext } from '../turn-provenance.js';
import {
  classifyChannel,
  type ChannelMeta,
} from '../../trust/policy.js';
import type { SessionStore } from '../store.js';
import type { UserContinuityStore } from '../continuity.js';
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
import { entriesToMessages, getMergedContinuity } from './context-support.js';
import { runAutoCompaction } from './compaction-service.js';
import { MASKED_TOOL_OBSERVATION_CONTENT } from '../tool-observation.js';
import { applyFocusCompactionRanges, type FocusCompactionRange } from '../focus-knowledge.js';

const log = createComponentLogger('ContextBuilder');

interface BuildSessionContextParams {
  channelId: string;
  systemPrompt: string;
  coreMemoryBlock: string;
  memoriesBlock: string;
  compactionPromptText?: string;
  llmProvider?: LLMProvider;
  userId?: string;
  channelMeta?: ChannelMeta;
  continuityFallbackUserIds: string[];
  store: SessionStore;
  config: SubstrateConfig;
  eventBus: EventBus | null;
  promptRegistry: PromptRegistryStore | null;
  preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  onCompactionComplete?: (event: {
    channelId: string;
    originalContext: string;
    compressedContext: string;
    capturedAt: number;
  }) => void;
  continuityStore: UserContinuityStore | null;
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
  if (hasCoreMemorySection) {
    fullSystem += '\n\n' + coreMemorySectionText;
  }
  const hasMemorySection = params.memoriesBlock.trim().length > 0;
  const memorySectionText = hasMemorySection ? params.memoriesBlock : '';
  if (hasMemorySection) {
    fullSystem += '\n\n' + params.memoriesBlock;
  }

  // Prepend compaction summaries as context
  let compactionSummarySectionText = '';
  if (compactionSummaryTexts.length > 0) {
    const summaryBlock = compactionSummaryTexts.join('\n\n');
    compactionSummarySectionText = '[Previous conversation summary]\n' + summaryBlock;
    fullSystem += '\n\n' + compactionSummarySectionText;
  }

  let focusKnowledgeSectionText = '';
  if (focusKnowledgeTexts.length > 0) {
    focusKnowledgeSectionText = '[Focus knowledge]\n' + focusKnowledgeTexts.join('\n');
    fullSystem += '\n\n' + focusKnowledgeSectionText;
  }

  // Cross-channel continuity: include recent activity from other channels
  const crossChannel = params.turnSnapshot
    ? params.turnSnapshot.continuityEntries.map(cloneSessionEntry)
    : params.continuityStore && params.userId
      ? getMergedContinuity({
        continuityStore: params.continuityStore,
        canonicalUserId: params.userId,
        limit: params.config.continuityMessageLimit ?? DEFAULT_CONTINUITY_CONTEXT_LIMIT,
        fallbackUserIds: params.continuityFallbackUserIds,
        channelId: params.channelId,
        channelMeta: params.channelMeta,
      })
      : [];

  let continuitySectionText = '';
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
    continuitySectionText = '[Recent activity from other channels]\n' + continuityBlock;
    fullSystem += '\n\n' + continuitySectionText;
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

  return {
    systemPrompt: fullSystem,
    messages,
    manifest,
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
