import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/shared/event-bus.js';
import { WyomingFrameCodec } from '../protocol/codec.js';
import { WyomingTcpServer } from './server.js';
import { WyomingServerError, type WyomingServerCloseReason, type WyomingTransportSession } from '../protocol/index.js';

interface RunningServer {
  server: WyomingTcpServer;
  port: number;
}

const activeServers: WyomingTcpServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.map((server) => server.stop()));
  activeServers.length = 0;
});

describe('WyomingTcpServer', () => {
  it('accepts valid frames and forwards them to onFrame', async () => {
    const onFrame = vi.fn();
    const running = await createRunningServer({
      idleTimeoutMs: 5_000,
    }, { onFrame });

    const socket = await connectClient(running.port);
    const codec = new WyomingFrameCodec();
    socket.write(codec.encode({ type: 'describe' }));

    await waitFor(() => onFrame.mock.calls.length === 1);
    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: expect.any(String) }),
      expect.objectContaining({ type: 'describe' }),
    );

    socket.destroy();
  });

  it('closes malformed frames with decode_error reason', async () => {
    const onSessionClose = vi.fn();
    const running = await createRunningServer({
      idleTimeoutMs: 5_000,
    }, { onSessionClose });

    const socket = await connectClient(running.port);
    socket.write(Buffer.from('type describe\n\n', 'utf8'));

    await waitFor(() => onSessionClose.mock.calls.length === 1);
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: expect.any(String) }),
      'decode_error',
    );

    socket.destroy();
  });

  it('enforces max write queue guard and closes connection with backpressure', async () => {
    let openedSession: WyomingTransportSession | undefined;
    const onSessionClose = vi.fn();

    const running = await createRunningServer({
      idleTimeoutMs: 5_000,
      maxWriteQueueBytes: 32,
    }, {
      onSessionOpen: (session) => {
        openedSession = session;
      },
      onSessionClose,
    });

    const socket = await connectClient(running.port);
    await waitFor(() => openedSession !== undefined);

    await expect(running.server.send(openedSession as WyomingTransportSession, {
      type: 'info',
      data: {
        name: 'psfn-wyoming',
        version: '1.0.0',
        services: [],
      },
    })).rejects.toEqual(expect.objectContaining<Partial<WyomingServerError>>({
      code: 'WRITE_QUEUE_OVERFLOW',
    }));

    await waitFor(() => onSessionClose.mock.calls.length === 1);
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: (openedSession as WyomingTransportSession).connectionId }),
      'backpressure',
    );

    socket.destroy();
  });

  it('emits Wyoming connection telemetry and audit summaries on open/close', async () => {
    const eventBus = new EventBus();
    const opens: string[] = [];
    const closes: string[] = [];
    const summaries: Array<{ method: string; decision: string }> = [];

    eventBus.on('wyoming.connection.open', (event) => {
      opens.push(event.connectionId);
    });
    eventBus.on('wyoming.connection.close', (event) => {
      closes.push(event.reason);
    });

    const running = await createRunningServer({
      idleTimeoutMs: 5_000,
      eventBus,
      onAuditSummary: (summary) => {
        summaries.push({ method: summary.method, decision: summary.decision });
      },
    }, {});

    const socket = await connectClient(running.port);
    await waitFor(() => opens.length === 1);
    socket.destroy();
    await waitFor(() => closes.length === 1);

    expect(summaries).toEqual(expect.arrayContaining([
      { method: 'wyoming.connection.open', decision: 'ALLOW' },
      expect.objectContaining({ method: 'wyoming.connection.close' }),
    ]));
  });

  it('enforces read frame rate limits with explicit error code and rate_limited close reason', async () => {
    const onConnectionError = vi.fn();
    const onSessionClose = vi.fn();
    const running = await createRunningServer({
      idleTimeoutMs: 5_000,
      maxFramesPerWindow: 1,
      frameRateWindowMs: 60_000,
    }, {
      onConnectionError,
      onSessionClose,
    });

    const socket = await connectClient(running.port);
    const codec = new WyomingFrameCodec();
    socket.write(Buffer.concat([
      codec.encode({ type: 'describe' }),
      codec.encode({ type: 'ping' }),
    ]));

    await waitFor(() => onConnectionError.mock.calls.length === 1);
    expect(onConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: expect.any(String) }),
      expect.objectContaining<Partial<WyomingServerError>>({ code: 'READ_RATE_LIMIT_EXCEEDED' }),
    );

    await waitFor(() => onSessionClose.mock.calls.length === 1);
    expect(onSessionClose).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: expect.any(String) }),
      'rate_limited',
    );

    socket.destroy();
  });
});

async function createRunningServer(
  options: {
    idleTimeoutMs: number;
    maxWriteQueueBytes?: number;
    maxFramesPerWindow?: number;
    frameRateWindowMs?: number;
    eventBus?: EventBus;
    onAuditSummary?: (summary: { method: string; decision: string }) => void;
  },
  hooks: {
    onFrame?: (session: WyomingTransportSession, frame: unknown) => void | Promise<void>;
    onSessionOpen?: (session: WyomingTransportSession) => void | Promise<void>;
    onSessionClose?: (session: WyomingTransportSession, reason: WyomingServerCloseReason) => void | Promise<void>;
    onConnectionError?: (session: WyomingTransportSession, error: Error) => void | Promise<void>;
  },
): Promise<RunningServer> {
  const port = await allocatePort();
  const server = new WyomingTcpServer({
    host: '127.0.0.1',
    port,
    idleTimeoutMs: options.idleTimeoutMs,
    maxWriteQueueBytes: options.maxWriteQueueBytes,
    maxFramesPerWindow: options.maxFramesPerWindow,
    frameRateWindowMs: options.frameRateWindowMs,
    eventBus: options.eventBus,
    onAuditSummary: options.onAuditSummary,
  }, hooks);

  await server.start();
  activeServers.push(server);

  return { server, port };
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      reject(error);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve ephemeral port'));
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
  });
}

async function connectClient(port: number): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => resolve(socket));
    socket.once('error', (error) => reject(error));
  });
}

async function waitFor(condition: () => boolean, maxAttempts = 60): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error('Condition not met within wait window');
}
