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
import { bindRequestForResponse, readBodyWithLimit, sendJson, sendText } from '../../channels/backplane/http/primitives.js';
import type { AuthorizedAdminApiRoute } from './api-routes.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type { GardenAdminDomainServices } from './admin-contract.js';
import { AdminServerTelemetryTransport } from './server-telemetry-transport.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  FLEET_MODEL_USAGE_INTERNAL_HEADER,
  FLEET_MODEL_USAGE_PARENT_COMPANION_HEADER,
  FLEET_MODEL_USAGE_PARENT_TARGET_HEADER,
  HEALTH_PROBE_PATH,
  isFleetModelUsageInternalRequestTarget,
} from './transport-client.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { GardenAdminTransportServerEndpoint } from './transport-paths.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from './types.js';
import { assertGardenRouteDeclarationsCovered } from '../../boundary/fleet-auth/garden-route-capabilities.js';
import {
  GardenRequestTargetError,
  parseCanonicalGardenRequestPath,
  validateGardenRequestMetadata,
} from '../../boundary/fleet-auth/request-capability-target.js';
import {
  admitFleetGardenRequest,
  readFleetGardenBody,
  resolveGardenAdmissionMode,
  stripFleetCallerAuthority,
  type GardenAdmissionMode,
} from './garden-admission.js';
import {
  createFleetGardenRequestContext,
  createLegacyGardenRequestContext,
  gardenRequestServiceBoundaryDenial,
  type GardenRequestContext,
} from './garden-request-context.js';

const log = createComponentLogger('GardenAdminTransport');
const ADMIN_MAX_BODY_SIZE = 65_536;

export interface GardenAdminTransportServerConfig {
  endpoint: GardenAdminTransportServerEndpoint;
  eventBus: EventBus;
  config: SubstrateConfig;
  services: GardenAdminDomainServices;
}

function dispatchAdminApiRoute(
  routes: readonly AuthorizedAdminApiRoute[],
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  context: GardenRequestContext | undefined,
  companionId: string | undefined,
): boolean {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = route.match(path);
    if (!params) continue;
    bindRequestForResponse(res, req);
    const requestContext = context ?? createLegacyGardenRequestContext({
      authorization: route.capability.authorization,
      routeId: route.capability.id,
      ...(companionId ? { companionId } : {}),
      pathParams: params,
      query: validateGardenRequestMetadata({
        rawTarget: req.url ?? '/',
        method: req.method ?? method,
        headers: req.headers,
      }).query,
    });
    const boundaryDenial = gardenRequestServiceBoundaryDenial(requestContext);
    if (boundaryDenial) {
      sendJson(res, 403, { error: boundaryDenial });
      return true;
    }
    route.handle(req, res, params, requestContext);
    return true;
  }
  return false;
}

export class GardenAdminTransportServer implements Lifecycle {
  private readonly server: HttpServer | HttpsServer;
  private readonly routes: AuthorizedAdminApiRoute[];
  private readonly telemetryTransport: AdminServerTelemetryTransport;
  private readonly admission: GardenAdmissionMode;
  private readonly bufferedFleetBodies = new WeakMap<IncomingMessage, string>();
  private readonly companionId?: string;
  private serverClosePromise: Promise<void> | null = null;

