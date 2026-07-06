import type { LLMProviderPort } from '../../agent/contracts.js';
import { countMessageTokens, countTokens } from '../../../primitives/llm/tokens.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { EventBus } from '../../../shared/event-bus.js';
import {
  COMPACTION_SUMMARY_PROMPT_KEY,
  RECENT_SESSION_SUMMARY_PROMPT_KEY,
  getDefaultPromptText,
  type PromptRegistryKey,
} from '../../identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import type { PromptRegistryStatePort } from '../../identity/prompt-state-port.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  buildCompactionSourceBlock,
  buildCompactionSourceHashTag,
} from '../compaction-audit.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionEntry } from '../types.js';
import {
  appendCompactionMetadataBlocks,
  buildRecentSessionSummaryFallbackText,
  buildSessionSummarySourceBlock,
  buildCompactionPreservedTagBlock,
  resolveEmotionalSalienceThreshold,
  withRetry,
} from '../manager-primitives.js';
import type { PreCompactionExtractionHandler } from './contracts.js';
import { entriesToMessages } from './context-support.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';

const log = createComponentLogger('CompactionService');

export interface CompactionParams {
  channelId: string;
  recent: SessionEntry[];
  channelVisibility: ChannelPrivacy;
  systemTokens: number;
  compactionPromptText?: string;
  llmProvider: LLMProviderPort;
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
  userId?: string;
}

export interface CompactionResult {
  /** The entries remaining after compaction (or the original entries if compaction was not triggered). */
  recent: SessionEntry[];
  /** Whether compaction was executed. */
  compacted: boolean;
  /** The summary text appended during this compaction run, when compaction succeeds. */
  compactionSummaryText?: string;
}

export type RecentSessionSummaryPurpose =
  | 'history_budget'
  | 'wake_session'
  | 'wake_continuity'
  | 'free_time_return';

export interface RecentSessionSummaryParams {
  channelId: string;
  entries: readonly SessionEntry[];
  characterName?: string;
  llmProvider?: LLMProviderPort;
  promptRegistry: PromptRegistryStatePort | null;
  maxTokens: number;
  purpose: RecentSessionSummaryPurpose;
}

export interface SessionSummaryCompletionParams {
  channelId: string;
  sourceText: string;
  llmProvider: LLMProviderPort;
  promptRegistry: PromptRegistryStatePort | null;
  promptKey: PromptRegistryKey;
  promptText?: string;
  requestIdBase: string;
  correlationPurpose: string;
  originStage: string;
  maxRetries: number;
  baseDelayMs: number;
  onRetry?: (params: { attempt: number; delayMs: number; error: Error }) => Promise<void> | void;
}

