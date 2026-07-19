import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ShardWorkloadRegistry } from '../../faculties/shards/workload-registry.js';
import { CAPABILITY_TOKENS } from '../../system/capabilities/tokens.js';
import { deriveShardCapabilityGrant } from '../../system/capabilities/shard-derivation.js';
import { GatewayShardWorkloadRegistrar } from './shard-workload-registrar.js';

const PARENT = 'companion-registrar-test';

function fixture() {
  const registry = new ShardWorkloadRegistry();
  const grant = deriveShardCapabilityGrant({
    companionId: PARENT,
    tier: 'custom',
    customTokens: [...CAPABILITY_TOKENS],
  });
  const registrar = new GatewayShardWorkloadRegistrar(registry, () => ({
    tier: 'custom',
    customTokens: [...CAPABILITY_TOKENS],
    grantedTokens: [...CAPABILITY_TOKENS],
  }));
  const params = {
    registrationId: randomUUID(),
    shardId: 'shard-registrar',
    shardLabel: 'Registrar Shard',
    channelIds: ['shard:registrar', 'shard:registrar:human'],
    ownerVersion: grant.ownerVersion,
    grantDigest: grant.grantDigest,
  };
  return { registry, registrar, params };
}

describe('GatewayShardWorkloadRegistrar', () => {
  it('derives authority at the gateway and revokes every connection lease on disconnect', () => {
    const { registry, registrar, params } = fixture();
    const connection = {};

    const registered = registrar.register(connection, PARENT, params);
    expect(registered.registrationId).toBe(params.registrationId);
    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:registrar')).toBeDefined();

    registrar.releaseConnection(connection);
    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:registrar')).toBeUndefined();
    expect(registry.hasHostedWorkloadForChannel(PARENT, 'shard:registrar')).toBe(true);
  });

  it('rejects stale agent grant assertions without registering a workload', () => {
    const { registry, registrar, params } = fixture();
    expect(() => registrar.register({}, PARENT, {
      ...params,
      grantDigest: '0'.repeat(64),
    })).toThrow(/does not match current gateway authority/);
    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:registrar')).toBeUndefined();
  });

  it('scopes end leases to the authenticated connection', () => {
    const { registry, registrar, params } = fixture();
    const ownerConnection = {};
    registrar.register(ownerConnection, PARENT, params);

    expect(registrar.end({}, { registrationId: params.registrationId })).toEqual({
      ended: false,
    });
    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:registrar')).toBeDefined();
    expect(registrar.end(ownerConnection, { registrationId: params.registrationId })).toEqual({
      ended: true,
    });
    expect(registry.resolveWorkloadForChannel(PARENT, 'shard:registrar')).toBeUndefined();
  });
});
