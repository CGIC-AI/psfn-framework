import type { ContextMessage, LLMContext, SubstrateConfig } from '../types.js';
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
import { countMessageTokens, countTokens } from '../llm/tokens.js';
import { createComponentLogger } from '../logger.js';
import {
  classifyChannel,
  evaluateMemoryPolicy,
  visibilitiesShareContinuity,
  type ChannelMeta,
} from '../trust/policy.js';
import type { ChannelVisibility, TrustLevel } from '../trust/types.js';
import type { PromptRegistryStore } from '../identity/prompt-registry.js';
import { COMPACTION_SUMMARY_PROMPT_KEY, getDefaultPromptText } from '../identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../identity/prompt-runtime.js';
import {
  resolveSessionHistoryBudget,
} from '../context-budget.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  buildCompactionSourceBlock,
  buildCompactionSourceHashTag,
} from './compaction-audit.js';
import {
  DEFAULT_CONTINUITY_CONTEXT_LIMIT,
  DEFAULT_SESSION_MIRROR_ACTIVE_WINDOW_MS,
  DEFAULT_SESSION_MIRROR_MAX_CHARS,
  appendCompactionMetadataBlocks,
  buildCompactionPreservedTagBlock,
  isUntrustedVisibility,
  normalizeImportBootstrapMaxTokens,
  normalizeMirrorText,
  parseChannelVisibility,
  parseMirrorMetadata,
  resolveEmotionalSalienceThreshold,
  trimRecentEntriesToTokenBudget,
  visibilityToMirrorSensitivity,
  withRetry,
  wrapUntrustedContext,
  type MirrorEntryMetadata,
  type SessionMessageRecordOptions,
} from './manager-primitives.js';

const log = createComponentLogger('SessionManager');

export interface PreCompactionExtractionContext {
  channelId: string;
  entries: SessionEntry[];
  canonicalContactId?: string;
}

export type PreCompactionExtractionHandler = (
  context: PreCompactionExtractionContext,
) => Promise<void>;

export interface ImportedHistoryBootstrapChunk {
  startId: number;
  endId: number;
  entryCount: number;
  approxTokens: number;
}

