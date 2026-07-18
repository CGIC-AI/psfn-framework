import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../routing/companion-id.js';
import {
  ShardParentIcpAdapter,
  createShardParentIcpEnvelope,
} from './shard-parent-icp.js';

const parentCompanionId = createCompanionId('11111111-1111-4111-8111-111111111111');

describe('ShardParentIcpAdapter', () => {
  it('keeps the parent CompanionId as the routing key and shardId as inner lineage', async () => {
    const deliverOrdinaryIcp = vi.fn(async () => {});
    const adapter = new ShardParentIcpAdapter(parentCompanionId, { deliverOrdinaryIcp });

    await adapter.sendFromShard('shard-live-1', 'I need parent guidance');

    expect(deliverOrdinaryIcp).toHaveBeenCalledWith({
      schemaVersion: 1,
      routingCompanionId: parentCompanionId,
      lineage: {
        parentCompanionId,
        shardId: 'shard-live-1',
      },
      direction: 'shard_to_parent',
      content: 'I need parent guidance',
    });
    expect(adapter).not.toHaveProperty('register');
    expect(adapter).not.toHaveProperty('subscribe');
    expect(adapter).not.toHaveProperty('roster');
  });

  it('rejects empty lineage or traffic instead of inventing a peer/fallback identity', () => {
    expect(() => createShardParentIcpEnvelope({
      parentCompanionId,
      shardId: ' ',
      direction: 'parent_to_shard',
      content: 'hello',
    })).toThrow(/non-empty shard lineage/u);
    expect(() => createShardParentIcpEnvelope({
      parentCompanionId,
      shardId: 'shard-live-1',
      direction: 'parent_to_shard',
      content: ' ',
    })).toThrow(/non-empty shard lineage/u);
  });
});
