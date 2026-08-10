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
import type { MessageAddressingMetadata } from '../../../shared/contracts/message-addressing.js';
import { evaluateMemoryPolicy } from '../../../system/trust/policy.js';
import type { SensitivityLevel, TrustLevel } from '../../../system/trust/types.js';
import type {
  BiographicalClaim,
  BiographicalClaimSource,
  BiographicalSensitivityGrant,
  BiographicalSubjectRef,
} from './types.js';
import {
  applyLoweringGrant,
  computeAutomaticSensitivity,
  computeSourceSetDigest,
} from './kernel.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import {
  resolveVerifiedCurrentAuthor,
  selectCurrentAuthorClaims,
  type CurrentAuthorResolution,
} from './current-author-selection.js';
import {
  presentBiographicalClaim,
  renderBiographicalPresentations,
  type BiographicalClaimPresentation,
} from './projection-rendering.js';
import {
  hasExplicitSubjectAddressing,
  selectExplicitSubjects,
  type CanonicalAddressedContactResolver,
  type ExplicitSubjectSelectionWithheld,
  type VerifiedExplicitSubject,
} from './explicit-subject-selection.js';

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
  /** Canonical author resolution performed at turn ingress. */
  readonly currentAuthor?: CurrentAuthorResolution;
  /** Transport-authoritative reply/mention metadata captured at ingress. */
  readonly messageAddressing?: MessageAddressingMetadata;
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
  | 'token-budget-exhausted'
  | 'participation-unproven'
  | 'explicit-resolver-unavailable'
  | ExplicitSubjectSelectionWithheld['reason'];

interface BiographicalWithheldEntry {
  readonly claimId?: string;
  readonly addressedParticipantId?: string;
  readonly reason: BiographicalWithheldReason;
  readonly detail: string;
}

export interface BiographicalProjectionResult {
  readonly promptSection: string;
  readonly disclosureSources: readonly DisclosureSourceContribution[];
  readonly admittedClaimIds: readonly string[];
  readonly withheld: readonly BiographicalWithheldEntry[];
}

/**
 * Render the companion self-shape prompt section from admitted claims. Pure and
 * deterministic: only the canonical structured nickname strings appear, never
 * source text or audit rationale. Returns the empty string when nothing is
 * admitted so callers add no empty heading.
 */
export function renderSelfNicknameSection(admitted: readonly BiographicalClaim[]): string {
  return renderBiographicalPresentations(
    admitted.flatMap(claim => {
      const presentation = presentBiographicalClaim(claim, 'companion-self');
      return presentation === undefined ? [] : [presentation];
    }),
  );
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
  /** Required to project explicit reply/mention subjects; absence fails closed. */
  readonly explicitAddressing?: {
    readonly resolver: CanonicalAddressedContactResolver;
    readonly maxSubjects: number;
  };
}

interface ProjectionPresentation {
  readonly claim: BiographicalClaim;
  readonly sectionKey: string;
  readonly header: string;
  readonly line: string;
  readonly sortKey: string;
}

interface AdmittedClaim {
  readonly claim: BiographicalClaim;
  readonly presentation: ProjectionPresentation;
  /** Recomputed effective sensitivity (from current sources + applicable grant). */
  readonly effectiveSensitivity: SensitivityLevel;
  /** Publication grant actually authorizing this projection (against current sources). */
  readonly appliedGrantId?: string;
  /** Authoritative current-participation proof used for a non-public explicit subject. */
  readonly participationProofRef?: string;
}

interface ProjectionCandidate {
  readonly claim: BiographicalClaim;
  readonly presentation: ProjectionPresentation;
  readonly audienceRole: 'companion-self' | 'current-author' | 'explicit-subject';
  readonly trustLevel?: TrustLevel;
  readonly currentParticipation?: VerifiedExplicitSubject['currentParticipation'];
}

function projectionPresentation(
  presentation: BiographicalClaimPresentation,
): ProjectionPresentation {
  return { ...presentation, sectionKey: presentation.section };
}

