import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveSatelliteRegistryConfig } from './satellite-registry.js';
import { createFileSyntheticSatelliteRetirementService } from './satellite-retirement-runtime.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-satellite-retirement-'));
  roots.push(root);
  return root;
}

function syntheticRegistry(): SatelliteRegistryConfig {
  return {
    schemaVersion: 1 as const,
    enabled: true,
    satellites: [{
      satelliteId: 'physical-one',
      displayName: 'Physical One',
      mobility: 'static' as const,
      endpoints: [{
        endpointId: 'physical-voice',
        displayName: 'Physical Voice',
        claimTypes: ['voice'],
        promptChannelType: 'voice',
        auth: { mode: 'api_key' as const, apiKeyPrincipalIds: ['physical-principal'] },
        defaultIdentity: {
          authorId: 'operator-one',
          authorName: 'Operator One',
          canonicalContactId: 'contact-one',
          channelPrivacy: 'private' as const,
        },
        maxCapabilities: ['audio_input', 'audio_output'],
        telemetryScopes: [],
      }],
    }, {
      satelliteId: 'synthetic-one',
      displayName: 'Synthetic One',
      mobility: 'static' as const,
      testProvenance: {
        schemaVersion: 1 as const,
        kind: 'testing_harness' as const,
        runId: 'run-one',
        manifestId: 'manifest-one',
      },
      endpoints: [{
        endpointId: 'voice-one',
        displayName: 'Voice One',
        claimTypes: ['voice'],
        promptChannelType: 'voice',
        auth: { mode: 'api_key' as const, apiKeyPrincipalIds: ['principal-one'] },
        defaultIdentity: {
          authorId: 'operator-one',
          authorName: 'Operator One',
          canonicalContactId: 'contact-one',
          channelPrivacy: 'private' as const,
        },
        maxCapabilities: ['audio_input', 'audio_output'],
        telemetryScopes: [],
      }],
    }],
    retiredSatellites: [],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('file-backed synthetic satellite retirement runtime', () => {
  it('backs up the exact owner before the validated atomic registry write', async () => {
    const root = createRoot();
    const dataDir = join(root, 'system');
    const backupDir = join(root, 'backup');
    mkdirSync(dataDir, { recursive: true });
    saveSatelliteRegistryConfig(dataDir, syntheticRegistry());
    const before = readFileSync(join(dataDir, 'satellites.json'));
    const service = createFileSyntheticSatelliteRetirementService({
      systemDataDir: dataDir,
      backupDir,
    });

    const result = await service.retire({
      target: {
        satelliteId: 'synthetic-one',
        endpointIds: ['voice-one'],
        runId: 'run-one',
        manifestId: 'manifest-one',
      },
      dryRun: false,
      retiredAt: '2026-08-20T12:00:00.000Z',
      approval: { operatorApproved: true, approvalId: 'approval-one' },
    });

    expect(result).toMatchObject({ status: 'retired', backupDigest: expect.stringMatching(/^sha256:/u) });
    const backupName = result.backupRef?.split(':')[1];
    expect(backupName).toBeTruthy();
    const backupPath = join(backupDir, backupName!);
    expect(readFileSync(backupPath)).toEqual(before);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(join(dataDir, 'satellites.json'), 'utf8')) as {
      satellites: unknown[];
      retiredSatellites: unknown[];
    };
    expect(written.satellites).toHaveLength(1);
    expect(written.retiredSatellites).toHaveLength(1);
  });

  it('does not create a backup during the default dry-run path', async () => {
    const root = createRoot();
    const dataDir = join(root, 'system');
    const backupDir = join(root, 'backup');
    mkdirSync(dataDir, { recursive: true });
    saveSatelliteRegistryConfig(dataDir, syntheticRegistry());
    const service = createFileSyntheticSatelliteRetirementService({
      systemDataDir: dataDir,
      backupDir,
    });
    await expect(service.retire({
      target: {
        satelliteId: 'synthetic-one',
        endpointIds: ['voice-one'],
        runId: 'run-one',
        manifestId: 'manifest-one',
      },
      dryRun: true,
      retiredAt: '2026-08-20T12:00:00.000Z',
    })).resolves.toMatchObject({ status: 'would_retire' });
    expect(statSync(backupDir).isDirectory()).toBe(true);
    expect(readFileSync(join(dataDir, 'satellites.json'))).toBeTruthy();
  });
});
