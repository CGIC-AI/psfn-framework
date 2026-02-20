import type { ContextMessage, LLMContext, SubstrateConfig } from '../types.js';
import type { LLMProvider } from '../agent-loop.js';
import type { SessionStore } from './store.js';
import type { UserContinuityStore } from './continuity.js';
import type { SessionEntry } from './types.js';
import type { EventBus } from '../event-bus.js';
import { estimateTokens } from '../llm/tokens.js';
import { createComponentLogger } from '../logger.js';
import { classifyChannel, type ChannelMeta } from '../trust/policy.js';
import type { PromptRegistryStore } from '../identity/prompt-registry.js';
import { COMPACTION_SUMMARY_PROMPT_KEY, getDefaultPromptText } from '../identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../identity/prompt-runtime.js';
import {
  resolveSessionHistoryBudget,
  SESSION_HISTORY_MIN_MESSAGES,
} from '../context-budget.js';

const log = createComponentLogger('SessionManager');

/** Default number of cross-channel continuity messages to include in context. */
const DEFAULT_CONTINUITY_CONTEXT_LIMIT = 10;

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

interface RetryCallbacks {
  onRetry?: (params: { attempt: number; delayMs: number; error: Error }) => Promise<void> | void;
}

async function withRetry<T>(
  task: () => Promise<T>,
  config: RetryConfig,
  callbacks?: RetryCallbacks,
): Promise<T> {
  const maxRetries = Math.max(0, config.maxRetries);
  const baseDelayMs = Math.max(0, config.baseDelayMs);

  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= maxRetries) throw error;

      const err = error instanceof Error ? error : new Error(String(error));
      const retryAttempt = attempt + 1;
      const delayMs = baseDelayMs * (2 ** attempt);
      await callbacks?.onRetry?.({
        attempt: retryAttempt,
        delayMs,
        error: err,
      });

      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
}

function trimRecentEntriesToTokenBudget(entries: SessionEntry[], tokenBudget: number): SessionEntry[] {
  if (entries.length === 0) return [];
  if (tokenBudget <= 0) {
    return entries.slice(-SESSION_HISTORY_MIN_MESSAGES);
  }

  let usedTokens = 0;
  const selected: SessionEntry[] = [];

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const entryTokens = Math.max(1, estimateTokens(entry.content));
    if (selected.length >= SESSION_HISTORY_MIN_MESSAGES && usedTokens + entryTokens > tokenBudget) {
      break;
    }
    selected.push(entry);
    usedTokens += entryTokens;
  }

  return selected.reverse();
}

export class SessionManager {
  private store: SessionStore;
  private config: SubstrateConfig;
  private eventBus: EventBus | null;
  private promptRegistry: PromptRegistryStore | null;
  continuityStore: UserContinuityStore | null = null;

  constructor(
    store: SessionStore,
    config: SubstrateConfig,
    eventBus?: EventBus,
    promptRegistry?: PromptRegistryStore | null,
  ) {
    this.store = store;
    this.config = config;
    this.eventBus = eventBus ?? null;
    this.promptRegistry = promptRegistry ?? null;
  }

  recordUserMessage(
    channelId: string,
    content: string,
    authorId: string,
    authorName: string,
    isDirectMessage?: boolean,
    continuityUserId?: string,
  ): void {
    this.store.append({
      channelId,
      role: 'user',
      content,
      authorId,
      authorName,
      timestamp: Date.now(),
    });

    // Also append to user continuity store (with origin metadata)
    const continuityKey = continuityUserId ?? authorId;
    if (this.continuityStore && continuityKey) {
      const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
      this.continuityStore.append(continuityKey, {
        channelId,
        role: 'user',
        content,
        authorId,
        authorName,
        timestamp: Date.now(),
        originChannelId: channelId,
        channelVisibility: classifyChannel(channelId, meta),
      });
    }
  }

  recordAssistantMessage(
    channelId: string,
    content: string,
    forUserId?: string,
    isDirectMessage?: boolean,
    continuityUserId?: string,
  ): void {
    this.store.append({
      channelId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });

    // Also append to user continuity store (with origin metadata)
    const continuityKey = continuityUserId ?? forUserId;
    if (this.continuityStore && continuityKey) {
      const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
      this.continuityStore.append(continuityKey, {
        channelId,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        originChannelId: channelId,
        channelVisibility: classifyChannel(channelId, meta),
      });
    }
  }

