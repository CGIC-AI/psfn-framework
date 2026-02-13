import type { ContextMessage, LLMContext, SubstrateConfig } from '../types.js';
import type { SessionStore } from './store.js';
import type { SessionEntry } from './types.js';

export class SessionManager {
  private store: SessionStore;
  private config: SubstrateConfig;

  constructor(store: SessionStore, config: SubstrateConfig) {
    this.store = store;
    this.config = config;
  }

  recordUserMessage(
    channelId: string,
    content: string,
    authorId: string,
    authorName: string,
  ): void {
    this.store.append({
      channelId,
      role: 'user',
      content,
      authorId,
      authorName,
      timestamp: Date.now(),
    });
  }

  recordAssistantMessage(channelId: string, content: string): void {
    this.store.append({
      channelId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  }

  buildContext(
    channelId: string,
    systemPrompt: string,
    memoriesBlock: string,
  ): LLMContext {
    const summaries = this.store.getCompactionSummaries(channelId);
    const recent = this.store.getRecent(channelId, this.config.sessionMessageLimit);

    // Build system prompt with memories
    let fullSystem = systemPrompt;
    if (memoriesBlock) {
      fullSystem += '\n\n' + memoriesBlock;
    }

    // Prepend compaction summaries as context
    if (summaries.length > 0) {
      const summaryBlock = summaries
        .map(s => s.summary)
        .join('\n\n');
      fullSystem += '\n\n[Previous conversation summary]\n' + summaryBlock;
    }

    // Convert session entries to LLM messages
    const messages = this.entriesToMessages(recent);

    return {
      systemPrompt: fullSystem,
      messages,
    };
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
      if (entry.role === 'system') continue;

      const role = entry.role as 'user' | 'assistant';

      // Merge consecutive same-role messages
      const last = messages[messages.length - 1];
      if (last && last.role === role) {
        last.content += '\n' + entry.content;
      } else {
        messages.push({ role, content: entry.content });
      }
    }

    // Ensure conversation starts with user message (LLM API requirement)
    if (messages.length > 0 && messages[0].role !== 'user') {
      messages.shift();
    }

    return messages;
  }
}
