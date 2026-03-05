import type {
  TtsAudioChunk,
  TtsAudioEncoding,
  TtsSynthesisRequest,
  TtsSynthesisSession,
  StreamingTtsConnector,
} from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:8001';
const DEFAULT_VOICE = '11labs-Allison';
const ECHO_SPEECH_PATH = '/v1/audio/speech';

type EchoResponseFormat = 'mp3' | 'opus' | 'pcm';

interface EchoSpeechRequestBody {
  input: string;
  voice: string;
  response_format: EchoResponseFormat;
  stream: boolean;
  extra_body?: Record<string, unknown>;
}

export interface EchoStreamingTtsConfig {
  baseUrl?: string;
  voice?: string;
  preset?: string;
  model?: string;
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
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

function normalizeRequestError(error: unknown, signal: AbortSignal | undefined, abortMessage: string): Error {
  const normalized = toError(error);

  if (normalized.name === 'AbortError') {
    return normalized;
  }

  if (signal?.aborted) {
    return abortError(abortMessage);
  }

  return normalized;
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

function resolveEncoding(request: TtsSynthesisRequest): TtsAudioEncoding {
  return request.encoding ?? 'mp3';
}

function resolveResponseFormat(request: TtsSynthesisRequest): EchoResponseFormat {
  const encoding = request.encoding ?? 'mp3';

  switch (encoding) {
    case 'opus':
      return 'opus';
    case 'pcm_s16le':
      return 'pcm';
    case 'mp3':
    default:
      return 'mp3';
  }
}

async function* responseBodyToAudioChunks(
  body: ReadableStream<Uint8Array>,
  encoding: TtsAudioEncoding,
  signal?: AbortSignal,
): AsyncGenerator<TtsAudioChunk> {
  const reader = body.getReader();
  let sequence = 0;
  let pending: Uint8Array | null = null;

  try {
    for (;;) {
      if (signal?.aborted) {
        throw abortError('Echo streaming TTS aborted');
      }

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw normalizeRequestError(error, signal, 'Echo streaming TTS aborted');
      }

      if (chunk.done) break;
      if (chunk.value.byteLength === 0) continue;

      if (pending) {
        yield {
          audio: pending,
          sequence,
          isFinal: false,
          encoding,
          source: 'stream',
        };
        sequence += 1;
      }

      pending = chunk.value;
    }

    if (pending) {
      yield {
        audio: pending,
        sequence,
        isFinal: true,
        encoding,
        source: 'stream',
      };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class EchoStreamingTtsConnector implements StreamingTtsConnector {
  readonly id = 'echo';

  private readonly baseUrl: string;
  private readonly voice: string;
  private readonly preset?: string;
  private readonly model?: string;
  private readonly extraBody?: Record<string, unknown>;
  private readonly headers?: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EchoStreamingTtsConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.voice = config.voice ?? DEFAULT_VOICE;
    this.preset = config.preset;
    this.model = config.model;
    this.extraBody = config.extraBody;
    this.headers = config.headers;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async synthesizeStream(request: TtsSynthesisRequest, signal?: AbortSignal): Promise<TtsSynthesisSession> {
    const controller = new AbortController();
    const combinedSignal = combineAbortSignal(signal, controller.signal);
    const encoding = resolveEncoding(request);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${ECHO_SPEECH_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*',
          ...this.headers,
        },
        body: JSON.stringify(this.createRequestBody(request, true)),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw await responseError('Echo streaming TTS failed', response);
      }

      if (!response.body) {
        throw new Error('Echo streaming TTS failed: response body was empty');
      }

      return {
        audio: responseBodyToAudioChunks(response.body, encoding, combinedSignal),
        cancel: async (reason?: string): Promise<void> => {
          if (!controller.signal.aborted) {
            controller.abort(abortError(reason ?? 'cancelled'));
          }
        },
      };
    } catch (error) {
      throw normalizeRequestError(error, combinedSignal, 'Echo streaming TTS aborted');
    }
  }

  async synthesizeBuffer(request: TtsSynthesisRequest, signal?: AbortSignal): Promise<Buffer> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${ECHO_SPEECH_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*',
          ...this.headers,
        },
        body: JSON.stringify(this.createRequestBody(request, false)),
        signal,
      });

      if (!response.ok) {
        throw await responseError('Echo buffered TTS failed', response);
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw normalizeRequestError(error, signal, 'Echo buffered TTS aborted');
    }
  }

  private createRequestBody(request: TtsSynthesisRequest, stream: boolean): EchoSpeechRequestBody {
    return {
      input: request.text,
      voice: request.voiceId ?? this.voice,
      response_format: resolveResponseFormat(request),
      stream,
      extra_body: this.resolveExtraBody(),
    };
  }

  private resolveExtraBody(): Record<string, unknown> | undefined {
    const extraBody: Record<string, unknown> = {
      ...(this.extraBody ?? {}),
    };

    if (this.preset) {
      extraBody.preset = this.preset;
    }

    if (this.model) {
      extraBody.model = this.model;
    }

    return Object.keys(extraBody).length > 0 ? extraBody : undefined;
  }
}

export function createEchoStreamingTtsConnector(config: EchoStreamingTtsConfig = {}): EchoStreamingTtsConnector {
  return new EchoStreamingTtsConnector(config);
}
