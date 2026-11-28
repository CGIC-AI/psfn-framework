import { describe, expect, it, vi } from 'vitest';
import { compileGatewayGardenRequestTarget } from '../../../boundary/fleet-auth/request-capability-target.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import {
  createGatewayFleetConfirmationClient,
  createGatewayOperatorConfirmationClient,
  GatewayOperatorConfirmationDeniedError,
  type FleetConfirmationParentCapability,
} from './gateway-operator-confirmation-client.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');

function fleetParent(): FleetConfirmationParentCapability {
  return {
    token: 'parent-token',
    target: compileGatewayGardenRequestTarget({
      rawTarget: '/api/admin/confirmations/resolve',
      method: 'POST',
      companionId: COMPANION_ID,
      body: Buffer.from(JSON.stringify({ id: 'fleet-approval', decision: 'approve' })),
    }),
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    versions: {
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      sessionAuthnVersion: 1,
      sessionAuthzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    },
  };
}

describe('createGatewayOperatorConfirmationClient', () => {
  it('uses the internal operator token after authenticated Garden admission', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'kube-approval',
      status: 'approved',
      message: 'Action approved and executed.',
      executed: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = createGatewayOperatorConfirmationClient(
      'http://psfn-gateway:10053/v1',
      {
        fetchImpl,
        operatorToken: 'internal-operator-token',
        requestTimeoutMs: 5_000,
      },
    );

    const result = await client.resolve({
      id: 'kube-approval',
      decision: 'approve',
    }, {
      kind: 'standalone_operator',
      authorization: 'Bearer garden-admin-token',
      cookie: 'garden-session=browser-credential',
    });

    expect(result).toMatchObject({ id: 'kube-approval', status: 'approved', executed: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://psfn-gateway:10053/v1/operator/confirmations/resolve');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: expect.objectContaining({
        Authorization: 'Bearer internal-operator-token',
        'Content-Type': 'application/json',
      }),
    });
    expect(init?.headers).not.toMatchObject({ Cookie: expect.any(String) });
    expect(JSON.parse(String(init?.body))).toEqual({
      id: 'kube-approval',
      decision: 'approve',
    });
  });

  it('fails closed without an authenticated Garden credential', async () => {
    const fetchImpl = vi.fn();
    const client = createGatewayOperatorConfirmationClient(
      'http://psfn-gateway:10053/v1',
      {
        fetchImpl,
        operatorToken: 'internal-operator-token',
        requestTimeoutMs: 5_000,
      },
    );

    await expect(client.resolve({
      id: 'kube-approval',
      decision: 'approve',
    }, { kind: 'standalone_operator' })).rejects.toThrow(
      'Authenticated Garden operator credentials are required',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects Fleet parent authority on the token client', async () => {
    const fetchImpl = vi.fn();
    const client = createGatewayOperatorConfirmationClient(
      'http://psfn-gateway:10053/v1',
      {
        fetchImpl,
        operatorToken: 'internal-operator-token',
        requestTimeoutMs: 5_000,
      },
    );

    await expect(client.resolve({ id: 'fleet-approval', decision: 'approve' }, {
      kind: 'fleet_principal',
      parent: fleetParent(),
    })).rejects.toThrow('Token confirmation routing accepts only standalone Garden operators');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when resolution params assert companion authority', async () => {
    const fetchImpl = vi.fn();
    const client = createGatewayOperatorConfirmationClient(
      'http://psfn-gateway:10053/v1',
      {
        fetchImpl,
        operatorToken: 'internal-operator-token',
        requestTimeoutMs: 5_000,
      },
    );
    const conflictingParams = {
      id: 'fleet-approval',
      decision: 'approve' as const,
      companionId: '22222222-2222-4222-8222-222222222222',
    };

    await expect(client.resolve(conflictingParams, {
      kind: 'standalone_operator',
      authorization: 'Bearer garden-admin-token',
    })).rejects.toThrow('Confirmation params cannot assert companion authority');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed without an internal operator token', () => {
    expect(() => createGatewayOperatorConfirmationClient(
      'http://psfn-gateway:10053/v1',
      { operatorToken: '', requestTimeoutMs: 5_000 },
    )).toThrow('Internal gateway operator token is required');
  });
});

describe('createGatewayFleetConfirmationClient', () => {
  it('presents the exact admitted parent without any gateway credential', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'fleet-approval',
      status: 'approved',
      message: 'Action approved and executed.',
      executed: true,
    }), { status: 200 }));
    const client = createGatewayFleetConfirmationClient('http://psfn-gateway:10053/v1', {
      fetchImpl,
      requestTimeoutMs: 5_000,
    });
    const parent = fleetParent();

    await expect(client.resolve({ id: 'fleet-approval', decision: 'approve' }, {
      kind: 'fleet_principal',
      parent,
    })).resolves.toMatchObject({ status: 'approved', executed: true });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://psfn-gateway:10053/v1/internal/fleet-auth/confirmations/resolve');
    expect(init?.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaVersion: 1,
      companionId: COMPANION_ID,
      parent: {
        token: 'parent-token',
        target: {
          rawTarget: '/api/admin/confirmations/resolve',
          method: 'POST',
          bodyBase64: parent.target.body.toString('base64url'),
          headers: null,
        },
        requestId: parent.requestId,
        decisionId: parent.decisionId,
        versions: parent.versions,
      },
    });
  });

  it('maps a gateway authority denial to a typed denial', async () => {
    const client = createGatewayFleetConfirmationClient('http://psfn-gateway:10053/v1', {
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({ error: 'confirmation_resolution_denied' }),
        { status: 403 },
      )),
      requestTimeoutMs: 5_000,
    });

    await expect(client.resolve({ id: 'fleet-approval', decision: 'approve' }, {
      kind: 'fleet_principal',
      parent: fleetParent(),
    })).rejects.toBeInstanceOf(GatewayOperatorConfirmationDeniedError);
  });

  it('rejects standalone authority and mismatched result ids', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'another-approval',
      status: 'approved',
      message: 'Action approved and executed.',
      executed: true,
    }), { status: 200 }));
    const client = createGatewayFleetConfirmationClient('http://psfn-gateway:10053/v1', {
      fetchImpl,
      requestTimeoutMs: 5_000,
    });

    await expect(client.resolve({ id: 'fleet-approval', decision: 'approve' }, {
      kind: 'standalone_operator',
      authorization: 'Bearer garden-admin-token',
    })).rejects.toThrow('Fleet confirmation routing requires an admitted Fleet Garden parent');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.resolve({ id: 'fleet-approval', decision: 'approve' }, {
      kind: 'fleet_principal',
      parent: fleetParent(),
    })).rejects.toThrow('Gateway operator confirmation response was invalid');
  });
});
