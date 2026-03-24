import type { ContextMessage } from '../../types.js';
import type { ChannelMeta } from '../../trust/policy.js';
import type { ChannelVisibility } from '../../trust/types.js';
import type { UserContinuityStore } from '../continuity.js';
import type { SessionEntry } from '../types.js';
import {
  formatAttributedSystemContent,
  isIntentionAppraisalArtifact,
  normalizeSessionEntryAttribution,
} from '../entry-attribution.js';
import {
  formatToolObservationForContext,
  parseToolObservationMetadata,
} from '../tool-observation.js';
import {
  isUntrustedVisibility,
  parseChannelVisibility,
  parseMirrorMetadata,
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
): ContextMessage[] {
  const messages: Array<ContextMessage & { sourceRole: SessionEntry['role'] }> = [];

  for (const entry of entries) {
    if (isIntentionAppraisalArtifact(entry)) {
      continue;
    }
    const attribution = normalizeSessionEntryAttribution(entry);
    const role = attribution.role === 'tool'
      ? 'system'
      : attribution.role;
    let content = entry.content;
    if (entry.role === 'system') {
      const mirror = parseMirrorMetadata(entry.metadata);
      if (mirror) {
        content = `[Mirror note from ${mirror.sourceChannelId}] ${entry.content}`;
      } else {
        content = formatAttributedSystemContent(entry.content, attribution.authorName);
      }
    } else if (entry.role === 'tool') {
      const toolObservation = parseToolObservationMetadata(entry.metadata);
      if (!toolObservation) {
        throw new Error(`Tool session entry ${entry.channelId}:${entry.id} is missing tool observation metadata`);
      }
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

    // Merge consecutive same-role messages
    const last = messages.at(-1);
    const canMerge = attribution.role !== 'tool';
    if (canMerge && last && last.role === role && last.sourceRole === entry.role) {
      last.content += '\n' + content;
    } else {
      messages.push({ role, content, sourceRole: entry.role });
    }
  }

  // Drop any leading assistant response without preceding user/system context.
  if (messages.length > 0 && messages[0].role === 'assistant') {
    messages.shift();
  }

  return messages.map(({ role, content }) => ({ role, content }));
}
