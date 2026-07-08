import type { CapabilityTier, SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { MemoryProvider } from '../../core/agent/contracts.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import { evaluateCompositionalPolicyForChannelId } from '../../system/capabilities/compositional-policy.js';
import {
  evaluateShardSessionMemorySyncPolicy,
  type ShardSessionMemorySyncDecision,
  type ShardSessionMemorySyncEnvelope,
} from '../../boundary/gateway/policy.js';
import { appendShardSessionMemorySyncAudit } from '../../persistence/jsonl.js';
import type { MemoryScopeQuery } from '../memory/types.js';
import type {
  ShardConfig,
  ShardContextPack,
  ShardContextPackEntry,
  ShardSourceContext,
} from './types.js';

const CONTEXT_PACK_SESSION_SCAN_LIMIT = 12;
const CONTEXT_PACK_SESSION_ENTRY_LIMIT = 6;
const CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS = 600;
const CONTEXT_PACK_MEMORY_MAX_CHARS = 4_000;
export const SHARD_SYNC_POLICY_VERSION = 1;
export const SHARD_SYNC_MEMORY_TARGET = 'memory:index';

export interface ShardContextPackAuditTrail {
  append(event: string, details?: Record<string, unknown>): unknown;
}

export interface ShardContextPackHelperDeps {
  config: SubstrateConfig;
  parentSystemPrompt: string;
  sessionStore: SessionStore;
  sessionManager?: SessionManager | null;
  memoryProvider: MemoryProvider | null;
  auditTrail?: ShardContextPackAuditTrail | null;
  shardSessionMemorySyncAuditPath?: string;
  resolveCapabilityTier: () => CapabilityTier;
}

export class ShardContextPackHelper {
  constructor(private readonly deps: ShardContextPackHelperDeps) {}

  async buildContextPack(
    shardId: string,
    shardChannelId: string,
    shardConfig: ShardConfig,
    companionName: string,
  ): Promise<ShardContextPack | null> {
    const source = this.normalizeSourceContext(shardConfig.sourceContext);
    if (!source) {
      return null;
    }

    const policyDecision = evaluateCompositionalPolicyForChannelId({
      policy: this.deps.config.compositionalPolicy,
      capabilityTier: this.deps.resolveCapabilityTier(),
      channelId: source.channelId,
      purpose: 'shard_context',
    });
    if (!policyDecision.allowed) {
      return null;
    }

    const sessionSyncEnvelope: ShardSessionMemorySyncEnvelope = {
      version: SHARD_SYNC_POLICY_VERSION,
      syncClass: 'transcript_fact',
      direction: 'prime_to_shard',
      authority: 'prime',
      operation: 'context_pack_session',
      shardId,
      sourceId: source.channelId,
      targetId: shardChannelId,
      idempotencyKey: this.buildSyncIdempotencyKey([
        'context_pack_session',
        shardId,
        source.channelId,
        source.requestId,
        source.turnId,
      ]),
      requestedAt: Date.now(),
    };
    const sessionSyncDecision = this.evaluateSyncPolicy(sessionSyncEnvelope);
    const sessionEntries = sessionSyncDecision.allowed
      ? this.buildContextPackEntries(source)
      : [];

    const memorySyncEnvelope: ShardSessionMemorySyncEnvelope = {
      version: SHARD_SYNC_POLICY_VERSION,
      syncClass: 'derived_memory',
      direction: 'prime_to_shard',
      authority: 'prime',
      operation: 'context_pack_memory',
      shardId,
      sourceId: source.channelId,
      targetId: shardChannelId,
      idempotencyKey: this.buildSyncIdempotencyKey([
        'context_pack_memory',
        shardId,
        source.channelId,
        source.requestId,
        source.turnId,
        shardConfig.task,
      ]),
      requestedAt: Date.now(),
    };
    const memorySyncDecision = this.evaluateSyncPolicy(memorySyncEnvelope);
    const memoryBlock = memorySyncDecision.allowed
      ? await this.buildContextPackMemoryBlock(
        shardConfig.task,
        source.channelId,
        this.resolveContextPackMemoryScopeQuery(source.channelId),
      )
      : '';
    if (sessionEntries.length === 0 && memoryBlock.length === 0) {
      return null;
    }

    return {
      purpose: 'shard_context',
      task: shardConfig.task,
      source,
      companionName,
      sessionEntries,
      ...(memoryBlock ? { memoryBlock } : {}),
    };
  }

  withCompanionNameForContextPack(
    contextPack: ShardContextPack,
    companionName: string,
  ): ShardContextPack {
    const existingCompanionName = contextPack.companionName?.trim();
    return {
      ...contextPack,
      companionName: existingCompanionName || companionName,
    };
  }

  resolveSystemPrompt(shardConfig: ShardConfig): string {
    const basePrompt = shardConfig.systemPrompt ?? this.deps.parentSystemPrompt;
    if (!shardConfig.contextPack) {
      return basePrompt;
    }

    return [basePrompt, this.renderContextPack(shardConfig.contextPack)]
      .map(section => section.trim())
      .filter(section => section.length > 0)
      .join('\n\n');
  }

  evaluateSyncPolicy(
    envelope: ShardSessionMemorySyncEnvelope,
  ): ShardSessionMemorySyncDecision {
    const decision = evaluateShardSessionMemorySyncPolicy(envelope);
    this.recordSyncPolicyDecision(envelope, decision);
    return decision;
  }

  buildSyncIdempotencyKey(parts: Array<string | undefined>): string {
    const normalized = parts
      .map(part => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join('|');
    if (normalized.length === 0) {
      return `sync:${Date.now()}`;
    }
    if (normalized.length > 200) {
      return normalized.slice(0, 200);
    }
    return normalized;
  }

  private recordSyncPolicyDecision(
    envelope: ShardSessionMemorySyncEnvelope,
    decision: ShardSessionMemorySyncDecision,
  ): void {
    const policyEvent = {
      shardId: envelope.shardId,
      syncClass: envelope.syncClass,
      direction: envelope.direction,
      authority: envelope.authority,
      operation: envelope.operation,
      sourceId: envelope.sourceId,
      targetId: envelope.targetId,
      idempotencyKey: envelope.idempotencyKey,
      decision: decision.allowed ? 'ALLOW' : 'DENY',
      reason: decision.reason,
      requestedAt: envelope.requestedAt,
    } as const;
    this.deps.auditTrail?.append('shard.sync.policy', policyEvent);

    const path = this.deps.shardSessionMemorySyncAuditPath?.trim();
    if (!path) {
      return;
    }

    appendShardSessionMemorySyncAudit(path, {
      timestamp: Date.now(),
      shardId: envelope.shardId,
      syncClass: envelope.syncClass,
      direction: envelope.direction,
      authority: envelope.authority,
      operation: envelope.operation,
      sourceId: envelope.sourceId,
      targetId: envelope.targetId,
      idempotencyKey: envelope.idempotencyKey,
      decision: decision.allowed ? 'ALLOW' : 'DENY',
      reason: decision.reason,
    });
  }

  private normalizeSourceContext(
    sourceContext: ShardSourceContext | undefined,
  ): ShardSourceContext | null {
    const channelId = sourceContext?.channelId.trim();
    if (!channelId || !sourceContext) {
      return null;
    }

    const requestId = sourceContext.requestId?.trim();
    const turnId = sourceContext.turnId?.trim();
    const embodimentContext = sourceContext.embodimentContext;
    return {
      channelId,
      ...(requestId ? { requestId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(embodimentContext ? { embodimentContext } : {}),
    };
  }

  private buildContextPackEntries(source: ShardSourceContext): ShardContextPackEntry[] {
    const recentEntries = this.deps.sessionStore.getRecent(
      source.channelId,
      CONTEXT_PACK_SESSION_SCAN_LIMIT,
    );
    const focusedEntries = this.selectContextPackEntries(recentEntries, source);
    return focusedEntries.map(entry => ({
      role: entry.role,
      content: truncateShardContextText(entry.content, CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS),
      ...(entry.authorName ? { authorName: entry.authorName } : {}),
      timestamp: entry.timestamp,
    }));
  }

  private selectContextPackEntries(
    recentEntries: readonly SessionEntry[],
    source: ShardSourceContext,
  ): SessionEntry[] {
    if (recentEntries.length <= CONTEXT_PACK_SESSION_ENTRY_LIMIT) {
      return [...recentEntries];
    }

    const anchorIndex = this.findContextPackAnchorIndex(recentEntries, source);
    if (anchorIndex < 0) {
      return recentEntries.slice(-CONTEXT_PACK_SESSION_ENTRY_LIMIT);
    }

    const endExclusive = anchorIndex + 1;
    const start = Math.max(0, endExclusive - CONTEXT_PACK_SESSION_ENTRY_LIMIT);
    return recentEntries.slice(start, endExclusive);
  }

  private findContextPackAnchorIndex(
    recentEntries: readonly SessionEntry[],
    source: ShardSourceContext,
  ): number {
    for (let index = recentEntries.length - 1; index >= 0; index -= 1) {
      const entry = recentEntries.at(index);
      if (!entry) continue;
      if (this.sessionEntryMatchesSource(entry, source)) {
        return index;
      }
    }
    return -1;
  }

  private sessionEntryMatchesSource(entry: SessionEntry, source: ShardSourceContext): boolean {
    const metadata = entry.metadata;
    if (!metadata) {
      return false;
    }

    return this.metadataIncludesField(metadata, 'requestId', source.requestId)
      || this.metadataIncludesField(metadata, 'turnId', source.turnId);
  }

  private metadataIncludesField(
    metadata: string,
    field: 'requestId' | 'turnId',
    value: string | undefined,
  ): boolean {
    if (!value) {
      return false;
    }
    return metadata.includes(`\"${field}\":${JSON.stringify(value)}`);
  }

  private async buildContextPackMemoryBlock(
    task: string,
    sourceChannelId: string,
    scopeQuery: MemoryScopeQuery | undefined,
  ): Promise<string> {
    const query = task.trim();
    if (!query || !this.deps.memoryProvider) {
      return '';
    }

    const memoryBlock = await this.deps.memoryProvider.retrieve(
      query,
      sourceChannelId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scopeQuery,
    );
    return truncateShardContextText(memoryBlock, CONTEXT_PACK_MEMORY_MAX_CHARS);
  }

  private resolveContextPackMemoryScopeQuery(
    sourceChannelId: string,
  ): MemoryScopeQuery | undefined {
    return this.deps.sessionManager?.getActiveFocusMemoryScopeQuery(sourceChannelId) ?? undefined;
  }

  private renderContextPack(contextPack: ShardContextPack): string {
    const companionName = contextPack.companionName?.trim() || 'Assistant';
    const sourceConversation = contextPack.sessionEntries
      .map(entry => {
        const speaker = entry.role === 'assistant'
          ? entry.authorName?.trim() || companionName
          : entry.role === 'system'
            ? 'System'
            : (entry.authorName?.trim() || 'User');
        return `${speaker}: ${entry.content}`;
      })
      .join('\n');

    return [
      '[Shard context pack]',
      'Use only this task-scoped source context while working the shard task.',
      `Source channel: ${contextPack.source.channelId}`,
      ...(contextPack.source.requestId ? [`Source requestId: ${contextPack.source.requestId}`] : []),
      ...(contextPack.source.turnId ? [`Source turnId: ${contextPack.source.turnId}`] : []),
      ...(contextPack.source.embodimentContext
        ? [`Source embodiment: ${contextPack.source.embodimentContext.embodimentId}`]
        : []),
      `Task scope: ${truncateShardContextText(contextPack.task, CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS)}`,
      ...(sourceConversation
        ? [
          '',
          '[Focused source conversation]',
          sourceConversation,
        ]
        : []),
      ...(contextPack.memoryBlock
        ? [
          '',
          '[Task-scoped memory]',
          contextPack.memoryBlock,
        ]
        : []),
    ].join('\n');
  }
}

export function truncateShardContextText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}
