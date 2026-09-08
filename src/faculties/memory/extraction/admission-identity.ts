// ── Extraction-source admission identity (psfn-framework-ccgdz.3) ──
//
// Maps session-entry ids to the intake-envelope snapshots persisted on their
// `intakeScreening` metadata (htm9.2). Two consumers share this ONE parse:
//
//  - the memory_write sink gate (`fact-acceptance.ts`, htm9.3), which decides
//    whether a fact derived from those envelopes may be written at all; and
//  - the derived-memory admission provenance (`write-execution.ts`, ccgdz.3),
//    which records WHICH admitted bytes the written memory came from.
//
// Keeping them on one index is what makes the gate decision and the recorded
// provenance describe the same set of source bytes, instead of two scans that
// can drift apart.
//
// Malformed screening metadata is unknowable admission state: it is tracked per
// entry, never treated as "no envelopes". The gate fails closed on it in
// enforce mode; the provenance side simply records no identity for it, which
// classifies descendants as `uncertain` rather than clean.

import { createComponentLogger } from '../../../shared/logger.js';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  INTAKE_SCREENING_METADATA_KEY,
  parseIntakeScreeningMetadata,
} from '../../../core/session/intake-screening-metadata.js';
import type { IntakeEnvelopeSnapshot } from '../../../shared/contracts/intake-envelope.js';
import type { CogSecStructuredProvenanceRef } from '../../../shared/contracts/provenance-ref.js';

const log = createComponentLogger('Extraction');

/** Structured-ref kind for an intake envelope that admitted source bytes. */
const INTAKE_ENVELOPE_PROVENANCE_REF_KIND = 'intake_envelope';

export interface ExtractionAdmissionIndex {
  envelopesByEntryId: Map<number, readonly IntakeEnvelopeSnapshot[]>;
  malformedEntryIds: Set<number>;
  allEnvelopes: IntakeEnvelopeSnapshot[];
}

export function buildExtractionAdmissionIndex(
  entries: readonly SessionEntry[],
  channelId: string,
): ExtractionAdmissionIndex {
  const index: ExtractionAdmissionIndex = {
    envelopesByEntryId: new Map(),
    malformedEntryIds: new Set(),
    allEnvelopes: [],
  };
  const marker = `"${INTAKE_SCREENING_METADATA_KEY}"`;
  for (const entry of entries) {
    if (!entry.metadata || !entry.metadata.includes(marker)) continue;
    try {
      const screening = parseIntakeScreeningMetadata(entry.metadata);
      if (!screening) continue;
      index.envelopesByEntryId.set(entry.id, screening.envelopes);
      index.allEnvelopes.push(...screening.envelopes);
    } catch (error) {
      // The index now serves BOTH the sink gate and the admission provenance,
      // so the consequence is stated by consequence, not by assuming a gate:
      // the gate (when wired) fails this entry closed in enforce mode, and the
      // provenance side records no identity for it.
      log.error('Malformed intake screening metadata on extraction source entry; unknowable admission state (gate-denied in enforce mode, no recorded admission identity)', {
        channelId,
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
      index.malformedEntryIds.add(entry.id);
    }
  }
  return index;
}

/**
 * Envelopes covering one fact's source entries.
 *
 * An unattributed fact may derive from any entry in the window: it inherits
 * every envelope in the window (fail closed — derivation never launders
 * provenance away).
 */
export function resolveAdmissionEnvelopesForSource(
  index: ExtractionAdmissionIndex,
  sourceMessageIds: readonly number[] | undefined,
): { envelopes: readonly IntakeEnvelopeSnapshot[]; coversMalformedEntry: boolean } {
  if (sourceMessageIds && sourceMessageIds.length > 0) {
    const envelopes: IntakeEnvelopeSnapshot[] = [];
    let coversMalformedEntry = false;
    for (const id of sourceMessageIds) {
      envelopes.push(...(index.envelopesByEntryId.get(id) ?? []));
      if (index.malformedEntryIds.has(id)) coversMalformedEntry = true;
    }
    return { envelopes, coversMalformedEntry };
  }
  return {
    envelopes: index.allEnvelopes,
    coversMalformedEntry: index.malformedEntryIds.size > 0,
  };
}

/**
 * Project envelope snapshots onto the content-free structured refs a derived
 * artifact records as its admission identity.
 *
 * Quarantined and withheld envelopes are deliberately INCLUDED: a memory
 * derived from a message whose envelope was quarantined is exactly the
 * descendant a CogSec case must be able to reach.
 */
export function buildAdmissionProvenanceRefs(
  envelopes: readonly IntakeEnvelopeSnapshot[],
): CogSecStructuredProvenanceRef[] {
  const byEnvelopeId = new Map<string, CogSecStructuredProvenanceRef>();
  for (const snapshot of envelopes) {
    const envelopeId = snapshot.envelopeId.trim();
    if (!envelopeId) continue;
    const receiptId = snapshot.receiptId?.trim();
    const existing = byEnvelopeId.get(envelopeId);
    // A later snapshot for the same envelope may carry the receipt the earlier
    // one lacked (body vs attachment subjects). Never drop identity we have.
    if (existing && (existing.receiptId || !receiptId)) continue;
    byEnvelopeId.set(envelopeId, {
      kind: INTAKE_ENVELOPE_PROVENANCE_REF_KIND,
      refId: envelopeId,
      envelopeId,
      ...(receiptId ? { receiptId } : {}),
    });
  }
  return [...byEnvelopeId.values()];
}
