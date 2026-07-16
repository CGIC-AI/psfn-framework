import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { JSONRPCClient, JSONRPCServer, JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { IncomingMessage } from 'node:http';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import { EventBus } from '../../shared/event-bus.js';
import { createTurnId, isTurnId } from '../../core/turns/id.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ApiAuthPrincipal } from '../backplane/http/auth.js';
import type { WebSocketVoiceSession } from '../../primitives/voice/transports/websocket/types.js';
import type { CommittedSegment } from '../../primitives/voice/reply-stream/types.js';
import type { StreamingSttConnector } from '../../primitives/voice/connectors/stt/types.js';
import type { StreamingTtsConnector } from '../../primitives/voice/connectors/tts/types.js';
import { registerStreamingSttProvider } from '../../primitives/voice/connectors/stt/index.js';
import { registerStreamingTtsProvider } from '../../primitives/voice/connectors/tts/index.js';
import { GatewayClient } from '../../boundary/gateway/client.js';
import type { GatewayRpcConnection, GatewayRpcSerializedTransportStats } from '../../boundary/gateway/transport.js';
import { requestAgentVoiceStream } from '../../boundary/gateway/voice-stream-request.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';

const {
  createStreamingSttConnectorMock,
  createStreamingTtsConnectorMock,
} = vi.hoisted(() => ({
  createStreamingSttConnectorMock: vi.fn(),
  createStreamingTtsConnectorMock: vi.fn(),
}));

vi.mock('../../primitives/voice/connectors/stt/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../primitives/voice/connectors/stt/index.js')>();
  return {
    ...actual,
    createStreamingSttConnector: createStreamingSttConnectorMock,
  };
});

vi.mock('../../primitives/voice/connectors/tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../primitives/voice/connectors/tts/index.js')>();
  return {
    ...actual,
    createStreamingTtsConnector: createStreamingTtsConnectorMock,
  };
});

import {
  createApiVoiceWebSocketRuntime,
  requireVoiceReplySegmenterSettings,
  runAgentAssistantStream,
} from './voice-websocket-runtime.js';

// Echo TTS no longer has silent defaults — requires explicit config

function createStubSttConnector(): StreamingSttConnector {
  return {
    id: 'deepgram-test',
    startStream: vi.fn(async () => ({
      transcripts: (async function* emptyTranscripts() {})(),
      writeAudio: async () => {},
      endInput: async () => {},
      cancel: async () => {},
    })),
  };
}

function createStubTtsConnector(): StreamingTtsConnector {
  return {
    id: 'tts-test',
    synthesizeStream: vi.fn(async () => ({
      audio: (async function* emptyAudio() {})(),
      cancel: async () => {},
    })),
    synthesizeBuffer: vi.fn(async () => Buffer.alloc(0)),
  };
}

type RuntimeVoiceTestOverrides = Partial<SubstrateConfig> & {
  sttProvider?: SubstrateConfig['sttProvider'] | 'disabled';
  ttsProvider?: SubstrateConfig['ttsProvider'] | 'disabled';
};

function createTestOptions(configOverrides: RuntimeVoiceTestOverrides = {}) {
  const config = {
    sttProvider: 'deepgram',
    ttsProvider: 'elevenlabs',
    deepgramApiKey: 'deepgram-key',
    deepgramModel: 'nova-3',
    deepgramSttEndpoint: 'wss://api.deepgram.com/v1/listen',
    deepgramListenEndpoint: 'https://api.deepgram.com/v1/listen',
    elevenLabsApiKey: 'elevenlabs-key',
    elevenLabsVoiceId: 'voice-id',
    elevenLabsModelId: 'eleven_turbo_v2_5',
    elevenLabsEndpointBase: 'https://api.elevenlabs.io/v1',
    voiceReplySegmenter: {
      minSegmentLength: 24,
      maxBufferLength: 240,
    },
    ...configOverrides,
  } as SubstrateConfig;

  return {
    agentLoop: {
      handleMessage: vi.fn(),
    } as unknown as SubstrateAgent,
    eventBus: {
      emit: vi.fn(async () => {}),
    } as unknown as EventBus,
    config,
  };
}

