import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { resolveFleetModelUsageInternalRequestTarget } from '../../shared/telemetry/fleet-model-usage-request.js';
import { compileGatewayGardenRequestTarget } from './request-capability-target.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  RequestCapabilityRejectedError,
  type RequestCapabilityAuthorityVersions,
  type RequestCapabilityParentBinding,
  type RequestCapabilityVerifierConfig,
} from './request-capability.js';

const NOW = Math.floor(Date.parse('2030-01-01T00:00:00.000Z') / 1_000);
const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const OTHER_COMPANION_ID = createCompanionId('22222222-2222-4222-8222-222222222222');
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DECISION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JTI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ISSUER = 'fleet-auth';
const ACTIVE_KID = '2030-active';
const keyPair = generateKeyPairSync('ed25519');
const nextKeyPair = generateKeyPairSync('ed25519');
const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const nextPublicKeyPem = nextKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const VERSIONS: RequestCapabilityAuthorityVersions = Object.freeze({
  authorityGeneration: 7,
  globalAuthEpoch: 11,
  sessionAuthnVersion: 2,
  sessionAuthzVersion: 3,
  bindingVersion: 5,
  grantVersion: 13,
  policyVersion: 17,
});
const AUTH_CONTEXT = Object.freeze({
  principalId: 'principal-a', provider: 'discord' as const, providerSubjectId: '12345678901234567',
  companionId: COMPANION_ID, contactBindingId: 'binding-a', contactId: 'contact-a',
  operatorGrantId: 'grant-a', role: 'admin' as const, sessionRecordId: 'session-a',
  sessionAssurance: 'escalated' as const, fleetAccessMode: 'multi_admin' as const,
  authorizationEventId: 'event-a',
  resolvedAt: '2030-01-01T00:00:00.000Z',
});
const TESTING_HARNESS_AUTH_CONTEXT = Object.freeze({
  ...AUTH_CONTEXT,
  principalId: 'testing-harness',
  provider: 'testing_harness' as const,
  providerSubjectId: 'testing-harness',
});
const FLEET_MODEL_USAGE_REQUEST_TARGET = resolveFleetModelUsageInternalRequestTarget(
  { range: 'week', timezone: 'UTC' },
  NOW * 1_000,
);

function target(
  rawTarget = '/api/admin/images/generated?favorite=true&q=cat',
  method = 'GET',
  body = Buffer.alloc(0),
  companionId = COMPANION_ID,
) {
  return compileGatewayGardenRequestTarget({ rawTarget, method, body, companionId });
}

function key(
  kid = ACTIVE_KID,
  status: 'active' | 'retiring' | 'revoked' = 'active',
  pem = publicKeyPem,
) {
  return {
    issuer: ISSUER,
    kid,
    publicKeyPem: pem,
    notBefore: '2029-01-01T00:00:00.000Z',
    notAfter: '2031-01-01T00:00:00.000Z',
    status,
  } as const;
}

function verifier(keys: RequestCapabilityVerifierConfig['keys'] = [key()]) {
  return createRequestCapabilityVerifier({ issuer: ISSUER, maxTtlSeconds: 30, keys });
}

function signer(options: { issuer?: string; kid?: string; now?: number; jti?: string } = {}) {
  return createGatewayRequestCapabilitySigner({
    issuer: options.issuer ?? ISSUER,
    kid: options.kid ?? ACTIVE_KID,
    privateKeyPem,
    ttlSeconds: 30,
    nowSeconds: () => options.now ?? NOW,
    generateJti: () => options.jti ?? JTI,
  });
}

function binding(compiled = target()) {
  return {
    target: compiled,
    requestId: REQUEST_ID,
    decisionId: DECISION_ID,
    authContext: { ...AUTH_CONTEXT, companionId: compiled.companionId },
    versions: VERSIONS,
  };
}

function parseToken(token: string) {
  const [header, claims, signature] = token.split('.') as [string, string, string];
  return {
    header,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>,
    signature,
  };
}

function encodeToken(input: {
  header: string;
  claims: Record<string, unknown>;
  signature?: string;
  resign?: boolean;
}): string {
  const claims = Buffer.from(JSON.stringify(input.claims), 'utf8').toString('base64url');
  const signingInput = `${input.header}.${claims}`;
  const signature = input.resign
    ? signBytes(null, Buffer.from(signingInput, 'ascii'), keyPair.privateKey).toString('base64url')
    : input.signature!;
  return `${signingInput}.${signature}`;
}

