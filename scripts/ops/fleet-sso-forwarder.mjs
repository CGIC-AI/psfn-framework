import http from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const BROWSER_OWNED_PSFN_HEADERS = new Set([
  'x-psfn-csrf',
  'x-psfn-escalation-grant',
]);
const UNTRUSTED_FORWARDING_HEADERS = new Set([
  'authorization',
  'forwarded',
  'host',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
]);
const UNSAFE_OBJECT_PROPERTY_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function requirePort(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return value;
}

function requireHost(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || /[\s,/\\]/u.test(normalized)) {
    throw new Error(`${name} must be one host authority without a scheme, path, or list`);
  }
  if (isIP(normalized)) return normalized;
  if (normalized.length > 253) {
    throw new Error(`${name} must be one DNS hostname or IP address`);
  }
  for (const label of normalized.split('.')) {
    if (label.length < 1
      || label.length > 63
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)) {
      throw new Error(`${name} must be one DNS hostname or IP address`);
    }
  }
  return normalized;
}

function requireEnvPort(env, name) {
  const raw = env[name]?.trim() ?? '';
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be an explicit integer TCP port`);
  }
  return requirePort(Number(raw), name);
}

function requireLoopbackHost(value, name) {
  const host = requireHost(value, name);
  const family = isIP(host);
  if ((family === 4 && !host.startsWith('127.')) || (family === 6 && host !== '::1') || family === 0) {
    throw new Error(`${name} must be one loopback IP`);
  }
  return host;
}

function resolveSingleForwardedFor(request) {
  const socketAddress = request.socket.remoteAddress ?? '';
  const withoutMappedPrefix = socketAddress.startsWith('::ffff:') ? socketAddress.slice(7) : socketAddress;
  const zoneIndex = withoutMappedPrefix.indexOf('%');
  const remoteAddress = zoneIndex === -1 ? withoutMappedPrefix : withoutMappedPrefix.slice(0, zoneIndex);
  if (!isIP(remoteAddress)) {
    throw new Error('Client socket has no IP-valued remote address');
  }
  return remoteAddress;
}

function copyHeaders(source, excludedNames) {
  const headers = Object.create(null);
  for (const [rawName, value] of Object.entries(source)) {
    const name = rawName.toLowerCase();
    if (UNSAFE_OBJECT_PROPERTY_NAMES.has(name) || excludedNames.has(name)) {
      continue;
    }
    Object.defineProperty(headers, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return headers;
}

function connectionNominatedHeaders(headers) {
  const nominated = new Set();
  const values = Array.isArray(headers.connection) ? headers.connection : [headers.connection];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const token of value.split(',')) {
      const name = token.trim().toLowerCase();
      if (name) nominated.add(name);
    }
  }
  return nominated;
}

function hopByHopHeaders(headers) {
  return new Set([...HOP_BY_HOP_HEADERS, ...connectionNominatedHeaders(headers)]);
}

function untrustedRequestHeaders(headers) {
  const excluded = new Set([
    ...UNTRUSTED_FORWARDING_HEADERS,
    ...hopByHopHeaders(headers),
  ]);
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (normalized.startsWith('x-psfn-') && !BROWSER_OWNED_PSFN_HEADERS.has(normalized)) {
      excluded.add(normalized);
    }
  }
  return excluded;
}

function trustedHeaders(request, canonicalHost, connection) {
  const headers = copyHeaders(request.headers, untrustedRequestHeaders(request.headers));
  const upgrade = request.headers.upgrade;
  if (connection === 'Upgrade' && (typeof upgrade !== 'string' || !upgrade.trim())) {
    throw new Error('Upgrade request must name one protocol');
  }
  Object.defineProperties(headers, {
    connection: { configurable: true, enumerable: true, value: connection, writable: true },
    host: { configurable: true, enumerable: true, value: canonicalHost, writable: true },
    'x-forwarded-for': {
      configurable: true,
      enumerable: true,
      value: resolveSingleForwardedFor(request),
      writable: true,
    },
    'x-forwarded-host': { configurable: true, enumerable: true, value: canonicalHost, writable: true },
    'x-forwarded-port': { configurable: true, enumerable: true, value: '443', writable: true },
    'x-forwarded-proto': { configurable: true, enumerable: true, value: 'https', writable: true },
    ...(connection === 'Upgrade'
      ? { upgrade: { configurable: true, enumerable: true, value: upgrade, writable: true } }
      : {}),
  });
  return headers;
}

function requireOriginFormTarget(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    throw new Error('Proxy target must use one origin-form absolute path');
  }
  return value;
}

function writeHttpError(response, statusCode, message) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    connection: 'close',
  });
  response.end(message);
}

function serializeUpstreamResponseHead(response) {
  const statusCode = response.statusCode ?? 502;
  const statusMessage = response.statusMessage ?? http.STATUS_CODES[statusCode] ?? 'Unknown';
  const lines = [`HTTP/${response.httpVersion} ${statusCode} ${statusMessage}`];
  const excluded = hopByHopHeaders(response.headers);
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (excluded.has(response.rawHeaders[index].toLowerCase())) continue;
    lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
  }
  const upgrade = response.headers.upgrade;
  if (typeof upgrade !== 'string' || !upgrade.trim()) {
    throw new Error('Upstream Upgrade response must name one protocol');
  }
  lines.push('Connection: Upgrade', `Upgrade: ${upgrade}`, '', '');
  return Buffer.from(lines.join('\r\n'), 'latin1');
}

function serializeCloseDelimitedResponseHead(response) {
  const statusCode = response.statusCode ?? 502;
  const statusMessage = response.statusMessage ?? http.STATUS_CODES[statusCode] ?? 'Unknown';
  const lines = [`HTTP/${response.httpVersion} ${statusCode} ${statusMessage}`];
  const excluded = hopByHopHeaders(response.headers);
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (excluded.has(response.rawHeaders[index].toLowerCase())) continue;
    lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
  }
  lines.push('Connection: close', '', '');
  return Buffer.from(lines.join('\r\n'), 'latin1');
}

function writeSocketError(socket, statusCode, statusMessage) {
  if (socket.destroyed) return;
  const body = `${statusMessage}\n`;
  socket.end([
    `HTTP/1.1 ${statusCode} ${statusMessage}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
}

