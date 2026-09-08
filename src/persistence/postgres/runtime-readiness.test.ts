import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../shared/logger.js';
import {
  POSTGRES_STORE_READINESS_CATALOG,
  PostgresRuntimeReadiness,
  PostgresStoreReadinessError,
  requirePostgresStoreReadinessRetry,
} from './runtime-readiness.js';

describe('PostgresRuntimeReadiness', () => {
  it('fails closed with the required store name and schema mismatch before Ready', async () => {
    const readiness = new PostgresRuntimeReadiness();
    const memory = readiness.start('memory', async () => {
      throw new Error('schema version 12 is missing');
    });

    await expect(memory.waitUntilReady()).rejects.toMatchObject({
      name: 'PostgresStoreReadinessError',
      store: 'memory',
      requirement: 'required',
      mismatch: 'schema version 12 is missing',
    });
    await expect(readiness.sealBeforeReady()).rejects.toThrow(
      'Required PostgreSQL store "memory" is not ready: schema version 12 is missing',
    );
    expect(readiness.snapshot().phase).toBe('failed');
  });

  it('retains an observable optional-store degradation while allowing Ready', async () => {
    const readiness = new PostgresRuntimeReadiness();
    readiness.start('analysis_workbench_trace', async () => {
      throw new Error('migration role cannot create relation');
    });

    const snapshot = await readiness.sealBeforeReady();

    expect(snapshot.phase).toBe('ready');
    expect(snapshot.degraded).toEqual([{
      store: 'analysis_workbench_trace',
      label: 'analysis workbench trace',
      degradesOperatorReadiness: false,
      requirement: 'optional',
      mismatch: 'migration role cannot create relation',
    }]);
    expect(readiness.snapshot()).toEqual(snapshot);
  });

  it.each([
    {
      store: 'analysis_workbench_trace' as const,
      component: 'AnalysisWorkbenchTraceStore',
      message: 'Analysis-workbench trace schema migration failed',
    },
    {
      store: 'model_usage_diagnostics' as const,
      component: 'ModelUsageStore',
      message: 'Model usage schema migration failed',
    },
  ])(
    'preserves the $store incident contract: rejection, named diagnostic, no unhandled escape',
    async ({ store, component, message }) => {
      clearDiagnosticLogRingBufferForTests();
      const unhandled: unknown[] = [];
      const listener = (reason: unknown): void => { unhandled.push(reason); };
      process.on('unhandledRejection', listener);
      try {
        const readiness = new PostgresRuntimeReadiness();
        const handle = readiness.start(store, async () => {
          throw new Error('no schema has been selected to create in');
        });

        // Recreate the incident path: the constructor-created migration has no
        // consumer yet. The coordinator itself must observe it in the same tick.
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        expect(unhandled).toEqual([]);
        await expect(handle.waitUntilReady()).rejects.toMatchObject({
          name: 'PostgresStoreReadinessError',
          store,
          mismatch: 'no schema has been selected to create in',
        });
        await expect(handle.waitUntilReady()).rejects.toMatchObject({ store });
        await expect(readiness.sealBeforeReady()).resolves.toMatchObject({ phase: 'ready' });

        expect(unhandled).toEqual([]);
        const matchingDiagnostics = getRecentDiagnosticLogRecords({ limit: 20 })
          .filter(record => (
            record.level === 'error'
            && record.component === component
            && record.message === message
          ));
        expect(matchingDiagnostics).toHaveLength(1);
      } finally {
        process.off('unhandledRejection', listener);
      }
    },
  );

  // psfn-framework-6c6cq. A first-boot credential race burned the single
  // attempt, logged one ERROR, and left the process advertising Ready with
  // model-usage telemetry silently broken and no recovery line ever written.
  describe('bounded readiness retry', () => {
    it('runs exactly once when no retry budget is declared', async () => {
      const readiness = new PostgresRuntimeReadiness();
      const task = vi.fn(async () => { throw new Error('password authentication failed'); });

      readiness.start('model_usage_diagnostics', task);
      await readiness.sealBeforeReady();

      expect(task).toHaveBeenCalledTimes(1);
    });

    it('retries a transient failure and logs the recovery', async () => {
      clearDiagnosticLogRingBufferForTests();
      const readiness = new PostgresRuntimeReadiness();
      let attempts = 0;
      const task = vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('password authentication failed');
      });

      const handle = readiness.start('model_usage_diagnostics', task, {
        retry: { maxAttempts: 4, backoffMs: 0 },
      });
      await expect(handle.waitUntilReady()).resolves.toBeUndefined();
      const snapshot = await readiness.sealBeforeReady();

      expect(task).toHaveBeenCalledTimes(3);
      expect(snapshot.degraded).toEqual([]);
      expect(snapshot.readyStores).toContain('model_usage_diagnostics');

      const records = getRecentDiagnosticLogRecords({ limit: 50 })
        .filter(record => record.component === 'ModelUsageStore');
      // One line per spent attempt, plus the terminal success line the
      // incident never had, and no terminal error.
      expect(records.filter(record => (
        record.message === 'Model usage schema migration failed; retrying'
      ))).toHaveLength(2);
      const recovery = records.filter(record => (
        record.message === 'PostgreSQL store readiness recovered after retry'
      ));
      expect(recovery).toHaveLength(1);
      expect(recovery[0]?.context).toMatchObject({ attempt: 3 });
      expect(records.some(record => record.level === 'error')).toBe(false);
    });

    it('spends the whole budget, then records one terminal failure', async () => {
      clearDiagnosticLogRingBufferForTests();
      const readiness = new PostgresRuntimeReadiness();
      const task = vi.fn(async () => { throw new Error('password authentication failed'); });

      readiness.start('model_usage_diagnostics', task, {
        retry: { maxAttempts: 3, backoffMs: 0 },
      });
      const snapshot = await readiness.sealBeforeReady();

      expect(task).toHaveBeenCalledTimes(3);
      // Optional stays optional: a persistently failing diagnostic reader must
      // not stop the process reaching Ready.
      expect(snapshot.phase).toBe('ready');
      expect(snapshot.degraded).toEqual([{
        store: 'model_usage_diagnostics',
        label: 'model usage diagnostics',
        // ...but it is no longer an anonymous degraded count: the operator
        // surface is required to reflect this one.
        degradesOperatorReadiness: true,
        requirement: 'optional',
        mismatch: 'password authentication failed',
      }]);

      const records = getRecentDiagnosticLogRecords({ limit: 50 })
        .filter(record => record.component === 'ModelUsageStore');
      expect(records.filter(record => record.level === 'warn')).toHaveLength(2);
      const terminal = records.filter(record => (
        record.level === 'error'
        && record.message === 'Model usage schema migration failed'
      ));
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.context).toMatchObject({ attempt: 3 });
    });

    it('holds the Ready boundary open until the budget is spent', async () => {
      const readiness = new PostgresRuntimeReadiness();
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let attempts = 0;
      readiness.start('model_usage_diagnostics', async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('password authentication failed');
        await barrier;
      }, { retry: { maxAttempts: 2, backoffMs: 0 } });

      let sealed = false;
      const sealing = readiness.sealBeforeReady().then((snapshot) => {
        sealed = true;
        return snapshot;
      });
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      expect(sealed).toBe(false);

      release();
      await expect(sealing).resolves.toMatchObject({ phase: 'ready' });
      expect(attempts).toBe(2);
    });
  });

  describe('requirePostgresStoreReadinessRetry', () => {
    it('refuses an undeclared budget rather than inventing one', () => {
      expect(() => requirePostgresStoreReadinessRetry({})).toThrow(
        'postgresStoreReadinessRetryAttempts and postgresStoreReadinessRetryBackoffMs',
      );
      expect(() => requirePostgresStoreReadinessRetry({
        postgresStoreReadinessRetryAttempts: 3,
      })).toThrow('postgresStoreReadinessRetryBackoffMs');
    });

    it('refuses a budget that could never run or could never wait', () => {
      expect(() => requirePostgresStoreReadinessRetry({
        postgresStoreReadinessRetryAttempts: 0,
        postgresStoreReadinessRetryBackoffMs: 100,
      })).toThrow('must be a positive integer');
      expect(() => requirePostgresStoreReadinessRetry({
        postgresStoreReadinessRetryAttempts: 3,
        postgresStoreReadinessRetryBackoffMs: -1,
      })).toThrow('must be a non-negative number');
    });

    it('accepts the canonical settings.seed.json budget', () => {
      const seed = JSON.parse(
        readFileSync('config/settings.seed.json', 'utf-8'),
      ) as Record<string, number>;
      expect(requirePostgresStoreReadinessRetry(seed)).toEqual({
        maxAttempts: seed.postgresStoreReadinessRetryAttempts,
        backoffMs: seed.postgresStoreReadinessRetryBackoffMs,
      });
    });
  });

  it('does not invoke PostgreSQL startup work registered after Ready', async () => {
    const readiness = new PostgresRuntimeReadiness();
    await readiness.sealBeforeReady();
    const migrate = vi.fn(async () => undefined);

    const late = readiness.start('model_usage_diagnostics', migrate);

    await expect(late.waitUntilReady()).rejects.toMatchObject({
      name: 'PostgresStoreReadinessError',
      store: 'model_usage_diagnostics',
      mismatch: 'runtime DDL/readiness work was registered after Ready',
    });
    expect(migrate).not.toHaveBeenCalled();
  });

  it('fences raw runtime DDL after Ready without blocking a not-yet-ready shard workload', async () => {
    const readiness = new PostgresRuntimeReadiness();
    await readiness.sealBeforeReady();

    expect(() => readiness.assertStartupWorkAllowed('ensure schema')).toThrow(
      'PostgreSQL runtime DDL "ensure schema" is forbidden while readiness is ready',
    );
    expect(() => readiness.assertStartupWorkAllowed(
      'prepare shard schema',
      'isolated_workload_migration',
    )).not.toThrow();
  });

  it('lets registered startup work finish while readiness is settling', async () => {
    const readiness = new PostgresRuntimeReadiness();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    readiness.start('memory', async () => {
      await barrier;
      readiness.assertStartupWorkAllowed('finish registered memory migration');
    });

    const sealing = readiness.sealBeforeReady();
    release();

    await expect(sealing).resolves.toMatchObject({ phase: 'ready' });
  });

  it('keeps the required/optional classification in one exhaustive catalog', () => {
    expect(POSTGRES_STORE_READINESS_CATALOG.memory.requirement).toBe('required');
    expect(POSTGRES_STORE_READINESS_CATALOG.gateway_audit.requirement).toBe('required');
    expect(POSTGRES_STORE_READINESS_CATALOG.icp_initiation_policy.requirement).toBe('required');
    expect(POSTGRES_STORE_READINESS_CATALOG.fleet_auth.requirement).toBe('required');
    expect(POSTGRES_STORE_READINESS_CATALOG.fleet_maintenance.requirement).toBe('required');
    expect(POSTGRES_STORE_READINESS_CATALOG.model_usage_accounting.requirement).toBe('required');
    expect(POSTGRES_STORE_READINESS_CATALOG.automata_bus.requirement).toBe('required');
    expect(POSTGRES_STORE_READINESS_CATALOG.buzz_recovery.requirement).toBe('required');
    expect(POSTGRES_STORE_READINESS_CATALOG.memory_ann_index.requirement).toBe('optional');
    expect(POSTGRES_STORE_READINESS_CATALOG.model_usage_diagnostics.requirement).toBe('optional');
    expect(POSTGRES_STORE_READINESS_CATALOG.analysis_workbench_trace.requirement).toBe('optional');
    expect(POSTGRES_STORE_READINESS_CATALOG.observer_eval_sidecar.requirement).toBe('optional');
    expect(POSTGRES_STORE_READINESS_CATALOG.icp_admin_projection.requirement).toBe('optional');
    expect(POSTGRES_STORE_READINESS_CATALOG.welfare_grant_verifier.requirement).toBe('optional');
    expect(PostgresStoreReadinessError.prototype).toBeInstanceOf(Error);
  });

  it('keeps covered production stores off raw constructor-owned ready promises', () => {
    const coveredSources = [
      './model-usage-store.ts',
      './analysis-workbench-trace-store.ts',
      '../../core/eval/observer-sidecar/persistence.ts',
      '../../faculties/wiki/shared-world-caretaker-store.ts',
      '../../faculties/memory/postgres-store.ts',
    ].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));

    for (const source of coveredSources) {
      expect(source).not.toContain('private readonly ready: Promise<void>');
      expect(source).not.toMatch(/this\.ready\s*=\s*(?:ensure|runPostgres|assertShared)/u);
      expect(source).not.toMatch(/void\s+this\.ready\.catch/u);
    }
    expect(coveredSources.at(-1)).toContain(
      "startPostgresStoreReadiness('memory_ann_index'",
    );
  });

  it('puts the generic and authority-owned schema migrators behind the Ready DDL fence', () => {
    const ddlSources = [
      '../postgres.ts',
      './shared-schema.ts',
      './fleet-auth/schema.ts',
    ].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));

    for (const source of ddlSources) {
      expect(source).toContain('assertPostgresRuntimeDdlAllowed(');
    }
  });

  it('seals gateway and operator PostgreSQL readiness before their listeners advertise Ready', () => {
    const gatewaySource = readFileSync(
      new URL('../../app/gateway/main.ts', import.meta.url),
      'utf8',
    );
    const operatorSource = readFileSync(
      new URL('../../app/operator/main.ts', import.meta.url),
      'utf8',
    );

    const gatewaySealIndex = gatewaySource.indexOf('await sealPostgresStoreReadinessBeforeReady()');
    const gatewayStartIndex = gatewaySource.indexOf('gateway.start()');
    const operatorSealIndex = operatorSource.indexOf('await sealPostgresStoreReadinessBeforeReady()');
    const operatorStartIndex = operatorSource.indexOf('await surface.start()');
    expect(gatewaySealIndex).toBeGreaterThanOrEqual(0);
    expect(gatewayStartIndex).toBeGreaterThanOrEqual(0);
    expect(operatorSealIndex).toBeGreaterThanOrEqual(0);
    expect(operatorStartIndex).toBeGreaterThanOrEqual(0);
    expect(gatewaySealIndex).toBeLessThan(gatewayStartIndex);
    expect(operatorSealIndex).toBeLessThan(operatorStartIndex);
  });
});
