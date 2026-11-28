import type {
  ConfirmationResolveRequest,
  ConfirmationResolveResult,
} from '../../../system/capabilities/confirmation-queue.js';
import type { CompiledGardenRequestTarget } from '../../../boundary/fleet-auth/request-capability-target.js';
import type { RequestCapabilityAuthorityVersions } from '../../../boundary/fleet-auth/request-capability.js';
import { isRecord } from '../../../shared/utils/types.js';

// GATEWAY_OPERATOR_API_BASE_URL already ends in /v1; route paths omit it.
const OPERATOR_CONFIRMATION_PATH = '/operator/confirmations/resolve';
const FLEET_CONFIRMATION_PATH = '/internal/fleet-auth/confirmations/resolve';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_LENGTH = 1_024;
const MAX_COOKIE_LENGTH = 2_048;
const RESOLUTION_STATUSES = new Set([
  'approved',
  'denied',
  'modified',
  'expired',
  'failed',
  'not_found',
]);

export interface GatewayOperatorConfirmationClient {
  resolve(
    params: ConfirmationResolveRequest,
    authority: GatewayOperatorConfirmationAuthority,
  ): Promise<ConfirmationResolveResult>;
}

/** Exact admitted Fleet Garden parent capability for the canonical resolve route. */
export interface FleetConfirmationParentCapability {
  readonly token: string;
  readonly target: CompiledGardenRequestTarget<Buffer>;
  readonly requestId: string;
  readonly decisionId: string;
  readonly versions: RequestCapabilityAuthorityVersions;
}

type GatewayOperatorConfirmationAuthority =
  | Readonly<{
      kind: 'standalone_operator';
      authorization?: string;
      cookie?: string;
    }>
  | Readonly<{
      kind: 'fleet_principal';
      parent: FleetConfirmationParentCapability;
    }>;

/** The gateway refused the presented authority; no resolution happened. */
export class GatewayOperatorConfirmationDeniedError extends Error {
  constructor() {
    super('Gateway operator confirmation authority was denied.');
    this.name = 'GatewayOperatorConfirmationDeniedError';
  }
}

interface GatewayOperatorConfirmationClientDeps {
  operatorToken: string;
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface GatewayFleetConfirmationClientDeps {
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

function resolveEndpoint(baseUrl: string, path: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('GATEWAY_OPERATOR_API_BASE_URL must be a valid absolute URL.');
  }
  if ((base.protocol !== 'http:' && base.protocol !== 'https:')
    || base.username
    || base.password
    || base.search
    || base.hash) {
    throw new Error('GATEWAY_OPERATOR_API_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  const basePath = base.pathname.replace(/\/+$/u, '');
  base.pathname = `${basePath}${path}`;
  return base;
}

function boundedCredential(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength || /[\r\n\u0000]/u.test(normalized)) {
    throw new Error('Operator authentication credential is invalid.');
  }
  return normalized;
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Gateway operator confirmation response exceeded the size limit.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Gateway operator confirmation response exceeded the size limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function parseResolveResult(value: unknown, expectedId: string): ConfirmationResolveResult {
  if (!isRecord(value)
    || value.id !== expectedId
    || typeof value.status !== 'string'
    || !RESOLUTION_STATUSES.has(value.status)
    || typeof value.message !== 'string'
    || value.message.length > 4_096
    || typeof value.executed !== 'boolean') {
    throw new Error('Gateway operator confirmation response was invalid.');
  }
  return {
    id: value.id,
    status: value.status as ConfirmationResolveResult['status'],
    message: value.message,
    executed: value.executed,
  };
}

function assertPositiveTimeout(requestTimeoutMs: number): void {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('Gateway operator confirmation request timeout must be a positive integer.');
  }
}

async function postResolution(input: {
  readonly fetchImpl: typeof fetch;
  readonly endpoint: URL;
  readonly requestTimeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly expectedId: string;
}): Promise<ConfirmationResolveResult> {
  const response = await input.fetchImpl(input.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(input.requestTimeoutMs),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...input.headers,
    },
    body: JSON.stringify(input.body),
  });
  const responseText = await readBoundedText(response);
  if (response.status === 403) throw new GatewayOperatorConfirmationDeniedError();
  if (!response.ok) {
    throw new Error(`Gateway operator confirmation failed with HTTP ${response.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error('Gateway operator confirmation returned invalid JSON.');
  }
  return parseResolveResult(parsed, input.expectedId);
}

function assertNoCompanionAssertion(params: ConfirmationResolveRequest): void {
  if (isRecord(params) && 'companionId' in params) {
    throw new Error('Confirmation params cannot assert companion authority.');
  }
}

/**
 * Standalone Garden: the independently authenticated operator process carries
 * the internal ADMIN_TOKEN straight to the gateway operator endpoint.
 */
export function createGatewayOperatorConfirmationClient(
  baseUrl: string,
  deps: GatewayOperatorConfirmationClientDeps,
): GatewayOperatorConfirmationClient {
  assertPositiveTimeout(deps.requestTimeoutMs);
  const operatorToken = boundedCredential(deps.operatorToken, MAX_AUTHORIZATION_LENGTH);
  if (!operatorToken) {
    throw new Error('Internal gateway operator token is required for confirmation resolution.');
  }
  const endpoint = resolveEndpoint(baseUrl, OPERATOR_CONFIRMATION_PATH);
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    resolve: async (params, authority) => {
      assertNoCompanionAssertion(params);
      if (authority.kind !== 'standalone_operator') {
        throw new Error('Token confirmation routing accepts only standalone Garden operators.');
      }
      const authorization = boundedCredential(
        authority.authorization,
        MAX_AUTHORIZATION_LENGTH,
      );
      const cookie = boundedCredential(authority.cookie, MAX_COOKIE_LENGTH);
      if (!authorization && !cookie) {
        throw new Error('Authenticated Garden operator credentials are required for gateway resolution.');
      }
      return await postResolution({
        fetchImpl,
        endpoint,
        requestTimeoutMs: deps.requestTimeoutMs,
        headers: { Authorization: `Bearer ${operatorToken}` },
        body: params,
        expectedId: params.id,
      });
    },
  };
}

/**
 * Fleet Garden: the operator holds no gateway credential. It presents the
 * exact admitted parent capability; the gateway resolves only that signed
 * body, for that capability's companion and principal.
 */
export function createGatewayFleetConfirmationClient(
  baseUrl: string,
  deps: GatewayFleetConfirmationClientDeps,
): GatewayOperatorConfirmationClient {
  assertPositiveTimeout(deps.requestTimeoutMs);
  const endpoint = resolveEndpoint(baseUrl, FLEET_CONFIRMATION_PATH);
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    resolve: async (params, authority) => {
      assertNoCompanionAssertion(params);
      if (authority.kind !== 'fleet_principal') {
        throw new Error('Fleet confirmation routing requires an admitted Fleet Garden parent.');
      }
      const { parent } = authority;
      return await postResolution({
        fetchImpl,
        endpoint,
        requestTimeoutMs: deps.requestTimeoutMs,
        headers: {},
        body: {
          schemaVersion: 1,
          companionId: parent.target.companionId,
          parent: {
            token: parent.token,
            target: {
              rawTarget: parent.target.canonicalRequestTarget,
              method: parent.target.method,
              bodyBase64: parent.target.body.toString('base64url'),
              headers: null,
            },
            requestId: parent.requestId,
            decisionId: parent.decisionId,
            versions: parent.versions,
          },
        },
        expectedId: params.id,
      });
    },
  };
}
