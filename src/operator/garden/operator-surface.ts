import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import type { Lifecycle } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  getGardenDenialsLastHour,
  recordGardenDenial,
} from './garden-denial-observability.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import {
  readBodyWithLimit,
  sendJson,
  sendRedirect,
  sendText,
} from '../../channels/backplane/http/primitives.js';
import { checkAdminRequestAuth, checkAdminUpgradeAuth } from './server-auth.js';
import { getCookieValue } from '../../channels/backplane/http/auth.js';
import { handleAdminRequest } from './server-request-routing.js';
import { AdminServerTransport } from './server-transport.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { sendGardenLoginPage } from './auth-pages.js';
import type { FleetGardenTransportProxyPort } from './fleet-transport-client.js';
import type { GardenAdminTransportClientEndpoint } from './transport-paths.js';
import { validateAdminAuthStartupPolicy } from './auth-policy.js';
import { assertFleetAuthLegacySurfacesUnavailable } from '../../system/config/fleet-auth-legacy-surface-guard.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseConfirmationResolveRequest } from './confirmation-resolve-request.js';
import type { ConfirmationOperatorAuthContext } from './admin-contract.js';
import type { GatewayOperatorConfirmationClient } from '../../app/startup/support/gateway-operator-confirmation-client.js';
import {
  GardenRequestTargetError,
  validateGardenRequestMetadata,
} from '../../boundary/fleet-auth/request-capability-target.js';
import { stripBrowserRequestCapabilityHeaders } from '../../boundary/fleet-auth/request-capability-transport.js';
import { readFleetGardenBody } from './garden-admission.js';
import type { GardenFleetChildAssertionClient } from './fleet-child-assertion-client.js';
import { FleetGardenControlPlane } from './fleet-garden-control-plane.js';
import { GardenOperatorRouting } from './garden-operator-routing.js';
import type { FleetGardenDirectDatabasePort } from './fleet-garden-operator-router.js';
import type { FleetModelUsageRouteService } from './routes/fleet-model-usage-routes.js';
import {
  requireMtlsPeerFileConfig,
  verifyPeerCertificateSpiffeUri,
  type RequiredMtlsPeerFileConfig,
} from '../../shared/net/mtls.js';

const log = createComponentLogger('GardenOperatorSurface');
const ADMIN_MAX_BODY_SIZE = 65_536;
const CONFIRMATION_RESOLVE_PATH = '/api/admin/confirmations/resolve';
const MAX_OPERATOR_AUTHORIZATION_LENGTH = 1_024;
const MAX_OPERATOR_COOKIE_TOKEN_LENGTH = 512;

export interface GardenOperatorSurfaceConfig {
  port: number;
  host?: string;
  token?: string;
  allowInsecureWithoutToken?: boolean;
  config: SubstrateConfig;
  /** Legacy fixed transport. Mutually exclusive with fleetControlPlane. */
  transportEndpoint?: GardenAdminTransportClientEndpoint;
  /** Immutable fleet admission and target registry (including a fleet of one). */
  fleetControlPlane?: FleetGardenControlPlane;
  /** Test seam; production constructs this from fleetControlPlane.targetRegistry(). */
  fleetTransport?: FleetGardenTransportProxyPort;
  /** Approved invariant-11 routes served from companion-bound Garden DB services. */
  fleetDirectDatabase?: FleetGardenDirectDatabasePort;
  /** Fleet-wide read model assembled through companion admin transports. */
  fleetModelUsage?: FleetModelUsageRouteService;
  /**
   * Direct operator → gateway confirmation resolver. Only the independently
   * authenticated Garden operator process holds this; it carries the operator
   * ADMIN_TOKEN straight to the gateway so the credential never traverses the
   * agent (x5rt.10). Absent → operator-only confirmations are not resolvable
   * from this surface and stay pending (fail closed).
   */
  operatorConfirmationResolver?: GatewayOperatorConfirmationClient;
  /** Authenticated operator→gateway exchange for an exact agent-audience child capability. */
  fleetChildAssertions?: GardenFleetChildAssertionClient;
  /** Required for a non-loopback fleet-auth Garden listener. */
  fleetSsoTls?: RequiredMtlsPeerFileConfig;
}

export type { FleetGardenTransportProxyPort } from './fleet-transport-client.js';

/**
 * Extracts the operator ADMIN_TOKEN material (bearer header and/or `psfn_token`
 * cookie) from an already-authenticated Garden operator request, to be handed
 * only to the direct operator → gateway confirmation call (x5rt.10).
 */
