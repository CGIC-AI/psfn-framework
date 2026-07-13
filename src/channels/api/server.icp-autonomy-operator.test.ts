import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SessionManager } from '../../core/session/manager.js';
import { EventBus } from '../../shared/event-bus.js';
import { ApiServer } from './server.js';

const API_TOKEN = 'api-token';
const ADMIN_TOKEN = 'admin-token';
const COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
  companionId: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: `/v1/operator/icp-autonomy/companions/${companionId}/cancel`,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: body ? JSON.parse(body) as unknown : null,
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('ApiServer ICP autonomy operator lifecycle route', () => {
  let server: ApiServer | null = null;
  let port: number;

  beforeEach(async () => {
    port = await allocatePort();
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('requires ADMIN_TOKEN and reaches the gateway cancellation port', async () => {
    const cancelForCompanion = vi.fn(async () => 2);
    server = new ApiServer({
      port,
      host: '127.0.0.1',
      companionId: COMPANION_ID,
      agentLoop: { handleMessage: vi.fn() } as unknown as SubstrateAgent,
      eventBus: new EventBus(),
      sessionManager: { recordAssistantMessage: vi.fn() } as unknown as SessionManager,
      apiKey: API_TOKEN,
      adminToken: ADMIN_TOKEN,
      icpAutonomyOperator: { cancelForCompanion },
    });
    await server.start();

    await expect(request(port, COMPANION_ID, API_TOKEN)).resolves.toMatchObject({ status: 403 });
    expect(cancelForCompanion).not.toHaveBeenCalled();

    await expect(request(port, 'not-a-uuid', ADMIN_TOKEN)).resolves.toMatchObject({ status: 400 });
    await expect(request(port, COMPANION_ID, ADMIN_TOKEN)).resolves.toEqual({
      status: 200,
      body: { companionId: COMPANION_ID, revokedCount: 2 },
    });
    expect(cancelForCompanion).toHaveBeenCalledOnce();
    expect(cancelForCompanion).toHaveBeenCalledWith(COMPANION_ID);
  });

  it('returns 503 when the gateway did not configure ICP autonomy', async () => {
    server = new ApiServer({
      port,
      host: '127.0.0.1',
      companionId: COMPANION_ID,
      agentLoop: { handleMessage: vi.fn() } as unknown as SubstrateAgent,
      eventBus: new EventBus(),
      sessionManager: { recordAssistantMessage: vi.fn() } as unknown as SessionManager,
      apiKey: API_TOKEN,
      adminToken: ADMIN_TOKEN,
    });
    await server.start();

    await expect(request(port, COMPANION_ID, ADMIN_TOKEN)).resolves.toEqual({
      status: 503,
      body: {
        error: {
          type: 'icp_autonomy_not_configured',
          message: 'ICP autonomy lifecycle control is not configured',
          code: null,
          param: null,
        },
      },
    });
  });
});
