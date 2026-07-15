import type { PurrMemory } from './types.js';

function normalizedId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Canonical mention-routing subject fallback shared by social-graph evidence
 * and the privacy projection. Source speakers and trigger contacts are not
 * subjects merely because a fact was routed through them.
 */
export function resolveCanonicalMemorySubjectContactId(
  memory: Pick<PurrMemory, 'contactId' | 'provenance'>,
): string | undefined {
  const provenance = memory.provenance;
  const explicit = normalizedId(provenance?.subjectContactId);
  if (explicit) return explicit;

  const mentionContactId = normalizedId(memory.contactId);
  const routedContactId = normalizedId(provenance?.routedContactId);
  const sourceContactId = normalizedId(provenance?.sourceContactId);
  const triggerContactId = normalizedId(provenance?.triggerContactId);
  if (
    mentionContactId
    && mentionContactId !== routedContactId
    && mentionContactId !== sourceContactId
    && mentionContactId !== triggerContactId
  ) {
    return mentionContactId;
  }

  if (!routedContactId || routedContactId === triggerContactId) return undefined;
  return routedContactId;
}
