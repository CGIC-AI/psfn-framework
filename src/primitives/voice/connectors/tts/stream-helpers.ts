import { abortError } from '../../../../shared/utils/errors.js';
import type {
  TtsAudioChunk,
  TtsAudioEncoding,
  TtsSynthesisSession,
} from './types.js';

export async function responseError(prefix: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');
  return new Error(`${prefix}: ${response.status} ${response.statusText} ${body.slice(0, 300)}`);
}

export function singleChunkSession(
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

export async function* responseBodyToAudioChunks(
  body: ReadableStream<Uint8Array>,
  encoding: TtsAudioEncoding,
  source: TtsAudioChunk['source'],
  signal: AbortSignal | undefined,
  abortMessage: string,
  normalizeReadError?: (error: unknown) => Error,
): AsyncGenerator<TtsAudioChunk> {
  const reader = body.getReader();
  let sequence = 0;
  let pending: Uint8Array | null = null;

  try {
    for (;;) {
      if (signal?.aborted) {
        throw abortError(abortMessage);
      }

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw normalizeReadError?.(error) ?? error;
      }
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) continue;

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

      pending = chunk.value;
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
