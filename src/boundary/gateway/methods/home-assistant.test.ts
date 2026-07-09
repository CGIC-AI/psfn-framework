import { describe, expect, it, vi, afterEach } from 'vitest';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { ApprovalBoundaryGateOptions } from '../approval-boundary.js';
import { evaluatePolicy, type PolicyConfig } from '../policy.js';
import { GatewayErrors } from '../protocol.js';
import {
  checkResolvedIP,
  evaluateUrlPolicy,
  type DnsResolver,
  type UrlPolicyConfig,
  type UrlPolicyLane,
} from '../url-policy.js';
import { createEnvCredentialVault } from '../../custody/credential-vault.js';
import type { GatewayMethodRuntime } from './types.js';

const { fetchWithValidatedRedirectChainMock } = vi.hoisted(() => ({
  fetchWithValidatedRedirectChainMock: vi.fn(),
}));

vi.mock('./web.js', () => ({
  fetchWithValidatedRedirectChain: fetchWithValidatedRedirectChainMock,
  formatFetchFailureDetails: (error: unknown) => error instanceof Error ? error.message : String(error),
  loadTlsBundle: vi.fn(() => undefined),
  normalizeRequestHeaders: (raw: unknown) => raw as Record<string, string>,
  resolveDnsResolver: vi.fn(() => undefined),
  resolveTlsCertPaths: vi.fn(() => []),
  resetWebCircuitBreakersForTests: vi.fn(),
  withWebCircuit: async (
    _method: string,
    _lane: UrlPolicyLane,
    _url: string,
    operation: () => Promise<unknown>,
  ) => await operation(),
}));

import { registerHomeAssistantMethods } from './home-assistant.js';

interface RuntimeHarness {
  invoke(method: string, params: Record<string, unknown>): Promise<unknown>;
  gateCalls: Array<ApprovalBoundaryGateOptions<Record<string, unknown>, unknown>>;
  recordAuditEvent: ReturnType<typeof vi.fn>;
}

function arrayBufferFromString(value: string): ArrayBuffer {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function jsonResponse(payload: unknown, status = 200, statusText = 'OK') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () => arrayBufferFromString(body),
  };
}

function queueJsonResponse(payload: unknown, status = 200, statusText = 'OK'): void {
  fetchWithValidatedRedirectChainMock.mockResolvedValueOnce({
    response: jsonResponse(payload, status, statusText),
    finalUrl: 'http://ha.allowed.test/api/states',
    redirectHopCount: 0,
    redirectChain: ['http://ha.allowed.test/api/states'],
  });
}

function createPolicyConfig(
  baseUrl = 'http://ha.allowed.test:8123',
  options: {
    enabled?: boolean;
    tokenConfigured?: boolean;
  } = {},
): PolicyConfig {
  return {
    workspacePath: process.cwd(),
    homeAssistant: {
      enabled: options.enabled ?? true,
      baseUrl,
      tokenConfigured: options.tokenConfigured ?? true,
    },
  };
}

function createRuntimeHarness(
  policyConfig: PolicyConfig,
  env: NodeJS.ProcessEnv = { HOME_ASSISTANT_TOKEN: 'ha-test-token' },
): RuntimeHarness {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const gateCalls: Array<ApprovalBoundaryGateOptions<Record<string, unknown>, unknown>> = [];
  const recordAuditEvent = vi.fn();
  const runtime: GatewayMethodRuntime = {
    target: {
      addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
        methods.set(name, handler);
      },
    } as any,
    llmProvider: {} as any,
    embeddingService: {} as any,
    discordAdapter: {} as any,
    credentialVault: createEnvCredentialVault(env),
    policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: {
      activeVersion: 'v1',
      keys: { v1: 'test-ha-secret' },
    },
    notifyAll: vi.fn(),
    listPendingConfirmations: () => [],
    listConfirmationHistory: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    getRuntimeHealth: vi.fn() as any,
    nextStreamRequestId: () => 'stream-1',
    recordAuditEvent,
    audited: (_method, handler) => handler,
    approvalBoundary: {
      gate: (options: ApprovalBoundaryGateOptions<Record<string, unknown>, unknown>) => {
        gateCalls.push(options);
        return async (params: Record<string, unknown>) => options.handler(params);
      },
    } as any,
  };

  registerHomeAssistantMethods(runtime);

  return {
    invoke(method: string, params: Record<string, unknown>) {
      const handler = methods.get(method);
      if (!handler) {
        throw new Error(`Method not registered: ${method}`);
      }
      return handler(params);
    },
    gateCalls,
    recordAuditEvent,
  };
}

