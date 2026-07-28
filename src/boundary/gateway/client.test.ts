import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DiscoveredModel } from '../../primitives/llm/discovery.js';
import { COMPANION_PRIVATE_BACKGROUND_TELEMETRY } from '../../shared/telemetry/model-usage.js';
import { GatewayClient } from './client.js';
import { GatewayErrors } from './protocol.js';
import type {
  GatewayRpcSerializedTransportStats,
  NdjsonConnection,
} from './transport.js';
import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { runWithChargeContext } from '../../shared/telemetry/run-charge.js';
import { makeTestChargePolicyConfig } from '../../test-support/charge-policy.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { EventBus } from '../../shared/event-bus.js';
import { TurnPerformanceTracker } from '../../shared/telemetry/turn-performance.js';
import { CAPABILITY_TOKENS } from '../../system/capabilities/tokens.js';
import { deriveShardCapabilityGrant } from '../../system/capabilities/shard-derivation.js';
import {
  buildSubagentWorkSpec,
  createSubagentWorkSpecProvider,
} from '../../faculties/subagents/work-spec.js';

const TEST_COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const TEST_GATEWAY_ROUTING = {
  gateway: { schemaVersion: 1 as const, companionId: TEST_COMPANION_ID },
};

/** Create a mock NdjsonConnection that captures sent messages */
function createMockConnection(options: { heartbeatResults?: boolean[] } = {}) {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  let heartbeatCount = 0;
  let destroyed = false;
  const transportStats: GatewayRpcSerializedTransportStats = {
    frameCount: 0,
    serializedBytes: 0,
    rpcCallCount: 0,
    byMethod: {},
  };

  const conn = {
    send(data: unknown): boolean {
      sent.push(data);
      const serializedBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
      transportStats.frameCount += 1;
      transportStats.serializedBytes += serializedBytes;
      const method = (data as { method?: unknown } | null)?.method;
      if (typeof method === 'string') {
        transportStats.rpcCallCount += 1;
        const methodStats = transportStats.byMethod[method] ?? { callCount: 0, serializedBytes: 0 };
        methodStats.callCount += 1;
        methodStats.serializedBytes += serializedBytes;
        transportStats.byMethod[method] = methodStats;
      }
      return true;
    },
    sendHeartbeat(): boolean {
      heartbeatCount += 1;
      return options.heartbeatResults?.shift() ?? true;
    },
    onHeartbeat(handler: () => void): void {
      emitter.on('heartbeat', handler);
    },
    onMessage(handler: (message: unknown) => void): void {
      emitter.on('message', handler);
    },
    on(event: string, handler: (...args: unknown[]) => void): void {
      emitter.on(event, handler);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      emitter.emit('close');
      emitter.removeAllListeners();
    },
    get destroyed(): boolean {
      return destroyed;
    },
    get serializedTransportStats(): GatewayRpcSerializedTransportStats {
      return structuredClone(transportStats);
    },
    // Emit a message to the client as if received from the gateway
    _emit(message: unknown): void {
      emitter.emit('message', message);
    },
    _emitClose(): void {
      emitter.emit('close');
    },
    _emitError(error: Error): void {
      emitter.emit('error', error);
    },
  };

  return {
    conn: conn as unknown as NdjsonConnection,
    sent,
    get heartbeatCount(): number {
      return heartbeatCount;
    },
    get destroyed(): boolean {
      return destroyed;
    },
    _emit: conn._emit,
    _emitClose: conn._emitClose,
    _emitError: conn._emitError,
  };
}

function getRpcResponse(sent: unknown[], id: number): any {
  return sent.find((msg: any) => msg.id === id && ('result' in msg || 'error' in msg));
}

describe('GatewayClient shard workload lifecycle', () => {
  it('registers and ends one opaque workload lease without sending parent authority', async () => {
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, { companionId: TEST_COMPANION_ID });
    const capabilityGrant = deriveShardCapabilityGrant({
      companionId: TEST_COMPANION_ID,
      tier: 'custom',
      customTokens: [...CAPABILITY_TOKENS],
    });

    const registering = client.registerWorkload({
      parentCompanionId: TEST_COMPANION_ID,
      shardId: 'shard-client-lifecycle',
      shardLabel: 'Client Lifecycle',
      channelIds: ['shard:client-lifecycle', 'shard:client-lifecycle:human'],
      capabilityGrant,
    });
    const registerRequest = conn.sent[0] as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(registerRequest.method).toBe('shard.workload.register');
    expect(registerRequest.params).toMatchObject({
      shardId: 'shard-client-lifecycle',
      ownerVersion: capabilityGrant.ownerVersion,
      grantDigest: capabilityGrant.grantDigest,
    });
    expect(registerRequest.params).not.toHaveProperty('parentCompanionId');
    expect(registerRequest.params).not.toHaveProperty('capabilityGrant');
    conn._emit({
      jsonrpc: '2.0',
      id: registerRequest.id,
      result: {
        registrationId: registerRequest.params.registrationId,
        workloadGeneration: 'shard-client-lifecycle#g1-server',
      },
    });
    const handle = await registering;

    const ending = client.endWorkload(handle);
    const endRequest = conn.sent[1] as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(endRequest).toMatchObject({
      method: 'shard.workload.end',
      params: { registrationId: registerRequest.params.registrationId },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: endRequest.id,
      result: { ended: true },
    });
    await ending;
    await expect(client.endWorkload(handle)).rejects.toThrow(/unknown gateway shard workload/);
  });

  it('destroys the authenticated connection when workload revocation is unconfirmed', async () => {
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, { companionId: TEST_COMPANION_ID });
    const capabilityGrant = deriveShardCapabilityGrant({
      companionId: TEST_COMPANION_ID,
      tier: 'custom',
      customTokens: [...CAPABILITY_TOKENS],
    });
    const registering = client.registerWorkload({
      parentCompanionId: TEST_COMPANION_ID,
      shardId: 'shard-client-revocation',
      channelIds: ['shard:client-revocation'],
      capabilityGrant,
    });
    const registerRequest = conn.sent[0] as {
      id: number;
      params: Record<string, unknown>;
    };
    conn._emit({
      jsonrpc: '2.0',
      id: registerRequest.id,
      result: {
        registrationId: registerRequest.params.registrationId,
        workloadGeneration: 'shard-client-revocation#g1-server',
      },
    });
    const handle = await registering;

    const ending = client.endWorkload(handle);
    const endRequest = conn.sent[1] as { id: number };
    conn._emit({
      jsonrpc: '2.0',
      id: endRequest.id,
      error: {
        code: -32_603,
        message: 'revocation unavailable',
      },
    });

    await expect(ending).rejects.toThrow('revocation unavailable');
    expect(conn.destroyed).toBe(true);
  });
});

