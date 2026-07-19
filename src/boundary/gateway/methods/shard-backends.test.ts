import { describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime, ShardBackendExecutor } from './types.js';
import type { PolicyConfig } from '../policy.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import {
  canonicalizeCapabilityTokens,
  createShardParentGrantSnapshot,
  deriveShardCapabilityGrant,
} from '../../../system/capabilities/shard-derivation.js';
import { GatewayErrors, type ShardBackendRequestParams } from '../protocol.js';
import { registerShardBackendMethods } from './shard-backends.js';

interface HarnessOptions {
  policyConfig: PolicyConfig;
  authenticatedCompanionId?: string;
  snapshots?: readonly CapabilityGrantSnapshot[];
  omitSnapshotProvider?: boolean;
  snapshotProviderThrows?: Error;
  executor?: ShardBackendExecutor;
}

function snapshotFor(
  tier: CapabilityTier,
  customTokens: readonly CapabilityToken[] = [],
): CapabilityGrantSnapshot {
  const parent = createShardParentGrantSnapshot({
    companionId: 'snapshot-fixture',
    tier,
    customTokens,
  });
  return Object.freeze({
    tier,
    customTokens: canonicalizeCapabilityTokens(customTokens, 'customTokens'),
    grantedTokens: parent.tokens,
  });
}

function boundParams(
  snapshot: CapabilityGrantSnapshot,
  companionId = 'companion-a',
  overrides: Partial<ShardBackendRequestParams> = {},
): ShardBackendRequestParams {
  const grant = deriveShardCapabilityGrant({
    companionId,
    tier: snapshot.tier,
    customTokens: snapshot.customTokens,
  });
  return {
    shardId: 'shard-1',
    name: 'containerized-research',
    backend: 'container',
    ownerVersion: grant.ownerVersion,
    grantDigest: grant.grantDigest,
    ...overrides,
  };
}

function unavailableResult(backend: 'container' | 'orchestrated' = 'container') {
  return {
    backend,
    controller: 'gateway' as const,
    status: 'unavailable' as const,
    reason: 'test executor',
  };
}

function createHarness(options: HarnessOptions): {
  invoke(params: Record<string, unknown>): Promise<any>;
  snapshotProvider: ReturnType<typeof vi.fn>;
  executor: ReturnType<typeof vi.fn>;
} {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<any>>();
  const keyring = {
    activeVersion: 'v1',
    keys: { v1: 'test-shard-backend-secret' },
  };
  const snapshots = options.snapshots ?? [snapshotFor('autonomous')];
  let snapshotIndex = 0;
  const snapshotProvider = vi.fn(() => {
    if (options.snapshotProviderThrows) {
      throw options.snapshotProviderThrows;
    }
    const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
    snapshotIndex += 1;
    return snapshot;
  });
  const executor = vi.fn(options.executor ?? (async context => unavailableResult(context.backend)));
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
    ...(options.omitSnapshotProvider
      ? {}
      : { capabilityGrantSnapshotProvider: snapshotProvider }),
    shardBackendExecutor: executor,
    authenticatedCompanionId: () => options.authenticatedCompanionId ?? 'companion-a',
    notifyRequester: vi.fn(),
    listPendingConfirmations: () => [],
    listConfirmationHistory: () => [],
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
    invoke: params => method(params),
    snapshotProvider,
    executor,
  };
}

const POLICY: PolicyConfig = { workspacePath: process.cwd() };

