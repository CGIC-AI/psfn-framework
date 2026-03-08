import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendRedirect, sendText } from '../http/primitives.js';
import { parseRequestUrl } from './request-url.js';

export const GARDEN_PREFIX = '/garden';
export const LEGACY_PREFIX = '/legacy';

const LEGACY_DEPRECATION_HEADERS = {
  Deprecation: 'true',
  Warning: '299 - "Legacy admin UI is deprecated; use /garden"',
  Link: '</garden>; rel="successor-version"',
} as const;

const LEGACY_REDIRECT_EXACT_PATHS = new Set([
  '/memory',
  '/sessions',
  '/scheduler',
  '/shards',
  '/contacts',
  '/chat',
  '/confirmations',
  '/identity',
  '/settings',
  '/skills',
  '/events',
  '/events/stream',
  '/values',
  '/primer',
  '/prompts',
]);

const LEGACY_REDIRECT_PREFIXES = [
  '/memory/',
  '/sessions/',
  '/prompts/',
];

interface AdminRequestRoutingDependencies {
  token?: string;
  hasRequestAuthCredentials: (req: IncomingMessage) => boolean;
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
  const {
    path: routedPath,
    isLegacyPath,
  } = resolveLegacyRequestPath(requestPath);
  const isLegacyChatRuntimePath = routedPath === '/static/chat.js';

  if (isLegacyChatRuntimePath && deps.token && !deps.hasRequestAuthCredentials(req)) {
    sendText(res, 404, `Not found: ${routedPath}`);
    return;
  }

  // Skip auth for OPTIONS, static files, and login page.
  const skipAuth = req.method === 'OPTIONS'
    || routedPath.startsWith('/static/')
    || routedPath === '/login';

  if (!skipAuth && deps.token && !deps.checkAuth(req, res)) return;

  if (!isLegacyPath && requestPath === '/') {
    sendRedirect(res, `${GARDEN_PREFIX}${url.search}`);
    return;
  }

  if (!isLegacyPath) {
    const legacyRedirectPath = resolveLegacyRedirectPath(requestPath);
    if (legacyRedirectPath) {
      sendRedirect(res, `${legacyRedirectPath}${url.search}`);
      return;
    }
  }

  if (isLegacyPath) {
    applyLegacyDeprecationHeaders(res);
  }

  if (deps.tryServeStaticAsset(routedPath, res)) {
    return;
  }

  // Serve SvelteKit garden UI static files.
  if (routedPath === GARDEN_PREFIX || routedPath.startsWith(GARDEN_PREFIX + '/')) {
    if (deps.isGardenUiEnabled()) {
      deps.serveGardenAsset(routedPath, res);
    } else {
      sendRedirect(res, LEGACY_PREFIX);
    }
    return;
  }

  try {
    deps.route(req.method ?? 'GET', routedPath, req, res);
  } catch (err) {
    deps.onRequestError(routedPath, err);
    sendText(res, 500, 'Internal Server Error');
  }
}

function resolveLegacyRequestPath(path: string): { path: string; isLegacyPath: boolean } {
  if (path === LEGACY_PREFIX || path === `${LEGACY_PREFIX}/`) {
    return { path: '/', isLegacyPath: true };
  }

  if (path.startsWith(`${LEGACY_PREFIX}/`)) {
    const stripped = path.slice(LEGACY_PREFIX.length);
    return { path: stripped.length > 0 ? stripped : '/', isLegacyPath: true };
  }

  return { path, isLegacyPath: false };
}

function resolveLegacyRedirectPath(path: string): string | null {
  if (
    path.startsWith('/api/')
    || path.startsWith('/static/')
    || path === '/login'
    || path === '/health'
    || path === GARDEN_PREFIX
    || path.startsWith(GARDEN_PREFIX + '/')
    || path === LEGACY_PREFIX
    || path.startsWith(`${LEGACY_PREFIX}/`)
  ) {
    return null;
  }

  if (LEGACY_REDIRECT_EXACT_PATHS.has(path)) {
    return `${LEGACY_PREFIX}${path}`;
  }

  for (const prefix of LEGACY_REDIRECT_PREFIXES) {
    if (path.startsWith(prefix)) {
      return `${LEGACY_PREFIX}${path}`;
    }
  }

  return null;
}

function applyLegacyDeprecationHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(LEGACY_DEPRECATION_HEADERS)) {
    res.setHeader(name, value);
  }
}