describe('GatewayClient streaming', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('routes streamed callbacks by the transported work-spec request id', async () => {
    const parentCorrelation = {
      turnId: 'parent-turn',
      requestId: 'parent-request',
      channelId: 'discord-channel',
      callType: 'chat' as const,
      purpose: 'agent.turn.prompt',
      originType: 'chat' as const,
      originStage: 'agent.turn.prompt',
    };
    const workSpec = buildSubagentWorkSpec({
      correlation: {
        ...parentCorrelation,
        requestId: 'worker-request',
      },
    });
    const chunks: string[] = [];
    const firstOutputs: Array<Record<string, unknown>> = [];

    const streaming = client.stream(
      {
        systemPrompt: 'bounded worker',
        messages: [{ role: 'user', content: 'analyze the attached evidence' }],
        correlation: parentCorrelation,
      },
      {
        onText: text => chunks.push(text),
        onFirstOutput: observation => firstOutputs.push(observation),
      },
      { workSpec },
    );
    const request = conn.sent[0] as {
      id: number;
      method: string;
      params: Record<string, unknown> & { workSpec: Record<string, unknown> };
    };

    expect(request.method).toBe('llm.chat');
    expect(request.params).toMatchObject({
      requestId: 'worker-request',
      turnId: 'parent-turn',
      channelId: 'discord-channel',
      callType: 'background',
      originType: 'chat',
      originStage: 'subagent.turn',
      purpose: 'agent.turn.prompt',
      workSpec: {
        purpose: 'background',
        lane: 'background_continuation',
        durable: false,
      },
    });
    expect(request.params.workSpec).not.toHaveProperty('correlation');

    conn._emit({
      method: 'llm.chunk',
      params: { requestId: 'worker-request', text: 'worker ' },
    });
    conn._emit({
      method: 'llm.first_output',
      params: {
        requestId: 'worker-request',
        kind: 'text',
        monotonicAtMs: 123,
        timestampMs: 456,
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: 'worker completed',
        toolCalls: [],
        model: 'background-model',
        inputTokens: 20,
        outputTokens: 4,
        stopReason: 'stop',
      },
    });
    await expect(streaming).resolves.toMatchObject({ content: 'worker completed' });
    expect(chunks).toEqual(['worker ']);
    expect(firstOutputs).toEqual([{
      kind: 'text',
      monotonicAtMs: 123,
      timestampMs: 456,
    }]);
  });

  it('uses an opaque routing id without exposing private source correlation', async () => {
    const sourceCorrelation = {
      turnId: 'private-source-turn',
      requestId: 'private-source-request',
      channelId: 'private-source-channel',
      telemetryVisibility: 'companion_private' as const,
    };
    const workSpec = buildSubagentWorkSpec({ correlation: sourceCorrelation });
    const chunks: string[] = [];

    const streaming = client.stream(
      {
        systemPrompt: 'private bounded worker',
        messages: [{ role: 'user', content: 'analyze private evidence' }],
        correlation: sourceCorrelation,
      },
      { onText: text => chunks.push(text) },
      { workSpec },
    );
    const request = conn.sent[0] as {
      id: number;
      params: Record<string, unknown> & { requestId: string };
    };

    expect(request.params).toMatchObject({
      telemetryVisibility: 'companion_private',
      callType: 'background',
      purpose: 'companion_private.background',
    });
    expect(request.params.requestId).toMatch(/^req-\d+$/);
    expect(request.params.requestId).not.toBe(sourceCorrelation.requestId);
    expect(request.params).not.toHaveProperty('turnId');
    expect(request.params).not.toHaveProperty('channelId');

    conn._emit({
      method: 'llm.chunk',
      params: { requestId: request.params.requestId, text: 'private chunk' },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: 'private worker completed',
        toolCalls: [],
        model: 'background-model',
        inputTokens: 20,
        outputTokens: 4,
        stopReason: 'stop',
      },
    });

    await expect(streaming).resolves.toMatchObject({ content: 'private worker completed' });
    expect(chunks).toEqual(['private chunk']);
  });

  it('flattens injected subagent correlation on matching-purpose complete calls', async () => {
    const parentCorrelation = {
      turnId: 'parent-complete-turn',
      requestId: 'parent-complete-request',
      channelId: 'discord-channel',
      callType: 'chat' as const,
      purpose: 'agent.turn.prompt',
      originType: 'chat' as const,
      originStage: 'agent.turn.prompt',
    };
    const workSpec = buildSubagentWorkSpec({ correlation: parentCorrelation });
    const workerProvider = createSubagentWorkSpecProvider(client, workSpec);

    const completion = workerProvider.complete(
      {
        systemPrompt: 'bounded worker',
        messages: [{ role: 'user', content: 'analyze the attached evidence' }],
        correlation: parentCorrelation,
      },
      'background',
      { correlation: { requestId: 'caller-complete-request' } },
    );
    const request = conn.sent[0] as {
      id: number;
      method: string;
      params: Record<string, unknown> & { workSpec: Record<string, unknown> };
    };

    expect(request.method).toBe('llm.complete');
    expect(request.params).toMatchObject({
      requestId: 'caller-complete-request',
      turnId: 'parent-complete-turn',
      channelId: 'discord-channel',
      callType: 'background',
      originType: 'chat',
      originStage: 'subagent.turn',
      purpose: 'background',
      workSpec: {
        purpose: 'background',
        lane: 'background_continuation',
        durable: false,
      },
    });
    expect(request.params.workSpec).not.toHaveProperty('correlation');

    conn._emit({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: 'worker completed',
        model: 'background-model',
        inputTokens: 20,
        outputTokens: 4,
        stopReason: 'stop',
      },
    });
    await expect(completion).resolves.toMatchObject({ content: 'worker completed' });
  });

  it('does not let caller completion correlation downgrade a private subagent spec', async () => {
    const privateSpec = buildSubagentWorkSpec({
      correlation: {
        telemetryVisibility: 'companion_private',
        requestId: 'private-spec-request',
        channelId: 'private-spec-channel',
      },
    });
    const workerProvider = createSubagentWorkSpecProvider(client, privateSpec);

    const completion = workerProvider.complete(
      {
        systemPrompt: 'private bounded worker',
        messages: [{ role: 'user', content: 'analyze private evidence' }],
        correlation: {
          requestId: 'context-request',
          channelId: 'context-channel',
          telemetryVisibility: 'operator_visible',
        },
      },
      'background',
      {
        correlation: {
          requestId: 'caller-request',
          telemetryVisibility: 'operator_visible',
        },
      },
    );
    const request = conn.sent[0] as {
      id: number;
      params: Record<string, unknown>;
    };

    expect(request.params).toMatchObject({
      telemetryVisibility: 'companion_private',
      callType: 'background',
      purpose: 'background',
      originStage: 'companion_private.background',
    });
    expect(request.params).not.toHaveProperty('requestId');
    expect(request.params).not.toHaveProperty('channelId');

    conn._emit({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: 'private worker completed',
        model: 'background-model',
        inputTokens: 20,
        outputTokens: 4,
        stopReason: 'stop',
      },
    });
    await expect(completion).resolves.toMatchObject({ content: 'private worker completed' });
  });

  it('sends screened inline image bytes in only the intake frame and references them in the main call', async () => {
    const imageBase64 = 'A'.repeat(4096);
    const requestScope = 'turn-inline-retained';
    const screened = client.screenImageIntake({
      imageBase64,
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope,
    });
    const screenRequest = conn.sent[0] as { id: number; method: string };
    expect(screenRequest.method).toBe('intake.screen_image');
    conn._emit({
      jsonrpc: '2.0',
      id: screenRequest.id,
      result: {
        kind: 'screened',
        mode: 'enforce',
        flagged: false,
        withheld: false,
        retainedImage: {
          handle: 'retained-handle-1',
          requestScope,
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    await screened;

    const streamPromise = client.stream({
      systemPrompt: 'system',
      correlation: { turnId: requestScope, callType: 'chat', purpose: 'chat' },
      messages: [{
        role: 'user',
        content: [{ type: 'image', data: imageBase64, mimeType: 'image/png' }],
      }] as any,
    });
    const llmRequest = conn.sent[1] as {
      id: number;
      method: string;
      params: { messages: unknown[] };
    };
    expect(llmRequest.method).toBe('llm.chat');
    expect(llmRequest.params.messages).toEqual([{
      role: 'user',
      content: [{ type: 'gateway_image_ref', handle: 'retained-handle-1' }],
    }]);
    expect(JSON.stringify(llmRequest)).not.toContain(imageBase64);
    expect(conn.sent.filter(frame => JSON.stringify(frame).includes(imageBase64))).toHaveLength(1);

    conn._emit({
      jsonrpc: '2.0',
      id: llmRequest.id,
      result: {
        content: 'saw image',
        toolCalls: [],
        model: 'vision-model',
        inputTokens: 10,
        outputTokens: 2,
        stopReason: 'stop',
      },
    });
    await expect(streamPromise).resolves.toMatchObject({ content: 'saw image' });
    expect(client.getSerializedTransportStats()).toMatchObject({
      frameCount: 2,
      rpcCallCount: 2,
      byMethod: {
        'intake.screen_image': { callCount: 1 },
        'llm.chat': { callCount: 1 },
      },
    });
    expect(client.getSerializedTransportStats().serializedBytes).toBe(
      conn.sent.reduce(
        (total, frame) => total + Buffer.byteLength(JSON.stringify(frame), 'utf8'),
        0,
      ),
    );
  });

  it('explicitly resends inline bytes once when the gateway reports a retention miss', async () => {
    const imageBase64 = 'A'.repeat(4096);
    const requestScope = 'turn-inline-miss';
    const screened = client.screenImageIntake({
      imageBase64,
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope,
    });
    const screenRequest = conn.sent[0] as { id: number };
    conn._emit({
      jsonrpc: '2.0',
      id: screenRequest.id,
      result: {
        kind: 'screened',
        mode: 'enforce',
        flagged: false,
        withheld: false,
        retainedImage: {
          handle: 'expired-handle',
          requestScope,
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    await screened;

    const streamPromise = client.stream({
      systemPrompt: 'system',
      correlation: { turnId: requestScope, callType: 'chat', purpose: 'chat' },
      messages: [{
        role: 'user',
        content: [{ type: 'image', data: imageBase64, mimeType: 'image/png' }],
      }] as any,
    });
    const referencedRequest = conn.sent[1] as { id: number };
    conn._emit({
      jsonrpc: '2.0',
      id: referencedRequest.id,
      error: {
        code: GatewayErrors.INLINE_IMAGE_RETENTION_MISS,
        message: 'Gateway inline image retention miss; explicit inline image byte resend is required.',
      },
    });

    await vi.waitFor(() => expect(conn.sent).toHaveLength(3));
    const resendRequest = conn.sent[2] as { id: number; method: string; params: unknown };
    expect(resendRequest.method).toBe('llm.chat');
    expect(JSON.stringify(resendRequest.params)).toContain(imageBase64);
    conn._emit({
      jsonrpc: '2.0',
      id: resendRequest.id,
      result: {
        content: 'saw resent image',
        toolCalls: [],
        model: 'vision-model',
        inputTokens: 10,
        outputTokens: 2,
        stopReason: 'stop',
      },
    });
    await expect(streamPromise).resolves.toMatchObject({ content: 'saw resent image' });
  });

  it('keeps inline bytes on the wire when a retained handle belongs to another turn scope', async () => {
    const imageBase64 = 'B'.repeat(4096);
    const screened = client.screenImageIntake({
      imageBase64,
      mimeType: 'image/jpeg',
      originRef: 'discord:channel:message:attachment:0',
      requestScope: 'turn-a',
    });
    const screenRequest = conn.sent[0] as { id: number };
    conn._emit({
      jsonrpc: '2.0',
      id: screenRequest.id,
      result: {
        kind: 'screened',
        mode: 'enforce',
        flagged: false,
        withheld: false,
        retainedImage: {
          handle: 'turn-a-handle',
          requestScope: 'turn-a',
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    await screened;

    const streamPromise = client.stream({
      systemPrompt: 'system',
      correlation: { turnId: 'turn-b', callType: 'chat', purpose: 'chat' },
      messages: [{
        role: 'user',
        content: [{ type: 'image', data: imageBase64, mimeType: 'image/jpeg' }],
      }] as any,
    });
    const llmRequest = conn.sent[1] as { id: number; params: unknown };
    expect(JSON.stringify(llmRequest.params)).toContain(imageBase64);
    expect(JSON.stringify(llmRequest.params)).not.toContain('turn-a-handle');
    conn._emit({
      jsonrpc: '2.0',
      id: llmRequest.id,
      result: {
        content: 'scope isolated',
        toolCalls: [],
        model: 'vision-model',
        inputTokens: 10,
        outputTokens: 2,
        stopReason: 'stop',
      },
    });
    await expect(streamPromise).resolves.toMatchObject({ content: 'scope isolated' });
  });

  it('uses retained references for complete and explicitly resends bytes on a miss', async () => {
    const imageBase64 = 'C'.repeat(4096);
    const requestScope = 'turn-complete-miss';
    const screened = client.screenImageIntake({
      imageBase64,
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope,
    });
    const screenRequest = conn.sent[0] as { id: number };
    conn._emit({
      jsonrpc: '2.0',
      id: screenRequest.id,
      result: {
        kind: 'screened',
        mode: 'enforce',
        flagged: false,
        withheld: false,
        retainedImage: {
          handle: 'complete-handle',
          requestScope,
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    await screened;

    const completePromise = client.complete({
      systemPrompt: 'system',
      correlation: { turnId: requestScope, callType: 'background', purpose: 'vision' },
      messages: [{
        role: 'user',
        content: [{ type: 'image', data: imageBase64, mimeType: 'image/png' }],
      }] as any,
    }, 'vision');
    const referencedRequest = conn.sent[1] as { id: number; params: unknown };
    expect(JSON.stringify(referencedRequest.params)).toContain('complete-handle');
    expect(JSON.stringify(referencedRequest.params)).not.toContain(imageBase64);
    conn._emit({
      jsonrpc: '2.0',
      id: referencedRequest.id,
      error: {
        code: GatewayErrors.INLINE_IMAGE_RETENTION_MISS,
        message: 'Gateway inline image retention miss; explicit inline image byte resend is required.',
      },
    });

    await vi.waitFor(() => expect(conn.sent).toHaveLength(3));
    const resendRequest = conn.sent[2] as { id: number; method: string; params: unknown };
    expect(resendRequest.method).toBe('llm.complete');
    expect(JSON.stringify(resendRequest.params)).toContain(imageBase64);
    conn._emit({
      jsonrpc: '2.0',
      id: resendRequest.id,
      result: {
        content: 'complete saw resent image',
        model: 'vision-model',
        inputTokens: 10,
        outputTokens: 2,
        stopReason: 'stop',
      },
    });
    await expect(completePromise).resolves.toMatchObject({ content: 'complete saw resent image' });
  });

  it('routes chunks to the correct handler by requestId', async () => {
    const chunksA: string[] = [];
    const chunksB: string[] = [];

    // Start two concurrent streams
    const streamA = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'a' }] },
      { onText: (text) => chunksA.push(text) },
    );
    const streamB = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'b' }] },
      { onText: (text) => chunksB.push(text) },
    );

    // Both requests should have been sent — extract their requestIds
    // sent[0] is stream A's RPC request, sent[1] is stream B's RPC request
    expect(conn.sent.length).toBe(2);
    const reqA = conn.sent[0] as { id: number; params: { requestId: string } };
    const reqB = conn.sent[1] as { id: number; params: { requestId: string } };
    const requestIdA = reqA.params.requestId;
    const requestIdB = reqB.params.requestId;

    expect(requestIdA).toBeTruthy();
    expect(requestIdB).toBeTruthy();
    expect(requestIdA).not.toBe(requestIdB);

    // Simulate interleaved chunk notifications from gateway
    conn._emit({ method: 'llm.chunk', params: { requestId: requestIdA, text: 'hello-A' } });
    conn._emit({ method: 'llm.chunk', params: { requestId: requestIdB, text: 'hello-B' } });
    conn._emit({ method: 'llm.chunk', params: { requestId: requestIdA, text: ' world-A' } });
    conn._emit({ method: 'llm.chunk', params: { requestId: requestIdB, text: ' world-B' } });

    // Resolve stream A
    conn._emit({
      id: reqA.id,
      jsonrpc: '2.0',
      result: {
        content: 'hello-A world-A',
        reasoning: 'thinking-a',
        providerObservability: {
          routeKind: 'registered_model',
          requestedProvider: 'openrouter',
          requestedModel: 'test',
          backendProvider: 'openrouter',
          backendModel: 'test',
          backendApi: 'openai-completions',
          systemRole: {
            transport: 'openai_developer',
            supportsSystemRole: true,
            supportsDeveloperRole: true,
            usesOutOfBandSystemPrompt: false,
          },
          providerWireMessages: [
            { role: 'developer', source: 'system_prompt', content: 'test' },
            { role: 'user', source: 'message', content: 'a' },
          ],
        },
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
        requestId: requestIdA,
      },
    });

    // Resolve stream B
    conn._emit({
      id: reqB.id,
      jsonrpc: '2.0',
      result: {
        content: 'hello-B world-B',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
        requestId: requestIdB,
      },
    });

    const [resultA, resultB] = await Promise.all([streamA, streamB]);

    // Each handler got only its own chunks
    expect(chunksA).toEqual(['hello-A', ' world-A']);
    expect(chunksB).toEqual(['hello-B', ' world-B']);

    expect(resultA.content).toBe('hello-A world-A');
    expect(resultB.content).toBe('hello-B world-B');
    expect(resultA.reasoning).toBe('thinking-a');
    expect(resultA.providerObservability?.systemRole.transport).toBe('openai_developer');
  });

  it('routes exactly one provider first-output observation by requestId', async () => {
    const observations: Array<Record<string, unknown>> = [];
    const streamPromise = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'use a tool' }] },
      { onFirstOutput: observation => observations.push(observation) },
    );
    const req = conn.sent[0] as {
      id: number;
      params: { requestId: string; stream: boolean };
    };

    expect(req.params.stream).toBe(true);
    conn._emit({
      method: 'llm.first_output',
      params: {
        requestId: req.params.requestId,
        kind: 'tool',
        monotonicAtMs: 1_234,
        timestampMs: 5_678,
      },
    });
    conn._emit({
      method: 'llm.first_output',
      params: {
        requestId: req.params.requestId,
        kind: 'text',
        monotonicAtMs: 1_235,
        timestampMs: 5_679,
      },
    });
    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      result: {
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'memory_lookup', input: { query: 'hello' } }],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'toolUse',
      },
    });

    await streamPromise;
    expect(observations).toEqual([{
      kind: 'tool',
      monotonicAtMs: 1_234,
      timestampMs: 5_678,
    }]);
  });

  it('cleans up chunk handler after stream completes', async () => {
    const chunks: string[] = [];

    const streamPromise = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] },
      { onText: (text) => chunks.push(text) },
    );

    const req = conn.sent[0] as { id: number; params: { requestId: string } };
    const requestId = req.params.requestId;

    // Send a chunk before completion
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'before' } });

    // Complete the stream
    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      result: {
        content: 'before',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
      },
    });

    await streamPromise;

    // Send a chunk after completion — should not be routed
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'after' } });
    expect(chunks).toEqual(['before']);
  });

  it('preserves reasoning from llm.chat responses', async () => {
    const streamPromise = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] },
      { onText: () => {} },
    );

    const req = conn.sent[0] as { id: number; params: { requestId: string } };
    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      result: {
        content: 'answer',
        reasoning: 'chain of thought summary',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
      },
    });

    await expect(streamPromise).resolves.toMatchObject({
      content: 'answer',
      reasoning: 'chain of thought summary',
    });
  });

  it('normalizes all 12 model-hint fields on llm.chat RPC requests', () => {
    void client.stream(
      {
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        modelHint: {
          model: '  z-ai/glm-5  ',
          provider: '  OpenRouter  ',
          pin: false,
          maxTokens: 321.9,
          contextWindow: 120_000.8,
          thinkingEnabled: false,
          thinkingEffort: 'xhigh',
          temperature: 0.33,
          topP: 0.77,
          topK: 42.7,
          frequencyPenalty: -0.12,
          repetitionPenalty: 1.03,
        },
      },
      { onText: () => {} },
    );

    const req = conn.sent[0] as { params: Record<string, unknown> };
    expect(req.params).toMatchObject({
      model: 'z-ai/glm-5',
      provider: 'openrouter',
      pin: false,
      maxTokens: 321,
      contextWindow: 120_000,
      thinkingEnabled: false,
      thinkingEffort: 'xhigh',
      temperature: 0.33,
      topP: 0.77,
      topK: 42,
      frequencyPenalty: -0.12,
      repetitionPenalty: 1.03,
    });
  });

  it('propagates private completion telemetry without source correlation', async () => {
    const completion = client.complete(
      { systemPrompt: 'private', messages: [{ role: 'user', content: 'work' }] },
      'background',
      {
        correlation: {
          ...COMPANION_PRIVATE_BACKGROUND_TELEMETRY,
          turnId: 'source-turn',
          requestId: 'source-request',
          channelId: 'source-channel',
        },
      },
    );
    const req = conn.sent[0] as { id: number; params: Record<string, unknown> };

    expect(req.params).toMatchObject({
      purpose: 'background',
      originStage: 'companion_private.background',
      telemetryVisibility: 'companion_private',
    });
    expect(req.params).not.toHaveProperty('turnId');
    expect(req.params).not.toHaveProperty('requestId');
    expect(req.params).not.toHaveProperty('channelId');

    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      result: {
        content: 'done',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
      },
    });
    await expect(completion).resolves.toMatchObject({ content: 'done' });
  });

  it('preserves caller-owned accounting identity on llm.chat RPC requests', () => {
    void client.stream(
      {
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        accounting: {
          logicalCallId: 'llm:caller-operation',
          attempt: 3,
          retryOwner: 'caller',
        },
      },
      { onText: () => {} },
    );

    const req = conn.sent[0] as { params: Record<string, unknown> };
    expect(req.params).toMatchObject({
      accounting: {
        logicalCallId: 'llm:caller-operation',
        attempt: 3,
        retryOwner: 'caller',
      },
    });

    void client.complete({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'summarize' }],
      accounting: {
        logicalCallId: 'llm:caller-completion',
        attempt: 8,
        retryOwner: 'caller',
      },
    }, 'summary');
    const completionReq = conn.sent[1] as { params: Record<string, unknown> };
    expect(completionReq.params).toMatchObject({
      accounting: {
        logicalCallId: 'llm:caller-completion',
        attempt: 8,
        retryOwner: 'caller',
      },
    });
  });

  it('preserves canonical ICP attribution on gateway model requests', () => {
    const icpCorrelation: IcpConversationCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      peerContactId: 'contact-a',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
      messageId: 'message-1',
      requestId: 'request-1',
      chargeLane: 'companion_social',
      surface: 'companion_dm',
      costPurpose: 'tool',
      costOriginStage: 'reply',
      fatigueDecision: 'allow',
    };

    void client.stream({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      correlation: {
        callType: 'tool',
        purpose: 'tool.continuation',
        icpCorrelation,
      },
    });

    const request = conn.sent[0] as { method: string; params: Record<string, unknown> };
    expect(request).toMatchObject({
      method: 'llm.chat',
      params: {
        companionId: icpCorrelation.localCompanionId,
        conversationId: icpCorrelation.conversationId,
        rootInitiationId: icpCorrelation.rootInitiationId,
        icpCorrelation,
      },
    });
  });

  it('does not overwrite the canonical ICP charge lane with the active behavioral run lane', async () => {
    const icpCorrelation: IcpConversationCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      peerContactId: 'contact-a',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
      messageId: 'message-1',
      requestId: 'request-1',
      chargeLane: 'companion_social',
      surface: 'companion_dm',
      costPurpose: 'tool',
      costOriginStage: 'reply',
      fatigueDecision: 'allow',
    };

    await runWithChargeContext({
      chargePolicy: makeTestChargePolicyConfig(),
      lane: 'interactive',
      runId: 'interactive-icp-turn',
    }, async () => {
      void client.stream({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        correlation: {
          callType: 'tool',
          purpose: 'tool.continuation',
          icpCorrelation,
        },
      });

      const request = conn.sent[0] as { params: Record<string, unknown> };
      expect(request.params).toMatchObject({
        chargeLane: 'companion_social',
        icpCorrelation,
      });
    });
  });

  it('cleans up chunk handler after stream error', async () => {
    const chunks: string[] = [];

    const streamPromise = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] },
      {
        onText: (text) => chunks.push(text),
        onError: () => {},  // suppress unhandled error
      },
    );

    const req = conn.sent[0] as { id: number; params: { requestId: string } };
    const requestId = req.params.requestId;

    // Send a chunk before the error
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'before-error' } });

    // Send an error response
    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      error: { code: -32003, message: 'Provider error' },
    });

    await expect(streamPromise).rejects.toThrow();

    // After error, handler should be cleaned up
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'after-error' } });
    expect(chunks).toEqual(['before-error']);
  });

  it('bridges gateway budget-block telemetry before rejecting the model call', async () => {
    const onModelBudgetBlocked = vi.fn();
    client = new GatewayClient(conn.conn, 1024, { onModelBudgetBlocked });
    const streamPromise = client.stream({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'blocked' }],
    });
    const request = conn.sent[0] as { id: number };
    const event = {
      timestampMs: 1_752_500_000_000,
      reason: 'daily_budget_exceeded',
      purpose: 'chat',
      provider: 'openrouter',
      model: 'test-model',
      service: 'chat',
      process: 'agent.turn.prompt',
      estimatedRequestCostUsd: 0.1,
      budget: {
        dayKey: '2025-07-14',
        monthKey: '2025-07',
        dailySpentUsd: 1,
        dailyLimitUsd: 1,
        monthlySpentUsd: 2,
        monthlyLimitUsd: 10,
        dailyUnknownCostAttempts: 0,
        monthlyUnknownCostAttempts: 0,
      },
    };
    conn._emit({
      id: request.id,
      jsonrpc: '2.0',
      error: {
        code: GatewayErrors.MODEL_BUDGET_BLOCKED,
        message: 'budget blocked',
        data: event,
      },
    });

    await expect(streamPromise).rejects.toThrow('budget blocked');
    expect(onModelBudgetBlocked).toHaveBeenCalledWith(event);
  });

  it('decodes a strict ICP cost block without accepting partner-identifying extensions', async () => {
    const streamPromise = client.stream({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'blocked' }],
    });
    const request = conn.sent[0] as { id: number };
    const event = {
      timestampMs: 1_752_500_000_000,
      outcome: 'blocked',
      reason: 'hard_limit_exceeded',
      logicalCallId: 'logical-1',
      attempt: 1,
      conversationId: '33333333-3333-4333-8333-333333333333',
      rootInitiationId: '44444444-4444-4444-8444-444444444444',
      localCompanionId: '11111111-1111-4111-8111-111111111111',
      costPurpose: 'conversation_turn',
      costOriginStage: 'reply',
      provider: 'openrouter',
      model: 'test/model',
      routingPurpose: 'chat',
      projectedRequestCostUsd: 0.5,
      replayed: false,
    };
    conn._emit({
      id: request.id,
      jsonrpc: '2.0',
      error: {
        code: GatewayErrors.ICP_CONVERSATION_COST_BLOCKED,
        message: 'cost blocked',
        data: event,
      },
    });
    await expect(streamPromise).rejects.toMatchObject({
      code: 'icp_conversation_cost_blocked',
      event,
    });

    const malformedPromise = client.stream({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'blocked again' }],
    });
    const malformedRequest = conn.sent[1] as { id: number };
    conn._emit({
      id: malformedRequest.id,
      jsonrpc: '2.0',
      error: {
        code: GatewayErrors.ICP_CONVERSATION_COST_BLOCKED,
        message: 'opaque malformed block',
        data: { ...event, peerContactId: 'must-not-cross' },
      },
    });
    await expect(malformedPromise).rejects.not.toMatchObject({
      code: 'icp_conversation_cost_blocked',
    });

    const mismatchedProjectionPromise = client.stream({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'blocked with mismatched projection' }],
    });
    const mismatchedProjectionRequest = conn.sent[2] as { id: number };
    conn._emit({
      id: mismatchedProjectionRequest.id,
      jsonrpc: '2.0',
      error: {
        code: GatewayErrors.ICP_CONVERSATION_COST_BLOCKED,
        message: 'opaque mismatched projection block',
        data: {
          ...event,
          projection: {
            conversationId: '55555555-5555-4555-8555-555555555555',
            rootInitiationId: event.rootInitiationId,
            actualCostUsd: 0.5,
            pendingProjectedCostUsd: 0,
            projectedTotalCostUsd: 0.5,
            warningThresholdUsd: 0.4,
            hardLimitUsd: 0.5,
            remainingToHardLimitUsd: 0,
            actualAttemptCount: 1,
            unknownCostAttemptCount: 0,
            pendingReservationCount: 0,
            staleReservationCount: 0,
            settledReservationCount: 1,
            attributedCompanionCount: 1,
            enforcementState: 'hard_stop',
          },
        },
      },
    });
    await expect(mismatchedProjectionPromise).rejects.not.toMatchObject({
      code: 'icp_conversation_cost_blocked',
    });
  });

  it.each([
    ['empty budget', { budget: {} }],
    ['bogus reason', { reason: 'invented_budget_reason' }],
    ['non-finite value', { estimatedRequestCostUsd: Number.POSITIVE_INFINITY }],
    ['unknown field', { shadowBudget: true }],
  ])('does not bridge malformed gateway budget telemetry with %s', async (_label, override) => {
    const onModelBudgetBlocked = vi.fn();
    client = new GatewayClient(conn.conn, 1024, { onModelBudgetBlocked });
    const streamPromise = client.stream({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'blocked' }],
    });
    const request = conn.sent[0] as { id: number };
    const validBudget = {
      dayKey: '2025-07-14',
      monthKey: '2025-07',
      dailySpentUsd: 1,
      dailyLimitUsd: 1,
      monthlySpentUsd: 2,
      monthlyLimitUsd: 10,
      dailyUnknownCostAttempts: 0,
      monthlyUnknownCostAttempts: 0,
    };
    const event = {
      timestampMs: 1_752_500_000_000,
      reason: 'daily_budget_exceeded',
      purpose: 'chat',
      provider: 'openrouter',
      model: 'test-model',
      service: 'chat',
      process: 'agent.turn.prompt',
      estimatedRequestCostUsd: 0.1,
      budget: validBudget,
      ...override,
    };
    conn._emit({
      id: request.id,
      jsonrpc: '2.0',
      error: {
        code: GatewayErrors.MODEL_BUDGET_BLOCKED,
        message: 'budget blocked',
        data: event,
      },
    });

    await expect(streamPromise).rejects.toThrow('budget blocked');
    expect(onModelBudgetBlocked).not.toHaveBeenCalled();
  });

  it('routes model discovery calls through gateway RPC', async () => {
    const discoverPromise = client.getAvailableModels();
    const discoverReq = conn.sent[0] as { id: number; method: string };
    expect(discoverReq.method).toBe('llm.discover_models');
    conn._emit({
      id: discoverReq.id,
      jsonrpc: '2.0',
      result: {
        models: [{ id: 'model-1' }],
      },
    });
    const discoveredModels: DiscoveredModel[] = await discoverPromise;
    expect(discoveredModels).toEqual([{ id: 'model-1' }]);

    const invalidatePromise = client.invalidateModelDiscoveryCache();
    const invalidateReq = conn.sent[1] as { id: number; method: string };
    expect(invalidateReq.method).toBe('llm.invalidate_model_discovery');
    conn._emit({
      id: invalidateReq.id,
      jsonrpc: '2.0',
      result: {
        success: true,
      },
    });
    await expect(invalidatePromise).resolves.toBeUndefined();
  });

  it('routes embedding calls through gateway RPC and returns typed vectors', async () => {
    const batchPromise = client.embedBatch(['alpha', 'beta']);
    const batchReq = conn.sent[0] as {
      id: number;
      method: string;
      params: { texts: string[] };
    };
    expect(batchReq.method).toBe('llm.embed');
    expect(batchReq.params.texts).toEqual(['alpha', 'beta']);
    conn._emit({
      id: batchReq.id,
      jsonrpc: '2.0',
      result: {
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      },
    });
    const batch = await batchPromise;
    expect(batch).toHaveLength(2);
    expect(batch[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(batch[0] ?? [])).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
    expect(Array.from(batch[1] ?? [])).toEqual([
      expect.closeTo(0.4, 5),
      expect.closeTo(0.5, 5),
      expect.closeTo(0.6, 5),
    ]);

    const singlePromise = client.embed('gamma');
    const singleReq = conn.sent[1] as {
      id: number;
      method: string;
      params: { texts: string[] };
    };
    expect(singleReq.method).toBe('llm.embed');
    expect(singleReq.params.texts).toEqual(['gamma']);
    conn._emit({
      id: singleReq.id,
      jsonrpc: '2.0',
      result: {
        embeddings: [
          [0.7, 0.8, 0.9],
        ],
      },
    });
    await expect(singlePromise).resolves.toBeInstanceOf(Float32Array);
    await expect(singlePromise).resolves.toSatisfy((value) => (
      Array.from(value).every((entry, index) => Math.abs(entry - [0.7, 0.8, 0.9][index]!) < 1e-5)
    ));
  });

  it('self-stamps tenant and request attribution on gateway embedding calls', async () => {
    const attributedClient = new GatewayClient(conn.conn, 1024, {
      companionId: '11111111-1111-4111-8111-111111111111',
    });
    const batchPromise = runWithRequestContext({
      sessionId: 'session-1',
      requestId: 'request-1',
      channelId: 'shard:shard-1',
      channelType: 'api',
      callType: 'memory',
      purpose: 'embedding',
      chargeLane: 'shard',
      chargeSurface: 'externalEmbedding',
      chargeEventId: 'charge-event-1',
      chargeRunId: 'run-1',
      chargeRootRunId: 'root-run-1',
      shardId: 'shard-1',
      workloadType: 'shard',
      workloadId: 'shard-1',
    }, async () => await attributedClient.embedBatch(['alpha']));
    const request = conn.sent[0] as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(request).toMatchObject({
      method: 'llm.embed',
      params: {
        companionId: '11111111-1111-4111-8111-111111111111',
        sessionId: 'session-1',
        requestId: 'request-1',
        channelId: 'shard:shard-1',
        channelType: 'api',
        chargeLane: 'shard',
        chargeSurface: 'externalEmbedding',
        chargeEventId: 'charge-event-1',
        chargeRunId: 'run-1',
        chargeRootRunId: 'root-run-1',
        shardId: 'shard-1',
        workloadType: 'shard',
        workloadId: 'shard-1',
        texts: ['alpha'],
      },
    });
    conn._emit({
      id: request.id,
      jsonrpc: '2.0',
      result: { embeddings: [[0.1, 0.2]] },
    });
    await expect(batchPromise).resolves.toHaveLength(1);
  });
});

