import type { SessionEntry, SessionEntryRole } from './types.js';

interface ParsedTurnMetadata {
  requestId?: string;
  sourceMessageId?: string;
  role?: SessionEntryRole;
  speakerRole?: SessionEntryRole;
}

const LEGACY_INTENTION_AUTHOR_NAME = 'Intention Appraisal';

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
  const role = typeof turn.role === 'string' && (
    turn.role === 'user'
    || turn.role === 'assistant'
    || turn.role === 'system'
    || turn.role === 'tool'
  )
    ? turn.role
    : undefined;
  const speakerRole = typeof turn.speakerRole === 'string' && (
    turn.speakerRole === 'user'
    || turn.speakerRole === 'assistant'
    || turn.speakerRole === 'system'
    || turn.speakerRole === 'tool'
  )
    ? turn.speakerRole
    : undefined;

  return {
    ...(requestId ? { requestId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(role ? { role } : {}),
    ...(speakerRole ? { speakerRole } : {}),
  };
}

function startsWithIntentionFollowUp(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('intention-follow-up:');
}

function startsWithReflectionRequest(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('reflection-');
}

function hasIntentionPrefix(content: string): boolean {
  return content.startsWith('[Intention Appraisal]')
    || content.startsWith('[SYSTEM: Intention Appraisal]');
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

export function isIntentionAppraisalArtifact(
  entry: Pick<SessionEntry, 'content' | 'authorId' | 'authorName' | 'metadata'>
    & Partial<ParsedTurnMetadata>,
): boolean {
  const parsedTurn = parseTurnMetadata(entry.metadata);
  const turn: ParsedTurnMetadata = {
    ...parsedTurn,
    ...(typeof entry.requestId === 'string' && entry.requestId.trim().length > 0
      ? { requestId: entry.requestId.trim() }
      : {}),
    ...(typeof entry.sourceMessageId === 'string' && entry.sourceMessageId.trim().length > 0
      ? { sourceMessageId: entry.sourceMessageId.trim() }
      : {}),
  };
  const authorId = entry.authorId?.trim() ?? '';
  const authorName = entry.authorName?.trim() ?? '';
  const content = entry.content.trimStart();

  return (
    authorId.startsWith('system:')
    || authorName === LEGACY_INTENTION_AUTHOR_NAME
    || startsWithIntentionFollowUp(turn.requestId)
    || startsWithIntentionFollowUp(turn.sourceMessageId)
    || hasIntentionPrefix(content)
  );
}

export function normalizeSessionEntryAttribution(
  entry: Pick<SessionEntry, 'role' | 'content' | 'authorId' | 'authorName' | 'metadata' | 'channelId'>
    & Partial<ParsedTurnMetadata>,
): NormalizedSessionEntryAttribution {
  if (entry.role === 'tool') {
    return { role: 'tool', authorName: entry.authorName };
  }

  const parsedTurn = parseTurnMetadata(entry.metadata);
  const turn: ParsedTurnMetadata = {
    ...parsedTurn,
    ...(typeof entry.requestId === 'string' && entry.requestId.trim().length > 0
      ? { requestId: entry.requestId.trim() }
      : {}),
    ...(typeof entry.sourceMessageId === 'string' && entry.sourceMessageId.trim().length > 0
      ? { sourceMessageId: entry.sourceMessageId.trim() }
      : {}),
  };
  const authorId = entry.authorId?.trim() ?? '';
  const authorName = entry.authorName?.trim() ?? '';

  const explicitSpeakerRole = turn.speakerRole;
  if (explicitSpeakerRole && explicitSpeakerRole !== 'tool') {
    return {
      role: explicitSpeakerRole === 'assistant' ? 'assistant' : explicitSpeakerRole === 'system' ? 'system' : 'user',
      ...(authorName ? { authorName } : {}),
    };
  }

  if (isIntentionAppraisalArtifact(entry)) {
    return {
      role: 'system',
      authorName: LEGACY_INTENTION_AUTHOR_NAME,
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
