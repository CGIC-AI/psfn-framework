import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  compileRequestCapabilityReplayConsumption,
  type RequestCapabilityReplayConsumption,
  type RequestCapabilityReplayOutcome,
  type RequestCapabilityReplayPort,
} from '../../boundary/fleet-auth/request-capability-replay.js';
import {
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthorityVersions,
  type RequestCapabilityParentBinding,
  type RequestCapabilityVerifier,
  type VerifiedRequestCapability,
} from '../../boundary/fleet-auth/request-capability.js';
import {
  compileAgentGardenRequestTarget,
  compileOperatorGardenRequestTarget,
  type CompiledGardenRequestTarget,
} from '../../boundary/fleet-auth/request-capability-target.js';
import {
  REQUEST_CAPABILITY_ASSERTION_HEADERS,
  stripBrowserRequestCapabilityHeaders,
} from '../../boundary/fleet-auth/request-capability-transport.js';
import type { FleetAuthVerifierConfig } from '../../system/config/fleet-auth-config.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import { sendText, type HttpLogger } from '../../channels/backplane/http/primitives.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';

export const GARDEN_CAPABILITY_CONTEXT_HEADER = 'x-psfn-capability-context';
const REQUEST_CAPABILITY_HEADER = REQUEST_CAPABILITY_ASSERTION_HEADERS[0];
const GARDEN_ADMISSION_PROTOCOL_BOUNDS = Object.freeze({
  capabilityLength: 65_536,
  contextLength: 8_192,
});

const FLEET_CALLER_AUTHORITY_HEADERS = Object.freeze([
  'authorization',
  'cookie',
  'x-contact-id',
  'x-actor-id',
  'x-authenticated-user',
  'x-forwarded-user',
  'x-principal-id',
  'x-psfn-action',
  'x-psfn-companion-id',
  'x-psfn-contact-id',
  'x-psfn-principal-id',
  'x-psfn-role',
  'x-role',
  'x-remote-user',
  GARDEN_CAPABILITY_CONTEXT_HEADER,
] as const);

export interface GardenCapabilityContext {
  readonly requestId: string;
  readonly decisionId: string;
  readonly versions: RequestCapabilityAuthorityVersions;
  readonly parent?: RequestCapabilityParentBinding;
}

export interface LegacyTokenGardenAdmission {
  readonly kind: 'legacy-token';
  readonly token?: string;
}

export interface FleetPrincipalGardenAdmission {
  readonly kind: 'fleet-principal';
  readonly audience: 'operator' | 'agent';
  readonly companionId: CompanionId;
  readonly verifier: RequestCapabilityVerifier;
  readonly replay: RequestCapabilityReplayPort;
}

export type GardenAdmissionMode = LegacyTokenGardenAdmission | FleetPrincipalGardenAdmission;

export function isLegacyTokenGardenAdmission(
  mode: GardenAdmissionMode,
): mode is LegacyTokenGardenAdmission {
  switch (mode.kind) {
    case 'legacy-token': return true;
    case 'fleet-principal': return false;
  }
}

export type FleetGardenAdmissionResult =
  | {
      readonly decision: 'allow';
      readonly target: CompiledGardenRequestTarget<Buffer>;
      readonly verified?: VerifiedRequestCapability;
      readonly authority?: {
        readonly token: string;
        readonly context: GardenCapabilityContext;
      };
    }
  | {
      readonly decision: 'deny';
      readonly status: 400 | 401 | 403 | 404 | 409 | 503;
      readonly message: string;
    };

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseVersions(value: unknown): RequestCapabilityAuthorityVersions {
  const keys = [
    'authorityGeneration',
    'globalAuthEpoch',
    'sessionAuthnVersion',
    'sessionAuthzVersion',
    'bindingVersion',
    'grantVersion',
    'policyVersion',
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error('invalid authority versions');
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) {
      throw new Error('invalid authority versions');
    }
  }
  return Object.freeze({
    authorityGeneration: value.authorityGeneration as number,
    globalAuthEpoch: value.globalAuthEpoch as number,
    sessionAuthnVersion: value.sessionAuthnVersion as number,
    sessionAuthzVersion: value.sessionAuthzVersion as number,
    bindingVersion: value.bindingVersion as number,
    grantVersion: value.grantVersion as number,
    policyVersion: value.policyVersion as number,
  });
}

function parseParent(value: unknown, companionId: CompanionId): RequestCapabilityParentBinding {
  const keys = ['audience', 'requestId', 'decisionId', 'jti', 'targetDigest'] as const;
  if (!isRecord(value)
    || !hasExactKeys(value, keys)
    || value.audience !== `operator:${companionId}`
    || !isRfc4122Uuid(value.requestId)
    || !isRfc4122Uuid(value.decisionId)
    || typeof value.jti !== 'string'
    || value.jti.length < 1
    || value.jti.length > 256
    || typeof value.targetDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.targetDigest)) {
    throw new Error('invalid parent binding');
  }
  return Object.freeze({
    audience: value.audience,
    requestId: value.requestId,
    decisionId: value.decisionId,
    jti: value.jti,
    targetDigest: value.targetDigest,
  });
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) throw new Error(`duplicate ${name} header`);
  return value;
}

