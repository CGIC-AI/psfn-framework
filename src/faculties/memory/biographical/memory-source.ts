import { createHash } from 'node:crypto';

import type { MemoryStorePort } from '../memory-store-port.js';
import { createMemorySubjectEvidenceDigest } from '../subject-classification.js';
import type { SourceRevalidationOutcome } from './lifecycle.js';
import type { BiographicalClaimSource } from './types.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function memoryIdFromRef(ref: string): string | undefined {
  if (!ref.startsWith('memory:')) return undefined;
  const id = ref.slice('memory:'.length).trim();
  return id || undefined;
}

/** Build one exact source snapshot from the current canonical memory row. */
export async function resolveLiveBiographicalMemorySource(input: {
  memoryStore: MemoryStorePort;
  memoryId: string;
}): Promise<BiographicalClaimSource | undefined> {
  const [memory, classification] = await Promise.all([
    input.memoryStore.getById(input.memoryId),
    input.memoryStore.getMemorySubjectClassification(input.memoryId),
  ]);
  if (
    !memory
    || memory.deletedAt !== undefined
    || memory.supersededBy !== undefined
    || memory.consentFlags?.allowRecall === false
    || !classification
    || classification.status !== 'current'
  ) {
    return undefined;
  }
  return {
    ref: `memory:${memory.id}`,
    revision: String(classification.memoryRevision),
    evidenceDigest: createMemorySubjectEvidenceDigest(memory),
    sensitivityAtProjection: memory.sensitivity,
    subjectEvidenceDigest: classification.evidenceDigest,
    consentFingerprint: digest(memory.consentFlags ?? {}),
    ...(memory.provenance?.channelId
      ? { sourceChannelId: memory.provenance.channelId }
      : {}),
  };
}

/**
 * Production read-time revalidator for memory-backed claims. Unknown source
 * families fail closed; no legacy summary or cached effective sensitivity is
 * consulted.
 */
export class MemoryBackedBiographicalSourceRevalidator {
  constructor(private readonly memoryStore: MemoryStorePort) {}

  async revalidate(
    sources: readonly BiographicalClaimSource[],
    _now: Date,
  ): Promise<SourceRevalidationOutcome> {
    const currentSources: BiographicalClaimSource[] = [];
    for (const stored of sources) {
      const memoryId = memoryIdFromRef(stored.ref);
      if (!memoryId) return { status: 'invalid', reason: 'missing', sourceRef: stored.ref };
      const current = await resolveLiveBiographicalMemorySource({
        memoryStore: this.memoryStore,
        memoryId,
      });
      if (!current) return { status: 'invalid', reason: 'missing', sourceRef: stored.ref };
      currentSources.push(current);
    }
    return { status: 'valid', currentSources };
  }
}