function openUpstreamRequest(options, onResponse) {
  if (onResponse) return http.request(options, onResponse); // ubs:ignore — http.request returns the ClientRequest this helper returns to its lifecycle owner.
  return http.request(options); // ubs:ignore — http.request returns the ClientRequest this helper returns to its lifecycle owner.
}

function proxyUpgrade(request, clientSocket, clientHead, options) {
  let headers;
  let path;
  try {
    headers = trustedHeaders(request, options.canonicalHost, 'Upgrade');
    path = requireOriginFormTarget(request.url);
  } catch {
    writeSocketError(clientSocket, 400, 'Bad Request');
    return;
  }

  clientSocket.pause();
  let upstreamSocket;
  let completed = false;
  let upstreamRequest;
  try {
    upstreamRequest = openUpstreamRequest({
      host: options.upstreamHost,
      port: options.upstreamPort,
      method: request.method,
      path,
      headers,
    });
  } catch {
    writeSocketError(clientSocket, 502, 'Bad Gateway');
    return;
  }
  const onClientDisconnectBeforeUpgrade = () => {
    if (!completed) upstreamRequest.destroy();
  };
  clientSocket.once('close', onClientDisconnectBeforeUpgrade);
  clientSocket.once('end', onClientDisconnectBeforeUpgrade);
  clientSocket.once('error', () => upstreamRequest.destroy());

  upstreamRequest.once('upgrade', (upstreamResponse, socket, upstreamHead) => {
    completed = true;
    upstreamSocket = socket;
    clientSocket.removeListener('close', onClientDisconnectBeforeUpgrade);
    clientSocket.removeListener('end', onClientDisconnectBeforeUpgrade);
    try {
      clientSocket.write(serializeUpstreamResponseHead(upstreamResponse));
    } catch {
      upstreamSocket.destroy();
      writeSocketError(clientSocket, 502, 'Bad Gateway');
      return;
    }
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    if (clientHead.length > 0) upstreamSocket.write(clientHead);

    clientSocket.once('error', () => upstreamSocket.destroy());
    upstreamSocket.once('error', () => clientSocket.destroy());
    clientSocket.once('end', () => upstreamSocket.destroy());
    upstreamSocket.once('end', () => clientSocket.destroy());
    clientSocket.once('close', () => upstreamSocket.destroy());
    upstreamSocket.once('close', () => clientSocket.destroy());
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
    clientSocket.resume();
  });

  upstreamRequest.once('response', (upstreamResponse) => {
    completed = true;
    clientSocket.removeListener('close', onClientDisconnectBeforeUpgrade);
    clientSocket.removeListener('end', onClientDisconnectBeforeUpgrade);
    clientSocket.write(serializeCloseDelimitedResponseHead(upstreamResponse));
    const closeUpstreamResponse = () => upstreamResponse.destroy();
    const closeClientSocket = () => clientSocket.destroy();
    clientSocket.once('error', closeUpstreamResponse);
    clientSocket.once('end', closeUpstreamResponse);
    clientSocket.once('close', closeUpstreamResponse);
    upstreamResponse.once('aborted', closeClientSocket);
    upstreamResponse.once('error', closeClientSocket);
    upstreamResponse.once('close', () => {
      if (!upstreamResponse.complete) closeClientSocket();
    });
    upstreamResponse.pipe(clientSocket, { end: false });
    upstreamResponse.once('end', () => {
      if (upstreamResponse.complete) clientSocket.end();
      else closeClientSocket();
    });
    clientSocket.resume();
  });
  upstreamRequest.once('error', () => {
    if (!completed) writeSocketError(clientSocket, 502, 'Bad Gateway');
  });
  try {
    upstreamRequest.end();
  } catch {
    completed = true;
    upstreamRequest.destroy();
    writeSocketError(clientSocket, 502, 'Bad Gateway');
  }
}

