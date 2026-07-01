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
import { isCogSecTombstoneSessionEntry } from './tombstones.js';
import type { CompactionSummary, SessionEntry } from '../session/types.js';

type Awaitable<T> = T | Promise<T>;

export type CogSecRegenerationArtifactClass =
  | CogSecArtifactClass
  | 'focus_knowledge'
  | 'contact_profiles';

export interface CogSecRegenerationFailure {
  artifactClass: CogSecRegenerationArtifactClass;
  artifactId?: string;
  operation: string;
  reason: string;
}

export interface CogSecRegenerationSessionStore {
  rebuildSearchIndex(): Awaitable<void>;
  getRecent(channelId: string, limit: number): SessionEntry[];
  getEntriesInRange(channelId: string, startId: number, endId: number): SessionEntry[];
  getCompactionSummaries(channelId: string): CompactionSummary[];
  applyCogSecCompactionRegenerations(input: {
    channelId: string;
    caseId: string;
    summaries: readonly { compactionId: number; summary: string }[];
  }): Awaitable<{
    regeneratedCompactionIds: number[];
    skippedCompactionIds: number[];
  }>;
}

export interface CogSecRegenerateCompactionSummaryInput {
  caseId: string;
  channelId: string;
  compaction: CogSecLineageCompactionRef;
  cleanEntries: readonly SessionEntry[];
}

export interface CogSecCompactionSummaryRegenerator {
  regenerateCompactionSummary(
    input: CogSecRegenerateCompactionSummaryInput,
  ): Awaitable<{ summary: string } | null>;
}

export interface CogSecRegenerateMemoriesInput {
  caseId: string;
  channelId: string;
  cleanEntries: readonly SessionEntry[];
  revokedMemoryIds: readonly string[];
  memoryRefs: readonly CogSecLineageMemoryRef[];
}

export interface CogSecRegenerateMemoriesResult {
  memoryIds: string[];
  embeddingMemoryIds?: string[];
}

export interface CogSecMemoryRegenerator {
  regenerateMemories(
    input: CogSecRegenerateMemoriesInput,
  ): Awaitable<CogSecRegenerateMemoriesResult>;
}

export interface CogSecRebuildActiveMemoryInput {
  caseId: string;
  channelId: string;
  cleanEntries: readonly SessionEntry[];
  regeneratedMemoryIds: readonly string[];
  contextText: string;
}

export interface CogSecRebuildActiveMemoryResult {
  rebuiltContextKeys: string[];
  selectedMemoryIds?: string[];
}

export interface CogSecActiveMemoryRebuilder {
  rebuildActiveMemoryContext(
    input: CogSecRebuildActiveMemoryInput,
  ): Awaitable<CogSecRebuildActiveMemoryResult>;
}

export interface CogSecRegenerateExternalArtifactsInput {
  caseId: string;
  artifacts: readonly CogSecLineageExternalArtifactRef[];
  cleanEntriesByChannel: ReadonlyMap<string, readonly SessionEntry[]>;
}

export interface CogSecRegenerateExternalArtifactsResult {
  regeneratedArtifactIds: string[];
  queuedArtifactIds?: string[];
}

export interface CogSecExternalArtifactRegenerator {
  regenerateCogSecArtifacts(
    input: CogSecRegenerateExternalArtifactsInput,
  ): Awaitable<CogSecRegenerateExternalArtifactsResult>;
}

export interface CogSecRegenerationResult {
  caseId: string;
  rebuiltProjection: boolean;
  regeneratedCompactionSummaryIds: string[];
  skippedCompactionSummaryIds: string[];
  regeneratedMemoryIds: string[];
  regeneratedEmbeddingMemoryIds: string[];
  rebuiltActiveMemoryKeys: string[];
  selectedActiveMemoryIds: string[];
  regeneratedExternalArtifactIds: string[];
  queuedExternalArtifactIds: string[];
  cleanEntryCount: number;
  failures: CogSecRegenerationFailure[];
}

