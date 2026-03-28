import type {
  SttStreamConfig,
  SttStreamSession,
  StreamingSttConnector,
} from '../../../../src/voice/connectors/stt/types.js';
import type {
  WyomingFrame,
  WyomingJsonObject,
} from '../../protocol/index.js';
import type {
  WyomingServiceAdapter,
  WyomingServiceSessionClosedRequest,
} from './contracts.js';

export const WYOMING_ASR_EVENT_TYPES = [
  'transcribe',
  'audio-start',
  'audio-chunk',
  'audio-stop',
  'audio.start',
  'audio.chunk',
  'audio.stop',
] as const;

type AsrErrorCode =
  | 'invalid_request'
  | 'unavailable'
  | 'cancelled';

class AsrServiceError extends Error {
  readonly code: AsrErrorCode;

  constructor(code: AsrErrorCode, message: string) {
    super(message);
    this.name = 'AsrServiceError';
    this.code = code;
  }
}

interface AsrSessionState {
  key: string;
  sessionId: string;
  sttSession: SttStreamSession;
  transcriptPump: Promise<void>;
  transcriptError: Error | null;
  pendingFrames: WyomingFrame[];
  finalTranscriptCount: number;
  lastPartialTranscript: string;
}

export interface WyomingAsrServiceOptions {
  stt: StreamingSttConnector;
  defaultConfig?: Partial<SttStreamConfig>;
}

