import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendText } from '../../channels/http/primitives.js';
import { parseRequestUrl } from './request-url.js';

export const GARDEN_PREFIX = '/';

const GARDEN_CLIENT_ROUTES = new Set([
  '/',
  '/chat',
  '/confirmations',
  '/contacts',
  '/identity',
  '/memory',
  '/model-room',
  '/models',
  '/primer',
  '/prompt-monitor',
  '/prompts',
  '/scheduler',
  '/sessions',
  '/settings',
  '/shards',
  '/skills',
  '/telemetry',
  '/theme',
  '/tools',
  '/values',
]);

interface AdminRequestRoutingDependencies {
  token?: string;
  checkAuth: (req: IncomingMessage, res: ServerResponse) => boolean;
  tryServeStaticAsset: (path: string, res: ServerResponse) => boolean;
  isGardenUiEnabled: () => boolean;
  serveGardenBuildAsset: (path: string, res: ServerResponse) => void;
  serveGardenPage: (path: string, res: ServerResponse) => void;
  route: (
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => boolean;
  sendNotFound: (path: string, res: ServerResponse) => void;
  onRequestError: (path: string, err: unknown) => void;
}

function isGardenClientRoute(method: string | undefined, requestPath: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (
    requestPath === '/api'
    || requestPath.startsWith('/api/')
    || requestPath === '/health'
    || requestPath.startsWith('/health/')
    || requestPath === '/login'
    || requestPath.startsWith('/login/')
    || requestPath === '/static'
    || requestPath.startsWith('/static/')
    || requestPath === '/_app'
    || requestPath.startsWith('/_app/')
  ) {
    return false;
  }

  const normalizedPath = requestPath.length > 1 && requestPath.endsWith('/')
    ? requestPath.replace(/\/+$/, '')
    : requestPath;
  return GARDEN_CLIENT_ROUTES.has(normalizedPath);
}

function isGardenBuildAssetPath(method: string | undefined, requestPath: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return requestPath === '/_app' || requestPath.startsWith('/_app/');
}

export function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRequestRoutingDependencies,
): void {
  const url = parseRequestUrl(req);
  const requestPath = url.pathname;

  // Skip auth for OPTIONS, static files, SvelteKit built assets, and login page.
  const skipAuth = req.method === 'OPTIONS'
    || requestPath.startsWith('/static/')
    || requestPath.startsWith('/_app/')
    || requestPath === '/login';

  if (!skipAuth && deps.token && !deps.checkAuth(req, res)) return;

  if (deps.tryServeStaticAsset(requestPath, res)) {
    return;
  }

  try {
    const handled = deps.route(req.method ?? 'GET', requestPath, req, res);
    if (handled) return;
  } catch (err) {
    deps.onRequestError(requestPath, err);
    sendText(res, 500, 'Internal Server Error');
    return;
  }

  if (isGardenBuildAssetPath(req.method, requestPath)) {
    if (deps.isGardenUiEnabled()) {
      deps.serveGardenBuildAsset(requestPath, res);
    } else {
      deps.sendNotFound(requestPath, res);
    }
    return;
  }

  if (isGardenClientRoute(req.method, requestPath)) {
    if (deps.isGardenUiEnabled()) {
      deps.serveGardenPage(requestPath, res);
    } else {
      deps.sendNotFound(requestPath, res);
    }
    return;
  }

  deps.sendNotFound(requestPath, res);
}
