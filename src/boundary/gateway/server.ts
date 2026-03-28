// ── Gateway Server ──
// Host-side process that holds secrets and proxies all external interactions.

import * as net from 'node:net';
import {
  JSONRPCServer,
  JSONRPCClient,
  JSONRPCServerAndClient,
} from 'json-rpc-2.0';
import type { LLMProvider, EmbeddingService } from '../../core/agent/contracts.js';
import type { ChannelOutboundDock } from '../../channels/types.js';
import type { CapabilityTier, WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { NdjsonConnection } from './transport.js';
import { createSocketServer } from './transport.js';
import {
  type PolicyDecision,
  type RuntimeHealthResult,
  type VoiceHandleMessageResult,
} from './protocol.js';
import type { GitOperations } from '../integrations/git/ops.js';
import type { ImageRuntimeConfig } from '../../images/types.js';
import type { AuditStore } from './audit.js';
import type { SessionHmacKeyring } from '../../session/journal-utils.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { registerGatewayMethods } from './methods/index.js';
import type { GatewayMethodRuntime } from './methods/types.js';
import type { PolicyConfig } from './policy.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  requestAgentVoiceStream,
  type VoiceStreamRequestOptions,
} from './voice-stream-request.js';
import { GatewayNtfyNotifier, type GatewayNtfyConfig } from './ntfy-notifier.js';
import {
  createGatewayApprovalBoundaryService,
  type ApprovalBoundaryService,
  type GatewayConfirmationConfig,
} from './approval-boundary.js';
import { GatewayRuntimeHealthTracker } from './runtime-health.js';
import { evaluatePolicy } from './policy.js';

const log = createComponentLogger('Gateway');
const DEFAULT_CONNECTION_HEARTBEAT_STALE_AFTER_MS = 90_000;
const INVALID_FRAME_AUDIT_METHOD = 'gateway.ipc.frame.invalid';
const FRAME_PREVIEW_LIMIT = 200;
export { evaluatePolicy };
export type { GatewayNtfyConfig, PolicyConfig, VoiceStreamRequestOptions };

type GatewayConnectionState = 'registering' | 'ready' | 'degraded' | 'offline';
type GatewayConnectionHealth = 'healthy' | 'stale' | 'failed';
type MalformedFrameKind = 'ndjson' | 'jsonrpc';

interface GatewayConnectionStatus {
  state: GatewayConnectionState;
  stateReason: string;
  health: GatewayConnectionHealth;
  connectedAt: number;
  lastHeartbeatAt: number;
  lastTransitionAt: number;
  heartbeatStaleAfterMs: number;
  failureReason?: string;
}

const GATEWAY_CONNECTION_STATE_TRANSITIONS:
Readonly<Record<GatewayConnectionState, readonly GatewayConnectionState[]>> = {
  registering: ['ready', 'degraded', 'offline'],
  ready: ['degraded', 'offline'],
  degraded: ['ready', 'offline'],
  offline: [],
};

export { requireGatewaySessionHmacKeyring, resolveGatewaySessionHmacKeyring } from './session-hmac-env.js';

// ── Gateway Server Class ──

export interface GatewayServerOptions {
  socketPath: string;
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
  ntfy?: GatewayNtfyConfig;
  auditStore?: AuditStore;
  sessionHmacKeyring: SessionHmacKeyring;
  confirmation?: Partial<GatewayConfirmationConfig>;
  capabilityTierProvider?: () => CapabilityTier;
  wyomingShardRouting: WyomingShardRoutingConfig;
}

export class GatewayServer {
  private netServer: net.Server | null = null;
  private readonly connections = new Set<NdjsonConnection>();
  private readonly rpcClients = new Map<NdjsonConnection, JSONRPCServerAndClient>();
  private readonly connectionStatuses = new Map<NdjsonConnection, GatewayConnectionStatus>();
  private readonly options: GatewayServerOptions;
  private readonly sessionHmacKeyring: SessionHmacKeyring;
  private streamRequestCounter = 0;
  private readonly capabilityTierProvider: () => CapabilityTier;
  private readonly wyomingShardRouting: WyomingShardRoutingConfig;
  private readonly ntfyNotifier: GatewayNtfyNotifier;
  private readonly approvalBoundary: ApprovalBoundaryService;
  private readonly runtimeHealthTracker: GatewayRuntimeHealthTracker;

