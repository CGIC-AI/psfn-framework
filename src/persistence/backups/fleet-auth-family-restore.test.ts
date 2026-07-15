import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetAuthAuthorityFloorStore } from '../postgres/fleet-auth/authority-floor.js';
import type { FleetAuthDatabaseRoles } from '../postgres/fleet-auth/schema.js';
import type { FleetAuthBackupArtifact } from './fleet-auth-coordinator.js';
import { restoreFleetAuthConsistentFamily } from './fleet-restore.js';

const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'auth_runtime',
  migration: 'auth_migration',
  backupRestore: 'auth_backup_restore',
};

const roots: string[] = [];

function makeRoot(): string {
  const root = join(
    tmpdir(),
    `psfn-fleet-auth-family-restore-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function hashArtifact(path: string): Pick<FleetAuthBackupArtifact, 'sha256' | 'sizeBytes'> {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

function writeFamily(
  root: string,
  options: { tamper?: boolean; omitShared?: boolean } = {},
): string {
  const files = [
    { kind: 'companion' as const, path: 'postgres/companion_one.dump', schema: 'companion_one' },
    { kind: 'shared' as const, path: 'postgres/shared.dump', schema: 'shared' },
    { kind: 'fleet_auth' as const, path: 'fleet-auth.snapshot.json', schema: 'fleet_auth' },
    { kind: 'fleet_auth_config' as const, path: 'system-config/fleet-auth.json' },
  ];
  for (const file of files) {
    const absolutePath = join(root, file.path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `${file.kind}\n`, 'utf8');
  }
  const manifestedFiles = options.omitShared
    ? files.filter(file => file.kind !== 'shared')
    : files;
  const artifacts: FleetAuthBackupArtifact[] = manifestedFiles.map(file => ({
    kind: file.kind,
    path: file.path,
    ...(file.schema ? { postgresSchema: file.schema } : {}),
    ...hashArtifact(join(root, file.path)),
  }));
  const manifestPath = join(root, 'fleet-auth-backup-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 2,
    capturedAt: '2026-07-15T15:00:00.000Z',
    postgresSnapshot: '100:200:',
    authorityLineageId: 'a'.repeat(64),
    artifacts,
  }), 'utf8');
  if (options.tamper) {
    writeFileSync(join(root, 'postgres/companion_one.dump'), 'tampered\n', 'utf8');
  }
  return manifestPath;
}

function writeRestoreStub(
  root: string,
  sharedTocSchema = 'shared',
): { binary: string; logPath: string } {
  const binary = join(root, 'pg-restore-stub.sh');
  const logPath = join(root, 'pg-restore.log');
  writeFileSync(binary, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${logPath}'`,
    'dump=""',
    'for arg in "$@"; do dump="$arg"; done',
    'case "$1" in',
    '  --list)',
    '    case "$dump" in',
    '      *companion_one.dump) printf "1; 0 100 TABLE companion_one sample owner\\n" ;;',
    `      *shared.dump) printf "1; 0 100 TABLE ${sharedTocSchema} sample owner\\n" ;;`,
    '    esac',
    '    exit 0',
    '    ;;',
    'esac',
    'case "$dump" in',
    '  *shared.dump) exit 17 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  return { binary, logPath };
}

function restoreOptions(
  manifestPath: string,
  pgRestoreBinary: string,
): Parameters<typeof restoreFleetAuthConsistentFamily>[0] {
  const floorRoot = join(dirname(manifestPath), 'authority-floor');
  mkdirSync(floorRoot, { recursive: true, mode: 0o700 });
  return {
    manifestPath,
    backupRestoreDatabaseUrl: 'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app',
    roles: ROLES,
    authorityFloors: new FleetAuthAuthorityFloorStore(floorRoot),
    activationGeneration: 2,
    pgRestoreBinary,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('restoreFleetAuthConsistentFamily fail-closed orchestration', () => {
  it('rejects manifest tampering before invoking pg_restore', async () => {
    const root = makeRoot();
    const manifestPath = writeFamily(root, { tamper: true });
    const stub = writeRestoreStub(root);

    await expect(restoreFleetAuthConsistentFamily(restoreOptions(manifestPath, stub.binary)))
      .rejects.toThrow(/digest mismatch/);
    expect(() => readFileSync(stub.logPath, 'utf8')).toThrow();
  });

  it('rejects an incomplete family before invoking pg_restore', async () => {
    const root = makeRoot();
    const manifestPath = writeFamily(root, { omitShared: true });
    const stub = writeRestoreStub(root);

    await expect(restoreFleetAuthConsistentFamily(restoreOptions(manifestPath, stub.binary)))
      .rejects.toThrow(/incomplete same-snapshot artifact family/);
    expect(() => readFileSync(stub.logPath, 'utf8')).toThrow();
  });

  it('validates every dump scope before restoring the first schema', async () => {
    const root = makeRoot();
    const manifestPath = writeFamily(root);
    const stub = writeRestoreStub(root, 'unexpected_schema');

    await expect(restoreFleetAuthConsistentFamily(restoreOptions(manifestPath, stub.binary)))
      .rejects.toThrow(/schema scope mismatch/);

    const calls = readFileSync(stub.logPath, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.startsWith('--list'))).toBe(true);
  });

  it('propagates a mid-family schema restore failure without reporting partial success', async () => {
    const root = makeRoot();
    const manifestPath = writeFamily(root);
    const stub = writeRestoreStub(root);

    await expect(restoreFleetAuthConsistentFamily(restoreOptions(manifestPath, stub.binary)))
      .rejects.toThrow(/pg_restore failed.*shared\.dump/);

    const calls = readFileSync(stub.logPath, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain('--list');
    expect(calls[0]).toContain('companion_one.dump');
    expect(calls[1]).toContain('--list');
    expect(calls[1]).toContain('shared.dump');
    expect(calls[2]).toContain('--single-transaction');
    expect(calls[2]).toContain('companion_one.dump');
    expect(calls[3]).toContain('--single-transaction');
    expect(calls[3]).toContain('shared.dump');
  });
});
