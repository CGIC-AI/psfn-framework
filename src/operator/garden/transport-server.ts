import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import type { Lifecycle } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { readBodyWithLimit, sendJson, sendText } from '../../channels/backplane/http/primitives.js';
import type { AdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type { GardenAdminDomainServices } from './admin-contract.js';
import { AdminServerTelemetryTransport } from './server-telemetry-transport.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { HEALTH_PROBE_PATH } from './transport-client.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from './types.js';

const log = createComponentLogger('GardenAdminTransport');
const ADMIN_MAX_BODY_SIZE = 65_536;

export interface GardenAdminTransportServerConfig {
  socketPath: string;
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
  private readonly server: Server;
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
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async init(): Promise<void> {
    this.prepareSocketPath();
  }

  async start(): Promise<void> {
    return await new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        log.error('Garden admin transport failed to start', {
          socketPath: this.config.socketPath,
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          error: error.message,
        });
        reject(error);
      };

      this.server.once('error', onError);
      this.server.listen(this.config.socketPath, () => {
        this.server.off('error', onError);
        chmodSync(this.config.socketPath, 0o600);
        log.info('Garden admin transport listening', {
          socketPath: this.config.socketPath,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return await new Promise((resolve, reject) => {
      this.server.closeAllConnections();
      this.telemetryTransport.close(() => {
        this.server.close((error) => {
          try {
            this.cleanupSocketPath();
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

  private prepareSocketPath(): void {
    mkdirSync(dirname(this.config.socketPath), { recursive: true });
    if (!existsSync(this.config.socketPath)) {
      return;
    }

    const stats = lstatSync(this.config.socketPath);
    if (!stats.isSocket()) {
      throw new Error(
        `Refusing to replace non-socket admin transport path: ${this.config.socketPath}`,
      );
    }
    rmSync(this.config.socketPath, { force: true });
  }

  private cleanupSocketPath(): void {
    if (!existsSync(this.config.socketPath)) {
      return;
    }
    const stats = lstatSync(this.config.socketPath);
    if (!stats.isSocket()) {
      return;
    }
    rmSync(this.config.socketPath, { force: true });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname;

    if ((req.method ?? 'GET') === 'GET' && requestPath === HEALTH_PROBE_PATH) {
      sendJson(res, 200, { status: 'ok' });
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