describe('createApiVoiceWebSocketRuntime provider wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createStreamingSttConnectorMock.mockReturnValue(createStubSttConnector());
    createStreamingTtsConnectorMock.mockReturnValue(createStubTtsConnector());
  });

  it('requires the settings-owned committed reply segmenter thresholds', () => {
    expect(() => requireVoiceReplySegmenterSettings(createTestOptions({
      voiceReplySegmenter: undefined,
    }).config)).toThrow('settings.json must define voiceReplySegmenter');
  });

  it('returns undefined when Deepgram credentials are missing', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      deepgramApiKey: '',
    }));

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('returns undefined when STT provider is explicitly disabled', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'disabled',
    }));

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('returns undefined when TTS provider is explicitly disabled', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      ttsProvider: 'disabled',
    }));

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('uses deepgram STT when provider is explicitly set to deepgram', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'deepgram',
      ttsProvider: 'elevenlabs',
    }));

    expect(runtime).toBeDefined();
    expect(createStreamingSttConnectorMock).toHaveBeenCalledWith('deepgram', {
      apiKey: 'deepgram-key',
      model: 'nova-3',
      endpoint: 'wss://api.deepgram.com/v1/listen',
    });
  });

  it('returns undefined for elevenlabs provider when ElevenLabs credentials are missing', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      ttsProvider: 'elevenlabs',
      elevenLabsApiKey: '',
      elevenLabsVoiceId: '',
    }));

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('throws when TTS provider selection is unset even if elevenlabs credentials exist', () => {
    expect(() => createApiVoiceWebSocketRuntime(createTestOptions({
      ttsProvider: undefined,
      elevenLabsModelId: 'eleven_turbo_v2_5',
    }))).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('builds runtime when elevenlabs and deepgram providers are explicitly set', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'deepgram',
      ttsProvider: 'elevenlabs',
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
      elevenLabsModelId: 'eleven_turbo_v2_5',
    }));

    expect(runtime).toBeDefined();
    expect(createStreamingSttConnectorMock).toHaveBeenCalledWith('deepgram', {
      apiKey: 'deepgram-key',
      model: 'nova-3',
      endpoint: 'wss://api.deepgram.com/v1/listen',
    });
    expect(createStreamingTtsConnectorMock).toHaveBeenCalledWith('elevenlabs', {
      apiKey: 'elevenlabs-key',
      voiceId: 'voice-id',
      modelId: 'eleven_turbo_v2_5',
      endpointBase: 'https://api.elevenlabs.io/v1',
    });
  });

  it('throws when echo provider selected without explicit Echo config', () => {
    expect(() => createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'deepgram',
      ttsProvider: 'echo',
      elevenLabsApiKey: undefined,
      elevenLabsVoiceId: undefined,
      echoTtsUrl: undefined,
      echoTtsVoice: undefined,
      echoTtsPreset: undefined,
      echoTtsModel: undefined,
    }))).toThrow('Echo TTS provider selected but ECHO_TTS_URL and ECHO_TTS_VOICE are not configured');
  });

  it('passes explicit echo provider overrides through to connector config', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'deepgram',
      ttsProvider: 'echo',
      elevenLabsApiKey: '',
      elevenLabsVoiceId: '',
      echoTtsUrl: 'http://127.0.0.1:5050/v1/audio/speech',
      echoTtsVoice: 'echo-voice-1',
      echoTtsPreset: 'normal',
      echoTtsModel: 'echo-v1',
    }));

    expect(runtime).toBeDefined();
    expect(createStreamingTtsConnectorMock).toHaveBeenCalledWith('echo', {
      url: 'http://127.0.0.1:5050/v1/audio/speech',
      voice: 'echo-voice-1',
      preset: 'normal',
      model: 'echo-v1',
    });
  });

  it('supports registered STT/TTS providers without built-in provider switches', () => {
    const restoreStt = registerStreamingSttProvider('plugin-stt', {
      createConnector: vi.fn(() => createStubSttConnector()),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
        eligibility: {},
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginSttEndpoint),
      }),
    });
    const restoreTts = registerStreamingTtsProvider('plugin-tts', {
      createConnector: vi.fn(() => createStubTtsConnector()),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
        eligibility: {},
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginTtsEndpoint),
      }),
    });

    try {
      const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
        sttProvider: 'plugin-stt',
        ttsProvider: 'plugin-tts',
        pluginSttToken: 'plugin-stt-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
        pluginTtsToken: 'plugin-tts-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
        deepgramApiKey: '',
        elevenLabsApiKey: '',
        elevenLabsVoiceId: '',
      }));

      expect(runtime).toBeDefined();
      expect(createStreamingSttConnectorMock).toHaveBeenCalledWith('plugin-stt', {
        endpoint: 'wss://plugin-stt.invalid',
      });
      expect(createStreamingTtsConnectorMock).toHaveBeenCalledWith('plugin-tts', {
        endpoint: 'https://plugin-tts.invalid',
      });
    } finally {
      restoreTts();
      restoreStt();
    }
  });

  it('fails closed when eligibility denies runtime voice provider activation', () => {
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'nursery',
      getGrantedTokens: () => new Set(),
      has: () => false,
    }));

    const runtime = createApiVoiceWebSocketRuntime({
      ...createTestOptions({
        sttProvider: 'deepgram',
        ttsProvider: 'elevenlabs',
      }),
      eligibilityGate,
    });

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });
});

