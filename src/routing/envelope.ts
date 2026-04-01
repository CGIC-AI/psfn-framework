export const GATEWAY_ROUTING_ENVELOPE_SCHEMA_VERSION = 1 as const;

export type CompanionId = string;

export interface ShardLineage {
  coreCompanionId: CompanionId;
  shardCompanionId: CompanionId;
  shardId: string;
  parentShardId?: string;
}

export interface GatewaySubagentAddress {
  executionPort: 'subagent';
  workerId: string;
  lane?: string;
}

export interface GatewayRoutingEnvelope {
  schemaVersion: 1;
  companionId: CompanionId;
  shard?: ShardLineage;
  subagentAddress?: GatewaySubagentAddress;
}

export interface CreateShardLineageInput {
  companionId: CompanionId;
  shardId: string;
  parentShardId?: string;
  shardCompanionId?: CompanionId;
}

export interface CreateGatewayRoutingEnvelopeInput {
  companionId: CompanionId;
  shard?: ShardLineage;
  subagentAddress?: GatewaySubagentAddress;
}

export interface DeriveShardRoutingEnvelopeInput {
  companionId: CompanionId;
  shardId: string;
  parentShardId?: string;
  shardCompanionId?: CompanionId;
  subagentAddress?: GatewaySubagentAddress;
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Gateway routing ${field} must be non-empty`);
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function deriveShardCompanionId(companionId: CompanionId, shardId: string): CompanionId {
  return `${companionId}/shards/${shardId}`;
}

export function createShardLineage(input: CreateShardLineageInput): ShardLineage {
  const coreCompanionId = normalizeRequiredString(input.companionId, 'companionId');
  const shardId = normalizeRequiredString(input.shardId, 'shardId');
  const shardCompanionId = normalizeRequiredString(
    input.shardCompanionId ?? deriveShardCompanionId(coreCompanionId, shardId),
    'shardCompanionId',
  );
  const parentShardId = normalizeOptionalString(input.parentShardId);

  return {
    coreCompanionId,
    shardCompanionId,
    shardId,
    ...(parentShardId ? { parentShardId } : {}),
  };
}

export function cloneShardLineage(lineage: ShardLineage | undefined): ShardLineage | undefined {
  if (!lineage) return undefined;
  return {
    coreCompanionId: normalizeRequiredString(lineage.coreCompanionId, 'coreCompanionId'),
    shardCompanionId: normalizeRequiredString(lineage.shardCompanionId, 'shardCompanionId'),
    shardId: normalizeRequiredString(lineage.shardId, 'shardId'),
    ...(normalizeOptionalString(lineage.parentShardId)
      ? { parentShardId: normalizeOptionalString(lineage.parentShardId) }
      : {}),
  };
}

export function cloneGatewaySubagentAddress(
  subagentAddress: GatewaySubagentAddress | undefined,
): GatewaySubagentAddress | undefined {
  if (!subagentAddress) return undefined;
  return {
    executionPort: 'subagent',
    workerId: normalizeRequiredString(subagentAddress.workerId, 'subagentAddress.workerId'),
    ...(normalizeOptionalString(subagentAddress.lane)
      ? { lane: normalizeOptionalString(subagentAddress.lane) }
      : {}),
  };
}

export function createGatewayRoutingEnvelope(
  input: CreateGatewayRoutingEnvelopeInput,
): GatewayRoutingEnvelope {
  return {
    schemaVersion: GATEWAY_ROUTING_ENVELOPE_SCHEMA_VERSION,
    companionId: normalizeRequiredString(input.companionId, 'companionId'),
    ...(input.shard ? { shard: cloneShardLineage(input.shard) } : {}),
    ...(input.subagentAddress
      ? { subagentAddress: cloneGatewaySubagentAddress(input.subagentAddress) }
      : {}),
  };
}

export function cloneGatewayRoutingEnvelope(
  envelope: GatewayRoutingEnvelope | undefined,
): GatewayRoutingEnvelope | undefined {
  if (!envelope) return undefined;
  return createGatewayRoutingEnvelope({
    companionId: envelope.companionId,
    shard: envelope.shard,
    subagentAddress: envelope.subagentAddress,
  });
}

export function deriveShardRoutingEnvelope(
  input: DeriveShardRoutingEnvelopeInput,
): GatewayRoutingEnvelope {
  return createGatewayRoutingEnvelope({
    companionId: input.companionId,
    shard: createShardLineage({
      companionId: input.companionId,
      shardId: input.shardId,
      parentShardId: input.parentShardId,
      shardCompanionId: input.shardCompanionId,
    }),
    ...(input.subagentAddress ? { subagentAddress: input.subagentAddress } : {}),
  });
}
