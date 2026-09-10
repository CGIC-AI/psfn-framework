import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny, fromPartial } from '@total-typescript/shoehorn';
import type { ApprovalBoundaryGateOptions } from '../approval-boundary.js';
import type { PolicyConfig } from '../policy.js';
import { evaluatePolicy } from '../policy.js';
import { createEnvCredentialVault } from '../../custody/credential-vault.js';
import type { GatewayMethodRuntime } from './types.js';
import { registerWorldMethods } from './world.js';

// The local one-companion bed: Home Assistant OFF, only the Hub control
// transport configured. That must be enough for the companion to move.
function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    workspacePath: process.cwd(),
    homeAssistant: { enabled: false },
    satelliteHub: { controlBaseUrl: 'http://127.0.0.1:8798', tokenConfigured: true },
    ...overrides,
  };
}

function harness(policyConfig = policy(), env: NodeJS.ProcessEnv = { SATELLITE_HUB_CONTROL_TOKEN: 'hub-control-secret' }) {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const gateCalls: Array<ApprovalBoundaryGateOptions<Record<string, unknown>, unknown>> = [];
  const runtime: GatewayMethodRuntime = {
    target: fromAny({ addMethod: (name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => methods.set(name, handler) }),
    llmProvider: fromPartial<Record<string, unknown>>({}),
    embeddingService: fromPartial<Record<string, unknown>>({}),
    discordAdapter: fromPartial<Record<string, unknown>>({}),
    credentialVault: createEnvCredentialVault(env),
    policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'test' } },
    notifyRequester: vi.fn(),
    listPendingConfirmations: () => [],
    listConfirmationHistory: () => [],
    resolveConfirmation: fromAny(vi.fn()),
    sendNtfy: fromAny(vi.fn()),
    getRuntimeHealth: fromAny(vi.fn()),
    nextStreamRequestId: () => 'stream-1',
    audited: (_method, handler) => handler,
    approvalBoundary: fromAny({
      gate: (options: ApprovalBoundaryGateOptions<Record<string, unknown>, unknown>) => {
        gateCalls.push(options);
        return async (params: Record<string, unknown>) => options.handler(params);
      },
    }),
  };
  registerWorldMethods(runtime);
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
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

describe('world avatar gateway methods (S13 MOVE)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('perceives through the Hub control port with the control token and no device assertion', async () => {
    const fetchMock = vi.fn(async () => json({
      world: 'commons', capturedAt: 'now', self: null, people: [{ id: 'visitor', positionKnown: true, x: 2, z: 2.5 }], things: [], recent: [], raw: '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = fromAny(await harness().invoke('world.avatar_perceive', { placeId: 'eidoverse:commons' }));
    expect(result.people[0].id).toBe('visitor');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:8798/internal/v1/world/perceive');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer hub-control-secret' });
    expect(init.headers).not.toHaveProperty('X-PSFN-Hub-Device-Assertion');
  });

  it('publishes the world map through the Hub control port on the read approval action (gs899, g8xyn)', async () => {
    const fetchMock = vi.fn(async () => json({
      world: 'commons', placeId: 'eidoverse:commons', places: [{ placeId: 'eidoverse:commons:plaza', region: 'plaza' }],
      room: { label: 'kitchen', labelled: true, waysOut: [], sealed: false }, terrain: { sizeM: 400 },
      tools: [{ name: 'look' }, { name: 'walk_to', description: 'Walk to x,z.' }], capturedAt: 'now',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = fromAny(await harness().invoke('world.avatar_map', { placeId: 'eidoverse:commons' }));
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['look', 'walk_to']);
    expect(result.room.label).toBe('kitchen');
    const [url] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:8798/internal/v1/world/map');
    const malformed = vi.fn(async () => json({ world: 'commons' }));
    vi.stubGlobal('fetch', malformed);
    await expect(harness().invoke('world.avatar_map', {})).rejects.toThrow(/Malformed Satellite Hub world map/u);
  });

  it('moves with a longer budget and forwards only validated fields', async () => {
    const fetchMock = vi.fn(async () => json({ accepted: true, world: 'commons', walk: { status: 'arrived', x: 3.5, z: 0 } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = fromAny(await harness().invoke('world.avatar_move', {
      placeId: 'eidoverse:commons:plaza', world: 'commons', region: 'plaza', participant: '@visitor', waitMs: 99_000,
    }));
    expect(result.walk.status).toBe('arrived');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:8798/internal/v1/world/move');
    expect(JSON.parse(init.body as string)).toEqual({ world: 'commons', region: 'plaza', participant: '@visitor', waitMs: 15_000 });
  });

  it('refuses a malformed world name, an empty move, and a non-avatar verb before any RPC', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(harness().invoke('world.avatar_move', { world: 'Not A World' })).rejects.toThrow(/world-name grammar/u);
    await expect(harness().invoke('world.avatar_move', {})).rejects.toThrow(/needs a world, region, position or participant/u);
    await expect(harness().invoke('world.avatar_act', { verb: 'world_verb' })).rejects.toThrow(/not a world-avatar/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acts through the Hub and surfaces the door refusal vocabulary', async () => {
    const fetchMock = vi.fn(async () => json({ accepted: false, verb: 'spawn', reason: 'not_allowlisted' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = fromAny(await harness().invoke('world.avatar_act', { verb: 'spawn', arguments: { query: 'bench' } }));
    expect(result).toEqual({ accepted: false, verb: 'spawn', reason: 'not_allowlisted' });
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ verb: 'spawn', arguments: { query: 'bench' } });
  });

  it('fails closed without Hub wiring; Home Assistant being off is NOT a reason to refuse', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(harness(policy({ satelliteHub: {} })).invoke('world.avatar_perceive', {})).rejects.toThrow(/not fully configured/u);
    await expect(harness(policy(), {}).invoke('world.avatar_perceive', {})).rejects.toThrow(/credential is missing/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers each method as a gated method with its own approval action', () => {
    const { gateCalls } = harness();
    expect(gateCalls.map((call) => [call.method, call.approvalAction])).toEqual([
      ['world.avatar_perceive', 'world.avatar.read'],
      ['world.avatar_map', 'world.avatar.read'],
      ['world.avatar_move', 'world.avatar.move'],
      ['world.avatar_act', 'world.avatar.act'],
    ]);
  });

  it('policy allows the world methods on transport alone and denies them without it', () => {
    for (const method of ['world.avatar_perceive', 'world.avatar_map', 'world.avatar_move', 'world.avatar_act']) {
      expect(evaluatePolicy({ method, params: {} }, policy())).toBe('ALLOW');
      expect(evaluatePolicy({ method, params: {} }, policy({ satelliteHub: { tokenConfigured: true } }))).toBe('DENY');
      expect(evaluatePolicy({ method, params: {} }, policy({ satelliteHub: {} }))).toBe('DENY');
      // Legacy wiring through the Home Assistant block still counts, even with HA disabled.
      expect(evaluatePolicy({ method, params: {} }, policy({
        satelliteHub: {}, homeAssistant: { enabled: false, hubBaseUrl: 'http://hub.local:8788', tokenConfigured: true },
      }))).toBe('ALLOW');
    }
  });
});
