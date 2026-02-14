export interface ElevenLabsTtsConfig {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  endpointBase?: string;
}

export class ElevenLabsTtsClient {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly endpointBase: string;

  constructor(config: ElevenLabsTtsConfig) {
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId;
    this.modelId = config.modelId ?? 'eleven_turbo_v2_5';
    this.endpointBase = config.endpointBase ?? 'https://api.elevenlabs.io/v1';
  }

  async synthesize(text: string): Promise<Buffer> {
    const response = await fetch(`${this.endpointBase}/text-to-speech/${this.voiceId}`, {
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
