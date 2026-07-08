import type { EmotionalSnapshot } from '../../../core/contacts/store/emotional-baseline.js';
import type { ContextManifestMemorySeed } from '../../../core/session/context-manifest.js';
import type {
  ActiveMemoryContextRequest,
  ActiveMemoryContextSnapshot,
  resolveActiveMemoryContextIdentity,
} from '../active-context.js';
import type { ContactProfileArtifact } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import type { MemoryWithheldSummary } from '../withheld-summary.js';
import type { EpisodicRetrievalChain } from './episodic.js';
import type {
  RetrievalContactContext,
  RetrievalSocialContext,
  ScoredMemory,
} from './types.js';

export const ACTIVE_MEMORY_ENTRY_LIMIT_MULTIPLIER = 2;
export const ACTIVE_MEMORY_ENTRY_MIN_LIMIT = 12;
export const ACTIVE_MEMORY_MISS_LIMIT = 3;
export const ACTIVE_MEMORY_MISS_DECAY = 0.72;

export interface ActiveMemoryEntry {
  scored: ScoredMemory;
  retainedScore: number;
  firstSelectedAt: number;
  lastSelectedAt: number;
  missCount: number;
}

export interface ActiveMemoryState {
  snapshot: ActiveMemoryContextSnapshot;
  entries: Map<string, ActiveMemoryEntry>;
  profile?: ContactProfileArtifact;
  emotionalSnapshot?: EmotionalSnapshot;
  emotionalContinuityMemories: PurrMemory[];
  withheldSummary?: MemoryWithheldSummary;
  socialContext?: RetrievalSocialContext;
  contactContextById?: ReadonlyMap<string, RetrievalContactContext>;
  episodicChains: EpisodicRetrievalChain[];
  refreshSerial: number;
  maxEntries: number;
}

export interface ActiveMemoryRefreshTarget {
  request: ActiveMemoryContextRequest;
  startedAt: number;
  identity: ReturnType<typeof resolveActiveMemoryContextIdentity>;
}

export interface ActiveMemoryRefreshLoop {
  latestRequest?: ActiveMemoryContextRequest;
  running: Promise<ActiveMemoryContextSnapshot | null>;
}

export function cloneActiveMemorySnapshot(
  snapshot: ActiveMemoryContextSnapshot | null,
): ActiveMemoryContextSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    selectedMemoryIds: [...snapshot.selectedMemoryIds],
    ...(snapshot.manifestSeed
      ? {
        manifestSeed: cloneManifestSeed(snapshot.manifestSeed),
      }
      : {}),
  };
}

function cloneManifestSeed(seed: ContextManifestMemorySeed): ContextManifestMemorySeed {
  return {
    ...seed,
    ...(seed.selectedTypes
      ? { selectedTypes: { ...seed.selectedTypes } }
      : {}),
    ...(seed.policyRejectedReasonTags
      ? { policyRejectedReasonTags: { ...seed.policyRejectedReasonTags } }
      : {}),
    ...(seed.withheldReasonCounts
      ? { withheldReasonCounts: { ...seed.withheldReasonCounts } }
      : {}),
    ...(seed.withheldRelevanceBands
      ? { withheldRelevanceBands: { ...seed.withheldRelevanceBands } }
      : {}),
  };
}