function parentFrom(token: string): RequestCapabilityParentBinding {
  const verified = verifier().verifyOperator({ token, ...binding(), nowSeconds: NOW });
  return {
    audience: verified.audience as `operator:${string}`,
    requestId: verified.requestId,
    decisionId: verified.decisionId,
    jti: verified.jti,
    targetDigest: verified.targetDigest,
  };
}

describe('Ed25519 hop request capabilities', () => {
  it('round-trips a canonical operator golden and binds every authority field', () => {
    const compiled = target();
    const token = signer().signOperator(binding(compiled));
    const verified = verifier().verifyOperator({ token, ...binding(compiled), nowSeconds: NOW });

    expect(verified).toEqual({
      issuer: ISSUER,
      keyId: ACTIVE_KID,
      audience: `operator:${COMPANION_ID}`,
      companionId: COMPANION_ID,
      requestId: REQUEST_ID,
      decisionId: DECISION_ID,
      authContext: AUTH_CONTEXT,
      jti: JTI,
      method: compiled.method,
      canonicalRequestTarget: compiled.canonicalRequestTarget,
      action: compiled.action,
      bodyDigest: compiled.bodyDigest,
      bodyLength: compiled.bodyLength,
      resourceDigest: compiled.resourceDigest,
      versions: VERSIONS,
      targetDigest: compiled.targetDigest,
      authorizationDigest: compiled.authorizationDigest,
      issuedAt: NOW,
      notBefore: NOW,
      expiresAt: NOW + 30,
    });
  });

  it('signs a canonical fleet roster only for the fleet model-usage read', () => {
    const compiled = target('/api/admin/fleet-model-usage?range=week');
    const fleetCompanionIds = Object.freeze([COMPANION_ID, OTHER_COMPANION_ID]);
    const input = {
      ...binding(compiled),
      authContext: {
        ...AUTH_CONTEXT,
        fleetCompanionIds,
        fleetModelUsageRequestTarget: FLEET_MODEL_USAGE_REQUEST_TARGET,
      },
    };
    const token = signer().signOperator(input);

    expect(verifier().verifyOperator({
      token,
      ...binding(compiled),
      nowSeconds: NOW,
    }).authContext).toMatchObject({
      fleetCompanionIds,
      fleetModelUsageRequestTarget: FLEET_MODEL_USAGE_REQUEST_TARGET,
    });
    expect(() => signer().signOperator({
      ...binding(target('/api/admin/model-usage?range=week')),
      authContext: {
        ...AUTH_CONTEXT,
        fleetCompanionIds,
        fleetModelUsageRequestTarget: FLEET_MODEL_USAGE_REQUEST_TARGET,
      },
    })).toThrow(/fleet roster is outside/u);
    expect(() => signer().signOperator({
      ...binding(compiled),
      authContext: {
        ...AUTH_CONTEXT,
        fleetCompanionIds: [OTHER_COMPANION_ID, COMPANION_ID],
        fleetModelUsageRequestTarget: FLEET_MODEL_USAGE_REQUEST_TARGET,
      },
    })).toThrow(/not canonical/u);
    expect(() => signer().signOperator({
      ...binding(compiled),
      authContext: {
        ...AUTH_CONTEXT,
        fleetCompanionIds,
        fleetModelUsageRequestTarget:
          '/api/admin/model-usage?range=custom&timezone=UTC&sinceMs=0&untilMs=3600000&bucket=hour&limit=1&topN=100&groupBy=model',
      },
    })).toThrow(/does not match the fleet route/u);
  });

  it('requires an exact operator parent for agent capabilities and forbids parent/audience crossover', () => {
    const operatorToken = signer().signOperator(binding());
    const parent = parentFrom(operatorToken);
    const agentToken = signer({ jti: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })
      .signAgent({ ...binding(), parent });

    expect(verifier().verifyAgent({ token: agentToken, ...binding(), parent, nowSeconds: NOW }))
      .toMatchObject({ audience: `agent:${COMPANION_ID}`, parent });
    expect(() => verifier().verifyOperator({ token: agentToken, ...binding(), nowSeconds: NOW }))
      .toThrow(RequestCapabilityRejectedError);
    expect(() => verifier().verifyAgent({
      token: operatorToken,
      ...binding(),
      parent,
      nowSeconds: NOW,
    })).toThrow(RequestCapabilityRejectedError);
    expect(() => verifier().verifyAgent({
      token: agentToken,
      ...binding(),
      parent: { ...parent, decisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      nowSeconds: NOW,
    })).toThrow(/parent binding does not match/u);
  });

  it('uses a provider-scoped testing-harness parent audience and rejects verifier crossover', () => {
    const harnessBinding = { ...binding(), authContext: TESTING_HARNESS_AUTH_CONTEXT };
    const harnessToken = signer().signTestingHarness(harnessBinding);
    const harnessVerified = verifier().verifyTestingHarness({
      token: harnessToken,
      ...binding(),
      nowSeconds: NOW,
    });
    const parent: RequestCapabilityParentBinding = {
      audience: harnessVerified.audience,
      requestId: harnessVerified.requestId,
      decisionId: harnessVerified.decisionId,
      jti: harnessVerified.jti,
      targetDigest: harnessVerified.targetDigest,
    };
    const agentToken = signer({ jti: 'testing-harness-agent-once' }).signAgent({
      ...harnessBinding,
      parent,
    });

    expect(harnessVerified).toMatchObject({
      audience: 'testing-harness',
      authContext: TESTING_HARNESS_AUTH_CONTEXT,
    });
    expect(verifier().verifyAgent({
      token: agentToken,
      ...binding(),
      parent,
      nowSeconds: NOW,
    })).toMatchObject({ audience: `agent:${COMPANION_ID}`, parent });
    expect(() => verifier().verifyOperator({
      token: harnessToken,
      ...binding(),
      nowSeconds: NOW,
    })).toThrow(RequestCapabilityRejectedError);
    expect(() => verifier().verifyTestingHarness({
      token: signer().signOperator(binding()),
      ...binding(),
      nowSeconds: NOW,
    })).toThrow(RequestCapabilityRejectedError);
  });

  it.each([
    ['query', target('/api/admin/images/generated?favorite=true&q=dog')],
    ['path/action/resource', target('/api/admin/settings')],
    ['companion', target('/api/admin/images/generated?favorite=true&q=cat', 'GET', Buffer.alloc(0), OTHER_COMPANION_ID)],
  ])('rejects a changed %s target', (_field, changedTarget) => {
    const token = signer().signOperator(binding());
    expect(() => verifier().verifyOperator({
      token,
      ...binding(changedTarget),
      nowSeconds: NOW,
    })).toThrow(RequestCapabilityRejectedError);
  });

  it('rejects a changed method', () => {
    const signedTarget = target('/api/admin/settings');
    const changedTarget = target('/api/admin/settings', 'PATCH', Buffer.from('{}'));
    const token = signer().signOperator(binding(signedTarget));
    expect(() => verifier().verifyOperator({
      token,
      ...binding(changedTarget),
      nowSeconds: NOW,
    })).toThrow(RequestCapabilityRejectedError);
  });

  it('rejects changed exact body bytes and digest', () => {
    const signedTarget = target(
      '/api/admin/images/generated/image-a',
      'PATCH',
      Buffer.from('{"favorite":true}'),
    );
    const changedTarget = target(
      '/api/admin/images/generated/image-a',
      'PATCH',
      Buffer.from('{"favorite":false}'),
    );
    const token = signer().signOperator(binding(signedTarget));
    expect(() => verifier().verifyOperator({
      token,
      ...binding(changedTarget),
      nowSeconds: NOW,
    })).toThrow(/target binding does not match/u);
  });

  it('rejects changed request, decision, and authority-version bindings', () => {
    const token = signer().signOperator(binding());
    expect(() => verifier().verifyOperator({
      token,
      ...binding(),
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      nowSeconds: NOW,
    })).toThrow(/decision binding does not match/u);
    expect(() => verifier().verifyOperator({
      token,
      ...binding(),
      decisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      nowSeconds: NOW,
    })).toThrow(/decision binding does not match/u);
    expect(() => verifier().verifyOperator({
      token,
      ...binding(),
      versions: { ...VERSIONS, globalAuthEpoch: VERSIONS.globalAuthEpoch + 1 },
      nowSeconds: NOW,
    })).toThrow(/authority versions do not match/u);
  });

  it.each([
    'jti', 'target_digest', 'authorization_digest', 'body_digest', 'decision_id', 'auth_context',
  ])('rejects forged %s claims', (field) => {
    const token = signer().signOperator(binding());
    const decoded = parseToken(token);
    decoded.claims[field] = field.endsWith('digest') ? '0'.repeat(64) : 'forged-value';
    const forged = encodeToken({ ...decoded, claims: decoded.claims });
    expect(() => verifier().verifyOperator({ token: forged, ...binding(), nowSeconds: NOW }))
      .toThrow(/signature is invalid/u);
  });

  it('requires the signed authorization digest and rejects stale or changed route classification', () => {
    const compiled = target();
    const token = signer().signOperator(binding(compiled));
    const decoded = parseToken(token);

    const missingDigestClaims = { ...decoded.claims };
    delete missingDigestClaims.authorization_digest;
    const missingDigest = encodeToken({
      ...decoded,
      claims: missingDigestClaims,
      resign: true,
    });
    expect(() => verifier().verifyOperator({
      token: missingDigest,
      ...binding(compiled),
      nowSeconds: NOW,
    })).toThrow(/invalid shape/u);

    const changedDigest = encodeToken({
      ...decoded,
      claims: { ...decoded.claims, authorization_digest: '0'.repeat(64) },
      resign: true,
    });
    expect(() => verifier().verifyOperator({
      token: changedDigest,
      ...binding(compiled),
      nowSeconds: NOW,
    })).toThrow(/request target binding does not match/u);

    const changedClassification = {
      ...compiled,
      authorization: { ...compiled.authorization, baseRole: 'owner' as const },
    };
    expect(() => signer().signOperator(binding(changedClassification)))
      .toThrow(/classification does not match/u);
    expect(() => signer().signOperator(binding({
      ...compiled,
      authorizationDigest: '0'.repeat(64),
    }))).toThrow(/authorization digest does not match/u);
  });

  it('refuses to sign an actor context for another companion', () => {
    expect(() => signer().signOperator({
      ...binding(),
      authContext: { ...AUTH_CONTEXT, companionId: OTHER_COMPANION_ID },
    })).toThrow(/authContext\.companionId does not match target/u);
  });

  it('refuses unknown actor-context fields at the signing boundary', () => {
    expect(() => signer().signOperator({
      ...binding(),
      authContext: { ...AUTH_CONTEXT, browserRole: 'owner' } as typeof AUTH_CONTEXT,
    })).toThrow(/authContext has an invalid shape/u);
  });

  it('rejects malformed, padded-signature, and signed noncanonical encodings', () => {
    const token = signer().signOperator(binding());
    const decoded = parseToken(token);
    expect(() => verifier().verifyOperator({ token: `${token}=`, ...binding(), nowSeconds: NOW }))
      .toThrow(/malformed/u);
    const reordered = { target_digest: decoded.claims.target_digest, ...decoded.claims };
    const noncanonical = encodeToken({ ...decoded, claims: reordered, resign: true });
    expect(() => verifier().verifyOperator({ token: noncanonical, ...binding(), nowSeconds: NOW }))
      .toThrow(/not canonical/u);
  });

  it('rejects unknown keys, wrong issuers, invalid time, and private verifier material', () => {
    const unknownKid = signer({ kid: 'unknown' }).signOperator(binding());
    expect(() => verifier().verifyOperator({ token: unknownKid, ...binding(), nowSeconds: NOW }))
      .toThrow(/not allowlisted/u);
    const wrongIssuer = signer({ issuer: 'other-fleet' }).signOperator(binding());
    expect(() => verifier().verifyOperator({ token: wrongIssuer, ...binding(), nowSeconds: NOW }))
      .toThrow(/issuer does not match/u);
    const expired = signer({ now: NOW - 31 }).signOperator(binding());
    expect(() => verifier().verifyOperator({ token: expired, ...binding(), nowSeconds: NOW }))
      .toThrow(/expired/u);
    const future = signer({ now: NOW + 1 }).signOperator(binding());
    expect(() => verifier().verifyOperator({ token: future, ...binding(), nowSeconds: NOW }))
      .toThrow(/not active yet/u);
    expect(() => createRequestCapabilityVerifier({
      issuer: ISSUER,
      maxTtlSeconds: 30,
      keys: [key(ACTIVE_KID, 'active', privateKeyPem)],
    })).toThrow(/public Ed25519/u);
  });

  it('accepts active/retiring overlap and rejects the retired key after a revoked-ring reload', () => {
    const oldToken = signer().signOperator(binding());
    const overlap = verifier([
      key(ACTIVE_KID, 'retiring'),
      key('2030-next', 'active', nextPublicKeyPem),
    ]);
    expect(overlap.verifyOperator({ token: oldToken, ...binding(), nowSeconds: NOW }).keyId)
      .toBe(ACTIVE_KID);

    const reloaded = verifier([
      key(ACTIVE_KID, 'revoked'),
      key('2030-next', 'active', nextPublicKeyPem),
    ]);
    expect(() => reloaded.verifyOperator({ token: oldToken, ...binding(), nowSeconds: NOW }))
      .toThrow(/key is revoked/u);
  });
});
