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

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

function exactTenantConfig(overrides: Record<string, unknown> = {}) {
  return {
    multiCompanion: true,
    companionId: COMPANION_A,
    postgresSchema: 'companion_alpha',
    postgresRole: 'companion_alpha_runtime',
    companionFleet: {
      companions: [
        {
          companionId: COMPANION_A,
          postgresSchema: 'companion_alpha',
          postgresRole: 'companion_alpha_runtime',
        },
        {
          companionId: COMPANION_B,
          postgresSchema: 'companion_beta',
          postgresRole: 'companion_beta_runtime',
        },
      ],
    },
    ...overrides,
  };
}

describe('resolveConfigTenantPoolScope (fail-closed tenant boundary)', () => {
  it('pins the manifest tenant in a one-entry deployment', () => {
    const oneEntry = exactTenantConfig({
      multiCompanion: false,
      companionFleet: {
        companions: [{
          companionId: COMPANION_A,
          postgresSchema: 'companion_alpha',
          postgresRole: 'companion_alpha_runtime',
        }],
      },
    });

    expect(resolveConfigTenantPoolScope(oneEntry)).toEqual({
      schema: 'companion_alpha',
      role: 'companion_alpha_runtime',
    });
  });

  it('returns undefined only when no fleet manifest has been projected', () => {
    expect(resolveConfigTenantPoolScope({})).toBeUndefined();
  });

  it('pins the companion schema and role in multi-companion mode', () => {
    expect(resolveConfigTenantPoolScope(exactTenantConfig())).toEqual({
      schema: 'companion_alpha',
      role: 'companion_alpha_runtime',
    });
  });

  it('rejects a valid sibling schema and role instead of treating any tenant as local', () => {
    expect(() => resolveConfigTenantPoolScope(exactTenantConfig({
      postgresSchema: 'companion_beta',
      postgresRole: 'companion_beta_runtime',
    }))).toThrow(/does not match the exact companion tenant authority/u);
  });

  it('rejects missing or unknown companion identity before a tenant pool opens', () => {
    expect(() => resolveConfigTenantPoolScope(exactTenantConfig({
      companionId: undefined,
    }))).toThrow(/exact config\.companionId/u);
    expect(() => resolveConfigTenantPoolScope(exactTenantConfig({
      companionId: '33333333-3333-4333-8333-333333333333',
    }))).toThrow(/not present in config\.companionFleet/u);
  });

  it('refuses to default to public when the tenant schema is missing', () => {
    expect(() =>
      resolveConfigTenantPoolScope({
        multiCompanion: true,
        companionId: COMPANION_A,
        companionFleet: exactTenantConfig().companionFleet,
        postgresRole: 'companion_follower_runtime',
      }),
    ).toThrow(/postgresSchema/);
  });

  it('refuses to default to public when the tenant role is missing', () => {
    expect(() =>
      resolveConfigTenantPoolScope({
        multiCompanion: true,
        companionId: COMPANION_A,
        companionFleet: exactTenantConfig().companionFleet,
        postgresSchema: 'companion_follower',
      }),
    ).toThrow(/postgresRole/);
  });
});

describe('resolveFleetLedgerPoolScope (explicit fleet-wide read scope)', () => {
  // Regression coverage for psfn-framework-vzh0u: the ICP admin cost projection
  // pool used to open with no schema and read the fleet-wide
  // icp_conversation_cost_decisions ledger through the libpq default
  // `"$user", public` search_path. The fleet ledger now lives in the canonical
  // first companion's schema and followers reach it under their own exact role.

  it('pins the canonical fleet ledger schema and current role in multi-companion mode', () => {
    expect(resolveFleetLedgerPoolScope({
      multiCompanion: true,
      companionFleet: {
        companions: [{ postgresSchema: 'companion_primary' }],
      },
      postgresRole: 'companion_follower_runtime',
    })).toEqual({
      schema: 'companion_primary',
      role: 'companion_follower_runtime',
    });
  });

  it('fails closed when canonical topology or the current role is missing', () => {
    expect(() => resolveFleetLedgerPoolScope({
      multiCompanion: true,
      postgresRole: 'companion_follower_runtime',
    })).toThrow(/canonical companion schema/u);
    expect(() => resolveFleetLedgerPoolScope({
      multiCompanion: true,
      companionFleet: {
        companions: [{ postgresSchema: 'companion_primary' }],
      },
    })).toThrow(/current runtime role/u);
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

  // Model usage is deliberately absent here: it resolves the canonical first
  // companion's ledger schema (not the current follower's tenant schema) in
  // createPostgresModelUsageStoreFromConfig, with dedicated read-only coverage
  // in model-usage-store.test.ts and named-tenant-store-boot.integration.test.ts.
  // The analysis-workbench trace store resolves its own tenant scope and is covered by
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
