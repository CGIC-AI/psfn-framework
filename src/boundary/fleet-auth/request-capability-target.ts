import { createHash } from 'node:crypto';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { encodeCanonicalQueryComponent } from '../../shared/utils/query-encoding.js';
import {
  GARDEN_FORWARD_METHODS,
  resolveGardenRouteCapability,
  type GardenForwardMethod,
  type GardenResourceArea,
  type GardenWorkspaceScope,
} from './garden-route-capabilities.js';
import type { FleetAuthAction } from '../../system/config/fleet-auth-config.js';
import type { GardenRouteAuthorization } from './garden-route-authorization.js';
import { REQUEST_CAPABILITY_ASSERTION_HEADERS } from './request-capability-transport.js';

const FORWARD_METHODS = new Set<string>(GARDEN_FORWARD_METHODS);
const AUTHORITY_QUERY_FIELDS = new Set([
  'action',
  'assertion',
  'audience',
  'capability',
  'companionid',
  'jti',
  'localcompanionid',
  'parent',
  'personalworkspace',
  'request_capability',
  'requestcapability',
  'resource',
  'token',
  'workspace',
  'workspacepath',
  REQUEST_CAPABILITY_ASSERTION_HEADERS[0],
]);
const AUTHORITY_HEADERS = new Set([
  'x-actor-id',
  'x-companion-id',
  'x-companion-shared-workspace-credential',
  'x-contact-id',
  'x-operator-grant-id',
  'x-principal-id',
  'x-psfn-action',
  'x-psfn-companion-id',
  'x-psfn-resource',
  'x-role',
  'x-root-id',
  'x-workspace-path',
  ...REQUEST_CAPABILITY_ASSERTION_HEADERS,
]);
const AUTHORITY_BODY_FIELDS = new Set([
  'actor',
  'actorid',
  'audience',
  'companionid',
  'contactid',
  'localcompanionid',
  'operatorgrantid',
  'personalworkspace',
  'principalid',
  'root',
  'rootactor',
  'rootid',
  'rootprincipal',
  'workspace',
  'workspacepath',
]);

export class GardenRequestTargetError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'route_not_declared' | 'authority_forbidden' = 'invalid',
  ) {
    super(`Invalid Garden request target: ${message}`);
    this.name = 'GardenRequestTargetError';
  }
}

export interface CanonicalGardenRequestPath {
  readonly canonicalPath: string;
  readonly rawQuery: string;
}

export interface GardenRequestHeaders {
  readonly [name: string]: string | readonly string[] | undefined;
}

export interface CompileGardenRequestTargetInput<Body extends Uint8Array = Uint8Array> {
  /** The origin-form request target exactly as received from the HTTP parser. */
  readonly rawTarget: string;
  readonly method: string;
  /** Branded identity selected from the authenticated connection, never the browser. */
  readonly companionId: CompanionId;
  /** Exact bounded bytes. The returned value preserves this object's identity. */
  readonly body: Body;
  readonly headers?: GardenRequestHeaders;
}

export interface ValidateGardenRequestMetadataInput {
  readonly rawTarget: string;
  readonly method: string;
  readonly headers?: GardenRequestHeaders;
}

export interface ValidatedGardenRequestMetadata {
  readonly method: GardenForwardMethod;
  readonly canonicalPath: string;
  readonly canonicalQuery: string;
  readonly canonicalRequestTarget: string;
  readonly routeId: string;
  readonly action: FleetAuthAction;
  readonly authorization: GardenRouteAuthorization;
  readonly pathParams: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, readonly string[]>>;
}

