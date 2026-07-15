import type { SubstrateMessage } from '../../shared/contracts/runtime.js';

export const INTERACTIVE_TERMINAL_CHANNEL_ID = 'cli:chat';

export function createInteractiveTerminalMessage(input: {
  id: string;
  content: string;
  timestamp: Date;
}): SubstrateMessage {
  return {
    id: input.id,
    channelId: INTERACTIVE_TERMINAL_CHANNEL_ID,
    channelType: 'terminal',
    authorId: 'primary-user',
    authorName: 'PrimaryUser',
    content: input.content,
    timestamp: input.timestamp,
    isDirectMessage: false,
    routing: {
      source: 'terminal',
      channelPrivacy: 'private',
    },
  };
}
