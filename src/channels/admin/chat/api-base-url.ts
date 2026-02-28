const DEFAULT_ADMIN_CHAT_API_HOST = '127.0.0.1';
const DEFAULT_ADMIN_CHAT_API_PORT = 3000;
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Sentinel value for "no API base URL configured — use relative paths".
 * When this is the resolved base URL, `buildAbsoluteAdminChatApiUrl` returns
 * just the path, which browsers resolve against `window.location.origin`.
 */
export const RELATIVE_BASE_URL = '';

interface ResolveAdminChatApiBaseUrlOptions {
  explicitApiBaseUrl?: string;
  apiHost?: string;
  apiPort?: number;
  browserOrigin?: string;
}

function normalizeTrimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAbsoluteHttpUrl(value: string | undefined): string | undefined {
  const trimmed = normalizeTrimmed(value);
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizePort(value: number | undefined): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (value <= 0 || value > 65535) return undefined;
  return Math.floor(value);
}

function normalizeBrowserOrigin(value: string | undefined): URL | undefined {
  const trimmed = normalizeTrimmed(value);
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return undefined;
  }
}

function formatHostForUrl(host: string): string {
  if (host.includes(':') && !(host.startsWith('[') && host.endsWith(']'))) {
    return `[${host}]`;
  }
  return host;
}

/**
 * Resolve the base URL for Garden Chat API endpoints.
 *
 * Resolution order:
 *  1. Explicit absolute URL (`explicitApiBaseUrl`) — returned verbatim.
 *  2. When `apiPort` is provided and `apiHost` is a wildcard bind address
 *     (0.0.0.0, ::), substitute with the browser's origin hostname so the
 *     URL is browser-reachable.
 *  3. When `apiPort` is provided with a routable `apiHost`, build an
 *     absolute http URL from that host+port.
 *  4. When `apiPort` is NOT provided, return `RELATIVE_BASE_URL` (empty
 *     string) so that `buildAbsoluteAdminChatApiUrl` produces a relative
 *     path that browsers resolve against `window.location.origin`.
 */
export function resolveAdminChatApiBaseUrl(options: ResolveAdminChatApiBaseUrlOptions = {}): string {
  const explicit = normalizeAbsoluteHttpUrl(options.explicitApiBaseUrl);
  if (explicit) return explicit;

  const apiPort = normalizePort(options.apiPort);
  const apiHost = normalizeTrimmed(options.apiHost);
  const browserOrigin = normalizeBrowserOrigin(options.browserOrigin);

  // No API port configured — we cannot construct an absolute URL, so
  // fall back to relative paths.  The browser resolves them against its
  // current origin which works when the admin server proxies the API or
  // when admin and API share the same port (e.g. single-process mode).
  if (apiPort === undefined) {
    return RELATIVE_BASE_URL;
  }

  if (apiHost && WILDCARD_BIND_HOSTS.has(apiHost.toLowerCase())) {
    if (browserOrigin) {
      return `${browserOrigin.protocol}//${formatHostForUrl(browserOrigin.hostname)}:${apiPort}`;
    }
    return `http://${DEFAULT_ADMIN_CHAT_API_HOST}:${apiPort}`;
  }

  return `http://${formatHostForUrl(apiHost ?? DEFAULT_ADMIN_CHAT_API_HOST)}:${apiPort}`;
}

/**
 * Build an endpoint URL from a path and the resolved API base URL.
 *
 * When `apiBaseUrl` is the empty string (RELATIVE_BASE_URL), returns just
 * the `path` — a relative URL that browsers resolve against
 * `window.location.origin`.  This avoids constructing absolute URLs that
 * contain unreachable addresses (e.g. 0.0.0.0).
 */
export function buildAbsoluteAdminChatApiUrl(path: string, apiBaseUrl: string): string {
  if (apiBaseUrl === RELATIVE_BASE_URL) {
    return path;
  }
  return new URL(path, apiBaseUrl).toString();
}
