import type { ContextMessage, LLMContext, SubstrateConfig } from '../types.js';
import type { LLMProvider } from '../agent-loop.js';
import type { SessionStore } from './store.js';
import type { UserContinuityStore } from './continuity.js';
import type { SessionEntry } from './types.js';
import { estimateTokens } from '../llm/tokens.js';
import { createComponentLogger } from '../logger.js';
import { classifyChannel, type ChannelMeta } from '../trust/policy.js';

const log = createComponentLogger('SessionManager');

/** Default number of cross-channel continuity messages to include in context. */
const DEFAULT_CONTINUITY_CONTEXT_LIMIT = 10;

export class SessionManager {
  private store: SessionStore;
  private config: SubstrateConfig;
  continuityStore: UserContinuityStore | null = null;

  constructor(store: SessionStore, config: SubstrateConfig) {
    this.store = store;
    this.config = config;
  }

  recordUserMessage(
    channelId: string,
    content: string,
    authorId: string,
    authorName: string,
    isDirectMessage?: boolean,
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
    if (this.continuityStore && authorId) {
      const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
      this.continuityStore.append(authorId, {
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

  recordAssistantMessage(channelId: string, content: string, forUserId?: string, isDirectMessage?: boolean): void {
    this.store.append({
      channelId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });

    // Also append to user continuity store (with origin metadata)
    if (this.continuityStore && forUserId) {
      const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
      this.continuityStore.append(forUserId, {
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
  ): Promise<LLMContext> {
    let recent = this.store.getRecent(channelId, this.config.sessionMessageLimit);

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

        // Compact oldest 50% of messages
        const splitPoint = Math.ceil(recent.length / 2);
        const toCompact = recent.slice(0, splitPoint);
        const toKeep = recent.slice(splitPoint);

        const compactText = toCompact
          .map(e => `${e.authorName ?? e.role}: ${e.content}`)
          .join('\n');

        try {
          const summaryResponse = await llmProvider.complete(
            {
              systemPrompt: 'Summarize this conversation excerpt concisely, preserving key facts and context.',
              messages: [{ role: 'user', content: compactText }],
            },
            'summary',
          );

          // Store compaction summary
          const coveredUpTo = toCompact[toCompact.length - 1].id;
          this.store.insertCompaction(channelId, summaryResponse.content, coveredUpTo);

          // Use only the kept (recent) messages going forward
          recent = toKeep;
          log.info('Compaction complete', { compacted: toCompact.length, kept: toKeep.length });
        } catch (err) {
          log.error('Auto-compaction failed, using full context', { error: String(err) });
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
      const crossChannel = this.continuityStore.getRecent(
        userId,
        continuityLimit,
        channelId,
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
    return this.store.getRecent(channelId, limit ?? this.config.sessionMessageLimit);
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