  async buildContext(
    channelId: string,
    systemPrompt: string,
    memoriesBlock: string,
    llmProvider?: LLMProvider,
    userId?: string,
    channelMeta?: ChannelMeta,
    continuityFallbackUserIds: string[] = [],
  ): Promise<LLMContext> {
    const historyBudget = resolveSessionHistoryBudget(this.config);
    let recent = this.store.getRecent(channelId, historyBudget.estimatedCount);
    if (historyBudget.mode === 'budget') {
      recent = trimRecentEntriesToTokenBudget(recent, historyBudget.tokenBudget);
    }

    // Auto-compaction: when total context tokens exceed threshold, compact oldest half
    if (llmProvider && recent.length > 4) {
      const chatSlot = this.config.modelRoster.chat;
      const contextWindow = chatSlot?.contextWindow ?? this.config.defaultContextWindow;
      const thresholdPct = this.config.compactionThresholdPct ?? 70;
      const tokenBudget = Math.floor(contextWindow * (thresholdPct / 100));

      const systemTokens = estimateTokens(systemPrompt) + estimateTokens(memoriesBlock);
      const messageTokens = recent.reduce((sum, e) => sum + estimateTokens(e.content), 0);
      const totalTokens = systemTokens + messageTokens;

      if (totalTokens > tokenBudget) {
        log.info('Auto-compacting session', { channelId, totalTokens, budget: tokenBudget });
        await this.eventBus?.emit('agent.compaction.start', {
          channelId,
          reason: 'threshold',
          tokensBefore: totalTokens,
          tokenBudget,
        });

        // Compact oldest 50% of messages
        const splitPoint = Math.ceil(recent.length / 2);
        const toCompact = recent.slice(0, splitPoint);
        const toKeep = recent.slice(splitPoint);

        const compactText = toCompact
          .map(e => `${e.authorName ?? e.role}: ${e.content}`)
          .join('\n');

        let tokensAfter = totalTokens;
        let sawRetry = false;
        let lastRetryAttempt = 1;
        const retryMaxRetries = 2;
        const retryMaxAttempts = retryMaxRetries + 1;
        try {
          const compactionPrompt = this.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
            ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
          const runtimeCompactionPrompt = injectPromptRuntimeTokens(compactionPrompt);
          const summaryResponse = await withRetry(
            () => llmProvider.complete(
              {
                systemPrompt: runtimeCompactionPrompt,
                messages: [{ role: 'user', content: compactText }],
              },
              'summary',
            ),
            { maxRetries: retryMaxRetries, baseDelayMs: 250 },
            {
              onRetry: async ({ attempt, delayMs, error }) => {
                sawRetry = true;
                lastRetryAttempt = attempt + 1;
                await this.eventBus?.emit('agent.retry.start', {
                  channelId,
                  attempt: lastRetryAttempt,
                  maxAttempts: retryMaxAttempts,
                  delayMs,
                  error: error.message,
                });
              },
            },
          );

          // Store compaction summary
          const coveredUpTo = toCompact[toCompact.length - 1].id;
          this.store.insertCompaction(channelId, summaryResponse.content, coveredUpTo);
          const keepTokens = toKeep.reduce((sum, e) => sum + estimateTokens(e.content), 0);
          const summaryTokens = estimateTokens(summaryResponse.content);
          tokensAfter = systemTokens + keepTokens + summaryTokens;

          // Use only the kept (recent) messages going forward
          recent = toKeep;
          if (sawRetry) {
            await this.eventBus?.emit('agent.retry.end', {
              channelId,
              success: true,
              attempt: lastRetryAttempt,
            });
          }
          await this.eventBus?.emit('session.compacted', {
            channelId,
            before: totalTokens,
            after: tokensAfter,
          });
          log.info('Compaction complete', { compacted: toCompact.length, kept: toKeep.length });
        } catch (err) {
          if (sawRetry) {
            await this.eventBus?.emit('agent.retry.end', {
              channelId,
              success: false,
              attempt: lastRetryAttempt,
            });
          }
          log.error('Auto-compaction failed, using full context', { error: String(err) });
        } finally {
          await this.eventBus?.emit('agent.compaction.end', {
            channelId,
            tokensBefore: totalTokens,
            tokensAfter,
          });
        }
      }
    }

    // Build system prompt with memories
    let fullSystem = systemPrompt;
    if (memoriesBlock) {
      fullSystem += '\n\n' + memoriesBlock;
    }

    // Prepend compaction summaries as context
    // Re-fetch summaries after potential compaction above
    const allSummaries = this.store.getCompactionSummaries(channelId);
    if (allSummaries.length > 0) {
      const summaryBlock = allSummaries
        .map(s => s.summary)
        .join('\n\n');
      fullSystem += '\n\n[Previous conversation summary]\n' + summaryBlock;
    }

    // Cross-channel continuity: include recent activity from other channels
    if (this.continuityStore && userId) {
      const continuityLimit = (this.config as any).continuityMessageLimit ?? DEFAULT_CONTINUITY_CONTEXT_LIMIT;
      const crossChannel = this.getMergedContinuity(
        userId,
        continuityLimit,
        continuityFallbackUserIds,
        channelId,
        channelMeta,
      );
      if (crossChannel.length > 0) {
        const continuityBlock = crossChannel
          .map(e => {
            const origin = e.originChannelId ? ` [from ${e.originChannelId}]` : '';
            const speaker = e.role === 'user' ? (e.authorName ?? 'User') : 'PSFN';
            return `${speaker}${origin}: ${e.content}`;
          })
          .join('\n');
        fullSystem += '\n\n[Recent activity from other channels]\n' + continuityBlock;
      }
    }

    // Convert session entries to LLM messages
    const messages = this.entriesToMessages(recent);

    return {
      systemPrompt: fullSystem,
      messages,
    };
  }

