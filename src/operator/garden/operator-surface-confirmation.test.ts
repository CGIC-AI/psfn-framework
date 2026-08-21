import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { resetRuntimeTrustPolicy } from '../../system/trust/runtime-policy.js';
import { GardenOperatorSurface } from './operator-surface.js';
import type { GardenAdminTransportSocketEndpoint } from './transport-paths.js';
import type { GatewayOperatorConfirmationClient } from '../../app/startup/support/gateway-operator-confirmation-client.js';
import type { ConfirmationResolveResult } from '../../system/capabilities/confirmation-queue.js';

/**
 * x5rt.10 regression coverage: the operator ADMIN_TOKEN must never reach the
 * agent, operator-owned confirmations resolve on a direct operator → gateway
 * path, and agent-local confirmations still resolve with the credential
 * stripped.
 */

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface CaptureUpstream {
  server: http.Server;
  requests: CapturedRequest[];
}

function startCaptureUpstream(socketPath: string): Promise<CaptureUpstream> {
  const requests: CapturedRequest[] = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          status: 'approved',
          executed: true,
          message: 'agent-local resolved',
          receivedAuthorization: req.headers.authorization ?? null,
          receivedCookie: req.headers.cookie ?? null,
        }));
      });
    });
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve({ server, requests });
    });
  });
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = address;
      probe.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

function requestPort(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function socketEndpoint(socketPath: string): GardenAdminTransportSocketEndpoint {
  return { mode: 'socket', socketPath, timeoutMs: 2_000 };
}

function minimalConfig(): SubstrateConfig {
  return { companionId: 'test-companion' } as unknown as SubstrateConfig;
}

interface Harness {
  tempDir: string;
  upstream: CaptureUpstream;
  surface: GardenOperatorSurface;
  port: number;
}

const harnesses: Harness[] = [];

async function createHarness(
  resolver?: GatewayOperatorConfirmationClient,
): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'operator-confirmation-test-'));
  const socketPath = join(tempDir, 'agent-admin.sock');
  const upstream = await startCaptureUpstream(socketPath);
  const port = await allocatePort();
  const surface = new GardenOperatorSurface({
    port,
    host: '127.0.0.1',
    allowInsecureWithoutToken: true,
    config: minimalConfig(),
    transportEndpoint: socketEndpoint(socketPath),
    ...(resolver ? { operatorConfirmationResolver: resolver } : {}),
  });
  await surface.init();
  await surface.start();
  const harness: Harness = { tempDir, upstream, surface, port };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    await harness.surface.stop();
    await new Promise<void>((resolve) => {
      harness.upstream.server.closeAllConnections();
      harness.upstream.server.close(() => resolve());
    });
    rmSync(harness.tempDir, { recursive: true, force: true });
  }
  resetRuntimeTrustPolicy();
});

function mockResolver(result: ConfirmationResolveResult): GatewayOperatorConfirmationClient {
  return { resolve: vi.fn(async () => result) };
}

