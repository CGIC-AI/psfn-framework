import { isRecord } from '../../shared/utils/types.js';
import type { SessionEntry } from './types.js';
import type { SessionActorKind } from './turn-provenance.js';

/**
 * Canonical speaker attribution stamped onto a session entry at write time
 * (psfn-framework-bs4m0). The raw `authorId` on a session entry is a channel
 * identity (a platform user id, an API principal, ...), never a canonical
 * contact id; authorization-bearing projections such as an episode's
 * `participantContactIds` must read this proven attribution instead.
 *
 * Only a speaker the runtime resolved to a canonical contact through the
 * contact store (a human or machine-intelligence user-role speaker) carries
 * one. Absence means "unresolved" and consumers must fail closed.
 */
interface SessionSpeakerAttributionEnvelope {
  schemaVersion: 1;
  canonicalContactId: string;
}

const SPEAKER_ATTRIBUTION_KEY = 'speakerAttribution';

function parseMetadataRecord(metadata: string | undefined): Record<string, unknown> {
  if (!metadata) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing speaker attribution');
  }
  if (!isRecord(parsed)) {
    throw new Error('Session metadata must be a JSON object for speaker attribution');
  }
  return parsed;
}

/**
 * The canonical contact id a turn may stamp as proven speaker attribution, or
 * undefined. A canonical key on a system/unknown actor (for example a system
 * speaker whose key is its raw author id) is never proof of a contact.
 */
export function resolveProvenSpeakerContactId(authorContext: {
  speakerRole: SessionEntry['role'];
  actorKind: SessionActorKind;
  canonicalContactKey?: string;
}): string | undefined {
  if (authorContext.speakerRole !== 'user') return undefined;
  if (authorContext.actorKind !== 'human' && authorContext.actorKind !== 'machine_intelligence') {
    return undefined;
  }
  const contactId = authorContext.canonicalContactKey?.trim();
  return contactId ? contactId : undefined;
}

export function buildSessionMetadataWithSpeakerAttribution(
  existingMetadata: string | undefined,
  canonicalContactId: string,
): string {
  const contactId = canonicalContactId.trim();
  if (!contactId) {
    throw new Error('Session speaker attribution requires a non-empty canonical contact id');
  }
  const base = parseMetadataRecord(existingMetadata);
  const attribution: SessionSpeakerAttributionEnvelope = {
    schemaVersion: 1,
    canonicalContactId: contactId,
  };
  return JSON.stringify({ ...base, [SPEAKER_ATTRIBUTION_KEY]: attribution });
}

/**
 * The proven canonical contact id of an entry's speaker, or undefined when the
 * entry carries no attribution (legacy rows, unresolved speakers). A present
 * but malformed attribution throws rather than being read as unresolved.
 */
export function resolveSessionEntrySpeakerContactId(
  entry: Pick<SessionEntry, 'metadata'>,
): string | undefined {
  const metadata = parseMetadataRecord(entry.metadata);
  const raw = metadata[SPEAKER_ATTRIBUTION_KEY];
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new Error('Session speaker attribution metadata is malformed');
  }
  const contactId = raw.canonicalContactId;
  if (typeof contactId !== 'string' || contactId.trim().length === 0) {
    throw new Error('Session speaker attribution canonicalContactId must be a non-empty string');
  }
  return contactId.trim();
}
