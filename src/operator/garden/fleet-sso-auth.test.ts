import { generateKeyPairSync } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  compileGatewayGardenRequestTarget,
  validateGardenRequestMetadata,
} from '../../boundary/fleet-auth/request-capability-target.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthorityVersions,
} from '../../boundary/fleet-auth/request-capability.js';
import {
  authenticateGardenFleetSsoRequest,
  GardenFleetSsoAuthenticationError,
} from './fleet-sso-auth.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const OTHER_COMPANION_ID = createCompanionId('22222222-2222-4222-8222-222222222222');
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DECISION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JTI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = Math.floor(Date.now() / 1_000);
const VERSIONS: RequestCapabilityAuthorityVersions = {
  authorityGeneration: 1,
  globalAuthEpoch: 1,
  sessionAuthnVersion: 1,
  sessionAuthzVersion: 1,
  bindingVersion: 1,
  grantVersion: 1,
  policyVersion: 1,
};
const keyPair = generateKeyPairSync('ed25519');
const signer = createGatewayRequestCapabilitySigner({
  issuer: 'fleet-sso-garden-test',
  kid: 'active',
  privateKeyPem: keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  ttlSeconds: 30,
  nowSeconds: () => NOW,
  generateJti: () => JTI,
});
const verifier = createRequestCapabilityVerifier({
  issuer: 'fleet-sso-garden-test',
  maxTtlSeconds: 30,
  keys: [{
    issuer: 'fleet-sso-garden-test',
    kid: 'active',
    publicKeyPem: keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
    status: 'active',
  }],
});

function envelope(overrides: Record<string, string> = {}): IncomingMessage {
  const target = compileGatewayGardenRequestTarget({
    rawTarget: '/api/admin/dashboard',
    method: 'GET',
    companionId: COMPANION_ID,
    body: Buffer.alloc(0),
  });
  const token = signer.signOperator({ target, requestId: REQUEST_ID, decisionId: DECISION_ID, versions: VERSIONS });
  const verified = verifier.verifyOperator({
    token,
    target,
    requestId: REQUEST_ID,
    decisionId: DECISION_ID,
    versions: VERSIONS,
    nowSeconds: NOW,
  });
  return {
    headers: {
      'content-length': '0',
      'x-psfn-request-capability': token,
      'x-psfn-capability-audience': verified.audience,
      'x-psfn-capability-request-id': REQUEST_ID,
      'x-psfn-capability-decision': DECISION_ID,
      'x-psfn-capability-jti': JTI,
      ...overrides,
    },
  } as IncomingMessage;
}

const metadata = validateGardenRequestMetadata({
  rawTarget: '/api/admin/dashboard',
  method: 'GET',
});

describe('Garden Fleet SSO capability boundary', () => {
  it('verifies the exact operator envelope and strips every assertion before agent proxying', () => {
    const request = envelope();
    expect(authenticateGardenFleetSsoRequest({ request, metadata, companionId: COMPANION_ID, verifier }))
      .toMatchObject({ companionId: COMPANION_ID, requestId: REQUEST_ID, decisionId: DECISION_ID });
    expect(Object.keys(request.headers).filter(name => name.startsWith('x-psfn-'))).toEqual([]);
  });

  it('rejects a changed companion or browser credential and strips assertions on denial', () => {
    const changedCompanion = envelope();
    expect(() => authenticateGardenFleetSsoRequest({
      request: changedCompanion,
      metadata,
      companionId: OTHER_COMPANION_ID,
      verifier,
    })).toThrow();
    expect(Object.keys(changedCompanion.headers).filter(name => name.startsWith('x-psfn-'))).toEqual([]);

    const browserCredential = envelope({ authorization: 'Bearer browser-token' });
    expect(() => authenticateGardenFleetSsoRequest({
      request: browserCredential,
      metadata,
      companionId: COMPANION_ID,
      verifier,
    })).toThrow(GardenFleetSsoAuthenticationError);
    expect(Object.keys(browserCredential.headers).filter(name => name.startsWith('x-psfn-'))).toEqual([]);
  });
});
