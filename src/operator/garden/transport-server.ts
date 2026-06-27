import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer, type ServerOptions as HttpsServerOptions } from 'node:https';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import type { Lifecycle } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  requireMtlsPeerFileConfig,
  verifyPeerCertificateSpiffeUri,
} from '../../shared/net/mtls.js';
import { readBodyWithLimit, sendJson, sendText } from '../../channels/backplane/http/primitives.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type { GardenAdminDomainServices } from './admin-contract.js';
import { AdminServerTelemetryTransport } from './server-telemetry-transport.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { HEALTH_PROBE_PATH } from './transport-client.js';
import type { GardenAdminTransportServerEndpoint } from './transport-paths.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from './types.js';

const log = createComponentLogger('GardenAdminTransport');
const ADMIN_MAX_BODY_SIZE = 65_536;

export interface GardenAdminTransportServerConfig {
  endpoint: GardenAdminTransportServerEndpoint;
  eventBus: EventBus;
  config: SubstrateConfig;
  services: GardenAdminDomainServices;
}

function dispatchAdminApiRoute(
  routes: readonly AdminApiRoute[],
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = route.match(path);
    if (!params) continue;
    route.handle(req, res, params);
    return true;
  }
  return false;
}

export class GardenAdminTransportServer implements Lifecycle {
  private readonly server: HttpServer | HttpsServer;
  private readonly routes: AdminApiRoute[];
  private readonly telemetryTransport: AdminServerTelemetryTransport;

  constructor(
    private readonly config: GardenAdminTransportServerConfig,
  ) {
    const appendAuditTimelineEntry = (
      actionType: AdminAuditActionType,
      decision: AdminAuditDecision,
      narrative: string,
      details?: Array<string | null | undefined>,
      actor?: AdminAuditActor,
    ): void => {
      const joinedDetails = details
        ?.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0)
        .join(' ');
      this.config.services.auditHistory.appendGardenEntry({
        actionType,
        decision,
        narrative,
        ...(joinedDetails ? { details: joinedDetails } : {}),
        ...(actor ? { actor } : {}),
      });
    };
    this.routes = buildAdminApiRoutes({
      config: config.config,
      dashboardService: config.services.dashboard,
      imagesService: config.services.images,
      auditHistoryService: config.services.auditHistory,
      chargeLedgerService: config.services.charges,
      modelUsageService: config.services.modelUsage,
      observerEvalSidecarService: config.services.observerEvalSidecar,
      actionPipeService: config.services.actionPipe,
      shardFoldReviewService: config.services.shards,
      adaptiveToolsService: config.services.adaptiveTools,
      episodicMemoryService: config.services.episodicMemory,
      memoryService: config.services.memory,
      sessionService: config.services.sessions,
      contactsService: config.services.contacts,
      settingsService: config.services.settings,
      identityService: config.services.identity,
      promptsService: config.services.prompts,
      modelDiscovery: config.services.modelDiscovery,
      chatBootstrapService: config.services.chatBootstrap,
      scheduler: config.services.scheduler,
      skillsRuntime: config.services.skills,
      confirmationQueueApi: config.services.confirmations,
      valuesJournal: config.services.values,
      withBody: (req, res, cb) => this.withBody(req, res, cb),
      appendAuditTimelineEntry,
    });
    this.telemetryTransport = new AdminServerTelemetryTransport(
      config.eventBus,
      () => true,
    );
    const requestHandler = (req: IncomingMessage, res: ServerResponse) => this.handleRequest(req, res);
    this.server = this.createHttpServer(requestHandler);
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async init(): Promise<void> {
    if (this.config.endpoint.mode === 'socket') {
      this.prepareSocketPath(this.config.endpoint.socketPath);
    }
  }

  async start(): Promise<void> {
    return await new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        log.error('Garden admin transport failed to start', {
          endpoint: this.describeEndpoint(),
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          error: error.message,
        });
        reject(error);
      };

      this.server.once('error', onError);
      const onListening = () => {
        this.server.off('error', onError);
        if (this.config.endpoint.mode === 'socket') {
          chmodSync(this.config.endpoint.socketPath, 0o600);
        }
        log.info('Garden admin transport listening', {
          endpoint: this.describeEndpoint(),
        });
        resolve();
      };

      if (this.config.endpoint.mode === 'socket') {
        this.server.listen(this.config.endpoint.socketPath, onListening);
        return;
      }

