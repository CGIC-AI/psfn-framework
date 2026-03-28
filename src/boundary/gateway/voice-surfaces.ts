import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import { EligibilityDeniedError } from '../../system/capabilities/eligibility.js';
import { WyomingTcpServer } from '../../channels/wyoming/server.js';
import { WyomingRuntime } from '../../channels/wyoming/runtime.js';
import { createWyomingServiceRegistry } from '../../channels/wyoming/services/index.js';
import { createWyomingHandleServiceAdapter } from '../../channels/wyoming/services/handle.js';
import { createWyomingAsrServiceAdapter } from '../../channels/wyoming/services/asr.js';
import { createWyomingTtsServiceAdapter } from '../../channels/wyoming/services/tts.js';
import type { WyomingInfoData } from '../../channels/wyoming/protocol.js';
import type { DiscordAdapter } from '../../channels/discord/adapter.js';
import type { EventBus } from '../../shared/event-bus.js';
import { DEFAULT_COMPANION_ID } from '../../core/identity/companion-naming.js';
import type { GatewayServer } from './server.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  resolveRuntimeVoiceProviderGate,
} from '../../app/startup/support/bootstrap-helpers.js';

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
  const voiceModuleHost = new GatewayVoiceModuleHost({
    gateway: input.gateway,
    discord: input.discord,
    eventBus: input.eventBus,
  });
  voiceModuleHost.registerModule(createDiscordReverseRpcVoiceModule());
  await voiceModuleHost.registerAll();

  let wyomingTcpServer: WyomingTcpServer | undefined;
  let wyomingRuntime: WyomingRuntime | undefined;

  if (input.config.wyomingEnabled) {
    const wyomingPort = input.config.wyomingPort ?? 10400;
    const wyomingHost = input.config.wyomingHost ?? '127.0.0.1';

    const handleAdapter = createWyomingHandleServiceAdapter({
      handleMessage: async (message) => {
        const result = await input.gateway.requestAgentVoiceStream(message);
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
      },
      eventBus: input.eventBus,
    });

    const wyomingAdapters = [handleAdapter];
    const voiceProviderGate = resolveRuntimeVoiceProviderGate(input.config);
    const wyomingSttProvider = voiceProviderGate.sttProvider;
    const wyomingTtsProvider = voiceProviderGate.ttsProvider;

    if (voiceProviderGate.sttEnabled) {
      try {
        const runtimeStt = createRuntimeVoiceSttConnector(input.config, {
          eligibilityGate: input.eligibilityGate,
        });
        if (!runtimeStt) {
          input.log.info('Wyoming ASR adapter disabled', {
            provider: wyomingSttProvider,
            reason: 'eligibility_or_runtime_binding_unavailable',
          });
        } else {
          wyomingAdapters.push(createWyomingAsrServiceAdapter({ stt: runtimeStt.connector }));
          input.log.info('Wyoming ASR adapter enabled', { provider: runtimeStt.provider });
        }
      } catch (error) {
        if (!(error instanceof EligibilityDeniedError)) {
          throw error;
        }
        input.log.info('Wyoming ASR adapter disabled by eligibility gate', {
          provider: wyomingSttProvider,
          error: error.message,
        });
      }
    } else {
      input.log.info('Wyoming ASR adapter disabled', {
        provider: wyomingSttProvider,
        hasDeepgramApiKey: Boolean(input.config.deepgramApiKey),
      });
    }

    try {
      if (voiceProviderGate.ttsEnabled) {
        const runtimeTts = createRuntimeVoiceTtsConnector(input.config, {
          requireElevenLabsVoiceId: true,
          eligibilityGate: input.eligibilityGate,
        });
        if (!runtimeTts) {
          throw new Error(`Expected runtime TTS connector for provider "${wyomingTtsProvider}"`);
        }
        wyomingAdapters.push(createWyomingTtsServiceAdapter({ tts: runtimeTts.connector }));
        input.log.info('Wyoming TTS adapter enabled', { provider: runtimeTts.provider });
      } else {
        input.log.info('Wyoming TTS adapter disabled', {
          provider: wyomingTtsProvider,
          hasElevenLabsApiKey: Boolean(input.config.elevenLabsApiKey),
          hasEchoConfig: Boolean(input.config.echoTtsUrl && input.config.echoTtsVoice),
        });
      }
    } catch (error) {
      if (error instanceof EligibilityDeniedError) {
        input.log.info('Wyoming TTS adapter disabled by eligibility gate', {
          provider: wyomingTtsProvider,
          error: error.message,
        });
      } else {
        input.log.warn('Wyoming TTS adapter could not be created', { error: String(error) });
      }
    }

    const serviceRegistry = createWyomingServiceRegistry(wyomingAdapters);

    wyomingTcpServer = new WyomingTcpServer(
      { port: wyomingPort, host: wyomingHost, eventBus: input.eventBus },
      {
        onFrame: (session, frame) => wyomingRuntime!.handleFrame(session, frame),
        onSessionClose: (session) => wyomingRuntime!.closeConnection(session.connectionId),
      },
    );

    wyomingRuntime = new WyomingRuntime({
      info: {
        name: DEFAULT_COMPANION_ID,
        version: '1.0.0',
        description: 'Companion Substrate Framework — Wyoming voice bridge',
        services: serviceRegistry.services,
      } as WyomingInfoData,
      emitFrame: (session, frame) => wyomingTcpServer!.send(session, frame),
      serviceRegistry,
      eventBus: input.eventBus,
    });

    input.log.info(`Wyoming voice bridge configured on ${wyomingHost}:${wyomingPort}`);
  }

  return {
    start: async () => {
      await voiceModuleHost.startAll();
      if (!wyomingTcpServer) {
        return;
      }
      await wyomingTcpServer.start();
      input.log.info(
        `Wyoming voice bridge listening on ${input.config.wyomingHost ?? '127.0.0.1'}:${input.config.wyomingPort ?? 10400}`,
      );
    },
    stop: async () => {
      await wyomingRuntime?.stop();
      await wyomingTcpServer?.stop();
      await voiceModuleHost.stopAll();
    },
  };
}
