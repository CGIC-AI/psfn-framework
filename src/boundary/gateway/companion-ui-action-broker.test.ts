import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { FleetAuthorizationContext } from './fleet-authorization-context.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../fleet-auth/request-capability.js';
import { GatewayFleetAuthChildAssertionBroker } from './fleet-auth-child-assertions.js';
import {
  CompanionUiActionDeniedError,
  GatewayCompanionUiActionBroker,
} from './companion-ui-action-broker.js';

const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
const principalId = '22222222-2222-4222-8222-222222222222';
const context = Object.freeze({
  principalId,
  providerSubject: Object.freeze({ provider: 'discord' as const, subjectId: '123456789012345678' }),
  companionId,
  contact: Object.freeze({
    bindingId: '33333333-3333-4333-8333-333333333333',
    contactId: '77777777-7777-4777-8777-777777777777',
    bindingVersion: 1,
  }),
  operator: Object.freeze({
    grantId: '44444444-4444-4444-8444-444444444444',
    role: 'member' as const,
    grantVersion: 1,
  }),
  session: Object.freeze({
    recordId: '55555555-5555-4555-8555-555555555555',
    audience: 'fleet' as const,
    assurance: 'oauth' as const,
    authnVersion: 1,
    authzVersion: 1,
    bindingVersion: 1,
    grantVersion: 1,
    policyVersion: 1,
    provider: 'discord' as const,
    providerSubjectId: '123456789012345678',
  }),
  authorization: Object.freeze({ action: 'companion.interact' as const, decision: 'allow' as const }),
  authority: Object.freeze({ authorityGeneration: 1, globalAuthEpoch: 1 }),
  provenance: Object.freeze({
    source: 'gateway_fleet_authorization_snapshot' as const,
    authorizationEventId: '66666666-6666-4666-8666-666666666666',
    resolvedAt: new Date().toISOString(),
  }),
}) satisfies FleetAuthorizationContext;

const hubPrincipal = Object.freeze({
  kind: 'hub_device' as const,
  issuer: 'satellite-hub',
  keyId: 'hub-key',
  deviceId: 'office-display',
  enrollmentVersion: 7,
  enrollmentAssurance: 'device_credential' as const,
  placeId: 'office',
  audience: 'https://fleet.example.test',
  companionId,
  sessionId: 'hub-session-1',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  jti: randomUUID(),
});
const attachment = Object.freeze({
  attachmentId: '88888888-8888-4888-8888-888888888888',
  disposition: 'created' as const,
  deviceActor: Object.freeze({ kind: 'hub_device' as const, principal: hubPrincipal, connectionId: 'connection-1' }),
  actor: Object.freeze({
    kind: 'human' as const,
    principalId,
    companionId,
    providerSubject: context.providerSubject,
    contact: context.contact,
    operator: context.operator,
    session: Object.freeze({
      recordId: context.session.recordId,
      authorityGeneration: context.authority.authorityGeneration,
      globalAuthEpoch: context.authority.globalAuthEpoch,
    }),
  }),
  channel: Object.freeze({ source: 'server' as const, id: `hub-device:${'a'.repeat(64)}`, companionId }),
});

function actionBody(resource = 'conversation.interact', action = 'companion.interact'): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    requestId: 'ui-request-1',
    action,
    resource,
    body: resource === 'confirmations.resolve'
      ? { id: 'confirmation-1', decision: 'deny' }
      : { content: 'browser text remains untrusted' },
  }));
}

function fixture(resolved = context) {
  const keys = generateKeyPairSync('ed25519');
  const signer = createGatewayRequestCapabilitySigner({
    issuer: 'fleet-auth', kid: 'active-key',
    privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ttlSeconds: 30,
  });
  const verifier = createRequestCapabilityVerifier({
    issuer: 'fleet-auth', maxTtlSeconds: 30,
    keys: [{
      issuer: 'fleet-auth', kid: 'active-key',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      notBefore: '2025-01-01T00:00:00.000Z',
      notAfter: '2030-01-01T00:00:00.000Z', status: 'active',
    }],
  });
  const childAssertions = new GatewayFleetAuthChildAssertionBroker({
    signer,
    verifier,
    replay: { consume: vi.fn(async input => ({ outcome: 'consumed', result: input.consumeResult })) },
    authority: {
      reauthorize: vi.fn(async input => ({
        decision: 'allow' as const,
        decisionId: randomUUID(),
        versions: input.parent.versions,
      })),
    },
  });
  const dispatch = { dispatch: vi.fn(async input => ({ targetDigest: input.compiled.target.targetDigest })) };
  const broker = new GatewayCompanionUiActionBroker({
    resolveAuthorizationContext: vi.fn(async () => resolved),
    signer,
    childAssertions,
    dispatch,
  });
  return { broker, dispatch, verifier };
}

