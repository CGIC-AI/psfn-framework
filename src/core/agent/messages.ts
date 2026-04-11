// ── Custom Message Types + convertToLlm ──
// Extends pi-agent-core's AgentMessage with companion-specific types
// via TypeScript declaration merging. These are first-class in our session
// pipeline but get flattened to standard Messages before hitting the LLM.

import type {
  Message,
  UserMessage,
  AssistantMessage as PiAssistantMessage,
  ToolResultMessage,
} from '@mariozechner/pi-ai';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { SessionEntry, CompactionSummary } from '../session/types.js';
import { parseToolObservationMetadata } from '../session/tool-observation.js';
import {
  MESSAGE_CLASSES,
  tagMessageClass,
  type MessageClassMetadata,
} from './message-classes.js';

// ── Custom message types ──

export interface CompactionMessage {
  role: 'custom';
  type: 'compaction';
  messageClass: typeof MESSAGE_CLASSES.compaction;
  summary: string;
  coveredUpTo: number;
  timestamp: number;
}

export interface SystemNoteMessage {
  role: 'custom';
  type: 'systemNote';
  messageClass: typeof MESSAGE_CLASSES.systemNote;
  content: string;
  timestamp: number;
}

export interface InternalWhisperMessage {
  role: 'custom';
  type: 'internalWhisper';
  messageClass: typeof MESSAGE_CLASSES.internalWhisper;
  content: string;
  speakerName?: string;
  timestamp: number;
}

export interface ContinuityMessage {
  role: 'custom';
  type: 'continuity';
  messageClass: typeof MESSAGE_CLASSES.continuity;
  content: string;
  originChannelId: string;
  timestamp: number;
}

export interface MirrorMessage {
  role: 'custom';
  type: 'mirror';
  messageClass: typeof MESSAGE_CLASSES.mirror;
  content: string;
  originChannelId: string;
  sourceRole: 'user' | 'assistant';
  sourceAuthorName?: string;
  timestamp: number;
}

type ClassifiedUserMessage = UserMessage & MessageClassMetadata;
type ClassifiedAssistantMessage = PiAssistantMessage & MessageClassMetadata;

interface MirrorSessionMetadata {
  type: 'mirror';
  sourceChannelId?: string;
  sourceRole?: 'user' | 'assistant';
  sourceAuthorName?: string;
}

const MAX_MIRROR_RENDER_CHARS = 180;
const LEGACY_OR_CANONICAL_MUSING_CHANNEL_PATTERN = /^internal:reflection:(musing|whisper)$/i;

function createInternalAssistantMessage(
  content: string,
  timestamp: number,
  messageClass: typeof MESSAGE_CLASSES.systemNote | typeof MESSAGE_CLASSES.internalWhisper,
): ClassifiedAssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: '',
    provider: '',
    model: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
    messageClass,
  };
}

// ── Declaration merging ──

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    compaction: CompactionMessage;
    systemNote: SystemNoteMessage;
    internalWhisper: InternalWhisperMessage;
    continuity: ContinuityMessage;
    mirror: MirrorMessage;
  }
}

// ── Type guards ──

/** Narrow AgentMessage to a record so we can check arbitrary properties without `as any`. */
function hasCustomRole(m: AgentMessage): m is AgentMessage & { role: 'custom'; type: string } {
  const record = m as unknown as Record<string, unknown>;
  return record.role === 'custom';
}

export function isCompactionMessage(m: AgentMessage): m is CompactionMessage {
  return hasCustomRole(m) && m.type === 'compaction';
}

export function isSystemNoteMessage(m: AgentMessage): m is SystemNoteMessage {
  return hasCustomRole(m) && m.type === 'systemNote';
}

export function isInternalWhisperMessage(m: AgentMessage): m is InternalWhisperMessage {
  return hasCustomRole(m) && m.type === 'internalWhisper';
}

export function isContinuityMessage(m: AgentMessage): m is ContinuityMessage {
  return hasCustomRole(m) && m.type === 'continuity';
}

export function isMirrorMessage(m: AgentMessage): m is MirrorMessage {
  return hasCustomRole(m) && m.type === 'mirror';
}

export function isCustomMessage(m: AgentMessage): boolean {
  return hasCustomRole(m);
}

function resolveStandardMessageClass(
  message: AgentMessage,
): typeof MESSAGE_CLASSES.outwardSpeech | typeof MESSAGE_CLASSES.musing {
  const existingMessageClass = (message as { messageClass?: unknown }).messageClass;
  return existingMessageClass === MESSAGE_CLASSES.musing
    ? MESSAGE_CLASSES.musing
    : MESSAGE_CLASSES.outwardSpeech;
}

function isMusingReflectionChannel(channelId: string): boolean {
  return LEGACY_OR_CANONICAL_MUSING_CHANNEL_PATTERN.test(channelId.trim());
}

// ── convertToLlm ──

