// Presence identity-claim resolver (Sprint 10, Workstream D2b — bead .13).
//
// A face-scope identity-claim PerceptionEvent (produced by the .11 sensor →
// cognition bridge) carries an OPAQUE hub identity handle plus a confidence,
// never biometric data (the bridge already rejects raw biometric payloads).
// This module turns that claim into a normalized ResolvedPresence, fail-closed:
//
//   - it resolves `hubIdentityId` → contact strictly through the owner-controlled
//     D2a enrollment binding, then loads the live Contact via
//     `ContactStorePort.getById`;
//   - it NEVER guesses a name, NEVER auto-creates a contact, and NEVER treats an
//     unenrolled or low-confidence claim as a known person;
//   - an unenrolled handle, a low-confidence claim, or an enrolled binding whose
//     contact has since been deleted all surface as an explicit ANONYMOUS
//     presence (with a reason), never dropped silently and never fabricated.
//
// The downstream note-delivery bead (.14) consumes {@link ResolvedPresence}
// through the {@link ResolvedPresenceSink} seam below; its default is a no-op so
// nothing is delivered until .14 plugs in a real sink.

import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { RelationshipType } from '../../contacts/types.js';
import type { HubIdentityResolution } from '../../enrollment/types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type {
  IdentityClaimPerceptionEvent,
  PerceptionEvent,
  PerceptionEventSink,
} from './sensor-cognition-bridge.js';

const log = createComponentLogger('IdentityClaimResolver');

/**
 * Minimum claim confidence (0..1) required before a handle is even resolved
 * against the enrollment binding. Below this, the presence surfaces as
 * anonymous `low_confidence` — the companion never guesses a name off a weak
 * match (Sprint 10 §5 fail-closed identity posture).
 */
export const DEFAULT_IDENTITY_CLAIM_CONFIDENCE_THRESHOLD = 0.6;

/** Why a claim resolved to an anonymous presence rather than a known contact. */
export type AnonymousPresenceReason =
  /** No active enrollment binding exists for this hub identity handle. */
  | 'unenrolled'
  /** Claim confidence was below the recognition threshold — no name guessed. */
  | 'low_confidence'
  /** An enrolled binding pointed at a contact that no longer exists (fail-closed). */
  | 'unknown_contact';

interface ResolvedPresenceBase {
  /** The identity-claim event this resolution was derived from. */
  event: IdentityClaimPerceptionEvent;
  /** Opaque hub identity handle carried by the claim. */
  hubIdentityId: string;
  /** Confidence carried by the hub claim (0..1). */
  confidence: number;
}

/** A claim resolved to a known, owner-enrolled contact. */
export interface KnownResolvedPresence extends ResolvedPresenceBase {
  kind: 'known';
  contactId: string;
  displayName: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  isMachineIntelligence: boolean;
}

/**
 * A claim that did NOT resolve to a known person. This is an explicit,
 * first-class outcome — "an unrecognized person" — not a dropped event.
 */
export interface AnonymousResolvedPresence extends ResolvedPresenceBase {
  kind: 'anonymous';
  reason: AnonymousPresenceReason;
}

/**
 * Normalized outcome of resolving a presence identity claim. The downstream
 * note-delivery path (bead .14) consumes this: `known` carries the contact
 * identity plus trust/relationship; `anonymous` carries only the reason and the
 * opaque handle — never a guessed identity.
 */
export type ResolvedPresence = KnownResolvedPresence | AnonymousResolvedPresence;

/**
 * Sink for resolved presences. Bead .14 (context-visible perception notes)
 * plugs in here; the default is a no-op so this bead delivers nothing yet.
 */
export interface ResolvedPresenceSink {
  handleResolvedPresence(presence: ResolvedPresence): void | Promise<void>;
}

export const NOOP_RESOLVED_PRESENCE_SINK: ResolvedPresenceSink = Object.freeze({
  handleResolvedPresence: () => undefined,
});

export function createNoopResolvedPresenceSink(): ResolvedPresenceSink {
  return NOOP_RESOLVED_PRESENCE_SINK;
}

/**
 * Narrow read seam over the D2a enrollment service. `HubIdentityEnrollmentService`
 * satisfies this directly; the resolver never touches enrollment internals.
 */
export interface HubIdentityClaimResolverPort {
  resolve(hubIdentityId: string): Promise<HubIdentityResolution>;
}