describe('Garden operator confirmation resolution (x5rt.10)', () => {
  it('strips the operator ADMIN_TOKEN from every request proxied to the agent', async () => {
    const harness = await createHarness();
    const res = await requestPort(harness.port, 'GET', '/api/admin/dashboard', undefined, {
      authorization: 'Bearer super-secret-admin-token',
      cookie: 'psfn_token=super-secret-admin-token; psfn_garden_session=browser-123',
    });
    expect(res.status).toBe(200);

    expect(harness.upstream.requests).toHaveLength(1);
    const captured = harness.upstream.requests[0]!;
    // The admin credential must never reach the agent transport.
    expect(captured.headers.authorization).toBeUndefined();
    expect(captured.headers.cookie ?? '').not.toContain('psfn_token');
    // Non-credential cookies (browser session keying) survive.
    expect(captured.headers.cookie).toContain('psfn_garden_session=browser-123');
  });

  it('resolves an operator-owned confirmation on the direct operator→gateway path without touching the agent', async () => {
    const resolver = mockResolver({
      id: 'kube-1',
      status: 'approved',
      message: 'kube rollout approved',
      executed: true,
    });
    const harness = await createHarness(resolver);

    const res = await requestPort(
      harness.port,
      'POST',
      '/api/admin/confirmations/resolve',
      JSON.stringify({ id: 'kube-1', decision: 'approve' }),
      {
        'content-type': 'application/json',
        authorization: 'Bearer super-secret-admin-token',
        cookie: 'psfn_token=super-secret-admin-token',
      },
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      message: 'kube rollout approved',
      status: 'approved',
      executed: true,
    });
    // The gateway resolver received the operator credential directly.
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(resolver.resolve).toHaveBeenCalledWith(
      { id: 'kube-1', decision: 'approve' },
      {
        kind: 'standalone_operator',
        authorization: 'Bearer super-secret-admin-token',
        cookie: 'psfn_token=super-secret-admin-token',
      },
    );
    // The agent (upstream) was never asked to resolve an operator-owned entry.
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('reports an operator denial as a successful terminal queue decision', async () => {
    const resolver = mockResolver({
      id: 'kube-deny-1',
      status: 'denied',
      message: 'Denied by operator.',
      executed: false,
    });
    const harness = await createHarness(resolver);

    const res = await requestPort(
      harness.port,
      'POST',
      '/api/admin/confirmations/resolve',
      JSON.stringify({ id: 'kube-deny-1', decision: 'deny' }),
      { 'content-type': 'application/json', authorization: 'Bearer operator-token' },
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      message: 'Denied by operator.',
      status: 'denied',
      executed: false,
    });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('falls back to agent-local resolution (credential stripped) when the gateway reports not_found', async () => {
    const resolver = mockResolver({
      id: 'card-1',
      status: 'not_found',
      message: 'Confirmation request not found.',
      executed: false,
    });
    const harness = await createHarness(resolver);

    const res = await requestPort(
      harness.port,
      'POST',
      '/api/admin/confirmations/resolve',
      JSON.stringify({ id: 'card-1', decision: 'approve' }),
      {
        'content-type': 'application/json',
        authorization: 'Bearer super-secret-admin-token',
        cookie: 'psfn_token=super-secret-admin-token',
      },
    );

    expect(res.status).toBe(200);
    // The agent resolved the local entry, and its credential was stripped.
    expect(harness.upstream.requests).toHaveLength(1);
    const captured = harness.upstream.requests[0]!;
    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('/api/admin/confirmations/resolve');
    expect(captured.body).toBe(JSON.stringify({ id: 'card-1', decision: 'approve' }));
    expect(captured.headers.authorization).toBeUndefined();
    expect(captured.headers.cookie ?? '').not.toContain('psfn_token');
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, status: 'approved' });
  });

  it('rejects malformed confirmation payloads before any resolution', async () => {
    const resolver = mockResolver({ id: 'x', status: 'approved', message: 'ok', executed: true });
    const harness = await createHarness(resolver);

    const res = await requestPort(
      harness.port,
      'POST',
      '/api/admin/confirmations/resolve',
      JSON.stringify({ id: 'x', decision: 'launch' }),
      { 'content-type': 'application/json', authorization: 'Bearer t' },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('without an operator credential, never calls the gateway and resolves only agent-local entries', async () => {
    const resolver = mockResolver({ id: 'y', status: 'approved', message: 'ok', executed: true });
    const harness = await createHarness(resolver);

    const res = await requestPort(
      harness.port,
      'POST',
      '/api/admin/confirmations/resolve',
      JSON.stringify({ id: 'y', decision: 'approve' }),
      { 'content-type': 'application/json' },
    );

    expect(res.status).toBe(200);
    // No credential present → operator-only entries stay pending (fail closed);
    // the request is handled entirely by the agent-local path.
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(harness.upstream.requests).toHaveLength(1);
  });
});
