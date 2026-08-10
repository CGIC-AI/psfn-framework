// ── Biographical Profile projection: companion self-nickname tracer (o61vb.3) ──
//
// The deep projection module described in
// `working_docs/cross-channel-biographical-continuity-design.md` ("Deep
// projection module"). It owns storage access, read-time source revalidation,
// destination policy, deterministic rendering, ranking, and CogSec disclosure
// lineage construction behind one small interface. Rendering and lineage are
// produced together: if either cannot be produced for a claim, neither is
// admitted.
//
// This first tracer selects only companion-self `nickname` claims (`scope:
// 'self'`). Raw private memories never cross rooms; only independently
// validated, source-snapshot-bound, sensitivity-gated claims project, and only
// the exact nicknames the companion has chosen to publish (via an exact
// digest-bound grant) may appear in a public group. A companion may have zero,
// one, or many such nicknames; the system invents or auto-selects none.
//
// Everything fails closed: missing source data, missing companion publication
// choice, source/claim digest drift, or a destination that does not admit the
// claim's effective sensitivity withholds that projection. Withheld reasons are
// returned for operator inspection without leaking source bodies.

import type { ConversationScope } from '../../../core/session/conversation-scope.js';
import type {
  DisclosureDestination,
  DisclosureDestinationConstraint,
  DisclosureSourceContribution,
} from '../../../core/cogsec/disclosure/contracts.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import type {
  BiographicalClaim,
  BiographicalClaimSource,
  BiographicalSensitivityGrant,
  BiographicalSubjectRef,
  NicknameClaimValue,
} from './types.js';
import {
  applyLoweringGrant,
  computeAutomaticSensitivity,
  computeSourceSetDigest,
} from './kernel.js';
import type { BiographicalProfileStorePort } from './store-port.js';

// ── Source revalidation ──

/**
 * Read-time source revalidator. The projection does not trust the stored
 * effective-sensitivity cache: it re-resolves each source ref to its current
 * revision, evidence, subject-evidence, consent, and sensitivity, then
 * recomputes the source-set digest. A current digest that no longer matches
 * the digest a publication grant was bound to invalidates that grant, so the
 * claim reverts to its automatic sensitivity and is withheld from destinations
 * that require the grant.
 *
 * A revalidator that cannot prove a source is still present, recallable, and
 * at the projected revision returns `missing`, which withholds the claim and
 * queues a deterministic rebuild.
 */
export interface BiographicalSourceRevalidator {
  revalidate(
    sources: readonly BiographicalClaimSource[],
    now: Date,
  ): Promise<SourceRevalidationOutcome>;
}

export type SourceRevalidationOutcome =
  | { readonly status: 'valid'; readonly currentSources: readonly BiographicalClaimSource[] }
  | { readonly status: 'missing'; readonly missingRef: string; readonly detail: string };

// ── Destination policy ──

/**
 * The outward destination a turn resolves to, derived from the conversation
 * scope. A private group collapses to `companion_self` (the private sink): no
 * outward projection. Self-nicknames are never forced into a private group.
 */
export type BiographicalDestination = DisclosureDestination;

/**
 * Derive the destination a biographical claim would project into from the
 * conversation scope. Mirrors the disclosure population seam's session-history
 * rule: DM → that contact's DM, invite-only group → that room, public group →
 * that room, private group → companion-self (no outward destination).
 */
export function destinationFromScope(scope: ConversationScope): BiographicalDestination {
  if (scope.kind === 'dm') {
    return { kind: 'contact_dm', contactId: scope.contact.contactId };
  }
  if (scope.envelope.channelPrivacy === 'public') {
    return { kind: 'public_room', channelId: scope.channelId };
  }
  if (scope.envelope.channelPrivacy === 'invite_only') {
    return { kind: 'invite_only_room', channelId: scope.channelId };
  }
  // Private group: the private sink. Nothing projects outward.
  return { kind: 'companion_self' };
}

/**
 * The disclosure constraint a claim projected into `destination` authorizes.
 * `companion_self` authorizes no outward destination (it is the always-eligible
 * private sink handled by the assessor).
 */
export function destinationConstraint(
  destination: BiographicalDestination,
): DisclosureDestinationConstraint | null {
  switch (destination.kind) {
    case 'public_room':
      return { kind: 'public_room', channelIds: [destination.channelId] };
    case 'invite_only_room':
      return { kind: 'invite_only_room', channelIds: [destination.channelId] };
    case 'contact_dm':
      return { kind: 'contact_dm', contactIds: [destination.contactId] };
    case 'publication':
      return { kind: 'publication' };
    case 'companion_self':
      return null;
  }
}

