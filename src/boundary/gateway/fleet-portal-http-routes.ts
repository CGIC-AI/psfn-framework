import type { IncomingMessage, ServerResponse } from 'node:http';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';
import {
  serializeFleetPortalProjection,
  type FleetPortalProjection,
} from './fleet-portal-projection.js';
import type { FleetGardenUiAssetsPort } from './fleet-garden-ui-assets.js';

export const FLEET_PORTAL_PATH = '/fleet';
export const FLEET_PORTAL_ASSET_PREFIX = '/fleet/_app/';
export const FLEET_SHARED_ASSET_PREFIX = '/_app/';
export const FLEET_PORTAL_API_PATH = '/v1/fleet/portal';

const PORTAL_HTTP_POLICY = Object.freeze({
  jsonCsp: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
  constructor(private readonly options: {
    readonly projection: FleetPortalProjectionPort;
    readonly ui: FleetGardenUiAssetsPort;
  }) {}

  matches(rawPath: string): boolean {
    return rawPath === FLEET_PORTAL_PATH
      || rawPath === `${FLEET_PORTAL_PATH}/`
      || rawPath === FLEET_PORTAL_API_PATH
      || rawPath.startsWith(FLEET_PORTAL_ASSET_PREFIX)
      || rawPath.startsWith(FLEET_SHARED_ASSET_PREFIX);
  }

  sendUnauthenticated(response: ServerResponse): void {
    sendJson(response, 401, { error: { type: 'fleet_portal_denied' } });
  }

  async handle(input: FleetPortalRouteRequest): Promise<void> {
    const isPage = input.rawPath === FLEET_PORTAL_PATH
      || input.rawPath === `${FLEET_PORTAL_PATH}/`;
    const isApi = input.rawPath === FLEET_PORTAL_API_PATH;
    const isAsset = input.rawPath.startsWith(FLEET_PORTAL_ASSET_PREFIX)
      || input.rawPath.startsWith(FLEET_SHARED_ASSET_PREFIX);
    if ((input.request.method !== 'GET' && input.request.method !== 'HEAD')
      || input.rawQuery
      || (!isPage && !isApi && !isAsset)
      || ((isApi || isPage) && input.request.method !== 'GET')) {
      sendNotFound(input.response);
      return;
    }
    if (isAsset) {
      this.options.ui.serveAsset(input.rawPath, input.request, input.response);
      return;
    }
    try {
      const projection = await this.options.projection.resolve({
        sessionToken: input.sessionToken,
      });
      if (isApi) {
        const body = serializeFleetPortalProjection(projection);
        input.response.writeHead(200, {
          ...strictHeaders('application/json; charset=utf-8', body.byteLength),
          'Content-Security-Policy': PORTAL_HTTP_POLICY.jsonCsp,
        });
        input.response.end(body);
        return;
      }
      if (!this.options.ui.isEnabled()) {
        sendJson(input.response, 503, { error: { type: 'fleet_portal_unavailable' } });
        return;
      }
      this.options.ui.servePage(input.request, input.response);
    } catch (error) {
      if (error instanceof FleetAuthorizationDeniedError) {
        if (error.code === 'authorization_store_error') {
          sendJson(input.response, 503, { error: { type: 'fleet_portal_unavailable' } });
        } else if (PORTAL_HTTP_POLICY.reauthenticationDenials.has(error.code)) {
          if (isApi) this.sendUnauthenticated(input.response);
          else sendLoginRedirect(input.response);
        } else {
          sendJson(input.response, 403, { error: { type: 'fleet_portal_denied' } });
        }
        return;
      }
      sendJson(input.response, 503, { error: { type: 'fleet_portal_unavailable' } });
    }
  }
}
