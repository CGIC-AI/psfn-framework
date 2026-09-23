// ── Context for a per-contact outreach turn (psfn-framework-vcq8v.4) ──
//
// Everything the companion sees before deciding whether to message a contact:
// who they are, when the two of them last talked, the last few lines of that
// conversation, what she has been doing since, and how she feels right now.
// Only the contact's own conversation is quoted; her other activity is named
// by kind, never by content, so nothing from another person's conversation is
// carried into this one.

import type { Contact, RelationshipType } from '../../contacts/types.js';
import type { EmotionStateSnapshot } from '../../../shared/contracts/emotion-contracts.js';
import { isNonConversationalSessionEntry } from '../../session/manager-primitives.js';
import { FREE_TIME_CHANNEL_PREFIX, isInternalSessionId, isTestingSessionId } from '../../session/session-id.js';
import type { SessionEntry } from '../../session/types.js';
import { parseCompanionChannelId } from '../../../shared/contracts/companion-channels.js';
import { stripLeadingHistoryStamps } from '../../../shared/utils/history-stamp-hygiene.js';

type Awaitable<T> = T | Promise<T>;

interface SocialOutreachTurnContextLimits {
  excerptMessages: number;
  excerptMaxChars: number;
  activityMaxItems: number;
}

export interface SocialOutreachContextPorts {
  contacts: { getById(id: string): Awaitable<Contact | undefined> };
  sessions: {
    findLatestEntries(
      channelId: string,
      predicate: (entry: SessionEntry) => boolean,
      limit: number,
    ): SessionEntry[];
    listSessionsByRecentActivity(limit: number, offset: number): Array<{
      channelId: string;
      lastActivityAt: number;
    }>;
  };
  readEmotion(): EmotionStateSnapshot | null;
  limits: SocialOutreachTurnContextLimits;
}

interface SocialOutreachExcerptLine {
  speaker: 'them' | 'you';
  text: string;
  atMs: number;
}

export interface SocialOutreachTurnContext {
  contactName: string;
  relationship: RelationshipType | null;
  companionTarget: boolean;
  lastTalkedAtMs: number | null;
  excerpt: SocialOutreachExcerptLine[];
  activitiesSince: string[];
  emotion: EmotionStateSnapshot | null;
}

export async function gatherSocialOutreachTurnContext(
  ports: SocialOutreachContextPorts,
  input: {
    contactId: string;
    contactName?: string;
    /** The contact's own conversation (their DM or companion DM). */
    conversationChannelId: string;
    companionTarget: boolean;
    nowMs: number;
  },
): Promise<SocialOutreachTurnContext> {
  const contact = await ports.contacts.getById(input.contactId);
  if (!contact) throw new Error('Social outreach context requires a known contact');
  const excerpt = collectExcerpt(ports, input.conversationChannelId);
  const lastTalkedAtMs = latestTalk(contact, excerpt);
  return {
    contactName: contact.nickname?.trim() || input.contactName?.trim() || contact.displayName,
    relationship: contact.relationshipType,
    companionTarget: input.companionTarget,
    lastTalkedAtMs,
    excerpt,
    activitiesSince: collectActivitiesSince(ports, {
      sinceMs: lastTalkedAtMs,
      excludeChannelId: input.conversationChannelId,
    }),
    emotion: ports.readEmotion(),
  };
}

function collectExcerpt(
  ports: SocialOutreachContextPorts,
  channelId: string,
): SocialOutreachExcerptLine[] {
  const entries = ports.sessions.findLatestEntries(
    channelId,
    entry => (entry.role === 'user' || entry.role === 'assistant')
      && !entry.authorId?.startsWith('system:')
      && !isNonConversationalSessionEntry(entry)
      && entry.content.trim().length > 0,
    ports.limits.excerptMessages,
  ).sort((left, right) => left.timestamp - right.timestamp);
  const lines = entries.map(entry => ({
    speaker: entry.role === 'user' ? 'them' as const : 'you' as const,
    text: stripLeadingHistoryStamps(entry.content).replace(/\s+/g, ' ').trim(),
    atMs: entry.timestamp,
  })).filter(line => line.text.length > 0);
  // Keep the most recent lines inside the character budget; the oldest kept
  // line is truncated from its start so the conversation still ends where it ended.
  const kept: SocialOutreachExcerptLine[] = [];
  let remaining = ports.limits.excerptMaxChars;
  for (const line of [...lines].reverse()) {
    if (remaining <= 0) break;
    const text = line.text.length <= remaining ? line.text : `…${line.text.slice(-remaining)}`;
    kept.unshift({ ...line, text });
    remaining -= line.text.length;
  }
  return kept;
}

function latestTalk(contact: Contact, excerpt: readonly SocialOutreachExcerptLine[]): number | null {
  const candidates = [
    ...excerpt.map(line => line.atMs),
    ...(contact.conversationChannels ?? []).map(channel => Date.parse(channel.lastSeen)),
  ].filter(value => Number.isFinite(value));
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function describeActivity(channelId: string): string | null {
  if (isTestingSessionId(channelId)) return null;
  if (channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)) {
    const topic = channelId.slice(FREE_TIME_CHANNEL_PREFIX.length).replace(/[:_-]+/g, ' ').trim();
    return topic ? `spent free time on ${topic}` : 'had some free time';
  }
  if (parseCompanionChannelId(channelId)) return 'talked with another companion';
  if (isInternalSessionId(channelId)) return null;
  return 'talked with someone else';
}

function collectActivitiesSince(
  ports: SocialOutreachContextPorts,
  input: { sinceMs: number | null; excludeChannelId: string },
): string[] {
  const pageSize = ports.limits.activityMaxItems;
  const counts = new Map<string, number>();
  for (let offset = 0; counts.size < pageSize; offset += pageSize) {
    const page = ports.sessions.listSessionsByRecentActivity(pageSize, offset);
    let reachedOlder = false;
    for (const session of page) {
      if (input.sinceMs !== null && session.lastActivityAt <= input.sinceMs) {
        reachedOlder = true;
        break;
      }
      if (session.channelId === input.excludeChannelId) continue;
      const label = describeActivity(session.channelId);
      if (!label) continue;
      if (!counts.has(label) && counts.size >= pageSize) break;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    if (reachedOlder || page.length < pageSize) break;
  }
  return [...counts.entries()].map(([label, count]) => (count > 1 ? `${label} (${count} separate sessions)` : label));
}
