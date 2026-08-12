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
    expect(POSTGRES_STORE_READINESS_CATALOG.model_usage_accounting.requirement).toBe('required');
    expect(POSTGRES_STORE_READINESS_CATALOG.automata_bus.requirement).toBe('required');
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
