import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { WebSocketServer } from 'ws';
import {
  compileGatewayGardenRequestTarget,
  GardenRequestTargetError,
  type CompiledGardenRequestTarget,
} from '../fleet-auth/request-capability-target.js';
import {
  compileRequestCapabilityReplayConsumption,
  type RequestCapabilityReplayPort,
} from '../fleet-auth/request-capability-replay.js';
import {
  stripBrowserRequestCapabilityHeaders,
} from '../fleet-auth/request-capability-transport.js';
import type {
  GatewayRequestCapabilitySigner,
  RequestCapabilityAuthContext,
  RequestCapabilityAuthorityVersions,
  RequestCapabilityVerifier,
  VerifiedRequestCapability,
} from '../fleet-auth/request-capability.js';
import {
  FleetAuthorizationDeniedError,
  toRequestCapabilityAuthContext,
  type FleetAuthorizationContext,
} from './fleet-authorization-context.js';
import type { GatewayFleetAuthBroker } from './fleet-auth-broker.js';
import type {
  FleetEscalationCoordinator,
  FleetEscalationGrantBinding,
} from '../fleet-auth/escalation.js';
import {
  resolveFleetAccessMode,
  type FleetAccessMode,
} from '../fleet-auth/fleet-access-mode.js';
import type { FleetAuthAccountRosterEntry } from '../../system/config/fleet-auth-config.js';
import {
  isPrivacyBreakGlassConfirmRoute,
} from '../../shared/contracts/privacy-break-glass.js';
import { buildGardenCapabilityHeaders } from '../fleet-auth/garden-capability-context.js';
import { createSpiffeCheckServerIdentity } from '../../shared/net/mtls.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import {
  parseFleetModelUsageResourceQuery,
  resolveFleetModelUsageInternalRequestTarget,
} from '../../shared/telemetry/fleet-model-usage-request.js';
import {
  CompanionScopedGardenRouteError,
  FLEET_SSO_COMPANION_ROUTE_PREFIX,
  parseCompanionScopedGardenRoute,
  parseFleetSsoOuterTarget,
  type FleetSsoGardenUpstream,
} from '../fleet-auth/fleet-sso-transport.js';
import {
  FLEET_PORTAL_API_PATH,
  GatewayFleetPortalHttpRoutes,
} from './fleet-portal-http-routes.js';
import type { GatewayFleetPortalProjection } from './fleet-portal-projection.js';
import {
  FleetGardenUiAssets,
  type FleetGardenUiAssetsPort,
} from './fleet-garden-ui-assets.js';
import {
  FLEET_MODEL_USAGE_API_PATH,
  GatewayFleetModelUsageHttpRoutes,
} from './fleet-model-usage-http-routes.js';
import type { FleetModelUsageProjectionPort } from './fleet-model-usage-projection.js';
import {
  GatewayFleetLoginLanding,
  type FleetBreakGlassLoginRegistration,
} from './fleet-login-landing.js';
import {
  TestingHarnessGardenDoor,
  TestingHarnessGardenDoorDeniedError,
  type TestingHarnessGardenDoorOptions,
} from './testing-harness-garden-door.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  hasRecordedGardenDenial,
  recordGardenDenial,
  type GardenDenialDetails,
  type GardenDenialLogger,
} from '../../shared/observability/garden-denial-observability.js';

const SESSION_COOKIE_NAME = '__Host-psfn_session';
const MAX_PROXY_BODY_BYTES = 1_048_576;
const MAX_CAPABILITY_HEADER_BYTES = 65_536;
const FLEET_PATH = '/fleet';
const FLEET_LOGIN_PATH = '/fleet/login';
const FLEET_GARDEN_CHAT_PATH = '/v1/chat/completions';
const COMPANION_PREFIX = FLEET_SSO_COMPANION_ROUTE_PREFIX;
const COMPANION_UI_PREFIX = '/companion-ui';
export const FLEET_ESCALATION_GRANT_HEADER = 'x-psfn-escalation-grant';
const FORWARDED_HEADERS = Object.freeze([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
] as const);
const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'range',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'user-agent',
]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'accept-ranges',
  'cache-control',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-security-policy',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'location',
  'referrer-policy',
  'vary',
  'x-content-type-options',
  'x-frame-options',
]);

export interface FleetSsoTrustedOriginOptions {
  readonly canonicalOrigin: string;
  /**
   * Explicitly trust one repository-owned ingress hop. NetworkPolicy must
   * independently restrict the listener to that ingress controller.
   */
  readonly trustProxy: boolean;
}

export interface GatewayFleetSsoRouterOptions extends FleetSsoTrustedOriginOptions {
  readonly broker: Pick<GatewayFleetAuthBroker, 'resolveAuthorizationContext'>;
  readonly signer: GatewayRequestCapabilitySigner;
  readonly verifier: RequestCapabilityVerifier;
  readonly replay: RequestCapabilityReplayPort;
  readonly portalProjection: Pick<GatewayFleetPortalProjection, 'resolve'>;
  readonly portalUi?: FleetGardenUiAssetsPort;
  readonly modelUsageProjection: FleetModelUsageProjectionPort;
  readonly escalation?: Pick<FleetEscalationCoordinator, 'consumeGrant'>;
  /** Boot-frozen admin-unconditional roster; drives the D1 access-mode seam. */
  readonly accountRoster?: readonly FleetAuthAccountRosterEntry[];
  readonly upstreams: readonly FleetSsoGardenUpstream[];
  readonly companionUi?: {
    readonly companionId: CompanionId;
    readonly origin: URL;
  };
  readonly breakGlassLogin?: FleetBreakGlassLoginRegistration;
  readonly nowSeconds?: () => number;
  readonly testingHarness?: TestingHarnessGardenDoorOptions;
  readonly denialLogger?: GardenDenialLogger;
}

export interface FleetGardenChatAdmission {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly body: Buffer;
  readonly companionId: CompanionId;
  readonly authorization: FleetAuthorizationContext;
}

