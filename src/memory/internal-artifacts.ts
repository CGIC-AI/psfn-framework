import type { PurrMemory } from './types.js';

const CONTEXT_FEEDBACK_SOURCE_PREFIX = 'source:context_feedback|';
const CONTEXT_FEEDBACK_TAG = 'context_feedback';

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

export function isInternalMemoryArtifact(
  memory: Pick<PurrMemory, 'sourceRef' | 'tags'>,
): boolean {
  const sourceRef = memory.sourceRef.trim().toLowerCase();
  if (sourceRef.startsWith(CONTEXT_FEEDBACK_SOURCE_PREFIX)) {
    return true;
  }

  for (const tag of memory.tags) {
    if (normalizeTag(tag) === CONTEXT_FEEDBACK_TAG) {
      return true;
    }
  }

  return false;
}
