import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendText } from '../../channels/backplane/http/primitives.js';
import { GARDEN_CLIENT_ROUTES } from '../../boundary/fleet-auth/garden-route-capabilities.js';
import {
  GardenRequestTargetError,
  parseCanonicalGardenRequestPath,
  validateGardenRequestMetadata,
} from '../../boundary/fleet-auth/request-capability-target.js';
import { stripBrowserRequestCapabilityHeaders } from '../../boundary/fleet-auth/request-capability-transport.js';

export const GARDEN_PREFIX = '/';

const GARDEN_CLIENT_ROUTE_SET = new Set<string>([
  ...GARDEN_CLIENT_ROUTES,
  '/wishlist',
]);

interface AdminRequestRoutingDependencies {
  token?: string;
  checkAuth: (req: IncomingMessage, res: ServerResponse) => boolean;
  isGardenUiEnabled: () => boolean;
  serveGardenBuildAsset: (path: string, req: IncomingMessage, res: ServerResponse) => void;
  serveGardenPage: (path: string, req: IncomingMessage, res: ServerResponse) => void;
  route: (
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => boolean;
  sendNotFound: (path: string, res: ServerResponse) => void;
  onRequestError: (path: string, err: unknown) => void;
  /** Assertion headers arrived only over the authenticated gateway hop. */
  trustedRequestCapability?: boolean;
  /** Fleet mode authenticates assets, health, and every Garden surface. */
  requireAuthForPublicRoutes?: boolean;
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
    || requestPath === '/_app'
    || requestPath.startsWith('/_app/')
  ) {
    return false;
  }

  const normalizedPath = requestPath.length > 1 && requestPath.endsWith('/')
    ? requestPath.replace(/\/+$/, '')
    : requestPath;
  return GARDEN_CLIENT_ROUTE_SET.has(normalizedPath);
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
  const metadataHeaders = deps.trustedRequestCapability ? { ...req.headers } : req.headers;
  stripBrowserRequestCapabilityHeaders(metadataHeaders);
  let requestPath: string;
  try {
    requestPath = validateGardenRequestMetadata({
      rawTarget: req.url ?? '/',
      method: req.method ?? 'GET',
      headers: metadataHeaders,
    }).canonicalPath;
  } catch (error) {
    if (error instanceof GardenRequestTargetError && error.code === 'authority_forbidden') {
      sendJson(res, 403, { error: 'Cross-tenant authority selector is forbidden' });
      return;
    }
    if (error instanceof GardenRequestTargetError && error.code === 'route_not_declared') {
      try {
        const canonicalPath = parseCanonicalGardenRequestPath(req.url ?? '/').canonicalPath;
        if (deps.requireAuthForPublicRoutes !== true && isGardenClientRoute(req.method, canonicalPath)) {
          requestPath = canonicalPath;
        } else {
          deps.sendNotFound(canonicalPath, res);
          return;
        }
      } catch {
        sendText(res, 400, 'Invalid request target');
        return;
      }
    } else {
      sendText(res, 400, 'Invalid request target');
      return;
    }
  }

  // Skip auth for SvelteKit built assets, health probes, and login page.
  const skipAuth = deps.requireAuthForPublicRoutes !== true && (
    requestPath.startsWith('/_app/')
    || requestPath === '/health'
    || requestPath.startsWith('/health/')
    || requestPath === '/login'
  );

  if (!skipAuth && (deps.token || deps.requireAuthForPublicRoutes) && !deps.checkAuth(req, res)) return;

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
      deps.serveGardenBuildAsset(requestPath, req, res);
    } else {
      deps.sendNotFound(requestPath, res);
    }
    return;
  }

  if (isGardenClientRoute(req.method, requestPath)) {
    if (deps.isGardenUiEnabled()) {
      deps.serveGardenPage(requestPath, req, res);
    } else {
      deps.sendNotFound(requestPath, res);
    }
    return;
  }

  deps.sendNotFound(requestPath, res);
}
