import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
  compileRequestCapabilityReplayConsumption,
  type RequestCapabilityReplayConsumption,
  type RequestCapabilityReplayOutcome,
  type RequestCapabilityReplayPort,
} from '../../boundary/fleet-auth/request-capability-replay.js';
import {
  createRequestCapabilityVerifier,
  TESTING_HARNESS_REQUEST_CAPABILITY_AUDIENCE,
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
import {
  GARDEN_CAPABILITY_CONTEXT_HEADER,
  GARDEN_CAPABILITY_PROTOCOL_BOUNDS,
  parseGardenCapabilityContext,
  type GardenCapabilityContext,
} from '../../boundary/fleet-auth/garden-capability-context.js';
import type { FleetAuthVerifierConfig } from '../../system/config/fleet-auth-config.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import { sendText, type HttpLogger } from '../../channels/backplane/http/primitives.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';

// Canonical envelope codec lives in the fleet-auth boundary; re-exported here
// for the operator-side call sites that historically imported it from this
// module.
export {
  GARDEN_CAPABILITY_CONTEXT_HEADER,
  buildGardenCapabilityHeaders,
  encodeGardenCapabilityContext,
} from '../../boundary/fleet-auth/garden-capability-context.js';
export type { GardenCapabilityContext } from '../../boundary/fleet-auth/garden-capability-context.js';

const REQUEST_CAPABILITY_HEADER = REQUEST_CAPABILITY_ASSERTION_HEADERS[0];

const FLEET_CALLER_AUTHORITY_HEADERS = Object.freeze([
  'authorization',
  'cookie',
  'x-contact-id',
  'x-companion-shared-workspace-credential',
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
  readonly testingHarness?: { readonly enabled: true };
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

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) throw new Error(`duplicate ${name} header`);
  return value;
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
    ...(input.fleetAuthVerifier.testingHarness?.enabled
      ? { testingHarness: Object.freeze({ enabled: true as const }) }
      : {}),
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
    || token.length > GARDEN_CAPABILITY_PROTOCOL_BOUNDS.capabilityLength) {
    return { decision: 'deny', status: 401, message: 'Fleet Garden capability required' };
  }

  let context: GardenCapabilityContext;
  let verified: VerifiedRequestCapability;
  try {
    context = parseGardenCapabilityContext(encodedContext, input.admission.companionId);
    if (input.admission.audience === 'operator') {
      if (context.parent) throw new Error('operator capability cannot contain a parent');
      try {
        verified = input.admission.verifier.verifyOperator({ token, target, ...context });
      } catch (error) {
        if (input.admission.testingHarness?.enabled !== true) throw error;
        verified = input.admission.verifier.verifyTestingHarness({ token, target, ...context });
      }
      if (verified.authContext.provider === 'testing_harness') {
        if (input.admission.testingHarness?.enabled !== true
          || !timingSafeStringEqual(
            verified.audience,
            TESTING_HARNESS_REQUEST_CAPABILITY_AUDIENCE,
          )) {
          throw new Error('testing-harness audience mismatch');
        }
      } else if (!timingSafeStringEqual(
        verified.audience,
        `operator:${input.admission.companionId}`,
      )) {
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
  if (verified.authContext.provider === 'testing_harness'
    && input.admission.testingHarness?.enabled !== true) {
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
