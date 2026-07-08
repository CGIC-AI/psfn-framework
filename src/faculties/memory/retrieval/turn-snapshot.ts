import type { EmbeddingProviderPort } from '../../../core/agent/contracts.js';
import type { TurnMemorySnapshot } from '../../../core/turns/snapshot.js';
import {
  buildSnapshotVersionPointer,
  cloneContactProfileArtifact,
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
import type { ContactProfileArtifact, MemoryStorePort } from '../memory-store-port.js';
import type {
  MemoryScopeQuery,
  PurrMemory,
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

export interface CaptureTurnMemorySnapshotInput {
  contextText: string;
  channelId: string;
  trustLevel?: TrustLevel;
  channelMeta?: ChannelMeta;
  canonicalContactId?: string;
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
  scopeQuery?: MemoryScopeQuery;
  callerContext?: RetrievalCallerContext;
  retrievalMode?: RetrievalModeInput;
}

export interface CaptureTurnMemorySnapshotDeps {
  memoryStore: MemoryStorePort;
  embeddingService: EmbeddingProviderPort;
  retrievalThreshold: number;
  resolveRetrievalBudget(turn?: ContextBudgetTurnCharacteristics): ResolvedContextBudget;
  resolveRoomVisibilityContext(
    channelId: string,
    channelMeta: ChannelMeta | undefined,
    canonicalContactId: string | undefined,
  ): Promise<RetrievalRoomVisibilityContext>;
  resolveContactProfileAccess(
    profile: ContactProfileArtifact | undefined,
    options: {
      trustLevel: TrustLevel;
      channelPrivacy: ReturnType<typeof classifyChannelDisclosure>['channelPrivacy'];
      broadcast: boolean;
      channelMeta?: ChannelMeta;
      canonicalContactId?: string;
      operatorApproval?: boolean;
      roomVisibility?: RetrievalRoomVisibilityContext;
    },
  ): Promise<{
    profile?: ContactProfileArtifact;
    withheldSummary?: MemoryWithheldSummary;
    withheldSourceMemoryIds: string[];
  }>;
  resolveEmotionalSnapshot(contactId: string): Promise<TurnMemorySnapshot['emotionalSnapshot']>;
  collectContactEmotionalMemories(canonicalContactId: string): Promise<PurrMemory[]>;
  collectProactiveRecallCandidates(channelId: string, canonicalContactId?: string): Promise<PurrMemory[]>;
  resolveEpisodicChains(input: {
    contextText: string;
    channelId: string;
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
  const channelDisclosure = classifyChannelDisclosure(channelId, channelMeta);
  const { channelPrivacy, broadcast } = channelDisclosure;
  const visibilityScope = resolveBroadcastVisibilityScope(channelId, channelMeta) ?? 'non_broadcast';
  const operatorApproval = visibilityScope === 'approved_private_context';
  const roomVisibility = await deps.resolveRoomVisibilityContext(channelId, channelMeta, canonicalContactId);
  const rawProfile = canonicalContactId
    ? await deps.memoryStore.getContactProfile(canonicalContactId)
    : undefined;
  const profileAccess = await deps.resolveContactProfileAccess(rawProfile, {
    trustLevel: effectiveTrust,
    channelPrivacy,
    broadcast,
    channelMeta,
    canonicalContactId,
    operatorApproval,
    roomVisibility,
  });
  const profile = profileAccess.profile;
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
    const embedding = await deps.embeddingService.embed(contextText);
    const candidateLimit = Math.max(40, limit * 4);
    semanticCandidates = await deps.memoryStore.searchByEmbedding(
      embedding,
      deps.retrievalThreshold,
      candidateLimit,
      normalizedScopeQuery,
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
    profileAccess.withheldSummary,
  );
  const withheldIds = [...new Set([
    ...quarantineWithheldIds,
    ...withheldCandidateIds,
    ...profileAccess.withheldSourceMemoryIds,
  ])];

  return {
    channelId,
    ...(profile ? { profile: cloneContactProfileArtifact(profile) } : {}),
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
      profile?.updatedAt,
      emotionalSnapshot?.lastMoodUpdateEpochMs,
      contactEmotionalMemories.map(memory => memory.id).join(','),
      semanticCandidates.map(memory => `${memory.id}:${memory.similarity.toFixed(4)}`).join(','),
      lexicalCandidates.map(memory => `${memory.id}:${memory.similarity.toFixed(4)}`).join(','),
      episodicChains.map(chain => `${chain.rootEpisodeId}:${chain.score.toFixed(4)}:${chain.episodes.map(episode => episode.id).join(',')}`).join(','),
      proactiveCandidates.map(memory => memory.id).join(','),
      serializeMemoryWithheldSummary(withheldSummary),
      serializeRetrievalModes(callerContext, retrievalMode),
    ]),
  };
}