export interface CompiledGardenRequestTarget<Body extends Uint8Array = Uint8Array> {
  readonly schemaVersion: 1;
  readonly method: GardenForwardMethod;
  readonly canonicalPath: string;
  readonly canonicalQuery: string;
  readonly canonicalRequestTarget: string;
  readonly companionId: CompanionId;
  readonly action: FleetAuthAction;
  readonly authorization: GardenRouteAuthorization;
  readonly resource: {
    readonly schemaVersion: 1;
    readonly kind: 'garden_route';
    readonly routeId: string;
    readonly scope: GardenWorkspaceScope;
    readonly area: GardenResourceArea;
    readonly companionId: CompanionId;
    readonly pathParams: Readonly<Record<string, string>>;
    readonly query: Readonly<Record<string, readonly string[]>>;
    readonly bodyDigest: string;
  };
  readonly bodyDigest: string;
  readonly bodyLength: number;
  readonly resourceDigest: string;
  readonly authorizationDigest: string;
  readonly targetDigest: string;
  readonly body: Body;
}

function fail(message: string): never {
  throw new GardenRequestTargetError(message);
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable digest of the shared route-authorization declaration. */
export function digestGardenRouteAuthorization(authorization: GardenRouteAuthorization): string {
  return digest(JSON.stringify(authorization));
}

function canonicalPathSegment(decoded: string): string {
  return encodeURIComponent(decoded).replaceAll('%3A', ':');
}

function decodeCanonicalComponent(
  raw: string,
  field: string,
  encoder: (value: string) => string,
  alternateEncoder?: (value: string) => string,
): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fail(`${field} contains malformed percent encoding`);
  }
  if (/[\x00-\x1f\x7f]/u.test(decoded)) fail(`${field} contains a control character`);
  if (encoder(decoded) !== raw && alternateEncoder?.(decoded) !== raw) {
    fail(`${field} is not canonically encoded`);
  }
  return decoded;
}

/**
 * Parse an origin-form request target without WHATWG URL normalization. This is
 * safe to run before authentication and routing and therefore prevents dot or
 * encoded-separator aliases from ever reaching a route matcher.
 */
export function parseCanonicalGardenRequestPath(rawTarget: string): CanonicalGardenRequestPath {
  if (rawTarget.length > 16_384) fail('exceeds 16384 characters');
  if (!rawTarget || !rawTarget.startsWith('/') || rawTarget.startsWith('//')) {
    fail('must use non-authority origin form');
  }
  if (rawTarget.includes('#')) fail('must not contain a fragment');
  const question = rawTarget.indexOf('?');
  const rawPath = question === -1 ? rawTarget : rawTarget.slice(0, question);
  const rawQuery = question === -1 ? '' : rawTarget.slice(question + 1);
  if (rawQuery.includes('?')) fail('contains an ambiguous query delimiter');
  if (rawPath.includes('\\')) fail('path contains a backslash');
  if (rawPath.length > 1 && rawPath.endsWith('/')) fail('path has a trailing slash alias');
  if (rawPath.includes('//')) fail('path contains a duplicate slash');

  if (rawPath === '/') return Object.freeze({ canonicalPath: '/', rawQuery });

  const canonicalSegments: string[] = [];
  for (const [index, rawSegment] of rawPath.split('/').entries()) {
    if (index === 0) continue;
    if (!rawSegment) fail('path contains an empty segment');
    const decoded = decodeCanonicalComponent(rawSegment, 'path', canonicalPathSegment, encodeURIComponent);
    if (decoded === '.' || decoded === '..') fail('path contains a dot segment');
    if (decoded.includes('/') || decoded.includes('\\')) fail('path contains an encoded separator');
    canonicalSegments.push(canonicalPathSegment(decoded));
  }
  return Object.freeze({
    canonicalPath: canonicalSegments.length === 0 ? '/' : `/${canonicalSegments.join('/')}`,
    rawQuery,
  });
}

