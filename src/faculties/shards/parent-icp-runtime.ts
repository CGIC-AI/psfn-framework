import {
  ShardParentIcpAdapter,
  type PolicyGovernedShardParentIcpDeliveryPort,
} from '../../shared/contracts/shard-parent-icp.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { ShardParentIcpPort } from './types.js';

interface LiveShardGenerationDirectoryPort {
  snapshotLiveShardGeneration(shardId: string): Readonly<{
    parentCompanionId: CompanionId;
    generation: object;
  }> | undefined;
}

/**
 * Live-deployment guard in front of the ordinary ICP adapter. It is a separate
 * runtime surface so directory/chat policy does not accrete in ShardManager.
 */
export class LiveShardParentIcpRuntime implements ShardParentIcpPort {
  constructor(
    private readonly directory: LiveShardGenerationDirectoryPort,
    private readonly delivery: PolicyGovernedShardParentIcpDeliveryPort | null,
  ) {}

  async sendShardParentIcp(shardId: string, content: string): Promise<string> {
    const liveGeneration = this.directory.snapshotLiveShardGeneration(shardId);
    if (!liveGeneration) {
      throw new Error('Shard-parent ICP denied for an unavailable or foreign shard');
    }
    const { parentCompanionId } = liveGeneration;
    if (!this.delivery) {
      throw new Error('Shard-parent ICP denied because no policy-governed ordinary ICP ingress is wired');
    }
    const response = await new ShardParentIcpAdapter(parentCompanionId, this.delivery)
      .sendFromShard(shardId, content);
    // The shard may have ended while its parent turn was queued or running.
    // Never deliver a late response into a stale/replaced workload.
    const currentGeneration = this.directory.snapshotLiveShardGeneration(shardId);
    if (currentGeneration?.parentCompanionId !== parentCompanionId
      || currentGeneration.generation !== liveGeneration.generation) {
      throw new Error('Shard-parent ICP response denied because the shard generation is no longer live');
    }
    return response.content;
  }
}
