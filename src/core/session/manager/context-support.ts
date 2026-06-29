import type { ContextMessage } from '../../../shared/contracts/runtime.js';
import {
  buildAuthenticityProvenance,
  DERIVED_DETAIL_LOSS_NOTE,
} from '../../../shared/authenticity-provenance.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { ChannelVisibility } from '../../../system/trust/types.js';
import type { UserContinuityStore } from '../continuity.js';
import type { SessionEntry } from '../types.js';
import {
  formatAttributedSystemContent,
  isIntentionAppraisalArtifact,
  normalizeSessionEntryAttribution,
} from '../entry-attribution.js';
import {
  formatToolObservationForContext,
  MASKED_TOOL_OBSERVATION_CONTENT,
  parseToolObservationMetadata,
  type ToolObservationMetadata,
} from '../tool-observation.js';
import {
  isUntrustedVisibility,
  parseChannelVisibility,
  parseMirrorMetadata,
  isNonConversationalSessionEntry,
  wrapUntrustedContext,
} from '../manager-primitives.js';

function continuityEntryKey(entry: SessionEntry): string {
  return [
    String(entry.timestamp),
    String(entry.id),
    entry.role,
    entry.originChannelId ?? entry.channelId,
    entry.authorId ?? '',
    entry.content,
  ].join('|');
}

function directUserProvenance(entry: SessionEntry): ContextMessage['provenance'] {
  return buildAuthenticityProvenance({
    kind: 'user_direct',
    sourceAuthor: 'partner',
    transformedBy: 'none',
    wording: 'direct',
    directSpeech: true,
    detailLoss: 'none',
    emotionalTexture: 'preserved',
    safeAsPartnerSpeech: true,
    sourceSpanCount: 1,
    sourceEntryIds: [entry.id],
  });
}

function companionDirectProvenance(entry: SessionEntry): ContextMessage['provenance'] {
  return buildAuthenticityProvenance({
    kind: 'companion_direct',
    sourceAuthor: 'companion',
    transformedBy: 'none',
    wording: 'direct',
    directSpeech: true,
    detailLoss: 'none',
    emotionalTexture: 'preserved',
    safeAsPartnerSpeech: false,
    sourceSpanCount: 1,
    sourceEntryIds: [entry.id],
  });
}

function systemNoteProvenance(entry: SessionEntry): ContextMessage['provenance'] {
  return buildAuthenticityProvenance({
    kind: 'system_note',
    sourceAuthor: 'system',
    transformedBy: 'system',
    wording: 'direct',
    directSpeech: false,
    detailLoss: 'none',
    emotionalTexture: 'unknown',
    safeAsPartnerSpeech: false,
    sourceSpanCount: 1,
    sourceEntryIds: [entry.id],
  });
}

function toolResultProvenance(
  entry: SessionEntry,
  metadata: ToolObservationMetadata,
): ContextMessage['provenance'] {
  const isRedacted = entry.content === MASKED_TOOL_OBSERVATION_CONTENT || metadata.truncated;
  return buildAuthenticityProvenance({
    kind: 'tool_result',
    sourceAuthor: 'tool',
    transformedBy: isRedacted ? 'redaction' : 'tool',
    wording: isRedacted ? 'redacted' : 'transformed',
    directSpeech: false,
    detailLoss: isRedacted ? 'possible' : 'none',
    emotionalTexture: 'unknown',
    safeAsPartnerSpeech: false,
    sourceSpanCount: 1,
    sourceEntryIds: [entry.id],
    notes: isRedacted ? [DERIVED_DETAIL_LOSS_NOTE] : undefined,
  });
}

function provenanceForEntry(
  entry: SessionEntry,
  attributionRole: SessionEntry['role'],
  toolObservation?: ToolObservationMetadata,
): ContextMessage['provenance'] {
  if (entry.role === 'tool' && toolObservation) {
    return toolResultProvenance(entry, toolObservation);
  }
  if (attributionRole === 'system') {
    return systemNoteProvenance(entry);
  }
  if (attributionRole === 'assistant') {
    return companionDirectProvenance(entry);
  }
  return directUserProvenance(entry);
}

