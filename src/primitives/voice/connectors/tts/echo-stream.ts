import type {
  TtsAudioEncoding,
  TtsSynthesisRequest,
  TtsSynthesisSession,
  StreamingTtsConnector,
} from './types.js';
import { combineAbortSignal } from '../../../../shared/utils/abort-signal.js';
import { abortError, toError } from '../../../../shared/utils/errors.js';
import { responseBodyToAudioChunks, responseError } from './stream-helpers.js';

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
        audio: responseBodyToAudioChunks(
          response.body,
          encoding,
          'stream',
          combinedSignal,
          'Echo streaming TTS aborted',
          error => normalizeRequestError(error, combinedSignal, 'Echo streaming TTS aborted'),
        ),
        cancel: async (reason?: string): Promise<void> => {
          if (!controller.signal.aborted) {
            controller.abort(abortError(reason ?? 'cancelled', 'Request aborted', true));
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
