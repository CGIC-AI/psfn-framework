import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo, Server as NetServer } from 'node:net';
import type { Server as HttpsServer } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../shared/logger.js';
import {
  computeReconnectDelayMs,
  createSocketClient,
  createSocketServer,
  createWebSocketRpcClient,
  createWebSocketRpcServer,
  GATEWAY_RPC_WS_PROTOCOL,
  NdjsonConnection,
  NdjsonFramingError,
  resolveGatewayRpcEndpointFromEnv,
  type GatewayRpcConnection,
  type GatewayRpcTlsFileConfig,
} from './transport.js';
import { GatewayRpcSocketAdmission } from './transport-admission.js';

const GATEWAY_SPIFFE_URI = 'spiffe://cluster.local/psfn/gateway';
const AGENT_SPIFFE_URI = 'spiffe://cluster.local/psfn/agent/test-companion';
const OTHER_AGENT_SPIFFE_URI = 'spiffe://cluster.local/psfn/agent/other-companion';
// Protocol acceptance cases deliberately pin the reviewed limit independently.
const FRAME_BUDGET_BYTES = 64 * 1024 * 1024;

function budgetRequest(bytes: number, character = 'x'): { jsonrpc: string; id: string; method: string; params: string } {
  const frame = { jsonrpc: '2.0', id: 'budget', method: 'gateway.test', params: '' };
  const payloadBytes = bytes - Buffer.byteLength(JSON.stringify(frame));
  const characterBytes = Buffer.byteLength(character);
  frame.params = character.repeat(Math.floor(payloadBytes / characterBytes)) + 'x'.repeat(payloadBytes % characterBytes);
  return frame;
}

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

async function closeServer(server: NetServer | HttpsServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

interface GatewayRpcTlsFixture {
  serverTls: GatewayRpcTlsFileConfig;
  serverWithoutSpiffeTls: GatewayRpcTlsFileConfig;
  serverUntrustedTls: GatewayRpcTlsFileConfig;
  clientTls: GatewayRpcTlsFileConfig;
  clientWithoutSpiffeTls: GatewayRpcTlsFileConfig;
  clientWrongSpiffeTls: GatewayRpcTlsFileConfig;
  clientUntrustedTls: GatewayRpcTlsFileConfig;
  cleanup(): void;
}

function runOpenSsl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'ignore' });
}

function createCertificateAuthority(dir: string, prefix: string, commonName: string): void {
  runOpenSsl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-days',
    '3650',
    '-nodes',
    '-subj',
    `/CN=${commonName}`,
    '-keyout',
    `${prefix}.key`,
    '-out',
    `${prefix}.crt`,
  ], dir);
}

function createSignedCertificate(input: {
  dir: string;
  prefix: string;
  commonName: string;
  caPrefix: string;
  subjectAltName?: string;
  extendedKeyUsage: 'serverAuth' | 'clientAuth';
}): void {
  runOpenSsl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${input.commonName}`,
    '-keyout',
    `${input.prefix}.key`,
    '-out',
    `${input.prefix}.csr`,
  ], input.dir);
  const extLines = [
    ...(input.subjectAltName ? [`subjectAltName=${input.subjectAltName}`] : []),
    `extendedKeyUsage=${input.extendedKeyUsage}`,
  ];
  writeFileSync(join(input.dir, `${input.prefix}.ext`), `${extLines.join('\n')}\n`, 'utf8');
  runOpenSsl([
    'x509',
    '-req',
    '-in',
    `${input.prefix}.csr`,
    '-CA',
    `${input.caPrefix}.crt`,
    '-CAkey',
    `${input.caPrefix}.key`,
    '-CAcreateserial',
    '-days',
    '3650',
    '-out',
    `${input.prefix}.crt`,
    '-extfile',
    `${input.prefix}.ext`,
  ], input.dir);
}

function buildTlsConfig(input: {
  dir: string;
  caPrefix?: string;
  certPrefix: string;
  expectedPeerSpiffeUri: string;
}): GatewayRpcTlsFileConfig {
  return {
    caPath: join(input.dir, `${input.caPrefix ?? 'ca'}.crt`),
    certPath: join(input.dir, `${input.certPrefix}.crt`),
    keyPath: join(input.dir, `${input.certPrefix}.key`),
    expectedPeerSpiffeUri: input.expectedPeerSpiffeUri,
  };
}

function createGatewayRpcTlsFixture(): GatewayRpcTlsFixture {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-gateway-rpc-wss-'));
  try {
    createCertificateAuthority(dir, 'ca', 'PSFN Test CA');
    createCertificateAuthority(dir, 'other-ca', 'PSFN Other Test CA');
    createSignedCertificate({
      dir,
      prefix: 'server',
      commonName: 'localhost',
      caPrefix: 'ca',
      subjectAltName: `DNS:localhost,IP:127.0.0.1,URI:${GATEWAY_SPIFFE_URI}`,
      extendedKeyUsage: 'serverAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'server-no-spiffe',
      commonName: 'localhost',
      caPrefix: 'ca',
      subjectAltName: 'DNS:localhost,IP:127.0.0.1',
      extendedKeyUsage: 'serverAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'server-untrusted',
      commonName: 'localhost',
      caPrefix: 'other-ca',
      subjectAltName: `DNS:localhost,IP:127.0.0.1,URI:${GATEWAY_SPIFFE_URI}`,
      extendedKeyUsage: 'serverAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'client',
      commonName: 'psfn-agent-test',
      caPrefix: 'ca',
      subjectAltName: `URI:${AGENT_SPIFFE_URI}`,
      extendedKeyUsage: 'clientAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'client-no-spiffe',
      commonName: 'psfn-agent-test',
      caPrefix: 'ca',
      extendedKeyUsage: 'clientAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'client-wrong-spiffe',
      commonName: 'psfn-agent-test',
      caPrefix: 'ca',
      subjectAltName: `URI:${OTHER_AGENT_SPIFFE_URI}`,
      extendedKeyUsage: 'clientAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'client-untrusted',
      commonName: 'psfn-agent-test',
      caPrefix: 'other-ca',
      subjectAltName: `URI:${AGENT_SPIFFE_URI}`,
      extendedKeyUsage: 'clientAuth',
    });

    return {
      serverTls: buildTlsConfig({ dir, certPrefix: 'server', expectedPeerSpiffeUri: AGENT_SPIFFE_URI }),
      serverWithoutSpiffeTls: buildTlsConfig({
        dir,
        certPrefix: 'server-no-spiffe',
        expectedPeerSpiffeUri: AGENT_SPIFFE_URI,
      }),
      serverUntrustedTls: buildTlsConfig({
        dir,
        certPrefix: 'server-untrusted',
        expectedPeerSpiffeUri: AGENT_SPIFFE_URI,
      }),
      clientTls: buildTlsConfig({ dir, certPrefix: 'client', expectedPeerSpiffeUri: GATEWAY_SPIFFE_URI }),
      clientWithoutSpiffeTls: buildTlsConfig({
        dir,
        certPrefix: 'client-no-spiffe',
        expectedPeerSpiffeUri: GATEWAY_SPIFFE_URI,
      }),
      clientWrongSpiffeTls: buildTlsConfig({
        dir,
        certPrefix: 'client-wrong-spiffe',
        expectedPeerSpiffeUri: GATEWAY_SPIFFE_URI,
      }),
      clientUntrustedTls: buildTlsConfig({
        dir,
        certPrefix: 'client-untrusted',
        expectedPeerSpiffeUri: GATEWAY_SPIFFE_URI,
      }),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function loadRawWebSocketTlsOptions(tls: GatewayRpcTlsFileConfig): WebSocket.ClientOptions {
  return {
    ca: readFileSync(tls.caPath),
    cert: readFileSync(tls.certPath),
    key: readFileSync(tls.keyPath),
    rejectUnauthorized: true,
  };
}

async function createWssHarness(
  onConnection: (conn: GatewayRpcConnection) => void,
  selectServerTls: (fixture: GatewayRpcTlsFixture) => GatewayRpcTlsFileConfig = fixture => fixture.serverTls,
  connectionLimits?: { total: number },
): Promise<{
  server: HttpsServer;
  url: string;
  fixture: GatewayRpcTlsFixture;
  close(): Promise<void>;
}> {
  const fixture = createGatewayRpcTlsFixture();
  const server = createWebSocketRpcServer({
    host: '127.0.0.1',
    port: 0,
    path: '/rpc',
    tls: selectServerTls(fixture),
    connectionLimits,
  }, onConnection);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `wss://localhost:${address.port}/rpc`,
    fixture,
    close: async () => {
      GatewayRpcSocketAdmission.closeServer(server);
      await closeServer(server);
      fixture.cleanup();
    },
  };
}

