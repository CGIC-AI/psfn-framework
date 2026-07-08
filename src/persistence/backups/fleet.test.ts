import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FLEET_BACKUP_MANIFEST_NAME,
  FLEET_CLUSTER_DIR_NAME,
  FLEET_COMPANIONS_DIR_NAME,
  FLEET_GROUP_DIR_NAME,
  FleetBackupPartialFailureError,
  runFleetBackupCycle,
  type FleetBackupCompanionUnit,
} from './service.js';

const FIXED_NOW = () => Date.UTC(2026, 1, 26, 10, 11, 12, 123);

/**
 * A pg_dump stub that records every invocation's `--schema` (or `ALL` when the
 * whole database is dumped) and output path to a shared log, then writes a
 * non-empty archive so the cycle proceeds.
 */
function writeSchemaLoggingStubPgDump(root: string): { stubPath: string; logPath: string } {
  const stubPath = join(root, 'stub-pg-dump-schema-log.sh');
  const logPath = join(root, 'pg-dump-schema-log.txt');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      'schema=""',
      'out=""',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    --schema=*) schema="${arg#--schema=}";;',
      '    --file=*) out="${arg#--file=}";;',
      '  esac',
      'done',
      `printf '%s\\t%s\\n' "\${schema:-ALL}" "$out" >> '${logPath}'`,
      'printf "stub-dump" > "$out"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { stubPath, logPath };
}

function writeSystemOwnerFiles(systemDataDir: string): void {
  mkdirSync(systemDataDir, { recursive: true });
  writeFileSync(join(systemDataDir, 'settings.json'), JSON.stringify({ sessionHistoryBudgetPct: 50 }), 'utf-8');
  writeFileSync(join(systemDataDir, 'models.json'), JSON.stringify({ schemaVersion: 1, models: [] }), 'utf-8');
  writeFileSync(join(systemDataDir, 'backup.json'), JSON.stringify({
    intervalHours: 12,
    maxRotatingBackups: 9,
    maxWeeklyBackups: 2,
    maxMonthlyBackups: 1,
    mirrorDir: '',
    verifyRestore: true,
    groupMode: false,
    encryption: { mode: 'required', keyRef: { kind: 'env', envName: 'PSFN_BACKUP_TEST_KEY' } },
  }), 'utf-8');
  writeFileSync(join(systemDataDir, 'channels.json'), JSON.stringify({
    discord: { heartbeatChannelId: 'heartbeat' },
  }), 'utf-8');
}

/**
 * Materializes a companion's data directory (files + a session JSONL) and
 * returns the fleet unit describing it.
 */
