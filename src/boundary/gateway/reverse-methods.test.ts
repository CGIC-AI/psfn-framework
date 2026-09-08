import { JSONRPCErrorCode } from 'json-rpc-2.0';
import { describe, expect, it, vi } from 'vitest';

import {
  registerReverseGatewayMethods,
  type ReverseGatewayMethodRuntime,
} from './reverse-methods.js';

type RegisteredHandler = (params: unknown) => Promise<unknown> | unknown;

const expectedRegisteredNames = [
  'memory.external.execute',
  'icp.policy.inspect',
  'icp.policy.acquire',
  'icp.policy.release',
  'welfare.grant.verify',
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

function createRegisteredRuntime(overrides: Partial<ReverseGatewayMethodRuntime> = {}): {
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
    ...overrides,
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

  // psfn-framework-h248l.7: the welfare answer is content-free by construction.
  // Anything but an exact { jobId, companionId } pair is refused at the boundary,
  // so no session, payload, or schema detail can ride the question inward.
  it.each([
    ['a missing companion identity', { jobId: 'job-1' }, /companionId must be a non-empty string/i],
    ['a blank job id', { jobId: '   ', companionId: 'companion-a' }, /jobId must be a non-empty string/i],
    [
      'a smuggled extra field',
      { jobId: 'job-1', companionId: 'companion-a', schema: 'tenant_a' },
      /params contain unknown fields: schema/i,
    ],
  ])('rejects welfare.grant.verify params carrying %s before its handler', (_label, params, expected) => {
    const handleWelfareGrantVerify = vi.fn();
    const { methods } = createRegisteredRuntime({ handleWelfareGrantVerify });
    const invoke = requireMethod(methods, 'welfare.grant.verify');

    expect(() => invoke(params)).toThrow(expected);
    expect(handleWelfareGrantVerify).not.toHaveBeenCalled();
  });

  it('passes an exact welfare.grant.verify pair to the companion authority', async () => {
    const handleWelfareGrantVerify = vi.fn(async () => ({
      companionId: 'companion-a',
      granted: true,
    }));
    const { methods } = createRegisteredRuntime({ handleWelfareGrantVerify });
    const invoke = requireMethod(methods, 'welfare.grant.verify');

    await expect(invoke({ jobId: ' job-1 ', companionId: 'companion-a' }))
      .resolves.toEqual({ companionId: 'companion-a', granted: true });
    expect(handleWelfareGrantVerify).toHaveBeenCalledExactlyOnceWith({
      jobId: 'job-1',
      companionId: 'companion-a',
    });
  });

  it('preserves valid empty params for api.health', async () => {
    const { methods, handleApiHealth } = createRegisteredRuntime();
    const invoke = requireMethod(methods, 'api.health');

    await expect(invoke({})).resolves.toEqual({ ok: true });
    expect(handleApiHealth).toHaveBeenCalledOnce();
  });
});
