import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FleetAuthBrokerError,
  type GatewayFleetAuthBroker,
} from '../../../boundary/gateway/fleet-auth-broker.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { appendVaryValue } from '../http-policy.js';
import {
  isLifecycleOAuthAction,
  isLifecycleOAuthProofRole,
} from '../../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import { isRecord } from '../../../shared/utils/types.js';
import { FLEET_AUTH_SESSION_COOKIE_NAME } from './fleet-auth-cookie.js';
import { resolveFleetSsoBrowserOrigin } from '../../../boundary/gateway/fleet-sso-router.js';
import { FleetAuthorizationDeniedError } from '../../../boundary/gateway/fleet-authorization-context.js';

const LOGIN_PATH = '/v1/fleet-auth/login';
export const FLEET_AUTH_LIFECYCLE_OAUTH_PATH = '/v1/fleet-auth/lifecycle/oauth';
const REFRESH_PATH = '/v1/fleet-auth/session/refresh';
const CSRF_PATH = '/v1/fleet-auth/session/csrf';
const STATUS_PATH = '/v1/fleet-auth/session/status';
const LOGOUT_PATH = '/v1/fleet-auth/logout';
const PROVIDER_REVOKE_PATH = '/v1/fleet-auth/provider/revoke';
const PREAUTH_COOKIE_NAME = '__Host-psfn_preauth';
const CSRF_HEADER_NAME = 'x-psfn-csrf';
const MUTATION_BODY_LIMIT = 2048;
const LIFECYCLE_CORS_ALLOWED_HEADERS = 'Content-Type, X-PSFN-CSRF';

export type FleetAuthLifecycleCorsDisposition = 'not_applicable' | 'continue' | 'handled';

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOpaqueCookie(request: IncomingMessage, name: string): string | undefined {
  const raw = singleHeader(request.headers.cookie);
  if (!raw) return undefined;
  const matches: string[] = [];
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (value) matches.push(value);
  }
  if (matches.length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(matches[0]!)) return undefined;
  return matches[0];
}

function readSessionCookie(request: IncomingMessage): string | undefined {
  return readOpaqueCookie(request, FLEET_AUTH_SESSION_COOKIE_NAME);
}

function requireSingleQuery(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] ?? undefined : undefined;
}

function requestCallbackOrigin(
  request: IncomingMessage,
  canonicalOrigin: string,
  trustProxy: boolean,
): string {
  try {
    return resolveFleetSsoBrowserOrigin(request, { canonicalOrigin, trustProxy });
  } catch {
    return 'invalid://callback-origin';
  }
}

function mutationOrigin(request: IncomingMessage): string {
  return singleHeader(request.headers.origin) ?? '';
}

function requestedLifecycleCorsHeaders(request: IncomingMessage): string[] | undefined {
  const raw = singleHeader(request.headers['access-control-request-headers']);
  if (!raw) return undefined;
  const headers = raw.split(',').map(header => header.trim().toLowerCase());
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) return undefined;
  if (headers.length !== 2
    || !headers.includes('content-type')
    || !headers.includes('x-psfn-csrf')) return undefined;
  return headers;
}

