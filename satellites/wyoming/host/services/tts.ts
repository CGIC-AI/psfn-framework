import type {
  StreamingTtsConnector,
  TtsAudioEncoding,
  TtsSynthesisRequest,
  TtsSynthesisSession,
} from '../../../../src/primitives/voice/connectors/tts/types.js';
import { isRecord, type WyomingFrame, type WyomingJsonObject } from '../../protocol/index.js';
import type {
  WyomingServiceAdapter,
  WyomingServiceSessionClosedRequest,
} from './contracts.js';

export const WYOMING_TTS_EVENT_TYPES = [
  'synthesize',
  'synthesize-start',
  'synthesize-chunk',
  'synthesize-stop',
] as const;

type TtsErrorCode =
  | 'invalid_request'
  | 'unavailable'
  | 'cancelled';

class TtsServiceError extends Error {
  readonly code: TtsErrorCode;

  constructor(code: TtsErrorCode, message: string) {
    super(message);
    this.name = 'TtsServiceError';
    this.code = code;
  }
}

interface SynthesisMetadata {
  request: Omit<TtsSynthesisRequest, 'text'>;
  language?: string;
  model?: string;
  channels: number;
  rate: number;
  width: number;
}

interface BufferedSynthesisState extends SynthesisMetadata {
  key: string;
  sessionId: string;
  textParts: string[];
}

export interface WyomingTtsServiceOptions {
  tts: StreamingTtsConnector;
  defaultRequest?: Omit<TtsSynthesisRequest, 'text'>;
}