/**
 * Eligibility of a claim's effective sensitivity for `destination`, following
 * the design's destination behavior:
 *   - `public`    → eligible in any destination;
 *   - `personal`  → invite-only groups and DMs (where trust and channel privacy
 *                   admit personal content), never a public room or publication;
 *   - `intimate`/`confidential` → origin room only: a DM whose channel is the
 *                   claim's source channel. (Self-nicknames default to
 *                   `personal`, so this branch is an edge case here; the
 *                   relationship tracer and lifecycle hardening tighten it
 *                   further.)
 */
function effectiveEligibleInDestination(
  effective: SensitivityLevel,
  destination: BiographicalDestination,
  originChannelId: string | undefined,
  destinationChannelId: string | undefined,
): boolean {
  if (effective === 'public') return true;
  if (effective === 'personal') {
    return destination.kind === 'invite_only_room' || destination.kind === 'contact_dm';
  }
  // intimate | confidential: origin room only.
  return destination.kind === 'contact_dm'
    && originChannelId !== undefined
    && originChannelId === destinationChannelId;
}

// ── Turn context and result ──

/**
 * Verified turn inputs the projection consumes. `companionSubject` is the
 * canonical companion self subject; the conversation scope fixes the
 * destination and its disclosure ceiling. `tokenBudget` and `estimateTokens`
 * are optional prompt-economy controls: when both are present, the lowest-
 * priority admitted claims are deterministically omitted.
 */
export interface TurnBiographicalContext {
  readonly companionSubject: BiographicalSubjectRef;
  readonly conversationScope: ConversationScope;
  readonly tokenBudget?: number;
  readonly estimateTokens?: (text: string) => number;
  readonly now?: Date;
}

type BiographicalWithheldReason =
  | 'status-inactive'
  | 'source-missing'
  | 'source-drift'
  | 'no-publication-choice'
  | 'destination-disallowed'
  | 'token-budget-exhausted';

interface BiographicalWithheldEntry {
  readonly claimId: string;
  readonly reason: BiographicalWithheldReason;
  readonly detail: string;
}

export interface BiographicalProjectionResult {
  readonly promptSection: string;
  readonly disclosureSources: readonly DisclosureSourceContribution[];
  readonly admittedClaimIds: readonly string[];
  readonly withheld: readonly BiographicalWithheldEntry[];
}

// ── Deterministic rendering ──

function normalizeForOrder(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Fixed heading for the companion self-shape section. Centralized so prompt
 * rendering and token-budget estimation count the same framing. */
function selfNicknameSectionHeader(): string {
  return '## Companion self-shape\nSelf-nicknames the companion has approved for this audience; she may recognize them when addressed by them:';
}

/**
 * Deterministic self-nickname ordering: normalized nickname ascending, then
 * claim digest ascending as a stable tiebreaker. There is no canonical
 * selection: every approved nickname renders, in this fixed order.
 */
function compareSelfNicknameClaims(left: BiographicalClaim, right: BiographicalClaim): number {
  const leftNickname = normalizeForOrder((left.value as NicknameClaimValue).nickname);
  const rightNickname = normalizeForOrder((right.value as NicknameClaimValue).nickname);
  if (leftNickname !== rightNickname) return leftNickname < rightNickname ? -1 : 1;
  return left.claimDigest < right.claimDigest ? -1 : left.claimDigest > right.claimDigest ? 1 : 0;
}

/**
 * Render the companion self-shape prompt section from admitted claims. Pure and
 * deterministic: only the canonical structured nickname strings appear, never
 * source text or audit rationale. Returns the empty string when nothing is
 * admitted so callers add no empty heading.
 */
export function renderSelfNicknameSection(admitted: readonly BiographicalClaim[]): string {
  if (admitted.length === 0) return '';
  const sorted = [...admitted].sort(compareSelfNicknameClaims);
  const lines = sorted.map(claim => `- ${(claim.value as NicknameClaimValue).nickname}`);
  return [selfNicknameSectionHeader(), ...lines].join('\n') + '\n';
}

// ── Publication-grant detection ──

/**
 * Whether a non-revoked, currently-temporally-valid grant exists in `grants`
 * that lowers a claim to `public`. Used to distinguish "the companion never
 * chose to publish this nickname" (`no-publication-choice`) from "she chose,
 * but source drift invalidated the bound grant" (`source-drift`).
 */
function hasActivePublicationGrant(
  grants: readonly BiographicalSensitivityGrant[],
  nowMs: number,
): boolean {
  return grants.some(grant => {
    if (grant.revokedAt !== undefined) return false;
    if (Date.parse(grant.grantedAt) > nowMs) return false;
    if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= nowMs) return false;
    return grant.grantedSensitivity === 'public';
  });
}

