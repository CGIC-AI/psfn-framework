import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { sendText } from '../../channels/backplane/http/primitives.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { buildGardenCapabilityHeaders } from './garden-admission.js';
import type {
  GardenFleetChildAssertion,
  GardenFleetChildAssertionClient,
} from './fleet-child-assertion-client.js';
import {
  FleetGardenControlPlane,
  type FleetGardenAdmittedPrincipalRequest,
  type FleetGardenReadiness,
} from './fleet-garden-control-plane.js';
import type { FleetGardenTransportProxyPort } from './fleet-transport-client.js';
import {
  handleFleetModelUsageRoute,
  type FleetModelUsageRouteService,
} from './routes/fleet-model-usage-routes.js';
import {
  observeGardenServiceDenial,
  recordGardenDenial,
} from './garden-denial-observability.js';

const log = createComponentLogger('FleetGardenOperatorRouter');

export interface FleetGardenOperatorRouterOptions {
  readonly controlPlane: FleetGardenControlPlane;
  readonly transport: FleetGardenTransportProxyPort;
  readonly childAssertions?: GardenFleetChildAssertionClient;
  readonly directDatabase?: FleetGardenDirectDatabasePort;
  readonly fleetModelUsage?: FleetModelUsageRouteService;
}

export interface FleetGardenDirectDatabasePort {
  handleHttp(input: {
    readonly admission: FleetGardenAdmittedPrincipalRequest;
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
  }): boolean;
}

/**
 * Deep fleet adapter between raw operator requests and one exact admitted
 * admin transport. It owns no companion selection state: every dispatch uses
 * the immutable target returned by the same request's admission.
 */
export class FleetGardenOperatorRouter {
  constructor(private readonly options: FleetGardenOperatorRouterOptions) {}

  close(callback: () => void): void {
    this.options.transport.close(callback);
  }

  async probe(): Promise<FleetGardenReadiness> {
    await this.options.transport.probeAll();
    return this.options.controlPlane.probe();
  }

  async handleHttp(input: {
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
    readonly body: Buffer;
    readonly dispatchLocal: (innerTarget: string) => void;
  }): Promise<void> {
    const admitted = await this.options.controlPlane.admit({
      rawTarget: input.req.url ?? '/',
      method: input.req.method ?? 'GET',
      headers: input.req.headers,
      body: input.body,
    });
    if (admitted.decision === 'deny') {
      sendText(input.res, admitted.status, admitted.message);
      return;
    }
    observeGardenServiceDenial(input.res, log, admitted.context);
    if (admitted.kind === 'public'
      || !admitted.target.canonicalPath.startsWith('/api/admin/')) {
      input.dispatchLocal(admitted.target.canonicalRequestTarget);
      return;
    }
    if (this.options.directDatabase?.handleHttp({
      admission: admitted,
      req: input.req,
      res: input.res,
    })) {
      return;
    }
    if (admitted.target.canonicalPath === '/api/admin/fleet-model-usage') {
      if (!this.options.fleetModelUsage) {
        sendText(input.res, 503, 'Fleet model usage unavailable');
        return;
      }
      const authorizedCompanionIds = admitted.verified.authContext.fleetCompanionIds;
      const modelUsageRequestTarget =
        admitted.verified.authContext.fleetModelUsageRequestTarget;
      if (!authorizedCompanionIds
        || !modelUsageRequestTarget
        || !authorizedCompanionIds.includes(admitted.companionId)) {
        sendText(input.res, 403, 'Fleet model usage authority unavailable');
        return;
      }
      const originalTarget = input.req.url;
      input.req.url = admitted.target.canonicalRequestTarget;
      try {
        handleFleetModelUsageRoute(input.req, input.res, this.options.fleetModelUsage, {
          authorizedCompanionIds: authorizedCompanionIds.map(companionId => (
            createCompanionId(companionId)
          )),
          modelUsageRequestTarget,
          token: admitted.authority.token,
          context: admitted.authority.context,
          parentCompanionId: admitted.companionId,
          parentRequestTarget: admitted.target.canonicalRequestTarget,
        });
      } finally {
        input.req.url = originalTarget;
      }
      return;
    }
    if (!this.options.childAssertions) {
      sendText(input.res, 503, 'Fleet child assertion exchange unavailable');
      return;
    }
    try {
      const child = await this.exchangeChild(admitted);
      this.options.transport.proxyBufferedApiRequest(
        admitted.upstream,
        input.req,
        input.res,
        admitted.target.body,
        buildGardenCapabilityHeaders(child),
        admitted.target.canonicalRequestTarget,
      );
    } catch (error) {
      log.warn('Fleet child assertion exchange failed', { error: toErrorMessage(error) });
      sendText(input.res, 403, 'Fleet child assertion exchange denied');
    }
  }

  async handleUpgrade(input: {
    readonly req: IncomingMessage;
    readonly socket: Duplex;
    readonly head: Buffer;
  }): Promise<void> {
    const admitted = await this.options.controlPlane.admit({
      rawTarget: input.req.url ?? '/',
      method: 'WS',
      headers: input.req.headers,
      body: Buffer.alloc(0),
    });
    if (admitted.decision === 'deny') {
      input.socket.write(`HTTP/1.1 ${admitted.status} Unauthorized\r\n\r\n`);
      input.socket.destroy();
      return;
    }
    if (admitted.kind !== 'fleet_principal'
      || !this.options.childAssertions
      || admitted.target.canonicalPath !== '/api/admin/events'
      || admitted.target.canonicalQuery) {
      recordGardenDenial(log, {
        reasonCode: 'websocket_route_denied',
        status: 403,
        routeId: admitted.target.resource.routeId,
        action: admitted.target.action,
        principalId: admitted.kind === 'fleet_principal'
          ? admitted.context.actor.principalId
          : undefined,
      });
      input.socket.write('HTTP/1.1 403 Unauthorized\r\n\r\n');
      input.socket.destroy();
      return;
    }
    try {
      const child = await this.exchangeChild(admitted);
      this.options.transport.handleTelemetryUpgrade(
        admitted.upstream,
        input.req,
        input.socket,
        input.head,
        buildGardenCapabilityHeaders(child),
        admitted.verified.expiresAt,
        admitted.target.canonicalRequestTarget,
      );
    } catch (error) {
      recordGardenDenial(log, {
        reasonCode: 'child_assertion_denied',
        status: 403,
        routeId: admitted.target.resource.routeId,
        action: admitted.target.action,
        principalId: admitted.context.actor.principalId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      input.socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      input.socket.destroy();
    }
  }

  private async exchangeChild(
    admitted: FleetGardenAdmittedPrincipalRequest,
  ): Promise<GardenFleetChildAssertion> {
    const childAssertions = this.options.childAssertions;
    if (!childAssertions) {
      throw new Error('Fleet child assertion exchange unavailable');
    }
    return await childAssertions.exchange({
      parentToken: admitted.authority.token,
      parentContext: admitted.authority.context,
      parentVerified: admitted.verified,
      target: admitted.target,
      expectedAgentAudience: admitted.upstream.expectedAgentAudience,
      ...(admitted.verified.authContext.provider === 'testing_harness'
        ? {
            providerIdentity: {
              provider: 'testing_harness' as const,
              audience: admitted.verified.authContext.principalId,
            },
          }
        : {}),
    });
  }
}
