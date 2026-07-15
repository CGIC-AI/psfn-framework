import { describe, expect, it, vi } from 'vitest';
import { createGatewayOperatorConfirmationClient } from './gateway-operator-confirmation-client.js';

describe('createGatewayOperatorConfirmationClient', () => {
  it('forwards only the authenticated Garden credential to the bounded operator endpoint', async () => {
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
      { fetchImpl },
    );

    const result = await client.resolve({
      id: 'kube-approval',
      decision: 'approve',
    }, {
      authorization: 'Bearer garden-admin-token',
    });

    expect(result).toMatchObject({ id: 'kube-approval', status: 'approved', executed: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://psfn-gateway:10053/v1/operator/confirmations/resolve');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: expect.objectContaining({
        Authorization: 'Bearer garden-admin-token',
        'Content-Type': 'application/json',
      }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      id: 'kube-approval',
      decision: 'approve',
    });
  });

  it('fails closed without an authenticated Garden credential', async () => {
    const fetchImpl = vi.fn();
    const client = createGatewayOperatorConfirmationClient(
      'http://psfn-gateway:10053/v1',
      { fetchImpl },
    );

    await expect(client.resolve({
      id: 'kube-approval',
      decision: 'approve',
    }, {})).rejects.toThrow('Authenticated Garden operator credentials are required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
