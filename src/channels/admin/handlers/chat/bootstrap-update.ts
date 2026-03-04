import type { ChannelPrivacyLevel } from '../../../../contacts/types.js';
import { parseJsonBody } from '../../../http/primitives.js';
import type { AdminChatBootstrapUpdateInput } from '../../chat/index.js';

export function parseChatBootstrapUpdate(
  body: string,
  contentTypeHeader: string | string[] | undefined,
): AdminChatBootstrapUpdateInput {
  const contentType = Array.isArray(contentTypeHeader)
    ? (contentTypeHeader[0] ?? '')
    : (contentTypeHeader ?? '');
  const normalizedContentType = contentType.toLowerCase();
  const trimmedBody = body.trim();
  if (!trimmedBody) return {};

  if (normalizedContentType.includes('application/json') || trimmedBody.startsWith('{')) {
    const parsed = parseJsonBody(trimmedBody);
    if (!parsed.ok) {
      throw new Error('Invalid JSON payload');
    }
    return parseChatBootstrapUpdateObject(parsed.value);
  }

  const params = new URLSearchParams(body);
  const privacyLevel = params.get('privacyLevel');

  return {
    canonicalContactId: params.get('canonicalContactId') ?? undefined,
    channel: params.get('channel') ?? undefined,
    userId: params.get('userId') ?? undefined,
    privacyLevel: privacyLevel ? privacyLevel as ChannelPrivacyLevel : undefined,
    defaultAuthorName: params.get('defaultAuthorName') ?? undefined,
    defaultAuthorId: params.get('defaultAuthorId') ?? undefined,
  };
}

function parseChatBootstrapUpdateObject(parsed: unknown): AdminChatBootstrapUpdateInput {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON payload must be an object');
  }

  const payload = parsed as Record<string, unknown>;
  const privacyLevel = readOptionalStringField(payload, 'privacyLevel');

  return {
    canonicalContactId: readOptionalStringField(payload, 'canonicalContactId'),
    channel: readOptionalStringField(payload, 'channel'),
    userId: readOptionalStringField(payload, 'userId'),
    privacyLevel: privacyLevel ? privacyLevel as ChannelPrivacyLevel : undefined,
    defaultAuthorName: readOptionalStringField(payload, 'defaultAuthorName'),
    defaultAuthorId: readOptionalStringField(payload, 'defaultAuthorId'),
  };
}

function readOptionalStringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Field "${key}" must be a string`);
  }
  return value;
}
