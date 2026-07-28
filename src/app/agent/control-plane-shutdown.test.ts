import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWorkHandoffRecoveryRuntime } from '../../core/agent/background-work/handoff-recovery-runtime.js';
import { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { createFilesystemTurnRecordStorePort } from '../../persistence/sessions/turn-records.js';
import { sanitizeChannelId } from '../../persistence/sessions/store-file-contracts.js';
import { EventBus } from '../../shared/event-bus.js';
import {
  ExternalCommunicationRateLimiter,
  LifecycleRestartSafeguard,
} from '../../system/capabilities/safeguards.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { lifecycleKubernetesSettingsFixture } from '../../test-support/lifecycle-kubernetes-settings.js';
import {
  buildAgentControlPlane,
  type BuildAgentControlPlaneOptions,
} from './control-plane.js';

const RECOVERY_SCRATCH_PREFIX = 'turn-record-recovery-';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = probe();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function listRecoveryScratchNames(): Set<string> {
  return new Set(
    readdirSync(tmpdir(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith(RECOVERY_SCRATCH_PREFIX))
      .map(entry => entry.name),
  );
}

function findNewRecoveryScratch(baseline: ReadonlySet<string>): string | undefined {
  for (const name of listRecoveryScratchNames()) {
    if (baseline.has(name)) continue;
    const path = join(tmpdir(), name);
    if (existsSync(join(path, 'snapshot.sqlite'))) return path;
  }
  return undefined;
}

function createAgentLoopDouble(properties: Record<string, unknown> = {}): SubstrateAgent {
  return Object.assign(
    Object.create(SubstrateAgent.prototype) as object,
    {
      registerTool: vi.fn(),
      getToolCatalog: () => ({ extended: [] }),
      registerPostTurnActionInferer: () => () => undefined,
    },
    properties,
  ) as SubstrateAgent;
}

function buildShutdownControlPlane(
  scheduler: Scheduler,
  agentLoop: SubstrateAgent,
  eventBus: EventBus,
): ReturnType<typeof buildAgentControlPlane> {
  return buildAgentControlPlane({
    dataDir: tmpdir(),
    config: {
      lifecycleKubernetes: lifecycleKubernetesSettingsFixture(),
    } as SubstrateConfig,
    eventBus,
    gateway: {
      discordSend: vi.fn(async () => undefined),
      clarifyDeliver: vi.fn(async () => {
        throw new Error('clarification is not exercised by shutdown tests');
      }),
      destroy: vi.fn(async () => undefined),
    },
    unregisterGatewayDisconnect: vi.fn(),
    stopDebugObserver: vi.fn(),
    writeGracefulShutdownMarkers: vi.fn(),
    closeDatabase: vi.fn(),
    scheduler,
    moduleLoader: {
      shutdown: vi.fn(async () => undefined),
    },
    memoryExtractor: {
      stop: vi.fn(async () => true),
    },
    agentLoop,
    operatorNotifier: {
      notify: vi.fn(async () => ({
        status: 'sent',
        topic: 'test',
      })),
    },
    lifecycleRestartSafeguard: new LifecycleRestartSafeguard(),
    externalRateLimiter: new ExternalCommunicationRateLimiter(),
    capabilityRuntime: {
      has: () => false,
      getTier: () => 'autonomous',
    },
    lifecycleRuntimeContract: {
      mode: 'split',
      restart: {
        strategy: 'reexec',
        source: 'mode-default',
        exitCode: 75,
      },
    },
    shutdownTargets: {},
    postTurnActions: {
      registerHandler: () => () => undefined,
    },
  } as unknown as BuildAgentControlPlaneOptions);
}

describe('agent control-plane recovery shutdown', () => {
  beforeEach(() => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '');
    vi.stubEnv('PSFN_KUBE_SELF_MANAGEMENT_ENABLED', 'false');
    vi.stubEnv('EXTRACTION_DRAIN_TIMEOUT_MS', '10000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('aborts an in-flight recovery before scheduler drain and still drains the supervisor', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-control-plane-shutdown-'));
    const sourceChannelId = 'api:shutdown-recovery';
    const turnRecordsDir = join(sessionsDir, '_turn_records');
    const activePath = join(turnRecordsDir, `${sanitizeChannelId(sourceChannelId)}.jsonl`);
    mkdirSync(turnRecordsDir, { recursive: true });
    mkdirSync(`${activePath}.rotate-lock`);

    const scratchBaseline = listRecoveryScratchNames();
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus);
    const supervisorDrain = deferred();
    const order: string[] = [];
    let abortEvents = 0;
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    const recoveryRuntime = new BackgroundWorkHandoffRecoveryRuntime({
      streamRecoverableBackgroundWorkTurnRecords: (signal) => {
        signal?.addEventListener('abort', () => {
          abortEvents += 1;
        });
        return store.streamTurnRecordsForRecovery!([sourceChannelId], { signal });
      },
      deferWorkerValidatedBackgroundWorkHandoffRecovery: () => undefined,
      recoverPendingBackgroundWorkHandoffs: async () => 0,
    });

    const agentLoop = createAgentLoopDouble({
      backgroundWorkHandoffRecoveryRuntime: recoveryRuntime,
      backgroundWorkSupervisor: {
        stop: async () => {
          order.push('supervisor-drain:start');
          await supervisorDrain.promise;
          order.push('supervisor-drain:end');
        },
      },
      abortBackgroundWorkRecovery() {
        order.push('abort-recovery');
        SubstrateAgent.prototype.abortBackgroundWorkRecovery.call(this);
      },
    });
    const originalSchedulerStop = scheduler.stop.bind(scheduler);
    scheduler.stop = async () => {
      order.push('scheduler-stop:start');
      await originalSchedulerStop();
      order.push('scheduler-stop:end');
    };
    scheduler.register({
      id: 'recover-background-work',
      name: 'recover background work',
      type: 'every',
      intervalMs: 60_000,
      state: 'idle',
      handler: () => recoveryRuntime.recover(async () => undefined),
    });

    let tickPromise: Promise<void> | undefined;
    let stopPromise: Promise<void> | undefined;
    let scratchPath: string | undefined;
    try {
      tickPromise = scheduler.tick();
      scratchPath = await waitFor(() => findNewRecoveryScratch(scratchBaseline));

      let stopCompleted = false;
      const shutdownStartedAt = Date.now();
      stopPromise = buildShutdownControlPlane(scheduler, agentLoop, eventBus).stopFn();
      void stopPromise.then(() => {
        stopCompleted = true;
      });

      await waitFor(() => !existsSync(scratchPath!) ? true : undefined);
      expect(Date.now() - shutdownStartedAt).toBeLessThan(1_000);
      expect(stopCompleted).toBe(false);
      expect(abortEvents).toBe(1);
      expect(order.indexOf('abort-recovery')).toBeLessThan(order.indexOf('scheduler-stop:start'));
      expect(order.indexOf('scheduler-stop:start')).toBeLessThan(order.indexOf('scheduler-stop:end'));
      expect(order.indexOf('scheduler-stop:end')).toBeLessThan(
        order.indexOf('supervisor-drain:start'),
      );

      supervisorDrain.resolve();
      await stopPromise;
      await tickPromise;
      expect(order.at(-1)).toBe('supervisor-drain:end');
      expect(order.filter(entry => entry === 'abort-recovery')).toHaveLength(1);
      expect(abortEvents).toBe(1);
    } finally {
      recoveryRuntime.abort();
      supervisorDrain.resolve();
      await Promise.allSettled([
        ...(tickPromise ? [tickPromise] : []),
        ...(stopPromise ? [stopPromise] : []),
      ]);
      if (scratchPath) {
        expect(existsSync(scratchPath)).toBe(false);
      }
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('fails closed before scheduler drain and permits a later shutdown retry', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus);
    const schedulerStop = vi.spyOn(scheduler, 'stop');
    const stopBackgroundWork = vi.fn(async () => undefined);
    const abortBackgroundWorkRecovery = vi.fn(() => {
      if (abortBackgroundWorkRecovery.mock.calls.length <= 2) {
        throw new Error('injected recovery abort failure');
      }
    });
    const controlPlane = buildShutdownControlPlane(
      scheduler,
      createAgentLoopDouble({
        abortBackgroundWorkRecovery,
        stopBackgroundWork,
      }),
      eventBus,
    );

    await expect(controlPlane.stopFn()).rejects.toThrow('injected recovery abort failure');
    expect(schedulerStop).not.toHaveBeenCalled();
    expect(stopBackgroundWork).not.toHaveBeenCalled();

    await expect(controlPlane.stopFn()).resolves.toBeUndefined();
    expect(abortBackgroundWorkRecovery).toHaveBeenCalledTimes(3);
    expect(schedulerStop).toHaveBeenCalledTimes(1);
    expect(stopBackgroundWork).toHaveBeenCalledTimes(1);
  });
});
