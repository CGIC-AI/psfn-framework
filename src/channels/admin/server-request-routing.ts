import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendText } from '../http/primitives.js';
import { parseRequestUrl } from './request-url.js';

export const GARDEN_PREFIX = '/garden';

interface AdminRequestRoutingDependencies {
  token?: string;
  checkAuth: (req: IncomingMessage, res: ServerResponse) => boolean;
  tryServeStaticAsset: (path: string, res: ServerResponse) => boolean;
  isGardenUiEnabled: () => boolean;
  serveGardenAsset: (path: string, res: ServerResponse) => void;
  route: (
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => void;
  onRequestError: (path: string, err: unknown) => void;
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

  // API and login routes go to the route dispatcher.
  if (requestPath === '/login' || requestPath.startsWith('/api/')) {
    try {
      deps.route(req.method ?? 'GET', requestPath, req, res);
    } catch (err) {
      deps.onRequestError(requestPath, err);
      sendText(res, 500, 'Internal Server Error');
    }
    return;
  }

  // All other paths: serve Garden SPA (UI routes, /_app/*, root).
  if (deps.isGardenUiEnabled()) {
    deps.serveGardenAsset(requestPath, res);
  } else {
    sendText(res, 404, `Not found: ${requestPath}`);
  }
}
