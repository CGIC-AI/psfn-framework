import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { sendText } from '../../channels/backplane/http/primitives.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  admitFleetGardenRequest,
  buildGardenCapabilityHeaders,
  resolveGardenAdmissionMode,
  type GardenAdmissionMode,
} from './garden-admission.js';
import type { GardenFleetChildAssertionClient } from './fleet-child-assertion-client.js';
import type {
  FleetGardenControlPlane,
  FleetGardenReadiness,
} from './fleet-garden-control-plane.js';
import {
  FleetGardenOperatorRouter,
  type FleetGardenDirectDatabasePort,
} from './fleet-garden-operator-router.js';
import {
  FleetGardenAdminTransportProxy,
  type FleetGardenTransportProxyPort,
} from './fleet-transport-client.js';
import {
  GardenAdminTransportProxy,
  type GardenAdminTransportHealth,
} from './transport-client.js';
import type { GardenAdminTransportClientEndpoint } from './transport-paths.js';

const log = createComponentLogger('GardenOperatorRouting');

export interface GardenOperatorRoutingOptions {
  readonly config: SubstrateConfig;
  readonly token?: string;
  readonly transportEndpoint?: GardenAdminTransportClientEndpoint;
  readonly fleetControlPlane?: FleetGardenControlPlane;
  readonly fleetTransport?: FleetGardenTransportProxyPort;
  readonly fleetChildAssertions?: GardenFleetChildAssertionClient;
  readonly fleetDirectDatabase?: FleetGardenDirectDatabasePort;
}

export type GardenOperatorTransportProbe =
  | { readonly kind: 'fixed'; readonly health: GardenAdminTransportHealth }
  | { readonly kind: 'fleet'; readonly readiness: FleetGardenReadiness };

/**
 * Transport/admission strategy selected once at startup. The HTTP surface
 * delegates here instead of owning parallel fixed and fleet routing state.
 */
export class GardenOperatorRouting {
  private readonly fixedProxy: GardenAdminTransportProxy | undefined;
  private readonly fleetRouter: FleetGardenOperatorRouter | undefined;
  private readonly admission: GardenAdmissionMode | undefined;

  constructor(private readonly options: GardenOperatorRoutingOptions) {
    if (options.fleetControlPlane && options.transportEndpoint) {
      throw new Error('Garden operator routing cannot combine fixed and fleet transports');
    }
    if (options.fleetTransport && !options.fleetControlPlane) {
      throw new Error('Garden operator fleet transport requires a fleet control plane');
    }
    if (options.fleetControlPlane) {
      if (options.config.multiCompanion !== true || !options.config.fleetAuthVerifier) {
        throw new Error('Fleet Garden routing requires multi-companion Fleet Auth configuration');
      }
      const fleetTransport = options.fleetTransport
        ?? new FleetGardenAdminTransportProxy(options.fleetControlPlane.targetRegistry());
      this.fleetRouter = new FleetGardenOperatorRouter({
        controlPlane: options.fleetControlPlane,
        transport: fleetTransport,
        ...(options.fleetChildAssertions
          ? { childAssertions: options.fleetChildAssertions }
          : {}),
        ...(options.fleetDirectDatabase
          ? { directDatabase: options.fleetDirectDatabase }
          : {}),
      });
      this.fixedProxy = undefined;
      this.admission = undefined;
      return;
    }
    if (!options.transportEndpoint) {
      throw new Error('Garden operator routing requires a fixed or fleet admin transport');
    }
    this.admission = resolveGardenAdmissionMode({
      fleetAuthVerifier: options.config.fleetAuthVerifier,
      companionId: options.config.companionId,
      audience: 'operator',
      token: options.token,
    });
    this.fixedProxy = new GardenAdminTransportProxy(options.transportEndpoint);
    this.fleetRouter = undefined;
  }

  isFleetPrincipal(): boolean {
    return this.fleetRouter !== undefined || this.admission?.kind === 'fleet-principal';
  }

  isLegacyToken(): boolean {
    return this.admission?.kind === 'legacy-token';
  }

  transportMode(): 'fleet' | GardenAdminTransportClientEndpoint['mode'] {
    return this.fleetRouter ? 'fleet' : this.requireFixedProxyEndpoint().mode;
  }

  close(callback: () => void): void {
    if (this.fleetRouter) this.fleetRouter.close(callback);
    else this.requireFixedProxy().close(callback);
  }

