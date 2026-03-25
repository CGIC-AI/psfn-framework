import { createHash } from 'node:crypto';
import {
  CHANNEL_TYPES,
  type ChannelType,
  type MessageRoutingMetadata,
  type ObservabilityCallType,
  type PostTurnActionCandidate,
  type SubstrateMessage,
} from '../types.js';

export const DEFERRED_TOOL_HANDOFF_ACTION_KIND = 'tool_handoff.continue';
export const DEFAULT_DEFERRED_TOOL_HANDOFF_MAX_RETRIES = 2;
export const DEFERRED_TOOL_HANDOFF_MESSAGE_ID_PREFIX = 'deferred-tool-handoff:';
const MAX_DEFERRED_TOOL_HANDOFF_MAX_RETRIES = 4;

const VALID_CHANNEL_TYPES = new Set<ChannelType>(CHANNEL_TYPES);
const VALID_CALL_TYPES = new Set<ObservabilityCallType>([
  'chat',
  'tool',
  'memory',
  'summary',
  'background',
  'scheduled',
]);

export interface DeferredToolHandoffIntent {
  toolNames: string[];
  intendedAction: string;
  maxRetries?: number;
  sessionId?: string;
}

export interface DeferredToolHandoffTurnMetadata {
  turnId: string;
  requestId: string;
  channelId: string;
  sessionId?: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  callType: ObservabilityCallType;
  isDirectMessage?: boolean;
  routing?: MessageRoutingMetadata;
}

export interface DeferredToolHandoffPayload {
  toolNames: string[];
  intendedAction: string;
  turn: DeferredToolHandoffTurnMetadata;
}

export function parseDeferredToolHandoffActionId(messageId: string): string | null {
  const trimmed = messageId.trim();
  if (!trimmed.startsWith(DEFERRED_TOOL_HANDOFF_MESSAGE_ID_PREFIX)) {
    return null;
  }
  const actionId = trimmed.slice(DEFERRED_TOOL_HANDOFF_MESSAGE_ID_PREFIX.length).trim();
  return actionId.length > 0 ? actionId : null;
}

export function isDeferredToolHandoffMessageId(messageId: string): boolean {
  return parseDeferredToolHandoffActionId(messageId) !== null;
}

function normalizeMaxRetries(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return undefined;
  }
  return Math.min(MAX_DEFERRED_TOOL_HANDOFF_MAX_RETRIES, Math.floor(raw));
}

function normalizeSessionId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeToolNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const deduped = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
  }
  return [...deduped];
}

export function normalizeDeferredToolHandoffIntent(raw: unknown): DeferredToolHandoffIntent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const toolNames = normalizeToolNameList(candidate.toolNames);
  const intendedAction = typeof candidate.intendedAction === 'string'
    ? candidate.intendedAction.trim()
    : '';
  if (toolNames.length === 0 || !intendedAction) {
    return null;
  }

  const maxRetries = normalizeMaxRetries(candidate.maxRetries);
  const sessionId = normalizeSessionId(candidate.sessionId);
  return {
    toolNames,
    intendedAction,
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export function buildDeferredToolHandoffCandidate(
  intent: DeferredToolHandoffIntent,
  message: SubstrateMessage,
  callType: ObservabilityCallType,
): PostTurnActionCandidate {
  const payload: DeferredToolHandoffPayload = {
    toolNames: intent.toolNames,
    intendedAction: intent.intendedAction,
    turn: {
      turnId: message.id,
      requestId: message.id,
      channelId: message.channelId,
      ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
      channelType: message.channelType,
      authorId: message.authorId,
      authorName: message.authorName,
      callType,
      ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
      ...(message.routing ? { routing: { ...message.routing } } : {}),
    },
  };

  const dedupeHash = createHash('sha256')
    .update(`${payload.turn.turnId}:${payload.toolNames.join(',')}:${payload.intendedAction}`)
    .digest('hex')
    .slice(0, 16);

  const maxRetries = intent.maxRetries ?? DEFAULT_DEFERRED_TOOL_HANDOFF_MAX_RETRIES;
  return {
    kind: DEFERRED_TOOL_HANDOFF_ACTION_KIND,
    payload: payload as unknown as Record<string, unknown>,
    dedupeKey: `${DEFERRED_TOOL_HANDOFF_ACTION_KIND}:${payload.turn.turnId}:${dedupeHash}`,
    maxRetries,
  };
}

export function normalizeDeferredToolHandoffPayload(raw: unknown): DeferredToolHandoffPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const toolNames = normalizeToolNameList(candidate.toolNames);
  const intendedAction = typeof candidate.intendedAction === 'string'
    ? candidate.intendedAction.trim()
    : '';
  if (toolNames.length === 0 || !intendedAction) {
    return null;
  }

  const turn = candidate.turn;
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
    return null;
  }
  const turnCandidate = turn as Record<string, unknown>;
  const turnId = typeof turnCandidate.turnId === 'string' ? turnCandidate.turnId.trim() : '';
  const requestId = typeof turnCandidate.requestId === 'string' ? turnCandidate.requestId.trim() : '';
  const channelId = typeof turnCandidate.channelId === 'string' ? turnCandidate.channelId.trim() : '';
  const channelTypeRaw = typeof turnCandidate.channelType === 'string' ? turnCandidate.channelType.trim() : '';
  const authorId = typeof turnCandidate.authorId === 'string' ? turnCandidate.authorId.trim() : '';
  const authorName = typeof turnCandidate.authorName === 'string' ? turnCandidate.authorName.trim() : '';
  const callTypeRaw = typeof turnCandidate.callType === 'string' ? turnCandidate.callType.trim() : '';

  if (!turnId || !requestId || !channelId || !authorId || !authorName) {
    return null;
  }
  if (!VALID_CHANNEL_TYPES.has(channelTypeRaw as ChannelType)) {
    return null;
  }
  if (!VALID_CALL_TYPES.has(callTypeRaw as ObservabilityCallType)) {
    return null;
  }

  const isDirectMessage = typeof turnCandidate.isDirectMessage === 'boolean'
    ? turnCandidate.isDirectMessage
    : undefined;
  const sessionId = normalizeSessionId(turnCandidate.sessionId);
  const routing = (
    turnCandidate.routing
    && typeof turnCandidate.routing === 'object'
    && !Array.isArray(turnCandidate.routing)
  )
    ? turnCandidate.routing as MessageRoutingMetadata
    : undefined;

  return {
    toolNames,
    intendedAction,
    turn: {
      turnId,
      requestId,
      channelId,
      ...(sessionId ? { sessionId } : {}),
      channelType: channelTypeRaw as ChannelType,
      authorId,
      authorName,
      callType: callTypeRaw as ObservabilityCallType,
      ...(isDirectMessage !== undefined ? { isDirectMessage } : {}),
      ...(routing ? { routing } : {}),
    },
  };
}

export function buildDeferredToolHandoffMessage(
  actionId: string,
  payload: DeferredToolHandoffPayload,
): SubstrateMessage {
  return {
    id: `${DEFERRED_TOOL_HANDOFF_MESSAGE_ID_PREFIX}${actionId}`,
    channelId: payload.turn.sessionId ?? payload.turn.channelId,
    channelType: payload.turn.channelType,
    authorId: payload.turn.authorId,
    authorName: payload.turn.authorName,
    content: payload.intendedAction,
    timestamp: new Date(),
    ...(payload.turn.isDirectMessage !== undefined ? { isDirectMessage: payload.turn.isDirectMessage } : {}),
    ...(payload.turn.routing ? { routing: { ...payload.turn.routing } } : {}),
  };
}
