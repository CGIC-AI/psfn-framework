// ── CogSec outbound disclosure: egress composition (bible §7/§9.0) ──
//
// The destination-eligibility gate "composes with (does not bypass) the existing
// sink gates at egress" (bible §9.0). This module is the pure composition seam
// that folds the disclosure destination decision (`assessDisclosure`) into the
// verdict the existing CogSec egress sink gate (`tool_egress` sink + lethal
// trifecta, src/core/cogsec/intake/sink-gates.ts) already produced. It is NOT a
// parallel gate: the existing sink gate stays authoritative for a deny, and the
// disclosure check only ever *narrows* — never widens — an allow.
//
// Two fail-closed rules layer on top of the decision layer's own fail-closed
// posture (assessDisclosure §9.5):
//   - Release keys on `DisclosureDecision.allowed`, NEVER on classification.
//   - An outward social destination with no usable per-turn lineage is denied;
//     `companion_self` (the private sink) stays eligible via the decision layer.
//
// Destination derivation is deliberately conservative: only a positively
// identified outbound social send (a message/reaction to a resolvable
// contact/room) yields a `DisclosureDestination`. Every other egress
// (web fetch, git, shell, operator/companion notification, an unresolvable
// target) yields `null`, so the disclosure check does not engage and the
// existing sink gate's verdict stands unchanged — no regression to non-social
// egress paths.

import { assessDisclosure } from './decision.js';
import type {
  DisclosureClassification,
  DisclosureDestination,
  DisclosureLineage,
} from './contracts.js';

/**
 * Outbound gateway/tool methods that can carry a self-generated,
 * disclosure-bearing payload to a SOCIAL destination (a specific contact,
 * room, or the publication surface). `notify` is included because it is the
 * model-facing route to Discord; {@link isDisclosureSocialEgressInvocation}
 * narrows it to the external Discord-send action so operator briefs, email, and
 * companion handoffs retain their existing sink/trifecta controls.
 */
export const DISCLOSURE_SOCIAL_EGRESS_METHODS: ReadonlySet<string> = new Set([
  'discord.send',
  'discord.sendMedia',
  'discord.sendReaction',
  'notify',
]);

export function isDisclosureSocialEgressMethod(method: string): boolean {
  return DISCLOSURE_SOCIAL_EGRESS_METHODS.has(method);
}

/**
 * Whether this exact invocation attempts disclosure-bearing social egress.
 *
 * `notify` is the model-facing consolidated tool used for live Discord sends;
 * the gateway RPC method (`discord.send`) is below the capability gate and is
 * therefore never the method name observed by the disclosure guard. Email,
 * operator briefs, approvals, and companion handoffs remain governed by their
 * existing sink gates and are not Discord-room disclosure invocations.
 */
export function isDisclosureSocialEgressInvocation(input: {
  method: string;
  params: unknown;
}): boolean {
  if (input.method !== 'notify') {
    return isDisclosureSocialEgressMethod(input.method);
  }
  if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) {
    return false;
  }
  const record = input.params as Record<string, unknown>;
  return record.action === 'send'
    && record.target_kind !== 'companion'
    && record.delivery_channel === 'discord';
}

/**
 * Channel-classification injector. Mirrors `classifyChannelDisclosure` from
 * trust policy but is injected so this module stays pure and unit-testable and
 * carries no dependency on trust-policy runtime. Sensitivity/subject/consent are
 * consumed, never recomputed here (bible §9.0).
 */
export type ChannelDisclosureResolver = (channelId: string) => {
  channelPrivacy: string;
  broadcast: boolean;
  /**
   * The channel's current classification epoch (jp36.6.3), when the channel is
   * epoch-tracked. Stamped onto the derived room destination as `currentEpoch`
   * so the decision layer's epoch gate can deny prior-epoch content. Omitted
   * (undefined) for channels with no tracked epoch — the epoch gate then does
   * not engage and eligibility is exactly the pre-epoch behavior. The resolver
   * owns this value; it is a system/operator fact (an epoch bumps only through
   * the gated invite-only → public demotion flow), never a model-asserted one.
   */
  classificationEpoch?: number;
};

/**
 * Derive the outward social `DisclosureDestination` an egress invocation targets,
 * or `null` when none is positively identifiable. A `null` result means the
 * disclosure check does not apply and the existing sink gate governs alone.
 *
 * Resolution order (fail closed):
 *   1. A `contactId` param → the contact's DM (`contact_dm`).
 *   2. Else a `channelId` param, classified: `invite_only` → invite-only room;
 *      `public`/broadcast → public room.
 *   3. Anything else (no id, a private/unresolvable channel, a non-social
 *      method) → `null`.
 */
