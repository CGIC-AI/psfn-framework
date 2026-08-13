import http from 'node:http';
import net from 'node:net';
import { fromAny } from '@total-typescript/shoehorn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SessionManager } from '../../core/session/manager.js';
import { EventBus } from '../../shared/event-bus.js';
import { ApiServer } from './server.js';

const API_TOKEN = 'api-token';
const ADMIN_TOKEN = 'admin-token';
const TEST_COMPANION_ID = '11111111-1111-4111-8111-111111111111';

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') {
        listener.close(() => reject(new Error('Failed to allocate test port')));
        return;
      }
      listener.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function request(
  port: number,
  token: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const encodedBody = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/operator/confirmations/resolve',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(encodedBody),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += String(chunk); });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: responseBody ? JSON.parse(responseBody) as unknown : null,
      }));
    });
    req.once('error', reject);
    req.end(encodedBody);
  });
}

describe('ApiServer operator confirmation route', () => {
  let server: ApiServer | null = null;
  let port: number;

  beforeEach(async () => {
    port = await allocatePort();
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('requires ADMIN_TOKEN before invoking the operator resolver', async () => {
    const resolve = vi.fn(async (params) => ({
      id: params.id,
      status: 'approved' as const,
      message: 'Action approved and executed.',
      executed: true,
    }));
    server = new ApiServer({
      port,
      host: '127.0.0.1',
      companionId: TEST_COMPANION_ID,
      agentLoop: { handleMessage: vi.fn() } as unknown as SubstrateAgent,
      eventBus: new EventBus(),
      sessionManager: { recordAssistantMessage: vi.fn() } as unknown as SessionManager,
      apiKey: API_TOKEN,
      adminToken: ADMIN_TOKEN,
      confirmationOperator: { resolve },
    });
    await server.start();

    await expect(request(port, API_TOKEN, {
      id: 'kube-approval',
      decision: 'approve',
    })).resolves.toMatchObject({ status: 403 });
    expect(resolve).not.toHaveBeenCalled();

    await expect(request(port, ADMIN_TOKEN, {
      id: 'kube-approval',
      decision: 'approve',
    })).resolves.toEqual({
      status: 200,
      body: {
        id: 'kube-approval',
        status: 'approved',
        message: 'Action approved and executed.',
        executed: true,
      },
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      id: 'kube-approval',
      decision: 'approve',
    });
  });

  it('rejects malformed resolution bodies before invoking the operator resolver', async () => {
    const resolve = vi.fn();
    server = new ApiServer({
      port,
      host: '127.0.0.1',
      companionId: TEST_COMPANION_ID,
      agentLoop: { handleMessage: vi.fn() } as unknown as SubstrateAgent,
      eventBus: new EventBus(),
      sessionManager: { recordAssistantMessage: vi.fn() } as unknown as SessionManager,
      apiKey: API_TOKEN,
      adminToken: ADMIN_TOKEN,
      confirmationOperator: { resolve },
    });
    await server.start();

    await expect(request(port, ADMIN_TOKEN, {
      id: 'kube-approval',
      decision: 'modify',
    })).resolves.toMatchObject({ status: 400 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps the ADMIN_TOKEN operator resolver reachable in fleet bootstrap mode', async () => {
    const resolve = vi.fn(async (params) => ({
      id: params.id,
      status: 'approved' as const,
      message: 'Fleet confirmation approved.',
      executed: true,
    }));
    server = new ApiServer({
      port,
      host: '127.0.0.1',
      companionId: TEST_COMPANION_ID,
      agentLoop: { handleMessage: vi.fn() } as unknown as SubstrateAgent,
      eventBus: new EventBus(),
      sessionManager: { recordAssistantMessage: vi.fn() } as unknown as SessionManager,
      apiKey: API_TOKEN,
      adminToken: ADMIN_TOKEN,
      confirmationOperator: { resolve },
      fleetAuthBootstrapOnly: true,
      fleetAuthHttpRoutes: fromAny({
        applyLifecycleCorsPolicy: () => 'not_applicable',
        matches: () => false,
        handle: vi.fn(),
      }),
    });
    await server.start();

    await expect(request(port, ADMIN_TOKEN, {
      id: 'fleet-memory-approval',
      decision: 'approve',
    })).resolves.toMatchObject({
      status: 200,
      body: { id: 'fleet-memory-approval', status: 'approved', executed: true },
    });
    expect(resolve).toHaveBeenCalledOnce();
  });
});
