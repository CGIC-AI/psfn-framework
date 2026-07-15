import type {
  ConfirmationResolveRequest,
  ConfirmationResolveResult,
} from '../../../system/capabilities/confirmation-queue.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { ConfirmationOperatorAuthContext } from '../../../operator/garden/admin-contract.js';

const OPERATOR_CONFIRMATION_PATH = '/operator/confirmations/resolve';
const REQUEST_TIMEOUT_MS = 5_000;
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
    auth: ConfirmationOperatorAuthContext,
  ): Promise<ConfirmationResolveResult>;
}

interface GatewayOperatorConfirmationClientDeps {
  fetchImpl?: typeof fetch;
}

function resolveEndpoint(baseUrl: string): URL {
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
  base.pathname = `${basePath}${OPERATOR_CONFIRMATION_PATH}`;
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

export function createGatewayOperatorConfirmationClient(
  baseUrl: string,
  deps: GatewayOperatorConfirmationClientDeps = {},
): GatewayOperatorConfirmationClient {
  const endpoint = resolveEndpoint(baseUrl);
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    resolve: async (params, auth) => {
      const authorization = boundedCredential(auth.authorization, MAX_AUTHORIZATION_LENGTH);
      const cookie = boundedCredential(auth.cookie, MAX_COOKIE_LENGTH);
      if (!authorization && !cookie) {
        throw new Error('Authenticated Garden operator credentials are required for gateway resolution.');
      }

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(authorization
            ? { Authorization: authorization }
            : cookie
              ? { Cookie: cookie }
              : {}),
        },
        body: JSON.stringify(params),
      });
      const responseText = await readBoundedText(response);
      if (!response.ok) {
        throw new Error(`Gateway operator confirmation failed with HTTP ${response.status}.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText) as unknown;
      } catch {
        throw new Error('Gateway operator confirmation returned invalid JSON.');
      }
      return parseResolveResult(parsed, params.id);
    },
  };
}
