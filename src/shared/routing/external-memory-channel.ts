/** Hermes is one logical channel; hashed IDs identify its archived sessions. */
export const EXTERNAL_MEMORY_CHANNEL = 'api:hermes';

export function externalMemoryPolicyChannelId(channelId: string): string {
  return /^api:hermes:[a-f0-9]{64}$/u.test(channelId) ? EXTERNAL_MEMORY_CHANNEL : channelId;
}
