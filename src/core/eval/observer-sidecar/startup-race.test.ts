import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultObserverEvalSidecarSettings,
  type SubstrateConfig,
} from '../../../system/config/runtime-config-contracts.js';
import { createObserverEvalSidecarRuntimeFromConfig } from './config.js';

// psfn-framework-qicb.4: the agent-process sidecar store is constructed through
// createObserverEvalSidecarRuntimeFromConfig -> createObserverEvalSidecarPersistence
// (config.ts). Like the Garden path guarded by qicb.3, the store starts its
// schema-ensure `ready` promise in its constructor without attaching a rejection
// handler, so a startup Postgres connectivity blip (the kube-router
// netpol-programming race, a ~1s ECONNREFUSED window) would otherwise escape to
// the agent's process-wide unhandledRejection handler. The construction-site
// probe must handle it at the source so a refused pool produces zero
// unhandledRejection.

/**
 * A loopback database URL whose port has no listener, so every connection
 * attempt is refused immediately (ECONNREFUSED) — the netpol-race analogue. A
 * fresh high random port per call also keeps each store out of the
 * databaseUrl-keyed memo in createPostgresObserverEvalSidecarStore.
 */
function refusedDatabaseUrl(): string {
  const port = 20_000 + Math.floor(Math.random() * 40_000);
  return `postgres://psfn@127.0.0.1:${port}/psfn_${port}`;
}

function persistenceEnabledConfig(): Pick<SubstrateConfig, 'observerEvalSidecar' | 'persistenceBackend'> {
  return {
    persistenceBackend: 'postgres',
    observerEvalSidecar: {
      ...createDefaultObserverEvalSidecarSettings(),
      // The top-level sidecar stays disabled so createObserverEvalSidecarPort
      // returns null without needing adapter fields; the persistence store is
      // still constructed (and its `ready` promise started) on this path.
      enabled: false,
      persistence: {
        enabled: true,
        retentionDays: 14,
        maxStoredObservations: 10_000,
      },
    },
  } as unknown as Pick<SubstrateConfig, 'observerEvalSidecar' | 'persistenceBackend'>;
}

describe('observer eval sidecar agent-process startup netpol race (psfn-framework-qicb.4)', () => {
  const captured: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    captured.push(reason);
  };

  beforeEach(() => {
    captured.length = 0;
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
  });

  it('constructs the agent-process persistence against a refused pool without leaking an unhandledRejection', async () => {
    const runtime = createObserverEvalSidecarRuntimeFromConfig(persistenceEnabledConfig(), {
      postgresDatabaseUrl: refusedDatabaseUrl(),
    });
    // The persistence store is wired even though the pool cannot reach Postgres
    // yet; the failure is handled at the source, not swallowed silently.
    expect(runtime.config).toBeDefined();

    // Allow the store's schema-ensure `ready` promise and the construction-site
    // probe query to attempt the refused connection and settle. The
    // unhandledRejection detector fires on the microtask/macrotask boundary, so
    // wait past it before asserting.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(captured).toHaveLength(0);
  });

  it('leaves the persistence-disabled path untouched (no store, no rejection)', async () => {
    const config = persistenceEnabledConfig();
    const disabled = {
      ...config,
      observerEvalSidecar: {
        ...config.observerEvalSidecar,
        persistence: { enabled: false, retentionDays: 14, maxStoredObservations: 10_000 },
      },
    } as unknown as Pick<SubstrateConfig, 'observerEvalSidecar' | 'persistenceBackend'>;

    const runtime = createObserverEvalSidecarRuntimeFromConfig(disabled, {
      postgresDatabaseUrl: refusedDatabaseUrl(),
    });
    expect(runtime.config).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(captured).toHaveLength(0);
  });
});
