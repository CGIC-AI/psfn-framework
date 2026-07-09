import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { LLMProviderPort, EmbeddingProviderPort } from '../../../core/agent/contracts.js';
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
  NotifyNtfyParams,
  NotifyNtfyResult,
  PolicyDecision,
  RuntimeHealthResult,
} from '../protocol.js';
import type { SessionHmacKeyring } from '../../../persistence/journals/journal-utils.js';
import type { ApprovalBoundaryService } from '../approval-boundary.js';
import type { PolicyConfig } from '../policy.js';
import type { ModelUsageRecorder } from '../../../shared/telemetry/model-usage.js';
import type { CredentialVaultPort } from '../../custody/credential-vault.js';

export interface GatewayMethodRuntime {
  target: JSONRPCServerAndClient;
  llmProvider: LLMProviderPort;
  embeddingService: EmbeddingProviderPort;
  modelDiscovery?: ModelDiscoveryBackend;
  discordAdapter: ChannelOutboundDock;
  gitOps?: GitOperations;
  imageConfig?: ImageRuntimeConfig;
  modelUsageRecorder?: ModelUsageRecorder;
  credentialVault?: CredentialVaultPort;
  policyConfig: PolicyConfig;
  workspacePath: string;
  sessionHmacKeyring: SessionHmacKeyring;
  approvalBoundary: ApprovalBoundaryService;
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
  getRuntimeHealth(): RuntimeHealthResult;
  nextStreamRequestId(): string;
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
