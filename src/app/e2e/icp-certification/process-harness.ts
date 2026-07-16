import { fork, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { GatewayServer } from '../../../boundary/gateway/server.js';
import { deriveCompanionAuthToken } from '../../../boundary/gateway/companion-auth.js';
import { createSocketClient, type GatewayRpcConnection } from '../../../boundary/gateway/transport.js';
import { GatewayCompanionChannelLane } from '../../../boundary/gateway/companion-channels.js';
import type { GatewayMultiCompanionConfig } from '../../../boundary/gateway/multi-companion.js';
import { RootBoundIcpInitiationCausalityAuthority } from '../../../boundary/gateway/icp-initiation-causality-authority.js';
import { IcpFatigueInitiationCapacityAuthority } from '../../../core/agent/fatigue/initiation-capacity.js';
import { EventBus } from '../../../shared/event-bus.js';
import type { IcpConversationCostBreakerEvent } from '../../../shared/telemetry/model-usage.js';
import { readRunChargeRollingWindowFromLedger } from '../../../shared/telemetry/charge-ledger.js';
import { resolveChargeLedgerPath } from '../../../persistence/layout.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { PostgresCompanionPresenceStore } from '../../../persistence/postgres/companion-presence-store.js';
import { PostgresIcpFatigueRegulationReservationStore } from '../../../persistence/postgres/icp-fatigue-regulation-reservation-store.js';
import { PostgresIcpInitiationPolicyAuthority } from '../../../persistence/postgres/icp-initiation-policy-authority.js';
import { PostgresIcpSharedAutonomyStore } from '../../../persistence/postgres/icp-shared-autonomy-store.js';
import { PostgresModelUsageStore } from '../../../persistence/postgres/model-usage-store.js';
import { createGatewayFleetChargePolicyResolver } from '../../gateway/fleet-charge-policy-resolver.js';
import { loadAgentConfig } from '../../../system/config/load-config.js';
import { hydrateJsonBackedRuntimeConfig } from '../../../system/config/runtime-config.js';
import { loadPlacesRegistryConfig } from '../../../channels/backplane/places-registry.js';
import { LLMClient } from '../../../primitives/llm/client.js';
import {
  CERTIFICATION_COMPANION_A,
  CERTIFICATION_COMPANION_B,
  CERTIFICATION_EMBEDDING_DIMS,
  CERTIFICATION_SESSION_KEYRING,
} from './constants.js';
import type {
  IcpCertificationCompanionFixture,
  IcpCertificationFixture,
} from './fixture.js';
import { configureIcpCertificationModelEndpoint } from './fixture.js';
import { startIcpCertificationModelServer } from './openai-fixture-server.js';
import type { IcpCertificationConsentDecision } from './openai-fixture-server.js';
import { IcpCertificationArtifactRecorder } from './artifact-recorder.js';

const AGENT_PROCESS_ENTRY = resolve('src/app/e2e/icp-certification/agent-process.ts');
const START_TIMEOUT_MS = 60_000;

interface ChildMessage {
  error?: string;
  id?: number;
  ok: boolean;
  result?: unknown;
  type?: 'ready';
}

export interface CertificationAgentReady {
  companionId: string;
  multiCompanion: boolean;
  peerContactId?: string;
  postgresSchema?: string;
  runtimeClass: string;
}

export class IcpCertificationAgentProcess {
  private nextRequestId = 0;
  private readonly pending = new Map<number, {
    reject(error: Error): void;
    resolve(value: unknown): void;
  }>();
  private readyResolve!: (value: CertificationAgentReady) => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise: Promise<CertificationAgentReady>;

  private constructor(
    readonly fixture: IcpCertificationCompanionFixture,
    private readonly child: ChildProcess,
    private readonly artifacts: IcpCertificationArtifactRecorder,
  ) {
    this.readyPromise = new Promise<CertificationAgentReady>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    child.on('message', (raw: ChildMessage) => this.onMessage(raw));
    child.once('exit', (code, signal) => {
      const error = new Error(
        `ICP certification agent ${fixture.companionId} exited before shutdown `
        + `(code=${String(code)}, signal=${String(signal)})`,
      );
      this.readyReject(error);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  static async start(
    fixture: IcpCertificationCompanionFixture,
    artifacts: IcpCertificationArtifactRecorder,
  ): Promise<IcpCertificationAgentProcess> {
    const child = fork(AGENT_PROCESS_ENTRY, [], {
      env: fixture.env,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const process = new IcpCertificationAgentProcess(fixture, child, artifacts);
    const stderr: string[] = [];
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => stderr.push(String(chunk)));
    const timeout = setTimeout(() => {
      process.readyReject(new Error(
        `Timed out starting ICP certification agent ${fixture.companionId}: ${stderr.join('').trim()}`,
      ));
    }, START_TIMEOUT_MS);
    try {
      await process.readyPromise;
      return process;
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async ready(): Promise<CertificationAgentReady> {
    return await this.readyPromise;
  }

  async snapshot(): Promise<Record<string, unknown>> {
    return await this.request({ type: 'snapshot' }) as Record<string, unknown>;
  }

  async publishAvailability(
    state: 'open_to_chat' | 'busy' | 'do_not_disturb',
  ): Promise<Record<string, unknown>> {
    const result = await this.request({ type: 'publish_availability', state }) as Record<string, unknown>;
    this.artifacts.append({
      kind: 'availability',
      companionId: this.fixture.companionId,
      state,
    });
    return result;
  }

  async runFreeTimeNotification(): Promise<Record<string, unknown>> {
    const result = await this.request({ type: 'run_free_time_notification' }) as
      Record<string, unknown>;
    this.artifacts.append({
      kind: 'initiation',
      companionId: this.fixture.companionId,
      source: 'free_time_notification',
      candidateId: String(result.candidateId ?? 'unknown'),
      status: String(result.status ?? 'unknown'),
      ...(result.reasonCode ? { reasonCode: String(result.reasonCode) } : {}),
      ...(result.deliveryDisposition
        ? { deliveryDisposition: String(result.deliveryDisposition) }
        : {}),
    });
    return result;
  }

  async runWeightedThoughtScheduler(): Promise<Record<string, unknown>> {
    const result = await this.request({ type: 'run_weighted_thought_scheduler' }) as
      Record<string, unknown>;
    this.artifacts.append({
      kind: 'initiation',
      companionId: this.fixture.companionId,
      source: 'weighted_thought_scheduler',
      candidateId: String(result.candidateId ?? 'unknown'),
      status: String(result.status ?? 'unknown'),
      ...(result.reasonCode ? { reasonCode: String(result.reasonCode) } : {}),
      ...(result.deliveryDisposition
        ? { deliveryDisposition: String(result.deliveryDisposition) }
        : {}),
    });
    return result;
  }

  async runRecursiveWeightedThoughtScheduler(
    rootInitiationId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.request({
      type: 'run_recursive_weighted_thought_scheduler',
      rootInitiationId,
    }) as Record<string, unknown>;
    this.artifacts.append({
      kind: 'initiation',
      companionId: this.fixture.companionId,
      source: 'recursive_weighted_thought_scheduler',
      candidateId: String(result.candidateId ?? 'unknown'),
      status: String(result.status ?? 'unknown'),
      ...(result.reasonCode ? { reasonCode: String(result.reasonCode) } : {}),
      ...(result.deliveryDisposition
        ? { deliveryDisposition: String(result.deliveryDisposition) }
        : {}),
    });
    return result;
  }

  async enterPrivateRoom(): Promise<Record<string, unknown>> {
    return await this.request({ type: 'enter_private_room' }) as Record<string, unknown>;
  }

  async sendRoomProbe(phase: 'post_exit' | 'pre_entry'): Promise<Record<string, unknown>> {
    return await this.request({ type: 'send_room_probe', phase }) as Record<string, unknown>;
  }

  async runRoomWeightedThoughtScheduler(): Promise<Record<string, unknown>> {
    const result = await this.request({ type: 'run_room_weighted_thought_scheduler' }) as
      Record<string, unknown>;
    this.artifacts.append({
      kind: 'initiation',
      companionId: this.fixture.companionId,
      source: 'room_weighted_thought_scheduler',
      candidateId: String(result.candidateId ?? 'unknown'),
      status: String(result.status ?? 'unknown'),
      ...(result.reasonCode ? { reasonCode: String(result.reasonCode) } : {}),
      ...(result.deliveryDisposition
        ? { deliveryDisposition: String(result.deliveryDisposition) }
        : {}),
    });
    return result;
  }

  async activateGardenEmergencyDisable(): Promise<Record<string, unknown>> {
    const result = await this.request({ type: 'garden_emergency_disable' }) as Record<string, unknown>;
    this.artifacts.append({
      kind: 'garden_emergency_disable',
      companionId: this.fixture.companionId,
    });
    return result;
  }

  async armNextCompanionTurnFailure(): Promise<void> {
    await this.request({ type: 'fail_next_companion_turn' });
  }

  async failureObservationCount(): Promise<number> {
    const result = await this.request({ type: 'failure_observation_snapshot' }) as {
      failureObservationCount: number;
    };
    return result.failureObservationCount;
  }

  async retryCandidateDelivery(candidateId: string): Promise<Record<string, unknown>> {
    const result = await this.request({ type: 'retry_candidate_delivery', candidateId }) as
      Record<string, unknown>;
    this.artifacts.append({
      kind: 'delivery_recovery',
      companionId: this.fixture.companionId,
      candidateId,
      disposition: String(result.disposition ?? 'unknown'),
    });
    return result;
  }

  async channelSnapshot(channelId: string): Promise<Record<string, unknown>> {
    return await this.request({ type: 'channel_snapshot', channelId }) as Record<string, unknown>;
  }

  async servedChannelSnapshot(channelId: string): Promise<Record<string, unknown>> {
    return await this.request({ type: 'served_channel_snapshot', channelId }) as Record<string, unknown>;
  }

  async turnRecordsSnapshot(channelId: string): Promise<Record<string, unknown>> {
    return await this.request({ type: 'turn_records_snapshot', channelId }) as Record<string, unknown>;
  }

  async forceCompaction(channelId: string): Promise<unknown> {
    return await this.request({ type: 'force_compaction', channelId });
  }

  async appendCompactionMarker(channelId: string): Promise<void> {
    await this.request({ type: 'append_compaction_marker', channelId });
  }

  async stop(): Promise<void> {
    if (!this.child.connected) return;
    await this.request({ type: 'shutdown' });
  }

  forceStop(): void {
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }

  private onMessage(message: ChildMessage): void {
    if (message.type === 'ready') {
      if (message.ok) {
        this.readyResolve(message.result as CertificationAgentReady);
      } else {
        this.readyReject(new Error(message.error ?? 'ICP certification agent startup failed'));
      }
      return;
    }
    if (message.id === undefined) {
      if (!message.ok) this.readyReject(new Error(message.error ?? 'ICP certification agent failed'));
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? 'ICP certification agent request failed'));
  }

  private async request(command: Record<string, unknown> & { type: string }): Promise<unknown> {
    const id = ++this.nextRequestId;
    const result = new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    this.child.send({ id, ...command });
    return await result;
  }
}

export interface IcpCertificationProcessHarness {
  agents: readonly [IcpCertificationAgentProcess, IcpCertificationAgentProcess];
  gateway: GatewayServer;
  readonly costDecisions: readonly IcpConversationCostBreakerEvent[];
  readonly modelRequestCount: number;
  queueConsentDecision(decision: IcpCertificationConsentDecision): void;
  rejectAuthenticatedSpoof(index: 0 | 1): Promise<void>;
  rejectMalformedFrame(): Promise<void>;
  restartAgent(index: 0 | 1): Promise<IcpCertificationAgentProcess>;
  restartAgents(): Promise<readonly [IcpCertificationAgentProcess, IcpCertificationAgentProcess]>;
  restartGatewayAndAgents(): Promise<readonly [IcpCertificationAgentProcess, IcpCertificationAgentProcess]>;
  stopAgent(index: 0 | 1): Promise<void>;
  stop(): Promise<void>;
}

export interface IcpSingleCompanionFeatureOffHarness {
  agent: IcpCertificationAgentProcess;
  readonly modelRequestCount: number;
  stop(): Promise<void>;
}

function deterministicEmbedding(text: string): Float32Array {
  const values = new Float32Array(CERTIFICATION_EMBEDDING_DIMS);
  for (let index = 0; index < text.length; index += 1) {
    values[index % values.length] += (text.charCodeAt(index) % 31) / 31;
  }
  return values;
}

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error(`Gateway socket was not created at ${path}`);
}

async function invokeRawRpc(
  connection: GatewayRpcConnection,
  id: number,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  const response = new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
    const timeout = setTimeout(() => {
      rejectResponse(new Error(`Timed out waiting for raw gateway RPC ${method}`));
    }, 5_000);
    connection.onMessage((message) => {
      if (typeof message !== 'object' || message === null || !('id' in message)
        || (message as { id?: unknown }).id !== id) return;
      clearTimeout(timeout);
      resolveResponse(message as Record<string, unknown>);
    });
    connection.once('close', () => {
      clearTimeout(timeout);
      rejectResponse(new Error(`Gateway closed raw RPC ${method}`));
    });
  });
  connection.send({ jsonrpc: '2.0', id, method, params });
  return await response;
}

async function waitForDestroyed(connection: GatewayRpcConnection): Promise<void> {
  if (connection.destroyed) return;
  await new Promise<void>((resolveClosed, rejectClosed) => {
    const timeout = setTimeout(() => rejectClosed(new Error('Gateway did not close rejected frame')), 5_000);
    connection.once('close', () => {
      clearTimeout(timeout);
      resolveClosed();
    });
  });
}

export async function startIcpCertificationProcessHarness(input: {
  databaseUrl: string;
  fixture: IcpCertificationFixture;
}): Promise<IcpCertificationProcessHarness> {
  const modelServer = await startIcpCertificationModelServer();
  const artifacts = new IcpCertificationArtifactRecorder(input.fixture.artifactsPath);
  artifacts.append({ kind: 'harness_lifecycle', state: 'started', modelRequestCount: 0 });
  configureIcpCertificationModelEndpoint(input.fixture, modelServer.baseUrl);
  const previousOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'icp-certification-loopback-key';
  const config = hydrateJsonBackedRuntimeConfig(
    loadAgentConfig(input.fixture.companions[0].env),
    { seedDir: input.fixture.companions[0].env.CONFIG_DIR },
  );
  const fleet = input.fixture.companions.map(companion => ({
    companionId: companion.companionId,
    postgresSchema: companion.postgresSchema,
    companionDataDir: companion.companionDataDir,
  }));
  const fleetById = new Map(fleet.map(companion => [companion.companionId, companion]));
  const resolveChargePolicy = createGatewayFleetChargePolicyResolver({
    companions: fleet,
    ...(input.fixture.companions[0].env.CONFIG_DIR
      ? { seedDir: input.fixture.companions[0].env.CONFIG_DIR }
      : {}),
  });
  const modelUsagePool = createPostgresPool(input.databaseUrl, {
    applicationName: 'psfn-icp-certification-model-usage',
    allowExitOnIdle: true,
  });
  const modelUsage = new PostgresModelUsageStore(modelUsagePool, { fleetAggregation: true });
  const costDecisions: IcpConversationCostBreakerEvent[] = [];
  const llmProvider = new LLMClient(config, {
    usageRecorder: modelUsage,
    usageBudgetQuery: modelUsage,
    icpConversationCostAccounting: modelUsage,
    onIcpConversationCostDecision: decision => {
      costDecisions.push(decision);
      artifacts.append({
        kind: 'cost_decision',
        companionId: decision.localCompanionId,
        conversationId: decision.conversationId,
        model: decision.model,
        outcome: decision.outcome,
        reason: decision.reason,
      });
    },
    icpConversationChargePolicyResolver: resolveChargePolicy,
  });
  const companionIds = [CERTIFICATION_COMPANION_A, CERTIFICATION_COMPANION_B];
  const presence = await PostgresCompanionPresenceStore.connect(input.databaseUrl);
  const autonomy = await PostgresIcpSharedAutonomyStore.connect(input.databaseUrl, {
    knownCompanionIds: companionIds,
  });
  const fatigue = await PostgresIcpFatigueRegulationReservationStore.connect(input.databaseUrl);
  const authority = new PostgresIcpInitiationPolicyAuthority(input.databaseUrl, {
    fleet,
    quietHours: {
      enabled: false,
      startLocalTime: '00:00',
      endLocalTime: '23:59',
      timeZone: 'UTC',
    },
    capacityAuthority: new IcpFatigueInitiationCapacityAuthority(
      fatigue,
      {
        read: ({ senderCompanionId }) => resolveChargePolicy(senderCompanionId),
      },
      {
        read: ({ senderCompanionId, nowMs }) => {
          const companion = fleetById.get(senderCompanionId);
          if (!companion) throw new Error('Unknown certification companion charge owner');
          return readRunChargeRollingWindowFromLedger(
            resolveChargeLedgerPath(companion.companionDataDir),
            nowMs,
          );
        },
      },
    ),
    causalityAuthority: new RootBoundIcpInitiationCausalityAuthority(),
  });
  const places = loadPlacesRegistryConfig(input.fixture.systemDataDir);
  const lane = new GatewayCompanionChannelLane({
    placesRegistry: places,
    presence,
    fleetCompanionIds: new Set(companionIds),
  });
  const multiCompanion: GatewayMultiCompanionConfig = {
    enabled: true,
    fleetCompanionIds: companionIds,
    channelRouting: {},
    discordAccounts: {},
    personalWorkspaceByCompanionId: Object.fromEntries(
      input.fixture.companions.map(companion => [
        companion.companionId,
        companion.workspacePath,
      ]),
    ),
  };
  const eventBus = new EventBus();
  const createGateway = () => new GatewayServer({
    socketPath: input.fixture.gatewaySocketPath,
    llmProvider,
    embeddingService: {
      dims: CERTIFICATION_EMBEDDING_DIMS,
      embed: async text => deterministicEmbedding(text),
      embedBatch: async texts => texts.map(deterministicEmbedding),
    },
    discordAdapter: {
      id: 'certification-disabled-discord',
      outbound: {
        textChunkLimit: 2_000,
        sendText: async () => undefined,
      },
    },
    policyConfig: { workspacePath: input.fixture.rootDir },
    sessionHmacKeyring: CERTIFICATION_SESSION_KEYRING,
    wyomingShardRouting: { enabled: false },
    multiCompanion,
    companionChannels: lane,
    icpAutonomyStore: autonomy,
    icpInitiationPolicyAuthority: authority,
    eventBus,
    modelUsageRecorder: modelUsage,
  });
  let gateway = createGateway();
  gateway.start();
  let agents: IcpCertificationAgentProcess[] = [];
  try {
    await waitForSocket(input.fixture.gatewaySocketPath);
    for (const companion of input.fixture.companions) {
      const agent = await IcpCertificationAgentProcess.start(companion, artifacts);
      agents.push(agent);
      const ready = await agent.ready();
      artifacts.append({
        kind: 'agent_ready',
        companionId: ready.companionId,
        postgresSchema: ready.postgresSchema,
        runtimeClass: ready.runtimeClass,
      });
    }
  } catch (error) {
    for (const agent of agents) agent.forceStop();
    await gateway.stop().catch(() => undefined);
    await authority.close().catch(() => undefined);
    await fatigue.close().catch(() => undefined);
    await autonomy.close().catch(() => undefined);
    await presence.close().catch(() => undefined);
    await modelUsagePool.end().catch(() => undefined);
    await modelServer.stop().catch(() => undefined);
    if (previousOpenRouterApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterApiKey;
    throw error;
  }
  let stopped = false;
  return {
    get agents() {
      return agents as unknown as readonly [
        IcpCertificationAgentProcess,
        IcpCertificationAgentProcess,
      ];
    },
    get gateway() {
      return gateway;
    },
    get costDecisions() {
      return costDecisions;
    },
    get modelRequestCount() {
      return modelServer.requests.length;
    },
    queueConsentDecision(decision) {
      modelServer.queueConsentDecision(decision);
    },
    async rejectAuthenticatedSpoof(index) {
      const fixtureCompanion = input.fixture.companions[index];
      const spoofedCompanion = input.fixture.companions[index === 0 ? 1 : 0];
      const connection = await createSocketClient({
        socketPath: input.fixture.gatewaySocketPath,
        reconnect: false,
      });
      try {
        const identified = await invokeRawRpc(connection, 1, 'gateway.client.identify', {
          role: 'agent',
          companionId: fixtureCompanion.companionId,
          authToken: deriveCompanionAuthToken(
            fixtureCompanion.companionId,
            'agent',
            CERTIFICATION_SESSION_KEYRING,
          ),
        });
        if ('error' in identified) {
          throw new Error(`Raw authenticated identify failed: ${JSON.stringify(identified.error)}`);
        }
        connection.send({
          jsonrpc: '2.0',
          id: 2,
          method: 'companion.message.send',
          params: {
            channelId: `companion-dm:${fixtureCompanion.companionId}:${spoofedCompanion.companionId}`,
            content: 'Certification authenticated identity-spoof probe',
            companionId: spoofedCompanion.companionId,
          },
        });
        await waitForDestroyed(connection);
      } finally {
        connection.destroy();
      }
      artifacts.append({
        kind: 'transport_rejection',
        probe: 'authenticated_identity_spoof',
        companionId: fixtureCompanion.companionId,
      });
    },
    async rejectMalformedFrame() {
      const socket = createConnection(input.fixture.gatewaySocketPath);
      await new Promise<void>((resolveConnected, rejectConnected) => {
        socket.once('connect', resolveConnected);
        socket.once('error', rejectConnected);
      });
      socket.write('{"jsonrpc":"2.0","method":\n');
      await new Promise<void>((resolveClosed, rejectClosed) => {
        const timeout = setTimeout(() => rejectClosed(new Error('Malformed frame was not closed')), 5_000);
        socket.once('close', () => {
          clearTimeout(timeout);
          resolveClosed();
        });
        socket.once('error', () => undefined);
      });
      artifacts.append({ kind: 'transport_rejection', probe: 'malformed_ndjson' });
    },
    async restartAgent(index) {
      const previous = agents[index];
      await previous.stop().catch(() => previous.forceStop());
      const replacement = await IcpCertificationAgentProcess.start(
        input.fixture.companions[index],
        artifacts,
      );
      agents[index] = replacement;
      const ready = await replacement.ready();
      artifacts.append({
        kind: 'agent_ready',
        companionId: ready.companionId,
        postgresSchema: ready.postgresSchema,
        runtimeClass: ready.runtimeClass,
      });
      return replacement;
    },
    async restartAgents() {
      await Promise.all(agents.map(agent => agent.stop().catch(() => agent.forceStop())));
      agents = [];
      for (const companion of input.fixture.companions) {
        const agent = await IcpCertificationAgentProcess.start(companion, artifacts);
        agents.push(agent);
        const ready = await agent.ready();
        artifacts.append({
          kind: 'agent_ready',
          companionId: ready.companionId,
          postgresSchema: ready.postgresSchema,
          runtimeClass: ready.runtimeClass,
        });
      }
      return agents as unknown as readonly [
        IcpCertificationAgentProcess,
        IcpCertificationAgentProcess,
      ];
    },
    async restartGatewayAndAgents() {
      await Promise.all(agents.map(agent => agent.stop().catch(() => agent.forceStop())));
      agents = [];
      await gateway.stop();
      gateway = createGateway();
      gateway.start();
      await waitForSocket(input.fixture.gatewaySocketPath);
      for (const companion of input.fixture.companions) {
        const agent = await IcpCertificationAgentProcess.start(companion, artifacts);
        agents.push(agent);
        const ready = await agent.ready();
        artifacts.append({
          kind: 'agent_ready',
          companionId: ready.companionId,
          postgresSchema: ready.postgresSchema,
          runtimeClass: ready.runtimeClass,
        });
      }
      return agents as unknown as readonly [
        IcpCertificationAgentProcess,
        IcpCertificationAgentProcess,
      ];
    },
    async stopAgent(index) {
      const agent = agents[index];
      await agent.stop().catch(() => agent.forceStop());
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await Promise.all(agents.map(agent => agent.stop().catch(() => agent.forceStop())));
      await gateway.stop();
      await authority.close();
      await fatigue.close();
      await autonomy.close();
      await presence.close();
      await modelUsagePool.end();
      artifacts.append({
        kind: 'harness_lifecycle',
        state: 'stopped',
        modelRequestCount: modelServer.requests.length,
      });
      await modelServer.stop();
      if (previousOpenRouterApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterApiKey;
    },
  };
}

export async function startIcpSingleCompanionFeatureOffHarness(input: {
  fixture: IcpCertificationFixture;
}): Promise<IcpSingleCompanionFeatureOffHarness> {
  if (input.fixture.topology !== 'single_companion') {
    throw new Error('Single-companion certification requires a single-companion fixture');
  }
  const modelServer = await startIcpCertificationModelServer();
  const artifacts = new IcpCertificationArtifactRecorder(input.fixture.artifactsPath);
  configureIcpCertificationModelEndpoint(input.fixture, modelServer.baseUrl);
  const previousOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'icp-certification-loopback-key';
  const companion = input.fixture.companions[0];
  const config = hydrateJsonBackedRuntimeConfig(
    loadAgentConfig(companion.env),
    { seedDir: companion.env.CONFIG_DIR },
  );
  const gateway = new GatewayServer({
    socketPath: input.fixture.gatewaySocketPath,
    llmProvider: new LLMClient(config),
    embeddingService: {
      dims: CERTIFICATION_EMBEDDING_DIMS,
      embed: async text => deterministicEmbedding(text),
      embedBatch: async texts => texts.map(deterministicEmbedding),
    },
    discordAdapter: {
      id: 'certification-disabled-discord',
      outbound: {
        textChunkLimit: 2_000,
        sendText: async () => undefined,
      },
    },
    policyConfig: { workspacePath: input.fixture.rootDir },
    sessionHmacKeyring: CERTIFICATION_SESSION_KEYRING,
    wyomingShardRouting: { enabled: false },
    eventBus: new EventBus(),
  });
  let agent: IcpCertificationAgentProcess | undefined;
  try {
    gateway.start();
    await waitForSocket(input.fixture.gatewaySocketPath);
    agent = await IcpCertificationAgentProcess.start(companion, artifacts);
    const ready = await agent.ready();
    artifacts.append({
      kind: 'agent_ready',
      companionId: ready.companionId,
      runtimeClass: ready.runtimeClass,
      topology: 'single_companion',
    });
  } catch (error) {
    agent?.forceStop();
    await gateway.stop().catch(() => undefined);
    await modelServer.stop().catch(() => undefined);
    if (previousOpenRouterApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterApiKey;
    throw error;
  }
  let stopped = false;
  return {
    agent,
    get modelRequestCount() {
      return modelServer.requests.length;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await agent.stop().catch(() => agent.forceStop());
      await gateway.stop();
      artifacts.append({
        kind: 'harness_lifecycle',
        state: 'stopped',
        topology: 'single_companion',
        modelRequestCount: modelServer.requests.length,
      });
      await modelServer.stop();
      if (previousOpenRouterApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterApiKey;
    },
  };
}
