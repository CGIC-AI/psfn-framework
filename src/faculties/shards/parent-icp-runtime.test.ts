import { describe, expect, it } from 'vitest';
import type { ShardParentIcpEnvelope } from '../../shared/contracts/shard-parent-icp.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { LiveShardParentIcpRuntime } from './parent-icp-runtime.js';

describe('LiveShardParentIcpRuntime generation binding', () => {
  it('denies a response when the same shard id is replaced during the parent turn', async () => {
    const parentCompanionId = createCompanionId('11111111-1111-4111-8111-111111111111');
    const firstGeneration = {};
    let currentGeneration = firstGeneration;
    let releaseResponse!: (response: ShardParentIcpEnvelope) => void;
    const pendingResponse = new Promise<ShardParentIcpEnvelope>((resolve) => {
      releaseResponse = resolve;
    });
    const directory = {
      snapshotLiveShardGeneration: () => ({
        parentCompanionId,
        generation: currentGeneration,
      }),
    };
    const runtime = new LiveShardParentIcpRuntime(directory, {
      deliverOrdinaryIcp: async () => await pendingResponse,
    });

    const exchange = runtime.sendShardParentIcp('same-shard-id', 'Question');
    currentGeneration = {};
    releaseResponse({
      schemaVersion: 1,
      routingCompanionId: parentCompanionId,
      lineage: {
        parentCompanionId,
        shardId: 'same-shard-id',
      },
      direction: 'parent_to_shard',
      content: 'Late response for the replaced generation',
    });

    await expect(exchange).rejects.toThrow(/generation is no longer live/u);
  });
});