/**
 * Convert AgentMessage[] to LLM-compatible Message[].
 *
 * Standard messages (user, assistant, toolResult) pass through.
 * Custom messages are converted:
 * - compaction → user message with summary prefix
 * - systemNote → assistant-side internal note with [System note] prefix
 * - internalWhisper → assistant-side internal note
 * - mirror → compact user-side mirror note
 * - continuity → filtered out (injected into system prompt instead)
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    if (isCompactionMessage(msg)) {
      result.push({
        role: 'user',
        content: `[Previous conversation summary]\n${msg.summary}`,
        timestamp: msg.timestamp,
        messageClass: MESSAGE_CLASSES.compaction,
      } satisfies ClassifiedUserMessage);
    } else if (isSystemNoteMessage(msg)) {
      result.push(createInternalAssistantMessage(
        `[System note] ${msg.content}`,
        msg.timestamp,
        MESSAGE_CLASSES.systemNote,
      ));
    } else if (isInternalWhisperMessage(msg)) {
      result.push(createInternalAssistantMessage(
        `[Internal note to self] ${msg.content}`,
        msg.timestamp,
        MESSAGE_CLASSES.internalWhisper,
      ));
    } else if (isContinuityMessage(msg)) {
      // Continuity messages are injected into system prompt, not as individual messages.
      // Skip in LLM conversion.
      continue;
    } else if (isMirrorMessage(msg)) {
      const speaker = msg.sourceAuthorName?.trim() || msg.sourceRole;
      result.push({
        role: 'user',
        content: `[Mirror note from ${msg.originChannelId}] ${speaker}: ${compactMirrorText(msg.content)}`,
        timestamp: msg.timestamp,
        messageClass: MESSAGE_CLASSES.mirror,
      } satisfies ClassifiedUserMessage);
    } else {
      // Standard pi-ai Message — pass through, preserving canonical outward subtypes.
      if (msg.role === 'user' || msg.role === 'assistant') {
        result.push(tagMessageClass(msg, resolveStandardMessageClass(msg)) as Message);
      } else {
        result.push(msg as Message);
      }
    }
  }

  return result;
}

// ── Session entry conversion ──

/**
 * Convert a SessionEntry (from JSONL) to an AgentMessage.
 * This bridges the session store format to pi-agent-core's type system.
 */
export function sessionEntryToMessage(entry: SessionEntry): AgentMessage {
  const ts = entry.timestamp;

  if (entry.role === 'system') {
    const mirrorMetadata = parseMirrorSessionMetadata(entry.metadata);
    if (mirrorMetadata) {
      return {
        role: 'custom',
        type: 'mirror',
        messageClass: MESSAGE_CLASSES.mirror,
        content: entry.content,
        originChannelId: mirrorMetadata.sourceChannelId ?? entry.originChannelId ?? entry.channelId,
        sourceRole: mirrorMetadata.sourceRole ?? 'assistant',
        sourceAuthorName: mirrorMetadata.sourceAuthorName,
        timestamp: ts,
      } satisfies MirrorMessage;
    }

    return {
      role: 'custom',
      type: 'systemNote',
      messageClass: MESSAGE_CLASSES.systemNote,
      content: entry.content,
      timestamp: ts,
    } satisfies SystemNoteMessage;
  }

  if (entry.role === 'user') {
    return {
      role: 'user',
      content: entry.content,
      timestamp: ts,
      messageClass: MESSAGE_CLASSES.outwardSpeech,
    } satisfies ClassifiedUserMessage;
  }

  if (entry.role === 'tool') {
    const toolObservation = parseToolObservationMetadata(entry.metadata);
    if (!toolObservation) {
      throw new Error(`Tool session entry ${entry.channelId}:${entry.id} is missing tool observation metadata`);
    }
    return {
      role: 'toolResult',
      toolCallId: toolObservation.toolCallId ?? `${entry.channelId}:${entry.id}`,
      toolName: toolObservation.toolName,
      content: [{ type: 'text', text: entry.content }],
      isError: toolObservation.isError ?? false,
      timestamp: ts,
    } satisfies ToolResultMessage;
  }

  // assistant
  return {
    role: 'assistant',
    content: [{ type: 'text', text: entry.content }],
    api: '',
    provider: '',
    model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: ts,
    messageClass: isMusingReflectionChannel(entry.channelId)
      ? MESSAGE_CLASSES.musing
      : MESSAGE_CLASSES.outwardSpeech,
  } satisfies ClassifiedAssistantMessage;
}

/**
 * Convert a CompactionSummary to a CompactionMessage.
 */
export function compactionToMessage(summary: CompactionSummary): CompactionMessage {
  return {
    role: 'custom',
    type: 'compaction',
    messageClass: MESSAGE_CLASSES.compaction,
    summary: summary.summary,
    coveredUpTo: summary.coveredUpTo,
    timestamp: summary.createdAt,
  };
}

function compactMirrorText(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_MIRROR_RENDER_CHARS) return normalized;
  return `${normalized.slice(0, MAX_MIRROR_RENDER_CHARS - 3)}...`;
}

function parseMirrorSessionMetadata(metadata?: string): MirrorSessionMetadata | null {
  if (!metadata) return null;

  try {
    const parsed = JSON.parse(metadata) as Partial<MirrorSessionMetadata>;
    if (parsed.type !== 'mirror') return null;
    return parsed as MirrorSessionMetadata;
  } catch {
    return null;
  }
}
