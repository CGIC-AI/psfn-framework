import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import {
  createTrustedSsoForwarder,
  resolveTrustedSsoForwarderConfig,
} from './fleet-sso-forwarder.mjs';

const CANONICAL_HOST = 'fleet.example.test';
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const serverSockets = new WeakMap();

function listen(server) {
  const sockets = new Set();
  serverSockets.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }).then(() => { // ubs:ignore — this returned chain has an explicit catch below.
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an IP server address');
    }
    return address.port;
  }).catch((error) => {
    throw error;
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

function createTestServer(requestListener) {
  const server = http.createServer(); // ubs:ignore — createServer returns the Server whose lifecycle each test owns.
  if (requestListener) server.on('request', requestListener);
  return server;
}

function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function websocketAccept(key) {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function rawUpgrade(port, path, extraHead) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    let finished = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for proxied WebSocket bytes'));
    }, 2_000);
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      if (!finished
        && combined.includes(Buffer.from('UPSTREAM_HEAD'))
        && combined.includes(Buffer.from(`echo:${extraHead}`))) {
        finished = true;
        clearTimeout(timeout);
        socket.once('close', () => resolve(combined));
        socket.destroy();
      }
    });
    socket.once('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        'Host: untrusted-edge.invalid',
        `Origin: https://${CANONICAL_HOST}`,
        `Cookie: __Host-psfn_session=${'a'.repeat(43)}`,
        'Connection: keep-alive, Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        'X-Forwarded-For: 203.0.113.9, 198.51.100.8',
        'X-Forwarded-Host: attacker.invalid',
        'X-Forwarded-Proto: http',
        'X-PSFN-Trusted-Proxy-Token: replayed-proxy-token',
        'X-PSFN-Client-Cert-Fingerprint-SHA256: caller-selected-fingerprint',
        'X-PSFN-Request-Capability: forged-request-capability',
        `X-PSFN-Companion-ID: ${COMPANION_ID}`,
        'X-PSFN-CSRF: browser-csrf-proof',
        'X-PSFN-Escalation-Grant: browser-escalation-grant',
        '',
        extraHead,
      ].join('\r\n'));
    });
  });
}

function rawExchange(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for raw proxy response'));
    }, 2_000);
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks));
    });
    socket.once('connect', () => socket.write(requestText));
  });
}

function openRawRequest(port, requestText, onData) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(requestText);
      resolve(socket);
    });
    if (onData) socket.on('data', onData);
  });
}

