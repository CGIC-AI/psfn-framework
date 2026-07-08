import type {
  CogSecAction,
  CogSecAffectedArtifacts,
  CogSecArtifactClass,
  CogSecEventStore,
} from './events.js';
import type {
  CogSecLineageCompactionRef,
  CogSecLineageExternalArtifactRef,
  CogSecLineageMemoryRef,
  CogSecLineagePreview,
} from './lineage.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';

type Awaitable<T> = T | Promise<T>;

export type CogSecRevocationArtifactClass =
  | CogSecArtifactClass
  | 'focus_knowledge'
  | 'contact_profiles';

export interface CogSecRevocationFailure {
  artifactClass: CogSecRevocationArtifactClass;
  artifactId?: string;
  operation: string;
  reason: string;
}

export interface CogSecActiveMemoryInvalidationInput {
  caseId: string;
  memoryIds: readonly string[];
  sessionChannelIds: readonly string[];
  reason: string;
}

export interface CogSecActiveMemoryInvalidationResult {
  invalidatedContextCount: number;
  invalidatedMemoryEntryCount: number;
  invalidatedKeys: string[];
}

export interface CogSecActiveMemoryInvalidator {
  invalidateActiveMemoryContexts(
    input: CogSecActiveMemoryInvalidationInput,
  ): Awaitable<CogSecActiveMemoryInvalidationResult>;
}

export interface CogSecCompactionInvalidationInput {
  caseId: string;
  compactionSummaries: readonly CogSecLineageCompactionRef[];
  reason: string;
}

export interface CogSecCompactionInvalidationResult {
  invalidatedCompactionIds: string[];
}

export interface CogSecCompactionInvalidator {
  invalidateCompactionSummaries(
    input: CogSecCompactionInvalidationInput,
  ): Awaitable<CogSecCompactionInvalidationResult>;
}

export interface CogSecExternalArtifactInvalidationInput {
  caseId: string;
  artifacts: readonly CogSecLineageExternalArtifactRef[];
  reason: string;
}

export interface CogSecExternalArtifactInvalidationResult {
  invalidatedArtifactIds: string[];
}

export interface CogSecExternalArtifactInvalidator {
  invalidateCogSecArtifacts(
    input: CogSecExternalArtifactInvalidationInput,
  ): Awaitable<CogSecExternalArtifactInvalidationResult>;
}

export interface CogSecRevocationResult {
  caseId: string;
  revokedMemoryIds: string[];
  manualReviewMemoryIds: string[];
  revokedEmbeddingMemoryIds: string[];
  invalidatedActiveMemoryKeys: string[];
  invalidatedActiveMemoryContextCount: number;
  invalidatedActiveMemoryEntryCount: number;
  invalidatedCompactionSummaryIds: string[];
  invalidatedExternalArtifactIds: string[];
  manualReviewExternalArtifactIds: string[];
  lineageGapCount: number;
  failures: CogSecRevocationFailure[];
}

