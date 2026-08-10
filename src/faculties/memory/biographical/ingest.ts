// ── Self-directed nickname evidence ingestion + change gate (o61vb.3) ──
//
// The candidate path for the companion self-nickname tracer. Self-directed
// nickname evidence (an observed nickname plus its source snapshots) becomes a
// validated, classified, digest-stable structured claim. Only registered
// structured candidates are emitted; the deterministic validator/classifier in
// the kernel rejects unknown kinds, malformed values, bad subject shapes, and
// invalid sources.
//
// A cheap deterministic CHANGE GATE runs before any synthesis call. When the
// evidence is already represented by an active claim with the same canonical
// claimDigest AND source-set digest, no synthesis runs and no new row is
// written. When the same normalized nickname re-appears over drifted sources,
// the prior claim is append-only superseded: the new source-set digest is
// distinct, so any publication grant bound to the prior digest no longer
// applies until the companion re-chooses.
//
// The synthesizer is pluggable so that a later ticket can wire an LLM
// extractor behind the SAME change gate (no LLM call when nothing changed).
// The default synthesizer is deterministic: it passes the structured nickname
// through, since self-nickname evidence already carries the exact value.

import type { SensitivityLevel } from '../../../system/trust/types.js';
import type {
  BiographicalClaim,
  BiographicalClaimSource,
  BiographicalSubjectRef,
} from './types.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import { computeClaimDigest, computeSourceSetDigest } from './kernel.js';
import { canonicalizeClaimValue } from './claim-kinds.js';
import { BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION, BIOGRAPHICAL_CLAIM_SCHEMA_VERSION } from './types.js';

/**
 * Self-directed nickname evidence observed for the companion. The nickname is
 * the exact structured value (not prose); the sources are the snapshots of the
 * private evidence the claim was reduced from. The raw sources never leave
 * their origin room; only this structured, digest-bound claim is portable.
 */
export interface SelfNicknameEvidence {
  readonly companionSubject: BiographicalSubjectRef;
  readonly nickname: string;
  readonly sources: readonly BiographicalClaimSource[];
  readonly confidence: number;
  readonly proposedSensitivity?: SensitivityLevel;
  readonly now?: Date;
}

/**
 * Result of a synthesis call. The default {@link deterministicSelfNicknameSynthesizer}
 * passes the evidence through; a later ticket can substitute an LLM extractor
 * that emits the same structured shape. Either way, only registered structured
 * candidates flow downstream.
 */
interface SynthesizedSelfNickname {
  readonly nickname: string;
  readonly confidence: number;
}

export type SelfNicknameSynthesizer = (evidence: SelfNicknameEvidence) => Promise<SynthesizedSelfNickname>;

/**
 * Default synthesizer: the evidence already carries the exact structured
 * nickname, so synthesis is the identity pass. This stands in for the LLM
 * extractor a later ticket wires behind the same change gate.
 */
export const deterministicSelfNicknameSynthesizer: SelfNicknameSynthesizer = async evidence => ({
  nickname: evidence.nickname,
  confidence: evidence.confidence,
});

/**
 * Deterministic candidate fingerprints the change gate compares against. They
 * are computed from the canonical structured value and the canonical ordered
 * source snapshots, independent of any synthesis wording, so semantically
 * identical re-extraction under the same versions is digest-stable.
 */
export interface SelfNicknameCandidateFingerprint {
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
}

export function selfNicknameCandidateFingerprint(
  evidence: SelfNicknameEvidence,
): SelfNicknameCandidateFingerprint {
  const value = canonicalizeClaimValue('nickname', {
    kind: 'nickname',
    nickname: evidence.nickname,
    scope: 'self',
  });
  const claimDigest = computeClaimDigest({
    schemaVersion: BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
    normalizerVersion: BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
    subject: evidence.companionSubject,
    kind: 'nickname',
    value,
  });
  const sourceSetDigest = computeSourceSetDigest(evidence.sources);
  return { claimDigest, sourceSetDigest };
}

type SelfNicknameIngestStatus = 'created' | 'unchanged' | 'superseded';

