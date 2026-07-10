// ── Second-arrow detection: evidence adapters (htm9.15) ──
//
// Binds the SecondArrowEvidencePort to the stores that ALREADY persist the
// evidence — no new runtime writes, no re-embedding, no classifiers, pure
// reads:
//
//  - memory writes with STORED embeddings: the pgvector column every write
//    persists (MemoryStorePort.listActiveMemoryEmbeddingsSince);
//  - active concerns: the intention concern store, for concern-loop linkage;
//  - affect series: the per-contact emotional time series the extractor
//    already maintains (the only persisted affect time series today);
//  - near-duplicate maintenance reviews: the writer's own merge-candidate
//    flags, counted as dedup-gap evidence on the card.

import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { ConcernStorePort } from '../../intention/concern-store-port.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { SecondArrowEvidencePort } from './second-arrow-review-lane.js';
import type {
  SecondArrowAffectPoint,
  SecondArrowConcernSample,
  SecondArrowMemoryWriteSample,
} from './second-arrow-signals.js';

/** Hard cap on the contact valence series (the store retains at most 64). */
const VALENCE_SERIES_LIMIT = 64;

/**
 * Windowed embedding scan depth. The horizon is windowHours + baseline days;
 * this bounds a pathological write flood, deterministic rather than unbounded
 * (oldest-first, so a hit on the cap truncates the NEWEST writes — the scan
 * degrades toward silence, never toward false positives on partial data).
 */
const MEMORY_EMBEDDING_SCAN_LIMIT = 4096;

/** Bounded scan of persisted near-duplicate maintenance reviews. */
const NEAR_DUPLICATE_REVIEW_SCAN_LIMIT = 1024;

export type SecondArrowEvidenceMemoryStore = Pick<
  MemoryStorePort,
  'listActiveMemoryEmbeddingsSince' | 'listMemoryMaintenanceReviews'
>;
export type SecondArrowEvidenceContactStore = Pick<ContactStorePort, 'getEmotionalTimeSeries'>;
export type SecondArrowEvidenceConcernStore = Pick<ConcernStorePort, 'getActiveConcerns'>;

export interface SecondArrowEvidenceAdapterOptions {
  memoryStore: SecondArrowEvidenceMemoryStore;
  contactStore: SecondArrowEvidenceContactStore;
  /**
   * Null when no concern store is wired: the concern-loop signal then
   * evaluates over zero concerns and reports insufficient evidence — the
   * correct conservative posture rather than a synthesized substitute.
   */
  concernStore: SecondArrowEvidenceConcernStore | null;
}

export function createSecondArrowEvidencePort(
  options: SecondArrowEvidenceAdapterOptions,
): SecondArrowEvidencePort {
  const { memoryStore, contactStore, concernStore } = options;
  const listEmbeddings = memoryStore.listActiveMemoryEmbeddingsSince?.bind(memoryStore);
  if (!listEmbeddings) {
    // Fail closed at construction: without stored embeddings there is no
    // deterministic clustering substrate, and silently scanning nothing
    // would be a silent no-op detector.
    throw new Error(
      'Second-arrow evidence port requires a memory store with listActiveMemoryEmbeddingsSince '
      + '(stored-embedding reads); refusing to construct a detector that cannot see its evidence',
    );
  }

  return {
    async listRecentMemoryWrites(sinceMs: number): Promise<SecondArrowMemoryWriteSample[]> {
      const samples = await listEmbeddings(sinceMs, MEMORY_EMBEDDING_SCAN_LIMIT);
      return samples.map((sample) => ({
        id: sample.id,
        text: sample.text,
        type: sample.type,
        extractedAtMs: sample.extractedAt,
        ...(sample.contactId !== undefined ? { contactId: sample.contactId } : {}),
        ...(sample.sourceType !== undefined ? { sourceType: sample.sourceType } : {}),
        salience: sample.salience,
        embedding: Array.from(sample.embedding),
      }));
    },

    async listActiveConcerns(): Promise<SecondArrowConcernSample[]> {
      if (!concernStore) return [];
      const concerns = await concernStore.getActiveConcerns();
      return concerns.map((concern) => ({
        id: concern.id,
        text: concern.text,
        status: concern.status,
      }));
    },

    async getValenceSeries(contactId: string): Promise<SecondArrowAffectPoint[]> {
      const series = await contactStore.getEmotionalTimeSeries(contactId, VALENCE_SERIES_LIMIT);
      return series.map((point) => ({
        valence: point.valence,
        confidence: point.confidence,
        observedAtMs: point.observedAtMs,
      }));
    },

    async countNearDuplicateReviews(memberIds: readonly string[]): Promise<number> {
      const listReviews = memoryStore.listMemoryMaintenanceReviews?.bind(memoryStore);
      // Optional enrichment: a store without the maintenance-review surface
      // yields zero corroborating reviews, which only weakens the card's
      // dedup-gap evidence — it can never create a finding.
      if (!listReviews) return 0;
      const members = new Set(memberIds);
      const reviews = await listReviews({
        kind: 'near_duplicate',
        limit: NEAR_DUPLICATE_REVIEW_SCAN_LIMIT,
      });
      return reviews.filter((review) => (
        members.has(review.subjectMemoryId)
        || review.candidateMemoryIds.some((id) => members.has(id))
      )).length;
    },
  };
}
