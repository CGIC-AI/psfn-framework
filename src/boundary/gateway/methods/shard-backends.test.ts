import { describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import type { PolicyConfig } from '../policy.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import { GatewayErrors } from '../protocol.js';
import { registerShardBackendMethods } from './shard-backends.js';

interface HarnessOptions {
  policyConfig: PolicyConfig;
  /**
   * Authoritative tier the gateway's own provider reports. `undefined` models a
   * gateway with no tier provider wired (fail-closed refusal path).
   */
  capabilityTier?: CapabilityTier;
  /** When true, omit capabilityTierProvider entirely (unwired gateway). */
  omitTierProvider?: boolean;
  /**
   * When set, the capabilityTierProvider throws this error instead of
   * returning a tier — models a malformed capability-tier.json whose reload
   * makes CapabilityRuntime.getTier() throw (fail-closed refusal path).
   */
  tierProviderThrows?: Error;
}

function createHarness(options: HarnessOptions): {
  invoke(params: Record<string, unknown>): Promise<any>;
} {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<any>>();
  const keyring = {
    activeVersion: 'v1',
    keys: { v1: 'test-shard-backend-secret' },
  };
  const runtime: GatewayMethodRuntime = {
    target: {
      addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<any>) {
        methods.set(name, handler);
      },
    } as any,
    llmProvider: {} as any,
    embeddingService: {} as any,
    discordAdapter: {} as any,
    policyConfig: options.policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: keyring,
    ...(options.omitTierProvider
      ? {}
      : {
        capabilityTierProvider: () => {
          if (options.tierProviderThrows) {
            throw options.tierProviderThrows;
          }
          return options.capabilityTier ?? 'nursery';
        },
      }),
    notifyRequester: vi.fn(),
    listPendingConfirmations: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    getRuntimeHealth: vi.fn(),
    nextStreamRequestId: () => 'stream-1',
    audited: (_method, handler) => handler,
    gated: (_method, handler) => handler,
  } as GatewayMethodRuntime;
  registerShardBackendMethods(runtime);
  const method = methods.get('shard.backend.request');
  if (!method) {
    throw new Error('shard.backend.request method was not registered');
  }
  return {
    invoke(params: Record<string, unknown>) {
      return method(params);
    },
  };
}

const POLICY: PolicyConfig = { workspacePath: process.cwd() };

describe('registerShardBackendMethods', () => {
  it('denies mediated shard backends when the authoritative tier is below autonomous', async () => {
    const harness = createHarness({ policyConfig: POLICY, capabilityTier: 'apprentice' });

    await expect(harness.invoke({
      shardId: 'shard-1',
      name: 'containerized-research',
      backend: 'container',
      capabilityTier: 'apprentice',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('requires autonomous or custom capability tier'),
    });
  });

  it('refuses a spoofed autonomous declaration when the runtime tier is apprentice', async () => {
    // The agent process declares capabilityTier=autonomous in the RPC params,
    // but the gateway's authoritative tier is apprentice: the boundary must
    // ignore the caller-declared value and refuse.
    const harness = createHarness({ policyConfig: POLICY, capabilityTier: 'apprentice' });

    await expect(harness.invoke({
      shardId: 'shard-spoof',
      name: 'containerized-research',
      backend: 'container',
      capabilityTier: 'autonomous',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('(current: "apprentice")'),
    });
  });

  it('allows the backend when the authoritative runtime tier is autonomous', async () => {
    // Caller under-declares (nursery) but the gateway tier is autonomous: the
    // authoritative value drives the decision, so the request is admitted.
    const harness = createHarness({ policyConfig: POLICY, capabilityTier: 'autonomous' });

    await expect(harness.invoke({
      shardId: 'shard-2',
      name: 'orchestrated-research',
      backend: 'orchestrated',
      capabilityTier: 'nursery',
    })).resolves.toEqual({
      backend: 'orchestrated',
      controller: 'gateway',
      status: 'unavailable',
      reason: expect.stringContaining('no kubectl-backed shard executor is wired'),
    });
  });

  it('fails closed when the gateway has no capability tier provider wired', async () => {
    const harness = createHarness({ policyConfig: POLICY, omitTierProvider: true });

    await expect(harness.invoke({
      shardId: 'shard-3',
      name: 'containerized-research',
      backend: 'container',
      capabilityTier: 'autonomous',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('tier provider is unavailable'),
    });
  });

  it('fails closed to POLICY_DENIED when the tier provider throws', async () => {
    // A malformed capability-tier.json makes CapabilityRuntime.getTier()
    // refreshFromDisk() throw. The boundary must convert that into a
    // POLICY_DENIED refusal (fail closed), not let the raw error escape as a
    // generic -32603 Internal error.
    const harness = createHarness({
      policyConfig: POLICY,
      tierProviderThrows: new Error('capability-tier.json is malformed'),
    });

    const rejection = harness.invoke({
      shardId: 'shard-throws',
      name: 'containerized-research',
      backend: 'container',
      capabilityTier: 'autonomous',
    });

    await expect(rejection).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('capability tier could not be resolved'),
    });
    // Guard against regressing to the generic Internal-error mapping.
    await expect(rejection).rejects.not.toMatchObject({
      code: -32603,
    });
  });
});
