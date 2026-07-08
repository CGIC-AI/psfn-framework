import type { PurrMemory } from '../types.js';
import {
  createEmptyMemoryWithheldSummary,
  incrementMemoryWithheldReason,
  incrementMemoryWithheldRelevanceBand,
  resolveMemoryWithheldRelevanceBand,
  type MemoryWithheldSummary,
} from '../withheld-summary.js';
import {
  cloneEpisodicRetrievalChain,
  type EpisodicRetrievalChain,
} from './episodic.js';

export interface MemorySessionQuarantineFilter {
  isSessionRetiredOrQuarantined(logicalSessionId: string): boolean;
  getRetiredLogicalSessionIds?(): ReadonlySet<string>;
}

export type MemoryQuarantineCandidate =
  Pick<PurrMemory, 'id' | 'sourceRef' | 'provenance' | 'provenanceRefs'>
  & { similarity?: number };

export function isRetiredSessionId(
  filter: MemorySessionQuarantineFilter | null,
  logicalSessionId: string | undefined,
): boolean {
  const normalized = logicalSessionId?.trim();
  if (!normalized || !filter) return false;
  return filter.isSessionRetiredOrQuarantined(normalized);
}

export function isMemoryQuarantined(
  filter: MemorySessionQuarantineFilter | null,
  memory: MemoryQuarantineCandidate,
): boolean {
  if (!filter) return false;
  if (isRetiredSessionId(filter, memory.provenance?.sessionId)) return true;
  if (referenceTargetsRetiredSession(filter, memory.sourceRef)) return true;
  return (memory.provenanceRefs ?? []).some(ref => referenceTargetsRetiredSession(filter, ref));
}

export function summarizeQuarantinedMemories<T extends MemoryQuarantineCandidate>(
  filter: MemorySessionQuarantineFilter | null,
  memories: readonly T[],
): { summary?: MemoryWithheldSummary; withheldIds: string[] } {
  const summary = createEmptyMemoryWithheldSummary();
  const withheldIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const memory of memories) {
    if (seenIds.has(memory.id)) continue;
    seenIds.add(memory.id);
    if (!isMemoryQuarantined(filter, memory)) continue;
    incrementMemoryWithheldReason(summary, 'session_quarantine.blocked');
    incrementMemoryWithheldRelevanceBand(
      summary,
      resolveMemoryWithheldRelevanceBand(memory.similarity),
    );
    withheldIds.add(memory.id);
  }
  return {
    ...(summary.totalCount > 0 ? { summary } : {}),
    withheldIds: [...withheldIds],
  };
}

export function filterQuarantinedMemories<T extends MemoryQuarantineCandidate>(
  filter: MemorySessionQuarantineFilter | null,
  memories: readonly T[],
): { memories: T[]; summary?: MemoryWithheldSummary; withheldIds: string[] } {
  if (!filter || memories.length === 0) {
    return { memories: [...memories], withheldIds: [] };
  }
  const summary = createEmptyMemoryWithheldSummary();
  const withheldIds = new Set<string>();
  const filtered: T[] = [];
  const seenIds = new Set<string>();
  for (const memory of memories) {
    if (isMemoryQuarantined(filter, memory)) {
      if (!seenIds.has(memory.id)) {
        seenIds.add(memory.id);
        incrementMemoryWithheldReason(summary, 'session_quarantine.blocked');
        incrementMemoryWithheldRelevanceBand(
          summary,
          resolveMemoryWithheldRelevanceBand(memory.similarity),
        );
        withheldIds.add(memory.id);
      }
      continue;
    }
    filtered.push(memory);
  }
  return {
    memories: filtered,
    ...(summary.totalCount > 0 ? { summary } : {}),
    withheldIds: [...withheldIds],
  };
}

export function filterQuarantinedEpisodicChains(
  filter: MemorySessionQuarantineFilter | null,
  chains: readonly EpisodicRetrievalChain[],
): EpisodicRetrievalChain[] {
  if (!filter || chains.length === 0) {
    return chains.map(cloneEpisodicRetrievalChain);
  }
  return chains
    .filter(chain => !isEpisodicChainQuarantined(filter, chain))
    .map(cloneEpisodicRetrievalChain);
}

function getRetiredLogicalSessionIds(
  filter: MemorySessionQuarantineFilter | null,
): ReadonlySet<string> {
  return filter?.getRetiredLogicalSessionIds?.() ?? new Set<string>();
}

function referenceTargetsRetiredSession(
  filter: MemorySessionQuarantineFilter | null,
  reference: string | undefined,
): boolean {
  const normalized = reference?.trim();
  if (!normalized || !filter) return false;
  if (isRetiredSessionId(filter, normalized)) return true;
  for (const retiredId of getRetiredLogicalSessionIds(filter)) {
    const sessionId = retiredId.trim();
    if (!sessionId) continue;
    if (normalized === `session:${sessionId}`) return true;
    if (hasDelimitedSessionReference(normalized, sessionId)) return true;
  }
  return false;
}

function hasDelimitedSessionReference(reference: string, sessionId: string): boolean {
  const marker = `session:${sessionId}`;
  const index = reference.indexOf(marker);
  if (index < 0) return false;
  const before = index === 0 ? '' : reference[index - 1];
  const after = reference[index + marker.length] ?? '';
  const beforeDelimited = index === 0 || before === '|' || before === ',' || before === ' ' || before === '#';
  const afterDelimited = after === '' || after === '|' || after === ',' || after === ' ' || after === '#';
  return beforeDelimited && afterDelimited;
}

function isEpisodicChainQuarantined(
  filter: MemorySessionQuarantineFilter | null,
  chain: EpisodicRetrievalChain,
): boolean {
  for (const episode of chain.episodes) {
    if (episode.spanRefs.some(ref => isRetiredSessionId(filter, ref.sessionId))) return true;
    if (episode.provenanceRefs.some(ref => (
      ref.kind === 'session' && isRetiredSessionId(filter, ref.refId)
    ))) {
      return true;
    }
  }
  for (const arc of chain.arcs) {
    if (arc.spanRefs.some(ref => isRetiredSessionId(filter, ref.sessionId))) return true;
    if (arc.provenanceRefs.some(ref => (
      ref.kind === 'session' && isRetiredSessionId(filter, ref.refId)
    ))) {
      return true;
    }
  }
  return false;
}
