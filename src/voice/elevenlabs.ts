export interface ElevenLabsTtsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  endpointBase: string;
  fetchFn?: typeof fetch;
  allowDirectNetworkEgress?: boolean;
}

function isGatewayAgentEntrypoint(): boolean {
  const entrypoint = (process.argv[1] ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return entrypoint.endsWith('/agent-main.ts') || entrypoint.endsWith('/agent-main.js');
}

export class ElevenLabsTtsClient {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly endpointBase: string;
  private readonly fetchFn?: typeof fetch;
  private readonly allowDirectNetworkEgress: boolean;

  constructor(config: ElevenLabsTtsConfig) {
    const apiKey = config.apiKey.trim();
    const voiceId = config.voiceId.trim();
    const modelId = config.modelId.trim();
    const endpointBase = config.endpointBase.trim().replace(/\/+$/g, '');
    if (!apiKey || !voiceId || !modelId || !endpointBase) {
      throw new Error('ElevenLabs config requires apiKey, voiceId, modelId, and endpointBase');
    }
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.endpointBase = endpointBase;
    this.fetchFn = config.fetchFn;
    this.allowDirectNetworkEgress = config.allowDirectNetworkEgress ?? !isGatewayAgentEntrypoint();
  }

  private resolveFetch(): typeof fetch {
    if (this.fetchFn) return this.fetchFn;
    if (this.allowDirectNetworkEgress) return fetch;
    throw new Error(
      'Direct network egress is disabled; ElevenLabs client requires gateway-backed fetch wiring.',
    );
  }

  async synthesize(text: string): Promise<Buffer> {
    const response = await this.resolveFetch()(`${this.endpointBase}/text-to-speech/${this.voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        model_id: this.modelId,
        text,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
