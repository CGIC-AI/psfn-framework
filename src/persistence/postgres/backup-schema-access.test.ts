import { describe, expect, it, vi } from 'vitest';
import { grantBackupReadAccessToTenantSchema } from './backup-schema-access.js';

describe('tenant backup-schema access', () => {
  it('grants the backup role read access to present and future tenant objects', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await grantBackupReadAccessToTenantSchema(
      { query },
      {
        schema: 'companion_alpha',
        ownerRole: 'companion_alpha_runtime',
        backupRole: 'fleet_auth_backup',
      },
    );

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'GRANT USAGE ON SCHEMA "companion_alpha" TO "fleet_auth_backup"',
      'GRANT SELECT ON ALL TABLES IN SCHEMA "companion_alpha" TO "fleet_auth_backup"',
      'GRANT SELECT ON ALL SEQUENCES IN SCHEMA "companion_alpha" TO "fleet_auth_backup"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "companion_alpha_runtime" IN SCHEMA "companion_alpha" GRANT SELECT ON TABLES TO "fleet_auth_backup"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "companion_alpha_runtime" IN SCHEMA "companion_alpha" GRANT SELECT ON SEQUENCES TO "fleet_auth_backup"',
    ]);
  });

  it('rejects unsafe identifiers before issuing any grant', async () => {
    const query = vi.fn();

    await expect(grantBackupReadAccessToTenantSchema(
      { query },
      {
        schema: 'companion_alpha; DROP SCHEMA public',
        ownerRole: 'companion_alpha_runtime',
        backupRole: 'fleet_auth_backup',
      },
    )).rejects.toThrow(/Invalid Postgres schema name/u);
    expect(query).not.toHaveBeenCalled();
  });
});
