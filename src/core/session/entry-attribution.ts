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

interface GroupUserAttributionInput {
  authorId?: string;
  authorName?: string;
  channelId?: string;
  source?: string;
}

const DISCORD_SNOWFLAKE_ID = /^\d{15,25}$/;

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function inferAuthorSourceFromChannelId(channelId: string | undefined): string | undefined {
  const normalized = trimToUndefined(channelId);
  if (!normalized) return undefined;
  if (normalized.startsWith('discord-voice:')) return 'discord';
  if (DISCORD_SNOWFLAKE_ID.test(normalized)) return 'discord';

  const separatorIndex = normalized.indexOf(':');
  if (separatorIndex <= 0) return undefined;
  const prefix = normalized.slice(0, separatorIndex).trim();
  if (!prefix) return undefined;
  return prefix === 'discord-voice' ? 'discord' : prefix;
}

function formatStableAuthorId(input: GroupUserAttributionInput): string {
  const authorId = trimToUndefined(input.authorId);
  const source = trimToUndefined(input.source) ?? inferAuthorSourceFromChannelId(input.channelId);
  if (!authorId) return source ? `${source}:unknown` : 'unknown';
  if (!source || authorId.startsWith(`${source}:`)) return authorId;
  return `${source}:${authorId}`;
}

function formatGroupUserAttributionLabel(input: GroupUserAttributionInput): string {
  const stableAuthorId = formatStableAuthorId(input);
  const displayName = trimToUndefined(input.authorName) ?? stableAuthorId;
  return `${displayName} (${stableAuthorId})`;
}

export function formatGroupUserMessageContent(
  content: string,
  input: GroupUserAttributionInput,
): string {
  const label = formatGroupUserAttributionLabel(input);
  const trimmedContent = content.trim();
  if (!trimmedContent) return `${label}:`;
  const prefix = `${label}:`;
  if (trimmedContent.startsWith(prefix)) return trimmedContent;
  return `${prefix} ${trimmedContent}`;
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

/**
 * Write-time authorship integrity detector (charter laws 17/19, section 8.2).
 *
 * The read-time normalizer above re-tags known internal signatures when
 * building context, but that alone lets a mistagged entry persist as partner
 * speech and regress whenever a new internal system forgets its provenance.
 * This detector lets the session manager refuse user attribution for
 * internal-origin entries at append time, so internal messages can never be
 * stored as if the partner authored them.
 */
export function detectInternalOriginForUserAttribution(
  entry: Pick<SessionEntry, 'content' | 'authorId' | 'authorName' | 'metadata' | 'channelId'>
    & Partial<ParsedTurnMetadata>,
): string | null {
  const authorId = entry.authorId?.trim() ?? '';
  if (authorId === 'scheduler') return 'scheduler_author';
  if (authorId.startsWith('system:')) return 'system_author_prefix';
  if (authorId.startsWith('internal:')) return 'internal_author_prefix';

  if (isIntentionAppraisalArtifact(entry)) return 'intention_appraisal_artifact';

  const parsedTurn = parseTurnMetadata(entry.metadata);
  const requestId = typeof entry.requestId === 'string' && entry.requestId.trim().length > 0
    ? entry.requestId.trim()
    : parsedTurn.requestId;
  const sourceMessageId = typeof entry.sourceMessageId === 'string' && entry.sourceMessageId.trim().length > 0
    ? entry.sourceMessageId.trim()
    : parsedTurn.sourceMessageId;
  if (
    entry.channelId.startsWith('internal:')
    && (startsWithReflectionRequest(requestId) || startsWithReflectionRequest(sourceMessageId))
  ) {
    return 'internal_reflection_request';
  }

  return null;
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
