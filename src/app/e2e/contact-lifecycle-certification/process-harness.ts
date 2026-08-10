import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { GatewayServer, type GatewayServerOptions } from '../../../boundary/gateway/server.js';
import { deriveCompanionAuthToken } from '../../../boundary/gateway/companion-auth.js';
import { ContactLifecycleAuthorityDeniedError } from '../../../boundary/gateway/contact-lifecycle-authority.js';
import type {
  GatewayRpcEndpoint,
  GatewayRpcTlsFileConfig,
} from '../../../boundary/gateway/transport.js';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import type {
  ContactAuthorityLifecycleRequest,
  ContactAuthorityLifecycleResult,
} from '../../../shared/contracts/contact-authority-lifecycle.js';
import {
  contactAuthorityLifecycleRequestDigest,
  parseContactAuthorityLifecycleRequest,
} from '../../../shared/contracts/contact-authority-lifecycle.js';
import { EventBus } from '../../../shared/event-bus.js';
import type { SessionHmacKeyring } from '../../../persistence/journals/journal-utils.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { testShadowIntakeScreening } from '../../../test-support/intake-screening.js';

export const CERTIFICATION_COMPANION_A = '11111111-1111-4111-8111-111111111111';
export const CERTIFICATION_COMPANION_B = '22222222-2222-4222-8222-222222222222';
const AGENT_PROCESS_ENTRY = resolve(
  'src/app/e2e/contact-lifecycle-certification/agent-process.ts',
);
const KEYRING: SessionHmacKeyring = {
  activeVersion: 'v1',
  keys: { v1: randomBytes(32).toString('hex') },
};
const GATEWAY_SPIFFE_URI = 'spiffe://cluster.local/psfn/gateway';
const AGENT_SPIFFE_URI = 'spiffe://cluster.local/psfn/agent/contact-lifecycle-certification';

interface ChildReply {
  id?: number;
  type?: 'ready';
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class CertificationAuthority {
  readonly calls: Array<{ companionId: string; request: ContactAuthorityLifecycleRequest }> = [];
  private readonly owners = new Map<string, string>();
  private readonly receipts = new Map<string, {
    digest: string;
    result: ContactAuthorityLifecycleResult;
  }>();

  async executeForCompanion(
    companionId: string,
    input: unknown,
  ): Promise<ContactAuthorityLifecycleResult> {
    const request = parseContactAuthorityLifecycleRequest(input);
    const owner = this.owners.get(request.intentId);
    if (owner && owner !== companionId) {
      throw new ContactLifecycleAuthorityDeniedError('cross_companion_intent_reuse');
    }
    this.owners.set(request.intentId, companionId);
    this.calls.push({ companionId, request });
    const key = `${companionId}:${request.intentId}:${request.phase}`;
    const digest = contactAuthorityLifecycleRequestDigest(request);
    const receipt = this.receipts.get(key);
    if (receipt) {
      if (!timingSafeStringEqual(receipt.digest, digest)) {
        throw new ContactLifecycleAuthorityDeniedError('changed_phase_reuse');
      }
      return receipt.result;
    }
    const auditSeed = createHash('sha256').update(key).digest('hex');
    const auditEventId = `${auditSeed.slice(0, 8)}-${auditSeed.slice(8, 12)}-4${auditSeed.slice(13, 16)}-8${auditSeed.slice(17, 20)}-${auditSeed.slice(20, 32)}`;
    const result: ContactAuthorityLifecycleResult = {
      schemaVersion: 1,
      intentId: request.intentId,
      phase: request.phase,
      action: request.action,
      status: request.phase === 'finalize' ? 'finalized' : 'no_binding',
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      auditEventId,
    };
    this.receipts.set(key, { digest, result });
    return result;
  }
}

export class ContactLifecycleCertificationAgent {
  private nextId = 0;
  private readonly waiters = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;

  private constructor(
    readonly companionId: string,
    private readonly child: ChildProcess,
  ) {
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    child.on('message', (message: ChildReply) => this.onMessage(message));
    child.once('exit', (code, signal) => {
      const error = new Error(
        `Contact lifecycle certification agent exited (code=${String(code)}, signal=${String(signal)})`,
      );
      this.readyReject(error);
      for (const waiter of this.waiters.values()) waiter.reject(error);
      this.waiters.clear();
    });
  }

