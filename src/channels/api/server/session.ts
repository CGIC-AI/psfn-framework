import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  Attachment,
  ChannelType,
  MessageRoutingMetadata,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { SatelliteRoutingMetadata } from '../../../shared/contracts/satellite-registry.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { ChannelVisibility } from '../../../system/trust/types.js';
import type { ApiAuthPrincipal } from '../../backplane/http/auth.js';
import type { ChatCompletionRequest } from '../types.js';
import type { TurnRoutingOverrides } from './request.js';
import { clampApiHeader, singleApiHeader } from './request.js';

const MAX_INLINE_CHAT_IMAGES = 4;
const DATA_IMAGE_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is;
const IMAGE_EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export interface ApiRequestAuthor {
  authorId: string;
  authorName: string;
}

export function deriveChannelId(req: IncomingMessage, principal: ApiAuthPrincipal): string {
  const sessionId = clampApiHeader(
    singleApiHeader(req.headers['x-session-id']),
    128,
  );
  if (sessionId) {
    return `api:${principal.id}:${sessionId}`;
  }

  return `api:${principal.id}`;
}

export function deriveAuthor(principal: ApiAuthPrincipal): ApiRequestAuthor {
  return {
    authorId: principal.id,
    authorName: principal.mode === 'api_key' ? 'API Principal' : 'Local API Principal',
  };
}

export function getMessageTextContent(message: ChatCompletionRequest['messages'][number]): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(text => text.length > 0)
    .join('\n');
}

export function getLastUserMessage(messages: ChatCompletionRequest['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return getMessageTextContent(messages[i]);
  }
  return getMessageTextContent(messages[messages.length - 1]);
}

export function getLastUserMessageAttachments(messages: ChatCompletionRequest['messages']): Attachment[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return getMessageImageAttachments(messages[i]);
  }
  return getMessageImageAttachments(messages[messages.length - 1]);
}

export function getMessageImageAttachments(
  message: ChatCompletionRequest['messages'][number],
): Attachment[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const attachments: Attachment[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const attachment = contentPartToImageAttachment(part, attachments.length);
    if (attachment) attachments.push(attachment);
    if (attachments.length >= MAX_INLINE_CHAT_IMAGES) break;
  }
  return attachments;
}

export function seedSession(params: {
  sessionManager: SessionManager;
  channelId: string;
  messages: ChatCompletionRequest['messages'];
  authorId: string;
  authorName: string;
  channelPrivacy?: ChannelVisibility;
}): void {
  const {
    sessionManager,
    channelId,
    messages,
    authorId,
    authorName,
    channelPrivacy,
  } = params;

  // Only seed if this session has no prior messages.
  const count = sessionManager.getMessageCount(channelId);
  if (count > 0) return;

  // Seed all messages except the last user message, which handleMessage records.
  const prior = messages.slice(0, -1);
  for (const msg of prior) {
    const content = getMessageTextContent(msg);
    if (msg.role === 'user') {
      if (channelPrivacy) {
        sessionManager.recordUserMessage(
          channelId,
          content,
          authorId,
          msg.name ?? authorName,
          undefined,
          undefined,
          {
            channelMeta: { privacyLevel: channelPrivacy },
          },
        );
        continue;
      }
      sessionManager.recordUserMessage(channelId, content, authorId, msg.name ?? authorName);
    } else if (msg.role === 'assistant') {
      if (channelPrivacy) {
        sessionManager.recordAssistantMessage(
          channelId,
          content,
          undefined,
          undefined,
          undefined,
          {
            channelMeta: { privacyLevel: channelPrivacy },
          },
        );
        continue;
      }
      sessionManager.recordAssistantMessage(channelId, content);
    }
    // system messages are handled via systemPrompt, skip
  }
}

