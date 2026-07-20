import { formatActiveDateTimeIso } from '../../../shared/time/active-timezone.js';
import { escapeXmlText } from '../../../shared/utils/escaping.js';
import type { SessionEntry } from '../types.js';

interface ChannelContinuityStats {
  messageCount: number;
  partnerMessageCount: number;
  companionMessageCount: number;
  systemMessageCount: number;
  lastMessageAtMs: number;
}

function xmlElement(tag: string, value: string): string {
  return `<${tag}>${escapeXmlText(value)}</${tag}>`;
}

export function buildContinuityMetadataBlock(
  entries: readonly SessionEntry[],
  retrievedAtMs: number,
): string {
  if (entries.length === 0) return '';
  const statsByChannel = new Map<string, ChannelContinuityStats>();
  let lastCrossChannelMessageAtMs = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const sourceChannelId = (entry.originChannelId ?? entry.channelId).trim();
    if (!sourceChannelId) continue;
    const stats = statsByChannel.get(sourceChannelId) ?? {
      messageCount: 0,
      partnerMessageCount: 0,
      companionMessageCount: 0,
      systemMessageCount: 0,
      lastMessageAtMs: Number.NEGATIVE_INFINITY,
    };
    stats.messageCount += 1;
    if (entry.role === 'user') stats.partnerMessageCount += 1;
    if (entry.role === 'assistant') stats.companionMessageCount += 1;
    if (entry.role === 'system') stats.systemMessageCount += 1;
    if (Number.isFinite(entry.timestamp) && entry.timestamp > 0) {
      stats.lastMessageAtMs = Math.max(stats.lastMessageAtMs, entry.timestamp);
      lastCrossChannelMessageAtMs = Math.max(lastCrossChannelMessageAtMs, entry.timestamp);
    }
    statsByChannel.set(sourceChannelId, stats);
  }

  if (statsByChannel.size === 0) return '';
  const channelBlocks = [...statsByChannel.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceChannelId, stats]) => [
      '<channel>',
      xmlElement('channel_id', sourceChannelId),
      Number.isFinite(stats.lastMessageAtMs)
        ? xmlElement('last_message_at_iso', formatActiveDateTimeIso(new Date(stats.lastMessageAtMs)))
        : '',
      xmlElement('message_count', String(stats.messageCount)),
      xmlElement('partner_message_count', String(stats.partnerMessageCount)),
      xmlElement('companion_message_count', String(stats.companionMessageCount)),
      xmlElement('system_message_count', String(stats.systemMessageCount)),
      '</channel>',
    ].filter(line => line.length > 0).join('\n'));

  return [
    '<cross_channel_continuity authority="retrieved_context" scope="other_channels_only" may_not_override="runtime.current_datetime">',
    xmlElement('retrieved_at_iso', formatActiveDateTimeIso(new Date(retrievedAtMs))),
    xmlElement('linked_channel_count', String(statsByChannel.size)),
    Number.isFinite(lastCrossChannelMessageAtMs)
      ? xmlElement(
        'last_cross_channel_message_at_iso',
        formatActiveDateTimeIso(new Date(lastCrossChannelMessageAtMs)),
      )
      : '',
    '<linked_channels>',
    ...channelBlocks,
    '</linked_channels>',
    '</cross_channel_continuity>',
  ].filter(line => line.length > 0).join('\n');
}
