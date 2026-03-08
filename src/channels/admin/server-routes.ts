import type { IncomingMessage, ServerResponse } from 'node:http';
import { toErrorMessage } from '../../utils/errors.js';
import { buildAdminApiRoutes, type AdminSchedulerApi, type AdminSkillsApi, type AdminValuesJournalApi } from './api-routes.js';
import type { AdminHandlers } from './handlers.js';
import { parseRequestUrl, resolveRequestOrigin } from './request-url.js';
import {
  exactPath,
  prefixedParamPath,
  wrappedParamPath,
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
  handlers: AdminHandlers;
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
  sendHtml: (res: ServerResponse, html: string) => void;
  sendFragment: (res: ServerResponse, html: string) => void;
  send404: (res: ServerResponse, path: string) => void;
  send500: (context: string, err: unknown, res: ServerResponse) => void;
  logError: (message: string, data?: Record<string, unknown>) => void;
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
      handle: (_req, res) => deps.sendHtml(res, deps.handlers.loginPage()),
    },
    {
      method: 'POST',
      match: exactPath('/login'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          const params = new URLSearchParams(body);
          const token = params.get('token') ?? '';
          if (token === deps.token) {
            const encodedToken = encodeURIComponent(token);
            sendRedirect(res, GARDEN_PREFIX, 302, {
              'Set-Cookie': `psfn_token=${encodedToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
            });
          } else {
            deps.sendHtml(res, deps.handlers.loginPage('Invalid token'));
          }
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
    { method: 'GET', match: exactPath('/'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.domains.dashboard.dashboard()) },
    {
      method: 'GET',
      match: exactPath('/memory'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/memory');
        deps.sendHtml(res, deps.handlers.domains.memory.memoryList(url.searchParams));
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/memory/', 'id', { exclude: (path) => path.startsWith('/memory/search') }),
      handle: (_req, res, { id }) => {
        const html = deps.handlers.domains.memory.memoryDetail(id);
        if (!html) {
          deps.send404(res, `/memory/${encodeURIComponent(id)}`);
          return;
        }
        deps.sendHtml(res, html);
      },
    },
    { method: 'GET', match: exactPath('/sessions'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.domains.sessions.sessionList()) },
    {
      method: 'GET',
      match: prefixedParamPath('/sessions/', 'channelId', { exclude: (path) => path.includes('/api/') }),
      handle: (_req, res, { channelId }) => deps.sendHtml(res, deps.handlers.domains.sessions.sessionMessages(channelId)),
    },
    { method: 'GET', match: exactPath('/scheduler'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.schedulerPage()) },
    { method: 'GET', match: exactPath('/shards'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.shardsPage()) },
    { method: 'GET', match: exactPath('/contacts'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.domains.contacts.contactsPage()) },
    { method: 'GET', match: exactPath('/chat'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.domains.chat.chatPage()) },
    {
      method: 'GET',
      match: exactPath('/confirmations'),
      handle: (_req, res) => {
        deps.handlers.domains.confirmations.confirmationsPage().then(
          (html) => deps.sendHtml(res, html),
          (err) => deps.send500('Confirmations page error', err, res),
        );
      },
    },
    { method: 'GET', match: exactPath('/identity'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.domains.identity.identityPage()) },
    {
      method: 'POST',
      match: exactPath('/api/identity/import'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.handlers.domains.identity.importIdentityCard(body).then(
            (html) => deps.sendFragment(res, html),
            (err) => deps.send500('Identity import error', err, res),
          );
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/identity/intake/stage'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.identity.stageIdentityIntake(body));
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/identity/intake/commit'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.handlers.domains.identity.commitIdentityIntake(body).then(
            (html) => deps.sendFragment(res, html),
            (err) => deps.send500('Identity intake commit error', err, res),
          );
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/identity/card/rollback'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.identity.rollbackIdentityCard(body));
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/identity/card/diff'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.identity.previewIdentityCardDiff(body));
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/settings'),
      handle: (_req, res) => {
        deps.handlers.domains.settings.settingsPage().then(
          (html) => deps.sendHtml(res, html),
          (err) => deps.send500('Settings page error', err, res),
        );
      },
    },
    { method: 'GET', match: exactPath('/skills'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.domains.settings.skillsPage()) },
    {
      method: 'GET',
      match: exactPath('/events'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/events');
        deps.sendHtml(res, deps.handlers.domains.events.eventsPageHtml(url.searchParams));
      },
    },
    { method: 'GET', match: exactPath('/values'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.domains.events.valuesTimelinePageHtml()) },
    { method: 'GET', match: exactPath('/primer'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.primerPage()) },
    {
      method: 'GET',
      match: exactPath('/api/memory/list'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/memory/list');
        deps.sendFragment(res, deps.handlers.domains.memory.memoryListFragment(url.searchParams));
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/memory/search'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          const params = new URLSearchParams(body);
          const query = params.get('query') ?? '';
          deps.handlers.domains.memory.memorySearch(query).then(
            (html) => deps.sendFragment(res, html),
            (error) => {
              deps.logError('Memory search error', { error: String(error) });
              deps.sendFragment(res, '<tr><td colspan="8" class="empty">Search error</td></tr>');
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: wrappedParamPath('/api/memory/', '/supersede', 'id'),
      handle: (_req, res, { id }) => deps.sendFragment(res, deps.handlers.domains.memory.memorySupersede(id)),
    },
    {
      method: 'GET',
      match: wrappedParamPath('/api/sessions/', '/messages', 'channelId'),
      handle: (_req, res, { channelId }) => deps.sendFragment(res, deps.handlers.domains.sessions.sessionMessagesFragment(channelId)),
    },
    {
      method: 'GET',
      match: exactPath('/api/chat/bootstrap'),
      handle: (req, res) => sendJson(
        res,
        200,
        deps.handlers.domains.chat.chatBootstrap(resolveRequestOrigin(req)),
      ),
    },
    {
      method: 'GET',
      match: exactPath('/api/chat/model-room/bootstrap'),
      handle: (req, res) => sendJson(
        res,
        200,
        deps.handlers.domains.chat.chatModelRoomBootstrap(resolveRequestOrigin(req)),
      ),
    },
    {
      method: 'GET',
      match: exactPath('/api/chat/events/stream'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/chat/events/stream');
        const channelId = url.searchParams.get('channelId') ?? undefined;
        const cleanup = deps.handlers.domains.chat.setupChatDebugSSE(res, { channelId });
        req.on('close', cleanup);
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/chat/bootstrap'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          try {
            const payload = deps.handlers.domains.chat.updateChatBootstrap(
              body,
              req.headers['content-type'],
              resolveRequestOrigin(req),
            );
            sendJson(res, 200, payload);
          } catch (error) {
            sendJson(res, 400, {
              error: toErrorMessage(error),
            });
          }
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/confirmations/list'),
      handle: (_req, res) => {
        deps.handlers.domains.confirmations.confirmationsListFragment().then(
          (html) => deps.sendFragment(res, html),
          (err) => deps.send500('Confirmation queue list error', err, res),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/confirmations/resolve'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.handlers.domains.confirmations.resolveConfirmation(body).then(
            (html) => deps.sendFragment(res, html),
            (err) => deps.send500('Confirmation queue resolve error', err, res),
          );
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/contacts/list'),
      handle: (_req, res) => deps.sendFragment(res, deps.handlers.domains.contacts.contactsListFragment()),
    },
    {
      method: 'GET',
      match: exactPath('/api/contacts/mutations'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/contacts/mutations');
        deps.sendFragment(res, deps.handlers.domains.contacts.contactMutationAuditFragment(url.searchParams));
      },
    },
    {
      method: 'GET',
      match: wrappedParamPath('/api/contacts/', '/edit', 'contactId'),
      handle: (_req, res, { contactId }) => deps.sendFragment(res, deps.handlers.domains.contacts.contactEditFormFragment(contactId)),
    },
    {
      method: 'POST',
      match: prefixedParamPath('/api/contacts/', 'contactId', { exclude: (path) => path.endsWith('/edit') }),
      handle: (req, res, { contactId }) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.contacts.handleContactUpdate(contactId, body));
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/settings'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.settings.updateSettings(body));
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/settings/models'),
      handle: (_req, res) => sendText(res, 200, deps.handlers.domains.settings.modelsConfigJson(), {
        'Content-Type': 'application/json',
      }),
    },
    {
      method: 'POST',
      match: exactPath('/api/settings/models'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.settings.updateModelsConfig(body));
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/settings/skills'),
      handle: (_req, res) => sendText(res, 200, deps.handlers.domains.settings.skillsConfigJson(), {
        'Content-Type': 'application/json',
      }),
    },
    {
      method: 'POST',
      match: exactPath('/api/settings/skills'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.settings.updateSkillsConfig(body));
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/settings/scheduler'),
      handle: (_req, res) => sendText(res, 200, deps.handlers.domains.settings.schedulerConfigJson(), {
        'Content-Type': 'application/json',
      }),
    },
    {
      method: 'POST',
      match: exactPath('/api/settings/scheduler'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.settings.updateSchedulerConfig(body));
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/settings/trust-policy'),
      handle: (_req, res) => sendText(res, 200, deps.handlers.domains.settings.trustPolicyConfigJson(), {
        'Content-Type': 'application/json',
      }),
    },
    {
      method: 'POST',
      match: exactPath('/api/settings/trust-policy'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.settings.updateTrustPolicyConfig(body));
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/settings/capabilities'),
      handle: (_req, res) => sendText(res, 200, deps.handlers.domains.settings.capabilitiesConfigJson(), {
        'Content-Type': 'application/json',
      }),
    },
    {
      method: 'POST',
      match: exactPath('/api/settings/capabilities'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.settings.updateCapabilitiesConfig(body));
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/models'),
      handle: (_req, res) => {
        deps.handlers.domains.settings.modelListJson().then(
          (json) => sendText(res, 200, json, { 'Content-Type': 'application/json' }),
          (error) => {
            deps.logError('Model list error', { error: String(error) });
            sendText(res, 500, '[]', { 'Content-Type': 'application/json' });
          },
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/models/refresh'),
      handle: (_req, res) => {
        deps.handlers.domains.settings.refreshModels().then(
          (json) => sendText(res, 200, json, { 'Content-Type': 'application/json' }),
          (error) => {
            deps.logError('Model refresh error', { error: String(error) });
            sendText(res, 200, '[]', { 'Content-Type': 'application/json' });
          },
        );
      },
    },
    { method: 'GET', match: exactPath('/prompts'), handle: (_req, res) => deps.sendHtml(res, deps.handlers.domains.prompts.promptsPage()) },
    {
      method: 'GET',
      match: prefixedParamPath('/prompts/static/', 'key'),
      handle: (_req, res, { key }) => {
        const html = deps.handlers.domains.prompts.promptRegistryDetail(key);
        if (!html) {
          deps.send404(res, `/prompts/static/${encodeURIComponent(key)}`);
          return;
        }
        deps.sendHtml(res, html);
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/prompts/', 'layerId', { exclude: (path) => path.includes('/api/') }),
      handle: (_req, res, { layerId }) => {
        const html = deps.handlers.domains.prompts.promptDetail(layerId);
        if (!html) {
          deps.send404(res, `/prompts/${encodeURIComponent(layerId)}`);
          return;
        }
        deps.sendHtml(res, html);
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/prompts/update'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.prompts.updatePromptLayer(body));
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/prompts/static/update'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.prompts.updatePromptRegistry(body));
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/prompts/toggle'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.prompts.togglePromptLayer(body));
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/prompts/rollback'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.prompts.rollbackPromptLayer(body));
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/prompts/static/rollback'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.prompts.rollbackPromptRegistry(body));
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/prompts/diff'),
      handle: (req, res) => {
        deps.withBody(req, res, (body) => {
          deps.sendFragment(res, deps.handlers.domains.prompts.previewPromptLayerDiff(body));
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/health'),
      handle: (_req, res) => sendJson(res, 200, { status: 'ok', uptime: process.uptime() }),
    },
    {
      method: 'GET',
      match: exactPath('/events/stream'),
      handle: (req, res) => {
        const cleanup = deps.handlers.domains.events.setupSSE(res);
        req.on('close', cleanup);
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
      appendAuditTimelineEntry: (actionType, decision, narrative, details = [], actor) => {
        deps.handlers.appendAuditTimelineEntry(actionType, decision, narrative, details, actor);
      },
      withBody: deps.withBody,
    }),
  ];
}
