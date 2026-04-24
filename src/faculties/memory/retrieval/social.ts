import { tokenizeForExplicitMatch } from './scoring.js';
import type { RetrievalContactContext } from './types.js';

export function normalizeRelationCue(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, ' ');
}

export function mergeRetrievalContactContext(
  existing: RetrievalContactContext | undefined,
  incoming: RetrievalContactContext,
): RetrievalContactContext {
  if (!existing) return incoming;
  return {
    ...existing,
    relationshipLabels: [...new Set([
      ...existing.relationshipLabels,
      ...incoming.relationshipLabels,
    ])],
    relatedToCanonical: existing.relatedToCanonical || incoming.relatedToCanonical,
  };
}

export function querySuggestsContactFocus(
  queryTokens: ReadonlySet<string>,
  contact: Pick<RetrievalContactContext, 'displayName' | 'relationshipType' | 'relationshipLabels'>,
): boolean {
  if (queryTokens.size === 0) return false;

  const cues = new Set<string>([
    ...tokenizeForExplicitMatch(contact.displayName),
    ...tokenizeForExplicitMatch(normalizeRelationCue(contact.relationshipType)),
  ]);
  for (const label of contact.relationshipLabels) {
    for (const token of tokenizeForExplicitMatch(label)) {
      cues.add(token);
    }
  }

  for (const cue of cues) {
    if (queryTokens.has(cue)) {
      return true;
    }
  }
  return false;
}
