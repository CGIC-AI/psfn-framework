import { describe, expect, it, vi } from 'vitest';
import { createGatewayOperatorConfirmationClient } from './gateway-operator-confirmation-client.js';

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

  it('fails closed with incomplete Fleet admission evidence', async () => {
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
    }, {
      kind: 'fleet_principal',
      companionId: '',
      requestId: 'request-1',
      decisionId: 'decision-1',
    })).rejects.toThrow('Admitted Fleet Garden authority is required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serializes the admitted Fleet companion as resolution authority', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'fleet-approval',
      status: 'approved',
      message: 'Action approved and executed.',
      executed: true,
    }), { status: 200 }));
    const client = createGatewayOperatorConfirmationClient(
      'http://psfn-gateway:10053/v1',
      {
        fetchImpl,
        operatorToken: 'internal-operator-token',
        requestTimeoutMs: 5_000,
      },
    );

    await client.resolve({
      id: 'fleet-approval',
      decision: 'approve',
    }, {
      kind: 'fleet_principal',
      companionId: '11111111-1111-4111-8111-111111111111',
      requestId: 'request-1',
      decisionId: 'decision-1',
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      id: 'fleet-approval',
      decision: 'approve',
      companionId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('fails closed when resolution params conflict with admitted companion authority', async () => {
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
      kind: 'fleet_principal',
      companionId: '11111111-1111-4111-8111-111111111111',
      requestId: 'request-1',
      decisionId: 'decision-1',
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
