import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseChildAssertionExchangeRequest } from './fleet-auth-child-assertion-route.js';

const companionId = '11111111-1111-4111-8111-111111111111';
const versions = {
  authorityGeneration: 2,
  globalAuthEpoch: 3,
  sessionAuthnVersion: 5,
  sessionAuthzVersion: 7,
  bindingVersion: 11,
  grantVersion: 13,
  policyVersion: 17,
};

function wireRequest() {
  return {
    schemaVersion: 1,
    companionId,
    parent: {
      token: 'signed-parent',
      target: {
        rawTarget: '/api/admin/images/generated?q=cat',
        method: 'GET',
        bodyBase64: '',
        headers: null,
      },
      requestId: randomUUID(),
      decisionId: randomUUID(),
      versions,
    },
    child: {
      target: {
        rawTarget: '/api/admin/images/generated/image-a',
        method: 'PATCH',
        bodyBase64: Buffer.from('{"favorite":true}').toString('base64url'),
        headers: { 'content-type': 'application/json' },
      },
      requestId: randomUUID(),
    },
  };
}

describe('fleet auth child assertion transport', () => {
  it('recompiles bounded wire targets and derives operator identity from the companion binding', () => {
    const wire = wireRequest();
    const parsed = parseChildAssertionExchangeRequest(wire);

    expect(parsed).toMatchObject({
      operator: {
        kind: 'operator_process',
        operatorId: `operator:${companionId}`,
        companionId,
      },
      parent: {
        token: 'signed-parent',
        requestId: wire.parent.requestId,
        decisionId: wire.parent.decisionId,
      },
      child: { requestId: wire.child.requestId },
    });
    expect(parsed.parent.target.bodyLength).toBe(0);
    expect(parsed.child.target.body).toEqual(Buffer.from('{"favorite":true}'));
  });

  it('derives a testing-harness control identity from the normalized provider audience', () => {
    const wire = {
      ...wireRequest(),
      providerIdentity: {
        provider: 'testing_harness',
        audience: 'testing-harness',
      },
    };

    expect(parseChildAssertionExchangeRequest(wire)).toMatchObject({
      operator: {
        kind: 'testing_harness_provider',
        provider: 'testing_harness',
        audience: 'testing-harness',
        companionId,
      },
    });
  });

  it.each([
    ['query', (wire: ReturnType<typeof wireRequest>) => {
      wire.child.target.rawTarget = '/api/admin/images/generated/image-a?capability=forged';
    }],
    ['header', (wire: ReturnType<typeof wireRequest>) => {
      Object.assign(wire.child.target.headers, { 'x-psfn-request-capability': 'forged' });
    }],
  ])('rejects embedded browser %s authority before exchange', (_label, mutate) => {
    const wire = wireRequest();
    mutate(wire);
    expect(() => parseChildAssertionExchangeRequest(wire)).toThrow(/authority/u);
  });

  it('rejects noncanonical or oversized wire data', () => {
    const wire = wireRequest();
    wire.child.target.bodyBase64 = '=';
    expect(() => parseChildAssertionExchangeRequest(wire)).toThrow(/target body/u);
  });
});
