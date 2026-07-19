import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  FleetGardenTargetRegistry,
  type FleetGardenTargetIdentity,
} from './fleet-garden-target-registry.js';
import {
  FLEET_MODEL_USAGE_INTERNAL_HEADER,
  GardenAdminTransportProxy,
} from './transport-client.js';

export interface FleetGardenTransportProxyPort {
  close(callback: () => void): void;
  probeAll(): Promise<void>;
  proxyBufferedApiRequest(
    target: FleetGardenTargetIdentity,
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    trustedAuthorityHeaders: Readonly<Record<string, string>>,
    requestPath: string,
  ): void;
  handleTelemetryUpgrade(
    target: FleetGardenTargetIdentity,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    trustedAuthorityHeaders: Readonly<Record<string, string>>,
    expiresAtSeconds: number,
    requestPath: string,
  ): void;
}

/** Narrow read client used by fleet-wide accounting fan-out. */
export interface FleetGardenModelUsageTransportPort {
  requestModelUsage(
    target: FleetGardenTargetIdentity,
    requestPath: string,
  ): Promise<unknown>;
}

interface FleetTargetProxy {
  readonly target: FleetGardenTargetIdentity;
  readonly proxy: GardenAdminTransportProxy;
}

/**
 * Owns one fixed transport adapter per immutable registry identity. Callers
 * must supply the exact identity returned by admission; a companion ID copied
 * or reconstructed later is insufficient to select an endpoint.
 */
export class FleetGardenAdminTransportProxy implements
  FleetGardenTransportProxyPort,
  FleetGardenModelUsageTransportPort {
  private readonly proxies: ReadonlyMap<string, FleetTargetProxy>;

  constructor(private readonly registry: FleetGardenTargetRegistry) {
    this.proxies = new Map(registry.companionIds().map((companionId) => {
      const target = registry.resolve(companionId);
      return [companionId, Object.freeze({
        target,
        proxy: new GardenAdminTransportProxy(target.endpoint),
      })];
    }));
  }

  close(callback: () => void): void {
    const entries = [...this.proxies.values()];
    let remaining = entries.length;
    if (remaining === 0) {
      callback();
      return;
    }
    for (const entry of entries) {
      entry.proxy.close(() => {
        remaining -= 1;
        if (remaining === 0) callback();
      });
    }
  }

  async probeAll(): Promise<void> {
    await Promise.all([...this.proxies.values()].map(async ({ target, proxy }) => {
      const health = await proxy.probeHealth();
      const probedAt = new Date().toISOString();
      this.registry.reportHealth(
        target.companionId,
        health.status === 'ok'
          ? { status: 'ready', probedAt }
          : {
              status: 'unavailable',
              probedAt,
              reason: health.error ?? `Admin transport probe returned HTTP ${health.httpStatus ?? 503}`,
            },
      );
    }));
  }

  proxyBufferedApiRequest(
    target: FleetGardenTargetIdentity,
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    trustedAuthorityHeaders: Readonly<Record<string, string>>,
    requestPath: string,
  ): void {
    this.requireExactProxy(target).proxyBufferedApiRequest(
      req,
      res,
      body,
      trustedAuthorityHeaders,
      requestPath,
      503,
    );
  }

  requestModelUsage(
    target: FleetGardenTargetIdentity,
    requestPath: string,
  ): Promise<unknown> {
    const parsed = new URL(requestPath, 'http://localhost');
    if (!requestPath.startsWith('/')
      || parsed.origin !== 'http://localhost'
      || parsed.pathname !== '/api/admin/model-usage'
      || parsed.hash) {
      throw new Error('Fleet model-usage transport requires the canonical model-usage route');
    }
    return this.requireExactProxy(target).requestJson(requestPath, {
      accept: 'application/json',
      [FLEET_MODEL_USAGE_INTERNAL_HEADER]: '1',
    });
  }

  handleTelemetryUpgrade(
    target: FleetGardenTargetIdentity,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    trustedAuthorityHeaders: Readonly<Record<string, string>>,
    expiresAtSeconds: number,
    requestPath: string,
  ): void {
    this.requireExactProxy(target).handleTelemetryUpgrade(
      req,
      socket,
      head,
      trustedAuthorityHeaders,
      expiresAtSeconds,
      requestPath,
    );
  }

  private requireExactProxy(target: FleetGardenTargetIdentity): GardenAdminTransportProxy {
    const entry = this.proxies.get(target.companionId);
    if (!entry || entry.target !== target
      || target.expectedAgentAudience !== `agent:${target.companionId}`) {
      throw new Error('Fleet Garden transport target does not match the immutable registry');
    }
    return entry.proxy;
  }
}