function openRawWebSocket(
  url: string,
  protocol: string,
  tls: GatewayRpcTlsFileConfig,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol, loadRawWebSocketTlsOptions(tls));
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('unexpected-response', onUnexpectedResponse);
      fn();
    };
    const onOpen = () => settle(() => resolve(socket));
    const onError = (error: Error) => settle(() => {
      socket.terminate();
      reject(error);
    });
    const onUnexpectedResponse = (_req: unknown, res: { statusCode?: number }) => settle(() => {
      reject(new Error(`Unexpected HTTP ${res.statusCode ?? 0}`));
    });
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

function websocketUpgradeStatus(
  url: string,
  protocol: string,
  tls: GatewayRpcTlsFileConfig,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol, loadRawWebSocketTlsOptions(tls));
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('unexpected-response', onUnexpectedResponse);
      fn();
    };
    const onOpen = () => settle(() => {
      socket.terminate();
      reject(new Error('WebSocket unexpectedly opened'));
    });
    const onError = (error: Error) => settle(() => reject(error));
    const onUnexpectedResponse = (_req: unknown, res: { statusCode?: number }) => settle(() => {
      resolve(res.statusCode ?? 0);
    });
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

describe('gateway RPC endpoint parsing', () => {
  it('defaults to the Unix socket transport', () => {
    expect(resolveGatewayRpcEndpointFromEnv({}, '/run/psfn/gateway.sock')).toEqual({
      kind: 'unix',
      socketPath: '/run/psfn/gateway.sock',
    });
    expect(resolveGatewayRpcEndpointFromEnv({
      GATEWAY_SOCKET: '/tmp/psfn.sock',
      GATEWAY_RPC_TLS_CA_PATH: '/certs/ca.pem',
    }, '/run/psfn/gateway.sock')).toEqual({
      kind: 'unix',
      socketPath: '/tmp/psfn.sock',
    });
  });

  it('selects WSS only through an explicit endpoint and requires TLS file paths', () => {
    expect(() => resolveGatewayRpcEndpointFromEnv({
      GATEWAY_RPC_ENDPOINT: 'wss://gateway.internal:10054/rpc',
    }, '/run/psfn/gateway.sock')).toThrow(/requires GATEWAY_RPC_TLS_CA_PATH/);

    expect(() => resolveGatewayRpcEndpointFromEnv({
      GATEWAY_RPC_ENDPOINT: 'wss://gateway.internal:10054/rpc',
      GATEWAY_RPC_TLS_CA_PATH: '/certs/ca.pem',
      GATEWAY_RPC_TLS_CERT_PATH: '/certs/client.pem',
      GATEWAY_RPC_TLS_KEY_PATH: '/certs/client-key.pem',
    }, '/run/psfn/gateway.sock')).toThrow(/requires GATEWAY_RPC_TLS_CA_PATH/);

    expect(() => resolveGatewayRpcEndpointFromEnv({
      GATEWAY_RPC_ENDPOINT: 'wss://gateway.internal:10054/rpc',
      GATEWAY_RPC_TLS_CA_PATH: '/certs/ca.pem',
      GATEWAY_RPC_TLS_CERT_PATH: '/certs/client.pem',
      GATEWAY_RPC_TLS_KEY_PATH: '/certs/client-key.pem',
      GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI: 'https://gateway.internal/not-spiffe',
    }, '/run/psfn/gateway.sock')).toThrow(/GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI must be a spiffe:\/\/ URI/);

    expect(resolveGatewayRpcEndpointFromEnv({
      GATEWAY_RPC_ENDPOINT: 'wss://gateway.internal:10054/rpc',
      GATEWAY_RPC_TLS_CA_PATH: '/certs/ca.pem',
      GATEWAY_RPC_TLS_CERT_PATH: '/certs/client.pem',
      GATEWAY_RPC_TLS_KEY_PATH: '/certs/client-key.pem',
      GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI: GATEWAY_SPIFFE_URI,
    }, '/run/psfn/gateway.sock')).toEqual({
      kind: 'wss',
      url: 'wss://gateway.internal:10054/rpc',
      host: 'gateway.internal',
      port: 10054,
      path: '/rpc',
      tls: {
        caPath: '/certs/ca.pem',
        certPath: '/certs/client.pem',
        keyPath: '/certs/client-key.pem',
        expectedPeerSpiffeUri: GATEWAY_SPIFFE_URI,
      },
    });
  });

  it('rejects non-WSS network endpoints', () => {
    expect(() => resolveGatewayRpcEndpointFromEnv({
      GATEWAY_RPC_ENDPOINT: 'ws://gateway.internal:10054/rpc',
    }, '/run/psfn/gateway.sock')).toThrow(/Plain ws:\/\/ is not allowed/);
  });
});

