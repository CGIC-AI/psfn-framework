import { hasExactKeys, isRecord } from '../../../shared/utils/types.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import { BiographicalClaimValidationError } from './claim-kinds.js';
import { admitBiographicalCandidate } from './conflict-policy.js';
import { resolveLiveBiographicalMemorySource } from './memory-source.js';
import { parsePortableStableCandidate } from './stable-candidate.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import type {
  BiographicalClaimSource,
  BiographicalCollectionDepth,
  BiographicalSubjectRef,
} from './types.js';

export interface LiveBiographicalMemoryEvidence {
  readonly memory: PurrMemory;
  readonly source: BiographicalClaimSource;
}

interface LiveSourceRebuildWithheld {
  readonly candidateIndex: number;
  readonly reason: 'candidate_limit' | 'malformed_candidate' | 'source_mismatch' | 'source_drift';
}

export interface LiveSourceRebuildResult {
  readonly emittedCount: number;
  readonly admittedClaimIds: readonly string[];
  readonly withheld: readonly LiveSourceRebuildWithheld[];
}

function exactSubjectMatch(
  subject: BiographicalSubjectRef,
  classification: Awaited<ReturnType<MemoryStorePort['getMemorySubjectClassification']>>,
): boolean {
  if (!classification || classification.status !== 'current') return false;
  if (subject.kind === 'companion') {
    return classification.subjectClass === 'companion_private';
  }
  return classification.subjectClass === 'single_contact'
    && classification.subjectContactIds.length === 1
    && classification.subjectContactIds[0] === subject.contactId;
}

/**
 * Discover claim-eligible evidence before synthesis. The LLM never sees a
 * legacy summary and never receives a memory whose current subject cannot be
 * proven to match the exact canonical claim subject.
 */
export async function discoverLiveBiographicalMemoryEvidence(input: {
  readonly memoryStore: MemoryStorePort;
  readonly memoryIds: readonly string[];
  readonly subject: BiographicalSubjectRef;
}): Promise<LiveBiographicalMemoryEvidence[]> {
  const result: LiveBiographicalMemoryEvidence[] = [];
  for (const memoryId of [...new Set(input.memoryIds.map(id => id.trim()).filter(Boolean))]) {
    const [memory, classification, source] = await Promise.all([
      input.memoryStore.getById(memoryId),
      input.memoryStore.getMemorySubjectClassification(memoryId),
      resolveLiveBiographicalMemorySource({ memoryStore: input.memoryStore, memoryId }),
    ]);
    if (!memory || !source || !exactSubjectMatch(input.subject, classification)) continue;
    result.push({ memory, source });
  }
  return result;
}

function candidateRecords(responseContent: string): unknown[] | undefined {
  const body = responseContent
    .match(/<biographical_candidates>([\s\S]*?)<\/biographical_candidates>/iu)?.[1]
    ?.trim();
  if (!body) return [];
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sourceMemoryIds(candidate: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(candidate.sourceMemoryIds) || candidate.sourceMemoryIds.length === 0) {
    return undefined;
  }
  const ids = candidate.sourceMemoryIds;
  if (!ids.every(id => typeof id === 'string' && id.trim().length > 0)) return undefined;
  const normalized = ids.map(id => (id as string).trim());
  return new Set(normalized).size === normalized.length ? normalized : undefined;
}

function candidateHasExactShape(candidate: Record<string, unknown>): boolean {
  return hasExactKeys(
    candidate,
    ['kind', 'value', 'basis', 'confidence', 'sourceMemoryIds'],
    ['proposedSensitivity', 'validFrom', 'validTo'],
  );
}

/**
 * Admit portable claims only from structured candidates bound to exact live
 * canonical sources. Subject, dyad, source snapshots, lifecycle status and
 * depth are runtime-owned; model output cannot select any of them.
 */
