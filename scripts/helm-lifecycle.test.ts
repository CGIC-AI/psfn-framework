import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parsePinnedImageReference,
  resolveSingleCompanionOwnerContract,
} from './helm-lifecycle.js';

describe('public Helm lifecycle contracts', () => {
  it('requires pinned image tags or exact digests', () => {
    expect(parsePinnedImageReference('registry.example/psfn:v1.2.3')).toEqual({
      repository: 'registry.example/psfn',
      tag: 'v1.2.3',
      full: 'registry.example/psfn:v1.2.3',
    });
    expect(parsePinnedImageReference(`registry.example/psfn@sha256:${'a'.repeat(64)}`)).toEqual({
      repository: 'registry.example/psfn',
      digest: `sha256:${'a'.repeat(64)}`,
      full: `registry.example/psfn@sha256:${'a'.repeat(64)}`,
    });
    expect(() => parsePinnedImageReference('psfn:latest')).toThrow(/pinned tag/u);
    expect(() => parsePinnedImageReference('psfn')).toThrow(/exact tag/u);
  });

  it('binds a one-entry manifest to exactly one provider env reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-helm-owner-'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'companions.json'), JSON.stringify({
      postgres: { sharedMigrationRole: 'shared_schema_migration' },
      companions: [{
        companionId: '11111111-1111-4111-8111-111111111111',
        postgresSchema: 'companion_main',
        postgresRole: 'companion_main_runtime',
      }],
    }));
    writeFileSync(join(root, 'providers.json'), JSON.stringify({
      providers: [{
        id: 'provider',
        enabled: true,
        apiKeyRef: { kind: 'env', envName: 'PROVIDER_API_KEY' },
      }],
    }));
    expect(resolveSingleCompanionOwnerContract(root)).toEqual({
      companionId: '11111111-1111-4111-8111-111111111111',
      providerEnvName: 'PROVIDER_API_KEY',
    });
  });
});
