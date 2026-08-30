/**
 * Fleet Garden cutover certification (psfn-framework-mus2.15).
 *
 * Exercises the assembled PRODUCTION control-plane composition end to end,
 * with no test doubles on the certified chain:
 *
 *   GatewayFleetSsoRouter (real edge routing, signing, replay)
 *     -> one fleet GardenOperatorSurface (real FleetGardenControlPlane over the
 *        registry produced by the production local fleet resolver)
 *     -> real FleetGardenAdminTransportProxy over per-companion unix sockets
 *     -> real GardenAdminTransportServer per companion agent
 *     -> real in-process Garden admin services over real owner files on disk.
 *
 * The operator->agent child-assertion exchange uses the production client and
 * the production gateway broker/HTTP route, served in-test by a real HTTP
 * server. Only session authentication (cookie -> authorization context) is
 * provided by the test, mirroring the existing unified-origin E2E suite; the
 * session broker itself is certified by the fleet-auth suites.
 *
 * Certified here because no per-bead test could prove the composite:
 * multi-companion concurrency/isolation, denial indistinguishability, outage
 * without fallback, canonical owner mutation through the full chain,
 * capability replay/expiry/digest-mismatch at the Garden origin, WebSocket
 * switching and revocation, and redeploy (pinned rollback posture) without
 * owner-data movement.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../../boundary/fleet-auth/request-capability.js';
import { compileGatewayGardenRequestTarget } from '../../boundary/fleet-auth/request-capability-target.js';
import { resolveFleetSsoGardenUpstreams } from '../../boundary/fleet-auth/fleet-sso-transport.js';
import { GatewayFleetSsoRouter } from '../../boundary/gateway/fleet-sso-router.js';
import type { FleetAuthorizationContext } from '../../boundary/gateway/fleet-authorization-context.js';
import { GatewayFleetAuthChildAssertionBroker } from '../../boundary/gateway/fleet-auth-child-assertions.js';
import { FleetAuthChildAssertionHttpRoute } from '../../channels/api/server/fleet-auth-child-assertion-route.js';
import { EventBus } from '../../shared/event-bus.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { isRecord } from '../../shared/utils/types.js';
import { FleetGardenControlPlane } from '../../operator/garden/fleet-garden-control-plane.js';
import { AtomicRequestCapabilityReplayPort } from '../../operator/garden/atomic-request-capability-replay.js';
import { GardenOperatorSurface } from '../../operator/garden/operator-surface.js';
import { GardenAdminTransportServer } from '../../operator/garden/transport-server.js';
import { createGardenFleetChildAssertionClient } from '../../operator/garden/fleet-child-assertion-client.js';
import { createInProcessGardenAdminContract } from '../../operator/garden/local-admin-contract.js';
import { resolveCompanionAdminTransportSocketPath } from '../../operator/garden/transport-paths.js';
import { buildGardenCapabilityHeaders } from '../../operator/garden/garden-admission.js';
import { createPromptStatePort } from '../../core/identity/prompt-state-port.js';
import { InMemoryMemoryStore } from '../../test-support/in-memory-memory-store.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../../core/session/manager.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { ShardManager } from '../../faculties/shards/manager.js';
import { saveModelsConfig } from '../../system/config/models-config.js';
import { resetRuntimeTrustPolicy } from '../../system/trust/runtime-policy.js';
import { ValuesJournalStore } from '../../faculties/values/store.js';
import { resolveValuesJournalPath } from '../../persistence/layout.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type { FleetAuthRole } from '../../system/config/fleet-auth-config.js';
import {
  resolveConfiguredLocalCompanionFleetRuntime,
  type ConfiguredLocalCompanionFleetRuntime,
} from '../../../scripts/companion-fleet-runtime.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');
const COMPANION_C = createCompanionId('33333333-3333-4333-8333-333333333333');
const UNKNOWN_COMPANION = createCompanionId('55555555-5555-4555-8555-555555555555');
const SESSION_A = 'a'.repeat(43);
const SESSION_B = 'b'.repeat(43);
const SESSION_C = 'c'.repeat(43);
const ADMIN_TOKEN = 'fleet-cert-admin-token';
const CANONICAL_ORIGIN = 'https://fleet.example.test';
const ISSUER = 'fleet-cert-e2e';
const KID = 'cert-active';

const keyPair = generateKeyPairSync('ed25519');
const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const verifierConfig = {
  issuer: ISSUER,
  maxTtlSeconds: 30,
  keys: [{
    issuer: ISSUER,
    kid: KID,
    publicKeyPem,
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2040-01-01T00:00:00.000Z',
    status: 'active' as const,
  }],
};

function characterCard(name: string): CharacterCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: 'A certification-fixture character',
      personality: 'Deterministic',
      scenario: '',
      first_mes: '',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: ['test'],
      creator: 'certification',
    },
  };
}

function authorizationContext(
  companionId: string,
  action: FleetAuthorizationContext['authorization']['action'],
  role: FleetAuthRole = 'owner',
): FleetAuthorizationContext {
  return Object.freeze({
    principalId: companionId === COMPANION_A
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : companionId === COMPANION_B
        ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    providerSubject: Object.freeze({ provider: 'discord', subjectId: `subject-${companionId}` }),
    companionId,
    contact: Object.freeze({
      bindingId: randomUUID(),
      contactId: randomUUID(),
      bindingVersion: 1,
    }),
    operator: Object.freeze({ grantId: randomUUID(), role, grantVersion: 1 }),
    session: Object.freeze({
      recordId: companionId === COMPANION_A
        ? 'aaaaaaaa-0000-4000-8000-000000000001'
        : companionId === COMPANION_B
          ? 'bbbbbbbb-0000-4000-8000-000000000001'
          : 'cccccccc-0000-4000-8000-000000000001',
      audience: 'fleet',
      assurance: 'oauth',
      authnVersion: 1,
      authzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
      provider: 'discord',
      providerSubjectId: `subject-${companionId}`,
    }),
    authorization: Object.freeze({ action, decision: 'allow' }),
    authority: Object.freeze({ authorityGeneration: 1, globalAuthEpoch: 1 }),
    provenance: Object.freeze({
      source: 'gateway_fleet_authorization_snapshot',
      authorizationEventId: randomUUID(),
      resolvedAt: new Date().toISOString(),
    }),
  });
}

const CAPABILITY_VERSIONS = Object.freeze({
  authorityGeneration: 1,
  globalAuthEpoch: 1,
  sessionAuthnVersion: 1,
  sessionAuthzVersion: 1,
  bindingVersion: 1,
  grantVersion: 1,
  policyVersion: 1,
});

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = address;
      probe.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
    return address.port;
  });
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function edgeRequest(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  session: string,
  body?: string,
  headerOverrides: IncomingHttpHeaders = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        host: 'fleet.example.test',
        cookie: `__Host-psfn_session=${session}`,
        authorization: 'Bearer browser-credential-must-not-cross',
        'x-forwarded-host': 'fleet.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-forwarded-for': '198.51.100.9',
        ...(method === 'POST'
          ? {
              origin: CANONICAL_ORIGIN,
              'content-type': 'application/x-www-form-urlencoded',
              'content-length': String(Buffer.byteLength(body ?? '')),
            }
          : {}),
        ...headerOverrides,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function rawRequest(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...headers,
        ...(body ? { 'content-length': String(body.byteLength) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function findOwnedFile(rootDir: string, fileName: string): string {
  const matches = readdirSync(rootDir, { recursive: true })
    .map(String)
    .filter(entry => entry === fileName || entry.endsWith(`/${fileName}`))
    .map(entry => join(rootDir, entry));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${fileName} beneath ${rootDir}, found ${matches.length}`);
  }
  return matches[0];
}

interface AgentFixture {
  companionId: string;
  companionDataDir: string;
  eventBus: EventBus;
  transportServer: GardenAdminTransportServer;
  socketPath: string;
}

interface Fixture {
  root: string;
  fleetEnv: NodeJS.ProcessEnv;
  runtime: ConfiguredLocalCompanionFleetRuntime;
  agents: Map<string, AgentFixture>;
  gardenPort: number;
  surface: GardenOperatorSurface;
  gatewayApi: Server;
  edge: Server;
  edgePort: number;
  gatewayApiBase: string;
  gardenConfig: SubstrateConfig;
  servers: Server[];
  surfaces: GardenOperatorSurface[];
  revoked: Set<string>;
}

let fixture: Fixture;
let fixtureReady = false;

const signer = createGatewayRequestCapabilitySigner({
  issuer: ISSUER,
  kid: KID,
  privateKeyPem,
  ttlSeconds: 30,
});

function buildSubstrateConfig(input: {
  companionId: string;
  dataDir: string;
  characterCardPath: string;
  companionFleet?: ConfiguredLocalCompanionFleetRuntime['fleet'];
  multiCompanion?: boolean;
}): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-extract',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '123',
    companionId: input.companionId,
    gatewaySessionIntegrityAuthToken: `v1.${'b'.repeat(64)}`,
    characterCardPath: input.characterCardPath,
    dataDir: input.dataDir,
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
        defaults: { description: 'Test Model Room' },
      },
    },
    modelRoleAssignments: { chat: 'primary' },
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
    },
    ...(input.companionFleet ? { companionFleet: input.companionFleet } : {}),
    ...(input.multiCompanion ? { multiCompanion: true } : {}),
    fleetAuthVerifier: {
      kind: 'verifier' as const,
      enabled: true as const,
      canonicalOrigin: CANONICAL_ORIGIN,
      requestCapabilities: verifierConfig,
      hubDeviceAssertions: {
        issuer: 'hub',
        audience: 'fleet',
        maxTtlSeconds: 60,
        clockSkewSeconds: 2,
        keys: [],
      },
    },
  };
}

function writeModelsFixture(dataDir: string, defaultContextWindow: number): void {
  saveModelsConfig(dataDir, {
    schemaVersion: 1,
    models: [
      {
        id: 'primary',
        rank: 100,
        identity: { provider: 'test', model: 'test-model', source: { type: 'local' } },
        purposes: [
          { purpose: 'chat', primary: true },
          { purpose: 'summary', primary: true },
          { purpose: 'reasoning', primary: true },
          { purpose: 'longContext', primary: true },
          { purpose: 'vision', primary: true },
          { purpose: 'moa', primary: true },
        ],
        capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
        tuning: { maxOutputTokens: 4096 },
      },
      {
        id: 'extraction',
        rank: 80,
        identity: { provider: 'test', model: 'test-extract', source: { type: 'local' } },
        purposes: [
          { purpose: 'background', primary: true },
          { purpose: 'extraction', primary: true },
          { purpose: 'import_processing', primary: true },
        ],
        capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
        tuning: { maxOutputTokens: 2048 },
      },
    ],
  }, { defaultContextWindow });
}

async function buildAgentFixture(input: {
  companionId: string;
  companionDataDir: string;
  characterCardPath: string;
  cardName: string;
  fleetEnv: NodeJS.ProcessEnv;
}): Promise<AgentFixture> {
  mkdirSync(input.companionDataDir, { recursive: true });
  mkdirSync(dirname(input.characterCardPath), { recursive: true });
  const card = characterCard(input.cardName);
  writeFileSync(input.characterCardPath, `${JSON.stringify(card, null, 2)}\n`, 'utf-8');
  const sessionsDir = join(input.companionDataDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  // Owner files never self-seed at runtime (fail closed); deployment seeds
  // them at install time. Mirror that step for the canonical file under test.
  writeFileSync(
    join(input.companionDataDir, 'scheduler.json'),
    readFileSync(join(process.cwd(), 'config', 'scheduler.seed.json')),
  );

  const config = buildSubstrateConfig({
    companionId: input.companionId,
    dataDir: input.companionDataDir,
    characterCardPath: input.characterCardPath,
  });
  writeModelsFixture(input.companionDataDir, config.defaultContextWindow);
  const journal = new ValuesJournalStore(resolveValuesJournalPath(input.companionDataDir));
  const journalEntryCount = input.companionId === COMPANION_A ? 1 : 2;
  for (let index = 0; index < journalEntryCount; index += 1) {
    journal.append({
      templateId: 'garden-route-certification',
      templateName: 'Garden route certification',
      prompt: 'Verify exact companion journal ownership.',
      reflection: `private-${input.companionId}-${index}`,
      createdAt: `2026-08-20T12:00:0${index}.000Z`,
    });
  }

  const eventBus = new EventBus();
  const memoryStore = new InMemoryMemoryStore().asPort();
  const sessionStore = new SessionStore(sessionsDir);
  const sessionManager = new SessionManager(sessionStore, config, eventBus);
  const scheduler = new Scheduler(eventBus);
  scheduler.registerHeartbeat(() => {});
  const mockLlmProvider = { stream: vi.fn(), complete: vi.fn() } as unknown as LLMProviderPort;
  const shardManager = new ShardManager({
    snapshotParentCapabilityGrant: () => ({
      tier: 'custom',
      customTokens: ['shard.spawn'],
      grantedTokens: ['shard.spawn'],
    }),
    eventBus,
    llmProvider: mockLlmProvider,
    sessionStore,
    embeddingService: null,
    memoryProvider: null,
    config,
    parentSystemPrompt: '',
  });

  const services = createInProcessGardenAdminContract({
    env: {},
    memoryStore,
    sessionStore,
    sessionManager,
    scheduler,
    shardManager,
    eventBus,
    characterCard: card,
    config,
    embeddingService: null,
    promptState: createPromptStatePort({}),
    modelDiscovery: null,
  });

  const socketPath = resolveCompanionAdminTransportSocketPath(input.companionId, input.fleetEnv);
  const transportServer = new GardenAdminTransportServer({
    endpoint: { mode: 'socket', socketPath, timeoutMs: 5_000 },
    eventBus,
    config,
    services,
  });
  await transportServer.init();
  await transportServer.start();
  // Mirror the agent's own startup (app/agent/main.ts): semantic readiness is
  // admitted only after init, so without it the transport serves nothing but
  // the capability-tier recovery route (hrmrq.132).
  transportServer.markRuntimeReady();

  return {
    companionId: input.companionId,
    companionDataDir: input.companionDataDir,
    eventBus,
    transportServer,
    socketPath,
  };
}

function buildRouter(input: {
  gardenPort: number;
  runtime: ConfiguredLocalCompanionFleetRuntime;
  revoked: Set<string>;
}): GatewayFleetSsoRouter {
  return new GatewayFleetSsoRouter({
    canonicalOrigin: CANONICAL_ORIGIN,
    trustProxy: true,
    adminToken: ADMIN_TOKEN,
    upstreams: resolveFleetSsoGardenUpstreams({
      fleet: input.runtime.fleet,
      fleetGardenPort: input.gardenPort,
      env: {},
    }),
    broker: {
      resolveAuthorizationContext: async (brokerInput: unknown) => {
        if (!isRecord(brokerInput)
          || typeof brokerInput.sessionToken !== 'string'
          || typeof brokerInput.companionId !== 'string'
          || typeof brokerInput.action !== 'string') {
          throw new Error('denied');
        }
        const expected = brokerInput.sessionToken === SESSION_A
          ? COMPANION_A
          : brokerInput.sessionToken === SESSION_B
            ? COMPANION_B
            : brokerInput.sessionToken === SESSION_C ? COMPANION_C : undefined;
        if (!expected
          || expected !== brokerInput.companionId
          || input.revoked.has(brokerInput.sessionToken)) {
          throw new Error('denied');
        }
        return authorizationContext(
          expected,
          brokerInput.action as FleetAuthorizationContext['authorization']['action'],
        );
      },
    },
    signer,
    verifier: createRequestCapabilityVerifier(verifierConfig),
    replay: new AtomicRequestCapabilityReplayPort(),
    portalProjection: {
      resolve: async () => ({
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        session: { state: 'authenticated' },
        companions: [],
      }),
    },
  });
}

function wireEdge(router: GatewayFleetSsoRouter): Server {
  const edge = createServer((request, response) => { void router.handle(request, response); });
  edge.on('upgrade', (request, socket, head) => {
    if (router.matches(request.url ?? '/')) {
      router.handleUpgrade(request, socket, head);
      return;
    }
    socket.destroy();
  });
  return edge;
}

/** Sign an operator capability directly, as a leaked/captured token would be. */
function directCapabilityHeaders(input: {
  companionId: string;
  innerTarget: string;
  method: 'GET' | 'POST' | 'WS';
  body?: Buffer;
  ttlSeconds?: number;
  nowSeconds?: () => number;
}): Record<string, string> {
  const target = compileGatewayGardenRequestTarget({
    rawTarget: input.innerTarget,
    method: input.method,
    companionId: input.companionId,
    body: input.body ?? Buffer.alloc(0),
  });
  const requestId = randomUUID();
  const decisionId = randomUUID();
  const directSigner = createGatewayRequestCapabilitySigner({
    issuer: ISSUER,
    kid: KID,
    privateKeyPem,
    ttlSeconds: input.ttlSeconds ?? 30,
    ...(input.nowSeconds ? { nowSeconds: input.nowSeconds } : {}),
  });
  const token = directSigner.signOperator({
    target,
    requestId,
    decisionId,
    authContext: {
      principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      provider: 'discord',
      providerSubjectId: '12345678901234567',
      companionId: input.companionId,
      contactBindingId: 'binding-direct',
      contactId: 'contact-direct',
      operatorGrantId: 'grant-direct',
      role: 'admin',
      sessionRecordId: 'session-direct',
      sessionAssurance: 'oauth' as const,
      fleetAccessMode: 'multi_admin' as const,
      authorizationEventId: 'event-direct',
      resolvedAt: new Date().toISOString(),
    },
    versions: CAPABILITY_VERSIONS,
  });
  return {
    ...buildGardenCapabilityHeaders({
      token,
      context: { requestId, decisionId, versions: CAPABILITY_VERSIONS },
    }),
  };
}

