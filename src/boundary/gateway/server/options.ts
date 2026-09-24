// Construction-time options contract for GatewayServer (the composition facade).
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { ChannelOutboundDock } from '../../../channels/backplane/types.js';
import type { CapabilityTier, WyomingShardRoutingConfig } from '../../../system/config/runtime-config-contracts.js';
import type { GatewayRpcEndpoint } from '../transport.js';
import type {
  GatewayCredentialPresenceResult,
  NotifyNtfyParams,
} from '../protocol.js';
import type { GatewayMultiCompanionConfig } from '../multi-companion.js';
import type { GatewayCompanionChannelLane } from '../companion-channels.js';
import type { GitOperations } from '../../integrations/git/ops.js';
import type { ImageRuntimeConfig } from '../../../primitives/images/types.js';
import type { ModelDiscoveryBackend } from '../../../primitives/llm/discovery.js';
import type { GatewayAuditStorePort } from '../audit-port.js';
import type { SessionHmacKeyring } from '../../../persistence/journals/journal-utils.js';
import type { ShardBackendExecutor } from '../methods/types.js';
import type { WelfareGrantVerifier } from '../welfare-grant-verifier.js';
import type { PolicyConfig } from '../policy.js';
import type { GatewayNtfyConfig } from '../ntfy-notifier.js';
import type {
  ConfirmationEscalationProducerOptions,
} from '../../../system/capabilities/confirmation-escalation-producer.js';
import type { GatewayConfirmationConfig } from '../approval-boundary.js';
import type { ModelUsageRecorder } from '../../../shared/telemetry/model-usage.js';
import type { CredentialVaultPort } from '../../custody/credential-vault.js';
import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import type { CogSecMode } from '../../../shared/contracts/cogsec-mode.js';
import type { QuarantinedArtifactAccessGuard } from '../../../core/cogsec/intake/quarantined-artifact-guard.js';
import type { CogSecEventStore } from '../../../core/cogsec/events.js';
import type { GatewayVisionIntakeScreener } from '../intake/compose-screening.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { IcpSharedAutonomyStorePort } from '../../../core/icp/autonomy-store-ports.js';
import type { GatewayIcpInitiationPolicyAuthority } from '../icp-initiation-policy-authority.js';
import type {
  CompanionId,
  OptionalCompanionRoutingBinding,
} from '../../../shared/routing/companion-id.js';
import type { SharedWorkspaceListBounds } from '../../../persistence/workspaces/shared-workspace-bounds.js';
import type { KubeSelfManagementController } from '../../../system/lifecycle/kube-self-management.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';
import type {
  ShardApprovalGrantAuditEvent,
  ShardWorkloadLifecycleRegistryPort,
} from '../../../system/capabilities/shard-approval-grants.js';
import type { GatewaySystemDataWriterPort } from '../system-data-writer.js';
import type { McpGatewayBroker } from '../mcp/broker.js';

