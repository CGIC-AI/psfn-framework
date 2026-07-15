import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Lifecycle } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
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
import {
  GardenAdminTransportProxy,
  type GardenAdminTransportHealth,
} from './transport-client.js';
import type { GardenAdminTransportClientEndpoint } from './transport-paths.js';
import { validateAdminAuthStartupPolicy } from './auth-policy.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseConfirmationResolveRequest } from './confirmation-resolve-request.js';
import type { ConfirmationOperatorAuthContext } from './admin-contract.js';
import type { GatewayOperatorConfirmationClient } from '../../app/startup/support/gateway-operator-confirmation-client.js';

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
  transportEndpoint: GardenAdminTransportClientEndpoint;
  /**
   * Direct operator → gateway confirmation resolver. Only the independently
   * authenticated Garden operator process holds this; it carries the operator
   * ADMIN_TOKEN straight to the gateway so the credential never traverses the
   * agent (x5rt.10). Absent → operator-only confirmations are not resolvable
   * from this surface and stay pending (fail closed).
   */
  operatorConfirmationResolver?: GatewayOperatorConfirmationClient;
}

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

interface GardenOperatorHealthPayload {
  status: 'ok' | 'degraded';
  uptime: number;
  dependencies: {
    adminTransport: GardenAdminTransportHealth;
  };
}

export class GardenOperatorSurface implements Lifecycle {
  private readonly server: Server;
  private readonly transport: AdminServerTransport;
  private readonly proxy: GardenAdminTransportProxy;

  constructor(private readonly config: GardenOperatorSurfaceConfig) {
    this.transport = new AdminServerTransport(log);
    this.proxy = new GardenAdminTransportProxy(config.transportEndpoint);
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async init(): Promise<void> {
    this.transport.initialize();
  }

  async start(): Promise<void> {
    const host = this.config.host ?? '127.0.0.1';
    validateAdminAuthStartupPolicy({
      host,
      port: this.config.port,
      token: this.config.token,
      allowInsecureWithoutToken: this.config.allowInsecureWithoutToken,
      componentLabel: 'Garden operator surface',
      logger: log,
    });

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
          transportMode: this.config.transportEndpoint.mode,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return await new Promise((resolve, reject) => {
      this.server.closeAllConnections();
      this.proxy.close(() => {
        this.server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    handleAdminRequest(req, res, {
      token: this.config.token,
      checkAuth: (request, response) => checkAdminRequestAuth(request, response, this.config.token),
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
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/api/admin/events') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!checkAdminUpgradeAuth(req, this.config.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.proxy.handleTelemetryUpgrade(req, socket, head);
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
      this.proxy.proxyApiRequest(req, res);
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
        this.proxy.proxyBufferedApiRequest(req, res, bodyBuffer);
        return;
      }

      resolver.resolve(parsed.params, auth).then(
        (result) => {
          if (res.writableEnded || res.destroyed) return;
          if (result.status === 'not_found') {
            // Not an operator-owned gateway confirmation — resolve the
            // agent-local entry. The proxy strips the admin credential.
            this.proxy.proxyBufferedApiRequest(req, res, bodyBuffer);
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
    const adminTransport = await this.proxy.probeHealth();
    if (res.writableEnded || res.destroyed) {
      return;
    }

    const payload: GardenOperatorHealthPayload = {
      status: adminTransport.status === 'ok' ? 'ok' : 'degraded',
      uptime: process.uptime(),
      dependencies: {
        adminTransport,
      },
    };

    sendJson(res, payload.status === 'ok' ? 200 : 503, payload);
  }
}
