import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayFleetAuthChildAssertionBroker } from '../../../boundary/gateway/fleet-auth-child-assertions.js';
import {
  GatewayChildAssertionDeniedError,
  type GatewayChildAssertionExchangeInput,
} from '../../../boundary/gateway/fleet-auth-child-assertions.js';
import {
  compileGatewayGardenRequestTarget,
  type CompiledGardenRequestTarget,
  type GardenRequestHeaders,
} from '../../../boundary/fleet-auth/request-capability-target.js';
import type { RequestCapabilityAuthorityVersions } from '../../../boundary/fleet-auth/request-capability.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { hasExactKeys, isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import { normalizeTestingHarnessApiPrincipalId } from '../../backplane/http/auth.js';

export const FLEET_AUTH_CHILD_ASSERTION_EXCHANGE_PATH =
  '/v1/internal/fleet-auth/child-assertions';
const MAX_EXCHANGE_BODY_BYTES = 256 * 1024;
const MAX_TARGET_BODY_BYTES = 128 * 1024;

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
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error('invalid versions');
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) {
      throw new Error('invalid versions');
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

function parseHeaders(value: unknown): GardenRequestHeaders | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || Object.keys(value).length > 64) throw new Error('invalid headers');
  const headers: Record<string, string | readonly string[]> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[a-z0-9-]{1,64}$/u.test(name)) throw new Error('invalid headers');
    if (typeof entry === 'string' && entry.length <= 8_192) {
      headers[name] = entry;
    } else if (Array.isArray(entry)
      && entry.length <= 16
      && entry.every(item => typeof item === 'string' && item.length <= 8_192)) {
      headers[name] = Object.freeze([...entry]) as readonly string[];
    } else {
      throw new Error('invalid headers');
    }
  }
  return Object.freeze(headers);
}

function decodeCanonicalBody(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > MAX_TARGET_BODY_BYTES * 2) {
    throw new Error('invalid target body');
  }
  const body = Buffer.from(value, 'base64url');
  if (body.length > MAX_TARGET_BODY_BYTES || body.toString('base64url') !== value) {
    throw new Error('invalid target body');
  }
  return body;
}

function parseTarget(
  value: unknown,
  companionId: ReturnType<typeof createCompanionId>,
): CompiledGardenRequestTarget {
  if (!isRecord(value)
    || !hasExactKeys(value, ['rawTarget', 'method', 'bodyBase64', 'headers'])
    || typeof value.rawTarget !== 'string'
    || typeof value.method !== 'string') {
    throw new Error('invalid target');
  }
  const headers = parseHeaders(value.headers);
  return compileGatewayGardenRequestTarget({
    rawTarget: value.rawTarget,
    method: value.method,
    companionId,
    body: decodeCanonicalBody(value.bodyBase64),
    ...(headers ? { headers } : {}),
  });
}

export function parseChildAssertionExchangeRequest(
  value: unknown,
): GatewayChildAssertionExchangeInput {
  const hasProviderIdentity = isRecord(value) && Object.hasOwn(value, 'providerIdentity');
  if (!isRecord(value)
    || !hasExactKeys(
      value,
      hasProviderIdentity
        ? ['schemaVersion', 'companionId', 'providerIdentity', 'parent', 'child']
        : ['schemaVersion', 'companionId', 'parent', 'child'],
    )
    || value.schemaVersion !== 1
    || (hasProviderIdentity
      && (!isRecord(value.providerIdentity)
        || !hasExactKeys(value.providerIdentity, ['provider', 'audience'])
        || value.providerIdentity.provider !== 'testing_harness'
        || typeof value.providerIdentity.audience !== 'string'))
    || !isRecord(value.parent)
    || !hasExactKeys(value.parent, ['token', 'target', 'requestId', 'decisionId', 'versions'])
    || typeof value.parent.token !== 'string'
    || value.parent.token.length < 1
    || value.parent.token.length > 65_536
    || !isRfc4122Uuid(value.parent.requestId)
    || !isRfc4122Uuid(value.parent.decisionId)
    || !isRecord(value.child)
    || !hasExactKeys(value.child, ['target', 'requestId'])
    || !isRfc4122Uuid(value.child.requestId)) {
    throw new Error('invalid child assertion exchange');
  }
  const companionId = createCompanionId(value.companionId);
  const parentTarget = parseTarget(value.parent.target, companionId);
  const childTarget = parseTarget(value.child.target, companionId);
  const operator = hasProviderIdentity
    ? Object.freeze({
        kind: 'testing_harness_provider' as const,
        provider: 'testing_harness' as const,
        audience: normalizeTestingHarnessApiPrincipalId(
          (value.providerIdentity as Record<string, unknown>).audience as string,
        ),
        companionId,
      })
    : Object.freeze({
        kind: 'operator_process' as const,
        operatorId: `operator:${companionId}` as const,
        companionId,
      });
  return Object.freeze({
    operator,
    parent: Object.freeze({
      token: value.parent.token,
      target: parentTarget,
      requestId: value.parent.requestId,
      decisionId: value.parent.decisionId,
      versions: parseVersions(value.parent.versions),
    }),
    child: Object.freeze({
      target: childTarget,
      requestId: value.child.requestId,
    }),
  });
}

export class FleetAuthChildAssertionHttpRoute {
  constructor(private readonly broker: GatewayFleetAuthChildAssertionBroker) {}

  matches(method: string | undefined, path: string): boolean {
    return method === 'POST' && path === FLEET_AUTH_CHILD_ASSERTION_EXCHANGE_PATH;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBodyWithLimit(req, res, { maxBytes: MAX_EXCHANGE_BODY_BYTES });
    if (!body.ok) {
      if (body.errorCode !== 'payload_too_large') {
        sendJson(res, 400, { error: 'invalid_child_assertion_exchange' });
      }
      return;
    }
    try {
      const exchange = await this.broker.exchange(parseChildAssertionExchangeRequest(body.value));
      sendJson(res, 200, {
        schemaVersion: 1,
        token: exchange.token,
        audience: `agent:${exchange.target.companionId}`,
        requestId: exchange.requestId,
        decisionId: exchange.decisionId,
        targetDigest: exchange.target.targetDigest,
        versions: exchange.versions,
        parent: exchange.parent,
      });
    } catch (error) {
      if (error instanceof GatewayChildAssertionDeniedError) {
        sendJson(res, 403, { error: 'child_assertion_exchange_denied' });
        return;
      }
      sendJson(res, 400, { error: 'invalid_child_assertion_exchange' });
    }
  }
}
