// ── Gateway Server ──
// Host-side process that holds secrets and proxies all external interactions.

import * as net from 'node:net';
import {
  JSONRPCServer,
  JSONRPCClient,
  JSONRPCServerAndClient,
  JSONRPCErrorException,
} from 'json-rpc-2.0';
import type { LLMProvider, EmbeddingService } from '../agent/contracts.js';
import type { ChannelOutboundDock } from '../channels/types.js';
import {
  parseWyomingShardRoutingConfigEnv,
  type CapabilityTier,
  type SubstrateMessage,
  type WyomingShardRoutingConfig,
} from '../types.js';
import type { NdjsonConnection } from './transport.js';
import { createSocketServer } from './transport.js';
import {
  GatewayErrors,
  type PolicyDecision,
  type VoiceHandleMessageResult,
} from './protocol.js';
import type { GitOperations } from '../git/ops.js';
import type { AuditStore } from './audit.js';
import {
  buildSessionHmacKeyring,
  type SessionHmacKeyring,
} from '../session/journal-utils.js';
import { createComponentLogger } from '../logger.js';
import {
  ConfirmationQueue,
  DEFAULT_CONFIRMATION_EXPIRY_MS,
} from '../capabilities/confirmation-queue.js';
import { isCapabilityTier } from '../capabilities/tiers.js';
import { toErrorMessage } from '../utils/errors.js';
import { registerGatewayMethods } from './methods/index.js';
import type { GatewayMethodRuntime } from './methods/types.js';
import { evaluatePolicy, type PolicyConfig } from './policy.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  requestAgentVoiceStream,
  type VoiceStreamRequestOptions,
} from './voice-stream-request.js';
import {
  GatewayNtfyNotifier,
  notifyOperatorForPendingAction,
  type GatewayNtfyConfig,
} from './ntfy-notifier.js';
import { executeQueuedAction, resolveCompanionReason } from './confirmation-actions.js';

const log = createComponentLogger('Gateway');
export { evaluatePolicy };
export type { GatewayNtfyConfig, PolicyConfig, VoiceStreamRequestOptions };

export interface GatewayConfirmationConfig {
  expiryMs: number;
  operatorDiscordChannelId?: string;
  ntfyTopic?: string;
}

const GATEWAY_SESSION_HMAC_KEYS_ENV = 'GATEWAY_SESSION_HMAC_KEYS';
const GATEWAY_SESSION_HMAC_KEY_ENV = 'GATEWAY_SESSION_HMAC_KEY';
const GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV = 'GATEWAY_SESSION_HMAC_ACTIVE_VERSION';

export function resolveGatewaySessionHmacKeyring(
  env: NodeJS.ProcessEnv = process.env,
): SessionHmacKeyring | null {
  return buildSessionHmacKeyring({
    serializedKeys: env[GATEWAY_SESSION_HMAC_KEYS_ENV],
    singleKey: env[GATEWAY_SESSION_HMAC_KEY_ENV],
    activeVersion: env[GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV],
  });
}

// ── Gateway Server Class ──

export interface GatewayServerOptions {
  socketPath: string;
  llmProvider: LLMProvider;
  embeddingService: EmbeddingService;
  discordAdapter: ChannelOutboundDock;
  gitOps?: GitOperations;
  policyConfig: PolicyConfig;
  ntfy?: GatewayNtfyConfig;
  auditStore?: AuditStore;
  sessionHmacKeyring?: SessionHmacKeyring | null;
  confirmation?: Partial<GatewayConfirmationConfig>;
  capabilityTierProvider?: () => CapabilityTier;
  wyomingShardRouting?: WyomingShardRoutingConfig;
}

export class GatewayServer {
  private netServer: net.Server | null = null;
  private readonly connections = new Set<NdjsonConnection>();
  private readonly rpcClients = new Map<NdjsonConnection, JSONRPCServerAndClient>();
  private readonly options: GatewayServerOptions;
  private readonly sessionHmacKeyring: SessionHmacKeyring | null;
  private streamRequestCounter = 0;
  private readonly confirmationQueue: ConfirmationQueue;
  private readonly confirmationConfig: GatewayConfirmationConfig;
  private readonly capabilityTierProvider: () => CapabilityTier;
  private readonly wyomingShardRouting: WyomingShardRoutingConfig;
  private readonly ntfyNotifier: GatewayNtfyNotifier;

