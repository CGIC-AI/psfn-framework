import type { LLMContext, SubstrateConfig } from '../types.js';
import type { LLMProvider } from '../agent/contracts.js';
import type {
  SessionStore,
  LegacyChatImportRequest,
  LegacyChatImportResult,
  LegacyChatImportRange,
} from './store.js';
import type { UserContinuityStore } from './continuity.js';
import type { SessionEntry } from './types.js';
import type { SessionSearchHit } from './search-index.js';
import type { EventBus } from '../event-bus.js';
import { classifyChannel, type ChannelMeta } from '../trust/policy.js';
import type { PromptRegistryStore } from '../identity/prompt-registry.js';
import { resolveSessionHistoryBudget } from '../context-budget.js';
import {
  trimRecentEntriesToTokenBudget,
  type SessionMessageRecordOptions,
} from './manager-primitives.js';
import {
  bootstrapImportedHistory,
  type ImportedHistoryBootstrapChunk,
  type ImportedHistoryBootstrapResult,
} from './manager/import-bootstrap.js';
import {
  mirrorMessageToActiveSessions,
} from './manager/mirroring.js';
import {
  buildSessionContext,
} from './manager/context-builder.js';
import type {
  PreCompactionExtractionContext,
  PreCompactionExtractionHandler,
} from './manager/contracts.js';

export type {
  ImportedHistoryBootstrapChunk,
  ImportedHistoryBootstrapResult,
  PreCompactionExtractionContext,
  PreCompactionExtractionHandler,
};

export interface LegacyChatImportRunRequest extends LegacyChatImportRequest {
  canonicalContactId?: string;
  bootstrap?: boolean;
  bootstrapMaxChunkTokens?: number;
}

export interface LegacyChatImportRunResult {
  importResult: LegacyChatImportResult;
  bootstrapResult: ImportedHistoryBootstrapResult | null;
}

export class SessionManager {
  private store: SessionStore;
  private config: SubstrateConfig;
  private eventBus: EventBus | null;
  private promptRegistry: PromptRegistryStore | null;
  private preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  continuityStore: UserContinuityStore | null = null;
  /** Character name from identity card (e.g. 'Purrsephone'). Used for display labels in context. */
  characterName: string | undefined;

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
    this.preCompactionExtractionHandler = null;
  }

  recordUserMessage(
    channelId: string,
    content: string,
    authorId: string,
    authorName: string,
    isDirectMessage?: boolean,
    continuityUserId?: string,
    options: SessionMessageRecordOptions = {},
  ): void {
    const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
    const channelVisibility = classifyChannel(channelId, meta);
    const timestamp = Date.now();
    this.store.append({
      channelId,
      role: 'user',
      content,
      authorId,
      authorName,
      timestamp,
      channelVisibility,
    });

    const continuityKey = continuityUserId ?? authorId;
    if (this.continuityStore && continuityKey) {
      this.continuityStore.append(continuityKey, {
        channelId,
        role: 'user',
        content,
        authorId,
        authorName,
        timestamp,
        originChannelId: channelId,
        channelVisibility,
      });
    }

    this.mirrorMessageToActiveSessions({
      continuityKey,
      sourceChannelId: channelId,
      sourceVisibility: channelVisibility,
      sourceRole: 'user',
      sourceAuthorName: authorName,
      content,
      trustLevel: options.trustLevel ?? 'regular',
      timestamp,
      mirrorEnabled: options.mirror !== false,
    });
  }

  recordAssistantMessage(
    channelId: string,
    content: string,
    forUserId?: string,
    isDirectMessage?: boolean,
    continuityUserId?: string,
    options: SessionMessageRecordOptions = {},
  ): void {
    const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
    const channelVisibility = classifyChannel(channelId, meta);
    const timestamp = Date.now();
    this.store.append({
      channelId,
      role: 'assistant',
      content,
      timestamp,
      channelVisibility,
    });

    const continuityKey = continuityUserId ?? forUserId;
    if (this.continuityStore && continuityKey) {
      this.continuityStore.append(continuityKey, {
        channelId,
        role: 'assistant',
        content,
        timestamp,
        originChannelId: channelId,
        channelVisibility,
      });
    }

    this.mirrorMessageToActiveSessions({
      continuityKey,
      sourceChannelId: channelId,
      sourceVisibility: channelVisibility,
      sourceRole: 'assistant',
      content,
      trustLevel: options.trustLevel ?? 'regular',
      timestamp,
      mirrorEnabled: options.mirror !== false,
    });
  }

  private mirrorMessageToActiveSessions(params: {
    continuityKey?: string;
    sourceChannelId: string;
    sourceVisibility: import('../trust/types.js').ChannelVisibility;
    sourceRole: 'user' | 'assistant';
    sourceAuthorName?: string;
    content: string;
    trustLevel: import('../trust/types.js').TrustLevel;
    timestamp: number;
    mirrorEnabled: boolean;
  }): void {
    mirrorMessageToActiveSessions({
      config: this.config,
      store: this.store,
      continuityStore: this.continuityStore,
      characterName: this.characterName,
      ...params,
    });
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
    return buildSessionContext({
      channelId,
      systemPrompt,
      memoriesBlock,
      llmProvider,
      userId,
      channelMeta,
      continuityFallbackUserIds,
      store: this.store,
      config: this.config,
      eventBus: this.eventBus,
      promptRegistry: this.promptRegistry,
      preCompactionExtractionHandler: this.preCompactionExtractionHandler,
      continuityStore: this.continuityStore,
      characterName: this.characterName,
    });
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

  setPreCompactionExtractionHandler(handler: PreCompactionExtractionHandler | null): void {
    this.preCompactionExtractionHandler = handler;
  }

  async importLegacyChatFromFile(request: LegacyChatImportRunRequest): Promise<LegacyChatImportRunResult> {
    const importResult = this.store.importLegacyChatFromFile(request);
    const shouldBootstrap = request.bootstrap !== false;
    if (!shouldBootstrap || importResult.manifest.importedRecordCount === 0) {
      return {
        importResult,
        bootstrapResult: null,
      };
    }

    const bootstrapResult = await this.bootstrapImportedHistory({
      channelId: request.channelId,
      entryRanges: importResult.manifest.entryRanges,
      canonicalContactId: request.canonicalContactId,
      maxChunkTokens: request.bootstrapMaxChunkTokens,
    });

    return {
      importResult,
      bootstrapResult,
    };
  }

  async bootstrapImportedHistory(params: {
    channelId: string;
    entryRanges: LegacyChatImportRange[];
    canonicalContactId?: string;
    maxChunkTokens?: number;
  }): Promise<ImportedHistoryBootstrapResult> {
    return bootstrapImportedHistory({
      store: this.store,
      channelId: params.channelId,
      entryRanges: params.entryRanges,
      canonicalContactId: params.canonicalContactId,
      maxChunkTokens: params.maxChunkTokens,
      preCompactionExtractionHandler: this.preCompactionExtractionHandler,
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

  searchTranscripts(query: string, limit?: number): SessionSearchHit[] {
    return this.store.searchByKeywords(query, limit);
  }
}
