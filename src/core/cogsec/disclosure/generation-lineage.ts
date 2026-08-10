// ── CogSec outbound disclosure: generation-context population seam (bible §9.2) ──
//
// The pure fold lives in ./decision.ts (`beginDisclosureAccumulation`,
// `accumulateDisclosureSource`). This module is the RUNTIME POPULATION SEAM that
// turns real admitted sources into `DisclosureSourceContribution`s and folds
// them, so callers never reimplement "max sensitivity / intersect destinations"
// (bible §13.3). This module wires the generation-context admission paths:
//
//   1. Session history — contributes the current conversation's channel/contact
//      scope, its destination-relative sensitivity ceiling, and (for a DM) its
//      subject contact (§9.2 item 1).
//   2. Memory retrieval — contributes each retrieved memory's source reference,
//      sensitivity, subject contact, and source-channel-derived destinations
//      (§9.2 item 2).
//   3. Wiki/project/journal reads — contribute their sensitivity and the one
//      outward audience the source inherently authorizes, or fail closed as
//      unclassified when no usable lineage rides the admitted item (§9.2 item 3,
//      §9.5). Plain wiki world-knowledge authorizes no outward destination
//      (companion-self); a personal-project artifact maps its runtime-derived
//      `intendedAudience` to a scoped destination; a `legacy_unverified` artifact
//      contributes `classified: false` and taints the whole context (jp36.1.1.3).
//   4. Tool results — contribute their provenance and a taint gate: a result that
//      did not pass the intake firewall as a released, non-untrusted source fails
//      closed to companion-self only (§9.0 tool outputs are untrusted-derived,
//      §9.2 item 4, §9.4 whole-output taint, jp36.1.1.3).
//
// Fail-closed invariants enforced here:
//   - A permitted-destination constraint for an id-bearing kind (contact_dm,
//     invite_only_room, public_room) is NEVER emitted without a non-empty id
//     set. An unscoped id-bearing constraint would collapse a source to "any
//     destination of that kind" (jp36.1.1.1 review handoff). Builders construct
//     only scoped constraints; `assertScopedDisclosureConstraints` is the
//     belt-and-suspenders guard that fails loud if that invariant is ever
//     violated.
//   - Source-channel-derived room destinations are gated by the channel's
//     disclosure ceiling: a memory whose sensitivity exceeds the source
//     channel's ceiling never contributes that room as a permitted destination.
//   - Sensitivity/subject/consent are CONSUMED from trust policy and CogSec
//     provenance (`classifyChannelDisclosure`, `getVisibilityDisclosureCeiling`,
//     the memory record), never recomputed here (bible §9.0).

import type { ConversationScope } from '../../session/conversation-scope.js';
import {
  isIntakeSinkConsumableState,
  type IntakeEnvelopeState,
  type IntakeSourceRiskTier,
} from '../../../shared/contracts/intake-envelope.js';
import {
  classifyChannelDisclosure,
  getVisibilityDisclosureCeiling,
} from '../../../system/trust/policy.js';
import {
  SENSITIVITY_LEVELS,
  sensitivityAtMost,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import {
  DISCLOSURE_KIND_ID_FIELD,
  type DisclosureDestinationConstraint,
  type DisclosureLineage,
  type DisclosureSourceContribution,
  type GenerationDisclosureContext,
} from './contracts.js';
import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
} from './decision.js';

/** Versioned identity for the disclosure population/classification pass. */
export const DISCLOSURE_CLASSIFIER_VERSION = 'disclosure/v1';

/**
 * One retrieved memory's disclosure-relevant facts, collected at memory
 * retrieval and handed to `memoryDisclosureContribution`. Content-free: only
 * references and policy facts, never the memory text.
 */