function withTimeout(promise, description) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${description}`)),
      2_000,
    );
    Promise.resolve(promise).then( // ubs:ignore — this chain has rejection handling plus an explicit catch below.
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    ).catch(reject);
  });
}

test('rewrites one trusted proxy hop while preserving HTTP request authority', async () => {
  let observed;
  const upstream = createTestServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk)); // ubs:ignore — EventEmitter.on is synchronous registration.
    req.on('end', () => {
      observed = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(202, {
        connection: 'keep-alive, x-response-hop',
        'content-type': 'text/plain',
        'keep-alive': 'timeout=5',
        'x-response-hop': 'must-not-reach-the-browser',
        'x-upstream': 'preserved',
      });
      res.end('accepted');
    }); // ubs:ignore — EventEmitter.on is synchronous registration.
  });
  let forwarder;

  try {
    const upstreamPort = await listen(upstream);
    forwarder = createTrustedSsoForwarder({
      upstreamHost: '127.0.0.1',
      upstreamPort,
      canonicalHost: CANONICAL_HOST,
    });
    const forwarderPort = await listen(forwarder);
    const body = '{"probe":true}';
    const path = `/companions/${COMPANION_ID}/garden/api/admin/stats?scope=current`;
    const response = await request(forwarderPort, {
      method: 'POST',
      path,
      body,
      headers: {
        host: 'untrusted-edge.invalid',
        origin: `https://${CANONICAL_HOST}`,
        cookie: '__Host-psfn_session=opaque-test-session',
        authorization: 'Bearer must-not-reach-the-gateway',
        forwarded: 'for=203.0.113.9;host=attacker.invalid',
        'x-forwarded-for': '203.0.113.9, 198.51.100.8',
        'x-forwarded-host': 'attacker.invalid',
        'x-forwarded-proto': 'http',
        connection: 'keep-alive, x-hop-metadata',
        'x-hop-metadata': 'must-not-reach-the-gateway',
        'x-psfn-trusted-proxy-token': 'caller-controlled-metadata', // ubs:ignore — deliberate non-secret adversarial fixture.
        'x-psfn-client-cert-fingerprint-sha256': 'caller-selected-fingerprint',
        'x-psfn-request-capability': 'forged-request-capability',
        'x-psfn-companion-id': COMPANION_ID,
        'x-psfn-role': 'owner',
        'x-psfn-csrf': 'browser-csrf-proof',
        'x-psfn-escalation-grant': 'browser-escalation-grant',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.headers['x-upstream'], 'preserved');
    assert.equal(response.headers['x-response-hop'], undefined);
    assert.equal(response.body, 'accepted');
    assert.equal(observed.method, 'POST');
    assert.equal(observed.url, path);
    assert.equal(observed.body, body);
    assert.equal(observed.headers.host, CANONICAL_HOST);
    assert.equal(observed.headers['x-forwarded-host'], CANONICAL_HOST);
    assert.equal(observed.headers['x-forwarded-proto'], 'https');
    assert.equal(observed.headers['x-forwarded-port'], '443');
    assert.equal(observed.headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(observed.headers.forwarded, undefined);
    assert.equal(observed.headers.authorization, undefined);
    assert.equal(observed.headers['x-hop-metadata'], undefined);
    assert.equal(observed.headers['x-psfn-trusted-proxy-token'], undefined);
    assert.equal(observed.headers['x-psfn-client-cert-fingerprint-sha256'], undefined);
    assert.equal(observed.headers['x-psfn-request-capability'], undefined);
    assert.equal(observed.headers['x-psfn-companion-id'], undefined);
    assert.equal(observed.headers['x-psfn-role'], undefined);
    assert.equal(observed.headers['x-psfn-csrf'], 'browser-csrf-proof');
    assert.equal(observed.headers['x-psfn-escalation-grant'], 'browser-escalation-grant');
    assert.equal(observed.headers.origin, `https://${CANONICAL_HOST}`);
    assert.equal(observed.headers.cookie, '__Host-psfn_session=opaque-test-session');
    assert.equal(observed.headers.connection, 'close');
  } finally {
    if (forwarder) await close(forwarder);
    await close(upstream);
  }
});

test('requires explicit operator ports and canonical host while binding only loopback', () => {
  assert.throws(
    () => resolveTrustedSsoForwarderConfig({}),
    /PSFN_FLEET_SSO_FORWARDER_LISTEN_PORT/u,
  );
  assert.throws(
    () => resolveTrustedSsoForwarderConfig({
      PSFN_FLEET_SSO_FORWARDER_LISTEN_HOST: '0.0.0.0',
      PSFN_FLEET_SSO_FORWARDER_LISTEN_PORT: '18080',
      PSFN_FLEET_SSO_FORWARDER_UPSTREAM_PORT: '18081',
      PSFN_FLEET_SSO_FORWARDER_CANONICAL_HOST: CANONICAL_HOST,
    }),
    /loopback IP/u,
  );
  assert.throws(
    () => resolveTrustedSsoForwarderConfig({
      PSFN_FLEET_SSO_FORWARDER_LISTEN_PORT: '18080',
      PSFN_FLEET_SSO_FORWARDER_UPSTREAM_PORT: '18081',
      PSFN_FLEET_SSO_FORWARDER_CANONICAL_HOST: 'https://fleet.example.test',
    }),
    /scheme, path, or list/u,
  );
  assert.deepEqual(resolveTrustedSsoForwarderConfig({
    PSFN_FLEET_SSO_FORWARDER_LISTEN_PORT: '18080',
    PSFN_FLEET_SSO_FORWARDER_UPSTREAM_PORT: '18081',
    PSFN_FLEET_SSO_FORWARDER_CANONICAL_HOST: CANONICAL_HOST,
  }), {
    listenHost: '127.0.0.1',
    listenPort: 18080,
    upstreamHost: '127.0.0.1',
    upstreamPort: 18081,
    canonicalHost: CANONICAL_HOST,
  });
});