describe('GatewayClient per-companion model selection transport (23pp)', () => {
  const selection = {
    chat: 'big-brain-opus',
    background: 'economy-worker',
    vision: 'vision-flash',
    longContext: 'long-haul',
  } as const;

  function makeSelectionClient() {
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, { modelPurposeSelection: selection });
    return { conn, client };
  }

  function respond(conn: ReturnType<typeof createMockConnection>, index = 0): void {
    const request = conn.sent[index] as { id: number };
    conn._emit({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: 'ok',
        toolCalls: [],
        model: 'served-model',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
      },
    });
  }

  it('transports the chat selection slot on an interactive streamed turn', async () => {
    const { conn, client } = makeSelectionClient();
    const promise = client.stream({
      systemPrompt: 'system',
      messages: [],
      correlation: { turnId: 't1', callType: 'chat', purpose: 'chat' },
    });
    const request = conn.sent[0] as { method: string; params: Record<string, unknown> };
    expect(request.method).toBe('llm.chat');
    expect(request.params.slotKey).toBe('big-brain-opus');
    respond(conn);
    await promise;
  });

  it('routes a non-streamed chat-purpose completion to the background selection (lane parity with LLMClient)', async () => {
    const { conn, client } = makeSelectionClient();
    const promise = client.complete({ systemPrompt: 'system', messages: [] }, 'chat');
    const request = conn.sent[0] as { method: string; params: Record<string, unknown> };
    expect(request.method).toBe('llm.complete');
    expect(request.params.slotKey).toBe('economy-worker');
    respond(conn);
    await promise;
  });

  it('transports the vision selection slot for vision completions', async () => {
    const { conn, client } = makeSelectionClient();
    const promise = client.complete({ systemPrompt: 'system', messages: [] }, 'vision');
    const request = conn.sent[0] as { params: Record<string, unknown> };
    expect(request.params.slotKey).toBe('vision-flash');
    respond(conn);
    await promise;
  });

  it('resolves the context lane through longContext before background', async () => {
    const { conn, client } = makeSelectionClient();
    const promise = client.complete({ systemPrompt: 'system', messages: [] }, 'context');
    const request = conn.sent[0] as { params: Record<string, unknown> };
    expect(request.params.slotKey).toBe('long-haul');
    respond(conn);
    await promise;
  });

  it('suppresses the selection when the caller pins an explicit model hint', async () => {
    const { conn, client } = makeSelectionClient();
    const promise = client.complete({
      systemPrompt: 'system',
      messages: [],
      modelHint: { model: 'openrouter:explicit/override' },
    }, 'vision');
    const request = conn.sent[0] as { params: Record<string, unknown> };
    expect(request.params.slotKey).toBeUndefined();
    expect(request.params.model).toBe('explicit/override');
    respond(conn);
    await promise;
  });

  it('omits slotKey for lanes without a selection', async () => {
    const { conn, client } = makeSelectionClient();
    const promise = client.complete({ systemPrompt: 'system', messages: [] }, 'memory');
    const request = conn.sent[0] as { params: Record<string, unknown> };
    expect(request.params.slotKey).toBeUndefined();
    respond(conn);
    await promise;
  });

  it('omits slotKey entirely when the client has no selection (byte-identical default)', async () => {
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024);
    const promise = client.complete({ systemPrompt: 'system', messages: [] }, 'chat');
    const request = conn.sent[0] as { params: Record<string, unknown> };
    expect('slotKey' in request.params).toBe(false);
    respond(conn);
    await promise;
  });
});

