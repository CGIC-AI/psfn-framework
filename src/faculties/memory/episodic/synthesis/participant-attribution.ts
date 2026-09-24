import type { SessionEntry } from '../../../../core/session/types.js';
import { resolveSessionEntrySpeakerContactId } from '../../../../core/session/speaker-attribution.js';
import { UNRESOLVED_EPISODE_PARTICIPANT } from '../../../../shared/contracts/episodic-memory.js';

/**
 * Authorization-bearing participant ids for an episode (psfn-framework-bs4m0).
 *
 * Only user-role speakers carrying proven canonical attribution (stamped at
 * session write time from the contact-store resolution) contribute their
 * canonical contact id. A raw `authorId` is never copied: it is a channel
 * identity that may collide with, or be mistaken for, a canonical contact id.
 *
 * Fail closed: an unattributed speaker, or one author whose entries carry
 * conflicting canonical attributions, contributes no contact id and instead
 * adds the reserved `UNRESOLVED_EPISODE_PARTICIPANT` marker so the episode is
 * never mistaken for an unattributed (empty-participant) one by admin
 * projections. Conflicting attributions are withheld entirely.
 */
export function resolveEpisodeParticipantContactIds(
  entries: readonly SessionEntry[],
): string[] {
  const contactIdsByAuthor = new Map<string, Set<string>>();
  let unresolved = false;

  for (const entry of entries) {
    if (entry.role !== 'user') continue;
    const contactId = resolveSessionEntrySpeakerContactId(entry);
    if (!contactId) {
      unresolved = true;
      continue;
    }
    const authorKey = entry.authorId?.trim() ?? '';
    const contacts = contactIdsByAuthor.get(authorKey) ?? new Set<string>();
    contacts.add(contactId);
    contactIdsByAuthor.set(authorKey, contacts);
  }

  const resolved = new Set<string>();
  for (const contacts of contactIdsByAuthor.values()) {
    if (contacts.size !== 1) {
      unresolved = true;
      continue;
    }
    for (const contactId of contacts) resolved.add(contactId);
  }
  if (unresolved) resolved.add(UNRESOLVED_EPISODE_PARTICIPANT);
  return [...resolved].sort();
}