function parseCapabilityContext(encoded: string, companionId: CompanionId): GardenCapabilityContext {
  if (!encoded
    || encoded.length > GARDEN_ADMISSION_PROTOCOL_BOUNDS.contextLength
    || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error('invalid capability context');
  }
  const raw = Buffer.from(encoded, 'base64url');
  const canonicalEncodedBytes = Buffer.from(raw.toString('base64url'));
  const encodedBytes = Buffer.from(encoded);
  if (canonicalEncodedBytes.byteLength !== encodedBytes.byteLength
    || !timingSafeEqual(canonicalEncodedBytes, encodedBytes)) {
    throw new Error('invalid capability context');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid capability context');
  }
  if (!isRecord(value)
    || !hasExactKeys(value, value.parent === undefined
      ? ['schemaVersion', 'requestId', 'decisionId', 'versions']
      : ['schemaVersion', 'requestId', 'decisionId', 'versions', 'parent'])
    || value.schemaVersion !== 1
    || !isRfc4122Uuid(value.requestId)
    || !isRfc4122Uuid(value.decisionId)) {
    throw new Error('invalid capability context');
  }
  const context = Object.freeze({
    requestId: value.requestId,
    decisionId: value.decisionId,
    versions: parseVersions(value.versions),
    ...(value.parent === undefined ? {} : { parent: parseParent(value.parent, companionId) }),
  });
  const canonical = encodeGardenCapabilityContext(context);
  if (canonical.length !== encoded.length
    || !timingSafeEqual(Buffer.from(canonical), Buffer.from(encoded))) {
    throw new Error('noncanonical capability context');
  }
  return context;
}

export function encodeGardenCapabilityContext(context: GardenCapabilityContext): string {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    requestId: context.requestId,
    decisionId: context.decisionId,
    versions: {
      authorityGeneration: context.versions.authorityGeneration,
      globalAuthEpoch: context.versions.globalAuthEpoch,
      sessionAuthnVersion: context.versions.sessionAuthnVersion,
      sessionAuthzVersion: context.versions.sessionAuthzVersion,
      bindingVersion: context.versions.bindingVersion,
      grantVersion: context.versions.grantVersion,
      policyVersion: context.versions.policyVersion,
    },
    ...(context.parent ? {
      parent: {
        audience: context.parent.audience,
        requestId: context.parent.requestId,
        decisionId: context.parent.decisionId,
        jti: context.parent.jti,
        targetDigest: context.parent.targetDigest,
      },
    } : {}),
  }), 'utf8').toString('base64url');
}

export function buildGardenCapabilityHeaders(input: {
  token: string;
  context: GardenCapabilityContext;
}): Readonly<Record<string, string>> {
  if (!input.token
    || input.token.length > GARDEN_ADMISSION_PROTOCOL_BOUNDS.capabilityLength
    || /[\r\n\u0000]/u.test(input.token)) {
    throw new Error('invalid request capability');
  }
  return Object.freeze({
    [REQUEST_CAPABILITY_HEADER]: input.token,
    [GARDEN_CAPABILITY_CONTEXT_HEADER]: encodeGardenCapabilityContext(input.context),
  });
}

export function stripFleetCallerAuthority(headers: IncomingHttpHeaders): void {
  stripBrowserRequestCapabilityHeaders(headers);
  for (const name of FLEET_CALLER_AUTHORITY_HEADERS) delete headers[name];
}

