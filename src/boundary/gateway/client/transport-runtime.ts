import {
  JSONRPCClient,
  JSONRPCServer,
  JSONRPCServerAndClient,
} from 'json-rpc-2.0';
import { randomUUID } from 'node:crypto';
import { getActiveCanaryToken, CANARY_CARRIER_PARAM_KEY } from '../../../core/cogsec/canary/canary-token.js';
import { isEgressCanaryMethod } from '../../../core/cogsec/canary/egress-scan.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { FleetCompanionPostureSummary } from '../../../shared/telemetry/fleet-posture.js';
import { abortError } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';
import type {
  GatewayRpcConnection,
  GatewayRpcSerializedTransportStats,
} from '../transport.js';

const log = createComponentLogger('GatewayClient');

interface GatewayClientTransportCloseEvent {
  source: 'close' | 'error';
  error?: Error;
}

interface GatewayClientTransportRuntimeOptions {
  onChunkNotification: (params: unknown) => void;
  onFirstOutputNotification: (params: unknown) => void;
  onClose: (event: GatewayClientTransportCloseEvent) => void;
}

/**
 * Owns one GatewayClient connection and its bidirectional JSON-RPC lifecycle.
 * The facade supplies protocol-capability handlers; this runtime preserves the
 * original frame routing and connection-event ordering.
 */
export class GatewayClientTransportRuntime {
  readonly target: JSONRPCServerAndClient;
  private readonly notificationHandlers = new Map<string, Array<(params: unknown) => void | Promise<void>>>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private fleetPostureProvider: (() => FleetCompanionPostureSummary) | null = null;
  private fleetPostureReportInFlight = false;
  private destroying = false;

  constructor(
    private readonly connection: GatewayRpcConnection,
    options: GatewayClientTransportRuntimeOptions,
  ) {
    this.target = new JSONRPCServerAndClient(
      new JSONRPCServer(),
      new JSONRPCClient((request) => {
        this.connection.send(attachCanaryToEgressRequest(request));
      }),
    );

    this.connection.onMessage((message: unknown) => {
      const msg = message as Record<string, unknown>;
      if ('method' in msg && !('id' in msg)) {
        const method = msg.method as string;
        if (method === 'llm.chunk') {
          options.onChunkNotification(msg.params);
          return;
        }
        if (method === 'llm.first_output') {
          options.onFirstOutputNotification(msg.params);
          return;
        }
        this.handleNotification(method, msg.params);
        return;
      }

      // json-rpc-2.0 receiveAndSend() intentionally types the payload as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void this.target.receiveAndSend(msg as any).catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        log.error('Gateway RPC dispatch failed', { error: normalized.message });
        options.onClose({ source: 'error', error: normalized });
      });
    });

    this.connection.on('close', () => {
      options.onClose({ source: 'close' });
    });
    this.connection.on('error', (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      options.onClose({ source: 'error', error: normalized });
    });
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.target.request(method, params) as Promise<T>;
  }

  async requestWithAbortSignal<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    remoteCancellation?: 'llm' | 'mcp',
    companionId?: string,
  ): Promise<T> {
    const cancellationId = remoteCancellation ? randomUUID() : undefined;
    const requestParams = cancellationId ? { ...params, cancellationId } : params;
    if (!signal) return await this.request<T>(method, requestParams);
    if (signal.aborted) throw abortError(signal.reason);

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finalize = (kind: 'resolve' | 'reject', value: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (kind === 'resolve') resolve(value as T);
        else reject(value);
      };
      const onAbort = () => {
        if (cancellationId && remoteCancellation) {
          this.notify(`${remoteCancellation}.cancel`, {
            cancellationId,
            ...(remoteCancellation === 'llm' && companionId ? { companionId } : {}),
          });
        }
        finalize('reject', abortError(signal.reason));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.request<T>(method, requestParams).then(
        (result) => finalize('resolve', result),
        (error) => finalize('reject', error),
      );
    });
  }

  onNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): () => void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    };
  }

  startKeepalive(intervalMs: number): void {
    if (this.keepaliveTimer || this.destroying) return;
    this.keepaliveTimer = setInterval(() => this.sendKeepalive(), intervalMs);
    this.keepaliveTimer.unref();
  }

  async startFleetPostureReporting(provider: () => FleetCompanionPostureSummary): Promise<void> {
    if (this.fleetPostureProvider) throw new Error('Fleet posture reporting is already configured');
    this.fleetPostureProvider = provider;
    this.fleetPostureReportInFlight = true;
    try {
      await this.publishFleetPosture();
    } catch (error) {
      this.fleetPostureProvider = null;
      throw error;
    } finally {
      this.fleetPostureReportInFlight = false;
    }
  }

  handleConnectionClosed(): void {
    this.stopKeepalive();
    this.fleetPostureProvider = null;
  }

  destroy(): void {
    this.destroying = true;
    this.handleConnectionClosed();
    this.notificationHandlers.clear();
    this.connection.destroy();
  }

  notify(method: string, params: unknown): void {
    this.target.notify(method, params);
  }

  send(message: unknown): void {
    this.connection.send(message);
  }

  sendHeartbeat(): boolean {
    return this.connection.sendHeartbeat();
  }

  get serializedTransportStats(): GatewayRpcSerializedTransportStats {
    return this.connection.serializedTransportStats;
  }

  rejectAllPendingRequests(reason: string): void {
    this.target.rejectAllPendingRequests(reason);
  }

  destroyConnection(): void {
    this.connection.destroy();
  }

  private stopKeepalive(): void {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private sendKeepalive(): void {
    if (this.destroying) return;
    if (!this.connection.sendHeartbeat()) {
      log.debug('Gateway transport heartbeat failed; closing connection');
      this.connection.destroy();
      return;
    }
    if (this.fleetPostureProvider && !this.fleetPostureReportInFlight) {
      this.fleetPostureReportInFlight = true;
      void this.publishFleetPosture()
        .catch((error: unknown) => {
          log.error('Fleet posture health report failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => { this.fleetPostureReportInFlight = false; });
    }
  }

  private async publishFleetPosture(): Promise<void> {
    const provider = this.fleetPostureProvider;
    if (!provider) return;
    const result = await this.request('gateway.client.health', { posture: provider() });
    if (!isRecord(result) || result.success !== true || Object.keys(result).length !== 1) {
      throw new Error('Gateway returned an invalid fleet posture acknowledgement');
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        const lifecycle = handler(params);
        if (lifecycle) {
          void lifecycle.catch((error: unknown) => {
            log.error(`Async notification handler error for ${method}`, { error: String(error) });
          });
        }
      } catch (error) {
        log.error(`Notification handler error for ${method}`, { error: String(error) });
      }
    }
  }
}

function attachCanaryToEgressRequest<T>(request: T): T {
  const rpc = request as unknown as { method?: unknown; params?: unknown };
  if (typeof rpc.method !== 'string' || !isEgressCanaryMethod(rpc.method)) {
    return request;
  }
  const token = getActiveCanaryToken();
  if (!token) return request;
  if (!rpc.params || typeof rpc.params !== 'object' || Array.isArray(rpc.params)) {
    return request;
  }
  (rpc.params as Record<string, unknown>)[CANARY_CARRIER_PARAM_KEY] = token;
  return request;
}
