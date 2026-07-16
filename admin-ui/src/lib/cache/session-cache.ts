import type {
  AdminSessionListData,
  AdminSessionMessagesData,
} from '$lib/types';
import type { LocalFirstMergeResult } from './local-first';
import {
  isFiniteNumber,
  isNonNegativeInteger,
  isOptionalString,
  isPositiveInteger,
  isRecord,
} from './validation';

function isSessionListRow(value: unknown): boolean {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && typeof value.channelId === 'string'
    && isNonNegativeInteger(value.messageCount)
    && (value.lastActivityAt === undefined || isFiniteNumber(value.lastActivityAt))
    && isOptionalString(value.displayLabel);
}

export function isAdminSessionListData(value: unknown): value is AdminSessionListData {
  if (!isRecord(value) || !Array.isArray(value.channels) || !value.channels.every(isSessionListRow)) {
    return false;
  }
  const ids = value.channels.map(channel => channel.sessionId);
  return new Set(ids).size === ids.length;
}

function isSessionRole(value: unknown): boolean {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool';
}

function isSessionEntry(value: unknown): boolean {
  return isRecord(value)
    && isPositiveInteger(value.id)
    && typeof value.channelId === 'string'
    && isSessionRole(value.role)
    && typeof value.content === 'string'
    && isFiniteNumber(value.timestamp)
    && isOptionalString(value.authorId)
    && isOptionalString(value.authorName)
    && isOptionalString(value.discordMessageId)
    && isOptionalString(value.metadata)
    && isOptionalString(value.originChannelId)
    && isOptionalString(value.channelVisibility);
}

function isNullablePositiveInteger(value: unknown): boolean {
  return value === null || isPositiveInteger(value);
}

function isPagination(
  value: unknown,
): value is AdminSessionMessagesData['pagination'] {
  return isRecord(value)
    && isPositiveInteger(value.limit)
    && isNullablePositiveInteger(value.beforeId)
    && isNullablePositiveInteger(value.nextBeforeId)
    && typeof value.hasMoreOlder === 'boolean'
    && isNonNegativeInteger(value.totalMessages)
    && isNonNegativeInteger(value.returnedMessages);
}

function isPromptRole(value: unknown): boolean {
  return value === 'user' || value === 'assistant' || value === 'toolResult' || value === 'custom';
}

function isSemanticType(value: unknown): boolean {
  return value === 'outwardSpeech'
    || value === 'toolResult'
    || value === 'systemNote'
    || value === 'mirror';
}

function isPromptVisibility(value: unknown): boolean {
  return value === 'prompt_visible' || value === 'operator_only';
}

function isMessageOntologyView(value: unknown): boolean {
  return isRecord(value)
    && isPositiveInteger(value.sessionEntryId)
    && isSessionRole(value.transportRole)
    && isPromptRole(value.promptRole)
    && isSemanticType(value.semanticType)
    && (value.messageClass === null || typeof value.messageClass === 'string')
    && isPromptVisibility(value.promptVisibility)
    && typeof value.displayLabel === 'string';
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isCompactionAudit(value: unknown): boolean {
  return isRecord(value)
    && isPositiveInteger(value.id)
    && isFiniteNumber(value.createdAt)
    && isNonNegativeInteger(value.coveredUpTo)
    && typeof value.summary === 'string'
    && (value.sourceHash === null || typeof value.sourceHash === 'string')
    && isNullableNumber(value.sourceFirstMessageId)
    && isNullableNumber(value.sourceLastMessageId)
    && isNullableNumber(value.sourceMessageCount)
    && typeof value.verification === 'string'
    && typeof value.verificationDetail === 'string';
}

export function isAdminSessionMessagesData(value: unknown): value is AdminSessionMessagesData {
  if (!isRecord(value)
    || typeof value.sessionId !== 'string'
    || typeof value.channelId !== 'string'
    || !Array.isArray(value.messages)
    || !value.messages.every(isSessionEntry)
    || !isPagination(value.pagination)
    || !Array.isArray(value.messageOntologyViews)
    || !value.messageOntologyViews.every(isMessageOntologyView)
    || !Array.isArray(value.compactionAuditViews)
    || !value.compactionAuditViews.every(isCompactionAudit)
    || !Array.isArray(value.roleEnvelopePreviews)
    || value.roleEnvelopePreviews.length !== 0
    || !Array.isArray(value.turns)
    || value.turns.length !== 0) {
    return false;
  }
  const ids = value.messages.map(message => message.id);
  return new Set(ids).size === ids.length
    && value.pagination.returnedMessages === value.messages.length;
}

export function sessionMessageCursor(data: AdminSessionMessagesData): string | null {
  let maximum = 0;
  for (const message of data.messages) maximum = Math.max(maximum, message.id);
  return maximum > 0 ? String(maximum) : null;
}

export function mergeSessionMessagePages(
  cached: AdminSessionMessagesData,
  fresh: AdminSessionMessagesData,
  storedCursor: string | null,
): LocalFirstMergeResult<AdminSessionMessagesData> {
  if (cached.sessionId !== fresh.sessionId || cached.channelId !== fresh.channelId) {
    return { kind: 'stale_cursor' };
  }
  const cachedCursor = sessionMessageCursor(cached);
  if (storedCursor !== cachedCursor) return { kind: 'stale_cursor' };
  const freshCursor = sessionMessageCursor(fresh);
  if (cachedCursor !== null) {
    if (fresh.pagination.totalMessages < cached.pagination.totalMessages || freshCursor === null) {
      return { kind: 'stale_cursor' };
    }
    const cachedMaximum = Number(cachedCursor);
    const freshMaximum = Number(freshCursor);
    const overlaps = fresh.messages.some(message => message.id === cachedMaximum);
    if (freshMaximum < cachedMaximum || (freshMaximum > cachedMaximum && !overlaps)) {
      return { kind: 'stale_cursor' };
    }
  }

  const byId = new Map(cached.messages.map(message => [message.id, message]));
  for (const message of fresh.messages) byId.set(message.id, message);
  const messages = [...byId.values()]
    .sort((left, right) => left.id - right.id)
    .slice(-fresh.pagination.limit);
  const retainedIds = new Set(messages.map(message => message.id));
  const ontologyById = new Map(
    cached.messageOntologyViews.map(view => [view.sessionEntryId, view]),
  );
  for (const view of fresh.messageOntologyViews) ontologyById.set(view.sessionEntryId, view);
  const messageOntologyViews = [...ontologyById.values()]
    .filter(view => retainedIds.has(view.sessionEntryId));
  const data: AdminSessionMessagesData = {
    ...fresh,
    messages,
    messageOntologyViews,
    pagination: {
      ...fresh.pagination,
      returnedMessages: messages.length,
    },
  };
  return { kind: 'merged', data, cursor: sessionMessageCursor(data) };
}
