import type { SessionEntry, SessionEntryRole } from './types.js';

interface ParsedTurnMetadata {
  requestId?: string;
  sourceMessageId?: string;
}

export interface NormalizedSessionEntryAttribution {
  role: SessionEntryRole;
  authorName?: string;
}

function parseTurnMetadata(metadata: string | undefined): ParsedTurnMetadata {
  if (!metadata) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const rawTurn = (parsed as Record<string, unknown>).turn;
  if (!rawTurn || typeof rawTurn !== 'object' || Array.isArray(rawTurn)) {
    return {};
  }

  const turn = rawTurn as Record<string, unknown>;
  const requestId = typeof turn.requestId === 'string' ? turn.requestId.trim() : '';
  const sourceMessageId = typeof turn.sourceMessageId === 'string' ? turn.sourceMessageId.trim() : '';

  return {
    ...(requestId ? { requestId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
  };
}

function startsWithIntentionFollowUp(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('intention-follow-up:');
}

function startsWithReflectionRequest(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('reflection-');
}

function stripBracketedPrefix(content: string, label: string): string {
  const trimmed = content.trimStart();
  const prefix = `[${label}]`;
  if (!trimmed.startsWith(prefix)) {
    return content;
  }

  const remainder = trimmed.slice(prefix.length).trimStart();
  return remainder || content;
}

export function normalizeSessionEntryAttribution(
  entry: Pick<SessionEntry, 'role' | 'content' | 'authorId' | 'authorName' | 'metadata' | 'channelId'>,
): NormalizedSessionEntryAttribution {
  if (entry.role === 'tool') {
    return { role: 'tool', authorName: entry.authorName };
  }

  const turn = parseTurnMetadata(entry.metadata);
  const authorId = entry.authorId?.trim() ?? '';
  const authorName = entry.authorName?.trim() ?? '';
  const content = entry.content.trimStart();
  const isIntentionFollowUp = (
    authorId.startsWith('system:')
    || authorName === 'Intention Appraisal'
    || startsWithIntentionFollowUp(turn.requestId)
    || startsWithIntentionFollowUp(turn.sourceMessageId)
    || content.startsWith('[Intention Appraisal]')
  );

  if (isIntentionFollowUp) {
    return {
      role: 'system',
      authorName: 'Intention Appraisal',
    };
  }

  const isScheduledInternalPrompt = (
    authorId === 'scheduler'
    || (
      entry.channelId.startsWith('internal:')
      && (startsWithReflectionRequest(turn.requestId) || startsWithReflectionRequest(turn.sourceMessageId))
    )
  );
  if (isScheduledInternalPrompt) {
    return {
      role: 'system',
      authorName: authorName || 'Scheduler',
    };
  }

  if (entry.role === 'system') {
    return {
      role: 'system',
      ...(authorName ? { authorName } : {}),
    };
  }

  return {
    role: entry.role === 'assistant' ? 'assistant' : 'user',
    ...(authorName ? { authorName } : {}),
  };
}

export function formatAttributedSystemContent(content: string, authorName?: string): string {
  const trimmed = content.trim();
  if (!trimmed) return content;
  if (trimmed.startsWith('[SYSTEM:')) return trimmed;
  if (trimmed.startsWith('[System note]')) return trimmed;
  if (trimmed.startsWith('[Mirror note')) return trimmed;

  const label = authorName?.trim() || 'System';
  const normalizedContent = stripBracketedPrefix(trimmed, label);
  return `[SYSTEM: ${label}] ${normalizedContent}`;
}