export interface ApplyCogSecRevocationInput {
  caseId?: string;
  preview: CogSecLineagePreview;
  eventStore: Pick<CogSecEventStore, 'getEvent' | 'updateEvent'>;
  memoryStore?: Pick<MemoryStorePort, 'softDeleteMemory'>;
  activeMemoryInvalidator?: CogSecActiveMemoryInvalidator;
  compactionInvalidator?: CogSecCompactionInvalidator;
  externalArtifactInvalidator?: CogSecExternalArtifactInvalidator;
  actor?: string;
  now?: () => number;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function mergeArtifactImpact(
  artifacts: CogSecAffectedArtifacts,
  artifactClass: CogSecArtifactClass,
  ids: readonly string[],
  count: number,
): void {
  const existing = artifacts[artifactClass];
  const mergedIds = uniqueStrings([
    ...(existing?.ids ?? []),
    ...ids,
  ]);
  artifacts[artifactClass] = {
    ids: mergedIds,
    count: Math.max(existing?.count ?? 0, mergedIds.length, count),
  };
}

function failure(
  artifactClass: CogSecRevocationArtifactClass,
  operation: string,
  reason: string,
  artifactId?: string,
): CogSecRevocationFailure {
  return {
    artifactClass,
    operation,
    reason,
    ...(artifactId ? { artifactId } : {}),
  };
}

function isAutoRevokedMemory(memory: CogSecLineageMemoryRef): boolean {
  return memory.classification === 'tainted' && memory.actions.includes('revoke');
}

function isManualReviewMemory(memory: CogSecLineageMemoryRef): boolean {
  return memory.classification === 'uncertain' || memory.actions.includes('manual_review');
}

function isAutoInvalidatedExternalArtifact(artifact: CogSecLineageExternalArtifactRef): boolean {
  return artifact.classification === 'tainted' && artifact.actions.includes('revoke');
}

function isManualReviewExternalArtifact(artifact: CogSecLineageExternalArtifactRef): boolean {
  return artifact.classification === 'uncertain' || artifact.actions.includes('manual_review');
}

function mapExternalArtifactClass(
  artifact: CogSecLineageExternalArtifactRef,
): CogSecArtifactClass {
  switch (artifact.artifactClass) {
    case 'active_memory_cache':
    case 'focus_knowledge':
      return 'active_memory_entries';
    case 'contact_profile':
    case 'profile_artifact':
      return 'profile_artifacts';
    case 'episodic_landmark':
      return 'episodic_landmarks';
    case 'persona_artifact':
      return 'persona_artifacts';
  }
}

function safeFailureDetails(failures: readonly CogSecRevocationFailure[]): string | undefined {
  if (failures.length === 0) return undefined;
  const first = failures[0];
  const id = first.artifactId ? ` ${first.artifactId}` : '';
  return `CogSec revocation recorded ${failures.length} failure(s). First failure: ${first.artifactClass}${id} ${first.operation} ${first.reason}.`;
}

function toCompactionId(ref: CogSecLineageCompactionRef): string {
  return `${ref.logicalSessionId}:${ref.compactionId}`;
}

export async function applyCogSecRevocation(
  input: ApplyCogSecRevocationInput,
): Promise<CogSecRevocationResult> {
  const caseId = input.caseId ?? input.preview.caseId;
  const event = input.eventStore.getEvent(caseId);
  if (!event) {
    throw new Error(`CogSec event not found: ${caseId}`);
  }

  const failures: CogSecRevocationFailure[] = [];
  const revokedMemoryIds: string[] = [];
  const manualReviewMemoryIds = input.preview.memories
    .filter(isManualReviewMemory)
    .map(memory => memory.id);

  const memoryRefs = input.preview.memories.filter(isAutoRevokedMemory);
  if (memoryRefs.length > 0 && !input.memoryStore) {
    for (const memory of memoryRefs) {
      failures.push(failure('memories', 'soft_delete', 'memory_store_not_provided', memory.id));
    }
  } else if (input.memoryStore) {
    const deletedAt = input.now?.() ?? Date.now();
    for (const memory of memoryRefs) {
      try {
        const deleted = await input.memoryStore.softDeleteMemory(memory.id, {
          deletedBy: input.actor ?? 'cogsec',
          reason: `CogSec revocation ${caseId}`,
          deletedAt,
        });
        if (deleted) {
          revokedMemoryIds.push(memory.id);
        } else {
          failures.push(failure('memories', 'soft_delete', 'memory_not_found_or_already_deleted', memory.id));
        }
      } catch {
        failures.push(failure('memories', 'soft_delete', 'soft_delete_failed', memory.id));
      }
    }
  }

  const revokedEmbeddingMemoryIds = input.preview.embeddingMemoryRows
    .filter(memory => revokedMemoryIds.includes(memory.id))
    .map(memory => memory.id);

  let invalidatedActiveMemoryKeys: string[] = [];
  let invalidatedActiveMemoryContextCount = 0;
  let invalidatedActiveMemoryEntryCount = 0;
  const activeMemoryIds = uniqueStrings([
    ...revokedMemoryIds,
    ...input.preview.memories
      .filter(memory => memory.classification === 'tainted')
      .map(memory => memory.id),
  ]);
  if (activeMemoryIds.length > 0 || input.preview.affectedLogicalSessionIds.length > 0) {
    if (input.activeMemoryInvalidator) {
      try {
        const invalidated = await input.activeMemoryInvalidator.invalidateActiveMemoryContexts({
          caseId,
          memoryIds: activeMemoryIds,
          sessionChannelIds: input.preview.affectedLogicalSessionIds,
          reason: 'cogsec_revocation',
        });
        invalidatedActiveMemoryKeys = invalidated.invalidatedKeys;
        invalidatedActiveMemoryContextCount = invalidated.invalidatedContextCount;
        invalidatedActiveMemoryEntryCount = invalidated.invalidatedMemoryEntryCount;
      } catch {
        failures.push(failure('active_memory_entries', 'invalidate', 'active_memory_invalidation_failed'));
      }
    } else {
      failures.push(failure('active_memory_entries', 'invalidate', 'active_memory_invalidator_not_provided'));
    }
  }

  const compactionRefs = input.preview.compactionSummaries
    .filter(ref => ref.actions.includes('regenerate'));
  let invalidatedCompactionSummaryIds: string[] = [];
  if (compactionRefs.length > 0) {
    if (input.compactionInvalidator) {
      try {
        const invalidated = await input.compactionInvalidator.invalidateCompactionSummaries({
          caseId,
          compactionSummaries: compactionRefs,
          reason: 'cogsec_revocation',
        });
        invalidatedCompactionSummaryIds = invalidated.invalidatedCompactionIds;
      } catch {
        failures.push(failure('compaction_summaries', 'invalidate', 'compaction_invalidation_failed'));
      }
    } else {
      failures.push(failure('compaction_summaries', 'invalidate', 'compaction_invalidator_not_provided'));
    }
  }

  const externalArtifacts = input.preview.externalArtifacts.filter(isAutoInvalidatedExternalArtifact);
  const manualReviewExternalArtifactIds = input.preview.externalArtifacts
    .filter(isManualReviewExternalArtifact)
    .map(artifact => artifact.id);
  let invalidatedExternalArtifactIds: string[] = [];
  if (externalArtifacts.length > 0) {
    if (input.externalArtifactInvalidator) {
      try {
        const invalidated = await input.externalArtifactInvalidator.invalidateCogSecArtifacts({
          caseId,
          artifacts: externalArtifacts,
          reason: 'cogsec_revocation',
        });
        invalidatedExternalArtifactIds = invalidated.invalidatedArtifactIds;
      } catch {
        failures.push(failure('profile_artifacts', 'invalidate', 'external_artifact_invalidation_failed'));
      }
    } else {
      for (const artifact of externalArtifacts) {
        failures.push(failure(mapExternalArtifactClass(artifact), 'invalidate', 'external_artifact_invalidator_not_provided', artifact.id));
      }
    }
  }

  const affectedArtifacts: CogSecAffectedArtifacts = { ...event.affectedArtifacts };
  mergeArtifactImpact(affectedArtifacts, 'memories', revokedMemoryIds, revokedMemoryIds.length);
  mergeArtifactImpact(affectedArtifacts, 'embeddings', revokedEmbeddingMemoryIds, revokedEmbeddingMemoryIds.length);
  mergeArtifactImpact(
    affectedArtifacts,
    'active_memory_entries',
    invalidatedActiveMemoryKeys,
    invalidatedActiveMemoryContextCount + invalidatedActiveMemoryEntryCount,
  );
  mergeArtifactImpact(
    affectedArtifacts,
    'compaction_summaries',
    invalidatedCompactionSummaryIds.length > 0
      ? invalidatedCompactionSummaryIds
      : compactionRefs.map(toCompactionId),
    invalidatedCompactionSummaryIds.length,
  );
  for (const artifact of externalArtifacts) {
    const artifactClass = mapExternalArtifactClass(artifact);
    mergeArtifactImpact(
      affectedArtifacts,
      artifactClass,
      invalidatedExternalArtifactIds.includes(artifact.id) ? [artifact.id] : [],
      invalidatedExternalArtifactIds.includes(artifact.id) ? 1 : 0,
    );
  }

  const revokedArtifactCount = revokedMemoryIds.length
    + revokedEmbeddingMemoryIds.length
    + invalidatedActiveMemoryContextCount
    + invalidatedCompactionSummaryIds.length
    + invalidatedExternalArtifactIds.length;
  const lineageGapCount = input.preview.gaps.length
    + manualReviewMemoryIds.length
    + manualReviewExternalArtifactIds.length
    + failures.length;
  const actions = uniqueStrings([
    ...event.actions,
    'revoke',
    ...(compactionRefs.length > 0 || externalArtifacts.length > 0 ? ['regenerate'] : []),
  ]) as CogSecAction[];

  input.eventStore.updateEvent(caseId, {
    affectedArtifacts,
    actions,
    resultCounters: {
      revokedArtifacts: revokedArtifactCount,
      lineageGaps: lineageGapCount,
    },
    ...(failures.length > 0 ? { failureDetails: safeFailureDetails(failures) } : {}),
  });

  return {
    caseId,
    revokedMemoryIds,
    manualReviewMemoryIds,
    revokedEmbeddingMemoryIds,
    invalidatedActiveMemoryKeys,
    invalidatedActiveMemoryContextCount,
    invalidatedActiveMemoryEntryCount,
    invalidatedCompactionSummaryIds,
    invalidatedExternalArtifactIds,
    manualReviewExternalArtifactIds,
    lineageGapCount,
    failures,
  };
}
