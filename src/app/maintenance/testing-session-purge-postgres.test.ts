import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { PostgresSessionAdapters } from '../../persistence/sessions/postgres-adapters.js';
import { createTestingSessionPurgePostgresAdapters } from './testing-session-purge-postgres.js';

const DATABASE_URL = 'postgresql://maintenance@example.invalid/psfn';
const FLEET_ROLE = 'psfn_companion_alpha_a629819705fa71b94777dc6f';

function adaptersFixture(): PostgresSessionAdapters {
  return {} as PostgresSessionAdapters;
}

describe('createTestingSessionPurgePostgresAdapters', () => {
  it('preflights the canonical fleet tenant boundary before opening the scoped adapter', async () => {
    const events: string[] = [];
    const pool = {
      end: vi.fn(async () => {
        events.push('end');
      }),
    } as unknown as Pool;
    const adapters = adaptersFixture();
    const createPostgresPool = vi.fn(() => {
      events.push('pool');
      return pool;
    });
    const assertPostgresTenantAccessProvisioned = vi.fn(async () => {
      events.push('preflight');
    });
    const createDefaultPostgresSessionAdapters = vi.fn(async () => {
      events.push('adapters');
      return adapters;
    });

    await expect(createTestingSessionPurgePostgresAdapters({
      databaseUrl: DATABASE_URL,
      multiCompanion: true,
      postgresSchema: 'companion_alpha',
      sessionsDir: '/runtime/companions/alpha/state/sessions',
      dependencies: {
        assertPostgresTenantAccessProvisioned,
        createDefaultPostgresSessionAdapters,
        createPostgresPool,
      },
    })).resolves.toBe(adapters);

    expect(events).toEqual(['pool', 'preflight', 'end', 'adapters']);
    expect(createPostgresPool).toHaveBeenCalledWith(DATABASE_URL, {
      applicationName: 'testing-session-purge-tenant-preflight',
      allowExitOnIdle: true,
      max: 1,
    });
    expect(assertPostgresTenantAccessProvisioned).toHaveBeenCalledWith(pool, {
      schema: 'companion_alpha',
      role: FLEET_ROLE,
      extensionSchema: 'extensions',
      searchPath: 'companion_alpha,extensions',
    });
    expect(createDefaultPostgresSessionAdapters).toHaveBeenCalledWith(DATABASE_URL, {
      sessionsDir: '/runtime/companions/alpha/state/sessions',
      schema: 'companion_alpha',
      role: FLEET_ROLE,
    });
  });

  it('refuses adapter creation when the fleet tenant preflight fails', async () => {
    const pool = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
    const preflightError = new Error('tenant boundary absent');
    const createDefaultPostgresSessionAdapters = vi.fn();

    await expect(createTestingSessionPurgePostgresAdapters({
      databaseUrl: DATABASE_URL,
      multiCompanion: true,
      postgresSchema: 'companion_alpha',
      sessionsDir: '/runtime/companions/alpha/state/sessions',
      dependencies: {
        assertPostgresTenantAccessProvisioned: vi.fn().mockRejectedValue(preflightError),
        createDefaultPostgresSessionAdapters,
        createPostgresPool: vi.fn(() => pool),
      },
    })).rejects.toBe(preflightError);

    expect(pool.end).toHaveBeenCalledOnce();
    expect(createDefaultPostgresSessionAdapters).not.toHaveBeenCalled();
  });

  it('keeps single-companion public adapter creation role-free and skips tenant preflight', async () => {
    const adapters = adaptersFixture();
    const assertPostgresTenantAccessProvisioned = vi.fn();
    const createPostgresPool = vi.fn();
    const createDefaultPostgresSessionAdapters = vi.fn().mockResolvedValue(adapters);

    await expect(createTestingSessionPurgePostgresAdapters({
      databaseUrl: DATABASE_URL,
      multiCompanion: false,
      postgresSchema: 'public',
      sessionsDir: '/runtime/companion-data/state/sessions',
      dependencies: {
        assertPostgresTenantAccessProvisioned,
        createDefaultPostgresSessionAdapters,
        createPostgresPool,
      },
    })).resolves.toBe(adapters);

    expect(createPostgresPool).not.toHaveBeenCalled();
    expect(assertPostgresTenantAccessProvisioned).not.toHaveBeenCalled();
    expect(createDefaultPostgresSessionAdapters).toHaveBeenCalledWith(DATABASE_URL, {
      sessionsDir: '/runtime/companion-data/state/sessions',
      schema: 'public',
    });
  });
});
