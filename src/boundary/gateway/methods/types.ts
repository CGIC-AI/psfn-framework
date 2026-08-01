import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { ChannelOutboundDock } from '../../../channels/backplane/types.js';
import type { GitOperations } from '../../integrations/git/ops.js';
import type { ImageRuntimeConfig } from '../../../primitives/images/types.js';
import type { ModelDiscoveryBackend } from '../../../primitives/llm/discovery.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
  ConfirmationResolveResult,
} from '../../../system/capabilities/confirmation-queue.js';
import type {
  ConfirmationResolveParams,
  GatewayCredentialPresenceResult,
  NotifyNtfyParams,
  NotifyNtfyResult,
  OperatorAlertResult,
  PolicyDecision,
  RuntimeHealthResult,
} from '../protocol.js';
import type { GatewayLLMRequestCancellation } from '../llm-request-cancellation.js';
import type { SessionHmacKeyring } from '../../../persistence/journals/journal-utils.js';
import type { ApprovalBoundaryService } from '../approval-boundary.js';
import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import type { QuarantinedArtifactAccessGuard } from '../../../core/cogsec/intake/quarantined-artifact-guard.js';
import type { GatewayVisionIntakeScreener } from '../intake/compose-screening.js';
import type { PolicyConfig } from '../policy.js';
import type { ModelUsageRecorder } from '../../../shared/telemetry/model-usage.js';
import type { CredentialVaultPort } from '../../custody/credential-vault.js';
import type { GatewayInlineImageRetention } from '../inline-image-retention.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import type { KubeSelfManagementController } from '../../../system/lifecycle/kube-self-management.js';
import type { GatewayContactLifecycleAuthorityPort } from '../contact-lifecycle-authority.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';
import type { ShardCapabilityAccess } from '../../../system/capabilities/shard-derivation.js';
import type {
  AuthenticatedShardWorkloadHandle,
  AuthenticatedShardWorkloadIdentity,
} from '../../../system/capabilities/shard-approval-grant-contracts.js';
import type {
  ShardBackendRequestBackend,
  ShardBackendRequestResult,
} from '../protocol.js';
import type { GatewaySystemDataWriterPort } from '../system-data-writer.js';
import type { McpGatewayBroker } from '../mcp/broker.js';

/**
 * Gateway-created authority passed to a shard backend executor only after the
 * manager assertions match an atomic authenticated-parent snapshot.
 */
export interface AuthorizedShardBackendLaunchContext {
  readonly backend: ShardBackendRequestBackend;
  readonly shardId: string;
  readonly name: string;
  readonly parentCompanionId: string;
  readonly parentTier: CapabilityTier;
  readonly ownerVersion: string;
  readonly grantDigest: string;
  readonly access: ShardCapabilityAccess;
}

export type ShardBackendExecutor = (
  context: AuthorizedShardBackendLaunchContext,
) => Promise<ShardBackendRequestResult>;

