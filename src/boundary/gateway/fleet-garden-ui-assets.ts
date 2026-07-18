import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const FLEET_ASSET_PREFIX = '/fleet/_app/';
const BUILD_ASSET_PREFIX = '/_app/';
const SHARED_ASSET_PREFIX = '/_app/';
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

export interface FleetGardenUiAssetsPort {
  isEnabled(): boolean;
  servePage(request: IncomingMessage, response: ServerResponse): void;
  serveAsset(path: string, request: IncomingMessage, response: ServerResponse): void;
}

function baseHeaders(contentType: string, contentLength: number): Record<string, string> {
  return {
    'Content-Length': String(contentLength),
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), display-capture=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function sendNotFound(response: ServerResponse): void {
  const body = Buffer.from('Not found', 'utf8');
  response.writeHead(404, {
    ...baseHeaders('text/plain; charset=utf-8', body.byteLength),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendUnavailable(response: ServerResponse): void {
  const body = Buffer.from('Fleet Garden unavailable', 'utf8');
  response.writeHead(503, {
    ...baseHeaders('text/plain; charset=utf-8', body.byteLength),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function isMissingAsset(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function pageContentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)]
    .map(match => match[1])
    .filter(source => source.length > 0)
    .map(source => `'sha256-${createHash('sha256').update(source).digest('base64')}'`);
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' https://fonts.gstatic.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    `script-src 'self'${hashes.length > 0 ? ` ${hashes.join(' ')}` : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "worker-src 'self' blob:",
  ].join('; ');
}

export class FleetGardenUiAssets implements FleetGardenUiAssetsPort {
  private readonly buildDir: string | null;

  constructor(explicitBuildDir?: string) {
    this.buildDir = this.resolveBuildDir(explicitBuildDir);
  }

  isEnabled(): boolean {
    return this.buildDir !== null;
  }

  servePage(_request: IncomingMessage, response: ServerResponse): void {
    if (!this.buildDir) {
      sendNotFound(response);
      return;
    }
    void readFile(join(this.buildDir, 'index.html'))
      .then((source) => {
        // Adapter-static emits root-absolute immutable asset references. Bind
        // them beneath /fleet so the gateway can serve the shared bundle
        // without a target-less Garden data route.
        const html = source.toString('utf8').replaceAll('/_app/', FLEET_ASSET_PREFIX);
        const body = Buffer.from(html, 'utf8');
        response.writeHead(200, {
          ...baseHeaders('text/html; charset=utf-8', body.byteLength),
          'Cache-Control': 'no-store',
          'Content-Security-Policy': pageContentSecurityPolicy(html),
          Expires: '0',
          Pragma: 'no-cache',
          Vary: 'Cookie',
        });
        response.end(body);
      })
      .catch((error: unknown) => {
        if (isMissingAsset(error)) sendNotFound(response);
        else sendUnavailable(response);
      });
  }

  serveAsset(path: string, request: IncomingMessage, response: ServerResponse): void {
    const publicPrefix = path.startsWith(FLEET_ASSET_PREFIX)
      ? FLEET_ASSET_PREFIX
      : path.startsWith(SHARED_ASSET_PREFIX)
        ? SHARED_ASSET_PREFIX
        : undefined;
    if (!this.buildDir || !publicPrefix) {
      sendNotFound(response);
      return;
    }
    const buildPath = `${BUILD_ASSET_PREFIX}${path.slice(publicPrefix.length)}`;
    const normalized = normalize(buildPath);
    const resolvedPath = resolve(join(this.buildDir, normalized));
    const immutableRoot = resolve(join(this.buildDir, BUILD_ASSET_PREFIX));
    if (!resolvedPath.startsWith(`${immutableRoot}/`)) {
      sendNotFound(response);
      return;
    }
    void this.sendAsset(resolvedPath, request, response)
      .catch((error: unknown) => {
        if (isMissingAsset(error)) sendNotFound(response);
        else sendUnavailable(response);
      });
  }

  private async sendAsset(
    resolvedPath: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const identity = await stat(resolvedPath);
    const accepts = typeof request.headers['accept-encoding'] === 'string'
      ? request.headers['accept-encoding']
      : '';
    const encodedPath = accepts.includes('br') && existsSync(`${resolvedPath}.br`)
      ? `${resolvedPath}.br`
      : accepts.includes('gzip') && existsSync(`${resolvedPath}.gz`)
        ? `${resolvedPath}.gz`
        : resolvedPath;
    const encoding = encodedPath.endsWith('.br')
      ? 'br'
      : encodedPath.endsWith('.gz')
        ? 'gzip'
        : undefined;
    const body = await readFile(encodedPath);
    const extension = extname(resolvedPath).toLowerCase();
    const etag = `W/"${identity.size.toString(16)}-${identity.mtimeMs.toString(16)}${encoding ? `-${encoding}` : ''}"`;
    const headers: Record<string, string> = {
      ...baseHeaders(MIME_TYPES[extension] ?? 'application/octet-stream', body.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      Vary: 'Accept-Encoding',
    };
    if (encoding) headers['Content-Encoding'] = encoding;
    if (request.headers['if-none-match'] === etag) {
      delete headers['Content-Length'];
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, headers);
    response.end(body);
  }

  private resolveBuildDir(explicitBuildDir: string | undefined): string | null {
    const candidates = explicitBuildDir
      ? [explicitBuildDir]
      : [
          join(process.cwd(), 'admin-ui', 'build'),
          join(resolve(import.meta.dirname, '..', '..', '..'), 'admin-ui', 'build'),
        ];
    for (const candidate of candidates) {
      const buildDir = resolve(candidate);
      if (existsSync(join(buildDir, 'index.html'))) return buildDir;
    }
    return null;
  }
}
