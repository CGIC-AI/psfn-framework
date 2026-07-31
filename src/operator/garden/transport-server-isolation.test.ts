import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

const listener = vi.hoisted(() => ({
  accepting: false,
  handler: null as ((req: IncomingMessage, res: ServerResponse) => void) | null,
  upgradeHandler: null as ((
    req: IncomingMessage,
    socket: { destroy: () => void; write: (chunk: string) => void },
    head: Buffer,
  ) => void) | null,
}));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn((handler: (req: IncomingMessage, res: ServerResponse) => void) => {
      listener.handler = handler;
      return {
        on: vi.fn((event: string, callback: typeof listener.upgradeHandler) => {
          if (event === 'upgrade') listener.upgradeHandler = callback;
        }),
        once: vi.fn(),
        off: vi.fn(),
        listen: vi.fn((...args: unknown[]) => {
          listener.accepting = true;
          const onListening = args.at(-1);
          if (typeof onListening === 'function') onListening();
        }),
        close: vi.fn((callback: (error?: Error) => void) => {
          listener.accepting = false;
          callback();
        }),
        closeAllConnections: vi.fn(),
      };
    }),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: vi.fn(),
  };
});

import { EventBus } from '../../shared/event-bus.js';
import { GardenAdminTransportServer } from './transport-server.js';

function responseRecorder(): {
  response: ServerResponse;
  result: { status: number | null; body: string };
} {
  const result = { status: null as number | null, body: '' };
  const response = {
    writeHead: (status: number) => {
      result.status = status;
      return response;
    },
    end: (body?: string) => {
      result.body = body ?? '';
      return response;
    },
  } as unknown as ServerResponse;
  return { response, result };
}

describe('Garden admin control-plane isolation', () => {
  it('keeps accepting capability reads after runtime readiness is withdrawn', async () => {
    const transport = new GardenAdminTransportServer({
      endpoint: {
        mode: 'socket',
        socketPath: '/tmp/psfn-in-memory-admin-transport.sock',
        timeoutMs: 1_000,
      },
      eventBus: new EventBus(),
      config: {} as never,
      services: {
        auditHistory: { appendGardenEntry: vi.fn() },
        settings: {
          getSubConfigJson: vi.fn((key: string) => (
            key === 'capabilities'
              ? JSON.stringify({ tier: 'nursery', customTokens: [] })
              : null
          )),
        },
      } as never,
    });
    await transport.init();
    await transport.start();
    transport.markRuntimeReady();

    transport.withdrawReadiness();

    expect(listener.accepting).toBe(true);
    const { response, result } = responseRecorder();
    listener.handler?.({
      method: 'GET',
      url: '/api/admin/settings/capabilities',
      headers: {},
      socket: {},
    } as IncomingMessage, response);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ tier: 'nursery', customTokens: [] });

    const unrelated = responseRecorder();
    listener.handler?.({
      method: 'GET',
      url: '/api/admin/dashboard',
      headers: {},
      socket: {},
    } as IncomingMessage, unrelated.response);
    expect(unrelated.result.status).toBe(503);
    expect(JSON.parse(unrelated.result.body)).toEqual({
      error: 'Agent runtime unavailable; only capability-tier recovery is admitted',
    });

    const websocketSocket = {
      destroy: vi.fn(),
      write: vi.fn(),
    };
    listener.upgradeHandler?.({
      method: 'GET',
      url: '/api/admin/events',
      headers: {},
      socket: {},
    } as IncomingMessage, websocketSocket, Buffer.alloc(0));
    expect(websocketSocket.write).toHaveBeenCalledWith(
      'HTTP/1.1 503 Service Unavailable\r\n\r\n',
    );
    expect(websocketSocket.destroy).toHaveBeenCalledOnce();

    await transport.stop();
    expect(listener.accepting).toBe(false);
  });
});
