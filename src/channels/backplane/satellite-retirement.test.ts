import { describe, expect, it, vi } from 'vitest';

import { buildAdminSatelliteRegistryView } from '../../operator/garden/services/satellite-registry-service.js';
import { parseSatelliteRegistryConfig } from './satellite-registry.js';
import {
  SyntheticSatelliteRetirementService,
  type SatelliteRegistryBackupPort,
  type SatelliteRegistryWritePort,
} from './satellite-retirement.js';

function endpoint(endpointId: string, deviceId?: string) {
  return {
    endpointId,
    displayName: `${endpointId} endpoint`,
    claimTypes: ['voice'],
    promptChannelType: 'voice',
    auth: { mode: 'api_key', apiKeyPrincipalIds: [`principal-${endpointId}`] },
    defaultIdentity: {
      authorId: `author-${endpointId}`,
      authorName: `${endpointId} user`,
      canonicalContactId: `contact-${endpointId}`,
      channelPrivacy: 'private',
    },
    maxCapabilities: ['audio_input', 'audio_output'],
    ...(deviceId
      ? {
          hubDeviceEnrollment: {
            deviceId,
            enrollmentVersion: 1,
            enrollmentStatus: 'active',
          },
        }
      : {}),
  };
}

function registry() {
  return parseSatelliteRegistryConfig({
    schemaVersion: 1,
    enabled: true,
    satellites: [{
      satelliteId: 'physical-active',
      displayName: 'Guest Test Device',
      mobility: 'static',
      endpoints: [endpoint('physical-voice', 'device-live-physical')],
    }, {
      satelliteId: 'ghost-smoke',
      displayName: 'Ordinary Looking Endpoint',
      mobility: 'static',
      testProvenance: {
        schemaVersion: 1,
        kind: 'testing_harness',
        runId: 'run-shakedown-001',
        manifestId: 'manifest-shakedown-001',
      },
      endpoints: [endpoint('smoke-voice')],
    }],
  });
}

describe('SyntheticSatelliteRetirementService', () => {
  it('retires only the exact manifest-provenanced ghost and is idempotent', async () => {
    let current = registry();
    const backup: SatelliteRegistryBackupPort = {
      create: vi.fn(async () => ({
        backupRef: 'backup:satellite-registry:001',
        backupDigest: `sha256:${'a'.repeat(64)}`,
      })),
    };
    const writer: SatelliteRegistryWritePort = {
      save: vi.fn(async input => {
        current = input.config;
      }),
    };
    const service = new SyntheticSatelliteRetirementService({
      read: () => current,
      backup,
      writer,
    });
    const target = {
      satelliteId: 'ghost-smoke',
      endpointIds: ['smoke-voice'],
      runId: 'run-shakedown-001',
      manifestId: 'manifest-shakedown-001',
    };

    await expect(service.retire({
      target,
      dryRun: true,
      retiredAt: '2026-08-20T12:00:00.000Z',
    })).resolves.toMatchObject({ status: 'would_retire', satelliteId: 'ghost-smoke' });
    expect(backup.create).not.toHaveBeenCalled();
    expect(writer.save).not.toHaveBeenCalled();

    await expect(service.retire({
      target,
      dryRun: false,
      retiredAt: '2026-08-20T12:00:00.000Z',
      approval: { operatorApproved: true, approvalId: 'approval-1' },
    })).resolves.toMatchObject({
      status: 'retired',
      satelliteId: 'ghost-smoke',
      endpointIds: ['smoke-voice'],
      backupRef: 'backup:satellite-registry:001',
    });
    expect(current.satellites.map(satellite => satellite.satelliteId)).toEqual(['physical-active']);
    expect(current.retiredSatellites).toHaveLength(1);
    expect(buildAdminSatelliteRegistryView(current)).toMatchObject({
      satelliteCount: 1,
      retiredSatelliteCount: 1,
      satellites: [{ satelliteId: 'physical-active', synthetic: false }],
    });

    await expect(service.retire({
      target,
      dryRun: false,
      retiredAt: '2026-08-20T12:00:00.000Z',
      approval: { operatorApproved: true, approvalId: 'approval-1' },
    })).resolves.toMatchObject({ status: 'already_retired', satelliteId: 'ghost-smoke' });
    expect(backup.create).toHaveBeenCalledOnce();
    expect(writer.save).toHaveBeenCalledOnce();
  });

  it('never treats names as provenance and protects the active physical device', async () => {
    const current = registry();
    const service = new SyntheticSatelliteRetirementService({
      read: () => current,
      backup: {
        create: vi.fn(async () => ({
          backupRef: 'backup:unused',
          backupDigest: `sha256:${'b'.repeat(64)}`,
        })),
      },
      writer: { save: vi.fn(async () => undefined) },
    });

    await expect(service.retire({
      dryRun: true,
      retiredAt: '2026-08-20T12:00:00.000Z',
      target: {
        satelliteId: 'physical-active',
        endpointIds: ['physical-voice'],
        runId: 'run-shakedown-001',
        manifestId: 'manifest-shakedown-001',
      },
    })).rejects.toThrow('does not carry testing-harness provenance');

    await expect(service.retire({
      dryRun: true,
      retiredAt: '2026-08-20T12:00:00.000Z',
      target: {
        satelliteId: 'ghost-smoke',
        endpointIds: ['physical-voice'],
        runId: 'run-shakedown-001',
        manifestId: 'manifest-shakedown-001',
      },
    })).rejects.toThrow('endpoint identity mismatch');
  });

  it('requires explicit approval before a non-dry-run backup or write', async () => {
    const backup = {
      create: vi.fn(async () => ({
        backupRef: 'backup:unused',
        backupDigest: `sha256:${'c'.repeat(64)}`,
      })),
    };
    const writer = { save: vi.fn(async () => undefined) };
    const service = new SyntheticSatelliteRetirementService({
      read: registry,
      backup,
      writer,
    });

    await expect(service.retire({
      target: {
        satelliteId: 'ghost-smoke',
        endpointIds: ['smoke-voice'],
        runId: 'run-shakedown-001',
        manifestId: 'manifest-shakedown-001',
      },
      dryRun: false,
      retiredAt: '2026-08-20T12:00:00.000Z',
    })).rejects.toThrow('explicit operator approval');
    expect(backup.create).not.toHaveBeenCalled();
    expect(writer.save).not.toHaveBeenCalled();
  });
});