/**
 * mmo9.6.5 — production-composition barge-in regression.
 *
 * The production WS voice path is api-surface `handleAssistantTurn` ->
 * `gateway.requestAgentVoiceStream(message, { signal })`. This wires the REAL
 * host-side `requestAgentVoiceStream` to a REAL agent-side `GatewayClient` over
 * an in-memory JSON-RPC bridge (mirroring the gateway server's client wiring),
 * so a barge-in that aborts the turn signal DURING model generation is driven
 * end-to-end: abort -> voice.transcript.cancel -> GatewayClient.handleVoiceStreamCancel
 * -> the in-flight dispatch's AbortSignal is aborted (the exact seam
 * SubstrateAgent.cancelTurn trips in production, mmo9.6.1). Pre-fix,
 * `requestAgentVoiceStream` ignored the abort while blocked awaiting
 * voice.transcript.end, so no cancel was sent and the model kept generating.
 */
class BridgeGatewayConnection extends EventEmitter implements GatewayRpcConnection {
  private messageHandler: ((message: unknown) => void) | undefined;
  private destroyedFlag = false;
  toHost: ((data: unknown) => void) | undefined;

  send(data: unknown): boolean {
    this.toHost?.(data);
    return true;
  }

  sendHeartbeat(): boolean {
    return true;
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  deliver(message: unknown): void {
    this.messageHandler?.(message);
  }

  destroy(): void {
    if (this.destroyedFlag) return;
    this.destroyedFlag = true;
    this.emit('close');
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  get serializedTransportStats(): GatewayRpcSerializedTransportStats {
    return { frameCount: 0, serializedBytes: 0, rpcCallCount: 0, byMethod: {} };
  }
}

function okAgentResponse() {
  return {
    content: 'ok',
    channelId: 'api:principal:session',
    metadata: { model: 'voice-model', inputTokens: 1, outputTokens: 1, durationMs: 1 },
  };
}

function createBridgedGateway() {
  const agentConn = new BridgeGatewayConnection();
  const gatewayClient = new GatewayClient(agentConn, 1024);
  const sentMethods: string[] = [];
  const hostClient = new JSONRPCServerAndClient(
    new JSONRPCServer(),
    new JSONRPCClient((request) => {
      const method = (request as { method?: unknown } | null)?.method;
      if (typeof method === 'string') {
        sentMethods.push(method);
      }
      agentConn.deliver(request);
    }),
  );
  agentConn.toHost = (data) => {
    // json-rpc-2.0 receiveAndSend() payload param is typed as `any`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void hostClient.receiveAndSend(data as any);
  };
  return { agentConn, gatewayClient, hostClient, sentMethods };
}

function makeVoiceMessage(id: string): SubstrateMessage {
  return {
    id,
    channelId: 'api:principal:session',
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'API Voice Principal',
    content: 'hello there',
    isDirectMessage: true,
    routing: { source: 'api', responseStyle: 'concise' },
    timestamp: new Date(),
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('requestAgentVoiceStream barge-in cancellation (mmo9.6.5 production composition)', () => {
  it('sends voice.transcript.cancel and cancels the in-flight agent turn when aborted mid-generation', async () => {
    const { gatewayClient, hostClient, sentMethods } = createBridgedGateway();

    const dispatchedSignals: Array<AbortSignal | undefined> = [];
    const dispatchedCancellationIds: Array<string | undefined> = [];
    let turnOneSettled = false;

    gatewayClient.onHandleMessage(async (_message, options) => {
      const index = dispatchedSignals.length;
      dispatchedSignals.push(options?.signal);
      dispatchedCancellationIds.push(options?.cancellationId);

      if (index === 0) {
        // Turn 1 stands in for the model turn: block until the dispatch signal
        // is aborted. In production SubstrateAgent.cancelTurn(cancellationId)
        // aborts exactly this signal (mmo9.6.1); here GatewayClient's
        // handleVoiceStreamCancel aborts it — the same seam.
        try {
          await new Promise<void>((_resolve, reject) => {
            const sig = options?.signal;
            if (!sig) {
              reject(new Error('agent dispatch received no cancellation signal'));
              return;
            }
            if (sig.aborted) {
              reject(new Error('aborted'));
              return;
            }
            sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        } finally {
          turnOneSettled = true;
        }
      }

      return okAgentResponse();
    });

    const controller = new AbortController();
    let counter = 0;
    const turnPromise = requestAgentVoiceStream({
      client: hostClient,
      message: makeVoiceMessage('api-voice-msg-1'),
      options: { signal: controller.signal, timeoutMs: 500 },
      wyomingShardRouting: { enabled: false },
      companionId: createCompanionId('companion'),
      nextRequestCounter: () => (counter += 1),
    });
    // Prevent an unhandled rejection race before we assert on it below.
    const turnOutcome = turnPromise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // The agent turn is dispatched (model "generating") and NOT yet aborted.
    await waitFor(() => dispatchedSignals.length === 1, 'agent turn dispatched');
    expect(dispatchedSignals[0]?.aborted).toBe(false);
    expect(sentMethods).not.toContain('voice.transcript.cancel');
    // The turn carries a cancellation identity, so it is addressable by cancelTurn.
    expect(typeof dispatchedCancellationIds[0]).toBe('string');
    expect(dispatchedCancellationIds[0]).toBeTruthy();

    // Barge-in: abort the turn signal WHILE the model is generating (pre-fix this
    // was ignored — the request stayed blocked on voice.transcript.end).
    controller.abort();

    const outcome = await turnOutcome;
    expect(outcome.ok).toBe(false);
    expect(String((outcome as { error: unknown }).error)).toMatch(/abort/i);

    // The caller sent the cancel frame, and it propagated to cancel the agent turn.
    await waitFor(() => sentMethods.includes('voice.transcript.cancel'), 'voice.transcript.cancel sent');
    await waitFor(() => dispatchedSignals[0]?.aborted === true, 'agent dispatch signal aborted');
    await waitFor(() => turnOneSettled, 'in-flight agent turn torn down');

    // A follow-up voice turn is NOT queued behind a still-active turn 1: turn 1
    // has been cancelled/torn down, so the next turn dispatches and completes.
    const followUp = await requestAgentVoiceStream({
      client: hostClient,
      message: makeVoiceMessage('api-voice-msg-2'),
      options: { timeoutMs: 500 },
      wyomingShardRouting: { enabled: false },
      companionId: createCompanionId('companion'),
      nextRequestCounter: () => (counter += 1),
    });
    expect(followUp.content).toBe('ok');
    expect(dispatchedSignals.length).toBe(2);
    expect(dispatchedSignals[1]?.aborted).toBe(false);

    gatewayClient.destroy();
  });
});

/**
 * mmo9.8.3 — streamed voice first-audio / turn-channel isolation regression.
 *
 * The live streamed path bridges `agent.stream.delta` into spoken segments. The
 * bridge filters deltas by channelId AND turnId. Pre-fix, the transport handed
 * the bridge a FABRICATED `api-voice-<conn>-<sess>-<ts>` turnId while the agent
 * stamped an independently-generated UUIDv7 on every real delta — the two ids
 * could never be equal, so 100% of real deltas were dropped and the streamed
 * path emitted ZERO audio. The prior tests missed it because their fake delta
 * sources emitted deltas with NO turnId, so the fatal branch never ran.
 *
 * The fix threads a REAL UUIDv7 the transport mints through `routing.turnId`, so
 * `executeTurn` stamps THAT id on the deltas and the bridge's options.turnId
 * matches. This drives `runAgentAssistantStream` with a fake agent that models
 * the real one (stamps `routing.turnId` on its deltas) under the exact shared
 * x-session-id channelId the reviewer flagged for cross-talk, and asserts real
 * deltas are spoken while a concurrent turn's / other channel's are not.
 */
describe('runAgentAssistantStream real-turn delta wiring (mmo9.8.3 first-audio regression)', () => {
  function makeStreamPrincipal(): ApiAuthPrincipal {
    return { id: 'principal-1', mode: 'api_key' };
  }

  function makeStreamRequest(headers: Record<string, string>): IncomingMessage {
    return { headers, url: '/voice' } as unknown as IncomingMessage;
  }

  function makeStreamSession(connectionId: string): WebSocketVoiceSession {
    return { id: `sess-${connectionId}`, connectionId, openedAtMs: 0, lastSeenAtMs: 0 };
  }

  async function drainSegments(
    stream: { segments: AsyncIterable<CommittedSegment> },
  ): Promise<string[]> {
    const out: string[] = [];
    for await (const seg of stream.segments) out.push(seg.text);
    return out;
  }

  it('speaks real agent deltas stamped with the routing-threaded UUIDv7, and isolates a concurrent turn on the same shared-session channel', async () => {
    const eventBus = new EventBus();
    const principal = makeStreamPrincipal();
    // x-session-id present → channelId collapses to `api:<principal>:<session>`,
    // the exact shared-session case the reviewer flagged for cross-talk. Isolation
    // must still hold, purely by the globally-unique per-turn UUIDv7.
    const request = makeStreamRequest({ 'x-session-id': 'shared-session' });
    const transportSession = makeStreamSession('conn-A');

    // A different concurrent connection's turn on the SAME collapsed channelId.
    const concurrentTurnId = createTurnId();
    let observedRoutingTurnId: string | undefined;

    const handleMessage = vi.fn(async (message: SubstrateMessage): Promise<AgentResponse> => {
      observedRoutingTurnId = message.routing?.turnId;
      // Model the REAL agent: executeTurn stamps `routing.turnId` (mmo9.8.3) on
      // every delta; absent a supplied id it mints its own UUIDv7. Deriving the
      // stamped id independently of any fabricated transport id is what makes
      // this test red on the pre-fix code.
      const stamped = message.routing?.turnId ?? createTurnId();

      // Decoy 1 — a concurrent turn's delta on the SAME (shared) channelId: must
      // NOT leak into this stream.
      await eventBus.emit('agent.stream.delta', {
        channelId: message.channelId,
        text: 'A different caller entirely. ',
        turnId: concurrentTurnId,
      });
      // Decoy 2 — a delta on a DIFFERENT channel: must NOT be spoken.
      await eventBus.emit('agent.stream.delta', {
        channelId: 'api:principal-1:some-other-session',
        text: 'Wrong channel noise. ',
        turnId: stamped,
      });
      // Real deltas for THIS turn.
      await eventBus.emit('agent.stream.delta', {
        channelId: message.channelId,
        text: 'Hello there. ',
        turnId: stamped,
      });
      await eventBus.emit('agent.stream.delta', {
        channelId: message.channelId,
        text: 'How can I help? ',
        turnId: stamped,
      });

      return {
        content: 'Hello there. How can I help?',
        channelId: message.channelId,
        metadata: { model: 'voice-model', inputTokens: 1, outputTokens: 1, durationMs: 1 },
      } as AgentResponse;
    });

    const agentLoop = { handleMessage } as unknown as SubstrateAgent;

    const stream = runAgentAssistantStream({
      agentLoop,
      eventBus,
      request,
      principal,
      transportSession,
      sessionId: 'shared-session',
      transcript: 'hi',
      signal: new AbortController().signal,
      channelPrefix: 'api-voice',
      segmenter: {
        minSegmentLength: 24,
        maxBufferLength: 240,
      },
    });

    const spoken = await drainSegments(stream);
    const heard = spoken.join('');

    // The transport threaded a REAL UUIDv7 to the agent — not the pre-fix
    // fabricated `api-voice-...` id.
    expect(observedRoutingTurnId).toBeDefined();
    expect(isTurnId(observedRoutingTurnId as string)).toBe(true);
    expect(observedRoutingTurnId).not.toMatch(/^api-voice-/);
    // Real deltas are spoken (pre-fix: nothing was spoken).
    expect(heard).toContain('Hello there.');
    expect(heard).toContain('How can I help?');
    // Cross-isolation: neither the concurrent same-channel turn nor the other
    // channel's text leaks into this voice stream.
    expect(heard).not.toContain('A different caller');
    expect(heard).not.toContain('Wrong channel');
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});
