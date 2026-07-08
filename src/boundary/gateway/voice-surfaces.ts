import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { DiscordAdapter } from '../../channels/discord/adapter.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { GatewayServer } from './server.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

export interface GatewayVoiceModuleContext {
  gateway: GatewayServer;
  discord: DiscordAdapter;
  eventBus: EventBus;
}

export interface GatewayVoiceModule {
  id: string;
  register?(context: GatewayVoiceModuleContext): void | Promise<void>;
  start?(context: GatewayVoiceModuleContext): void | Promise<void>;
  stop?(context: GatewayVoiceModuleContext): void | Promise<void>;
}

export class GatewayVoiceModuleHost {
  private readonly modules: GatewayVoiceModule[] = [];
  private readonly context: GatewayVoiceModuleContext;

  constructor(context: GatewayVoiceModuleContext) {
    this.context = context;
  }

  registerModule(module: GatewayVoiceModule): void {
    this.modules.push(module);
  }

  async registerAll(): Promise<void> {
    for (const module of this.modules) {
      await module.register?.(this.context);
    }
  }

  async startAll(): Promise<void> {
    for (const module of this.modules) {
      await module.start?.(this.context);
    }
  }

  async stopAll(): Promise<void> {
    for (const module of [...this.modules].reverse()) {
      await module.stop?.(this.context);
    }
  }
}

export function createDiscordReverseRpcVoiceModule(): GatewayVoiceModule {
  return {
    id: 'discord-reverse-rpc-voice',
    register: ({ gateway, discord }) => {
      discord.setVoiceHandler(async (message) => {
        const result = await gateway.requestAgentVoiceStream(message);
        return {
          content: result.content,
          channelId: result.channelId,
          metadata: {
            model: result.model,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: result.durationMs,
          },
        };
      });
    },
  };
}

export interface GatewayVoiceSurfaceLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface GatewayVoiceSurfaces {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateGatewayVoiceSurfacesInput {
  config: SubstrateConfig;
  eventBus: EventBus;
  gateway: GatewayServer;
  discord: DiscordAdapter;
  eligibilityGate: EligibilityGate;
  log: GatewayVoiceSurfaceLogger;
}

export async function createGatewayVoiceSurfaces(
  input: CreateGatewayVoiceSurfacesInput,
): Promise<GatewayVoiceSurfaces> {
  if (input.config.wyomingEnabled) {
    throw new Error(
      'Gateway-hosted Wyoming endpoint runtime has moved to the Satellite Hub repository. ' +
      'Disable WYOMING_ENABLED here and run Wyoming/OpenHome endpoints through Satellite Hub.',
    );
  }

  const voiceModuleHost = new GatewayVoiceModuleHost({
    gateway: input.gateway,
    discord: input.discord,
    eventBus: input.eventBus,
  });
  voiceModuleHost.registerModule(createDiscordReverseRpcVoiceModule());
  await voiceModuleHost.registerAll();

  return {
    start: async () => {
      await voiceModuleHost.startAll();
    },
    stop: async () => {
      await voiceModuleHost.stopAll();
    },
  };
}
