import type { ContextManifestMemorySeed } from '../../core/session/context-manifest.js';
import type { ContextBudgetTurnCharacteristics } from '../../shared/context-budget.js';
import { resolveBroadcastVisibilityScope, type BroadcastVisibilityScope } from '../../system/trust/broadcast-safety.js';
import { classifyChannel, type ChannelMeta } from '../../system/trust/policy.js';
import type { ChannelVisibility, TrustLevel } from '../../system/trust/types.js';
import type {
  MemoryScopeQuery,
  RetrievalCallerContext,
  RetrievalModeInput,
} from './types.js';
import { normalizeMemoryScopeQuery } from './types.js';
import type { ConversationScope } from '../../core/session/conversation-scope.js';

export type ActiveMemoryRefreshStatus = 'ready' | 'refreshing' | 'degraded';

export interface ActiveMemoryContextRequest {
  contextText: string;
  channelId: string;
  sessionChannelId?: string;
  trustLevel?: TrustLevel;
  channelMeta?: ChannelMeta;
  canonicalContactId?: string;
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
  scopeQuery?: MemoryScopeQuery;
  callerContext?: RetrievalCallerContext;
  retrievalMode?: RetrievalModeInput;
  /**
   * Turn ConversationScope (E1 epic), plumbed so active-context refreshes run
   * retrieval with the same scope the turn resolved. Not part of the request
   * identity; gating does not consume it yet.
   */
  conversationScope?: ConversationScope;
}

export interface ActiveMemoryContextSnapshot {
  key: string;
  subjectKey: string;
  channelId: string;
  trustLevel: TrustLevel;
  channelVisibility: ChannelVisibility;
  visibilityScope: BroadcastVisibilityScope | 'non_broadcast';
  contextBlock: string;
  contextChars: number;
  selectedMemoryIds: string[];
  generatedAt: number;
  lastRefreshStartedAt: number;
  lastRefreshCompletedAt?: number;
  refreshStatus: ActiveMemoryRefreshStatus;
  versionPointer: string;
  manifestSeed?: ContextManifestMemorySeed;
  lastRefreshError?: string;
}

export interface ActiveMemoryContextInvalidationRequest {
  memoryIds?: readonly string[];
  sessionChannelIds?: readonly string[];
  reason?: string;
}

export interface ActiveMemoryContextInvalidationResult {
  invalidatedContextCount: number;
  invalidatedMemoryEntryCount: number;
  invalidatedKeys: string[];
}

export interface ActiveMemoryContextIdentity {
  key: string;
  subjectKey: string;
  trustLevel: TrustLevel;
  channelVisibility: ChannelVisibility;
  visibilityScope: BroadcastVisibilityScope | 'non_broadcast';
}

function serializeRetrievalModeInput(value: RetrievalModeInput | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : [...value].sort().join(',');
}

function serializeScopeQuery(query: MemoryScopeQuery | undefined): string {
  const normalized = normalizeMemoryScopeQuery(query);
  if (!normalized) return '';
  const refs = (normalized.refs ?? [])
    .map(ref => `${ref.kind}:${ref.id}`)
    .sort()
    .join(',');
  const tags = [...(normalized.tags ?? [])].sort().join(',');
  return [
    `mode=${normalized.mode ?? 'prefer'}`,
    `refs=${refs}`,
    `tags=${tags}`,
  ].join(';');
}

export function resolveActiveMemoryContextIdentity(
  request: Pick<ActiveMemoryContextRequest,
    | 'channelId'
    | 'sessionChannelId'
    | 'trustLevel'
    | 'channelMeta'
    | 'canonicalContactId'
    | 'scopeQuery'
    | 'callerContext'
    | 'retrievalMode'
  >,
): ActiveMemoryContextIdentity {
  const trustLevel = request.trustLevel ?? 'regular';
  const channelVisibility = classifyChannel(request.channelId, request.channelMeta);
  const visibilityScope = resolveBroadcastVisibilityScope(request.channelId, request.channelMeta) ?? 'non_broadcast';
  const contactKey = request.canonicalContactId?.trim();
  const subjectKey = contactKey && contactKey.length > 0
    ? `contact:${contactKey}`
    : `channel:${request.channelId}`;
  const sessionChannelKey = request.sessionChannelId?.trim() || request.channelId;
  const callerRetrievalMode = request.callerContext?.retrievalMode;
  const key = [
    subjectKey,
    `session:${sessionChannelKey}`,
    `trust:${trustLevel}`,
    `visibility:${channelVisibility}`,
    `scope:${visibilityScope}`,
    `focus:${serializeScopeQuery(request.scopeQuery)}`,
    `callerMode:${serializeRetrievalModeInput(callerRetrievalMode)}`,
    `mode:${serializeRetrievalModeInput(request.retrievalMode)}`,
  ].join('|');

  return {
    key,
    subjectKey,
    trustLevel,
    channelVisibility,
    visibilityScope,
  };
}
