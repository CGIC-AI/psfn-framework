import type { ConfirmationResolverIdentity } from './confirmation-queue.js';
import type { DerivedShardCapabilityGrant } from './shard-derivation.js';
import type { ShardDenialMaskToken } from './shard-derivation.js';

declare const authenticatedShardWorkloadBrand: unique symbol;
declare const preparedShardRequestGrantBrand: unique symbol;

/**
 * Opaque identity issued by an authenticated shard-workload registry. The
 * production constructor is `ShardWorkloadRegistry.registerWorkload`
 * (src/faculties/shards/workload-registry.ts), fed exclusively from
 * ShardManager launch registration state. Browser/RPC/tool values can never
 * mint one of these; the brand is process-local and unforgeable.
 */
export interface AuthenticatedShardWorkloadHandle {
  readonly kind: 'authenticated-shard-workload';
  readonly [authenticatedShardWorkloadBrand]: true;
}

/** Opaque pre-enqueue request reservation. */
export interface PreparedShardRequestGrant {
  readonly kind: 'prepared-shard-request-grant';
  readonly [preparedShardRequestGrantBrand]: true;
}

export interface AuthenticatedShardWorkloadRegistration {
  readonly parentCompanionId: string;
  readonly shardId: string;
  readonly workloadGeneration: string;
  readonly shardLabel?: string;
  /** Immutable launch snapshot derived by shard-derivation.ts. */
  readonly capabilityGrant: DerivedShardCapabilityGrant;
}

/** One launch generation registered by ShardManager before any shard turn runs. */
export interface ShardWorkloadRegistrationInput {
  readonly parentCompanionId: string;
  readonly shardId: string;
  readonly shardLabel?: string;
  readonly channelIds: readonly string[];
  /** Immutable launch snapshot derived by shard-derivation.ts. */
  readonly capabilityGrant: DerivedShardCapabilityGrant;
}

/**
 * Launch/release seam consumed by ShardManager. Implementations may be the
 * in-process registry or an authenticated gateway RPC client; registration
 * and release are awaitable so a shard never runs before the gateway records
 * its generation and normal completion never outruns revocation.
 */
export interface ShardWorkloadLifecyclePort {
  registerWorkload(
    input: ShardWorkloadRegistrationInput,
  ): AuthenticatedShardWorkloadHandle | Promise<AuthenticatedShardWorkloadHandle>;
  endWorkload(
    handle: AuthenticatedShardWorkloadHandle,
  ): void | Promise<void>;
}

/**
 * Authentication port owned by the shard runtime. A live handle resolves to
 * one exact workload generation; ended and replaced generations return
 * undefined. Browser/RPC/tool values must never implement this port.
 */
export interface AuthenticatedShardWorkloadRegistry {
  resolveAuthenticatedWorkload(
    handle: AuthenticatedShardWorkloadHandle,
  ): AuthenticatedShardWorkloadRegistration | undefined;
}

/**
 * Server-owned registry seam the gateway consumes (2h6q.3). In addition to
 * handle resolution it maps a dispatch's registered shard channel to the
 * current live workload handle. The channel id is only a lookup key into
 * server-owned registration state — every authority value (parent binding,
 * generation, frozen derived access) comes from the registration itself.
 */
export interface ShardApprovalWorkloadRegistryPort extends AuthenticatedShardWorkloadRegistry {
  resolveWorkloadForChannel(
    parentCompanionId: string,
    channelId: string,
  ): AuthenticatedShardWorkloadHandle | undefined;
  /**
   * True when this channel has EVER hosted a shard workload for this parent
   * in this process (live, ended, or superseded). Satellite/Wyoming shard
   * channels carry arbitrary schemes, so shard recognition must be
   * registry-backed, not prefix-based: a recognizably shard-hosting channel
   * that no longer resolves to a live workload is denied, never treated as
   * the parent's own dispatch.
   */
  hasHostedWorkloadForChannel(parentCompanionId: string, channelId: string): boolean;
}

/** Complete gateway-owned registry: RPC lifecycle mutations plus grant lookup. */
export interface ShardWorkloadLifecycleRegistryPort
  extends ShardApprovalWorkloadRegistryPort, ShardWorkloadLifecyclePort {
  registerWorkload(input: ShardWorkloadRegistrationInput): AuthenticatedShardWorkloadHandle;
  endWorkload(handle: AuthenticatedShardWorkloadHandle): void;
}

export interface AuthenticatedShardWorkloadIdentity {
  readonly parentCompanionId: string;
  readonly shardId: string;
  readonly workloadGeneration: string;
  readonly shardLabel?: string;
  readonly ownerVersion: string;
  readonly grantDigest: string;
}

export interface ShardApprovalGrantTuple {
  readonly workload: AuthenticatedShardWorkloadHandle;
  readonly method: string;
  readonly action: string;
  readonly scope: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ShardApprovalGrantUse extends ShardApprovalGrantTuple {
  readonly grantId: string;
  readonly approvalId: string;
}

export type ShardApprovalGrantStatus = 'active' | 'consumed' | 'expired' | 'revoked';

export interface ShardApprovalGrantSnapshot {
  readonly grantId: string;
  readonly approvalId: string;
  readonly mode: 'request';
  readonly status: ShardApprovalGrantStatus;
  readonly token: ShardDenialMaskToken;
  readonly parentCompanionId: string;
  readonly shardId: string;
  readonly workloadGeneration: string;
  readonly method: string;
  readonly action: string;
  readonly scopeDigest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly consumedAt?: number;
  readonly revokedAt?: number;
}

export interface ShardApprovalGrantAuthorityOptions {
  readonly workloadRegistry: AuthenticatedShardWorkloadRegistry;
  readonly now?: () => number;
  readonly grantIdFactory?: () => string;
  readonly audit?: (event: ShardApprovalGrantAuditEvent) => void;
}

export type ShardApprovalGrantAuditOutcome =
  | 'prepared'
  | 'issued'
  | 'consumed'
  | 'executed'
  | 'execution_failed'
  | 'revoked'
  | 'expired'
  | 'denied'
  | 'replay_denied';

/** Allowlisted audit projection. Raw params, scope, resolver ids, and secrets are excluded. */
export interface ShardApprovalGrantAuditEvent {
  readonly outcome: ShardApprovalGrantAuditOutcome;
  readonly mode: 'request';
  readonly token: ShardDenialMaskToken;
  readonly parentCompanionId: string;
  readonly shardId: string;
  readonly workloadGeneration: string;
  readonly grantId?: string;
  readonly approvalId?: string;
  readonly method: 'home_assistant.call_service';
  readonly action: 'home_assistant.control';
  readonly scopeDigest: string;
  readonly timestamp: number;
  readonly expiresAt?: number;
  readonly decision?: 'approve' | 'modify';
  readonly resolverKind?: ConfirmationResolverIdentity['kind'];
  readonly resolverIdDigest?: string;
  readonly reasonCode?: string;
}
