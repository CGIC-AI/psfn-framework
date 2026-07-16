import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  validateFleetAuthConfig,
  type FleetAuthConfig,
  type FleetAuthVerifierConfig,
} from '../../../system/config/fleet-auth-config.js';
import { projectFleetAuthGardenMetadata } from '../../../system/config/fleet-auth-garden-projection.js';
import { buildEffectiveFleetAuthOwnerProjection } from './fleet-auth-owner-projection.js';

function makeConfig(): FleetAuthConfig {
  const config = JSON.parse(
    readFileSync('config/fleet-auth.seed.json', 'utf8'),
  ) as Record<string, unknown>;
  const broker = generateKeyPairSync('ed25519');
  const hub = generateKeyPairSync('ed25519');
  const verifierKeys = config.verifierKeys as Array<Record<string, unknown>>;
  const hubDeviceAssertions = config.hubDeviceAssertions as Record<string, unknown>;
  const hubKeys = hubDeviceAssertions.keys as Array<Record<string, unknown>>;
  verifierKeys[0] = {
    ...verifierKeys[0],
    kid: 'garden-projection-broker',
    publicKeyPem: broker.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  hubKeys[0] = {
    ...hubKeys[0],
    kid: 'garden-projection-hub',
    publicKeyPem: hub.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  config.discordEvidenceMappings = [{
    guildId: '234567890123456789',
    channelId: '345678901234567890',
    companionId: '11111111-1111-4111-8111-111111111111',
    requiredRoleIds: ['456789012345678901'],
  }];
  const provider = config.provider as Record<string, unknown>;
  provider.scopes = ['identify', 'guilds', 'guilds.members.read'];
  return validateFleetAuthConfig(config, 'fleet-auth.json');
}

function verifier(config: FleetAuthConfig, includeGardenMetadata = true): FleetAuthVerifierConfig {
  return {
    kind: 'verifier',
    enabled: true,
    canonicalOrigin: config.canonicalOrigin,
    requestCapabilities: {
      issuer: config.verifierKeys[0]!.issuer,
      maxTtlSeconds: config.ttls.internalAssertionMs / 1_000,
      keys: config.verifierKeys,
    },
    hubDeviceAssertions: config.hubDeviceAssertions,
    ...(includeGardenMetadata
      ? { gardenMetadata: projectFleetAuthGardenMetadata(config) }
      : {}),
  };
}

describe('fleet-auth Garden owner projection', () => {
  it('reports equal startup and canonical owner revisions as healthy and read-only', () => {
    const config = makeConfig();
    const projection = buildEffectiveFleetAuthOwnerProjection({
      effectiveVerifierConfig: verifier(config),
      loadOnDisk: () => structuredClone(config),
    });

    expect(projection).toMatchObject({
      ownerFile: 'fleet-auth.json',
      scope: 'global',
      access: { mode: 'read_only', editableFields: [] },
      featureState: 'enabled',
      status: 'healthy',
      restartRequired: false,
      restartStatus: 'not_required',
      provenance: {
        parser: 'validateFleetAuthConfig',
        effectiveSource: 'startup_runtime',
        onDiskSource: 'canonical_owner_file',
      },
      effective: { state: 'loaded' },
      onDisk: { state: 'loaded' },
    });
    expect(projection.effective.state).toBe('loaded');
    expect(projection.onDisk.state).toBe('loaded');
    if (projection.effective.state === 'loaded' && projection.onDisk.state === 'loaded') {
      expect(projection.effective.revision.canonicalSha256)
        .toBe(projection.onDisk.revision.canonicalSha256);
    }
  });

  it('reports exact canonical owner divergence as restart-required', () => {
    const effective = makeConfig();
    const onDisk = structuredClone(effective);
    onDisk.ttls.discordEvidenceMs += 1_000;

    const projection = buildEffectiveFleetAuthOwnerProjection({
      effectiveVerifierConfig: verifier(effective),
      loadOnDisk: () => onDisk,
    });

    expect(projection).toMatchObject({
      featureState: 'enabled',
      status: 'restart_required',
      restartRequired: true,
      restartStatus: 'required',
    });
    expect(projection.effective.state).toBe('loaded');
    expect(projection.onDisk.state).toBe('loaded');
    if (projection.effective.state === 'loaded' && projection.onDisk.state === 'loaded') {
      expect(projection.effective.revision.canonicalSha256)
        .not.toBe(projection.onDisk.revision.canonicalSha256);
      expect(projection.effective.value.ttls.discordEvidenceMs).toBe(300_000);
      expect(projection.onDisk.value.ttls.discordEvidenceMs).toBe(301_000);
    }
  });

  it('fails closed without reflecting parser errors or owner contents', () => {
    const config = makeConfig();
    const reportUnavailable = vi.fn();
    const projection = buildEffectiveFleetAuthOwnerProjection({
      effectiveVerifierConfig: verifier(config),
      loadOnDisk: () => {
        throw new Error('invalid envName=PRIVATE_RECOVERY_CREDENTIAL at /private/system-data');
      },
      reportUnavailable,
    });

    expect(reportUnavailable).toHaveBeenCalledOnce();
    expect(projection).toMatchObject({
      featureState: 'enabled',
      status: 'unavailable',
      restartRequired: true,
      restartStatus: 'blocked',
      onDisk: { state: 'unavailable' },
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('PRIVATE_RECOVERY_CREDENTIAL');
    expect(serialized).not.toContain('/private/system-data');
  });

  it('reports an absent disabled owner as off instead of healthy', () => {
    const projection = buildEffectiveFleetAuthOwnerProjection({
      loadOnDisk: () => null,
    });

    expect(projection).toMatchObject({
      featureState: 'off',
      status: 'off',
      restartRequired: false,
      restartStatus: 'not_required',
      effective: { state: 'off' },
      onDisk: { state: 'absent' },
    });
  });

  it('reports enabled runtime metadata gaps and off/file mismatches without guessing', () => {
    const config = makeConfig();
    const unavailable = buildEffectiveFleetAuthOwnerProjection({
      effectiveVerifierConfig: verifier(config, false),
      loadOnDisk: () => config,
    });
    expect(unavailable).toMatchObject({
      featureState: 'unavailable',
      status: 'unavailable',
      restartRequired: null,
      restartStatus: 'unknown',
      effective: { state: 'unavailable' },
    });

    const mismatchedOff = buildEffectiveFleetAuthOwnerProjection({
      loadOnDisk: () => config,
    });
    expect(mismatchedOff).toMatchObject({
      featureState: 'off',
      status: 'unavailable',
      restartRequired: true,
      restartStatus: 'blocked',
      effective: { state: 'off' },
      onDisk: { state: 'loaded' },
    });
  });
});