test('preserves authenticated WebSocket Upgrade, path, headers, and head bytes', async () => {
  let observed;
  let resolveClientHead;
  let resolveUpstreamClose;
  const clientHeadReceived = new Promise(resolve => { resolveClientHead = resolve; });
  const upstreamClosed = new Promise(resolve => { resolveUpstreamClose = resolve; });
  const upstream = createTestServer((_req, res) => {
    res.writeHead(426);
    res.end('upgrade required');
  });
  upstream.on('upgrade', (req, socket, head) => {
    observed = { url: req.url, headers: req.headers };
    socket.once('close', resolveUpstreamClose);
    socket.once('end', () => {
      resolveUpstreamClose();
      socket.destroy();
    });
    const key = req.headers['sec-websocket-key'];
    assert.equal(typeof key, 'string');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: keep-alive, X-Upstream-Hop, Upgrade',
      'Upgrade: websocket',
      'TE: trailers',
      'Trailer: X-Checksum',
      'X-Upstream-Hop: must-not-reach-the-browser',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      '',
      'UPSTREAM_HEAD',
    ].join('\r\n'));
    const onClientBytes = (chunk) => {
      const text = chunk.toString('utf8');
      resolveClientHead(text);
      socket.write(`echo:${text}`);
    };
    if (head.length > 0) onClientBytes(head);
    else socket.once('data', onClientBytes);
  });
  let forwarder;

  try {
    const upstreamPort = await listen(upstream);
    forwarder = createTrustedSsoForwarder({
      upstreamHost: '127.0.0.1',
      upstreamPort,
      canonicalHost: CANONICAL_HOST,
    });
    const forwarderPort = await listen(forwarder);
    const path = `/companions/${COMPANION_ID}/garden/api/admin/events?cursor=opaque`;
    const response = await rawUpgrade(forwarderPort, path, 'CLIENT_HEAD');
    assert.match(response.toString('utf8'), /^HTTP\/1\.1 101 Switching Protocols/mu);
    assert.doesNotMatch(response.toString('utf8'), /X-Upstream-Hop|Trailer|TE:/iu);
    assert.equal(await clientHeadReceived, 'CLIENT_HEAD');
    assert.equal(observed.url, path);
    assert.equal(observed.headers.host, CANONICAL_HOST);
    assert.equal(observed.headers['x-forwarded-host'], CANONICAL_HOST);
    assert.equal(observed.headers['x-forwarded-proto'], 'https');
    assert.equal(observed.headers['x-forwarded-port'], '443');
    assert.equal(observed.headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(observed.headers.origin, `https://${CANONICAL_HOST}`);
    assert.equal(observed.headers.cookie, `__Host-psfn_session=${'a'.repeat(43)}`);
    assert.equal(observed.headers.connection, 'Upgrade');
    assert.equal(observed.headers.upgrade, 'websocket');
    assert.equal(observed.headers['x-psfn-trusted-proxy-token'], undefined);
    assert.equal(observed.headers['x-psfn-client-cert-fingerprint-sha256'], undefined);
    assert.equal(observed.headers['x-psfn-request-capability'], undefined);
    assert.equal(observed.headers['x-psfn-companion-id'], undefined);
    assert.equal(observed.headers['x-psfn-csrf'], 'browser-csrf-proof');
    assert.equal(observed.headers['x-psfn-escalation-grant'], 'browser-escalation-grant');
    await withTimeout(upstreamClosed, 'upstream close after the client disconnects');
  } finally {
    if (forwarder) await close(forwarder);
    await close(upstream);
  }
});

