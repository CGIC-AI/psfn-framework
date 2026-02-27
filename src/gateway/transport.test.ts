import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { describe, it, expect } from 'vitest';
import { createSocketClient, createSocketServer, type NdjsonConnection } from './transport.js';

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
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
