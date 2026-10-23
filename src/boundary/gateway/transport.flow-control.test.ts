import * as net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { createSocketServer, createWebSocketRpcServer, GATEWAY_RPC_WS_PROTOCOL, type GatewayRpcConnection } from './transport.js';
import { createGatewayRpcTlsFixture, loadRawWebSocketTlsOptions } from './__tests__/transport-tls.js';

async function harness(kind: 'unix' | 'wss') {
  let connection!: GatewayRpcConnection;
  const fixture = kind === 'wss' ? createGatewayRpcTlsFixture() : undefined;
  const path = join(tmpdir(), `psfn-flow-${randomUUID()}.sock`);
  const server = fixture
    ? createWebSocketRpcServer({ host: '127.0.0.1', port: 0, tls: fixture.serverTls }, conn => { connection = conn; })
    : createSocketServer(path, conn => { connection = conn; });
  await once(server, 'listening');
  const address = server.address() as net.AddressInfo;
  const peer = fixture
    ? new WebSocket(`wss://localhost:${address.port}/rpc`, GATEWAY_RPC_WS_PROTOCOL, loadRawWebSocketTlsOptions(fixture.clientTls))
    : net.createConnection(path);
  peer.on('error', () => undefined);
  await once(peer, fixture ? 'open' : 'connect');
  peer.pause();
  return { connection, peer, async close() {
    if (peer instanceof WebSocket) peer.terminate();
    else peer.destroy();
    connection.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fixture?.cleanup();
  } };
}

describe.each(['unix', 'wss'] as const)('%s outbound flow control', kind => {
  it('closes a non-reading peer before accepting an over-budget response or notification', async () => {
    const app = await harness(kind);
    try {
      const payload = '☃'.repeat(350_000);
      let accepted = 0;
      for (let index = 0; index < 80; index++) {
        const frame = index % 2 === 0
          ? { jsonrpc: '2.0', id: payload, result: null }
          : { jsonrpc: '2.0', method: 'notification.test', params: payload };
        if (!app.connection.send(frame)) break;
        accepted++;
        // Permit native callbacks to settle: native writableLength/bufferedAmount
        // must remain charged even after application write completions.
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(accepted).toBeGreaterThan(1);
      expect(accepted).toBeLessThan(80);
      expect(app.connection.destroyed).toBe(true);
      expect(app.connection.serializedTransportStats.frameCount).toBe(accepted);
      expect(app.connection.send({ late: true })).toBe(false);
    } finally { await app.close(); }
  });

  it('accepts exactly 128 outstanding complete frames and rejects frame 129 atomically', async () => {
    const app = await harness(kind);
    try {
      for (let index = 0; index < 128; index++) expect(app.connection.send({ index })).toBe(true);
      expect(app.connection.serializedTransportStats.frameCount).toBe(128);
      expect(app.connection.send({ rejected: 'invented-private-output-sentinel' })).toBe(false);
      expect(app.connection.serializedTransportStats.frameCount).toBe(128);
      expect(app.connection.destroyed).toBe(true);
      expect(app.connection.listenerCount('message')).toBe(0);
    } finally { await app.close(); }
  });

  it('accepts the exact aggregate wire-byte ceiling and rejects the next complete frame', async () => {
    const app = await harness(kind);
    try {
      const wireBytes = 32 * 1024 * 1024 + 7;
      const payloadBytes = wireBytes - (kind === 'unix' ? 1 : 14);
      const frame = { value: '' };
      const remaining = payloadBytes - Buffer.byteLength(JSON.stringify(frame));
      frame.value = '☃'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
      expect(app.connection.send(frame)).toBe(true);
      expect(app.connection.send(frame)).toBe(true);
      expect(app.connection.serializedTransportStats.serializedBytes).toBe(payloadBytes * 2);
      expect(app.connection.send({ rejected: true })).toBe(false);
      expect(app.connection.serializedTransportStats.frameCount).toBe(2);
      expect(app.connection.destroyed).toBe(true);
    } finally { await app.close(); }
  });

  it('releases accepted-write charges after successful delivery and leaves the loop responsive', async () => {
    const app = await harness(kind);
    let received = 0;
    if (app.peer instanceof WebSocket) app.peer.on('message', () => received++);
    else {
      const peer = app.peer;
      let partial = '';
      peer.on('data', chunk => {
        const lines = (partial + chunk.toString()).split('\n');
        partial = lines.pop()!;
        for (const line of lines) {
          if (line === 'PSFN_RPC_HEARTBEAT_PING') peer.write('PSFN_RPC_HEARTBEAT_PONG\n');
          else if (line) received++;
        }
      });
    }
    app.peer.resume();
    try {
      for (let batch = 0; batch < 4; batch++) {
        for (let index = 0; index < 64; index++) expect(app.connection.send({ batch, index })).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(received).toBe(256);
      expect(app.connection.destroyed).toBe(false);
      expect(app.connection.sendHeartbeat()).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(app.connection.sendHeartbeat()).toBe(true);
    } finally { await app.close(); }
  });

});
