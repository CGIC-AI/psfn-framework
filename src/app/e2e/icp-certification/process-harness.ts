import { fork, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GatewayServer } from '../../../boundary/gateway/server.js';
import { GatewayCapabilityTierResolver } from '../../../boundary/gateway/capability-tier-resolver.js';
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
import { createPostgresPool, quotePostgresRoleName } from '../../../persistence/postgres.js';
import { PostgresCompanionPresenceStore } from '../../../persistence/postgres/companion-presence-store.js';
import { PostgresIcpFatigueRegulationReservationStore } from '../../../persistence/postgres/icp-fatigue-regulation-reservation-store.js';
import { PostgresIcpInitiationPolicyAuthority } from '../../../persistence/postgres/icp-initiation-policy-authority.js';
import { PostgresIcpSharedAutonomyStore } from '../../../persistence/postgres/icp-shared-autonomy-store.js';
import { grantFleetModelUsageReadAccess } from '../../../persistence/postgres/model-usage-access.js';
import { PostgresModelUsageStore } from '../../../persistence/postgres/model-usage-store.js';
import { bootstrapSharedSchema } from '../../../persistence/postgres/shared-schema.js';
import { createGatewayFleetChargePolicyResolver } from '../../gateway/fleet-charge-policy-resolver.js';
import {
  assertPostgresTenantAccessProvisioned,
  planPostgresTenantAccess,
  provisionPostgresTenantAccess,
} from '../../../persistence/postgres/tenancy.js';
import { loadAgentConfig } from '../../../system/config/load-config.js';
import { hydrateJsonBackedRuntimeConfig } from '../../../system/config/runtime-config.js';
import { CapabilityRuntime } from '../../../system/capabilities/runtime.js';
import { loadPlacesRegistryConfig } from '../../../channels/backplane/places-registry.js';
import { createCompanionId, type CompanionId } from '../../../shared/routing/companion-id.js';
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
// Password for the disposable per-companion tenant login the agents connect as.
// Test-only; the whole cluster is a throwaway dockerized postgres.
const CERTIFICATION_TENANT_PASSWORD = 'icp-certification-tenant-role-not-for-production';
const START_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

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
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readyResolve!: (value: CertificationAgentReady) => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise: Promise<CertificationAgentReady>;
  private readonly exitPromise: Promise<void>;

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
    this.exitPromise = new Promise<void>((resolveExit) => {
      child.once('exit', (code, signal) => {
        const error = new Error(
          `ICP certification agent ${fixture.companionId} exited `
          + `(code=${String(code)}, signal=${String(signal)})`,
        );
        this.readyReject(error);
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timeout);
          waiter.reject(error);
        }
        this.pending.clear();
        resolveExit();
      });
    });
  }

  get processId(): number {
    if (this.child.pid === undefined) {
      throw new Error(`ICP certification agent ${this.fixture.companionId} has no process id`);
    }
    return this.child.pid;
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

  async sendRoomProbe(
    phase: 'post_exit' | 'pre_entry' | 'rejoined',
  ): Promise<Record<string, unknown>> {
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

  async pendingBackgroundWorkCount(): Promise<number> {
    const result = await this.request({ type: 'background_work_snapshot' });
    if (typeof result !== 'object' || result === null
      || !('pending' in result) || typeof result.pending !== 'number') {
      throw new Error('ICP certification background-work snapshot is malformed');
    }
    return result.pending;
  }

  async hasCompletedFatigueSuppression(
    channelId: string,
    rootInitiationId: string,
  ): Promise<boolean> {
    const result = await this.request({
      type: 'has_completed_fatigue_suppression',
      channelId,
      rootInitiationId,
    });
    if (typeof result !== 'object' || result === null
      || !('completed' in result) || typeof result.completed !== 'boolean') {
      throw new Error('ICP certification fatigue-suppression result is malformed');
    }
    return result.completed;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    if (this.child.connected) {
      await this.request({ type: 'shutdown' });
    }
    try {
      await this.waitForExit(STOP_TIMEOUT_MS);
    } catch (error) {
      this.forceStop();
      await this.waitForExit(STOP_TIMEOUT_MS).catch(() => {
        throw error;
      });
    }
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
    clearTimeout(waiter.timeout);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? 'ICP certification agent request failed'));
  }

  private async request(command: Record<string, unknown> & { type: string }): Promise<unknown> {
    const id = ++this.nextRequestId;
    const result = new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(
          `Timed out waiting for ICP certification agent command ${command.type}`,
        ));
      }, COMMAND_TIMEOUT_MS);
      timeout.unref();
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
    });
    this.child.send({ id, ...command });
    return await result;
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(
            `Timed out waiting for ICP certification agent ${this.fixture.companionId} to exit`,
          )), timeoutMs);
          timeoutHandle.unref();
        }),
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
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

