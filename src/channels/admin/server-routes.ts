import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildAdminApiRoutes, type AdminSchedulerApi, type AdminSkillsApi, type AdminValuesJournalApi } from './api-routes.js';
import {
  exactPath,
  type RouteMatcher,
  type RouteParams,
} from './route-matchers.js';
import type {
  AdminAdaptiveToolsService,
  AdminContactsService,
  AdminDashboardService,
  AdminIdentityService,
  AdminMemoryService,
  AdminPromptsService,
  AdminSessionService,
  AdminSettingsService,
} from './services/types.js';
import type { ConfirmationQueueAdminApi } from './types.js';
import { GARDEN_PREFIX } from './server-request-routing.js';
import { sendJson, sendRedirect, sendText } from '../http/primitives.js';

export interface AdminRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

interface AdminRouteDependencies {
  token?: string;
  dashboardService: AdminDashboardService;
  adaptiveToolsService: AdminAdaptiveToolsService | null;
  memoryService: AdminMemoryService;
  sessionService: AdminSessionService;
  contactsService: AdminContactsService;
  settingsService: AdminSettingsService;
  identityService: AdminIdentityService;
  promptsService: AdminPromptsService;
  scheduler: AdminSchedulerApi;
  skillsRuntime: AdminSkillsApi | null;
  confirmationQueueApi: ConfirmationQueueAdminApi | null;
  valuesJournal: AdminValuesJournalApi;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

function loginPage(error?: string): string {
  const errorBlock = error
    ? `<p style="color:#b42318;margin:0 0 12px 0">${escapeHtml(error)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Login - Purrsephone's Garden</title>
  </head>
  <body style="font-family:system-ui,sans-serif;max-width:420px;margin:5rem auto;padding:0 1rem">
    <h1 style="margin:0 0 0.5rem 0">Purrsephone's Garden</h1>
    <p style="margin:0 0 1rem 0;color:#666">Enter your admin token to continue.</p>
    ${errorBlock}
    <form method="POST" action="/login">
      <label for="token">Admin token</label><br>
      <input id="token" name="token" type="password" autocomplete="current-password" style="margin-top:0.5rem;width:100%;padding:0.5rem">
      <button type="submit" style="margin-top:1rem;padding:0.5rem 1rem">Sign in</button>
    </form>
  </body>
</html>`;
}

function sendLoginPage(res: ServerResponse, error?: string, status: number = 200): void {
  sendText(
    res,
    status,
    loginPage(error),
    {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
    },
  );
}

export function dispatchAdminRoute(
  routes: AdminRoute[],
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  send404: (res: ServerResponse, path: string) => void,
): void {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = route.match(path);
    if (!params) continue;
    route.handle(req, res, params);
    return;
  }
  send404(res, path);
}

export function buildAdminRoutes(deps: AdminRouteDependencies): AdminRoute[] {
  return [
    {
      method: 'GET',
      match: exactPath('/login'),
      handle: (_req, res) => {
        sendLoginPage(res);
      },
    },
    {
      method: 'POST',
      match: exactPath('/login'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          if (!deps.token) {
            sendLoginPage(res, 'Login is unavailable when ADMIN_TOKEN is unset.', 503);
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
          sendLoginPage(res, 'Invalid token');
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
      dashboardService: deps.dashboardService,
      adaptiveToolsService: deps.adaptiveToolsService,
      memoryService: deps.memoryService,
      sessionService: deps.sessionService,
      contactsService: deps.contactsService,
      settingsService: deps.settingsService,
      identityService: deps.identityService,
      promptsService: deps.promptsService,
      scheduler: deps.scheduler,
      skillsRuntime: deps.skillsRuntime,
      confirmationQueueApi: deps.confirmationQueueApi,
      valuesJournal: deps.valuesJournal,
      withBody: deps.withBody,
    }),
  ];
}
