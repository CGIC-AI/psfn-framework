import { createComponentLogger } from '../../../../shared/logger.js';
import type {
  SttStreamConfig,
  SttStreamSession,
  SttTranscriptChunk,
  StreamingSttConnector,
} from './types.js';

const log = createComponentLogger('DeepgramStreamingSttConnector');

const DEFAULT_DEEPGRAM_ENDPOINT = 'wss://api.deepgram.com/v1/listen';
const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_FINALIZE_TIMEOUT_MS = 2_000;
const DEFAULT_TRANSCRIPT_QUEUE_MAX_ENTRIES = 128;
const DEFAULT_TRANSCRIPT_QUEUE_OVERFLOW_POLICY = 'drop_oldest' as const;

interface DeepgramWord {
  start?: number;
  end?: number;
}

interface DeepgramAlternative {
  transcript?: string;
  confidence?: number;
  words?: DeepgramWord[];
}

interface DeepgramResultMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: DeepgramAlternative[];
  };
}

type SocketEventName = 'open' | 'message' | 'error' | 'close';

type SocketEventHandler = (event: unknown) => void;

export interface WebSocketLike {
  readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: SocketEventName, listener: SocketEventHandler): void;
}

export interface DeepgramWebSocketFactory {
  (url: string, protocols: string[]): WebSocketLike;
}

type TranscriptQueueOverflowPolicy = 'drop_oldest' | 'drop_newest' | 'fail';

export interface DeepgramStreamingSttConfig {
  apiKey: string;
  model?: string;
  endpoint?: string;
  openTimeoutMs?: number;
  finalizeTimeoutMs?: number;
  transcriptQueueMaxEntries?: number;
  transcriptQueueOverflowPolicy?: TranscriptQueueOverflowPolicy;
  webSocketFactory?: DeepgramWebSocketFactory;
}

interface SocketMessageEvent {
  data?: unknown;
}

interface SocketCloseEvent {
  code?: number;
  reason?: string;
}

interface TranscriptQueueMetrics {
  enqueued: number;
  dequeued: number;
  dropped: number;
  highWatermark: number;
}

