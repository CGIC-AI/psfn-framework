import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { FleetGardenTargetRegistry } from './fleet-garden-target-registry.js';
import {
  FleetGardenAdminTransportProxy,
  type FleetGardenModelUsageAuthority,
} from './fleet-transport-client.js';
import {
  FLEET_MODEL_USAGE_INTERNAL_HEADER,
  FLEET_MODEL_USAGE_PARENT_COMPANION_HEADER,
  FLEET_MODEL_USAGE_PARENT_TARGET_HEADER,
} from './transport-client.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');

const MODEL_USAGE_AUTHORITY: FleetGardenModelUsageAuthority = {
  authorizedCompanionIds: [COMPANION_A],
  modelUsageRequestTarget:
    '/api/admin/model-usage?range=custom&timezone=UTC&sinceMs=0&untilMs=3600000&bucket=hour&limit=1&topN=100&groupBy=model',
  token: 'signed-fleet-authority',
  context: {
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
  },
  parentCompanionId: COMPANION_A,
  parentRequestTarget: '/api/admin/fleet-model-usage?range=week',
};

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
  it('reads model usage from the exact target over the bounded internal transport seam', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'psfn-fleet-model-usage-'));
    const socketPath = join(scratch, 'admin.sock');
    const requestPath = '/api/admin/model-usage?range=custom&timezone=UTC&sinceMs=0&untilMs=3600000&bucket=hour&limit=1&topN=100&groupBy=model';
    const server = createServer((req, res) => {
      expect(req.url).toBe(requestPath);
      expect(req.headers[FLEET_MODEL_USAGE_INTERNAL_HEADER]).toBe('1');
      expect(req.headers[FLEET_MODEL_USAGE_PARENT_COMPANION_HEADER]).toBe(COMPANION_A);
      expect(req.headers[FLEET_MODEL_USAGE_PARENT_TARGET_HEADER])
        .toBe('/api/admin/fleet-model-usage?range=week');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const registry = new FleetGardenTargetRegistry([{
      companionId: COMPANION_A,
      endpoint: { mode: 'socket', socketPath, timeoutMs: 1_000 },
    }]);
    const transport = new FleetGardenAdminTransportProxy(registry);

    try {
      await expect(transport.requestModelUsage(
        registry.resolve(COMPANION_A),
        requestPath,
        MODEL_USAGE_AUTHORITY,
      )).resolves.toEqual({ ok: true });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  });

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
