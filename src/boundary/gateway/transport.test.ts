import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo, Server as NetServer } from 'node:net';
import type { Server as HttpsServer } from 'node:https';
import { WebSocket } from 'ws';
import { describe, it, expect } from 'vitest';
import {
  createSocketClient,
  createSocketServer,
  createWebSocketRpcClient,
  createWebSocketRpcServer,
  GATEWAY_RPC_WS_PROTOCOL,
  NdjsonFramingError,
  resolveGatewayRpcEndpointFromEnv,
  type GatewayRpcConnection,
  type GatewayRpcTlsFileConfig,
  type NdjsonConnection,
} from './transport.js';

const GATEWAY_SPIFFE_URI = 'spiffe://cluster.local/psfn/gateway';
const AGENT_SPIFFE_URI = 'spiffe://cluster.local/psfn/agent/test-companion';
const OTHER_AGENT_SPIFFE_URI = 'spiffe://cluster.local/psfn/agent/other-companion';

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
  }, onConnection);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `wss://localhost:${address.port}/rpc`,
    fixture,
    close: async () => {
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

describe('WebSocket RPC transport', () => {
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

      client.destroy();
    } finally {
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
      expect((frameErrors[0] as NdjsonFramingError).preview).toContain('"method":"bad"');
      expect(receivedMessages).toEqual([]);
    } finally {
      client.terminate();
      await harness.close();
    }
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