export interface ApplyCogSecRegenerationInput {
  caseId?: string;
  preview: CogSecLineagePreview;
  eventStore: Pick<CogSecEventStore, 'getEvent' | 'updateEvent'>;
  sessionStore: CogSecRegenerationSessionStore;
  compactionRegenerator?: CogSecCompactionSummaryRegenerator;
  memoryRegenerator?: CogSecMemoryRegenerator;
  activeMemoryRebuilder?: CogSecActiveMemoryRebuilder;
  externalArtifactRegenerator?: CogSecExternalArtifactRegenerator;
  now?: () => Date;
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
  artifactClass: CogSecRegenerationArtifactClass,
  operation: string,
  reason: string,
  artifactId?: string,
): CogSecRegenerationFailure {
  return {
    artifactClass,
    operation,
    reason,
    ...(artifactId ? { artifactId } : {}),
  };
}

function safeFailureDetails(failures: readonly CogSecRegenerationFailure[]): string | undefined {
  if (failures.length === 0) return undefined;
  const first = failures[0];
  const id = first.artifactId ? ` ${first.artifactId}` : '';
  return `CogSec regeneration recorded ${failures.length} failure(s). First failure: ${first.artifactClass}${id} ${first.operation} ${first.reason}.`;
}

function projectionId(channelId: string, messageId: number): string {
  return `${channelId}:${messageId}`;
}

function compactionId(ref: CogSecLineageCompactionRef): string {
  return `${ref.logicalSessionId}:${ref.compactionId}`;
}

function isCleanRegenerationEntry(entry: SessionEntry): boolean {
  return !isCogSecTombstoneSessionEntry(entry);
}

function getCleanEntriesForChannel(
  sessionStore: CogSecRegenerationSessionStore,
  channelId: string,
): SessionEntry[] {
  return sessionStore
    .getRecent(channelId, Number.MAX_SAFE_INTEGER)
    .filter(isCleanRegenerationEntry)
    .sort((left, right) => left.id - right.id);
}

function getCleanEntriesForCompaction(
  sessionStore: CogSecRegenerationSessionStore,
  ref: CogSecLineageCompactionRef,
): SessionEntry[] {
  return sessionStore
    .getEntriesInRange(ref.logicalSessionId, 1, ref.coveredUpTo)
    .filter(isCleanRegenerationEntry)
    .sort((left, right) => left.id - right.id);
}