test('relays ordinary HTTP and non-101 WebSocket denials without an auth fallback', async () => {
  const observedUpgrades = [];
  const upstream = createTestServer((req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end(`ordinary GET denied: ${req.url}`);
  });
  upstream.on('upgrade', (req, socket) => {
    observedUpgrades.push({ origin: req.headers.origin, cookie: req.headers.cookie });
    const status = req.headers.origin === `https://${CANONICAL_HOST}` ? 401 : 403;
    const message = status === 401 ? 'invalid session cookie' : 'invalid origin';
    if (status === 403) {
      socket.end([
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        'Content-Type: text/plain',
        'Transfer-Encoding: chunked',
        '',
        `${Buffer.byteLength(message).toString(16)}\r\n${message}\r\n0\r\n\r\n`,
      ].join('\r\n'));
      return;
    }
    socket.end([
      'HTTP/1.1 401 Unauthorized',
      'Connection: close',
      'Content-Type: text/plain',
      `Content-Length: ${Buffer.byteLength(message)}`,
      '',
      message,
    ].join('\r\n'));
  });
  let forwarder;

  try {
    const upstreamPort = await listen(upstream);
    forwarder = createTrustedSsoForwarder({
      upstreamHost: '127.0.0.1',
      upstreamPort,
      canonicalHost: CANONICAL_HOST,
    });
    const forwarderPort = await listen(forwarder);
    const path = `/companions/${COMPANION_ID}/garden/api/admin/events`;
    const ordinary = await request(forwarderPort, {
      method: 'GET',
      path,
      headers: { origin: `https://${CANONICAL_HOST}` },
    });
    assert.equal(ordinary.statusCode, 405);
    assert.equal(ordinary.body, `ordinary GET denied: ${path}`);

    const invalidOrigin = await request(forwarderPort, {
      method: 'GET',
      path,
      headers: {
        host: 'untrusted-edge.invalid',
        origin: 'https://attacker.invalid',
        cookie: `__Host-psfn_session=${'a'.repeat(43)}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
      },
    });
    assert.equal(invalidOrigin.statusCode, 403);
    assert.equal(invalidOrigin.headers['transfer-encoding'], undefined);
    assert.equal(invalidOrigin.body, 'invalid origin');

    const invalidCookie = await rawExchange(forwarderPort, [
      `GET ${path} HTTP/1.1`,
      'Host: untrusted-edge.invalid',
      `Origin: https://${CANONICAL_HOST}`,
      'Cookie: __Host-psfn_session=invalid',
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
    assert.match(invalidCookie.toString('utf8'), /^HTTP\/1\.1 401 Unauthorized/mu);
    assert.match(invalidCookie.toString('utf8'), /invalid session cookie$/u);
    assert.deepEqual(observedUpgrades, [
      {
        origin: 'https://attacker.invalid',
        cookie: `__Host-psfn_session=${'a'.repeat(43)}`,
      },
      {
        origin: `https://${CANONICAL_HOST}`,
        cookie: '__Host-psfn_session=invalid',
      },
    ]);
  } finally {
    if (forwarder) await close(forwarder);
    await close(upstream);
  }
});

test('strips hop-by-hop Upgrade headers without allowing request construction to terminate the process', async () => {
  let observed;
  const upstream = createTestServer();
  upstream.on('upgrade', (req, socket) => {
    observed = req.headers;
    socket.end([
      'HTTP/1.1 403 Forbidden',
      'Connection: close',
      'Content-Length: 6',
      '',
      'denied',
    ].join('\r\n'));
  });
  let forwarder;

  try {
    const upstreamPort = await listen(upstream);
    forwarder = createTrustedSsoForwarder({
      upstreamHost: '127.0.0.1',
      upstreamPort,
      canonicalHost: CANONICAL_HOST,
    });
    const forwarderPort = await listen(forwarder);
    const path = `/companions/${COMPANION_ID}/garden/api/admin/events`;
    const response = await rawExchange(forwarderPort, [
      `GET ${path} HTTP/1.1`,
      'Host: untrusted-edge.invalid',
      'Connection: keep-alive, X-Hop-Secret, Upgrade',
      'Upgrade: websocket',
      'TE: trailers',
      'Trailer: X-Checksum',
      'X-Hop-Secret: must-not-reach-the-gateway',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));

    assert.match(response.toString('utf8'), /^HTTP\/1\.1 403 Forbidden/mu);
    assert.equal(observed.connection, 'Upgrade');
    assert.equal(observed.upgrade, 'websocket');
    assert.equal(observed.te, undefined);
    assert.equal(observed.trailer, undefined);
    assert.equal(observed['x-hop-secret'], undefined);
  } finally {
    if (forwarder) await close(forwarder);
    await close(upstream);
  }
});

test('couples ordinary HTTP cancellation and truncation in both directions', async () => {
  let resolveHeldRequest;
  let resolveHeldClose;
  let resolveStreamStarted;
  let resolveStreamClose;
  const heldRequest = new Promise(resolve => { resolveHeldRequest = resolve; });
  const heldClosed = new Promise(resolve => { resolveHeldClose = resolve; });
  const streamStarted = new Promise(resolve => { resolveStreamStarted = resolve; });
  const streamClosed = new Promise(resolve => { resolveStreamClose = resolve; });
  const upstream = createTestServer((req, res) => {
    if (req.url === '/held') {
      req.socket.once('close', resolveHeldClose);
      resolveHeldRequest();
      return;
    }
    if (req.url === '/stream') {
      res.once('close', resolveStreamClose);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial-stream');
      resolveStreamStarted();
      return;
    }
    res.writeHead(200, { 'content-length': '100', 'content-type': 'text/plain' });
    res.flushHeaders();
    res.write('truncated');
    setImmediate(() => res.destroy());
  });
  let forwarder;

  try {
    const upstreamPort = await listen(upstream);
    forwarder = createTrustedSsoForwarder({
      upstreamHost: '127.0.0.1',
      upstreamPort,
      canonicalHost: CANONICAL_HOST,
    });
    const forwarderPort = await listen(forwarder);

    const heldClient = await openRawRequest(forwarderPort, [
      'GET /held HTTP/1.1',
      `Host: ${CANONICAL_HOST}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n'));
    await withTimeout(heldRequest, 'held upstream request');
    heldClient.destroy();
    await withTimeout(heldClosed, 'held upstream teardown');

    let resolveStreamBytes;
    const streamBytes = new Promise(resolve => { resolveStreamBytes = resolve; });
    let sawStreamBytes = false;
    const streamClient = await openRawRequest(forwarderPort, [
      'GET /stream HTTP/1.1',
      `Host: ${CANONICAL_HOST}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n'), (chunk) => {
      if (!sawStreamBytes && chunk.includes(Buffer.from('partial-stream'))) {
        sawStreamBytes = true;
        resolveStreamBytes();
      }
    });
    await withTimeout(streamStarted, 'streaming upstream response');
    await withTimeout(streamBytes, 'streamed downstream response bytes');
    streamClient.destroy();
    await withTimeout(streamClosed, 'streaming upstream teardown');

    const truncated = await rawExchange(forwarderPort, [
      'GET /truncate HTTP/1.1',
      `Host: ${CANONICAL_HOST}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n'));
    assert.match(truncated.toString('utf8'), /^HTTP\/1\.1 200 OK/mu);
    assert.match(truncated.toString('utf8'), /truncated/u);
  } finally {
    if (forwarder) await close(forwarder);
    await close(upstream);
  }
});

test('tears down the opposite transport when either Upgrade peer disconnects', async () => {
  let resolvePendingUpgrade;
  let resolvePendingUpstreamClose;
  const pendingUpgrade = new Promise(resolve => { resolvePendingUpgrade = resolve; });
  const pendingUpstreamClosed = new Promise(resolve => { resolvePendingUpstreamClose = resolve; });
  let upgradeCount = 0;
  const upstream = createTestServer();
  upstream.on('upgrade', (_req, socket) => {
    upgradeCount += 1;
    if (upgradeCount === 1) {
      socket.once('close', resolvePendingUpstreamClose);
      socket.once('end', () => {
        resolvePendingUpstreamClose();
        socket.destroy();
      });
      resolvePendingUpgrade();
      return;
    }
    socket.end([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      '',
      '',
    ].join('\r\n'));
  });
  const path = `/companions/${COMPANION_ID}/garden/api/admin/events`;
  const handshake = () => [
    `GET ${path} HTTP/1.1`,
    'Host: untrusted-edge.invalid',
    `Origin: https://${CANONICAL_HOST}`,
    `Cookie: __Host-psfn_session=${'a'.repeat(43)}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n');

  let forwarder;
  try {
    const upstreamPort = await listen(upstream);
    forwarder = createTrustedSsoForwarder({
      upstreamHost: '127.0.0.1',
      upstreamPort,
      canonicalHost: CANONICAL_HOST,
    });
    const forwarderPort = await listen(forwarder);
    const clientClosedFirst = net.connect({ host: '127.0.0.1', port: forwarderPort });
    await new Promise((resolve, reject) => {
      clientClosedFirst.once('error', reject);
      clientClosedFirst.once('connect', () => {
        clientClosedFirst.write(handshake());
        resolve();
      });
    });
    await withTimeout(pendingUpgrade, 'pending upstream Upgrade');
    clientClosedFirst.destroy();
    await withTimeout(pendingUpstreamClosed, 'pending upstream socket teardown');

    const upstreamClosedFirst = await rawExchange(forwarderPort, handshake());
    assert.match(upstreamClosedFirst.toString('utf8'), /^HTTP\/1\.1 101 Switching Protocols/mu);
  } finally {
    if (forwarder) await close(forwarder);
    await close(upstream);
  }
});
