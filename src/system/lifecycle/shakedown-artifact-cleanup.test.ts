import { describe, expect, it, vi } from 'vitest';
import {
  ShakedownArtifactCleanupService,
  type ShakedownCleanupInventory,
  type ShakedownCleanupPorts,
  type ShakedownCleanupTarget,
} from './shakedown-artifact-cleanup.js';

const target: ShakedownCleanupTarget = {
  schemaVersion: 1,
  companionId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'api:testing-harness',
  runId: 'run-shakedown-001',
  manifestId: 'manifest-shakedown-001',
  artifacts: [
    { kind: 'session', id: 'api:testing-harness' },
    { kind: 'channel', id: 'api:testing-harness' },
    { kind: 'event', id: '1' },
  ],
};

const revision = 'a'.repeat(64);

function inventory(status: 'present' | 'absent' = 'present'): ShakedownCleanupInventory {
  return {
    status,
    targetRevision: revision,
    artifactCounts: status === 'present'
      ? { journals: 2, turn_records: 1, postgres_rows: 3 }
      : {},
    artifacts: status === 'present' ? target.artifacts : [],
  };
}

function ports(overrides: Partial<ShakedownCleanupPorts> = {}): ShakedownCleanupPorts {
  return {
    inspectExact: vi.fn(async () => inventory()),
    captureBackup: vi.fn(async () => ({
      backupRef: 'backup:shakedown-001',
      backupDigest: 'b'.repeat(64),
      rollbackRef: 'rollback:shakedown-001',
      targetRevision: revision,
    })),
    removeExact: vi.fn(async () => undefined),
    verifyAbsent: vi.fn(async () => ({
      allRunArtifactsRemoved: true,
      remainingArtifactCounts: {},
    })),
    appendAudit: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('ShakedownArtifactCleanupService', () => {
  it('produces an exact dry run without backup or mutation', async () => {
    const dependencies = ports();
    const service = new ShakedownArtifactCleanupService(dependencies);

    await expect(service.dryRun(target)).resolves.toMatchObject({
      status: 'ready',
      runId: target.runId,
      manifestId: target.manifestId,
      targetRevision: revision,
      artifactCounts: { journals: 2, turn_records: 1, postgres_rows: 3 },
    });
    expect(dependencies.captureBackup).not.toHaveBeenCalled();
    expect(dependencies.removeExact).not.toHaveBeenCalled();
  });

  it('backs up the exact revision before deletion and returns absence proof', async () => {
    const dependencies = ports();
    const service = new ShakedownArtifactCleanupService(dependencies);

    await expect(service.apply(target, {
      operatorApproved: true,
      approvalId: 'operator-approval-001',
    })).resolves.toMatchObject({
      status: 'removed',
      backupRef: 'backup:shakedown-001',
      rollbackRef: 'rollback:shakedown-001',
      proof: { allRunArtifactsRemoved: true, remainingArtifactCounts: {} },
    });
    expect(dependencies.inspectExact).toHaveBeenCalledTimes(2);
    expect(dependencies.removeExact).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: revision,
    }));
    expect(dependencies.appendAudit).toHaveBeenCalledOnce();
  });

  it('refuses a target that changes during backup', async () => {
    const inspectExact = vi.fn()
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce({ ...inventory(), targetRevision: 'c'.repeat(64) });
    const dependencies = ports({ inspectExact });
    const service = new ShakedownArtifactCleanupService(dependencies);

    await expect(service.apply(target, {
      operatorApproved: true,
      approvalId: 'operator-approval-001',
    })).rejects.toThrow('changed while the backup was being captured');
    expect(dependencies.removeExact).not.toHaveBeenCalled();
  });

  it('fails instead of claiming success when any run artifact remains', async () => {
    const dependencies = ports({
      verifyAbsent: vi.fn(async () => ({
        allRunArtifactsRemoved: false,
        remainingArtifactCounts: { turn_records: 1 },
      })),
    });
    const service = new ShakedownArtifactCleanupService(dependencies);

    await expect(service.apply(target, {
      operatorApproved: true,
      approvalId: 'operator-approval-001',
    })).rejects.toThrow('every run-owned artifact');
    expect(dependencies.appendAudit).not.toHaveBeenCalled();
  });

  it('requires approval before any backup or mutation', async () => {
    const dependencies = ports();
    const service = new ShakedownArtifactCleanupService(dependencies);

    await expect(service.apply(target, {
      operatorApproved: false,
      approvalId: 'operator-approval-001',
    })).rejects.toThrow('explicit operator approval');
    expect(dependencies.inspectExact).not.toHaveBeenCalled();
    expect(dependencies.captureBackup).not.toHaveBeenCalled();
  });

  it('rejects inventory that does not match the exact manifest artifact ids', async () => {
    const dependencies = ports({
      inspectExact: vi.fn(async () => ({
        ...inventory(),
        artifacts: target.artifacts.slice(0, -1),
      })),
    });
    const service = new ShakedownArtifactCleanupService(dependencies);

    await expect(service.dryRun(target)).rejects.toThrow('exact artifact manifest');
    expect(dependencies.captureBackup).not.toHaveBeenCalled();
  });
});