describe('GatewayClient authenticated identification', () => {
  it('sends the companion-bound agent proof and keeps the worker proof off the agent frame', async () => {
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, {
      companionId: '11111111-1111-4111-8111-111111111111',
      companionAuthToken: 'v1.agent-proof',
      sessionIntegrityAuthToken: 'v1.worker-proof',
    });

    const identified = client.identifyAsAgent();
    const request = conn.sent[0] as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(request).toMatchObject({
      method: 'gateway.client.identify',
      params: {
        role: 'agent',
        companionId: '11111111-1111-4111-8111-111111111111',
        authToken: 'v1.agent-proof',
      },
    });
    expect(JSON.stringify(request)).not.toContain('worker-proof');
    conn._emit({ jsonrpc: '2.0', id: request.id, result: { success: true } });
    await expect(identified).resolves.toBeUndefined();
  });

  it('publishes only the bounded posture envelope after deterministic runtime wiring', async () => {
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, {
      companionId: TEST_COMPANION_ID,
    });
    const started = client.startFleetPostureReporting(() => ({
      schemaVersion: 1,
      updatedAt: 1_800_000_000_000,
      charge: { state: 'pressured', utilizationPercent: 25 },
      fatigue: { state: 'clear', utilizationPercent: 0 },
    }));
    const request = conn.sent[0] as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(request).toMatchObject({
      method: 'gateway.client.health',
      params: {
        posture: {
          schemaVersion: 1,
          charge: { state: 'pressured', utilizationPercent: 25 },
          fatigue: { state: 'clear', utilizationPercent: 0 },
        },
      },
    });
    expect(JSON.stringify(request.params)).not.toContain(TEST_COMPANION_ID);
    conn._emit({ jsonrpc: '2.0', id: request.id, result: { success: true } });
    await expect(started).resolves.toBeUndefined();
    client.destroy();
  });
});

