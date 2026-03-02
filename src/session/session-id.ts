const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;

function normalizePrefix(prefix: string): string | null {
  const normalized = prefix.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function isInternalSessionId(sessionId: string): boolean {
  return sessionId.startsWith('internal:') || sessionId.startsWith('shard:');
}

export function inferSessionChannelType(sessionId: string): string | undefined {
  if (sessionId.startsWith('discord-voice:')) return 'discord';
  if (DISCORD_CHANNEL_ID_PATTERN.test(sessionId)) return 'discord';

  const separatorIndex = sessionId.indexOf(':');
  if (separatorIndex > 0) {
    return normalizePrefix(sessionId.slice(0, separatorIndex)) ?? undefined;
  }

  return undefined;
}