function parseCanonicalQuery(
  rawQuery: string,
  policy: Readonly<Partial<Record<string, {
    readonly cardinality: 'singleton' | 'multiple';
    readonly maxValues: number;
  }>>>,
): {
  readonly canonicalQuery: string;
  readonly selector: Readonly<Record<string, readonly string[]>>;
} {
  if (!rawQuery) return { canonicalQuery: '', selector: Object.freeze({}) };
  if (rawQuery.includes('+')) fail('query must encode spaces as %20, never +');
  const values = new Map<string, string[]>();
  for (const pair of rawQuery.split('&')) {
    if (!pair) fail('query contains an empty field');
    const separator = pair.indexOf('=');
    if (separator <= 0 || pair.indexOf('=', separator + 1) !== -1) {
      fail('query fields must contain exactly one = delimiter');
    }
    const rawName = pair.slice(0, separator);
    const rawValue = pair.slice(separator + 1);
    const name = decodeCanonicalComponent(rawName, 'query name', encodeCanonicalQueryComponent);
    const value = decodeCanonicalComponent(
      rawValue,
      `query value for ${name}`,
      encodeCanonicalQueryComponent,
      decoded => encodeCanonicalQueryComponent(decoded).replaceAll('%2C', ','),
    );
    if (AUTHORITY_QUERY_FIELDS.has(name.toLowerCase())) {
      throw new GardenRequestTargetError(
        `browser-controlled authority selector ${name} is forbidden`,
        'authority_forbidden',
      );
    }
    const fieldPolicy = policy[name];
    if (!fieldPolicy) fail(`query field ${name} is not declared for this route`);
    const fieldValues = values.get(name) ?? [];
    fieldValues.push(value);
    if (fieldValues.length > fieldPolicy.maxValues) fail(`query field ${name} exceeds its cardinality`);
    if (fieldPolicy.cardinality === 'singleton' && fieldValues.length !== 1) {
      fail(`query field ${name} must be a singleton`);
    }
    values.set(name, fieldValues);
  }

  const selector: Record<string, readonly string[]> = {};
  const pairs: string[] = [];
  for (const name of [...values.keys()].sort()) {
    const sorted = [...(values.get(name) ?? [])].sort();
    selector[name] = Object.freeze(sorted);
    for (const value of sorted) {
      pairs.push(`${encodeCanonicalQueryComponent(name)}=${encodeCanonicalQueryComponent(value)}`);
    }
  }
  return {
    canonicalQuery: pairs.join('&'),
    selector: Object.freeze(selector),
  };
}

function rejectAuthorityHeaders(headers: GardenRequestHeaders | undefined): void {
  if (!headers) return;
  for (const name of Object.keys(headers)) {
    if (AUTHORITY_HEADERS.has(name.toLowerCase())) {
      throw new GardenRequestTargetError(
        `browser-controlled authority header ${name} is forbidden`,
        'authority_forbidden',
      );
    }
  }
}

function rejectAuthorityBodyFields(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (AUTHORITY_BODY_FIELDS.has(key.toLowerCase())) {
        throw new GardenRequestTargetError(
          `browser-controlled authority body field ${key} is forbidden`,
          'authority_forbidden',
        );
      }
      pending.push(child);
    }
  }
}

