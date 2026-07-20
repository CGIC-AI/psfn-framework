import { describe, expect, it, vi } from 'vitest';
import { GatewayApiRuntime, computeGatewayChatRequestTimeoutMs } from './gateway-runtime.js';
import type { ApiRuntimeChatRequest } from './types.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';

function createChatRequest(): ApiRuntimeChatRequest {
  return {
    request: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    },
    principal: { id: 'principal-1', mode: 'api_key' },
    headers: { 'x-session-id': 'session-1' },
  };
}

describe('GatewayApiRuntime', () => {
  it('routes normalized shared-satellite observations to exact recipients, never the generic agent', async () => {
    const primary = createCompanionId('11111111-1111-4111-8111-111111111111');
    const productivity = createCompanionId('22222222-2222-4222-8222-222222222222');
    const requestAgent = vi.fn();
    const observationAudit = vi.fn(async () => undefined);
    const requestCompanionAgent = vi.fn(async () => ({
      ok: true as const,
      response: {
        ok: true as const,
        id: 'event-1',
        acceptedEventType: 'external.telemetry.status',
      },
    }));
    const runtime = new GatewayApiRuntime({
      requestAgent,
      requestCompanionAgent,
      subscribeApiStream: vi.fn(() => () => {}),
    }, {
      satelliteRegistryProvider: () => ({
        schemaVersion: 1,
        enabled: true,
        productivityCompanionId: productivity,
        satellites: [{
          satelliteId: 'sat-1',
          displayName: 'Kitchen',
          mobility: 'static',
          placeId: 'kitchen',
          sharedDevice: {
            primaryCompanionId: primary,
            observationRecipients: [
              { companionId: primary, scopes: ['presence'] },
              { companionId: productivity, scopes: ['presence'] },
            ],
            emanationMemberIds: [primary],
            responseLease: { durationMs: 5_000, activeConversationTtlMs: 60_000 },
          },
          endpoints: [{
            endpointId: 'sensor',
            displayName: 'Sensor',
            claimTypes: ['telemetry'],
            promptChannelType: 'api',
            auth: { mode: 'api_key', apiKeyPrincipalIds: ['sensor-key'] },
            defaultIdentity: {
              authorId: 'sensor',
              authorName: 'Sensor',
              canonicalContactId: 'contact-partner',
              channelPrivacy: 'private',
            },
            maxCapabilities: ['telemetry', 'presence'],
            telemetryScopes: ['presence'],
          }],
        }],
      }),
      observationAudit,
      now: () => 1_000,
    });

    await runtime.handleTelemetryIngest({
      id: 'event-1',
      source: 'sat-1',
      eventType: 'external.telemetry.status',
      payload: { satelliteId: 'sat-1', present: true, rawRoomDetail: 'strip me' },
      occurredAt: '2026-07-19T12:00:00.000Z',
      receivedAt: '2026-07-19T12:00:01.000Z',
      nonce: 'nonce-12345678',
      scope: 'presence',
      auth: {
        principalId: 'sensor-key',
        principalMode: 'api_key',
        satelliteScoped: false,
      },
    });

    expect(requestAgent).not.toHaveBeenCalled();
    expect(requestCompanionAgent).toHaveBeenCalledTimes(2);
    expect(requestCompanionAgent).toHaveBeenNthCalledWith(
      2,
      productivity,
      'api.telemetry.ingest',
      {
        event: expect.objectContaining({
          payload: { satelliteId: 'sat-1', placeId: 'kitchen', present: true },
        }),
      },
    );
    expect(observationAudit).toHaveBeenCalledTimes(2);
    expect(observationAudit).toHaveBeenNthCalledWith(2, {
      satelliteId: 'sat-1',
      companionId: productivity,
      scope: 'presence',
      eventId: 'event-1',
      timestamp: 1_000,
    });
  });

  it('routes an admitted fleet chat request to the exact companion', async () => {
    const requestAgent = vi.fn();
    const requestCompanionAgent = vi.fn(async () => ({
      ok: true,
      response: {
        content: 'scoped response',
        channelId: 'api:principal-1:session-1',
        inputTokens: 3,
        outputTokens: 2,
      },
    }));
    const runtime = new GatewayApiRuntime({
      requestAgent,
      requestCompanionAgent,
      subscribeApiStream: vi.fn(() => () => {}),
    });

    const result = await runtime.handleChatCompletion({
      ...createChatRequest(),
      companionId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result).toMatchObject({
      ok: true,
      response: { content: 'scoped response' },
    });
    expect(requestAgent).not.toHaveBeenCalled();
    expect(requestCompanionAgent).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'api.chat.completion',
      expect.objectContaining({
        requestId: expect.stringMatching(/^api-/),
        request: expect.objectContaining({ model: 'test-model' }),
      }),
      95_000,
    );
  });

  it('routes authenticated satellite HTTP chat through shared response arbitration', async () => {
    const primary = createCompanionId('11111111-1111-4111-8111-111111111111');
    const requestAgent = vi.fn();
    const requestCompanionAgent = vi.fn();
    const requestSharedSatelliteChatCompletion = vi.fn(async () => ({
      ok: true as const,
      response: {
        content: 'leased response',
        channelId: 'satellite:voice:session-1',
        inputTokens: 2,
        outputTokens: 2,
      },
    }));
    const runtime = new GatewayApiRuntime({
      requestAgent,
      requestCompanionAgent,
      requestSharedSatelliteChatCompletion,
      cancelSharedSatelliteChatCompletion: vi.fn(),
      subscribeApiStream: vi.fn(() => () => {}),
    }, {
      satelliteRegistryProvider: () => ({
        schemaVersion: 1,
        enabled: true,
        satellites: [{
          satelliteId: 'sat-1',
          displayName: 'Kitchen',
          mobility: 'static',
          sharedDevice: {
            primaryCompanionId: primary,
            observationRecipients: [],
            emanationMemberIds: [primary],
            responseLease: { durationMs: 5_000, activeConversationTtlMs: 60_000 },
          },
          endpoints: [{
            endpointId: 'voice',
            displayName: 'Voice',
            claimTypes: ['voice'],
            promptChannelType: 'api',
            auth: { mode: 'api_key', apiKeyPrincipalIds: ['sensor-key'] },
            defaultIdentity: {
              authorId: 'partner',
              authorName: 'Partner',
              canonicalContactId: 'contact-partner',
              channelPrivacy: 'private',
            },
            maxCapabilities: ['audio_input', 'audio_output'],
            telemetryScopes: [],
          }],
        }],
      }),
    });

    const result = await runtime.handleChatCompletion({
      ...createChatRequest(),
      request: { ...createChatRequest().request, stream: false },
      principal: { id: 'sensor-key', mode: 'api_key' },
      headers: {
        'x-psfn-satellite-claim-type': 'voice',
        'x-psfn-satellite-id': 'sat-1',
        'x-psfn-satellite-endpoint-id': 'voice',
        'x-psfn-satellite-session-id': 'session-1',
      },
    });

    expect(result).toMatchObject({ ok: true, response: { content: 'leased response' } });
    expect(requestAgent).not.toHaveBeenCalled();
    expect(requestCompanionAgent).not.toHaveBeenCalled();
    expect(requestSharedSatelliteChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalContactId: 'contact-partner',
        channelId: 'satellite:voice:session-1',
        satellite: expect.objectContaining({
          satelliteId: 'sat-1',
          sharedDevice: expect.objectContaining({ primaryCompanionId: primary }),
        }),
      }),
    );
  });

  it('brokers chat completions and forwards stream deltas', async () => {
    const onDelta = vi.fn();
    let streamListener: ((text: string) => void) | undefined;
    const unsubscribe = vi.fn();
    const requestAgent = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'api.chat.completion') {
        streamListener?.('partial delta');
        expect(params.requestId).toMatch(/^api-/);
        expect(params.performance).toEqual({
          receivedMonotonicAtMs: expect.any(Number),
          receivedTimestampMs: expect.any(Number),
        });
        return {
          ok: true,
          response: {
            content: 'done',
            channelId: 'api:principal-1:session-1',
            inputTokens: 3,
            outputTokens: 2,
          },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const runtime = new GatewayApiRuntime({
      requestAgent,
      subscribeApiStream: (_requestId, listener) => {
        streamListener = listener;
        return () => {
          unsubscribe();
        };
      },
    });

    const result = await runtime.handleChatCompletion({
      ...createChatRequest(),
      onDelta,
    });

    expect(result).toEqual({
      ok: true,
      response: {
        content: 'done',
        channelId: 'api:principal-1:session-1',
        inputTokens: 3,
        outputTokens: 2,
      },
    });
    expect(onDelta).toHaveBeenCalledWith('partial delta');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('sends cancellation to the agent when the request aborts', async () => {
    const controller = new AbortController();
    let resolveCompletion: ((value: unknown) => void) | undefined;
    const requestAgent = vi.fn((method: string) => {
      if (method === 'api.chat.cancel') {
        return Promise.resolve({ cancelled: true });
      }
      if (method === 'api.chat.completion') {
        return new Promise((resolve) => {
          resolveCompletion = resolve;
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const runtime = new GatewayApiRuntime({
      requestAgent,
      subscribeApiStream: () => () => {},
    });

    const completionPromise = runtime.handleChatCompletion({
      ...createChatRequest(),
      signal: controller.signal,
    });
    controller.abort();
    resolveCompletion?.({
      ok: true,
      response: {
        content: 'done',
        channelId: 'api:principal-1:session-1',
        inputTokens: 3,
        outputTokens: 2,
      },
    });

    await completionPromise;

    expect(requestAgent).toHaveBeenCalledWith(
      'api.chat.cancel',
      expect.objectContaining({ requestId: expect.any(String) }),
      95_000,
    );
  });

  it('degrades health instead of throwing when no agent is connected yet', async () => {
    const runtime = new GatewayApiRuntime({
      requestAgent: vi.fn(async () => {
        throw new Error('No agent connected');
      }),
      subscribeApiStream: vi.fn(() => () => {}),
    });

    const health = await runtime.handleHealth();

    expect(health.status).toBe('degraded');
    expect(health.subsystems.memory.status).toBe('degraded');
    expect(health.continuity.status).toBe('degraded');
    expect(health.continuity.checks.gatewayLink.status).toBe('degraded');
    expect(health.continuity.checks.gatewayLink.detail).toContain('No agent connected');
    expect(health.continuity.checks.gatewayLink.meta).toEqual({ agentConnected: false });
  });

  it('passes an explicit chat completion timeout to the gateway request', async () => {
    const requestAgent = vi.fn(async () => ({
      ok: true,
      response: {
        content: 'ok',
        channelId: 'api:test',
        inputTokens: 1,
        outputTokens: 1,
      },
    }));
    const runtime = new GatewayApiRuntime({
      requestAgent,
      subscribeApiStream: vi.fn(() => () => {}),
    }, {
      chatRequestTimeoutMs: 123_456,
    });

    await runtime.handleChatCompletion({
      request: {
        model: 'openrouter/moonshotai/kimi-k2.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(requestAgent).toHaveBeenCalledWith(
      'api.chat.completion',
      expect.objectContaining({
        request: expect.objectContaining({
          model: 'openrouter/moonshotai/kimi-k2.5',
        }),
        timeoutMs: 117_456,
      }),
      123_456,
    );
  });

  it('adds a small buffer to the API request timeout when computing the gateway timeout', () => {
    expect(computeGatewayChatRequestTimeoutMs(120_000)).toBe(125_000);
    expect(computeGatewayChatRequestTimeoutMs(undefined)).toBe(95_000);
  });
});
