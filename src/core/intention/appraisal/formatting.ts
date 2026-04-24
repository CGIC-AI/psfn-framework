import {
  formatActiveDateTimeLabel,
} from '../../../shared/time/active-timezone.js';
import {
  formatAttributedSystemContent,
  isIntentionAppraisalArtifact,
  normalizeSessionEntryAttribution,
} from '../../session/entry-attribution.js';
import type { IntentionAppraisalMessage } from './types.js';

export function formatPromptTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return formatActiveDateTimeLabel(new Date(Math.floor(value)));
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
    if (isIntentionAppraisalArtifact(entry)) {
      continue;
    }
    const normalized = normalizeSessionEntryAttribution({
      role: (
        entry.role === 'assistant'
        || entry.role === 'system'
        || entry.role === 'tool'
        || entry.role === 'user'
      )
        ? entry.role
        : 'user',
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
