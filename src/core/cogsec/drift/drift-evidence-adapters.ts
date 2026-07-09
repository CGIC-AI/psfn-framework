// ── Slow-poisoning detection: evidence adapters (htm9.14) ──
//
// Binds the DriftVelocityEvidencePort to the stores that ALREADY persist the
// evidence — no new runtime writes, no new classifiers, pure reads:
//
//  - valence trajectory: the per-contact emotional time series the memory
//    extractor already maintains (ContactStorePort.getEmotionalTimeSeries);
//  - memory-write events: persisted memory rows attributed to the contact
//    (extractedAt epoch ms);
//  - risk-label events: intake quarantine entries carrying envelope risk
//    labels keyed by canonical contact id (the durable label journal today);
//  - retrieval summary: lastAccessed recency over active memories.

import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { IntakeQuarantineStore } from '../intake/quarantine-store.js';
import type {
  DriftContactRef,
  DriftRetrievalAccessSummary,
  DriftVelocityEvidencePort,
} from './drift-review-lane.js';
import type {
  DriftMemoryWriteEvent,
  DriftRiskLabelEvent,
  DriftValencePoint,
} from './drift-signals.js';

/** Hard cap on the contact valence series (the store retains at most 64). */
const VALENCE_SERIES_LIMIT = 64;

/**
 * Per-contact memory scan depth. getMemoriesByContact returns a salience-
 * ordered slice, not a chronological one, so this must comfortably exceed any
 * plausible per-contact write volume inside the drift horizon; rows outside
 * the horizon are filtered out after the fetch.
 */
const MEMORY_SCAN_LIMIT = 512;

/**
 * Active-memory scan depth for the retrieval summary. A nightly aggregate
 * over the working set; deterministic and bounded rather than unbounded.
 */
const RETRIEVAL_SCAN_LIMIT = 4096;

export type DriftEvidenceContactStore = Pick<ContactStorePort, 'listAll' | 'getEmotionalTimeSeries'>;
export type DriftEvidenceMemoryStore = Pick<MemoryStorePort, 'getMemoriesByContact' | 'getAllActiveMemories'>;
export type DriftEvidenceQuarantineStore = Pick<IntakeQuarantineStore, 'list'>;

export interface DriftVelocityEvidenceAdapterOptions {
  contactStore: DriftEvidenceContactStore;
  memoryStore: DriftEvidenceMemoryStore;
  /**
   * Null when the intake firewall is off: the label-frequency signal then
   * evaluates over zero events (and cannot trigger), which is the correct
   * conservative posture rather than a synthesized substitute.
   */
  quarantineStore: DriftEvidenceQuarantineStore | null;
}

export function createDriftVelocityEvidencePort(
  options: DriftVelocityEvidenceAdapterOptions,
): DriftVelocityEvidencePort {
  const { contactStore, memoryStore, quarantineStore } = options;
  return {
    async listContacts(): Promise<DriftContactRef[]> {
      const contacts = await contactStore.listAll();
      return contacts.map((contact) => ({
        id: contact.id,
        displayName: contact.displayName,
        trustLevel: contact.trustLevel,
      }));
    },

    async getValenceSeries(contactId: string): Promise<DriftValencePoint[]> {
      const series = await contactStore.getEmotionalTimeSeries(contactId, VALENCE_SERIES_LIMIT);
      return series.map((point) => ({
        valence: point.valence,
        confidence: point.confidence,
        observedAtMs: point.observedAtMs,
      }));
    },

    async listMemoryWrites(contactId: string, sinceMs: number): Promise<DriftMemoryWriteEvent[]> {
      const memories = await memoryStore.getMemoriesByContact(contactId, MEMORY_SCAN_LIMIT);
      return memories
        .filter((memory) => Number.isFinite(memory.extractedAt) && memory.extractedAt >= sinceMs)
        .map((memory) => ({ extractedAtMs: memory.extractedAt }));
    },

    async listRiskLabelEvents(contactId: string, sinceMs: number): Promise<DriftRiskLabelEvent[]> {
      if (!quarantineStore) return [];
      const events: DriftRiskLabelEvent[] = [];
      for (const entry of quarantineStore.list()) {
        if (entry.canonicalContactId !== contactId) continue;
        if (entry.heldAtMs < sinceMs) continue;
        for (const label of entry.envelope.riskLabels) {
          events.push({ label, observedAtMs: entry.heldAtMs });
        }
      }
      return events;
    },

    async getRetrievalAccessSummary(sinceMs: number): Promise<DriftRetrievalAccessSummary> {
      const memories = await memoryStore.getAllActiveMemories(RETRIEVAL_SCAN_LIMIT);
      let totalRetrievedCount = 0;
      const retrievedCountByContactId = new Map<string, number>();
      for (const memory of memories) {
        if (!Number.isFinite(memory.lastAccessed) || memory.lastAccessed < sinceMs) continue;
        if (memory.accessCount <= 0) continue;
        totalRetrievedCount += 1;
        if (memory.contactId) {
          retrievedCountByContactId.set(
            memory.contactId,
            (retrievedCountByContactId.get(memory.contactId) ?? 0) + 1,
          );
        }
      }
      return { totalRetrievedCount, retrievedCountByContactId };
    },
  };
}