export function createTrustedSsoForwarder(options) {
  const upstreamHost = requireHost(options?.upstreamHost, 'upstreamHost');
  const upstreamPort = requirePort(options?.upstreamPort, 'upstreamPort');
  const canonicalHost = requireHost(options?.canonicalHost, 'canonicalHost');

  const server = http.createServer(); // ubs:ignore — createServer returns the lifecycle-managed Server that this function returns.
  server.on('request', (request, response) => {
    let headers;
    let path;
    try {
      headers = trustedHeaders(request, canonicalHost, 'close');
      path = requireOriginFormTarget(request.url);
    } catch {
      writeHttpError(response, 400, 'invalid client transport');
      return;
    }

    let upstreamResponse;
    let upstreamRequest;
    try {
      upstreamRequest = openUpstreamRequest({
        host: upstreamHost,
        port: upstreamPort,
        method: request.method,
        path,
        headers,
      }, (receivedResponse) => {
        upstreamResponse = receivedResponse;
        if (response.destroyed) {
          upstreamResponse.destroy();
          return;
        }
        const responseHeaders = copyHeaders(
          upstreamResponse.headers,
          hopByHopHeaders(upstreamResponse.headers),
        );
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        const closeDownstreamResponse = () => response.destroy();
        upstreamResponse.once('aborted', closeDownstreamResponse);
        upstreamResponse.once('error', closeDownstreamResponse);
        upstreamResponse.once('close', () => {
          if (!upstreamResponse.complete) closeDownstreamResponse();
        });
        upstreamResponse.pipe(response);
      });
    } catch {
      writeHttpError(response, 502, 'upstream transport failed');
      return;
    }

    const closeUpstreamTransport = () => {
      upstreamRequest.destroy();
      upstreamResponse?.destroy();
    };

    upstreamRequest.once('error', () => {
      writeHttpError(response, 502, 'upstream transport failed');
    });
    response.once('close', () => {
      if (!response.writableFinished) closeUpstreamTransport();
    }); // ubs:ignore — EventEmitter.once is synchronous registration.
    response.once('error', closeUpstreamTransport); // ubs:ignore — EventEmitter.once is synchronous registration.
    request.once('aborted', closeUpstreamTransport); // ubs:ignore — EventEmitter.once is synchronous registration.
    request.once('error', () => {
      closeUpstreamTransport();
      writeHttpError(response, 400, 'invalid client request');
    }); // ubs:ignore — EventEmitter.once is synchronous registration.
    try {
      request.pipe(upstreamRequest); // ubs:ignore — stream.pipe returns the destination; both stream error paths are handled.
    } catch {
      closeUpstreamTransport();
      writeHttpError(response, 400, 'invalid client request');
    }
  });
  server.on('upgrade', (request, socket, head) => {
    proxyUpgrade(request, socket, head, { upstreamHost, upstreamPort, canonicalHost });
  });
  return server;
}

export function resolveTrustedSsoForwarderConfig(env) {
  return {
    listenHost: requireLoopbackHost(
      env.PSFN_FLEET_SSO_FORWARDER_LISTEN_HOST?.trim() || '127.0.0.1',
      'PSFN_FLEET_SSO_FORWARDER_LISTEN_HOST',
    ),
    listenPort: requireEnvPort(env, 'PSFN_FLEET_SSO_FORWARDER_LISTEN_PORT'),
    upstreamHost: requireHost(
      env.PSFN_FLEET_SSO_FORWARDER_UPSTREAM_HOST?.trim() || '127.0.0.1',
      'PSFN_FLEET_SSO_FORWARDER_UPSTREAM_HOST',
    ),
    upstreamPort: requireEnvPort(env, 'PSFN_FLEET_SSO_FORWARDER_UPSTREAM_PORT'),
    canonicalHost: requireHost(
      env.PSFN_FLEET_SSO_FORWARDER_CANONICAL_HOST,
      'PSFN_FLEET_SSO_FORWARDER_CANONICAL_HOST',
    ),
  };
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href);
}

if (isMainModule()) {
  const config = resolveTrustedSsoForwarderConfig(process.env);
  const server = createTrustedSsoForwarder(config);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const shutdown = () => {
    for (const socket of sockets) socket.destroy();
    server.close((error) => {
      if (error) {
        console.error(`Fleet SSO forwarder shutdown failed: ${error.message}`);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.listen(config.listenPort, config.listenHost, () => {
    console.log(
      `Fleet SSO forwarder listening on ${config.listenHost}:${config.listenPort} `
      + `for ${config.canonicalHost} -> http://${config.upstreamHost}:${config.upstreamPort}`,
    );
  });
}
