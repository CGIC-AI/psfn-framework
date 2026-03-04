// ── Admin GUI Server ──
// Serves the garden-themed management interface on ADMIN_PORT.
// Uses htmx for interactivity — server returns HTML fragments.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CorrelationMetadata, Lifecycle, ObservabilityCallType } from '../../types.js';
import type { AdminServerConfig } from './types.js';
import type { ContactStore } from '../../contacts/store.js';
import type { PromptLayerStore } from '../../identity/prompt-store.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import type { EventBus, EventName, EventMap } from '../../event-bus.js';
import { AdminHandlers } from './handlers.js';
import { buildAdminApiRoutes } from './api-routes.js';
import { createComponentLogger } from '../../logger.js';
import {
  acceptsHtml,
  hasBearerToken,
  hasCookieValue,
  isHtmxRequest,
} from '../http/auth.js';
import { toErrorMessage } from '../../utils/errors.js';
import {
  readBodyWithLimit,
  sendHtml,
  sendJson,
  sendRedirect,
  sendText,
} from '../http/primitives.js';
import { AdminDashboardDataService } from './services/dashboard-service.js';
import { AdminMemoryDataService } from './services/memory-service.js';
import { AdminSessionDataService } from './services/session-service.js';
import { AdminContactsDataService } from './services/contacts-service.js';
import { AdminSettingsDataService } from './services/settings-service.js';
import { AdminIdentityDataService } from './services/identity-service.js';
import { AdminPromptsDataService } from './services/prompts-service.js';
import { AdminSchedulerService } from './services/scheduler-service.js';
import { AdminAdaptiveToolsDataService } from './services/adaptive-tools-service.js';
import { ValuesJournalStore } from '../../values/store.js';
import {
  resolveLegacyValuesJournalPath,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';

const log = createComponentLogger('AdminServer');
const ADMIN_MAX_BODY_SIZE = 65_536; // 64KB
const STATIC_CACHE_CONTROL = 'public, max-age=86400';
const MODULE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PI_WEB_UI_ENTRY_SPECIFIER = '@mariozechner/pi-web-ui';
const PI_WEB_UI_STYLE_SPECIFIER = '@mariozechner/pi-web-ui/app.css';
const PI_WEB_UI_ENTRY_ROUTE = '/static/pi-web-ui/index.js';
const PI_WEB_UI_STYLE_ROUTE = '/static/pi-web-ui/app.css';
const PI_WEB_UI_MODULE_ROUTE_PREFIX = '/static/pi-web-ui/modules/';
const SUPPORTED_MODULE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.wasm',
]);

// ── SvelteKit Garden UI (static SPA at /garden/*) ──
const GARDEN_PREFIX = '/garden';
const GARDEN_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const GARDEN_HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const GARDEN_ASSET_CACHE_CONTROL = 'public, max-age=86400';
const LEGACY_PREFIX = '/legacy';
const LEGACY_DEPRECATION_HEADERS = {
  Deprecation: 'true',
  Warning: '299 - "Legacy admin UI is deprecated; use /garden"',
  Link: '</garden>; rel="successor-version"',
} as const;
const LEGACY_REDIRECT_EXACT_PATHS = new Set([
  '/memory',
  '/sessions',
  '/scheduler',
  '/shards',
  '/contacts',
  '/chat',
  '/confirmations',
  '/identity',
  '/settings',
  '/skills',
  '/events',
  '/events/stream',
  '/values',
  '/primer',
  '/prompts',
]);
const LEGACY_REDIRECT_PREFIXES = [
  '/memory/',
  '/sessions/',
  '/prompts/',
];

type RouteParams = Record<string, string>;
type RouteMatcher = (path: string) => RouteParams | null;

interface AdminRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

interface StaticAsset {
  content: Buffer;
  contentType: string;
  cacheControl: string;
}

