// ── Custom Message Types + convertToLlm ──
// Extends pi-agent-core's AgentMessage with Purrsephone-specific types
// via TypeScript declaration merging. These are first-class in our session
// pipeline but get flattened to standard Messages before hitting the LLM.

import type { Message, UserMessage, AssistantMessage as PiAssistantMessage } from '@mariozechner/pi-ai';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { SessionEntry, CompactionSummary } from '../session/types.js';

// ── Custom message types ──

export interface CompactionMessage {
  role: 'custom';
  type: 'compaction';
  summary: string;
  coveredUpTo: number;
  timestamp: number;
}

export interface SystemNoteMessage {
  role: 'custom';
  type: 'systemNote';
  content: string;
  timestamp: number;
}

export interface ContinuityMessage {
  role: 'custom';
  type: 'continuity';
  content: string;
  originChannelId: string;
  timestamp: number;
}

export interface MirrorMessage {
  role: 'custom';
  type: 'mirror';
  content: string;
  originChannelId: string;
  sourceRole: 'user' | 'assistant';
  sourceAuthorName?: string;
  timestamp: number;
}

interface MirrorSessionMetadata {
  type: 'mirror';
  sourceChannelId?: string;
  sourceRole?: 'user' | 'assistant';
  sourceAuthorName?: string;
}

const MAX_MIRROR_RENDER_CHARS = 180;

// ── Declaration merging ──

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    compaction: CompactionMessage;
    systemNote: SystemNoteMessage;
    continuity: ContinuityMessage;
    mirror: MirrorMessage;
  }
}

// ── Type guards ──

export function isCompactionMessage(m: AgentMessage): m is CompactionMessage {
  return (m as any).role === 'custom' && (m as any).type === 'compaction';
}

export function isSystemNoteMessage(m: AgentMessage): m is SystemNoteMessage {
  return (m as any).role === 'custom' && (m as any).type === 'systemNote';
}

export function isContinuityMessage(m: AgentMessage): m is ContinuityMessage {
  return (m as any).role === 'custom' && (m as any).type === 'continuity';
}

export function isMirrorMessage(m: AgentMessage): m is MirrorMessage {
  return (m as any).role === 'custom' && (m as any).type === 'mirror';
}

export function isCustomMessage(m: AgentMessage): boolean {
  return (m as any).role === 'custom';
}

// ── convertToLlm ──

/**
 * Convert AgentMessage[] to LLM-compatible Message[].
 *
 * Standard messages (user, assistant, toolResult) pass through.
 * Custom messages are converted:
 * - compaction → user message with summary prefix
 * - systemNote → user message with [System note] prefix
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
      } satisfies UserMessage);
    } else if (isSystemNoteMessage(msg)) {
      result.push({
        role: 'user',
        content: `[System note] ${msg.content}`,
        timestamp: msg.timestamp,
      } satisfies UserMessage);
    } else if (isContinuityMessage(msg)) {
      // Continuity messages are injected into system prompt, not as individual messages.
      // Skip in LLM conversion.
      continue;
    } else if (isMirrorMessage(msg)) {
      const speaker = msg.sourceRole === 'assistant'
        ? 'Purrsephone'
        : (msg.sourceAuthorName ?? 'User');
      result.push({
        role: 'user',
        content: `[Mirror note from ${msg.originChannelId}] ${speaker}: ${compactMirrorText(msg.content)}`,
        timestamp: msg.timestamp,
      } satisfies UserMessage);
    } else {
      // Standard pi-ai Message — pass through
      result.push(msg as Message);
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
      content: entry.content,
      timestamp: ts,
    } satisfies SystemNoteMessage;
  }

  if (entry.role === 'user') {
    return {
      role: 'user',
      content: entry.content,
      timestamp: ts,
    } satisfies UserMessage;
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
  } satisfies PiAssistantMessage;
}

/**
 * Convert a CompactionSummary to a CompactionMessage.
 */
export function compactionToMessage(summary: CompactionSummary): CompactionMessage {
  return {
    role: 'custom',
    type: 'compaction',
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
    if (
      parsed.sourceRole !== undefined
      && parsed.sourceRole !== 'user'
      && parsed.sourceRole !== 'assistant'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
