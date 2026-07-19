import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { CapabilityGrantSnapshot } from '../../system/capabilities/access.js';
import type {
  AuthenticatedShardWorkloadHandle,
  ShardWorkloadLifecycleRegistryPort,
} from '../../system/capabilities/shard-approval-grant-contracts.js';
import { deriveShardCapabilityGrantFromSnapshot } from '../../system/capabilities/shard-derivation.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { GatewayErrors } from './protocol.js';
import type {
  ShardWorkloadEndResult,
  ShardWorkloadRegisterResult,
} from './protocol.js';

const MAX_CHANNEL_IDS = 4;
const MAX_ID_CHARS = 512;
const MAX_LABEL_CHARS = 160;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REGISTRATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const log = createComponentLogger('GatewayShardWorkloadRegistrar');

interface ScopedLease {
  readonly shardId: string;
  readonly handle: AuthenticatedShardWorkloadHandle;
}

function deny(message: string): never {
  throw new JSONRPCErrorException(message, GatewayErrors.POLICY_DENIED);
}

function requiredText(value: unknown, field: string, maxChars = MAX_ID_CHARS): string {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maxChars) {
    deny(`shard workload ${field} must be a trimmed non-empty string of at most ${maxChars} characters`);
  }
  return value;
}

function registrationId(value: unknown): string {
  const normalized = requiredText(value, 'registrationId', 36);
  if (!REGISTRATION_ID_PATTERN.test(normalized)) {
    deny('shard workload registrationId must be a lowercase UUID v4');
  }
  return normalized;
}

function digest(value: unknown, field: 'ownerVersion' | 'grantDigest'): string {
  const normalized = requiredText(value, field, 64);
  if (!SHA256_PATTERN.test(normalized)) {
    deny(`shard workload ${field} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

/**
 * Gateway-owned authenticated workload lifecycle. The connection scope and
 * companion identity are supplied by GatewayServer, never by RPC params.
 */
export class GatewayShardWorkloadRegistrar {
  private readonly leasesByConnection = new WeakMap<object, Map<string, ScopedLease>>();

  constructor(
    private readonly registry: ShardWorkloadLifecycleRegistryPort,
    private readonly snapshotProvider:
      | ((companionId: string) => CapabilityGrantSnapshot)
      | undefined,
  ) {}

  register(
    connection: object,
    companionId: string,
    params: unknown,
  ): ShardWorkloadRegisterResult {
    if (!isRecord(params)) {
      deny('shard.workload.register params must be an object');
    }
    assertNoUnknownKeys(
      params,
      [
        'registrationId',
        'shardId',
        'shardLabel',
        'channelIds',
        'ownerVersion',
        'grantDigest',
      ] as const,
      'shard.workload.register params',
    );
    const leaseId = registrationId(params.registrationId);
    const shardId = requiredText(params.shardId, 'shardId');
    const shardLabel = params.shardLabel === undefined
      ? undefined
      : requiredText(params.shardLabel, 'shardLabel', MAX_LABEL_CHARS);
    if (!Array.isArray(params.channelIds)
      || params.channelIds.length === 0
      || params.channelIds.length > MAX_CHANNEL_IDS) {
      deny(`shard workload channelIds must contain 1-${MAX_CHANNEL_IDS} entries`);
    }
    const channelIds = [...new Set(
      params.channelIds.map((value, index) => requiredText(value, `channelIds[${index}]`)),
    )];
    const ownerVersion = digest(params.ownerVersion, 'ownerVersion');
    const grantDigest = digest(params.grantDigest, 'grantDigest');
    if (!this.snapshotProvider) {
      deny('shard workload registration has no gateway capability snapshot authority');
    }

    let capabilityGrant;
    try {
      capabilityGrant = deriveShardCapabilityGrantFromSnapshot(
        companionId,
        this.snapshotProvider(companionId),
      );
    } catch (error) {
      log.warn('Shard workload registration could not resolve gateway capability authority', {
        companionId,
        error: toErrorMessage(error),
      });
      deny('shard workload registration could not resolve gateway capability authority');
    }
    if (capabilityGrant.ownerVersion !== ownerVersion
      || capabilityGrant.grantDigest !== grantDigest) {
      deny('shard workload registration grant does not match current gateway authority');
    }

    const leases = this.leasesByConnection.get(connection) ?? new Map<string, ScopedLease>();
    this.leasesByConnection.set(connection, leases);
    for (const [existingId, existing] of leases) {
      if (existingId === leaseId || existing.shardId === shardId) {
        this.registry.endWorkload(existing.handle);
        leases.delete(existingId);
      }
    }
    const handle = this.registry.registerWorkload({
      parentCompanionId: companionId,
      shardId,
      ...(shardLabel ? { shardLabel } : {}),
      channelIds,
      capabilityGrant,
    });
    const registered = this.registry.resolveAuthenticatedWorkload(handle);
    if (!registered) {
      throw new Error('Gateway shard workload registry failed to retain the new generation');
    }
    leases.set(leaseId, { shardId, handle });
    return {
      registrationId: leaseId,
      workloadGeneration: registered.workloadGeneration,
    };
  }

  end(connection: object, params: unknown): ShardWorkloadEndResult {
    if (!isRecord(params)) {
      deny('shard.workload.end params must be an object');
    }
    assertNoUnknownKeys(
      params,
      ['registrationId'] as const,
      'shard.workload.end params',
    );
    const leaseId = registrationId(params.registrationId);
    const leases = this.leasesByConnection.get(connection);
    const lease = leases?.get(leaseId);
    if (!lease) {
      return { ended: false };
    }
    this.registry.endWorkload(lease.handle);
    leases!.delete(leaseId);
    return { ended: true };
  }

  releaseConnection(connection: object): void {
    const leases = this.leasesByConnection.get(connection);
    if (!leases) return;
    for (const lease of leases.values()) {
      this.registry.endWorkload(lease.handle);
    }
    leases.clear();
    this.leasesByConnection.delete(connection);
  }
}
