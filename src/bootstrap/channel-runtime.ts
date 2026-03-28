import type { EventBus } from '../shared/event-bus.js';
import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import type { SubstrateAgent } from '../agent/substrate-agent.js';
import type { EligibilityGate } from '../system/capabilities/eligibility.js';
import { ApiServer, type ApiServerConfig } from '../channels/api/server.js';
import { DiscordAdapter } from '../channels/discord/adapter.js';
import { OpenHomeAdapter } from '../channels/openhome/adapter.js';
import type { TelegramChannelConfig } from '../channels/config.js';
import { TelegramAdapter } from '../channels/telegram/adapter.js';
import type {
  ChannelAdapter,
  ChannelAdapterFactoryEntry,
  MessageHandler,
} from '../channels/types.js';
import type { SessionStore } from '../session/store.js';

export interface DiscordChannelAdapterFactoryOptions {
  config: SubstrateConfig;
  eventBus: EventBus;
  sessionStore?: SessionStore | null;
  agentLoop?: SubstrateAgent | null;
  onMessage?: MessageHandler | null;
  onVoiceMessage?: MessageHandler | null;
  eligibilityGate?: EligibilityGate;
}

export function createDiscordChannelAdapterFactoryEntry(
  options: DiscordChannelAdapterFactoryOptions,
): ChannelAdapterFactoryEntry {
  return {
    manifest: {
      id: 'discord',
      label: 'Discord',
      enabled: true,
      required: true,
      eligibility: {},
    },
    create: async (): Promise<ChannelAdapter> => {
      const adapter = new DiscordAdapter(options.config, options.eventBus, {
        ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
        ...(options.eligibilityGate ? { eligibilityGate: options.eligibilityGate } : {}),
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
): ChannelAdapterFactoryEntry {
  return {
    manifest: {
      id: 'telegram',
      label: 'Telegram',
      enabled: options.config.enabled,
      required: false,
      eligibility: {},
    },
    create: async (): Promise<ChannelAdapter> => {
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
): ChannelAdapterFactoryEntry {
  return {
    manifest: {
      id: 'api',
      label: 'OpenAI-Compatible API',
      enabled: true,
      required: true,
      eligibility: {},
    },
    create: async (): Promise<ChannelAdapter> => {
      const adapter = new ApiServer(config);
      await adapter.init();
      return adapter;
    },
  };
}

export function createOpenHomeChannelAdapterFactoryEntry(): ChannelAdapterFactoryEntry {
  return {
    manifest: {
      id: 'psfn-amica',
      label: 'PSFN Amica',
      enabled: true,
      required: false,
      eligibility: {},
    },
    create: async (): Promise<ChannelAdapter> => {
      const adapter = new OpenHomeAdapter();
      await adapter.init();
      return adapter;
    },
  };
}

export function requireChannelAdapter<T extends ChannelAdapter>(
  registry: Map<string, ChannelAdapter>,
  channelId: string,
): T {
  const adapter = registry.get(channelId);
  if (!adapter) {
    throw new Error(`Required channel adapter "${channelId}" was not loaded`);
  }
  return adapter as T;
}

export function getOptionalChannelAdapter<T extends ChannelAdapter>(
  registry: Map<string, ChannelAdapter>,
  channelId: string,
): T | null {
  const adapter = registry.get(channelId);
  return (adapter as T | undefined) ?? null;
}