function presentExplicitSubjectClaim(
  claim: BiographicalClaim,
  subject: VerifiedExplicitSubject['subject'],
): ProjectionPresentation | undefined {
  const presentation = presentBiographicalClaim(claim, 'current-author');
  if (presentation === undefined) return undefined;
  return {
    claim,
    sectionKey: `explicit-subject:${subject.contactId}:${subject.subjectVersion}`,
    header: '## Explicitly relevant contact',
    line: presentation.line.replace(
      'The current author',
      'This explicitly addressed contact',
    ),
    sortKey: `explicit-subject:${subject.contactId}:${presentation.sortKey}`,
  };
}

function compareProjectionPresentations(
  left: ProjectionPresentation,
  right: ProjectionPresentation,
): number {
  if (left.sortKey !== right.sortKey) return left.sortKey < right.sortKey ? -1 : 1;
  return left.claim.claimDigest < right.claim.claimDigest
    ? -1
    : left.claim.claimDigest > right.claim.claimDigest ? 1 : 0;
}

function renderProjectionPresentations(
  presentations: readonly ProjectionPresentation[],
): string {
  if (presentations.length === 0) return '';
  const sorted = [...presentations].sort(compareProjectionPresentations);
  const lines: string[] = [];
  let sectionKey: string | undefined;
  for (const presentation of sorted) {
    if (presentation.sectionKey !== sectionKey) {
      lines.push(presentation.header);
      sectionKey = presentation.sectionKey;
    }
    lines.push(presentation.line);
  }
  return `${lines.join('\n')}\n`;
}