function openEdgeWebSocket(
  edgePort: number,
  path: string,
  session: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${edgePort}${path}`, {
      headers: {
        host: 'fleet.example.test',
        cookie: `__Host-psfn_session=${session}`,
        origin: CANONICAL_ORIGIN,
        'x-forwarded-host': 'fleet.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-forwarded-for': '198.51.100.9',
      },
    });
    const cleanup = () => {
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('unexpected-response');
    };
    ws.once('open', () => { cleanup(); resolve(ws); });
    ws.once('error', (error) => { cleanup(); reject(error); });
    ws.once('unexpected-response', (_request, response) => {
      cleanup();
      ws.terminate();
      reject(new Error(`unexpected websocket response: ${response.statusCode}`));
    });
  });
}

function edgeWebSocketStatus(
  edgePort: number,
  path: string,
  session: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${edgePort}${path}`, {
      headers: {
        host: 'fleet.example.test',
        cookie: `__Host-psfn_session=${session}`,
        origin: CANONICAL_ORIGIN,
        'x-forwarded-host': 'fleet.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-forwarded-for': '198.51.100.9',
      },
    });
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('websocket unexpectedly connected'));
    });
    ws.once('unexpected-response', (_request, response) => {
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.once('error', () => {
      resolve(0);
    });
  });
}

