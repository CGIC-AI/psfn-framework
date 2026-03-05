import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { LLMProvider, EmbeddingService } from '../../agent/contracts.js';
import type { ChannelOutboundDock } from '../../channels/types.js';
import type { GitOperations } from '../../git/ops.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationResolveParams,
  ConfirmationResolveResult,
  NotifyNtfyParams,
  NotifyNtfyResult,
  PolicyDecision,
} from '../protocol.js';
import type { SessionHmacKeyring } from '../../session/journal-utils.js';
import type { PolicyConfig } from '../policy.js';

export interface GatewayMethodRuntime {
  target: JSONRPCServerAndClient;
  llmProvider: LLMProvider;
  embeddingService: EmbeddingService;
  discordAdapter: ChannelOutboundDock;
  gitOps?: GitOperations;
  policyConfig: PolicyConfig;
  workspacePath: string;
  sessionHmacKeyring: SessionHmacKeyring;
  notifyAll(method: string, params: unknown): void;
  listPendingConfirmations(): ConfirmationQueueEntry[];
  resolveConfirmation(params: ConfirmationResolveParams): Promise<ConfirmationResolveResult>;
  sendNtfy(params: NotifyNtfyParams): Promise<NotifyNtfyResult>;
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
  gated<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary: (params: P) => Record<string, unknown>,
    approvalAction: string,
    approvalScope: (params: P) => string,
    approvalReason?: (params: P) => string,
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
