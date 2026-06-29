import type { ServerResponse } from 'node:http';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { sendText } from '../../channels/backplane/http/primitives.js';

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

interface AdminServerTransportLogger {
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export class AdminServerTransport {
  private gardenBuildDir: string | null = null;

  constructor(private readonly log: AdminServerTransportLogger) {}

  initialize(): void {
    this.initializeGardenUi();
  }

  isGardenUiEnabled(): boolean {
    return this.gardenBuildDir !== null;
  }

  serveGardenPage(path: string, res: ServerResponse): void {
    this.serveGardenPath(path, res, { spaFallback: true });
  }

  serveGardenBuildAsset(path: string, res: ServerResponse): void {
    this.serveGardenPath(path, res, { spaFallback: false });
  }

  private serveGardenPath(
    path: string,
    res: ServerResponse,
    options: { spaFallback: boolean },
  ): void {
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
        if (!options.spaFallback) {
          sendText(res, 404, `Not found: ${path}`);
          return;
        }

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

  private initializeGardenUi(): void {
    const buildDir = this.resolveGardenBuildDir();
    if (!buildDir) {
      return;
    }

    this.gardenBuildDir = realpathSync(buildDir);
    this.log.info('Garden SvelteKit UI enabled at /*');
  }

  private resolveGardenBuildDir(): string | null {
    const candidateBuildDirs = [
      join(process.cwd(), 'admin-ui', 'build'),
      join(resolve(import.meta.dirname, '..', '..', '..'), 'admin-ui', 'build'),
    ];
    const checkedBuildDirs: string[] = [];

    for (const candidate of candidateBuildDirs) {
      const buildDir = resolve(candidate);
      if (checkedBuildDirs.includes(buildDir)) continue;
      checkedBuildDirs.push(buildDir);

      if (!existsSync(buildDir)) continue;

      const indexPath = join(buildDir, 'index.html');
      if (existsSync(indexPath)) {
        return buildDir;
      }

      this.log.warn('admin-ui/build/index.html not found; Garden UI route disabled', {
        buildDir,
      });
    }

    this.log.warn('admin-ui/build not found; Garden UI route disabled. Run "cd admin-ui && npm run build" to enable.', {
      checkedBuildDirs,
    });
    return null;
  }
}