interface ModuleAssetDescriptor {
  filePath: string;
  contentType: string;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const CALL_TYPES: ReadonlySet<ObservabilityCallType> = new Set([
  'chat',
  'tool',
  'memory',
  'summary',
  'background',
  'scheduled',
]);

function normalizeCallType(value: string | undefined): ObservabilityCallType | undefined {
  if (!value) return undefined;
  return CALL_TYPES.has(value as ObservabilityCallType)
    ? (value as ObservabilityCallType)
    : undefined;
}

function inferTelemetryCallType(eventName: EventName): ObservabilityCallType | undefined {
  if (eventName === 'agent.tool.start' || eventName === 'agent.tool.end') {
    return 'tool';
  }
  if (eventName.startsWith('agent.tools.adaptive.')) {
    return 'tool';
  }
  if (eventName === 'memory.extraction.end') {
    return 'memory';
  }
  if (
    eventName === 'agent.turn.usage'
    || eventName === 'message.sent'
    || eventName.startsWith('broadcast.')
  ) {
    return 'chat';
  }
  if (
    eventName.startsWith('wyoming.')
    || eventName === 'external.telemetry.ingested'
  ) {
    return 'background';
  }
  return undefined;
}

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
  private telemetryWebSocketServer = new WebSocketServer({ noServer: true });
  private staticFiles = new Map<string, StaticAsset>();
  private moduleAssets = new Map<string, ModuleAssetDescriptor>();
  private moduleAssetCache = new Map<string, Buffer>();
  private moduleRouteByFilePath = new Map<string, string>();
  private moduleResolver = createRequire(import.meta.url);
  private routes: AdminRoute[];
  private gardenBuildDir: string | null = null;

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
      skillsRuntime: config.skillsRuntime,
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
    });
    this.adaptiveToolsService = new AdminAdaptiveToolsDataService({
      eventBus: config.eventBus,
      stateProvider: config.adaptiveToolsStateProvider ?? null,
    });
    this.valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(config.config.dataDir), {
      legacyFilePaths: [resolveLegacyValuesJournalPath(config.config.dataDir)],
    });
    this.scheduler = config.scheduler;
    this.schedulerService = new AdminSchedulerService(config.scheduler, config.config.dataDir);
    this.skillsRuntimeRef = config.skillsRuntime ?? null;
    this.confirmationQueueApiRef = config.confirmationQueueApi ?? null;
    this.routes = this.buildRoutes();
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async init(): Promise<void> {
    // Pre-load static files
    const staticDir = join(import.meta.dirname, 'static');
    const staticAssets = [
      { file: 'htmx.min.js', contentType: 'application/javascript' },
      { file: 'sse.js', contentType: 'application/javascript' },
      { file: 'chat.js', contentType: 'application/javascript' },
      { file: 'chat-debug.js', contentType: 'application/javascript' },
      { file: 'admin.css', contentType: 'text/css; charset=utf-8' },
    ];
    for (const { file, contentType } of staticAssets) {
      try {
        const content = readFileSync(join(staticDir, file));
        this.registerStaticAsset(`/static/${file}`, content, contentType);
      } catch {
        log.warn(`Static file not found: ${file}`);
      }
    }

    this.initializePiWebUiRoutes();
    this.initializeGardenUi();
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
      this.telemetryWebSocketServer.close(() => {
        this.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const requestPath = url.pathname;
    const {
      path: routedPath,
      isLegacyPath,
    } = this.resolveLegacyRequestPath(requestPath);
    const isLegacyChatRuntimePath = routedPath === '/static/chat.js';

    if (isLegacyChatRuntimePath && this.token && !this.hasRequestAuthCredentials(req)) {
      this.send404(res, routedPath);
      return;
    }

    // Skip auth for OPTIONS, static files, and login page.
    const skipAuth = req.method === 'OPTIONS'
      || routedPath.startsWith('/static/')
      || routedPath === '/login';

    if (!skipAuth && this.token && !this.checkAuth(req, res)) return;

    if (!isLegacyPath && requestPath === '/') {
      sendRedirect(res, `${GARDEN_PREFIX}${url.search}`);
      return;
    }

    if (!isLegacyPath) {
      const legacyRedirectPath = this.resolveLegacyRedirectPath(requestPath);
      if (legacyRedirectPath) {
        sendRedirect(res, `${legacyRedirectPath}${url.search}`);
        return;
      }
    }

    if (isLegacyPath) {
      this.applyLegacyDeprecationHeaders(res);
    }

    if (this.tryServeStaticAsset(routedPath, res)) {
      return;
    }

    // Serve SvelteKit garden UI static files.
    if (routedPath === GARDEN_PREFIX || routedPath.startsWith(GARDEN_PREFIX + '/')) {
      if (this.gardenBuildDir) {
        this.serveGardenAsset(routedPath, res);
      } else {
        sendRedirect(res, LEGACY_PREFIX);
      }
      return;
    }

    try {
      this.route(req.method ?? 'GET', routedPath, req, res);
    } catch (err) {
      log.error('Request error', { path: routedPath, error: String(err) });
      sendText(res, 500, 'Internal Server Error');
    }
  }

  private resolveLegacyRequestPath(path: string): { path: string; isLegacyPath: boolean } {
    if (path === LEGACY_PREFIX || path === `${LEGACY_PREFIX}/`) {
      return { path: '/', isLegacyPath: true };
    }

    if (path.startsWith(`${LEGACY_PREFIX}/`)) {
      const stripped = path.slice(LEGACY_PREFIX.length);
      return { path: stripped.length > 0 ? stripped : '/', isLegacyPath: true };
    }

    return { path, isLegacyPath: false };
  }

  private resolveLegacyRedirectPath(path: string): string | null {
    if (
      path.startsWith('/api/')
      || path.startsWith('/static/')
      || path === '/login'
      || path === '/health'
      || path === GARDEN_PREFIX
      || path.startsWith(GARDEN_PREFIX + '/')
      || path === LEGACY_PREFIX
      || path.startsWith(`${LEGACY_PREFIX}/`)
    ) {
      return null;
    }

    if (LEGACY_REDIRECT_EXACT_PATHS.has(path)) {
      return `${LEGACY_PREFIX}${path}`;
    }

    for (const prefix of LEGACY_REDIRECT_PREFIXES) {
      if (path.startsWith(prefix)) {
        return `${LEGACY_PREFIX}${path}`;
      }
    }

    return null;
  }

  private applyLegacyDeprecationHeaders(res: ServerResponse): void {
    for (const [name, value] of Object.entries(LEGACY_DEPRECATION_HEADERS)) {
      res.setHeader(name, value);
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

  private registerStaticAsset(
    routePath: string,
    content: Buffer,
    contentType: string,
    cacheControl: string = STATIC_CACHE_CONTROL,
  ): void {
    this.staticFiles.set(routePath, {
      content,
      contentType,
      cacheControl,
    });
  }

  private initializePiWebUiRoutes(): void {
    const entryPath = this.resolveModuleSpecifier(PI_WEB_UI_ENTRY_SPECIFIER);
    if (!entryPath) {
      log.warn('pi-web-ui entry module not found; /chat ESM runtime route disabled');
      return;
    }

    this.registerModuleAssetRoute(PI_WEB_UI_ENTRY_ROUTE, entryPath, 'application/javascript');

    const stylePath = this.resolveModuleSpecifier(PI_WEB_UI_STYLE_SPECIFIER);
    if (!stylePath) {
      log.warn('pi-web-ui stylesheet not found; /chat ESM stylesheet route disabled');
      return;
    }

    this.registerModuleAssetRoute(PI_WEB_UI_STYLE_ROUTE, stylePath, 'text/css; charset=utf-8');
  }

  private initializeGardenUi(): void {
    // Resolve admin-ui/build relative to project root (3 dirs up from src/channels/admin/)
    const projectRoot = resolve(import.meta.dirname, '..', '..', '..');
    const buildDir = join(projectRoot, 'admin-ui', 'build');
    if (!existsSync(buildDir)) {
      log.warn('admin-ui/build not found; /garden/* route disabled. Run "cd admin-ui && npm run build" to enable.');
      return;
    }
    const indexPath = join(buildDir, 'index.html');
    if (!existsSync(indexPath)) {
      log.warn('admin-ui/build/index.html not found; /garden/* route disabled');
      return;
    }
    this.gardenBuildDir = buildDir;
    log.info('Garden SvelteKit UI enabled at /garden/*');
  }

  private serveGardenAsset(path: string, res: ServerResponse): void {
    if (!this.gardenBuildDir) {
      this.send404(res, path);
      return;
    }

    // Strip /garden prefix; bare /garden serves index.html
    let filePath = path === GARDEN_PREFIX ? '/' : path.slice(GARDEN_PREFIX.length);
    if (filePath === '' || filePath === '/') {
      filePath = '/index.html';
    }

    // Normalize and resolve within the build directory
    const normalizedPath = normalize(filePath);
    const fullPath = join(this.gardenBuildDir, normalizedPath);

    // Prevent directory traversal: resolved path must be inside build dir
    const resolvedPath = resolve(fullPath);
    if (!resolvedPath.startsWith(this.gardenBuildDir)) {
      this.send404(res, path);
      return;
    }

    const ext = extname(resolvedPath).toLowerCase();
    const mimeType = GARDEN_MIME_TYPES[ext];

    readFile(resolvedPath)
      .then((content) => {
        const isHtml = ext === '.html';
        res.writeHead(200, {
          'Content-Type': mimeType ?? 'application/octet-stream',
          'Cache-Control': isHtml ? GARDEN_HTML_CACHE_CONTROL : GARDEN_ASSET_CACHE_CONTROL,
        });
        res.end(content);
      })
      .catch(() => {
        // File not found — serve index.html as SPA fallback
        const indexPath = join(this.gardenBuildDir!, 'index.html');
        readFile(indexPath)
          .then((content) => {
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'Cache-Control': GARDEN_HTML_CACHE_CONTROL,
            });
            res.end(content);
          })
          .catch(() => {
            this.send404(res, path);
          });
      });
  }

  private registerModuleAssetRoute(routePath: string, filePath: string, contentType?: string): string {
    const normalizedPath = this.normalizeFilePath(filePath);
    const resolvedContentType = contentType ?? this.inferContentType(normalizedPath);
    this.moduleAssets.set(routePath, {
      filePath: normalizedPath,
      contentType: resolvedContentType,
    });
    this.moduleRouteByFilePath.set(normalizedPath, routePath);
    return routePath;
  }

  private tryServeStaticAsset(path: string, res: ServerResponse): boolean {
    const staticAsset = this.staticFiles.get(path);
    if (staticAsset) {
      res.writeHead(200, {
        'Content-Type': staticAsset.contentType,
        'Cache-Control': staticAsset.cacheControl,
      });
      res.end(staticAsset.content);
      return true;
    }

    const moduleAsset = this.moduleAssets.get(path);
    if (!moduleAsset) return false;

    const content = this.loadModuleAsset(path, moduleAsset);
    if (!content) {
      this.send404(res, path);
      return true;
    }

    res.writeHead(200, {
      'Content-Type': moduleAsset.contentType,
      'Cache-Control': MODULE_CACHE_CONTROL,
    });
    res.end(content);
    return true;
  }

  private loadModuleAsset(routePath: string, descriptor: ModuleAssetDescriptor): Buffer | null {
    const cached = this.moduleAssetCache.get(routePath);
    if (cached) return cached;

    try {
      let content: Buffer;
      if (descriptor.contentType.startsWith('application/javascript')) {
        const source = readFileSync(descriptor.filePath, 'utf-8');
        const rewritten = this.rewriteModuleImports(source, descriptor.filePath);
        content = Buffer.from(rewritten, 'utf-8');
      } else {
        content = readFileSync(descriptor.filePath);
      }
      this.moduleAssetCache.set(routePath, content);
      return content;
    } catch (error) {
      log.warn('Unable to load module asset', { routePath, filePath: descriptor.filePath, error: String(error) });
      return null;
    }
  }

  private rewriteModuleImports(source: string, parentFilePath: string): string {
    const rewriteMatches = (input: string, pattern: RegExp): string => (
      input.replace(pattern, (match: string, quote: string, specifier: string) => {
        const rewritten = this.rewriteModuleSpecifier(specifier, parentFilePath);
        if (!rewritten) return match;
        return match.replace(`${quote}${specifier}${quote}`, `${quote}${rewritten}${quote}`);
      })
    );

    const staticImportPattern = /\bimport\s+(?:[^'"]*?\sfrom\s*)?(['"])([^'"]+)\1/g;
    const exportFromPattern = /\bexport\s+[^'"]*?\sfrom\s*(['"])([^'"]+)\1/g;
    const dynamicImportPattern = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

    let rewritten = source;
    rewritten = rewriteMatches(rewritten, staticImportPattern);
    rewritten = rewriteMatches(rewritten, exportFromPattern);
    rewritten = rewriteMatches(rewritten, dynamicImportPattern);
    return rewritten;
  }

  private rewriteModuleSpecifier(specifier: string, parentFilePath: string): string | null {
    if (
      specifier.startsWith('http://')
      || specifier.startsWith('https://')
      || specifier.startsWith('data:')
      || specifier.startsWith('blob:')
      || specifier.startsWith('#')
      || specifier.startsWith('node:')
    ) {
      return null;
    }

    const resolvedPath = this.resolveModuleSpecifier(specifier, parentFilePath);
    if (!resolvedPath) {
      log.warn('Unable to resolve browser module specifier', { specifier, parentFilePath });
      return null;
    }

    if (!this.isSupportedModulePath(resolvedPath)) {
      log.warn('Unsupported browser module asset extension', { specifier, resolvedPath });
      return null;
    }

    return this.ensureModuleAssetRoute(resolvedPath);
  }

  private ensureModuleAssetRoute(filePath: string): string | null {
    const normalizedPath = this.normalizeFilePath(filePath);
    const existingRoute = this.moduleRouteByFilePath.get(normalizedPath);
    if (existingRoute) return existingRoute;

    const generatedRoute = this.toGeneratedModuleRoute(normalizedPath);
    if (!generatedRoute) return null;

    this.registerModuleAssetRoute(generatedRoute, normalizedPath);
    return generatedRoute;
  }

  private toGeneratedModuleRoute(filePath: string): string | null {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const marker = '/node_modules/';
    const nodeModulesIndex = normalizedPath.lastIndexOf(marker);
    if (nodeModulesIndex < 0) return null;

    const relativeNodeModulePath = normalizedPath.slice(nodeModulesIndex + marker.length);
    if (relativeNodeModulePath.length === 0) return null;
    const encodedPath = relativeNodeModulePath
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    return `${PI_WEB_UI_MODULE_ROUTE_PREFIX}${encodedPath}`;
  }

  private resolveModuleSpecifier(specifier: string, parentFilePath?: string): string | null {
    try {
      if (parentFilePath) {
        return this.moduleResolver.resolve(specifier, { paths: [dirname(parentFilePath)] });
      }
      return this.moduleResolver.resolve(specifier);
    } catch {
      return null;
    }
  }

  private isSupportedModulePath(filePath: string): boolean {
    return SUPPORTED_MODULE_EXTENSIONS.has(extname(filePath).toLowerCase());
  }

  private inferContentType(filePath: string): string {
    const extension = extname(filePath).toLowerCase();
    if (extension === '.css') return 'text/css; charset=utf-8';
    if (extension === '.json' || extension === '.map') return 'application/json; charset=utf-8';
    if (extension === '.wasm') return 'application/wasm';
    return 'application/javascript';
  }

  private normalizeFilePath(filePath: string): string {
    try {
      return realpathSync(filePath);
    } catch {
      return filePath;
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/admin/events') {
      socket.write('HTTP/1.1 404 Not Found\\r\\n\\r\\n');
      socket.destroy();
      return;
    }

    if (!this.checkUpgradeAuth(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
      socket.destroy();
      return;
    }

    this.telemetryWebSocketServer.handleUpgrade(req, socket, head, (ws) => {
      this.attachTelemetryWebSocket(ws);
    });
  }

  private checkUpgradeAuth(req: IncomingMessage): boolean {
    if (!this.token) return true;
    return this.hasRequestAuthCredentials(req);
  }

  private attachTelemetryWebSocket(ws: WebSocket): void {
    const telemetryEvents: EventName[] = [
      'agent.turn.usage',
      'agent.think.trace',
      'agent.tool.start',
      'agent.tool.end',
      'memory.extraction.end',
      'message.sent',
      'broadcast.approval.required',
      'broadcast.provenance',
      'external.telemetry.ingested',
      'agent.tools.adaptive.decision',
      'agent.tools.adaptive.snapshot',
      'wyoming.session.start',
      'wyoming.session.end',
      'wyoming.policy.violation',
    ];

    const unsubscribers: Array<() => void> = [];
    for (const eventName of telemetryEvents) {
      const unsub = this.eventBus.on(eventName, (data: EventMap[typeof eventName]) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const correlation = this.resolveTelemetryCorrelation(eventName, data);
        ws.send(JSON.stringify({
          type: eventName,
          timestamp: Date.now(),
          correlation,
          data,
        }));
      });
      unsubscribers.push(unsub);
    }

    const cleanup = (): void => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  private resolveTelemetryCorrelation<E extends EventName>(
    eventName: E,
    data: EventMap[E],
  ): Partial<CorrelationMetadata> {
    const payload = data as Record<string, unknown>;
    const nestedMessage = asRecord(payload.message);
    const nestedResponse = asRecord(payload.response);
    const nestedExternalEvent = asRecord(payload.event);
    const turnId = readString(payload.turnId) ?? readString(nestedMessage?.id);
    const requestId = readString(payload.requestId) ?? turnId;
    const channelId = readString(payload.channelId)
      ?? readString(nestedMessage?.channelId)
      ?? readString(nestedResponse?.channelId)
      ?? readString(nestedExternalEvent?.channelId);
    const callType = normalizeCallType(readString(payload.callType))
      ?? inferTelemetryCallType(eventName);
    const originType = normalizeCallType(readString(payload.originType))
      ?? callType;
    const toolName = readString(payload.toolName);
    const toolCallId = readString(payload.toolCallId);
    const purpose = readString(payload.purpose) ?? eventName;
    const originStage = readString(payload.originStage) ?? purpose;

    return {
      ...(turnId ? { turnId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(callType ? { callType } : {}),
      ...(originType ? { originType } : {}),
      ...(originStage ? { originStage } : {}),
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(purpose ? { purpose } : {}),
    };
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
              const encodedToken = encodeURIComponent(token);
              sendRedirect(res, GARDEN_PREFIX, 302, {
                'Set-Cookie': `psfn_token=${encodedToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
              });
            } else {
              this.sendHtml(res, this.handlers.loginPage('Invalid token'));
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
      { method: 'GET', match: exactPath('/'), handle: (_req, res) => this.sendHtml(res, this.handlers.domains.dashboard.dashboard()) },
      {
        method: 'GET',
        match: exactPath('/memory'),
        handle: (req, res) => {
          const url = new URL(req.url ?? '/memory', `http://${req.headers.host ?? 'localhost'}`);
          this.sendHtml(res, this.handlers.domains.memory.memoryList(url.searchParams));
        },
      },
      {
        method: 'GET',
        match: prefixedParamPath('/memory/', 'id', { exclude: (path) => path.startsWith('/memory/search') }),
        handle: (_req, res, { id }) => {
          const html = this.handlers.domains.memory.memoryDetail(id);
          if (!html) {
            this.send404(res, `/memory/${encodeURIComponent(id)}`);
            return;
          }
          this.sendHtml(res, html);
        },
      },
      { method: 'GET', match: exactPath('/sessions'), handle: (_req, res) => this.sendHtml(res, this.handlers.domains.sessions.sessionList()) },
      {
        method: 'GET',
        match: prefixedParamPath('/sessions/', 'channelId', { exclude: (path) => path.includes('/api/') }),
        handle: (_req, res, { channelId }) => this.sendHtml(res, this.handlers.domains.sessions.sessionMessages(channelId)),
      },
      { method: 'GET', match: exactPath('/scheduler'), handle: (_req, res) => this.sendHtml(res, this.handlers.schedulerPage()) },
      { method: 'GET', match: exactPath('/shards'), handle: (_req, res) => this.sendHtml(res, this.handlers.shardsPage()) },
      { method: 'GET', match: exactPath('/contacts'), handle: (_req, res) => this.sendHtml(res, this.handlers.domains.contacts.contactsPage()) },
      { method: 'GET', match: exactPath('/chat'), handle: (_req, res) => this.sendHtml(res, this.handlers.domains.chat.chatPage()) },
      {
        method: 'GET',
        match: exactPath('/confirmations'),
        handle: (_req, res) => {
          this.handlers.domains.confirmations.confirmationsPage().then(
            (html) => this.sendHtml(res, html),
            (err) => this.send500('Confirmations page error', err, res),
          );
        },
      },
      { method: 'GET', match: exactPath('/identity'), handle: (_req, res) => this.sendHtml(res, this.handlers.domains.identity.identityPage()) },
      {
        method: 'POST',
        match: exactPath('/api/identity/import'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.handlers.domains.identity.importIdentityCard(body).then(
              (html) => this.sendFragment(res, html),
              (err) => this.send500('Identity import error', err, res),
            );
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/identity/intake/stage'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.identity.stageIdentityIntake(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/identity/intake/commit'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.handlers.domains.identity.commitIdentityIntake(body).then(
              (html) => this.sendFragment(res, html),
              (err) => this.send500('Identity intake commit error', err, res),
            );
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/identity/card/rollback'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.identity.rollbackIdentityCard(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/identity/card/diff'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.identity.previewIdentityCardDiff(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/settings'),
        handle: (_req, res) => {
          this.handlers.domains.settings.settingsPage().then(
            (html) => this.sendHtml(res, html),
            (err) => this.send500('Settings page error', err, res),
          );
        },
      },
      { method: 'GET', match: exactPath('/skills'), handle: (_req, res) => this.sendHtml(res, this.handlers.domains.settings.skillsPage()) },
      {
        method: 'GET',
        match: exactPath('/events'),
        handle: (req, res) => {
          const url = new URL(req.url ?? '/events', `http://${req.headers.host ?? 'localhost'}`);
          this.sendHtml(res, this.handlers.domains.events.eventsPageHtml(url.searchParams));
        },
      },
      { method: 'GET', match: exactPath('/values'), handle: (_req, res) => this.sendHtml(res, this.handlers.domains.events.valuesTimelinePageHtml()) },
      { method: 'GET', match: exactPath('/primer'), handle: (_req, res) => this.sendHtml(res, this.handlers.primerPage()) },
      {
        method: 'GET',
        match: exactPath('/api/memory/list'),
        handle: (req, res) => {
          const url = new URL(req.url ?? '/api/memory/list', `http://${req.headers.host ?? 'localhost'}`);
          this.sendFragment(res, this.handlers.domains.memory.memoryListFragment(url.searchParams));
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/memory/search'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            const params = new URLSearchParams(body);
            const query = params.get('query') ?? '';
            this.handlers.domains.memory.memorySearch(query).then(
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
        handle: (_req, res, { id }) => this.sendFragment(res, this.handlers.domains.memory.memorySupersede(id)),
      },
      {
        method: 'GET',
        match: wrappedParamPath('/api/sessions/', '/messages', 'channelId'),
        handle: (_req, res, { channelId }) => this.sendFragment(res, this.handlers.domains.sessions.sessionMessagesFragment(channelId)),
      },
      {
        method: 'GET',
        match: exactPath('/api/chat/bootstrap'),
        handle: (req, res) => sendJson(
          res,
          200,
          this.handlers.domains.chat.chatBootstrap(this.resolveRequestOrigin(req)),
        ),
      },
      {
        method: 'GET',
        match: exactPath('/api/chat/model-room/bootstrap'),
        handle: (req, res) => sendJson(
          res,
          200,
          this.handlers.domains.chat.chatModelRoomBootstrap(this.resolveRequestOrigin(req)),
        ),
      },
      {
        method: 'GET',
        match: exactPath('/api/chat/events/stream'),
        handle: (req, res) => {
          const url = new URL(req.url ?? '/api/chat/events/stream', `http://${req.headers.host ?? 'localhost'}`);
          const channelId = url.searchParams.get('channelId') ?? undefined;
          const cleanup = this.handlers.domains.chat.setupChatDebugSSE(res, { channelId });
          req.on('close', cleanup);
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/chat/bootstrap'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            try {
              const payload = this.handlers.domains.chat.updateChatBootstrap(
                body,
                req.headers['content-type'],
                this.resolveRequestOrigin(req),
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
          this.handlers.domains.confirmations.confirmationsListFragment().then(
            (html) => this.sendFragment(res, html),
            (err) => this.send500('Confirmation queue list error', err, res),
          );
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/confirmations/resolve'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.handlers.domains.confirmations.resolveConfirmation(body).then(
              (html) => this.sendFragment(res, html),
              (err) => this.send500('Confirmation queue resolve error', err, res),
            );
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/contacts/list'),
        handle: (_req, res) => this.sendFragment(res, this.handlers.domains.contacts.contactsListFragment()),
      },
      {
        method: 'GET',
        match: exactPath('/api/contacts/mutations'),
        handle: (req, res) => {
          const url = new URL(req.url ?? '/api/contacts/mutations', `http://${req.headers.host ?? 'localhost'}`);
          this.sendFragment(res, this.handlers.domains.contacts.contactMutationAuditFragment(url.searchParams));
        },
      },
      {
        method: 'GET',
        match: wrappedParamPath('/api/contacts/', '/edit', 'contactId'),
        handle: (_req, res, { contactId }) => this.sendFragment(res, this.handlers.domains.contacts.contactEditFormFragment(contactId)),
      },
      {
        method: 'POST',
        match: prefixedParamPath('/api/contacts/', 'contactId', { exclude: (path) => path.endsWith('/edit') }),
        handle: (req, res, { contactId }) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.contacts.handleContactUpdate(contactId, body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/settings'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.settings.updateSettings(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/settings/models'),
        handle: (_req, res) => sendText(res, 200, this.handlers.domains.settings.modelsConfigJson(), {
          'Content-Type': 'application/json',
        }),
      },
      {
        method: 'POST',
        match: exactPath('/api/settings/models'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.settings.updateModelsConfig(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/settings/skills'),
        handle: (_req, res) => sendText(res, 200, this.handlers.domains.settings.skillsConfigJson(), {
          'Content-Type': 'application/json',
        }),
      },
      {
        method: 'POST',
        match: exactPath('/api/settings/skills'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.settings.updateSkillsConfig(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/settings/scheduler'),
        handle: (_req, res) => sendText(res, 200, this.handlers.domains.settings.schedulerConfigJson(), {
          'Content-Type': 'application/json',
        }),
      },
      {
        method: 'POST',
        match: exactPath('/api/settings/scheduler'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.settings.updateSchedulerConfig(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/settings/trust-policy'),
        handle: (_req, res) => sendText(res, 200, this.handlers.domains.settings.trustPolicyConfigJson(), {
          'Content-Type': 'application/json',
        }),
      },
      {
        method: 'POST',
        match: exactPath('/api/settings/trust-policy'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.settings.updateTrustPolicyConfig(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/settings/capabilities'),
        handle: (_req, res) => sendText(res, 200, this.handlers.domains.settings.capabilitiesConfigJson(), {
          'Content-Type': 'application/json',
        }),
      },
      {
        method: 'POST',
        match: exactPath('/api/settings/capabilities'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.settings.updateCapabilitiesConfig(body));
          });
        },
      },
      {
        method: 'GET',
        match: exactPath('/api/models'),
        handle: (_req, res) => {
          this.handlers.domains.settings.modelListJson().then(
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
          this.handlers.domains.settings.refreshModels().then(
            (json) => sendText(res, 200, json, { 'Content-Type': 'application/json' }),
            (err) => {
              log.error('Model refresh error', { error: String(err) });
              sendText(res, 200, '[]', { 'Content-Type': 'application/json' });
            },
          );
        },
      },
      // ── JSON API: Settings (for SvelteKit Garden UI) ──
      {
        method: 'GET',
        match: exactPath('/api/admin/settings'),
        handle: (_req, res) => {
          this.settingsService.getSettingsData().then(
            (data) => sendText(res, 200, JSON.stringify(data), { 'Content-Type': 'application/json' }),
            (err) => {
              log.error('Settings data error', { error: String(err) });
              sendText(res, 500, JSON.stringify({ error: 'Failed to load settings' }), { 'Content-Type': 'application/json' });
            },
          );
        },
      },
      {
        method: 'PATCH',
        match: exactPath('/api/admin/settings'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            const result = this.settingsService.updateSettings(body);
            sendText(res, result.ok ? 200 : 400, JSON.stringify(result), { 'Content-Type': 'application/json' });
          });
        },
      },
      { method: 'GET', match: exactPath('/prompts'), handle: (_req, res) => this.sendHtml(res, this.handlers.domains.prompts.promptsPage()) },
      {
        method: 'GET',
        match: prefixedParamPath('/prompts/static/', 'key'),
        handle: (_req, res, { key }) => {
          const html = this.handlers.domains.prompts.promptRegistryDetail(key);
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
          const html = this.handlers.domains.prompts.promptDetail(layerId);
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
            this.sendFragment(res, this.handlers.domains.prompts.updatePromptLayer(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/static/update'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.prompts.updatePromptRegistry(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/toggle'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.prompts.togglePromptLayer(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/rollback'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.prompts.rollbackPromptLayer(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/static/rollback'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.prompts.rollbackPromptRegistry(body));
          });
        },
      },
      {
        method: 'POST',
        match: exactPath('/api/prompts/diff'),
        handle: (req, res) => {
          this.withBody(req, res, (body) => {
            this.sendFragment(res, this.handlers.domains.prompts.previewPromptLayerDiff(body));
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
          const cleanup = this.handlers.domains.events.setupSSE(res);
          req.on('close', cleanup);
        },
      },
      ...buildAdminApiRoutes({
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
        appendAuditTimelineEntry: (actionType, decision, narrative, details = [], actor) => {
          this.handlers.appendAuditTimelineEntry(actionType, decision, narrative, details, actor);
        },
        withBody: (req, res, cb) => this.withBody(req, res, cb),
      }),
    ];
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.token) return true;
    if (this.hasRequestAuthCredentials(req)) {
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

  private hasRequestAuthCredentials(req: IncomingMessage): boolean {
    if (!this.token) return true;
    if (hasBearerToken(req, this.token)) return true;
    return hasCookieValue(req, 'psfn_token', this.token);
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

  private resolveRequestOrigin(req: IncomingMessage): string | undefined {
    const forwardedHost = req.headers['x-forwarded-host'];
    const rawHost = (
      Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost
    ) ?? req.headers.host;
    const host = rawHost?.split(',')[0]?.trim();
    if (!host) {
      return undefined;
    }

    const forwardedProto = req.headers['x-forwarded-proto'];
    const rawProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    const protoToken = rawProto?.split(',')[0]?.trim().toLowerCase();
    const protocol = protoToken === 'https' ? 'https' : 'http';

    try {
      return new URL(`${protocol}://${host}`).origin;
    } catch {
      return undefined;
    }
  }

  private send500(context: string, err: unknown, res: ServerResponse): void {
    log.error(context, { error: String(err) });
    if (res.writableEnded || res.destroyed) return;
    sendText(res, 500, 'Internal Server Error');
  }
}