function makeCompanion(
  root: string,
  companionId: string,
  postgresSchema: string,
): FleetBackupCompanionUnit {
  const companionDataDir = join(root, 'companion-data', companionId);
  const sessionsDir = join(companionDataDir, 'state', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(join(companionDataDir, 'vault'), { recursive: true });
  writeFileSync(join(companionDataDir, 'companion.json'), `{"id":"${companionId}"}\n`, 'utf-8');
  writeFileSync(join(companionDataDir, 'vault', 'note.md'), `note for ${companionId}\n`, 'utf-8');
  writeFileSync(join(sessionsDir, 'channel.jsonl'), '{"id":1}\n', 'utf-8');
  return { companionId, postgresSchema, companionDataDir, sessionsDir };
}

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

describe('runFleetBackupCycle', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('produces N per-companion slices plus one cluster artifact (N+1)', async () => {
    const root = join(tmpdir(), `psfn-fleet-nplus1-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    writeSystemOwnerFiles(systemDataDir);
    const backupRootDir = join(root, 'backups');
    const { stubPath, logPath } = writeSchemaLoggingStubPgDump(root);

    const companions = [
      makeCompanion(root, COMPANION_A, 'companion_alpha'),
      makeCompanion(root, COMPANION_B, 'companion_beta'),
    ];

    const result = await runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn', pgDumpBinary: stubPath },
      companions,
      systemDataDir,
      backupRootDir,
      now: FIXED_NOW,
    });

    // N companions + 1 cluster = N+1 artifacts.
    expect(result.mode).toBe('per-companion');
    expect(result.overallStatus).toBe('success');
    expect(result.units).toHaveLength(companions.length + 1);
    expect(result.units.filter(u => u.kind === 'companion')).toHaveLength(2);
    expect(result.units.filter(u => u.kind === 'cluster')).toHaveLength(1);
    expect(result.units.every(u => u.status === 'success')).toBe(true);

    // Each companion slice carries a schema-scoped dump and its own tree; no
    // system-config leaks into a companion slice.
    for (const companion of companions) {
      const artifact = result.units.find(u => u.companionId === companion.companionId)?.artifactDir;
      expect(artifact).toBeDefined();
      const artifactDir = join(backupRootDir, artifact!);
      expect(existsSync(join(artifactDir, 'database', `psfn.${companion.postgresSchema}.dump`))).toBe(true);
      expect(existsSync(join(artifactDir, 'companion-tree', 'vault', 'note.md'))).toBe(true);
      expect(existsSync(join(artifactDir, 'sessions', 'channel.jsonl'))).toBe(true);
      expect(existsSync(join(artifactDir, 'system-config'))).toBe(false);
    }

    // Cluster artifact holds the shared dump + system tree, no companion tree.
    const clusterArtifact = result.units.find(u => u.kind === 'cluster')?.artifactDir;
    const clusterDir = join(backupRootDir, clusterArtifact!);
    expect(existsSync(join(clusterDir, 'database', 'psfn.shared.dump'))).toBe(true);
    expect(existsSync(join(clusterDir, 'system-config', 'settings.json'))).toBe(true);
    expect(existsSync(join(clusterDir, 'companion-tree'))).toBe(false);

    // Per-schema dump args: one dump per companion schema + the shared schema.
    const dumped = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => line.split('\t')[0]).sort();
    expect(dumped).toEqual(['companion_alpha', 'companion_beta', 'shared']);

    // Directory layout matches N+1.
    expect(readdirSync(join(backupRootDir, FLEET_COMPANIONS_DIR_NAME)).sort())
      .toEqual([COMPANION_A, COMPANION_B].sort());
    expect(existsSync(join(backupRootDir, FLEET_CLUSTER_DIR_NAME))).toBe(true);

    // Fleet manifest records per-unit outcomes + overall success.
    const manifest = JSON.parse(readFileSync(join(backupRootDir, FLEET_BACKUP_MANIFEST_NAME), 'utf-8'));
    expect(manifest.mode).toBe('per-companion');
    expect(manifest.overallStatus).toBe('success');
    expect(manifest.units).toHaveLength(3);
    expect(manifest.layout.mode).toBe('per-companion');
  });

  it('produces a single whole-database family artifact in group mode', async () => {
    const root = join(tmpdir(), `psfn-fleet-group-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    writeSystemOwnerFiles(systemDataDir);
    const backupRootDir = join(root, 'backups');
    const { stubPath, logPath } = writeSchemaLoggingStubPgDump(root);

    const companions = [
      makeCompanion(root, COMPANION_A, 'companion_alpha'),
      makeCompanion(root, COMPANION_B, 'companion_beta'),
    ];

    const result = await runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn', pgDumpBinary: stubPath },
      companions,
      systemDataDir,
      backupRootDir,
      groupMode: true,
      groupCompanionDataDir: join(root, 'companion-data'),
      now: FIXED_NOW,
    });

    expect(result.mode).toBe('group');
    expect(result.overallStatus).toBe('success');
    expect(result.units).toHaveLength(1);
    expect(result.units[0].kind).toBe('group');

    const groupDir = join(backupRootDir, result.units[0].artifactDir!);
    // Whole-database dump (no schema qualifier).
    expect(existsSync(join(groupDir, 'database', 'psfn.dump'))).toBe(true);
    // Every companion's files land in the single family tree.
    expect(existsSync(join(groupDir, 'companion-tree', COMPANION_A, 'vault', 'note.md'))).toBe(true);
    expect(existsSync(join(groupDir, 'companion-tree', COMPANION_B, 'vault', 'note.md'))).toBe(true);
    expect(existsSync(join(groupDir, 'system-config', 'settings.json'))).toBe(true);

    // Exactly one whole-database dump; no per-schema slices.
    const dumped = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => line.split('\t')[0]);
    expect(dumped).toEqual(['ALL']);

    expect(existsSync(join(backupRootDir, FLEET_GROUP_DIR_NAME))).toBe(true);
    expect(existsSync(join(backupRootDir, FLEET_COMPANIONS_DIR_NAME))).toBe(false);
  });

  it('fails loudly and records per-unit outcomes when one companion fails', async () => {
    const root = join(tmpdir(), `psfn-fleet-onefail-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    writeSystemOwnerFiles(systemDataDir);
    const backupRootDir = join(root, 'backups');
    const { stubPath } = writeSchemaLoggingStubPgDump(root);

    const good = makeCompanion(root, COMPANION_A, 'companion_alpha');
    // Second companion's data dir is never created — its tree capture must fail.
    const broken: FleetBackupCompanionUnit = {
      companionId: COMPANION_B,
      postgresSchema: 'companion_beta',
      companionDataDir: join(root, 'companion-data', COMPANION_B),
      sessionsDir: join(root, 'companion-data', COMPANION_B, 'state', 'sessions'),
    };

    await expect(runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn', pgDumpBinary: stubPath },
      companions: [good, broken],
      systemDataDir,
      backupRootDir,
      now: FIXED_NOW,
    })).rejects.toBeInstanceOf(FleetBackupPartialFailureError);

    // The fleet manifest is written before throwing: a partial run can never
    // pass for a full success.
    const manifest = JSON.parse(readFileSync(join(backupRootDir, FLEET_BACKUP_MANIFEST_NAME), 'utf-8'));
    expect(manifest.overallStatus).toBe('failure');
    const goodOutcome = manifest.units.find((u: { companionId?: string }) => u.companionId === COMPANION_A);
    const brokenOutcome = manifest.units.find((u: { companionId?: string }) => u.companionId === COMPANION_B);
    expect(goodOutcome.status).toBe('success');
    expect(brokenOutcome.status).toBe('failure');
    expect(brokenOutcome.error).toMatch(/directory missing/i);
  });

  it('refuses to run with an empty fleet', async () => {
    const root = join(tmpdir(), `psfn-fleet-empty-${Date.now()}`);
    roots.push(root);
    await expect(runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn' },
      companions: [],
      systemDataDir: join(root, 'system-data'),
      backupRootDir: join(root, 'backups'),
      now: FIXED_NOW,
    })).rejects.toThrow('at least one companion');
  });

  it('requires a group companion-data root in group mode', async () => {
    const root = join(tmpdir(), `psfn-fleet-group-missing-${Date.now()}`);
    roots.push(root);
    await expect(runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn' },
      companions: [makeCompanion(root, COMPANION_A, 'companion_alpha')],
      systemDataDir: join(root, 'system-data'),
      backupRootDir: join(root, 'backups'),
      groupMode: true,
      now: FIXED_NOW,
    })).rejects.toThrow('groupCompanionDataDir');
  });
});