function extractOperatorConfirmationAuth(req: IncomingMessage): ConfirmationOperatorAuthContext {
  const authorizationHeader = req.headers.authorization;
  const authorization = typeof authorizationHeader === 'string'
    && authorizationHeader.length <= MAX_OPERATOR_AUTHORIZATION_LENGTH
    ? authorizationHeader
    : undefined;
  const adminCookieToken = getCookieValue(req, 'psfn_token');
  const cookie = adminCookieToken && adminCookieToken.length <= MAX_OPERATOR_COOKIE_TOKEN_LENGTH
    ? `psfn_token=${encodeURIComponent(adminCookieToken)}`
    : undefined;
  return {
    ...(authorization ? { authorization } : {}),
    ...(cookie ? { cookie } : {}),
  };
}

export class GardenOperatorSurface implements Lifecycle {
  private readonly server: Server | HttpsServer;
  private readonly transport: AdminServerTransport;
  private readonly routing: GardenOperatorRouting;

  constructor(private readonly config: GardenOperatorSurfaceConfig) {
    this.routing = new GardenOperatorRouting({
      config: config.config,
      ...(config.token ? { token: config.token } : {}),
      ...(config.transportEndpoint ? { transportEndpoint: config.transportEndpoint } : {}),
      ...(config.fleetControlPlane ? { fleetControlPlane: config.fleetControlPlane } : {}),
      ...(config.fleetTransport ? { fleetTransport: config.fleetTransport } : {}),
      ...(config.fleetDirectDatabase
        ? { fleetDirectDatabase: config.fleetDirectDatabase }
        : {}),
      ...(config.fleetModelUsage
        ? { fleetModelUsage: config.fleetModelUsage }
        : {}),
      ...(config.fleetChildAssertions
        ? { fleetChildAssertions: config.fleetChildAssertions }
        : {}),
    });
    this.transport = new AdminServerTransport(log);
    const handler = (req: IncomingMessage, res: ServerResponse) => this.handleRequest(req, res);
    this.server = config.fleetSsoTls
      ? createHttpsServer({
          ca: readFileSync(config.fleetSsoTls.caPath),
          cert: readFileSync(config.fleetSsoTls.certPath),
          key: readFileSync(config.fleetSsoTls.keyPath),
          requestCert: true,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
        }, handler)
      : createServer(handler);
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async init(): Promise<void> {
    this.transport.initialize();
  }

  async start(): Promise<void> {
    assertFleetAuthLegacySurfacesUnavailable({
      fleetAuthEnabled: this.routing.isFleetPrincipal(),
      processMode: 'operator',
      env: {
        ADMIN_PORT: String(this.config.port),
        ...(this.config.token ? { ADMIN_TOKEN: this.config.token } : {}),
        ...(this.config.allowInsecureWithoutToken ? { ADMIN_ALLOW_INSECURE: 'true' } : {}),
      },
      principalAuthenticationWired: this.routing.isFleetPrincipal(),
    });
    const host = this.config.host ?? '127.0.0.1';
    if (this.routing.isFleetPrincipal()) {
      const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
      if (!loopback && !this.config.fleetSsoTls) {
        throw new Error('Non-loopback fleet-auth Garden requires HTTPS mTLS with SPIFFE authorization');
      }
      if (this.config.fleetSsoTls) {
        requireMtlsPeerFileConfig(this.config.fleetSsoTls, 'Fleet SSO Garden server TLS');
      }
    } else if (this.routing.isLegacyToken()) {
      validateAdminAuthStartupPolicy({
        host,
        port: this.config.port,
        token: this.config.token,
        allowInsecureWithoutToken: this.config.allowInsecureWithoutToken,
        componentLabel: 'Garden operator surface',
        logger: log,
      });
    }

    return await new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        log.error('Garden operator surface failed to start', {
          host,
          port: this.config.port,
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          error: error.message,
        });
        reject(error);
      };

      this.server.once('error', onError);
      this.server.listen(this.config.port, host, () => {
        this.server.off('error', onError);
        log.info('Garden operator surface listening', {
          host,
          port: this.config.port,
          transportMode: this.routing.transportMode(),
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return await new Promise((resolve, reject) => {
      this.server.closeAllConnections();
      this.routing.close(() => {
        this.server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorizeFleetPeer(req)) {
      if (this.routing.isFleetPrincipal()) {
        recordGardenDenial(log, {
          reasonCode: 'transport_peer_forbidden',
          status: 403,
        });
      }
      sendText(res, 403, 'Forbidden');
      return;
    }
    if (this.routing.isFleetPrincipal()) {
      void this.handleFleetRequest(req, res);
      return;
    }
    this.dispatchRequest(req, res, this.config.token);
  }

  private dispatchRequest(
    req: IncomingMessage,
    res: ServerResponse,
    token: string | undefined,
  ): void {
    handleAdminRequest(req, res, {
      token,
      checkAuth: this.routing.isFleetPrincipal()
        ? () => true
        : (request, response) => checkAdminRequestAuth(request, response, this.config.token),
      isGardenUiEnabled: () => this.transport.isGardenUiEnabled(),
      serveGardenBuildAsset: (path, request, response) => this.transport.serveGardenBuildAsset(path, request, response),
      serveGardenPage: (path, request, response) => this.transport.serveGardenPage(path, request, response),
      route: (method, path, request, response) => this.route(method, path, request, response),
      sendNotFound: (path, response) => sendText(response, 404, `Not found: ${path}`),
      onRequestError: (path, error) => {
        log.error('Garden operator surface request failed', {
          path,
          error: toErrorMessage(error),
        });
      },
      trustedRequestCapability: this.routing.isFleetPrincipal(),
      requireAuthForPublicRoutes: this.routing.isFleetPrincipal(),
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.authorizeFleetPeer(req)) {
      if (this.routing.isFleetPrincipal()) {
        recordGardenDenial(log, {
          reasonCode: 'transport_peer_forbidden',
          status: 403,
        });
      }
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (this.routing.isFleetPrincipal()) {
      void this.handleFleetUpgrade(req, socket, head);
      return;
    }
    stripBrowserRequestCapabilityHeaders(req.headers);
    let target;
    try {
      target = validateGardenRequestMetadata({
        rawTarget: req.url ?? '/',
        method: 'WS',
        headers: req.headers,
      });
    } catch (error) {
      const status = error instanceof GardenRequestTargetError && error.code === 'route_not_declared'
        ? '404 Not Found'
        : '400 Bad Request';
      socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      socket.destroy();
      return;
    }
    if (target.canonicalPath !== '/api/admin/events' || target.canonicalQuery) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!checkAdminUpgradeAuth(req, this.config.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.routing.handleTelemetryUpgrade(req, socket, head);
  }

  private async handleFleetRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer | null;
    try {
      body = await readFleetGardenBody(req, res, {
        maxBytes: ADMIN_MAX_BODY_SIZE,
        logger: log,
      });
    } catch (error) {
      log.error('Fleet Garden request body read failed', { error: toErrorMessage(error) });
      if (!res.writableEnded && !res.destroyed) sendText(res, 500, 'Internal Server Error');
      return;
    }
    if (body === null) return;
    await this.routing.handleFleetHttp({
      req,
      res,
      body,
      dispatchLocal: innerTarget => this.dispatchInnerRequest(req, res, innerTarget),
    });
  }

  private async handleFleetUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    await this.routing.handleFleetUpgrade(req, socket, head);
  }

  private dispatchInnerRequest(
    req: IncomingMessage,
    res: ServerResponse,
    innerTarget: string,
  ): void {
    const outerTarget = req.url;
    req.url = innerTarget;
    try {
      this.dispatchRequest(req, res, undefined);
    } finally {
      req.url = outerTarget;
    }
  }

  private authorizeFleetPeer(req: IncomingMessage): boolean {
    if (!this.routing.isFleetPrincipal()) return true;
    if (!this.config.fleetSsoTls) {
      const address = req.socket.remoteAddress;
      return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    }
    const socket = req.socket as TLSSocket;
    if (!socket.authorized) return false;
    const certificate = socket.getPeerCertificate();
    return Object.keys(certificate).length > 0
      && verifyPeerCertificateSpiffeUri(
        certificate,
        this.config.fleetSsoTls.expectedPeerSpiffeUri,
      ) === null;
  }

  private route(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    if (method === 'GET' && path === '/login') {
      sendGardenLoginPage(res, this.config.config);
      return true;
    }

    if (method === 'POST' && path === '/login') {
      this.withBody(req, res, (body) => {
        if (!this.config.token) {
          sendGardenLoginPage(
            res,
            this.config.config,
            'Login is unavailable when ADMIN_TOKEN is unset.',
            503,
          );
          return;
        }

        const params = new URLSearchParams(body);
        const token = params.get('token') ?? '';
        if (timingSafeStringEqual(token, this.config.token)) {
          const encodedToken = encodeURIComponent(token);
          sendRedirect(res, '/', 302, {
            'Set-Cookie': `psfn_token=${encodedToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
          });
          return;
        }

        sendGardenLoginPage(res, this.config.config, 'Invalid token');
      });
      return true;
    }

    if (method === 'POST' && path === '/api/admin/logout') {
      sendJson(
        res,
        200,
        { ok: true },
        {
          'Set-Cookie': 'psfn_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
        },
      );
      return true;
    }

    if (method === 'GET' && path === '/health') {
      void this.handleHealth(res);
      return true;
    }

    if (method === 'POST' && path === CONFIRMATION_RESOLVE_PATH) {
      this.handleConfirmationResolve(req, res);
      return true;
    }

    if (path === '/api/admin' || path.startsWith('/api/admin/')) {
      this.routing.proxyApiRequest(req, res);
      return true;
    }

    return false;
  }

  /**
   * Resolves a confirmation from the independently authenticated Garden
   * operator process (x5rt.10).
   *
   * Operator-owned gateway confirmations (e.g. kube self-management) are
   * resolved on a direct operator → gateway path that carries the operator
   * ADMIN_TOKEN; the credential never crosses into the agent. Agent-local
   * confirmations (e.g. card proposals) are proxied to the agent with the
   * credential stripped. When no resolver or no operator credential is present,
   * only agent-local resolution is attempted and operator-owned entries stay
   * pending — fail closed.
   */
  private handleConfirmationResolve(req: IncomingMessage, res: ServerResponse): void {
    this.withBody(req, res, (body) => {
      const parsedBody = parseAdminJsonBody(body);
      if (!parsedBody.ok) {
        sendJson(res, 400, { ok: false, message: parsedBody.error });
        return;
      }
      const parsed = parseConfirmationResolveRequest(parsedBody.value);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, message: parsed.error });
        return;
      }

      const bodyBuffer = Buffer.from(body, 'utf8');
      const resolver = this.config.operatorConfirmationResolver;
      const auth = extractOperatorConfirmationAuth(req);
      const hasOperatorCredential = auth.authorization !== undefined || auth.cookie !== undefined;

      if (!resolver || !hasOperatorCredential) {
        // No operator → gateway resolution path (or no operator credential):
        // only agent-local confirmations are resolvable. The admin credential,
        // if any, is stripped before the request reaches the agent; operator
        // -owned entries stay pending.
        this.routing.proxyBufferedApiRequest(req, res, bodyBuffer);
        return;
      }

      resolver.resolve(parsed.params, auth).then(
        (result) => {
          if (res.writableEnded || res.destroyed) return;
          if (result.status === 'not_found') {
            // Not an operator-owned gateway confirmation — resolve the
            // agent-local entry. The proxy strips the admin credential.
            this.routing.proxyBufferedApiRequest(req, res, bodyBuffer);
            return;
          }
          sendJson(res, 200, {
            ok: result.status === 'approved' || result.status === 'modified',
            message: result.message,
            status: result.status,
            executed: result.executed,
          });
        },
        (error) => {
          log.error('Operator confirmation resolution failed', {
            error: toErrorMessage(error),
          });
          if (res.writableEnded || res.destroyed) return;
          sendJson(res, 500, { ok: false, message: 'Confirmation resolve failed' });
        },
      );
    });
  }

  private withBody(
    req: IncomingMessage,
    res: ServerResponse,
    cb: (body: string) => void,
  ): void {
    readBodyWithLimit(req, res, {
      maxBytes: ADMIN_MAX_BODY_SIZE,
      logger: log,
    }).then(
      (body) => {
        if (body === null) return;
        cb(body);
      },
      (error) => {
        log.error('Garden operator surface body read failed', {
          error: toErrorMessage(error),
        });
        if (res.writableEnded || res.destroyed) return;
        sendText(res, 500, 'Internal Server Error');
      },
    );
  }

  private async handleHealth(res: ServerResponse): Promise<void> {
    const probe = await this.routing.probe();
    if (probe.kind === 'fleet') {
      const { readiness } = probe;
      if (res.writableEnded || res.destroyed) return;
      sendJson(res, readiness.status === 'ready' ? 200 : 503, {
        status: readiness.status === 'ready' ? 'ok' : 'degraded',
        uptime: process.uptime(),
        gardenDenialsLastHour: getGardenDenialsLastHour(),
        // /health is always-public. Probe every registered target internally,
        // but never disclose fleet membership, endpoints, or raw failure
        // reasons through this response.
        dependencies: { adminTransports: { status: readiness.status } },
      });
      return;
    }
    const adminTransport = probe.health;
    if (res.writableEnded || res.destroyed) {
      return;
    }

    const payload = {
      status: adminTransport.status === 'ok' ? 'ok' : 'degraded',
      uptime: process.uptime(),
      gardenDenialsLastHour: getGardenDenialsLastHour(),
      dependencies: {
        adminTransport,
      },
    };

    sendJson(res, payload.status === 'ok' ? 200 : 503, payload);
  }
}
