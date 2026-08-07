import type { MessageAddressingMetadata } from '../../shared/contracts/runtime.js';
import { parseMessageAddressingMetadata } from '../../shared/contracts/message-addressing.js';
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

export function buildSessionMetadataWithMessageAddressing(
  existingMetadata: string | undefined,
  addressing: MessageAddressingMetadata,
): string {
  const base = parseMetadataObject(existingMetadata);
  return JSON.stringify({
    ...base,
    [SESSION_MESSAGE_ADDRESSING_METADATA_KEY]: parseMessageAddressingMetadata(addressing),
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
  return parseMessageAddressingMetadata(addressing);
}