function sessionCookie(token: string, absoluteExpiresAt: Date, now = Date.now()): string {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - now) / 1000));
  return `${FLEET_AUTH_SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${FLEET_AUTH_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function preauthCookie(token: string, expiresAt: Date, now = Date.now()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000));
  return `${PREAUTH_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function clearPreauthCookie(): string {
  return `${PREAUTH_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function sendRouteError(response: ServerResponse, error: unknown): void {
  if (error instanceof FleetAuthBrokerError) {
    sendJson(response, error.status, {
      error: { type: error.code, message: error.message },
    }, { 'Cache-Control': 'no-store' });
    return;
  }
  sendJson(response, 500, {
    error: { type: 'fleet_auth_internal_error', message: 'Fleet authentication failed' },
  }, { 'Cache-Control': 'no-store' });
}

export class FleetAuthHttpRoutes {
  private readonly broker: GatewayFleetAuthBroker;
  private readonly canonicalOrigin: string;
  private readonly callbackPath: string;
  private readonly trustProxy: boolean;
  private readonly companionUi?: Readonly<{
    companionId: string;
    guestMode: 'disabled' | 'explicit';
  }>;

  constructor(options: {
    broker: GatewayFleetAuthBroker;
    canonicalOrigin: string;
    callbackPath: string;
    trustProxy?: boolean;
    companionUi?: Readonly<{
      companionId: string;
      guestMode: 'disabled' | 'explicit';
    }>;
  }) {
    this.broker = options.broker;
    this.canonicalOrigin = options.canonicalOrigin;
    this.callbackPath = options.callbackPath;
    this.trustProxy = options.trustProxy === true;
    this.companionUi = options.companionUi;
  }

  matches(method: string | undefined, path: string): boolean {
    return (method === 'GET' && (
      path === LOGIN_PATH || path === CSRF_PATH || path === STATUS_PATH || path === this.callbackPath
    ))
      || (method === 'POST'
        && (path === FLEET_AUTH_LIFECYCLE_OAUTH_PATH || path === REFRESH_PATH
          || path === LOGOUT_PATH || path === PROVIDER_REVOKE_PATH));
  }

  applyLifecycleCorsPolicy(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): FleetAuthLifecycleCorsDisposition {
    if (path !== FLEET_AUTH_LIFECYCLE_OAUTH_PATH
      || (request.method !== 'POST' && request.method !== 'OPTIONS')) {
      return 'not_applicable';
    }
    if (singleHeader(request.headers.origin) !== this.canonicalOrigin) {
      sendJson(response, 403, {
        error: {
          type: 'cors_origin_not_allowed',
          message: 'Origin is not allowed for fleet-auth lifecycle OAuth',
        },
      }, { 'Cache-Control': 'no-store' });
      return 'handled';
    }

    let vary = appendVaryValue(response.getHeader('Vary'), 'Origin');
    response.setHeader('Access-Control-Allow-Origin', this.canonicalOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    if (request.method === 'POST') {
      response.setHeader('Vary', vary);
      return 'continue';
    }

    vary = appendVaryValue(vary, 'Access-Control-Request-Method');
    vary = appendVaryValue(vary, 'Access-Control-Request-Headers');
    response.setHeader('Vary', vary);
    if (singleHeader(request.headers['access-control-request-method']) !== 'POST'
      || !requestedLifecycleCorsHeaders(request)) {
      sendJson(response, 403, {
        error: {
          type: 'cors_preflight_not_allowed',
          message: 'Fleet-auth lifecycle OAuth preflight is not allowed',
        },
      }, { 'Cache-Control': 'no-store' });
      return 'handled';
    }
    response.statusCode = 204;
    response.setHeader('Access-Control-Allow-Methods', 'POST');
    response.setHeader('Access-Control-Allow-Headers', LIFECYCLE_CORS_ALLOWED_HEADERS);
    response.setHeader('Access-Control-Max-Age', '600');
    response.end();
    return 'handled';
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const isCallback = request.method === 'GET' && url.pathname === this.callbackPath;
    try {
      if (request.method === 'GET' && url.pathname === LOGIN_PATH) {
        const returnPath = requireSingleQuery(url, 'return_to');
        if (!returnPath || [...url.searchParams.keys()].some(key => key !== 'return_to')) {
          throw new FleetAuthBrokerError('invalid_login_request', 400, 'Login request is malformed');
        }
        const started = await this.broker.beginLogin({ returnPath });
        response.statusCode = 302;
        response.setHeader('Location', started.authorizationUrl);
        response.setHeader('Set-Cookie', preauthCookie(
          started.initiatingBrowserToken,
          started.expiresAt,
        ));
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === this.callbackPath) {
        const state = requireSingleQuery(url, 'state');
        const code = requireSingleQuery(url, 'code');
        if (!state || !code || [...url.searchParams.keys()].some(key => key !== 'state' && key !== 'code')) {
          throw new FleetAuthBrokerError('invalid_oauth_callback', 400, 'OAuth callback is malformed');
        }
        const completed = await this.broker.completeOAuthCallback({
          state,
          code,
          requestOrigin: requestCallbackOrigin(request, this.canonicalOrigin, this.trustProxy),
          initiatingBrowserToken: readOpaqueCookie(request, PREAUTH_COOKIE_NAME) ?? '',
        });
        if (completed.kind === 'login') {
          response.statusCode = 303;
          response.setHeader('Set-Cookie', [
            clearPreauthCookie(),
            sessionCookie(completed.session.token, completed.session.absoluteExpiresAt),
          ]);
          response.setHeader('Location', completed.returnPath);
          response.end();
          return;
        }
        response.setHeader('Set-Cookie', clearPreauthCookie());
        sendJson(response, 200, {
          kind: completed.kind,
          returnPath: completed.returnPath,
          ceremonyId: completed.ceremonyId,
          action: completed.action,
          proofRole: completed.proofRole,
          proof: completed.proof,
        }, { 'Cache-Control': 'no-store' });
        return;
      }
      if (request.method === 'GET' && url.pathname === STATUS_PATH) {
        if (url.search || !this.companionUi) {
          throw new FleetAuthBrokerError('fleet_auth_route_not_found', 404);
        }
        response.setHeader('Vary', 'Cookie');
        const statusToken = readSessionCookie(request);
        if (!statusToken) {
          sendJson(response, 200, {
            schemaVersion: 1,
            state: 'signed_out',
            guestMode: this.companionUi.guestMode,
            ...(this.companionUi.guestMode === 'explicit'
              ? { websocketPath: `/companion-ui/companions/${this.companionUi.companionId}/ws` }
              : {}),
          }, { 'Cache-Control': 'no-store, private' });
          return;
        }
        try {
          const context = await this.broker.resolveAuthorizationContext({
            sessionToken: statusToken,
            audience: 'fleet',
            companionId: this.companionUi.companionId,
            action: 'companion.read',
          });
          if (context.companionId !== this.companionUi.companionId
            || context.authorization.action !== 'companion.read') {
            throw new Error('Companion UI session authority changed');
          }
          sendJson(response, 200, {
            schemaVersion: 1,
            state: 'signed_in',
            guestMode: this.companionUi.guestMode,
            websocketPath: `/companion-ui/companions/${this.companionUi.companionId}/ws`,
            human: {
              provider: context.providerSubject.provider,
              label: 'Discord user',
              role: context.operator.role,
            },
          }, { 'Cache-Control': 'no-store, private' });
          return;
        } catch (error) {
          if (!(error instanceof FleetAuthorizationDeniedError)) throw error;
          response.setHeader('Set-Cookie', clearSessionCookie());
          sendJson(response, 200, {
            schemaVersion: 1,
            state: 'signed_out',
            guestMode: this.companionUi.guestMode,
            ...(this.companionUi.guestMode === 'explicit'
              ? { websocketPath: `/companion-ui/companions/${this.companionUi.companionId}/ws` }
              : {}),
          }, { 'Cache-Control': 'no-store, private' });
          return;
        }
      }
      const token = readSessionCookie(request);
      if (!token) {
        throw new FleetAuthBrokerError('invalid_session', 401, 'Session is invalid or expired');
      }
      if (request.method === 'GET' && url.pathname === CSRF_PATH) {
        const csrfToken = await this.broker.issueCsrf({
          token,
          requestOrigin: requestCallbackOrigin(request, this.canonicalOrigin, this.trustProxy),
        });
        sendJson(response, 200, { csrfToken }, { 'Cache-Control': 'no-store' });
        return;
      }
      const csrfToken = singleHeader(request.headers[CSRF_HEADER_NAME]);
      if (!csrfToken || !/^[A-Za-z0-9_-]{43}$/u.test(csrfToken)) {
        throw new FleetAuthBrokerError('invalid_csrf', 403, 'Session-bound CSRF token is required');
      }
      if (request.method === 'POST' && url.pathname === FLEET_AUTH_LIFECYCLE_OAUTH_PATH) {
        const body = await readJsonBodyWithLimit(request, response, { maxBytes: MUTATION_BODY_LIMIT });
        if (!body.ok || !isRecord(body.value) || Object.keys(body.value).length !== 4
          || typeof body.value.returnPath !== 'string'
          || typeof body.value.ceremonyId !== 'string'
          || !isLifecycleOAuthAction(body.value.action)
          || !isLifecycleOAuthProofRole(body.value.proofRole)) {
          if (!response.writableEnded) {
            throw new FleetAuthBrokerError(
              'invalid_lifecycle_oauth_request',
              400,
              'Lifecycle OAuth request is malformed',
            );
          }
          return;
        }
        const started = await this.broker.beginLifecycleOAuth({
          token,
          csrfToken,
          requestOrigin: mutationOrigin(request),
          returnPath: body.value.returnPath,
          ceremonyId: body.value.ceremonyId,
          action: body.value.action,
          proofRole: body.value.proofRole,
        });
        response.statusCode = 302;
        response.setHeader('Location', started.authorizationUrl);
        response.setHeader('Set-Cookie', preauthCookie(
          started.initiatingBrowserToken,
          started.expiresAt,
        ));
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === REFRESH_PATH) {
        const rotated = await this.broker.rotateSession({
          token,
          csrfToken,
          requestOrigin: mutationOrigin(request),
        });
        response.setHeader('Set-Cookie', sessionCookie(rotated.token, rotated.absoluteExpiresAt));
        sendJson(response, 200, {
          csrfToken: rotated.csrfToken,
          principalStatus: rotated.principalStatus,
          idleExpiresAt: rotated.idleExpiresAt.toISOString(),
          absoluteExpiresAt: rotated.absoluteExpiresAt.toISOString(),
        }, { 'Cache-Control': 'no-store' });
        return;
      }
      if (request.method === 'POST' && url.pathname === LOGOUT_PATH) {
        await this.broker.logout({ token, csrfToken, requestOrigin: mutationOrigin(request) });
        response.setHeader('Set-Cookie', clearSessionCookie());
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === PROVIDER_REVOKE_PATH) {
        const body = await readJsonBodyWithLimit(request, response, { maxBytes: MUTATION_BODY_LIMIT });
        if (!body.ok || !isRecord(body.value) || Object.keys(body.value).length !== 1
          || typeof body.value.reason !== 'string') {
          if (!response.writableEnded) {
            throw new FleetAuthBrokerError('invalid_revocation_request', 400, 'Revocation request is malformed');
          }
          return;
        }
        await this.broker.revokeProvider({
          token,
          csrfToken,
          requestOrigin: mutationOrigin(request),
          reason: body.value.reason,
        });
        response.setHeader('Set-Cookie', clearSessionCookie());
        response.statusCode = 204;
        response.end();
        return;
      }
      throw new FleetAuthBrokerError('fleet_auth_route_not_found', 404);
    } catch (error) {
      if (!response.writableEnded) {
        const reauthenticationRequired = error instanceof FleetAuthBrokerError
          && error.code === 'reauthentication_required';
        if (isCallback && reauthenticationRequired) {
          response.setHeader('Set-Cookie', [clearPreauthCookie(), clearSessionCookie()]);
        } else if (isCallback) {
          response.setHeader('Set-Cookie', clearPreauthCookie());
        } else if (reauthenticationRequired) {
          response.setHeader('Set-Cookie', clearSessionCookie());
        }
        sendRouteError(response, error);
      }
    }
  }
}
