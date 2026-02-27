const DEFAULT_ADMIN_CHAT_API_HOST = '127.0.0.1';
const DEFAULT_ADMIN_CHAT_API_PORT = 3000;
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

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

export function resolveAdminChatApiBaseUrl(options: ResolveAdminChatApiBaseUrlOptions = {}): string {
  const explicit = normalizeAbsoluteHttpUrl(options.explicitApiBaseUrl);
  if (explicit) return explicit;

  const apiPort = normalizePort(options.apiPort) ?? DEFAULT_ADMIN_CHAT_API_PORT;
  const apiHost = normalizeTrimmed(options.apiHost);
  const browserOrigin = normalizeBrowserOrigin(options.browserOrigin);

  if (apiHost && WILDCARD_BIND_HOSTS.has(apiHost.toLowerCase())) {
    if (browserOrigin) {
      return `${browserOrigin.protocol}//${formatHostForUrl(browserOrigin.hostname)}:${apiPort}`;
    }
    return `http://${DEFAULT_ADMIN_CHAT_API_HOST}:${apiPort}`;
  }

  return `http://${formatHostForUrl(apiHost ?? DEFAULT_ADMIN_CHAT_API_HOST)}:${apiPort}`;
}

export function buildAbsoluteAdminChatApiUrl(path: string, apiBaseUrl: string): string {
  return new URL(path, apiBaseUrl).toString();
}
