import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

import { GatewayServer } from '../../../boundary/gateway/server.js';
import { EventBus } from '../../../shared/event-bus.js';
import { isRecord } from '../../../shared/utils/types.js';
import { testShadowIntakeScreening } from '../../../test-support/intake-screening.js';
import { loadAgentConfig } from '../../../system/config/load-config.js';
import { hydrateJsonBackedRuntimeConfig } from '../../../system/config/runtime-config.js';
import { LLMClient } from '../../../primitives/llm/client.js';
import { GardenAdminTransportProxy } from '../../../operator/garden/transport-client.js';
import {
  DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS,
  resolveAdminTransportClientEndpoint,
} from '../../../operator/garden/transport-paths.js';
import {
  CERTIFICATION_EMBEDDING_DIMS,
  CERTIFICATION_SESSION_KEYRING,
} from '../icp-certification/constants.js';
import {
  configureIcpCertificationModelEndpoint,
  type IcpCertificationCompanionFixture,
  type IcpCertificationFixture,
} from '../icp-certification/fixture.js';
import { startIcpCertificationModelServer } from '../icp-certification/openai-fixture-server.js';
import { provisionIcpCertificationDatabase } from '../icp-certification/process-harness.js';

const PRODUCTION_AGENT_ENTRY = resolve('src/app/agent/main.ts');
const START_TIMEOUT_MS = DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS * 6;
const STOP_TIMEOUT_MS = DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS * 2;
const MAX_CAPTURED_OUTPUT_CHARS = DEFAULT_ADMIN_TRANSPORT_TIMEOUT_MS * 2;
const READY_LOG_LINE = 'Ready — waiting for messages';

