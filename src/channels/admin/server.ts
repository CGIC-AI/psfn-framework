// ── Admin GUI Server ──
// Serves the garden-themed management interface on ADMIN_PORT.
// Uses htmx for interactivity — server returns HTML fragments.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Lifecycle } from '../../types.js';
import type { AdminServerConfig } from './types.js';
import type { ContactStore } from '../../contacts/store.js';
import type { PromptLayerStore } from '../../identity/prompt-store.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import { AdminHandlers } from './handlers.js';
import { createComponentLogger } from '../../logger.js';
import {
  acceptsHtml,
  hasBearerToken,
  hasCookieValue,
  isHtmxRequest,
} from '../http/auth.js';
import {
  readBodyWithLimit,
  sendHtml,
  sendJson,
  sendRedirect,
  sendText,
} from '../http/primitives.js';

const log = createComponentLogger('AdminServer');
const ADMIN_MAX_BODY_SIZE = 65_536; // 64KB

type RouteParams = Record<string, string>;
type RouteMatcher = (path: string) => RouteParams | null;

interface AdminRoute {
  method: 'GET' | 'POST';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

function exactPath(expected: string): RouteMatcher {
  return (path) => (path === expected ? {} : null);
}

function prefixedParamPath(
  prefix: string,
  paramName: string,
  options?: { exclude?: (path: string) => boolean },
): RouteMatcher {
  return (path) => {
    if (!path.startsWith(prefix)) return null;
    if (options?.exclude?.(path)) return null;
    const raw = path.slice(prefix.length);
    if (!raw) return null;
    return { [paramName]: decodeURIComponent(raw) };
  };
}

function wrappedParamPath(prefix: string, suffix: string, paramName: string): RouteMatcher {
  return (path) => {
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
    const raw = path.slice(prefix.length, path.length - suffix.length);
    if (!raw) return null;
    return { [paramName]: decodeURIComponent(raw) };
  };
}

export class AdminServer implements Lifecycle {
  private server: Server;
  private port: number;
  private host: string;
  private token?: string;
  private allowInsecureWithoutToken: boolean;
  private handlers: AdminHandlers;
  private staticFiles = new Map<string, { content: Buffer; contentType: string }>();
  private routes: AdminRoute[];

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
      skillsRuntime: config.skillsRuntime,
    });
    this.routes = this.buildRoutes();
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async init(): Promise<void> {
    // Pre-load static files
    const staticDir = join(import.meta.dirname, 'static');
    const staticAssets = [
      { file: 'htmx.min.js', contentType: 'application/javascript' },
      { file: 'sse.js', contentType: 'application/javascript' },
      { file: 'chat.js', contentType: 'application/javascript' },
      { file: 'chat-voice.js', contentType: 'application/javascript' },
      { file: 'chat-debug.js', contentType: 'application/javascript' },
      { file: 'admin.css', contentType: 'text/css; charset=utf-8' },
    ];
    for (const { file, contentType } of staticAssets) {
      try {
        const content = readFileSync(join(staticDir, file));
        this.staticFiles.set(`/static/${file}`, {
          content,
          contentType,
        });
      } catch {
        log.warn(`Static file not found: ${file}`);
      }
    }
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
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Skip auth for OPTIONS, static files, and login page
    const skipAuth = req.method === 'OPTIONS' || path.startsWith('/static/') || path === '/login';

    if (!skipAuth && this.token && !this.checkAuth(req, res)) return;

    // Static files
    const staticFile = this.staticFiles.get(path);
    if (staticFile) {
      res.writeHead(200, { 'Content-Type': staticFile.contentType, 'Cache-Control': 'public, max-age=86400' });
      res.end(staticFile.content);
      return;
    }

    try {
      this.route(req.method ?? 'GET', path, req, res);
    } catch (err) {
      log.error('Request error', { path, error: String(err) });
      sendText(res, 500, 'Internal Server Error');
    }
  }

  private route(method: string, path: string, req: IncomingMessage, res: ServerResponse): void {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = route.match(path);
      if (!params) continue;
      route.handle(req, res, params);
      return;
    }
    this.send404(res, path);
  }

  private buildRoutes(): AdminRoute[] {
    return [
      {
        method: 'GET',
        match: exactPath('/login'),
        handle: (_req, res) => this.sendHtml(res, this.handlers.loginPage()),
      },
      {
        method: 'POST',
        match: exactPath('/login'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            const params = new URLSearchParams(body);
            const token = params.get('token') ?? '';
            if (token === this.token) {
              sendRedirect(res, '/', 302, {
                'Set-Cookie': `psfn_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
              });
            } else {
              this.sendHtml(res, this.handlers.loginPage('Invalid token'));
            }
          });
        },
      },
      { method: 'GET', match: exactPath('/'), handle: (_req, res) => this.sendHtml(res, this.handlers.dashboard()) },
      { method: 'GET', match: exactPath('/memory'), handle: (_req, res) => this.sendHtml(res, this.handlers.memoryList()) },
      {
        method: 'GET',
        match: prefixedParamPath('/memory/', 'id', { exclude: (path) => path.startsWith('/memory/search') }),
        handle: (_req, res, { id }) => {
          const html = this.handlers.memoryDetail(id);
          if (!html) {
            this.send404(res, `/memory/${encodeURIComponent(id)}`);
            return;
          }
          this.sendHtml(res, html);
        },
      },
      { method: 'GET', match: exactPath('/sessions'), handle: (_req, res) => this.sendHtml(res, this.handlers.sessionList()) },
      {
        method: 'GET',
        match: prefixedParamPath('/sessions/', 'channelId', { exclude: (path) => path.includes('/api/') }),
        handle: (_req, res, { channelId }) => this.sendHtml(res, this.handlers.sessionMessages(channelId)),
      },
      { method: 'GET', match: exactPath('/scheduler'), handle: (_req, res) => this.sendHtml(res, this.handlers.schedulerPage()) },
      { method: 'GET', match: exactPath('/shards'), handle: (_req, res) => this.sendHtml(res, this.handlers.shardsPage()) },
      { method: 'GET', match: exactPath('/contacts'), handle: (_req, res) => this.sendHtml(res, this.handlers.contactsPage()) },
      { method: 'GET', match: exactPath('/chat'), handle: (_req, res) => this.sendHtml(res, this.handlers.chatPage()) },
      { method: 'GET', match: exactPath('/identity'), handle: (_req, res) => this.sendHtml(res, this.handlers.identityPage()) },
      {
        method: 'GET',
        match: exactPath('/settings'),
        handle: (_req, res) => {
          this.handlers.settingsPage().then(
            (html) => this.sendHtml(res, html),
            (err) => this.send500('Settings page error', err, res),
          );
        },
      },
      { method: 'GET', match: exactPath('/skills'), handle: (_req, res) => this.sendHtml(res, this.handlers.skillsPage()) },
      { method: 'GET', match: exactPath('/events'), handle: (_req, res) => this.sendHtml(res, this.handlers.eventsPageHtml()) },
      { method: 'GET', match: exactPath('/primer'), handle: (_req, res) => this.sendHtml(res, this.handlers.primerPage()) },
      {
        method: 'GET',
        match: exactPath('/api/memory/list'),
        handle: (_req, res) => this.sendFragment(res, this.handlers.memoryListFragment()),
      },
      {
        method: 'POST',
        match: exactPath('/api/memory/search'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            const params = new URLSearchParams(body);
            const query = params.get('query') ?? '';
            this.handlers.memorySearch(query).then(
              (html) => this.sendFragment(res, html),
              (err) => {
                log.error('Memory search error', { error: String(err) });
                this.sendFragment(res, '<tr><td colspan="8" class="empty">Search error</td></tr>');
              },
            );
          });
        },
      },
      {
        method: 'POST',
        match: wrappedParamPath('/api/memory/', '/supersede', 'id'),
        handle: (_req, res, { id }) => this.sendFragment(res, this.handlers.memorySupersede(id)),
      },
      {
        method: 'GET',
        match: wrappedParamPath('/api/sessions/', '/messages', 'channelId'),
        handle: (_req, res, { channelId }) => this.sendFragment(res, this.handlers.sessionMessagesFragment(channelId)),
      },
      {
        method: 'GET',
        match: exactPath('/api/chat/bootstrap'),
        handle: (_req, res) => sendJson(res, 200, this.handlers.chatBootstrap()),
      },
      {
        method: 'GET',
        match: exactPath('/api/chat/events/stream'),
        handle: (req, res) => {
          const url = new URL(req.url ?? '/api/chat/events/stream', `http://${req.headers.host ?? 'localhost'}`);
          const channelId = url.searchParams.get('channelId') ?? undefined;
          const cleanup = this.handlers.setupChatDebugSSE(res, { channelId });
          req.on('close', cleanup);
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/chat/bootstrap'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            try {
              const payload = this.handlers.updateChatBootstrap(body, req.headers['content-type']);
              sendJson(res, 200, payload);
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/contacts/list'),
        handle: (_req, res) => this.sendFragment(res, this.handlers.contactsListFragment()),
      },
      {
        method: 'GET',
        match: wrappedParamPath('/api/contacts/', '/edit', 'contactId'),
        handle: (_req, res, { contactId }) => this.sendFragment(res, this.handlers.contactEditFormFragment(contactId)),
      },
      {
        method: 'POST',
        match: prefixedParamPath('/api/contacts/', 'contactId', { exclude: (path) => path.endsWith('/edit') }),
        handle: (req, res, { contactId }) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.handleContactUpdate(contactId, body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/settings'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.updateSettings(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/settings/models'),
        handle: (_req, res) => sendText(res, 200, this.handlers.modelsConfigJson(), {
          'Content-Type': 'application/json',
        }),
      },
      {
        method: 'POST',
        match: exactPath('/api/settings/models'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.updateModelsConfig(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/settings/skills'),
        handle: (_req, res) => sendText(res, 200, this.handlers.skillsConfigJson(), {
          'Content-Type': 'application/json',
        }),
      },
      {
        method: 'POST',
        match: exactPath('/api/settings/skills'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.updateSkillsConfig(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/settings/scheduler'),
        handle: (_req, res) => sendText(res, 200, this.handlers.schedulerConfigJson(), {
          'Content-Type': 'application/json',
        }),
      },
      {
        method: 'POST',
        match: exactPath('/api/settings/scheduler'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.updateSchedulerConfig(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/settings/trust-policy'),
        handle: (_req, res) => sendText(res, 200, this.handlers.trustPolicyConfigJson(), {
          'Content-Type': 'application/json',
        }),
      },
      {
        method: 'POST',
        match: exactPath('/api/settings/trust-policy'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.updateTrustPolicyConfig(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/models'),
        handle: (_req, res) => {
          this.handlers.modelListJson().then(
            (json) => sendText(res, 200, json, { 'Content-Type': 'application/json' }),
            (err) => {
              log.error('Model list error', { error: String(err) });
              sendText(res, 500, '[]', { 'Content-Type': 'application/json' });
            },
          );
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/models/refresh'),
        handle: (_req, res) => {
          this.handlers.refreshModels().then(
            (json) => sendText(res, 200, json, { 'Content-Type': 'application/json' }),
            (err) => {
              log.error('Model refresh error', { error: String(err) });
              sendText(res, 200, '[]', { 'Content-Type': 'application/json' });
            },
          );
        },
      },
      { method: 'GET', match: exactPath('/prompts'), handle: (_req, res) => this.sendHtml(res, this.handlers.promptsPage()) },
      {
        method: 'GET',
        match: prefixedParamPath('/prompts/static/', 'key'),
        handle: (_req, res, { key }) => {
          const html = this.handlers.promptRegistryDetail(key);
          if (!html) {
            this.send404(res, `/prompts/static/${encodeURIComponent(key)}`);
            return;
          }
          this.sendHtml(res, html);
        },
      },
      {
        method: 'GET',
        match: prefixedParamPath('/prompts/', 'layerId', { exclude: (path) => path.includes('/api/') }),
        handle: (_req, res, { layerId }) => {
          const html = this.handlers.promptDetail(layerId);
          if (!html) {
            this.send404(res, `/prompts/${encodeURIComponent(layerId)}`);
            return;
          }
          this.sendHtml(res, html);
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/update'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.updatePromptLayer(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/static/update'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.updatePromptRegistry(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/toggle'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.togglePromptLayer(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/rollback'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.rollbackPromptLayer(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/static/rollback'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.rollbackPromptRegistry(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/diff'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.previewPromptLayerDiff(body));
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
          const cleanup = this.handlers.setupSSE(res);
          req.on('close', cleanup);
        },
      },
    ];
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.token) return true;
    if (hasBearerToken(req, this.token)) {
      return true;
    }
    if (hasCookieValue(req, 'psfn_token', this.token)) {
      return true;
    }

    // Redirect browser requests to login page, return 401 for API/htmx
    if (!isHtmxRequest(req) && acceptsHtml(req)) {
      sendRedirect(res, '/login');
    } else {
      sendText(res, 401, 'Unauthorized');
    }
    return false;
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
    log.error(context, { error: String(err) });
    if (res.writableEnded || res.destroyed) return;
    sendText(res, 500, 'Internal Server Error');
  }
}
