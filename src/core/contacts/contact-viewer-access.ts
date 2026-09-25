import { viewerAdmitsSensitivity } from '../session/session-viewer-access.js';
import type { Contact } from './types.js';

/**
 * Viewer access for the contact tool's reads (o5wf5 sweep; r6 sibling lookup).
 *
 * Human contacts hold notes, trust and identities about people met in other
 * conversations, so they are readable only where the viewer's trust and room
 * admit personal material. Fleet sibling companions (the `ai_companion`
 * contacts provisioned for the fleet, bound to a `companion` channel
 * identity) are the companion's own siblings, not private human data: a
 * companion can always look up their name, contact id, companion id and that
 * an ICP DM exists, from any room, so it can reach them over ICP. Outside a
 * personal-admitting room only that projection is shown, never notes, trust
 * history or other identities.
 */
export type ContactReadAccess = 'full' | 'fleet_siblings_only';

export function resolveContactReadAccess(): ContactReadAccess {
  return viewerAdmitsSensitivity('personal') ? 'full' : 'fleet_siblings_only';
}

/** The sibling's companion id when `contact` is a provisioned fleet sibling. */
function fleetSiblingCompanionId(contact: Contact): string | undefined {
  if (contact.relationshipType !== 'ai_companion') return undefined;
  const identity = (contact.channelIdentities ?? []).find(entry => entry.channel === 'companion')
    ?? (contact.channels ?? []).find(entry => entry.channel === 'companion');
  const companionId = identity?.userId.trim();
  return companionId || undefined;
}

export function isContactVisible(contact: Contact, access: ContactReadAccess): boolean {
  return access === 'full' || fleetSiblingCompanionId(contact) !== undefined;
}

export function partitionVisibleContacts(
  contacts: readonly Contact[],
  access: ContactReadAccess,
): { visible: Contact[]; withheldCount: number } {
  const visible = contacts.filter(contact => isContactVisible(contact, access));
  return { visible, withheldCount: contacts.length - visible.length };
}

/** Searchable text of a sibling outside a personal room: identity only. */
export function fleetSiblingSearchHaystack(contact: Contact, name: string): string {
  return [contact.id, name, contact.displayName, contact.nickname, fleetSiblingCompanionId(contact), 'ai_companion', 'sibling']
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

export function formatFleetSiblingLine(contact: Contact, name: string): string {
  return `- ${contact.id}: ${name} [fleet sibling companion] companion_id=${fleetSiblingCompanionId(contact) ?? ''}`
    + ' icp=companion DM available';
}

export function formatFleetSiblingLookup(contact: Contact, name: string): string {
  return `Canonical ID: ${contact.id}\n`
    + `Contact: ${name}\n`
    + 'Relationship: ai_companion (fleet sibling companion)\n'
    + `Companion peer ID: ${fleetSiblingCompanionId(contact) ?? ''}\n`
    + 'ICP: a companion DM with this sibling is available through the ICP send path.\n'
    + 'Other contact details are withheld by visibility gating in this conversation.';
}

export const CONTACTS_WITHHELD_NOTE = 'Other contacts are withheld by visibility gating in this conversation.';
