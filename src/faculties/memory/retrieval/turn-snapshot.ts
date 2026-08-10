import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { TurnMemorySnapshot } from '../../../core/turns/snapshot.js';
import {
  buildSnapshotVersionPointer,
  cloneRecentContactShapeArtifact,
  cloneEmotionalSnapshot,
  cloneMemory,
  cloneScoredMemory,
} from '../../../core/turns/snapshot.js';
import type {
  ContextBudgetTurnCharacteristics,
  ResolvedContextBudget,
} from '../../../shared/context-budget.js';
import { resolveBroadcastVisibilityScope } from '../../../system/trust/broadcast-safety.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { MemoryRetrievalPolicy } from '../../../system/config/memory-retrieval-policy.js';
import type { RecentContactShapeArtifact, EmbeddingSearchAuthorization, MemoryStorePort } from '../memory-store-port.js';
import type {
  MemoryScopeQuery,
  PurrMemory,
  RetrievalAccessScope,
  RetrievalCallerContext,
  RetrievalModeInput,
} from '../types.js';
import { normalizeMemoryScopeQuery } from '../types.js';
import { isInternalMemoryArtifact } from '../internal-artifacts.js';
import {
  serializeMemoryWithheldSummary,
  type MemoryWithheldSummary,
} from '../withheld-summary.js';
import {
  cloneRetrievalCallerContext,
  cloneRetrievalModeInput,
  serializeRetrievalModes,
} from './modes.js';
import { resolveAuthorizedRetrievalAccessScope } from './access-scope.js';
import {
  collectRecentLexicalMemoryCandidates,
  mergeScoredMemoryCandidates,
} from './candidates.js';
import {
  cloneEpisodicRetrievalChain,
  type EpisodicRetrievalChain,
} from './episodic.js';
import {
  mergeMemoryWithheldSummaries,
  summarizeWithheldMemories,
  type RetrievalRoomVisibilityContext,
} from './access.js';
import type { MemoryQuarantineCandidate } from './session-quarantine.js';
import type {
  RetrievalQueryEmbeddingProvenance,
  TurnRetrievalQueryEmbedding,
} from '../../../shared/retrieval-query-embedding.js';
import type { RolledOutSessionBoundary } from '../../../core/session/rolled-out-session-boundary.js';

export interface CaptureTurnMemorySnapshotInput {
  contextText: string;
  channelId: string;
  rolledOutSessionBoundary?: RolledOutSessionBoundary;
  trustLevel?: TrustLevel;
  channelMeta?: ChannelMeta;
  canonicalContactId?: string;
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
  scopeQuery?: MemoryScopeQuery;
  callerContext?: RetrievalCallerContext;
  retrievalMode?: RetrievalModeInput;
  retrievalQueryEmbedding?: {
    value: TurnRetrievalQueryEmbedding;
    turnId: string;
    requestId: string;
    companionId: string;
  };
  roomVisibility?: RetrievalRoomVisibilityContext;
}

export interface CaptureTurnMemorySnapshotDeps {
  memoryStore: MemoryStorePort;
  embeddingService: EmbeddingProviderPort;
  embeddingProvenance?: RetrievalQueryEmbeddingProvenance;
  retrievalThreshold: number;
  /**
   * Explicit authorization stance for the raw embedding search (a27w.3). The
   * retriever passes 'subject-enforced' when it runs against the subject-
   * authorized projection and 'bypass-system-internal' only when it was
   * explicitly constructed without subject enforcement.
   */
  embeddingSearchAuthorization: EmbeddingSearchAuthorization;
  resolveMemoryRetrievalPolicy(): MemoryRetrievalPolicy;
  resolveRetrievalBudget(turn?: ContextBudgetTurnCharacteristics): ResolvedContextBudget;
  resolveRoomVisibilityContext(
    channelId: string,
    channelMeta: ChannelMeta | undefined,
    canonicalContactId: string | undefined,
  ): Promise<RetrievalRoomVisibilityContext>;
  resolveRecentContactShapeAccess(
    recentContactShape: RecentContactShapeArtifact | undefined,
    options: {
      accessScope?: RetrievalAccessScope;
      trustLevel: TrustLevel;
      channelPrivacy: ReturnType<typeof classifyChannelDisclosure>['channelPrivacy'];
      broadcast: boolean;
      channelMeta?: ChannelMeta;
      canonicalContactId?: string;
      operatorApproval?: boolean;
      roomVisibility?: RetrievalRoomVisibilityContext;
    },
  ): Promise<{
    recentContactShape?: RecentContactShapeArtifact;
    withheldSummary?: MemoryWithheldSummary;
    withheldSourceMemoryIds: string[];
  }>;
  resolveEmotionalSnapshot(contactId: string): Promise<TurnMemorySnapshot['emotionalSnapshot']>;
  collectContactEmotionalMemories(canonicalContactId: string): Promise<PurrMemory[]>;
  collectProactiveRecallCandidates(channelId: string, canonicalContactId?: string): Promise<PurrMemory[]>;
  resolveEpisodicChains(input: {
    contextText: string;
    channelId: string;
    rolledOutSessionBoundary?: RolledOutSessionBoundary;
    trustLevel: TrustLevel;
    channelDisclosure: ReturnType<typeof classifyChannelDisclosure>;
    canonicalContactId?: string;
    scopeQuery?: MemoryScopeQuery;
  }): Promise<EpisodicRetrievalChain[]>;
  filterQuarantinedMemories<T extends MemoryQuarantineCandidate>(
    memories: readonly T[],
  ): { memories: T[]; summary?: MemoryWithheldSummary; withheldIds: string[] };
  filterQuarantinedEpisodicChains(chains: readonly EpisodicRetrievalChain[]): EpisodicRetrievalChain[];
}