  async probe(): Promise<GardenOperatorTransportProbe> {
    return this.fleetRouter
      ? { kind: 'fleet', readiness: await this.fleetRouter.probe() }
      : { kind: 'fixed', health: await this.requireFixedProxy().probeHealth() };
  }

  proxyApiRequest(req: IncomingMessage, res: ServerResponse): void {
    this.requireFixedProxy().proxyApiRequest(req, res);
  }

  proxyBufferedApiRequest(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    this.requireFixedProxy().proxyBufferedApiRequest(req, res, body);
  }

  handleTelemetryUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.requireFixedProxy().handleTelemetryUpgrade(req, socket, head);
  }

  async handleFleetHttp(input: {
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
    readonly body: Buffer;
    readonly dispatchLocal: (innerTarget: string) => void;
  }): Promise<void> {
    if (this.fleetRouter) {
      await this.fleetRouter.handleHttp(input);
      return;
    }
    const admitted = await admitFleetGardenRequest({
      admission: this.requireFixedFleetAdmission(),
      rawTarget: input.req.url ?? '/',
      method: input.req.method ?? 'GET',
      headers: input.req.headers,
      body: input.body,
    });
    if (admitted.decision === 'deny') {
      sendText(input.res, admitted.status, admitted.message);
      return;
    }
    if (!admitted.target.canonicalPath.startsWith('/api/admin/')) {
      input.dispatchLocal(admitted.target.canonicalRequestTarget);
      return;
    }
    if (!admitted.authority || !admitted.verified || !this.options.fleetChildAssertions) {
      sendText(input.res, 503, 'Fleet child assertion exchange unavailable');
      return;
    }
    try {
      const child = await this.options.fleetChildAssertions.exchange({
        parentToken: admitted.authority.token,
        parentContext: admitted.authority.context,
        parentVerified: admitted.verified,
        target: admitted.target,
        expectedAgentAudience: `agent:${admitted.target.companionId}`,
      });
      this.requireFixedProxy().proxyBufferedApiRequest(
        input.req,
        input.res,
        admitted.target.body,
        buildGardenCapabilityHeaders(child),
      );
    } catch (error) {
      log.warn('Fleet child assertion exchange failed', { error: toErrorMessage(error) });
      sendText(input.res, 403, 'Fleet child assertion exchange denied');
    }
  }

  async handleFleetUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.fleetRouter) {
      await this.fleetRouter.handleUpgrade({ req, socket, head });
      return;
    }
    const admitted = await admitFleetGardenRequest({
      admission: this.requireFixedFleetAdmission(),
      rawTarget: req.url ?? '/',
      method: 'WS',
      headers: req.headers,
      body: Buffer.alloc(0),
    });
    if (admitted.decision === 'deny'
      || !admitted.authority
      || !admitted.verified
      || !this.options.fleetChildAssertions) {
      const status = admitted.decision === 'deny' ? admitted.status : 503;
      socket.write(`HTTP/1.1 ${status} Unauthorized\r\n\r\n`);
      socket.destroy();
      return;
    }
    try {
      const child = await this.options.fleetChildAssertions.exchange({
        parentToken: admitted.authority.token,
        parentContext: admitted.authority.context,
        parentVerified: admitted.verified,
        target: admitted.target,
        expectedAgentAudience: `agent:${admitted.target.companionId}`,
      });
      this.requireFixedProxy().handleTelemetryUpgrade(
        req,
        socket,
        head,
        buildGardenCapabilityHeaders(child),
        admitted.verified.expiresAt,
      );
    } catch (error) {
      log.warn('Fleet websocket child assertion exchange failed', { error: toErrorMessage(error) });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    }
  }

  private requireFixedFleetAdmission():
  Extract<GardenAdmissionMode, { kind: 'fleet-principal' }> {
    if (this.admission?.kind !== 'fleet-principal') {
      throw new Error('Garden operator fixed Fleet Auth admission is unavailable');
    }
    return this.admission;
  }

  private requireFixedProxy(): GardenAdminTransportProxy {
    if (!this.fixedProxy) throw new Error('Garden operator fixed transport is unavailable');
    return this.fixedProxy;
  }

  private requireFixedProxyEndpoint(): GardenAdminTransportClientEndpoint {
    const endpoint = this.options.transportEndpoint;
    if (!endpoint) throw new Error('Garden operator fixed transport endpoint is unavailable');
    return endpoint;
  }
}
