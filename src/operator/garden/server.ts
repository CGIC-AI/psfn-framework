// ── Admin GUI Server ──
// Serves the Garden UI shell and canonical /api/admin endpoints on ADMIN_PORT.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Lifecycle } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { readBodyWithLimit, sendText } from '../../channels/backplane/http/primitives.js';
import type { AdminServerConfig } from './admin-contract.js';
import { buildAdminRoutes, dispatchAdminRoute, type AdminRoute } from './server-routes.js';
import { checkAdminRequestAuth, checkAdminUpgradeAuth } from './server-auth.js';
import { handleAdminRequest } from './server-request-routing.js';
import { AdminServerTransport } from './server-transport.js';
import { AdminServerTelemetryTransport } from './server-telemetry-transport.js';
import { validateAdminAuthStartupPolicy } from './auth-policy.js';
import {
  admitFleetGardenRequest,
  isLegacyTokenGardenAdmission,
  readFleetGardenBody,
  resolveGardenAdmissionMode,
  type GardenAdmissionMode,
} from './garden-admission.js';

const log = createComponentLogger('AdminServer');
const ADMIN_MAX_BODY_SIZE = 65_536; // 64KB

export class AdminServer implements Lifecycle {
  private server: Server;
  private port: number;
  private host: string;
  private token?: string;
  private allowInsecureWithoutToken: boolean;
  private readonly admission: GardenAdmissionMode;
  private readonly bufferedFleetBodies = new WeakMap<IncomingMessage, string>();
  private routes: AdminRoute[];
  private transport: AdminServerTransport;
  private telemetryTransport: AdminServerTelemetryTransport;

  constructor(config: AdminServerConfig) {
    this.port = config.port;
    this.host = config.host ?? '127.0.0.1';
    this.token = config.token;
    this.allowInsecureWithoutToken = config.allowInsecureWithoutToken ?? false;
    const modeSelection = {
      fleetAuthVerifier: config.config.fleetAuthVerifier,
      companionId: config.config.companionId,
      audience: 'operator' as const,
      token: config.token,
    };
    this.admission = resolveGardenAdmissionMode(modeSelection);
    this.transport = new AdminServerTransport(log);
    this.telemetryTransport = new AdminServerTelemetryTransport(
      config.eventBus,
      (req) => this.checkUpgradeAuth(req),
    );
    this.routes = buildAdminRoutes({
      token: this.token,
      legacySessionRoutes: isLegacyTokenGardenAdmission(this.admission),
      services: config.services,
      config: config.config,
      withBody: (req, res, cb) => this.withBody(req, res, cb),
    });
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async init(): Promise<void> {
    this.transport.initialize();
  }

  async start(): Promise<void> {
    if (isLegacyTokenGardenAdmission(this.admission)) {
      validateAdminAuthStartupPolicy({
        host: this.host,
        port: this.port,
        token: this.token,
        allowInsecureWithoutToken: this.allowInsecureWithoutToken,
        componentLabel: 'admin server',
        logger: log,
      });
    }

    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        log.error('Admin server failed to start', {
          host: this.host,
          port: this.port,
          code: err.code,
          errno: err.errno,
          syscall: err.syscall,
          error: err.message,
        });
        reject(err);
      };

      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        log.info(`Listening on ${this.host}:${this.port}`);
        if (this.admission.kind === 'fleet-principal') {
          log.info('Fleet principal Garden admission enabled');
        } else if (this.token) {
          log.info('Admin authentication enabled');
        } else {
          log.warn('Admin authentication disabled by explicit ADMIN_ALLOW_INSECURE=true');
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.closeAllConnections();
      this.telemetryTransport.close(() => {
        this.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (this.admission.kind === 'fleet-principal') {
      void this.handleFleetRequest(req, res);
      return;
    }
    this.dispatchRequest(req, res, this.token);
  }

  private dispatchRequest(
    req: IncomingMessage,
    res: ServerResponse,
    token: string | undefined,
  ): void {
    handleAdminRequest(req, res, {
      token,
      checkAuth: (request, response) => this.checkAuth(request, response),
      isGardenUiEnabled: () => this.transport.isGardenUiEnabled(),
      serveGardenBuildAsset: (path, request, response) => this.transport.serveGardenBuildAsset(path, request, response),
      serveGardenPage: (path, request, response) => this.transport.serveGardenPage(path, request, response),
      route: (method, path, request, response) => this.route(method, path, request, response),
      sendNotFound: (path, response) => this.send404(response, path),
      onRequestError: (path, err) => log.error('Request error', { path, error: String(err) }),
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.admission.kind === 'fleet-principal') {
      void this.handleFleetUpgrade(req, socket, head);
      return;
    }
    this.telemetryTransport.handleUpgrade(req, socket, head);
  }

  private async handleFleetRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer | null;
    try {
      body = await readFleetGardenBody(req, res, {
        maxBytes: ADMIN_MAX_BODY_SIZE,
        logger: log,
      });
    } catch (error) {
      this.send500('Fleet Garden request body read error', error, res);
      return;
    }
    if (body === null) return;
    const admitted = await admitFleetGardenRequest({
      admission: this.admission as Extract<GardenAdmissionMode, { kind: 'fleet-principal' }>,
      rawTarget: req.url ?? '/',
      method: req.method ?? 'GET',
      headers: req.headers,
      body,
    });
    if (admitted.decision === 'deny') {
      sendText(res, admitted.status, admitted.message);
      return;
    }
    this.bufferedFleetBodies.set(req, body.toString('utf8'));
    this.dispatchRequest(req, res, undefined);
  }

  private async handleFleetUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const admitted = await admitFleetGardenRequest({
      admission: this.admission as Extract<GardenAdmissionMode, { kind: 'fleet-principal' }>,
      rawTarget: req.url ?? '/',
      method: 'WS',
      headers: req.headers,
      body: Buffer.alloc(0),
    });
    if (admitted.decision === 'deny' || !admitted.verified) {
      const status = admitted.decision === 'deny' ? admitted.status : 403;
      socket.write(`HTTP/1.1 ${status} Unauthorized\r\n\r\n`);
      socket.destroy();
      return;
    }
    this.telemetryTransport.handleAuthorizedUpgrade(
      req,
      socket,
      head,
      admitted.verified.expiresAt,
    );
  }

  private route(method: string, path: string, req: IncomingMessage, res: ServerResponse): boolean {
    return dispatchAdminRoute(this.routes, method, path, req, res);
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    return checkAdminRequestAuth(req, res, this.token);
  }

  private checkUpgradeAuth(req: IncomingMessage): boolean {
    return checkAdminUpgradeAuth(req, this.token);
  }

  private send404(res: ServerResponse, path: string): void {
    sendText(res, 404, `Not found: ${path}`);
  }

  private withBody(
    req: IncomingMessage,
    res: ServerResponse,
    cb: (body: string) => void,
  ): void {
    const bufferedBody = this.bufferedFleetBodies.get(req);
    if (bufferedBody !== undefined) {
      this.bufferedFleetBodies.delete(req);
      cb(bufferedBody);
      return;
    }
    readBodyWithLimit(req, res, {
      maxBytes: ADMIN_MAX_BODY_SIZE,
      logger: log,
    }).then(
      (body) => {
        if (body === null) return;
        cb(body);
      },
      (err) => this.send500('Request body read error', err, res),
    );
  }

  private send500(context: string, err: unknown, res: ServerResponse): void {
    log.error(context, { error: toErrorMessage(err) });
    if (res.writableEnded || res.destroyed) return;
    sendText(res, 500, 'Internal Server Error');
  }
}