  private getMergedContinuity(
    canonicalUserId: string,
    limit: number,
    fallbackUserIds: string[],
    channelId: string,
    channelMeta?: ChannelMeta,
  ): SessionEntry[] {
    if (!this.continuityStore || !canonicalUserId) return [];

    const candidateUserIds = [
      canonicalUserId,
      ...fallbackUserIds.filter(id => id && id !== canonicalUserId),
    ];

    const merged: SessionEntry[] = [];
    const seen = new Set<string>();

    for (const candidateUserId of candidateUserIds) {
      const entries = this.continuityStore.getRecent(
        candidateUserId,
        limit,
        channelId,
        channelId,
        channelMeta,
      );

      for (const entry of entries) {
        const key = this.continuityEntryKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entry);
      }
    }

    merged.sort((a, b) => {
      const timestampDelta = a.timestamp - b.timestamp;
      if (timestampDelta !== 0) return timestampDelta;
      return a.id - b.id;
    });

    if (merged.length <= limit) return merged;
    return merged.slice(-limit);
  }

  private continuityEntryKey(entry: SessionEntry): string {
    return [
      String(entry.timestamp),
      String(entry.id),
      entry.role,
      entry.originChannelId ?? entry.channelId,
      entry.authorId ?? '',
      entry.content,
    ].join('|');
  }

  /** Append a system note to a session. Visible in subsequent context builds. */
  appendSystemNote(channelId: string, note: string): void {
    this.store.append({
      channelId,
      role: 'system',
      content: note,
      authorId: 'system',
      authorName: 'System',
      timestamp: Date.now(),
    });
  }

  getRecentMessages(channelId: string, limit?: number): SessionEntry[] {
    if (limit !== undefined) {
      return this.store.getRecent(channelId, limit);
    }

    const historyBudget = resolveSessionHistoryBudget(this.config);
    const recent = this.store.getRecent(channelId, historyBudget.estimatedCount);
    if (historyBudget.mode === 'hard_limit') {
      return recent;
    }
    return trimRecentEntriesToTokenBudget(recent, historyBudget.tokenBudget);
  }

  getMessageCount(channelId: string): number {
    return this.store.count(channelId);
  }

  private entriesToMessages(entries: SessionEntry[]): ContextMessage[] {
    const messages: ContextMessage[] = [];

    for (const entry of entries) {
      // System notes are included as user-role messages with a marker
      const role: 'user' | 'assistant' = entry.role === 'system' ? 'user' : entry.role as 'user' | 'assistant';
      const content = entry.role === 'system' ? `[System note] ${entry.content}` : entry.content;

      // Merge consecutive same-role messages
      const last = messages[messages.length - 1];
      if (last && last.role === role) {
        last.content += '\n' + content;
      } else {
        messages.push({ role, content });
      }
    }

    // Ensure conversation starts with user message (LLM API requirement)
    if (messages.length > 0 && messages[0].role !== 'user') {
      messages.shift();
    }

    return messages;
  }
}
