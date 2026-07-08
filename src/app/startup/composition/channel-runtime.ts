import type { EventBus } from '../../../shared/event-bus.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { EligibilityGate } from '../../../system/capabilities/eligibility.js';
import { ApiServer, type ApiServerConfig } from '../../../channels/api/server.js';
import { DiscordAdapter, type DiscordAdapterAccountBinding } from '../../../channels/discord/adapter.js';
import type { DiscordChannelConfig, TelegramChannelConfig } from '../../../channels/backplane/config.js';
import { TelegramAdapter } from '../../../channels/telegram/adapter.js';
import type {
  ChannelAdapterFactoryPort,
  ChannelAdapterPort,
  MessageHandler,
} from '../../../channels/backplane/types.js';
import type { ChannelAdapterRegistryPort } from '../../../channels/backplane/registry-port.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';

export interface DiscordChannelAdapterFactoryOptions {
  config: SubstrateConfig;
  discordConfig?: DiscordChannelConfig;
  eventBus: EventBus;
  sessionStore?: SessionStore | null;
  agentLoop?: SubstrateAgent | null;
  onMessage?: MessageHandler | null;
  onVoiceMessage?: MessageHandler | null;
  eligibilityGate?: EligibilityGate;
  personalFilesDir?: string;
  /**
   * Multi-companion (sprint-10 W1-P2): bind this adapter instance to one
   * per-companion bot account. The registry/manifest key becomes
   * `discord:<accountId>` and `allowedBotUserIds` must be provided explicitly
   * (per-account) instead of via `discordConfig`.
   */
  account?: DiscordAdapterAccountBinding;
  allowedBotUserIds?: string[];
}

export function createDiscordChannelAdapterFactoryEntry(
  options: DiscordChannelAdapterFactoryOptions,
): ChannelAdapterFactoryPort {
  const adapterId = options.account ? `discord:${options.account.accountId}` : 'discord';
  return {
    manifest: {
      id: adapterId,
      label: options.account ? `Discord (${options.account.accountId})` : 'Discord',
      enabled: true,
      required: true,
      eligibility: {},
    },
    create: async (): Promise<ChannelAdapterPort> => {
      const allowedBotUserIds = options.allowedBotUserIds
        ?? options.discordConfig?.allowedBotUserIds;
      const adapter = new DiscordAdapter(options.config, options.eventBus, {
        ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
        ...(options.eligibilityGate ? { eligibilityGate: options.eligibilityGate } : {}),
        ...(allowedBotUserIds ? { allowedBotUserIds } : {}),
        ...(options.personalFilesDir ? { personalFilesDir: options.personalFilesDir } : {}),
        ...(options.account ? { account: options.account } : {}),
      });
      if (options.agentLoop) {
        adapter.setAgent(options.agentLoop);
      } else if (options.onMessage) {
        adapter.onMessage(options.onMessage);
      }
      if (options.onVoiceMessage) {
        adapter.setVoiceHandler(options.onVoiceMessage);
      }
      await adapter.init();
      return adapter;
    },
  };
}

export interface TelegramChannelAdapterFactoryOptions {
  config: TelegramChannelConfig;
  eventBus: EventBus;
  onMessage?: MessageHandler | null;
}

export function createTelegramChannelAdapterFactoryEntry(
  options: TelegramChannelAdapterFactoryOptions,
): ChannelAdapterFactoryPort {
  return {
    manifest: {
      id: 'telegram',
      label: 'Telegram',
      enabled: options.config.enabled,
      required: false,
      eligibility: {},
    },
    create: async (): Promise<ChannelAdapterPort> => {
      const adapter = new TelegramAdapter(options.config, options.eventBus);
      if (options.onMessage) {
        adapter.onMessage(options.onMessage);
      }
      await adapter.init();
      return adapter;
    },
  };
}

export function createApiServerChannelAdapterFactoryEntry(
  config: ApiServerConfig,
): ChannelAdapterFactoryPort {
  return {
    manifest: {
      id: 'api',
      label: 'OpenAI-Compatible API',
      enabled: true,
      required: true,
      eligibility: {},
    },
    create: async (): Promise<ChannelAdapterPort> => {
      const adapter = new ApiServer(config);
      await adapter.init();
      return adapter;
    },
  };
}

export function requireChannelAdapter<T extends ChannelAdapterPort>(
  registry: ChannelAdapterRegistryPort,
  channelId: string,
): T {
  return registry.require<T>(channelId);
}

export function getOptionalChannelAdapter<T extends ChannelAdapterPort>(
  registry: ChannelAdapterRegistryPort,
  channelId: string,
): T | null {
  return registry.optional<T>(channelId);
}