describe('registerShardBackendMethods', () => {
  it('retains the autonomous/custom backend-tier restriction', async () => {
    const snapshot = snapshotFor('apprentice');
    const harness = createHarness({ policyConfig: POLICY, snapshots: [snapshot] });

    await expect(harness.invoke(boundParams(snapshot))).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('requires autonomous or custom capability tier'),
    });
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('denies custom authority without shard.spawn despite spoofed tier and tokens', async () => {
    const snapshot = snapshotFor('custom', ['identity.read']);
    const harness = createHarness({ policyConfig: POLICY, snapshots: [snapshot] });

    await expect(harness.invoke({
      ...boundParams(snapshot),
      capabilityTier: 'autonomous',
      customTokens: ['identity.read', 'shard.spawn', 'world.control'],
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('requires authoritative parent capability "shard.spawn"'),
    });
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('derives the exact custom mask and passes the immutable access to execution', async () => {
    const snapshot = snapshotFor('custom', [
      'world.control',
      'lifecycle.restart',
      'lifecycle.rebuild',
      'identity.write.base',
      'identity.write.operator',
      'memory.delete',
      'memory.write',
      'shard.spawn',
      'identity.read',
    ]);
    const executor = vi.fn(async context => {
      expect(context.parentCompanionId).toBe('companion-a');
      expect(context.parentTier).toBe('custom');
      expect(context.access.getTier()).toBe('custom');
      expect([...context.access.getGrantedTokens()]).toEqual([
        'identity.read',
        'memory.write',
        'shard.spawn',
      ]);
      expect(() => (context.access.getGrantedTokens() as Set<CapabilityToken>).add('world.control'))
        .toThrow('immutable');
      return unavailableResult(context.backend);
    });
    const harness = createHarness({ policyConfig: POLICY, snapshots: [snapshot], executor });

    await expect(harness.invoke(boundParams(snapshot))).resolves.toEqual(unavailableResult());
    expect(harness.snapshotProvider).toHaveBeenCalledTimes(2);
    expect(harness.executor).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the gateway has no atomic snapshot provider', async () => {
    const snapshot = snapshotFor('autonomous');
    const harness = createHarness({ policyConfig: POLICY, omitSnapshotProvider: true });

    await expect(harness.invoke(boundParams(snapshot))).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('snapshot provider is unavailable'),
    });
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('fails closed to POLICY_DENIED when the snapshot provider throws', async () => {
    const snapshot = snapshotFor('autonomous');
    const harness = createHarness({
      policyConfig: POLICY,
      snapshotProviderThrows: new Error('capability-tier.json is malformed'),
    });

    const rejection = harness.invoke(boundParams(snapshot));
    await expect(rejection).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('could not be resolved during admission'),
    });
    await expect(rejection).rejects.not.toMatchObject({ code: -32603 });
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed atomic snapshot', async () => {
    const valid = snapshotFor('autonomous');
    const malformed = {
      ...valid,
      grantedTokens: [...valid.grantedTokens, 'unknown.capability'],
    } as unknown as CapabilityGrantSnapshot;
    const harness = createHarness({ policyConfig: POLICY, snapshots: [malformed] });

    await expect(harness.invoke(boundParams(valid))).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('could not be resolved during admission'),
    });
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('denies a manager/gateway digest mismatch before execution', async () => {
    const snapshot = snapshotFor('autonomous');
    const harness = createHarness({ policyConfig: POLICY, snapshots: [snapshot] });

    await expect(harness.invoke({
      ...boundParams(snapshot),
      grantDigest: '0'.repeat(64),
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('does not match current gateway authority'),
    });
    expect(harness.snapshotProvider).toHaveBeenCalledTimes(1);
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('denies manager/gateway owner-file churn even when effective tokens are unchanged', async () => {
    const managerSnapshot = snapshotFor('autonomous');
    const gatewaySnapshot = snapshotFor('autonomous', ['identity.read']);
    const harness = createHarness({ policyConfig: POLICY, snapshots: [gatewaySnapshot] });

    await expect(harness.invoke(boundParams(managerSnapshot))).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('does not match current gateway authority'),
    });
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('denies owner-file churn between admission and execution before executor side effects', async () => {
    const admittedSnapshot = snapshotFor('autonomous');
    const changedSnapshot = snapshotFor('autonomous', ['identity.read']);
    const harness = createHarness({
      policyConfig: POLICY,
      snapshots: [admittedSnapshot, changedSnapshot],
    });

    await expect(harness.invoke(boundParams(admittedSnapshot))).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('capability owner changed after admission'),
    });
    expect(harness.snapshotProvider).toHaveBeenCalledTimes(2);
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('binds the digest to the authenticated companion identity', async () => {
    const snapshot = snapshotFor('autonomous');
    const harness = createHarness({
      policyConfig: POLICY,
      authenticatedCompanionId: 'companion-b',
      snapshots: [snapshot],
    });

    await expect(harness.invoke(boundParams(snapshot, 'companion-a'))).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('does not match current gateway authority'),
    });
    expect(harness.executor).not.toHaveBeenCalled();
  });

  it('admits matching manager/gateway authority and preserves unavailable backend behavior', async () => {
    const snapshot = snapshotFor('autonomous');
    const harness = createHarness({ policyConfig: POLICY, snapshots: [snapshot] });

    await expect(harness.invoke(boundParams(snapshot, 'companion-a', {
      backend: 'orchestrated',
      name: 'orchestrated-research',
    }))).resolves.toEqual(unavailableResult('orchestrated'));
    expect(harness.snapshotProvider).toHaveBeenCalledTimes(2);
    expect(harness.executor).toHaveBeenCalledTimes(1);
  });
});
