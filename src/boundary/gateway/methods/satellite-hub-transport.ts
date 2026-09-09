import { JSONRPCErrorException } from 'json-rpc-2.0';
import { GatewayErrors } from '../protocol.js';
import type { GatewayMethodRuntime } from './types.js';
import { resolveOptionalEnvCredential } from '../../custody/credential-vault.js';
import { isRecord } from '../../../shared/utils/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

// ── Gateway → Satellite Hub private control transport ──
//
// The gateway holds the Hub control credential (`SATELLITE_HUB_CONTROL_TOKEN`)
// and the Hub control URL (`SATELLITE_HUB_CONTROL_BASE_URL`). Home Assistant
// methods and the companion's own world-avatar methods share this one HTTP
// path. Nothing here involves a Hub device assertion or fleet auth: a key is
// the whole credential.

const HUB_CONTROL_TOKEN_ENV = 'SATELLITE_HUB_CONTROL_TOKEN';
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export function denyPolicy(message: string): never {
  throw new JSONRPCErrorException(message, GatewayErrors.POLICY_DENIED);
}

export function providerError(message: string): never {
  throw new JSONRPCErrorException(message, GatewayErrors.PROVIDER_ERROR);
}

interface ResolveSatelliteHubOptions {
  /** Home Assistant methods additionally require `homeAssistant.enabled`. */
  requireHomeAssistant?: boolean;
}

/**
 * The Hub control endpoint for this gateway. `satelliteHub` is the transport
 * block (URL + whether the token is present); `homeAssistant` carries the
 * same URL for callers that predate the split. Either satisfies the world
 * methods; Home Assistant callers still need Home Assistant enabled.
 */
function resolveSatelliteHub(
  runtime: GatewayMethodRuntime,
  options: ResolveSatelliteHubOptions = {},
): { baseUrl: URL; token: string } {
  const ha = runtime.policyConfig.homeAssistant;
  const hub = runtime.policyConfig.satelliteHub;
  if (options.requireHomeAssistant && ha?.enabled !== true) {
    denyPolicy('Satellite Hub world transport is not fully configured');
  }
  const rawBaseUrl = hub?.controlBaseUrl?.trim() || ha?.hubBaseUrl?.trim() || '';
  const tokenConfigured = hub?.tokenConfigured === true || ha?.tokenConfigured === true;
  if (!rawBaseUrl || !tokenConfigured) {
    denyPolicy('Satellite Hub world transport is not fully configured');
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    denyPolicy('Satellite Hub control URL is invalid');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    denyPolicy('Satellite Hub control URL must be an http(s) URL without embedded credentials');
  }
  baseUrl.search = '';
  baseUrl.hash = '';
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/u, '');
  const token = resolveOptionalEnvCredential(runtime.credentialVault, HUB_CONTROL_TOKEN_ENV);
  if (!token) denyPolicy(`Satellite Hub control credential is missing (${HUB_CONTROL_TOKEN_ENV})`);
  return { baseUrl, token };
}

export interface RequestSatelliteHubOptions extends ResolveSatelliteHubOptions {
  timeoutMs?: number;
}

/** One bounded JSON request to the Hub control port. */
export async function requestSatelliteHub(
  runtime: GatewayMethodRuntime,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  options: RequestSatelliteHubOptions = {},
): Promise<unknown> {
  const { baseUrl, token } = resolveSatelliteHub(runtime, options);
  const url = new URL(baseUrl);
  url.pathname = `${baseUrl.pathname.replace(/\/+$/u, '')}${path}`;
  const encoded = body ? JSON.stringify(body) : undefined;
  if (encoded && Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) denyPolicy('Satellite Hub request is too large');
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(encoded ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(encoded ? { body: encoded } : {}),
    });
  } catch (error) {
    providerError(`Satellite Hub request failed: ${toErrorMessage(error)}`);
  }
  const bytes = await readBoundedResponse(response);
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    providerError('Satellite Hub returned malformed JSON');
  }
  if (!response.ok) {
    const detail = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
      ? payload.error.message
      : `${response.status} ${response.statusText}`;
    providerError(`Satellite Hub rejected world request: ${detail}`);
  }
  return payload;
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    providerError('Satellite Hub response is too large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      providerError('Satellite Hub response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
