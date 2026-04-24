import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  ChannelType,
  MessageRoutingMetadata,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { ChannelVisibility } from '../../../system/trust/types.js';
import type { ApiAuthPrincipal } from '../../backplane/http/auth.js';
import type { ChatCompletionRequest } from '../types.js';
import type { TurnRoutingOverrides } from './request.js';
import { clampApiHeader, singleApiHeader } from './request.js';

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

export function getLastUserMessage(messages: ChatCompletionRequest['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return messages[messages.length - 1].content;
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
    if (msg.role === 'user') {
      if (channelPrivacy) {
        sessionManager.recordUserMessage(
          channelId,
          msg.content,
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
      sessionManager.recordUserMessage(channelId, msg.content, authorId, msg.name ?? authorName);
    } else if (msg.role === 'assistant') {
      if (channelPrivacy) {
        sessionManager.recordAssistantMessage(
          channelId,
          msg.content,
          undefined,
          undefined,
          undefined,
          {
            channelMeta: { privacyLevel: channelPrivacy },
          },
        );
        continue;
      }
      sessionManager.recordAssistantMessage(channelId, msg.content);
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
    ...(channelPrivacy ? { channelPrivacy } : {}),
    ...(overrides.modelOverride ? { modelOverride: overrides.modelOverride } : {}),
    ...(overrides.promptOverride ? { promptOverride: overrides.promptOverride } : {}),
    ...(overrides.responseStyle ? { responseStyle: overrides.responseStyle } : {}),
    ...(canonicalContactId ? { canonicalContactId } : {}),
  };
  const hasRouting = source !== 'api'
    || routing.broadcast
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
    ...(hasRouting ? { routing } : {}),
    timestamp: new Date(),
  };
}
