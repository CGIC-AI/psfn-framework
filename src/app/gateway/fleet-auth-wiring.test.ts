import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('gateway fleet authorization context wiring', () => {
  it('passes exact manifest companion IDs without enabling public principal authentication', () => {
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
    expect(mainSource).toContain('principalAuthenticationWired: false,');
    expect(apiSurfaceSource).toContain('principalAuthenticationWired: false,');
    expect(mainSource).toContain('hubDeviceAssertionVerifier: fleetAuthPersistence,');
    expect(apiSurfaceSource).toContain('new GatewayHubDeviceIngressService({');
    expect(apiSurfaceSource).toContain('.verifyAndConsumeHubDeviceAssertion(assertion, expected)');
  });
});
