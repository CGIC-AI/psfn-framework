import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalBoundaryGateOptions } from '../approval-boundary.js';
import type { PolicyConfig } from '../policy.js';
import { GatewayErrors } from '../protocol.js';
import { createEnvCredentialVault } from '../../custody/credential-vault.js';
import type { GatewayMethodRuntime } from './types.js';
import { registerHomeAssistantMethods } from './home-assistant.js';

const PLACES = {
  places: [{
    placeId: 'place.kitchen',
    affordances: [{
      affordanceId: 'kitchen_lights',
      role: 'effector' as const,
      kind: 'light' as const,
      backend: 'ha' as const,
      entityId: 'switch.kitchen_light',
      control: ['on', 'off'],
    }],
  }],
};

function policy(overrides: Partial<NonNullable<PolicyConfig['homeAssistant']>> = {}): PolicyConfig {
  return {
    workspacePath: process.cwd(),
    homeAssistant: {
      enabled: true,
      hubBaseUrl: 'http://127.0.0.1:8788',
      tokenConfigured: true,
      placesRegistry: PLACES,
      ...overrides,
    },
  };
}

function harness(policyConfig = policy(), env: NodeJS.ProcessEnv = {
  SATELLITE_HUB_CONTROL_TOKEN: 'hub-control-secret',
}) {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const gateCalls: Array<ApprovalBoundaryGateOptions<Record<string, unknown>, unknown>> = [];
  const runtime: GatewayMethodRuntime = {
    target: { addMethod: (name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => methods.set(name, handler) } as any,
    llmProvider: {} as any,
    embeddingService: {} as any,
    discordAdapter: {} as any,
    credentialVault: createEnvCredentialVault(env),
    policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'test' } },
    notifyRequester: vi.fn(),
    listPendingConfirmations: () => [],
    listConfirmationHistory: () => [],
    resolveConfirmation: vi.fn() as any,
    sendNtfy: vi.fn() as any,
    getRuntimeHealth: vi.fn() as any,
    nextStreamRequestId: () => 'stream-1',
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
    gateCalls,
    invoke(method: string, params: Record<string, unknown>) {
      const handler = methods.get(method);
      if (!handler) throw new Error(`missing ${method}`);
      return handler(params);
    },
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Satellite Hub world transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads HA state only through the authenticated Hub internal route', async () => {
    const fetchMock = vi.fn(async () => json({
      states: [{ entity_id: 'light.kitchen', state: 'on', attributes: {} }],
      count: 1,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await harness().invoke('home_assistant.get_states', { entityId: 'light.kitchen' }) as any;

    expect(result.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:8788/internal/v1/home-assistant/states');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer hub-control-secret' });
    expect(JSON.parse(init.body as string)).toEqual({ entityIds: ['light.kitchen'] });
  });

  it('revalidates the registered place/affordance before calling a service', async () => {
    const fetchMock = vi.fn(async () => json({ requestId: 'req-1', response: null }));
    vi.stubGlobal('fetch', fetchMock);
    await harness().invoke('home_assistant.call_service', {
      requestId: 'req-1',
      domain: 'switch',
      service: 'turn_on',
      placeId: 'place.kitchen',
      affordanceId: 'kitchen_lights',
      entityId: 'switch.kitchen_light',
      intent: 'attention',
      reason: 'Get the operator attention',
    });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      requestId: 'req-1', domain: 'switch', service: 'turn_on', entityIds: ['switch.kitchen_light'],
    });
  });

  it('fails closed when an entity does not match the registered affordance', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(harness().invoke('home_assistant.call_service', {
      domain: 'light', service: 'turn_on', placeId: 'place.kitchen', affordanceId: 'kitchen_lights',
      entityId: 'light.other', intent: 'direct', reason: 'test',
    })).rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed without Hub wiring or its credential', async () => {
    await expect(harness(policy({ enabled: false })).invoke('home_assistant.get_states', {}))
      .rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    await expect(harness(policy({ tokenConfigured: false }), {}).invoke('home_assistant.get_states', {}))
      .rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
  });

  it('checks Hub transport readiness without contacting Home Assistant directly', async () => {
    const fetchMock = vi.fn(async () => json({ connected: true, status: 'ready' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(harness().invoke('home_assistant.check_connection', {})).resolves.toEqual({
      ok: true,
      message: 'Satellite Hub Home Assistant transport is ready',
    });
  });
});