export type FleetGardenChatHandler = (
  admission: FleetGardenChatAdmission,
) => Promise<void>;

interface ParsedGardenRoute {
  companionId: CompanionId;
  upstreamTarget: string;
  publicPrefix: string;
}

type FleetSsoDenialDetails = Omit<GardenDenialDetails, 'response' | 'status'>;
type FleetSsoResponseType =
  | 'fleet_sso_request_denied'
  | 'fleet_sso_unavailable'
  | 'garden_upstream_unavailable'
  | 'invalid_request_target'
  | 'not_found';
type GardenUpstreamFailureCause = 'connect_refused' | 'setup_error' | 'socket_error' | 'timeout';

interface GardenUpstreamFailureDetails {
  readonly cause: GardenUpstreamFailureCause;
  readonly routeId: string;
  readonly action: string;
  readonly principalId: string;
  readonly errorName: string;
  readonly errorCode?: string;
}

function defaultFleetSsoDenial(
  status: FleetSsoRequestError['status'],
): FleetSsoDenialDetails | undefined {
  switch (status) {
    case 400:
      return { reasonCode: 'request_target_invalid' };
    case 401:
      return { reasonCode: 'capability_required' };
    case 403:
      return { reasonCode: 'fleet_authorization_denied' };
    case 404:
      return { reasonCode: 'fleet_target_not_found' };
    case 413:
      return { reasonCode: 'request_body_too_large' };
    case 502:
    case 503:
      return undefined;
  }
}

class FleetSsoRequestError extends Error {
  readonly denial?: FleetSsoDenialDetails;

  constructor(
    readonly status: 400 | 401 | 403 | 404 | 413 | 502 | 503,
    message: string,
    denial?: FleetSsoDenialDetails,
    readonly responseType?: FleetSsoResponseType,
  ) {
    super(message);
    this.name = 'FleetSsoRequestError';
    this.denial = denial ?? defaultFleetSsoDenial(status);
  }
}

class GardenUpstreamTimeoutError extends Error {
  constructor() {
    super('Garden upstream timed out');
    this.name = 'GardenUpstreamTimeoutError';
  }
}

class GardenUpstreamSocketError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('Garden upstream socket failed');
    this.name = 'GardenUpstreamSocketError';
    this.cause = cause;
  }
}

function gardenUpstreamFailureCause(error: unknown): GardenUpstreamFailureCause {
  if (error instanceof GardenUpstreamTimeoutError) return 'timeout';
  if (error instanceof GardenUpstreamSocketError) {
    return error.cause instanceof Error
      && 'code' in error.cause
      && error.cause.code === 'ECONNREFUSED'
      ? 'connect_refused'
      : 'socket_error';
  }
  return 'setup_error';
}

function gardenUpstreamOriginalError(error: unknown): unknown {
  return error instanceof GardenUpstreamSocketError ? error.cause : error;
}

function fleetSsoResponseType(error: FleetSsoRequestError): FleetSsoResponseType {
  if (error.responseType) return error.responseType;
  if (error.status === 404) return 'not_found';
  if ((error.status === 502 || error.status === 503) && !error.denial) {
    return 'fleet_sso_unavailable';
  }
  return 'fleet_sso_request_denied';
}

class FleetSsoUpstreamUnavailableError extends FleetSsoRequestError {
  override readonly cause: unknown;

  constructor(
    readonly failure: GardenUpstreamFailureDetails,
    cause: unknown,
  ) {
    super(502, 'Garden upstream is unavailable', undefined, 'garden_upstream_unavailable');
    this.name = 'FleetSsoUpstreamUnavailableError';
    this.cause = cause;
  }
}

class FleetSsoUpstreamUpgradeError extends FleetSsoRequestError {
  constructor(status: 502 | 503, message: string) {
    super(status, message);
    this.name = 'FleetSsoUpstreamUpgradeError';
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function noStoreHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    ...noStoreHeaders(),
    'Content-Length': String(body.byteLength),
  });
  response.end(body);
}

function writeSocketError(socket: Duplex, status: 400 | 401 | 403 | 404 | 413 | 502 | 503): void {
  const label = status === 400 ? 'Bad Request'
    : status === 401 ? 'Unauthorized'
      : status === 403 ? 'Forbidden'
        : status === 404 ? 'Not Found'
          : status === 413 ? 'Payload Too Large'
            : status === 502 ? 'Bad Gateway'
              : 'Service Unavailable';
  socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function fleetGardenUpgradeClose(
  status: 400 | 401 | 403 | 404 | 413 | 502 | 503,
): { code: number; reason: string } {
  switch (status) {
    case 400:
    case 413:
      return { code: 4400, reason: 'Invalid Garden stream request' };
    case 401:
    case 403:
      return { code: 4401, reason: 'Garden stream authentication required' };
    case 404:
      return { code: 4404, reason: 'Garden stream unavailable' };
    case 502:
    case 503:
      return { code: 4503, reason: 'Garden stream service unavailable' };
  }
}

function hasAnyHeader(headers: IncomingHttpHeaders, names: readonly string[]): boolean {
  return names.some(name => headers[name] !== undefined);
}

/**
 * Resolve the one public origin. Direct TLS and an explicitly enabled single
 * proxy hop are mutually exclusive shapes; mixed/duplicate forwarding
 * metadata fails closed before OAuth/session processing.
 */
export function resolveFleetSsoBrowserOrigin(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  options: FleetSsoTrustedOriginOptions,
): string {
  const canonical = new URL(options.canonicalOrigin);
  const host = singleHeader(request.headers.host);
  if (host !== canonical.host || request.headers.forwarded !== undefined) {
    throw new FleetSsoRequestError(400, 'Public origin provenance is invalid');
  }
  const directTls = request.socket instanceof TLSSocket
    ? request.socket.encrypted
    : (request.socket as { encrypted?: boolean }).encrypted === true;
  const forwardedHost = singleHeader(request.headers['x-forwarded-host']);
  const forwardedProto = singleHeader(request.headers['x-forwarded-proto']);
  const forwardedPort = singleHeader(request.headers['x-forwarded-port']);
  const forwardedFor = singleHeader(request.headers['x-forwarded-for'])?.trim();
  if (directTls) {
    if (hasAnyHeader(request.headers, FORWARDED_HEADERS.slice(1))) {
      throw new FleetSsoRequestError(400, 'Forwarded origin metadata is forbidden on direct TLS');
    }
    return canonical.origin;
  }
  if (!options.trustProxy
    || forwardedHost !== canonical.host
    || forwardedProto !== 'https'
    || (forwardedPort !== undefined && forwardedPort !== (canonical.port || '443'))
    || !forwardedFor
    || isIP(forwardedFor) === 0) {
    throw new FleetSsoRequestError(400, 'Trusted HTTPS proxy provenance is invalid');
  }
  return canonical.origin;
}

function readOpaqueSessionCookie(request: IncomingMessage): string | undefined {
  const raw = singleHeader(request.headers.cookie);
  if (!raw) return undefined;
  const values: string[] = [];
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (value) values.push(value);
  }
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(values[0]!)) return undefined;
  return values[0];
}