describe('GatewayClient reverse RPC (onHandleMessage)', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('serves only a strictly parsed exact contact-authority snapshot', async () => {
    const handler = vi.fn(async (request) => ({
      schemaVersion: 1 as const,
      contactId: request.contactId,
      channel: 'discord' as const,
      providerSubjectId: request.providerSubjectId,
      identityVersion: 3,
      verificationId: '00000000-0000-4000-8000-000000000301',
      verificationDigest: 'a'.repeat(64),
      contactAuthorityVersion: 5,
      ownershipState: 'verified' as const,
      restoreState: 'live' as const,
    }));
    client.onContactAuthoritySnapshot(handler);

    conn._emit({
      jsonrpc: '2.0',
      id: 41,
      method: 'contact.authority.snapshot',
      params: {
        contactId: 'contact-one',
        providerSubjectId: '123456789012345679',
      },
    });
    await vi.waitFor(() => expect(getRpcResponse(conn.sent, 41)?.result).toMatchObject({
      contactId: 'contact-one',
      providerSubjectId: '123456789012345679',
      contactAuthorityVersion: 5,
    }));
    expect(handler).toHaveBeenCalledWith({
      contactId: 'contact-one',
      providerSubjectId: '123456789012345679',
    });

    conn._emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'contact.authority.snapshot',
      params: {
        contactId: 'contact-one',
        providerSubjectId: '123456789012345679',
        companionId: 'caller-controlled',
      },
    });
    await vi.waitFor(() => expect(getRpcResponse(conn.sent, 42)?.error).toBeDefined());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('receives and processes voice.handleMessage requests from gateway', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: 'voice response',
      channelId: 'discord-voice:123',
      metadata: { model: 'test-model', inputTokens: 10, outputTokens: 5, durationMs: 500 },
    });

    client.onHandleMessage(handler);

    // Simulate gateway sending an RPC request (has 'id' AND 'method')
    conn._emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'voice.handleMessage',
      params: {
        message: {
          id: 'voice-1',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'TestUser',
          content: 'hello voice',
          timestamp: '2025-01-01T00:00:00.000Z',
          routing: TEST_GATEWAY_ROUTING,
        },
      },
    });

    // Wait for async handling
    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    const handledMsg = handler.mock.calls[0][0];
    expect(handledMsg.content).toBe('hello voice');
    // Timestamp should be deserialized to Date
    expect(handledMsg.timestamp).toBeInstanceOf(Date);

    // The response should have been sent back
    const response = conn.sent.find(
      (msg: any) => msg.id === 42 && 'result' in msg,
    ) as any;
    expect(response).toBeDefined();
    expect(response.result.content).toBe('voice response');
    expect(response.result.model).toBe('test-model');
    expect(response.result.durationMs).toBe(500);
  });

  it('assembles voice TTFA on the agent bus from gateway-process RPC stages', async () => {
    const agentEventBus = new EventBus();
    const tracker = new TurnPerformanceTracker();
    agentEventBus.on('agent.turn.performance', event => tracker.observe(event));
    client.onTurnPerformance(async (event) => {
      await agentEventBus.emit('agent.turn.performance', event);
    });

    const sendStage = (id: number, stage: 'speech_end' | 'first_audible_playback', monotonicAtMs: number) => {
      conn._emit({
        jsonrpc: '2.0',
        id,
        method: 'telemetry.turn.performance',
        params: {
          event: {
            schemaVersion: 1,
            traceId: 'voice-split-1',
            stage,
            monotonicAtMs,
            timestampMs: monotonicAtMs,
            companionId: 'companion',
            channelId: 'voice-channel-1',
            channelType: 'discord-voice',
          },
        },
      });
    };

    sendStage(80, 'speech_end', 1_000);
    sendStage(81, 'first_audible_playback', 1_075);
    await vi.waitFor(() => {
      expect(getRpcResponse(conn.sent, 80)?.result).toEqual({ accepted: true });
      expect(getRpcResponse(conn.sent, 81)?.result).toEqual({ accepted: true });
    });

    const ttfa = tracker.snapshot().series.find(series => (
      series.metric === 'ttfa' && Object.keys(series.dimensions).length === 0
    ));
    expect(ttfa?.percentiles).toEqual({ samples: 1, p50Ms: 75, p95Ms: 75, p99Ms: 75 });

    conn._emit({
      jsonrpc: '2.0',
      id: 82,
      method: 'telemetry.turn.performance',
      params: {
        event: {
          schemaVersion: 1,
          traceId: 'voice-private',
          stage: 'speech_end',
          monotonicAtMs: 2_000,
          timestampMs: 2_000,
          transcript: 'must not cross processes',
        },
      },
    });
    await vi.waitFor(() => expect(getRpcResponse(conn.sent, 82)?.error).toBeDefined());
  });

  it('fails closed when voice.handleMessage omits validated gateway routing', async () => {
    const handler = vi.fn();
    client.onHandleMessage(handler);

    conn._emit({
      jsonrpc: '2.0',
      id: 43,
      method: 'voice.handleMessage',
      params: {
        message: {
          id: 'voice-unrouted',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'TestUser',
          content: 'hello voice',
          timestamp: '2025-01-01T00:00:00.000Z',
          routing: {},
        },
      },
    });

    await new Promise(r => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
    expect(conn.sent).toContainEqual(expect.objectContaining({
      id: 43,
      error: expect.objectContaining({
        message: expect.stringContaining('routing.gateway'),
      }),
    }));
  });

  it('fails closed when reverse-message routing targets another companion', async () => {
    const boundConn = createMockConnection();
    const boundClient = new GatewayClient(boundConn.conn, 1024, {
      companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
    });
    const handler = vi.fn();
    boundClient.onHandleMessage(handler);

    boundConn._emit({
      jsonrpc: '2.0',
      id: 44,
      method: 'voice.handleMessage',
      params: {
        message: {
          id: 'voice-misrouted',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'TestUser',
          content: 'hello voice',
          timestamp: '2025-01-01T00:00:00.000Z',
          routing: {
            gateway: { schemaVersion: 1, companionId: '22222222-2222-4222-8222-222222222222' },
          },
        },
      },
    });

    await new Promise(r => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
    expect(boundConn.sent).toContainEqual(expect.objectContaining({
      id: 44,
      error: expect.objectContaining({
        message: expect.stringContaining('does not match this gateway client binding'),
      }),
    }));
    boundClient.destroy();
  });

  it('rejects an unrouted voice.stream.start before ACK or stream-state creation', async () => {
    client.onHandleMessage(vi.fn());
    const message = {
      id: 'voice-stream-unrouted',
      channelId: 'discord-voice:123',
      channelType: 'discord',
      authorId: 'user-1',
      authorName: 'TestUser',
      content: '',
      timestamp: '2025-01-01T00:00:00.000Z',
    };

    conn._emit({
      jsonrpc: '2.0',
      id: 45,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-unrouted',
        streamId: 'stream-unrouted',
        sequence: 0,
        message: { ...message, routing: {} },
      },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(getRpcResponse(conn.sent, 45)).toMatchObject({
      error: { message: expect.stringContaining('routing.gateway') },
    });

    // Reusing the same key succeeds once the envelope is valid, proving the
    // rejected frame was never ACKed or inserted into voiceStreams.
    conn._emit({
      jsonrpc: '2.0',
      id: 46,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-unrouted',
        streamId: 'stream-unrouted',
        sequence: 0,
        message: { ...message, routing: TEST_GATEWAY_ROUTING },
      },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(getRpcResponse(conn.sent, 46)).toMatchObject({
      result: { accepted: true, sequence: 0 },
    });
  });

  it('rejects a cross-companion voice.stream.start before ACK or stream-state creation', async () => {
    const boundConn = createMockConnection();
    const boundClient = new GatewayClient(boundConn.conn, 1024, {
      companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
    });
    boundClient.onHandleMessage(vi.fn());
    const message = {
      id: 'voice-stream-misrouted',
      channelId: 'discord-voice:123',
      channelType: 'discord',
      authorId: 'user-1',
      authorName: 'TestUser',
      content: '',
      timestamp: '2025-01-01T00:00:00.000Z',
    };

    boundConn._emit({
      jsonrpc: '2.0',
      id: 47,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-misrouted',
        streamId: 'stream-misrouted',
        sequence: 0,
        message: {
          ...message,
          routing: { gateway: { schemaVersion: 1, companionId: '22222222-2222-4222-8222-222222222222' } },
        },
      },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(getRpcResponse(boundConn.sent, 47)).toMatchObject({
      error: { message: expect.stringContaining('does not match this gateway client binding') },
    });

    boundConn._emit({
      jsonrpc: '2.0',
      id: 48,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-misrouted',
        streamId: 'stream-misrouted',
        sequence: 0,
        message: {
          ...message,
          routing: {
            gateway: { schemaVersion: 1, companionId: '11111111-1111-4111-8111-111111111111' },
          },
        },
      },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(getRpcResponse(boundConn.sent, 48)).toMatchObject({
      result: { accepted: true, sequence: 0 },
    });
    boundClient.destroy();
  });

  it('handles voice.stream.start/chunk/end reverse RPC flow', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: 'assembled response',
      channelId: 'discord-voice:123',
      metadata: { model: 'voice-model', inputTokens: 10, outputTokens: 4, durationMs: 250 },
    });
    client.onHandleMessage(handler);

    conn._emit({
      jsonrpc: '2.0',
      id: 100,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-1',
        streamId: 'stream-1',
        sequence: 0,
        metadata: { format: 'text' },
        message: {
          id: 'voice-1',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'Voice User',
          content: '',
          timestamp: '2025-01-01T00:00:00.000Z',
          routing: TEST_GATEWAY_ROUTING,
        },
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 101,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-1',
        streamId: 'stream-1',
        sequence: 1,
        text: 'hello ',
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 102,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-1',
        streamId: 'stream-1',
        sequence: 2,
        text: 'voice',
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 103,
      method: 'voice.stream.end',
      params: {
        correlationId: 'corr-1',
        streamId: 'stream-1',
        sequence: 3,
      },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].content).toBe('hello voice');
    expect(handler.mock.calls[0][0].timestamp).toBeInstanceOf(Date);

    expect(getRpcResponse(conn.sent, 100).result.accepted).toBe(true);
    expect(getRpcResponse(conn.sent, 101).result.accepted).toBe(true);
    expect(getRpcResponse(conn.sent, 102).result.accepted).toBe(true);
    expect(getRpcResponse(conn.sent, 103).result.content).toBe('assembled response');
  });

  it('dispatches the renamed voice.transcript.begin/chunk/end names to the same handlers (mmo9.8.6)', async () => {
    // mmo9.8.6: the inbound transcript-chunking family was renamed
    // voice.stream.* -> voice.transcript.*. The agent registers BOTH names on the
    // same handlers for version-skew safety. The legacy names are covered by the
    // test above; this asserts the new names reach the identical handler.
    const handler = vi.fn().mockResolvedValue({
      content: 'assembled response',
      channelId: 'discord-voice:123',
      metadata: { model: 'voice-model', inputTokens: 10, outputTokens: 4, durationMs: 250 },
    });
    client.onHandleMessage(handler);

    conn._emit({
      jsonrpc: '2.0',
      id: 110,
      method: 'voice.transcript.begin',
      params: {
        correlationId: 'corr-t1',
        streamId: 'stream-t1',
        sequence: 0,
        metadata: { format: 'text' },
        message: {
          id: 'voice-t1',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'Voice User',
          content: '',
          timestamp: '2025-01-01T00:00:00.000Z',
          routing: TEST_GATEWAY_ROUTING,
        },
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 111,
      method: 'voice.transcript.chunk',
      params: {
        correlationId: 'corr-t1',
        streamId: 'stream-t1',
        sequence: 1,
        text: 'hello ',
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 112,
      method: 'voice.transcript.chunk',
      params: {
        correlationId: 'corr-t1',
        streamId: 'stream-t1',
        sequence: 2,
        text: 'voice',
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 113,
      method: 'voice.transcript.end',
      params: {
        correlationId: 'corr-t1',
        streamId: 'stream-t1',
        sequence: 3,
      },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].content).toBe('hello voice');
    expect(handler.mock.calls[0][0].timestamp).toBeInstanceOf(Date);

    expect(getRpcResponse(conn.sent, 110).result.accepted).toBe(true);
    expect(getRpcResponse(conn.sent, 111).result.accepted).toBe(true);
    expect(getRpcResponse(conn.sent, 112).result.accepted).toBe(true);
    expect(getRpcResponse(conn.sent, 113).result.content).toBe('assembled response');
  });

  it('cancels a voice stream under the renamed voice.transcript.cancel name (mmo9.8.6 barge-in)', async () => {
    // The barge-in cancel path must be identical after the rename: a
    // voice.transcript.cancel keyed off correlationId+streamId aborts the
    // in-flight turn exactly as voice.stream.cancel did.
    const handler = vi.fn().mockResolvedValue({
      content: 'should not happen',
      channelId: 'discord-voice:123',
      metadata: { model: 'voice-model', inputTokens: 1, outputTokens: 1, durationMs: 1 },
    });
    client.onHandleMessage(handler);

    conn._emit({
      jsonrpc: '2.0',
      id: 210,
      method: 'voice.transcript.begin',
      params: {
        correlationId: 'corr-t-cancel',
        streamId: 'stream-t-cancel',
        sequence: 0,
        message: {
          id: 'voice-t2',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'Voice User',
          content: '',
          timestamp: '2025-01-01T00:00:00.000Z',
          routing: TEST_GATEWAY_ROUTING,
        },
      },
    });
    await new Promise(r => setTimeout(r, 10));
    conn._emit({
      jsonrpc: '2.0',
      id: 211,
      method: 'voice.transcript.chunk',
      params: {
        correlationId: 'corr-t-cancel',
        streamId: 'stream-t-cancel',
        sequence: 1,
        text: 'partial',
      },
    });
    await new Promise(r => setTimeout(r, 10));
    conn._emit({
      jsonrpc: '2.0',
      id: 212,
      method: 'voice.transcript.cancel',
      params: {
        correlationId: 'corr-t-cancel',
        streamId: 'stream-t-cancel',
        sequence: 2,
        reason: 'interrupted',
      },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(getRpcResponse(conn.sent, 212).result.cancelled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it('supports voice stream cancellation', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: 'should not happen',
      channelId: 'discord-voice:123',
      metadata: { model: 'voice-model', inputTokens: 1, outputTokens: 1, durationMs: 1 },
    });
    client.onHandleMessage(handler);

    conn._emit({
      jsonrpc: '2.0',
      id: 200,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-cancel',
        streamId: 'stream-cancel',
        sequence: 0,
        message: {
          id: 'voice-2',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'Voice User',
          content: '',
          timestamp: '2025-01-01T00:00:00.000Z',
          routing: TEST_GATEWAY_ROUTING,
        },
      },
    });
    await new Promise(r => setTimeout(r, 10));
    conn._emit({
      jsonrpc: '2.0',
      id: 201,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-cancel',
        streamId: 'stream-cancel',
        sequence: 1,
        text: 'partial',
      },
    });
    await new Promise(r => setTimeout(r, 10));
    conn._emit({
      jsonrpc: '2.0',
      id: 202,
      method: 'voice.stream.cancel',
      params: {
        correlationId: 'corr-cancel',
        streamId: 'stream-cancel',
        sequence: 2,
        reason: 'interrupted',
      },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(getRpcResponse(conn.sent, 202).result.cancelled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it('aborts the in-flight model turn when voice.stream.cancel lands AFTER dispatch (mmo9.6.1)', async () => {
    // Regression: before mmo9.6.1, handleVoiceStreamCancel only flipped
    // state.cancelled/deleted state, so a barge-in that arrived once the model
    // turn was already dispatched (via handleVoiceStreamEnd) never reached the
    // running turn. This asserts the cancel now aborts the in-flight dispatch's
    // AbortSignal (agent turn) AND clears transport state (gateway state).
    let capturedOptions: { signal?: AbortSignal; cancellationId?: string } | undefined;
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let sawAbort = false;
    const handler = vi.fn(async (_message: unknown, options?: { signal?: AbortSignal; cancellationId?: string }) => {
      capturedOptions = options;
      options?.signal?.addEventListener('abort', () => { sawAbort = true; });
      await handlerGate;
      return {
        content: 'late-and-unused',
        channelId: 'discord-voice:123',
        metadata: { model: 'voice-model', inputTokens: 1, outputTokens: 1, durationMs: 1 },
      };
    });
    client.onHandleMessage(handler);

    conn._emit({
      jsonrpc: '2.0',
      id: 300,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-late',
        streamId: 'stream-late',
        sequence: 0,
        message: {
          id: 'voice-late',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'Voice User',
          content: '',
          timestamp: '2025-01-01T00:00:00.000Z',
          routing: { ...TEST_GATEWAY_ROUTING, cancellationId: 'cancel-voice-late' },
        },
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 301,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-late',
        streamId: 'stream-late',
        sequence: 1,
        text: 'hello there',
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 302,
      method: 'voice.stream.end',
      params: {
        correlationId: 'corr-late',
        streamId: 'stream-late',
        sequence: 2,
      },
    });

    await new Promise(r => setTimeout(r, 20));

    // The model turn was dispatched, carrying the transport identity + signal.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(capturedOptions?.cancellationId).toBe('cancel-voice-late');
    expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedOptions?.signal?.aborted).toBe(false);

    // Barge-in AFTER dispatch.
    conn._emit({
      jsonrpc: '2.0',
      id: 303,
      method: 'voice.stream.cancel',
      params: {
        correlationId: 'corr-late',
        streamId: 'stream-late',
        sequence: 3,
        reason: 'barge-in',
      },
    });

    await new Promise(r => setTimeout(r, 10));

    // Agent turn: the in-flight dispatch's signal is aborted (pre-fix: never).
    expect(sawAbort).toBe(true);
    expect(capturedOptions?.signal?.aborted).toBe(true);
    // Gateway state: cancel acknowledged and stream state cleared.
    expect(getRpcResponse(conn.sent, 303).result.cancelled).toBe(true);

    releaseHandler();
    await new Promise(r => setTimeout(r, 10));

    // A repeat cancel for the now-cleared stream is a safe no-op (stale-safe).
    conn._emit({
      jsonrpc: '2.0',
      id: 304,
      method: 'voice.stream.cancel',
      params: {
        correlationId: 'corr-late',
        streamId: 'stream-late',
        sequence: 4,
        reason: 'barge-in',
      },
    });
    await new Promise(r => setTimeout(r, 10));
    expect(getRpcResponse(conn.sent, 304).result.cancelled).toBe(false);
  });

  it('applies drop_newest queue policy for voice chunks', async () => {
    const localConn = createMockConnection();
    const localClient = new GatewayClient(localConn.conn, 1024, {
      voiceStreamQueueSize: 1,
      voiceStreamOverflowPolicy: 'drop_newest',
    });
    const handler = vi.fn().mockResolvedValue({
      content: 'ok',
      channelId: 'discord-voice:123',
      metadata: { model: 'voice-model', inputTokens: 1, outputTokens: 1, durationMs: 1 },
    });
    localClient.onHandleMessage(handler);

    localConn._emit({
      jsonrpc: '2.0',
      id: 300,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-drop',
        streamId: 'stream-drop',
        sequence: 0,
        message: {
          id: 'voice-3',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'Voice User',
          content: '',
          timestamp: '2025-01-01T00:00:00.000Z',
          routing: TEST_GATEWAY_ROUTING,
        },
      },
    });
    await new Promise(r => setTimeout(r, 10));
    localConn._emit({
      jsonrpc: '2.0',
      id: 301,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-drop',
        streamId: 'stream-drop',
        sequence: 1,
        text: 'first',
      },
    });
    await new Promise(r => setTimeout(r, 10));
    localConn._emit({
      jsonrpc: '2.0',
      id: 302,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-drop',
        streamId: 'stream-drop',
        sequence: 2,
        text: 'second',
      },
    });
    await new Promise(r => setTimeout(r, 10));
    localConn._emit({
      jsonrpc: '2.0',
      id: 303,
      method: 'voice.stream.end',
      params: {
        correlationId: 'corr-drop',
        streamId: 'stream-drop',
        sequence: 3,
      },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].content).toBe('first');
    const droppedChunkResp = getRpcResponse(localConn.sent, 302);
    expect(droppedChunkResp).toBeDefined();
    expect(droppedChunkResp.result.accepted).toBe(false);
    expect(getRpcResponse(localConn.sent, 303).result.droppedChunks).toBe(1);
    localClient.destroy();
  });

  it('chunk routing still works after refactor', async () => {
    const chunks: string[] = [];

    const streamPromise = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] },
      { onText: (text) => chunks.push(text) },
    );

    const req = conn.sent[0] as { id: number; params: { requestId: string } };
    const requestId = req.params.requestId;

    // Chunk should still be routed correctly via handleChunkNotification
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'chunk-1' } });

    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      result: {
        content: 'chunk-1',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
      },
    });

    const result = await streamPromise;
    expect(chunks).toEqual(['chunk-1']);
    expect(result.content).toBe('chunk-1');
  });

  it('discord.message notifications still work after refactor', () => {
    const messages: unknown[] = [];
    client.onDiscordMessage((msg) => messages.push(msg));

    conn._emit({
      method: 'discord.message',
      params: {
        message: {
          id: 'msg-1',
          channelId: 'ch-1',
          content: 'test notification',
        },
      },
    });

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).content).toBe('test notification');
  });

  it('owns rejected async companion notification handlers without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      client.onCompanionMessage(async () => {
        throw new Error('durable dedupe lookup failed');
      });

      conn._emit({
        method: 'companion.message',
        params: {
          message: {
            id: 'companion-async-rejection',
            channelId: 'companion-dm:comp-a:comp-b',
            content: 'test notification',
          },
        },
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('accepts only coarse Garden queue-change notifications', () => {
    const queues: string[] = [];
    client.onGardenQueueChanged((queue) => queues.push(queue));

    conn._emit({
      method: 'garden.queue.changed',
      params: { queue: 'confirmations', entryId: 'must-not-cross' },
    });
    conn._emit({
      method: 'garden.queue.changed',
      params: { queue: 'unknown-queue' },
    });

    expect(queues).toEqual(['confirmations']);
  });

  it('routes companion delivery failure notifications to their observe-only handler', () => {
    const failures: unknown[] = [];
    client.onCompanionDeliveryFailure((failure) => failures.push(failure));

    conn._emit({
      method: 'companion.message.delivery_failure',
      params: {
        channelId: 'companion-dm:comp-a:comp-b',
        messageId: 'companion-1',
        reportingCompanionId: 'comp-b',
        reason: 'processing_failed',
        reportedAt: '2026-07-09T18:00:00.000Z',
      },
    });

    expect(failures).toEqual([expect.objectContaining({
      messageId: 'companion-1',
      reportingCompanionId: 'comp-b',
      reason: 'processing_failed',
    })]);
  });

  it('stamps correlated companion retries with a deterministic transport message id', async () => {
    const correlation: IcpConversationCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      peerContactId: 'contact-a',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
      messageId: 'companion-initiation-source',
      requestId: 'companion-initiation-source',
      chargeLane: 'companion_social',
      surface: 'companion_dm',
      costPurpose: 'conversation_turn',
      costOriginStage: 'reply',
      fatigueDecision: 'allow',
    };
    const sendPromise = client.companionSend(
      correlation.channelId,
      'durable reply',
      'Selene',
      correlation,
    );
    const request = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };

    expect(request).toMatchObject({
      method: 'companion.message.send',
      params: {
        messageId: `companion-reply-${correlation.localCompanionId}-${correlation.turnId}`,
        correlation,
        replyToMessageId: correlation.messageId,
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        channelId: correlation.channelId,
        messageId: request.params.messageId,
        deliveredTo: [correlation.peerCompanionId],
        skippedOffline: [],
      },
    });
    await expect(sendPromise).resolves.toMatchObject({ messageId: request.params.messageId });
  });

  it('sends structured companion failure reports through the gateway RPC', async () => {
    const reportPromise = client.companionReportFailure({
      channelId: 'companion-dm:comp-a:comp-b',
      messageId: 'companion-1',
      reason: 'reply_delivery_failed',
    });
    const request = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };

    expect(request).toMatchObject({
      method: 'companion.message.report_failure',
      params: {
        channelId: 'companion-dm:comp-a:comp-b',
        messageId: 'companion-1',
        reason: 'reply_delivery_failed',
      },
    });
    conn._emit({ jsonrpc: '2.0', id: request.id, result: { reportedTo: 'comp-a' } });
    await expect(reportPromise).resolves.toEqual({ reportedTo: 'comp-a' });
  });
});

