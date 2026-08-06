import { JSONRPCErrorCode } from 'json-rpc-2.0';
import { describe, expect, it, vi } from 'vitest';

import {
  registerReverseGatewayMethods,
  type ReverseGatewayMethodRuntime,
} from './reverse-methods.js';

type RegisteredHandler = (params: unknown) => Promise<unknown> | unknown;

const expectedRegisteredNames = [
  'icp.policy.inspect',
  'icp.policy.acquire',
  'icp.policy.release',
  'memory.deletion.snapshot',
  'memory.deletion.partner_alerted',
  'memory.deletion.resolve',
  'contact.authority.snapshot',
  'voice.handleMessage',
  'voice.stream.start',
  'voice.transcript.begin',
  'voice.stream.chunk',
  'voice.transcript.chunk',
  'voice.stream.end',
  'voice.transcript.end',
  'voice.stream.cancel',
  'voice.transcript.cancel',
  'api.chat.completion',
  'api.chat.cancel',
  'api.companion-ui.shard.action',
  'shard.directory.owner',
  'api.telemetry.ingest',
  'api.health',
  'satellite.response.eligibility',
  'telemetry.turn.performance',
] as const;

function createRegisteredRuntime(): {
  methods: Map<string, RegisteredHandler>;
  handleVoiceStreamChunk: ReturnType<typeof vi.fn>;
  handleApiHealth: ReturnType<typeof vi.fn>;
} {
  const methods = new Map<string, RegisteredHandler>();
  const handleVoiceStreamChunk = vi.fn((params: unknown) => ({
    accepted: true,
    params,
  }));
  const handleApiHealth = vi.fn(async () => ({ ok: true }));
  const runtime = {
    target: {
      addMethod(name: string, handler: RegisteredHandler): void {
        methods.set(name, handler);
      },
    },
    handleVoiceStreamChunk,
    handleApiHealth,
  } as unknown as ReverseGatewayMethodRuntime;

  registerReverseGatewayMethods(runtime);
  return { methods, handleVoiceStreamChunk, handleApiHealth };
}

function requireMethod(
  methods: ReadonlyMap<string, RegisteredHandler>,
  name: string,
): RegisteredHandler {
  const method = methods.get(name);
  if (!method) {
    throw new Error(`Missing registered reverse method ${name}`);
  }
  return method;
}

describe('registered reverse RPC parameter boundary', () => {
  it('keeps the complete production reverse method and rollout-alias inventory', () => {
    const { methods } = createRegisteredRuntime();

    expect([...methods.keys()]).toEqual(expectedRegisteredNames);
  });

  it.each([
    'voice.stream.chunk',
    'voice.transcript.chunk',
  ])('rejects malformed %s params before its handler', name => {
    const { methods, handleVoiceStreamChunk } = createRegisteredRuntime();
    const invoke = requireMethod(methods, name);

    expect(() => invoke({
      correlationId: 'correlation-1',
      streamId: 'stream-1',
      sequence: 1,
      text: 42,
    })).toThrow(expect.objectContaining({
      code: JSONRPCErrorCode.InvalidParams,
    }));
    expect(handleVoiceStreamChunk).not.toHaveBeenCalled();
  });

  it('rejects unexpected fields on empty params before dispatch', () => {
    const { methods, handleApiHealth } = createRegisteredRuntime();
    const invoke = requireMethod(methods, 'api.health');

    expect(() => invoke({ unrecognizedAuthority: true }))
      .toThrow(expect.objectContaining({
        code: JSONRPCErrorCode.InvalidParams,
      }));
    expect(handleApiHealth).not.toHaveBeenCalled();
  });

  it.each([
    'voice.stream.chunk',
    'voice.transcript.chunk',
  ])('preserves valid %s params by identity', name => {
    const { methods, handleVoiceStreamChunk } = createRegisteredRuntime();
    const invoke = requireMethod(methods, name);
    const params = {
      correlationId: 'correlation-1',
      streamId: 'stream-1',
      sequence: 1,
      text: 'hello',
    };

    expect(invoke(params)).toEqual({
      accepted: true,
      params,
    });
    expect(handleVoiceStreamChunk).toHaveBeenCalledExactlyOnceWith(params);
  });

  it('preserves valid empty params for api.health', async () => {
    const { methods, handleApiHealth } = createRegisteredRuntime();
    const invoke = requireMethod(methods, 'api.health');

    await expect(invoke({})).resolves.toEqual({ ok: true });
    expect(handleApiHealth).toHaveBeenCalledOnce();
  });
});
