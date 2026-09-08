import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

/** The public leg contains only browser metadata; Hub adds its own authority. */
export function proxyCompanionUiBrowserUpgrade(input: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  hubOrigin: string;
  canonicalOrigin: string;
  timeoutMs: number;
  allowGuest: boolean;
}): void {
  const { request, socket, head } = input;
  const origin = new URL(input.hubOrigin);
  const canonical = new URL(input.canonicalOrigin);
  const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());
  const cookieCount = names.filter(name => name === 'cookie').length;
  const validCookie = typeof request.headers.cookie === 'string'
    && /^__Host-psfn_session=[A-Za-z0-9_-]{43}$/u.test(request.headers.cookie);
  if (request.headers.host !== canonical.host || request.headers.origin !== canonical.origin
    || !['host', 'origin'].every(name => names.filter(entry => entry === name).length === 1)
    || names.some(name => name === 'authorization' || name === 'sec-websocket-protocol'
      || name.startsWith('x-psfn-') || name.startsWith('x-identity-claim-'))
    || !(validCookie ? cookieCount === 1 : cookieCount === 0 && input.allowGuest)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const outgoing = (origin.protocol === 'https:' ? httpsRequest : httpRequest)(
    new URL(request.url!, origin), {
      method: 'GET',
      headers: {
        Host: canonical.host,
        Origin: canonical.origin,
        ...(validCookie ? { Cookie: request.headers.cookie } : {}),
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': String(request.headers['sec-websocket-key'] ?? ''),
        'Sec-WebSocket-Version': String(request.headers['sec-websocket-version'] ?? ''),
      },
    },
  );
  outgoing.once('upgrade', (response, upstream, upstreamHead) => {
    outgoing.setTimeout(0);
    upstream.setTimeout(0);
    const accept = response.headers['sec-websocket-accept'];
    if (typeof accept !== 'string' || response.headers['sec-websocket-protocol'] !== undefined) {
      upstream.destroy();
      socket.destroy();
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  outgoing.once('response', response => {
    response.resume();
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  outgoing.once('error', () => socket.destroy());
  outgoing.setTimeout(input.timeoutMs, () => { outgoing.destroy(); socket.destroy(); });
  socket.once('close', () => outgoing.destroy());
  outgoing.end();
}