describe('GatewayClient session integrity RPC', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('calls session.hmac.sign and returns signed entry', async () => {
    const signPromise = client.sessionHmacSign({
      type: 'message',
      id: 1,
      channelId: 'api:test',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    }, null);

    const req = conn.sent[0] as { id: number; method: string };
    expect(req.method).toBe('session.hmac.sign');

    conn._emit({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        entry: {
          type: 'message',
          id: 1,
          channelId: 'api:test',
          role: 'user',
          content: 'hello',
          timestamp: 1_000,
          _hmac: 'a'.repeat(64),
          _hmacKeyVersion: 'v1',
        },
      },
    });

    const signed = await signPromise;
    expect(signed._hmac).toBe('a'.repeat(64));
    expect(signed._hmacKeyVersion).toBe('v1');
  });

  it('calls session.hmac.verify and returns verification result', async () => {
    const verifyPromise = client.sessionHmacVerify({
      type: 'message',
      id: 1,
      channelId: 'api:test',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
      _hmac: 'a'.repeat(64),
      _hmacKeyVersion: 'v1',
    }, null);

    const req = conn.sent[0] as { id: number; method: string };
    expect(req.method).toBe('session.hmac.verify');

    conn._emit({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        verified: true,
        observedHmac: 'a'.repeat(64),
      },
    });

    const verification = await verifyPromise;
    expect(verification).toEqual({
      verified: true,
      observedHmac: 'a'.repeat(64),
    });
  });

  it('fails to create sync session integrity bridge without socket path', () => {
    const provider = client.createSessionIntegrityProvider();
    expect(() => provider.sign({
      type: 'message',
      id: 1,
      channelId: 'api:test',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    }, null)).toThrow('requires a gateway socket path');
  });

  it('memoizes repeated sync session integrity verification for unchanged entries', () => {
    client = new GatewayClient(conn.conn, 1024, {
      sessionIntegritySocketPath: '/tmp/test-gateway.sock',
    });
    const requestSessionIntegritySync = vi.spyOn(client as any, 'requestSessionIntegritySync')
      .mockReturnValue({
        verified: true,
        observedHmac: 'a'.repeat(64),
      });
    const provider = client.createSessionIntegrityProvider();
    const entry = {
      type: 'message' as const,
      id: 1,
      channelId: 'api:test',
      role: 'user' as const,
      content: 'hello',
      timestamp: 1_000,
      _hmac: 'a'.repeat(64),
      _hmacKeyVersion: 'v1',
    };

    expect(provider.verify(entry, null)).toEqual({
      verified: true,
      observedHmac: 'a'.repeat(64),
    });
    expect(provider.verify(entry, null)).toEqual({
      verified: true,
      observedHmac: 'a'.repeat(64),
    });
    expect(requestSessionIntegritySync).toHaveBeenCalledTimes(1);
  });
});

