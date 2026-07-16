import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { AgentApiBackend } from './agent-backend.js';
import { parseSatelliteRegistryConfig } from '../backplane/satellite-registry.js';
import { deriveApiKeyPrincipalId } from '../backplane/http/auth.js';

function createSessionManagerStub() {
  return {
    getMessageCount: vi.fn(() => 0),
    recordUserMessage: vi.fn(),
    recordAssistantMessage: vi.fn(),
  } as any;
}

describe('AgentApiBackend health RPC', () => {
  it('returns the health body directly instead of an HTTP response envelope', async () => {
    const backend = new AgentApiBackend({
      agentLoop: { handleMessage: vi.fn(), abort: vi.fn() } as any,
      eventBus: new EventBus(),
      sessionManager: createSessionManagerStub(),
      healthChecks: {
        memory: () => ({ status: 'healthy' }),
        llm: () => ({ status: 'healthy' }),
        discord: () => ({ status: 'healthy' }),
        embeddings: () => ({ status: 'healthy' }),
        scheduler: () => ({ status: 'healthy' }),
      },
    });

    const health = await backend.handleHealth();

    expect(health).toMatchObject({
      status: 'healthy',
      subsystems: {
        memory: { status: 'healthy' },
        llm: { status: 'healthy' },
        discord: { status: 'healthy' },
        embeddings: { status: 'healthy' },
        scheduler: { status: 'healthy' },
      },
    });
    expect(health).not.toHaveProperty('statusCode');
    expect(health).not.toHaveProperty('body');
  });
});