describe('GatewayCompanionUiActionBroker', () => {
  it('resolves current human authority and dispatches only a linked agent child with sibling provenance', async () => {
    const built = fixture();
    await expect(built.broker.execute({
      rawBody: actionBody(),
      companionId,
      sessionToken: 's'.repeat(43),
      attachment,
      physicalCeiling: { capabilities: ['text'], telemetryScopes: [] },
      deviceTransport: {
        principal: { id: 'satellite-principal', mode: 'api_key', scope: 'satellite' },
        headers: {},
      },
    })).resolves.toHaveProperty('targetDigest');
    expect(built.dispatch.dispatch).toHaveBeenCalledOnce();
    const dispatched = built.dispatch.dispatch.mock.calls[0]![0];
    expect(dispatched.attachment.actor).toEqual(attachment.actor);
    expect(dispatched.attachment.deviceActor).toEqual(attachment.deviceActor);
    expect(dispatched).not.toHaveProperty('parentToken');
    const verifiedChild = built.verifier.verifyAgent({
      token: dispatched.childAssertion.token,
      target: dispatched.compiled.target,
      requestId: dispatched.childAssertion.requestId,
      decisionId: dispatched.childAssertion.decisionId,
      versions: dispatched.childAssertion.versions,
      parent: dispatched.childAssertion.parent,
    });
    expect(verifiedChild.authContext).toMatchObject({
      principalId,
      companionId,
      contactId: context.contact.contactId,
      role: context.operator.role,
      sessionRecordId: context.session.recordId,
    });
    expect(() => built.verifier.verifyOperator({
      token: dispatched.childAssertion.token,
      target: dispatched.compiled.target,
      requestId: dispatched.childAssertion.requestId,
      decisionId: dispatched.childAssertion.decisionId,
      versions: dispatched.childAssertion.versions,
    })).toThrow();
  });

  it('denies stale or switched human attachment before dispatch', async () => {
    const built = fixture(Object.freeze({
      ...context,
      authority: Object.freeze({ authorityGeneration: 2, globalAuthEpoch: 1 }),
    }));
    await expect(built.broker.execute({
      rawBody: actionBody(), companionId, sessionToken: 's'.repeat(43), attachment,
      physicalCeiling: { capabilities: ['text'], telemetryScopes: [] },
      deviceTransport: { principal: { id: 'satellite-principal', mode: 'api_key', scope: 'satellite' }, headers: {} },
    })).rejects.toBeInstanceOf(CompanionUiActionDeniedError);
    expect(built.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('denies guest approval even if an upstream resolver is misconfigured to allow it', async () => {
    const guestContext = Object.freeze({
      ...context,
      operator: Object.freeze({ ...context.operator, role: 'guest' as const }),
      authorization: Object.freeze({ action: 'confirmations.resolve' as const, decision: 'allow' as const }),
    });
    const guestAttachment = Object.freeze({
      ...attachment,
      actor: Object.freeze({ ...attachment.actor, operator: guestContext.operator }),
    });
    const built = fixture(guestContext);
    await expect(built.broker.execute({
      rawBody: actionBody('confirmations.resolve', 'confirmations.resolve'),
      companionId,
      sessionToken: 's'.repeat(43),
      attachment: guestAttachment,
      physicalCeiling: { capabilities: [], telemetryScopes: ['approvals'] },
      deviceTransport: { principal: { id: 'satellite-principal', mode: 'api_key', scope: 'satellite' }, headers: {} },
    })).rejects.toBeInstanceOf(CompanionUiActionDeniedError);
    expect(built.dispatch.dispatch).not.toHaveBeenCalled();
  });
});
