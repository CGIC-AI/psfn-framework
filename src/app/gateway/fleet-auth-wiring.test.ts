import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  assertGatewayApiIntakeScreeningOwnership,
  startOptionalGatewayApiServer,
} from './api-surface.js';
import { FLEET_SSO_FLEET_MANIFEST_REQUIRED_ERROR } from '../../boundary/fleet-auth/fleet-sso-transport.js';
import { testShadowIntakeScreening } from '../../test-support/intake-screening.js';

describe('gateway fleet authorization context wiring', () => {
  it('fails closed when fleet API intake ownership is missing or mode-mismatched', () => {
    const base = {
      multiCompanion: true,
      intakeScreeningMode: 'shadow',
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
      intakeScreeningMode: 'strict',
      intakeScreeningForCompanion: () => null,
    })).toThrow(/mode=strict has no matching service/u);
    expect(() => assertGatewayApiIntakeScreeningOwnership({
      ...base,
      intakeScreeningForCompanion: testShadowIntakeScreening,
    })).not.toThrow();
  });

  it('passes exact manifest companion IDs and enables only the complete principal composition', () => {
    const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const apiSurfaceSource = readFileSync(new URL('./api-surface.ts', import.meta.url), 'utf8');
    const helmHelpersSource = readFileSync(
      new URL('../../../deploy/helm/psfn/templates/_helpers.tpl', import.meta.url),
      'utf8',
    );
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
    expect(apiSurfaceSource).toContain('adminToken: env.ADMIN_TOKEN || undefined,');
    expect(apiSurfaceSource).toContain(
      '...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}),',
    );
    expect(apiSurfaceSource).not.toContain(
      'adminToken: fleetAuthBootstrapOnly ? undefined : env.ADMIN_TOKEN || undefined,',
    );
    const providerSecretEnvStart = helmHelpersSource.indexOf(
      '{{- define "psfn.providerSecretEnv" -}}',
    );
    const providerSecretEnv = helmHelpersSource.slice(
      providerSecretEnvStart,
      helmHelpersSource.indexOf('{{- define ', providerSecretEnvStart + 1),
    );
    expect(providerSecretEnv).toContain('- name: ADMIN_TOKEN');
    expect(providerSecretEnv).not.toContain('{{- if not .Values.fleetAuth.enabled }}');
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

  it('constructs private gateway services only inside gateway composition', () => {
    const compositionSource = readFileSync(
      new URL('./fleet-auth-persistence.ts', import.meta.url),
      'utf8',
    );
    const configSource = readFileSync(
      new URL('../../system/config/fleet-auth-config.ts', import.meta.url),
      'utf8',
    );

    expect(compositionSource).toContain('createGatewayRequestCapabilitySigner({');
    expect(compositionSource).toContain('privateKeyPem: secrets.assertionPrivateKeyPem,');
    expect(compositionSource).toContain('new GatewayFleetAuthBroker({');
    expect(compositionSource).toContain('new FleetEscalationCoordinator({');
    expect(compositionSource).toContain('requestCapabilities,');
    expect(configSource).toContain('requestCapabilities: {');
    expect(configSource).toContain('keys: config.verifierKeys.map(key => ({ ...key })),');
  });

  it('keeps production fleet-auth persistence free of boundary runtime imports', () => {
    const persistenceDirectory = new URL(
      '../../persistence/postgres/fleet-auth/',
      import.meta.url,
    );
    const violations: string[] = [];
    for (const name of readdirSync(persistenceDirectory)) {
      if (!name.endsWith('.ts')
        || name.includes('.test.')
        || name.includes('.integration.')
        || name.endsWith('.test-support.ts')) {
        continue;
      }
      const source = readFileSync(new URL(name, persistenceDirectory), 'utf8');
      const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)
          || !statement.moduleSpecifier.text.includes('boundary/')) {
          continue;
        }
        const clause = statement.importClause;
        const hasRuntimeBinding = clause === undefined
          || (!clause.isTypeOnly
          && (clause.name !== undefined
            || clause.namedBindings === undefined
            || ts.isNamespaceImport(clause.namedBindings)
            || clause.namedBindings.elements.some(element => !element.isTypeOnly)));
        if (hasRuntimeBinding) violations.push(name);
      }
    }
    expect(violations).toEqual([]);
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