export interface GatewayMethodRuntime {
  target: JSONRPCServerAndClient;
  llmProvider: LLMProviderPort;
  /** Cancellable provider calls owned exclusively by this authenticated connection. */
  llmRequestCancellation: GatewayLLMRequestCancellation;
  /** Cancellable MCP discovery/call operations owned by this authenticated connection. */
  mcpRequestCancellation: {
    run<T>(
      cancellationId: unknown,
      operation: (signal: AbortSignal | undefined) => Promise<T>,
    ): Promise<T>;
    cancel(cancellationId: unknown): boolean;
    abortAll(): number;
  };
  embeddingService: EmbeddingProviderPort;
  modelDiscovery?: ModelDiscoveryBackend;
  discordAdapter: ChannelOutboundDock;
  /**
   * vvf.5.2: single-account Telegram outbound dock, present only when Telegram is
   * configured. Used by clarify.deliver to render a numbered-list clarification
   * and await the reply. Discord clarify reuses the per-connection
   * {@link GatewayMethodRuntime.discordAdapter} dock for account isolation.
   */
  telegramDock?: ChannelOutboundDock;
  gitOps?: GitOperations;
  imageConfig?: ImageRuntimeConfig;
  modelUsageRecorder?: ModelUsageRecorder;
  credentialVault?: CredentialVaultPort;
  /**
   * Cognition intake firewall screening (htm9.2). Absent when intake-policy
   * mode is 'off'; shadow mode screens/audits without altering content.
   */
  intakeScreening?: IntakeScreeningService;
  /**
   * Vision intake screener (htm9.8): images are screened through a small VLM
   * (OCR + description) with the transcript routed through the L1/L1.5 text
   * stack before any vision block reaches the main model. Absent when the
   * firewall is off, the visionScreener policy is disabled, or (shadow mode)
   * no OpenRouter backend is resolvable.
   */
  visionIntake?: GatewayVisionIntakeScreener;
  /** Connection-scoped screened inline image bytes for the immediately-following turn. */
  inlineImageRetention?: GatewayInlineImageRetention;
  /**
   * Quarantined-artifact access guard (hrmrq.54): refuses to serve or mutate a
   * quarantined item's on-disk artifact through fs read/search/write/edit
   * seams and records the attempted access for the operator. Absent when the
   * intake firewall is off.
   */
  quarantinedArtifactGuard?: QuarantinedArtifactAccessGuard;
  policyConfig: PolicyConfig;
  workspacePath: string;
  /** True when this connection is confined to one fleet Personal Workspace. */
  personalWorkspaceIsolation?: boolean;
  sessionHmacKeyring: SessionHmacKeyring;
  approvalBoundary: ApprovalBoundaryService;
  /** Gateway-owned, namespace-scoped Kubernetes lifecycle safety boundary. */
  kubeSelfManagement?: KubeSelfManagementController;
  /** Gateway-owned contact authority; companion identity remains connection-derived. */
  contactLifecycleAuthority?: GatewayContactLifecycleAuthorityPort;
  /** The gateway-owned, audited single writer for the system-data PVC. */
  systemDataWriter?: GatewaySystemDataWriterPort;
  /** Gateway-owned lazy MCP broker; absent means external MCP is disabled. */
  mcpBroker?: McpGatewayBroker;
  /**
   * Authoritative capability tier resolved from the gateway's own
   * CapabilityRuntime (never the caller-declared value). Gateway methods that
   * still gate on tier MUST consult this instead of trusting RPC params.
   * Absent ⇒ the tier cannot be resolved and tier-gated privileges must be
   * refused (fail closed). Shard backend admission uses the atomic grant
   * snapshot provider below.
   */
  capabilityTierProvider?: () => CapabilityTier;
  /**
   * One atomic, connection-bound snapshot of the authenticated companion's
   * authoritative capability owner. Missing or throwing providers fail closed.
   */
  capabilityGrantSnapshotProvider?: () => CapabilityGrantSnapshot;
  /**
   * Optional backend executor. It receives only a gateway-authorized immutable
   * context, never caller-declared capability authority.
   */
  shardBackendExecutor?: ShardBackendExecutor;
  /**
   * 2h6q.3: server-owned per-dispatch shard lineage resolution for gated
   * methods. Maps a runtime-stamped correlation channel id to the current
   * authenticated shard workload registered by the shard runtime. The channel
   * id is only a lookup key into server-owned registration state — every
   * authority value comes from the registration. A recognizably
   * shard-originated channel that cannot be resolved to a live workload of
   * the connection's authenticated companion MUST throw (fail closed).
   */
  resolveShardWorkloadForChannel?: (
    channelId: string | undefined,
  ) => {
    workload: AuthenticatedShardWorkloadHandle;
    identity: AuthenticatedShardWorkloadIdentity;
  } | undefined;
  /** Authenticated companion bound to the connection serving this RPC. */
  authenticatedCompanionId(): string | undefined;
  /**
   * fxt1: verify that a caller-asserted `preemptionProtected`
   * work spec is backed by a genuine welfare escalation — `jobId` names a
   * `welfare_claimed`, `running` background-work row owned (schema-scoped) by
   * `companionId`. Absent ⇒ the boundary cannot verify and strips the flag
   * (fail closed). May reject on a DB/verify error; the caller strips + logs.
   */
  verifyWelfareGrant?(jobId: string, companionId: string): Promise<boolean>;
  /**
   * Notify the connection that originated the current request. Single-companion
   * mode preserves the historical broadcast; multi-companion mode pins delivery
   * to the requesting connection (companion crossover would leak secrets).
   */
  notifyRequester(method: string, params: unknown): void;
  listPendingConfirmations(): ConfirmationQueueEntry[];
  listConfirmationHistory(): ConfirmationQueueHistoryEntry[];
  resolveConfirmation(params: ConfirmationResolveParams): Promise<ConfirmationResolveResult>;
  sendNtfy(params: NotifyNtfyParams): Promise<NotifyNtfyResult>;
  sendOperatorAlert(params: NotifyNtfyParams): Promise<OperatorAlertResult>;
  getRuntimeHealth(): RuntimeHealthResult;
  getCredentialPresence?(): GatewayCredentialPresenceResult;
  nextStreamRequestId(): string;
  /** Authenticates nested ICP cost identity against the connection and durable episode. */
  authorizeIcpConversationCorrelation?(
    correlation: IcpConversationCorrelation,
  ): Promise<IcpConversationCorrelation>;
  recordAuditEvent?(entry: {
    method: string;
    decision: PolicyDecision;
    params?: Record<string, unknown>;
    durationMs?: number;
    error?: string;
  }): Promise<void>;
  audited<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary?: (params: P) => Record<string, unknown>,
  ): (params: P) => Promise<R>;
}

export interface AuditedMethodDescriptor<P, R> {
  name: string;
  handler: (params: P, runtime: GatewayMethodRuntime) => Promise<R>;
  summary?: (params: P) => Record<string, unknown>;
}

export interface GatedMethodDescriptor<P, R> extends AuditedMethodDescriptor<P, R> {
  approvalAction: string;
  approvalScope: (params: P) => string;
  approvalReason?: (params: P) => string;
}
