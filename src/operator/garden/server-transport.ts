import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { sendText } from '../../channels/backplane/http/primitives.js';

const GARDEN_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const GARDEN_HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const GARDEN_ASSET_CACHE_CONTROL = 'public, max-age=86400';
// Content-hashed /_app/immutable/* assets never change under a fixed URL, so
// they are safe to cache for a year without revalidation.
const GARDEN_IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const GARDEN_IMMUTABLE_PREFIX = '/_app/immutable/';

// Extensions whose payloads are worth compressing on the wire.
const GARDEN_COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.css', '.svg', '.json', '.map']);
// Below this size on-the-fly compression is not worth the header + CPU cost.
// Precompressed siblings emitted by the build are still served regardless.
const GARDEN_MIN_COMPRESS_BYTES = 1024;
// Cap on the in-memory on-the-fly compression memo. Static asset counts are
// small; this is a safety valve against unbounded growth.
const GARDEN_COMPRESSION_CACHE_MAX_ENTRIES = 512;

type WireEncoding = 'br' | 'gzip';

interface AdminServerTransportLogger {
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

interface CompressedEntry {
  buffer: Buffer;
}

/**
 * Parse an Accept-Encoding header and choose the best supported wire encoding.
 * Brotli is preferred over gzip when both are acceptable at equal quality.
 * Returns null when the client accepts neither (or only at q=0).
 */
function selectWireEncoding(req: IncomingMessage): WireEncoding | null {
  const rawHeader = req.headers['accept-encoding'];
  const header = Array.isArray(rawHeader) ? rawHeader.join(',') : rawHeader;
  if (!header) return null;

  const accepted = new Map<string, number>();
  for (const part of header.split(',')) {
    const [rawEncoding, ...rawParams] = part.trim().split(';');
    const encoding = rawEncoding.trim().toLowerCase();
    if (!encoding) continue;
    const qParam = rawParams
      .map(param => param.trim())
      .find(param => param.toLowerCase().startsWith('q='));
    const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q < 0) continue;
    accepted.set(encoding, q);
  }

  const brotliQ = accepted.has('br') ? accepted.get('br')! : (accepted.get('*') ?? 0);
  const gzipQ = accepted.has('gzip') ? accepted.get('gzip')! : (accepted.get('*') ?? 0);
  if (brotliQ <= 0 && gzipQ <= 0) return null;
  return brotliQ >= gzipQ ? 'br' : 'gzip';
}

export class AdminServerTransport {
  private gardenBuildDir: string | null = null;
  // On-the-fly compression memo keyed by path + mtime + size + encoding so a
  // given file version is compressed at most once per encoding.
  private readonly compressionCache = new Map<string, CompressedEntry>();

  constructor(private readonly log: AdminServerTransportLogger) {}

  initialize(): void {
    this.initializeGardenUi();
  }

  isGardenUiEnabled(): boolean {
    return this.gardenBuildDir !== null;
  }

  serveGardenPage(path: string, req: IncomingMessage, res: ServerResponse): void {
    this.serveGardenPath(path, req, res, { spaFallback: true });
  }

  serveGardenBuildAsset(path: string, req: IncomingMessage, res: ServerResponse): void {
    this.serveGardenPath(path, req, res, { spaFallback: false });
  }

