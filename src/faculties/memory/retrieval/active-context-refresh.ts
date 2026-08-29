import type { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  resolveMemorySelectionCap,
  type MemoryRetrievalPolicy,
} from '../../../system/config/memory-retrieval-policy.js';
import type { MemoryPresentationProfile } from '../../../system/config/memory-presentation-profile.js';
import type { EmotionalSnapshot } from '../../../core/contacts/store/emotional-baseline.js';
import type { ContextManifestMemorySeed } from '../../../core/session/context-manifest.js';
import { buildSnapshotVersionPointer } from '../../../core/turns/snapshot.js';
import {
  cloneRecentContactShapeArtifact,
  cloneEmotionalSnapshot,
  cloneMemory,
} from '../../../core/turns/snapshot.js';
import type { RecentContactShapeArtifact } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import {
  cloneMemoryWithheldSummary,
  type MemoryWithheldSummary,
} from '../withheld-summary.js';
import type {
  ActiveMemoryContextInvalidationRequest,
  ActiveMemoryContextInvalidationResult,
  ActiveMemoryContextSnapshot,
} from '../active-context.js';
import {
  ACTIVE_MEMORY_ENTRY_LIMIT_MULTIPLIER,
  ACTIVE_MEMORY_ENTRY_MIN_LIMIT,
  ACTIVE_MEMORY_MISS_DECAY,
  ACTIVE_MEMORY_MISS_LIMIT,
  type ActiveMemoryEntry,
  type ActiveMemoryRefreshTarget,
  type ActiveMemoryState,
} from './active-state.js';
import {
  cloneEpisodicRetrievalChain,
  type EpisodicRetrievalChain,
} from './episodic.js';
import { renderPromptBlock } from './formatting.js';
import type {
  RetrievalContactContext,
  RetrievalSocialContext,
  ScoredMemory,
} from './types.js';
import type { ArtifactSensitivitySource } from '../../../shared/contracts/artifact-sensitivity.js';
import type { DisclosureMemorySource } from '../../../core/cogsec/disclosure/generation-lineage.js';
import { channelClassificationEpochAsOf } from '../../../system/trust/runtime-classification-epochs.js';

