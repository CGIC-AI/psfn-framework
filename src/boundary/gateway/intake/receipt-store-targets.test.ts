// The gateway's ingress receipt stores must be opened on the same tenant
// authority the agent uses for its own `cogsec_receipts` store. A gateway that
// booted first on the bare login role would own the receipts table and leave
// the agent's REQUIRED readiness failing on a fresh multi-role fleet deploy.

import { fromAny, fromPartial } from '@total-typescript/shoehorn';
import { describe, expect, it } from 'vitest';
import {
  resolveGatewayReceiptStoreDatabaseUrl,
  resolveGatewayReceiptStoreTargets,
} from './receipt-store-targets.js';
import type { ResolvedCompanionDatabaseTopology } from '../../../system/config/companion-database-config.js';
import { PostgresRuntimeReadiness } from '../../../persistence/postgres/runtime-readiness.js';
import {
  resolveConfigTenantPoolScope,
} from '../../../persistence/postgres/tenant-pool-scope.js';

const FLEET = {
  companions: [
    {
      companionId: 'companion-alpha',
      postgresSchema: 'companion_alpha',
      postgresRole: 'companion_alpha_runtime',
    },
    {
      companionId: 'companion-beta',
      postgresSchema: 'companion_beta',
      postgresRole: 'companion_beta_runtime',
    },
  ],
};

describe('resolveGatewayReceiptStoreTargets', () => {
  it('opens every fleet companion receipt store on that companion schema AND role', () => {
    const targets = resolveGatewayReceiptStoreTargets(fromAny({
      companionFleet: FLEET,
      postgresSchema: 'companion_alpha',
    }));

    expect(targets).toEqual([
      {
        companionId: 'companion-alpha',
        connectOptions: { schema: 'companion_alpha', role: 'companion_alpha_runtime' },
      },
      {
        companionId: 'companion-beta',
        connectOptions: { schema: 'companion_beta', role: 'companion_beta_runtime' },
      },
    ]);
  });

  it('matches the tenant scope the agent process pins for the same companion', () => {
    const agentScope = resolveConfigTenantPoolScope(fromAny({
      multiCompanion: true,
      companionId: 'companion-beta',
      postgresSchema: 'companion_beta',
      postgresRole: 'companion_beta_runtime',
      companionFleet: FLEET,
    }));

    const gatewayTarget = resolveGatewayReceiptStoreTargets(fromAny({
      companionFleet: FLEET,
      postgresSchema: 'companion_alpha',
    })).find(target => target.companionId === 'companion-beta');

    expect(gatewayTarget?.connectOptions).toEqual({
      schema: agentScope?.schema,
      role: agentScope?.role,
    });
  });

  it('stays unscoped and role-free in single-companion mode, as the agent does', () => {
    expect(resolveConfigTenantPoolScope(fromAny({ postgresSchema: 'public' })))
      .toBeUndefined();
    expect(resolveGatewayReceiptStoreTargets(fromAny({})))
      .toEqual([{ connectOptions: {} }]);
    expect(resolveGatewayReceiptStoreTargets(fromAny({ postgresSchema: ' solo ' })))
      .toEqual([{ connectOptions: { schema: 'solo' } }]);
  });

  it('refuses a manifest companion with no role rather than defaulting to public', () => {
    expect(() => resolveGatewayReceiptStoreTargets(fromAny({
      companionFleet: {
        companions: [{
          companionId: 'companion-alpha',
          postgresSchema: 'companion_alpha',
          postgresRole: '   ',
        }],
      },
    }))).toThrow('postgresRole');
  });
});


describe('resolveGatewayReceiptStoreDatabaseUrl', () => {
  function topology() {
    return fromPartial<ResolvedCompanionDatabaseTopology>({
      companions: FLEET.companions.map(companion => ({
        companion,
        role: companion.postgresRole,
        databaseUrl: `postgresql://${companion.postgresRole}:fixture-password@db.example.test/receipt_test`,
      })),
    });
  }
  function targets() {
    return resolveGatewayReceiptStoreTargets(fromAny({ companionFleet: FLEET }));
  }
  const primaryUrl = 'postgresql://companion_alpha_runtime:fixture-password@db.example.test/receipt_test';

  it('matches credentials by companion identity regardless of topology order', () => {
    const credentials = topology();
    credentials.companions.reverse();
    expect(targets().map(target => resolveGatewayReceiptStoreDatabaseUrl(target, primaryUrl, credentials)))
      .toEqual(topology().companions.map(entry => entry.databaseUrl));
  });

  it('preserves the configured single-companion credential without inventing a tenant', () => {
    expect(resolveGatewayReceiptStoreDatabaseUrl({ connectOptions: {} }, primaryUrl)).toBe(primaryUrl);
    expect(() => resolveGatewayReceiptStoreDatabaseUrl({ connectOptions: {} }, primaryUrl, topology()))
      .toThrow('companion-bound');
  });

  it.each(['missing', 'unknown', 'duplicate', 'schema', 'role', 'login'] as const)(
    'rejects a %s companion credential instead of using the primary login',
    (defect) => {
      const credentials = topology();
      const target = targets()[1]!;
      const credential = credentials.companions[1]!;
      switch (defect) {
        case 'missing': credentials.companions = []; break;
        case 'unknown': credentials.companions = credentials.companions.slice(0, 1); break;
        case 'duplicate': credentials.companions.push(credential); break;
        case 'schema': credential.companion = { ...credential.companion, postgresSchema: 'wrong_schema' }; break;
        case 'role': credential.role = 'wrong_role'; break;
        case 'login': credential.databaseUrl = primaryUrl; break;
      }
      expect(() => resolveGatewayReceiptStoreDatabaseUrl(target, primaryUrl, credentials)).toThrow('credential');
    },
  );

  it('records a missing topology as optional degradation while allowing core readiness', async () => {
    const readiness = new PostgresRuntimeReadiness();
    const handle = readiness.start('gateway_cogsec_receipts', async () => {
      resolveGatewayReceiptStoreDatabaseUrl(targets()[1]!, primaryUrl);
    });
    await expect(handle.waitUntilReady()).rejects.toMatchObject({ requirement: 'optional' });
    await expect(readiness.sealBeforeReady()).resolves.toMatchObject({
      phase: 'ready',
      degraded: [{ store: 'gateway_cogsec_receipts', requirement: 'optional',
        mismatch: 'Gateway receipt store requires one exact companion database credential' }],
    });
  });
});