function toSessionKey(connectionId: string, sessionId: string): string {
  return `${connectionId}:${sessionId}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

function resolveEncoding(
  data: WyomingJsonObject | undefined,
  fallback: SttStreamConfig['encoding'] | undefined,
): SttStreamConfig['encoding'] {
  const value = readString(data, ['encoding', 'format'])?.toLowerCase();
  if (!value) return fallback ?? 'pcm_s16le';
  if (value.includes('opus')) return 'opus';
  return 'pcm_s16le';
}

function resolveSttConfig(
  data: WyomingJsonObject | undefined,
  defaults: Partial<SttStreamConfig> | undefined,
): SttStreamConfig {
  const sampleRateHz = Math.max(
    1,
    Math.floor(
      readNumber(data, ['sample_rate', 'sampleRateHz', 'sampleRate', 'rate'])
      ?? defaults?.sampleRateHz
      ?? 16_000,
    ),
  );
  const channels = Math.max(
    1,
    Math.floor(readNumber(data, ['channels']) ?? defaults?.channels ?? 1),
  );
  const encoding = resolveEncoding(data, defaults?.encoding);
  const language = readString(data, ['language', 'lang']) ?? defaults?.language;
  const model = readString(data, ['name', 'model']) ?? defaults?.model;
  const interimResults = readBoolean(data, ['interim_results', 'interimResults'])
    ?? defaults?.interimResults
    ?? true;

  return {
    sampleRateHz,
    channels,
    encoding,
    language,
    model,
    interimResults,
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
  code: AsrErrorCode,
  frame: WyomingFrame,
  message: string,
  sessionId?: string,
): WyomingFrame {
  return {
    type: 'error',
    data: {
      code,
      event: frame.type,
      service: 'asr',
      message,
      session_id: sessionId ?? null,
    },
  };
}

function canonicalBase64(value: string): string {
  return value.replace(/\s+/g, '').replace(/=+$/g, '');
}

function decodeAudioChunk(frame: WyomingFrame): Uint8Array {
  if (frame.payload && frame.payload.byteLength > 0) {
    return frame.payload;
  }

  const base64 = readString(frame.data, ['audio', 'audio_base64', 'chunk']);
  if (!base64) {
    throw new AsrServiceError('invalid_request', 'ASR audio chunk is missing payload bytes');
  }

  const normalized = canonicalBase64(base64);
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.byteLength === 0 || canonicalBase64(decoded.toString('base64')) !== normalized) {
    throw new AsrServiceError('invalid_request', 'ASR audio chunk contains invalid base64');
  }

  return new Uint8Array(decoded);
}

function drainPendingFrames(state: AsrSessionState): WyomingFrame[] {
  const drained = state.pendingFrames.slice();
  state.pendingFrames.length = 0;
  return drained;
}

export function createWyomingAsrServiceAdapter(
  options: WyomingAsrServiceOptions,
): WyomingServiceAdapter {
  const states = new Map<string, AsrSessionState>();

  const releaseState = (state: AsrSessionState): void => {
    const current = states.get(state.key);
    if (current === state) {
      states.delete(state.key);
    }
  };

  const pumpTranscripts = async (state: AsrSessionState): Promise<void> => {
    try {
      for await (const transcript of state.sttSession.transcripts) {
        const text = transcript.text.trim();
        if (!text) continue;

        const isFinal = transcript.type === 'final';
        if (isFinal) {
          state.finalTranscriptCount += 1;
        } else {
          state.lastPartialTranscript = text;
        }

        state.pendingFrames.push({
          type: 'transcript',
          data: {
            session_id: state.sessionId,
            text,
            is_final: isFinal,
            final: isFinal,
            ...(typeof transcript.confidence === 'number' ? { confidence: transcript.confidence } : {}),
            ...(typeof transcript.startMs === 'number' ? { start_ms: transcript.startMs } : {}),
            ...(typeof transcript.endMs === 'number' ? { end_ms: transcript.endMs } : {}),
          },
        });
      }
    } catch (error) {
      state.transcriptError = toError(error);
    }
  };

  const closeState = async (state: AsrSessionState, reason: string): Promise<void> => {
    releaseState(state);
    await Promise.allSettled([
      state.sttSession.cancel(reason),
      state.transcriptPump,
    ]);
  };

  const startState = async (
    key: string,
    sessionId: string,
    config: SttStreamConfig,
  ): Promise<AsrSessionState> => {
    const existing = states.get(key);
    if (existing) {
      await closeState(existing, 'asr.restart');
    }

    const sttSession = await options.stt.startStream(config);
    const state: AsrSessionState = {
      key,
      sessionId,
      sttSession,
      transcriptPump: Promise.resolve(),
      transcriptError: null,
      pendingFrames: [],
      finalTranscriptCount: 0,
      lastPartialTranscript: '',
    };
    states.set(key, state);
    state.transcriptPump = pumpTranscripts(state);
    return state;
  };

  const requireState = (
    key: string,
    sessionId: string,
  ): AsrSessionState => {
    const state = states.get(key);
    if (!state) {
      throw new AsrServiceError(
        'invalid_request',
        `ASR session ${sessionId} is not active; send transcribe first`,
      );
    }
    return state;
  };

  return {
    id: 'asr',
    family: 'asr',
    service: {
      name: 'asr',
      description: 'Streaming ASR adapter',
      version: '1.0.0',
      supports: [...WYOMING_ASR_EVENT_TYPES, 'transcript'],
    },
    eventTypes: WYOMING_ASR_EVENT_TYPES,
    async handle(request): Promise<WyomingFrame | WyomingFrame[]> {
      const sessionId = request.sessionId?.trim();
      if (!sessionId) {
        return createErrorFrame(
          'invalid_request',
          request.frame,
          'ASR events require data.session_id',
        );
      }

      const key = toSessionKey(request.transportSession.connectionId, sessionId);

      try {
        switch (request.frame.type) {
          case 'transcribe': {
            const config = resolveSttConfig(request.frame.data, options.defaultConfig);
            const state = await startState(key, sessionId, config);
            return [
              createAckFrame(request.frame.type, sessionId),
              ...drainPendingFrames(state),
            ];
          }
          case 'audio-start':
          case 'audio.start': {
            const existing = states.get(key);
            const state = existing ?? await startState(
              key,
              sessionId,
              resolveSttConfig(request.frame.data, options.defaultConfig),
            );
            return [
              createAckFrame(request.frame.type, sessionId),
              ...drainPendingFrames(state),
            ];
          }
          case 'audio-chunk':
          case 'audio.chunk': {
            const existing = states.get(key);
            const state = existing ?? await startState(
              key,
              sessionId,
              resolveSttConfig(request.frame.data, options.defaultConfig),
            );
            const chunk = decodeAudioChunk(request.frame);
            await state.sttSession.writeAudio(chunk);
            return [
              createAckFrame(request.frame.type, sessionId),
              ...drainPendingFrames(state),
            ];
          }
          case 'audio-stop':
          case 'audio.stop': {
            const state = requireState(key, sessionId);
            await state.sttSession.endInput();
            await state.transcriptPump;
            if (state.transcriptError) {
              throw new AsrServiceError(
                'unavailable',
                state.transcriptError.message,
              );
            }

            if (state.finalTranscriptCount === 0 && state.lastPartialTranscript) {
              state.pendingFrames.push({
                type: 'transcript',
                data: {
                  session_id: sessionId,
                  text: state.lastPartialTranscript,
                  is_final: true,
                  final: true,
                },
              });
            }

            const outbound = [
              createAckFrame(request.frame.type, sessionId),
              ...drainPendingFrames(state),
            ];
            await closeState(state, 'asr.stop');
            return outbound;
          }
          default:
            return createErrorFrame(
              'invalid_request',
              request.frame,
              `ASR event ${request.frame.type} is not supported`,
              sessionId,
            );
        }
      } catch (error) {
        const normalized = error instanceof AsrServiceError
          ? error
          : new AsrServiceError('unavailable', toError(error).message);
        return createErrorFrame(
          normalized.code,
          request.frame,
          normalized.message,
          sessionId,
        );
      }
    },
    async onSessionClosed(requestContext: WyomingServiceSessionClosedRequest): Promise<void> {
      const state = states.get(toSessionKey(requestContext.connectionId, requestContext.sessionId));
      if (!state) return;
      await closeState(state, `asr.session-closed:${requestContext.reason}`);
    },
  };
}