function nextWebSocketMessage<T>(ws: WebSocket, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for websocket message')),
      timeoutMs,
    );
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

async function emitUsageTelemetry(eventBus: EventBus, marker: string): Promise<void> {
  await eventBus.emit('agent.turn.usage', {
    message: {
      id: marker,
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
}

const SCHEDULER_PATH = (companionId: string) =>
  `/companions/${companionId}/garden/api/admin/settings/scheduler`;

async function readScheduler(companionId: string, session: string): Promise<HttpResult> {
  return edgeRequest(fixture.edgePort, 'GET', SCHEDULER_PATH(companionId), session);
}

async function writeScheduler(
  companionId: string,
  session: string,
  configJson: string,
): Promise<HttpResult> {
  return edgeRequest(
    fixture.edgePort,
    'POST',
    SCHEDULER_PATH(companionId),
    session,
    `configJson=${encodeURIComponent(configJson)}`,
  );
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-cert-'));
  const systemDataDir = join(root, 'system-data');
  const companionDataDir = join(root, 'companion-data');
  const runDir = join(root, 'run');
  mkdirSync(systemDataDir, { recursive: true });
  mkdirSync(companionDataDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify({
    postgres: {
      sharedMigrationRole: 'shared_schema_migration',
      sharedMigrationDatabaseUrlRef: {
        kind: 'env',
        envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
      },
    },
    companions: [
      {
        companionId: COMPANION_A,
        companionDataDir: 'companions/alpha',
        characterCardPath: 'companions/alpha/character-card.json',
        postgresSchema: 'companion_alpha',
        postgresRole: 'companion_alpha_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_ALPHA_DATABASE_URL' },
      },
      {
        companionId: COMPANION_B,
        companionDataDir: 'companions/beta',
        characterCardPath: 'companions/beta/character-card.json',
        postgresSchema: 'companion_beta',
        postgresRole: 'companion_beta_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_BETA_DATABASE_URL' },
      },
      {
        companionId: COMPANION_C,
        companionDataDir: 'companions/gamma',
        characterCardPath: 'companions/gamma/character-card.json',
        postgresSchema: 'companion_gamma',
        postgresRole: 'companion_gamma_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_GAMMA_DATABASE_URL' },
      },
    ],
  })}\n`);

  const fleetEnv: NodeJS.ProcessEnv = {
    PSFN_MULTI_COMPANION: '1',
    PSFN_FLEET_AUTH: '1',
    PSFN_RUNTIME_ROOT: root,
    SYSTEM_DATA_DIR: systemDataDir,
    COMPANION_DATA_DIR: companionDataDir,
    ADMIN_TRANSPORT_SOCKET: join(runDir, 'garden-admin.sock'),
  };

  // Production local fleet resolver: companions.json -> immutable target
  // registry with one garden-admin-<companionId>.sock endpoint per agent.
  const runtime = resolveConfiguredLocalCompanionFleetRuntime(fleetEnv);

  const agents = new Map<string, AgentFixture>();
  for (const entry of runtime.fleet.companions) {
    agents.set(entry.companionId, await buildAgentFixture({
      companionId: entry.companionId,
      companionDataDir: entry.companionDataDir,
      characterCardPath: entry.characterCardPath,
      cardName: entry.companionId === COMPANION_A
        ? 'Cert Alpha'
        : entry.companionId === COMPANION_B ? 'Cert Beta' : 'Cert Gamma',
      fleetEnv,
    }));
  }

  // Production gateway child-assertion exchange: real broker + real HTTP route.
  const childAssertionBroker = new GatewayFleetAuthChildAssertionBroker({
    verifier: createRequestCapabilityVerifier(verifierConfig),
    signer,
    replay: new AtomicRequestCapabilityReplayPort(),
    authority: {
      reauthorize: async (input) => ({
        decision: 'allow',
        decisionId: randomUUID(),
        versions: input.parent.versions,
      }),
    },
  });
  const childAssertionRoute = new FleetAuthChildAssertionHttpRoute(childAssertionBroker);
  const gatewayApi = createServer((request, response) => {
    if (childAssertionRoute.matches(request.method, request.url ?? '')) {
      void childAssertionRoute.handle(request, response);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const gatewayApiPort = await listen(gatewayApi);
  const gatewayApiBase = `http://127.0.0.1:${gatewayApiPort}/v1`;

  // The one fleet Garden, exactly as src/app/operator/main.ts composes it.
  const gardenDataDir = join(root, 'garden-data');
  mkdirSync(join(gardenDataDir, 'sessions'), { recursive: true });
  const gardenCardPath = join(gardenDataDir, 'character.json');
  writeFileSync(gardenCardPath, '{}\n', 'utf-8');
  const gardenConfig = buildSubstrateConfig({
    companionId: COMPANION_A,
    dataDir: gardenDataDir,
    characterCardPath: gardenCardPath,
    companionFleet: runtime.fleet,
    multiCompanion: true,
  });
  const controlPlane = new FleetGardenControlPlane({
    registry: runtime.targetRegistry,
    verifier: createRequestCapabilityVerifier(verifierConfig),
    replay: new AtomicRequestCapabilityReplayPort(),
  });
  const gardenPort = await allocatePort();
  const surface = new GardenOperatorSurface({
    port: gardenPort,
    host: '127.0.0.1',
    allowInsecureWithoutToken: true,
    config: gardenConfig,
    fleetControlPlane: controlPlane,
    fleetChildAssertions: createGardenFleetChildAssertionClient(gatewayApiBase),
  });
  await surface.init();
  await surface.start();

  // Gateway edge: the production router with every companion mapped to the ONE
  // fleet Garden origin (resolveFleetSsoGardenUpstreams, loopback plain HTTP).
  const revoked = new Set<string>();
  const router = buildRouter({ gardenPort, runtime, revoked });
  const edge = wireEdge(router);
  const edgePort = await listen(edge);

  fixture = {
    root,
    fleetEnv,
    runtime,
    agents,
    gardenPort,
    surface,
    gatewayApi,
    edge,
    edgePort,
    gatewayApiBase,
    gardenConfig,
    servers: [gatewayApi, edge],
    surfaces: [surface],
    revoked,
  };
  fixtureReady = true;
}, 60_000);