/**
 * The gateway and the fleet Garden control plane share one companion-scoped
 * route parser (`parseCompanionScopedGardenRoute`) so both hops bind exactly
 * the same companion selection for the same request bytes. This wrapper only
 * translates shared parse failures into unified-origin protocol errors.
 */
function parseOuterPath(rawTarget: string): { rawPath: string; rawQuery: string } {
  try {
    return parseFleetSsoOuterTarget(rawTarget);
  } catch (error) {
    if (error instanceof CompanionScopedGardenRouteError) {
      throw new FleetSsoRequestError(
        400,
        'Unified-origin request target is invalid',
        undefined,
        'invalid_request_target',
      );
    }
    throw error;
  }
}

function parseGardenRoute(rawTarget: string): ParsedGardenRoute | undefined {
  let route;
  try {
    route = parseCompanionScopedGardenRoute(rawTarget);
  } catch (error) {
    if (error instanceof CompanionScopedGardenRouteError) {
      throw new FleetSsoRequestError(
        error.code === 'not_found' ? 404 : 400,
        error.code === 'not_found' ? 'Resource not found' : 'Unified-origin request target is invalid',
        undefined,
        error.code === 'invalid_target' ? 'invalid_request_target' : undefined,
      );
    }
    throw error;
  }
  if (!route) return undefined;
  return {
    companionId: route.companionId,
    upstreamTarget: route.innerTarget,
    publicPrefix: route.publicPrefix,
  };
}

/**
 * The consolidated fleet Garden derives the companion binding from the
 * canonical companion-scoped route (garden-control-plane invariant 3), so
 * fleet upstreams receive the full public target. A single-companion operator
 * surface admits the inner target directly against its fixed companion.
 */
function upstreamRequestTarget(
  upstream: FleetSsoGardenUpstream,
  route: ParsedGardenRoute,
): string {
  return upstream.companionScopedTarget
    ? `${route.publicPrefix}${route.upstreamTarget}`
    : route.upstreamTarget;
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  if (request.headers['transfer-encoding'] !== undefined) {
    throw new FleetSsoRequestError(400, 'Transfer-Encoding is not accepted at the unified origin');
  }
  const rawLength = singleHeader(request.headers['content-length']);
  const declaredLength = rawLength === undefined ? 0 : Number(rawLength);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    throw new FleetSsoRequestError(400, 'Content-Length is invalid');
  }
  if (declaredLength > MAX_PROXY_BODY_BYTES) {
    throw new FleetSsoRequestError(413, 'Request body is too large');
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += bytes.byteLength;
    if (received > MAX_PROXY_BODY_BYTES || received > declaredLength) {
      throw new FleetSsoRequestError(413, 'Request body is too large');
    }
    chunks.push(bytes);
  }
  if (received !== declaredLength) {
    throw new FleetSsoRequestError(400, 'Request body length changed in transit');
  }
  return Buffer.concat(chunks, received);
}

function authorityVersions(context: FleetAuthorizationContext): RequestCapabilityAuthorityVersions {
  return Object.freeze({
    authorityGeneration: context.authority.authorityGeneration,
    globalAuthEpoch: context.authority.globalAuthEpoch,
    sessionAuthnVersion: context.session.authnVersion,
    sessionAuthzVersion: context.session.authzVersion,
    bindingVersion: context.session.bindingVersion,
    grantVersion: context.session.grantVersion,
    policyVersion: context.session.policyVersion,
  });
}

export function buildFleetSsoProxyRequestHeaders(
  input: IncomingHttpHeaders,
): IncomingHttpHeaders {
  const output: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(input)) {
    if (!REQUEST_HEADER_ALLOWLIST.has(name) || value === undefined) continue;
    output[name] = value;
  }
  return output;
}

function copyResponseHeaders(
  input: IncomingHttpHeaders,
  publicPrefix: string,
): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!RESPONSE_HEADER_ALLOWLIST.has(name) || value === undefined) continue;
    if (name === 'location') {
      if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
        && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value)) {
        output[name] = value === publicPrefix
          || value.startsWith(`${publicPrefix}/`)
          || value.startsWith(`${publicPrefix}?`)
          ? value
          : `${publicPrefix}${value}`;
      }
    } else if (typeof value === 'string' || Array.isArray(value)) {
      output[name] = value;
    }
  }
  return output;
}

function assertAllowedContext(
  context: FleetAuthorizationContext,
  companionId: CompanionId,
  action: FleetAuthorizationContext['authorization']['action'],
): void {
  if (context.companionId !== companionId || context.authorization.action !== action) {
    throw new FleetSsoRequestError(404, 'Resource not found');
  }
}