export async function captureTurnMemorySnapshot(
  input: CaptureTurnMemorySnapshotInput,
  deps: CaptureTurnMemorySnapshotDeps,
): Promise<TurnMemorySnapshot> {
  const {
    contextText,
    channelId,
    rolledOutSessionBoundary,
    trustLevel,
    channelMeta,
    canonicalContactId,
    turnBudgetCharacteristics,
    scopeQuery,
    callerContext,
    retrievalMode,
  } = input;
  const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
  const effectiveBudgetTurn = turnBudgetCharacteristics ?? {
    channelId,
    ...(channelMeta?.isDirectMessage !== undefined ? { isDirectMessage: channelMeta.isDirectMessage } : {}),
    messageText: contextText,
  };
  const budget = deps.resolveRetrievalBudget(effectiveBudgetTurn);
  const limit = budget.estimatedCount;
  const effectiveTrust = trustLevel ?? 'regular';
  const effectiveAccessScope = resolveAuthorizedRetrievalAccessScope(
    channelId,
    callerContext?.accessScope,
  );
  const channelDisclosure = classifyChannelDisclosure(channelId, channelMeta);
  const { channelPrivacy, broadcast } = channelDisclosure;
  const visibilityScope = resolveBroadcastVisibilityScope(channelId, channelMeta) ?? 'non_broadcast';
  const operatorApproval = visibilityScope === 'approved_private_context';
  const roomVisibility = input.roomVisibility
    ?? await deps.resolveRoomVisibilityContext(channelId, channelMeta, canonicalContactId);
  const rawRecentContactShape = canonicalContactId
    ? await deps.memoryStore.getRecentContactShape(canonicalContactId)
    : undefined;
  const shapeAccess = await deps.resolveRecentContactShapeAccess(rawRecentContactShape, {
    accessScope: effectiveAccessScope,
    trustLevel: effectiveTrust,
    channelPrivacy,
    broadcast,
    channelMeta,
    canonicalContactId,
    operatorApproval,
    roomVisibility,
  });
  const recentContactShape = shapeAccess.recentContactShape;
  const emotionalSnapshot = canonicalContactId
    ? await deps.resolveEmotionalSnapshot(canonicalContactId)
    : undefined;
  let quarantineWithheldSummary: MemoryWithheldSummary | undefined;
  const quarantineWithheldIds: string[] = [];
  const applyQuarantineResult = <T extends MemoryQuarantineCandidate>(result: {
    memories: T[];
    summary?: MemoryWithheldSummary;
    withheldIds: string[];
  }): T[] => {
    quarantineWithheldSummary = mergeMemoryWithheldSummaries(
      quarantineWithheldSummary,
      result.summary,
    );
    quarantineWithheldIds.push(...result.withheldIds);
    return result.memories;
  };
  let contactEmotionalMemories = canonicalContactId
    ? await deps.collectContactEmotionalMemories(canonicalContactId)
    : [];
  contactEmotionalMemories = applyQuarantineResult(
    deps.filterQuarantinedMemories(contactEmotionalMemories),
  );

  let semanticCandidates: Array<PurrMemory & { similarity: number }> = [];
  let lexicalCandidates: Array<PurrMemory & { similarity: number }> = [];

  if (contextText.trim().length > 0) {
    if (input.retrievalQueryEmbedding && !deps.embeddingProvenance) {
      throw new Error('Shared turn retrieval query embedding requires configured memory embedding provenance');
    }
    const embedding = input.retrievalQueryEmbedding
      ? await input.retrievalQueryEmbedding.value.resolve({
        turnId: input.retrievalQueryEmbedding.turnId,
        requestId: input.retrievalQueryEmbedding.requestId,
        companionId: input.retrievalQueryEmbedding.companionId,
        channelId,
        ...(canonicalContactId ? { canonicalContactId } : {}),
        queryText: contextText,
        provenance: deps.embeddingProvenance!,
      })
      : await deps.embeddingService.embed(contextText);
    const candidateLimit = Math.max(40, limit * 4);
    semanticCandidates = await deps.memoryStore.searchByEmbedding(
      embedding,
      deps.retrievalThreshold,
      candidateLimit,
      normalizedScopeQuery,
      // Product recall snapshot: the retriever supplies the authorization stance
      // it was configured with. In production `deps.memoryStore` is the subject-
      // authorized projection and the stance is 'subject-enforced'.
      deps.embeddingSearchAuthorization,
    );
    semanticCandidates = semanticCandidates
      .filter(memory => !isInternalMemoryArtifact(memory))
      .map(cloneScoredMemory);
    semanticCandidates = applyQuarantineResult(
      deps.filterQuarantinedMemories(semanticCandidates),
    );
    if (semanticCandidates.length === 0) {
      lexicalCandidates = (await deps.memoryStore
        .searchByText(contextText, candidateLimit, normalizedScopeQuery))
        .filter(memory => !isInternalMemoryArtifact(memory))
        .map(cloneScoredMemory);
      lexicalCandidates = applyQuarantineResult(
        deps.filterQuarantinedMemories(lexicalCandidates),
      );
    }
    const recentLexicalCandidates = await collectRecentLexicalMemoryCandidates({
      memoryStore: deps.memoryStore,
      contextText,
      existingIds: new Set([
        ...semanticCandidates.map(memory => memory.id),
        ...lexicalCandidates.map(memory => memory.id),
      ]),
      scopeQuery: normalizedScopeQuery,
      memoryRetrievalPolicy: deps.resolveMemoryRetrievalPolicy(),
    });
    semanticCandidates = mergeScoredMemoryCandidates(semanticCandidates, recentLexicalCandidates);
    semanticCandidates = applyQuarantineResult(
      deps.filterQuarantinedMemories(semanticCandidates),
    );
  }

  const proactiveCandidates = applyQuarantineResult(deps.filterQuarantinedMemories(await deps.collectProactiveRecallCandidates(
    channelId,
    canonicalContactId,
  )))
    .map(cloneMemory);
  const episodicChains = deps.filterQuarantinedEpisodicChains(await deps.resolveEpisodicChains({
    contextText,
    channelId,
    ...(rolledOutSessionBoundary ? { rolledOutSessionBoundary } : {}),
    trustLevel: effectiveTrust,
    channelDisclosure,
    canonicalContactId,
    scopeQuery: normalizedScopeQuery,
  }));
  const retrievalCandidates = semanticCandidates.length > 0 ? semanticCandidates : lexicalCandidates;
  const {
    summary: candidateWithheldSummary,
    withheldIds: withheldCandidateIds,
  } = summarizeWithheldMemories(
    [...retrievalCandidates, ...contactEmotionalMemories, ...proactiveCandidates],
    {
      accessScope: effectiveAccessScope,
      trustLevel: effectiveTrust,
      channelPrivacy,
      broadcast,
      channelMeta,
      canonicalContactId,
      operatorApproval,
      roomVisibility,
    },
  );
  const withheldSummary = mergeMemoryWithheldSummaries(
    quarantineWithheldSummary,
    candidateWithheldSummary,
    shapeAccess.withheldSummary,
  );
  const withheldIds = [...new Set([
    ...quarantineWithheldIds,
    ...withheldCandidateIds,
    ...shapeAccess.withheldSourceMemoryIds,
  ])];

  return {
    channelId,
    ...(recentContactShape
      ? { recentContactShape: cloneRecentContactShapeArtifact(recentContactShape) }
      : {}),
    ...(emotionalSnapshot ? { emotionalSnapshot: cloneEmotionalSnapshot(emotionalSnapshot) } : {}),
    contactEmotionalMemories: contactEmotionalMemories.map(cloneMemory),
    semanticCandidates,
    lexicalCandidates,
    episodicChains: episodicChains.map(cloneEpisodicRetrievalChain),
    proactiveCandidates,
    ...(withheldSummary ? { withheldSummary } : {}),
    ...(withheldIds.length > 0 ? { withheldCandidateIds: withheldIds } : {}),
    ...(callerContext ? { callerContext: cloneRetrievalCallerContext(callerContext) } : {}),
    ...((retrievalMode ?? callerContext?.retrievalMode) !== undefined
      ? { retrievalMode: cloneRetrievalModeInput(retrievalMode ?? callerContext?.retrievalMode) }
      : {}),
    versionPointer: buildSnapshotVersionPointer([
      channelId,
      effectiveTrust,
      channelPrivacy,
      visibilityScope,
      operatorApproval ? 'approved' : 'default',
      recentContactShape?.updatedAt,
      emotionalSnapshot?.lastMoodUpdateEpochMs,
      contactEmotionalMemories.map(memory => memory.id).join(','),
      semanticCandidates.map(memory => `${memory.id}:${memory.similarity.toFixed(4)}`).join(','),
      lexicalCandidates.map(memory => `${memory.id}:${memory.similarity.toFixed(4)}`).join(','),
      episodicChains.map(chain => `${chain.rootEpisodeId}:${chain.score.toFixed(4)}:${chain.episodes.map(episode => episode.id).join(',')}`).join(','),
      proactiveCandidates.map(memory => memory.id).join(','),
      serializeMemoryWithheldSummary(withheldSummary),
      serializeRetrievalModes(callerContext, retrievalMode),
      effectiveAccessScope,
    ]),
  };
}
