import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for psfn-framework-3ack: a per-companion runtime pool
// left on the default `"$user", public` search_path crashes a multi-companion
// follower at boot ("no schema has been selected to create in") and would
// otherwise resolve unqualified reads against the primary tenant's public
// schema. The store factories must pin the tenant search_path/role instead.

const postgresMocks = vi.hoisted(() => ({
  createPostgresPool: vi.fn((_databaseUrl: string, _options?: Record<string, unknown>) => ({}) as Pool),
  runPostgresMigrations: vi.fn(async () => undefined),
  ensurePostgresSchemaWithAdvisoryLock: vi.fn(async () => undefined),
  ensurePostgresSchema: vi.fn(async () => undefined),
  queryOne: vi.fn(async () => undefined),
  queryRows: vi.fn(async () => []),
  executeQuery: vi.fn(async () => undefined),
  withPostgresClient: vi.fn(async () => undefined),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: postgresMocks.createPostgresPool,
  runPostgresMigrations: postgresMocks.runPostgresMigrations,
  ensurePostgresSchemaWithAdvisoryLock: postgresMocks.ensurePostgresSchemaWithAdvisoryLock,
  ensurePostgresSchema: postgresMocks.ensurePostgresSchema,
  queryOne: postgresMocks.queryOne,
  queryRows: postgresMocks.queryRows,
  executeQuery: postgresMocks.executeQuery,
  withPostgresClient: postgresMocks.withPostgresClient,
}));

import {
  FLEET_LEDGER_SCHEMA,
  resolveConfigTenantPoolScope,
  resolveFleetLedgerPoolScope,
} from './tenant-pool-scope.js';
import { createPostgresObserverEvalSidecarStore } from '../../core/eval/observer-sidecar/persistence.js';
import { createObserverEvalSidecarRuntimeFromConfig } from '../../core/eval/observer-sidecar/config.js';
import { createDefaultObserverEvalSidecarSettings } from '../../system/config/runtime-config-contracts.js';

const BASE_CONFIG = {
  persistenceBackend: 'postgres',
  postgresDatabaseUrl: 'postgres://tenant@localhost:5432/psfn',
  companionId: 'companion-under-test',
} as const;

describe('resolveConfigTenantPoolScope (fail-closed tenant boundary)', () => {
  it('returns undefined in single-companion mode (public is the sole tenant)', () => {
    expect(resolveConfigTenantPoolScope({ multiCompanion: false })).toBeUndefined();
    expect(resolveConfigTenantPoolScope({})).toBeUndefined();
  });

  it('pins the companion schema and role in multi-companion mode', () => {
    expect(
      resolveConfigTenantPoolScope({
        multiCompanion: true,
        postgresSchema: 'companion_follower',
        postgresRole: 'companion_follower_runtime',
      }),
    ).toEqual({ schema: 'companion_follower', role: 'companion_follower_runtime' });
  });

  it('refuses to default to public when the tenant schema is missing', () => {
    expect(() =>
      resolveConfigTenantPoolScope({
        multiCompanion: true,
        postgresRole: 'companion_follower_runtime',
      }),
    ).toThrow(/postgresSchema/);
  });

  it('refuses to default to public when the tenant role is missing', () => {
    expect(() =>
      resolveConfigTenantPoolScope({
        multiCompanion: true,
        postgresSchema: 'companion_follower',
      }),
    ).toThrow(/postgresRole/);
  });
});

describe('resolveFleetLedgerPoolScope (explicit fleet-wide read scope)', () => {
  // Regression coverage for psfn-framework-vzh0u: the ICP admin cost projection
  // pool used to open with no schema and read the fleet-wide
  // icp_conversation_cost_decisions ledger through the libpq default
  // `"$user", public` search_path. Operator ruling 2026-07-28: aggregation
  // across companions is intentional (shared budget pool), so the fix only makes
  // the target schema explicit and fails closed when the scope is ambiguous.

  it('pins the public fleet ledger schema in multi-companion mode', () => {
    expect(resolveFleetLedgerPoolScope({ multiCompanion: true })).toEqual({
      schema: FLEET_LEDGER_SCHEMA,
    });
    expect(FLEET_LEDGER_SCHEMA).toBe('public');
  });

  it('never carries a role (a public search_path with a role would be rejected)', () => {
    expect(resolveFleetLedgerPoolScope({ multiCompanion: true })).not.toHaveProperty('role');
  });

  it('fails closed in single-companion mode rather than opening an unscoped pool', () => {
    expect(() => resolveFleetLedgerPoolScope({ multiCompanion: false })).toThrow(
      /multi-companion mode/u,
    );
    expect(() => resolveFleetLedgerPoolScope({})).toThrow(/multi-companion mode/u);
  });
});

describe('per-companion store factories forward the tenant pool scope', () => {
  beforeEach(() => {
    postgresMocks.createPostgresPool.mockClear();
  });

  // Model-usage is deliberately absent here: `model_usage_events` is a
  // fleet-wide ledger written by the gateway and aggregated across companions
  // by the fleet Garden, so it must NOT be pinned to a companion schema
  // (psfn-framework-stmof). The analysis-workbench trace store resolves its own
  // tenant scope from config and is covered by
  // `named-tenant-store-boot.integration.test.ts`.

  it('pins observer-eval-sidecar pools to the companion schema and role when scoped', () => {
    // nowMs bypasses the databaseUrl-keyed store memoization so this row always
    // opens a fresh pool and can assert the tenant scope reaches createPostgresPool.
    createPostgresObserverEvalSidecarStore(
      BASE_CONFIG.postgresDatabaseUrl,
      { nowMs: () => 0 },
      { schema: 'companion_follower', role: 'companion_follower_runtime' },
    );

    expect(postgresMocks.createPostgresPool).toHaveBeenCalledTimes(1);
    expect(postgresMocks.createPostgresPool).toHaveBeenCalledWith(
      BASE_CONFIG.postgresDatabaseUrl,
      expect.objectContaining({
        schema: 'companion_follower',
        role: 'companion_follower_runtime',
      }),
    );
  });

  it('leaves observer-eval-sidecar pools unscoped in single-companion mode', () => {
    createPostgresObserverEvalSidecarStore(
      BASE_CONFIG.postgresDatabaseUrl,
      { nowMs: () => 0 },
    );

    const options = postgresMocks.createPostgresPool.mock.calls[0]?.[1] ?? {};
    expect(options).not.toHaveProperty('schema');
    expect(options).not.toHaveProperty('role');
  });

  it('forwards the tenant scope through the sidecar runtime-from-config write path', () => {
    // The agent follower builds its sidecar (and its memoized write store) here;
    // this is the first-firing pool that decides the tenant scope. A distinct
    // databaseUrl avoids the module-level store memo carrying across rows.
    const settings = createDefaultObserverEvalSidecarSettings();
    settings.persistence.enabled = true;

    createObserverEvalSidecarRuntimeFromConfig(
      { observerEvalSidecar: settings, persistenceBackend: 'postgres' },
      {
        postgresDatabaseUrl: 'postgres://follower@localhost:5432/psfn',
        tenant: { schema: 'companion_follower', role: 'companion_follower_runtime' },
      },
    );

    expect(postgresMocks.createPostgresPool).toHaveBeenCalledTimes(1);
    expect(postgresMocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://follower@localhost:5432/psfn',
      expect.objectContaining({
        schema: 'companion_follower',
        role: 'companion_follower_runtime',
      }),
    );
  });
});
