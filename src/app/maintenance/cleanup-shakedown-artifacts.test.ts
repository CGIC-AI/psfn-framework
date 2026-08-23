import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShakedownArtifactCleanupService } from '../../system/lifecycle/shakedown-artifact-cleanup.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  parseShakedownCleanupArgs,
  runShakedownCleanupCli,
} from './cleanup-shakedown-artifacts.js';

describe('shakedown artifact cleanup CLI', () => {
  it('defaults to an exact dry run and requires explicit apply approval', () => {
    expect(parseShakedownCleanupArgs([
      '--manifest', '/tmp/exact-manifest.json',
    ])).toMatchObject({
      apply: false,
      manifestFile: '/tmp/exact-manifest.json',
    });
    expect(parseShakedownCleanupArgs([
      '--manifest', '/tmp/exact-manifest.json',
      '--apply',
      '--approval-id', 'approval-one',
    ])).toMatchObject({ apply: true, approvalId: 'approval-one' });
  });

  it('exposes a reachable dry-run command without backup or mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-shakedown-cleanup-cli-'));
    const manifestPath = join(root, 'manifest.json');
    const artifacts = [
      { kind: 'session' as const, id: 'api:testing-harness' },
      { kind: 'channel' as const, id: 'api:testing-harness' },
      { kind: 'event' as const, id: '1' },
    ];
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      companionId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'api:testing-harness',
      runId: 'run-one',
      manifestId: 'manifest-one',
      artifacts,
    }));
    const inspectExact = vi.fn(async () => ({
      status: 'present' as const,
      targetRevision: 'a'.repeat(64),
      artifactCounts: { journal_files: 1 },
      artifacts,
    }));
    const captureBackup = vi.fn();
    const removeExact = vi.fn();
    const close = vi.fn(async () => undefined);
    const createRuntime = vi.fn(async () => ({
      service: new ShakedownArtifactCleanupService({
        inspectExact,
        captureBackup,
        removeExact,
        verifyAbsent: vi.fn(),
        appendAudit: vi.fn(),
        finalize: vi.fn(),
      }),
      close,
    }));
    const companionId = '11111111-1111-4111-8111-111111111111';
    const bootstrapRuntime = vi.fn(async () => ({
      backupDir: '/backup',
      dataDir: '/system',
      config: {
        companionId,
        postgresDatabaseUrl: 'postgresql://runtime@example.invalid/psfn',
      } as unknown as SubstrateConfig,
    }));
    const resolveTarget = vi.fn(() => ({
      companionDataDir: '/companion',
      companionId,
      postgresSchema: 'public',
      sessionsDir: '/companion/state/sessions',
    }));
    const resolveBackupConfig = vi.fn();

    try {
      await expect(runShakedownCleanupCli([
        '--manifest', manifestPath,
      ], {
        bootstrapRuntime,
        createRuntime,
        resolveBackupConfig,
        resolveTarget,
      })).resolves.toMatchObject({ status: 'ready' });
      expect(inspectExact).toHaveBeenCalledOnce();
      expect(captureBackup).not.toHaveBeenCalled();
      expect(removeExact).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(resolveBackupConfig).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