function anonymous(
  event: IdentityClaimPerceptionEvent,
  reason: AnonymousPresenceReason,
): AnonymousResolvedPresence {
  return {
    kind: 'anonymous',
    reason,
    event,
    hubIdentityId: event.hubIdentityId,
    confidence: event.confidence,
  };
}

export interface ResolveIdentityClaimInput {
  event: IdentityClaimPerceptionEvent;
  enrollmentService: HubIdentityClaimResolverPort;
  contactStore: Pick<ContactStorePort, 'getById'>;
  confidenceThreshold?: number;
  logger?: Pick<typeof log, 'warn'>;
}

/**
 * Resolve a single identity-claim event to a {@link ResolvedPresence},
 * fail-closed. Never guesses, never auto-creates a contact. A store failure is
 * NOT swallowed — it propagates so the caller can fail closed (deliver nothing)
 * rather than fabricate or silently drop an identity.
 */
export async function resolveIdentityClaim(
  input: ResolveIdentityClaimInput,
): Promise<ResolvedPresence> {
  const { event, enrollmentService, contactStore } = input;
  const threshold = input.confidenceThreshold ?? DEFAULT_IDENTITY_CLAIM_CONFIDENCE_THRESHOLD;
  const logger = input.logger ?? log;

  // Fail closed on weak matches BEFORE touching the binding: a low-confidence
  // claim must not even reveal that a handle is enrolled.
  if (event.confidence < threshold) {
    return anonymous(event, 'low_confidence');
  }

  const resolution = await enrollmentService.resolve(event.hubIdentityId);
  if (resolution.status !== 'enrolled') {
    return anonymous(event, 'unenrolled');
  }

  const contact = await contactStore.getById(resolution.binding.canonicalContactId);
  if (!contact) {
    // Enrolled binding references a contact that no longer exists. Fail closed:
    // surface an unknown presence, never fabricate the missing identity.
    logger.warn('identity claim binding references a missing contact; surfacing anonymous', {
      hubIdentityId: resolution.binding.hubIdentityId,
      contactId: resolution.binding.canonicalContactId,
    });
    return anonymous(event, 'unknown_contact');
  }

  return {
    kind: 'known',
    event,
    hubIdentityId: event.hubIdentityId,
    confidence: event.confidence,
    contactId: contact.id,
    displayName: contact.displayName,
    trustLevel: contact.trustLevel,
    relationshipType: contact.relationshipType,
    isMachineIntelligence: contact.isMachineIntelligence === true,
  };
}

export interface IdentityClaimResolverOptions {
  enrollmentService: HubIdentityClaimResolverPort;
  contactStore: Pick<ContactStorePort, 'getById'>;
  /** Where resolved identity claims are delivered. Defaults to a no-op (bead .14 plugs in here). */
  presenceSink?: ResolvedPresenceSink;
  /** Passthrough for non-identity perception events. Defaults to a no-op. */
  inner?: PerceptionEventSink;
  confidenceThreshold?: number;
  logger?: Pick<typeof log, 'warn'>;
}

/**
 * Build a {@link PerceptionEventSink} that resolves identity-claim events to a
 * {@link ResolvedPresence} and forwards them to a {@link ResolvedPresenceSink},
 * while passing every other perception event through unchanged to an inner sink.
 * Both downstream sinks default to no-ops, so wiring this into the bridge keeps
 * the perception path a no-op until bead .14 supplies a real presence sink.
 */
export function createIdentityClaimResolvingSink(
  options: IdentityClaimResolverOptions,
): PerceptionEventSink {
  const presenceSink = options.presenceSink ?? NOOP_RESOLVED_PRESENCE_SINK;
  const inner = options.inner ?? { handlePerceptionEvent: () => undefined };
  return {
    async handlePerceptionEvent(event: PerceptionEvent): Promise<void> {
      if (event.kind !== 'identity_claim') {
        await inner.handlePerceptionEvent(event);
        return;
      }
      const presence = await resolveIdentityClaim({
        event,
        enrollmentService: options.enrollmentService,
        contactStore: options.contactStore,
        ...(options.confidenceThreshold !== undefined
          ? { confidenceThreshold: options.confidenceThreshold }
          : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      });
      await presenceSink.handleResolvedPresence(presence);
    },
  };
}
