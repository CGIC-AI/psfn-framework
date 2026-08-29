import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  FREE_TIME_CHANNEL_PREFIX,
  isInternalReflectionSessionId,
  isInternalSessionId,
  isTestingSessionId,
} from './session-id.js';
import type { SessionEntry } from './types.js';

export const SESSION_CONVERSATIONAL_ACTIVITY_KINDS = [
  'direct_message',
  'group_conversation',
  'inter_companion',
  'experiential_free_time',
  'automation_scaffold',
  'journal',
  'health',
  'maintenance',
  'testing',
] as const;

type SessionConversationalActivityKind =
  (typeof SESSION_CONVERSATIONAL_ACTIVITY_KINDS)[number];

export type ProcessableConversationKind = Extract<
  SessionConversationalActivityKind,
  'direct_message' | 'group_conversation' | 'inter_companion' | 'experiential_free_time'
>;

export interface SessionConversationOrigin {
  schemaVersion: 1;
  kind: ProcessableConversationKind;
}

export interface ClassifiedConversationalActivity {
  kind: SessionConversationalActivityKind;
  processable: boolean;
}

export function resolveSessionConversationOrigin(input: {
  logicalSessionId: string;
  isDirectMessage?: boolean;
  channelVisibility?: string;
}): SessionConversationOrigin | null {
  if (parseCompanionChannelId(input.logicalSessionId)) {
    return { schemaVersion: 1, kind: 'inter_companion' };
  }
  if (input.logicalSessionId.startsWith(FREE_TIME_CHANNEL_PREFIX)) {
    return { schemaVersion: 1, kind: 'experiential_free_time' };
  }
  if (isInternalSessionId(input.logicalSessionId)) return null;
  if (input.isDirectMessage === false) {
    return { schemaVersion: 1, kind: 'group_conversation' };
  }
  if (input.isDirectMessage === true) {
    return { schemaVersion: 1, kind: 'direct_message' };
  }
  return {
    schemaVersion: 1,
    kind: input.channelVisibility === 'public' || input.channelVisibility === 'invite_only'
      ? 'group_conversation'
      : 'direct_message',
  };
}

export function buildSessionMetadataWithConversationOrigin(
  existingMetadata: string | undefined,
  origin: SessionConversationOrigin | null,
): string | undefined {
  if (!origin) return existingMetadata;
  let envelope: unknown = {};
  if (existingMetadata !== undefined) {
    try {
      envelope = JSON.parse(existingMetadata);
    } catch {
      throw new Error('Session metadata is malformed JSON; refusing conversation-origin merge');
    }
  }
  if (!isRecord(envelope)) {
    throw new Error('Session metadata must be an object for conversation-origin merge');
  }
  return JSON.stringify({
    ...envelope,
    conversationOrigin: origin,
  });
}

const PROCESSABLE_KINDS = new Set<SessionConversationalActivityKind>([
  'direct_message',
  'group_conversation',
  'inter_companion',
  'experiential_free_time',
]);

const AUTOMATION_SCAFFOLD_SOURCES = new Set([
  'ambient_presence',
  'temporal_wakeup_morning',
  'temporal_wakeup_refresher',
  'free_time_block',
  'free_time_return',
  'room_entry',
]);

interface ParsedActivityMetadata {
  valid: boolean;
  conversationOrigin?: SessionConversationOrigin;
  sessionLaneSource?: string;
  testingHarness: boolean;
  reflectionTurn: boolean;
}

function isProcessableKind(value: unknown): value is ProcessableConversationKind {
  return value === 'direct_message'
    || value === 'group_conversation'
    || value === 'inter_companion'
    || value === 'experiential_free_time';
}

function parseActivityMetadata(metadata: string | undefined): ParsedActivityMetadata {
  if (metadata === undefined) {
    return { valid: true, testingHarness: false, reflectionTurn: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(metadata);
  } catch {
    return { valid: false, testingHarness: false, reflectionTurn: false };
  }
  if (!isRecord(value)) {
    return { valid: false, testingHarness: false, reflectionTurn: false };
  }

  let conversationOrigin: SessionConversationOrigin | undefined;
  if (value.conversationOrigin !== undefined) {
    if (
      !isRecord(value.conversationOrigin)
      || value.conversationOrigin.schemaVersion !== 1
      || !isProcessableKind(value.conversationOrigin.kind)
    ) {
      return { valid: false, testingHarness: false, reflectionTurn: false };
    }
    conversationOrigin = {
      schemaVersion: 1,
      kind: value.conversationOrigin.kind,
    };
  }

  const sessionLaneSource = isRecord(value.sessionLane)
    && typeof value.sessionLane.source === 'string'
    ? value.sessionLane.source
    : undefined;
  return {
    valid: true,
    ...(conversationOrigin ? { conversationOrigin } : {}),
    ...(sessionLaneSource ? { sessionLaneSource } : {}),
    testingHarness: value.testingHarness !== undefined,
    reflectionTurn: value.reflectionTurn !== undefined,
  };
}

function classified(kind: SessionConversationalActivityKind): ClassifiedConversationalActivity {
  return { kind, processable: PROCESSABLE_KINDS.has(kind) };
}

/**
 * Classify one durable L0 message revision for maintenance workset eligibility.
 * Unknown or malformed metadata fails closed. A processable classification is
 * based on conversational authorship plus an allowed session origin; recency
 * timestamps do not participate.
 */
export function classifyConversationalActivity(
  entry: Pick<
    SessionEntry,
    'channelId' | 'role' | 'metadata' | 'channelVisibility'
  >,
): ClassifiedConversationalActivity {
  const metadata = parseActivityMetadata(entry.metadata);
  if (!metadata.valid) return classified('maintenance');
  if (isTestingSessionId(entry.channelId) || metadata.testingHarness) {
    return classified('testing');
  }
  if (
    entry.channelId.startsWith('internal:health:')
    || entry.channelId.startsWith('internal:heartbeat:')
    || metadata.sessionLaneSource === 'health'
    || metadata.sessionLaneSource === 'healthcheck'
  ) {
    return classified('health');
  }
  if (isInternalReflectionSessionId(entry.channelId) || metadata.reflectionTurn) {
    return classified('journal');
  }
  if (entry.role === 'system' && metadata.sessionLaneSource
    && AUTOMATION_SCAFFOLD_SOURCES.has(metadata.sessionLaneSource)) {
    return classified('automation_scaffold');
  }
  if (entry.channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)) {
    return entry.role === 'assistant'
      ? classified('experiential_free_time')
      : classified('automation_scaffold');
  }
  if (entry.role !== 'user' && entry.role !== 'assistant') {
    return classified(entry.role === 'system' ? 'automation_scaffold' : 'maintenance');
  }
  if (isInternalSessionId(entry.channelId)) return classified('maintenance');

  const companionChannel = parseCompanionChannelId(entry.channelId);
  if (companionChannel) return classified('inter_companion');

  if (metadata.conversationOrigin) {
    return classified(metadata.conversationOrigin.kind);
  }
  return classified(
    entry.channelVisibility === 'public' || entry.channelVisibility === 'invite_only'
      ? 'group_conversation'
      : 'direct_message',
  );
}