export interface DisclosureMemorySource {
  /** Durable, content-free reference, e.g. `memory:<id>`. */
  readonly ref: string;
  readonly sensitivity: SensitivityLevel;
  /** Subject contact the memory is about (PurrMemory.contactId / provenance subject). */
  readonly subjectContactId?: string;
  /** Channel the memory was formed in (PurrMemory.provenance.channelId). */
  readonly sourceChannelId?: string;
  /**
   * The classification epoch the source channel was at when the memory was
   * formed (jp36.6.3). Stamps the room constraint so the memory is auto-eligible
   * to that room only while the room remains at that epoch; absent ⇒ epoch
   * UNKNOWN (fail closed against an epoch-tracked destination).
   */
  readonly sourceChannelEpoch?: number;
  readonly provenanceRefs?: readonly string[];
}

/**
 * The outward audience a companion-owned artifact (a personal-project artifact)
 * inherently authorizes. Mirror of `faculties/wiki`'s `CompanionOwnedVisibility`,
 * redeclared here so the disclosure seam carries no dependency on the wiki
 * faculty. Mapped to disclosure destinations in `wikiDisclosureContribution`:
 * `self` → companion-self (no outward destination); `primary_contact` → the
 * primary contact's DM (requires the id to stay scoped, else companion-self);
 * `public` → the autonomous publication surface.
 */
export type CompanionOwnedDisclosureAudience = 'self' | 'primary_contact' | 'public';

/**
 * One admitted wiki/project/journal read's disclosure-relevant facts, collected
 * at admission and handed to `wikiDisclosureContribution`. Content-free: refs and
 * policy facts only, never the document text.
 *
 * Plain wiki world-knowledge carries no `companionOwnedAudience` (it authorizes
 * no outward social destination — it is reference knowledge, not lived memory,
 * and collapses to companion-self). A personal-project artifact carries the
 * runtime-derived `intendedAudience` (`companionOwnedAudience`) and, for the
 * `primary_contact` audience, the resolved `primaryContactId`. `classified` is
 * false for an artifact without usable disclosure lineage (a `legacy_unverified`
 * project artifact, or a read whose sensitivity/scope could not be resolved),
 * which fails the whole context closed (§9.5).
 */
export interface DisclosureWikiSource {
  /** Durable, content-free reference, e.g. `wiki:<docId>` or `project:<id>:<artifactRef>`. */
  readonly ref: string;
  readonly sensitivity: SensitivityLevel;
  /** Present only for companion-owned artifacts (personal projects); absent for plain wiki world-knowledge. */
  readonly companionOwnedAudience?: CompanionOwnedDisclosureAudience;
  /** Required to scope a `primary_contact` audience to a DM; absent forces companion-self collapse. */
  readonly primaryContactId?: string;
  readonly provenanceRefs?: readonly string[];
  /** False when the read carried no usable disclosure lineage — taints the context unclassified (§9.5). */
  readonly classified: boolean;
}

/**
 * One admitted tool result's disclosure-relevant facts, collected right after
 * intake-firewall screening of the tool output (htm9.2) and handed to
 * `toolResultDisclosureContribution`. Content-free: a ref plus the intake
 * screening verdict (state + risk tier). `intakeState`/`sourceRiskTier` are
 * absent when the firewall did not screen the result, which fails closed.
 */
export interface DisclosureToolResultSource {
  /** Durable, content-free reference, e.g. `tool:<name>:<callId>`. */
  readonly ref: string;
  readonly intakeState?: IntakeEnvelopeState;
  readonly sourceRiskTier?: IntakeSourceRiskTier;
  readonly provenanceRefs?: readonly string[];
}

/**
 * The disclosure axis carries no vetted sensitivity for a tool result: the
 * intake firewall vets tool output for injection/exfiltration, not for how
 * sensitive it is relative to the companion's social graph. So a tool result
 * fails closed on the sensitivity axis to the most restrictive level — it never
 * grants an outward destination anyway, so this only tightens the classification
 * label and (later) the egress ceiling, never over-shares.
 */
const TOOL_RESULT_SENSITIVITY_FLOOR: SensitivityLevel = SENSITIVITY_LEVELS[SENSITIVITY_LEVELS.length - 1] ?? 'confidential';

