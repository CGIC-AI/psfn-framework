import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { LLMProvider, EmbeddingService } from '../../agent/contracts.js';
import type { ChannelOutboundDock } from '../../channels/types.js';
import type { GitOperations } from '../../git/ops.js';
import type { UrlPolicyConfig } from '../url-policy.js';

export interface GatewayMethodRuntime {
  target: JSONRPCServerAndClient;
  llmProvider: LLMProvider;
  embeddingService: EmbeddingService;
  discordAdapter: ChannelOutboundDock;
  gitOps?: GitOperations;
  policyConfig: { urlPolicy?: UrlPolicyConfig };
  notifyAll(method: string, params: unknown): void;
  nextStreamRequestId(): string;
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
}
