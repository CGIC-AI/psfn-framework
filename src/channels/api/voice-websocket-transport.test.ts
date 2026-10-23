import http from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { ApiVoiceWebSocketAdapter } from './voice-websocket.js';

it('enforces the downstream voice frame limit on the real transport and recovers after abuse', async () => {
  const received: number[] = [];
  const adapter = new ApiVoiceWebSocketAdapter({
    runtime: {
      maxFrameBytes: 64,
      attach(connection) {
        return connection.onMessage(raw => { received.push(Buffer.byteLength(raw)); });
      },
      stop() {},
    },
  });
  const server = http.createServer((_request, response) => response.end('healthy'));
  server.on('upgrade', (request, socket, head) => adapter.handleUpgrade(request, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const url = `ws://127.0.0.1:${address.port}/v1/voice/ws`;
  const sockets: WebSocket[] = [];
  try {
    const socket = new WebSocket(url); sockets.push(socket);
    await once(socket, 'open');
    socket.send('a'.repeat(64));
    await new Promise(resolve => setImmediate(resolve));
    const closed = once(socket, 'close');
    socket.send('b'.repeat(65));
    expect((await closed)[0]).toBe(1009);
    expect(received).toEqual([64]);
    const recovered = new WebSocket(url); sockets.push(recovered);
    await once(recovered, 'open');
    recovered.send('c'.repeat(64));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(received).toEqual([64, 64]);
  } finally {
    for (const socket of sockets) socket.terminate();
    await adapter.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