/** Project eligible companion-self and verified-current-author claims. Subject
 * selection, kind rendering, sensitivity admission, prompt construction, and
 * CogSec lineage stay behind this one interface; no caller can render a claim
 * without receiving its matching disclosure contribution. */
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

  const selfClaims = await deps.store.listClaims({
    subject: turn.companionSubject,
    kind: 'nickname',
    status: 'active',
  });
  const currentAuthor = resolveVerifiedCurrentAuthor(turn);
  const currentAuthorClaims = currentAuthor === undefined
    ? []
    : await selectCurrentAuthorClaims({
      store: deps.store,
      companionSubject: turn.companionSubject,
      currentAuthor,
    });
  const explicitSelection = deps.explicitAddressing === undefined
    ? {
      subjects: [],
      withheld: hasExplicitSubjectAddressing(turn.messageAddressing)
        ? [{
          reason: 'explicit-resolver-unavailable' as const,
          detail: 'explicit addressing cannot project without a canonical-contact resolver',
        }]
        : [],
    }
    : await selectExplicitSubjects({
      conversationScope: turn.conversationScope,
      messageAddressing: turn.messageAddressing,
      resolver: deps.explicitAddressing.resolver,
      maxSubjects: deps.explicitAddressing.maxSubjects,
    });
  const explicitClaimsBySubject = await Promise.all(explicitSelection.subjects.map(
    async subject => ({
      subject,
      claims: await selectCurrentAuthorClaims({
        store: deps.store,
        companionSubject: turn.companionSubject,
        currentAuthor: subject,
      }),
    }),
  ));
  const candidates: ProjectionCandidate[] = [
    ...selfClaims.flatMap(claim => {
      const presentation = presentBiographicalClaim(claim, 'companion-self');
      return presentation === undefined
        ? []
        : [{
          claim,
          presentation: projectionPresentation(presentation),
          audienceRole: 'companion-self' as const,
          ...(currentAuthor === undefined ? {} : { trustLevel: currentAuthor.trustLevel }),
        }];
    }),
    ...currentAuthorClaims.flatMap(claim => {
      const presentation = presentBiographicalClaim(claim, 'current-author');
      return presentation === undefined
        ? []
        : [{
          claim,
          presentation: projectionPresentation(presentation),
          audienceRole: 'current-author' as const,
          ...(currentAuthor === undefined ? {} : { trustLevel: currentAuthor.trustLevel }),
        }];
    }),
    ...explicitClaimsBySubject.flatMap(({ subject, claims }) => claims.flatMap(claim => {
      const presentation = presentExplicitSubjectClaim(claim, subject.subject);
      return presentation === undefined
        ? []
        : [{
          claim,
          presentation,
          audienceRole: 'explicit-subject' as const,
          trustLevel: subject.trustLevel,
          currentParticipation: subject.currentParticipation,
        }];
    })),
  ];

  const admitted: AdmittedClaim[] = [];
  const withheld: BiographicalWithheldEntry[] = explicitSelection.withheld.map(entry => ({
    ...entry,
  }));
  const consideredClaimIds = new Set<string>();

  for (const candidate of candidates) {
    const { claim } = candidate;
    // One claim may be selected through both current-author and explicit
    // addressing. Its first, more direct eligibility path owns the projection.
    if (consideredClaimIds.has(claim.id)) continue;
    consideredClaimIds.add(claim.id);
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
        withholdReasonFor(
          claim,
          candidate.audienceRole,
          drifted,
          grants,
          effectiveSensitivity,
          automaticSensitivity,
          nowMs,
        ),
      );
      continue;
    }

    if (
      candidate.audienceRole === 'explicit-subject'
      && effectiveSensitivity !== 'public'
      && candidate.currentParticipation?.status !== 'authoritative'
    ) {
      withheld.push({
        claimId: claim.id,
        reason: 'participation-unproven',
        detail: 'a non-public explicit-subject claim requires authoritative current participation proof',
      });
      continue;
    }

    if (candidate.trustLevel !== undefined) {
      const policy = evaluateMemoryPolicy({
        trustLevel: candidate.trustLevel,
        channelPrivacy: turn.conversationScope.envelope.channelPrivacy,
        broadcast: turn.conversationScope.envelope.broadcast,
        memorySensitivity: effectiveSensitivity,
      });
      if (policy.decision !== 'allow') {
        withheld.push({
          claimId: claim.id,
          reason: 'destination-disallowed',
          detail: `subject trust or context envelope denied this claim: ${policy.reason}`,
        });
        continue;
      }
    }

    // Atomic admit: a claim in the prompt section has a matching disclosure
    // contribution on the same result, and vice versa.
    admitted.push({
      claim,
      presentation: candidate.presentation,
      effectiveSensitivity,
      ...(appliedGrant !== undefined ? { appliedGrantId: appliedGrant.id } : {}),
      ...(candidate.audienceRole === 'explicit-subject'
        && effectiveSensitivity !== 'public'
        && candidate.currentParticipation?.status === 'authoritative'
        ? { participationProofRef: candidate.currentParticipation.proofRef }
        : {}),
    });
  }

  // Deterministic order, then optional prompt-economy trimming.
  admitted.sort((left, right) =>
    compareProjectionPresentations(left.presentation, right.presentation));
  const { admitted: budgeted, trimmed } = applyTokenBudget(admitted, turn);

  for (const entry of trimmed) {
    withheld.push({
      claimId: entry.claim.id,
      reason: 'token-budget-exhausted',
      detail: 'omitted as the lowest-priority claim after the prompt token budget was reached',
    });
  }

  const promptSection = renderProjectionPresentations(
    budgeted.map(entry => entry.presentation),
  );
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
  audienceRole: ProjectionCandidate['audienceRole'],
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
      detail: audienceRole === 'companion-self'
        ? 'the companion has not recorded an exact publication choice lowering this nickname to public'
        : 'the claim subject has not recorded an exact publication choice lowering this claim to public',
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
  const budget = Number.isFinite(turn.tokenBudget) && turn.tokenBudget >= 0
    ? turn.tokenBudget
    : 0;
  const estimate = turn.estimateTokens;
  let running = 0;
  const kept: AdmittedClaim[] = [];
  const trimmed: AdmittedClaim[] = [];
  const admittedSections = new Set<string>();
  let budgetExceeded = false;
  for (const entry of admitted) {
    if (budgetExceeded) {
      trimmed.push(entry);
      continue;
    }
    const headerCost = admittedSections.has(entry.presentation.sectionKey)
      ? 0
      : estimate(`${entry.presentation.header}\n`);
    const marginal = headerCost + estimate(`${entry.presentation.line}\n`);
    if (running + marginal > budget) {
      budgetExceeded = true;
      trimmed.push(entry);
      continue;
    }
    running += marginal;
    admittedSections.add(entry.presentation.sectionKey);
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
  if (entry.participationProofRef !== undefined) {
    provenanceRefs.push(`biographical-participation:${entry.participationProofRef}`);
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