/** Read and preserve the exact signed request bytes before any route consumes the stream. */
export function readFleetGardenBody(
  req: IncomingMessage,
  res: ServerResponse,
  options: { maxBytes: number; logger?: HttpLogger },
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const finish = (body: Buffer | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(body);
    };
    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > options.maxBytes) {
        options.logger?.warn('Request body too large', {
          size: totalBytes,
          limit: options.maxBytes,
        });
        sendText(res, 413, 'Payload Too Large');
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => finish(Buffer.concat(chunks, totalBytes));
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function hasForbiddenFleetCallerAuthority(headers: IncomingHttpHeaders): boolean {
  const forbidden = new Set<string>([
    ...FLEET_CALLER_AUTHORITY_HEADERS,
    ...REQUEST_CAPABILITY_ASSERTION_HEADERS.slice(1),
  ]);
  forbidden.delete(GARDEN_CAPABILITY_CONTEXT_HEADER);
  return Object.keys(headers).some(name => forbidden.has(name.toLowerCase()));
}

export class InMemoryRequestCapabilityReplayPort implements RequestCapabilityReplayPort {
  private readonly consumed = new Map<string, RequestCapabilityReplayConsumption>();

  async consume(input: RequestCapabilityReplayConsumption): Promise<RequestCapabilityReplayOutcome> {
    const now = Date.now();
    for (const [consumedKey, consumed] of this.consumed) {
      if (consumed.expiresAt.getTime() <= now) this.consumed.delete(consumedKey);
    }
    const key = `${input.issuer}\u0000${input.jti}`;
    const existing = this.consumed.get(key);
    if (!existing) {
      this.consumed.set(key, input);
      return { outcome: 'consumed', result: input.consumeResult };
    }
    return JSON.stringify(existing) === JSON.stringify(input)
      ? { outcome: 'replayed', result: existing.consumeResult }
      : { outcome: 'mismatch' };
  }
}

export function resolveGardenAdmissionMode(input: {
  fleetAuthVerifier?: FleetAuthVerifierConfig;
  companionId?: string;
  audience: 'operator' | 'agent';
  token?: string;
  replay?: RequestCapabilityReplayPort;
}): GardenAdmissionMode {
  if (!input.fleetAuthVerifier) {
    return Object.freeze({ kind: 'legacy-token', ...(input.token ? { token: input.token } : {}) });
  }
  const companionId = createCompanionId(input.companionId);
  return Object.freeze({
    kind: 'fleet-principal',
    audience: input.audience,
    companionId,
    verifier: createRequestCapabilityVerifier(input.fleetAuthVerifier.requestCapabilities),
    replay: input.replay ?? new InMemoryRequestCapabilityReplayPort(),
  });
}

export async function admitFleetGardenRequest(input: {
  admission: FleetPrincipalGardenAdmission;
  rawTarget: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}): Promise<FleetGardenAdmissionResult> {
  let token: string | undefined;
  let encodedContext: string | undefined;
  try {
    token = firstHeader(input.headers, REQUEST_CAPABILITY_HEADER);
    encodedContext = firstHeader(input.headers, GARDEN_CAPABILITY_CONTEXT_HEADER);
  } catch {
    stripFleetCallerAuthority(input.headers);
    return { decision: 'deny', status: 400, message: 'Invalid Garden capability headers' };
  }
  const forbiddenCallerAuthority = hasForbiddenFleetCallerAuthority(input.headers);
  stripFleetCallerAuthority(input.headers);
  if (forbiddenCallerAuthority) {
    return { decision: 'deny', status: 400, message: 'Browser authority headers are forbidden' };
  }

  let target: CompiledGardenRequestTarget<Buffer>;
  try {
    const compile = input.admission.audience === 'agent'
      ? compileAgentGardenRequestTarget
      : compileOperatorGardenRequestTarget;
    target = compile({
      rawTarget: input.rawTarget,
      method: input.method,
      companionId: input.admission.companionId,
      body: input.body,
      headers: input.headers,
    });
  } catch (error) {
    const routeMissing = error instanceof Error && /route .* is not declared/u.test(error.message);
    return {
      decision: 'deny',
      status: routeMissing ? 404 : 400,
      message: routeMissing ? 'Not found' : 'Invalid Garden request target',
    };
  }

  switch (target.authorization.publicAccess) {
    case 'always':
      if (token || encodedContext) {
        return { decision: 'deny', status: 400, message: 'Public routes do not accept authority' };
      }
      return { decision: 'allow', target };
    case 'feature_off_only':
      return { decision: 'deny', status: 404, message: 'Not found' };
    case 'never':
      break;
  }
  if (!token
    || !encodedContext
    || token.length > GARDEN_ADMISSION_PROTOCOL_BOUNDS.capabilityLength) {
    return { decision: 'deny', status: 401, message: 'Fleet Garden capability required' };
  }

  let context: GardenCapabilityContext;
  let verified: VerifiedRequestCapability;
  try {
    context = parseCapabilityContext(encodedContext, input.admission.companionId);
    if (input.admission.audience === 'operator') {
      if (context.parent) throw new Error('operator capability cannot contain a parent');
      verified = input.admission.verifier.verifyOperator({ token, target, ...context });
      if (!timingSafeStringEqual(verified.audience, `operator:${input.admission.companionId}`)) {
        throw new Error('operator audience mismatch');
      }
    } else {
      if (!context.parent) throw new Error('agent child capability requires a parent');
      verified = input.admission.verifier.verifyAgent({ token, target, ...context, parent: context.parent });
      if (!timingSafeStringEqual(verified.audience, `agent:${input.admission.companionId}`)) {
        throw new Error('agent audience mismatch');
      }
    }
  } catch {
    return { decision: 'deny', status: 403, message: 'Invalid Fleet Garden capability' };
  }

  let replay: RequestCapabilityReplayOutcome;
  try {
    replay = await input.admission.replay.consume(
      compileRequestCapabilityReplayConsumption({ token, verified, target }),
    );
  } catch {
    return { decision: 'deny', status: 503, message: 'Fleet Garden replay authority unavailable' };
  }
  switch (replay.outcome) {
    case 'mismatch':
      return { decision: 'deny', status: 403, message: 'Fleet Garden capability replay mismatch' };
    case 'replayed':
      return { decision: 'deny', status: 409, message: 'Fleet Garden capability already consumed' };
    case 'consumed':
      break;
  }
  return {
    decision: 'allow',
    target,
    verified,
    authority: Object.freeze({ token, context }),
  };
}
