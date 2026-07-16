import { randomUUID } from 'node:crypto';
import type { CompiledGardenRequestTarget } from '../../boundary/fleet-auth/request-capability-target.js';
import type { GardenCapabilityContext } from './garden-admission.js';
import { isRecord } from '../../shared/utils/types.js';

const CHILD_ASSERTION_PATH = '/v1/internal/fleet-auth/child-assertions';
const CHILD_ASSERTION_PROTOCOL_BOUNDS = Object.freeze({
  requestTimeoutMs: 5_000,
  responseBytes: 128 * 1024,
});

export interface GardenFleetChildAssertion {
  readonly token: string;
  readonly context: GardenCapabilityContext;
}

export interface GardenFleetChildAssertionClient {
  exchange(input: {
    readonly parentToken: string;
    readonly parentContext: GardenCapabilityContext;
    readonly target: CompiledGardenRequestTarget<Buffer>;
  }): Promise<GardenFleetChildAssertion>;
}

function endpointFromBaseUrl(baseUrl: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error('Fleet child assertion gateway base URL must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash) {
    throw new Error('Fleet child assertion gateway base URL is invalid');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}${CHILD_ASSERTION_PATH}`;
  return endpoint;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > CHILD_ASSERTION_PROTOCOL_BOUNDS.responseBytes) {
    throw new Error('Fleet child assertion response exceeded the size limit');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Fleet child assertion response was invalid JSON');
  }
}

function parseResponse(value: unknown): GardenFleetChildAssertion {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.token !== 'string'
    || value.token.length < 1
    || value.token.length > 65_536
    || !isRecord(value.versions)
    || !isRecord(value.parent)
    || typeof value.requestId !== 'string'
    || typeof value.decisionId !== 'string') {
    throw new Error('Fleet child assertion response was invalid');
  }
  return Object.freeze({
    token: value.token,
    context: Object.freeze({
      requestId: value.requestId,
      decisionId: value.decisionId,
      versions: value.versions as unknown as GardenCapabilityContext['versions'],
      parent: value.parent as unknown as NonNullable<GardenCapabilityContext['parent']>,
    }),
  });
}

export function createGardenFleetChildAssertionClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): GardenFleetChildAssertionClient {
  const endpoint = endpointFromBaseUrl(baseUrl);
  return Object.freeze({
    exchange: async ({ parentToken, parentContext, target }) => {
      if (parentContext.parent) throw new Error('Operator parent capability must not be a child');
      const requestId = randomUUID();
      const wireTarget = {
        rawTarget: target.canonicalRequestTarget,
        method: target.method,
        bodyBase64: target.body.toString('base64url'),
        headers: null,
      };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(CHILD_ASSERTION_PROTOCOL_BOUNDS.requestTimeoutMs),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          companionId: target.companionId,
          parent: {
            token: parentToken,
            target: wireTarget,
            requestId: parentContext.requestId,
            decisionId: parentContext.decisionId,
            versions: parentContext.versions,
          },
          child: {
            target: wireTarget,
            requestId,
          },
        }),
      });
      const payload = await readBoundedJson(response);
      if (!response.ok) {
        throw new Error(`Fleet child assertion exchange failed with HTTP ${response.status}`);
      }
      return parseResponse(payload);
    },
  });
}