export function deriveDisclosureDestination(input: {
  method: string;
  params: unknown;
  resolveChannel: ChannelDisclosureResolver;
}): DisclosureDestination | null {
  if (!isDisclosureSocialEgressInvocation(input)) return null;
  const { params } = input;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;

  const rawContactId = input.method === 'notify' ? undefined : record.contactId;
  const contactId = typeof rawContactId === 'string' ? rawContactId.trim() : '';
  if (contactId) return { kind: 'contact_dm', contactId };

  const rawChannelId = input.method === 'notify'
    ? record.delivery_target
    : record.channelId;
  const channelId = typeof rawChannelId === 'string' ? rawChannelId.trim() : '';
  if (!channelId) return null;

  const disclosure = input.resolveChannel(channelId);
  const currentEpoch = typeof disclosure.classificationEpoch === 'number'
    && Number.isFinite(disclosure.classificationEpoch)
    ? disclosure.classificationEpoch
    : undefined;
  if (disclosure.channelPrivacy === 'invite_only') {
    return { kind: 'invite_only_room', channelId, ...(currentEpoch !== undefined ? { currentEpoch } : {}) };
  }
  if (disclosure.channelPrivacy === 'public' || disclosure.broadcast) {
    return { kind: 'public_room', channelId, ...(currentEpoch !== undefined ? { currentEpoch } : {}) };
  }
  // A private (non-broadcast) channel is not an outward social room, and no DM
  // contact was resolvable: no outward destination is derivable. Fail closed to
  // null so the existing sink gate — not a guessed destination — governs.
  return null;
}

/** Composed verdict for an egress invocation: existing sink gate ∧ disclosure. */
export interface ComposedEgressDisclosureDecision {
  /**
   * Final answer. True only when the existing sink gate allowed AND — when a
   * social destination was derived — the disclosure destination check allowed.
   * Keyed on `DisclosureDecision.allowed`, never on classification.
   */
  readonly allowed: boolean;
  /** Disclosure classification of the composed outcome (audit/telemetry only). */
  readonly outcome: DisclosureClassification;
  /** The derived outward destination, or null when the disclosure check did not apply. */
  readonly destination: DisclosureDestination | null;
  /** True when the disclosure destination check actually ran (a destination was derived). */
  readonly disclosureEvaluated: boolean;
  readonly reason: string;
}

/**
 * Compose the existing egress sink-gate verdict with the disclosure destination
 * decision. Never widens the sink gate's answer:
 *   - Sink gate denied            → denied (existing gate is authoritative).
 *   - Sink allowed, no destination → allowed (disclosure check does not apply).
 *   - Sink allowed, destination    → `assessDisclosure(...).allowed` governs
 *     (fail closed on absent/unclassified lineage for outward destinations;
 *     `companion_self` stays eligible via the decision layer).
 */
export function composeEgressDisclosureDecision(input: {
  /** Result of the existing CogSec egress sink-gate/trifecta evaluation. */
  sinkAllowed: boolean;
  /** Auditable reason from the existing sink gate (used when it denied). */
  sinkReason?: string;
  /** Per-turn generation-context lineage; undefined ⇒ fail closed for outward destinations (§9.5). */
  lineage: DisclosureLineage | undefined;
  /** Outward destination derived from the invocation; null ⇒ disclosure check does not apply. */
  destination: DisclosureDestination | null;
  /**
   * True when the invocation is known to be disclosure-bearing social egress.
   * Such an invocation with no resolvable destination fails closed instead of
   * falling through to the generic sink-gate allow.
   */
  requiresDisclosureDestination?: boolean;
}): ComposedEgressDisclosureDecision {
  // Compose, do not bypass: a denied sink gate stays denied regardless of any
  // disclosure decision.
  if (!input.sinkAllowed) {
    return {
      allowed: false,
      outcome: 'non_shareable',
      destination: input.destination,
      disclosureEvaluated: false,
      reason: input.sinkReason ?? 'existing egress sink gate denied',
    };
  }

  // No disclosure-bearing social destination: the existing sink gate's allow
  // stands untouched.
  if (!input.destination) {
    if (input.requiresDisclosureDestination) {
      return {
        allowed: false,
        outcome: 'non_shareable',
        destination: null,
        disclosureEvaluated: true,
        reason: 'fail closed: disclosure-bearing social egress destination could not be resolved',
      };
    }
    return {
      allowed: true,
      outcome: 'auto_shareable',
      destination: null,
      disclosureEvaluated: false,
      reason: 'no disclosure-bearing social destination derived; existing sink gate governs',
    };
  }

  const decision = assessDisclosure(input.lineage, input.destination);
  return {
    allowed: decision.allowed,
    outcome: decision.outcome,
    destination: input.destination,
    disclosureEvaluated: true,
    reason: decision.reason,
  };
}