function contextTextFromCleanEntries(entries: readonly SessionEntry[]): string {
  return entries
    .map(entry => {
      const speaker = entry.authorName?.trim() || entry.role;
      return `${speaker}: ${entry.content.replace(/\s+/g, ' ').trim()}`;
    })
    .filter(line => line.trim().length > 0)
    .join('\n');
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

function isRegenerableMemory(memory: CogSecLineageMemoryRef): boolean {
  return memory.actions.includes('regenerate') && memory.classification === 'tainted';
}

function isRegenerableExternalArtifact(artifact: CogSecLineageExternalArtifactRef): boolean {
  return artifact.actions.includes('regenerate') && artifact.classification === 'tainted';
}

export async function applyCogSecRegeneration(
  input: ApplyCogSecRegenerationInput,
): Promise<CogSecRegenerationResult> {
  const caseId = input.caseId ?? input.preview.caseId;
  const event = input.eventStore.getEvent(caseId);
  if (!event) {
    throw new Error(`CogSec event not found: ${caseId}`);
  }

  const failures: CogSecRegenerationFailure[] = [];
  const cleanEntriesByChannel = new Map<string, SessionEntry[]>();
  for (const channelId of uniqueStrings(input.preview.affectedLogicalSessionIds)) {
    cleanEntriesByChannel.set(channelId, getCleanEntriesForChannel(input.sessionStore, channelId));
  }
  const cleanEntryCount = [...cleanEntriesByChannel.values()]
    .reduce((sum, entries) => sum + entries.length, 0);

  let rebuiltProjection = false;
  try {
    await input.sessionStore.rebuildSearchIndex();
    rebuiltProjection = true;
  } catch {
    failures.push(failure('search_index_rows', 'rebuild', 'projection_rebuild_failed'));
  }

  const compactionRefs = input.preview.compactionSummaries
    .filter(ref => ref.actions.includes('regenerate'));
  const compactionSummariesByChannel = new Map<string, { compactionId: number; summary: string }[]>();
  const skippedCompactionSummaryIds: string[] = [];
  if (compactionRefs.length > 0) {
    if (!input.compactionRegenerator) {
      for (const ref of compactionRefs) {
        failures.push(failure('compaction_summaries', 'regenerate', 'compaction_regenerator_not_provided', compactionId(ref)));
      }
    } else {
      for (const ref of compactionRefs) {
        try {
          const regenerated = await input.compactionRegenerator.regenerateCompactionSummary({
            caseId,
            channelId: ref.logicalSessionId,
            compaction: ref,
            cleanEntries: getCleanEntriesForCompaction(input.sessionStore, ref),
          });
          if (!regenerated?.summary.trim()) {
            skippedCompactionSummaryIds.push(compactionId(ref));
            continue;
          }
          const byChannel = compactionSummariesByChannel.get(ref.logicalSessionId) ?? [];
          byChannel.push({ compactionId: ref.compactionId, summary: regenerated.summary });
          compactionSummariesByChannel.set(ref.logicalSessionId, byChannel);
        } catch {
          failures.push(failure('compaction_summaries', 'regenerate', 'compaction_regeneration_failed', compactionId(ref)));
        }
      }
    }
  }

  const regeneratedCompactionSummaryIds: string[] = [];
  for (const [channelId, summaries] of compactionSummariesByChannel.entries()) {
    try {
      const result = await input.sessionStore.applyCogSecCompactionRegenerations({
        channelId,
        caseId,
        summaries,
      });
      regeneratedCompactionSummaryIds.push(
        ...result.regeneratedCompactionIds.map(id => `${channelId}:${id}`),
      );
      skippedCompactionSummaryIds.push(
        ...result.skippedCompactionIds.map(id => `${channelId}:${id}`),
      );
    } catch {
      failures.push(failure('compaction_summaries', 'apply', 'compaction_apply_failed', channelId));
    }
  }

  const regenerableMemories = input.preview.memories.filter(isRegenerableMemory);
  const regeneratedMemoryIds: string[] = [];
  const regeneratedEmbeddingMemoryIds: string[] = [];
  if (regenerableMemories.length > 0) {
    if (!input.memoryRegenerator) {
      for (const memory of regenerableMemories) {
        failures.push(failure('memories', 'regenerate', 'memory_regenerator_not_provided', memory.id));
      }
    } else {
      for (const [channelId, cleanEntries] of cleanEntriesByChannel.entries()) {
        if (cleanEntries.length === 0) continue;
        try {
          const result = await input.memoryRegenerator.regenerateMemories({
            caseId,
            channelId,
            cleanEntries,
            revokedMemoryIds: regenerableMemories.map(memory => memory.id),
            memoryRefs: regenerableMemories,
          });
          regeneratedMemoryIds.push(...result.memoryIds);
          regeneratedEmbeddingMemoryIds.push(...(result.embeddingMemoryIds ?? result.memoryIds));
        } catch {
          failures.push(failure('memories', 'regenerate', 'memory_regeneration_failed', channelId));
        }
      }
    }
  }

  const rebuiltActiveMemoryKeys: string[] = [];
  const selectedActiveMemoryIds: string[] = [];
  if (regeneratedMemoryIds.length > 0) {
    if (!input.activeMemoryRebuilder) {
      failures.push(failure('active_memory_entries', 'rebuild', 'active_memory_rebuilder_not_provided'));
    } else {
      for (const [channelId, cleanEntries] of cleanEntriesByChannel.entries()) {
        if (cleanEntries.length === 0) continue;
        try {
          const result = await input.activeMemoryRebuilder.rebuildActiveMemoryContext({
            caseId,
            channelId,
            cleanEntries,
            regeneratedMemoryIds,
            contextText: contextTextFromCleanEntries(cleanEntries),
          });
          rebuiltActiveMemoryKeys.push(...result.rebuiltContextKeys);
          selectedActiveMemoryIds.push(...(result.selectedMemoryIds ?? []));
        } catch {
          failures.push(failure('active_memory_entries', 'rebuild', 'active_memory_rebuild_failed', channelId));
        }
      }
    }
  }

  const externalArtifacts = input.preview.externalArtifacts.filter(isRegenerableExternalArtifact);
  const regeneratedExternalArtifactIds: string[] = [];
  const queuedExternalArtifactIds: string[] = [];
  if (externalArtifacts.length > 0) {
    if (!input.externalArtifactRegenerator) {
      for (const artifact of externalArtifacts) {
        failures.push(failure(mapExternalArtifactClass(artifact), 'regenerate', 'external_regenerator_not_provided', artifact.id));
      }
    } else {
      try {
        const result = await input.externalArtifactRegenerator.regenerateCogSecArtifacts({
          caseId,
          artifacts: externalArtifacts,
          cleanEntriesByChannel,
        });
        regeneratedExternalArtifactIds.push(...result.regeneratedArtifactIds);
        queuedExternalArtifactIds.push(...(result.queuedArtifactIds ?? []));
      } catch {
        failures.push(failure('profile_artifacts', 'regenerate', 'external_regeneration_failed'));
      }
    }
  }

  const affectedArtifacts: CogSecAffectedArtifacts = { ...event.affectedArtifacts };
  const projectionIds = input.preview.transcriptProjectionRows
    .map(row => projectionId(row.channelId, row.messageId));
  if (rebuiltProjection) {
    mergeArtifactImpact(affectedArtifacts, 'transcript_projection_rows', projectionIds, projectionIds.length);
    mergeArtifactImpact(affectedArtifacts, 'search_index_rows', projectionIds, projectionIds.length);
  }
  mergeArtifactImpact(
    affectedArtifacts,
    'compaction_summaries',
    regeneratedCompactionSummaryIds,
    regeneratedCompactionSummaryIds.length,
  );
  mergeArtifactImpact(affectedArtifacts, 'memories', regeneratedMemoryIds, regeneratedMemoryIds.length);
  mergeArtifactImpact(
    affectedArtifacts,
    'embeddings',
    regeneratedEmbeddingMemoryIds,
    regeneratedEmbeddingMemoryIds.length,
  );
  mergeArtifactImpact(
    affectedArtifacts,
    'active_memory_entries',
    rebuiltActiveMemoryKeys,
    rebuiltActiveMemoryKeys.length,
  );
  for (const artifact of externalArtifacts) {
    const artifactClass = mapExternalArtifactClass(artifact);
    const ids = [
      ...regeneratedExternalArtifactIds,
      ...queuedExternalArtifactIds,
    ].filter(id => id === artifact.id || id.startsWith(`${artifact.id}:`));
    mergeArtifactImpact(affectedArtifacts, artifactClass, ids, ids.length);
  }

  const regeneratedArtifactCount = (rebuiltProjection ? projectionIds.length : 0)
    + regeneratedCompactionSummaryIds.length
    + regeneratedMemoryIds.length
    + regeneratedEmbeddingMemoryIds.length
    + rebuiltActiveMemoryKeys.length
    + regeneratedExternalArtifactIds.length
    + queuedExternalArtifactIds.length;
  const actions = uniqueStrings([
    ...event.actions,
    'regenerate',
  ]) as CogSecAction[];
  const appliedAt = input.now?.().toISOString() ?? new Date().toISOString();
  input.eventStore.updateEvent(caseId, {
    status: failures.length > 0 ? 'failed' : 'applied',
    affectedArtifacts,
    actions,
    ...(failures.length === 0 ? { appliedAt } : {}),
    resultCounters: {
      regeneratedArtifacts: regeneratedArtifactCount,
      ...(failures.length > 0
        ? { lineageGaps: (event.resultCounters.lineageGaps ?? 0) + failures.length }
        : {}),
    },
    ...(failures.length > 0 ? { failureDetails: safeFailureDetails(failures) } : {}),
  });

  return {
    caseId,
    rebuiltProjection,
    regeneratedCompactionSummaryIds,
    skippedCompactionSummaryIds: uniqueStrings(skippedCompactionSummaryIds),
    regeneratedMemoryIds: uniqueStrings(regeneratedMemoryIds),
    regeneratedEmbeddingMemoryIds: uniqueStrings(regeneratedEmbeddingMemoryIds),
    rebuiltActiveMemoryKeys: uniqueStrings(rebuiltActiveMemoryKeys),
    selectedActiveMemoryIds: uniqueStrings(selectedActiveMemoryIds),
    regeneratedExternalArtifactIds: uniqueStrings(regeneratedExternalArtifactIds),
    queuedExternalArtifactIds: uniqueStrings(queuedExternalArtifactIds),
    cleanEntryCount,
    failures,
  };
}
