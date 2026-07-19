import {
  createCompanionId,
  type CompanionId,
} from '../routing/companion-id.js';
import { isRecord } from '../utils/types.js';

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

/** Content-free provenance attached to the parent companion's ordinary turn. */
export type ShardParentIcpRoutingMetadata = Readonly<
  Omit<ShardParentIcpEnvelope, 'content'>
>;

const ROUTING_METADATA_KEYS = new Set([
  'schemaVersion',
  'routingCompanionId',
  'lineage',
  'direction',
]);
const ENVELOPE_KEYS = new Set([...ROUTING_METADATA_KEYS, 'content']);
const LINEAGE_KEYS = new Set(['parentCompanionId', 'shardId']);

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  const unknownKey = Object.keys(value).find(key => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`${label} contains unknown field "${unknownKey}"`);
  }
}

/**
 * Strictly decode untrusted shard-parent routing metadata. No numeric or
 * string coercion is permitted because this provenance controls the contact
 * and trust path selected at cognition ingress.
 */
export function parseShardParentIcpRoutingMetadata(
  value: unknown,
): ShardParentIcpRoutingMetadata {
  if (!isRecord(value)) {
    throw new Error('Shard-parent ICP routing metadata must be an object');
  }
  assertExactKeys(value, ROUTING_METADATA_KEYS, 'Shard-parent ICP routing metadata');
  if (value.schemaVersion !== 1) {
    throw new Error('Shard-parent ICP schema version is unsupported');
  }
  if (!isRecord(value.lineage)) {
    throw new Error('Shard-parent ICP lineage must be an object');
  }
  assertExactKeys(value.lineage, LINEAGE_KEYS, 'Shard-parent ICP lineage');

  const routingCompanionId = createCompanionId(
    value.routingCompanionId,
    'Shard-parent ICP routing companionId',
  );
  const lineageParentCompanionId = createCompanionId(
    value.lineage.parentCompanionId,
    'Shard-parent ICP lineage parent companionId',
  );
  if (routingCompanionId !== lineageParentCompanionId) {
    throw new Error('Shard-parent ICP routing and lineage parent mismatch');
  }
  if (typeof value.lineage.shardId !== 'string' || !value.lineage.shardId.trim()) {
    throw new Error('Shard-parent ICP requires non-empty shard lineage');
  }
  if (value.direction !== 'shard_to_parent' && value.direction !== 'parent_to_shard') {
    throw new Error('Shard-parent ICP direction is invalid');
  }

  return Object.freeze({
    schemaVersion: 1,
    routingCompanionId,
    lineage: Object.freeze({
      parentCompanionId: lineageParentCompanionId,
      shardId: value.lineage.shardId.trim(),
    }),
    direction: value.direction,
  });
}

/** Strictly decode a complete ordinary shard-parent ICP envelope. */
export function parseShardParentIcpEnvelope(value: unknown): ShardParentIcpEnvelope {
  if (!isRecord(value)) {
    throw new Error('Shard-parent ICP envelope must be an object');
  }
  assertExactKeys(value, ENVELOPE_KEYS, 'Shard-parent ICP envelope');
  const routing = parseShardParentIcpRoutingMetadata({
    schemaVersion: value.schemaVersion,
    routingCompanionId: value.routingCompanionId,
    lineage: value.lineage,
    direction: value.direction,
  });
  if (typeof value.content !== 'string' || !value.content.trim()) {
    throw new Error('Shard-parent ICP requires non-empty shard lineage and content');
  }
  return Object.freeze({
    ...routing,
    content: value.content.trim(),
  });
}

export function formatShardParentIcpChannelId(
  routing: Pick<ShardParentIcpRoutingMetadata, 'routingCompanionId' | 'lineage'>,
): string {
  return `companion-shard:${routing.routingCompanionId}:${routing.lineage.shardId}`;
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
  return parseShardParentIcpEnvelope({
    schemaVersion: 1,
    routingCompanionId: input.parentCompanionId,
    lineage: {
      parentCompanionId: input.parentCompanionId,
      shardId: input.shardId,
    },
    direction: input.direction,
    content: input.content,
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