      this.server.listen(this.config.endpoint.port, this.config.endpoint.host, onListening);
    });
  }

  async stop(): Promise<void> {
    return await new Promise((resolve, reject) => {
      this.server.closeAllConnections();
      this.telemetryTransport.close(() => {
        this.server.close((error) => {
          try {
            if (this.config.endpoint.mode === 'socket') {
              this.cleanupSocketPath(this.config.endpoint.socketPath);
            }
          } catch (cleanupError) {
            reject(cleanupError);
            return;
          }

          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    });
  }

  describeEndpoint(): Record<string, string | number> {
    if (this.config.endpoint.mode === 'socket') {
      return {
        mode: 'socket',
        socketPath: this.config.endpoint.socketPath,
      };
    }

    return {
      mode: 'network',
      scheme: this.config.endpoint.scheme,
      host: this.config.endpoint.host,
      port: this.config.endpoint.port,
    };
  }

  private prepareSocketPath(socketPath: string): void {
    mkdirSync(dirname(socketPath), { recursive: true });
    if (!existsSync(socketPath)) {
      return;
    }

    const stats = lstatSync(socketPath);
    if (!stats.isSocket()) {
      throw new Error(
        `Refusing to replace non-socket admin transport path: ${socketPath}`,
      );
    }
    rmSync(socketPath, { force: true });
  }

  private cleanupSocketPath(socketPath: string): void {
    if (!existsSync(socketPath)) {
      return;
    }
    const stats = lstatSync(socketPath);
    if (!stats.isSocket()) {
      return;
    }
    rmSync(socketPath, { force: true });
  }

  private createHttpServer(
    requestHandler: (req: IncomingMessage, res: ServerResponse) => void,
  ): HttpServer | HttpsServer {
    if (this.config.endpoint.mode === 'socket') {
      return createHttpServer(requestHandler);
    }
    const peerAuthMode: string = this.config.endpoint.peerAuthMode;
    const scheme: string = this.config.endpoint.scheme;
    if (peerAuthMode !== 'mtls-spiffe' || scheme !== 'https') {
      throw new Error('Garden admin network transport requires HTTPS mTLS with SPIFFE peer authorization');
    }
    return createHttpsServer(
      this.loadNetworkTlsOptions(),
      requestHandler,
    );
  }

  private loadNetworkTlsOptions(): HttpsServerOptions {
    if (this.config.endpoint.mode !== 'network') {
      throw new Error('Garden admin transport TLS options require network mode');
    }
    const tlsConfig = requireMtlsPeerFileConfig(
      this.config.endpoint.tls,
      'Garden admin transport server TLS',
    );
    return {
      ca: readFileSync(tlsConfig.caPath),
      cert: readFileSync(tlsConfig.certPath),
      key: readFileSync(tlsConfig.keyPath),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    };
  }

  private authorizePeer(req: IncomingMessage): string | null {
    if (this.config.endpoint.mode !== 'network') {
      return null;
    }
    const tlsSocket = req.socket as TLSSocket;
    if (!tlsSocket.authorized) {
      const authorizationError = tlsSocket.authorizationError;
      return authorizationError instanceof Error
        ? `peer TLS certificate is not authorized: ${authorizationError.message}`
        : 'peer TLS certificate is not authorized';
    }
    const peerCertificate = tlsSocket.getPeerCertificate();
    if (Object.keys(peerCertificate).length === 0) {
      return 'peer TLS certificate is missing';
    }
    return verifyPeerCertificateSpiffeUri(
      peerCertificate,
      this.config.endpoint.tls.expectedPeerSpiffeUri,
    );
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const rejectionReason = this.authorizePeer(req);
    if (rejectionReason) {
      log.warn('Rejected Garden admin transport peer', { reason: rejectionReason });
      sendText(res, 403, 'Forbidden');
      return;
    }

    const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname;

    if ((req.method ?? 'GET') === 'GET' && requestPath === HEALTH_PROBE_PATH) {
      sendJson(res, 200, { status: 'ok', mode: this.config.endpoint.mode });
      return;
    }

    try {
      const handled = dispatchAdminApiRoute(
        this.routes,
        req.method ?? 'GET',
        requestPath,
        req,
        res,
      );
      if (handled) return;
    } catch (error) {
      log.error('Garden admin transport request failed', {
        path: requestPath,
        error: toErrorMessage(error),
      });
      if (!res.writableEnded && !res.destroyed) {
        sendText(res, 500, 'Internal Server Error');
      }
      return;
    }

    sendText(res, 404, `Not found: ${requestPath}`);
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const rejectionReason = this.authorizePeer(req);
    if (rejectionReason) {
      log.warn('Rejected Garden admin transport websocket peer', { reason: rejectionReason });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    this.telemetryTransport.handleUpgrade(req, socket, head);
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
        log.error('Garden admin transport body read failed', {
          error: toErrorMessage(error),
        });
        if (res.writableEnded || res.destroyed) return;
        sendText(res, 500, 'Internal Server Error');
      },
    );
  }
}
