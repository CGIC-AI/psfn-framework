import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Lifecycle } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  readBodyWithLimit,
  sendJson,
  sendRedirect,
  sendText,
} from '../../channels/backplane/http/primitives.js';
import { checkAdminRequestAuth, checkAdminUpgradeAuth } from './server-auth.js';
import { handleAdminRequest } from './server-request-routing.js';
import { AdminServerTransport } from './server-transport.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { sendGardenLoginPage } from './auth-pages.js';
import {
  GardenAdminTransportProxy,
  type GardenAdminTransportHealth,
} from './transport-client.js';
import type { GardenAdminTransportClientEndpoint } from './transport-paths.js';

const log = createComponentLogger('GardenOperatorSurface');
const ADMIN_MAX_BODY_SIZE = 65_536;

export interface GardenOperatorSurfaceConfig {
  port: number;
  host?: string;
  token?: string;
  allowInsecureWithoutToken?: boolean;
  config: SubstrateConfig;
  transportEndpoint: GardenAdminTransportClientEndpoint;
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
    if (!this.config.token && !this.config.allowInsecureWithoutToken) {
      const error = new Error('ADMIN_TOKEN is required unless ADMIN_ALLOW_INSECURE=true');
      log.error('Refusing to start Garden operator surface without authentication', {
        host: this.config.host ?? '127.0.0.1',
        port: this.config.port,
        requiredEnv: 'ADMIN_TOKEN or ADMIN_ALLOW_INSECURE=true',
      });
      throw error;
    }

    return await new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        log.error('Garden operator surface failed to start', {
          host: this.config.host ?? '127.0.0.1',
          port: this.config.port,
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          error: error.message,
        });
        reject(error);
      };

      this.server.once('error', onError);
      this.server.listen(this.config.port, this.config.host ?? '127.0.0.1', () => {
        this.server.off('error', onError);
        log.info('Garden operator surface listening', {
          host: this.config.host ?? '127.0.0.1',
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
      serveGardenBuildAsset: (path, response) => this.transport.serveGardenBuildAsset(path, response),
      serveGardenPage: (path, response) => this.transport.serveGardenPage(path, response),
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
        if (token === this.config.token) {
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

    if (path === '/api/admin' || path.startsWith('/api/admin/')) {
      this.proxy.proxyApiRequest(req, res);
      return true;
    }

    return false;
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
