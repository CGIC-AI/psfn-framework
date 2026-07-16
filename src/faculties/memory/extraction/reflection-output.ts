import type { FinalReflectionExtractionInput } from '../../../core/agent/contracts.js';
import { isInternalReflectionSessionId } from '../../../core/session/session-id.js';
import { buildSessionMetadataWithReflectionTurn } from '../../../core/session/reflection-turn-provenance.js';
import type { SessionEntry } from '../../../core/session/types.js';

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Final reflection extraction ${field} must be non-empty`);
  }
  return normalized;
}

/**
 * Projects one canonical reflection-journal record into the transcript shape
 * consumed by experiential extraction. The journal entry itself remains the
 * durable owner; this projection is never appended to the ordinary session
 * store.
 */
export function projectFinalReflectionForExtraction(
  input: FinalReflectionExtractionInput,
  companionName: string | undefined,
): SessionEntry {
  const journalEntryId = requireNonEmpty(input.journalEntryId, 'journalEntryId');
  const channelId = requireNonEmpty(input.channelId, 'channelId');
  if (!isInternalReflectionSessionId(channelId)) {
    throw new Error('Final reflection extraction channelId must be an internal reflection channel');
  }
  const templateId = requireNonEmpty(input.templateId, 'templateId');
  const reflection = requireNonEmpty(input.reflection, 'reflection');
  const timestamp = Date.parse(input.createdAt);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
    throw new Error('Final reflection extraction createdAt must be a valid positive timestamp');
  }
  return {
    id: timestamp,
    channelId,
    role: 'assistant',
    authorId: 'companion:self-reflection',
    authorName: companionName?.trim() || 'Companion',
    content: reflection,
    timestamp,
    metadata: buildSessionMetadataWithReflectionTurn(undefined, {
      schemaVersion: 1,
      stage: 'final_output',
      templateId,
      mode: input.mode,
      journalEntryId,
    }),
  };
}