/**
 * Fail-loud guard: no permitted-destination constraint for an id-bearing kind
 * may be emitted without a non-empty id set. An unscoped id-bearing constraint
 * silently widens a source to "any destination of that kind" — the exact
 * collapse the jp36.1.1.1 review flagged. Builders never produce such a
 * constraint; this asserts the invariant so a regression fails loud rather than
 * over-sharing.
 */
export function assertScopedDisclosureConstraints(
  constraints: readonly DisclosureDestinationConstraint[],
  context: string,
): void {
  for (const constraint of constraints) {
    const field = DISCLOSURE_KIND_ID_FIELD[constraint.kind];
    if (field === null) continue;
    const ids = field === 'channelId' ? constraint.channelIds : constraint.contactIds;
    if (ids === undefined || ids.length === 0) {
      throw new Error(
        `Disclosure population seam produced an unscoped ${constraint.kind} constraint (${context}); `
          + `id-bearing destinations must carry a non-empty ${field} set (jp36 disclosure invariant).`,
      );
    }
  }
}

/**
 * Coerce an admitted classification epoch: a finite number stamps the
 * per-channel `channelEpochs` entry so the decision layer's epoch gate (jp36.6.3)
 * can deny prior-epoch content; anything else is UNKNOWN (undefined), which fails
 * closed against an epoch-tracked destination and is inert against an untracked
 * one. The epoch is a system/operator fact captured at admission — never a
 * model-asserted value.
 */
function normalizeAdmittedEpoch(epoch: number | undefined): number | undefined {
  return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : undefined;
}

function scopedRoomConstraint(
  kind: 'invite_only_room' | 'public_room',
  channelId: string,
  epoch: number | undefined,
): DisclosureDestinationConstraint {
  const admitted = normalizeAdmittedEpoch(epoch);
  return admitted !== undefined
    ? { kind, channelIds: [channelId], channelEpochs: { [channelId]: admitted } }
    : { kind, channelIds: [channelId] };
}

/**
 * Derive a scoped room destination for a source channel, gated by the channel's
 * disclosure ceiling. Returns `null` for private channels (no outward room),
 * for a blank channel id, or when the source sensitivity exceeds the channel's
 * ceiling. Never returns an unscoped constraint. When the admitting caller knows
 * the channel's classification epoch (jp36.6.3) it is stamped so the content is
 * auto-eligible to the room only while the room remains at that epoch.
 */
function sourceChannelRoomConstraint(
  channelId: string | undefined,
  sensitivity: SensitivityLevel,
  channelEpoch?: number,
): DisclosureDestinationConstraint | null {
  const id = channelId?.trim();
  if (!id) return null;
  const disclosure = classifyChannelDisclosure(id);
  // A memory more sensitive than the channel may disclose can never flow back to
  // that room automatically.
  if (!sensitivityAtMost(sensitivity, getVisibilityDisclosureCeiling(disclosure))) return null;
  if (disclosure.channelPrivacy === 'invite_only') return scopedRoomConstraint('invite_only_room', id, channelEpoch);
  if (disclosure.channelPrivacy === 'public') return scopedRoomConstraint('public_room', id, channelEpoch);
  return null;
}

/**
 * Session-history contribution (§9.2 item 1). The current conversation's scope
 * fixes the destination-relative sensitivity ceiling and the one destination the
 * session content is inherently authorized for:
 *   - DM        → the partner contact's DM (contact_dm), subject = that contact;
 *   - invite-only room → that room (invite_only_room);
 *   - public room      → that room (public_room);
 *   - private group    → companion-self only (no outward constraint).
 * `companion_self` is never emitted as a constraint — it is the always-eligible
 * private sink handled by the assessor.
 */
