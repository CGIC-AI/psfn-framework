import type {
  ChannelAdapterPort,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  ChannelPromptAdapter,
  OutboundContext,
} from '../../../src/channels/backplane/types.js';
import type { SatelliteAdapterPort } from '../../../src/core/agent/satellite-adapter-port.js';

const OPENHOME_CAPABILITIES: ChannelCapabilities = {
  chatTypes: ['direct'],
  media: false,
  reactions: false,
  threads: false,
  streaming: true,
  promptChannelType: 'psfn-amica',
};

const OPENHOME_GATEWAY: ChannelGatewayAdapter = {
  async init(): Promise<void> {},
  async start(): Promise<void> {},
  async stop(): Promise<void> {},
};

const OPENHOME_PROMPT: ChannelPromptAdapter = {
  resolveChannelType: () => 'psfn-amica',
};

export class OpenHomeAdapter implements ChannelAdapterPort {
  readonly id = 'psfn-amica';
  readonly name = this.id;
  readonly meta = {
    label: 'PSFN Amica',
    emoji: ':satellite:',
  };
  readonly capabilities = OPENHOME_CAPABILITIES;
  readonly config: ChannelConfigAdapter = {
    enabled: true,
    connectionLabel: 'psfn-amica-external-api-claim',
  };
  readonly outbound: ChannelOutboundAdapter = {
    textChunkLimit: Number.MAX_SAFE_INTEGER,
    sendText: async (ctx: OutboundContext, _text: string): Promise<void> => {
      throw new Error(
        `PSFN Amica outbound delivery is not wired for "${ctx.channelId}"; replies must flow through the initiating transport`,
      );
    },
  };
  readonly gateway = OPENHOME_GATEWAY;
  readonly prompt = OPENHOME_PROMPT;

  async init(): Promise<void> {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(channelId: string, content: string): Promise<void> {
    await this.outbound.sendText({ channelId }, content);
  }
}

export function createOpenHomeSatelliteAdapterPort(): SatelliteAdapterPort {
  return {
    id: 'psfn-amica',
    channel: {
      manifest: {
        id: 'psfn-amica',
        label: 'PSFN Amica',
        enabled: true,
        required: false,
        eligibility: {},
      },
      create: async (): Promise<ChannelAdapterPort> => {
        const adapter = new OpenHomeAdapter();
        await adapter.init();
        return adapter;
      },
    },
  };
}
