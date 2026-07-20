import type { ContextMessage } from '../../../shared/contracts/runtime.js';
import {
  buildAuthenticityProvenance,
  DERIVED_DETAIL_LOSS_NOTE,
} from '../../../shared/authenticity-provenance.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { UserContinuityStore } from '../continuity.js';
import type { SessionEntry } from '../types.js';
import {
  formatAttributedSystemContent,
  formatGroupUserMessageContent,
  isIntentionAppraisalArtifact,
  normalizeSessionEntryAttribution,
} from '../entry-attribution.js';
import {
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
import { parseChannelBondEntryMarker } from '../channel-bond.js';
import { formatActiveDateTimeCompact, formatActiveWeekdayShort } from '../../../shared/time/active-timezone.js';

const ARTIFACT_IMAGE_TOOL_NAMES = new Set(['selfie_create', 'generate_image']);
const GENERATED_IMAGE_STATUS_PATTERN = /"status"\s*:\s*"image_generated"/u;
const PENDING_IMAGE_ATTACHMENT_PATTERN = /"attachmentPending"\s*:\s*true/u;

function renderImageToolHistoryProvenance(
  entry: SessionEntry,
  metadata: ToolObservationMetadata,
): string | null {
  if (
    metadata.isError !== false
    || !ARTIFACT_IMAGE_TOOL_NAMES.has(metadata.toolName)
    || !GENERATED_IMAGE_STATUS_PATTERN.test(entry.content)
    || !PENDING_IMAGE_ATTACHMENT_PATTERN.test(entry.content)
  ) {
    return null;
  }

  const nextRequest = metadata.toolName === 'selfie_create'
    ? 'call selfie_create again for a new selfie'
    : 'call generate_image again for a new image';
  return `[Prior image tool success] ${metadata.toolName} produced a pending image attachment in that turn. `
    + `Assistant text alone never creates an attachment; ${nextRequest}.`;
}

// Minute-resolution provenance stamp for rendered history. Returns undefined on
// missing/invalid timestamps so context assembly never crashes on bad data.
function entryStampLabel(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  const at = new Date(timestamp);
  return `${formatActiveWeekdayShort(at)} ${formatActiveDateTimeCompact(at)}`;
}

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

function shouldRenderGroupUserAttribution(visibility: ChannelPrivacy): boolean {
  return visibility !== 'private';
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
  defaultVisibility: ChannelPrivacy,
  includeTrustTags: boolean = true,
  preserveLeadingAssistant: boolean = false,
  renderGroupUserAttribution: boolean = true,
): ContextMessage[] {
  const messages: Array<ContextMessage & {
    sourceRole: SessionEntry['role'];
    stampLabel?: string;
  }> = [];

  for (const entry of entries) {
    if (isNonConversationalSessionEntry(entry)) {
      continue;
    }
    if (isIntentionAppraisalArtifact(entry)) {
      continue;
    }
    if (entry.role === 'tool') {
      const toolObservation = parseToolObservationMetadata(entry.metadata);
      if (toolObservation) {
        const content = renderImageToolHistoryProvenance(entry, toolObservation);
        if (!content) continue;
        const stampLabel = entryStampLabel(entry.timestamp);
        messages.push({
          role: 'system',
          content: stampLabel !== undefined ? `[${stampLabel}] ${content}` : content,
          provenance: toolResultProvenance(entry, toolObservation),
          sourceRole: entry.role,
          ...(stampLabel !== undefined ? { stampLabel } : {}),
        });
      }
      continue;
    }
    const attribution = normalizeSessionEntryAttribution(entry);
    const role = attribution.role === 'tool'
      ? 'system'
      : attribution.role;
    let content = entry.content;
    const visibility = parseChannelVisibility(entry.channelVisibility) ?? defaultVisibility;
    let toolObservation: ToolObservationMetadata | undefined;
    if (entry.role === 'system') {
      const mirror = parseMirrorMetadata(entry.metadata);
      if (mirror) {
        content = `[Mirror note from ${mirror.sourceChannelId}] ${entry.content}`;
      } else {
        content = formatAttributedSystemContent(entry.content, attribution.authorName);
      }
    } else if (attribution.role === 'system') {
      content = formatAttributedSystemContent(entry.content, attribution.authorName);
    } else if (role === 'user' && renderGroupUserAttribution && shouldRenderGroupUserAttribution(visibility)) {
      content = formatGroupUserMessageContent(entry.content, {
        authorId: entry.authorId,
        authorName: attribution.authorName,
        channelId: entry.originChannelId ?? entry.channelId,
      });
    }
    // Channel bonding (psfn-framework-vrmf): interleaved foreign entries are
    // annotated with their source channel. The companion's own turns stay
    // unannotated — a model that reads its past speech prefixed with source
    // tags mimics the prefix into new replies (same live-leak class as the
    // temporal stamps, psfn-framework-2x37.10); the source channels of its
    // interleaved replies are carried by the surrounding annotated turns.
    const bondMarker = parseChannelBondEntryMarker(entry.metadata);
    if (bondMarker && role !== 'assistant') {
      content = `[via ${bondMarker.sourceChannelId}] ${content}`;
    }
    if (includeTrustTags) {
      if (isUntrustedVisibility(visibility)) {
        content = wrapUntrustedContext(content);
      }
    }
    const provenance = provenanceForEntry(
      entry,
      attribution.role,
      toolObservation,
    );

    // Timestamp stamp is trusted runtime provenance, so it wraps OUTSIDE any
    // untrusted-context envelope applied above. The companion's own turns stay
    // unstamped: a model that reads its past speech prefixed with stamps
    // mimics the prefix into new replies (live leak, psfn-framework-2x37.10);
    // user/system stamps alone carry the timeline.
    const stampLabel = role === 'assistant' ? undefined : entryStampLabel(entry.timestamp);

    // Merge consecutive same-role messages
    const last = messages.at(-1);
    const canMerge = attribution.role !== 'tool';
    if (canMerge && last && last.role === role && last.sourceRole === entry.role) {
      // Re-stamp appended lines only when the minute-resolution label moved,
      // so rapid-fire messages in the same minute stay unstamped.
      const appended = stampLabel !== undefined && stampLabel !== last.stampLabel
        ? `[${stampLabel}] ${content}`
        : content;
      last.content += '\n' + appended;
      if (stampLabel !== undefined) {
        last.stampLabel = stampLabel;
      }
      last.provenance = mergeProvenance(last.provenance, provenance);
    } else {
      messages.push({
        role,
        content: stampLabel !== undefined ? `[${stampLabel}] ${content}` : content,
        provenance,
        sourceRole: entry.role,
        ...(stampLabel !== undefined ? { stampLabel } : {}),
      });
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