export interface GatewayServerOptions extends OptionalCompanionRoutingBinding {
  socketPath: string;
  gatewayRpcEndpoint?: GatewayRpcEndpoint;
  llmProvider: LLMProviderPort;
  embeddingService: EmbeddingProviderPort;
  modelDiscovery?: ModelDiscoveryBackend;
  discordAdapter: ChannelOutboundDock;
  /**
   * Multi-account Discord: outbound dock per companionId.
   * Required to cover every companion routed via multiCompanion.discordAccounts;
   * outbound sends from a companion connection resolve through its own dock
   * only, so one companion can never egress through another companion's bot.
   */
  discordAccountDocks?: ReadonlyMap<CompanionId, ChannelOutboundDock>;
  /** Native channel-plugin outbound accounts, resolved only by authenticated caller identity. */
  pluginOutboundRoutes?: readonly {
    pluginId: 'buzz';
    accountId?: string;
    companionId?: string;
    dock: ChannelOutboundDock;
  }[];
  /**
   * vvf.5.2: single-account Telegram outbound dock for interactive clarify
   * delivery. Present only when Telegram is configured; clarify.deliver fails
   * closed on the telegram channel without it.
   */
  telegramDock?: ChannelOutboundDock;
  /** Numeric Telegram destination for secondary system/operator alerts. */
  operatorTelegramChatId?: string;
  /** Explicit Discord system-alert outbound identity and destination. */
  operatorDiscordDock?: ChannelOutboundDock;
  operatorDiscordChannelId?: string;
  gitOps?: GitOperations;
  imageConfig?: ImageRuntimeConfig;
  modelUsageRecorder?: ModelUsageRecorder;
  credentialVault?: CredentialVaultPort;
  /** Value-free provider/channel credential inventory for the Garden status UI. */
  credentialPresence?: GatewayCredentialPresenceResult;
  /** Cognition intake firewall screening (htm9.2); absent when mode is 'off'. */
  intakeScreening?: IntakeScreeningService;
  /**
   * Fleet-only exact resolver for the authenticated companion's screening
   * composition. It must throw on a missing/unknown identity.
   */
  intakeScreeningProvider?: (
    companionId?: string,
  ) => IntakeScreeningService | null;
  /**
   * Canonical global CogSec mode (shadow/boundary/strict). Required so omitting
   * intake composition cannot silently disable gateway-global egress guards.
   */
  intakeScreeningMode: CogSecMode;
  /**
   * Quarantined-artifact access guard (hrmrq.54): blocks fs reads, searches,
   * writes, and edits of quarantined on-disk artifacts and records attempts.
   * Absent when the intake firewall is off.
   */
  quarantinedArtifactGuard?: QuarantinedArtifactAccessGuard;
  /** Gateway-global registry of protected persona owners for raw mutation tools. */
  personaMutationAttemptGuard?: import('../persona-mutation-attempt-guard.js').PersonaMutationAttemptGuard;
  /**
   * CogSec event store (htm9.18). When present, a canary token leaking into an
   * outbound method is recorded as a durable CogSecEvent (token sha256 only)
   * before the action is held. Absent ⇒ the tripwire still holds the action,
   * but writes no durable event.
   */
  cogSecEvents?: Pick<CogSecEventStore, 'createEvent'>;
  /** Vision intake screener (htm9.8); absent when off/disabled/backend-less. */
  visionIntake?: GatewayVisionIntakeScreener;
  /** Fleet-only exact resolver for companion-owned vision screening. */
  visionIntakeProvider?: (
    companionId?: string,
  ) => GatewayVisionIntakeScreener | null;
  policyConfig: PolicyConfig;
  ntfy?: GatewayNtfyConfig;
  auditStore?: GatewayAuditStorePort;
  kubeSelfManagement?: KubeSelfManagementController;
  /** Gateway-owned exact contact authority lifecycle service. */
  contactLifecycleAuthority?: import('../contact-lifecycle-authority.js').GatewayContactLifecycleAuthorityPort;
  /** Gateway-owned single writer for system owner files and system state. */
  systemDataWriter?: GatewaySystemDataWriterPort;
  /** Lazy external MCP client broker. It never connects until a catalog tool is selected. */
  mcpBroker?: McpGatewayBroker;
  sessionHmacKeyring: SessionHmacKeyring;
  confirmation?: Partial<GatewayConfirmationConfig>;
  // an52.3: keyed on the authenticated companion so a fleet resolves each
  // companion's own capability tier. Single-companion providers ignore the arg.
  capabilityTierProvider?: (companionId?: string) => CapabilityTier;
  // mus2.5: atomic owner snapshot keyed on the authenticated companion.
  capabilityGrantSnapshotProvider?: (
    companionId?: string,
  ) => CapabilityGrantSnapshot;
  /** Optional privileged executor; receives only gateway-authorized launch context. */
  shardBackendExecutor?: ShardBackendExecutor;
  /**
   * 2h6q.3: server-owned authenticated shard-workload registry (fed from
   * ShardManager launch registration state). Presence constructs the
   * exact-once ShardApprovalGrantAuthority and enables the shard
   * exceptional-action approval path. Absence keeps every shard
   * temporary-grant path disabled AND still denies recognizably
   * shard-originated gated dispatches (they can never inherit the parent's
   * autonomous auto-clear).
   */
  shardApprovalWorkloads?: ShardWorkloadLifecycleRegistryPort;
  /**
   * Human escalation control plane and its durable ledger (bead
   * psfn-framework-wtw7l). Presence makes every confirmation-queue enqueue and
   * resolution visible on the Garden attention surface. Absence keeps the queue
   * behaving exactly as before — the escalation is a projection of the queue,
   * never an authority over it.
   */
  confirmationEscalation?: ConfirmationEscalationProducerOptions<NotifyNtfyParams>;
  /**
   * Structured audit sink for shard approval-grant lifecycle events. A
   * throwing sink fails the transition it audits (terminal resolutions are
   * audit-then-remove). Defaults to the gateway structured logger.
   */
  shardApprovalGrantAudit?: (event: ShardApprovalGrantAuditEvent) => void;
  /** Canonical companion display label used across human-facing gateway surfaces. */
  approvalParentLabelProvider?: (companionId: string) => string | undefined;
  wyomingShardRouting: WyomingShardRoutingConfig;
  companionId?: CompanionId;
  /**
   * Multi-companion topology. When absent or disabled, the gateway keeps
   * the single-agent semantics (first-ready routing + broadcast notifications)
   * byte-identical. When enabled, every routed exchange is companion-addressed
   * and any ambiguity fails closed.
   */
  multiCompanion?: GatewayMultiCompanionConfig;
  /**
   * settings.json-owned bounds on a governed shared-workspace listing. Required
   * whenever `multiCompanion.sharedWorkspacePath` is configured: the reviewed
   * corpus is re-read and re-hashed on every list, so it may only be exposed
   * with an operator-declared page bound (psfn-framework-9jld5).
   */
  sharedWorkspaceListBounds?: SharedWorkspaceListBounds;
  /**
   * Inter-companion channel lane: resolves companion-room /
   * companion-dm addressing for `companion.message.send`. Requires the
   * multi-companion flag; providing it flag-off is a configuration error
   * (fail closed). Absent while multi-companion is on, the lane RPC alarms
   * and rejects every send.
   */
  companionChannels?: GatewayCompanionChannelLane;
  /**
   * fxt1: verifies a caller-asserted `preemptionProtected` work
   * spec against the background-work store before the gateway-side gate honors
   * it. Absent ⇒ the LLM handlers strip every asserted flag (fail closed).
   */
  welfareGrantVerifier?: WelfareGrantVerifier;
  /** Durable shared-schema authority for the content-free ICP autonomy broker. */
  icpAutonomyStore?: IcpSharedAutonomyStorePort;
  /** Canonical gateway-owned deterministic policy authority for ICP initiation. */
  icpInitiationPolicyAuthority?: Pick<
    GatewayIcpInitiationPolicyAuthority,
    'resolve' | 'authorizeHandoff' | 'runAuthorizedHandoff'
      | 'authorizeDyadContinuation' | 'runAuthorizedDyadContinuation'
  >;
  /** Shared clock for companion room delivery/reply boundary tests. */
  companionChannelNow?: () => number;
  /**
   * Gateway-process event bus. Carries the redacted `companion.*` relay
   * events: approval lifecycle emitted at the confirmation-queue choke
   * points, plus agent-forwarded tool/artifact events re-published from
   * `companion.event.publish` (w9hj.1).
   */
  eventBus: EventBus;
  /** JSON-owner quiet-hours gate evaluated before any shared-device model call. */
  sharedSatelliteQuietHoursAllows?: (nowMs: number, companionId: string) => boolean;
}
