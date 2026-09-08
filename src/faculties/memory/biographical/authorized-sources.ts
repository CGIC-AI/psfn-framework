// ── Cross-silo authorized source collection (o61vb.12) ──
//
// The biography automaton mines evidence across sessions and rooms, so room
// visibility cannot be its collection boundary. The boundary here is instead
// the pair of gates the epic actually authorizes:
//
//   1. SUBJECT AUTHORIZATION, applied in SQL by the shared subject-authorized
//      memory proxy. A companion-self scan sees only `companion_private` rows;
//      a contact scan sees only that contact's `single_contact` rows. Neither
//      scan can observe another silo's rows at any sensitivity.
//   2. OWNER CANDIDATE POLICY, applied to every resolved snapshot BEFORE the
//      text is handed to a synthesizer. An excluded memory type, an excluded
//      lifecycle state, or a sensitivity above the owner ceiling is dropped
//      here, so an emotional/intimate/confidential body never reaches a prompt,
//      a candidate, or telemetry.
//
// This module is the only place raw rows are touched on the synthesis path. It
// returns admitted evidence and content-free counts, never the excluded rows.

import type { BiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import { createSubjectAuthorizedMemoryStore } from '../subject-authorized-store.js';
import type { MemorySubjectAccessContext } from '../subject-authorized-store.js';
import {
  biographicalCandidateSourceAdmission,
  type BiographicalCandidateSourceAdmission,
} from './candidate-state.js';
import {
  discoverLiveBiographicalMemoryEvidence,
  type LiveBiographicalMemoryEvidence,
} from './live-source-rebuild.js';
import type { BiographicalSubjectRef } from './types.js';

type BiographicalSourceWithholdReason = Exclude<
  BiographicalCandidateSourceAdmission,
  'admitted'
>;

export interface BiographicalSourceCollection {
  /** Sources the owner policy admits, bound to exact live canonical snapshots. */
  readonly evidence: readonly LiveBiographicalMemoryEvidence[];
  /** Rows the subject-authorized query returned, before owner-policy admission. */
  readonly scannedCount: number;
  /** Rows whose current subject no longer proves the exact canonical subject. */
  readonly unresolvedCount: number;
  /** Content-free withhold tally, keyed by the owner-policy rule that refused. */
  readonly withheldByPolicy: Readonly<Record<BiographicalSourceWithholdReason, number>>;
}

/**
 * The subject-authorized access context for one canonical biography subject.
 * A companion self scan is companion-internal process work and never carries a
 * viewer contact; a contact scan is scoped to that single canonical contact.
 */
function accessContextForSubject(subject: BiographicalSubjectRef): MemorySubjectAccessContext {
  return subject.kind === 'companion'
    ? { companionInternal: true }
    : { viewerContactId: subject.contactId };
}

function emptyWithheldTally(): Record<BiographicalSourceWithholdReason, number> {
  return { source_type_excluded: 0, lifecycle_excluded: 0, sensitivity_exceeded: 0 };
}

/**
 * Collect owner-policy-admitted biographical evidence for one canonical
 * subject, across every session and room the subject authorization covers.
 */
export async function collectAuthorizedBiographicalSources(input: {
  readonly memoryStore: MemoryStorePort;
  readonly subject: BiographicalSubjectRef;
  readonly policy: BiographicalCandidatePolicy;
  readonly scanLimit: number;
}): Promise<BiographicalSourceCollection> {
  if (!Number.isSafeInteger(input.scanLimit) || input.scanLimit < 1) {
    throw new Error('biography source scan limit must be a positive safe integer');
  }
  const authorized = createSubjectAuthorizedMemoryStore(
    input.memoryStore,
    accessContextForSubject(input.subject),
  );
  // One listing primitive for both subject kinds. The proxy resolves it to a
  // `queryAuthorizedMemorySubjects` list whose authorization predicate runs in
  // the same SQL statement, so the companion silo and a contact silo are
  // separated by the query itself rather than by a post-fetch filter.
  const rows = await authorized.listActiveMemories({ limit: input.scanLimit });
  // Exact canonical subject proof plus a live source snapshot. A row whose
  // current classification no longer resolves to this subject is dropped before
  // owner policy even runs.
  const discovered = await discoverLiveBiographicalMemoryEvidence({
    memoryStore: authorized,
    memoryIds: rows.map(memory => memory.id),
    subject: input.subject,
  });
  const withheldByPolicy = emptyWithheldTally();
  const evidence: LiveBiographicalMemoryEvidence[] = [];
  for (const candidate of discovered) {
    const admission = biographicalCandidateSourceAdmission(candidate.source, input.policy);
    if (admission === 'admitted') {
      evidence.push(candidate);
      continue;
    }
    withheldByPolicy[admission] += 1;
  }
  return {
    evidence,
    scannedCount: rows.length,
    unresolvedCount: rows.length - discovered.length,
    withheldByPolicy,
  };
}
