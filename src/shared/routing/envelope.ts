export const GATEWAY_ROUTING_ENVELOPE_SCHEMA_VERSION = 1 as const;

import {
  createCompanionId,
  createShardCompanionId,
  type CompanionId,
  type ShardCompanionId,
} from './companion-id.js';
import { isRecord } from '../utils/types.js';

export {
  createCompanionId,
  createShardCompanionId,
  type CompanionId,
  type ShardCompanionId,
} from './companion-id.js';
export type ShardCreationMode = 'fresh' | 'forked';

export interface ShardLineage {
  coreCompanionId: CompanionId;
  shardCompanionId: ShardCompanionId;
  shardId: string;
  creationMode: ShardCreationMode;
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
  creationMode?: ShardCreationMode;
  parentShardId?: string;
  shardCompanionId?: ShardCompanionId;
}

export interface CreateGatewayRoutingEnvelopeInput {
  companionId: CompanionId;
  shard?: ShardLineage;
  subagentAddress?: GatewaySubagentAddress;
}

export interface DeriveShardRoutingEnvelopeInput {
  companionId: CompanionId;
  shardId: string;
  creationMode?: ShardCreationMode;
  parentShardId?: string;
  shardCompanionId?: ShardCompanionId;
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

function deriveShardCompanionId(companionId: CompanionId, shardId: string): ShardCompanionId {
  return createShardCompanionId(`${companionId}/shards/${shardId}`, 'shardCompanionId');
}

function assertShardCompanionIdMatchesLineage(
  coreCompanionId: CompanionId,
  shardId: string,
  shardCompanionId: ShardCompanionId,
  fieldName: string,
): void {
  if (shardCompanionId !== `${coreCompanionId}/shards/${shardId}`
    && shardCompanionId !== `${coreCompanionId}::${shardId}`) {
    throw new Error(`${fieldName} must match coreCompanionId and shardId`);
  }
}

function normalizeShardCreationMode(value: ShardCreationMode | undefined): ShardCreationMode {
  if (value === undefined) {
    return 'fresh';
  }
  return value;
}

export function createShardLineage(input: CreateShardLineageInput): ShardLineage {
  const coreCompanionId = createCompanionId(input.companionId, 'Gateway routing companionId');
  const shardId = normalizeRequiredString(input.shardId, 'shardId');
  const shardCompanionId = createShardCompanionId(
    input.shardCompanionId ?? deriveShardCompanionId(coreCompanionId, shardId),
    'Gateway routing shardCompanionId',
  );
  assertShardCompanionIdMatchesLineage(
    coreCompanionId,
    shardId,
    shardCompanionId,
    'Gateway routing shardCompanionId',
  );
  const parentShardId = normalizeOptionalString(input.parentShardId);

  return {
    coreCompanionId,
    shardCompanionId,
    shardId,
    creationMode: normalizeShardCreationMode(input.creationMode),
    ...(parentShardId ? { parentShardId } : {}),
  };
}

export function cloneShardLineage(lineage: ShardLineage | undefined): ShardLineage | undefined {
  if (!lineage) return undefined;
  return createShardLineage({
    companionId: lineage.coreCompanionId,
    shardCompanionId: lineage.shardCompanionId,
    shardId: lineage.shardId,
    creationMode: lineage.creationMode,
    ...(lineage.parentShardId !== undefined ? { parentShardId: lineage.parentShardId } : {}),
  });
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
  const companionId = createCompanionId(input.companionId, 'Gateway routing companionId');
  const shard = cloneShardLineage(input.shard);
  if (shard && shard.coreCompanionId !== companionId) {
    throw new Error('Gateway routing shard.coreCompanionId must match companionId');
  }
  return {
    schemaVersion: GATEWAY_ROUTING_ENVELOPE_SCHEMA_VERSION,
    companionId,
    ...(shard ? { shard } : {}),
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
      creationMode: input.creationMode,
      parentShardId: input.parentShardId,
      shardCompanionId: input.shardCompanionId,
    }),
    ...(input.subagentAddress ? { subagentAddress: input.subagentAddress } : {}),
  });
}

function parseShardLineage(value: unknown, fieldName: string): ShardLineage {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  if (value.creationMode !== 'fresh' && value.creationMode !== 'forked') {
    throw new Error(`${fieldName}.creationMode must be "fresh" or "forked"`);
  }
  if (value.parentShardId !== undefined && typeof value.parentShardId !== 'string') {
    throw new Error(`${fieldName}.parentShardId must be a string when provided`);
  }
  const coreCompanionId = createCompanionId(
    value.coreCompanionId,
    `${fieldName}.coreCompanionId`,
  );
  const shardCompanionId = createShardCompanionId(
    value.shardCompanionId,
    `${fieldName}.shardCompanionId`,
  );
  const shardId = normalizeRequiredString(
    typeof value.shardId === 'string' ? value.shardId : '',
    `${fieldName}.shardId`,
  );
  assertShardCompanionIdMatchesLineage(
    coreCompanionId,
    shardId,
    shardCompanionId,
    `${fieldName}.shardCompanionId`,
  );
  return {
    coreCompanionId,
    shardCompanionId,
    shardId,
    creationMode: value.creationMode,
    ...(value.parentShardId !== undefined ? { parentShardId: value.parentShardId } : {}),
  };
}

function parseGatewaySubagentAddress(
  value: unknown,
  fieldName: string,
): GatewaySubagentAddress {
  if (!isRecord(value) || value.executionPort !== 'subagent') {
    throw new Error(`${fieldName} must be a subagent address object`);
  }
  if (value.lane !== undefined && typeof value.lane !== 'string') {
    throw new Error(`${fieldName}.lane must be a string when provided`);
  }
  return {
    executionPort: 'subagent',
    workerId: normalizeRequiredString(
      typeof value.workerId === 'string' ? value.workerId : '',
      `${fieldName}.workerId`,
    ),
    ...(typeof value.lane === 'string' && value.lane.trim()
      ? { lane: value.lane.trim() }
      : {}),
  };
}

/** Parse and re-brand a routing envelope received across a JSON/RPC boundary. */
export function parseGatewayRoutingEnvelope(
  value: unknown,
  fieldName = 'routing.gateway',
): GatewayRoutingEnvelope {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  if (value.schemaVersion !== GATEWAY_ROUTING_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(`${fieldName}.schemaVersion must be 1`);
  }
  return createGatewayRoutingEnvelope({
    companionId: createCompanionId(value.companionId, `${fieldName}.companionId`),
    ...(value.shard !== undefined
      ? { shard: parseShardLineage(value.shard, `${fieldName}.shard`) }
      : {}),
    ...(value.subagentAddress !== undefined
      ? {
          subagentAddress: parseGatewaySubagentAddress(
            value.subagentAddress,
            `${fieldName}.subagentAddress`,
          ),
        }
      : {}),
  });
}
