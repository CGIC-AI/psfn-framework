import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { EventBus } from '../../shared/event-bus.js';
import { createSpiffeCheckServerIdentity } from '../../shared/net/mtls.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { resetRuntimeTrustPolicy } from '../../system/trust/runtime-policy.js';
import { GardenAdminTransportServer } from './transport-server.js';
import { GardenOperatorSurface } from './operator-surface.js';
import type { GardenAdminDomainServices } from './admin-contract.js';
import type {
  GardenAdminTransportClientEndpoint,
  GardenAdminTransportServerEndpoint,
  GardenAdminTransportSocketEndpoint,
  GardenAdminTransportTlsConfig,
} from './transport-paths.js';

const GARDEN_SPIFFE_URI = 'spiffe://cluster.local/psfn/garden';
const AGENT_SPIFFE_URI = 'spiffe://cluster.local/psfn/agent/test-companion';
const OTHER_GARDEN_SPIFFE_URI = 'spiffe://cluster.local/psfn/garden-other';

function requestPort(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestSocket(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

interface AdminTransportTlsFixture {
  serverTls: GardenAdminTransportTlsConfig;
  serverWithoutSpiffeTls: GardenAdminTransportTlsConfig;
  clientTls: GardenAdminTransportTlsConfig;
  clientWithoutSpiffeTls: GardenAdminTransportTlsConfig;
  clientWrongSpiffeTls: GardenAdminTransportTlsConfig;
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
  certPrefix: string;
  expectedPeerSpiffeUri: string;
}): GardenAdminTransportTlsConfig {
  return {
    caPath: join(input.dir, 'ca.crt'),
    certPath: join(input.dir, `${input.certPrefix}.crt`),
    keyPath: join(input.dir, `${input.certPrefix}.key`),
    expectedPeerSpiffeUri: input.expectedPeerSpiffeUri,
  };
}

function createAdminTransportTlsFixture(dir: string): AdminTransportTlsFixture {
  createCertificateAuthority(dir, 'ca', 'PSFN Garden Admin Transport Test CA');
  createSignedCertificate({
    dir,
    prefix: 'agent-server',
    commonName: 'agent-admin.local',
    caPrefix: 'ca',
    subjectAltName: `DNS:localhost,IP:127.0.0.1,URI:${AGENT_SPIFFE_URI}`,
    extendedKeyUsage: 'serverAuth',
  });
  createSignedCertificate({
    dir,
    prefix: 'agent-server-no-spiffe',
    commonName: 'agent-admin.local',
    caPrefix: 'ca',
    subjectAltName: 'DNS:localhost,IP:127.0.0.1',
    extendedKeyUsage: 'serverAuth',
  });
  createSignedCertificate({
    dir,
    prefix: 'garden-client',
    commonName: 'garden',
    caPrefix: 'ca',
    subjectAltName: `URI:${GARDEN_SPIFFE_URI}`,
    extendedKeyUsage: 'clientAuth',
  });
  createSignedCertificate({
    dir,
    prefix: 'garden-client-no-spiffe',
    commonName: 'garden',
    caPrefix: 'ca',
    extendedKeyUsage: 'clientAuth',
  });
  createSignedCertificate({
    dir,
    prefix: 'garden-client-wrong-spiffe',
    commonName: 'garden',
    caPrefix: 'ca',
    subjectAltName: `URI:${OTHER_GARDEN_SPIFFE_URI}`,
    extendedKeyUsage: 'clientAuth',
  });

  return {
    serverTls: buildTlsConfig({
      dir,
      certPrefix: 'agent-server',
      expectedPeerSpiffeUri: GARDEN_SPIFFE_URI,
    }),
    serverWithoutSpiffeTls: buildTlsConfig({
      dir,
      certPrefix: 'agent-server-no-spiffe',
      expectedPeerSpiffeUri: GARDEN_SPIFFE_URI,
    }),
    clientTls: buildTlsConfig({
      dir,
      certPrefix: 'garden-client',
      expectedPeerSpiffeUri: AGENT_SPIFFE_URI,
    }),
    clientWithoutSpiffeTls: buildTlsConfig({
      dir,
      certPrefix: 'garden-client-no-spiffe',
      expectedPeerSpiffeUri: AGENT_SPIFFE_URI,
    }),
    clientWrongSpiffeTls: buildTlsConfig({
      dir,
      certPrefix: 'garden-client-wrong-spiffe',
      expectedPeerSpiffeUri: AGENT_SPIFFE_URI,
    }),
  };
}

function buildHttpsClientTlsOptions(tls: GardenAdminTransportTlsConfig): https.RequestOptions {
  return {
    ca: readFileSync(tls.caPath),
    cert: readFileSync(tls.certPath),
    key: readFileSync(tls.keyPath),
    rejectUnauthorized: true,
    checkServerIdentity: createSpiffeCheckServerIdentity(tls.expectedPeerSpiffeUri),
  };
}

function requestTransportPort(
  port: number,
  method: string,
  path: string,
  tls: GardenAdminTransportTlsConfig,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'localhost',
        port,
        method,
        path,
        headers,
        ...buildHttpsClientTlsOptions(tls),
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestTransportPortWithoutClientCertificate(
  port: number,
  clientTlsConfig: GardenAdminTransportTlsConfig,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'localhost',
        port,
        method: 'GET',
        path: '/api/admin/dashboard',
        ca: readFileSync(clientTlsConfig.caPath),
        rejectUnauthorized: true,
        checkServerIdentity: createSpiffeCheckServerIdentity(clientTlsConfig.expectedPeerSpiffeUri),
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function openWebSocket(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const cleanup = () => {
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('unexpected-response');
    };

    ws.once('open', () => {
      cleanup();
      resolve(ws);
    });
    ws.once('unexpected-response', (_request, response) => {
      cleanup();
      response.resume();
      reject(new Error(`Unexpected websocket response: ${response.statusCode ?? 0}`));
    });
    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}

function openWebSocketExpectStatus(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const cleanup = () => {
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('unexpected-response');
    };

    ws.once('open', () => {
      cleanup();
      ws.close();
      reject(new Error('Expected websocket handshake to fail'));
    });
    ws.once('unexpected-response', (_request, response) => {
      cleanup();
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}

function readWebSocketMessage<T>(ws: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket message')), 2000);
    ws.once('message', (raw: WebSocket.RawData) => {
      clearTimeout(timeout);
      try {
        const text = typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString()
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString()
              : raw.toString();
        resolve(JSON.parse(text) as T);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function listenSocketServer(socketPath: string, handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function listenHttpsPortServer(
  port: number,
  tls: GardenAdminTransportTlsConfig,
  handler: http.RequestListener,
): Promise<https.Server> {
  return new Promise((resolve, reject) => {
    const server = https.createServer({
      ca: readFileSync(tls.caPath),
      cert: readFileSync(tls.certPath),
      key: readFileSync(tls.keyPath),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    }, handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

interface Harness {
  tempDir: string;
  socketPath: string;
  port: number;
  transportPort?: number;
  tlsFixture?: AdminTransportTlsFixture;
  eventBus: EventBus;
  services: GardenAdminDomainServices;
  transportServer: GardenAdminTransportServer;
  operatorSurface: GardenOperatorSurface;
  transportStopped: boolean;
}

interface OperatorOnlyHarness {
  tempDir: string;
  port: number;
  operatorSurface: GardenOperatorSurface;
}

interface CreateHarnessOptions {
  transportMode?: 'socket' | 'network-mtls';
  serverIdentity?: 'valid' | 'missing-spiffe';
  timeoutMs?: number;
}

function createTestConfig(tempDir: string): SubstrateConfig {
  const characterCardPath = join(tempDir, 'character.json');
  mkdirSync(join(tempDir, 'sessions'), { recursive: true });
  writeFileSync(characterCardPath, '{}\n', 'utf-8');

  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-extract',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '123',
    companionId: 'test-companion',
    characterCardPath,
    dataDir: tempDir,
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelCatalog: {
      primary: {
        model: 'test-model-room',
        provider: 'openai',
        defaults: {
          description: 'Test Model Room',
        },
      },
    },
    modelRoleAssignments: {
      chat: 'primary',
    },
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
    },
  };
}

function createTestServices(): GardenAdminDomainServices {
  return {
    dashboard: {
      getDashboardData: vi.fn(async () => ({
        stats: {
          sessionCount: 1,
        },
      })),
    },
    diagnostics: {
      getDiagnostics: vi.fn(async () => ({
        schemaVersion: 1,
        generatedAt: 1_780_000_000_000,
        window: {
          sinceMs: 1_779_996_400_000,
          untilMs: 1_780_000_000_000,
          windowMs: 3_600_000,
          limit: 20,
          includeFileLogs: false,
          logsDir: '/app/logs',
        },
        sources: [],
        agentLog: { status: 'available', counts: { warn: 0, error: 0, total: 0 }, records: [] },
        fileLogs: { status: 'unavailable', reason: 'file log diagnostics disabled for this request' },
        toolValidationFailures: { status: 'available', total: 0, byTool: [] },
        lifecycle: { status: 'available', events: [] },
        rollout: { status: 'unavailable', reason: 'requires kube surface (x5rt.4)' },
        pods: { status: 'unavailable', reason: 'requires kube surface (x5rt.4)' },
        backup: {
          status: 'available',
          counts: { success: 0, failure: 0, total: 0 },
          lastSuccess: null,
          lastFailure: null,
          recent: [],
        },
      })),
    },
    auditHistory: {
      appendGardenEntry: vi.fn(),
      getAuditHistory: vi.fn(async () => ({
        entries: [],
        filters: {
          actionType: 'all',
          decision: 'all',
          timeRange: '24h',
          source: 'all',
          limit: 100,
          offset: 0,
        },
        pagination: {
          limit: 100,
          offset: 0,
          total: 0,
          hasPrevious: false,
          hasNext: false,
        },
        sources: {
          garden: { available: true, count: 0 },
          gateway: { available: false, count: 0 },
          charge: { available: false, count: 0 },
        },
      })),
    },
    shards: {
      listShardFoldReviews: vi.fn(async () => ({ reviews: [] })),
      getShardFoldReview: vi.fn(async () => null),
      resolveShardFoldReview: vi.fn(async () => ({ ok: false, message: 'Shard fold review not found' })),
    },
    modelUsage: {
      getModelUsageData: vi.fn(async query => ({
        query: query ?? {},
        totals: {
          calls: 1,
          successfulCalls: 1,
          failedCalls: 0,
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          providerCostUsd: 0.001,
          estimatedCostUsd: 0,
          totalCostUsd: 0.001,
          averageDurationMs: 120,
          averageTtftMs: 40,
        },
        byModel: [],
        byPurpose: [],
        byTool: [],
        byCallKind: [],
        recentEvents: [],
        expensiveEvents: [],
      })),
    },
    observerEvalSidecar: {
      getHealth: vi.fn(async () => ({
        status: 'disabled',
        observedAt: 1_780_000_000_000,
        runtime: null,
        persistence: {
          available: false,
          evalOwned: false,
          authoritative: false,
        },
      })),
      getLatestObservation: vi.fn(),
      queryObservations: vi.fn(),
      queryRuns: vi.fn(),
      exportObservations: vi.fn(),
    },
    adaptiveTools: null,
    images: {} as GardenAdminDomainServices['images'],
    memory: {} as GardenAdminDomainServices['memory'],
    sessions: {} as GardenAdminDomainServices['sessions'],
    contacts: {} as GardenAdminDomainServices['contacts'],
    settings: {
      getSettingsData: vi.fn(),
      getSettingsContractData: vi.fn(),
      updateSettings: vi.fn(),
      getSubConfigJson: vi.fn((key: string) => {
        if (key !== 'providers') return null;
        return JSON.stringify({
          schemaVersion: 1,
          providers: [
            {
              id: 'litellm',
              type: 'litellm_proxy',
              enabled: true,
              apiBaseUrl: 'http://localhost:4000/v1',
              apiKeyRef: { kind: 'env', envName: 'LITELLM_API_KEY' },
            },
          ],
        });
      }),
      saveSubConfigJson: vi.fn(() => ({ ok: true, message: 'providers.json saved' })),
    } as GardenAdminDomainServices['settings'],
    identity: {} as GardenAdminDomainServices['identity'],
    prompts: {} as GardenAdminDomainServices['prompts'],
    scheduler: {
      listTasks: () => [],
    },
    skills: null,
    confirmations: null,
    values: {
      list: () => [],
    },
    modelDiscovery: null,
    chatBootstrap: {
      buildBootstrap: vi.fn(async () => ({ defaultSessionId: 'api:admin-user' })),
      updateSelection: vi.fn(async () => ({ selectedTarget: { channel: 'api', userId: 'admin-user' } })),
      buildModelRoomBootstrap: vi.fn(async () => ({ defaultRoomId: 'garden-model-room' })),
    },
  } as GardenAdminDomainServices;
}

function createSocketEndpoint(socketPath: string, timeoutMs: number): GardenAdminTransportSocketEndpoint {
  return {
    mode: 'socket',
    socketPath,
    timeoutMs,
  };
}

function createNetworkClientEndpoint(
  port: number,
  timeoutMs: number,
  tls: GardenAdminTransportTlsConfig,
): GardenAdminTransportClientEndpoint {
  return {
    mode: 'network',
    httpUrl: new URL(`https://localhost:${port}`),
    wsUrl: new URL(`wss://localhost:${port}`),
    timeoutMs,
    peerAuthMode: 'mtls-spiffe',
    tls,
  };
}

function createNetworkEndpoints(
  tempDir: string,
  port: number,
  timeoutMs: number,
  serverIdentity: 'valid' | 'missing-spiffe',
): {
  serverEndpoint: GardenAdminTransportServerEndpoint;
  clientEndpoint: GardenAdminTransportClientEndpoint;
  tlsFixture: AdminTransportTlsFixture;
} {
  const tlsFixture = createAdminTransportTlsFixture(tempDir);
  return {
    serverEndpoint: {
      mode: 'network',
      host: '127.0.0.1',
      port,
      scheme: 'https',
      timeoutMs,
      peerAuthMode: 'mtls-spiffe',
      tls: serverIdentity === 'missing-spiffe'
        ? tlsFixture.serverWithoutSpiffeTls
        : tlsFixture.serverTls,
    },
    clientEndpoint: createNetworkClientEndpoint(port, timeoutMs, tlsFixture.clientTls),
    tlsFixture,
  };
}

async function createOperatorOnlyHarness(
  transportEndpoint: GardenAdminTransportClientEndpoint,
  options: { host?: string } = {},
): Promise<OperatorOnlyHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'garden-operator-surface-test-'));
  const config = createTestConfig(tempDir);
  const port = await allocatePort();
  const operatorSurface = new GardenOperatorSurface({
    port,
    host: options.host ?? '127.0.0.1',
    allowInsecureWithoutToken: true,
    config,
    transportEndpoint,
  });
  try {
    await operatorSurface.init();
    await operatorSurface.start();
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    resetRuntimeTrustPolicy();
    throw error;
  }

  return {
    tempDir,
    port,
    operatorSurface,
  };
}

async function createHarness(options: CreateHarnessOptions = {}): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'garden-operator-surface-test-'));
  const config = createTestConfig(tempDir);
  const eventBus = new EventBus();
  const services = createTestServices();
  const timeoutMs = options.timeoutMs ?? 15_000;

  const socketPath = join(tempDir, 'garden-admin.sock');
  const transportMode = options.transportMode ?? 'socket';
  const transportEndpoint = transportMode === 'socket'
    ? {
        serverEndpoint: createSocketEndpoint(socketPath, timeoutMs),
        clientEndpoint: createSocketEndpoint(socketPath, timeoutMs),
      }
    : createNetworkEndpoints(
        tempDir,
        await allocatePort(),
        timeoutMs,
        options.serverIdentity ?? 'valid',
      );

  const transportServer = new GardenAdminTransportServer({
    endpoint: transportEndpoint.serverEndpoint,
    eventBus,
    config,
    services,
  });
  await transportServer.init();
  await transportServer.start();

  const port = await allocatePort();
  const operatorSurface = new GardenOperatorSurface({
    port,
    host: '127.0.0.1',
    allowInsecureWithoutToken: true,
    config,
    transportEndpoint: transportEndpoint.clientEndpoint,
  });
  await operatorSurface.init();
  await operatorSurface.start();

  return {
    tempDir,
    socketPath,
    port,
    ...(transportEndpoint.serverEndpoint.mode === 'network'
      ? { transportPort: transportEndpoint.serverEndpoint.port }
      : {}),
    ...('tlsFixture' in transportEndpoint
      ? { tlsFixture: transportEndpoint.tlsFixture }
      : {}),
    eventBus,
    services,
    transportServer,
    operatorSurface,
    transportStopped: false,
  };
}

async function destroyHarness(harness: Harness): Promise<void> {
  await harness.operatorSurface.stop();
  if (!harness.transportStopped) {
    await harness.transportServer.stop();
  }
  rmSync(harness.tempDir, { recursive: true, force: true });
  resetRuntimeTrustPolicy();
}

async function destroyOperatorOnlyHarness(harness: OperatorOnlyHarness): Promise<void> {
  await harness.operatorSurface.stop();
  rmSync(harness.tempDir, { recursive: true, force: true });
  resetRuntimeTrustPolicy();
}

describe('Garden operator surface startup policy', () => {
  it('rejects insecure local mode on non-loopback hosts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'garden-operator-surface-policy-test-'));
    const config = createTestConfig(tempDir);
    const operatorSurface = new GardenOperatorSurface({
      port: await allocatePort(),
      host: '0.0.0.0',
      allowInsecureWithoutToken: true,
      config,
      transportEndpoint: createSocketEndpoint(join(tempDir, 'garden-admin.sock'), 1_000),
    });

    try {
      await operatorSurface.init();
      await expect(operatorSurface.start()).rejects.toThrow(
        'ADMIN_ALLOW_INSECURE=true requires ADMIN_HOST to be loopback',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      resetRuntimeTrustPolicy();
    }
  });

  it('allows insecure local mode on explicit loopback hosts', async () => {
    const socketTempDir = mkdtempSync(join(tmpdir(), 'garden-operator-surface-policy-test-'));
    let loopbackHarness: OperatorOnlyHarness | undefined;
    let localhostHarness: OperatorOnlyHarness | undefined;
    try {
      loopbackHarness = await createOperatorOnlyHarness(
        createSocketEndpoint(join(socketTempDir, 'loopback.sock'), 1_000),
        { host: '127.0.0.1' },
      );
      await destroyOperatorOnlyHarness(loopbackHarness);
      loopbackHarness = undefined;

      localhostHarness = await createOperatorOnlyHarness(
        createSocketEndpoint(join(socketTempDir, 'localhost.sock'), 1_000),
        { host: 'localhost' },
      );
      await destroyOperatorOnlyHarness(localhostHarness);
      localhostHarness = undefined;
    } finally {
      if (loopbackHarness) {
        await destroyOperatorOnlyHarness(loopbackHarness);
      }
      if (localhostHarness) {
        await destroyOperatorOnlyHarness(localhostHarness);
      }
      rmSync(socketTempDir, { recursive: true, force: true });
    }
  });
});

describe('Garden operator surface', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await destroyHarness(harness);
  });

  it('keeps Garden UI off the private transport while serving canonical admin API routes', async () => {
    const dashboardRes = await requestSocket(harness.socketPath, 'GET', '/api/admin/dashboard');
    expect(dashboardRes.status).toBe(200);
    const payload = JSON.parse(dashboardRes.body) as { stats: { sessionCount: number } };
    expect(payload.stats.sessionCount).toBeTypeOf('number');

    const uiRes = await requestSocket(harness.socketPath, 'GET', '/memory');
    expect(uiRes.status).toBe(404);
  });

  it('proxies admin API routes through the operator surface', async () => {
    const res = await requestPort(harness.port, 'GET', '/api/admin/dashboard');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { stats: { sessionCount: number } };
    expect(payload.stats.sessionCount).toBeTypeOf('number');
  });

  it('proxies GET, POST, health, and telemetry over an explicit mTLS HTTPS/WSS admin transport', async () => {
    let networkHarness: Harness | undefined;
    try {
      networkHarness = await createHarness({ transportMode: 'network-mtls' });

      const healthRes = await requestPort(networkHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(200);
      expect(JSON.parse(healthRes.body)).toEqual({
        status: 'ok',
        uptime: expect.any(Number),
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: true,
            status: 'ok',
            httpStatus: 200,
          },
        },
      });

      const getRes = await requestPort(networkHarness.port, 'GET', '/api/admin/dashboard');
      expect(getRes.status).toBe(200);
      expect(JSON.parse(getRes.body)).toMatchObject({ stats: { sessionCount: 1 } });

      const providersJson = JSON.stringify({ schemaVersion: 1, providers: [] });
      const postRes = await requestPort(
        networkHarness.port,
        'POST',
        '/api/admin/settings/providers',
        new URLSearchParams({ configJson: providersJson }).toString(),
        { 'content-type': 'application/x-www-form-urlencoded' },
      );
      expect(postRes.status).toBe(200);
      expect(postRes.body).toBe('providers.json saved');
      expect(networkHarness.services.settings.saveSubConfigJson).toHaveBeenCalledWith(
        'providers',
        providersJson,
      );

      const ws = await openWebSocket(networkHarness.port, '/api/admin/events');
      const messagePromise = readWebSocketMessage<{ type: string }>(ws);
      await networkHarness.eventBus.emit('agent.turn.usage', {
        message: {
          id: 'msg-network-usage-1',
          channelId: 'test-channel',
          channelType: 'terminal',
          authorId: 'user-1',
          authorName: 'Tester',
          content: 'hello',
          timestamp: new Date(),
        },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          llmCalls: 1,
          toolCalls: 0,
          contextUtilization: 5,
          estimatedCostUsd: 0.001,
        },
      });

      expect(await messagePromise).toMatchObject({ type: 'agent.turn.usage' });
      ws.close();
    } finally {
      if (networkHarness) {
        await destroyHarness(networkHarness);
      }
    }
  });

  it('requires a Garden client certificate with the expected SPIFFE URI before route handling', async () => {
    let networkHarness: Harness | undefined;
    try {
      networkHarness = await createHarness({ transportMode: 'network-mtls' });
      if (!networkHarness.transportPort || !networkHarness.tlsFixture) {
        throw new Error('Expected network transport fixture');
      }

      const getDashboardData = vi.mocked(networkHarness.services.dashboard.getDashboardData);
      getDashboardData.mockClear();

      await expect(requestTransportPortWithoutClientCertificate(
        networkHarness.transportPort,
        networkHarness.tlsFixture.clientTls,
      )).rejects.toThrow();
      expect(getDashboardData).not.toHaveBeenCalled();

      const missingSpiffeRes = await requestTransportPort(
        networkHarness.transportPort,
        'GET',
        '/api/admin/dashboard',
        networkHarness.tlsFixture.clientWithoutSpiffeTls,
      );
      expect(missingSpiffeRes.status).toBe(403);
      expect(getDashboardData).not.toHaveBeenCalled();

      const wrongSpiffeRes = await requestTransportPort(
        networkHarness.transportPort,
        'GET',
        '/api/admin/dashboard',
        networkHarness.tlsFixture.clientWrongSpiffeTls,
      );
      expect(wrongSpiffeRes.status).toBe(403);
      expect(getDashboardData).not.toHaveBeenCalled();
    } finally {
      if (networkHarness) {
        await destroyHarness(networkHarness);
      }
    }
  });

  it('rejects agent server certificates missing the expected SPIFFE URI SAN', async () => {
    let networkHarness: Harness | undefined;
    try {
      networkHarness = await createHarness({
        transportMode: 'network-mtls',
        serverIdentity: 'missing-spiffe',
        timeoutMs: 250,
      });

      const healthRes = await requestPort(networkHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(503);
      expect(JSON.parse(healthRes.body)).toMatchObject({
        status: 'degraded',
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: false,
            status: 'degraded',
            error: expect.stringContaining('missing SPIFFE URI SAN'),
          },
        },
      });

      const proxyRes = await requestPort(networkHarness.port, 'GET', '/api/admin/dashboard');
      expect(proxyRes.status).toBe(502);
      expect(proxyRes.body).toContain('admin transport unavailable');
    } finally {
      if (networkHarness) {
        await destroyHarness(networkHarness);
      }
    }
  });

  it('proxies persisted model usage routes through the operator surface', async () => {
    const res = await requestPort(harness.port, 'GET', '/api/admin/model-usage?limit=5&sinceMs=100');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { totals: { totalTokens: number }; query: { limit?: number; sinceMs?: number } };
    expect(payload.totals.totalTokens).toBe(15);
    expect(payload.query).toMatchObject({ limit: 5, sinceMs: 100 });
  });

  it('proxies observer eval sidecar health through the operator surface', async () => {
    const res = await requestPort(harness.port, 'GET', '/api/admin/evals/observer-sidecar/health');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { status: string; persistence: { available: boolean } };
    expect(payload.status).toBe('disabled');
    expect(payload.persistence.available).toBe(false);
  });

  it('proxies canonical admin settings owner-file routes through the operator surface', async () => {
    const canonicalRes = await requestPort(harness.port, 'GET', '/api/admin/settings/providers');
    expect(canonicalRes.status).toBe(200);
    expect(JSON.parse(canonicalRes.body)).toEqual({
      schemaVersion: 1,
      providers: [
        {
          id: 'litellm',
          type: 'litellm_proxy',
          enabled: true,
          apiBaseUrl: 'http://localhost:4000/v1',
          apiKeyRef: { kind: 'env', envName: 'LITELLM_API_KEY' },
        },
      ],
    });

    const staleRes = await requestPort(harness.port, 'GET', '/api/settings/providers');
    expect(staleRes.status).toBe(404);
  });

  it('reports degraded health when the admin transport is unreachable', async () => {
    await harness.transportServer.stop();
    harness.transportStopped = true;

    const res = await requestPort(harness.port, 'GET', '/health');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      status: 'degraded',
      uptime: expect.any(Number),
      dependencies: {
        adminTransport: expect.objectContaining({
          mode: 'socket',
          reachable: false,
          status: 'degraded',
          error: expect.any(String),
        }),
      },
    });
  });

  it('returns clear 404 or 502 responses for wrong paths and closed network upstreams', async () => {
    const missingRes = await requestPort(harness.port, 'GET', '/api/admin/not-a-route');
    expect(missingRes.status).toBe(404);
    expect(missingRes.body).toContain('Not found: /api/admin/not-a-route');

    await expect(openWebSocketExpectStatus(harness.port, '/api/admin/events/not-a-route'))
      .resolves.toBe(404);

    let networkHarness: Harness | undefined;
    try {
      networkHarness = await createHarness({ transportMode: 'network-mtls', timeoutMs: 250 });
      await networkHarness.transportServer.stop();
      networkHarness.transportStopped = true;

      const proxyRes = await requestPort(networkHarness.port, 'GET', '/api/admin/dashboard');
      expect(proxyRes.status).toBe(502);
      expect(proxyRes.body).toContain('admin transport unavailable');

      const healthRes = await requestPort(networkHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(503);
      expect(JSON.parse(healthRes.body)).toMatchObject({
        status: 'degraded',
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: false,
            status: 'degraded',
          },
        },
      });
    } finally {
      if (networkHarness) {
        await destroyHarness(networkHarness);
      }
    }
  });

  it('reports degraded health and returns 502 when the upstream network endpoint serves the wrong path', async () => {
    const upstreamPort = await allocatePort();
    const upstreamTempDir = mkdtempSync(join(tmpdir(), 'garden-operator-upstream-test-'));
    const tlsFixture = createAdminTransportTlsFixture(upstreamTempDir);
    let wrongPathServer: https.Server | undefined;
    let operatorHarness: OperatorOnlyHarness | undefined;
    try {
      wrongPathServer = await listenHttpsPortServer(upstreamPort, tlsFixture.serverTls, (_req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('wrong admin transport path');
      });
      wrongPathServer.on('upgrade', (_req, socket) => {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      });
      operatorHarness = await createOperatorOnlyHarness(
        createNetworkClientEndpoint(upstreamPort, 250, tlsFixture.clientTls),
      );

      const healthRes = await requestPort(operatorHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(503);
      expect(JSON.parse(healthRes.body)).toMatchObject({
        status: 'degraded',
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: true,
            status: 'degraded',
            httpStatus: 404,
          },
        },
      });

      await expect(openWebSocketExpectStatus(operatorHarness.port, '/api/admin/events'))
        .resolves.toBe(502);
    } finally {
      if (operatorHarness) {
        await destroyOperatorOnlyHarness(operatorHarness);
      }
      if (wrongPathServer) {
        await closeServer(wrongPathServer);
      }
      rmSync(upstreamTempDir, { recursive: true, force: true });
    }
  });

  it('returns 502 and degraded health when the network upstream times out', async () => {
    const slowPort = await allocatePort();
    const upstreamTempDir = mkdtempSync(join(tmpdir(), 'garden-operator-upstream-test-'));
    const tlsFixture = createAdminTransportTlsFixture(upstreamTempDir);
    let slowServer: https.Server | undefined;
    let operatorHarness: OperatorOnlyHarness | undefined;
    try {
      slowServer = await listenHttpsPortServer(slowPort, tlsFixture.serverTls, () => undefined);
      operatorHarness = await createOperatorOnlyHarness(
        createNetworkClientEndpoint(slowPort, 100, tlsFixture.clientTls),
      );

      const proxyRes = await requestPort(operatorHarness.port, 'GET', '/api/admin/dashboard');
      expect(proxyRes.status).toBe(502);
      expect(proxyRes.body).toContain('admin transport timed out');

      const healthRes = await requestPort(operatorHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(503);
      expect(JSON.parse(healthRes.body)).toMatchObject({
        status: 'degraded',
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: false,
            status: 'degraded',
            error: expect.stringContaining('timed out'),
          },
        },
      });
    } finally {
      if (operatorHarness) {
        await destroyOperatorOnlyHarness(operatorHarness);
      }
      if (slowServer) {
        await closeServer(slowServer);
      }
      rmSync(upstreamTempDir, { recursive: true, force: true });
    }
  });

  it('reports degraded health when the admin transport probe reports an error', async () => {
    await harness.transportServer.stop();
    harness.transportStopped = true;

    const unhealthyTransport = await listenSocketServer(harness.socketPath, (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'transport unavailable' }));
    });

    try {
      const res = await requestPort(harness.port, 'GET', '/health');
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body)).toEqual({
        status: 'degraded',
        uptime: expect.any(Number),
        dependencies: {
          adminTransport: {
            mode: 'socket',
            reachable: true,
            status: 'degraded',
            httpStatus: 503,
            error: 'transport unavailable',
          },
        },
      });
    } finally {
      await closeServer(unhealthyTransport);
      rmSync(harness.socketPath, { force: true });
    }
  });

  it('reports healthy transport status in operator health', async () => {
    const res = await requestPort(harness.port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'ok',
      uptime: expect.any(Number),
      dependencies: {
        adminTransport: {
          mode: 'socket',
          reachable: true,
          status: 'ok',
          httpStatus: 200,
        },
      },
    });
  });

  it('bridges telemetry websocket events through the operator surface', async () => {
    const ws = await openWebSocket(harness.port, '/api/admin/events');
    const messagePromise = readWebSocketMessage<{ type: string }>(ws);

    await harness.eventBus.emit('agent.turn.usage', {
      message: {
        id: 'msg-usage-1',
        channelId: 'test-channel',
        channelType: 'terminal',
        authorId: 'user-1',
        authorName: 'Tester',
        content: 'hello',
        timestamp: new Date(),
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        llmCalls: 1,
        toolCalls: 0,
        contextUtilization: 5,
        estimatedCostUsd: 0.001,
      },
    });

    const telemetry = await messagePromise;
    expect(telemetry.type).toBe('agent.turn.usage');
    ws.close();
  });
});
