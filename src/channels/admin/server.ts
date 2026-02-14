// ── Admin GUI Server ──
// Serves the garden-themed management interface on ADMIN_PORT.
// Uses htmx for interactivity — server returns HTML fragments.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Lifecycle } from '../../types.js';
import type { AdminServerConfig } from './types.js';
import type { ContactStore } from '../../contacts/store.js';
import { AdminHandlers } from './handlers.js';
import { createComponentLogger } from '../../logger.js';

const log = createComponentLogger('AdminServer');

export class AdminServer implements Lifecycle {
  private server: Server;
  private port: number;
  private host: string;
  private token?: string;
  private handlers: AdminHandlers;
  private staticFiles = new Map<string, { content: Buffer; contentType: string }>();

  constructor(config: AdminServerConfig & { contactStore?: ContactStore | null }) {
    this.port = config.port;
    this.host = config.host ?? '127.0.0.1';
    this.token = config.token;
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
    });
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async init(): Promise<void> {
    // Pre-load static files
    const staticDir = join(import.meta.dirname, 'static');
    for (const file of ['htmx.min.js', 'sse.js']) {
      try {
        const content = readFileSync(join(staticDir, file));
        this.staticFiles.set(`/static/${file}`, {
          content,
          contentType: 'application/javascript',
        });
      } catch {
        log.warn(`Static file not found: ${file}`);
      }
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        log.info(`Listening on ${this.host}:${this.port}`);
        if (!this.token) {
          log.warn('Admin server started WITHOUT authentication — set ADMIN_TOKEN to secure');
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
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }

  private route(method: string, path: string, req: IncomingMessage, res: ServerResponse): void {
    // ── Login ──

    if (method === 'GET' && path === '/login') {
      return this.sendHtml(res, this.handlers.loginPage());
    }
    if (method === 'POST' && path === '/login') {
      return this.readBody(req, res, (body) => {
        const params = new URLSearchParams(body);
        const token = params.get('token') ?? '';
        if (token === this.token) {
          res.writeHead(302, {
            Location: '/',
            'Set-Cookie': `psfn_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
          });
          res.end();
        } else {
          this.sendHtml(res, this.handlers.loginPage('Invalid token'));
        }
      });
    }

    // ── Pages (return full HTML) ──

    if (method === 'GET' && path === '/') {
      return this.sendHtml(res, this.handlers.dashboard());
    }
    if (method === 'GET' && path === '/memory') {
      return this.sendHtml(res, this.handlers.memoryList());
    }
    if (method === 'GET' && path.startsWith('/memory/') && !path.startsWith('/memory/search')) {
      const id = decodeURIComponent(path.slice(8));
      const html = this.handlers.memoryDetail(id);
      if (!html) return this.send404(res, path);
      return this.sendHtml(res, html);
    }
    if (method === 'GET' && path === '/sessions') {
      return this.sendHtml(res, this.handlers.sessionList());
    }
    if (method === 'GET' && path.startsWith('/sessions/') && !path.includes('/api/')) {
      const channelId = decodeURIComponent(path.slice(10));
      return this.sendHtml(res, this.handlers.sessionMessages(channelId));
    }
    if (method === 'GET' && path === '/scheduler') {
      return this.sendHtml(res, this.handlers.schedulerPage());
    }
    if (method === 'GET' && path === '/shards') {
      return this.sendHtml(res, this.handlers.shardsPage());
    }
    if (method === 'GET' && path === '/contacts') {
      return this.sendHtml(res, this.handlers.contactsPage());
    }
    if (method === 'GET' && path === '/identity') {
      return this.sendHtml(res, this.handlers.identityPage());
    }
    if (method === 'GET' && path === '/settings') {
      this.handlers.settingsPage().then(
        (html) => this.sendHtml(res, html),
        (err) => {
          log.error('Settings page error', { error: String(err) });
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        },
      );
      return;
    }
    if (method === 'GET' && path === '/events') {
      return this.sendHtml(res, this.handlers.eventsPageHtml());
    }
    if (method === 'GET' && path === '/primer') {
      return this.sendHtml(res, this.handlers.primerPage());
    }

    // ── API fragments (return HTML fragments for htmx) ──

    if (method === 'GET' && path === '/api/memory/list') {
      return this.sendFragment(res, this.handlers.memoryListFragment());
    }
    if (method === 'POST' && path === '/api/memory/search') {
      return this.readBody(req, res, (body) => {
        const params = new URLSearchParams(body);
        const query = params.get('query') ?? '';
        this.handlers.memorySearch(query).then(
          (html) => this.sendFragment(res, html),
          (err) => {
            log.error('Memory search error', { error: String(err) });
            this.sendFragment(res, '<tr><td colspan="6" class="empty">Search error</td></tr>');
          },
        );
      });
    }
    if (method === 'POST' && path.startsWith('/api/memory/') && path.endsWith('/supersede')) {
      const id = decodeURIComponent(path.slice(12, -10));
      return this.sendFragment(res, this.handlers.memorySupersede(id));
    }
    if (method === 'GET' && path.startsWith('/api/sessions/') && path.endsWith('/messages')) {
      const channelId = decodeURIComponent(path.slice(14, -9));
      return this.sendFragment(res, this.handlers.sessionMessagesFragment(channelId));
    }

    // ── Contacts API ──

    if (method === 'GET' && path === '/api/contacts/list') {
      return this.sendFragment(res, this.handlers.contactsListFragment());
    }
    if (method === 'GET' && path.startsWith('/api/contacts/') && path.endsWith('/edit')) {
      const contactId = decodeURIComponent(path.slice(14, -5)); // strip /api/contacts/ and /edit
      return this.sendFragment(res, this.handlers.contactEditFormFragment(contactId));
    }
    if (method === 'POST' && path.startsWith('/api/contacts/') && !path.endsWith('/edit')) {
      const contactId = decodeURIComponent(path.slice(14)); // strip /api/contacts/
      return this.readBody(req, res, (body) => {
        this.sendFragment(res, this.handlers.handleContactUpdate(contactId, body));
      });
    }

    // ── Settings API ──

    if (method === 'POST' && path === '/api/settings') {
      return this.readBody(req, res, (body) => {
        const html = this.handlers.updateSettings(body);
        this.sendFragment(res, html);
      });
    }
    if (method === 'GET' && path === '/api/models') {
      this.handlers.modelListJson().then(
        (json) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(json);
        },
        (err) => {
          log.error('Model list error', { error: String(err) });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('[]');
        },
      );
      return;
    }
    if (method === 'POST' && path === '/api/models/refresh') {
      this.handlers.refreshModels().then(
        (json) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(json);
        },
        (err) => {
          log.error('Model refresh error', { error: String(err) });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('[]');
        },
      );
      return;
    }

    // ── Health endpoint (for watchdog / monitoring) ──

    if (method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    // ── SSE event stream ──

    if (method === 'GET' && path === '/events/stream') {
      const cleanup = this.handlers.setupSSE(res);
      req.on('close', cleanup);
      return;
    }

    this.send404(res, path);
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    // Check Bearer header first
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ') && auth.slice(7) === this.token) {
      return true;
    }

    // Check cookie
    const cookies = req.headers.cookie ?? '';
    const match = cookies.match(/(?:^|;\s*)psfn_token=([^;]+)/);
    if (match && match[1] === this.token) {
      return true;
    }

    // Redirect browser requests to login page, return 401 for API/htmx
    const isHtmx = req.headers['hx-request'] === 'true';
    const accept = req.headers.accept ?? '';
    if (!isHtmx && accept.includes('text/html')) {
      res.writeHead(302, { Location: '/login' });
      res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
    }
    return false;
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private sendFragment(res: ServerResponse, html: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private send404(res: ServerResponse, path: string): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${path}`);
  }

  private readBody(req: IncomingMessage, res: ServerResponse, cb: (body: string) => void): void {
    const MAX_BODY_SIZE = 65_536; // 64KB
    let body = '';
    let bodySize = 0;
    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        log.warn('Request body too large', { size: bodySize, limit: MAX_BODY_SIZE });
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Payload Too Large');
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (bodySize > MAX_BODY_SIZE) return;
      cb(body);
    });
  }
}
