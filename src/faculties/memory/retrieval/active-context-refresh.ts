import type { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { EmotionalSnapshot } from '../../../core/contacts/store/emotional-baseline.js';
import type { ContextManifestMemorySeed } from '../../../core/session/context-manifest.js';
import { buildSnapshotVersionPointer } from '../../../core/turns/snapshot.js';
import {
  cloneContactProfileArtifact,
  cloneEmotionalSnapshot,
  cloneMemory,
} from '../../../core/turns/snapshot.js';
import type { ContactProfileArtifact } from '../memory-store-port.js';
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

const log = createComponentLogger('Retrieval');

export interface FinalizeRetrievalPromptBlockInput {
  activeContextTarget?: ActiveMemoryRefreshTarget;
  profile?: ContactProfileArtifact;
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
  const block = renderPromptBlock(input.profile, input.selectedForPrompt ?? [], {
    emotionalSnapshot: input.emotionalSnapshot,
    emotionalContinuityMemories: input.emotionalContinuityMemories,
    withheldSummary: input.withheldSummary,
    socialContext: input.socialContext,
    contactContextById: input.contactContextById,
    episodicChains: input.episodicChains,
  });

  if (!input.activeContextTarget) {
    return block;
  }

  return applyActiveMemoryContextRefresh({
    target: input.activeContextTarget,
    profile: input.profile,
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

export function cloneScoredPromptMemory(input: ScoredMemory): ScoredMemory {
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
    profile?: ContactProfileArtifact;
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
  const previousEntries = existing?.entries ?? new Map<string, ActiveMemoryEntry>();
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
    ))
    .slice(0, maxEntries);
  const cappedEntries = new Map(rankedEntries);
  const selectedForActivePrompt = rankedEntries.map(([, entry]) => cloneScoredPromptMemory(entry.scored));
  const profile = input.profile ?? existing?.profile;
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
  const contextBlock = renderPromptBlock(profile, selectedForActivePrompt, {
    emotionalSnapshot,
    emotionalContinuityMemories,
    withheldSummary,
    socialContext,
    contactContextById,
    episodicChains,
  });
  const selectedMemoryIds = [...cappedEntries.keys()];
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
    ...(profile ? { profile: cloneContactProfileArtifact(profile) } : {}),
    ...(emotionalSnapshot ? { emotionalSnapshot: cloneEmotionalSnapshot(emotionalSnapshot) } : {}),
    emotionalContinuityMemories,
    ...(withheldSummary ? { withheldSummary: cloneMemoryWithheldSummary(withheldSummary) } : {}),
    ...(socialContext ? { socialContext } : {}),
    ...(contactContextById ? { contactContextById } : {}),
    episodicChains,
    refreshSerial,
    maxEntries,
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