/**
 * Provision the production tenant boundary the multi-companion agents verify at
 * startup. The gateway migration authority (bootstrapSharedSchema) has already
 * owned the shared schema; here we mirror the operator/launcher step:
 *
 *  - EVERY companion in the fleet manifest gets its own tenant schema owned by
 *    its configured `postgresRole` (companions.json), including support
 *    companions that never boot an agent — the agent's runtime-authority proof
 *    checks the full fleet schema set and reciprocal isolation.
 *  - Each companion role is turned into the least-privilege LOGIN authority
 *    required by the production fleet topology: own-schema owner + DML-only
 *    shared access with a SELECT-only migrations ledger, NOINHERIT, finite
 *    connection limit, no cluster attributes, no role memberships. Credentials
 *    are written only for the two companions this process harness boots.
 */
async function provisionCertificationTenantBoundaries(
  databaseUrl: string,
  fixture: IcpCertificationFixture,
): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(join(fixture.systemDataDir, 'companions.json'), 'utf8'),
  ) as { companions: Array<{ companionId: string; postgresSchema: string; postgresRole: string }> };
  const bootedById = new Map(
    fixture.companions.map(companion => [companion.companionId, companion]),
  );
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-icp-certification-tenant-provisioning',
    max: 1,
  });
  try {
    const login = await pool.query<{ runtime_login_role: string }>(
      'SELECT current_user::text AS runtime_login_role',
    );
    const runtimeLoginRole = login.rows.at(0)?.runtime_login_role;
    if (!runtimeLoginRole) {
      throw new Error('ICP certification could not resolve the disposable PostgreSQL login role');
    }
    for (const entry of manifest.companions) {
      const plan = planPostgresTenantAccess({
        schema: entry.postgresSchema,
        // The agent runtime asserts the schema is owned by its configured
        // tenant role (companions.json), not the derived default. Provision the
        // same role here so the boundary the agent verifies actually exists.
        role: entry.postgresRole,
        approvedSharedSchema: 'shared',
        approvedSharedAccess: 'read_write',
      });
      await provisionPostgresTenantAccess(pool, {
        plan,
        runtimeLoginRole,
        relocateExtensions: ['vector'],
      });
      await assertPostgresTenantAccessProvisioned(pool, plan);

      const role = quotePostgresRoleName(entry.postgresRole);
      // The migrations ledger is SELECT-only for a runtime credential; the
      // read_write tenant grant included it, so narrow it back.
      await pool.query(
        `REVOKE INSERT, UPDATE, DELETE ON shared.shared_schema_migrations FROM ${role}`,
      );
      // Turn the NOLOGIN owner into the least-privilege login the agent uses.
      // The authority check only requires a finite limit >= 1; an agent opens
      // many runtime pools, so the cap is generous but still bounded.
      await pool.query(
        `ALTER ROLE ${role} LOGIN CONNECTION LIMIT 100 PASSWORD '${CERTIFICATION_TENANT_PASSWORD}'`,
      );
      const booted = bootedById.get(entry.companionId);
      if (!booted) continue;
      const credentialFile = booted.env.POSTGRES_DATABASE_URL_FILE;
      if (!credentialFile) {
        throw new Error(
          `ICP certification companion ${entry.companionId} is missing POSTGRES_DATABASE_URL_FILE`,
        );
      }
      const roleUrl = new URL(databaseUrl);
      roleUrl.username = entry.postgresRole;
      roleUrl.password = CERTIFICATION_TENANT_PASSWORD;
      writeFileSync(credentialFile, `${roleUrl.toString()}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  } finally {
    await pool.end();
  }
}

export async function startIcpCertificationProcessHarness(input: {
  databaseUrl: string;
  fixture: IcpCertificationFixture;
  channelRouting?: GatewayMultiCompanionConfig['channelRouting'];
}): Promise<IcpCertificationProcessHarness> {
  const modelServer = await startIcpCertificationModelServer();
  const artifacts = new IcpCertificationArtifactRecorder(input.fixture.artifactsPath);
  artifacts.append({ kind: 'harness_lifecycle', state: 'started', modelRequestCount: 0 });
  configureIcpCertificationModelEndpoint(input.fixture, modelServer.baseUrl);
  const previousOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'icp-certification-loopback-key';
  // This hand-composed harness stands in for the production gateway migration
  // authority. Establish both the shared and companion schemas before loading
  // the primary agent credential used by the canonical model-usage owner.
  await bootstrapSharedSchema(input.databaseUrl);
  await provisionCertificationTenantBoundaries(input.databaseUrl, input.fixture);
  const config = hydrateJsonBackedRuntimeConfig(
    loadAgentConfig(input.fixture.companions[0].env),
    { seedDir: input.fixture.companions[0].env.CONFIG_DIR },
  );
  const companionFleet = config.companionFleet;
  const primary = companionFleet?.companions.at(0);
  const ownerDatabaseUrl = config.postgresDatabaseUrl;
  if (!companionFleet || !primary || !ownerDatabaseUrl) {
    throw new Error('ICP certification requires canonical fleet model-usage authority');
  }
  const capabilityTierResolver = new GatewayCapabilityTierResolver({
    baseRuntime: new CapabilityRuntime({ dataDir: primary.companionDataDir }),
    multiCompanion: true,
    companionFleet,
  });
  const fleet = input.fixture.companions.map(companion => ({
    companionId: createCompanionId(companion.companionId, 'certification fleet companionId'),
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
  const modelUsagePool = createPostgresPool(ownerDatabaseUrl, {
    applicationName: 'psfn-icp-certification-model-usage',
    allowExitOnIdle: true,
    schema: primary.postgresSchema,
    role: primary.postgresRole,
  });
  const modelUsage = new PostgresModelUsageStore(modelUsagePool, { fleetAggregation: true });
  await modelUsage.waitUntilReady();
  await grantFleetModelUsageReadAccess({
    ownerDatabaseUrl,
    primarySchema: primary.postgresSchema,
    primaryRole: primary.postgresRole,
    followerRoles: companionFleet.companions.slice(1).map(
      companion => companion.postgresRole,
    ),
  });
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
  const companionIds: CompanionId[] = [
    createCompanionId(CERTIFICATION_COMPANION_A, 'certification companion A'),
    createCompanionId(CERTIFICATION_COMPANION_B, 'certification companion B'),
  ];
  const presence = await PostgresCompanionPresenceStore.connect(input.databaseUrl);
  const autonomy = await PostgresIcpSharedAutonomyStore.connect(input.databaseUrl, {
    knownCompanionIds: companionIds,
  });
  const fatigue = await PostgresIcpFatigueRegulationReservationStore.connect(input.databaseUrl);
  const authority = new PostgresIcpInitiationPolicyAuthority(input.databaseUrl, {
    fleet,
    capacityAuthority: new IcpFatigueInitiationCapacityAuthority(
      fatigue,
      {
        read: ({ senderCompanionId }) => resolveChargePolicy(senderCompanionId),
      },
      {
        read: ({ senderCompanionId, nowMs }) => {
          const companion = fleetById.get(createCompanionId(senderCompanionId, 'senderCompanionId'));
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
    channelRouting: { ...(input.channelRouting ?? {}) },
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
    intakeScreeningMode: 'off',
    intakeScreeningProvider: () => null,
    visionIntakeProvider: () => null,
    sessionHmacKeyring: CERTIFICATION_SESSION_KEYRING,
    wyomingShardRouting: { enabled: false },
    multiCompanion,
    companionChannels: lane,
    icpAutonomyStore: autonomy,
    icpInitiationPolicyAuthority: authority,
    capabilityTierProvider: companionId => capabilityTierResolver.resolveTier(companionId),
    capabilityGrantSnapshotProvider: companionId =>
      capabilityTierResolver.snapshotOwnerGrantStrict(companionId),
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
    intakeScreeningMode: 'off',
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
