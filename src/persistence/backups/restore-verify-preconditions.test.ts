import { describe, expect, it, vi } from 'vitest';
import { assertRestoreVerifyDatabasePreconditions } from './restore-verify-preconditions.js';

describe('restore-verify database startup preconditions', () => {
  it('proves every restore authority targets the same scratch database with CONNECT and CREATE', async () => {
    const end = vi.fn(async () => undefined);
    const release = vi.fn();
    const createPool = vi.fn((databaseUrl: string) => {
      const credential = new URL(databaseUrl);
      return {
        async connect() {
          return {
            async query() {
              return {
                rows: [{
                  database_name: 'psfn_restore_verify',
                  role_name: decodeURIComponent(credential.username),
                  can_connect: true,
                  can_create: true,
                }],
              };
            },
            release,
          };
        },
        end,
      };
    });

    await assertRestoreVerifyDatabasePreconditions({
      credentials: [
        {
          label: 'backup',
          databaseUrl: 'postgresql://fleet_auth_backup:secret@db:5432/psfn_restore_verify',
          expectedRole: 'fleet_auth_backup',
        },
        {
          label: 'companion alpha owner',
          databaseUrl: 'postgresql://companion_alpha:secret@db:5432/psfn_restore_verify',
          expectedRole: 'companion_alpha',
        },
      ],
    }, { createPool });

    expect(createPool).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(2);
  });

  it('fails startup before scheduling when a restore authority lacks CREATE', async () => {
    const createPool = vi.fn(() => ({
      async connect() {
        return {
          async query() {
            return {
              rows: [{
                database_name: 'psfn_restore_verify',
                role_name: 'fleet_auth_backup',
                can_connect: true,
                can_create: false,
              }],
            };
          },
          release() {},
        };
      },
      async end() {},
    }));

    await expect(assertRestoreVerifyDatabasePreconditions({
      credentials: [{
        label: 'backup',
        databaseUrl: 'postgresql://fleet_auth_backup:secret@db:5432/psfn_restore_verify',
        expectedRole: 'fleet_auth_backup',
      }],
    }, { createPool })).rejects.toThrow(
      /backup requires CONNECT and CREATE on restore-verify database psfn_restore_verify/u,
    );
  });
});
