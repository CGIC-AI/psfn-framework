import type { LLMProvider } from '../../agent/contracts.js';
import { countMessageTokens, countTokens } from '../../llm/tokens.js';
import { createComponentLogger } from '../../logger.js';
import type { SubstrateConfig } from '../../types.js';
import type { ChannelVisibility } from '../../trust/types.js';
import type { EventBus } from '../../event-bus.js';
import { COMPACTION_SUMMARY_PROMPT_KEY, getDefaultPromptText } from '../../identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import { toErrorMessage } from '../../utils/errors.js';
import {
  buildCompactionSourceBlock,
  buildCompactionSourceHashTag,
} from '../compaction-audit.js';
import type { SessionStore } from '../store.js';
import type { SessionEntry } from '../types.js';
import {
  appendCompactionMetadataBlocks,
  buildCompactionPreservedTagBlock,
  resolveEmotionalSalienceThreshold,
  withRetry,
} from '../manager-primitives.js';
import type { PreCompactionExtractionHandler } from './contracts.js';
import { entriesToMessages } from './context-support.js';
import { getRequestContext } from '../../llm/request-context.js';

const log = createComponentLogger('CompactionService');

export interface CompactionParams {
  channelId: string;
  recent: SessionEntry[];
  channelVisibility: ChannelVisibility;
  systemTokens: number;
  llmProvider: LLMProvider;
  store: SessionStore;
  config: SubstrateConfig;
  eventBus: EventBus | null;
  promptRegistry: PromptRegistryStore | null;
  preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  userId?: string;
}

export interface CompactionResult {
  /** The entries remaining after compaction (or the original entries if compaction was not triggered). */
  recent: SessionEntry[];
  /** Whether compaction was executed. */
  compacted: boolean;
}

/**
 * Evaluate whether auto-compaction should trigger based on current token usage
 * relative to the configured compaction threshold.
 */
export function shouldCompact(params: {
  recent: SessionEntry[];
  channelVisibility: ChannelVisibility;
  systemTokens: number;
  config: SubstrateConfig;
}): { trigger: boolean; tokenBudget: number; totalTokens: number } {
  if (params.recent.length <= 4) {
    return { trigger: false, tokenBudget: 0, totalTokens: 0 };
  }

  const chatSlot = params.config.modelRoster.chat;
  const contextWindow = chatSlot?.contextWindow ?? params.config.defaultContextWindow;
  const thresholdPct = params.config.compactionThresholdPct;
  const tokenBudget = Math.floor(contextWindow * (thresholdPct / 100));

  const messageTokens = countMessageTokens(
    entriesToMessages(params.recent, params.channelVisibility, false),
  );
  const totalTokens = params.systemTokens + messageTokens;

  return {
    trigger: totalTokens > tokenBudget,
    tokenBudget,
    totalTokens,
  };
}

/**
 * Execute auto-compaction: summarize the oldest half of session entries via LLM,
 * store the compaction summary, and return the kept (recent) entries.
 *
 * Emits compaction lifecycle events on the event bus and runs pre-compaction
 * extraction before generating the summary.
 */
export async function runAutoCompaction(params: CompactionParams): Promise<CompactionResult> {
  const check = shouldCompact({
    recent: params.recent,
    channelVisibility: params.channelVisibility,
    systemTokens: params.systemTokens,
    config: params.config,
  });

  if (!check.trigger) {
    return { recent: params.recent, compacted: false };
  }

  const { totalTokens, tokenBudget } = check;

  // Compact oldest 50% of messages
  const splitPoint = Math.ceil(params.recent.length / 2);
  const toCompact = params.recent.slice(0, splitPoint);
  const toKeep = params.recent.slice(splitPoint);
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
  let sawRetry = false as boolean;
  let lastRetryAttempt = 1;
  const retryMaxRetries = 2;
  const retryMaxAttempts = retryMaxRetries + 1;
  const requestContext = getRequestContext();
  const compactionRequestIdBase = requestContext?.requestId
    ? `${requestContext.requestId}:compaction`
    : `compaction:${params.channelId}:${Date.now()}`;
  try {
    const compactionPrompt = params.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
      ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
    const runtimeCompactionPrompt = injectPromptRuntimeTokens(compactionPrompt);
    const summaryResponse = await withRetry(
      () => params.llmProvider.complete(
        {
          systemPrompt: runtimeCompactionPrompt,
          messages: [{ role: 'user', content: compactText }],
          correlation: {
            ...(requestContext?.turnId ? { turnId: requestContext.turnId } : {}),
            requestId: `${compactionRequestIdBase}:summary`,
            channelId: params.channelId,
            callType: 'summary',
            purpose: 'session.compaction.summary',
            originType: 'summary',
            originStage: 'session.compaction.summary',
            ...(requestContext?.toolName ? { toolName: requestContext.toolName } : {}),
            ...(requestContext?.toolCallId ? { toolCallId: requestContext.toolCallId } : {}),
          },
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
    const keepTokens = countMessageTokens(
      entriesToMessages(toKeep, params.channelVisibility, false),
    );
    const summaryTokens = countTokens(compactionSummary);
    tokensAfter = params.systemTokens + keepTokens + summaryTokens;

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

    return { recent: toKeep, compacted: true };
  } catch (err) {
    if (sawRetry) {
      await params.eventBus?.emit('agent.retry.end', {
        channelId: params.channelId,
        success: false,
        attempt: lastRetryAttempt,
      });
    }
    log.error('Auto-compaction failed, using full context', { error: String(err) });
    return { recent: params.recent, compacted: false };
  } finally {
    await params.eventBus?.emit('agent.compaction.end', {
      channelId: params.channelId,
      tokensBefore: totalTokens,
      tokensAfter,
    });
  }
}