function stripGeneratedSummaryToolResultLines(content: string): string {
  const lines = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  const filtered = lines.filter(line => !/^(?:[-*]\s*)?(?:\[Tool result:|Tool reported:)/iu.test(line));
  return filtered.join(' ');
}

export function normalizeGeneratedRecentSummaryText(content: string, maxTokens: number): string {
  const withoutHeader = stripGeneratedSummaryToolResultLines(content)
    .replace(/^\[History summary\]\s*/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutHeader || maxTokens <= 0) return '';
  if (countTokens(withoutHeader) <= maxTokens) return withoutHeader;

  let maxChars = Math.max(80, Math.floor(withoutHeader.length * 0.8));
  while (maxChars >= 80) {
    const candidate = `${withoutHeader.slice(0, maxChars).trimEnd()}...`;
    if (countTokens(candidate) <= maxTokens) {
      return candidate;
    }
    maxChars = Math.floor(maxChars * 0.8);
  }
  return '';
}

/**
 * Shared session-summary completion primitive. Owns PromptRegistry lookup,
 * runtime-token injection, retry behavior, request correlation, and
 * callType/originStage metadata for every session-summary LLM call
 * (compaction, recent-session, and session-search summaries).
 *
 * callType convention: the positional `complete` callType is 'background'
 * while the correlation metadata carries callType 'summary'.
 */
export async function completeSessionSummary(params: SessionSummaryCompletionParams): Promise<string> {
  const summaryPrompt = params.promptText
    ?? params.promptRegistry?.getPrompt(params.promptKey)
    ?? getDefaultPromptText(params.promptKey);
  const runtimeSummaryPrompt = injectPromptRuntimeTokens(summaryPrompt);
  const requestContext = getRequestContext();
  const summaryResponse = await withRetry(
    () => params.llmProvider.complete(
      {
        systemPrompt: runtimeSummaryPrompt,
        messages: [{ role: 'user', content: params.sourceText }],
        correlation: {
          ...(requestContext?.turnId ? { turnId: requestContext.turnId } : {}),
          requestId: `${params.requestIdBase}:summary`,
          channelId: params.channelId,
          callType: 'summary',
          purpose: params.correlationPurpose,
          originType: 'summary',
          originStage: params.originStage,
          ...(requestContext?.toolName ? { toolName: requestContext.toolName } : {}),
          ...(requestContext?.toolCallId ? { toolCallId: requestContext.toolCallId } : {}),
        },
      },
      'background',
    ),
    { maxRetries: params.maxRetries, baseDelayMs: params.baseDelayMs },
    params.onRetry ? { onRetry: params.onRetry } : undefined,
  );
  return summaryResponse.content;
}

export async function summarizeRecentSessionEntries(params: RecentSessionSummaryParams): Promise<string> {
  const sourceText = buildSessionSummarySourceBlock({
    entries: params.entries,
    characterName: params.characterName,
  });
  if (!sourceText) return '';

  if (!params.llmProvider) {
    return buildRecentSessionSummaryFallbackText({
      entries: params.entries,
      characterName: params.characterName,
      maxTokens: params.maxTokens,
    }).replace(/^\[History summary\]\s*/iu, '').trim();
  }

  const requestContext = getRequestContext();
  const requestIdBase = requestContext?.requestId
    ? `${requestContext.requestId}:recent-summary:${params.purpose}`
    : `recent-summary:${params.channelId}:${params.purpose}:${Date.now()}`;
  try {
    const summary = await completeSessionSummary({
      channelId: params.channelId,
      sourceText,
      llmProvider: params.llmProvider,
      promptRegistry: params.promptRegistry,
      promptKey: RECENT_SESSION_SUMMARY_PROMPT_KEY,
      requestIdBase,
      correlationPurpose: 'session.recent.summary',
      originStage: `session.recent.summary.${params.purpose}`,
      maxRetries: 1,
      baseDelayMs: 150,
    });
    return normalizeGeneratedRecentSummaryText(summary, params.maxTokens);
  } catch (error) {
    log.warn('Recent session summary failed', {
      channelId: params.channelId,
      purpose: params.purpose,
      error: toErrorMessage(error),
    });
    return '';
  }
}

/**
 * Evaluate whether auto-compaction should trigger based on current token usage
 * relative to the configured compaction threshold.
 */
export function shouldCompact(params: {
  recent: SessionEntry[];
  channelVisibility: ChannelPrivacy;
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
    const summaryContent = await completeSessionSummary({
      channelId: params.channelId,
      sourceText: compactText,
      llmProvider: params.llmProvider,
      promptRegistry: params.promptRegistry,
      promptKey: COMPACTION_SUMMARY_PROMPT_KEY,
      promptText: params.compactionPromptText,
      requestIdBase: compactionRequestIdBase,
      correlationPurpose: 'session.compaction.summary',
      originStage: 'session.compaction.summary',
      maxRetries: retryMaxRetries,
      baseDelayMs: 250,
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
    });

    // Store compaction summary
    const compactionSummary = appendCompactionMetadataBlocks(summaryContent, [
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
    if (params.onCompactionComplete) {
      const capturedAt = Date.now();
      try {
        params.onCompactionComplete({
          channelId: params.channelId,
          originalContext: compactText,
          compressedContext: compactionSummary,
          capturedAt,
        });
      } catch (error) {
        log.warn('Compaction completion hook failed', {
          channelId: params.channelId,
          error: toErrorMessage(error),
        });
      }
    }
    log.info('Compaction complete', { compacted: toCompact.length, kept: toKeep.length });

    return { recent: toKeep, compacted: true, compactionSummaryText: compactionSummary };
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
