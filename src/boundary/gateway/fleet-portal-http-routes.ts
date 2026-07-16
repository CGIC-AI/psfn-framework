import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';
import {
  serializeFleetPortalProjection,
  type FleetPortalCompanionProjection,
  type FleetPortalProjection,
} from './fleet-portal-projection.js';
import { compileFleetSsoGardenPath } from './fleet-sso-route-compiler.js';
import { FLEET_PORTAL_CLIENT_SOURCE } from './fleet-portal-client.js';

export const FLEET_PORTAL_PATH = '/fleet';
export const FLEET_PORTAL_API_PATH = '/v1/fleet/portal';

const PORTAL_HTTP_POLICY = Object.freeze({
  jsonCsp: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  maxCompanions: 256,
  reauthenticationDenials: new Set<string>([
    'session_absent',
    'session_ambiguous',
    'session_revoked',
    'session_replaced',
    'session_expired',
    'session_authn_stale',
    'session_authz_stale',
    'session_epoch_stale',
    'authority_generation_stale',
  ]),
});

export type FleetPortalPageState =
  | Readonly<{ state: 'loading' }>
  | Readonly<{ state: 'denied' }>
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{ state: 'ready'; projection: FleetPortalProjection }>;

interface FleetPortalProjectionPort {
  resolve(input: unknown): Promise<FleetPortalProjection>;
}

interface FleetPortalRouteRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly sessionToken: string;
  readonly rawPath: string;
  readonly rawQuery: string;
}

function assertSafeCompanion(
  companion: FleetPortalCompanionProjection,
  seen: Set<string>,
): void {
  if (!isRecord(companion)
    || !isRfc4122Uuid(companion.companionId)
    || typeof companion.headless !== 'boolean'
    || !['online', 'degraded', 'offline', 'unknown'].includes(String(companion.availability))) {
    throw new Error('Fleet portal renderer received an invalid companion');
  }
  const keys = Object.keys(companion).sort();
  const expectedKeys = ['availability', 'companionId', 'headless',
    ...(companion.gardenPath === undefined ? [] : ['gardenPath'])].sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || seen.has(companion.companionId)) {
    throw new Error('Fleet portal renderer received a colliding or widened companion');
  }
  seen.add(companion.companionId);
  if (companion.gardenPath !== undefined
    && (companion.headless
      || companion.gardenPath !== compileFleetSsoGardenPath(companion.companionId))) {
    throw new Error('Fleet portal renderer received a non-canonical Garden path');
  }
}

function renderReadyState(projection: FleetPortalProjection): string {
  if (!isRecord(projection)
    || !isRecord(projection.session)
    || !Array.isArray(projection.companions)
    || projection.companions.length > PORTAL_HTTP_POLICY.maxCompanions) {
    throw new Error('Fleet portal renderer received an invalid projection');
  }
  const seen = new Set<string>();
  const items = projection.companions.map((companion) => {
    assertSafeCompanion(companion, seen);
    const availability = {
      online: 'Online',
      degraded: 'Degraded',
      offline: 'Offline',
      unknown: 'Unknown',
    }[companion.availability];
    let action: string;
    if (companion.headless) {
      action = '<p>Headless companion — Garden is not configured.</p>';
    } else if (!companion.gardenPath) {
      action = '<p>Garden access unavailable.</p>';
    } else if (companion.availability === 'offline' || companion.availability === 'unknown') {
      action = `<span aria-disabled="true">${companion.availability === 'offline'
        ? 'Garden is offline' : 'Garden is not ready'}</span>`;
    } else {
      action = `<a href="${companion.gardenPath}">Open Garden</a>`;
    }
    return `<li><article><h2><code>${companion.companionId}</code></h2>`
      + `<p>Status: ${availability}</p>${action}</article></li>`;
  });
  if (items.length === 0) {
    return '<p>No companions are available for this account.</p>';
  }
  return `<ul>${items.join('')}</ul>`;
}

function stateSummary(state: FleetPortalPageState): string {
  if (state.state === 'loading') return 'Loading companion access…';
  if (state.state === 'denied') return 'Fleet portal access is unavailable.';
  if (state.state === 'unavailable') return 'Fleet portal status is unavailable.';
  const companions = state.projection.companions;
  if (companions.length === 0) return 'No companion access is currently available.';
  const hasAvailable = companions.some(companion => (
    companion.gardenPath !== undefined
      && (companion.availability === 'online' || companion.availability === 'degraded')
  ));
  const hasUnavailable = companions.some(companion => (
    companion.headless || companion.gardenPath === undefined || companion.availability !== 'online'
  ));
  if (hasAvailable && hasUnavailable) return 'Some companions are unavailable.';
  return hasUnavailable ? 'Companion access is currently unavailable.' : 'All companions are online.';
}