describe('GatewayClient git RPC wrappers', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('routes git.status and git.diff with typed payloads', async () => {
    const statusPromise = client.gitStatus();
    const statusReq = conn.sent[0] as { id: number; method: string; params: Record<string, never> };
    expect(statusReq.method).toBe('git.status');
    expect(statusReq.params).toEqual({});
    conn._emit({
      jsonrpc: '2.0',
      id: statusReq.id,
      result: {
        branch: 'main',
        ahead: 1,
        behind: 0,
        staged: ['src/a.ts'],
        modified: ['src/b.ts'],
        untracked: ['src/c.ts'],
      },
    });
    await expect(statusPromise).resolves.toMatchObject({ branch: 'main', ahead: 1 });

    const diffPromise = client.gitDiff({ staged: false });
    const diffReq = conn.sent[1] as { id: number; method: string; params: { staged: boolean } };
    expect(diffReq.method).toBe('git.diff');
    expect(diffReq.params).toEqual({ staged: false });
    conn._emit({
      jsonrpc: '2.0',
      id: diffReq.id,
      result: {
        staged: '',
        unstaged: 'diff',
      },
    });
    await expect(diffPromise).resolves.toEqual({ staged: '', unstaged: 'diff' });
  });

  it('routes git write wrappers and maps structured responses', async () => {
    const createBranchPromise = client.gitCreateBranch('feature/test', 'main');
    const createBranchReq = conn.sent[0] as {
      id: number;
      method: string;
      params: { name: string; startPoint: string };
    };
    expect(createBranchReq.method).toBe('git.create_branch');
    expect(createBranchReq.params).toEqual({ name: 'feature/test', startPoint: 'main' });
    conn._emit({
      jsonrpc: '2.0',
      id: createBranchReq.id,
      result: { name: 'feature/test' },
    });
    await expect(createBranchPromise).resolves.toBe('feature/test');

    const applyPatchPromise = client.gitApplyPatch('src/x.ts', 'export const x = 1;');
    const applyPatchReq = conn.sent[1] as {
      id: number;
      method: string;
      params: { filePath: string; content: string };
    };
    expect(applyPatchReq.method).toBe('git.apply_patch');
    expect(applyPatchReq.params.filePath).toBe('src/x.ts');
    conn._emit({
      jsonrpc: '2.0',
      id: applyPatchReq.id,
      result: { success: true },
    });
    await expect(applyPatchPromise).resolves.toBeUndefined();

    const commitPromise = client.gitCommit('msg', 'intent', 'scope');
    const commitReq = conn.sent[2] as { id: number; method: string; params: Record<string, unknown> };
    expect(commitReq.method).toBe('git.commit');
    expect(commitReq.params).toEqual({ message: 'msg', intent: 'intent', scope: 'scope' });
    conn._emit({
      jsonrpc: '2.0',
      id: commitReq.id,
      result: { hash: 'abc', message: 'msg', filesChanged: 2 },
    });
    await expect(commitPromise).resolves.toMatchObject({ hash: 'abc', filesChanged: 2 });

    const openPrPromise = client.gitOpenPR('Title', 'Body', 'main');
    const openPrReq = conn.sent[3] as { id: number; method: string; params: Record<string, unknown> };
    expect(openPrReq.method).toBe('git.open_pr');
    expect(openPrReq.params).toEqual({ title: 'Title', body: 'Body', base: 'main' });
    conn._emit({
      jsonrpc: '2.0',
      id: openPrReq.id,
      result: { url: 'https://example.test/pr/1' },
    });
    await expect(openPrPromise).resolves.toBe('https://example.test/pr/1');
  });
});

describe('GatewayClient filesystem RPC wrappers', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('routes filesystem methods with typed payloads', async () => {
    const readPromise = client.fsReadDetailed('notes.txt', { maxBytes: 12 });
    const readReq = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };
    expect(readReq.method).toBe('fs.read');
    expect(readReq.params).toEqual({ path: 'notes.txt', maxBytes: 12 });
    conn._emit({
      jsonrpc: '2.0',
      id: readReq.id,
      result: { content: 'hello', truncated: false },
    });
    await expect(readPromise).resolves.toEqual({ content: 'hello', truncated: false });

    const listPromise = client.fsList(undefined, 25, { path: 'downloads' });
    const listReq = conn.sent[1] as { id: number; method: string; params: Record<string, unknown> };
    expect(listReq.method).toBe('fs.list');
    expect(listReq.params).toEqual({ path: 'downloads', maxEntries: 25 });
    const listResult = {
      paths: ['downloads/COMPANION_EXPERIENCE.md'],
      scannedEntries: 1,
      maxEntries: 25,
      maxScannedEntries: 5000,
      truncated: false,
      scanLimitReached: false,
      entryLimitReached: false,
    };
    conn._emit({
      jsonrpc: '2.0',
      id: listReq.id,
      result: listResult,
    });
    await expect(listPromise).resolves.toEqual(listResult);

    const searchPromise = client.fsSearch({ query: 'alpha', glob: '*.txt', maxMatches: 2 });
    const searchReq = conn.sent[2] as { id: number; method: string; params: Record<string, unknown> };
    expect(searchReq.method).toBe('fs.search');
    expect(searchReq.params).toEqual({ query: 'alpha', glob: '*.txt', maxMatches: 2 });
    conn._emit({
      jsonrpc: '2.0',
      id: searchReq.id,
      result: {
        query: 'alpha',
        glob: '*.txt',
        mode: 'literal',
        scannedFiles: 1,
        hitLimit: false,
        truncatedFiles: [],
        matches: [{ path: 'notes.txt', line: 1, column: 1, preview: 'alpha' }],
      },
    });
    await expect(searchPromise).resolves.toMatchObject({
      query: 'alpha',
      matches: [{ path: 'notes.txt', line: 1, column: 1, preview: 'alpha' }],
    });

    const editPromise = client.fsEdit({
      path: 'notes.txt',
      oldText: 'alpha',
      newText: 'beta',
    });
    const editReq = conn.sent[3] as { id: number; method: string; params: Record<string, unknown> };
    expect(editReq.method).toBe('fs.edit');
    expect(editReq.params).toEqual({
      path: 'notes.txt',
      oldText: 'alpha',
      newText: 'beta',
    });
    conn._emit({
      jsonrpc: '2.0',
      id: editReq.id,
      result: { success: true, replacements: 1 },
    });
    await expect(editPromise).resolves.toEqual({ success: true, replacements: 1 });
  });
});