export function sessionHistoryDisclosureContribution(
  scope: ConversationScope,
  options?: { readonly channelEpoch?: number },
): DisclosureSourceContribution {
  const sensitivity = getVisibilityDisclosureCeiling(scope.envelope);
  const permittedDestinations: DisclosureDestinationConstraint[] = [];
  const subjectContactIds: string[] = [];

  if (scope.kind === 'dm') {
    const contactId = scope.contact.contactId.trim();
    if (contactId) {
      permittedDestinations.push({ kind: 'contact_dm', contactIds: [contactId] });
      subjectContactIds.push(contactId);
    }
  } else if (scope.envelope.channelPrivacy === 'invite_only') {
    permittedDestinations.push(scopedRoomConstraint('invite_only_room', scope.channelId, options?.channelEpoch));
  } else if (scope.envelope.channelPrivacy === 'public') {
    permittedDestinations.push(scopedRoomConstraint('public_room', scope.channelId, options?.channelEpoch));
  }

  assertScopedDisclosureConstraints(permittedDestinations, `session:${scope.key}`);

  return {
    ref: `session:${scope.key}`,
    sensitivity,
    permittedDestinations,
    subjectContactIds,
    sourceChannelId: scope.channelId,
    classified: true,
  };
}

/**
 * Memory-retrieval contribution (§9.2 item 2). A retrieved memory contributes
 * its sensitivity, its subject contact (permitting return to that contact's DM),
 * and — when the memory carries a source channel whose ceiling admits the
 * memory — that room. A memory with neither a subject nor an eligible source
 * channel contributes no outward destination, so it fails closed to
 * companion-self only.
 */
export function memoryDisclosureContribution(
  source: DisclosureMemorySource,
): DisclosureSourceContribution {
  const permittedDestinations: DisclosureDestinationConstraint[] = [];
  const subjectContactIds: string[] = [];

  const subjectContactId = source.subjectContactId?.trim();
  if (subjectContactId) {
    permittedDestinations.push({ kind: 'contact_dm', contactIds: [subjectContactId] });
    subjectContactIds.push(subjectContactId);
  }

  const roomConstraint = sourceChannelRoomConstraint(
    source.sourceChannelId,
    source.sensitivity,
    source.sourceChannelEpoch,
  );
  if (roomConstraint) permittedDestinations.push(roomConstraint);

  assertScopedDisclosureConstraints(permittedDestinations, source.ref);

  const sourceChannelId = source.sourceChannelId?.trim();
  return {
    ref: source.ref,
    sensitivity: source.sensitivity,
    permittedDestinations,
    subjectContactIds,
    ...(sourceChannelId ? { sourceChannelId } : {}),
    ...(source.provenanceRefs ? { provenanceRefs: source.provenanceRefs } : {}),
    classified: true,
  };
}

/**
 * Wiki/project/journal contribution (§9.2 item 3). Plain wiki world-knowledge
 * authorizes no outward social destination and collapses to companion-self
 * (empty outward permission set). A companion-owned artifact (personal project)
 * maps its runtime-derived `companionOwnedAudience` to the single destination it
 * authorizes:
 *   - `self`            → companion-self only (no outward constraint);
 *   - `primary_contact` → that contact's DM (contact_dm), subject = that contact;
 *   - `public`          → the autonomous publication surface (publication).
 * A `primary_contact` audience with no resolved id fails closed to companion-self
 * rather than emitting an unscoped contact_dm. `classified: false` (a
 * `legacy_unverified` artifact, or an unresolvable read) taints the whole
 * generation context unclassified so assessment fails closed (§9.5).
 */
export function wikiDisclosureContribution(
  source: DisclosureWikiSource,
): DisclosureSourceContribution {
  const permittedDestinations: DisclosureDestinationConstraint[] = [];
  const subjectContactIds: string[] = [];

  if (source.companionOwnedAudience === 'primary_contact') {
    const contactId = source.primaryContactId?.trim();
    if (contactId) {
      permittedDestinations.push({ kind: 'contact_dm', contactIds: [contactId] });
      subjectContactIds.push(contactId);
    }
    // No resolvable primary contact → companion-self collapse (fail closed),
    // never an unscoped contact_dm.
  } else if (source.companionOwnedAudience === 'public') {
    permittedDestinations.push({ kind: 'publication' });
  }
  // `self` or absent audience → companion-self only (no outward constraint).

  assertScopedDisclosureConstraints(permittedDestinations, source.ref);

  return {
    ref: source.ref,
    sensitivity: source.sensitivity,
    permittedDestinations,
    subjectContactIds,
    ...(source.provenanceRefs ? { provenanceRefs: source.provenanceRefs } : {}),
    classified: source.classified,
  };
}

