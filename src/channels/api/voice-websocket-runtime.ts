import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { SubstrateAgent } from '../../agent/substrate-agent.js';
import {
  EligibilityDeniedError,
  type EligibilityGate,
} from '../../system/capabilities/eligibility.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SubstrateConfig, SubstrateMessage } from '../../types.js';
import { createWavFromPcm16le } from '../../voice/audio.js';
import { DeepgramSttClient } from '../../voice/deepgram.js';
import {
  resolveVoiceReliabilityBudgets,
  runWithVoiceStageBudget,
} from '../../voice/policy/reliability.js';
import {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  resolveRuntimeVoiceProviderGate,
} from '../../runtime/bootstrap-helpers.js';
import type { SttStreamConfig, SttStreamSession, SttTranscriptChunk, StreamingSttConnector } from '../../voice/connectors/stt/types.js';
import type { StreamingTtsConnector } from '../../voice/connectors/tts/types.js';
import {
  resolveVoiceSecurityLimits,
  validatePcmAudio,
  validateTranscriptText,
  validateTtsAudioChunk,
  validateTtsInputText,
} from '../../voice/policy/security.js';
import { serializeVoiceWireFrame } from '../../voice/transports/websocket/serializer.js';
import { WebSocketVoiceRuntime } from '../../voice/transports/websocket/runtime.js';
import { WebSocketVoiceServer } from '../../voice/transports/websocket/server.js';
import type {
  WebSocketVoiceConnection,
  WebSocketVoiceServerOptions,
  WebSocketVoiceSession,
} from '../../voice/transports/websocket/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { WebRequestBinaryResult } from '../../gateway/protocol.js';
import type {
  VoiceWebSocketRuntime,
  VoiceWebSocketRuntimeContext,
} from './voice-websocket.js';
import type { ApiAuthPrincipal } from '../http/auth.js';

const log = createComponentLogger('ApiVoiceRuntime');

const DEFAULT_CHANNEL_PREFIX = 'api-voice';

interface ApiVoiceWebSocketRuntimeConfig {
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  config: SubstrateConfig;
  gateway?: GatewayVoiceHttpClient;
  channelPrefix?: string;
  serverOptions?: Partial<WebSocketVoiceServerOptions>;
  eligibilityGate?: EligibilityGate;
}

interface VoiceActor {
  authorId: string;
  authorName: string;
}

interface GatewayVoiceHttpClient {
  webRequestBinary(
    url: string,
    options?: {
      method?: string;
      lane?: 'default' | 'local_crawler' | 'discovery';
      maxBytes?: number;
      headers?: Record<string, string>;
      bodyBase64?: string;
    },
  ): Promise<WebRequestBinaryResult>;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.closed || this.failure) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed || this.failure) {
      return;
    }

    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined as never });
    }
  }

  fail(error: Error): void {
    if (this.closed || this.failure) {
      return;
    }

    this.failure = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift() as T;
      return Promise.resolve({ done: false, value });
    }

    if (this.failure) {
      return Promise.reject(this.failure);
    }

    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined as never });
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function normalizeRequestHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) continue;
    if (/^host$/i.test(normalizedKey) || /^content-length$/i.test(normalizedKey)) {
      continue;
    }
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

async function requestBodyToBase64(request: Request): Promise<string | undefined> {
  if (!request.body) return undefined;
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength === 0) return undefined;
  return bytes.toString('base64');
}

function createGatewayFetchAdapter(gateway: GatewayVoiceHttpClient): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const bodyBase64 = await requestBodyToBase64(request);
    const result = await gateway.webRequestBinary(request.url, {
      method: request.method,
      lane: 'default',
      headers: normalizeRequestHeaders(request.headers),
      ...(bodyBase64 ? { bodyBase64 } : {}),
    });

    const body = Buffer.from(result.dataBase64, 'base64');
    return new Response(body, {
      status: result.status,
      statusText: result.statusText,
      headers: {
        'Content-Type': result.mimeType || 'application/octet-stream',
        'Content-Length': String(result.sizeBytes),
      },
    });
  };
}

class GatewayBufferedDeepgramSttConnector implements StreamingSttConnector {
  readonly id = 'deepgram';

  constructor(
    private readonly client: DeepgramSttClient,
    private readonly maxPcmBytes: number,
  ) {}