  static async start(companionId: string, endpoint: GatewayRpcEndpoint): Promise<ContactLifecycleCertificationAgent> {
    const child = fork(AGENT_PROCESS_ENTRY, [], {
      env: {
        ...process.env,
        COMPANION_ID: companionId,
        GATEWAY_COMPANION_AUTH_TOKEN: deriveCompanionAuthToken(companionId, 'agent', KEYRING),
        CONTACT_LIFECYCLE_CERTIFICATION_ENDPOINT: JSON.stringify(endpoint),
      },
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const agent = new ContactLifecycleCertificationAgent(companionId, child);
    const stderr: string[] = [];
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => stderr.push(String(chunk)));
    const timeout = setTimeout(() => {
      agent.readyReject(new Error(`Timed out starting contact lifecycle agent: ${stderr.join('')}`));
    }, 15_000);
    try {
      await agent.ready;
      return agent;
    } catch (error) {
      await agent.forceStop();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async execute(request: ContactAuthorityLifecycleRequest): Promise<ContactAuthorityLifecycleResult> {
    return await this.request({ type: 'execute', request }) as ContactAuthorityLifecycleResult;
  }

  async stop(): Promise<void> {
    if (!this.child.connected) return;
    await this.request({ type: 'shutdown' });
  }

  async forceStop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, 'exit');
    this.child.kill('SIGKILL');
    await exited;
  }

  private onMessage(message: ChildReply): void {
    if (message.type === 'ready') {
      if (message.ok) this.readyResolve();
      else this.readyReject(new Error(message.error ?? 'Agent startup failed'));
      return;
    }
    if (message.id === undefined) {
      if (!message.ok) this.readyReject(new Error(message.error ?? 'Agent failed'));
      return;
    }
    const waiter = this.waiters.get(message.id);
    if (!waiter) return;
    this.waiters.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? 'Agent request failed'));
  }

  private async request(command: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    const response = new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.waiters.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    this.child.send({ id, ...command });
    return await response;
  }
}

function createCertificateAuthority(dir: string): void {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-days', '2', '-nodes',
    '-subj', '/CN=PSFN Contact Lifecycle Test CA',
    '-keyout', 'ca.key', '-out', 'ca.crt',
  ], { cwd: dir, stdio: 'ignore' });
}

function createSignedCertificate(input: {
  dir: string;
  prefix: string;
  commonName: string;
  subjectAltName: string;
  extendedKeyUsage: 'serverAuth' | 'clientAuth';
}): void {
  execFileSync('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${input.commonName}`,
    '-keyout', `${input.prefix}.key`, '-out', `${input.prefix}.csr`,
  ], { cwd: input.dir, stdio: 'ignore' });
  writeFileSync(join(input.dir, `${input.prefix}.ext`), [
    `subjectAltName=${input.subjectAltName}`,
    `extendedKeyUsage=${input.extendedKeyUsage}`,
    '',
  ].join('\n'));
  execFileSync('openssl', [
    'x509', '-req', '-in', `${input.prefix}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-days', '2', '-out', `${input.prefix}.crt`,
    '-extfile', `${input.prefix}.ext`,
  ], { cwd: input.dir, stdio: 'ignore' });
}

function tlsConfig(dir: string, prefix: string, expectedPeerSpiffeUri: string): GatewayRpcTlsFileConfig {
  return {
    caPath: join(dir, 'ca.crt'),
    certPath: join(dir, `${prefix}.crt`),
    keyPath: join(dir, `${prefix}.key`),
    expectedPeerSpiffeUri,
  };
}

async function availablePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate WSS port');
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

async function endpoints(
  transport: 'unix' | 'wss',
  root: string,
): Promise<{ client: GatewayRpcEndpoint; server: GatewayRpcEndpoint }> {
  if (transport === 'unix') {
    const socketPath = join(root, 'gateway.sock');
    return {
      client: { kind: 'unix', socketPath },
      server: { kind: 'unix', socketPath },
    };
  }
  createCertificateAuthority(root);
  createSignedCertificate({
    dir: root,
    prefix: 'server',
    commonName: 'localhost',
    subjectAltName: `DNS:localhost,IP:127.0.0.1,URI:${GATEWAY_SPIFFE_URI}`,
    extendedKeyUsage: 'serverAuth',
  });
  createSignedCertificate({
    dir: root,
    prefix: 'client',
    commonName: 'contact-lifecycle-agent',
    subjectAltName: `URI:${AGENT_SPIFFE_URI}`,
    extendedKeyUsage: 'clientAuth',
  });
  const port = await availablePort();
  const path = '/rpc';
  return {
    client: {
      kind: 'wss',
      url: `wss://localhost:${port}${path}`,
      host: 'localhost',
      port,
      path,
      tls: tlsConfig(root, 'client', GATEWAY_SPIFFE_URI),
    },
    server: {
      kind: 'wss',
      url: `wss://127.0.0.1:${port}${path}`,
      host: '127.0.0.1',
      port,
      path,
      tls: tlsConfig(root, 'server', AGENT_SPIFFE_URI),
    },
  };
}

