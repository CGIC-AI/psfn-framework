import type { Contact } from '../../contacts/types.js';

export function resolveReflectionContactSessionId(
  contact: Contact | null,
  fallbackSessionId: string,
): string {
  let bestSessionId = fallbackSessionId;
  let bestLastSeen = Number.NEGATIVE_INFINITY;

  for (const conversation of contact?.conversationChannels ?? []) {
    const channelId = conversation.channelId.trim();
    if (!channelId) {
      continue;
    }
    const lastSeen = Date.parse(conversation.lastSeen);
    if (Number.isNaN(lastSeen)) {
      continue;
    }
    if (lastSeen > bestLastSeen || (lastSeen === bestLastSeen && channelId.localeCompare(bestSessionId) < 0)) {
      bestLastSeen = lastSeen;
      bestSessionId = channelId;
    }
  }

  return bestSessionId;
}
