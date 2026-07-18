import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { FleetGardenTargetRegistry } from './fleet-garden-target-registry.js';
import { FleetGardenAdminTransportProxy } from './fleet-transport-client.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');

function request(): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.url = '/companions/ignored/garden/api/admin/dashboard';
  req.method = 'GET';
  req.headers = {};
  return req;
}

function response(): {
  res: ServerResponse;
  completed: Promise<{ status: number; body: string }>;
} {
  let status = 0;
  let finish!: (result: { status: number; body: string }) => void;
  const completed = new Promise<{ status: number; body: string }>((resolve) => {
    finish = resolve;
  });
  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(nextStatus: number) {
      status = nextStatus;
      this.headersSent = true;
      return this;
    },
    end(body: string) {
      this.writableEnded = true;
      finish({ status, body });
      return this;
    },
  } as unknown as ServerResponse;
  return { res, completed };
}

describe('FleetGardenAdminTransportProxy', () => {
  it('returns an authenticated 503 for the selected outage without trying another target', async () => {
    const registry = new FleetGardenTargetRegistry([
      {
        companionId: COMPANION_A,
        endpoint: {
          mode: 'socket',
          socketPath: '/tmp/psfn-missing-admin-a.sock',
          timeoutMs: 100,
        },
      },
      {
        companionId: COMPANION_B,
        endpoint: {
          mode: 'socket',
          socketPath: '/tmp/psfn-missing-admin-b.sock',
          timeoutMs: 100,
        },
      },
    ]);
    registry.reportHealth(COMPANION_A, {
      status: 'unavailable',
      probedAt: '2030-01-01T00:00:00.000Z',
      reason: 'offline',
    });
    registry.reportHealth(COMPANION_B, {
      status: 'ready',
      probedAt: '2030-01-01T00:00:00.000Z',
    });
    const transport = new FleetGardenAdminTransportProxy(registry);
    const selected = registry.resolve(COMPANION_A);
    const { res, completed } = response();

    transport.proxyBufferedApiRequest(
      selected,
      request(),
      res,
      Buffer.alloc(0),
      {},
      '/api/admin/dashboard',
    );

    await expect(completed).resolves.toEqual({
      status: 503,
      body: 'Service Unavailable: admin transport unavailable',
    });
    expect(registry.resolve(COMPANION_A)).toBe(selected);
    expect(registry.resolve(COMPANION_B).endpoint).toMatchObject({
      socketPath: '/tmp/psfn-missing-admin-b.sock',
    });
  });

  it('rejects reconstructed target data instead of selecting by copied companion ID', () => {
    const registry = new FleetGardenTargetRegistry([{
      companionId: COMPANION_A,
      endpoint: {
        mode: 'socket',
        socketPath: '/tmp/psfn-missing-admin-a.sock',
        timeoutMs: 100,
      },
    }]);
    const transport = new FleetGardenAdminTransportProxy(registry);
    const admitted = registry.resolve(COMPANION_A);
    const reconstructed = { ...admitted };

    expect(() => transport.proxyBufferedApiRequest(
      reconstructed,
      request(),
      response().res,
      Buffer.alloc(0),
      {},
      '/api/admin/dashboard',
    )).toThrow('does not match the immutable registry');
  });
});
