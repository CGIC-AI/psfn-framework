import type { LLMProvider } from '../../agent/contracts.js';
import { countTokens } from '../../llm/tokens.js';
import type { ContextMessage, LLMContext, SubstrateConfig } from '../../types.js';
import { resolveSessionHistoryBudget } from '../../context-budget.js';
import type { EventBus } from '../../event-bus.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import {
  classifyChannel,
  type ChannelMeta,
} from '../../trust/policy.js';
import type { SessionStore } from '../store.js';
import type { UserContinuityStore } from '../continuity.js';
import {
  DEFAULT_CONTINUITY_CONTEXT_LIMIT,
  isUntrustedVisibility,
  parseChannelVisibility,
  resolveRoleName,
  trimRecentEntriesToTokenBudget,
  wrapUntrustedContext,
} from '../manager-primitives.js';
import type { PreCompactionExtractionHandler } from './contracts.js';
import { entriesToMessages, getMergedContinuity } from './context-support.js';
import { runAutoCompaction } from './compaction-service.js';

interface BuildSessionContextParams {
  channelId: string;
  systemPrompt: string;
  memoriesBlock: string;
  llmProvider?: LLMProvider;
  userId?: string;
  channelMeta?: ChannelMeta;
  continuityFallbackUserIds: string[];
  store: SessionStore;
  config: SubstrateConfig;
  eventBus: EventBus | null;
  promptRegistry: PromptRegistryStore | null;
  preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  continuityStore: UserContinuityStore | null;
  /** Character name from identity card (e.g. 'Purrsephone'). Used for display labels. */
  characterName?: string;
}

export async function buildSessionContext(params: BuildSessionContextParams): Promise<LLMContext> {
  const channelVisibility = classifyChannel(params.channelId, params.channelMeta);
  const historyBudget = resolveSessionHistoryBudget(params.config);
  let recent = params.store.getRecent(params.channelId, historyBudget.estimatedCount);
  if (historyBudget.mode === 'budget') {
    recent = trimRecentEntriesToTokenBudget(recent, historyBudget.tokenBudget);
  }

  // Auto-compaction: when total context tokens exceed threshold, compact oldest half
  if (params.llmProvider) {
    const systemTokens = countTokens(params.systemPrompt) + countTokens(params.memoriesBlock);
    const result = await runAutoCompaction({
      channelId: params.channelId,
      recent,
      channelVisibility,
      systemTokens,
      llmProvider: params.llmProvider,
      store: params.store,
      config: params.config,
      eventBus: params.eventBus,
      promptRegistry: params.promptRegistry,
      preCompactionExtractionHandler: params.preCompactionExtractionHandler,
      userId: params.userId,
    });
    recent = result.recent;
  }

  // Build system prompt with memories
  let fullSystem = params.systemPrompt;
  if (params.memoriesBlock) {
    fullSystem += '\n\n' + params.memoriesBlock;
  }

  // Prepend compaction summaries as context
  // Re-fetch summaries after potential compaction above
  const allSummaries = params.store.getCompactionSummaries(params.channelId);
  if (allSummaries.length > 0) {
    const summaryBlock = allSummaries
      .map(s => s.summary)
      .join('\n\n');
    fullSystem += '\n\n[Previous conversation summary]\n' + summaryBlock;
  }

  // Cross-channel continuity: include recent activity from other channels
  if (params.continuityStore && params.userId) {
    const continuityLimit = params.config.continuityMessageLimit ?? DEFAULT_CONTINUITY_CONTEXT_LIMIT;
    const crossChannel = getMergedContinuity({
      continuityStore: params.continuityStore,
      canonicalUserId: params.userId,
      limit: continuityLimit,
      fallbackUserIds: params.continuityFallbackUserIds,
      channelId: params.channelId,
      channelMeta: params.channelMeta,
    });

    if (crossChannel.length > 0) {
      const roleNames = { charName: params.characterName };
      const continuityBlock = crossChannel
        .map(e => {
          const origin = e.originChannelId ? ` [from ${e.originChannelId}]` : '';
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
      fullSystem += '\n\n[Recent activity from other channels]\n' + continuityBlock;
    }
  }

  // Convert session entries to LLM messages
  const messages: ContextMessage[] = entriesToMessages(recent, channelVisibility);

  return {
    systemPrompt: fullSystem,
    messages,
  };
}
