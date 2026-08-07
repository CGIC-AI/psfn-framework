import type { SessionEntry } from '../../../core/session/types.js';
import { parseSessionMessageAddressing } from '../../../core/session/message-addressing.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { GroupMemoryAddressMode } from '../types.js';
import { hasSpeakerWord, normalizeSpeakerPhrase } from './strict-group-routing.js';

export interface FactRoutingOptions {
  companionNames?: readonly string[];
  companionAuthorIds?: readonly string[];
  /** Group-room facts may claim direct address only when journal metadata proves it. */
  requireStructuredAddressing?: boolean;
}

export type SessionEntryCompanionRelevance =
  | 'companion_turn'
  | 'reply_to_companion'
  | 'direct_to_companion'
  | 'mention_of_companion'
  | 'not_relevant';

/** Classify one journal entry using typed addressing before legacy text hints. */
export function classifySessionEntryCompanionRelevance(
  entry: SessionEntry,
  options: FactRoutingOptions,
): SessionEntryCompanionRelevance {
  if (entry.role === 'assistant') return 'companion_turn';
  if (entry.role !== 'user') return 'not_relevant';
  if (isReplyToCompanion(entry, options)) return 'reply_to_companion';
  if (isDirectCompanionAddress(entry, options)) return 'direct_to_companion';
  if (containsCompanionMention(entry, options)) return 'mention_of_companion';
  return 'not_relevant';
}

export function inferAddressMode(
  sourceEntries: readonly SessionEntry[],
  options: FactRoutingOptions,
): GroupMemoryAddressMode {
  if (sourceEntries.some(entry => entry.role === 'system' || entry.role === 'tool')) {
    return 'system_api';
  }
  const structuredAddressing = sourceEntries.map(entry => ({
    entry,
    addressing: parseSessionMessageAddressing(entry.metadata),
  }));
  const userAddressing = structuredAddressing.filter(item => item.entry.role === 'user');
  const everyUserSourceTargetsCompanion = userAddressing.length > 0
    && userAddressing.every(item => (
      item.addressing?.resolvedAddressee.kind === 'participants'
      && item.addressing.resolvedAddressee.participants.some(target => (
        isCurrentCompanionTarget(target, options, item.addressing?.observer.authorId)
      ))
    ));
  if (everyUserSourceTargetsCompanion) return 'direct_to_companion';
  if (sourceEntries.some(entry => isReplyToUser(entry))) return 'reply_to_user';
  if (
    structuredAddressing.some(item => item.addressing !== null)
    || options.requireStructuredAddressing
  ) {
    return 'overheard_room_context';
  }
  if (sourceEntries.some(entry => isDirectCompanionAddress(entry, options))) {
    return 'direct_to_companion';
  }
  if (sourceEntries.some(entry => containsCompanionMention(entry, options))) {
    return 'mention_of_companion';
  }
  return 'overheard_room_context';
}

function isReplyToCompanion(entry: SessionEntry, options: FactRoutingOptions): boolean {
  const addressing = parseSessionMessageAddressing(entry.metadata);
  if (addressing?.replyTarget) {
    return addressing.replyTarget.author !== undefined
      && addressing.replyTarget.author.authorId === addressing.observer.authorId;
  }
  const companionAuthorIds = options.companionAuthorIds ?? [];
  if (companionAuthorIds.length === 0) return false;
  const metadata = parseEntryMetadata(entry);
  const replyAuthorId = normalizeOptionalMetadataString(metadata?.replyToAuthorId)
    ?? normalizeOptionalMetadataString(metadata?.referencedMessageAuthorId);
  return replyAuthorId !== undefined && companionAuthorIds.includes(replyAuthorId);
}

function isCurrentCompanionTarget(
  target: { authorId: string; authorName: string },
  options: FactRoutingOptions,
  observerAuthorId?: string,
): boolean {
  if (observerAuthorId) return target.authorId === observerAuthorId;
  const companionAuthorIds = options.companionAuthorIds ?? [];
  if (companionAuthorIds.length > 0) return companionAuthorIds.includes(target.authorId);
  return buildCompanionAliases(options.companionNames).includes(
    normalizeSpeakerPhrase(target.authorName),
  );
}

function isReplyToUser(entry: SessionEntry): boolean {
  const addressing = parseSessionMessageAddressing(entry.metadata);
  if (addressing) return false;
  const metadata = parseEntryMetadata(entry);
  const turn = isRecord(metadata?.turn) ? metadata.turn : undefined;
  return Boolean(
    normalizeOptionalMetadataString(metadata?.replyToAuthorId)
    || normalizeOptionalMetadataString(metadata?.referencedMessageAuthorId)
    || normalizeOptionalMetadataString(turn?.replyToMessageId)
    || normalizeOptionalMetadataString(metadata?.referencedMessageId),
  );
}

function isDirectCompanionAddress(entry: SessionEntry, options: FactRoutingOptions): boolean {
  const addressing = parseSessionMessageAddressing(entry.metadata);
  if (addressing) {
    return addressing.resolvedAddressee.kind === 'participants'
      && addressing.resolvedAddressee.participants.some(target => (
        isCurrentCompanionTarget(target, options, addressing.observer.authorId)
      ));
  }
  const content = entry.content.trim();
  if (options.companionAuthorIds?.some(authorId => content.startsWith(`<@${authorId}>`))) {
    return true;
  }
  const normalized = normalizeSpeakerPhrase(content);
  return buildCompanionAliases(options.companionNames).some(alias => (
    normalized === alias || normalized.startsWith(`${alias} `)
  ));
}

function containsCompanionMention(entry: SessionEntry, options: FactRoutingOptions): boolean {
  const addressing = parseSessionMessageAddressing(entry.metadata);
  if (addressing) {
    return addressing.mentionedTargets.some(target => (
      isCurrentCompanionTarget(target, options, addressing.observer.authorId)
    ));
  }
  const content = entry.content;
  if (options.companionAuthorIds?.some(authorId => content.includes(`<@${authorId}>`))) {
    return true;
  }
  const normalized = normalizeSpeakerPhrase(content);
  return buildCompanionAliases(options.companionNames)
    .some(alias => hasSpeakerWord(normalized, alias));
}

function buildCompanionAliases(names: readonly string[] | undefined): string[] {
  return [...new Set((names ?? [])
    .map(name => normalizeSpeakerPhrase(name))
    .filter(Boolean))];
}

function parseEntryMetadata(entry: SessionEntry): Record<string, unknown> | undefined {
  if (!entry.metadata) return undefined;
  try {
    const parsed = JSON.parse(entry.metadata) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptionalMetadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