afterAll(async () => {
  if (!fixtureReady) {
    resetRuntimeTrustPolicy();
    return;
  }
  await Promise.all(fixture.servers.map(server => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const surface of fixture.surfaces) {
    await surface.stop().catch(() => {});
  }
  for (const agent of fixture.agents.values()) {
    await agent.transportServer.stop().catch(() => {});
  }
  rmSync(fixture.root, { recursive: true, force: true });
  resetRuntimeTrustPolicy();
}, 30_000);

describe('fleet Garden cutover certification: assembled production composition', () => {
  it('resolves a one-Garden local topology: every companion routes to the same origin', () => {
    const upstreams = resolveFleetSsoGardenUpstreams({
      fleet: fixture.runtime.fleet,
      fleetGardenPort: fixture.gardenPort,
      env: {},
    });
    expect(upstreams.map(upstream => upstream.companionId).sort()).toEqual(
      [COMPANION_A, COMPANION_B, COMPANION_C].sort(),
    );
    const origins = new Set(upstreams.map(upstream => upstream.origin.href));
    expect(origins.size).toBe(1);
    expect(fixture.runtime.targetRegistry.companionIds()).toEqual([
      COMPANION_A,
      COMPANION_B,
      COMPANION_C,
    ]);
  });

  it('fails closed at the dark Garden origin: no gateway capability, no admin access', async () => {
    const bare = await rawRequest(
      fixture.gardenPort,
      'GET',
      `/companions/${COMPANION_A}/garden/api/admin/settings/scheduler`,
      { host: '127.0.0.1' },
    );
    expect(bare.status).toBeGreaterThanOrEqual(400);
    expect(bare.body).not.toContain('backgroundMaintenance');
  });

  it('serves the adaptive tool catalog through an ADMIN_TOKEN-derived child capability', async () => {
    const response = await rawRequest(
      fixture.edgePort,
      'GET',
      `/companions/${COMPANION_A}/garden/api/admin/tools/adaptive`,
      {
        host: 'fleet.example.test',
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'x-forwarded-host': 'fleet.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-forwarded-for': '198.51.100.9',
      },
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      serviceHealth: [],
      toolHealth: [],
      inventory: [],
    });
    expect(response.body).not.toContain(ADMIN_TOKEN);
  });

  it('serves live subsystem, observer, and journal status from the exact selected companion', async () => {
    const endpoints = [
      '/api/admin/subsystem-health',
      '/api/admin/evals/observer-sidecar/health',
      '/api/admin/values/status',
    ] as const;
    const read = (companionId: string, session: string, endpoint: string) => edgeRequest(
      fixture.edgePort,
      'GET',
      `/companions/${companionId}/garden${endpoint}`,
      session,
    );
    const [subsystemA, observerA, journalA, subsystemB, observerB, journalB] = await Promise.all([
      ...endpoints.map(endpoint => read(COMPANION_A, SESSION_A, endpoint)),
      ...endpoints.map(endpoint => read(COMPANION_B, SESSION_B, endpoint)),
    ]);

    for (const response of [subsystemA, observerA, journalA, subsystemB, observerB, journalB]) {
      expect(response.status).toBe(200);
    }
    expect(subsystemA.headers['cache-control']).toBe('private, no-cache');
    expect(subsystemB.headers['cache-control']).toBe('private, no-cache');
    for (const response of [observerA, journalA, observerB, journalB]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(JSON.parse(observerA.body)).toHaveProperty('status');
    expect(JSON.parse(observerB.body)).toHaveProperty('status');
    expect(JSON.parse(journalA.body).streams.values.count).toBe(1);
    expect(JSON.parse(journalB.body).streams.values.count).toBe(2);
    expect(journalA.body).not.toContain(`private-${COMPANION_A}`);
    expect(journalB.body).not.toContain(`private-${COMPANION_B}`);
  });

  it('mutates the canonical owner file of exactly the selected companion', async () => {
    const initialA = await readScheduler(COMPANION_A, SESSION_A);
    const initialB = await readScheduler(COMPANION_B, SESSION_B);
    // eslint-disable-next-line no-console
    console.log('DEBUG edge GET', initialA.status, initialA.body.slice(0, 300));
    expect(initialA.status).toBe(200);
    expect(initialB.status).toBe(200);

    const schedulerA = JSON.parse(initialA.body) as {
      backgroundMaintenance: { intervalMs: number };
    };
    const schedulerB = JSON.parse(initialB.body) as {
      backgroundMaintenance: { intervalMs: number };
    };
    schedulerA.backgroundMaintenance.intervalMs = 111_000;
    schedulerB.backgroundMaintenance.intervalMs = 222_000;

    const writeA = await writeScheduler(COMPANION_A, SESSION_A, JSON.stringify(schedulerA));
    expect(writeA.status).toBe(200);
    const writeB = await writeScheduler(COMPANION_B, SESSION_B, JSON.stringify(schedulerB));
    expect(writeB.status).toBe(200);

    const agentA = fixture.agents.get(COMPANION_A)!;
    const agentB = fixture.agents.get(COMPANION_B)!;
    const fileA = findOwnedFile(agentA.companionDataDir, 'scheduler.json');
    const fileB = findOwnedFile(agentB.companionDataDir, 'scheduler.json');
    expect(readFileSync(fileA, 'utf-8')).toContain('111000');
    expect(readFileSync(fileA, 'utf-8')).not.toContain('222000');
    expect(readFileSync(fileB, 'utf-8')).toContain('222000');
    expect(readFileSync(fileB, 'utf-8')).not.toContain('111000');
  });

  it('serves concurrent two-companion requests without crossing data', async () => {
    const rounds = 6;
    const requests: Promise<{ companionId: string; result: HttpResult }>[] = [];
    for (let index = 0; index < rounds; index += 1) {
      requests.push(readScheduler(COMPANION_A, SESSION_A)
        .then(result => ({ companionId: COMPANION_A as string, result })));
      requests.push(readScheduler(COMPANION_B, SESSION_B)
        .then(result => ({ companionId: COMPANION_B as string, result })));
    }
    const results = await Promise.all(requests);
    for (const { companionId, result } of results) {
      expect(result.status).toBe(200);
      const scheduler = JSON.parse(result.body) as {
        backgroundMaintenance: { intervalMs: number };
      };
      expect(scheduler.backgroundMaintenance.intervalMs).toBe(
        companionId === COMPANION_A ? 111_000 : 222_000,
      );
    }
  });

  it('keeps an unauthorized companion indistinguishable from an unknown one', async () => {
    const denied = await readScheduler(COMPANION_B, SESSION_A);
    const unknown = await readScheduler(UNKNOWN_COMPANION, SESSION_A);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.status).toBe(unknown.status);
    expect(denied.body).toBe(unknown.body);
    expect(denied.body).not.toContain('222000');
  });

  it('rejects a leaked capability whose companion binding mismatches the route', async () => {
    const headers = directCapabilityHeaders({
      companionId: COMPANION_A,
      innerTarget: '/api/admin/settings/scheduler',
      method: 'GET',
    });
    const crossed = await rawRequest(
      fixture.gardenPort,
      'GET',
      `/companions/${COMPANION_B}/garden/api/admin/settings/scheduler`,
      { host: '127.0.0.1', ...headers },
    );
    expect(crossed.status).toBeGreaterThanOrEqual(400);
    expect(crossed.body).not.toContain('222000');
  });

  it('consumes a capability exactly once: replaying the same token fails closed', async () => {
    const headers = directCapabilityHeaders({
      companionId: COMPANION_A,
      innerTarget: '/api/admin/settings/scheduler',
      method: 'GET',
    });
    const first = await rawRequest(
      fixture.gardenPort,
      'GET',
      `/companions/${COMPANION_A}/garden/api/admin/settings/scheduler`,
      { host: '127.0.0.1', ...headers },
    );
    expect(first.status).toBe(200);
    expect(first.body).toContain('111000');

    const replayed = await rawRequest(
      fixture.gardenPort,
      'GET',
      `/companions/${COMPANION_A}/garden/api/admin/settings/scheduler`,
      { host: '127.0.0.1', ...headers },
    );
    expect(replayed.status).toBeGreaterThanOrEqual(400);
    expect(replayed.body).not.toContain('111000');
  });

  it('rejects an expired capability grant fail-closed', async () => {
    const headers = directCapabilityHeaders({
      companionId: COMPANION_A,
      innerTarget: '/api/admin/settings/scheduler',
      method: 'GET',
      ttlSeconds: 5,
      nowSeconds: () => Math.floor(Date.now() / 1_000) - 120,
    });
    const expired = await rawRequest(
      fixture.gardenPort,
      'GET',
      `/companions/${COMPANION_A}/garden/api/admin/settings/scheduler`,
      { host: '127.0.0.1', ...headers },
    );
    expect(expired.status).toBeGreaterThanOrEqual(400);
    expect(expired.body).not.toContain('111000');
  });

  it('rejects a digest mismatch between the signed target and the delivered body', async () => {
    const signedBody = Buffer.from('configJson=%7B%7D', 'utf-8');
    const tamperedBody = Buffer.from('configJson=%7B%22tampered%22%3Atrue%7D', 'utf-8');
    const headers = directCapabilityHeaders({
      companionId: COMPANION_A,
      innerTarget: '/api/admin/settings/scheduler',
      method: 'POST',
      body: signedBody,
    });
    const beforeFile = readFileSync(
      findOwnedFile(fixture.agents.get(COMPANION_A)!.companionDataDir, 'scheduler.json'),
      'utf-8',
    );
    const tampered = await rawRequest(
      fixture.gardenPort,
      'POST',
      `/companions/${COMPANION_A}/garden/api/admin/settings/scheduler`,
      {
        host: '127.0.0.1',
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      tamperedBody,
    );
    expect(tampered.status).toBeGreaterThanOrEqual(400);
    const afterFile = readFileSync(
      findOwnedFile(fixture.agents.get(COMPANION_A)!.companionDataDir, 'scheduler.json'),
      'utf-8',
    );
    expect(afterFile).toBe(beforeFile);
  });

  it('keeps three concurrent Prompt Loom streams companion-scoped through production routing', async () => {
    const wsA = await openEdgeWebSocket(
      fixture.edgePort,
      `/companions/${COMPANION_A}/garden/api/admin/events`,
      SESSION_A,
    );
    const wsB = await openEdgeWebSocket(
      fixture.edgePort,
      `/companions/${COMPANION_B}/garden/api/admin/events`,
      SESSION_B,
    );
    const wsC = await openEdgeWebSocket(
      fixture.edgePort,
      `/companions/${COMPANION_C}/garden/api/admin/events`,
      SESSION_C,
    );
    try {
      const observedMarkers = new Map<WebSocket, string[]>([
        [wsA, []],
        [wsB, []],
        [wsC, []],
      ]);
      for (const [ws, markers] of observedMarkers) {
        ws.on('message', (raw: WebSocket.RawData) => {
          const telemetry = JSON.parse(raw.toString()) as {
            type: string;
            data?: { message?: { id?: string } };
          };
          if (telemetry.type === 'agent.turn.usage' && telemetry.data?.message?.id) {
            markers.push(telemetry.data.message.id);
          }
        });
      }
      const receivedA = nextWebSocketMessage<{
        type: string;
        data: { message: { id: string } };
      }>(wsA);
      const receivedB = nextWebSocketMessage<{
        type: string;
        data: { message: { id: string } };
      }>(wsB);
      const receivedC = nextWebSocketMessage<{
        type: string;
        data: { message: { id: string } };
      }>(wsC);

      await Promise.all([
        emitUsageTelemetry(fixture.agents.get(COMPANION_A)!.eventBus, 'usage-alpha-1'),
        emitUsageTelemetry(fixture.agents.get(COMPANION_B)!.eventBus, 'usage-beta-1'),
        emitUsageTelemetry(fixture.agents.get(COMPANION_C)!.eventBus, 'usage-gamma-1'),
      ]);

      const [telemetryA, telemetryB, telemetryC] = await Promise.all([
        receivedA,
        receivedB,
        receivedC,
      ]);
      expect(telemetryA).toMatchObject({
        type: 'agent.turn.usage',
        data: { message: { id: 'usage-alpha-1' } },
      });
      expect(telemetryB).toMatchObject({
        type: 'agent.turn.usage',
        data: { message: { id: 'usage-beta-1' } },
      });
      expect(telemetryC).toMatchObject({
        type: 'agent.turn.usage',
        data: { message: { id: 'usage-gamma-1' } },
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(observedMarkers.get(wsA)).toEqual(['usage-alpha-1']);
      expect(observedMarkers.get(wsB)).toEqual(['usage-beta-1']);
      expect(observedMarkers.get(wsC)).toEqual(['usage-gamma-1']);

      // Revocation: the same session that just switched streams can no longer
      // open a new one once the gateway denies it.
      fixture.revoked.add(SESSION_A);
      const deniedStatus = await edgeWebSocketStatus(
        fixture.edgePort,
        `/companions/${COMPANION_A}/garden/api/admin/events`,
        SESSION_A,
      );
      expect(deniedStatus).toBeGreaterThanOrEqual(400);
    } finally {
      fixture.revoked.delete(SESSION_A);
      wsA.terminate();
      wsB.terminate();
      wsC.terminate();
    }
  });

  it('fails closed on a companion outage without falling back to another companion', async () => {
    const agentB = fixture.agents.get(COMPANION_B)!;
    await agentB.transportServer.stop();

    const outage = await readScheduler(COMPANION_B, SESSION_B);
    expect(outage.status).toBeGreaterThanOrEqual(500);
    expect(outage.body).not.toContain('111000');
    expect(outage.body).not.toContain('222000');

    const healthy = await readScheduler(COMPANION_A, SESSION_A);
    expect(healthy.status).toBe(200);
    expect(JSON.parse(healthy.body).backgroundMaintenance.intervalMs).toBe(111_000);
  });

  it('redeploys the fleet Garden (pinned rollback posture) with unchanged public routes and untouched owner data', async () => {
    const agentA = fixture.agents.get(COMPANION_A)!;
    const ownerFile = findOwnedFile(agentA.companionDataDir, 'scheduler.json');
    const ownerBytesBefore = readFileSync(ownerFile, 'utf-8');

    // Stop the current Garden revision entirely (no dual topology).
    await fixture.surface.stop();

    // Bring up the replacement revision from the same immutable registry and
    // owner files, then atomically swap the gateway upstream map to it. The
    // canonical public URL space is identical before and after.
    const controlPlane = new FleetGardenControlPlane({
      registry: fixture.runtime.targetRegistry,
      verifier: createRequestCapabilityVerifier(verifierConfig),
      replay: new AtomicRequestCapabilityReplayPort(),
    });
    const newGardenPort = await allocatePort();
    const newSurface = new GardenOperatorSurface({
      port: newGardenPort,
      host: '127.0.0.1',
      allowInsecureWithoutToken: true,
      config: fixture.gardenConfig,
      fleetControlPlane: controlPlane,
      fleetChildAssertions: createGardenFleetChildAssertionClient(fixture.gatewayApiBase),
    });
    await newSurface.init();
    await newSurface.start();
    fixture.surfaces.push(newSurface);

    const newRouter = buildRouter({
      gardenPort: newGardenPort,
      runtime: fixture.runtime,
      revoked: fixture.revoked,
    });
    const newEdge = wireEdge(newRouter);
    const newEdgePort = await listen(newEdge);
    fixture.servers.push(newEdge);

    const sameUrl = SCHEDULER_PATH(COMPANION_A);
    const afterCutover = await edgeRequest(newEdgePort, 'GET', sameUrl, SESSION_A);
    expect(afterCutover.status).toBe(200);
    expect(JSON.parse(afterCutover.body).backgroundMaintenance.intervalMs).toBe(111_000);

    for (const endpoint of [
      '/api/admin/subsystem-health',
      '/api/admin/evals/observer-sidecar/health',
      '/api/admin/values/status',
    ]) {
      const restored = await edgeRequest(
        newEdgePort,
        'GET',
        `/companions/${COMPANION_A}/garden${endpoint}`,
        SESSION_A,
      );
      expect(restored.status).toBe(200);
    }

    // Topology swap moved no owner data and rewrote no owner files.
    expect(readFileSync(ownerFile, 'utf-8')).toBe(ownerBytesBefore);
  }, 20_000);
});