// ── Deep projection ──

export interface BiographicalProjectionDeps {
  readonly store: BiographicalProfileStorePort;
  readonly revalidator: BiographicalSourceRevalidator;
}

interface AdmittedClaim {
  readonly claim: BiographicalClaim;
  /** Recomputed effective sensitivity (from current sources + applicable grant). */
  readonly effectiveSensitivity: SensitivityLevel;
  /** Publication grant actually authorizing this projection (against current sources). */
  readonly appliedGrantId?: string;
}

/**
 * Project companion self-nickname claims for a turn.
 *
 * Selection: active companion-self `nickname` claims with `scope: 'self'`.
 * Each is source-revalidated at read time; the source-set digest is recomputed
 * from the CURRENT sources so any drift invalidates a publication grant bound
 * to the prior digest. A claim projects into the turn's destination only when
 * its recomputed effective sensitivity is eligible there. Every admitted claim
 * contributes a disclosure source bound to the exact destination, with claim,
 * grant, and source provenance refs. Rendering and lineage are atomic per
 * claim: a claim appears in the prompt section iff it appears in lineage.
 */
export async function projectBiographicalContext(
  deps: BiographicalProjectionDeps,
  turn: TurnBiographicalContext,
): Promise<BiographicalProjectionResult> {
  if (turn.companionSubject.kind !== 'companion') {
    throw new Error('projectBiographicalContext requires a companion self subject');
  }
  const now = turn.now ?? new Date();
  const nowMs = now.getTime();
  const destination = destinationFromScope(turn.conversationScope);
  // The private sink (a private group, or no outward audience) has no outward
  // destination for cross-room recognition: the projection is inert there and
  // the companion's raw self-knowledge remains available through the ordinary
  // memory path.
  if (destination.kind === 'companion_self') {
    return { promptSection: '', disclosureSources: [], admittedClaimIds: [], withheld: [] };
  }
  const destinationChannelId = turn.conversationScope.channelId;

  const candidates = await deps.store.listClaims({
    subject: turn.companionSubject,
    kind: 'nickname',
    status: 'active',
  });

  const admitted: AdmittedClaim[] = [];
  const withheld: BiographicalWithheldEntry[] = [];

  for (const claim of candidates) {
    const value = claim.value as NicknameClaimValue;
    if (value.scope !== 'self') {
      // Relational nicknames are the current-author relationship tracer
      // (o61vb.4); the self-nickname tracer does not select them.
      continue;
    }

    // Read-time source revalidation. Missing source data fails closed.
    const revalidation = await deps.revalidator.revalidate(claim.sources, now);
    if (revalidation.status === 'missing') {
      withheld.push({
        claimId: claim.id,
        reason: 'source-missing',
        detail: `source ${revalidation.missingRef} is missing or no longer recallable: ${revalidation.detail}`,
      });
      continue;
    }
    const currentSources = revalidation.currentSources;

    // Recompute the source-set digest and automatic sensitivity from CURRENT
    // sources. A drifted source set yields a different digest, so a publication
    // grant bound to the prior source-set digest no longer matches and the
    // claim reverts to its automatic sensitivity.
    const currentSourceSetDigest = computeSourceSetDigest(currentSources);
    const drifted = currentSourceSetDigest !== claim.sourceSetDigest;
    const { sensitivity: automaticSensitivity } = computeAutomaticSensitivity({
      kind: claim.kind,
      proposedSensitivity: claim.proposedSensitivity,
      sources: currentSources,
      now,
    });
    const grants = await deps.store.listGrantsForClaim(claim.id);
    const { effectiveSensitivity, appliedGrant } = applyLoweringGrant({
      claimDigest: claim.claimDigest,
      sourceSetDigest: currentSourceSetDigest,
      automaticSensitivity,
      grants,
      now,
    });

    const originChannelId = currentSources[0]?.sourceChannelId;
    const eligible = effectiveEligibleInDestination(
      effectiveSensitivity,
      destination,
      originChannelId,
      destinationChannelId,
    );

    if (!eligible) {
      withheld.push(
        withholdReasonFor(claim, drifted, grants, effectiveSensitivity, automaticSensitivity, nowMs),
      );
      continue;
    }

    // Atomic admit: a claim in the prompt section has a matching disclosure
    // contribution on the same result, and vice versa.
    admitted.push({
      claim,
      effectiveSensitivity,
      ...(appliedGrant !== undefined ? { appliedGrantId: appliedGrant.id } : {}),
    });
  }

  // Deterministic order, then optional prompt-economy trimming.
  admitted.sort((left, right) => compareSelfNicknameClaims(left.claim, right.claim));
  const { admitted: budgeted, trimmed } = applyTokenBudget(admitted, turn);

  for (const entry of trimmed) {
    withheld.push({
      claimId: entry.claim.id,
      reason: 'token-budget-exhausted',
      detail: 'omitted as the lowest-priority claim after the prompt token budget was reached',
    });
  }

  const promptSection = renderSelfNicknameSection(budgeted.map(entry => entry.claim));
  const disclosureSources = budgeted.map(entry =>
    claimDisclosureContribution(entry, destination),
  );

  return {
    promptSection,
    disclosureSources,
    admittedClaimIds: budgeted.map(entry => entry.claim.id),
    withheld,
  };
}

