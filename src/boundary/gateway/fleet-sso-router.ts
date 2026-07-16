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
import {
  compileGatewayGardenRequestTarget,
  GardenRequestTargetError,
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
  RequestCapabilityAuthorityVersions,
  RequestCapabilityVerifier,
  VerifiedRequestCapability,
} from '../fleet-auth/request-capability.js';
import {
  toRequestCapabilityAuthContext,
  type FleetAuthorizationContext,
} from './fleet-authorization-context.js';
import type { GatewayFleetAuthBroker } from './fleet-auth-broker.js';
import type {
  FleetJitGrantBinding,
  FleetJitRequestBinding,
  FleetJitStepUpCoordinator,
} from '../fleet-auth/jit-step-up.js';
import { parseMemorySubjectJitRequest } from '../../shared/contracts/memory-subject-jit.js';
import {
  isPrivacyBreakGlassConfirmRoute,
  parsePrivacyBreakGlassConfirmRequest,
  privacyBreakGlassPurpose,
  privacyBreakGlassResourceKindForRoute,
  privacyBreakGlassSubjectScopeDigest,
} from '../../shared/contracts/privacy-break-glass.js';
import { createSpiffeCheckServerIdentity } from '../../shared/net/mtls.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import type { FleetSsoGardenUpstream } from '../fleet-auth/fleet-sso-transport.js';
import {
  FLEET_PORTAL_API_PATH,
  GatewayFleetPortalHttpRoutes,
} from './fleet-portal-http-routes.js';
import type { GatewayFleetPortalProjection } from './fleet-portal-projection.js';

const SESSION_COOKIE_NAME = '__Host-psfn_session';
const MAX_PROXY_BODY_BYTES = 1_048_576;
const MAX_CAPABILITY_HEADER_BYTES = 65_536;
const FLEET_PATH = '/fleet';
const FLEET_LOGIN_PATH = '/fleet/login';
const COMPANION_PREFIX = '/companions/';
const GARDEN_MARKER = '/garden';
const COMPANION_UI_PREFIX = '/companion-ui';
export const FLEET_JIT_GRANT_HEADER = 'x-psfn-jit-grant';
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
  readonly jitStepUp?: Pick<FleetJitStepUpCoordinator, 'consumeGrant'>;
  readonly upstreams: readonly FleetSsoGardenUpstream[];
  readonly companionUi?: {
    readonly companionId: CompanionId;
    readonly origin: URL;
  };
  readonly nowSeconds?: () => number;
}

interface ParsedGardenRoute {
  companionId: CompanionId;
  upstreamTarget: string;
  publicPrefix: string;
}