export function renderFleetPortalShell(state: FleetPortalPageState): Buffer {
  const content = state.state === 'loading'
    ? '<p>Loading companion access…</p>'
    : state.state === 'denied'
      ? '<p>Access unavailable. Sign in again or ask an administrator for access.</p>'
      : state.state === 'unavailable'
        ? '<p>Fleet status is temporarily unavailable. You can still sign out.</p>'
        : renderReadyState(state.projection);
  const busy = state.state === 'loading' ? 'true' : 'false';
  return Buffer.from(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>PSFN Fleet portal</title></head><body><main><h1>Fleet portal</h1>'
    + `<p id="fleet-portal-summary" role="status" aria-live="polite">${stateSummary(state)}</p>`
    + `<section id="fleet-portal-content" aria-busy="${busy}" aria-label="Companion access">${content}</section>`
    + '<p><button id="fleet-logout" type="button" disabled>Sign out</button></p>'
    + '<noscript><p>JavaScript is required to refresh status and sign out safely.</p></noscript>'
    + `<script>${FLEET_PORTAL_CLIENT_SOURCE}</script></main></body></html>`,
    'utf8',
  );
}

function strictHeaders(contentType: string, contentLength: number): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Length': String(contentLength),
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    Expires: '0',
    'Permissions-Policy': 'camera=(), display-capture=(), geolocation=(), microphone=()',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    ...strictHeaders('application/json; charset=utf-8', body.byteLength),
    'Content-Security-Policy': PORTAL_HTTP_POLICY.jsonCsp,
  });
  response.end(body);
}

function sendPage(response: ServerResponse, status: number, state: FleetPortalPageState): void {
  const body = renderFleetPortalShell(state);
  const scriptHash = createHash('sha256').update(FLEET_PORTAL_CLIENT_SOURCE).digest('base64');
  response.writeHead(status, {
    ...strictHeaders('text/html; charset=utf-8', body.byteLength),
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; connect-src 'self'; "
      + "form-action 'self'; frame-ancestors 'none'; "
      + `script-src 'sha256-${scriptHash}'`,
  });
  response.end(body);
}

function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, { error: { type: 'not_found' } });
}

function sendLoginRedirect(response: ServerResponse): void {
  response.writeHead(303, {
    ...strictHeaders('text/plain; charset=utf-8', 0),
    'Content-Security-Policy': PORTAL_HTTP_POLICY.jsonCsp,
    Location: '/fleet/login',
  });
  response.end();
}

export class GatewayFleetPortalHttpRoutes {
  constructor(private readonly options: { readonly projection: FleetPortalProjectionPort }) {}

  matches(rawPath: string): boolean {
    return rawPath === FLEET_PORTAL_PATH || rawPath === `${FLEET_PORTAL_PATH}/`
      || rawPath === FLEET_PORTAL_API_PATH;
  }

  sendUnauthenticated(response: ServerResponse): void {
    sendJson(response, 401, { error: { type: 'fleet_portal_denied' } });
  }

  async handle(input: FleetPortalRouteRequest): Promise<void> {
    const isPage = input.rawPath === FLEET_PORTAL_PATH || input.rawPath === `${FLEET_PORTAL_PATH}/`;
    const isApi = input.rawPath === FLEET_PORTAL_API_PATH;
    if (input.request.method !== 'GET' || input.rawQuery || (!isPage && !isApi)) {
      sendNotFound(input.response);
      return;
    }
    try {
      const projection = await this.options.projection.resolve({ sessionToken: input.sessionToken });
      if (isApi) {
        const body = serializeFleetPortalProjection(projection);
        input.response.writeHead(200, {
          ...strictHeaders('application/json; charset=utf-8', body.byteLength),
          'Content-Security-Policy': PORTAL_HTTP_POLICY.jsonCsp,
        });
        input.response.end(body);
        return;
      }
      sendPage(input.response, 200, { state: 'ready', projection });
    } catch (error) {
      if (error instanceof FleetAuthorizationDeniedError) {
        if (error.code === 'authorization_store_error') {
          if (isApi) sendJson(input.response, 503, { error: { type: 'fleet_portal_unavailable' } });
          else sendPage(input.response, 503, { state: 'unavailable' });
        } else if (PORTAL_HTTP_POLICY.reauthenticationDenials.has(error.code)) {
          if (isApi) this.sendUnauthenticated(input.response);
          else sendLoginRedirect(input.response);
        } else if (isApi) {
          sendJson(input.response, 403, { error: { type: 'fleet_portal_denied' } });
        } else {
          sendPage(input.response, 403, { state: 'denied' });
        }
        return;
      }
      if (isApi) sendJson(input.response, 503, { error: { type: 'fleet_portal_unavailable' } });
      else sendPage(input.response, 503, { state: 'unavailable' });
    }
  }
}