  async startStream(config: SttStreamConfig, signal?: AbortSignal): Promise<SttStreamSession> {
    const queue = new AsyncQueue<SttTranscriptChunk>();
    const chunks: Buffer[] = [];
    let ended = false;
    let cancelled = false;

    const fail = (error: unknown) => {
      queue.fail(error instanceof Error ? error : new Error(String(error)));
    };

    if (signal?.aborted) {
      queue.close();
      throw new Error('Deepgram STT stream aborted before opening');
    }

    if (signal) {
      signal.addEventListener('abort', () => {
        cancelled = true;
        queue.close();
      }, { once: true });
    }

    return {
      transcripts: queue,
      writeAudio: async (chunk: Uint8Array): Promise<void> => {
        if (cancelled) throw new Error('Deepgram STT stream cancelled');
        if (ended) throw new Error('Deepgram STT stream already closed');
        if (signal?.aborted) throw new Error('Deepgram STT stream aborted');
        if (chunk.byteLength === 0) return;
        const nextSize = chunks.reduce((sum, value) => sum + value.byteLength, 0) + chunk.byteLength;
        if (nextSize > this.maxPcmBytes) {
          throw new Error(`Deepgram STT buffer exceeds safety limit (${nextSize} > ${this.maxPcmBytes})`);
        }
        chunks.push(Buffer.from(chunk));
      },
      endInput: async (): Promise<void> => {
        if (ended || cancelled) return;
        ended = true;

        try {
          const pcm = Buffer.concat(chunks);
          const wav = createWavFromPcm16le(pcm, config.sampleRateHz, config.channels);
          const transcript = await this.client.transcribeWav(wav);
          if (transcript.trim()) {
            queue.push({
              type: 'final',
              text: transcript.trim(),
            });
          }
        } catch (error) {
          fail(error);
          return;
        } finally {
          queue.close();
        }
      },
      cancel: async (): Promise<void> => {
        cancelled = true;
        queue.close();
      },
    };
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function clampHeader(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function parseRequestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  } catch {
    return null;
  }
}

function readQueryParam(request: IncomingMessage, names: string[]): string | undefined {
  const url = parseRequestUrl(request);
  if (!url) return undefined;

  for (const name of names) {
    const value = clampHeader(url.searchParams.get(name) ?? undefined, 1024);
    if (value) return value;
  }

  return undefined;
}

function readHeaderOrQuery(
  request: IncomingMessage,
  headerName: string,
  queryNames: string[],
  maxLength: number,
): string | undefined {
  const headerValue = clampHeader(singleHeader(request.headers[headerName]), maxLength);
  if (headerValue) return headerValue;
  return clampHeader(readQueryParam(request, queryNames), maxLength);
}

function deriveActor(principal: ApiAuthPrincipal): VoiceActor {
  return {
    authorId: principal.id,
    authorName: principal.mode === 'api_key' ? 'API Voice Principal' : 'Local Voice Principal',
  };
}

function deriveChannelId(
  request: IncomingMessage,
  connectionId: string,
  channelPrefix: string,
  principal: ApiAuthPrincipal,
): string {
  const sessionId = readHeaderOrQuery(
    request,
    'x-session-id',
    ['session_id', 'x_session_id', 'x-session-id'],
    128,
  );
  if (sessionId) {
    return `api:${principal.id}:${sessionId}`;
  }

  return `${channelPrefix}:${principal.id}:${connectionId}`;
}

function resolveGatewayDeepgramListenEndpoint(config: SubstrateConfig): string {
  const listenEndpoint = config.deepgramListenEndpoint?.trim();
  if (listenEndpoint) {
    return listenEndpoint;
  }

  const sttEndpoint = config.deepgramSttEndpoint?.trim();
  if (sttEndpoint) {
    try {
      const parsed = new URL(sttEndpoint);
      if (parsed.protocol === 'wss:') {
        parsed.protocol = 'https:';
      } else if (parsed.protocol === 'ws:') {
        parsed.protocol = 'http:';
      }
      return parsed.toString();
    } catch {
      // Fall through to the configured value below.
    }
    return sttEndpoint;
  }

  return 'https://api.deepgram.com/v1/listen';
}

function toCloseReason(
  reason: 'timeout' | 'client_disconnect' | 'decode_error' | 'shutdown',
): string {
  switch (reason) {
    case 'timeout':
      return 'timeout';
    case 'client_disconnect':
      return 'client-disconnect';
    case 'decode_error':
      return 'decode-error';
    case 'shutdown':
      return 'shutdown';
  }
}

async function runAssistantTurn(params: {
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  request: IncomingMessage;
  principal: ApiAuthPrincipal;
  transportSession: WebSocketVoiceSession;
  sessionId: string;
  transcript: string;
  signal: AbortSignal;
  channelPrefix: string;
}): Promise<string> {
  const {
    agentLoop,
    eventBus,
    request,
    principal,
    transportSession,
    sessionId,
    transcript,
    signal,
    channelPrefix,
  } = params;

  const actor = deriveActor(principal);
  const channelId = deriveChannelId(request, transportSession.connectionId, channelPrefix, principal);
  const turnId = `api-voice-${transportSession.connectionId}-${sessionId}-${Date.now()}`;

  const message: SubstrateMessage = {
    id: `api-voice-msg-${randomUUID()}`,
    channelId,
    channelType: 'api',
    authorId: actor.authorId,
    authorName: actor.authorName,
    content: transcript,
    isDirectMessage: true,
    routing: {
      source: 'api',
      responseStyle: 'concise',
    },
    timestamp: new Date(),
  };

  const maybeAbortable = agentLoop as unknown as { abort?: () => void };
  const onAbort = () => {
    try {
      maybeAbortable.abort?.();
    } catch (error) {
      log.warn('Failed to abort active voice turn', {
        channelId,
        error: String(error),
      });
    }
  };

  signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal.aborted) {
      throw new Error('Voice turn aborted before LLM execution');
    }

