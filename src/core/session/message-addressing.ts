import type { MessageAddressingMetadata } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';

export const SESSION_MESSAGE_ADDRESSING_METADATA_KEY = 'messageAddressing';

function parseMetadataObject(metadata: string | undefined): Record<string, unknown> {
  if (!metadata) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing message addressing fallback');
  }
  if (!isRecord(parsed)) {
    throw new Error('Session metadata must be a JSON object for message addressing');
  }
  return parsed;
}

function parseRequiredText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Session message addressing field "${fieldName}" must be a non-empty string`);
  }
  return value.trim();
}

function normalizeMessageAddressing(value: unknown): MessageAddressingMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Session message addressing must be a schemaVersion 1 object');
  }
  if (!Array.isArray(value.mentionedTargets)) {
    throw new Error('Session message addressing mentionedTargets must be an array');
  }
  const seenAuthorIds = new Set<string>();
  const mentionedTargets = value.mentionedTargets.map((target, index) => {
    if (!isRecord(target)) {
      throw new Error(`Session message addressing mentionedTargets[${index}] must be an object`);
    }
    const authorId = parseRequiredText(target.authorId, `mentionedTargets[${index}].authorId`);
    const authorName = parseRequiredText(target.authorName, `mentionedTargets[${index}].authorName`);
    if (seenAuthorIds.has(authorId)) {
      throw new Error(`Session message addressing contains duplicate target "${authorId}"`);
    }
    seenAuthorIds.add(authorId);
    return { authorId, authorName };
  });
  return { schemaVersion: 1, mentionedTargets };
}

export function buildSessionMetadataWithMessageAddressing(
  existingMetadata: string | undefined,
  addressing: MessageAddressingMetadata,
): string {
  const base = parseMetadataObject(existingMetadata);
  return JSON.stringify({
    ...base,
    [SESSION_MESSAGE_ADDRESSING_METADATA_KEY]: normalizeMessageAddressing(addressing),
  });
}

export function parseSessionMessageAddressing(
  metadata: string | undefined,
): MessageAddressingMetadata | null {
  const envelope = parseMetadataObject(metadata);
  if (!Object.hasOwn(envelope, SESSION_MESSAGE_ADDRESSING_METADATA_KEY)) {
    return null;
  }
  const addressing = envelope[SESSION_MESSAGE_ADDRESSING_METADATA_KEY];
  return normalizeMessageAddressing(addressing);
}