function toSessionKey(connectionId: string, sessionId: string): string {
  return `${connectionId}:${sessionId}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  return /abort|cancel/i.test(error.message);
}

function readString(data: WyomingJsonObject | undefined, keys: string[]): string | undefined {
  if (!data) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function readNumber(data: WyomingJsonObject | undefined, keys: string[]): number | undefined {
  if (!data) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function readBoolean(data: WyomingJsonObject | undefined, keys: string[]): boolean | undefined {
  if (!data) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return undefined;
}

function resolveVoiceId(data: WyomingJsonObject | undefined): string | undefined {
  const direct = readString(data, ['voice_id', 'voiceId']);
  if (direct) return direct;

  const voice = data?.voice;
  if (typeof voice === 'string') {
    const trimmed = voice.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (isRecord(voice)) {
    return readString(voice as WyomingJsonObject, ['id', 'voice_id', 'voiceId', 'name']);
  }

  return undefined;
}

function resolveEncoding(
  data: WyomingJsonObject | undefined,
  fallback: TtsAudioEncoding | undefined,
): TtsAudioEncoding {
  const value = readString(data, ['encoding', 'format'])?.toLowerCase();
  if (!value) return fallback ?? 'pcm_s16le';
  if (value.includes('opus')) return 'opus';
  if (value.includes('mp3') || value.includes('mpeg')) return 'mp3';
  return 'pcm_s16le';
}

function resolveMetadata(
  data: WyomingJsonObject | undefined,
  defaults: Omit<TtsSynthesisRequest, 'text'> | undefined,
): SynthesisMetadata {
  const voiceId = resolveVoiceId(data) ?? defaults?.voiceId;
  const encoding = resolveEncoding(data, defaults?.encoding);
  const sampleRate = Math.max(
    1,
    Math.floor(
      readNumber(data, ['sample_rate', 'sampleRateHz', 'sampleRate', 'rate'])
      ?? defaults?.sampleRateHz
      ?? 22_050,
    ),
  );
  const channels = Math.max(
    1,
    Math.floor(readNumber(data, ['channels']) ?? 1),
  );
  const width = Math.max(
    0,
    Math.floor(
      readNumber(data, ['width', 'sample_width', 'sampleWidth'])
      ?? (encoding === 'pcm_s16le' ? 2 : 0),
    ),
  );
  const allowBufferFallback = readBoolean(
    data,
    ['allow_buffer_fallback', 'allowBufferFallback'],
  );

  return {
    request: {
      ...(voiceId ? { voiceId } : {}),
      ...(Number.isFinite(sampleRate) ? { sampleRateHz: sampleRate } : {}),
      encoding,
      ...(allowBufferFallback !== undefined ? { allowBufferFallback } : {}),
    },
    language: readString(data, ['language', 'lang']),
    model: readString(data, ['name', 'model']),
    channels,
    rate: sampleRate,
    width,
  };
}

function mergeMetadata(
  current: SynthesisMetadata,
  incoming: SynthesisMetadata,
): SynthesisMetadata {
  return {
    request: {
      ...current.request,
      ...incoming.request,
    },
    language: incoming.language ?? current.language,
    model: incoming.model ?? current.model,
    channels: incoming.channels,
    rate: incoming.rate,
    width: incoming.width,
  };
}

function createAckFrame(event: string, sessionId: string): WyomingFrame {
  return {
    type: 'ack',
    data: {
      event,
      session_id: sessionId,
    },
  };
}

function createErrorFrame(
  code: TtsErrorCode,
  frame: WyomingFrame,
  message: string,
  sessionId?: string,
): WyomingFrame {
  return {
    type: 'error',
    data: {
      code,
      event: frame.type,
      service: 'tts',
      message,
      session_id: sessionId ?? null,
    },
  };
}

function extractText(data: WyomingJsonObject | undefined): string | undefined {
  return readString(data, ['text', 'chunk', 'utterance', 'input']);
}

function createBufferedState(
  key: string,
  sessionId: string,
  metadata: SynthesisMetadata,
): BufferedSynthesisState {
  return {
    key,
    sessionId,
    textParts: [],
    request: { ...metadata.request },
    language: metadata.language,
    model: metadata.model,
    channels: metadata.channels,
    rate: metadata.rate,
    width: metadata.width,
  };
}

function collectText(state: BufferedSynthesisState): string {
  return state.textParts.join('').trim();
}

export function createWyomingTtsServiceAdapter(
  options: WyomingTtsServiceOptions,
): WyomingServiceAdapter {
  const buffered = new Map<string, BufferedSynthesisState>();
  const active = new Map<string, TtsSynthesisSession>();

  const closeActiveSession = async (key: string, reason: string): Promise<void> => {
    const session = active.get(key);
    if (!session) return;
    active.delete(key);
    await session.cancel(reason).catch(() => undefined);
  };

  const synthesize = async (
    state: BufferedSynthesisState,
  ): Promise<WyomingFrame[]> => {
    const text = collectText(state);
    if (!text) {
      throw new TtsServiceError(
        'invalid_request',
        'synthesize request requires non-empty text',
      );
    }

    await closeActiveSession(state.key, 'tts.restart');

    const session = await options.tts.synthesizeStream({
      ...state.request,
      text,
    });
    active.set(state.key, session);

    const frames: WyomingFrame[] = [{
      type: 'audio-start',
      data: {
        session_id: state.sessionId,
        rate: state.rate,
        width: state.width,
        channels: state.channels,
        ...(state.language ? { language: state.language } : {}),
        ...(state.model ? { model: state.model } : {}),
      },
    }];

    try {
      for await (const chunk of session.audio) {
        frames.push({
          type: 'audio-chunk',
          data: {
            session_id: state.sessionId,
            sequence: chunk.sequence,
            is_final: chunk.isFinal,
            encoding: chunk.encoding,
            source: chunk.source,
          },
          payload: chunk.audio,
        });
      }

      frames.push({
        type: 'audio-stop',
        data: {
          session_id: state.sessionId,
        },
      });
      frames.push({
        type: 'synthesize-stopped',
        data: {
          session_id: state.sessionId,
        },
      });

      return frames;
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw new TtsServiceError('cancelled', toError(error).message);
      }
      throw new TtsServiceError('unavailable', toError(error).message);
    } finally {
      active.delete(state.key);
    }
  };

  const getOrCreateBufferedState = (
    key: string,
    sessionId: string,
    frameData: WyomingJsonObject | undefined,
  ): BufferedSynthesisState => {
    const incomingMetadata = resolveMetadata(frameData, options.defaultRequest);
    const existing = buffered.get(key);
    if (!existing) {
      const created = createBufferedState(key, sessionId, incomingMetadata);
      buffered.set(key, created);
      return created;
    }

    const merged = mergeMetadata(existing, incomingMetadata);
    existing.request = merged.request;
    existing.language = merged.language;
    existing.model = merged.model;
    existing.channels = merged.channels;
    existing.rate = merged.rate;
    existing.width = merged.width;
    return existing;
  };

  return {
    id: 'tts',
    family: 'tts',
    service: {
      name: 'tts',
      description: 'Streaming TTS adapter',
      version: '1.0.0',
      supports: [...WYOMING_TTS_EVENT_TYPES, 'audio-start', 'audio-chunk', 'audio-stop'],
    },
    eventTypes: WYOMING_TTS_EVENT_TYPES,
    async handle(request): Promise<WyomingFrame | WyomingFrame[]> {
      const sessionId = request.sessionId?.trim();
      if (!sessionId) {
        return createErrorFrame(
          'invalid_request',
          request.frame,
          'TTS events require data.session_id',
        );
      }

      const key = toSessionKey(request.transportSession.connectionId, sessionId);

      try {
        switch (request.frame.type) {
          case 'synthesize-start': {
            getOrCreateBufferedState(key, sessionId, request.frame.data);
            return createAckFrame(request.frame.type, sessionId);
          }
          case 'synthesize-chunk': {
            const state = getOrCreateBufferedState(key, sessionId, request.frame.data);
            const text = extractText(request.frame.data);
            if (!text) {
              throw new TtsServiceError(
                'invalid_request',
                'synthesize-chunk requires non-empty text',
              );
            }

            state.textParts.push(text);
            return createAckFrame(request.frame.type, sessionId);
          }
          case 'synthesize': {
            const existing = buffered.get(key);
            if (existing) {
              const state = getOrCreateBufferedState(key, sessionId, request.frame.data);
              const text = extractText(request.frame.data);
              if (text) {
                state.textParts.push(text);
              }

              const isFinal = readBoolean(request.frame.data, ['is_final', 'isFinal', 'final']) ?? false;
              if (!isFinal) {
                return createAckFrame(request.frame.type, sessionId);
              }

              buffered.delete(key);
              return await synthesize(state);
            }

            const metadata = resolveMetadata(request.frame.data, options.defaultRequest);
            const state = createBufferedState(key, sessionId, metadata);
            const text = extractText(request.frame.data);
            if (!text) {
              throw new TtsServiceError(
                'invalid_request',
                'synthesize requires non-empty text',
              );
            }
            state.textParts.push(text);
            return await synthesize(state);
          }
          case 'synthesize-stop': {
            const state = buffered.get(key);
            if (!state) {
              throw new TtsServiceError(
                'invalid_request',
                'synthesize-stop requires an active synthesize-start session',
              );
            }
            buffered.delete(key);
            return await synthesize(state);
          }
          default:
            return createErrorFrame(
              'invalid_request',
              request.frame,
              `TTS event ${request.frame.type} is not supported`,
              sessionId,
            );
        }
      } catch (error) {
        const normalized = error instanceof TtsServiceError
          ? error
          : new TtsServiceError('unavailable', toError(error).message);

        return createErrorFrame(
          normalized.code,
          request.frame,
          normalized.message,
          sessionId,
        );
      }
    },
    async onSessionClosed(requestContext: WyomingServiceSessionClosedRequest): Promise<void> {
      const key = toSessionKey(requestContext.connectionId, requestContext.sessionId);
      buffered.delete(key);
      await closeActiveSession(key, `tts.session-closed:${requestContext.reason}`);
    },
  };
}
