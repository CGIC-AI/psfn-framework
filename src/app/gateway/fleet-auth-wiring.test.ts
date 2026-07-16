import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { startOptionalGatewayApiServer } from './api-surface.js';

describe('gateway fleet authorization context wiring', () => {
  it('passes exact manifest companion IDs and enables only the complete principal composition', () => {
    const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const apiSurfaceSource = readFileSync(new URL('./api-surface.ts', import.meta.url), 'utf8');
    const manifestGuard = mainSource.indexOf('if (config.fleetAuth && !config.companionFleet)');
    const persistenceInitialization = mainSource.indexOf(
      'const fleetAuthPersistence = await initializeGatewayFleetAuthPersistence({',
    );

    expect(manifestGuard).toBeGreaterThanOrEqual(0);
    expect(manifestGuard).toBeLessThan(persistenceInitialization);
    expect(mainSource).toContain(
      'const fleetAuthKnownCompanionIds = config.companionFleet?.companions',
    );
    expect(mainSource).toContain('.map(companion => companion.companionId) ?? [];');
    expect(mainSource).toContain('knownCompanionIds: fleetAuthKnownCompanionIds,');
    expect(mainSource).toContain('principalAuthenticationWired: true,');
    expect(apiSurfaceSource).toContain('const principalAuthenticationWired =');
    expect(apiSurfaceSource).toContain('if (fleetAuthBootstrapOnly && !principalAuthenticationWired)');
    expect(mainSource).toContain('hubDeviceAssertionVerifier: fleetAuthPersistence,');
    expect(mainSource).toContain('primaryEmbodiments: fleetAuthPersistence.primaryEmbodiments,');
    expect(mainSource).toContain(
      'fleetAuthAccountReapprovalCeremonies:\n            fleetAuthPersistence.accountReapprovalCeremonies,',
    );
    expect(apiSurfaceSource).toContain(
      '{ accountReapprovalCeremonies: options.fleetAuthAccountReapprovalCeremonies }',
    );
    expect(apiSurfaceSource).toContain('new GatewayHubDeviceIngressService({');
    expect(apiSurfaceSource).toContain('.verifyAndConsumeHubDeviceAssertion(assertion, expected)');
  });

  it('constructs the private request-capability signer only inside gateway persistence', () => {
    const persistenceSource = readFileSync(
      new URL('../../persistence/postgres/fleet-auth/gateway-persistence.ts', import.meta.url),
      'utf8',
    );
    const configSource = readFileSync(
      new URL('../../system/config/fleet-auth-config.ts', import.meta.url),
      'utf8',
    );

    expect(persistenceSource).toContain('createGatewayRequestCapabilitySigner({');
    expect(persistenceSource).toContain('privateKeyPem: secrets.assertionPrivateKeyPem,');
    expect(persistenceSource).toContain('requestCapabilities,');
    expect(configSource).toContain('requestCapabilities: {');
    expect(configSource).toContain('keys: config.verifierKeys.map(key => ({ ...key })),');
  });

  it('fails before listen when fleet auth is enabled with partial principal composition', async () => {
    await expect(startOptionalGatewayApiServer({
      apiPort: 8443,
      config: { fleetAuth: {} },
      env: {},
      fleetAuthBroker: {},
    } as unknown as Parameters<typeof startOptionalGatewayApiServer>[0])).rejects.toThrow(
      'Fleet-auth principal composition is incomplete; refusing to expose the gateway API',
    );
  });
});