function serverOptions(
  endpoint: GatewayRpcEndpoint,
  authority: CertificationAuthority,
  root: string,
): GatewayServerOptions {
  return {
    socketPath: endpoint.kind === 'unix' ? endpoint.socketPath : '/unused/contact-lifecycle.sock',
    gatewayRpcEndpoint: endpoint,
    llmProvider: { stream: async () => { throw new Error('unused'); }, complete: async () => { throw new Error('unused'); } } as never,
    embeddingService: { dims: 8, embed: async () => [], embedBatch: async () => [] } as never,
    discordAdapter: { id: 'discord', outbound: { textChunkLimit: 2_000, sendText: async () => undefined } } as never,
    policyConfig: { workspacePath: join(root, 'workspace') },
    intakeScreeningMode: 'shadow',
    intakeScreeningProvider: testShadowIntakeScreening,
    visionIntakeProvider: () => null,
    sessionHmacKeyring: KEYRING,
    wyomingShardRouting: { enabled: false },
    eventBus: new EventBus(),
    contactLifecycleAuthority: authority,
    multiCompanion: {
      enabled: true,
      fleetCompanionIds: [
        CERTIFICATION_COMPANION_A as CompanionId,
        CERTIFICATION_COMPANION_B as CompanionId,
      ],
      channelRouting: {},
      discordAccounts: {},
      personalWorkspaceByCompanionId: {
        [CERTIFICATION_COMPANION_A]: join(root, 'companion-a'),
        [CERTIFICATION_COMPANION_B]: join(root, 'companion-b'),
      },
    },
  };
}

async function waitForServer(endpoint: GatewayRpcEndpoint): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (endpoint.kind === 'unix' && existsSync(endpoint.socketPath)) return;
    if (endpoint.kind === 'wss') {
      try {
        await new Promise<void>((resolveConnection, rejectConnection) => {
          const socket = createConnection({ host: endpoint.host, port: endpoint.port });
          socket.once('connect', () => {
            socket.destroy();
            resolveConnection();
          });
          socket.once('error', (error) => {
            socket.destroy();
            rejectConnection(error);
          });
        });
        return;
      } catch {
        // retry
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error('Timed out waiting for contact lifecycle certification gateway');
}

export interface ContactLifecycleCertificationHarness {
  agents: readonly [ContactLifecycleCertificationAgent, ContactLifecycleCertificationAgent];
  authority: CertificationAuthority;
  restart(): Promise<readonly [ContactLifecycleCertificationAgent, ContactLifecycleCertificationAgent]>;
  stop(): Promise<void>;
}

async function startCertificationAgents(
  endpoint: GatewayRpcEndpoint,
): Promise<[ContactLifecycleCertificationAgent, ContactLifecycleCertificationAgent]> {
  const results = await Promise.allSettled([
    ContactLifecycleCertificationAgent.start(CERTIFICATION_COMPANION_A, endpoint),
    ContactLifecycleCertificationAgent.start(CERTIFICATION_COMPANION_B, endpoint),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    await Promise.all(results
      .filter((result): result is PromiseFulfilledResult<ContactLifecycleCertificationAgent> => (
        result.status === 'fulfilled'
      ))
      .map(async result => result.value.forceStop()));
    throw failure.reason;
  }
  const [agentA, agentB] = results as [
    PromiseFulfilledResult<ContactLifecycleCertificationAgent>,
    PromiseFulfilledResult<ContactLifecycleCertificationAgent>,
  ];
  return [agentA.value, agentB.value];
}

export async function startContactLifecycleCertificationHarness(
  transport: 'unix' | 'wss',
): Promise<ContactLifecycleCertificationHarness> {
  const root = mkdtempSync(join(tmpdir(), `psfn-contact-lifecycle-${transport}-`));
  const rpc = await endpoints(transport, root);
  const authority = new CertificationAuthority();
  let server = new GatewayServer(serverOptions(rpc.server, authority, root));
  server.start();
  await waitForServer(rpc.server);
  let agents: [ContactLifecycleCertificationAgent, ContactLifecycleCertificationAgent];
  try {
    agents = await startCertificationAgents(rpc.client);
  } catch (error) {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    get agents() { return agents; },
    authority,
    restart: async () => {
      await Promise.all(agents.map(async agent => agent.forceStop()));
      await server.stop();
      server = new GatewayServer(serverOptions(rpc.server, authority, root));
      server.start();
      await waitForServer(rpc.server);
      agents = await startCertificationAgents(rpc.client);
      return agents;
    },
    stop: async () => {
      const gracefulStops = await Promise.allSettled(agents.map(async agent => agent.stop()));
      await Promise.all(agents.map(async agent => agent.forceStop()));
      await server.stop();
      rmSync(root, { recursive: true, force: true });
      const failure = gracefulStops.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    },
  };
}

export function certificationDeleteRequest(intentId = randomUUID()): ContactAuthorityLifecycleRequest {
  return {
    schemaVersion: 1,
    intentId,
    phase: 'prepare',
    action: 'contact.delete',
    contactId: 'same-contact-id-in-both-companions',
  };
}