class IdlePurityProductionAgent {
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  static async start(
    fixture: IcpCertificationCompanionFixture,
  ): Promise<IdlePurityProductionAgent> {
    const child = spawn(process.execPath, ['--import', 'tsx', PRODUCTION_AGENT_ENTRY], {
      env: {
        ...fixture.env,
        ADMIN_PORT: '10054',
        ALLOW_AGENT_OUTBOUND_NETWORK: 'true',
        LOG_LEVEL: 'info',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let ready = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise;
      rejectReady = rejectPromise;
    });
    const capture = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
      if (!ready && output.includes(READY_LOG_LINE)) {
        ready = true;
        resolveReady();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', error => rejectReady(error));
    child.once('exit', (code, signal) => {
      if (!ready) {
        rejectReady(new Error(
          `Production idle-purity agent exited before readiness `
          + `(code=${String(code)}, signal=${String(signal)}): ${output.trim()}`,
        ));
      }
    });
    const timeout = setTimeout(() => rejectReady(new Error(
      `Timed out starting production idle-purity agent: ${output.trim()}`,
    )), START_TIMEOUT_MS);
    try {
      await readyPromise;
      return new IdlePurityProductionAgent(child);
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>(resolveExit => this.child.once('exit', () => resolveExit()));
    this.child.kill('SIGTERM');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Timed out stopping production idle-purity agent')),
            STOP_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.child.kill('SIGKILL');
      await exited;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export interface IdlePurityRuntimeHarness {
  readonly modelRequestCount: number;
  schedulerTaskIds(): Promise<readonly string[]>;
  stop(): Promise<void>;
}

function deterministicEmbedding(text: string): Float32Array {
  const values = new Float32Array(CERTIFICATION_EMBEDDING_DIMS);
  for (let index = 0; index < text.length; index += 1) {
    const slot = index % values.length;
    values[slot] = (values[slot] ?? 0) + (text.charCodeAt(index) % 31) / 31;
  }
  return values;
}

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const connected = await new Promise<boolean>((resolveConnection) => {
        const socket = createConnection(path);
        socket.once('connect', () => {
          socket.destroy();
          resolveConnection(true);
        });
        socket.once('error', () => {
          socket.destroy();
          resolveConnection(false);
        });
      });
      if (connected) return;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error(`Runtime socket was not ready at ${path}`);
}

function parseSchedulerTaskIds(payload: unknown): readonly string[] {
  if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
    throw new Error('Production idle-purity scheduler response is malformed');
  }
  return payload.tasks.map((task) => {
    if (!isRecord(task) || typeof task.id !== 'string') {
      throw new Error('Production idle-purity scheduler task is malformed');
    }
    return task.id;
  });
}

export async function startIdlePurityRuntimeHarness(input: {
  databaseUrl: string;
  fixture: IcpCertificationFixture;
}): Promise<IdlePurityRuntimeHarness> {
  if (input.fixture.topology !== 'single_companion') {
    throw new Error('Idle-purity certification requires a single-companion fixture');
  }
  await provisionIcpCertificationDatabase(input.databaseUrl, input.fixture);
  const previousOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  const modelServer = await startIcpCertificationModelServer();
  let gateway: GatewayServer | undefined;
  let gatewayStarted = false;
  let agent: IdlePurityProductionAgent | undefined;
  let stopped = false;

  const cleanup = async (): Promise<unknown[]> => {
    if (stopped) return [];
    stopped = true;
    const errors: unknown[] = [];
    if (agent) {
      try {
        await agent.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (gateway && gatewayStarted) {
      try {
        await gateway.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await modelServer.stop();
    } catch (error) {
      errors.push(error);
    }
    if (previousOpenRouterApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterApiKey;
    return errors;
  };

  try {
    process.env.OPENROUTER_API_KEY = 'idle-purity-loopback-key';
    configureIcpCertificationModelEndpoint(input.fixture, modelServer.baseUrl);
    const companion = input.fixture.companions[0];
    const config = hydrateJsonBackedRuntimeConfig(
      loadAgentConfig(companion.env),
      { seedDir: companion.env.CONFIG_DIR },
    );
    gateway = new GatewayServer({
      socketPath: input.fixture.gatewaySocketPath,
      llmProvider: new LLMClient(config),
      embeddingService: {
        dims: CERTIFICATION_EMBEDDING_DIMS,
        embed: async text => deterministicEmbedding(text),
        embedBatch: async texts => texts.map(deterministicEmbedding),
      },
      discordAdapter: {
        id: 'idle-purity-disabled-discord',
        outbound: {
          textChunkLimit: Number.MAX_SAFE_INTEGER,
          sendText: async () => undefined,
        },
      },
      policyConfig: { workspacePath: input.fixture.rootDir },
      intakeScreeningMode: 'shadow',
      intakeScreening: testShadowIntakeScreening(),
      sessionHmacKeyring: CERTIFICATION_SESSION_KEYRING,
      wyomingShardRouting: { enabled: false },
      eventBus: new EventBus(),
    });
    const adminTransportEndpoint = resolveAdminTransportClientEndpoint(companion.env);
    if (adminTransportEndpoint.mode !== 'socket') {
      throw new Error('Idle-purity certification requires the local admin socket transport');
    }
    gatewayStarted = true;
    gateway.start();
    await waitForSocket(input.fixture.gatewaySocketPath);
    agent = await IdlePurityProductionAgent.start(companion);
    await waitForSocket(adminTransportEndpoint.socketPath);
    const adminProxy = new GardenAdminTransportProxy(adminTransportEndpoint);
    return {
      get modelRequestCount() {
        return modelServer.requests.length;
      },
      async schedulerTaskIds() {
        return parseSchedulerTaskIds(await adminProxy.requestJson('/api/admin/scheduler', {}));
      },
      async stop() {
        const errors = await cleanup();
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Failed to stop idle-purity runtime harness cleanly');
        }
      },
    };
  } catch (error) {
    const cleanupErrors = await cleanup();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Failed to start and clean up idle-purity runtime harness',
      );
    }
    throw error;
  }
}
