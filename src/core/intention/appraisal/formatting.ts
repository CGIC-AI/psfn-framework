import {
  formatActiveDateTimeLabel,
} from '../../../shared/time/active-timezone.js';
import {
  formatAttributedSystemContent,
  isIntentionAppraisalArtifact,
  normalizeSessionEntryAttribution,
} from '../../session/entry-attribution.js';
import type { SessionEntryRole } from '../../session/types.js';
import type { IntentionAppraisalMessage } from './types.js';

export function formatPromptTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return formatActiveDateTimeLabel(new Date(Math.floor(value)));
}

export interface PostTurnAppraisalTranscriptInput {
  recentSessionEntries: ReadonlyArray<{
    role: string;
    content: string;
    timestamp: number;
    authorId?: string;
    authorName?: string;
    metadata?: string;
    channelId?: string;
  }>;
  currentUserMessage: {
    content: string;
    timestampMs: number;
  };
  /** Trimmed outward reply for the turn; empty string when the turn sent nothing. */
  currentAssistantReply: string;
  nowMs: number;
}

/**
 * Build the conversation transcript for post-turn intention appraisal.
 *
 * The recent-session window is fetched AFTER the turn persisted its user
 * message and assistant reply, so those entries are usually already in the
 * window. Appending the current exchange unconditionally therefore showed the
 * appraisal model the last exchange twice, and it concluded the companion had
 * a "repetition glitch" and issued self-silencing whispers (psfn-framework-gexb).
 * Entries at or after the current user message timestamp are dropped and the
 * canonical exchange is appended exactly once, independent of persistence
 * timing.
 */
export function buildPostTurnAppraisalTranscript(
  input: PostTurnAppraisalTranscriptInput,
): IntentionAppraisalMessage[] {
  const cutoffMs = input.currentUserMessage.timestampMs;
  const historicalEntries = input.recentSessionEntries.filter(entry =>
    typeof entry.timestamp === 'number'
    && Number.isFinite(entry.timestamp)
    && entry.timestamp < cutoffMs,
  );
  const messages = sessionEntriesToIntentionMessages(historicalEntries);
  messages.push({
    role: 'user',
    content: input.currentUserMessage.content,
    timestamp: Math.floor(cutoffMs),
  });
  if (input.currentAssistantReply) {
    messages.push({
      role: 'assistant',
      content: input.currentAssistantReply,
      timestamp: Math.floor(input.nowMs),
    });
  }
  return messages;
}

export function sessionEntriesToIntentionMessages(
  entries: ReadonlyArray<{
    role: string;
    content: string;
    timestamp: number;
    authorId?: string;
    authorName?: string;
    metadata?: string;
    channelId?: string;
  }>,
): IntentionAppraisalMessage[] {
  const messages: IntentionAppraisalMessage[] = [];
  for (const entry of entries) {
    if (typeof entry.role !== 'string' || typeof entry.content !== 'string') {
      continue;
    }
    const entryRole = normalizeSessionEntryRole(entry.role);
    if (isIntentionAppraisalArtifact({ ...entry, role: entryRole })) {
      continue;
    }
    const normalized = normalizeSessionEntryAttribution({
      role: entryRole,
      content: entry.content,
      authorId: entry.authorId,
      authorName: entry.authorName,
      metadata: entry.metadata,
      channelId: entry.channelId ?? '',
    });
    const role = normalized.role;
    const content = (
      role === 'system'
        ? formatAttributedSystemContent(entry.content, normalized.authorName)
        : entry.content
    ).trim();
    if (!content) continue;
    messages.push({
      role,
      content,
      ...(typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
        ? { timestamp: Math.floor(entry.timestamp) }
        : {}),
    });
  }
  return messages;
}

function normalizeSessionEntryRole(role: string): SessionEntryRole {
  if (role === 'assistant' || role === 'system' || role === 'tool' || role === 'user') {
    return role;
  }
  return 'user';
}