function collectArtifactSensitivitySources(input: {
  selectedForPrompt: readonly ScoredMemory[];
  emotionalContinuityMemories: readonly PurrMemory[];
  recentContactShapeSourceMemories: readonly PurrMemory[];
}): ArtifactSensitivitySource[] {
  const byRef = new Map<string, ArtifactSensitivitySource>();
  const addMemory = (memory: PurrMemory): void => {
    byRef.set(`memory:${memory.id}`, {
      ref: `memory:${memory.id}`,
      sensitivity: memory.sensitivity,
    });
  };
  for (const scored of input.selectedForPrompt) {
    addMemory(scored.memory);
    for (const link of scored.evolutionChain ?? []) addMemory(link.memory);
  }
  for (const memory of input.emotionalContinuityMemories) addMemory(memory);
  for (const memory of input.recentContactShapeSourceMemories) addMemory(memory);
  return [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

// jp36.1.1.2: disclosure lineage seam. Content-free disclosure facts for every
// memory admitted to the generation context — sensitivity, subject contact, and
// source channel — so the outbound disclosure accumulator can fold them (bible
// §9.2 item 2). Parallel to the sensitivity-only artifact provenance above and
// keyed identically (`memory:<id>`) so both project the same admitted set.
export function collectDisclosureMemorySources(input: {
  selectedForPrompt: readonly ScoredMemory[];
  emotionalContinuityMemories: readonly PurrMemory[];
  recentContactShapeSourceMemories?: readonly PurrMemory[];
}): DisclosureMemorySource[] {
  const byRef = new Map<string, DisclosureMemorySource>();
  const addMemory = (memory: PurrMemory): void => {
    const ref = `memory:${memory.id}`;
    const subjectContactId = memory.contactId?.trim() || memory.provenance?.subjectContactId?.trim();
    const sourceChannelId = memory.provenance?.channelId?.trim();
    // jp36.6.4 / psfn-framework-qgqw.2: stamp the classification epoch the source
    // channel was at AS-OF THE CONVERSATION the memory was formed from — the
    // latest source-message instant (`provenance.sourceConversationAt`), NOT the
    // extraction instant (`extractedAt`). Deferred extraction (e.g. sleeptime
    // running after a restart) makes `extractedAt` post-date an invite-only →
    // public demotion, which would resolve the CURRENT (widened) epoch and make
    // pre-demotion content wrongly auto-eligible to the now-public room. Anchoring
    // to the conversation instant keeps such content at its old (lower or absent)
    // epoch so jp36.6.3's gate denies the auto-share.
    //
    // Fail closed on absence: when the conversation instant is missing (legacy
    // provenance persisted before this field, or a producer that cannot supply
    // it) we stamp NO epoch rather than falling back to `extractedAt`. An omitted
    // epoch denies auto-share to any epoch-tracked (since-demoted) room while
    // staying inert for never-demoted channels — the conservative direction.
    const sourceConversationAt = memory.provenance?.sourceConversationAt;
    const sourceChannelEpoch = sourceChannelId && sourceConversationAt !== undefined
      ? channelClassificationEpochAsOf(sourceChannelId, new Date(sourceConversationAt))
      : undefined;
    byRef.set(ref, {
      ref,
      sensitivity: memory.sensitivity,
      ...(subjectContactId ? { subjectContactId } : {}),
      ...(sourceChannelId ? { sourceChannelId } : {}),
      ...(sourceChannelEpoch !== undefined ? { sourceChannelEpoch } : {}),
      ...(memory.provenanceRefs && memory.provenanceRefs.length > 0
        ? { provenanceRefs: [...memory.provenanceRefs] }
        : {}),
    });
  };
  for (const scored of input.selectedForPrompt) {
    addMemory(scored.memory);
    for (const link of scored.evolutionChain ?? []) addMemory(link.memory);
  }
  for (const memory of input.emotionalContinuityMemories) addMemory(memory);
  for (const memory of input.recentContactShapeSourceMemories ?? []) addMemory(memory);
  return [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

const log = createComponentLogger('Retrieval');

export interface FinalizeRetrievalPromptBlockInput {
  activeContextTarget?: ActiveMemoryRefreshTarget;
  recentContactShape?: RecentContactShapeArtifact;
  recentContactShapeSourceMemories?: PurrMemory[];
  selectedForPrompt?: ScoredMemory[];
  emotionalSnapshot?: EmotionalSnapshot;
  emotionalContinuityMemories?: PurrMemory[];
  withheldSummary?: MemoryWithheldSummary;
  socialContext?: RetrievalSocialContext;
  contactContextById?: ReadonlyMap<string, RetrievalContactContext>;
  episodicChains?: EpisodicRetrievalChain[];
  manifestSeed: ContextManifestMemorySeed;
}

export interface ActiveMemoryContextRefreshDeps {
  activeMemoryContexts: Map<string, ActiveMemoryState>;
  memoryRetrievalPolicy: MemoryRetrievalPolicy;
  memoryPresentationProfile: MemoryPresentationProfile;
  eventBus?: EventBus;
  isMemoryQuarantined(memory: PurrMemory): boolean;
  filterQuarantinedMemories(memories: readonly PurrMemory[]): PurrMemory[];
  filterQuarantinedEpisodicChains(chains: readonly EpisodicRetrievalChain[]): EpisodicRetrievalChain[];
  toErrorMessage(error: unknown): string;
}

export function finalizeRetrievalPromptBlock(
  input: FinalizeRetrievalPromptBlockInput,
  deps: ActiveMemoryContextRefreshDeps,
): string {
  const block = renderPromptBlock(input.recentContactShape, input.selectedForPrompt ?? [], {
    emotionalSnapshot: input.emotionalSnapshot,
    emotionalContinuityMemories: input.emotionalContinuityMemories,
    withheldSummary: input.withheldSummary,
    socialContext: input.socialContext,
    contactContextById: input.contactContextById,
    episodicChains: input.episodicChains,
    presentationProfile: deps.memoryPresentationProfile,
  });

  if (!input.activeContextTarget) {
    return block;
  }

  return applyActiveMemoryContextRefresh({
    target: input.activeContextTarget,
    recentContactShape: input.recentContactShape,
    recentContactShapeSourceMemories: input.recentContactShapeSourceMemories ?? [],
    selectedForPrompt: input.selectedForPrompt ?? [],
    emotionalSnapshot: input.emotionalSnapshot,
    emotionalContinuityMemories: input.emotionalContinuityMemories ?? [],
    withheldSummary: input.withheldSummary,
    socialContext: input.socialContext,
    contactContextById: input.contactContextById,
    episodicChains: input.episodicChains ?? [],
    manifestSeed: input.manifestSeed,
  }, deps).contextBlock;
}

function cloneScoredPromptMemory(input: ScoredMemory): ScoredMemory {
  return {
    ...input,
    memory: cloneMemory(input.memory),
    privacyBreakdown: { ...input.privacyBreakdown },
    ...(input.evolutionChain
      ? {
        evolutionChain: input.evolutionChain.map(link => ({
          ...link,
          memory: cloneMemory(link.memory),
        })),
      }
      : {}),
  };
}

export function invalidateActiveMemoryContexts(
  request: ActiveMemoryContextInvalidationRequest,
  deps: Pick<ActiveMemoryContextRefreshDeps, 'activeMemoryContexts' | 'eventBus' | 'toErrorMessage'>,
): ActiveMemoryContextInvalidationResult {
  const memoryIds = new Set((request.memoryIds ?? []).map(id => id.trim()).filter(Boolean));
  const sessionChannelIds = new Set((request.sessionChannelIds ?? []).map(id => id.trim()).filter(Boolean));
  const invalidatedKeys: string[] = [];
  let invalidatedMemoryEntryCount = 0;

  for (const [key, state] of deps.activeMemoryContexts.entries()) {
    const keyParts = key.split('|');
    const sessionMatches = state.snapshot.channelId && sessionChannelIds.has(state.snapshot.channelId)
      ? true
      : [...sessionChannelIds].some(sessionId => keyParts.includes(`session:${sessionId}`));
    const selectedMemoryMatches = state.snapshot.selectedMemoryIds.some(id => memoryIds.has(id));
    const activeEntryMatches = [...state.entries.keys()].some(id => memoryIds.has(id));
    if (!sessionMatches && !selectedMemoryMatches && !activeEntryMatches) continue;

    invalidatedMemoryEntryCount += [...state.entries.keys()]
      .filter(id => memoryIds.has(id)).length;
    invalidatedKeys.push(key);
    deps.activeMemoryContexts.delete(key);
  }

  if (invalidatedKeys.length > 0) {
    void deps.eventBus?.emit('memory.active_context.invalidate', {
      reason: request.reason,
      memoryIds: [...memoryIds],
      sessionChannelIds: [...sessionChannelIds],
      invalidatedKeys: [...invalidatedKeys],
      timestamp: Date.now(),
    }).catch((error: unknown) => {
      log.debug('Failed to emit active memory invalidation event', {
        error: deps.toErrorMessage(error),
      });
    });
  }

  return {
    invalidatedContextCount: invalidatedKeys.length,
    invalidatedMemoryEntryCount,
    invalidatedKeys,
  };
}

function applyActiveMemoryContextRefresh(
  input: {
    target: ActiveMemoryRefreshTarget;
    recentContactShape?: RecentContactShapeArtifact;
    recentContactShapeSourceMemories: PurrMemory[];
    selectedForPrompt: ScoredMemory[];
    emotionalSnapshot?: EmotionalSnapshot;
    emotionalContinuityMemories: PurrMemory[];
    withheldSummary?: MemoryWithheldSummary;
    socialContext?: RetrievalSocialContext;
    contactContextById?: ReadonlyMap<string, RetrievalContactContext>;
    episodicChains: EpisodicRetrievalChain[];
    manifestSeed: ContextManifestMemorySeed;
  },
  deps: ActiveMemoryContextRefreshDeps,
): ActiveMemoryContextSnapshot {
  const { target } = input;
  const now = Date.now();
  const existing = deps.activeMemoryContexts.get(target.identity.key);
  const canRetainExistingEntries = target.accessPolicyHash !== undefined
    && existing?.completedAccessPolicyHash === target.accessPolicyHash;
  const previousEntries = canRetainExistingEntries
    ? existing.entries
    : new Map<string, ActiveMemoryEntry>();
  const nextEntries = new Map<string, ActiveMemoryEntry>();
  const selectedIds = new Set(input.selectedForPrompt.map(item => item.memory.id));
  const maxEntries = Math.max(
    ACTIVE_MEMORY_ENTRY_MIN_LIMIT,
    (input.manifestSeed.retrievalLimit ?? ACTIVE_MEMORY_ENTRY_MIN_LIMIT) * ACTIVE_MEMORY_ENTRY_LIMIT_MULTIPLIER,
    input.selectedForPrompt.length,
  );

  for (const [id, entry] of previousEntries.entries()) {
    if (selectedIds.has(id)) continue;
    if (deps.isMemoryQuarantined(entry.scored.memory)) continue;
    const missCount = entry.missCount + 1;
    if (missCount >= ACTIVE_MEMORY_MISS_LIMIT) continue;
    const retainedScore = entry.retainedScore * ACTIVE_MEMORY_MISS_DECAY;
    nextEntries.set(id, {
      ...entry,
      scored: cloneScoredPromptMemory(entry.scored),
      retainedScore,
      missCount,
    });
  }

  for (const scored of input.selectedForPrompt) {
    const id = scored.memory.id;
    const previous = previousEntries.get(id);
    nextEntries.set(id, {
      scored: cloneScoredPromptMemory(scored),
      retainedScore: Math.max(scored.score, previous?.retainedScore ?? 0),
      firstSelectedAt: previous?.firstSelectedAt ?? now,
      lastSelectedAt: now,
      missCount: 0,
    });
  }

  const rankedEntries = [...nextEntries.entries()]
    .sort(([, left], [, right]) => (
      right.retainedScore - left.retainedScore
      || right.lastSelectedAt - left.lastSelectedAt
      || right.scored.memory.importance - left.scored.memory.importance
    ));
  const selectedEntryCounts = new Map<string, number>();
  const selectedEntries: Array<[string, ActiveMemoryEntry]> = [];
  for (const rankedEntry of rankedEntries) {
    const type = rankedEntry[1].scored.memory.type;
    const selectionCap = resolveMemorySelectionCap(deps.memoryRetrievalPolicy, type);
    if (
      selectionCap !== undefined
      && (selectedEntryCounts.get(type) ?? 0) >= selectionCap
    ) {
      continue;
    }
    selectedEntries.push(rankedEntry);
    selectedEntryCounts.set(type, (selectedEntryCounts.get(type) ?? 0) + 1);
    if (selectedEntries.length >= maxEntries) break;
  }
  const cappedEntries = new Map(selectedEntries);
  const selectedForActivePrompt = selectedEntries
    .map(([, entry]) => cloneScoredPromptMemory(entry.scored));
  const recentContactShape = input.recentContactShape;
  const recentContactShapeSourceMemories = recentContactShape
    ? input.recentContactShapeSourceMemories.map(cloneMemory)
    : [];
  const emotionalSnapshot = input.emotionalSnapshot ?? existing?.emotionalSnapshot;
  const emotionalContinuityMemories = input.emotionalContinuityMemories.length > 0
    ? input.emotionalContinuityMemories.map(memory => cloneMemory(memory))
    : deps.filterQuarantinedMemories(existing?.emotionalContinuityMemories.map(memory => cloneMemory(memory)) ?? []);
  const withheldSummary = input.withheldSummary ?? existing?.withheldSummary;
  const socialContext = input.socialContext ?? existing?.socialContext;
  const contactContextById = input.contactContextById ?? existing?.contactContextById;
  const episodicChains = input.episodicChains.length > 0
    ? input.episodicChains.map(cloneEpisodicRetrievalChain)
    : deps.filterQuarantinedEpisodicChains(existing?.episodicChains.map(cloneEpisodicRetrievalChain) ?? []);
  const contextBlock = renderPromptBlock(recentContactShape, selectedForActivePrompt, {
    emotionalSnapshot,
    emotionalContinuityMemories,
    withheldSummary,
    socialContext,
    contactContextById,
    episodicChains,
    presentationProfile: deps.memoryPresentationProfile,
  });
  const selectedMemoryIds = [...cappedEntries.keys()];
  const artifactSensitivitySources = collectArtifactSensitivitySources({
    selectedForPrompt: selectedForActivePrompt,
    emotionalContinuityMemories,
    recentContactShapeSourceMemories,
  });
  const disclosureMemorySources = collectDisclosureMemorySources({
    selectedForPrompt: selectedForActivePrompt,
    emotionalContinuityMemories,
    recentContactShapeSourceMemories,
  });
  const refreshSerial = (existing?.refreshSerial ?? 0) + 1;
  const snapshot: ActiveMemoryContextSnapshot = {
    key: target.identity.key,
    subjectKey: target.identity.subjectKey,
    channelId: target.request.channelId,
    trustLevel: target.identity.trustLevel,
    channelVisibility: target.identity.channelVisibility,
    visibilityScope: target.identity.visibilityScope,
    contextBlock,
    contextChars: contextBlock.length,
    selectedMemoryIds,
    artifactSensitivitySources,
    disclosureMemorySources,
    generatedAt: now,
    lastRefreshStartedAt: target.startedAt,
    lastRefreshCompletedAt: now,
    refreshStatus: 'ready',
    versionPointer: buildSnapshotVersionPointer([
      target.identity.key,
      refreshSerial,
      selectedMemoryIds.join(','),
      contextBlock,
    ]),
    manifestSeed: {
      ...input.manifestSeed,
      reason: input.manifestSeed.reason ?? 'active_projection',
      returnedCount: selectedMemoryIds.length,
    },
  };

  deps.activeMemoryContexts.set(target.identity.key, {
    snapshot,
    entries: cappedEntries,
    ...(recentContactShape
      ? { recentContactShape: cloneRecentContactShapeArtifact(recentContactShape) }
      : {}),
    ...(emotionalSnapshot ? { emotionalSnapshot: cloneEmotionalSnapshot(emotionalSnapshot) } : {}),
    emotionalContinuityMemories,
    ...(withheldSummary ? { withheldSummary: cloneMemoryWithheldSummary(withheldSummary) } : {}),
    ...(socialContext ? { socialContext } : {}),
    ...(contactContextById ? { contactContextById } : {}),
    episodicChains,
    refreshSerial,
    maxEntries,
    ...(target.fingerprint
      ? { completedRefreshFingerprint: { ...target.fingerprint } }
      : {}),
    ...(target.accessPolicyHash
      ? { completedAccessPolicyHash: target.accessPolicyHash }
      : {}),
  });
  void deps.eventBus?.emit('memory.active_context.refresh', {
    channelId: target.request.channelId,
    key: target.identity.key,
    phase: 'ready',
    selectedMemoryIds,
    contextChars: contextBlock.length,
    timestamp: now,
  }).catch((emitError: unknown) => {
    log.debug('Failed to emit active memory refresh event', {
      key: target.identity.key,
      channelId: target.request.channelId,
      error: deps.toErrorMessage(emitError),
    });
  });
  return snapshot;
}
