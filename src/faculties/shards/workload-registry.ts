import { randomUUID } from 'node:crypto';
import type {
  AuthenticatedShardWorkloadHandle,
  AuthenticatedShardWorkloadRegistration,
  ShardApprovalWorkloadRegistryPort,
} from '../../system/capabilities/shard-approval-grant-contracts.js';
import type { DerivedShardCapabilityGrant } from '../../system/capabilities/shard-derivation.js';

/**
 * Production constructor input for one authenticated shard workload
 * generation. Fed exclusively from ShardManager launch state — never from RPC
 * params, tool arguments, or browser fields.
 */
export interface ShardWorkloadRegistrationInput {
  readonly parentCompanionId: string;
  readonly shardId: string;
  readonly shardLabel?: string;
  /**
   * Gateway-visible channel ids that address this workload (task lane plus
   * the direct human-chat lane). Used only as lookup keys; they carry no
   * authority of their own.
   */
  readonly channelIds: readonly string[];
  /** Immutable launch snapshot derived by shard-derivation.ts (mus2.4). */
  readonly capabilityGrant: DerivedShardCapabilityGrant;
}

interface WorkloadRecord {
  readonly workloadKey: string;
  readonly channelKeys: readonly string[];
  readonly registration: AuthenticatedShardWorkloadRegistration;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Shard workload registration ${field} must be a non-empty string`);
  }
  return normalized;
}

function workloadKey(parentCompanionId: string, shardId: string): string {
  return `${parentCompanionId}\u0000${shardId}`;
}

function channelKey(parentCompanionId: string, channelId: string): string {
  return `${parentCompanionId}\u0000${channelId}`;
}

/**
 * Production authenticated shard-workload registry (2h6q.3).
 *
 * ShardManager registers one generation per launch and ends it on release;
 * the gateway resolves handles (and per-dispatch channel bindings) through
 * the `ShardApprovalWorkloadRegistryPort` seam. Guarantees:
 *
 * - one live handle per (parent, shardId); registering a replacement
 *   generation supersedes the previous handle, which then resolves undefined
 *   (replacement-generation denial);
 * - ended handles resolve undefined (ended-workload denial);
 * - `resolveAuthenticatedWorkload` returns the SAME frozen registration
 *   object for the life of a generation, so the mus2.7 authority's
 *   reference-identity `sameWorkload` comparison holds (stable frozen derived
 *   access per workload generation);
 * - handles are process-local frozen objects — RPC/tool/browser values can
 *   never mint or forge one.
 */
export class ShardWorkloadRegistry implements ShardApprovalWorkloadRegistryPort {
  private readonly recordsByHandle =
    new WeakMap<AuthenticatedShardWorkloadHandle, WorkloadRecord>();

  private readonly currentByWorkloadKey = new Map<string, AuthenticatedShardWorkloadHandle>();
  /**
   * Live handles claiming each channel key. Spawn-path channels are unique by
   * construction; Wyoming satellite channels may be claimed by overlapping
   * delegations, in which case the channel lineage is ambiguous and every
   * lookup on it denies (fail closed) until exactly one claimant remains.
   */
  private readonly currentByChannelKey = new Map<string, Set<AuthenticatedShardWorkloadHandle>>();
  /**
   * Tombstones: every channel key that has EVER hosted a workload in this
   * process, retained after end/supersede. Satellite/Wyoming shard channels
   * carry arbitrary schemes, so the gateway's shard recognition must be
   * registry-backed — an ended or superseded shard channel is still
   * recognizably shard-originated and must deny, never fall through to the
   * parent's own authority. Bounded: shards are short-lived and the set is
   * process-scoped (one small string per launched channel).
   */
  private readonly everRegisteredChannelKeys = new Set<string>();
  private generationCounter = 0;

  registerWorkload(input: ShardWorkloadRegistrationInput): AuthenticatedShardWorkloadHandle {
    const parentCompanionId = requiredText(input.parentCompanionId, 'parentCompanionId');
    const shardId = requiredText(input.shardId, 'shardId');
    const shardLabel = input.shardLabel?.trim() || undefined;
    if (input.channelIds.length === 0) {
      throw new Error('Shard workload registration requires at least one channel id');
    }
    const channelKeys = [...new Set(
      input.channelIds.map((channelId, index) =>
        channelKey(parentCompanionId, requiredText(channelId, `channelIds[${index}]`))),
    )];

    const key = workloadKey(parentCompanionId, shardId);
    const previous = this.currentByWorkloadKey.get(key);
    if (previous) {
      // Replacement generation supersedes: the previous handle (and every
      // grant bound to it) resolves undefined from here on.
      this.endWorkload(previous);
    }

    this.generationCounter += 1;
    const registration: AuthenticatedShardWorkloadRegistration = Object.freeze({
      parentCompanionId,
      shardId,
      workloadGeneration: `${shardId}#g${this.generationCounter}-${randomUUID()}`,
      ...(shardLabel ? { shardLabel } : {}),
      capabilityGrant: input.capabilityGrant,
    });
    const handle = Object.freeze({
      kind: 'authenticated-shard-workload' as const,
    }) as AuthenticatedShardWorkloadHandle;

    this.recordsByHandle.set(handle, Object.freeze({
      workloadKey: key,
      channelKeys: Object.freeze(channelKeys),
      registration,
    }));
    this.currentByWorkloadKey.set(key, handle);
    for (const candidate of channelKeys) {
      const claimants = this.currentByChannelKey.get(candidate) ?? new Set();
      claimants.add(handle);
      this.currentByChannelKey.set(candidate, claimants);
      this.everRegisteredChannelKeys.add(candidate);
    }
    return handle;
  }

  /** Idempotent: ending an unknown or already-superseded handle is a no-op. */
  endWorkload(handle: AuthenticatedShardWorkloadHandle): void {
    const record = this.recordsByHandle.get(handle);
    if (!record) {
      return;
    }
    if (this.currentByWorkloadKey.get(record.workloadKey) === handle) {
      this.currentByWorkloadKey.delete(record.workloadKey);
    }
    for (const candidate of record.channelKeys) {
      const claimants = this.currentByChannelKey.get(candidate);
      if (!claimants) {
        continue;
      }
      claimants.delete(handle);
      if (claimants.size === 0) {
        this.currentByChannelKey.delete(candidate);
      }
    }
    this.recordsByHandle.delete(handle);
  }

  resolveAuthenticatedWorkload(
    handle: AuthenticatedShardWorkloadHandle,
  ): AuthenticatedShardWorkloadRegistration | undefined {
    const record = this.recordsByHandle.get(handle);
    if (!record) {
      return undefined;
    }
    return this.currentByWorkloadKey.get(record.workloadKey) === handle
      ? record.registration
      : undefined;
  }

  resolveWorkloadForChannel(
    parentCompanionId: string,
    channelId: string,
  ): AuthenticatedShardWorkloadHandle | undefined {
    const parent = parentCompanionId.trim();
    const channel = channelId.trim();
    if (!parent || !channel) {
      return undefined;
    }
    const claimants = this.currentByChannelKey.get(channelKey(parent, channel));
    if (!claimants || claimants.size === 0) {
      return undefined;
    }
    if (claimants.size > 1) {
      // Ambiguous lineage is a denial, never a guess (SHARD_APPROVALS.md).
      throw new Error(
        'Shard workload channel lineage is ambiguous: multiple live workloads claim this channel',
      );
    }
    const [handle] = claimants;
    return handle;
  }

  hasHostedWorkloadForChannel(parentCompanionId: string, channelId: string): boolean {
    const parent = parentCompanionId.trim();
    const channel = channelId.trim();
    if (!parent || !channel) {
      return false;
    }
    return this.everRegisteredChannelKeys.has(channelKey(parent, channel));
  }
}
