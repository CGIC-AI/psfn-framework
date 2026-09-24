import { describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  parseFleetAuthGrantTeardownArgs,
  resolveFleetAuthGrantTeardownTargets,
} from './teardown-fleet-auth-grants.js';

const URLS: Record<string, string> = {
  shared: 'postgres://shared_owner:pw-shared@db.example.test:5432/psfn',
  one: 'postgres://companion_one_runtime:pw-one@db.example.test:5432/psfn',
};

function fleetConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    postgresDatabaseUrl: URLS.one,
    credentialVault: {
      resolveRequired: (reference: { id: string }) => URLS[reference.id],
    },
    companionFleet: {
      postgres: {
        sharedMigrationDatabaseUrlRef: { id: 'shared' },
        sharedMigrationRole: 'shared_owner',
      },
      companions: [{
        companionId: '11111111-1111-4111-8111-111111111111',
        postgresDatabaseUrlRef: { id: 'one' },
        postgresRole: 'companion_one_runtime',
        postgresSchema: 'companion_one',
      }],
    },
    ...overrides,
  } as unknown as SubstrateConfig;
}

describe('fleet auth grant teardown CLI (psfn-framework-bi3w6)', () => {
  it('parses repeated roles and defaults to a dry run', () => {
    expect(parseFleetAuthGrantTeardownArgs(['--role', 'fleet_auth_backup', '--role', 'fleet_auth_runtime']))
      .toEqual({ apply: false, roles: ['fleet_auth_backup', 'fleet_auth_runtime'], showHelp: false });
    expect(parseFleetAuthGrantTeardownArgs(['--role', 'x', '--apply']).apply).toBe(true);
    expect(() => parseFleetAuthGrantTeardownArgs(['--roles', 'x'])).toThrow(/Unknown argument/);
  });

  it('targets every companion schema and the shared schema as their owners', () => {
    expect(resolveFleetAuthGrantTeardownTargets(fleetConfig(), ['fleet_auth_backup'])).toEqual([
      { schema: 'companion_one', ownerDatabaseUrl: URLS.one, ownerRole: 'companion_one_runtime' },
      { schema: 'shared', ownerDatabaseUrl: URLS.shared, ownerRole: 'shared_owner' },
    ]);
  });

  it('fails closed while fleet auth is configured, without topology, or on an authority role', () => {
    expect(() => resolveFleetAuthGrantTeardownTargets(
      fleetConfig({ fleetAuth: {} as SubstrateConfig['fleetAuth'] }),
      ['fleet_auth_backup'],
    )).toThrow(/still configured/);
    expect(() => resolveFleetAuthGrantTeardownTargets(
      fleetConfig({ companionFleet: undefined }),
      ['fleet_auth_backup'],
    )).toThrow(/requires the gateway fleet topology/);
    expect(() => resolveFleetAuthGrantTeardownTargets(fleetConfig(), ['shared_owner']))
      .toThrow(/refuses configured authority roles: shared_owner/);
  });
});