function mergeProvenance(
  left: ContextMessage['provenance'],
  right: ContextMessage['provenance'],
): ContextMessage['provenance'] {
  if (!left || !right) return left ?? right;
  if (
    left.kind !== right.kind
    || left.sourceAuthor !== right.sourceAuthor
    || left.transformedBy !== right.transformedBy
    || left.wording !== right.wording
    || left.directSpeech !== right.directSpeech
    || left.detailLoss !== right.detailLoss
    || left.emotionalTexture !== right.emotionalTexture
    || left.safeAsPartnerSpeech !== right.safeAsPartnerSpeech
  ) {
    return buildAuthenticityProvenance({
      kind: 'projection',
      sourceAuthor: 'mixed',
      transformedBy: 'runtime',
      wording: 'transformed',
      directSpeech: false,
      detailLoss: 'possible',
      emotionalTexture: 'unknown',
      safeAsPartnerSpeech: false,
      sourceSpanCount: (left.sourceSpanCount ?? 1) + (right.sourceSpanCount ?? 1),
      sourceEntryIds: [
        ...(left.sourceEntryIds ?? []),
        ...(right.sourceEntryIds ?? []),
      ],
      notes: [
        ...(left.notes ?? []),
        ...(right.notes ?? []),
        'Merged context spans carry mixed provenance and must not be treated as partner-authored speech.',
      ],
    });
  }
  return buildAuthenticityProvenance({
    kind: left.kind,
    sourceAuthor: left.sourceAuthor,
    transformedBy: left.transformedBy,
    wording: left.wording,
    directSpeech: left.directSpeech,
    detailLoss: left.detailLoss,
    emotionalTexture: left.emotionalTexture,
    safeAsPartnerSpeech: left.safeAsPartnerSpeech,
    sourceSpanCount: (left.sourceSpanCount ?? 1) + (right.sourceSpanCount ?? 1),
    sourceEntryIds: [
      ...(left.sourceEntryIds ?? []),
      ...(right.sourceEntryIds ?? []),
    ],
    notes: [
      ...(left.notes ?? []),
      ...(right.notes ?? []),
    ],
  });
}

export function getMergedContinuity(params: {
  continuityStore: UserContinuityStore | null;
  canonicalUserId: string;
  limit: number;
  fallbackUserIds: string[];
  channelId: string;
  channelMeta?: ChannelMeta;
}): SessionEntry[] {
  if (!params.continuityStore || !params.canonicalUserId) return [];

  const candidateUserIds = [
    params.canonicalUserId,
    ...params.fallbackUserIds.filter(id => id && id !== params.canonicalUserId),
  ];

  const merged: SessionEntry[] = [];
  const seen = new Set<string>();

  for (const candidateUserId of candidateUserIds) {
    const entries = params.continuityStore.getRecent(
      candidateUserId,
      params.limit,
      params.channelId,
      params.channelId,
      params.channelMeta,
    );

    for (const entry of entries) {
      const key = continuityEntryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }

  merged.sort((a, b) => {
    const timestampDelta = a.timestamp - b.timestamp;
    if (timestampDelta !== 0) return timestampDelta;
    return a.id - b.id;
  });

  if (merged.length <= params.limit) return merged;
  return merged.slice(-params.limit);
}

export function entriesToMessages(
  entries: SessionEntry[],
  defaultVisibility: ChannelVisibility,
  includeTrustTags: boolean = true,
  preserveLeadingAssistant: boolean = false,
): ContextMessage[] {
  const messages: Array<ContextMessage & { sourceRole: SessionEntry['role'] }> = [];

  for (const entry of entries) {
    if (isNonConversationalSessionEntry(entry)) {
      continue;
    }
    if (isIntentionAppraisalArtifact(entry)) {
      continue;
    }
    const attribution = normalizeSessionEntryAttribution(entry);
    const role = attribution.role === 'tool'
      ? 'system'
      : attribution.role;
    let content = entry.content;
    let toolObservation: ToolObservationMetadata | undefined;
    if (entry.role === 'system') {
      const mirror = parseMirrorMetadata(entry.metadata);
      if (mirror) {
        content = `[Mirror note from ${mirror.sourceChannelId}] ${entry.content}`;
      } else {
        content = formatAttributedSystemContent(entry.content, attribution.authorName);
      }
    } else if (entry.role === 'tool') {
      const parsedToolObservation = parseToolObservationMetadata(entry.metadata);
      if (!parsedToolObservation) {
        throw new Error(`Tool session entry ${entry.channelId}:${entry.id} is missing tool observation metadata`);
      }
      toolObservation = parsedToolObservation;
      content = formatToolObservationForContext(entry.content, toolObservation);
    } else if (attribution.role === 'system') {
      content = formatAttributedSystemContent(entry.content, attribution.authorName);
    }
    if (includeTrustTags) {
      const visibility = parseChannelVisibility(entry.channelVisibility) ?? defaultVisibility;
      if (isUntrustedVisibility(visibility)) {
        content = wrapUntrustedContext(content);
      }
    }
    const provenance = provenanceForEntry(
      entry,
      attribution.role,
      toolObservation,
    );

    // Merge consecutive same-role messages
    const last = messages.at(-1);
    const canMerge = attribution.role !== 'tool';
    if (canMerge && last && last.role === role && last.sourceRole === entry.role) {
      last.content += '\n' + content;
      last.provenance = mergeProvenance(last.provenance, provenance);
    } else {
      messages.push({ role, content, provenance, sourceRole: entry.role });
    }
  }

  // Drop any leading assistant response without preceding user/system context.
  if (!preserveLeadingAssistant && messages.length > 0 && messages[0].role === 'assistant') {
    messages.shift();
  }

  return messages.map(({ role, content, provenance }) => ({
    role,
    content,
    ...(provenance ? { provenance } : {}),
  }));
}

export function countIntentionAppraisalArtifacts(entries: readonly SessionEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (isNonConversationalSessionEntry(entry)) {
      continue;
    }
    if (isIntentionAppraisalArtifact(entry)) {
      count += 1;
    }
  }
  return count;
}
