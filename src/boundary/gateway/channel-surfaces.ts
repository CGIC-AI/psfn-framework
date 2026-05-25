import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { DiscordAdapter } from '../../channels/discord/adapter.js';
import type { TelegramAdapter } from '../../channels/telegram/adapter.js';
import { ChannelAdapterRegistry } from '../../channels/backplane/registry-port.js';
import { startDiscordWithRetry } from './discord-startup.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { GatewayBootstrapInput } from './bootstrap-input.js';
import type { GatewayServer } from './server.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  createDiscordChannelAdapterFactoryEntry,
  createOpenHomeChannelAdapterFactoryEntry,
  createTelegramChannelAdapterFactoryEntry,
  getOptionalChannelAdapter,
  requireChannelAdapter,
} from '../../app/startup/composition/channel-runtime.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
  type RuntimeChannelLifecycleLogger,
} from '../../app/startup/support/channel-lifecycle.js';

export interface GatewayChannelSurfaces {
  discord: DiscordAdapter;
  telegram?: TelegramAdapter;
}

export interface LoadGatewayChannelSurfacesInput {
  config: SubstrateConfig;
  bootstrap: GatewayBootstrapInput;
  eventBus: EventBus;
  eligibilityGate: EligibilityGate;
  log: RuntimeChannelLifecycleLogger;
}

export interface GatewayChannelStartupLogger extends RuntimeChannelLifecycleLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

export async function initGatewayChannelSurfaces(
  surfaces: GatewayChannelSurfaces,
): Promise<void> {
  if (surfaces.telegram) {
    await surfaces.telegram.init();
  }
  await surfaces.discord.init();
}

export async function loadGatewayChannelSurfaces(
  input: LoadGatewayChannelSurfacesInput,
): Promise<GatewayChannelSurfaces> {
  const gatewayChannelRegistry = new ChannelAdapterRegistry();
  const gatewayChannelManifest = buildChannelAdapterFactoryManifest([
    createDiscordChannelAdapterFactoryEntry({
      config: input.config,
      discordConfig: input.bootstrap.channelsConfig.discord,
      eventBus: input.eventBus,
      eligibilityGate: input.eligibilityGate,
      personalFilesDir: input.bootstrap.workspaceRoot,
    }),
    createOpenHomeChannelAdapterFactoryEntry(),
    createTelegramChannelAdapterFactoryEntry({
      config: input.bootstrap.channelsConfig.telegram,
      eventBus: input.eventBus,
    }),
  ]);

  await loadChannelAdaptersFromManifest(
    gatewayChannelRegistry,
    gatewayChannelManifest,
    () => undefined,
    input.log,
    input.eligibilityGate,
  );

  return {
    discord: requireChannelAdapter<DiscordAdapter>(gatewayChannelRegistry, 'discord'),
    telegram: getOptionalChannelAdapter<TelegramAdapter>(gatewayChannelRegistry, 'telegram'),
  };
}

export interface WireGatewayChannelMessagesInput {
  discord: Pick<DiscordAdapter, 'onMessage'>;
  telegram?: Pick<TelegramAdapter, 'onMessage'>;
  gateway: Pick<GatewayServer, 'notifyAll' | 'requestAgentVoiceStream'>;
  serializeMessage: (message: SubstrateMessage) => Record<string, unknown>;
}

export function wireGatewayChannelMessages(input: WireGatewayChannelMessagesInput): void {
  input.discord.onMessage(async (message) => {
    input.gateway.notifyAll('discord.message', {
      message: input.serializeMessage(message),
    });
    return {
      content: '',
      channelId: message.channelId,
      metadata: {
        model: '',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      },
    };
  });

  if (!input.telegram) {
    return;
  }
  if (typeof input.telegram.onMessage !== 'function') {
    throw new Error('Telegram adapter is missing onMessage bootstrap hook');
  }

  input.telegram.onMessage(async (message) => {
    const result = await input.gateway.requestAgentVoiceStream(message);
    return {
      content: result.content,
      channelId: result.channelId,
      ...(result.attachments ? { attachments: result.attachments } : {}),
      metadata: {
        model: result.model,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: result.durationMs,
      },
    };
  });
}

export async function startGatewayChannelSurfaces(
  surfaces: GatewayChannelSurfaces,
  bootstrap: GatewayBootstrapInput,
  log: GatewayChannelStartupLogger,
): Promise<void> {
  let discordStartAttempts = 0;
  await startDiscordWithRetry(
    async () => {
      discordStartAttempts += 1;
      await surfaces.discord.start();
    },
    {
      baseDelayMs: bootstrap.discordStartRetry.baseDelayMs,
      maxDelayMs: bootstrap.discordStartRetry.maxDelayMs,
      maxAttempts: bootstrap.discordStartRetry.maxAttempts,
      onRetry: ({ attempt, delayMs, maxAttempts, error }) => {
        const rawCode = (error as Error & { code?: unknown }).code;
        const code = typeof rawCode === 'string' ? rawCode : undefined;
        log.warn('Discord startup failed; retrying', {
          attempt,
          ...(maxAttempts > 0 ? { maxAttempts } : { maxAttempts: 'unbounded' }),
          delayMs,
          ...(code ? { code } : {}),
          error: error.message,
        });
      },
    },
  );
  if (discordStartAttempts > 1) {
    log.info('Discord startup recovered after retries', { attempts: discordStartAttempts });
  }

  if (!surfaces.telegram) {
    return;
  }

  await surfaces.telegram.start();
  log.info('Telegram gateway bridge enabled', {
    mode: bootstrap.channelsConfig.telegram.mode,
    allowlistSize: bootstrap.channelsConfig.telegram.allowedUsers.length,
  });
}

export async function stopGatewayChannelSurfaces(
  surfaces: GatewayChannelSurfaces,
): Promise<void> {
  await surfaces.telegram?.stop();
  await surfaces.discord.stop();
}
