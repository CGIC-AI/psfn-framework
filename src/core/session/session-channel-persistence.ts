const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';

/** Internal reflection channels are ephemeral and never persist to session stores. */
export function shouldPersistSessionChannel(channelId: string): boolean {
  return !channelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX);
}
