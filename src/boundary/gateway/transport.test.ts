import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { describe, it, expect } from 'vitest';
import {
  createSocketClient,
  createSocketServer,
  NdjsonFramingError,
  type NdjsonConnection,
} from './transport.js';

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await sleep(10);
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('createSocketClient lifecycle', () => {
  it('keeps a single live connection after successful connect (no reconnect storm)', async () => {
    const socketPath = join(tmpdir(), `psfn-transport-${randomUUID()}.sock`);
    let accepts = 0;
    let lastConn: NdjsonConnection | null = null;

    const server = createSocketServer(socketPath, (conn) => {
      accepts += 1;
      lastConn = conn;
    });

    const client = await createSocketClient({
      socketPath,
      reconnect: true,
      reconnectDelayMs: 20,
      maxReconnectAttempts: 5,
    });

    expect(accepts).toBe(1);
    lastConn?.destroy();
    await sleep(200);
    expect(accepts).toBe(1);

    client.destroy();
    await closeServer(server);
  });

  it('retries during startup race until the server is available', async () => {
    const socketPath = join(tmpdir(), `psfn-transport-${randomUUID()}.sock`);
    let accepted = false;

    const clientPromise = createSocketClient({
      socketPath,
      reconnect: true,
      reconnectDelayMs: 20,
      maxReconnectAttempts: 20,
    });

    await sleep(80);
    const server = createSocketServer(socketPath, () => {
      accepted = true;
    });

    const client = await clientPromise;
    expect(client.destroyed).toBe(false);
    expect(accepted).toBe(true);

    client.destroy();
    await closeServer(server);
  });
});

describe('NdjsonConnection framing', () => {
  it('forwards readline socket errors instead of crashing the process', async () => {
    const socketPath = join(tmpdir(), `psfn-transport-${randomUUID()}.sock`);
    let serverConn: NdjsonConnection | null = null;
    const connectionErrors: unknown[] = [];

    const server = createSocketServer(socketPath, (conn) => {
      serverConn = conn;
      conn.on('error', (error) => {
        connectionErrors.push(error);
      });
    });

    const client = net.createConnection(socketPath);

    try {
      await waitFor(() => serverConn !== null);
      const resetError = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      });

      (serverConn as any).rl.emit('error', resetError);

      await waitFor(() => connectionErrors.length === 1);
      await waitFor(() => serverConn?.destroyed === true);

      expect(connectionErrors[0]).toBe(resetError);
    } finally {
      client.destroy();
      await closeServer(server);
    }
  });

  it('fails closed on malformed NDJSON frames', async () => {
    const socketPath = join(tmpdir(), `psfn-transport-${randomUUID()}.sock`);
    let serverConn: NdjsonConnection | null = null;
    const receivedMessages: unknown[] = [];
    const frameErrors: unknown[] = [];
    let clientClosed = false;

    const server = createSocketServer(socketPath, (conn) => {
      serverConn = conn;
      conn.onMessage((message) => {
        receivedMessages.push(message);
      });
      conn.on('frameError', (error) => {
        frameErrors.push(error);
      });
    });

    const client = net.createConnection(socketPath);
    client.on('close', () => {
      clientClosed = true;
    });

    try {
      await waitFor(() => serverConn !== null);
      client.write('{"jsonrpc":"2.0","method":"bad"\n');

      await waitFor(() => frameErrors.length === 1);
      await waitFor(() => serverConn?.destroyed === true);
      await waitFor(() => clientClosed);

      expect(frameErrors[0]).toBeInstanceOf(NdjsonFramingError);
      expect((frameErrors[0] as NdjsonFramingError).preview).toContain('"method":"bad"');
      expect(receivedMessages).toEqual([]);
    } finally {
      client.destroy();
      await closeServer(server);
    }
  });
});