function requestOptions(
  upstream: Pick<FleetSsoGardenUpstream, 'origin' | 'tls'>,
  method: string,
  target: string,
  headers: IncomingHttpHeaders,
): RequestOptions {
  const options: RequestOptions = {
    protocol: upstream.origin.protocol,
    hostname: upstream.origin.hostname,
    port: upstream.origin.port || (upstream.origin.protocol === 'https:' ? 443 : 80),
    method,
    path: target,
    headers: { ...headers, host: upstream.origin.host },
    timeout: 30_000,
  };
  if (!upstream.tls) return options;
  return {
    ...options,
    ca: readFileSync(upstream.tls.caPath),
    cert: readFileSync(upstream.tls.certPath),
    key: readFileSync(upstream.tls.keyPath),
    rejectUnauthorized: true,
    servername: upstream.tls.serverName ?? upstream.origin.hostname,
    checkServerIdentity: createSpiffeCheckServerIdentity(upstream.tls.expectedPeerSpiffeUri),
    minVersion: 'TLSv1.3',
  };
}

export class GatewayFleetSsoRouter {
  private readonly upstreams: ReadonlyMap<string, FleetSsoGardenUpstream>;
  private readonly portalRoutes: GatewayFleetPortalHttpRoutes;
  private readonly loginLanding: GatewayFleetLoginLanding;
  private gardenChatHandler: FleetGardenChatHandler | null = null;
  private readonly modelUsageRoutes: GatewayFleetModelUsageHttpRoutes;
  private readonly testingHarnessDoor?: TestingHarnessGardenDoor;
  private readonly denialLogger: GardenDenialLogger;
  private readonly rejectedUpgradeServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
  });

  constructor(private readonly options: GatewayFleetSsoRouterOptions) {
    const canonical = new URL(options.canonicalOrigin);
    if (canonical.protocol !== 'https:' || canonical.origin !== options.canonicalOrigin) {
      throw new Error('Fleet SSO router requires an exact canonical HTTPS origin');
    }
    if (options.upstreams.length === 0) {
      throw new Error('Fleet SSO router requires at least one Garden upstream');
    }
    this.testingHarnessDoor = options.testingHarness
      ? new TestingHarnessGardenDoor(options.testingHarness)
      : undefined;
    this.denialLogger = options.denialLogger ?? createComponentLogger('GatewayFleetSsoRouter');
    this.portalRoutes = new GatewayFleetPortalHttpRoutes({
      projection: options.portalProjection,
      ui: options.portalUi ?? new FleetGardenUiAssets(),
    });
    this.loginLanding = new GatewayFleetLoginLanding(options.breakGlassLogin);
    this.modelUsageRoutes = new GatewayFleetModelUsageHttpRoutes({
      projection: options.modelUsageProjection,
    });
    const entries = options.upstreams.map((upstream) => {
      if (upstream.origin.username || upstream.origin.password || upstream.origin.pathname !== '/'
        || upstream.origin.search || upstream.origin.hash) {
        throw new Error('Fleet SSO Garden upstream must be an exact origin');
      }
      const loopbackHttp = upstream.origin.protocol === 'http:'
        && ['127.0.0.1', '::1', 'localhost'].includes(upstream.origin.hostname);
      if (!loopbackHttp && (upstream.origin.protocol !== 'https:' || !upstream.tls)) {
        throw new Error('Non-loopback Fleet SSO Garden upstream requires HTTPS mTLS');
      }
      if (loopbackHttp && upstream.tls) {
        throw new Error('Loopback Fleet SSO Garden upstream must not carry TLS configuration');
      }
      return [upstream.companionId, upstream] as const;
    });
    this.upstreams = new Map(entries);
    if (this.upstreams.size !== entries.length) {
      throw new Error('Fleet SSO Garden upstream companion IDs must be unique');
    }
    if (options.companionUi) {
      const { origin, companionId } = options.companionUi;
      if (origin.protocol !== 'http:' || origin.username || origin.password
        || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error('Fleet SSO Companion UI upstream must be an exact internal HTTP origin');
      }
      if (!this.upstreams.has(companionId)) {
        throw new Error('Fleet SSO Companion UI must bind to a registered companion');
      }
    }
  }

  matches(rawTarget: string): boolean {
    try {
      const { rawPath } = parseOuterPath(rawTarget);
      return rawPath === FLEET_PATH || rawPath === `${FLEET_PATH}/`
        || rawPath.startsWith(`${FLEET_PATH}/_app/`)
        || rawPath.startsWith('/_app/')
        || rawPath === FLEET_LOGIN_PATH || rawPath.startsWith(FLEET_PORTAL_API_PATH)
        || rawPath === FLEET_MODEL_USAGE_API_PATH
        || rawPath.startsWith(COMPANION_PREFIX)
        || rawPath === COMPANION_UI_PREFIX || rawPath.startsWith(`${COMPANION_UI_PREFIX}/`);
    } catch {
      return rawTarget.startsWith(FLEET_PATH) || rawTarget.startsWith(FLEET_PORTAL_API_PATH)
        || rawTarget.startsWith('/_app/')
        || rawTarget.startsWith(FLEET_MODEL_USAGE_API_PATH)
        || rawTarget.startsWith(COMPANION_PREFIX)
        || rawTarget.startsWith(COMPANION_UI_PREFIX);
    }
  }

  registerGardenChatHandler(handler: FleetGardenChatHandler): void {
    if (this.gardenChatHandler) {
      throw new Error('Fleet SSO Garden chat handler is already registered');
    }
    this.gardenChatHandler = handler;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.observeResponseDenial(request, response);
    try {
      resolveFleetSsoBrowserOrigin(request, this.options);
      const browserOrigin = singleHeader(request.headers.origin);
      if (browserOrigin !== undefined && browserOrigin !== this.options.canonicalOrigin) {
        throw new FleetSsoRequestError(400, 'Browser origin is invalid');
      }
      const { rawPath, rawQuery } = parseOuterPath(request.url ?? '/');
      if (rawPath === FLEET_LOGIN_PATH) {
        if (request.method !== 'GET' || rawQuery) throw new FleetSsoRequestError(404, 'Resource not found');
        this.loginLanding.send(response);
        return;
      }
      const companionUiRequest = rawPath === COMPANION_UI_PREFIX
        || rawPath.startsWith(`${COMPANION_UI_PREFIX}/`);
      if (this.testingHarnessDoor?.matchesBearer(request)) {
        const route = parseGardenRoute(request.url ?? '/');
        if (!route) throw new FleetSsoRequestError(404, 'Resource not found');
        const upstream = this.upstreams.get(route.companionId);
        if (!upstream) throw new FleetSsoRequestError(404, 'Resource not found');
        const body = await readBoundedBody(request);
        const authorization = await this.testingHarnessDoor.authorize({
          companionId: route.companionId,
          upstreamTarget: route.upstreamTarget,
          method: request.method ?? 'GET',
          headers: request.headers,
          body,
        });
        const issued = await this.issueCapability({
          ...authorization,
          authContext: Object.freeze({
            ...authorization.authContext,
            fleetAccessMode: resolveFleetAccessMode(
              this.options.accountRoster,
              route.companionId,
            ),
          }),
        });
        await this.proxyHttp(request, response, upstream, route, body, issued);
        return;
      }
      const sessionToken = readOpaqueSessionCookie(request);
      if (!sessionToken) {
        if (request.method === 'GET' && (
          rawPath === FLEET_PATH
          || rawPath === `${FLEET_PATH}/`
          || companionUiRequest
        )) {
          this.loginLanding.send(response);
          return;
        }
        if (rawPath.startsWith(FLEET_PORTAL_API_PATH)) {
          this.portalRoutes.sendUnauthenticated(response);
          return;
        }
        if (rawPath === FLEET_MODEL_USAGE_API_PATH) {
          this.modelUsageRoutes.sendUnauthenticated(response);
          return;
        }
        throw new FleetSsoRequestError(401, 'Authentication required');
      }
      if (companionUiRequest) {
        const companionUi = this.options.companionUi;
        if (!companionUi) throw new FleetSsoRequestError(404, 'Resource not found');
        try {
          const context = await this.options.broker.resolveAuthorizationContext({
            sessionToken,
            audience: 'fleet',
            companionId: companionUi.companionId,
            action: 'companion.read',
            correlationId: randomUUID(),
          });
          assertAllowedContext(context, companionUi.companionId, 'companion.read');
        } catch (error) {
          if (error instanceof FleetAuthorizationDeniedError) {
            recordGardenDenial(this.denialLogger, {
              reasonCode: 'fleet_authorization_denied',
              reason: error.code,
              status: 403,
              routeId: `${request.method ?? 'GET'} ${rawPath}`,
              action: 'companion.read',
              response,
            });
            this.loginLanding.send(response);
            return;
          }
          throw error;
        }
        await this.serveCompanionUi(request, response, rawPath, rawQuery);
        return;
      }
      if (this.portalRoutes.matches(rawPath) || rawPath.startsWith(FLEET_PORTAL_API_PATH)) {
        await this.portalRoutes.handle({
          request,
          response,
          sessionToken,
          rawPath,
          rawQuery,
        });
        return;
      }
      if (this.modelUsageRoutes.matches(rawPath)) {
        await this.modelUsageRoutes.handle({
          request,
          response,
          sessionToken,
          rawPath,
          rawQuery,
        });
        return;
      }
      const route = parseGardenRoute(request.url ?? '/');
      if (!route) throw new FleetSsoRequestError(404, 'Resource not found');
      const upstream = this.upstreams.get(route.companionId);
      if (!upstream) throw new FleetSsoRequestError(404, 'Resource not found');
      const body = await readBoundedBody(request);
      const issued = await this.authorizeAndIssue({
        sessionToken,
        route,
        method: request.method ?? 'GET',
        headers: request.headers,
        body,
      });
      if (route.upstreamTarget === FLEET_GARDEN_CHAT_PATH
        && request.method === 'POST') {
        if (!this.gardenChatHandler) {
          throw new FleetSsoRequestError(503, 'Fleet Garden chat is unavailable');
        }
        await this.gardenChatHandler({
          request,
          response,
          body,
          companionId: route.companionId,
          authorization: issued.context,
        });
        return;
      }
      await this.proxyHttp(request, response, upstream, route, body, issued);
    } catch (error) {
      this.recordRequestFailure(request, error, response);
      if (response.writableEnded || response.destroyed) return;
      if (error instanceof FleetSsoRequestError) {
        sendJson(response, error.status, {
          error: {
            type: fleetSsoResponseType(error),
          },
        });
        return;
      }
      if (error instanceof TestingHarnessGardenDoorDeniedError) {
        sendJson(response, 404, { error: { type: 'not_found' } });
        return;
      }
      if (error instanceof GardenRequestTargetError) {
        sendJson(response, error.code === 'route_not_declared' ? 404 : 400, {
          error: { type: error.code === 'route_not_declared' ? 'not_found' : 'invalid_request_target' },
        });
        return;
      }
      sendJson(response, 503, { error: { type: 'fleet_sso_unavailable' } });
    }
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    void this.proxyUpgrade(request, socket, head).catch((error) => {
      const status = error instanceof FleetSsoRequestError ? error.status : 503;
      this.recordRequestFailure(request, error);
      if (socket.destroyed) return;
      if (error instanceof FleetSsoUpstreamUpgradeError
        && this.canSurfaceUpstreamUpgradeFailure(request)) {
        this.rejectedUpgradeServer.handleUpgrade(request, socket, head, (webSocket) => {
          const close = fleetGardenUpgradeClose(status);
          webSocket.close(close.code, close.reason);
        });
        return;
      }
      writeSocketError(socket, status);
    });
  }

  private canSurfaceUpstreamUpgradeFailure(request: IncomingMessage): boolean {
    if (singleHeader(request.headers.origin) !== this.options.canonicalOrigin) return false;
    try {
      return parseGardenRoute(request.url ?? '')?.upstreamTarget === '/api/admin/events';
    } catch {
      return false;
    }
  }

  private observeResponseDenial(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (typeof response.once !== 'function') return;
    response.once('finish', () => {
      if (hasRecordedGardenDenial(response)) return;
      const status = response.statusCode === 400
        || response.statusCode === 401
        || response.statusCode === 403
        || response.statusCode === 404
        || response.statusCode === 409
        || response.statusCode === 413
        ? response.statusCode
        : undefined;
      if (status === undefined) return;
      const reasonCode = status === 400
        ? 'request_target_invalid'
        : status === 401
          ? 'capability_required'
          : status === 403
            ? 'fleet_authorization_denied'
            : status === 404
              ? 'fleet_target_not_found'
              : status === 409
                ? 'capability_already_consumed'
                : 'request_body_too_large';
      recordGardenDenial(this.denialLogger, {
        reasonCode,
        reason: 'response_denied',
        status,
        routeId: `${request.method ?? 'GET'} ${request.url ?? '/'}`,
        response,
      });
    });
  }

  private recordRequestFailure(
    request: IncomingMessage,
    error: unknown,
    response?: ServerResponse,
  ): void {
    if (error instanceof FleetSsoUpstreamUnavailableError) {
      this.denialLogger.warn('Fleet Garden upstream unavailable', {
        reasonCode: 'garden_upstream_unavailable',
        ...error.failure,
        status: error.status,
      });
      return;
    }
    let status: GardenDenialDetails['status'] | undefined;
    let denial: FleetSsoDenialDetails | undefined;
    if (error instanceof FleetSsoRequestError) {
      if (error.status === 502 || (error.status === 503 && !error.denial)) return;
      status = error.status;
      denial = error.denial;
    } else if (error instanceof TestingHarnessGardenDoorDeniedError) {
      status = 404;
      denial = {
        reasonCode: 'capability_testing_harness_disabled',
        reason: 'testing_harness_policy_denied',
        principalId: 'testing-harness',
      };
    } else if (error instanceof GardenRequestTargetError) {
      status = error.code === 'route_not_declared' ? 404 : 400;
      denial = {
        reasonCode: error.code === 'route_not_declared'
          ? 'route_not_declared'
          : error.code === 'authority_forbidden'
            ? 'browser_authority_forbidden'
            : 'request_target_invalid',
        reason: error.code,
      };
    }
    if (status === undefined || !denial) return;

    recordGardenDenial(this.denialLogger, {
      ...denial,
      status,
      routeId: denial.routeId ?? `${request.method ?? 'GET'} ${request.url ?? '/'}`,
      ...(response ? { response } : {}),
    });
  }

  private async serveCompanionUi(
    request: IncomingMessage,
    response: ServerResponse,
    rawPath: string,
    rawQuery: string,
  ): Promise<void> {
    const companionUi = this.options.companionUi;
    if (!companionUi || (request.method !== 'GET' && request.method !== 'HEAD')
      || request.headers['transfer-encoding'] !== undefined
      || (singleHeader(request.headers['content-length']) ?? '0') !== '0') {
      throw new FleetSsoRequestError(404, 'Resource not found');
    }
    const upstreamTarget = rawQuery ? `${rawPath}?${rawQuery}` : rawPath;
    await new Promise<void>((resolve, reject) => {
      const headers = buildFleetSsoProxyRequestHeaders(request.headers);
      const proxyRequest = httpRequest(
        requestOptions(
          { origin: companionUi.origin },
          request.method ?? 'GET',
          upstreamTarget,
          headers,
        ),
        (proxyResponse) => {
          response.writeHead(
            proxyResponse.statusCode ?? 502,
            copyResponseHeaders(proxyResponse.headers, COMPANION_UI_PREFIX),
          );
          proxyResponse.pipe(response);
          proxyResponse.on('end', resolve);
          proxyResponse.on('error', reject);
        },
      );
      proxyRequest.on('timeout', () => proxyRequest.destroy(new Error('Companion UI upstream timed out')));
      proxyRequest.on('error', reject);
      proxyRequest.end();
    }).catch(() => {
      throw new FleetSsoRequestError(502, 'Companion UI upstream is unavailable');
    });
  }

  private async authorizeAndIssue(input: {
    sessionToken: string;
    route: ParsedGardenRoute;
    method: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }): Promise<{
    token: string;
    verified: VerifiedRequestCapability;
    context: FleetAuthorizationContext;
  }> {
    const targetHeaders = { ...input.headers };
    stripBrowserRequestCapabilityHeaders(targetHeaders);
    const target = compileGatewayGardenRequestTarget({
      rawTarget: input.route.upstreamTarget,
      method: input.method,
      companionId: input.route.companionId,
      headers: targetHeaders,
      body: input.body,
    });
    const rawEscalationGrantId = singleHeader(input.headers[FLEET_ESCALATION_GRANT_HEADER]);
    const isPrivacyConfirm = target.action === 'privacy.break_glass'
      && isPrivacyBreakGlassConfirmRoute(target.resource.routeId)
      && target.authorization.requirements.assurance === 'privacy_break_glass';
    const isEscalationTarget = target.authorization.requirements.assurance === 'escalated'
      || isPrivacyConfirm;
    if (!isEscalationTarget && rawEscalationGrantId !== undefined) {
      throw new FleetSsoRequestError(404, 'Resource not found', {
        reasonCode: 'request_target_invalid',
        reason: 'unexpected_escalation_grant',
        routeId: target.resource.routeId,
        action: target.action,
      });
    }
    const requestId = randomUUID();
    let context: FleetAuthorizationContext;
    try {
      context = await this.options.broker.resolveAuthorizationContext({
        sessionToken: input.sessionToken,
        audience: 'fleet',
        companionId: input.route.companionId,
        action: target.action,
        correlationId: requestId,
      });
      assertAllowedContext(context, input.route.companionId, target.action);
    } catch (error) {
      throw new FleetSsoRequestError(404, 'Resource not found', {
        reasonCode: 'fleet_authorization_denied',
        reason: error instanceof FleetAuthorizationDeniedError
          ? error.code
          : 'authorization_context_unavailable',
        routeId: target.resource.routeId,
        action: target.action,
      });
    }
    const decisionId = context.provenance.authorizationEventId;
    const versions = authorityVersions(context);
    let consumedEscalation: FleetEscalationGrantBinding | undefined;
    if (isEscalationTarget) {
      if (!rawEscalationGrantId || !isRfc4122Uuid(rawEscalationGrantId)
        || !this.options.escalation) {
        // Fail closed, and say why: the surface requires an audited grant.
        throw new FleetSsoRequestError(403, 'Audited escalation grant required', {
          reasonCode: 'escalation_grant_required',
          routeId: target.resource.routeId,
          action: target.action,
          principalId: context.principalId,
        });
      }
      try {
        consumedEscalation = await this.options.escalation.consumeGrant({
          grantId: rawEscalationGrantId,
          token: input.sessionToken,
          requestOrigin: this.options.canonicalOrigin,
          target,
        });
      } catch {
        throw new FleetSsoRequestError(403, 'Audited escalation grant required', {
          reasonCode: 'escalation_grant_required',
          reason: 'escalation_grant_rejected',
          routeId: target.resource.routeId,
          action: target.action,
          principalId: context.principalId,
        });
      }
      if (!timingSafeStringEqual(consumedEscalation.principalId, context.principalId)
        || !timingSafeStringEqual(consumedEscalation.browserSessionId, context.session.recordId)
        || consumedEscalation.expiresAt.getTime()
          <= (this.options.nowSeconds ? this.options.nowSeconds() * 1_000 : Date.now())) {
        throw new FleetSsoRequestError(403, 'Audited escalation grant required', {
          reasonCode: 'escalation_grant_required',
          reason: 'escalation_grant_binding_invalid',
          routeId: target.resource.routeId,
          action: target.action,
          principalId: context.principalId,
        });
      }
    }
    const fleetAccessMode: FleetAccessMode = resolveFleetAccessMode(
      this.options.accountRoster,
      input.route.companionId,
    );
    const authContext = toRequestCapabilityAuthContext(context);
    const fleetCompanionIds = target.method === 'GET'
      && target.canonicalPath === '/api/admin/fleet-model-usage'
      && target.action === 'models.read'
      ? await this.resolveFleetModelUsageRoster(
          input.sessionToken,
          input.route.companionId,
          context,
        )
      : undefined;
    let fleetModelUsageRequestTarget: string | undefined;
    if (fleetCompanionIds) {
      try {
        fleetModelUsageRequestTarget = resolveFleetModelUsageInternalRequestTarget(
          parseFleetModelUsageResourceQuery(target.resource.query),
          Date.parse(authContext.resolvedAt),
        );
      } catch {
        throw new FleetSsoRequestError(400, 'Invalid fleet model usage query', {
          reasonCode: 'request_target_invalid',
          reason: 'fleet_model_usage_query_invalid',
          routeId: target.resource.routeId,
          action: target.action,
          principalId: context.principalId,
        });
      }
    }
    return await this.issueCapability({
      target,
      requestId,
      decisionId,
      authContext: consumedEscalation
        ? Object.freeze({
          ...authContext,
          fleetAccessMode,
          sessionAssurance: isPrivacyConfirm ? 'break_glass' as const : 'escalated' as const,
        })
        : Object.freeze({
            ...authContext,
            fleetAccessMode,
            ...(fleetCompanionIds && fleetModelUsageRequestTarget
              ? { fleetCompanionIds, fleetModelUsageRequestTarget }
              : {}),
          }),
      versions,
      context,
    });
  }

  private async issueCapability(input: {
    target: CompiledGardenRequestTarget;
    requestId: string;
    decisionId: string;
    authContext: RequestCapabilityAuthContext;
    versions: RequestCapabilityAuthorityVersions;
    context: FleetAuthorizationContext;
  }): Promise<{
    token: string;
    verified: VerifiedRequestCapability;
    context: FleetAuthorizationContext;
  }> {
    const capabilityInput = {
      target: input.target,
      requestId: input.requestId,
      decisionId: input.decisionId,
      authContext: input.authContext,
      versions: input.versions,
    };
    const testingHarnessParent = input.authContext.provider === 'testing_harness';
    if (testingHarnessParent
      && (!timingSafeStringEqual(input.authContext.principalId, 'testing-harness')
        || !timingSafeStringEqual(input.authContext.providerSubjectId, 'testing-harness'))) {
      throw new FleetSsoRequestError(404, 'Resource not found', {
        reasonCode: 'capability_context_invalid',
        reason: 'testing_harness_principal_invalid',
        routeId: input.target.resource.routeId,
        action: input.target.action,
        principalId: input.context.principalId,
      });
    }
    const token = testingHarnessParent
      ? this.options.signer.signTestingHarness(capabilityInput)
      : this.options.signer.signOperator(capabilityInput);
    if (Buffer.byteLength(token, 'ascii') > MAX_CAPABILITY_HEADER_BYTES) {
      throw new FleetSsoRequestError(503, 'Issued capability exceeds the transport envelope', {
        reasonCode: 'capability_invalid',
        reason: 'issued_capability_too_large',
        routeId: input.target.resource.routeId,
        action: input.target.action,
        principalId: input.context.principalId,
      });
    }
    const verifyInput = {
      token,
      target: input.target,
      requestId: input.requestId,
      decisionId: input.decisionId,
      versions: input.versions,
      ...(this.options.nowSeconds ? { nowSeconds: this.options.nowSeconds() } : {}),
    };
    const verified = testingHarnessParent
      ? this.options.verifier.verifyTestingHarness(verifyInput)
      : this.options.verifier.verifyOperator(verifyInput);
    const replay = await this.options.replay.consume(
      compileRequestCapabilityReplayConsumption({ token, verified, target: input.target }),
    );
    if (replay.outcome !== 'consumed') {
      throw new FleetSsoRequestError(404, 'Resource not found', {
        reasonCode: replay.outcome === 'replayed'
          ? 'capability_already_consumed'
          : 'capability_replay_mismatch',
        routeId: input.target.resource.routeId,
        action: input.target.action,
        principalId: input.context.principalId,
      });
    }
    return { token, verified, context: input.context };
  }

  private async resolveFleetModelUsageRoster(
    sessionToken: string,
    selectedCompanionId: CompanionId,
    selectedContext: FleetAuthorizationContext,
  ): Promise<readonly string[]> {
    const resolved = await Promise.all([...this.upstreams.keys()].map(async (companionId) => {
      const typedCompanionId = createCompanionId(companionId);
      if (typedCompanionId === selectedCompanionId) return typedCompanionId;
      try {
        const context = await this.options.broker.resolveAuthorizationContext({
          sessionToken,
          audience: 'fleet',
          companionId: typedCompanionId,
          action: 'models.read',
          correlationId: randomUUID(),
        });
        assertAllowedContext(context, typedCompanionId, 'models.read');
        if (context.principalId !== selectedContext.principalId
          || context.session.recordId !== selectedContext.session.recordId) {
          return null;
        }
        return typedCompanionId;
      } catch {
        return null;
      }
    }));
    return Object.freeze(resolved.flatMap(companionId => (
      companionId === null ? [] : [companionId]
    )).sort());
  }

  private proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    upstream: FleetSsoGardenUpstream,
    route: ParsedGardenRoute,
    body: Buffer,
    issued: { token: string; verified: VerifiedRequestCapability },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const headers = buildFleetSsoProxyRequestHeaders(request.headers);
      headers['content-length'] = String(body.byteLength);
      // Canonical Garden capability envelope: one token header plus one
      // canonical context header, exactly what Garden admission consumes.
      Object.assign(headers, buildGardenCapabilityHeaders({
        token: issued.token,
        context: {
          requestId: issued.verified.requestId,
          decisionId: issued.verified.decisionId,
          versions: issued.verified.versions,
        },
      }));
      const requestFn = upstream.origin.protocol === 'https:' ? httpsRequest : httpRequest;
      const proxyRequest = requestFn(
        requestOptions(upstream, request.method ?? 'GET', upstreamRequestTarget(upstream, route), headers),
        (proxyResponse) => {
          response.writeHead(
            proxyResponse.statusCode ?? 502,
            copyResponseHeaders(proxyResponse.headers, route.publicPrefix),
          );
          proxyResponse.pipe(response);
          proxyResponse.on('end', resolve);
          proxyResponse.on('error', error => reject(new GardenUpstreamSocketError(error)));
        },
      );
      proxyRequest.on('timeout', () => proxyRequest.destroy(new GardenUpstreamTimeoutError()));
      proxyRequest.on('error', error => reject(
        error instanceof GardenUpstreamTimeoutError
          ? error
          : new GardenUpstreamSocketError(error),
      ));
      if (body.byteLength > 0) proxyRequest.write(body);
      proxyRequest.end();
    }).catch((error: unknown) => {
      const cause = gardenUpstreamFailureCause(error);
      const originalError = gardenUpstreamOriginalError(error);
      throw new FleetSsoUpstreamUnavailableError({
        cause,
        routeId: `${request.method ?? 'GET'} ${route.upstreamTarget}`,
        action: issued.verified.action,
        principalId: issued.verified.authContext.principalId,
        errorName: originalError instanceof Error ? originalError.name : 'UnknownError',
        ...(originalError instanceof Error
          && 'code' in originalError
          && typeof originalError.code === 'string'
          ? { errorCode: originalError.code }
          : {}),
      }, originalError);
    });
  }

  private async proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    resolveFleetSsoBrowserOrigin(request, this.options);
    if (singleHeader(request.headers.origin) !== this.options.canonicalOrigin) {
      throw new FleetSsoRequestError(400, 'WebSocket origin is invalid');
    }
    const sessionToken = readOpaqueSessionCookie(request);
    if (!sessionToken) throw new FleetSsoRequestError(401, 'Authentication required');
    const route = parseGardenRoute(request.url ?? '/');
    if (!route) throw new FleetSsoRequestError(404, 'Resource not found');
    const upstream = this.upstreams.get(route.companionId);
    if (!upstream) throw new FleetSsoRequestError(404, 'Resource not found');
    const issued = await this.authorizeAndIssue({
      sessionToken,
      route,
      method: 'WS',
      headers: request.headers,
      body: Buffer.alloc(0),
    });
    const headers = buildFleetSsoProxyRequestHeaders(request.headers);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    headers['content-length'] = '0';
    // Canonical Garden capability envelope (see proxyHttp).
    Object.assign(headers, buildGardenCapabilityHeaders({
      token: issued.token,
      context: {
        requestId: issued.verified.requestId,
        decisionId: issued.verified.decisionId,
        versions: issued.verified.versions,
      },
    }));
    await new Promise<void>((resolve, reject) => {
      const requestFn = upstream.origin.protocol === 'https:' ? httpsRequest : httpRequest;
      const proxyRequest = requestFn(requestOptions(upstream, 'GET', upstreamRequestTarget(upstream, route), headers));
      proxyRequest.once('upgrade', (proxyResponse, proxySocket, proxyHead) => {
        const rawHeaders: string[] = [];
        for (let index = 0; index < proxyResponse.rawHeaders.length; index += 2) {
          const name = proxyResponse.rawHeaders[index];
          const value = proxyResponse.rawHeaders[index + 1];
          if (name && value && !name.toLowerCase().startsWith('set-cookie')) {
            rawHeaders.push(`${name}: ${value}`);
          }
        }
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${rawHeaders.join('\r\n')}\r\n\r\n`);
        if (head.byteLength > 0) proxySocket.write(head);
        if (proxyHead.byteLength > 0) socket.write(proxyHead);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
        resolve();
      });
      proxyRequest.once('response', (proxyResponse) => {
        proxyResponse.resume();
        reject(new FleetSsoUpstreamUpgradeError(502, 'Garden upstream refused the upgrade'));
      });
      proxyRequest.once('error', () => {
        reject(new FleetSsoUpstreamUpgradeError(503, 'Garden upstream is unavailable'));
      });
      proxyRequest.end();
    });
  }
}
