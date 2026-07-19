import type {
  TtsAudioEncoding,
  TtsSynthesisRequest,
  TtsSynthesisSession,
  StreamingTtsConnector,
} from './types.js';
import { combineAbortSignal } from '../../../../shared/utils/abort-signal.js';
import { abortError, toError } from '../../../../shared/utils/errors.js';
import {
  responseBodyToAudioChunks,
  responseError,
  singleChunkSession,
} from './stream-helpers.js';

export interface ElevenLabsStreamingTtsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  endpointBase: string;
  fetchImpl?: typeof fetch;
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

export class ElevenLabsStreamingTtsConnector implements StreamingTtsConnector {
  readonly id = 'elevenlabs';

  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly endpointBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ElevenLabsStreamingTtsConfig) {
    const apiKey = config.apiKey.trim();
    const voiceId = config.voiceId.trim();
    const modelId = config.modelId.trim();
    const endpointBase = config.endpointBase.trim().replace(/\/+$/g, '');
    if (!apiKey || !voiceId || !modelId || !endpointBase) {
      throw new Error(
        'ElevenLabs streaming config requires apiKey, voiceId, modelId, and endpointBase',
      );
    }
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.endpointBase = endpointBase;
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
        audio: responseBodyToAudioChunks(
          response.body,
          encoding,
          'stream',
          combinedSignal,
          'TTS streaming aborted',
        ),
        cancel: async (reason?: string): Promise<void> => {
          if (!controller.signal.aborted) {
            controller.abort(abortError(reason ?? 'cancelled', 'Request aborted', true));
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
