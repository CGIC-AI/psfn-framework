import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { JSONRPCClient, JSONRPCServer, JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { StreamingSttConnector } from '../../primitives/voice/connectors/stt/types.js';
import type { StreamingTtsConnector } from '../../primitives/voice/connectors/tts/types.js';
import { registerStreamingSttProvider } from '../../primitives/voice/connectors/stt/index.js';
import { registerStreamingTtsProvider } from '../../primitives/voice/connectors/tts/index.js';
import { GatewayClient } from '../../boundary/gateway/client.js';
import type { GatewayRpcConnection, GatewayRpcSerializedTransportStats } from '../../boundary/gateway/transport.js';
import { requestAgentVoiceStream } from '../../boundary/gateway/voice-stream-request.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';

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

import { createApiVoiceWebSocketRuntime } from './voice-websocket-runtime.js';

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