export function buildSubstrateMessage(params: {
  channelId: string;
  channelType: ChannelType;
  source: NonNullable<MessageRoutingMetadata['source']>;
  content: string;
  authorId: string;
  authorName: string;
  req: IncomingMessage;
  overrides: TurnRoutingOverrides;
  channelPrivacy?: ChannelVisibility;
  canonicalContactId?: string;
  satellite?: SatelliteRoutingMetadata;
  attachments?: Attachment[];
}): SubstrateMessage {
  const {
    channelId,
    channelType,
    source,
    content,
    authorId,
    authorName,
    req,
    overrides,
    channelPrivacy,
    canonicalContactId,
    satellite,
    attachments,
  } = params;
  const approvalToken = clampApiHeader(
    singleApiHeader(req.headers['x-broadcast-approval-token']),
    256,
  );
  const requestedScope = clampApiHeader(
    singleApiHeader(req.headers['x-broadcast-visibility-scope']),
    64,
  );
  const visibilityScope = requestedScope === 'public_only' || requestedScope === 'approved_private_context'
    ? requestedScope
    : undefined;
  const routing: MessageRoutingMetadata = {
    source,
    ...(approvalToken || visibilityScope
      ? {
        broadcast: {
          ...(approvalToken ? { approvalToken } : {}),
          ...(visibilityScope ? { visibilityScope } : {}),
        },
      }
      : {}),
    ...(satellite ? { satellite } : {}),
    ...(channelPrivacy ? { channelPrivacy } : {}),
    ...(overrides.modelOverride ? { modelOverride: overrides.modelOverride } : {}),
    ...(overrides.promptOverride ? { promptOverride: overrides.promptOverride } : {}),
    ...(overrides.responseStyle ? { responseStyle: overrides.responseStyle } : {}),
    ...(canonicalContactId ? { canonicalContactId } : {}),
  };
  const hasRouting = source !== 'api'
    || routing.broadcast
    || routing.satellite
    || routing.channelPrivacy
    || routing.modelOverride
    || routing.promptOverride
    || routing.responseStyle
    || routing.canonicalContactId;

  return {
    id: `api-${randomUUID()}`,
    channelId,
    channelType,
    authorId,
    authorName,
    content,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(hasRouting ? { routing } : {}),
    timestamp: new Date(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function contentPartToImageAttachment(part: Record<string, unknown>, index: number): Attachment | null {
  if (part.type === 'image') {
    const data = typeof part.data === 'string' ? normalizeBase64(part.data) : '';
    const mimeType = typeof part.mimeType === 'string' ? normalizeImageContentType(part.mimeType) : '';
    if (!data || !mimeType) return null;
    const name = typeof part.name === 'string' && part.name.trim()
      ? part.name.trim()
      : inlineImageName(index, mimeType);
    return {
      url: `inline:image:${index}`,
      contentType: mimeType,
      name,
      dataBase64: data,
    };
  }

  if (part.type !== 'image_url') return null;
  const imageUrl = part.image_url;
  const rawUrl = typeof imageUrl === 'string'
    ? imageUrl
    : isRecord(imageUrl) && typeof imageUrl.url === 'string'
      ? imageUrl.url
      : '';
  const normalizedUrl = rawUrl.trim();
  if (!normalizedUrl) return null;

  const dataUrl = parseImageDataUrl(normalizedUrl);
  if (dataUrl) {
    return {
      url: `inline:image:${index}`,
      contentType: dataUrl.mimeType,
      name: inlineImageName(index, dataUrl.mimeType),
      dataBase64: dataUrl.dataBase64,
    };
  }

  return {
    url: normalizedUrl,
    contentType: inferImageContentType(normalizedUrl) ?? 'application/octet-stream',
    name: inferImageName(normalizedUrl, index),
  };
}

function parseImageDataUrl(url: string): { mimeType: string; dataBase64: string } | null {
  const match = DATA_IMAGE_URL_PATTERN.exec(url.trim());
  if (!match) return null;
  const mimeType = normalizeImageContentType(match[1]);
  const dataBase64 = normalizeBase64(match[2]);
  if (!mimeType || !dataBase64) return null;
  return { mimeType, dataBase64 };
}

function normalizeImageContentType(value: string): string {
  const normalized = value.split(';')[0].trim().toLowerCase();
  return normalized.startsWith('image/') ? normalized : '';
}

function normalizeBase64(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

function inlineImageName(index: number, mimeType: string): string {
  const extension = Object.entries(IMAGE_EXTENSION_CONTENT_TYPES)
    .find(([, contentType]) => contentType === mimeType)?.[0] ?? '.bin';
  return `inline-image-${index + 1}${extension}`;
}

function inferImageContentType(url: string): string | undefined {
  const name = inferImageName(url, 0);
  const lowerName = name.toLowerCase();
  return Object.entries(IMAGE_EXTENSION_CONTENT_TYPES)
    .find(([extension]) => lowerName.endsWith(extension))?.[1];
}

function inferImageName(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).at(-1);
    if (segment) return decodeURIComponent(segment);
  } catch {
    // Keep the fallback below for malformed URL strings; validation happens later.
  }
  return `image-${index + 1}`;
}
