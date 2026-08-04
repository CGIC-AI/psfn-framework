import type { ChannelInfo } from '$lib/types';

export const SESSION_KIND_FILTERS = [
  'all',
  'chat',
  'subagent',
  'intake',
  'scheduled',
  'other',
] as const;

export type SessionKind = Exclude<(typeof SESSION_KIND_FILTERS)[number], 'all'>;
export type SessionKindFilter = (typeof SESSION_KIND_FILTERS)[number];

const CHAT_SESSION_PREFIXES = [
  'api:',
  'discord:',
  'discord-voice:',
  'telegram:',
  'satellite:',
  'model-room:',
] as const;
const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/u;

export function classifySessionKind(
  channel: Pick<ChannelInfo, 'sessionId' | 'channelId' | 'displayLabel'>,
): SessionKind {
  const sessionId = channel.sessionId.toLowerCase();
  const searchable = `${sessionId} ${channel.channelId} ${channel.displayLabel ?? ''}`.toLowerCase();

  if (searchable.includes('intake') || searchable.includes('quarantine')) return 'intake';
  if (sessionId.startsWith('subagent:') || sessionId.startsWith('shard:')) return 'subagent';
  if (sessionId.startsWith('internal:')
    || sessionId.startsWith('reflection-journal:')
    || searchable.includes('scheduler')
    || searchable.includes('scheduled')) {
    return 'scheduled';
  }
  if (CHAT_SESSION_PREFIXES.some(prefix => sessionId.startsWith(prefix))
    || DISCORD_CHANNEL_ID_PATTERN.test(sessionId)) {
    return 'chat';
  }
  return 'other';
}