describe('AgentApiBackend Hub device principal boundary', () => {
  it('authors the turn as a device with no human contact and revalidates registry/session/companion bindings', async () => {
    const token = 'hub-satellite-secret-key';
    const companionId = '11111111-1111-4111-8111-111111111111';
    const sessionManager = createSessionManagerStub();
    const handleMessage = vi.fn(async (message) => ({
      content: 'device reply', channelId: message.channelId,
      metadata: { inputTokens: 1, outputTokens: 1 },
    }));
    const backend = new AgentApiBackend({
      agentLoop: { handleMessage, abort: vi.fn() } as any,
      eventBus: new EventBus(), sessionManager,
      companionId,
      satelliteRegistry: parseSatelliteRegistryConfig({
        schemaVersion: 1, enabled: true,
        satellites: [{
          satelliteId: 'office', displayName: 'Office', mobility: 'static', placeId: 'office',
          endpoints: [{
            endpointId: 'office-device', displayName: 'Office Device',
            claimTypes: ['hub-device'], promptChannelType: 'satellite_hub',
            auth: { mode: 'api_key', apiKeyPrincipalIds: [deriveApiKeyPrincipalId(token)] },
            defaultIdentity: {
              authorId: 'legacy-human', authorName: 'Legacy Human',
              canonicalContactId: 'contact-legacy-human', channelPrivacy: 'private',
            },
            maxCapabilities: ['text'],
            hubDeviceEnrollment: {
              deviceId: 'office-device', enrollmentVersion: 7, enrollmentStatus: 'active',
            },
          }],
        }],
      }),
    });
    const principal = { id: deriveApiKeyPrincipalId(token), mode: 'api_key' as const, scope: 'satellite' as const };
    const hubDevicePrincipal = {
      kind: 'hub_device' as const, issuer: 'psfn-satellite-hub', keyId: 'hub-key',
      deviceId: 'office-device', enrollmentVersion: 7,
      enrollmentAssurance: 'device_credential' as const, placeId: 'office',
      audience: 'https://fleet.example.test', companionId,
      sessionId: 'realtime:office-device:session',
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
      jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    };
    const hubDeviceAttachment = {
      attachmentId: '018f0f10-79b2-4cc7-8c99-0242ac120003',
      disposition: 'guest_created' as const,
      deviceActor: {
        kind: 'hub_device' as const,
        principal: hubDevicePrincipal,
        connectionId: 'authenticated-connection',
      },
      actor: { kind: 'guest' as const, companionId },
      channel: {
        source: 'server' as const,
        id: `hub-device:${'a'.repeat(64)}`,
        companionId,
      },
    };
    const result = await backend.handleChatCompletion({
      requestId: 'hub-device-request',
      request: { model: 'companion', messages: [{ role: 'user', content: 'hello' }] },
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'hub-device',
        'x-psfn-satellite-id': 'office',
        'x-psfn-satellite-endpoint-id': 'office-device',
        'x-psfn-satellite-session-id': 'realtime:office-device:session',
      },
      hubDevicePrincipal,
      hubDeviceAttachment,
    });

    expect(result).toMatchObject({ ok: true });
    expect(handleMessage).toHaveBeenCalledOnce();
    expect(handleMessage.mock.calls[0]?.[0]).toMatchObject({
      channelId: `hub-device:${'a'.repeat(64)}`,
      authorId: 'hub-device-guest:office-device',
      authorName: 'Hub device guest',
      routing: { satellite: { hubDevicePrincipal } },
    });
    expect(handleMessage.mock.calls[0]?.[0].routing).not.toHaveProperty('canonicalContactId');
    await expect(backend.handleChatCompletion({
      requestId: 'hub-device-wrong-companion',
      request: { model: 'companion', messages: [{ role: 'user', content: 'hello' }] },
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'hub-device',
        'x-psfn-satellite-id': 'office',
        'x-psfn-satellite-endpoint-id': 'office-device',
        'x-psfn-satellite-session-id': 'realtime:office-device:session',
      },
      hubDevicePrincipal: { ...hubDevicePrincipal, companionId: '22222222-2222-4222-8222-222222222222' },
      hubDeviceAttachment,
    })).resolves.toMatchObject({ ok: false, error: { type: 'hub_device_principal_mismatch' } });

    await expect(backend.handleChatCompletion({
      requestId: 'hub-device-human-smuggling',
      request: { model: 'companion', messages: [{ role: 'user', content: 'hello' }] },
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'hub-device',
        'x-psfn-satellite-id': 'office',
        'x-psfn-satellite-endpoint-id': 'office-device',
        'x-psfn-satellite-session-id': 'realtime:office-device:session',
      },
      hubDevicePrincipal: { ...hubDevicePrincipal, humanPrincipal: { id: 'forged' } } as any,
      hubDeviceAttachment,
    })).resolves.toMatchObject({ ok: false, error: { type: 'hub_device_principal_mismatch' } });

    const humanAttachment = {
      ...hubDeviceAttachment,
      attachmentId: '018f0f10-79b2-4cc7-8c99-0242ac120004',
      disposition: 'created' as const,
      actor: {
        kind: 'human' as const,
        principalId: '33333333-3333-4333-8333-333333333333',
        companionId,
        providerSubject: { provider: 'discord' as const, subjectId: '123456789012345678' },
        contact: {
          bindingId: '44444444-4444-4444-8444-444444444444',
          contactId: 'contact/current-human',
          bindingVersion: 1,
        },
        operator: {
          grantId: '55555555-5555-4555-8555-555555555555',
          role: 'member' as const,
          grantVersion: 1,
        },
        session: {
          recordId: '66666666-6666-4666-8666-666666666666',
          authorityGeneration: 1,
          globalAuthEpoch: 1,
        },
      },
    };
    await expect(backend.handleChatCompletion({
      requestId: 'hub-device-human',
      request: { model: 'companion', messages: [{ role: 'user', content: 'hello' }] },
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'hub-device',
        'x-psfn-satellite-id': 'office',
        'x-psfn-satellite-endpoint-id': 'office-device',
        'x-psfn-satellite-session-id': 'realtime:office-device:session',
      },
      hubDevicePrincipal,
      hubDeviceAttachment: humanAttachment,
    })).resolves.toMatchObject({ ok: true });
    expect(handleMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      channelId: `hub-device:${'a'.repeat(64)}`,
      authorId: humanAttachment.actor.principalId,
      authorName: 'Authenticated fleet human',
      routing: {
        canonicalContactId: humanAttachment.actor.contact.contactId,
        satellite: { hubDevicePrincipal },
      },
    });
  });
});