class FleetSsoRequestError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 413 | 502 | 503, message: string) {
    super(message);
    this.name = 'FleetSsoRequestError';
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

function writeSocketError(socket: Duplex, status: 400 | 401 | 404 | 413 | 502 | 503): void {
  const label = status === 400 ? 'Bad Request'
    : status === 401 ? 'Unauthorized'
      : status === 404 ? 'Not Found'
        : status === 413 ? 'Payload Too Large'
          : status === 502 ? 'Bad Gateway'
            : 'Service Unavailable';
  socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
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

function parseOuterPath(rawTarget: string): { rawPath: string; rawQuery: string } {
  if (!rawTarget.startsWith('/') || rawTarget.startsWith('//') || rawTarget.includes('#')
    || rawTarget.includes('\\') || /%2f|%5c/iu.test(rawTarget)) {
    throw new FleetSsoRequestError(400, 'Unified-origin request target is invalid');
  }
  const question = rawTarget.indexOf('?');
  const rawPath = question < 0 ? rawTarget : rawTarget.slice(0, question);
  const rawQuery = question < 0 ? '' : rawTarget.slice(question + 1);
  if (rawQuery.includes('?') || rawPath.includes('//') || /(?:^|\/)\.\.?($|\/)/u.test(rawPath)) {
    throw new FleetSsoRequestError(400, 'Unified-origin request target is invalid');
  }
  return { rawPath, rawQuery };
}

function parseGardenRoute(rawTarget: string): ParsedGardenRoute | undefined {
  const { rawPath, rawQuery } = parseOuterPath(rawTarget);
  if (!rawPath.startsWith(COMPANION_PREFIX)) return undefined;
  const rest = rawPath.slice(COMPANION_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) throw new FleetSsoRequestError(404, 'Resource not found');
  const rawCompanionId = rest.slice(0, slash);
  const afterCompanion = rest.slice(slash);
  if (!isRfc4122Uuid(rawCompanionId) || !afterCompanion.startsWith(GARDEN_MARKER)
    || (afterCompanion.length > GARDEN_MARKER.length
      && afterCompanion[GARDEN_MARKER.length] !== '/')) {
    throw new FleetSsoRequestError(404, 'Resource not found');
  }
  const gardenPath = afterCompanion.slice(GARDEN_MARKER.length) || '/';
  return {
    companionId: createCompanionId(rawCompanionId, 'unified-origin companionId'),
    upstreamTarget: rawQuery ? `${gardenPath}?${rawQuery}` : gardenPath,
    publicPrefix: `${COMPANION_PREFIX}${rawCompanionId}${GARDEN_MARKER}`,
  };
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

function copyRequestHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
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
        output[name] = `${publicPrefix}${value}`;
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

  constructor(private readonly options: GatewayFleetSsoRouterOptions) {
    const canonical = new URL(options.canonicalOrigin);
    if (canonical.protocol !== 'https:' || canonical.origin !== options.canonicalOrigin) {
      throw new Error('Fleet SSO router requires an exact canonical HTTPS origin');
    }
    if (options.upstreams.length === 0) {
      throw new Error('Fleet SSO router requires at least one Garden upstream');
    }
    this.portalRoutes = new GatewayFleetPortalHttpRoutes({
      projection: options.portalProjection,
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
        || rawPath === FLEET_LOGIN_PATH || rawPath.startsWith(FLEET_PORTAL_API_PATH)
        || rawPath.startsWith(COMPANION_PREFIX)
        || rawPath === COMPANION_UI_PREFIX || rawPath.startsWith(`${COMPANION_UI_PREFIX}/`);
    } catch {
      return rawTarget.startsWith(FLEET_PATH) || rawTarget.startsWith(FLEET_PORTAL_API_PATH)
        || rawTarget.startsWith(COMPANION_PREFIX)
        || rawTarget.startsWith(COMPANION_UI_PREFIX);
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      resolveFleetSsoBrowserOrigin(request, this.options);
      const browserOrigin = singleHeader(request.headers.origin);
      if (browserOrigin !== undefined && browserOrigin !== this.options.canonicalOrigin) {
        throw new FleetSsoRequestError(400, 'Browser origin is invalid');
      }
      const { rawPath, rawQuery } = parseOuterPath(request.url ?? '/');
      if (rawPath === FLEET_LOGIN_PATH) {
        if (request.method !== 'GET' || rawQuery) throw new FleetSsoRequestError(404, 'Resource not found');
        response.writeHead(303, {
          'Cache-Control': 'no-store',
          Location: '/v1/fleet-auth/login?return_to=%2Ffleet',
          'Referrer-Policy': 'no-referrer',
        });
        response.end();
        return;
      }
      if (rawPath === COMPANION_UI_PREFIX || rawPath.startsWith(`${COMPANION_UI_PREFIX}/`)) {
        await this.serveCompanionUi(request, response, rawPath, rawQuery);
        return;
      }
      const sessionToken = readOpaqueSessionCookie(request);
      if (!sessionToken) {
        if (request.method === 'GET' && (rawPath === FLEET_PATH || rawPath === `${FLEET_PATH}/`)) {
          response.writeHead(303, {
            'Cache-Control': 'no-store',
            Location: FLEET_LOGIN_PATH,
            'Referrer-Policy': 'no-referrer',
          });
          response.end();
          return;
        }
        if (rawPath.startsWith(FLEET_PORTAL_API_PATH)) {
          this.portalRoutes.sendUnauthenticated(response);
          return;
        }
        throw new FleetSsoRequestError(401, 'Authentication required');
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
      await this.proxyHttp(request, response, upstream, route, body, issued);
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      if (error instanceof FleetSsoRequestError) {
        sendJson(response, error.status, {
          error: { type: error.status === 404 ? 'not_found' : 'fleet_sso_request_denied' },
        });
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
      if (!socket.destroyed) {
        writeSocketError(socket, error instanceof FleetSsoRequestError ? error.status : 503);
      }
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
      || rawQuery
      || request.headers['transfer-encoding'] !== undefined
      || (singleHeader(request.headers['content-length']) ?? '0') !== '0') {
      throw new FleetSsoRequestError(404, 'Resource not found');
    }
    const upstreamTarget = rawPath;
    await new Promise<void>((resolve, reject) => {
      const headers = copyRequestHeaders(request.headers);
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
            copyResponseHeaders(proxyResponse.headers, ''),
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
  }): Promise<{ token: string; verified: VerifiedRequestCapability }> {
    const targetHeaders = { ...input.headers };
    stripBrowserRequestCapabilityHeaders(targetHeaders);
    const target = compileGatewayGardenRequestTarget({
      rawTarget: input.route.upstreamTarget,
      method: input.method,
      companionId: input.route.companionId,
      headers: targetHeaders,
      body: input.body,
    });
    const rawJitGrantId = singleHeader(input.headers[FLEET_JIT_GRANT_HEADER]);
    const isMemoryReveal = target.action === 'memory.jit.self'
      && target.resource.routeId === 'POST /api/admin/memory/:id/reveal';
    const isPrivacyConfirm = target.action === 'privacy.break_glass'
      && isPrivacyBreakGlassConfirmRoute(target.resource.routeId)
      && target.authorization.requirements.assurance === 'privacy_break_glass';
    const isJitTarget = isMemoryReveal || isPrivacyConfirm;
    if (!isJitTarget && rawJitGrantId !== undefined) {
      throw new FleetSsoRequestError(404, 'Resource not found');
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
    } catch {
      throw new FleetSsoRequestError(404, 'Resource not found');
    }
    const decisionId = context.provenance.authorizationEventId;
    const versions = authorityVersions(context);
    let consumedJit: FleetJitGrantBinding | undefined;
    if (isJitTarget) {
      if (!rawJitGrantId || !isRfc4122Uuid(rawJitGrantId) || !this.options.jitStepUp) {
        throw new FleetSsoRequestError(404, 'Resource not found');
      }
      let binding: FleetJitRequestBinding;
      try {
        if (isMemoryReveal) {
          const jitRequest = parseMemorySubjectJitRequest(JSON.parse(input.body.toString('utf8')));
          binding = {
            target,
            subjectScopeDigest: jitRequest.subjectScopeDigest,
            purpose: jitRequest.purpose,
            memoryRevision: jitRequest.memoryRevision,
            classifierEvidenceDigest: jitRequest.classifierEvidenceDigest,
          };
        } else {
          const resourceKind = privacyBreakGlassResourceKindForRoute(target.resource.routeId);
          const resourceId = target.resource.pathParams.id;
          if (!resourceKind || !resourceId) throw new Error('Privacy resource is incomplete');
          const request = parsePrivacyBreakGlassConfirmRequest(JSON.parse(input.body.toString('utf8')));
          binding = {
            target,
            subjectScopeDigest: privacyBreakGlassSubjectScopeDigest({
              companionId: target.companionId,
              action: target.action,
              routeId: target.resource.routeId,
              resourceKind,
              resourceId,
            }),
            purpose: privacyBreakGlassPurpose(request),
            memoryRevision: 1,
            classifierEvidenceDigest: target.resourceDigest,
          };
        }
      } catch {
        throw new FleetSsoRequestError(404, 'Resource not found');
      }
      try {
        consumedJit = await this.options.jitStepUp.consumeGrant({
          grantId: rawJitGrantId,
          token: input.sessionToken,
          requestOrigin: this.options.canonicalOrigin,
          binding,
        });
      } catch {
        throw new FleetSsoRequestError(404, 'Resource not found');
      }
      if (!timingSafeStringEqual(consumedJit.principalId, context.principalId)
        || !timingSafeStringEqual(consumedJit.browserSessionId, context.session.recordId)
        || consumedJit.assurance !== 'webauthn_uv'
        || consumedJit.expiresAt.getTime()
          <= (this.options.nowSeconds ? this.options.nowSeconds() * 1_000 : Date.now())) {
        throw new FleetSsoRequestError(404, 'Resource not found');
      }
    }
    const authContext = toRequestCapabilityAuthContext(context);
    const token = this.options.signer.signOperator({
      target,
      requestId,
      decisionId,
      authContext: consumedJit
        ? Object.freeze({
          ...authContext,
          sessionAssurance: isPrivacyConfirm ? 'break_glass' as const : 'webauthn_uv' as const,
        })
        : authContext,
      versions,
    });
    if (Buffer.byteLength(token, 'ascii') > MAX_CAPABILITY_HEADER_BYTES) {
      throw new FleetSsoRequestError(503, 'Issued capability exceeds the transport envelope');
    }
    const verified = this.options.verifier.verifyOperator({
      token,
      target,
      requestId,
      decisionId,
      versions,
      ...(this.options.nowSeconds ? { nowSeconds: this.options.nowSeconds() } : {}),
    });
    const replay = await this.options.replay.consume(
      compileRequestCapabilityReplayConsumption({ token, verified, target }),
    );
    if (replay.outcome !== 'consumed') {
      throw new FleetSsoRequestError(404, 'Resource not found');
    }
    return { token, verified };
  }

  private proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    upstream: FleetSsoGardenUpstream,
    route: ParsedGardenRoute,
    body: Buffer,
    issued: { token: string; verified: VerifiedRequestCapability },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers = copyRequestHeaders(request.headers);
      headers['content-length'] = String(body.byteLength);
      headers['x-psfn-request-capability'] = issued.token;
      headers['x-psfn-capability-audience'] = issued.verified.audience;
      headers['x-psfn-capability-request-id'] = issued.verified.requestId;
      headers['x-psfn-capability-decision'] = issued.verified.decisionId;
      headers['x-psfn-capability-jti'] = issued.verified.jti;
      const requestFn = upstream.origin.protocol === 'https:' ? httpsRequest : httpRequest;
      const proxyRequest = requestFn(
        requestOptions(upstream, request.method ?? 'GET', route.upstreamTarget, headers),
        (proxyResponse) => {
          response.writeHead(
            proxyResponse.statusCode ?? 502,
            copyResponseHeaders(proxyResponse.headers, route.publicPrefix),
          );
          proxyResponse.pipe(response);
          proxyResponse.on('end', resolve);
          proxyResponse.on('error', reject);
        },
      );
      proxyRequest.on('timeout', () => proxyRequest.destroy(new Error('Garden upstream timed out')));
      proxyRequest.on('error', reject);
      if (body.byteLength > 0) proxyRequest.write(body);
      proxyRequest.end();
    }).catch(() => {
      throw new FleetSsoRequestError(502, 'Garden upstream is unavailable');
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
    const headers = copyRequestHeaders(request.headers);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    headers['content-length'] = '0';
    headers['x-psfn-request-capability'] = issued.token;
    headers['x-psfn-capability-audience'] = issued.verified.audience;
    headers['x-psfn-capability-request-id'] = issued.verified.requestId;
    headers['x-psfn-capability-decision'] = issued.verified.decisionId;
    headers['x-psfn-capability-jti'] = issued.verified.jti;
    await new Promise<void>((resolve, reject) => {
      const requestFn = upstream.origin.protocol === 'https:' ? httpsRequest : httpRequest;
      const proxyRequest = requestFn(requestOptions(upstream, 'GET', route.upstreamTarget, headers));
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
        reject(new FleetSsoRequestError(502, 'Garden upstream refused the upgrade'));
      });
      proxyRequest.once('error', reject);
      proxyRequest.end();
    });
  }
}
