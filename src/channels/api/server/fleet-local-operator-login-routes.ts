import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  FleetAuthSessionRecord,
  GatewayFleetAuthBroker,
} from '../../../boundary/gateway/fleet-auth-broker.js';
import {
  FLEET_LOCAL_OPERATOR_LOGIN_PATH,
  FLEET_LOCAL_OPERATOR_SESSION_COOKIE_NAME,
  fleetLocalOperatorOriginAllowed,
  validateFleetLocalOperatorOrigins,
} from '../../../boundary/gateway/fleet-local-operator-login.js';
import { readBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';

const PAGE_STYLE = 'body{font:16px system-ui;max-width:32rem;margin:10vh auto;padding:1rem}label,input,button{display:block;width:100%;margin:.75rem 0;padding:.65rem}input,button{box-sizing:border-box}';
const STYLE_HASH = createHash('sha256').update(PAGE_STYLE, 'utf8').digest('base64');
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
].join('; ');
const PAGE = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Garden administrator login</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>Garden administrator</h1><p>Sign in with your admin token.</p>
<form method="post" action="${FLEET_LOCAL_OPERATOR_LOGIN_PATH}">
<label for="token">Admin token</label><input id="token" name="token" type="password" required autocomplete="current-password">
<button type="submit">Sign in</button></form></main></body></html>`, 'utf8');

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function localOperatorSessionCookie(
  session: Pick<FleetAuthSessionRecord, 'token' | 'absoluteExpiresAt'>,
  now = Date.now(),
): string {
  const maxAge = Math.max(0, Math.floor((session.absoluteExpiresAt.getTime() - now) / 1000));
  return `${FLEET_LOCAL_OPERATOR_SESSION_COOKIE_NAME}=${session.token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`;
}

export function clearLocalOperatorSessionCookie(): string {
  return `${FLEET_LOCAL_OPERATOR_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

function sendPage(response: ServerResponse): void {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': String(PAGE.byteLength),
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  response.end(PAGE.toString('utf8'));
}

export class FleetLocalOperatorLoginRoutes {
  readonly allowedOrigins: readonly string[];
  private readonly broker: Pick<GatewayFleetAuthBroker, 'completeLocalOperatorLogin'>;
  private readonly adminToken: string;
  private readonly maxBodyBytes: number;

  constructor(options: {
    broker: Pick<GatewayFleetAuthBroker, 'completeLocalOperatorLogin'>;
    adminToken: string;
    allowedOrigins: readonly string[];
    maxBodyBytes: number;
  }) {
    if (!options.adminToken) {
      throw new Error('Fleet local operator login requires ADMIN_TOKEN');
    }
    this.broker = options.broker;
    this.adminToken = options.adminToken;
    this.maxBodyBytes = options.maxBodyBytes;
    this.allowedOrigins = validateFleetLocalOperatorOrigins(options.allowedOrigins);
  }

  matches(method: string | undefined, path: string): boolean {
    return path === FLEET_LOCAL_OPERATOR_LOGIN_PATH
      && (method === 'GET' || method === 'POST');
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.search) {
      sendJson(response, 404, { error: { type: 'fleet_auth_route_not_found' } });
      return;
    }
    if (request.method === 'GET') {
      sendPage(response);
      return;
    }
    if (!fleetLocalOperatorOriginAllowed(
      singleHeader(request.headers.origin),
      this.allowedOrigins,
    )) {
      sendJson(response, 403, { error: { type: 'local_operator_origin_denied' } }, {
        'Cache-Control': 'no-store',
      });
      return;
    }
    if (singleHeader(request.headers['content-type'])
      ?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
      sendJson(response, 400, { error: { type: 'invalid_local_operator_login' } });
      return;
    }
    const body = await readBodyWithLimit(request, response, { maxBytes: this.maxBodyBytes });
    if (body === null || response.writableEnded) return;
    const params = new URLSearchParams(body);
    const tokens = params.getAll('token');
    const exactFields = [...params.keys()].every(key => key === 'token') && tokens.length === 1;
    const supplied = tokens[0] ?? '';
    if (!exactFields || !timingSafeStringEqual(supplied, this.adminToken)) {
      sendJson(response, 401, { error: { type: 'invalid_local_operator_login' } }, {
        'Cache-Control': 'no-store',
      });
      return;
    }
    const session = await this.broker.completeLocalOperatorLogin();
    response.writeHead(303, {
      'Cache-Control': 'no-store',
      Location: '/fleet',
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': localOperatorSessionCookie(session),
    });
    response.end();
  }
}
