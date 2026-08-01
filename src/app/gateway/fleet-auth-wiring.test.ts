import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertGatewayApiIntakeScreeningOwnership,
  startOptionalGatewayApiServer,
} from './api-surface.js';
import { FLEET_SSO_FLEET_MANIFEST_REQUIRED_ERROR } from '../../boundary/fleet-auth/fleet-sso-transport.js';

describe('gateway fleet authorization context wiring', () => {
  it('fails closed when fleet API intake ownership is missing or mode-mismatched', () => {
    const base = {
      multiCompanion: true,
      intakeScreeningMode: 'off',
      intakeScreening: null,
      config: {
        companionFleet: {
          companions: [{
            companionId: '11111111-1111-4111-8111-111111111111',
          }],
        },
      },
    } as unknown as Parameters<typeof assertGatewayApiIntakeScreeningOwnership>[0];

    expect(() => assertGatewayApiIntakeScreeningOwnership(base))
      .toThrow(/requires a companion-owned resolver/u);
    expect(() => assertGatewayApiIntakeScreeningOwnership({
      ...base,
      intakeScreeningMode: 'enforce',
      intakeScreeningForCompanion: () => null,
    })).toThrow(/mode=enforce has no matching service/u);
    expect(() => assertGatewayApiIntakeScreeningOwnership({
      ...base,
      intakeScreeningForCompanion: () => null,
    })).not.toThrow();
  });

  it('passes exact manifest companion IDs and enables only the complete principal composition', () => {
    const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const apiSurfaceSource = readFileSync(new URL('./api-surface.ts', import.meta.url), 'utf8');
    const manifestGuard = mainSource.indexOf(
      'requireFleetSsoFleetManifest(config.companionFleet)',
    );
    const guardedPersistenceInitialization = mainSource.indexOf(
      "? await awaitPostgresStoreReadiness('fleet_auth', initializeFleetAuthPersistence)",
    );

    expect(manifestGuard).toBeGreaterThanOrEqual(0);
    expect(guardedPersistenceInitialization).toBeGreaterThanOrEqual(0);
    expect(manifestGuard).toBeLessThan(guardedPersistenceInitialization);
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
      'fleetAuthEscalation: fleetAuthPersistence.escalation,',
    );
    expect(apiSurfaceSource).toContain(
      '{ escalation: options.fleetAuthEscalation }',
    );
    expect(apiSurfaceSource).toContain('new GatewayHubDeviceIngressService({');
    expect(apiSurfaceSource).toContain('.verifyAndConsumeHubDeviceAssertion(assertion, expected)');
    expect(apiSurfaceSource).toContain(
      'const companionRelay: CompanionRelayHttpDeps | undefined = options.companionRelay',
    );
    // The removed passkey/JIT ceremony surfaces must not creep back into the wiring.
    for (const retired of [
      'fleetAuthJitStepUp',
      'fleetAuthPasskeyCeremonies',
      'fleetAuthAccountReapprovalCeremonies',
      'fleetAuthProviderRecovery',
    ]) {
      expect(mainSource).not.toContain(retired);
      expect(apiSurfaceSource).not.toContain(retired);
    }
    // Every principal-composition conjunct stays required; dropping one must not
    // silently downgrade the fail-closed startup guard.
    for (const conjunct of [
      'options.fleetAuthBroker !== undefined',
      'options.fleetAuthEscalation !== undefined',
      'options.fleetAuthTrustedHostRecovery !== undefined',
      'options.fleetAuthLifecycleCeremonies !== undefined',
      'options.fleetAuthChildAssertions !== undefined',
      'options.fleetAuthRequestCapabilities !== undefined',
      'options.fleetAuthRequestCapabilityVerifier !== undefined',
      'options.fleetAuthRequestCapabilityReplay !== undefined',
      'options.fleetPortalAuthorization !== undefined',
      'options.primaryEmbodiments !== undefined',
      'options.hubDeviceAssertionVerifier !== undefined',
    ]) {
      expect(apiSurfaceSource).toContain(conjunct);
    }
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
      config: {
        fleetAuth: {},
        companionFleet: {
          persistenceRoot: '/runtime',
          workspacesRoot: '/runtime/workspaces',
          sharedWorkspacePath: '/runtime/shared',
          companions: [{
            companionId: '11111111-1111-4111-8111-111111111111',
            companionDataDir: '/runtime/companions/one',
            characterCardPath: '/runtime/companions/one/character-card.json',
            personalWorkspacePath: '/runtime/workspaces/one',
            postgresSchema: 'companion_one',
          }],
        },
      },
      env: {},
      fleetAuthBroker: {},
    } as unknown as Parameters<typeof startOptionalGatewayApiServer>[0])).rejects.toThrow(
      'Fleet-auth principal composition is incomplete; refusing to expose the gateway API',
    );
  });

  it('fails before listen with the one-entry manifest requirement when companions.json is absent', async () => {
    let thrown: unknown;
    try {
      await startOptionalGatewayApiServer({
        apiPort: 8443,
        config: { fleetAuth: {} },
        env: {},
      } as unknown as Parameters<typeof startOptionalGatewayApiServer>[0]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(FLEET_SSO_FLEET_MANIFEST_REQUIRED_ERROR);
  });
});
