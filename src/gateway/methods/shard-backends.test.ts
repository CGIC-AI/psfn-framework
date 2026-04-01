import { describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import type { PolicyConfig } from '../policy.js';
import { GatewayErrors } from '../protocol.js';
import { registerShardBackendMethods } from './shard-backends.js';

function createHarness(policyConfig: PolicyConfig): {
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
    policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: keyring,
    notifyAll: vi.fn(),
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
  };
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

describe('registerShardBackendMethods', () => {
  it('denies mediated shard backends outside autonomous tiers', async () => {
    const harness = createHarness({ workspacePath: process.cwd() });

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

  it('fails closed with explicit unavailable result when no executor is wired', async () => {
    const harness = createHarness({ workspacePath: process.cwd() });

    await expect(harness.invoke({
      shardId: 'shard-2',
      name: 'orchestrated-research',
      backend: 'orchestrated',
      capabilityTier: 'autonomous',
    })).resolves.toEqual({
      backend: 'orchestrated',
      controller: 'gateway',
      status: 'unavailable',
      reason: expect.stringContaining('no kubectl-backed shard executor is wired'),
    });
  });
});
