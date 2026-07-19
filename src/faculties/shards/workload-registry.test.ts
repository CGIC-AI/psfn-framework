import { describe, expect, it } from 'vitest';
import { CAPABILITY_TOKENS } from '../../system/capabilities/tokens.js';
import { deriveShardCapabilityGrant } from '../../system/capabilities/shard-derivation.js';
import { ShardWorkloadRegistry } from './workload-registry.js';

const PARENT = 'companion-parent-test';
const OTHER_PARENT = 'companion-parent-other';

function derivedGrant(companionId = PARENT) {
  return deriveShardCapabilityGrant({
    companionId,
    tier: 'custom',
    customTokens: [...CAPABILITY_TOKENS],
  });
}

function register(
  registry: ShardWorkloadRegistry,
  overrides: {
    parentCompanionId?: string;
    shardId?: string;
    channelIds?: string[];
  } = {},
) {
  const shardId = overrides.shardId ?? 'shard-a';
  const parentCompanionId = overrides.parentCompanionId ?? PARENT;
  return registry.registerWorkload({
    parentCompanionId,
    shardId,
    shardLabel: 'Test Shard',
    channelIds: overrides.channelIds ?? [`shard:${shardId}`, `shard:${shardId}:human`],
    capabilityGrant: derivedGrant(parentCompanionId.trim() ? parentCompanionId : PARENT),
  });
}

describe('ShardWorkloadRegistry (production workload handles, 2h6q.3)', () => {
  it('mints a resolvable handle whose registration object is reference-stable per generation', () => {
    const registry = new ShardWorkloadRegistry();
    const handle = register(registry);

    const first = registry.resolveAuthenticatedWorkload(handle);
    const second = registry.resolveAuthenticatedWorkload(handle);
    expect(first).toBeDefined();
    // The SAME frozen registration (and therefore the same frozen derived
    // access) is returned on every resolve — the mus2.7 authority compares
    // access by reference identity.
    expect(second).toBe(first);
    expect(second?.capabilityGrant.access).toBe(first?.capabilityGrant.access);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first?.parentCompanionId).toBe(PARENT);
    expect(first?.shardId).toBe('shard-a');
    expect(first?.workloadGeneration).toMatch(/^shard-a#g\d+-/);
  });

  it('resolves the current workload by registered channel id, scoped to the parent', () => {
    const registry = new ShardWorkloadRegistry();
    const handle = register(registry);

    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:shard-a')).toBe(handle);
    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:shard-a:human')).toBe(handle);
    // Another parent can never resolve this workload through channel lookup.
    expect(registry.resolveWorkloadForChannel(OTHER_PARENT, 'shard:shard-a')).toBeUndefined();
    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:unknown')).toBeUndefined();
  });

  it('ends a workload: handle and channel bindings stop resolving', () => {
    const registry = new ShardWorkloadRegistry();
    const handle = register(registry);

    registry.endWorkload(handle);
    expect(registry.resolveAuthenticatedWorkload(handle)).toBeUndefined();
    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:shard-a')).toBeUndefined();
    // Idempotent.
    expect(() => registry.endWorkload(handle)).not.toThrow();
  });

  it('supersedes the previous generation when the same (parent, shard) re-registers', () => {
    const registry = new ShardWorkloadRegistry();
    const first = register(registry);
    const second = register(registry);

    expect(registry.resolveAuthenticatedWorkload(first)).toBeUndefined();
    const registration = registry.resolveAuthenticatedWorkload(second);
    expect(registration).toBeDefined();
    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:shard-a')).toBe(second);
  });

  it('denies ambiguous channel lineage while two live workloads claim one channel', () => {
    const registry = new ShardWorkloadRegistry();
    const first = register(registry, { shardId: 'wy-a', channelIds: ['api:wyoming:site:sat'] });
    const second = register(registry, { shardId: 'wy-b', channelIds: ['api:wyoming:site:sat'] });

    expect(() => registry.resolveWorkloadForChannel(PARENT, 'api:wyoming:site:sat'))
      .toThrow(/ambiguous/);
    // Handles themselves stay individually resolvable.
    expect(registry.resolveAuthenticatedWorkload(first)).toBeDefined();
    expect(registry.resolveAuthenticatedWorkload(second)).toBeDefined();
    // Once one claimant ends, the channel is unambiguous again.
    registry.endWorkload(first);
    expect(registry.resolveWorkloadForChannel(PARENT, 'api:wyoming:site:sat')).toBe(second);
  });

  it('fails closed on malformed registrations', () => {
    const registry = new ShardWorkloadRegistry();
    expect(() => register(registry, { parentCompanionId: '  ' })).toThrow(/parentCompanionId/);
    expect(() => register(registry, { shardId: '' })).toThrow(/shardId/);
    expect(() => register(registry, { channelIds: [] })).toThrow(/channel id/);
    expect(() => register(registry, { channelIds: ['  '] })).toThrow(/channelIds\[0\]/);
  });
});