describe('computeReconnectDelayMs backoff schedule', () => {
  it('grows exponentially per attempt and caps at the max delay', () => {
    const base = 1000;
    const cap = 10_000;
    // Use the midpoint by stubbing jitter to its lower bound (Math.random -> 0),
    // which yields exactly capped/2, so the exponential doubling is observable.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(computeReconnectDelayMs(1, base, cap)).toBe(500); // 1000 -> /2
      expect(computeReconnectDelayMs(2, base, cap)).toBe(1000); // 2000 -> /2
      expect(computeReconnectDelayMs(3, base, cap)).toBe(2000); // 4000 -> /2
      expect(computeReconnectDelayMs(4, base, cap)).toBe(4000); // 8000 -> /2
      // Attempt 5 would be 16000 uncapped; capped to 10000 -> /2 = 5000.
      expect(computeReconnectDelayMs(5, base, cap)).toBe(5000);
      expect(computeReconnectDelayMs(50, base, cap)).toBe(5000); // stays capped
    } finally {
      spy.mockRestore();
    }
  });

  it('applies equal jitter so the delay stays within [capped/2, capped]', () => {
    const base = 1000;
    const cap = 10_000;
    for (const random of [0, 0.5, 0.999999]) {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(random);
      try {
        // Attempt 5 is capped at 10000; equal jitter keeps it in [5000, 10000].
        const delay = computeReconnectDelayMs(5, base, cap);
        expect(delay).toBeGreaterThanOrEqual(5000);
        expect(delay).toBeLessThanOrEqual(10_000);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('provides a startup budget far longer than the former fixed ~10s window', () => {
    const base = 1000;
    const cap = 10_000;
    const maxReconnectAttempts = 30;
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0); // lower-bound each delay
    try {
      let budgetMs = 0;
      for (let attempt = 1; attempt < maxReconnectAttempts; attempt += 1) {
        budgetMs += computeReconnectDelayMs(attempt, base, cap);
      }
      // Even at the jitter lower bound the budget is minutes, not ~10s.
      expect(budgetMs).toBeGreaterThan(60_000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('createSocketClient lifecycle', () => {
  it('restricts the trusted local Unix socket to owner and group', async () => {
    const socketPath = join(tmpdir(), `psfn-transport-mode-${randomUUID()}.sock`);
    const server = createSocketServer(socketPath, () => undefined);
    try {
      await once(server, 'listening');
      expect(statSync(socketPath).mode & 0o777).toBe(0o770);
    } finally {
      await closeServer(server);
    }
  });

  it('counts NDJSON backpressure as accepted but rejects writes after destruction', () => {
    const socket = new net.Socket();
    const write = vi.spyOn(socket, 'write').mockReturnValue(false);
    const connection = new NdjsonConnection(socket);
    const notification = {
      jsonrpc: '2.0',
      method: 'discord.message',
      params: { message: { id: 'backpressured' } },
    };

    expect(connection.send(notification)).toBe(true);
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(notification)}\n`);
    expect(connection.serializedTransportStats.frameCount).toBe(1);

    connection.destroy();

    expect(connection.send({ ...notification, params: { message: { id: 'destroyed' } } })).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(connection.serializedTransportStats.frameCount).toBe(1);
  });

  it('exchanges Unix transport heartbeats without producing JSON-RPC frames or stats', async () => {
    const socketPath = join(tmpdir(), `psfn-transport-heartbeat-${randomUUID()}.sock`);
    let serverConn: GatewayRpcConnection | null = null;
    let serverHeartbeats = 0;
    const serverMessages: unknown[] = [];
    const server = createSocketServer(socketPath, (conn) => {
      serverConn = conn;
      conn.on('heartbeat', () => {
        serverHeartbeats += 1;
      });
      conn.onMessage((message) => serverMessages.push(message));
    });
    const client = await createSocketClient({ socketPath, reconnect: false });

    try {
      expect(client.sendHeartbeat()).toBe(true);
      await waitFor(() => serverHeartbeats === 1 && serverConn !== null);
      await sleep(10);

      expect(client.sendHeartbeat()).toBe(true);
      await waitFor(() => serverHeartbeats === 2);
      expect(serverMessages).toEqual([]);
      expect(client.serializedTransportStats).toEqual({
        frameCount: 0,
        serializedBytes: 0,
        rpcCallCount: 0,
        byMethod: {},
      });
      expect(serverConn!.serializedTransportStats).toEqual({
        frameCount: 0,
        serializedBytes: 0,
        rpcCallCount: 0,
        byMethod: {},
      });
    } finally {
      client.destroy();
      await closeServer(server);
    }
  });

  it('counts exact serialized JSON bytes and RPC calls by method', async () => {
    const socketPath = join(tmpdir(), `psfn-transport-stats-${randomUUID()}.sock`);
    let serverConn: GatewayRpcConnection | null = null;
    const serverMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    const server = createSocketServer(socketPath, (conn) => {
      serverConn = conn;
      conn.onMessage((message) => serverMessages.push(message));
    });
    const client = await createSocketClient({ socketPath, reconnect: false });
    client.onMessage((message) => clientMessages.push(message));

    try {
      const request = {
        jsonrpc: '2.0',
        id: 'unicode-call',
        method: 'gateway.métrics',
        params: { value: '☃' },
      };
      expect(client.send(request)).toBe(true);
      await waitFor(() => serverMessages.length === 1 && serverConn !== null);

      const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
      expect(client.serializedTransportStats).toEqual({
        frameCount: 1,
        serializedBytes: requestBytes,
        rpcCallCount: 1,
        byMethod: {
          'gateway.métrics': { callCount: 1, serializedBytes: requestBytes },
        },
      });

      const response = { jsonrpc: '2.0', id: 'unicode-call', result: { ok: true } };
      expect(serverConn!.send(response)).toBe(true);
      await waitFor(() => clientMessages.length === 1);
      expect(serverConn!.serializedTransportStats).toEqual({
        frameCount: 1,
        serializedBytes: Buffer.byteLength(JSON.stringify(response), 'utf8'),
        rpcCallCount: 0,
        byMethod: {},
      });
    } finally {
      client.destroy();
      await closeServer(server);
    }
  });

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

describe('WebSocket RPC transport', () => {
  it('rejects a frame when websocket send throws or the connection is closed', async () => {
    const harness = await createWssHarness(() => undefined);
    const client = await createWebSocketRpcClient({
      url: harness.url,
      tls: harness.fixture.clientTls,
      reconnect: false,
    });
    const rawSocket = (client as unknown as { socket: WebSocket }).socket;
    const sendError = new Error('simulated websocket close race');
    const errors: unknown[] = [];
    client.on('error', error => errors.push(error));

    try {
      const send = vi.spyOn(rawSocket, 'send').mockImplementation(() => {
        throw sendError;
      });

      expect(client.send({ jsonrpc: '2.0', method: 'discord.message' })).toBe(false);
      expect(errors).toEqual([sendError]);
      expect(client.serializedTransportStats.frameCount).toBe(0);

      send.mockRestore();
      client.destroy();
      expect(client.send({ jsonrpc: '2.0', method: 'discord.message' })).toBe(false);
      expect(client.serializedTransportStats.frameCount).toBe(0);
    } finally {
      client.destroy();
      await harness.close();
    }
  });

  it('fails closed before WSS start or connect when mTLS config is incomplete', () => {
    const fixture = createGatewayRpcTlsFixture();
    try {
      expect(() => createWebSocketRpcServer({
        host: '127.0.0.1',
        port: 0,
        path: '/rpc',
        tls: {
          ...fixture.serverTls,
          expectedPeerSpiffeUri: '',
        },
      }, () => undefined)).toThrow(/expected peer SPIFFE URI is required/);

      expect(() => createWebSocketRpcClient({
        url: 'wss://localhost:1/rpc',
        tls: {
          ...fixture.clientTls,
          caPath: '',
        },
        reconnect: false,
      })).toThrow(/Gateway RPC WSS TLS caPath is required/);
    } finally {
      fixture.cleanup();
    }
  });

  it('connects over WSS and forwards JSON frames', async () => {
    let serverConn: GatewayRpcConnection | null = null;
    const serverMessages: unknown[] = [];
    const clientMessages: unknown[] = [];

    const harness = await createWssHarness((conn) => {
      serverConn = conn;
      conn.onMessage((message) => {
        serverMessages.push(message);
        conn.send({ jsonrpc: '2.0', id: 'server-reply', result: message });
      });
    });

    try {
      const client = await createWebSocketRpcClient({
        url: harness.url,
        tls: harness.fixture.clientTls,
        reconnect: false,
      });
      client.onMessage((message) => {
        clientMessages.push(message);
      });

      const request = { jsonrpc: '2.0', id: 'client-request', method: 'gateway.test' };
      expect(client.send(request)).toBe(true);

      await waitFor(() => serverMessages.length === 1);
      await waitFor(() => clientMessages.length === 1);

      expect(serverConn?.destroyed).toBe(false);
      expect(serverMessages).toEqual([request]);
      expect(clientMessages).toEqual([
        { jsonrpc: '2.0', id: 'server-reply', result: request },
      ]);
      const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
      expect(client.serializedTransportStats).toEqual({
        frameCount: 1,
        serializedBytes: requestBytes,
        rpcCallCount: 1,
        byMethod: {
          'gateway.test': { callCount: 1, serializedBytes: requestBytes },
        },
      });

      client.destroy();
    } finally {
      await harness.close();
    }
  });

  it('exchanges WSS ping/pong heartbeats without producing JSON-RPC frames or stats', async () => {
    let serverConn: GatewayRpcConnection | null = null;
    let serverHeartbeats = 0;
    const serverMessages: unknown[] = [];
    const harness = await createWssHarness((conn) => {
      serverConn = conn;
      conn.on('heartbeat', () => {
        serverHeartbeats += 1;
      });
      conn.onMessage((message) => serverMessages.push(message));
    });

    let client: GatewayRpcConnection | null = null;
    try {
      client = await createWebSocketRpcClient({
        url: harness.url,
        tls: harness.fixture.clientTls,
        reconnect: false,
      });
      expect(client.sendHeartbeat()).toBe(true);
      await waitFor(() => serverHeartbeats === 1 && serverConn !== null);
      await sleep(10);

      expect(client.sendHeartbeat()).toBe(true);
      await waitFor(() => serverHeartbeats === 2);
      expect(serverMessages).toEqual([]);
      expect(client.serializedTransportStats).toEqual({
        frameCount: 0,
        serializedBytes: 0,
        rpcCallCount: 0,
        byMethod: {},
      });
      expect(serverConn!.serializedTransportStats).toEqual({
        frameCount: 0,
        serializedBytes: 0,
        rpcCallCount: 0,
        byMethod: {},
      });
    } finally {
      client?.destroy();
      await harness.close();
    }
  });

  it('rejects client certificates missing the expected agent SPIFFE URI SAN', async () => {
    let connections = 0;
    const harness = await createWssHarness(() => {
      connections += 1;
    });

    try {
      await expect(websocketUpgradeStatus(
        harness.url,
        GATEWAY_RPC_WS_PROTOCOL,
        harness.fixture.clientWithoutSpiffeTls,
      )).resolves.toBe(403);
      await expect(websocketUpgradeStatus(
        harness.url,
        GATEWAY_RPC_WS_PROTOCOL,
        harness.fixture.clientWrongSpiffeTls,
      )).resolves.toBe(403);
      expect(connections).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('rejects client certificates signed by an untrusted CA before JSON-RPC handling', async () => {
    let connections = 0;
    const harness = await createWssHarness(() => {
      connections += 1;
    });

    try {
      await expect(websocketUpgradeStatus(
        harness.url,
        GATEWAY_RPC_WS_PROTOCOL,
        harness.fixture.clientUntrustedTls,
      )).rejects.toThrow();
      expect(connections).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('rejects gateway server certificates missing the expected SPIFFE URI SAN', async () => {
    const harness = await createWssHarness(
      () => undefined,
      fixture => fixture.serverWithoutSpiffeTls,
    );

    try {
      await expect(createWebSocketRpcClient({
        url: harness.url,
        tls: harness.fixture.clientTls,
        reconnect: false,
      })).rejects.toThrow(/missing SPIFFE URI SAN/);
    } finally {
      await harness.close();
    }
  });

  it('rejects gateway server certificates signed by an untrusted CA', async () => {
    const harness = await createWssHarness(
      () => undefined,
      fixture => fixture.serverUntrustedTls,
    );

    try {
      await expect(createWebSocketRpcClient({
        url: harness.url,
        tls: harness.fixture.clientTls,
        reconnect: false,
      })).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });

  it('rejects websocket upgrades on the wrong path or subprotocol', async () => {
    const harness = await createWssHarness(() => undefined);

    try {
      await expect(websocketUpgradeStatus(
        harness.url.replace('/rpc', '/wrong'),
        GATEWAY_RPC_WS_PROTOCOL,
        harness.fixture.clientTls,
      )).resolves.toBe(404);
      await expect(websocketUpgradeStatus(
        harness.url,
        'wrong-protocol',
        harness.fixture.clientTls,
      )).resolves.toBe(426);
    } finally {
      await harness.close();
    }
  });

  it('fails closed on malformed websocket frames', async () => {
    let serverConn: GatewayRpcConnection | null = null;
    const receivedMessages: unknown[] = [];
    const frameErrors: unknown[] = [];
    let clientClosed = false;

    const harness = await createWssHarness((conn) => {
      serverConn = conn;
      conn.onMessage((message) => {
        receivedMessages.push(message);
      });
      conn.on('frameError', (error) => {
        frameErrors.push(error);
      });
    });

    const client = await openRawWebSocket(
      harness.url,
      GATEWAY_RPC_WS_PROTOCOL,
      harness.fixture.clientTls,
    );
    client.on('close', () => {
      clientClosed = true;
    });

    try {
      await waitFor(() => serverConn !== null);
      client.send('{"jsonrpc":"2.0","method":"bad"');

      await waitFor(() => frameErrors.length === 1);
      await waitFor(() => serverConn?.destroyed === true);
      await waitFor(() => clientClosed);

      expect(frameErrors[0]).toBeInstanceOf(NdjsonFramingError);
      expect(frameErrors[0]).not.toHaveProperty('preview');
      expect(receivedMessages).toEqual([]);
    } finally {
      client.terminate();
      await harness.close();
    }
  });
});

describe('NdjsonConnection framing', () => {
  it('releases connection and socket listeners when destroyed', async () => {
    const socketPath = join(tmpdir(), `psfn-transport-${randomUUID()}.sock`);
    let serverConn: NdjsonConnection | null = null;
    const closeEvents: string[] = [];

    const server = createSocketServer(socketPath, (conn) => {
      serverConn = conn;
    });

    const client = net.createConnection(socketPath);
    client.on('error', () => undefined);

    try {
      await waitFor(() => serverConn !== null);
      const conn = serverConn;
      const internals = conn as unknown as {
        socket: net.Socket;
      };

      conn.onMessage(() => undefined);
      conn.on('close', () => {
        closeEvents.push('close');
      });
      conn.on('error', () => undefined);

      expect(conn.listenerCount('message')).toBe(1);
      expect(internals.socket.listenerCount('data')).toBeGreaterThan(0);
      expect(internals.socket.listenerCount('close')).toBeGreaterThan(0);

      conn.destroy();

      await waitFor(() => conn.destroyed);

      expect(closeEvents).toEqual(['close']);
      expect(conn.listenerCount('message')).toBe(0);
      expect(conn.listenerCount('close')).toBe(0);
      expect(conn.listenerCount('error')).toBe(0);
      expect(internals.socket.listenerCount('data')).toBe(0);
      // net.Socket owns its readable-end lifecycle listener.
      expect(internals.socket.listenerCount('end')).toBeLessThanOrEqual(1);
      expect(internals.socket.listenerCount('close')).toBe(0);
      expect(internals.socket.listenerCount('error')).toBe(0);
    } finally {
      client.destroy();
      await closeServer(server);
    }
  });

  it('forwards socket errors instead of crashing the process', async () => {
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

      const rawSocket = (serverConn as unknown as { socket: net.Socket }).socket;
      rawSocket.destroy(resetError);

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
      expect(frameErrors[0]).not.toHaveProperty('preview');
      expect(receivedMessages).toEqual([]);
    } finally {
      client.destroy();
      await closeServer(server);
    }
  });
});

describe('Gateway RPC frame byte budget', () => {
  it('terminates a persistent oversized WSS peer that never acknowledges close and releases its total slot', async () => {
    const connections: GatewayRpcConnection[] = [];
    const harness = await createWssHarness(conn => {
      connections.push(conn);
      conn.onMessage(() => {
        conn.completeAdmission?.();
        conn.send({ identified: true });
      });
      conn.on('frameError', () => conn.destroy());
    }, fixture => fixture.serverTls, { total: 4 });
    const peers: WebSocket[] = [];
    try {
      for (let index = 0; index < 4; index += 1) {
        const peer = await openRawWebSocket(harness.url, GATEWAY_RPC_WS_PROTOCOL, harness.fixture.clientTls);
        peers.push(peer);
        const identified = once(peer, 'message');
        peer.send('{"jsonrpc":"2.0","id":1,"method":"gateway.client.identify"}');
        await identified;
      }
      await expect(openRawWebSocket(harness.url, GATEWAY_RPC_WS_PROTOCOL, harness.fixture.clientTls)).rejects.toThrow();
      const stubborn = peers[0];
      stubborn.on('error', () => undefined);
      stubborn.pause();
      const socket = (stubborn as unknown as { _socket: net.Socket })._socket;
      const oversizedHeader = Buffer.alloc(14);
      oversizedHeader[0] = 0x81;
      oversizedHeader[1] = 0xff;
      oversizedHeader.writeBigUInt64BE(BigInt(FRAME_BUDGET_BYTES + 1), 2);
      const serverSocket = (connections[0] as unknown as { socket: WebSocket }).socket;
      socket.write(oversizedHeader);
      await waitFor(() => serverSocket.readyState === WebSocket.CLOSING);
      expect(serverSocket.readyState).not.toBe(WebSocket.CLOSED);
      await waitFor(() => serverSocket.readyState === WebSocket.CLOSED, 6_000);
      expect(connections[0].eventNames()).toEqual([]);
      const recovered = await openRawWebSocket(harness.url, GATEWAY_RPC_WS_PROTOCOL, harness.fixture.clientTls);
      peers.push(recovered);
      const response = once(recovered, 'message');
      recovered.send('{"jsonrpc":"2.0","id":2,"method":"gateway.client.identify"}');
      await response;
      expect(peers.slice(1, 4).every(peer => peer.readyState === WebSocket.OPEN)).toBe(true);
    } finally {
      peers.forEach(peer => peer.terminate());
      connections.forEach(conn => conn.destroy());
      await harness.close();
    }
  });

  it('bounds raw TLS and partial HTTP upgrade peers before RPC registration, then recovers after timeout', async () => {
    const accepted: GatewayRpcConnection[] = [];
    const harness = await createWssHarness(conn => {
      accepted.push(conn);
      conn.onMessage(() => conn.completeAdmission?.());
    }, fixture => fixture.serverTls, { total: 4 });
    const port = (harness.server.address() as AddressInfo).port;
    const raw = net.createConnection(port, '127.0.0.1');
    const partial = tls.connect({
      host: '127.0.0.1', port, servername: 'localhost',
      ca: readFileSync(harness.fixture.clientTls.caPath),
      cert: readFileSync(harness.fixture.clientTls.certPath),
      key: readFileSync(harness.fixture.clientTls.keyPath),
    });
    raw.on('error', () => undefined);
    partial.on('error', () => undefined);
    try {
      await once(partial, 'secureConnect');
      partial.write('GET /rpc HTTP/1.1\r\nHost: localhost\r\nX-Partial: ');
      const excess = net.createConnection(port, '127.0.0.1');
      excess.on('error', () => undefined);
      await waitFor(() => excess.destroyed);
      expect(accepted).toHaveLength(0);
      expect(raw.destroyed).toBe(false);
      expect(partial.destroyed).toBe(false);
      await waitFor(() => raw.destroyed && partial.destroyed, 6_000);
      const healthy = await openRawWebSocket(harness.url, GATEWAY_RPC_WS_PROTOCOL, harness.fixture.clientTls);
      healthy.send('{"jsonrpc":"2.0","id":1,"method":"test"}');
      await waitFor(() => accepted.length === 1);
      healthy.terminate();
    } finally {
      raw.destroy();
      partial.destroy();
      for (const conn of accepted) conn.destroy();
      await harness.close();
    }
  });

  it('releases raw admission after a socket error and closes pending sockets on shutdown', async () => {
    const socketPath = join(tmpdir(), `psfn-admission-error-${randomUUID()}.sock`);
    const connections: GatewayRpcConnection[] = [];
    const server = createSocketServer(socketPath, conn => {
      connections.push(conn);
      conn.on('error', () => conn.destroy());
    }, { connectionLimits: { total: 4 } });
    await once(server, 'listening');
    const peers = [net.createConnection(socketPath), net.createConnection(socketPath)];
    peers.forEach(peer => peer.on('error', () => undefined));
    try {
      await waitFor(() => connections.length === 2);
      const socket = (connections[0] as unknown as { socket: net.Socket }).socket;
      socket.destroy(new Error('invented-sensitive-error'));
      await waitFor(() => peers[0].destroyed);
      const next = net.createConnection(socketPath);
      next.on('error', () => undefined);
      peers.push(next);
      await waitFor(() => connections.length === 3);
      GatewayRpcSocketAdmission.closeServer(server);
      await waitFor(() => peers.every(peer => peer.destroyed));
      expect(connections.every(conn => conn.destroyed)).toBe(true);
    } finally {
      peers.forEach(peer => peer.destroy());
      connections.forEach(conn => conn.destroy());
      await closeServer(server);
    }
  });

  it('closes a fragmented multibyte WebSocket one byte over budget before application dispatch', async () => {
    let outcome: unknown;
    let connection: GatewayRpcConnection | undefined;
    const errors: unknown[] = [];
    const harness = await createWssHarness(conn => {
      connection = conn;
      conn.onMessage(() => { outcome = 'dispatched'; });
      conn.on('frameError', error => errors.push(error));
    });
    const client = await openRawWebSocket(harness.url, GATEWAY_RPC_WS_PROTOCOL, harness.fixture.clientTls);
    client.on('close', code => { outcome = code; });
    try {
      const frame = Buffer.from(JSON.stringify(budgetRequest(FRAME_BUDGET_BYTES + 1, 'é')));
      client.send(frame.subarray(0, frame.length / 2), { binary: false, fin: false });
      client.send(frame.subarray(frame.length / 2), { binary: false, fin: true });
      await waitFor(() => outcome !== undefined);
      expect(outcome).toBe(1009);
      await waitFor(() => connection?.eventNames().length === 0);
      expect(errors).toEqual([expect.objectContaining({ message: 'Gateway RPC frame exceeds the UTF-8 byte limit' })]);
    } finally {
      client.terminate();
      await harness.close();
    }
  });

  it('closes a slow NDJSON line when it crosses budget without waiting for newline', async () => {
    let connection: GatewayRpcConnection | undefined;
    const received: unknown[] = [];
    const server = net.createServer(socket => {
      connection = new NdjsonConnection(socket);
      connection.onMessage(frame => received.push(frame));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = net.createConnection((server.address() as AddressInfo).port, '127.0.0.1');
    client.on('error', () => undefined);
    await once(client, 'connect');
    try {
      const chunk = Buffer.alloc(64 * 1024, 'x');
      for (let written = 0; written < FRAME_BUDGET_BYTES; written += chunk.length) {
        if (!client.write(chunk)) await once(client, 'drain');
        if (written % (1024 * 1024) === 0) await sleep(1);
      }
      client.write('x');
      await waitFor(() => connection?.destroyed === true);
      expect(received).toEqual([]);
    } finally {
      client.destroy();
      connection?.destroy();
      await closeServer(server);
    }
  });

  it.each(['ndjson', 'websocket'] as const)('rejects oversized %s outbound frames atomically', async kind => {
    const received: unknown[] = [];
    let connection: GatewayRpcConnection;
    let close: () => Promise<void>;
    if (kind === 'ndjson') {
      const socketPath = join(tmpdir(), `psfn-frame-budget-${randomUUID()}.sock`);
      const server = createSocketServer(socketPath, conn => conn.onMessage(frame => received.push(frame)));
      connection = await createSocketClient({ socketPath, reconnect: false });
      close = () => closeServer(server);
    } else {
      const harness = await createWssHarness(conn => conn.onMessage(frame => received.push(frame)));
      connection = await createWebSocketRpcClient({ url: harness.url, tls: harness.fixture.clientTls, reconnect: false });
      close = () => harness.close();
    }
    connection.on('error', () => undefined);
    try {
      expect(connection.send(budgetRequest(FRAME_BUDGET_BYTES + 1))).toBe(false);
      expect(connection.serializedTransportStats.frameCount).toBe(0);
      expect(connection.send({ ok: true })).toBe(true);
      await waitFor(() => received.length > 0);
      expect(received).toEqual([{ ok: true }]);
    } finally {
      connection.destroy();
      await close();
    }
  });

  it.each(['ndjson', 'websocket'] as const)('accepts exact-budget multibyte %s frames and counts only accepted bytes', async kind => {
    let receivedBytes = 0;
    let connection: GatewayRpcConnection;
    let close: () => Promise<void>;
    let compression = '';
    const onConnection = (conn: GatewayRpcConnection): void => {
      conn.onMessage(frame => {
        receivedBytes = Buffer.byteLength(JSON.stringify(frame));
        conn.send({ acceptedBytes: receivedBytes });
      });
    };
    if (kind === 'ndjson') {
      const socketPath = join(tmpdir(), `psfn-frame-budget-${randomUUID()}.sock`);
      const server = createSocketServer(socketPath, onConnection);
      connection = await createSocketClient({ socketPath, reconnect: false });
      close = () => closeServer(server);
    } else {
      const harness = await createWssHarness(onConnection);
      // Request compression at the peer boundary; the production server refuses it.
      const peer = await openRawWebSocket(harness.url, GATEWAY_RPC_WS_PROTOCOL, harness.fixture.clientTls);
      compression = peer.extensions;
      peer.terminate();
      connection = await createWebSocketRpcClient({ url: harness.url, tls: harness.fixture.clientTls, reconnect: false });
      close = () => harness.close();
    }
    const responses: unknown[] = [];
    connection.onMessage(frame => responses.push(frame));
    try {
      expect(connection.send(budgetRequest(FRAME_BUDGET_BYTES, '☃'))).toBe(true);
      await waitFor(() => responses.length === 1);
      expect(receivedBytes).toBe(67_108_864);
      expect(responses).toEqual([{ acceptedBytes: 67_108_864 }]);
      expect(connection.serializedTransportStats).toEqual({
        frameCount: 1,
        serializedBytes: 67_108_864,
        rpcCallCount: 1,
        byMethod: { 'gateway.test': { callCount: 1, serializedBytes: 67_108_864 } },
      });
      expect(compression).toBe('');
      expect(connection.sendHeartbeat()).toBe(true);
      expect(connection.serializedTransportStats.frameCount).toBe(1);
    } finally {
      connection.destroy();
      await close();
    }
  });

  it('bounds frames received by the WSS client and leaves the next connection healthy', async () => {
    const fixture = createGatewayRpcTlsFixture();
    const server = https.createServer({
      ca: readFileSync(fixture.serverTls.caPath),
      cert: readFileSync(fixture.serverTls.certPath),
      key: readFileSync(fixture.serverTls.keyPath),
      requestCert: true,
      rejectUnauthorized: true,
    });
    const peers = new WebSocketServer({ server });
    let rawPeer: WebSocket | undefined;
    peers.on('connection', peer => { rawPeer = peer; });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `wss://localhost:${(server.address() as AddressInfo).port}/rpc`;
    const client = await createWebSocketRpcClient({ url, tls: fixture.clientTls, reconnect: false });
    const received: unknown[] = [];
    const errors: unknown[] = [];
    client.onMessage(frame => received.push(frame));
    client.on('frameError', error => errors.push(error));
    let healthy: GatewayRpcConnection | undefined;
    try {
      await waitFor(() => rawPeer !== undefined);
      expect(rawPeer!.extensions).toBe('');
      const close = once(rawPeer!, 'close');
      rawPeer!.send(JSON.stringify(budgetRequest(FRAME_BUDGET_BYTES + 1)));
      expect((await close)[0]).toBe(1009);
      await waitFor(() => client.eventNames().length === 0);
      expect(received).toEqual([]);
      expect(errors).toHaveLength(1);
      rawPeer = undefined;
      healthy = await createWebSocketRpcClient({ url, tls: fixture.clientTls, reconnect: false });
      await waitFor(() => rawPeer !== undefined);
      const next: unknown[] = [];
      healthy.onMessage(frame => next.push(frame));
      rawPeer!.send('{"ok":true}');
      await waitFor(() => next.length === 1);
      expect(next).toEqual([{ ok: true }]);
    } finally {
      client.destroy();
      healthy?.destroy();
      for (const peer of peers.clients) peer.terminate();
      await closeServer(server);
      peers.close();
      fixture.cleanup();
    }
  });

  it('bounds repeated streaming attacks, releases listeners and keeps other NDJSON connections responsive', async () => {
    const connections: GatewayRpcConnection[] = [];
    const sockets: net.Socket[] = [];
    const server = net.createServer(socket => {
      sockets.push(socket);
      const conn = new NdjsonConnection(socket);
      connections.push(conn);
      conn.onMessage(() => conn.send({ ok: true }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const open = async (): Promise<net.Socket> => {
      const peer = net.createConnection(port, '127.0.0.1');
      peer.on('error', () => undefined);
      await once(peer, 'connect');
      return peer;
    };
    const healthy = await open();
    const replies: string[] = [];
    healthy.on('data', chunk => replies.push(chunk.toString()));
    let ticks = 0;
    let lastTick = performance.now();
    let largestGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      largestGapMs = Math.max(largestGapMs, now - lastTick);
      lastTick = now;
      ticks += 1;
    }, 10);
    const baselineBuffers = process.memoryUsage().arrayBuffers;
    let peakBuffers = baselineBuffers;
    try {
      const chunk = Buffer.alloc(64 * 1024, 'x');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const attacker = await open();
        const conn = connections.at(-1)!;
        const socket = sockets.at(-1)!;
        try {
          for (let written = 0; written < FRAME_BUDGET_BYTES; written += chunk.length) {
            if (!attacker.write(chunk)) await once(attacker, 'drain');
            if (written % (1024 * 1024) === 0) {
              await sleep(1);
              peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers);
            }
          }
          attacker.write('x');
          await waitFor(() => conn.destroyed && attacker.destroyed);
          expect(conn.eventNames()).toEqual([]);
          expect(socket.eventNames().filter(event => event !== 'end')).toEqual([]);
          expect(socket.listenerCount('end')).toBeLessThanOrEqual(1);
          healthy.write('{"probe":true}\r');
          await waitFor(() => replies.length === attempt + 1);
          healthy.write('\n');
        } finally {
          attacker.destroy();
        }
      }
      const fresh = await open();
      const response = once(fresh, 'data');
      fresh.write('{"new":true}\n');
      expect((await response)[0].toString()).toBe('{"ok":true}\n');
      fresh.destroy();
      expect(ticks).toBeGreaterThan(2);
      expect(largestGapMs).toBeLessThan(500);
      // Allows buffer growth/copying and network queues, but not retained lines per attack.
      expect(peakBuffers - baselineBuffers).toBeLessThan(4 * FRAME_BUDGET_BYTES);
    } finally {
      clearInterval(timer);
      healthy.destroy();
      for (const conn of connections) conn.destroy();
      await closeServer(server);
    }
  });

  it('keeps malformed transport logs and errors content-free', async () => {
    const marker = 'invented-private-frame-marker';
    const logs: unknown[] = [];
    const capture = (entry: { component?: string }): void => {
      if (entry.component === 'Transport') logs.push(entry);
    };
    logger.on('data', capture);
    const errors: unknown[] = [];
    const server = net.createServer(socket => {
      const conn = new NdjsonConnection(socket);
      conn.on('frameError', error => errors.push(error));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const peer = net.createConnection((server.address() as AddressInfo).port, '127.0.0.1');
    peer.on('error', () => undefined);
    try {
      peer.write(`{"secret":"${marker}"\n`);
      await waitFor(() => peer.destroyed);
      expect(errors).toHaveLength(1);
      expect(logs.length).toBeGreaterThan(0);
      expect(JSON.stringify(logs)).not.toContain(marker);
      expect(JSON.stringify(errors)).not.toContain(marker);
    } finally {
      logger.removeListener('data', capture);
      peer.destroy();
      await closeServer(server);
    }
  });
});
