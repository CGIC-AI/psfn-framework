import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';

const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;

function normalizePrefix(prefix: string): string | null {
  const normalized = prefix.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function isInternalSessionId(sessionId: string): boolean {
  return sessionId.startsWith('internal:')
    || sessionId.startsWith('subagent:')
    || sessionId.startsWith('shard:');
}

export function inferSessionChannelType(sessionId: string): ChannelType | undefined {
  if (sessionId.startsWith('discord-voice:')) return 'discord';
  if (DISCORD_CHANNEL_ID_PATTERN.test(sessionId)) return 'discord';

  const separatorIndex = sessionId.indexOf(':');
  if (separatorIndex > 0) {
    const prefix = normalizePrefix(sessionId.slice(0, separatorIndex));
    if (!prefix) return undefined;
    return CHANNEL_TYPES.includes(prefix as ChannelType)
      ? prefix as ChannelType
      : undefined;
  }

  return undefined;
}
