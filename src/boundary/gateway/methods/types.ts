import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { LLMProvider, EmbeddingService } from '../../../agent/contracts.js';
import type { ChannelOutboundDock } from '../../../channels/types.js';
import type { GitOperations } from '../../integrations/git/ops.js';
import type { ImageRuntimeConfig } from '../../../images/types.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
  ConfirmationResolveParams,
  ConfirmationResolveResult,
  NotifyNtfyParams,
  NotifyNtfyResult,
  PolicyDecision,
  RuntimeHealthResult,
} from '../protocol.js';
import type { SessionHmacKeyring } from '../../../session/journal-utils.js';
import type { ApprovalBoundaryService } from '../approval-boundary.js';
import type { PolicyConfig } from '../policy.js';

export interface GatewayMethodRuntime {
  target: JSONRPCServerAndClient;
  llmProvider: LLMProvider;
  embeddingService: EmbeddingService;
  modelDiscovery?: {
    getAvailableModels(): Promise<unknown[]>;
    invalidateCache(): void;
  };
  discordAdapter: ChannelOutboundDock;
  gitOps?: GitOperations;
  imageConfig?: ImageRuntimeConfig;
  policyConfig: PolicyConfig;
  workspacePath: string;
  sessionHmacKeyring: SessionHmacKeyring;
  approvalBoundary: ApprovalBoundaryService;
  notifyAll(method: string, params: unknown): void;
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
  }): void;
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
