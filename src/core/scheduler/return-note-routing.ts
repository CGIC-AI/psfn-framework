// ── Workspace-resolved return-note routing (bible §10.8 / adjudication 2026-07-19) ──
//
// The DESTINATION-eligible summarizer projection (return-note-projection.ts,
// jp36.2.3.2) is destination-IN: given a `DisclosureDestination` it narrows the
// block's evidence to the subset that destination may lawfully receive. It never
// decides WHERE the note lands. This module owns that other half of jp36.2.3:
//
//   1. the FreeTimeReturnPolicy → DisclosureDestination mapping (the content
//      gate fed to the projection); and
//   2. the ROUTING/append target for the resolved note — which session the
//      attributed system note is appended to.
//
// Both come from the SAME resolved workspace return policy, so the route and the
// projection destination can never disagree (bible §10.8: a note bound for one
// contact's DM must be summarized from — and delivered to — that exact DM).
//
// Fail-closed posture (charter / AGENTS.md, bible §20.4):
//
//   - `private_self`      → the companion's internal workspace session; full
//     fidelity is allowed because it never enters a human/contact session.
//   - `contact_dm`        → resolve `contactId` → that contact's DM session
//     (never address a private channel id directly). An UNRESOLVABLE contact
//     collapses to a content-free private/self note — NEVER a wrong-destination
//     append.
//   - `room`              → the same room's session (the resolver-computed room
//     disclosure destination, invite-only vs public). A missing/mis-typed room
//     ceiling collapses to private/self.
//   - `publication_state` → a publication STATE update on the workspace's own
//     internal session; carries no transcript content and no partner disclosure
//     (bible §10.8 rows 4-5).
//
// A projection collapse (nothing eligible for the outward destination) is handled
// by the caller: it re-routes to the private/self session as a content-free note.
// This module only produces the REQUESTED route; it never widens a destination.

import type { DisclosureDestination } from '../cogsec/disclosure/index.js';
import type { FreeTimeReturnPolicy } from './free-time-workspace-resolver.js';

/**
 * Map a resolved workspace return policy to the disclosure destination the
 * summarizer projection is gated on (bible §10.8). This is the single source of
 * truth for the note's destination; the append target is derived from the SAME
 * policy in {@link routeReturnNote}, so route and destination always agree.
 *
 * A `room` return policy carries only the bound channel id; the invite-only vs
 * public distinction lives in the resolver's disclosure ceiling, so the caller
 * passes it through `roomDisclosureCeiling`. A room policy WITHOUT a room-kind
 * ceiling fails closed to `companion_self` (never a guessed room destination).
 */
export function returnPolicyToDisclosureDestination(
  returnPolicy: FreeTimeReturnPolicy,
  roomDisclosureCeiling?: DisclosureDestination,
): DisclosureDestination {
  switch (returnPolicy.kind) {
    case 'contact_dm':
      return { kind: 'contact_dm', contactId: returnPolicy.contactId };
    case 'private_self':
      return { kind: 'companion_self' };
    case 'room':
      // The room's disclosure destination (invite_only_room | public_room) is the
      // resolver-computed ceiling. Anything else fails closed to private/self.
      return roomDisclosureCeiling
        && (roomDisclosureCeiling.kind === 'invite_only_room' || roomDisclosureCeiling.kind === 'public_room')
        ? roomDisclosureCeiling
        : { kind: 'companion_self' };
    case 'publication_state':
      return { kind: 'publication' };
    default: {
      // Exhaustiveness guard: an unknown return policy fails closed rather than
      // guessing a destination (bible §20.4 missing/unknown lineage fails closed).
      const unknown = returnPolicy as { kind?: unknown };
      throw new Error(`unknown free-time return policy kind: ${String(unknown.kind)}`);
    }
  }
}

/** Resolves a verified contact's DM session id, or `null` when unresolvable. */
export type ContactDmSessionResolver = (contactId: string) => string | null;

export interface ReturnNoteRoutingPorts {
  /**
   * The companion's private-self return surface — the INTERNAL workspace
   * session a private/self or fail-closed content-free note is appended to.
   * It is never a human DM, room, arbitrary admin, or "latest session"; outward
   * delivery requires an exact contact/room route (bible §10.8 multi-human
   * rule).
   */
  readonly privateSelfSessionId: string;
  /**
   * The workspace's own internal continuity session — the append target for a
   * publication STATE note (no partner disclosure, bible §10.8 rows 4-5).
   */
  readonly workspaceSessionId: string;
  /**
   * Resolve a `contact_dm` return policy's `contactId` to its DM session id.
   * Absent (or returning `null`) → the contact-anchored note fails closed to a
   * content-free private/self note rather than a wrong-destination append.
   */
  readonly resolveContactDmSessionId?: ContactDmSessionResolver;
}

/**
 * The fully-resolved return-note route. `destination` is fed to the projection
 * (the content gate); `targetSessionId` is where an eligible content or the
 * content-free note is appended. `isPublicationState` short-circuits to a state
 * note on the workspace session. `contentAllowed` is false whenever the route
 * could not resolve an outward target — the caller must then render a
 * content-free private/self note.
 */
export interface ReturnNoteRoute {
  readonly destination: DisclosureDestination;
  readonly targetSessionId: string;
  readonly isPublicationState: boolean;
  readonly contentAllowed: boolean;
  readonly reason: string;
}

/**
 * Route a resolved disclosure destination to its append target, fail-closed. The
 * destination itself already carries the id-bearing facts (contactId / channelId)
 * so this routes uniformly whether the destination came from a workspace return
 * policy or the legacy no-workspace seam.
 */
export function routeReturnNote(
  destination: DisclosureDestination,
  ports: ReturnNoteRoutingPorts,
): ReturnNoteRoute {
  const collapse = (reason: string): ReturnNoteRoute => ({
    destination: { kind: 'companion_self' },
    targetSessionId: ports.privateSelfSessionId,
    isPublicationState: false,
    contentAllowed: false,
    reason,
  });

  switch (destination.kind) {
    case 'companion_self':
      return {
        destination,
        targetSessionId: ports.privateSelfSessionId,
        isPublicationState: false,
        contentAllowed: true,
        reason: 'private/self note (companion-self sink)',
      };
    case 'contact_dm': {
      const dmSessionId = ports.resolveContactDmSessionId?.(destination.contactId)?.trim() || null;
      if (!dmSessionId) return collapse(`unresolvable contact DM ${destination.contactId} — collapsed to private/self`);
      return {
        destination,
        targetSessionId: dmSessionId,
        isPublicationState: false,
        contentAllowed: true,
        reason: `contact DM ${destination.contactId}`,
      };
    }
    case 'invite_only_room':
    case 'public_room': {
      const channelId = destination.channelId.trim();
      if (!channelId) return collapse('room destination missing channel id — collapsed to private/self');
      return {
        destination,
        targetSessionId: channelId,
        isPublicationState: false,
        contentAllowed: true,
        reason: `same-room note ${channelId}`,
      };
    }
    case 'publication':
      return {
        destination,
        targetSessionId: ports.workspaceSessionId,
        isPublicationState: true,
        contentAllowed: false,
        reason: 'publication state update on workspace session',
      };
    default: {
      const unknown = destination as { kind?: unknown };
      return collapse(`unknown disclosure destination kind ${String(unknown.kind)} — collapsed to private/self`);
    }
  }
}