class TranscriptQueue implements AsyncIterable<SttTranscriptChunk> {
  private readonly values: SttTranscriptChunk[] = [];
  private readonly maxEntries: number;
  private readonly overflowPolicy: TranscriptQueueOverflowPolicy;
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<SttTranscriptChunk>) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly metrics: TranscriptQueueMetrics = {
    enqueued: 0,
    dequeued: 0,
    dropped: 0,
    highWatermark: 0,
  };
  private closed = false;
  private error: Error | null = null;

  constructor(
    maxEntries: number,
    overflowPolicy: TranscriptQueueOverflowPolicy,
  ) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    this.overflowPolicy = overflowPolicy;
  }

  push(value: SttTranscriptChunk): void {
    if (this.closed || this.error) return;

    const waiter = this.waiters.shift();
    if (waiter) {
      this.metrics.enqueued += 1;
      this.metrics.dequeued += 1;
      waiter.resolve({ value, done: false });
      return;
    }

    if (this.values.length >= this.maxEntries) {
      this.metrics.dropped += 1;

      if (this.overflowPolicy === 'fail') {
        this.fail(new Error(`Deepgram transcript queue overflow (${this.maxEntries})`));
        return;
      }

      if (this.overflowPolicy === 'drop_newest') {
        return;
      }

      this.values.shift();
    }

    this.values.push(value);
    this.metrics.enqueued += 1;
    this.metrics.highWatermark = Math.max(this.metrics.highWatermark, this.values.length);
  }

  close(): void {
    if (this.closed || this.error) return;
    this.closed = true;

    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.closed || this.error) return;
    this.error = error;

    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  snapshot(): TranscriptQueueMetrics {
    return {
      ...this.metrics,
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<SttTranscriptChunk> {
    return {
      next: async (): Promise<IteratorResult<SttTranscriptChunk>> => {
        if (this.values.length > 0) {
          this.metrics.dequeued += 1;
          return {
            value: this.values.shift()!,
            done: false,
          };
        }

        if (this.error) {
          throw this.error;
        }

        if (this.closed) {
          return {
            value: undefined,
            done: true,
          };
        }

        return new Promise<IteratorResult<SttTranscriptChunk>>((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function secondsToMilliseconds(value?: number): number | undefined {
  if (value === undefined) return undefined;
  return Math.round(value * 1000);
}

function mapEncodingToDeepgram(encoding: SttStreamConfig['encoding']): string {
  switch (encoding) {
    case 'opus':
      return 'opus';
    case 'pcm_s16le':
    default:
      return 'linear16';
  }
}

function parseMessagePayload(data: unknown): DeepgramResultMessage | null {
  let text: string | null = null;

  if (typeof data === 'string') {
    text = data;
  } else if (data instanceof ArrayBuffer) {
    text = Buffer.from(data).toString('utf8');
  } else if (ArrayBuffer.isView(data)) {
    text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }

  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as DeepgramResultMessage;
  } catch {
    return null;
  }
}

function mapDeepgramMessage(message: DeepgramResultMessage): SttTranscriptChunk | null {
  if (message.type && message.type !== 'Results') return null;

  const alternative = message.channel?.alternatives?.[0];
  const text = alternative?.transcript?.trim() ?? '';
  if (!text) return null;

  const confidence = asFiniteNumber(alternative?.confidence);
  const words = alternative?.words ?? [];

  let startMs: number | undefined;
  let endMs: number | undefined;

  if (words.length > 0) {
    startMs = secondsToMilliseconds(asFiniteNumber(words[0]?.start));
    endMs = secondsToMilliseconds(asFiniteNumber(words[words.length - 1]?.end));
  }

  if (startMs === undefined) {
    startMs = secondsToMilliseconds(asFiniteNumber(message.start));
  }

  if (endMs === undefined) {
    const startSeconds = asFiniteNumber(message.start);
    const durationSeconds = asFiniteNumber(message.duration);

    if (startSeconds !== undefined && durationSeconds !== undefined) {
      endMs = secondsToMilliseconds(startSeconds + durationSeconds);
    }
  }

  return {
    type: message.is_final || message.speech_final ? 'final' : 'partial',
    text,
    confidence,
    startMs,
    endMs,
  };
}

function defaultWebSocketFactory(url: string, protocols: string[]): WebSocketLike {
  const WebSocketCtor = (globalThis as unknown as {
    WebSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike;
  }).WebSocket;

  if (!WebSocketCtor) {
    throw new Error('Deepgram STT streaming requires a WebSocket implementation in global scope');
  }

  return new WebSocketCtor(url, protocols);
}

export class DeepgramStreamingSttConnector implements StreamingSttConnector {
  readonly id = 'deepgram';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly openTimeoutMs: number;
  private readonly finalizeTimeoutMs: number;
  private readonly transcriptQueueMaxEntries: number;
  private readonly transcriptQueueOverflowPolicy: TranscriptQueueOverflowPolicy;
  private readonly webSocketFactory: DeepgramWebSocketFactory;

  constructor(config: DeepgramStreamingSttConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_DEEPGRAM_MODEL;
    this.endpoint = config.endpoint ?? DEFAULT_DEEPGRAM_ENDPOINT;
    this.openTimeoutMs = config.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.finalizeTimeoutMs = config.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS;
    this.transcriptQueueMaxEntries = Math.max(
      1,
      Math.floor(config.transcriptQueueMaxEntries ?? DEFAULT_TRANSCRIPT_QUEUE_MAX_ENTRIES),
    );
    this.transcriptQueueOverflowPolicy = config.transcriptQueueOverflowPolicy ?? DEFAULT_TRANSCRIPT_QUEUE_OVERFLOW_POLICY;
    this.webSocketFactory = config.webSocketFactory ?? defaultWebSocketFactory;
  }

  async startStream(config: SttStreamConfig, signal?: AbortSignal): Promise<SttStreamSession> {
    const queue = new TranscriptQueue(
      this.transcriptQueueMaxEntries,
      this.transcriptQueueOverflowPolicy,
    );
    const socket = this.openSocket(config);

    let closed = false;
    let ended = false;
    let cancelled = false;
    let lastLoggedDropped = 0;
    const maybeLogQueueMetrics = (reason: string) => {
      const metrics = queue.snapshot();
      if (metrics.dropped <= lastLoggedDropped) {
        return;
      }

      lastLoggedDropped = metrics.dropped;
      log.warn('Deepgram transcript queue overflow policy applied', {
        reason,
        policy: this.transcriptQueueOverflowPolicy,
        maxEntries: this.transcriptQueueMaxEntries,
        dropped: metrics.dropped,
        highWatermark: metrics.highWatermark,
      });
    };

    const fail = (reason: unknown) => {
      const error = toError(reason);
      queue.fail(error);
    };

    socket.addEventListener('message', (event) => {
      const payload = parseMessagePayload((event as SocketMessageEvent).data);
      if (!payload) return;

      const chunk = mapDeepgramMessage(payload);
      if (!chunk) return;

      queue.push(chunk);
      maybeLogQueueMetrics('push');
    });

    socket.addEventListener('error', () => {
      if (cancelled || closed) return;
      fail(new Error('Deepgram STT socket error'));
    });

    socket.addEventListener('close', (event) => {
      const details = event as SocketCloseEvent;
      closed = true;
      maybeLogQueueMetrics(`close:${details.code ?? 'unknown'}`);

      if (cancelled || ended || details.code === 1000) {
        queue.close();
        return;
      }

      fail(new Error(`Deepgram STT socket closed unexpectedly (${details.code ?? 'unknown'}) ${details.reason ?? ''}`.trim()));
    });

    await this.waitForOpen(socket, signal);

    const cancel = async (reason?: string): Promise<void> => {
      if (cancelled) return;
      cancelled = true;
      ended = true;
      maybeLogQueueMetrics('cancel');
      queue.close();

      try {
        socket.close(1000, reason?.slice(0, 120) ?? 'cancelled');
      } catch {
        // Ignore close errors.
      }
    };

    if (signal) {
      if (signal.aborted) {
        await cancel('aborted');
      } else {
        signal.addEventListener('abort', () => {
          cancel('aborted').catch(() => undefined);
        }, { once: true });
      }
    }

    return {
      transcripts: queue,
      writeAudio: async (chunk: Uint8Array): Promise<void> => {
        if (signal?.aborted) throw new Error('Deepgram STT stream aborted');
        if (cancelled) throw new Error('Deepgram STT stream cancelled');
        if (closed) throw new Error('Deepgram STT stream already closed');
        if (chunk.byteLength === 0) return;

        socket.send(chunk);
      },
      endInput: async (): Promise<void> => {
        if (ended || cancelled || closed) return;
        ended = true;

        try {
          socket.send(JSON.stringify({ type: 'Finalize' }));
        } catch {
          // Ignore finalize send errors and rely on close handling.
        }

        const timer = setTimeout(() => {
          if (closed || cancelled) return;
          try {
            socket.close(1000, 'input-ended');
          } catch {
            // Ignore close errors.
          }
        }, this.finalizeTimeoutMs);

        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      },
      cancel,
    };
  }

  private openSocket(config: SttStreamConfig): WebSocketLike {
    const url = new URL(this.endpoint);
    url.searchParams.set('model', config.model ?? this.model);
    url.searchParams.set('encoding', mapEncodingToDeepgram(config.encoding));
    url.searchParams.set('sample_rate', String(config.sampleRateHz));
    url.searchParams.set('channels', String(config.channels));
    url.searchParams.set('interim_results', String(config.interimResults ?? true));
    url.searchParams.set('punctuate', 'true');
    url.searchParams.set('smart_format', 'true');

    if (config.language) {
      url.searchParams.set('language', config.language);
    }

    return this.webSocketFactory(url.toString(), ['token', this.apiKey]);
  }

  private async waitForOpen(socket: WebSocketLike, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Deepgram STT stream aborted before opening'));
        return;
      }

      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Deepgram STT stream open timeout (${this.openTimeoutMs}ms)`));
      }, this.openTimeoutMs);
      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }

      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Deepgram STT socket failed before open'));
      };

      const onClose = (event: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        const closeEvent = event as SocketCloseEvent;
        reject(new Error(`Deepgram STT socket closed before open (${closeEvent.code ?? 'unknown'})`));
      };

      const removeOpen = this.attachRemovableListener(socket, 'open', onOpen);
      const removeError = this.attachRemovableListener(socket, 'error', onError);
      const removeClose = this.attachRemovableListener(socket, 'close', onClose);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.close(1000, 'aborted-before-open');
        } catch {
          // Ignore close errors.
        }
        reject(new Error('Deepgram STT stream aborted before opening'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        removeOpen();
        removeError();
        removeClose();
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private attachRemovableListener(
    socket: WebSocketLike,
    type: SocketEventName,
    listener: SocketEventHandler,
  ): () => void {
    socket.addEventListener(type, listener);

    const removableSocket = socket as WebSocketLike & {
      removeEventListener?: (eventName: SocketEventName, eventListener: SocketEventHandler) => void;
    };

    if (typeof removableSocket.removeEventListener === 'function') {
      return () => {
        removableSocket.removeEventListener?.(type, listener);
      };
    }

    return () => undefined;
  }
}

export function createDeepgramStreamingSttConnector(config: DeepgramStreamingSttConfig): DeepgramStreamingSttConnector {
  return new DeepgramStreamingSttConnector(config);
}
