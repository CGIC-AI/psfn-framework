import {
  ShardParentIcpAdapter,
  type PolicyGovernedShardParentIcpDeliveryPort,
} from '../../shared/contracts/shard-parent-icp.js';
import type { ShardDirectoryPort } from '../../shared/contracts/shard-directory.js';
import type { ShardParentIcpPort } from './port.js';

/**
 * Live-deployment guard in front of the ordinary ICP adapter. It is a separate
 * runtime surface so directory/chat policy does not accrete in ShardManager.
 */
export class LiveShardParentIcpRuntime implements ShardParentIcpPort {
  constructor(
    private readonly directory: Pick<ShardDirectoryPort, 'ownerOfLiveShard'>,
    private readonly delivery: PolicyGovernedShardParentIcpDeliveryPort | null,
  ) {}

  async sendShardParentIcp(shardId: string, content: string): Promise<void> {
    const parentCompanionId = this.directory.ownerOfLiveShard(shardId);
    if (!parentCompanionId) {
      throw new Error('Shard-parent ICP denied for an unavailable or foreign shard');
    }
    if (!this.delivery) {
      throw new Error('Shard-parent ICP denied because no policy-governed ordinary ICP ingress is wired');
    }
    await new ShardParentIcpAdapter(parentCompanionId, this.delivery)
      .sendFromShard(shardId, content);
  }
}
