import type { ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { sendText } from '../http/primitives.js';


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

interface StaticAsset {
  content: Buffer;
  contentType: string;
  cacheControl: string;
}

interface ModuleAssetDescriptor {
  filePath: string;
  contentType: string;
}

interface AdminServerTransportLogger {
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export class AdminServerTransport {
  private staticFiles = new Map<string, StaticAsset>();
  private moduleAssets = new Map<string, ModuleAssetDescriptor>();
  private moduleAssetCache = new Map<string, Buffer>();
  private moduleRouteByFilePath = new Map<string, string>();
  private moduleResolver = createRequire(import.meta.url);
  private gardenBuildDir: string | null = null;

  constructor(private readonly log: AdminServerTransportLogger) {}

  initialize(): void {
    this.initializePiWebUiRoutes();
    this.initializeGardenUi();
  }

  isGardenUiEnabled(): boolean {
    return this.gardenBuildDir !== null;
  }

  tryServeStaticAsset(path: string, res: ServerResponse): boolean {
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
      sendText(res, 404, `Not found: ${path}`);
      return true;
    }

    res.writeHead(200, {
      'Content-Type': moduleAsset.contentType,
      'Cache-Control': MODULE_CACHE_CONTROL,
    });
    res.end(content);
    return true;
  }

  serveGardenAsset(path: string, res: ServerResponse): void {
    if (!this.gardenBuildDir) {
      sendText(res, 404, `Not found: ${path}`);
      return;
    }

    // Use path directly; unknown paths fall back to index.html as SPA shell.
    let filePath = path === '' || path === '/' ? '/index.html' : path;

    // Normalize and resolve within the build directory
    const normalizedPath = normalize(filePath);
    const fullPath = join(this.gardenBuildDir, normalizedPath);

    // Prevent directory traversal: resolved path must be inside build dir
    const resolvedPath = resolve(fullPath);
    if (!resolvedPath.startsWith(this.gardenBuildDir)) {
      sendText(res, 404, `Not found: ${path}`);
      return;
    }

    const ext = extname(resolvedPath).toLowerCase();
    const mimeType = GARDEN_MIME_TYPES[ext];

    readFile(resolvedPath)
      .then((content) => {
        const isHtml = ext === '.html';
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Cache-Control': isHtml ? GARDEN_HTML_CACHE_CONTROL : GARDEN_ASSET_CACHE_CONTROL,
        });
        res.end(content);
      })
      .catch((fileErr) => {
        // File not found — serve index.html as SPA fallback
        if ((fileErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.log.debug('Garden asset read error', { path, error: String(fileErr) });
        }
        const indexPath = join(this.gardenBuildDir!, 'index.html');
        readFile(indexPath)
          .then((content) => {
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'Cache-Control': GARDEN_HTML_CACHE_CONTROL,
            });
            res.end(content);
          })
          .catch((indexErr) => {
            this.log.debug('Garden SPA fallback failed', { error: String(indexErr) });
            sendText(res, 404, `Not found: ${path}`);
          });
      });
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
      this.log.warn('pi-web-ui entry module not found; /chat ESM runtime route disabled');
      return;
    }

    this.registerModuleAssetRoute(PI_WEB_UI_ENTRY_ROUTE, entryPath, 'application/javascript');

    const stylePath = this.resolveModuleSpecifier(PI_WEB_UI_STYLE_SPECIFIER);
    if (!stylePath) {
      this.log.warn('pi-web-ui stylesheet not found; /chat ESM stylesheet route disabled');
      return;
    }

    this.registerModuleAssetRoute(PI_WEB_UI_STYLE_ROUTE, stylePath, 'text/css; charset=utf-8');
  }

  private initializeGardenUi(): void {
    // Resolve admin-ui/build relative to project root (3 dirs up from src/channels/admin/)
    const projectRoot = resolve(import.meta.dirname, '..', '..', '..');
    const buildDir = join(projectRoot, 'admin-ui', 'build');
    if (!existsSync(buildDir)) {
      this.log.warn('admin-ui/build not found; Garden UI route disabled. Run "cd admin-ui && npm run build" to enable.');
      return;
    }
    const indexPath = join(buildDir, 'index.html');
    if (!existsSync(indexPath)) {
      this.log.warn('admin-ui/build/index.html not found; Garden UI route disabled');
      return;
    }
    this.gardenBuildDir = buildDir;
    this.log.info('Garden SvelteKit UI enabled at /garden/*');
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
      this.log.warn('Unable to load module asset', { routePath, filePath: descriptor.filePath, error: String(error) });
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
      this.log.warn('Unable to resolve browser module specifier', { specifier, parentFilePath });
      return null;
    }

    if (!this.isSupportedModulePath(resolvedPath)) {
      this.log.warn('Unsupported browser module asset extension', { specifier, resolvedPath });
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
}
