import { describe, expect, it, vi } from 'vitest';
import {
  ShakedownArtifactCleanupService,
  type ShakedownArtifactInventoryRecord,
  type ShakedownArtifactManifest,
} from './shakedown-artifact-cleanup.js';

const manifest: ShakedownArtifactManifest = {
  schemaVersion: 1,
  companionId: 'companion-a',
  runId: 'run-2026-08-20-a',
  manifestId: 'manifest-2026-08-20-a',
  artifacts: [
    { kind: 'session', id: 'api:testing-harness' },
    { kind: 'memory', id: 'memory-test-1' },
    { kind: 'event', id: 'event-test-1' },
    { kind: 'task', id: 'scheduled-test-follow-up-30-days' },
  ],
};

function proven(
  kind: ShakedownArtifactInventoryRecord['kind'],
  id: string,
  state: ShakedownArtifactInventoryRecord['state'] = 'active',
): ShakedownArtifactInventoryRecord {
  return {
    kind,
    id,
    companionId: manifest.companionId,
    state,
    provenance: {
      schemaVersion: 1,
      kind: 'testing_harness',
      runId: manifest.runId,
      manifestId: manifest.manifestId,
    },
  };
}

function makePorts(records: ShakedownArtifactInventoryRecord[]) {
  const order: string[] = [];
  return {
    order,
    inventory: {
      inspectExact: vi.fn(async () => records),
    },
    backup: {
      captureExact: vi.fn(async () => {
        order.push('backup');
        return {
          backupRef: 'backup:test-run-a',
          backupDigest: 'a'.repeat(64),
          rollbackRef: 'rollback:test-run-a',
          artifactKeys: records.filter(record => record.state !== 'removed')
            .map(record => JSON.stringify([record.kind, record.id])),
        };
      }),
    },
    mutation: {
      quarantineExact: vi.fn(async () => {
        order.push('quarantine');
        return { quarantineRef: 'quarantine:test-run-a' };
      }),
      removeQuarantinedExact: vi.fn(async () => {
        order.push('remove');
      }),
    },
    audit: {
      append: vi.fn(async () => {
        order.push('audit');
      }),
    },
  };
}

describe('ShakedownArtifactCleanupService', () => {
  it('produces a content-free exact dry run without backup or mutation', async () => {
    const records = [
      proven('session', 'api:testing-harness'),
      proven('memory', 'memory-test-1'),
      proven('event', 'event-test-1'),
      proven('task', 'scheduled-test-follow-up-30-days'),
    ];
    const ports = makePorts(records);
    const service = new ShakedownArtifactCleanupService({
      companionId: 'companion-a',
      ...ports,
    });

    const result = await service.dryRun(manifest);

    expect(result).toEqual({
      status: 'ready',
      companionId: manifest.companionId,
      runId: manifest.runId,
      manifestId: manifest.manifestId,
      targets: manifest.artifacts.map(target => ({ ...target, state: 'active' })),
    });
    expect(JSON.stringify(result)).not.toContain('content');
    expect(ports.backup.captureExact).not.toHaveBeenCalled();
    expect(ports.mutation.quarantineExact).not.toHaveBeenCalled();
  });

  it('backs up with rollback before quarantining and removes only exact proven targets', async () => {
    const records = [
      proven('session', 'api:testing-harness'),
      proven('memory', 'memory-test-1'),
      proven('event', 'event-test-1'),
      proven('task', 'scheduled-test-follow-up-30-days'),
    ];
    const ports = makePorts(records);
    const service = new ShakedownArtifactCleanupService({ companionId: 'companion-a', ...ports });

    const result = await service.apply(manifest, {
      operatorApproved: true,
      approvalId: 'approval-1',
    });

    expect(ports.order).toEqual(['backup', 'quarantine', 'remove', 'audit']);
    expect(ports.mutation.quarantineExact).toHaveBeenCalledWith({
      manifest,
      targets: records,
      backup: expect.objectContaining({ rollbackRef: 'rollback:test-run-a' }),
    });
    expect(result.status).toBe('removed');
  });

  it('fails closed for unproven, foreign-companion, or out-of-manifest inventory', async () => {
    const cases: ShakedownArtifactInventoryRecord[][] = [
      [{ ...proven('memory', 'memory-test-1'), provenance: undefined }],
      [{ ...proven('memory', 'memory-test-1'), companionId: 'companion-b' }],
      [proven('task', 'genuine-far-future-schedule-not-in-manifest')],
    ];
    for (const records of cases) {
      const ports = makePorts(records);
      const service = new ShakedownArtifactCleanupService({ companionId: 'companion-a', ...ports });
      await expect(service.dryRun(manifest)).rejects.toThrow();
      expect(ports.backup.captureExact).not.toHaveBeenCalled();
    }
  });

  it('rejects absent approval and companion-scope mismatch before mutation', async () => {
    const records = manifest.artifacts.map(target => proven(target.kind, target.id));
    const ports = makePorts(records);
    const service = new ShakedownArtifactCleanupService({ companionId: 'companion-a', ...ports });
    await expect(service.apply(manifest, {
      operatorApproved: false,
      approvalId: 'approval-1',
    })).rejects.toThrow('operator approval');
    await expect(service.dryRun({ ...manifest, companionId: 'companion-b' }))
      .rejects.toThrow('companion');
    expect(ports.backup.captureExact).not.toHaveBeenCalled();
  });

  it('is idempotent after every exact artifact has already been removed', async () => {
    const records = manifest.artifacts.map(target => proven(target.kind, target.id, 'removed'));
    const ports = makePorts(records);
    const service = new ShakedownArtifactCleanupService({ companionId: 'companion-a', ...ports });

    await expect(service.apply(manifest, {
      operatorApproved: true,
      approvalId: 'approval-1',
    })).resolves.toEqual(expect.objectContaining({ status: 'already_removed' }));
    expect(ports.backup.captureExact).not.toHaveBeenCalled();
    expect(ports.mutation.removeQuarantinedExact).not.toHaveBeenCalled();
  });
});
