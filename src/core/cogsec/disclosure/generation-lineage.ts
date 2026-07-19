// ── CogSec outbound disclosure: generation-context population seam (bible §9.2) ──
//
// The pure fold lives in ./decision.ts (`beginDisclosureAccumulation`,
// `accumulateDisclosureSource`). This module is the RUNTIME POPULATION SEAM that
// turns real admitted sources into `DisclosureSourceContribution`s and folds
// them, so callers never reimplement "max sensitivity / intersect destinations"
// (bible §13.3). This bead (jp36.1.1.2) wires two admission paths:
//
//   1. Session history — contributes the current conversation's channel/contact
//      scope, its destination-relative sensitivity ceiling, and (for a DM) its
//      subject contact (§9.2 item 1).
//   2. Memory retrieval — contributes each retrieved memory's source reference,
//      sensitivity, subject contact, and source-channel-derived destinations
//      (§9.2 item 2).
//
// Wiki/journal/project reads and tool results are the sibling bead (jp36.1.1.3)
// and are intentionally NOT populated here.
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
  classifyChannelDisclosure,
  getVisibilityDisclosureCeiling,
} from '../../../system/trust/policy.js';
import { sensitivityAtMost, type SensitivityLevel } from '../../../system/trust/types.js';
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
  readonly provenanceRefs?: readonly string[];
}

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
 * Derive a scoped room destination for a source channel, gated by the channel's
 * disclosure ceiling. Returns `null` for private channels (no outward room),
 * for a blank channel id, or when the source sensitivity exceeds the channel's
 * ceiling. Never returns an unscoped constraint.
 */
function sourceChannelRoomConstraint(
  channelId: string | undefined,
  sensitivity: SensitivityLevel,
): DisclosureDestinationConstraint | null {
  const id = channelId?.trim();
  if (!id) return null;
  const disclosure = classifyChannelDisclosure(id);
  // A memory more sensitive than the channel may disclose can never flow back to
  // that room automatically.
  if (!sensitivityAtMost(sensitivity, getVisibilityDisclosureCeiling(disclosure))) return null;
  if (disclosure.channelPrivacy === 'invite_only') return { kind: 'invite_only_room', channelIds: [id] };
  if (disclosure.channelPrivacy === 'public') return { kind: 'public_room', channelIds: [id] };
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
    permittedDestinations.push({ kind: 'invite_only_room', channelIds: [scope.channelId] });
  } else if (scope.envelope.channelPrivacy === 'public') {
    permittedDestinations.push({ kind: 'public_room', channelIds: [scope.channelId] });
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

  const roomConstraint = sourceChannelRoomConstraint(source.sourceChannelId, source.sensitivity);
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
 * Build the generation-context disclosure lineage for a turn by folding the
 * session-history contribution and every retrieved-memory contribution into a
 * fresh accumulator. The single seam the turn runtime calls; a later, more
 * restrictive memory source tightens subsequent outputs (bible §9.2).
 */
export function buildGenerationDisclosureLineage(input: {
  context: GenerationDisclosureContext;
  conversationScope: ConversationScope;
  memorySources: readonly DisclosureMemorySource[];
}): DisclosureLineage {
  let lineage = beginDisclosureAccumulation(input.context);
  lineage = accumulateDisclosureSource(lineage, sessionHistoryDisclosureContribution(input.conversationScope));
  for (const source of input.memorySources) {
    lineage = accumulateDisclosureSource(lineage, memoryDisclosureContribution(source));
  }
  return lineage;
}
