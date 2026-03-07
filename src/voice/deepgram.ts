export interface DeepgramSttConfig {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
  allowDirectNetworkEgress?: boolean;
}

interface DeepgramListenResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
      }>;
    }>;
  };
}

export class DeepgramSttClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetchFn?: typeof fetch;
  private readonly allowDirectNetworkEgress: boolean;

  constructor(config: DeepgramSttConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'nova-3';
    this.endpoint = config.endpoint ?? 'https://api.deepgram.com/v1/listen';
    this.fetchFn = config.fetchFn;
    this.allowDirectNetworkEgress = config.allowDirectNetworkEgress ?? !isGatewayAgentEntrypoint();
  }

  private resolveFetch(): typeof fetch {
    if (this.fetchFn) return this.fetchFn;
    if (this.allowDirectNetworkEgress) return fetch;
    throw new Error(
      'Direct network egress is disabled; Deepgram client requires gateway-backed fetch wiring.',
    );
  }

  async transcribeWav(audioWav: Buffer): Promise<string> {
    const url = new URL(this.endpoint);
    url.searchParams.set('model', this.model);
    url.searchParams.set('punctuate', 'true');
    url.searchParams.set('smart_format', 'true');

    const response = await this.resolveFetch()(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: audioWav,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Deepgram STT failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`);
    }

    const payload = await response.json() as DeepgramListenResponse;
    return payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
  }
}

function isGatewayAgentEntrypoint(): boolean {
  const entrypoint = (process.argv[1] ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return entrypoint.endsWith('/agent-main.ts') || entrypoint.endsWith('/agent-main.js');
}