    const startedAt = Date.now();
    await eventBus.emit('voice.turn.start', {
      turnId,
      channelId,
      userId: actor.authorId,
      timestampMs: startedAt,
    });
    await eventBus.emit('voice.stt.final', {
      turnId,
      channelId,
      userId: actor.authorId,
      text: transcript,
      timestampMs: startedAt,
    });

    await eventBus.emit('message.received', { message });
    const response = await agentLoop.handleMessage(message);
    await eventBus.emit('message.sent', { response });
    await eventBus.emit('voice.tts.requested', {
      turnId,
      channelId,
      userId: actor.authorId,
      text: response.content,
      timestampMs: Date.now(),
    });
    await eventBus.emit('voice.turn.end', {
      turnId,
      channelId,
      userId: actor.authorId,
      status: 'completed',
      timestampMs: Date.now(),
    });

    return response.content;
  } catch (error) {
    const messageText = toErrorMessage(error);
    await eventBus.emit('voice.turn.error', {
      turnId,
      channelId,
      userId: actor.authorId,
      stage: 'orchestrator',
      error: messageText,
      timestampMs: Date.now(),
    });
    await eventBus.emit('voice.turn.end', {
      turnId,
      channelId,
      userId: actor.authorId,
      status: signal.aborted ? 'cancelled' : 'error',
      reason: messageText,
      timestampMs: Date.now(),
    });
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createApiVoiceWebSocketRuntime(
  options: ApiVoiceWebSocketRuntimeConfig,
): VoiceWebSocketRuntime | undefined {
  const providerGateOptions = {
    allowEchoDefaults: true,
    requireElevenLabsVoiceId: true,
  } satisfies Parameters<typeof resolveRuntimeVoiceProviderGate>[1];
  const providerGate = resolveRuntimeVoiceProviderGate(options.config, providerGateOptions);
  const sttProvider = providerGate.sttProvider;
  const ttsProvider = providerGate.ttsProvider;
  if (!providerGate.sttEnabled || !providerGate.ttsEnabled) {
    log.warn('API voice websocket runtime disabled: missing STT/TTS provider credentials', {
      sttProvider,
      ttsProvider,
      sttEnabled: providerGate.sttEnabled,
      ttsEnabled: providerGate.ttsEnabled,
      hasDeepgramApiKey: Boolean(options.config.deepgramApiKey),
      hasElevenLabsApiKey: Boolean(options.config.elevenLabsApiKey),
      hasElevenLabsVoiceId: Boolean(options.config.elevenLabsVoiceId),
    });
    return undefined;
  }

  const gatewayFetch = options.gateway ? createGatewayFetchAdapter(options.gateway) : undefined;
  const sttListenEndpoint = gatewayFetch
    ? resolveGatewayDeepgramListenEndpoint(options.config)
    : undefined;

  let sttBinding: { connector: StreamingSttConnector } | null = null;
  let ttsBinding: { connector: StreamingTtsConnector } | null = null;
  try {
    if (gatewayFetch && sttProvider === 'deepgram') {
      const sttApiKey = options.config.deepgramApiKey?.trim();
      if (!sttApiKey) {
        throw new Error('Deepgram STT provider selected but DEEPGRAM_API_KEY is not configured');
      }
      sttBinding = {
        connector: new GatewayBufferedDeepgramSttConnector(
          new DeepgramSttClient({
            apiKey: sttApiKey,
            model: options.config.deepgramModel?.trim() ?? '',
            endpoint: sttListenEndpoint ?? resolveGatewayDeepgramListenEndpoint(options.config),
            fetchFn: gatewayFetch,
            allowDirectNetworkEgress: false,
          }),
          resolveVoiceSecurityLimits().maxPcmBytes,
        ),
      };
    } else {
      sttBinding = null;
    }

    ttsBinding = createRuntimeVoiceTtsConnector(options.config, {
      ...providerGateOptions,
      provider: ttsProvider,
      eligibilityGate: options.eligibilityGate,
      ...(gatewayFetch ? { fetchImpl: gatewayFetch } : {}),
    });
  } catch (error) {
    if (!(error instanceof EligibilityDeniedError)) {
      throw error;
    }
    log.warn('API voice websocket runtime disabled by eligibility gate', {
      sttProvider,
      ttsProvider,
      error: error.message,
    });
    return undefined;
  }
  if (!sttBinding && !gatewayFetch) {
    sttBinding = createRuntimeVoiceSttConnector(options.config, {
      ...providerGateOptions,
      provider: sttProvider,
      eligibilityGate: options.eligibilityGate,
    });
  }
  if (!sttBinding || !ttsBinding) {
    throw new Error('API voice websocket runtime resolved enabled providers without connector bindings');
  }

  const channelPrefix = options.channelPrefix ?? DEFAULT_CHANNEL_PREFIX;
  const contexts = new Map<string, VoiceWebSocketRuntimeContext>();
  const connections = new Map<string, WebSocketVoiceConnection>();
  const securityLimits = resolveVoiceSecurityLimits();
  const reliabilityBudgets = resolveVoiceReliabilityBudgets();

  const stt = sttBinding.connector;
  const tts = ttsBinding.connector;

  const runtime = new WebSocketVoiceRuntime({
    stt,
    tts,
    sttConfig: {
      sampleRateHz: 48_000,
      channels: 1,
      encoding: 'pcm_s16le',
      model: options.config.deepgramModel,
      interimResults: true,
    },
    ttsRequest: {
      encoding: 'mp3',
      allowBufferFallback: false,
    },
    security: {
      validatePcmAudio: (pcm) => validatePcmAudio(pcm, securityLimits),
      validateTranscriptText: (text) => validateTranscriptText(text, securityLimits),
      validateTtsInputText: (text) => validateTtsInputText(text, securityLimits),
      validateTtsAudioChunk: (chunk, totalBytesSoFar) => (
        validateTtsAudioChunk(chunk, totalBytesSoFar, securityLimits)
      ),
    },
    reliability: {
      runStage: (stage, task, signal) => runWithVoiceStageBudget({
        stage,
        task,
        signal,
        budgets: reliabilityBudgets,
      }),
    },
    onAssistantTurn: async ({ transportSession, sessionId, transcript, signal }) => {
      const context = contexts.get(transportSession.connectionId);
      if (!context) {
        throw new Error(`Missing websocket request context for ${transportSession.connectionId}`);
      }

      return runAssistantTurn({
        agentLoop: options.agentLoop,
        eventBus: options.eventBus,
        request: context.request,
        principal: context.principal,
        transportSession,
        sessionId,
        transcript,
        signal,
        channelPrefix,
      });
    },
    emitFrame: (session, frame) => {
      const connection = connections.get(session.connectionId);
      if (!connection) return;
      connection.send(serializeVoiceWireFrame(frame));
    },
  });

  const server = new WebSocketVoiceServer(options.serverOptions, {
    onFrame: (session, frame) => runtime.handleFrame(session, frame),
    onSessionClose: async (session, reason) => {
      await runtime.closeConnection(session.connectionId, `transport.${toCloseReason(reason)}`);
      contexts.delete(session.connectionId);
      connections.delete(session.connectionId);
    },
  });

  return {
    attach(connection, context): () => void {
      contexts.set(connection.id, context);
      connections.set(connection.id, connection);
      const detachServer = server.attach(connection);

      return () => {
        detachServer();
        contexts.delete(connection.id);
        connections.delete(connection.id);
        void runtime.closeConnection(connection.id, 'transport.detach');
      };
    },
    async stop(): Promise<void> {
      server.stop();
      await runtime.stop();
      contexts.clear();
      connections.clear();
    },
  };
}