  constructor(options: GatewayServerOptions) {
    this.options = options;
    this.sessionHmacKeyring = options.sessionHmacKeyring;
    this.capabilityTierProvider = options.capabilityTierProvider ?? (() => 'nursery');
    this.wyomingShardRouting = options.wyomingShardRouting;
    this.ntfyNotifier = new GatewayNtfyNotifier(options.ntfy);
    this.approvalBoundary = createGatewayApprovalBoundaryService({
      policyConfig: options.policyConfig,
      ntfyNotifier: this.ntfyNotifier,
      discordAdapter: options.discordAdapter,
      capabilityTierProvider: this.capabilityTierProvider,
      confirmation: options.confirmation,
      audit: this.audit.bind(this),
      auditComplete: this.auditComplete.bind(this),
      recordMethodSuccess: (method) => this.runtimeHealthTracker.recordMethodSuccess(method),
      recordMethodFailure: (method, error) => this.runtimeHealthTracker.recordMethodFailure(method, error),
    });
    this.runtimeHealthTracker = new GatewayRuntimeHealthTracker({
      ntfyConfigured: Boolean(options.ntfy),
      vaultEnabled: Boolean(options.policyConfig.vault?.enabled),
      vaultAllowActions: options.policyConfig.vault?.allowActions ?? [],
      vaultOpsConfigured: Boolean(options.policyConfig.vault?.ops),
    });
    log.info('Session HMAC keyring configured', {
      activeVersion: this.sessionHmacKeyring.activeVersion,
      versionCount: Object.keys(this.sessionHmacKeyring.keys).length,
    });
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
        this.runtimeHealthTracker.recordMethodSuccess(method);
        this.auditComplete(auditId, startTime);
        return result;
      } catch (err) {
        this.runtimeHealthTracker.recordMethodFailure(method, err);
        const msg = toErrorMessage(err);
        this.auditComplete(auditId, startTime, msg);
        throw err;
      }
    };
  }

  private registerMethods(target: JSONRPCServerAndClient): void {
    const runtime: GatewayMethodRuntime = {
      target,
      llmProvider: this.options.llmProvider,
      embeddingService: this.options.embeddingService,
      ...(this.options.modelDiscovery ? { modelDiscovery: this.options.modelDiscovery } : {}),
      discordAdapter: this.options.discordAdapter,
      gitOps: this.options.gitOps,
      imageConfig: this.options.imageConfig,
      policyConfig: this.options.policyConfig,
      workspacePath: this.options.policyConfig.workspacePath,
      sessionHmacKeyring: this.sessionHmacKeyring,
      approvalBoundary: this.approvalBoundary,
      notifyAll: (method, params) => this.notifyAll(method, params),
      listPendingConfirmations: () => this.approvalBoundary.listPendingConfirmations(),
      listConfirmationHistory: () => this.approvalBoundary.listConfirmationHistory(),
      resolveConfirmation: (params) => this.approvalBoundary.resolveConfirmation(params),
      sendNtfy: (params) => this.ntfyNotifier.send(params),
      getRuntimeHealth: () => this.getRuntimeHealth(),
      nextStreamRequestId: () => `gw-${++this.streamRequestCounter}`,
      recordAuditEvent: (entry) => {
        if (this.options.auditStore) {
          this.options.auditStore.recordSummary(entry);
        }
      },
      audited: (method, handler, paramsSummary) => this.audited(method, handler, paramsSummary),
    };

    registerGatewayMethods(runtime);
  }

  // ── Connection management ──

  start(): void {
    this.netServer = createSocketServer(this.options.socketPath, (conn) => {
      log.info('Agent connected');
      this.connections.add(conn);
      this.connectionStatuses.set(conn, {
        state: 'registering',
        stateReason: 'connection_opened',
        health: 'healthy',
        connectedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        lastTransitionAt: Date.now(),
        heartbeatStaleAfterMs: DEFAULT_CONNECTION_HEARTBEAT_STALE_AFTER_MS,
      });
      this.appendConnectionTransition(conn, 'none', 'registering', 'connection_opened');

      const serverAndClient = new JSONRPCServerAndClient(
        new JSONRPCServer(),
        new JSONRPCClient((request) => { conn.send(request); }),
      );
      this.registerMethods(serverAndClient);
      this.rpcClients.set(conn, serverAndClient);
      this.transitionConnectionState(conn, 'ready', 'rpc_registered');

      conn.on('frameError', (error: unknown) => {
        const frameError = normalizeNdjsonFrameError(error);
        this.handleMalformedFrame(conn, 'ndjson', frameError.reason, frameError.preview);
      });

      conn.onMessage(async (message) => {
        if (!this.connections.has(conn)) {
          return;
        }
        this.touchConnectionHeartbeat(conn);
        this.transitionConnectionState(conn, 'ready', 'rpc_message_received');
        const validationError = validateJsonRpcFrame(message);
        if (validationError) {
          this.handleMalformedFrame(
            conn,
            'jsonrpc',
            validationError,
            summarizeFramePreview(message),
          );
          return;
        }
        // json-rpc-2.0 receiveAndSend() payload param is typed as `any`; message is parsed JSON
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try {
          await serverAndClient.receiveAndSend(message as any);
        } catch (error) {
          const messageText = toErrorMessage(error);
          this.handleMalformedFrame(
            conn,
            'jsonrpc',
            `JSON-RPC receive/send failed: ${messageText}`,
            summarizeFramePreview(message),
          );
        }
      });

      conn.on('close', () => {
        log.info('Agent disconnected');
        this.transitionConnectionState(conn, 'offline', 'connection_closed');
        this.removeConnection(conn);
      });

      conn.on('error', (err) => {
        const messageText = err instanceof Error ? err.message : String(err);
        log.error('Connection error', { error: messageText });
        this.transitionConnectionState(conn, 'degraded', 'connection_error', messageText);
        this.transitionConnectionState(conn, 'offline', 'connection_error', messageText);
        this.removeConnection(conn);
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

  private removeConnection(conn: NdjsonConnection): void {
    this.connections.delete(conn);
    this.rpcClients.delete(conn);
    this.connectionStatuses.delete(conn);
  }

  private handleMalformedFrame(
    conn: NdjsonConnection,
    frameKind: MalformedFrameKind,
    reason: string,
    preview?: string,
  ): void {
    if (!this.connectionStatuses.has(conn)) {
      return;
    }

    const startedAt = Date.now();
    const params: Record<string, unknown> = {
      frameKind,
      reason,
      ...(preview ? { preview } : {}),
    };
    const auditId = this.audit(INVALID_FRAME_AUDIT_METHOD, 'DENY', params);
    this.auditComplete(auditId, startedAt, reason);
    log.error('Malformed IPC frame received; disconnecting agent connection', params);
    this.transitionConnectionState(conn, 'degraded', 'malformed_frame', reason);
    this.transitionConnectionState(conn, 'offline', 'malformed_frame', reason);
    this.removeConnection(conn);
    if (!conn.destroyed) {
      conn.destroy();
    }
  }

  /** Send an RPC request to the first connected agent and await its response */
  async requestAgent<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<T> {
    const first = this.resolveReadyRpcClient();

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
    const client = this.resolveReadyRpcClient();

    return requestAgentVoiceStream({
      client,
      message,
      options,
      wyomingShardRouting: this.wyomingShardRouting,
      nextRequestCounter: () => ++this.streamRequestCounter,
    });
  }

  private resolveReadyRpcClient(): JSONRPCServerAndClient {
    this.refreshConnectionHealth();
    if (this.rpcClients.size === 0) {
      throw new Error('No agent connected');
    }

    for (const [conn, client] of this.rpcClients.entries()) {
      const status = this.connectionStatuses.get(conn);
      if (!status) {
        continue;
      }
      if (status.state === 'ready' && status.health === 'healthy') {
        return client;
      }
    }

    throw new Error('No ready agent connected');
  }

  private refreshConnectionHealth(now = Date.now()): void {
    for (const [conn, status] of this.connectionStatuses.entries()) {
      if (status.state !== 'ready' && status.state !== 'registering') {
        continue;
      }

      const staleForMs = now - status.lastHeartbeatAt;
      if (staleForMs <= status.heartbeatStaleAfterMs) {
        continue;
      }

      const reason = `No heartbeat observed for ${staleForMs}ms (limit ${status.heartbeatStaleAfterMs}ms).`;
      this.transitionConnectionState(conn, 'degraded', 'heartbeat_stale', reason);
    }
  }

  private touchConnectionHeartbeat(conn: NdjsonConnection): void {
    const status = this.connectionStatuses.get(conn);
    if (!status || status.state === 'offline') {
      return;
    }
    status.lastHeartbeatAt = Date.now();
    if (status.state === 'degraded' && status.stateReason === 'heartbeat_stale') {
      this.transitionConnectionState(conn, 'ready', 'heartbeat_recovered');
    }
  }

  private transitionConnectionState(
    conn: NdjsonConnection,
    nextState: GatewayConnectionState,
    reason: string,
    failureReason?: string,
  ): void {
    const status = this.connectionStatuses.get(conn);
    if (!status) {
      return;
    }

    const currentState = status.state;
    if (currentState === nextState && status.stateReason === reason && !failureReason) {
      return;
    }
    if (currentState !== nextState) {
      const allowedTransitions = GATEWAY_CONNECTION_STATE_TRANSITIONS[currentState];
      if (!allowedTransitions.includes(nextState)) {
        throw new Error(
          `Invalid gateway connection transition: ${currentState} -> ${nextState}.`,
        );
      }
      status.state = nextState;
      status.lastTransitionAt = Date.now();
    }
    status.stateReason = reason;

    if (nextState === 'ready') {
      status.health = 'healthy';
      delete status.failureReason;
    } else if (nextState === 'degraded') {
      status.health = reason === 'heartbeat_stale' ? 'stale' : 'failed';
      if (failureReason) {
        status.failureReason = failureReason;
      }
    } else if (nextState === 'offline' && failureReason) {
      status.failureReason = failureReason;
    }

    this.appendConnectionTransition(conn, currentState, nextState, reason, failureReason);
  }

  private appendConnectionTransition(
    conn: NdjsonConnection,
    from: GatewayConnectionState | 'none',
    to: GatewayConnectionState,
    reason: string,
    failureReason?: string,
  ): void {
    const status = this.connectionStatuses.get(conn);
    log.info('Gateway connection lifecycle transition', {
      from,
      to,
      reason,
      health: status?.health,
      ...(failureReason ? { failureReason } : {}),
    });
  }

  private getConnectionSummary(): {
    total: number;
    registering: number;
    ready: number;
    degraded: number;
    offline: number;
  } {
    const summary = {
      total: 0,
      registering: 0,
      ready: 0,
      degraded: 0,
      offline: 0,
    };

    for (const status of this.connectionStatuses.values()) {
      summary.total += 1;
      if (status.state === 'registering') summary.registering += 1;
      else if (status.state === 'ready') summary.ready += 1;
      else if (status.state === 'degraded') summary.degraded += 1;
      else summary.offline += 1;
    }

    return summary;
  }

  private getRuntimeHealth(): RuntimeHealthResult {
    return this.runtimeHealthTracker.getSnapshot(this.getConnectionSummary());
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();
    this.rpcClients.clear();
    this.connectionStatuses.clear();

    if (this.netServer) {
      await new Promise<void>((resolve) => {
        this.netServer!.close(() => resolve());
      });
    }

    log.info('Stopped');
  }

  private audit(method: string, decision: PolicyDecision, params?: Record<string, unknown>): number {
    const correlation = extractGatewayCorrelation(params);
    if (decision !== 'ALLOW') {
      log.info(`${method} → ${decision}`, {
        ...(Object.keys(correlation).length > 0 ? correlation : {}),
      });
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

function extractGatewayCorrelation(
  params: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!params) return {};
  const correlation: Record<string, string> = {};
  for (const key of [
    'turnId',
    'requestId',
    'channelId',
    'callType',
    'originType',
    'originStage',
    'toolName',
    'toolCallId',
    'purpose',
  ]) {
    const value = params[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    correlation[key] = trimmed;
  }
  return correlation;
}

function normalizeNdjsonFrameError(error: unknown): { reason: string; preview?: string } {
  const reason = error instanceof Error ? error.message : 'Malformed NDJSON frame received';
  if (isRecord(error)) {
    const previewValue = error.preview;
    if (typeof previewValue === 'string' && previewValue.trim()) {
      return { reason, preview: summarizeFramePreview(previewValue) };
    }
  }
  return { reason };
}

function validateJsonRpcFrame(message: unknown): string | null {
  if (!isRecord(message)) {
    return 'JSON-RPC frame must be an object';
  }
  if (message.jsonrpc !== '2.0') {
    return 'JSON-RPC frame must include jsonrpc="2.0"';
  }

  const hasMethod = hasOwn(message, 'method');
  const hasId = hasOwn(message, 'id');
  const hasResult = hasOwn(message, 'result');
  const hasError = hasOwn(message, 'error');

  if (hasMethod) {
    if (typeof message.method !== 'string' || !message.method.trim()) {
      return 'JSON-RPC request method must be a non-empty string';
    }
    if (hasResult || hasError) {
      return 'JSON-RPC request/notification must not contain result or error';
    }
    if (hasId && !isValidJsonRpcId(message.id)) {
      return 'JSON-RPC request id must be string, number, or null';
    }
    return null;
  }

  if (!hasId) {
    return 'JSON-RPC response must include id';
  }
  if (!isValidJsonRpcId(message.id)) {
    return 'JSON-RPC response id must be string, number, or null';
  }
  if (hasResult === hasError) {
    return 'JSON-RPC response must contain exactly one of result or error';
  }
  if (hasError && !isValidJsonRpcError(message.error)) {
    return 'JSON-RPC response error must include numeric code and string message';
  }
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isValidJsonRpcId(id: unknown): boolean {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function isValidJsonRpcError(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.code === 'number'
    && Number.isFinite(value.code)
    && typeof value.message === 'string'
    && value.message.trim().length > 0;
}

function summarizeFramePreview(message: unknown): string {
  if (typeof message === 'string') {
    return truncateFramePreview(message.trim());
  }
  try {
    const serialized = JSON.stringify(message);
    return truncateFramePreview(typeof serialized === 'string' ? serialized : String(message));
  } catch {
    return truncateFramePreview(String(message));
  }
}

function truncateFramePreview(value: string): string {
  if (value.length <= FRAME_PREVIEW_LIMIT) {
    return value;
  }
  return `${value.slice(0, FRAME_PREVIEW_LIMIT)}... (${value.length} chars)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
