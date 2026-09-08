// The gateway's ingress receipt stores must be opened on the same tenant
// authority the agent uses for its own `cogsec_receipts` store. A gateway that
// booted first on the bare login role would own the receipts table and leave
// the agent's REQUIRED readiness failing on a fresh multi-role fleet deploy.

import { fromAny } from '@total-typescript/shoehorn';
import { describe, expect, it } from 'vitest';
import { resolveGatewayReceiptStoreTargets } from './receipt-store-targets.js';
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