  constructor(options: GatewayServerOptions) {
    this.options = options;
    this.sessionHmacKeyring = options.sessionHmacKeyring === undefined
      ? resolveGatewaySessionHmacKeyring(process.env)
      : options.sessionHmacKeyring;
    this.confirmationConfig = {
      expiryMs: this.normalizePositiveInt(
        options.confirmation?.expiryMs,
        DEFAULT_CONFIRMATION_EXPIRY_MS,
      ),
      operatorDiscordChannelId: options.confirmation?.operatorDiscordChannelId?.trim() || undefined,
      ntfyTopic: options.confirmation?.ntfyTopic?.trim() || undefined,
    };
    this.confirmationQueue = new ConfirmationQueue({
      defaultExpiryMs: this.confirmationConfig.expiryMs,
    });
    this.capabilityTierProvider = options.capabilityTierProvider ?? (() => this.resolveCapabilityTierFromEnv());
    this.wyomingShardRouting = options.wyomingShardRouting ?? parseWyomingShardRoutingConfigEnv(process.env);
    this.ntfyNotifier = new GatewayNtfyNotifier(options.ntfy);
    if (this.sessionHmacKeyring) {
      log.info('Session HMAC keyring configured', {
        activeVersion: this.sessionHmacKeyring.activeVersion,
        versionCount: Object.keys(this.sessionHmacKeyring.keys).length,
      });
    }
  }

