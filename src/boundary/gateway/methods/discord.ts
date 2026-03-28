import type {
  DiscordSendParams,
  DiscordSendMediaParams,
  DiscordTypingParams,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

const discordDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'discord.send',
    handler: async (params: DiscordSendParams, runtime) => {
      await runtime.discordAdapter.outbound.sendText(
        { channelId: params.channelId },
        params.content,
      );
      return { success: true };
    },
    summary: (p: DiscordSendParams) => ({ channelId: p.channelId }),
  },
  {
    name: 'discord.sendMedia',
    handler: async (params: DiscordSendMediaParams, runtime) => {
      await runtime.discordAdapter.outbound.sendMedia?.(
        { channelId: params.channelId },
        params.media,
      );
      return { success: true };
    },
    summary: (p: DiscordSendMediaParams) => ({
      channelId: p.channelId,
      mediaName: p.media.name,
    }),
  },
  {
    name: 'discord.typing',
    handler: async (_params: DiscordTypingParams) => ({ success: true }),
  },
];

export function registerDiscordMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, discordDescriptors);
}