  private serveGardenPath(
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
    options: { spaFallback: boolean },
  ): void {
    if (!this.gardenBuildDir) {
      sendText(res, 404, `Not found: ${path}`);
      return;
    }

    // Use path directly; unknown paths fall back to index.html as SPA shell.
    const filePath = path === '' || path === '/' ? '/index.html' : path;

    // Normalize and resolve within the build directory
    const normalizedPath = normalize(filePath);
    const fullPath = join(this.gardenBuildDir, normalizedPath);

    // Prevent directory traversal: resolved path must be inside build dir
    const resolvedPath = resolve(fullPath);
    if (!resolvedPath.startsWith(this.gardenBuildDir)) {
      sendText(res, 404, `Not found: ${path}`);
      return;
    }

    const isImmutable = path.startsWith(GARDEN_IMMUTABLE_PREFIX);

    this.respondWithFile(resolvedPath, req, res, { cacheControlOverride: undefined, isImmutable })
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
        this.respondWithFile(indexPath, req, res, {
          cacheControlOverride: GARDEN_HTML_CACHE_CONTROL,
          isImmutable: false,
        }).catch((indexErr) => {
          this.log.debug('Garden SPA fallback failed', { error: String(indexErr) });
          sendText(res, 404, `Not found: ${path}`);
        });
      });
  }

  /**
   * Stat, negotiate encoding, honor If-None-Match, and send a static file.
   * Rejects with the underlying fs error (e.g. ENOENT) so the caller can drive
   * SPA fallback / 404 behavior.
   */
  private async respondWithFile(
    resolvedPath: string,
    req: IncomingMessage,
    res: ServerResponse,
    context: { cacheControlOverride: string | undefined; isImmutable: boolean },
  ): Promise<void> {
    const fileStat = await stat(resolvedPath);

    const ext = extname(resolvedPath).toLowerCase();
    const mimeType = GARDEN_MIME_TYPES[ext];
    const isHtml = ext === '.html';
    const compressible = GARDEN_COMPRESSIBLE_EXTENSIONS.has(ext);

    const cacheControl = context.cacheControlOverride
      ?? (isHtml
        ? GARDEN_HTML_CACHE_CONTROL
        : context.isImmutable
          ? GARDEN_IMMUTABLE_CACHE_CONTROL
          : GARDEN_ASSET_CACHE_CONTROL);

    // Negotiate an on-the-wire encoding: prefer a precompressed sibling emitted
    // by the build, otherwise compress text payloads on the fly (and memoize).
    const requested = compressible ? selectWireEncoding(req) : null;
    let encoding: WireEncoding | null = null;
    let body: Buffer | null = null;

    if (requested) {
      const sibling = requested === 'br' ? `${resolvedPath}.br` : `${resolvedPath}.gz`;
      if (existsSync(sibling)) {
        encoding = requested;
        body = await readFile(sibling);
      } else if (fileStat.size >= GARDEN_MIN_COMPRESS_BYTES) {
        encoding = requested;
        body = await this.compressOnTheFly(resolvedPath, fileStat.mtimeMs, fileStat.size, requested);
      }
    }

    // ETag identifies the exact representation: base version (size + mtime) plus
    // the content-encoding, since Vary: Accept-Encoding means caches key on both.
    const baseTag = `${fileStat.size.toString(16)}-${Math.trunc(fileStat.mtimeMs).toString(16)}`;
    const etag = `"${baseTag}${encoding ? `-${encoding}` : ''}"`;

    const headers: Record<string, string> = {
      'Cache-Control': cacheControl,
      ETag: etag,
    };
    if (mimeType) headers['Content-Type'] = mimeType;
    if (compressible) headers.Vary = 'Accept-Encoding';

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && this.ifNoneMatchSatisfied(ifNoneMatch, etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    if (encoding && body) {
      headers['Content-Encoding'] = encoding;
      headers['Content-Length'] = String(body.length);
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    const content = await readFile(resolvedPath);
    headers['Content-Length'] = String(content.length);
    res.writeHead(200, headers);
    res.end(content);
  }

  private async compressOnTheFly(
    resolvedPath: string,
    mtimeMs: number,
    size: number,
    encoding: WireEncoding,
  ): Promise<Buffer> {
    const key = `${resolvedPath} ${Math.trunc(mtimeMs)} ${size} ${encoding}`;
    const cached = this.compressionCache.get(key);
    if (cached) return cached.buffer;

    const content = await readFile(resolvedPath);
    const buffer = encoding === 'br' ? brotliCompressSync(content) : gzipSync(content);

    if (this.compressionCache.size >= GARDEN_COMPRESSION_CACHE_MAX_ENTRIES) {
      this.compressionCache.clear();
    }
    this.compressionCache.set(key, { buffer });
    return buffer;
  }

  private ifNoneMatchSatisfied(header: string | string[], etag: string): boolean {
    const raw = Array.isArray(header) ? header.join(',') : header;
    if (raw.trim() === '*') return true;
    // Compare against both the strong tag and its weak form; the client may echo
    // either back on a conditional request.
    const weak = `W/${etag}`;
    for (const candidate of raw.split(',')) {
      const value = candidate.trim();
      if (value === etag || value === weak) return true;
    }
    return false;
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