  // Wrap a handler with audit timing — logs call, records duration/error on completion
  private audited<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary?: (params: P) => Record<string, unknown>,
  ): (params: P) => Promise<R> {
    return async (params: P) => {
      const summary = paramsSummary ? paramsSummary(params) : undefined;
      const auditId = this.audit(method, 'ALLOW', summary);
      const startTime = Date.now();
      try {
        const result = await handler(params);
        this.auditComplete(auditId, startTime);
        return result;
      } catch (err) {
        const msg = toErrorMessage(err);
        this.auditComplete(auditId, startTime, msg);
        throw err;
      }
    };
  }

  // Wrap a gated handler — evaluates policy, logs decision, handles approval flow
  private gated<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary: (params: P) => Record<string, unknown>,
    approvalAction: string,
    approvalScope: (params: P) => string,
    approvalReason?: (params: P) => string,
  ): (params: P) => Promise<R> {
    return async (params: P) => {
      const decision = evaluatePolicy(
        { method, params: params as unknown as Record<string, unknown> },
        this.options.policyConfig,
      );
      const summary = paramsSummary(params);
      const auditId = this.audit(method, decision, summary);
      const startTime = Date.now();

      try {
        if (decision === 'DENY') {
          throw new JSONRPCErrorException('Policy denied', GatewayErrors.POLICY_DENIED);
        }
        if (decision === 'NEEDS_APPROVAL' && this.currentCapabilityTier() !== 'autonomous') {
          const paramsRecord = params as unknown as Record<string, unknown>;
          const queueEntry = this.confirmationQueue.enqueue(
            {
              method,
              action: approvalAction,
              scope: approvalScope(params),
              params: paramsRecord,
              companionReason: resolveCompanionReason(
                paramsRecord,
                approvalReason?.(params) ?? 'Outside workspace',
              ),
              expiresInMs: this.confirmationConfig.expiryMs,
            },
            async (approvedParams, entry) => executeQueuedAction({
              method,
              handler,
              paramsSummary,
              params: approvedParams as P,
              entry,
              audit: this.audit.bind(this),
              auditComplete: this.auditComplete.bind(this),
            }),
          );
          await notifyOperatorForPendingAction({
            entry: queueEntry,
            discordAdapter: this.options.discordAdapter,
            operatorDiscordChannelId: this.confirmationConfig.operatorDiscordChannelId,
            ntfyTopic: this.confirmationConfig.ntfyTopic,
            ntfyNotifier: this.ntfyNotifier,
          });
          throw new JSONRPCErrorException(
            `Your action is pending operator approval (id: ${queueEntry.id}).`,
            GatewayErrors.NEEDS_APPROVAL,
          );
        }
        const result = await handler(params);
        this.auditComplete(auditId, startTime);
        return result;
      } catch (err) {
        const msg = toErrorMessage(err);
        this.auditComplete(auditId, startTime, msg);
        throw err;
      }
    };
  }

  private currentCapabilityTier(): CapabilityTier {
    try {
      const tier = this.capabilityTierProvider();
      return isCapabilityTier(tier) ? tier : 'nursery';
    } catch {
      return 'nursery';
    }
  }

  private resolveCapabilityTierFromEnv(): CapabilityTier {
    const value = process.env.CAPABILITY_TIER?.trim().toLowerCase();
    if (value && isCapabilityTier(value)) {
      return value;
    }
    return 'nursery';
  }

  private registerMethods(target: JSONRPCServerAndClient): void {
    const runtime: GatewayMethodRuntime = {
      target,
      llmProvider: this.options.llmProvider,
      embeddingService: this.options.embeddingService,
      discordAdapter: this.options.discordAdapter,
      gitOps: this.options.gitOps,
      policyConfig: this.options.policyConfig,
      workspacePath: this.options.policyConfig.workspacePath,
      sessionHmacKeyring: this.sessionHmacKeyring,
      notifyAll: (method, params) => this.notifyAll(method, params),
      listPendingConfirmations: () => this.confirmationQueue.listPending(),
      resolveConfirmation: (params) => this.confirmationQueue.resolve(params),
      sendNtfy: (params) => this.ntfyNotifier.send(params),
      nextStreamRequestId: () => `gw-${++this.streamRequestCounter}`,
      audited: (method, handler, paramsSummary) => this.audited(method, handler, paramsSummary),
      gated: (method, handler, paramsSummary, approvalAction, approvalScope, approvalReason) =>
        this.gated(
          method,
          handler,
          paramsSummary,
          approvalAction,
          approvalScope,
          approvalReason,
        ),
    };

    registerGatewayMethods(runtime);
  }

  // ── Connection management ──

  start(): void {
    this.netServer = createSocketServer(this.options.socketPath, (conn) => {
      log.info('Agent connected');
      this.connections.add(conn);

      const serverAndClient = new JSONRPCServerAndClient(
        new JSONRPCServer(),
        new JSONRPCClient((request) => { conn.send(request); }),
      );
      this.registerMethods(serverAndClient);
      this.rpcClients.set(conn, serverAndClient);

      conn.onMessage(async (message) => {
        await serverAndClient.receiveAndSend(message as any);
      });

      conn.on('close', () => {
        log.info('Agent disconnected');
        this.connections.delete(conn);
        this.rpcClients.delete(conn);
      });

      conn.on('error', (err) => {
        log.error('Connection error', { error: err.message });
        this.connections.delete(conn);
        this.rpcClients.delete(conn);
      });
    });
  }

  // Send notification to all connected agents
  notifyAll(method: string, params: unknown): void {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    for (const conn of this.connections) {
      conn.send(notification);
    }
  }

  // Send notification to a specific connection
  notifyOne(conn: NdjsonConnection, method: string, params: unknown): void {
    conn.send({
      jsonrpc: '2.0' as const,
      method,
      params,
    });
  }

  /** Send an RPC request to the first connected agent and await its response */
  async requestAgent<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<T> {
    const first = this.rpcClients.values().next().value;
    if (!first) throw new Error('No agent connected');

    const result = await Promise.race([
      first.request(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Agent request timed out')), timeoutMs),
      ),
    ]);
    return result as T;
  }

  async requestAgentVoiceStream(
    message: SubstrateMessage,
    options: VoiceStreamRequestOptions = {},
  ): Promise<VoiceHandleMessageResult> {
    const client = this.rpcClients.values().next().value as JSONRPCServerAndClient | undefined;
    if (!client) {
      throw new Error('No agent connected');
    }

    return requestAgentVoiceStream({
      client,
      message,
      options,
      wyomingShardRouting: this.wyomingShardRouting,
      nextRequestCounter: () => ++this.streamRequestCounter,
    });
  }

  private normalizePositiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value) || value === undefined) {
      return fallback;
    }

    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : fallback;
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();
    this.rpcClients.clear();

    if (this.netServer) {
      await new Promise<void>((resolve) => {
        this.netServer!.close(() => resolve());
      });
    }

    log.info('Stopped');
  }

  private audit(method: string, decision: PolicyDecision, params?: Record<string, unknown>): number {
    if (decision !== 'ALLOW') {
      log.info(`${method} → ${decision}`);
    }
    if (this.options.auditStore) {
      return this.options.auditStore.log(method, decision, params);
    }
    return 0;
  }

  private auditComplete(id: number, startTime: number, error?: string): void {
    if (this.options.auditStore && id > 0) {
      this.options.auditStore.complete(id, Date.now() - startTime, error);
    }
  }
}
