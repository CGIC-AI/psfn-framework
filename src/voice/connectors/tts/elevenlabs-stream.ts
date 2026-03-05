import type {
  TtsAudioChunk,
  TtsAudioEncoding,
  TtsSynthesisRequest,
  TtsSynthesisSession,
  StreamingTtsConnector,
} from './types.js';

const DEFAULT_ENDPOINT_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';

export interface ElevenLabsStreamingTtsConfig {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  endpointBase?: string;
  fetchImpl?: typeof fetch;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function responseError(prefix: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');
  return new Error(`${prefix}: ${response.status} ${response.statusText} ${body.slice(0, 300)}`);
}

function combineAbortSignal(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const abortSignalAny = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;

  if (abortSignalAny) {
    return abortSignalAny([primary, secondary]);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  primary.addEventListener('abort', onAbort, { once: true });
  secondary.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

function resolveOutputFormat(request: TtsSynthesisRequest): string {
  const encoding = request.encoding ?? 'mp3';
  const sampleRateHz = request.sampleRateHz ?? 44_100;

  if (encoding === 'pcm_s16le') {
    return `pcm_${sampleRateHz}`;
  }

  return 'mp3_44100_128';
}

function resolveEncoding(request: TtsSynthesisRequest): TtsAudioEncoding {
  return request.encoding ?? 'mp3';
}

function singleChunkSession(
  audio: Uint8Array,
  encoding: TtsAudioEncoding,
  source: TtsAudioChunk['source'],
): TtsSynthesisSession {
  return {
    audio: (async function* streamOneChunk(): AsyncGenerator<TtsAudioChunk> {
      yield {
        audio,
        sequence: 0,
        isFinal: true,
        encoding,
        source,
      };
    })(),
    cancel: async (): Promise<void> => {},
  };
}

async function* responseBodyToAudioChunks(
  body: ReadableStream<Uint8Array>,
  encoding: TtsAudioEncoding,
  source: TtsAudioChunk['source'],
  signal?: AbortSignal,
): AsyncGenerator<TtsAudioChunk> {
  const reader = body.getReader();
  let sequence = 0;
  let pending: Uint8Array | null = null;

  try {
    for (;;) {
      if (signal?.aborted) {
        throw abortError('TTS streaming aborted');
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;

      if (pending) {
        yield {
          audio: pending,
          sequence,
          isFinal: false,
          encoding,
          source,
        };
        sequence += 1;
      }

      pending = value;
    }

    if (pending) {
      yield {
        audio: pending,
        sequence,
        isFinal: true,
        encoding,
        source,
      };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class ElevenLabsStreamingTtsConnector implements StreamingTtsConnector {
  readonly id = 'elevenlabs';

  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly endpointBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ElevenLabsStreamingTtsConfig) {
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId;
    this.modelId = config.modelId ?? DEFAULT_MODEL_ID;
    this.endpointBase = config.endpointBase ?? DEFAULT_ENDPOINT_BASE;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async synthesizeStream(request: TtsSynthesisRequest, signal?: AbortSignal): Promise<TtsSynthesisSession> {
    const controller = new AbortController();
    const combinedSignal = combineAbortSignal(signal, controller.signal);
    const encoding = resolveEncoding(request);
    const allowBufferFallback = request.allowBufferFallback !== false;
    const voiceId = request.voiceId ?? this.voiceId;

    try {
      const response = await this.fetchImpl(`${this.endpointBase}/text-to-speech/${voiceId}/stream`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          model_id: this.modelId,
          text: request.text,
          output_format: resolveOutputFormat(request),
        }),
        signal: combinedSignal,
      });

      if (!response.ok || !response.body) {
        if (!allowBufferFallback) {
          throw await responseError('ElevenLabs streaming TTS failed', response);
        }

        const audio = await this.synthesizeBuffer(request, combinedSignal);
        return singleChunkSession(audio, encoding, 'buffer-fallback');
      }

      return {
        audio: responseBodyToAudioChunks(response.body, encoding, 'stream', combinedSignal),
        cancel: async (reason?: string): Promise<void> => {
          if (!controller.signal.aborted) {
            controller.abort(abortError(reason ?? 'cancelled'));
          }
        },
      };
    } catch (error) {
      if (!allowBufferFallback || (signal?.aborted ?? false)) {
        throw toError(error);
      }

      const audio = await this.synthesizeBuffer(request, combinedSignal);
      return singleChunkSession(audio, encoding, 'buffer-fallback');
    }
  }

  async synthesizeBuffer(request: TtsSynthesisRequest, signal?: AbortSignal): Promise<Buffer> {
    const voiceId = request.voiceId ?? this.voiceId;
    const response = await this.fetchImpl(`${this.endpointBase}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        model_id: this.modelId,
        text: request.text,
        output_format: resolveOutputFormat(request),
      }),
      signal,
    });

    if (!response.ok) {
      throw await responseError('ElevenLabs buffered TTS failed', response);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}

export function createElevenLabsStreamingTtsConnector(config: ElevenLabsStreamingTtsConfig): ElevenLabsStreamingTtsConnector {
  return new ElevenLabsStreamingTtsConnector(config);
}
