import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { ApiServer } from './server.js';

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate test port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('ApiServer sensor ingest wiring', () => {
  let server: ApiServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('routes telemetry ingestion through the configured sensor ingest port', async () => {
    const port = await allocatePort();
    const eventBus = new EventBus();
    const sensorIngest = {
      ingestTelemetry: vi.fn(async (event: any) => ({
        id: event.id,
        acceptedEventType: event.eventType,
        event,
      })),
    };
    server = new ApiServer({
      port,
      companionId: 'test-companion',
      agentLoop: {} as any,
      eventBus,
      sessionManager: {} as any,
      apiKey: 'test-secret-key',
      sensorIngest,
    });
    await server.init();
    await server.start();

    const res = await request(port, 'POST', '/v1/telemetry/ingest', {
      source: 'sensor-a',
      eventType: 'external.telemetry.status',
      timestamp: new Date().toISOString(),
      nonce: 'nonce-telemetry-port',
      payload: { status: 'green' },
      channelId: 'ops-room',
      scope: 'cluster-a',
    }, {
      Authorization: 'Bearer test-secret-key',
    });

    expect(res.status).toBe(202);
    expect(sensorIngest.ingestTelemetry).toHaveBeenCalledTimes(1);
    expect(sensorIngest.ingestTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      source: 'sensor-a',
      eventType: 'external.telemetry.status',
      payload: { status: 'green' },
      channelId: 'ops-room',
      scope: 'cluster-a',
      nonce: 'nonce-telemetry-port',
    }));
  });
});