/**
 * Tool-result contribution (§9.2 item 4). A tool result is admitted,
 * externally-derived context: it never inherently authorizes an outward social
 * destination, so its permission set is always empty (companion-self collapse).
 * On top of that it is a taint gate — a result is only `classified` when the
 * intake firewall released it (a sink-consumable state) as a non-untrusted
 * source; anything else (unscreened, quarantined, discarded/expired, or an
 * untrusted/hostile tier) fails the whole context closed to `non_shareable`
 * (§9.0 tool outputs are untrusted-derived; §9.5).
 */
export function toolResultDisclosureContribution(
  source: DisclosureToolResultSource,
): DisclosureSourceContribution {
  const classified = source.intakeState !== undefined
    && isIntakeSinkConsumableState(source.intakeState)
    && source.sourceRiskTier !== undefined
    && source.sourceRiskTier !== 'untrusted'
    && source.sourceRiskTier !== 'hostile';

  // A tool result never contributes an outward destination. Guarded on every
  // path even though the list is empty, keeping the invariant assertion uniform.
  const permittedDestinations: DisclosureDestinationConstraint[] = [];
  assertScopedDisclosureConstraints(permittedDestinations, source.ref);

  return {
    ref: source.ref,
    sensitivity: TOOL_RESULT_SENSITIVITY_FLOOR,
    permittedDestinations,
    subjectContactIds: [],
    ...(source.provenanceRefs ? { provenanceRefs: source.provenanceRefs } : {}),
    classified,
  };
}

/**
 * Build the generation-context disclosure lineage for a turn by folding the
 * session-history contribution and every admitted source (retrieved memories,
 * wiki/project/journal reads, tool results) into a fresh accumulator. The single
 * seam the turn runtime calls; a later, more restrictive source tightens
 * subsequent outputs (bible §9.2). Sources are folded in admission order:
 * session history, then memory, then wiki/project/journal, then tool results
 * (admitted during the turn, after context assembly).
 */
export function buildGenerationDisclosureLineage(input: {
  context: GenerationDisclosureContext;
  conversationScope: ConversationScope;
  /**
   * Current classification epoch of the conversation's channel (jp36.6.3), when
   * epoch-tracked. Stamps the session-history room constraint so this turn's own
   * content stays auto-eligible to the room only while the room remains at this
   * epoch. Absent ⇒ epoch UNKNOWN for the session channel (fail closed against an
   * epoch-tracked destination, inert against an untracked one).
   */
  conversationChannelEpoch?: number;
  memorySources: readonly DisclosureMemorySource[];
  biographicalSources?: readonly DisclosureSourceContribution[];
  wikiSources?: readonly DisclosureWikiSource[];
  toolResultSources?: readonly DisclosureToolResultSource[];
}): DisclosureLineage {
  let lineage = beginDisclosureAccumulation(input.context);
  lineage = accumulateDisclosureSource(
    lineage,
    sessionHistoryDisclosureContribution(input.conversationScope, { channelEpoch: input.conversationChannelEpoch }),
  );
  for (const source of input.memorySources) {
    lineage = accumulateDisclosureSource(lineage, memoryDisclosureContribution(source));
  }
  for (const source of input.biographicalSources ?? []) {
    assertScopedDisclosureConstraints(source.permittedDestinations, source.ref);
    lineage = accumulateDisclosureSource(lineage, source);
  }
  for (const source of input.wikiSources ?? []) {
    lineage = accumulateDisclosureSource(lineage, wikiDisclosureContribution(source));
  }
  for (const source of input.toolResultSources ?? []) {
    lineage = accumulateDisclosureSource(lineage, toolResultDisclosureContribution(source));
  }
  return lineage;
}
