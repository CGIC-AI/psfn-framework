import type { CompanionId } from '../routing/companion-id.js';

/**
 * Inner address for ordinary shard↔parent ICP traffic. The parent CompanionId
 * remains the sole fleet routing identity; shardId is provenance and inner
 * addressing only.
 */
export interface ShardParentIcpLineage {
  readonly parentCompanionId: CompanionId;
  readonly shardId: string;
}

export interface ShardParentIcpEnvelope {
  readonly schemaVersion: 1;
  readonly routingCompanionId: CompanionId;
  readonly lineage: ShardParentIcpLineage;
  readonly direction: 'shard_to_parent' | 'parent_to_shard';
  readonly content: string;
}

/**
 * Governed ordinary-ICP ingress. Implementations must feed the canonical
 * companion turn lane, including its intake, trust, fatigue, and loop-safety
 * gates. This deliberately exposes no raw peer registration or roster API.
 */
export interface PolicyGovernedShardParentIcpDeliveryPort {
  deliverOrdinaryIcp(envelope: ShardParentIcpEnvelope): Promise<void>;
}

export function createShardParentIcpEnvelope(input: Readonly<{
  parentCompanionId: CompanionId;
  shardId: string;
  direction: ShardParentIcpEnvelope['direction'];
  content: string;
}>): ShardParentIcpEnvelope {
  const shardId = input.shardId.trim();
  const content = input.content.trim();
  if (!shardId || !content) {
    throw new Error('Shard-parent ICP requires non-empty shard lineage and content');
  }
  return Object.freeze({
    schemaVersion: 1,
    routingCompanionId: input.parentCompanionId,
    lineage: Object.freeze({
      parentCompanionId: input.parentCompanionId,
      shardId,
    }),
    direction: input.direction,
    content,
  });
}

/**
 * The adapter deliberately exposes no subscriber-registration or peer-roster
 * operation. A ShardInstanceId can therefore never be promoted to a peer
 * CompanionId through this surface.
 */
export class ShardParentIcpAdapter {
  constructor(
    private readonly parentCompanionId: CompanionId,
    private readonly delivery: PolicyGovernedShardParentIcpDeliveryPort,
  ) {}

  async sendFromShard(shardId: string, content: string): Promise<void> {
    await this.delivery.deliverOrdinaryIcp(createShardParentIcpEnvelope({
      parentCompanionId: this.parentCompanionId,
      shardId,
      direction: 'shard_to_parent',
      content,
    }));
  }

  async sendToShard(shardId: string, content: string): Promise<void> {
    await this.delivery.deliverOrdinaryIcp(createShardParentIcpEnvelope({
      parentCompanionId: this.parentCompanionId,
      shardId,
      direction: 'parent_to_shard',
      content,
    }));
  }
}