export async function rebuildBiographicalClaimsFromLiveSources(input: {
  readonly responseContent: string;
  readonly memoryStore: MemoryStorePort;
  readonly profileStore: BiographicalProfileStorePort;
  readonly subject: BiographicalSubjectRef;
  readonly companionSubject: Extract<BiographicalSubjectRef, { kind: 'companion' }>;
  readonly availableEvidence: readonly LiveBiographicalMemoryEvidence[];
  readonly depth: BiographicalCollectionDepth;
  readonly candidateLimit: number;
  readonly now?: Date;
}): Promise<LiveSourceRebuildResult> {
  const records = candidateRecords(input.responseContent);
  if (records === undefined) {
    return {
      emittedCount: 1,
      admittedClaimIds: [],
      withheld: [{ candidateIndex: 0, reason: 'malformed_candidate' }],
    };
  }
  const admittedClaimIds: string[] = [];
  const withheld: LiveSourceRebuildWithheld[] = [];
  const availableById = new Map(
    input.availableEvidence.map(evidence => [evidence.memory.id, evidence]),
  );
  const bounded = records.slice(0, input.candidateLimit);
  for (let index = bounded.length; index < records.length; index += 1) {
    withheld.push({ candidateIndex: index, reason: 'candidate_limit' });
  }

  for (const [candidateIndex, rawCandidate] of bounded.entries()) {
    if (!isRecord(rawCandidate) || !candidateHasExactShape(rawCandidate)) {
      withheld.push({ candidateIndex, reason: 'malformed_candidate' });
      continue;
    }
    const ids = sourceMemoryIds(rawCandidate);
    if (!ids || ids.some(id => !availableById.has(id))) {
      withheld.push({ candidateIndex, reason: 'source_mismatch' });
      continue;
    }
    const currentSources: BiographicalClaimSource[] = [];
    let drifted = false;
    for (const memoryId of ids) {
      const current = await discoverLiveBiographicalMemoryEvidence({
        memoryStore: input.memoryStore,
        memoryIds: [memoryId],
        subject: input.subject,
      });
      const exact = current[0];
      const discovered = availableById.get(memoryId);
      if (!exact || !discovered || exact.source.evidenceDigest !== discovered.source.evidenceDigest
        || exact.source.subjectEvidenceDigest !== discovered.source.subjectEvidenceDigest
        || exact.source.revision !== discovered.source.revision) {
        drifted = true;
        break;
      }
      currentSources.push(exact.source);
    }
    if (drifted) {
      withheld.push({ candidateIndex, reason: 'source_drift' });
      continue;
    }

    let parsed: ReturnType<typeof parsePortableStableCandidate>;
    try {
      parsed = parsePortableStableCandidate({
        subject: input.subject,
        ...(rawCandidate.kind === 'shared-language'
          ? { relatedSubject: input.companionSubject }
          : {}),
        kind: rawCandidate.kind,
        value: rawCandidate.value,
        basis: rawCandidate.basis,
        ...(rawCandidate.proposedSensitivity !== undefined
          ? { proposedSensitivity: rawCandidate.proposedSensitivity }
          : {}),
        confidence: rawCandidate.confidence,
        sources: currentSources,
        ...(rawCandidate.validFrom !== undefined ? { validFrom: rawCandidate.validFrom } : {}),
        ...(rawCandidate.validTo !== undefined ? { validTo: rawCandidate.validTo } : {}),
        depthDecision: input.depth,
      }, input.now ? { now: input.now } : {});
    } catch (error) {
      if (!(error instanceof BiographicalClaimValidationError)) throw error;
      withheld.push({ candidateIndex, reason: 'malformed_candidate' });
      continue;
    }
    const admitted = await admitBiographicalCandidate({
      store: input.profileStore,
      candidate: parsed,
    });
    admittedClaimIds.push(admitted.claim.id);
  }
  return {
    emittedCount: records.length,
    admittedClaimIds,
    withheld,
  };
}
