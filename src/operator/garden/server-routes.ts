import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildAdminApiRoutes } from './api-routes.js';
import type { GardenAdminDomainServices } from './admin-contract.js';
import {
  exactPath,
  type RouteMatcher,
  type RouteParams,
} from './route-matchers.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { GARDEN_PREFIX } from './server-request-routing.js';
import { bindRequestForResponse, sendJson, sendRedirect } from '../../channels/backplane/http/primitives.js';
import { sendGardenLoginPage } from './auth-pages.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from './types.js';
import {
  assertGardenRouteDeclarationsCovered,
  compileGardenRouteDeclarations,
  type AuthorizedGardenRoute,
} from '../../boundary/fleet-auth/garden-route-capabilities.js';
import { validateGardenRequestMetadata } from '../../boundary/fleet-auth/request-capability-target.js';
import {
  createStandaloneGardenRequestContext,
  type GardenRequestContext,
} from './garden-request-context.js';
import { gardenRequestCompanionScopeDenial } from './garden-companion-scope.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  denyFleetGardenServiceBoundary,
  getGardenDenialsLastHour,
} from './garden-denial-observability.js';

const log = createComponentLogger('GardenAdminRoutes');

interface AdminRouteDeclaration {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    params: RouteParams,
    context: GardenRequestContext,
  ) => void;
}

export type AdminRoute = AuthorizedGardenRoute<AdminRouteDeclaration>;

interface AdminRouteDependencies {
  token?: string;
  standaloneSessionRoutes: boolean;
  services: GardenAdminDomainServices;
  config: SubstrateConfig;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}

export function dispatchAdminRoute(
  routes: AdminRoute[],
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  context?: GardenRequestContext,
  companionId?: string,
): boolean {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = route.match(path);
    if (!params) continue;
    bindRequestForResponse(res, req);
    const requestContext = context ?? createStandaloneGardenRequestContext({
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
    if (denyFleetGardenServiceBoundary(res, log, requestContext)) return true;
    // Invariant 11 (docs/garden-control-plane.md): the companion whose direct-DB
    // service instances handle this route is `companionId` (the connection-bound
    // companion whose stores were captured at construction). Refuse to run any
    // companion-scoped route unless the authenticated request context names that
    // same companion, so a request for companion A can never touch companion B's
    // schema, rows, or writes. Fails closed; standalone/public contexts are exempt.
    const companionScopeDenial = gardenRequestCompanionScopeDenial(requestContext, companionId);
    if (companionScopeDenial) {
      sendJson(res, 403, { error: companionScopeDenial });
      return true;
    }
    route.handle(req, res, params, requestContext);
    return true;
  }
  return false;
}

export function buildAdminRoutes(deps: AdminRouteDependencies): AdminRoute[] {
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
    deps.services.auditHistory.appendGardenEntry({
      actionType,
      decision,
      narrative,
      ...(joinedDetails ? { details: joinedDetails } : {}),
      ...(actor ? { actor } : {}),
      ...(context ? { requestContext: context } : {}),
    });
  };

  const standaloneSessionRoutes: AdminRouteDeclaration[] = deps.standaloneSessionRoutes ? [
    {
      method: 'GET',
      match: exactPath('/login'),
      handle: (_req, res) => {
        sendGardenLoginPage(res, deps.config);
      },
    },
    {
      method: 'POST',
      match: exactPath('/login'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          if (!deps.token) {
            sendGardenLoginPage(
              res,
              deps.config,
              'Login is unavailable when ADMIN_TOKEN is unset.',
              503,
            );
            return;
          }
          const params = new URLSearchParams(body);
          const token = params.get('token') ?? '';
          if (timingSafeStringEqual(token, deps.token)) {
            const encodedToken = encodeURIComponent(token);
            sendRedirect(res, GARDEN_PREFIX, 302, {
              'Set-Cookie': `psfn_token=${encodedToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
            });
            return;
          }
          sendGardenLoginPage(res, deps.config, 'Invalid token');
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/logout'),
      handle: (_req, res) => {
        sendJson(
          res,
          200,
          { ok: true },
          {
            'Set-Cookie': 'psfn_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
          },
        );
      },
    },
  ] : [];
  const routes = compileGardenRouteDeclarations([
    ...standaloneSessionRoutes,
    {
      method: 'GET',
      match: exactPath('/health'),
      handle: (_req, res) => {
        sendJson(res, 200, {
          status: 'ok',
          uptime: process.uptime(),
          gardenDenialsLastHour: getGardenDenialsLastHour(),
        });
      },
    },
    ...buildAdminApiRoutes({
      automataService: deps.services.automata,
      dashboardService: deps.services.dashboard,
      diagnosticsService: deps.services.diagnostics,
      imagesService: deps.services.images,
      auditHistoryService: deps.services.auditHistory,
      chargeLedgerService: deps.services.charges,
      chargeCostReconciliationService: deps.services.chargeCosts,
      modelUsageService: deps.services.modelUsage,
      observerEvalSidecarService: deps.services.observerEvalSidecar,
      actionPipeService: deps.services.actionPipe,
      shardFoldReviewService: deps.services.shards,
      adaptiveToolsService: deps.services.adaptiveTools,
      wikiService: deps.services.wiki,
      wishlistService: deps.services.wishlist,
      letterService: deps.services.letters,
      doingMirrorService: deps.services.doingMirror,
      episodicMemoryService: deps.services.episodicMemory,
      groupMemoryService: deps.services.groupMemory,
      memoryService: deps.services.memory,
      privacyBreakGlassService: deps.services.privacyBreakGlass,
      sessionService: deps.services.sessions,
      contactsService: deps.services.contacts,
      pendingContactsService: deps.services.pendingContacts ?? null,
      roomsService: deps.services.rooms ?? null,
      placesService: deps.services.places ?? null,
      enrollmentService: deps.services.enrollment ?? null,
      graphProposalsService: deps.services.graphProposals ?? null,
      concernService: deps.services.concerns,
      subjectAuditService: deps.services.subjectAudit,
      subsystemHealthService: deps.services.subsystemHealth ?? null,
      partnerAffectShadowService: deps.services.partnerAffectShadow ?? null,
      toolConformanceService: deps.services.toolConformance ?? null,
      settingsService: deps.services.settings,
      sharedWorkspaceService: deps.services.sharedWorkspace ?? null,
      intakeQuarantineService: deps.services.intakeQuarantine,
      driftReviewService: deps.services.driftReviews,
      identityService: deps.services.identity,
      promptsService: deps.services.prompts,
      scheduler: deps.services.scheduler,
      skillsRuntime: deps.services.skills,
      confirmationQueueApi: deps.services.confirmations,
      valuesJournal: deps.services.values,
      reflectionMetacognitionJournal: deps.services.reflectionMetacognitionJournal,
      reflectionDailyJournal: deps.services.reflectionDailyJournal,
      reflectionJournal: deps.services.reflectionJournal,
      config: deps.config,
      modelDiscovery: deps.services.modelDiscovery,
      chatBootstrapService: deps.services.chatBootstrap,
      withBody: deps.withBody,
      appendAuditTimelineEntry,
    }),
  ] satisfies AdminRouteDeclaration[]);
  assertGardenRouteDeclarationsCovered(routes);
  return routes;
}
