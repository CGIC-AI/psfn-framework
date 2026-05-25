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
import { sendJson, sendRedirect } from '../../channels/backplane/http/primitives.js';
import { sendGardenLoginPage } from './auth-pages.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from './types.js';

export interface AdminRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

interface AdminRouteDependencies {
  token?: string;
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

export function buildAdminRoutes(deps: AdminRouteDependencies): AdminRoute[] {
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
    deps.services.auditHistory.appendGardenEntry({
      actionType,
      decision,
      narrative,
      ...(joinedDetails ? { details: joinedDetails } : {}),
      ...(actor ? { actor } : {}),
    });
  };

  return [
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
          if (token === deps.token) {
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
    {
      method: 'GET',
      match: exactPath('/health'),
      handle: (_req, res) => {
        sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
      },
    },
    ...buildAdminApiRoutes({
      dashboardService: deps.services.dashboard,
      imagesService: deps.services.images,
      auditHistoryService: deps.services.auditHistory,
      chargeLedgerService: deps.services.charges,
      actionPipeService: deps.services.actionPipe,
      shardFoldReviewService: deps.services.shards,
      adaptiveToolsService: deps.services.adaptiveTools,
      episodicMemoryService: deps.services.episodicMemory,
      memoryService: deps.services.memory,
      sessionService: deps.services.sessions,
      contactsService: deps.services.contacts,
      settingsService: deps.services.settings,
      identityService: deps.services.identity,
      promptsService: deps.services.prompts,
      scheduler: deps.services.scheduler,
      skillsRuntime: deps.services.skills,
      confirmationQueueApi: deps.services.confirmations,
      valuesJournal: deps.services.values,
      config: deps.config,
      modelDiscovery: deps.services.modelDiscovery,
      chatBootstrapService: deps.services.chatBootstrap,
      withBody: deps.withBody,
      appendAuditTimelineEntry,
    }),
  ];
}
