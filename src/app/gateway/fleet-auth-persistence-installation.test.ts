import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const CHILD_SOURCE = String.raw`
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const expectedPreinstallError =
  'Fleet-auth persistence requires gateway boundary values to be installed by composition';
const companionId = '00000000-0000-4000-8000-000000000201';
const config = {
  schemaVersion: 1,
  activationGeneration: 1,
  ttls: { discordEvidenceMs: 300_000 },
  rolePolicy: {
    disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] },
  },
  discordEvidenceMappings: [],
};
const pool = {};
const providerRevocationAuthority = {
  sessionAuthorityGenerationIsCurrent: () => true,
  fence: async () => { throw new Error('Unexpected provider revocation fence'); },
};

const { FleetAuthBrokerError } = await import(
  './src/boundary/gateway/fleet-auth-broker.ts'
);
const { createImmutableFleetAuthorizationContext } = await import(
  './src/boundary/gateway/fleet-authorization-context.ts'
);
const { requireFleetAuthPersistenceBoundaryValues } = await import(
  './src/persistence/postgres/fleet-auth/boundary-values-port.ts'
);
const composition = await import('./src/app/gateway/fleet-auth-persistence.ts');

assert.throws(
  requireFleetAuthPersistenceBoundaryValues,
  error => error instanceof Error && error.message === expectedPreinstallError,
);

switch (process.env.PSFN_TEST_FLEET_AUTH_INSTALLER_SEAM) {
  case 'authorization-context':
    composition.createPostgresFleetAuthorizationContextResolver({
      pool,
      sessionPepper: 'p'.repeat(32),
      config,
      knownCompanionIds: [companionId],
      providerRevocationAuthority,
    });
    break;
  case 'portal-authorization':
    composition.createPostgresFleetPortalAuthorization({
      pool,
      sessionPepper: 'p'.repeat(32),
      config,
      knownCompanionIds: [companionId],
      providerRevocationAuthority,
    });
    break;
  case 'gateway-initialization':
    await composition.initializeGatewayFleetAuthPersistence({
      knownCompanionIds: [],
      protectedRestoreRoots: [],
      lifecycleWitnessRoot: join(tmpdir(), randomUUID()),
    });
    break;
  default:
    throw new Error('Unknown Fleet Auth persistence installer seam');
}

const installed = requireFleetAuthPersistenceBoundaryValues();
assert.equal(installed.FleetAuthBrokerError, FleetAuthBrokerError);
assert.equal(
  installed.createImmutableFleetAuthorizationContext,
  createImmutableFleetAuthorizationContext,
);
`;

describe('Fleet Auth persistence boundary installation', () => {
  it.each([
    'authorization-context',
    'portal-authorization',
    'gateway-initialization',
  ])('installs canonical gateway values through the %s composition seam', seam => {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SOURCE],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PSFN_TEST_FLEET_AUTH_INSTALLER_SEAM: seam },
      },
    );

    expect({ status: child.status, signal: child.signal, stderr: child.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
  });
});