function lastFetchCall(): unknown[] {
  expect(fetchWithValidatedRedirectChainMock).toHaveBeenCalled();
  const calls = fetchWithValidatedRedirectChainMock.mock.calls;
  return calls[calls.length - 1] as unknown[];
}

describe('registerHomeAssistantMethods', () => {
  afterEach(() => {
    fetchWithValidatedRedirectChainMock.mockReset();
  });

  it('registers gated descriptors with redacted summaries and control approval action', () => {
    const policyConfig = createPolicyConfig();
    const harness = createRuntimeHarness(policyConfig);

    const callServiceGate = harness.gateCalls.find(call => call.method === 'home_assistant.call_service');
    expect(callServiceGate).toBeTruthy();
    expect(callServiceGate?.approvalAction).toBe('home_assistant.control');
    expect(callServiceGate?.approvalScope({
      domain: 'light',
      service: 'turn_on',
      entityId: 'light.kitchen',
      data: { brightness_pct: 50 },
    })).toBe('light.turn_on:light.kitchen');
    expect(callServiceGate?.paramsSummary({
      domain: 'light',
      service: 'turn_on',
      entityId: 'light.kitchen',
      data: { token: 'ha-test-token' },
    })).toEqual({
      action: 'call_service',
      domain: 'light',
      service: 'turn_on',
      entityId: 'light.kitchen',
      entityCount: 0,
      hasData: true,
    });
    expect(evaluatePolicy(
      { method: 'home_assistant.call_service', params: {} },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('gets all states through the scoped Home Assistant lane and redacts the token from audit', async () => {
    queueJsonResponse([
      { entity_id: 'light.kitchen', state: 'on', attributes: { brightness: 180 } },
      { entity_id: 'binary_sensor.motion', state: 'off', attributes: {} },
    ]);
    const harness = createRuntimeHarness(createPolicyConfig());

    const result = await harness.invoke('home_assistant.get_states', {}) as {
      count: number;
      states: Array<{ entity_id: string; state: string }>;
    };

    expect(result.count).toBe(2);
    expect(result.states[0]).toMatchObject({ entity_id: 'light.kitchen', state: 'on' });
    const call = lastFetchCall();
    expect(call[0]).toBe('home_assistant.get_states');
    expect(call[1]).toBe('http://ha.allowed.test:8123/api/states');
    expect(call[2]).toBe('home_assistant');
    expect(call[3]).toEqual({
      allowHttp: true,
      allowInternalNetwork: true,
      hostAllowlist: ['ha.allowed.test'],
    });
    expect(call[5]).toMatchObject({ Authorization: 'Bearer ha-test-token' });
    expect(JSON.stringify(harness.recordAuditEvent.mock.calls)).not.toContain('ha-test-token');
  });

  it('gets one entity state by entity_id', async () => {
    queueJsonResponse({ entity_id: 'light.kitchen', state: 'off', attributes: {} });
    const harness = createRuntimeHarness(createPolicyConfig());

    const result = await harness.invoke('home_assistant.get_states', {
      entityId: 'light.kitchen',
    }) as { count: number; entityId: string };

    expect(result).toMatchObject({ count: 1, entityId: 'light.kitchen' });
    expect(lastFetchCall()[1]).toBe('http://ha.allowed.test:8123/api/states/light.kitchen');
  });

  it('calls services with domain service entity payload', async () => {
    queueJsonResponse([
      { entity_id: 'light.kitchen', state: 'on', attributes: { brightness_pct: 60 } },
    ]);
    const harness = createRuntimeHarness(createPolicyConfig());

    const result = await harness.invoke('home_assistant.call_service', {
      domain: 'light',
      service: 'turn_on',
      entityId: 'light.kitchen',
      data: { brightness_pct: 60 },
    }) as { domain: string; service: string; entityIds: string[]; response: unknown };

    const call = lastFetchCall();
    expect(call[1]).toBe('http://ha.allowed.test:8123/api/services/light/turn_on');
    expect(call[6]).toBe('POST');
    expect(JSON.parse(Buffer.from(call[7] as Buffer).toString('utf8'))).toEqual({
      brightness_pct: 60,
      entity_id: 'light.kitchen',
    });
    expect(result.domain).toBe('light');
    expect(result.service).toBe('turn_on');
    expect(result.entityIds).toEqual(['light.kitchen']);
  });

  it('refuses when Home Assistant is disabled without making a request', async () => {
    const harness = createRuntimeHarness(createPolicyConfig(undefined, { enabled: false }));

    await expect(harness.invoke('home_assistant.get_states', {})).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('disabled'),
    });
    expect(fetchWithValidatedRedirectChainMock).not.toHaveBeenCalled();
  });

  it('refuses when the gateway-side token is absent without falling back', async () => {
    const harness = createRuntimeHarness(createPolicyConfig(undefined, { tokenConfigured: false }), {});

    await expect(harness.invoke('home_assistant.get_states', {})).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('HOME_ASSISTANT_TOKEN'),
    });
    expect(fetchWithValidatedRedirectChainMock).not.toHaveBeenCalled();
  });

  it('scopes the Home Assistant lane to the configured host only', async () => {
    queueJsonResponse({ message: 'API running.' });
    const harness = createRuntimeHarness(createPolicyConfig('http://ha.allowed.test:8123'));

    await harness.invoke('home_assistant.check_connection', {});
    const policy = lastFetchCall()[3] as UrlPolicyConfig;

    expect(evaluateUrlPolicy(
      'http://ha.allowed.test:8123/api/',
      policy,
      'home_assistant',
    ).allowed).toBe(true);
    expect(evaluateUrlPolicy(
      'http://other.internal.test:8123/api/',
      policy,
      'home_assistant',
    )).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('not in allowlist'),
    });
  });

  it('still blocks cloud metadata/link-local DNS targets in the Home Assistant lane', async () => {
    const dnsResolver: DnsResolver = vi.fn(async () => ({ address: '169.254.169.254', family: 4 }));

    await expect(checkResolvedIP('ha.allowed.test', dnsResolver, {
      allowPrivateResolvedIp: true,
    })).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('cloud metadata'),
    });
  });

  it('raises explicit errors for malformed Home Assistant state payloads', async () => {
    queueJsonResponse([{ entity_id: 'light.kitchen' }]);
    const harness = createRuntimeHarness(createPolicyConfig());

    await expect(harness.invoke('home_assistant.get_states', {})).rejects.toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
      message: expect.stringContaining('states[0].state'),
    });
  });

  it('does not include token material in thrown provider errors', async () => {
    queueJsonResponse({ error: 'upstream failed' }, 500, 'Internal Server Error');
    const harness = createRuntimeHarness(createPolicyConfig());

    let thrown: unknown;
    try {
      await harness.invoke('home_assistant.check_connection', {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(JSONRPCErrorException);
    expect(String((thrown as Error).message)).toContain('Home Assistant request failed');
    expect(String((thrown as Error).message)).not.toContain('ha-test-token');
    expect(JSON.stringify(harness.recordAuditEvent.mock.calls)).not.toContain('ha-test-token');
  });

  it('redacts token material from lower transport failures', async () => {
    fetchWithValidatedRedirectChainMock.mockRejectedValueOnce(
      new Error('network failure with Authorization: Bearer ha-test-token'),
    );
    const harness = createRuntimeHarness(createPolicyConfig());

    let thrown: unknown;
    try {
      await harness.invoke('home_assistant.check_connection', {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(JSONRPCErrorException);
    expect(String((thrown as Error).message)).toContain('Bearer [REDACTED]');
    expect(String((thrown as Error).message)).not.toContain('ha-test-token');
    expect(JSON.stringify(harness.recordAuditEvent.mock.calls)).not.toContain('ha-test-token');
  });
});
