// ── Admin GUI Server ──
// Serves the garden-themed management interface on ADMIN_PORT.
// Uses htmx for interactivity — server returns HTML fragments.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Lifecycle } from '../../types.js';
import type { ContactStore } from '../../contacts/store.js';
import type { PromptLayerStore } from '../../identity/prompt-store.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import type { EventBus } from '../../event-bus.js';
import { resolveCompanionNameFromConfig } from '../../identity/companion-runtime.js';
import { createComponentLogger } from '../../logger.js';
import { toErrorMessage } from '../../utils/errors.js';
import { readBodyWithLimit, sendHtml, sendText } from '../http/primitives.js';
import { ValuesJournalStore } from '../../values/store.js';
import {
  resolveConfiguredCompanionDataDir,
  resolveLegacyValuesJournalPath,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';
import type { AdminServerConfig } from './types.js';
import { AdminHandlers } from './handlers.js';
import { AdminDashboardDataService } from './services/dashboard-service.js';
import { AdminMemoryDataService } from './services/memory-service.js';
import { AdminSessionDataService } from './services/session-service.js';
import { AdminContactsDataService } from './services/contacts-service.js';
import { AdminSettingsDataService } from './services/settings-service.js';
import { AdminIdentityDataService } from './services/identity-service.js';
import { AdminPromptsDataService } from './services/prompts-service.js';
import { AdminSchedulerService } from './services/scheduler-service.js';
import { AdminAdaptiveToolsDataService } from './services/adaptive-tools-service.js';
import { buildAdminRoutes, dispatchAdminRoute, type AdminRoute } from './server-routes.js';
import { checkAdminRequestAuth, checkAdminUpgradeAuth, hasAdminRequestAuthCredentials } from './server-auth.js';
import { handleAdminRequest } from './server-request-routing.js';
import { AdminServerTransport } from './server-transport.js';
import { AdminServerTelemetryTransport } from './server-telemetry-transport.js';

const log = createComponentLogger('AdminServer');
const ADMIN_MAX_BODY_SIZE = 65_536; // 64KB

export class AdminServer implements Lifecycle {
  private server: Server;
  private port: number;
  private host: string;
  private token?: string;
  private allowInsecureWithoutToken: boolean;
  private eventBus: EventBus;
  private handlers: AdminHandlers;
  private dashboardService: AdminDashboardDataService;
  private memoryService: AdminMemoryDataService;
  private sessionService: AdminSessionDataService;
  private contactsService: AdminContactsDataService;
  private settingsService: AdminSettingsDataService;
  private identityService: AdminIdentityDataService;
  private promptsService: AdminPromptsDataService;
  private adaptiveToolsService: AdminAdaptiveToolsDataService;
  private valuesJournal!: ValuesJournalStore;
  private schedulerService!: AdminSchedulerService;
  private scheduler!: import('../../scheduler/scheduler.js').Scheduler;
  private skillsRuntimeRef!: import('../../skills/runtime.js').SkillsRuntime | null;
  private confirmationQueueApiRef!: import('./types.js').ConfirmationQueueAdminApi | null;
  private routes: AdminRoute[];
  private transport: AdminServerTransport;
  private telemetryTransport: AdminServerTelemetryTransport;

  constructor(config: AdminServerConfig & {
    contactStore?: ContactStore | null;
    promptStore?: PromptLayerStore | null;
    promptRegistry?: PromptRegistryStore | null;
    allowInsecureWithoutToken?: boolean;
  }) {
    this.port = config.port;
    this.host = config.host ?? '127.0.0.1';
    this.token = config.token;
    this.allowInsecureWithoutToken = config.allowInsecureWithoutToken ?? false;
    this.eventBus = config.eventBus;
    this.handlers = new AdminHandlers({
      memoryStore: config.memoryStore,
      sessionStore: config.sessionStore,
      sessionManager: config.sessionManager,
      scheduler: config.scheduler,
      shardManager: config.shardManager,
      eventBus: config.eventBus,
      embeddingService: config.embeddingService,
      characterCard: config.characterCard,
      config: config.config,
      modelDiscovery: config.modelDiscovery,
      contactStore: config.contactStore,
      promptStore: config.promptStore,
      promptRegistry: config.promptRegistry,
      cardVersionStore: config.cardVersionStore,
      skillsRuntime: config.skillsRuntime,
      confirmationQueueApi: config.confirmationQueueApi,
      apiBaseUrl: config.apiBaseUrl,
      apiHost: config.apiHost,
      apiPort: config.apiPort,
    });
    this.dashboardService = new AdminDashboardDataService({
      memoryStore: config.memoryStore,
      sessionStore: config.sessionStore,
      scheduler: config.scheduler,
      shardManager: config.shardManager,
      eventBus: config.eventBus,
    });
    this.memoryService = new AdminMemoryDataService({
      memoryStore: config.memoryStore,
      contactStore: config.contactStore,
      embeddingService: config.embeddingService,
      resolveCompanionName: () => resolveCompanionNameFromConfig(config.config),
    });
    this.sessionService = new AdminSessionDataService({
      sessionStore: config.sessionStore,
      sessionManager: config.sessionManager,
      contactStore: config.contactStore,
    });
    this.contactsService = new AdminContactsDataService({
      contactStore: config.contactStore,
      memoryStore: config.memoryStore,
      sessionStore: config.sessionStore,
    });
    this.settingsService = new AdminSettingsDataService({
      config: config.config,
    });
    this.identityService = new AdminIdentityDataService({
      characterCard: config.characterCard,
      config: config.config,
      cardVersionStore: config.cardVersionStore,
      importIdentityCardHtml: (body) => this.handlers.domains.identity.importIdentityCard(body),
      promptStore: config.promptStore,
    });
    this.promptsService = new AdminPromptsDataService({
      promptStore: config.promptStore,
      promptRegistry: config.promptRegistry,
      sessionStore: config.sessionStore,
      sessionManager: config.sessionManager,
      resolveCompanionName: () => resolveCompanionNameFromConfig(config.config),
    });
    this.adaptiveToolsService = new AdminAdaptiveToolsDataService({
      eventBus: config.eventBus,
      stateProvider: config.adaptiveToolsStateProvider ?? null,
    });
    const companionDataDir = resolveConfiguredCompanionDataDir(config.config);
    this.valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(companionDataDir), {
      legacyFilePaths: [resolveLegacyValuesJournalPath(companionDataDir)],
    });
    this.scheduler = config.scheduler;
    this.schedulerService = new AdminSchedulerService(config.scheduler, config.config.dataDir);
    this.skillsRuntimeRef = config.skillsRuntime ?? null;
    this.confirmationQueueApiRef = config.confirmationQueueApi ?? null;
    this.transport = new AdminServerTransport(log);
    this.telemetryTransport = new AdminServerTelemetryTransport(
      this.eventBus,
      (req) => this.checkUpgradeAuth(req),
    );
    this.routes = buildAdminRoutes({
      token: this.token,
      handlers: this.handlers,
      dashboardService: this.dashboardService,
      adaptiveToolsService: this.adaptiveToolsService,
      memoryService: this.memoryService,
      sessionService: this.sessionService,
      contactsService: this.contactsService,
      settingsService: this.settingsService,
      identityService: this.identityService,
      promptsService: this.promptsService,
      scheduler: this.schedulerService,
      skillsRuntime: this.skillsRuntimeRef,
      confirmationQueueApi: this.confirmationQueueApiRef,
      valuesJournal: this.valuesJournal,
      withBody: (req, res, cb) => this.withBody(req, res, cb),
      sendHtml: (res, html) => this.sendHtml(res, html),
      sendFragment: (res, html) => this.sendFragment(res, html),
      send404: (res, path) => this.send404(res, path),
      send500: (context, err, res) => this.send500(context, err, res),
      logError: (message, data) => log.error(message, data),
    });
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async init(): Promise<void> {
    this.transport.initialize();
  }

  async start(): Promise<void> {
    if (!this.token && !this.allowInsecureWithoutToken) {
      const err = new Error('ADMIN_TOKEN is required unless ADMIN_ALLOW_INSECURE=true');
      log.error('Refusing to start admin server without authentication', {
        host: this.host,
        port: this.port,
        requiredEnv: 'ADMIN_TOKEN or ADMIN_ALLOW_INSECURE=true',
      });
      throw err;
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
        if (this.token) {
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
      // Force-close any open connections (SSE streams, etc.)
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
    handleAdminRequest(req, res, {
      token: this.token,
      hasRequestAuthCredentials: (request) => this.hasRequestAuthCredentials(request),
      checkAuth: (request, response) => this.checkAuth(request, response),
      tryServeStaticAsset: (path, response) => this.transport.tryServeStaticAsset(path, response),
      isGardenUiEnabled: () => this.transport.isGardenUiEnabled(),
      serveGardenAsset: (path, response) => this.transport.serveGardenAsset(path, response),
      route: (method, path, request, response) => this.route(method, path, request, response),
      onRequestError: (path, err) => log.error('Request error', { path, error: String(err) }),
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.telemetryTransport.handleUpgrade(req, socket, head);
  }

  private route(method: string, path: string, req: IncomingMessage, res: ServerResponse): void {
    dispatchAdminRoute(this.routes, method, path, req, res, (response, unknownPath) => this.send404(response, unknownPath));
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    return checkAdminRequestAuth(req, res, this.token);
  }

  private hasRequestAuthCredentials(req: IncomingMessage): boolean {
    return hasAdminRequestAuthCredentials(req, this.token);
  }

  private checkUpgradeAuth(req: IncomingMessage): boolean {
    return checkAdminUpgradeAuth(req, this.token);
  }

  private sendHtml(res: ServerResponse, html: string): void {
    sendHtml(res, 200, html);
  }

  private sendFragment(res: ServerResponse, html: string): void {
    sendHtml(res, 200, html);
  }

  private send404(res: ServerResponse, path: string): void {
    sendText(res, 404, `Not found: ${path}`);
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
      (err) => this.send500('Request body read error', err, res),
    );
  }

  private send500(context: string, err: unknown, res: ServerResponse): void {
    log.error(context, { error: toErrorMessage(err) });
    if (res.writableEnded || res.destroyed) return;
    sendText(res, 500, 'Internal Server Error');
  }
}