function rejectJsonAuthorityBody(body: Uint8Array, headers: GardenRequestHeaders | undefined): void {
  const contentTypeEntry = headers && Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const contentType = Array.isArray(contentTypeEntry) ? contentTypeEntry[0] : contentTypeEntry;
  const bodyText = Buffer.from(body).toString('utf8');
  const appearsJson = /^[\t\r\n ]*[\[{]/u.test(bodyText);
  if (
    !appearsJson
    && (typeof contentType !== 'string'
      || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType))
  ) {
    return;
  }
  try {
    rejectAuthorityBodyFields(JSON.parse(bodyText) as unknown);
  } catch (error) {
    if (error instanceof GardenRequestTargetError) throw error;
    // JSON validity belongs to the route. The compiler still binds the exact bytes.
  }
}

/** Validate all browser-controlled request metadata before authentication or forwarding. */
export function validateGardenRequestMetadata(
  input: ValidateGardenRequestMetadataInput,
): ValidatedGardenRequestMetadata {
  if (!FORWARD_METHODS.has(input.method)) fail(`method ${input.method} is not supported`);
  const method = input.method as GardenForwardMethod;
  const parsedPath = parseCanonicalGardenRequestPath(input.rawTarget);
  const resolved = resolveGardenRouteCapability(method, parsedPath.canonicalPath);
  if (!resolved) {
    throw new GardenRequestTargetError(
      `route ${method} ${parsedPath.canonicalPath} is not declared`,
      'route_not_declared',
    );
  }
  rejectAuthorityHeaders(input.headers);
  const { canonicalQuery, selector } = parseCanonicalQuery(
    parsedPath.rawQuery,
    resolved.capability.query,
  );
  return Object.freeze({
    method,
    canonicalPath: parsedPath.canonicalPath,
    canonicalQuery,
    canonicalRequestTarget: canonicalQuery
      ? `${parsedPath.canonicalPath}?${canonicalQuery}`
      : parsedPath.canonicalPath,
    routeId: resolved.capability.id,
    action: resolved.capability.authorization.action,
    authorization: resolved.capability.authorization,
    pathParams: resolved.pathParams,
    query: selector,
  });
}

export function compileGardenRequestCapabilityTarget<Body extends Uint8Array>(
  input: CompileGardenRequestTargetInput<Body>,
): CompiledGardenRequestTarget<Body> {
  const metadata = validateGardenRequestMetadata(input);
  const resolved = resolveGardenRouteCapability(metadata.method, metadata.canonicalPath);
  if (!resolved) fail('validated route capability disappeared');
  const { body: bodyPolicy } = resolved.capability;
  if (bodyPolicy.mode === 'forbidden' && input.body.byteLength !== 0) fail('body is forbidden for this route');
  if (input.body.byteLength > bodyPolicy.maxBytes) fail(`body exceeds ${bodyPolicy.maxBytes} bytes`);
  if (bodyPolicy.mode === 'required' && input.body.byteLength === 0) fail('body is required for this route');
  rejectJsonAuthorityBody(input.body, input.headers);

  const bodyDigest = digest(input.body);
  const resource = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'garden_route' as const,
    routeId: resolved.capability.id,
    scope: resolved.capability.authorization.resource.scope,
    area: resolved.capability.authorization.resource.area,
    companionId: input.companionId,
    pathParams: Object.freeze(Object.fromEntries(Object.entries(resolved.pathParams).sort())),
    query: metadata.query,
    bodyDigest,
  });
  const resourceDigest = digest(JSON.stringify(resource));
  const authorizationDigest = digestGardenRouteAuthorization(metadata.authorization);
  const targetDigest = digest(JSON.stringify({
    schemaVersion: 1,
    method: metadata.method,
    canonicalRequestTarget: metadata.canonicalRequestTarget,
    companionId: input.companionId,
    action: metadata.action,
    authorizationDigest,
    resourceDigest,
  }));
  return Object.freeze({
    schemaVersion: 1 as const,
    method: metadata.method,
    canonicalPath: metadata.canonicalPath,
    canonicalQuery: metadata.canonicalQuery,
    canonicalRequestTarget: metadata.canonicalRequestTarget,
    companionId: input.companionId,
    action: metadata.action,
    authorization: metadata.authorization,
    resource,
    bodyDigest,
    bodyLength: input.body.byteLength,
    resourceDigest,
    authorizationDigest,
    targetDigest,
    body: input.body,
  });
}

/** Shared boundary names make accidental per-hop compiler forks visible in review. */
export const compileGatewayGardenRequestTarget = compileGardenRequestCapabilityTarget;
export const compileOperatorGardenRequestTarget = compileGardenRequestCapabilityTarget;
export const compileAgentGardenRequestTarget = compileGardenRequestCapabilityTarget;