export interface ImportedHistoryBootstrapResult {
  channelId: string;
  totalEntries: number;
  maxChunkTokens: number;
  chunkCount: number;
  processedChunks: number;
  chunks: ImportedHistoryBootstrapChunk[];
}

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

    // Also append to user continuity store (with origin metadata)
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

    // Also append to user continuity store (with origin metadata)
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
    sourceVisibility: ChannelVisibility;
    sourceRole: 'user' | 'assistant';
    sourceAuthorName?: string;
    content: string;
    trustLevel: TrustLevel;
    timestamp: number;
    mirrorEnabled: boolean;
  }): void {
    if (!params.mirrorEnabled) return;
    if (!this.continuityStore || !params.continuityKey) return;
    if (!this.isSessionMirroringEnabledForChannel(params.sourceChannelId)) return;
    if (!this.isSessionMirroringGloballyEnabled()) return;

    const maxChars = Math.max(32, this.config.sessionMirrorMaxChars ?? DEFAULT_SESSION_MIRROR_MAX_CHARS);
    const normalized = normalizeMirrorText(params.content, maxChars);
    if (!normalized.text) return;

    const activeWindowMs = Math.max(
      1_000,
      this.config.sessionMirrorActiveWindowMs ?? DEFAULT_SESSION_MIRROR_ACTIVE_WINDOW_MS,
    );
    const targets = this.continuityStore.getActiveChannels(params.continuityKey, {
      excludeChannelId: params.sourceChannelId,
      withinMs: activeWindowMs,
      nowMs: params.timestamp,
    });
    if (targets.length === 0) return;

    const sourceSensitivity = visibilityToMirrorSensitivity(params.sourceVisibility);
    const sourceSpeaker = params.sourceRole === 'assistant'
      ? 'Purrsephone'
      : (params.sourceAuthorName ?? 'User');

    for (const target of targets) {
      if (!this.isSessionMirroringEnabledForChannel(target.channelId)) continue;
      if (!visibilitiesShareContinuity(params.sourceVisibility, target.channelVisibility)) continue;

      const policy = evaluateMemoryPolicy({
        trustLevel: params.trustLevel,
        channelVisibility: target.channelVisibility,
        memorySensitivity: sourceSensitivity,
      });
      if (policy.decision !== 'allow') continue;

      const mirrorMetadata: MirrorEntryMetadata = {
        type: 'mirror',
        sourceChannelId: params.sourceChannelId,
        sourceRole: params.sourceRole,
        sourceAuthorName: params.sourceRole === 'user' ? sourceSpeaker : undefined,
        sourceVisibility: params.sourceVisibility,
        trustLevel: params.trustLevel,
        mirroredAt: params.timestamp,
        truncated: normalized.truncated,
      };

      this.store.append({
        channelId: target.channelId,
        role: 'system',
        content: `${sourceSpeaker} [from ${params.sourceChannelId}]: ${normalized.text}`,
        authorId: 'session-mirror',
        authorName: 'Session Mirror',
        timestamp: params.timestamp,
        metadata: JSON.stringify(mirrorMetadata),
        originChannelId: params.sourceChannelId,
        channelVisibility: target.channelVisibility,
      });
    }
  }

  private isSessionMirroringGloballyEnabled(): boolean {
    return this.config.sessionMirrorEnabled !== false;
  }

  private isSessionMirroringEnabledForChannel(channelId: string): boolean {
    const overrides = this.config.sessionMirrorChannelOverrides;
    if (!overrides) return true;

    const exact = overrides[channelId];
    if (typeof exact === 'boolean') return exact;

    const separatorIdx = channelId.indexOf(':');
    if (separatorIdx > 0) {
      const prefix = channelId.slice(0, separatorIdx);
      const prefixMatch = overrides[prefix];
      if (typeof prefixMatch === 'boolean') return prefixMatch;
    } else if (/^\d{6,}$/.test(channelId)) {
      const discordMatch = overrides.discord;
      if (typeof discordMatch === 'boolean') return discordMatch;
    }

    for (const [pattern, value] of Object.entries(overrides)) {
      if (!pattern.endsWith('*')) continue;
      const candidatePrefix = pattern.slice(0, -1);
      if (candidatePrefix.length === 0) continue;
      if (channelId.startsWith(candidatePrefix)) return value;
    }

    return true;
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
    const channelVisibility = classifyChannel(channelId, channelMeta);
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

      const systemTokens = countTokens(systemPrompt) + countTokens(memoriesBlock);
      const messageTokens = countMessageTokens(this.entriesToMessages(recent, channelVisibility, false));
      const totalTokens = systemTokens + messageTokens;

      if (totalTokens > tokenBudget) {
        // Compact oldest 50% of messages
        const splitPoint = Math.ceil(recent.length / 2);
        const toCompact = recent.slice(0, splitPoint);
        const toKeep = recent.slice(splitPoint);
        const compactText = buildCompactionSourceBlock(toCompact);
        const sourceHashTag = buildCompactionSourceHashTag(toCompact);
        const emotionalSalienceThreshold = resolveEmotionalSalienceThreshold(this.config);
        const preservedTagBlock = buildCompactionPreservedTagBlock(
          toCompact,
          emotionalSalienceThreshold,
        );

        log.info('Auto-compacting session', { channelId, totalTokens, budget: tokenBudget });
        await this.eventBus?.emit('agent.compaction.start', {
          channelId,
          reason: 'threshold',
          tokensBefore: totalTokens,
          tokenBudget,
        });

        if (toCompact.length > 0 && this.preCompactionExtractionHandler) {
          try {
            await this.preCompactionExtractionHandler({
              channelId,
              entries: [...toCompact],
              canonicalContactId: userId,
            });
          } catch (error) {
            log.warn('Pre-compaction extraction flush failed', {
              channelId,
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
          const compactionPrompt = this.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
            ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
          const runtimeCompactionPrompt = injectPromptRuntimeTokens(compactionPrompt);
          const summaryResponse = await withRetry(
            () => llmProvider.complete(
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
          const compactionSummary = appendCompactionMetadataBlocks(summaryResponse.content, [
            sourceHashTag,
            preservedTagBlock,
          ]);
          const coveredUpTo = toCompact[toCompact.length - 1].id;
          this.store.insertCompaction(channelId, compactionSummary, coveredUpTo);
          const keepTokens = countMessageTokens(this.entriesToMessages(toKeep, channelVisibility, false));
          const summaryTokens = countTokens(compactionSummary);
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
      const continuityLimit = this.config.continuityMessageLimit ?? DEFAULT_CONTINUITY_CONTEXT_LIMIT;
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
            const speaker = e.role === 'user' ? (e.authorName ?? 'User') : 'Purrsephone';
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
    const messages = this.entriesToMessages(recent, channelVisibility);

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
    const maxChunkTokens = normalizeImportBootstrapMaxTokens(params.maxChunkTokens);
    const importedEntries = this.collectImportedEntries(params.channelId, params.entryRanges);
    if (importedEntries.length === 0) {
      return {
        channelId: params.channelId,
        totalEntries: 0,
        maxChunkTokens,
        chunkCount: 0,
        processedChunks: 0,
        chunks: [],
      };
    }

    const chunkPlans = this.chunkImportedEntries(importedEntries, maxChunkTokens);
    let processedChunks = 0;
    for (const chunk of chunkPlans) {
      if (!this.preCompactionExtractionHandler) break;
      await this.preCompactionExtractionHandler({
        channelId: params.channelId,
        entries: [...chunk.entries],
        canonicalContactId: params.canonicalContactId,
      });
      processedChunks += 1;
    }

    return {
      channelId: params.channelId,
      totalEntries: importedEntries.length,
      maxChunkTokens,
      chunkCount: chunkPlans.length,
      processedChunks,
      chunks: chunkPlans.map(chunk => ({
        startId: chunk.entries[0].id,
        endId: chunk.entries[chunk.entries.length - 1].id,
        entryCount: chunk.entries.length,
        approxTokens: chunk.tokens,
      })),
    };
  }

  private collectImportedEntries(
    channelId: string,
    entryRanges: LegacyChatImportRange[],
  ): SessionEntry[] {
    if (entryRanges.length === 0) return [];

    const deduped = new Map<number, SessionEntry>();
    for (const range of entryRanges) {
      const entries = this.store.getEntriesInRange(
        channelId,
        range.firstEntryId,
        range.lastEntryId,
      );
      for (const entry of entries) {
        deduped.set(entry.id, entry);
      }
    }

    return [...deduped.values()].sort((left, right) => left.id - right.id);
  }

  private chunkImportedEntries(
    entries: SessionEntry[],
    maxChunkTokens: number,
  ): Array<{ entries: SessionEntry[]; tokens: number }> {
    const chunks: Array<{ entries: SessionEntry[]; tokens: number }> = [];
    let currentEntries: SessionEntry[] = [];
    let currentTokens = 0;

    for (const entry of entries) {
      const entryTokens = Math.max(1, countTokens(entry.content));
      const shouldStartNewChunk = currentEntries.length > 0 && currentTokens + entryTokens > maxChunkTokens;
      if (shouldStartNewChunk) {
        chunks.push({
          entries: currentEntries,
          tokens: currentTokens,
        });
        currentEntries = [];
        currentTokens = 0;
      }

      currentEntries.push(entry);
      currentTokens += entryTokens;
    }

    if (currentEntries.length > 0) {
      chunks.push({
        entries: currentEntries,
        tokens: currentTokens,
      });
    }

    return chunks;
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

  private entriesToMessages(
    entries: SessionEntry[],
    defaultVisibility: ChannelVisibility,
    includeTrustTags: boolean = true,
  ): ContextMessage[] {
    const messages: ContextMessage[] = [];

    for (const entry of entries) {
      // System notes are included as user-role messages with a marker
      const role: 'user' | 'assistant' = entry.role === 'system' ? 'user' : entry.role as 'user' | 'assistant';
      let content = entry.content;
      if (entry.role === 'system') {
        const mirror = parseMirrorMetadata(entry.metadata);
        if (mirror) {
          content = `[Mirror note from ${mirror.sourceChannelId}] ${entry.content}`;
        } else {
          content = `[System note] ${entry.content}`;
        }
      }
      if (includeTrustTags) {
        const visibility = parseChannelVisibility(entry.channelVisibility) ?? defaultVisibility;
        if (isUntrustedVisibility(visibility)) {
          content = wrapUntrustedContext(content);
        }
      }

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