export interface SelfNicknameIngestResult {
  readonly claim: BiographicalClaim;
  readonly status: SelfNicknameIngestStatus;
  /** The previously-active claim this one append-only superseded, when status is `superseded`. */
  readonly superseded?: BiographicalClaim;
}

/**
 * Ingest self-directed nickname evidence under the deterministic change gate.
 *
 * Gate order (no synthesis call when the gate is closed):
 *   1. Compute the candidate fingerprint from the canonical evidence.
 *   2. List the companion's active self-nickname claims.
 *   3. If an active claim already has the same claimDigest AND source-set
 *      digest → `unchanged`: return it, run no synthesis, write nothing.
 *   4. If an active claim has the same claimDigest but a different source-set
 *      digest → the nickname recurred over drifted sources → run synthesis,
 *      then append-only supersede the prior claim. The new source-set digest
 *      is distinct, so a publication grant bound to the prior digest no longer
 *      applies.
 *   5. Otherwise → run synthesis and write a new active claim.
 *
 * The synthesizer is invoked ONLY when the gate is open (step 4 or 5), which is
 * the "no-change makes no LLM call" guarantee: a later LLM extractor wired here
 * is never called for unchanged evidence.
 */
export async function ingestSelfNicknameEvidence(input: {
  store: BiographicalProfileStorePort;
  evidence: SelfNicknameEvidence;
  synthesize?: SelfNicknameSynthesizer;
}): Promise<SelfNicknameIngestResult> {
  if (input.evidence.companionSubject.kind !== 'companion') {
    throw new Error('ingestSelfNicknameEvidence requires a companion self subject');
  }
  const fingerprint = selfNicknameCandidateFingerprint(input.evidence);

  const active = await input.store.listClaims({
    subject: input.evidence.companionSubject,
    kind: 'nickname',
    status: 'active',
  });

  // Step 3: identical claim + identical sources → no change, no synthesis.
  const identical = active.find(
    claim => claim.claimDigest === fingerprint.claimDigest
      && claim.sourceSetDigest === fingerprint.sourceSetDigest,
  );
  if (identical !== undefined) {
    return { claim: identical, status: 'unchanged' };
  }

  // Gate is open: synthesize (deterministic by default; an LLM extractor can be
  // wired here later under the SAME gate).
  const synthesizer = input.synthesize ?? deterministicSelfNicknameSynthesizer;
  const synthesized = await synthesizer(input.evidence);

  // Step 4: same nickname, drifted sources → append-only supersede.
  const priorSameNickname = active.find(
    claim => claim.claimDigest === fingerprint.claimDigest,
  );
  if (priorSameNickname !== undefined) {
    const { superseding, superseded } = await input.store.supersedeClaim({
      supersededClaimId: priorSameNickname.id,
      subject: input.evidence.companionSubject,
      kind: 'nickname',
      value: { kind: 'nickname', nickname: synthesized.nickname, scope: 'self' },
      basis: 'observed',
      ...(input.evidence.proposedSensitivity !== undefined
        ? { proposedSensitivity: input.evidence.proposedSensitivity }
        : {}),
      confidence: synthesized.confidence,
      sources: input.evidence.sources,
      ...(input.evidence.now !== undefined ? { now: input.evidence.now } : {}),
    });
    // The supersession row is created as a candidate; admit it to the active
    // profile so it replaces the prior active claim for this nickname.
    const activated = await input.store.transitionClaim({
      claimId: superseding.id,
      to: 'active',
      ...(input.evidence.now !== undefined ? { now: input.evidence.now } : {}),
    });
    return { claim: activated, status: 'superseded', superseded };
  }

  // Step 5: new nickname → new active claim.
  const claim = await input.store.writeClaim({
    subject: input.evidence.companionSubject,
    kind: 'nickname',
    value: { kind: 'nickname', nickname: synthesized.nickname, scope: 'self' },
    basis: 'observed',
    status: 'active',
    ...(input.evidence.proposedSensitivity !== undefined
      ? { proposedSensitivity: input.evidence.proposedSensitivity }
      : {}),
    confidence: synthesized.confidence,
    sources: input.evidence.sources,
    ...(input.evidence.now !== undefined ? { now: input.evidence.now } : {}),
  });
  return { claim, status: 'created' };
}
