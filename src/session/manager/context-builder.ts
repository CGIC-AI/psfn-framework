import type { LLMProvider } from '../../agent/contracts.js';
import { countMessageTokens, countTokens } from '../../llm/tokens.js';
import { createComponentLogger } from '../../logger.js';
import type { ContextMessage, LLMContext, SubstrateConfig } from '../../types.js';
import { resolveSessionHistoryBudget } from '../../context-budget.js';
import type { EventBus } from '../../event-bus.js';
import { COMPACTION_SUMMARY_PROMPT_KEY, getDefaultPromptText } from '../../identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import {
  classifyChannel,
  type ChannelMeta,
} from '../../trust/policy.js';
import { toErrorMessage } from '../../utils/errors.js';
import {
  buildCompactionSourceBlock,
  buildCompactionSourceHashTag,
} from '../compaction-audit.js';
import type { SessionStore } from '../store.js';
import type { UserContinuityStore } from '../continuity.js';
import {
  DEFAULT_CONTINUITY_CONTEXT_LIMIT,
  appendCompactionMetadataBlocks,
  buildCompactionPreservedTagBlock,
  isUntrustedVisibility,
  parseChannelVisibility,
  resolveEmotionalSalienceThreshold,
  resolveRoleName,
  trimRecentEntriesToTokenBudget,
  withRetry,
  wrapUntrustedContext,
} from '../manager-primitives.js';
import type { PreCompactionExtractionHandler } from './contracts.js';
import { entriesToMessages, getMergedContinuity } from './context-support.js';

const log = createComponentLogger('SessionManager');

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
  if (params.llmProvider && recent.length > 4) {
    const chatSlot = params.config.modelRoster.chat;
    const contextWindow = chatSlot?.contextWindow ?? params.config.defaultContextWindow;
    const thresholdPct = params.config.compactionThresholdPct ?? 70;
    const tokenBudget = Math.floor(contextWindow * (thresholdPct / 100));

    const systemTokens = countTokens(params.systemPrompt) + countTokens(params.memoriesBlock);
    const messageTokens = countMessageTokens(entriesToMessages(recent, channelVisibility, false));
    const totalTokens = systemTokens + messageTokens;

    if (totalTokens > tokenBudget) {
      // Compact oldest 50% of messages
      const splitPoint = Math.ceil(recent.length / 2);
      const toCompact = recent.slice(0, splitPoint);
      const toKeep = recent.slice(splitPoint);
      const compactText = buildCompactionSourceBlock(toCompact);
      const sourceHashTag = buildCompactionSourceHashTag(toCompact);
      const emotionalSalienceThreshold = resolveEmotionalSalienceThreshold(params.config);
      const preservedTagBlock = buildCompactionPreservedTagBlock(
        toCompact,
        emotionalSalienceThreshold,
      );

      log.info('Auto-compacting session', { channelId: params.channelId, totalTokens, budget: tokenBudget });
      await params.eventBus?.emit('agent.compaction.start', {
        channelId: params.channelId,
        reason: 'threshold',
        tokensBefore: totalTokens,
        tokenBudget,
      });

      if (toCompact.length > 0 && params.preCompactionExtractionHandler) {
        try {
          await params.preCompactionExtractionHandler({
            channelId: params.channelId,
            entries: [...toCompact],
            canonicalContactId: params.userId,
          });
        } catch (error) {
          log.warn('Pre-compaction extraction flush failed', {
            channelId: params.channelId,
            error: toErrorMessage(error),
          });
        }
      }

      let tokensAfter = totalTokens;
      let sawRetry = false;
      let lastRetryAttempt = 1;
      const retryMaxRetries = 2;
      const retryMaxAttempts = retryMaxRetries + 1;
      try {
        const compactionPrompt = params.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
          ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
        const runtimeCompactionPrompt = injectPromptRuntimeTokens(compactionPrompt);
        const summaryResponse = await withRetry(
          () => params.llmProvider!.complete(
            {
              systemPrompt: runtimeCompactionPrompt,
              messages: [{ role: 'user', content: compactText }],
            },
            'background',
          ),
          { maxRetries: retryMaxRetries, baseDelayMs: 250 },
          {
            onRetry: async ({ attempt, delayMs, error }) => {
              sawRetry = true;
              lastRetryAttempt = attempt + 1;
              await params.eventBus?.emit('agent.retry.start', {
                channelId: params.channelId,
                attempt: lastRetryAttempt,
                maxAttempts: retryMaxAttempts,
                delayMs,
                error: error.message,
              });
            },
          },
        );

        // Store compaction summary
        const compactionSummary = appendCompactionMetadataBlocks(summaryResponse.content, [
          sourceHashTag,
          preservedTagBlock,
        ]);
        const coveredUpTo = toCompact[toCompact.length - 1].id;
        params.store.insertCompaction(params.channelId, compactionSummary, coveredUpTo);
        const keepTokens = countMessageTokens(entriesToMessages(toKeep, channelVisibility, false));
        const summaryTokens = countTokens(compactionSummary);
        tokensAfter = systemTokens + keepTokens + summaryTokens;

        // Use only the kept (recent) messages going forward
        recent = toKeep;
        if (sawRetry) {
          await params.eventBus?.emit('agent.retry.end', {
            channelId: params.channelId,
            success: true,
            attempt: lastRetryAttempt,
          });
        }
        await params.eventBus?.emit('session.compacted', {
          channelId: params.channelId,
          before: totalTokens,
          after: tokensAfter,
        });
        log.info('Compaction complete', { compacted: toCompact.length, kept: toKeep.length });
      } catch (err) {
        if (sawRetry) {
          await params.eventBus?.emit('agent.retry.end', {
            channelId: params.channelId,
            success: false,
            attempt: lastRetryAttempt,
          });
        }
        log.error('Auto-compaction failed, using full context', { error: String(err) });
      } finally {
        await params.eventBus?.emit('agent.compaction.end', {
          channelId: params.channelId,
          tokensBefore: totalTokens,
          tokensAfter,
        });
      }
    }
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
