import { randomUUID } from 'node:crypto';
import type { CompiledGardenRequestTarget } from '../../boundary/fleet-auth/request-capability-target.js';
import type { VerifiedRequestCapability } from '../../boundary/fleet-auth/request-capability.js';
import type { GardenCapabilityContext } from './garden-admission.js';
import { hasExactKeys, isRecord } from '../../shared/utils/types.js';

const CHILD_ASSERTION_PATH = '/v1/internal/fleet-auth/child-assertions';
const CHILD_ASSERTION_PROTOCOL_BOUNDS = Object.freeze({
  requestTimeoutMs: 5_000,
  responseBytes: 128 * 1024,
});
const VERSION_KEYS = [
  'authorityGeneration',
  'globalAuthEpoch',
  'sessionAuthnVersion',
  'sessionAuthzVersion',
  'bindingVersion',
  'grantVersion',
  'policyVersion',
] as const;
const PARENT_KEYS = ['audience', 'requestId', 'decisionId', 'jti', 'targetDigest'] as const;

export interface GardenFleetChildAssertion {
  readonly token: string;
  readonly context: GardenCapabilityContext;
}

export interface GardenFleetChildAssertionClient {
  exchange(input: {
    readonly parentToken: string;
    readonly parentContext: GardenCapabilityContext;
    readonly parentVerified: VerifiedRequestCapability;
    readonly target: CompiledGardenRequestTarget<Buffer>;
    readonly expectedAgentAudience: `agent:${string}`;
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

function parseResponse(
  value: unknown,
  expected: {
    readonly requestId: string;
    readonly target: CompiledGardenRequestTarget<Buffer>;
    readonly parentVerified: VerifiedRequestCapability;
    readonly expectedAgentAudience: `agent:${string}`;
  },
): GardenFleetChildAssertion {
  const expectedParent = {
    audience: expected.parentVerified.audience,
    requestId: expected.parentVerified.requestId,
    decisionId: expected.parentVerified.decisionId,
    jti: expected.parentVerified.jti,
    targetDigest: expected.parentVerified.targetDigest,
  };
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'token',
      'audience',
      'requestId',
      'decisionId',
      'targetDigest',
      'versions',
      'parent',
    ])
    || value.schemaVersion !== 1
    || typeof value.token !== 'string'
    || value.token.length < 1
    || value.token.length > 65_536
    || value.audience !== expected.expectedAgentAudience
    || value.requestId !== expected.requestId
    || value.targetDigest !== expected.target.targetDigest
    || !isRecord(value.versions)
    || !hasExactKeys(value.versions, VERSION_KEYS)
    || !isRecord(value.parent)
    || !hasExactKeys(value.parent, PARENT_KEYS)
    || typeof value.requestId !== 'string'
    || typeof value.decisionId !== 'string'
    || value.decisionId.length < 1
    || value.decisionId.length > 256
    || VERSION_KEYS.some(key => value.versions[key] !== expected.parentVerified.versions[key])
    || PARENT_KEYS.some(key => value.parent[key] !== expectedParent[key])) {
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
    exchange: async (
      { parentToken, parentContext, parentVerified, target, expectedAgentAudience }:
      Parameters<GardenFleetChildAssertionClient['exchange']>[0],
    ) => {
      if (parentContext.parent) throw new Error('Operator parent capability must not be a child');
      if (parentVerified.parent
        || parentVerified.companionId !== target.companionId
        || parentVerified.audience !== `operator:${target.companionId}`
        || expectedAgentAudience !== `agent:${target.companionId}`
        || parentContext.requestId !== parentVerified.requestId
        || parentContext.decisionId !== parentVerified.decisionId
        || VERSION_KEYS.some(
          key => parentContext.versions[key] !== parentVerified.versions[key],
        )) {
        throw new Error('Fleet child assertion input was not bound to one companion');
      }
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
      return parseResponse(payload, {
        requestId,
        target,
        parentVerified,
        expectedAgentAudience,
      });
    },
  });
}
