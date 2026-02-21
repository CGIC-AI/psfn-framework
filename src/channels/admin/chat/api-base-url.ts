const DEFAULT_ADMIN_CHAT_API_HOST = '127.0.0.1';
const DEFAULT_ADMIN_CHAT_API_PORT = 3000;

interface ResolveAdminChatApiBaseUrlOptions {
  explicitApiBaseUrl?: string;
  apiHost?: string;
  apiPort?: number;
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

export function resolveAdminChatApiBaseUrl(options: ResolveAdminChatApiBaseUrlOptions = {}): string {
  const explicit = normalizeAbsoluteHttpUrl(options.explicitApiBaseUrl);
  if (explicit) return explicit;

  const apiHost = normalizeTrimmed(options.apiHost) ?? DEFAULT_ADMIN_CHAT_API_HOST;
  const apiPort = normalizePort(options.apiPort) ?? DEFAULT_ADMIN_CHAT_API_PORT;
  return `http://${apiHost}:${apiPort}`;
}

export function buildAbsoluteAdminChatApiUrl(path: string, apiBaseUrl: string): string {
  return new URL(path, apiBaseUrl).toString();
}
