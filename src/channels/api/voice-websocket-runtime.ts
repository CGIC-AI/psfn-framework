import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AgentLoop } from '../../agent-loop.js';
import type { EventBus } from '../../event-bus.js';
import { createComponentLogger } from '../../logger.js';
import type { SubstrateConfig, SubstrateMessage } from '../../types.js';
import { createStreamingSttConnector } from '../../voice/connectors/stt/index.js';
import { createStreamingTtsConnector } from '../../voice/connectors/tts/index.js';
import {
  resolveVoiceReliabilityBudgets,
  runWithVoiceStageBudget,
} from '../../voice/policy/reliability.js';
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
import type {
  VoiceWebSocketRuntime,
  VoiceWebSocketRuntimeContext,
} from './voice-websocket.js';

const log = createComponentLogger('ApiVoiceRuntime');

const DEFAULT_CHANNEL_PREFIX = 'api-voice';

interface ApiVoiceWebSocketRuntimeConfig {
  agentLoop: AgentLoop;
  eventBus: EventBus;
  config: SubstrateConfig;
  channelPrefix?: string;
  serverOptions?: Partial<WebSocketVoiceServerOptions>;
}

interface VoiceActor {
  authorId: string;
  authorName: string;
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

function deriveActor(request: IncomingMessage): VoiceActor {
  const rawUserId = singleHeader(request.headers['x-user-id']);
  const rawUserName = singleHeader(request.headers['x-user-name']);

  const authorId = clampHeader(rawUserId, 128) ?? 'api-voice-user';
  const authorName = clampHeader(rawUserName, 80) ?? 'Voice User';
  return { authorId, authorName };
}

function deriveChannelId(
  request: IncomingMessage,
  connectionId: string,
  channelPrefix: string,
): string {
  const sessionId = clampHeader(singleHeader(request.headers['x-session-id']), 128);
  if (sessionId) {
    return `api:${sessionId}`;
  }

  return `${channelPrefix}:${connectionId}`;
}

function hasVoiceConnectorConfig(config: SubstrateConfig): boolean {
  return Boolean(
    config.deepgramApiKey
      && config.elevenLabsApiKey
      && config.elevenLabsVoiceId,
  );
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
  agentLoop: AgentLoop;
  eventBus: EventBus;
  request: IncomingMessage;
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
    transportSession,
    sessionId,
    transcript,
    signal,
    channelPrefix,
  } = params;

  const actor = deriveActor(request);
  const channelId = deriveChannelId(request, transportSession.connectionId, channelPrefix);
  const turnId = `api-voice-${transportSession.connectionId}-${sessionId}-${Date.now()}`;

  const message: SubstrateMessage = {
    id: `api-voice-msg-${randomUUID()}`,
    channelId,
    channelType: 'api',
    authorId: actor.authorId,
    authorName: actor.authorName,
    content: transcript,
    isDirectMessage: true,
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
    const messageText = error instanceof Error ? error.message : String(error);
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
  if (!hasVoiceConnectorConfig(options.config)) {
    log.warn('API voice websocket runtime disabled: missing STT/TTS provider credentials');
    return undefined;
  }

  const channelPrefix = options.channelPrefix ?? DEFAULT_CHANNEL_PREFIX;
  const contexts = new Map<string, VoiceWebSocketRuntimeContext>();
  const connections = new Map<string, WebSocketVoiceConnection>();
  const securityLimits = resolveVoiceSecurityLimits();
  const reliabilityBudgets = resolveVoiceReliabilityBudgets();

  const stt = createStreamingSttConnector('deepgram', {
    apiKey: options.config.deepgramApiKey ?? '',
    model: options.config.deepgramModel,
  });

  const tts = createStreamingTtsConnector('elevenlabs', {
    apiKey: options.config.elevenLabsApiKey ?? '',
    voiceId: options.config.elevenLabsVoiceId ?? '',
    modelId: options.config.elevenLabsModelId,
  });

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