describe('GatewayClient vault RPC wrappers', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('routes vault methods with typed payloads', async () => {
    const writePromise = client.vaultWrite('Inbox', 'entry', {
      folder: 'Journal',
      mode: 'append',
    });
    const writeReq = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };
    expect(writeReq.method).toBe('vault.write');
    expect(writeReq.params).toEqual({
      name: 'Inbox',
      content: 'entry',
      folder: 'Journal',
      mode: 'append',
    });
    conn._emit({
      jsonrpc: '2.0',
      id: writeReq.id,
      result: { name: 'Inbox', folder: 'Journal', mode: 'append' },
    });
    await expect(writePromise).resolves.toEqual({ name: 'Inbox', folder: 'Journal', mode: 'append' });

    const readPromise = client.vaultRead('Inbox.md');
    const readReq = conn.sent[1] as { id: number; method: string; params: Record<string, unknown> };
    expect(readReq.method).toBe('vault.read');
    expect(readReq.params).toEqual({ name: 'Inbox.md' });
    conn._emit({
      jsonrpc: '2.0',
      id: readReq.id,
      result: { name: 'Inbox.md', content: 'hello' },
    });
    await expect(readPromise).resolves.toEqual({ name: 'Inbox.md', content: 'hello' });

    const searchPromise = client.vaultSearch('focus', 5);
    const searchReq = conn.sent[2] as { id: number; method: string; params: Record<string, unknown> };
    expect(searchReq.method).toBe('vault.search');
    expect(searchReq.params).toEqual({ query: 'focus', limit: 5 });
    conn._emit({
      jsonrpc: '2.0',
      id: searchReq.id,
      result: { query: 'focus', results: [{ path: 'Notes/Focus.md' }] },
    });
    await expect(searchPromise).resolves.toEqual({
      query: 'focus',
      results: [{ path: 'Notes/Focus.md' }],
    });

    const dailyReadPromise = client.vaultDaily();
    const dailyReadReq = conn.sent[3] as { id: number; method: string; params: Record<string, unknown> };
    expect(dailyReadReq.method).toBe('vault.daily');
    expect(dailyReadReq.params).toEqual({});
    conn._emit({
      jsonrpc: '2.0',
      id: dailyReadReq.id,
      result: { date: '2026-03-06', content: 'daily', mode: 'read' },
    });
    await expect(dailyReadPromise).resolves.toEqual({ date: '2026-03-06', content: 'daily', mode: 'read' });

    const dailyAppendPromise = client.vaultDaily('entry');
    const dailyAppendReq = conn.sent[4] as { id: number; method: string; params: Record<string, unknown> };
    expect(dailyAppendReq.method).toBe('vault.daily');
    expect(dailyAppendReq.params).toEqual({ content: 'entry' });
    conn._emit({
      jsonrpc: '2.0',
      id: dailyAppendReq.id,
      result: { date: '2026-03-06', mode: 'append' },
    });
    await expect(dailyAppendPromise).resolves.toEqual({ date: '2026-03-06', mode: 'append' });
  });

  it('exposes RPC-name aliases for tool wiring validation', () => {
    expect(typeof (client as any)['vault.write']).toBe('function');
    expect(typeof (client as any)['vault.read']).toBe('function');
    expect(typeof (client as any)['vault.search']).toBe('function');
    expect(typeof (client as any)['vault.daily']).toBe('function');
  });
});

describe('GatewayClient runtime health RPC wrapper', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('requests runtime.health with the typed response shape', async () => {
    const healthPromise = client.runtimeHealth();
    const healthReq = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };

    expect(healthReq.method).toBe('runtime.health');
    expect(healthReq.params).toEqual({});

    conn._emit({
      jsonrpc: '2.0',
      id: healthReq.id,
      result: {
        checkedAt: 1_701_234_567_890,
        services: [
          {
            serviceId: 'gateway',
            status: 'healthy',
            detail: 'Gateway ready.',
            checkedAt: 1_701_234_567_890,
          },
        ],
      },
    });

    await expect(healthPromise).resolves.toEqual({
      checkedAt: 1_701_234_567_890,
      services: [
        {
          serviceId: 'gateway',
          status: 'healthy',
          detail: 'Gateway ready.',
          checkedAt: 1_701_234_567_890,
        },
      ],
    });
  });

  it('requests only redacted credential-presence booleans', async () => {
    const presencePromise = client.getCredentialPresence();
    const request = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };
    expect(request).toMatchObject({ method: 'runtime.credential_presence', params: {} });
    const result = {
      discordToken: true,
      apiKey: false,
      adminToken: true,
      openrouterApiKey: true,
      litellmBaseUrl: true,
      litellmApiKey: true,
      importProcessingLocalApiKey: false,
      falApiKey: false,
      telegramBotToken: true,
    };
    conn._emit({ jsonrpc: '2.0', id: request.id, result });
    await expect(presencePromise).resolves.toEqual(result);
  });
});

describe('GatewayClient beads RPC wrappers', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('routes beads methods with typed payloads', async () => {
    const readyPromise = client.beadsReady({ actor: 'agent' });
    const readyReq = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };
    expect(readyReq.method).toBe('beads.ready');
    expect(readyReq.params).toEqual({ actor: 'agent' });
    conn._emit({
      jsonrpc: '2.0',
      id: readyReq.id,
      result: {
        actor: 'agent',
        action: 'ready',
        target: 'ready',
        result: 'success',
        payload: [{ id: 'PSFN-1' }],
      },
    });
    await expect(readyPromise).resolves.toMatchObject({ action: 'ready' });

    const createPromise = client.beadsCreate({
      title: 'New issue',
      issueType: 'task',
      priority: 2,
      actor: 'agent',
    });
    const createReq = conn.sent[1] as { id: number; method: string; params: Record<string, unknown> };
    expect(createReq.method).toBe('beads.create');
    expect(createReq.params).toEqual({
      title: 'New issue',
      issueType: 'task',
      priority: 2,
      actor: 'agent',
    });
    conn._emit({
      jsonrpc: '2.0',
      id: createReq.id,
      result: {
        actor: 'agent',
        action: 'create',
        target: 'new',
        result: 'success',
        payload: { id: 'PSFN-2' },
      },
    });
    await expect(createPromise).resolves.toMatchObject({ action: 'create' });

    const closePromise = client.beadsClose({
      id: 'PSFN-2',
      reason: 'done',
    });
    const closeReq = conn.sent[2] as { id: number; method: string; params: Record<string, unknown> };
    expect(closeReq.method).toBe('beads.close');
    expect(closeReq.params).toEqual({ id: 'PSFN-2', reason: 'done' });
    conn._emit({
      jsonrpc: '2.0',
      id: closeReq.id,
      result: {
        actor: 'runtime-agent',
        action: 'close',
        target: 'PSFN-2',
        result: 'success',
        payload: { closed: true },
      },
    });
    await expect(closePromise).resolves.toMatchObject({ action: 'close' });
  });
});

describe('GatewayClient keepalive', () => {
  it('does not overlap the acknowledged initial posture report with a keepalive report', async () => {
    vi.useFakeTimers();
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, {
      companionId: TEST_COMPANION_ID,
      keepaliveIntervalMs: 1_000,
    });

    try {
      const started = client.startFleetPostureReporting(() => ({
        schemaVersion: 1,
        updatedAt: 1_800_000_000_000,
        charge: { state: 'clear', utilizationPercent: 0 },
        fatigue: { state: 'clear', utilizationPercent: 0 },
      }));
      const initial = conn.sent[0] as { id: number; method: string };
      await vi.advanceTimersByTimeAsync(1_000);
      expect(conn.heartbeatCount).toBe(1);
      expect(conn.sent.filter((frame: unknown) => (
        (frame as { method?: unknown }).method === 'gateway.client.health'
      ))).toHaveLength(1);

      conn._emit({ jsonrpc: '2.0', id: initial.id, result: { success: true } });
      await started;
      await vi.advanceTimersByTimeAsync(1_000);
      const reports = conn.sent.filter((frame: unknown) => (
        (frame as { method?: unknown }).method === 'gateway.client.health'
      )) as Array<{ id: number }>;
      expect(reports).toHaveLength(2);
      conn._emit({ jsonrpc: '2.0', id: reports[1]!.id, result: { success: true } });
      await Promise.resolve();
    } finally {
      client.destroy();
      vi.useRealTimers();
    }
  });

  it('emits transport heartbeats without JSON-RPC frames while idle', async () => {
    vi.useFakeTimers();
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, { keepaliveIntervalMs: 1_000 });

    try {
      expect(conn.sent).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(conn.heartbeatCount).toBe(1);
      expect(conn.sent).toHaveLength(0);
      expect(conn.conn.serializedTransportStats.rpcCallCount).toBe(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(conn.heartbeatCount).toBe(2);
      expect(conn.sent).toHaveLength(0);
    } finally {
      client.destroy();
      vi.useRealTimers();
    }
  });

  it('stops keepalive emissions after destroy', async () => {
    vi.useFakeTimers();
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, { keepaliveIntervalMs: 500 });

    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(conn.heartbeatCount).toBe(1);

      client.destroy();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(conn.heartbeatCount).toBe(1);
    } finally {
      client.destroy();
      vi.useRealTimers();
    }
  });

  it('disconnects within one interval when the transport heartbeat cannot be sent', async () => {
    vi.useFakeTimers();
    const conn = createMockConnection({ heartbeatResults: [false] });
    const client = new GatewayClient(conn.conn, 1024, { keepaliveIntervalMs: 1_000 });
    const onDisconnect = vi.fn();
    client.onDisconnect(onDisconnect);

    try {
      await vi.advanceTimersByTimeAsync(1_000);

      expect(conn.heartbeatCount).toBe(1);
      expect(conn.destroyed).toBe(true);
      expect(onDisconnect).toHaveBeenCalledOnce();
      expect(onDisconnect).toHaveBeenCalledWith({ source: 'close' });
    } finally {
      client.destroy();
      vi.useRealTimers();
    }
  });
});

describe('GatewayClient connection lifecycle', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('emits disconnect once when the gateway connection closes', () => {
    const handler = vi.fn();
    client.onDisconnect(handler);

    conn._emitClose();
    conn._emitError(new Error('late error'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ source: 'close' });
  });
});
