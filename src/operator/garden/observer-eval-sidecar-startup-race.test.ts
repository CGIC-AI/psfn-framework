import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultObserverEvalSidecarSettings,
  type SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import { createObserverEvalSidecarAdminService } from './local-admin-contract.js';

// psfn-framework-qicb.3: at pod start a kube-router netpol-programming race
// leaves a ~1s window where the Postgres endpoint refuses connections. The
// observer-eval sidecar store starts its schema-ensure `ready` promise in its
// constructor; before this fix that unobserved rejection escaped to the
// process-wide unhandledRejection handler. createObserverEvalSidecarAdminService
// must now observe that startup connectivity at the Garden construction site so
// a refused pool produces zero unhandledRejection.

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

function persistenceEnabledConfig(databaseUrl: string): SubstrateConfig {
  return {
    persistenceBackend: 'postgres',
    postgresDatabaseUrl: databaseUrl,
    observerEvalSidecar: {
      ...createDefaultObserverEvalSidecarSettings(),
      enabled: true,
      persistence: {
        enabled: true,
        retentionDays: 14,
        maxStoredObservations: 10_000,
      },
      garden: {
        exposeHealth: true,
        exposeTelemetry: true,
      },
    },
  } as unknown as SubstrateConfig;
}

describe('observer eval sidecar startup netpol race (psfn-framework-qicb.3)', () => {
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

  it('constructs against a refused pool without leaking an unhandledRejection', async () => {
    const service = createObserverEvalSidecarAdminService({
      config: persistenceEnabledConfig(refusedDatabaseUrl()),
    });
    // The persistence-backed service is wired even though the pool cannot reach
    // Postgres yet; the failure is handled at the source, not swallowed silently.
    expect(service).toBeDefined();

    // Allow the store's schema-ensure `ready` promise and the construction-site
    // observation query to attempt the refused connection and settle. The
    // unhandledRejection detector fires on the microtask/macrotask boundary, so
    // wait past it before asserting.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(captured).toHaveLength(0);
  });

  it('leaves the persistence-disabled path untouched (no pool, no rejection)', async () => {
    const config = persistenceEnabledConfig(refusedDatabaseUrl());
    const disabled = {
      ...config,
      observerEvalSidecar: {
        ...config.observerEvalSidecar,
        persistence: { enabled: false, retentionDays: 14, maxStoredObservations: 10_000 },
      },
    } as unknown as SubstrateConfig;

    const service = createObserverEvalSidecarAdminService({ config: disabled });
    expect(service).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(captured).toHaveLength(0);
  });

  it('reports the production posture from emosimProactivity rather than eval levers', async () => {
    const config = persistenceEnabledConfig(refusedDatabaseUrl());
    config.observerEvalSidecar!.levers = {
      ...config.observerEvalSidecar!.levers,
      enabled: true,
    };
    config.emosimProactivity = {
      mode: 'off',
      thresholdProfile: {
        profileId: 'emosim-would-message-v1',
        socialNeedThreshold: 0.7,
        attachmentIntensityThreshold: 0.5,
        sustainMs: 1_800_000,
        cooldownMs: 21_600_000,
      },
    };

    const service = createObserverEvalSidecarAdminService({ config });

    await expect(service.getHealth()).resolves.toMatchObject({
      proactivityMode: 'off',
    });
  });
});