  constructor(
    private readonly config: GardenAdminTransportServerConfig,
  ) {
    const modeSelection = {
      fleetAuthVerifier: config.config.fleetAuthVerifier,
      companionId: config.config.companionId,
      audience: 'agent' as const,
    };
    this.admission = resolveGardenAdmissionMode(modeSelection);
    this.companionId = config.config.companionId;
    const appendAuditTimelineEntry = (
      actionType: AdminAuditActionType,
      decision: AdminAuditDecision,
      narrative: string,
      details?: Array<string | null | undefined>,
      actor?: AdminAuditActor,
      context?: GardenRequestContext,
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
        ...(context ? { requestContext: context } : {}),
      });
    };
    this.routes = buildAdminApiRoutes({
      config: config.config,
      dashboardService: config.services.dashboard,
      imagesService: config.services.images,
      auditHistoryService: config.services.auditHistory,
      chargeLedgerService: config.services.charges,
      chargeCostReconciliationService: config.services.chargeCosts,
      modelUsageService: config.services.modelUsage,
      observerEvalSidecarService: config.services.observerEvalSidecar,
      actionPipeService: config.services.actionPipe,
      shardFoldReviewService: config.services.shards,
      adaptiveToolsService: config.services.adaptiveTools,
      wikiService: config.services.wiki,
      wishlistService: config.services.wishlist,
      episodicMemoryService: config.services.episodicMemory,
      groupMemoryService: config.services.groupMemory,
      memoryService: config.services.memory,
      privacyBreakGlassService: config.services.privacyBreakGlass,
      sessionService: config.services.sessions,
      contactsService: config.services.contacts,
      pendingContactsService: config.services.pendingContacts ?? null,
      roomsService: config.services.rooms ?? null,
      placesService: config.services.places ?? null,
      enrollmentService: config.services.enrollment ?? null,
      graphProposalsService: config.services.graphProposals ?? null,
      concernService: config.services.concerns,
      subsystemHealthService: config.services.subsystemHealth ?? null,
      partnerAffectShadowService: config.services.partnerAffectShadow ?? null,
      toolConformanceService: config.services.toolConformance ?? null,
      icpAutonomyService: config.services.icpAutonomy ?? null,
      roomArbiterService: config.services.roomArbiter ?? null,
      diagnosticsService: config.services.diagnostics,
      settingsService: config.services.settings,
      sharedWorkspaceService: config.services.sharedWorkspace ?? null,
      intakeQuarantineService: config.services.intakeQuarantine,
      driftReviewService: config.services.driftReviews,
      identityService: config.services.identity,
      promptsService: config.services.prompts,
      modelDiscovery: config.services.modelDiscovery,
      chatBootstrapService: config.services.chatBootstrap,
      scheduler: config.services.scheduler,
      skillsRuntime: config.services.skills,
      confirmationQueueApi: config.services.confirmations,
      valuesJournal: config.services.values,
      reflectionMetacognitionJournal: config.services.reflectionMetacognitionJournal,
      reflectionDailyJournal: config.services.reflectionDailyJournal,
      reflectionJournal: config.services.reflectionJournal,
      withBody: (req, res, cb) => this.withBody(req, res, cb),
      appendAuditTimelineEntry,
    });
    assertGardenRouteDeclarationsCovered(this.routes);
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
    this.config.services.ownerFileReloadWatcher?.close();
    await this.config.services.icpAutonomy?.close?.();
    await this.config.services.roomArbiter?.close?.();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.telemetryTransport.close(resolve);
    });
    await this.beginServerClose();
    if (this.config.endpoint.mode === 'socket') {
      this.cleanupSocketPath(this.config.endpoint.socketPath);
    }
  }

  /**
   * Stop accepting new admin transport connections immediately.
   *
   * Kubernetes readiness probes use this listener in both single-agent and
   * fleet deployments. Withdrawing the listener makes a disconnected agent
   * NotReady before slower database/background cleanup finishes. `stop()`
   * reuses the same close promise, so the normal shutdown sequence remains
   * responsible for draining active connections and cleaning up socket state.
   */
  withdrawReadiness(): void {
    if (this.serverClosePromise) return;
    log.warn('Withdrawing Garden admin transport readiness', {
      endpoint: this.describeEndpoint(),
    });
    void this.beginServerClose().catch((error: unknown) => {
      log.error('Garden admin transport readiness withdrawal failed', {
        endpoint: this.describeEndpoint(),
        error: toErrorMessage(error),
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

  private beginServerClose(): Promise<void> {
    if (this.serverClosePromise) return this.serverClosePromise;
    this.serverClosePromise = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return this.serverClosePromise;
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

    let requestPath: string;
    try {
      requestPath = parseCanonicalGardenRequestPath(req.url ?? '/').canonicalPath;
    } catch {
      sendText(res, 400, 'Invalid request target');
      return;
    }

    if ((req.method ?? 'GET') === 'GET' && requestPath === HEALTH_PROBE_PATH) {
      sendJson(res, 200, { status: 'ok', mode: this.config.endpoint.mode });
      return;
    }

    const internalFleetModelUsage = req.headers[FLEET_MODEL_USAGE_INTERNAL_HEADER];
    if (internalFleetModelUsage !== undefined) {
      void this.handleFleetModelUsageRead(
        req,
        res,
        requestPath,
        req.url ?? '',
        internalFleetModelUsage,
      );
      return;
    }

    if (this.admission.kind === 'fleet-principal') {
      void this.handleFleetRequest(req, res);
      return;
    }

    this.dispatchRequest(req, res, requestPath);
  }

  private async handleFleetModelUsageRead(
    req: IncomingMessage,
    res: ServerResponse,
    requestPath: string,
    requestTarget: string,
    marker: string | string[],
  ): Promise<void> {
    const parentCompanion = req.headers[FLEET_MODEL_USAGE_PARENT_COMPANION_HEADER];
    const parentTarget = req.headers[FLEET_MODEL_USAGE_PARENT_TARGET_HEADER];
    delete req.headers[FLEET_MODEL_USAGE_INTERNAL_HEADER];
    delete req.headers[FLEET_MODEL_USAGE_PARENT_COMPANION_HEADER];
    delete req.headers[FLEET_MODEL_USAGE_PARENT_TARGET_HEADER];
    if (this.admission.kind !== 'fleet-principal'
      || marker !== '1'
      || typeof parentCompanion !== 'string'
      || typeof parentTarget !== 'string'
      || req.method !== 'GET'
      || requestPath !== '/api/admin/model-usage'
      || !isFleetModelUsageInternalRequestTarget(requestTarget)
      || !this.companionId) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    let admitted: Awaited<ReturnType<typeof admitFleetGardenRequest>>;
    try {
      admitted = await admitFleetGardenRequest({
        admission: {
          ...this.admission,
          audience: 'operator',
          companionId: createCompanionId(parentCompanion),
        },
        rawTarget: parentTarget,
        method: 'GET',
        headers: req.headers,
        body: Buffer.alloc(0),
      });
    } catch {
      sendText(res, 403, 'Forbidden');
      return;
    }
    const authorizedCompanionIds = admitted.decision === 'allow'
      ? admitted.verified?.authContext.fleetCompanionIds
      : undefined;
    const authorizedRequestTarget = admitted.decision === 'allow'
      ? admitted.verified?.authContext.fleetModelUsageRequestTarget
      : undefined;
    if (admitted.decision !== 'allow'
      || admitted.target.canonicalPath !== '/api/admin/fleet-model-usage'
      || admitted.target.method !== 'GET'
      || admitted.target.action !== 'models.read'
      || !authorizedCompanionIds?.includes(this.companionId)
      || authorizedRequestTarget !== requestTarget) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    stripFleetCallerAuthority(req.headers);
    // The gateway-signed roster and exact child target authorize this read for
    // the bound companion without granting an arbitrary aggregate time slice.
    // Dispatch still uses the canonical per-companion model-usage service,
    // preserving its aggregate/private-detail combination.
    this.dispatchRequest(req, res, requestPath);
  }

  private dispatchRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedPath?: string,
    context?: GardenRequestContext,
  ): void {
    let requestPath = parsedPath ?? '/';

    try {
      requestPath = validateGardenRequestMetadata({
        rawTarget: req.url ?? '/',
        method: req.method ?? 'GET',
        headers: req.headers,
      }).canonicalPath;
    } catch (error) {
      if (error instanceof GardenRequestTargetError && error.code === 'authority_forbidden') {
        sendJson(res, 403, { error: 'Cross-tenant authority selector is forbidden' });
      } else if (error instanceof GardenRequestTargetError && error.code === 'route_not_declared') {
        sendText(res, 404, `Not found: ${requestPath}`);
      } else {
        sendText(res, 400, 'Invalid request target');
      }
      return;
    }

    try {
      const handled = dispatchAdminApiRoute(
        this.routes,
        req.method ?? 'GET',
        requestPath,
        req,
        res,
        context,
        this.companionId,
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

  private async handleFleetRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer | null;
    try {
      body = await readFleetGardenBody(req, res, {
        maxBytes: ADMIN_MAX_BODY_SIZE,
        logger: log,
      });
    } catch (error) {
      log.error('Fleet Garden transport body read failed', { error: toErrorMessage(error) });
      if (!res.writableEnded && !res.destroyed) sendText(res, 500, 'Internal Server Error');
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
    if (admitted.decision === 'deny' || !admitted.verified) {
      const status = admitted.decision === 'deny' ? admitted.status : 403;
      const message = admitted.decision === 'deny' ? admitted.message : 'Invalid Fleet Garden capability';
      sendText(res, status, message);
      return;
    }
    this.bufferedFleetBodies.set(req, body.toString('utf8'));
    const context = createFleetGardenRequestContext({
      target: admitted.target,
      verified: admitted.verified,
    });
    this.dispatchRequest(req, res, admitted.target.canonicalPath, context);
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const rejectionReason = this.authorizePeer(req);
    if (rejectionReason) {
      log.warn('Rejected Garden admin transport websocket peer', { reason: rejectionReason });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (this.admission.kind === 'fleet-principal') {
      void this.handleFleetUpgrade(req, socket, head);
      return;
    }
    this.telemetryTransport.handleUpgrade(req, socket, head);
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