function withholdReasonFor(
  claim: BiographicalClaim,
  drifted: boolean,
  grants: readonly BiographicalSensitivityGrant[],
  effective: SensitivityLevel,
  automatic: SensitivityLevel,
  nowMs: number,
): BiographicalWithheldEntry {
  if (drifted && hasActivePublicationGrant(grants, nowMs)) {
    return {
      claimId: claim.id,
      reason: 'source-drift',
      detail: 'source-set digest drifted from the digest the publication grant was bound to; the grant no longer applies',
    };
  }
  if (!hasActivePublicationGrant(grants, nowMs)) {
    return {
      claimId: claim.id,
      reason: 'no-publication-choice',
      detail: 'the companion has not recorded an exact publication choice lowering this nickname to public',
    };
  }
  return {
    claimId: claim.id,
    reason: 'destination-disallowed',
    detail: `effective sensitivity ${effective} (automatic ${automatic}) is not admissible in this destination`,
  };
}

function applyTokenBudget(
  admitted: readonly AdmittedClaim[],
  turn: TurnBiographicalContext,
): { admitted: AdmittedClaim[]; trimmed: AdmittedClaim[] } {
  if (turn.tokenBudget === undefined || turn.estimateTokens === undefined) {
    return { admitted: [...admitted], trimmed: [] };
  }
  const budget = turn.tokenBudget;
  const estimate = turn.estimateTokens;
  // Count the section framing once so a budget of zero admits nothing rather
  // than a heading with no nicknames.
  let running = estimate(`${selfNicknameSectionHeader()}\n`);
  const kept: AdmittedClaim[] = [];
  const trimmed: AdmittedClaim[] = [];
  let budgetExceeded = false;
  for (const entry of admitted) {
    if (budgetExceeded) {
      trimmed.push(entry);
      continue;
    }
    const marginal = estimate(`- ${(entry.claim.value as NicknameClaimValue).nickname}\n`);
    if (running + marginal > budget) {
      budgetExceeded = true;
      trimmed.push(entry);
      continue;
    }
    running += marginal;
    kept.push(entry);
  }
  return { admitted: kept, trimmed };
}

/**
 * Build the CogSec disclosure contribution for one admitted claim. The
 * contribution carries the claim's effective sensitivity, the destination it
 * projects into, and provenance refs for the claim, the applied publication
 * grant, and every source — never the source bodies.
 */
function claimDisclosureContribution(
  entry: AdmittedClaim,
  destination: BiographicalDestination,
): DisclosureSourceContribution {
  const claim = entry.claim;
  const constraint = destinationConstraint(destination);
  const provenanceRefs: string[] = [`biographical-claim:${claim.id}`];
  if (entry.appliedGrantId !== undefined) {
    provenanceRefs.push(`biographical-grant:${entry.appliedGrantId}`);
  }
  for (const source of claim.sources) {
    provenanceRefs.push(source.ref);
  }
  return {
    ref: `biographical:${claim.id}`,
    sensitivity: entry.effectiveSensitivity,
    permittedDestinations: constraint === null ? [] : [constraint],
    provenanceRefs,
    classified: true,
  };
}