describe('AgentApiBackend chat completion deadlines', () => {
  it('returns at visible turn completion instead of waiting for post-turn cleanup', async () => {
    vi.useFakeTimers();
    try {
      const eventBus = new EventBus();
      const performanceEvents: Array<{ traceId: string; stage: string; monotonicAtMs: number }> = [];
      eventBus.on('agent.turn.performance', event => performanceEvents.push(event));
      const response = {
        content: 'visible answer',
        channelId: 'api:principal-1:completion-session',
        metadata: {
          inputTokens: 11,
          outputTokens: 7,
        },
      };
      const handleMessage = vi.fn((message) => {
        setTimeout(() => {
          void eventBus.emit('agent.turn.end', { message, response } as any);
        }, 10);
        return new Promise(() => undefined);
      });
      const backend = new AgentApiBackend({
        agentLoop: {
          handleMessage,
          abort: vi.fn(),
        } as any,
        eventBus,
        sessionManager: createSessionManagerStub(),
      });

      const resultPromise = backend.handleChatCompletion({
        requestId: 'req-visible-complete',
        request: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Finish before cleanup' }],
        },
        principal: { id: 'principal-1', mode: 'api_key' },
        headers: {
          'x-session-id': 'completion-session',
          'x-channel-privacy': 'public',
        },
        timeoutMs: 1_000,
        performance: {
          receivedMonotonicAtMs: 123_456,
          receivedTimestampMs: 123_000,
        },
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(resultPromise).resolves.toEqual({
        ok: true,
        response: {
          content: 'visible answer',
          channelId: 'api:principal-1:completion-session',
          inputTokens: 11,
          outputTokens: 7,
        },
      });
      expect(handleMessage.mock.calls[0]?.[0]).toMatchObject({
        id: 'req-visible-complete',
        isDirectMessage: false,
        routing: { channelPrivacy: 'public' },
      });
      expect(performanceEvents).toContainEqual(expect.objectContaining({
        traceId: 'req-visible-complete',
        stage: 'transport_received',
        monotonicAtMs: 123_456,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the substrate turn and returns request_timeout when the RPC deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn(() => ({ status: 'signaled' as const }));
      const eventBus = new EventBus();
      const abortEvents: Array<{ reason: string }> = [];
      const cancellationOutcomes: string[] = [];
      eventBus.on('api.turn.abort', event => abortEvents.push({ reason: event.reason }));
      eventBus.on('agent.turn.performance', event => {
        if (event.stage === 'cancellation_ack' && event.cancellationOutcome) {
          cancellationOutcomes.push(event.cancellationOutcome);
        }
      });
      const backend = new AgentApiBackend({
        agentLoop: {
          handleMessage: vi.fn(() => new Promise(() => undefined)),
          abort,
        } as any,
        eventBus,
        sessionManager: createSessionManagerStub(),
      });

      const resultPromise = backend.handleChatCompletion({
        requestId: 'req-timeout',
        request: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Long task' }],
        },
        principal: { id: 'principal-1', mode: 'api_key' },
        headers: { 'x-session-id': 'deadline-session' },
        timeoutMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(abort).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledWith('req-timeout');
      await vi.waitFor(() => {
        expect(cancellationOutcomes).toEqual(['acknowledged']);
      });
      expect(abortEvents).toEqual([{ reason: 'timeout' }]);
      expect(result).toEqual({
        ok: false,
        error: {
          status: 504,
          type: 'request_timeout',
          message: 'Request timed out before turn completed',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('acknowledges client cancellation only after the active parent signal is proven', async () => {
    let resolveTurn!: (response: any) => void;
    const turnPromise = new Promise<any>((resolve) => {
      resolveTurn = resolve;
    });
    const eventBus = new EventBus();
    const abortEvents: Array<{ reason: string }> = [];
    const cancellationOutcomes: string[] = [];
    eventBus.on('api.turn.abort', event => abortEvents.push({ reason: event.reason }));
    eventBus.on('agent.turn.performance', event => {
      if (event.stage === 'cancellation_ack' && event.cancellationOutcome) {
        cancellationOutcomes.push(event.cancellationOutcome);
      }
    });
    const handleMessage = vi.fn(() => turnPromise);
    const abort = vi.fn(() => ({ status: 'signaled' as const }));
    const backend = new AgentApiBackend({
      agentLoop: { handleMessage, abort } as any,
      eventBus,
      sessionManager: createSessionManagerStub(),
    });

    const resultPromise = backend.handleChatCompletion({
      requestId: 'req-cancel-active-prompt',
      request: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Run until cancelled' }],
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: { 'x-session-id': 'cancel-active-prompt-session' },
    });
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledOnce();
    });

    await expect(backend.cancelChatCompletion({ requestId: 'req-cancel-active-prompt' })).resolves.toEqual({
      cancelled: true,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith('req-cancel-active-prompt');
    expect(abortEvents).toEqual([{ reason: 'client_disconnected' }]);
    expect(cancellationOutcomes).toEqual(['acknowledged']);

    resolveTurn({
      content: 'cancelled turn settled',
      channelId: 'api:principal-1:cancel-active-prompt-session',
      metadata: { inputTokens: 1, outputTokens: 1 },
    });
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
  });

  it('does not acknowledge cancellation before the parent Pi run becomes active', async () => {
    let resolveTurn!: (response: any) => void;
    const turnPromise = new Promise<any>((resolve) => {
      resolveTurn = resolve;
    });
    const eventBus = new EventBus();
    const abortEvents: Array<{ reason: string }> = [];
    const cancellationOutcomes: string[] = [];
    eventBus.on('api.turn.abort', event => abortEvents.push({ reason: event.reason }));
    eventBus.on('agent.turn.performance', event => {
      if (event.stage === 'cancellation_ack' && event.cancellationOutcome) {
        cancellationOutcomes.push(event.cancellationOutcome);
      }
    });
    const handleMessage = vi.fn(() => turnPromise);
    const abort = vi.fn(() => ({ status: 'not_active' as const }));
    const backend = new AgentApiBackend({
      agentLoop: { handleMessage, abort } as any,
      eventBus,
      sessionManager: createSessionManagerStub(),
    });

    const resultPromise = backend.handleChatCompletion({
      requestId: 'req-cancel-pre-prompt',
      request: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Search before answering' }],
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: { 'x-session-id': 'cancel-pre-prompt-session' },
    });
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledOnce();
    });

    await expect(backend.cancelChatCompletion({ requestId: 'req-cancel-pre-prompt' })).resolves.toEqual({
      cancelled: false,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith('req-cancel-pre-prompt');
    expect(abortEvents).toEqual([]);
    expect(cancellationOutcomes).toEqual(['failed']);

    resolveTurn({
      content: 'eventual answer',
      channelId: 'api:principal-1:cancel-pre-prompt-session',
      metadata: { inputTokens: 1, outputTokens: 1 },
    });
    await expect(resultPromise).resolves.toMatchObject({ ok: true });

    await expect(backend.cancelChatCompletion({ requestId: 'req-cancel-pre-prompt' })).resolves.toEqual({
      cancelled: false,
    });
    expect(cancellationOutcomes).toEqual(['failed', 'failed']);
  });

  it('does not acknowledge cancellation when another request owns the active parent run', async () => {
    let resolveTurn!: (response: any) => void;
    const turnPromise = new Promise<any>((resolve) => {
      resolveTurn = resolve;
    });
    const eventBus = new EventBus();
    const abortEvents: Array<{ reason: string }> = [];
    const cancellationOutcomes: string[] = [];
    eventBus.on('api.turn.abort', event => abortEvents.push({ reason: event.reason }));
    eventBus.on('agent.turn.performance', event => {
      if (event.stage === 'cancellation_ack' && event.cancellationOutcome) {
        cancellationOutcomes.push(event.cancellationOutcome);
      }
    });
    const handleMessage = vi.fn(() => turnPromise);
    const abort = vi.fn(() => ({ status: 'owner_mismatch' as const }));
    const backend = new AgentApiBackend({
      agentLoop: { handleMessage, abort } as any,
      eventBus,
      sessionManager: createSessionManagerStub(),
    });

    const resultPromise = backend.handleChatCompletion({
      requestId: 'request-a',
      request: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Wait while another run is active' }],
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: { 'x-session-id': 'owner-mismatch-session' },
    });
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledOnce();
    });

    await expect(backend.cancelChatCompletion({ requestId: 'request-a' })).resolves.toEqual({
      cancelled: false,
    });
    expect(abort).toHaveBeenCalledWith('request-a');
    expect(abortEvents).toEqual([]);
    expect(cancellationOutcomes).toEqual(['failed']);

    resolveTurn({
      content: 'request eventually settled',
      channelId: 'api:principal-1:owner-mismatch-session',
      metadata: { inputTokens: 1, outputTokens: 1 },
    });
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
  });

  it('reports failed cancellation when the active agent abort throws', async () => {
    let resolveTurn!: (response: any) => void;
    const turnPromise = new Promise<any>((resolve) => {
      resolveTurn = resolve;
    });
    const eventBus = new EventBus();
    const cancellationOutcomes: string[] = [];
    eventBus.on('agent.turn.performance', event => {
      if (event.stage === 'cancellation_ack' && event.cancellationOutcome) {
        cancellationOutcomes.push(event.cancellationOutcome);
      }
    });
    const handleMessage = vi.fn(() => turnPromise);
    const backend = new AgentApiBackend({
      agentLoop: {
        handleMessage,
        abort: vi.fn(() => {
          throw new Error('agent abort failed');
        }),
      } as any,
      eventBus,
      sessionManager: createSessionManagerStub(),
    });
    const resultPromise = backend.handleChatCompletion({
      requestId: 'req-cancel-failed',
      request: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Long task' }],
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: { 'x-session-id': 'cancel-failed-session' },
    });
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledOnce();
    });

    await expect(backend.cancelChatCompletion({ requestId: 'req-cancel-failed' })).resolves.toEqual({
      cancelled: false,
    });
    expect(cancellationOutcomes).toEqual(['failed']);

    resolveTurn({
      content: 'eventual answer',
      channelId: 'api:principal-1:cancel-failed-session',
      metadata: { inputTokens: 1, outputTokens: 1 },
    });
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
  });
});

describe('AgentApiBackend direct model completions', () => {
  function createBackend(overrides: {
    complete?: ReturnType<typeof vi.fn>;
    handleMessage?: ReturnType<typeof vi.fn>;
    llmProvider?: false;
    eventBus?: EventBus;
  } = {}) {
    const complete = overrides.complete ?? vi.fn(async () => ({
      content: 'raw model reply',
      toolCalls: [],
      model: 'claude-fable-5',
      inputTokens: 5,
      outputTokens: 9,
      stopReason: 'stop',
    }));
    const handleMessage = overrides.handleMessage ?? vi.fn(() => new Promise(() => undefined));
    const eventBus = overrides.eventBus ?? new EventBus();
    const backend = new AgentApiBackend({
      agentLoop: {
        handleMessage,
        abort: vi.fn(() => ({ status: 'not_active' as const })),
      } as any,
      eventBus,
      sessionManager: createSessionManagerStub(),
      ...(overrides.llmProvider === false
        ? {}
        : { llmProvider: { complete, stream: vi.fn() } as any }),
    });
    return { backend, complete, handleMessage, eventBus };
  }

  const participantRequest = {
    model: 'anthropic/claude-fable-5',
    provider: 'anthropic',
    messages: [{ role: 'user' as const, content: 'Hello raw model' }],
  };

  it('bypasses the companion pipeline and pins the overridden model', async () => {
    const { backend, complete, handleMessage } = createBackend();

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-1',
      request: { ...participantRequest, system_prompt_mode: 'none' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: { 'x-channel-id': 'model-room:room-1:claude-fable' },
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    const [context, purpose] = complete.mock.calls[0];
    expect(purpose).toBe('reasoning');
    expect(context.systemPrompt).toBe('');
    expect(context.messages).toEqual([{ role: 'user', content: 'Hello raw model' }]);
    expect(context.modelHint).toEqual({
      provider: 'anthropic',
      model: 'anthropic/claude-fable-5',
      pin: true,
    });
    expect(result).toEqual({
      ok: true,
      response: {
        content: 'raw model reply',
        channelId: 'model-room:room-1:claude-fable',
        inputTokens: 5,
        outputTokens: 9,
      },
    });
  });

  it('passes a custom system prompt through to the raw completion', async () => {
    const { backend, complete } = createBackend();

    await backend.handleChatCompletion({
      requestId: 'req-direct-2',
      request: {
        ...participantRequest,
        system_prompt_mode: 'custom',
        system_prompt: 'You are a frank advisor.',
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(complete.mock.calls[0][0].systemPrompt).toBe('You are a frank advisor.');
  });

  it('defaults to the raw path when a provider override has no system_prompt_mode', async () => {
    const { backend, complete, handleMessage } = createBackend();

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-3',
      request: { ...participantRequest },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('keeps the companion pipeline when system_prompt_mode=default is explicit', async () => {
    const handleMessage = vi.fn(() => new Promise(() => undefined));
    const { backend, complete } = createBackend({ handleMessage });

    const resultPromise = backend.handleChatCompletion({
      requestId: 'req-direct-4',
      request: { ...participantRequest, system_prompt_mode: 'default' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: { 'x-session-id': 'pipeline-session' },
      timeoutMs: 1_000,
    });

    const result = await resultPromise;
    expect(complete).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it('rejects system-role messages on the raw path', async () => {
    const { backend, complete } = createBackend();

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-5',
      request: {
        ...participantRequest,
        messages: [
          { role: 'system' as const, content: 'sneaky system prompt' },
          { role: 'user' as const, content: 'hi' },
        ],
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(complete).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
    }
  });

  it('fails closed when no LLM provider port is configured', async () => {
    const { backend, handleMessage } = createBackend({ llmProvider: false });

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-6',
      request: { ...participantRequest, system_prompt_mode: 'none' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(503);
      expect(result.error.type).toBe('direct_model_unavailable');
    }
  });

  it('cancels an in-flight direct completion via cancelChatCompletion', async () => {
    let providerSignal: AbortSignal | undefined;
    const complete = vi.fn((_context, _purpose, options) => {
      providerSignal = options?.signal;
      return new Promise<never>(() => undefined);
    });
    const eventBus = new EventBus();
    const cancellationOutcomes: string[] = [];
    eventBus.on('agent.turn.performance', event => {
      if (event.stage === 'cancellation_ack' && event.cancellationOutcome) {
        cancellationOutcomes.push(event.cancellationOutcome);
      }
    });
    const { backend } = createBackend({ complete, eventBus });

    const resultPromise = backend.handleChatCompletion({
      requestId: 'req-direct-cancel-1',
      request: { ...participantRequest, system_prompt_mode: 'none' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: { 'x-channel-id': 'model-room:room-1:claude-fable' },
    });

    await Promise.resolve();
    const cancelResult = await backend.cancelChatCompletion({ requestId: 'req-direct-cancel-1' });
    expect(cancelResult).toEqual({ cancelled: true });

    const result = await resultPromise;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(providerSignal).toBeInstanceOf(AbortSignal);
    expect(providerSignal?.aborted).toBe(true);
    expect(result).toEqual({
      ok: false,
      error: {
        status: 499,
        type: 'request_cancelled',
        message: 'Direct model completion cancelled',
      },
    });

    const repeatCancel = await backend.cancelChatCompletion({ requestId: 'req-direct-cancel-1' });
    expect(repeatCancel).toEqual({ cancelled: false });
    expect(cancellationOutcomes).toEqual(['acknowledged', 'failed']);
  });

  it('cancels an in-flight direct completion when the caller AbortSignal fires', async () => {
    let providerSignal: AbortSignal | undefined;
    const complete = vi.fn((_context, _purpose, options) => {
      providerSignal = options?.signal;
      return new Promise<never>(() => undefined);
    });
    const { backend } = createBackend({ complete });
    const controller = new AbortController();

    const resultPromise = backend.runChatCompletion({
      request: { ...participantRequest, system_prompt_mode: 'none' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();

    const result = await resultPromise;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(providerSignal).toBeInstanceOf(AbortSignal);
    expect(providerSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(499);
      expect(result.error.type).toBe('request_cancelled');
    }
  });

  it('rejects direct completions immediately when the signal is already aborted', async () => {
    const complete = vi.fn(() => new Promise<never>(() => undefined));
    const { backend } = createBackend({ complete });
    const controller = new AbortController();
    controller.abort();

    const result = await backend.runChatCompletion({
      request: { ...participantRequest, system_prompt_mode: 'none' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
      signal: controller.signal,
    });

    expect(complete).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(499);
      expect(result.error.type).toBe('request_cancelled');
    }
  });

  it('surfaces pinned-model failures instead of falling back', async () => {
    const complete = vi.fn(async () => {
      throw new Error('404 No endpoints available');
    });
    const { backend } = createBackend({ complete });

    const result = await backend.handleChatCompletion({
      requestId: 'req-direct-7',
      request: { ...participantRequest, system_prompt_mode: 'none' },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(502);
      expect(result.error.type).toBe('model_error');
      expect(result.error.message).toContain('anthropic/claude-fable-5');
      expect(result.error.message).toContain('404 No endpoints available');
    }
  });
});
