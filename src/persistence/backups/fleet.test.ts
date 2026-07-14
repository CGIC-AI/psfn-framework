import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_BACKUP_MANIFEST_NAME,
  FLEET_CLUSTER_DIR_NAME,
  FLEET_COMPANIONS_DIR_NAME,
  FLEET_GROUP_DIR_NAME,
  FleetBackupPartialFailureError,
  runFleetBackupCycle,
  type FleetBackupCompanionUnit,
} from './service.js';
import {
  restoreFleetClusterArtifact,
  restoreFleetCompanionSlice,
  restoreFleetGroupArtifact,
} from './fleet-restore.js';
import {
  KUBERNETES_HELM_RECOVERY_MANIFEST_NAME,
  type KubernetesHelmBackupConfig,
} from './kubernetes-helm.js';
import {
  KUBERNETES_HELM_CHART_DIGEST_FILE_NAME,
  inspectKubernetesHelmRecoveryChart,
} from './kubernetes-helm-chart.js';

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

function writeLoggingStubPgRestore(root: string): { stubPath: string; logPath: string } {
  const stubPath = join(root, 'stub-pg-restore.sh');
  const logPath = join(root, 'pg-restore-log.txt');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--list" ]; then',
      '  case "$2" in',
      '    *.companion_alpha.dump) schemas="companion_alpha";;',
      '    *.companion_beta.dump) schemas="companion_beta";;',
      '    *.shared.dump) schemas="shared";;',
      '    *) schemas="companion_alpha companion_beta shared";;',
      '  esac',
      '  id=1',
      '  for schema in $schemas; do',
      '    printf "%s; 2615 0 SCHEMA - %s postgres\\n" "$id" "$schema"',
      '    id=$((id + 1))',
      '    printf "%s; 1259 0 TABLE %s restore_probe postgres\\n" "$id" "$schema"',
      '    id=$((id + 1))',
      '  done',
      '  exit 0',
      'fi',
      `printf '%s\\n' "$*" >> '${logPath}'`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { stubPath, logPath };
}

function writeTargetStateStubPsql(root: string, output = 'public\\t0\\n'): string {
  const stubPath = join(root, `stub-psql-${Date.now()}-${Math.random()}.sh`);
  const markerPath = `${stubPath}.marker`;
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      'command=""',
      'previous=""',
      'for arg in "$@"; do',
      '  if [ "$previous" = "--command" ]; then command="$arg"; fi',
      '  previous="$arg"',
      'done',
      'case "$command" in',
      '  *"restore_marker_inspect"*)',
      `    if [ -f '${markerPath}' ]; then cat '${markerPath}'; else printf 'absent\\n'; fi`,
      '    ;;',
      '  *"restore_marker_prepare"*)',
      `    printf 'prepared\\n' > '${markerPath}'`,
      '    ;;',
      '  *"restore_marker_commit"*)',
      `    printf 'committed\\n' > '${markerPath}'`,
      '    ;;',
      '  *"restore_marker_remove"*)',
      `    rm -f '${markerPath}'`,
      '    ;;',
      '  *)',
      `    printf '${output.replaceAll("'", "'\\\\''")}'`,
      '    ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return stubPath;
}

function writeCredentialRecordingTargetStateStubPsql(root: string): {
  stubPath: string;
  argvPath: string;
  envPath: string;
} {
  const stubPath = writeTargetStateStubPsql(root);
  const originalPath = `${stubPath}.original`;
  const argvPath = `${stubPath}.argv`;
  const envPath = `${stubPath}.env`;
  writeFileSync(originalPath, readFileSync(stubPath, 'utf8'), { mode: 0o755 });
  writeFileSync(stubPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> '${argvPath}'`,
    `printf 'PGPASSWORD=%s|PGPASSFILE=%s|PGSERVICE=%s|PGSERVICEFILE=%s|PGSSLKEY=%s|KRB5CCNAME=%s\\n' "$PGPASSWORD" "$PGPASSFILE" "$PGSERVICE" "$PGSERVICEFILE" "$PGSSLKEY" "$KRB5CCNAME" >> '${envPath}'`,
    `exec '${originalPath}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { stubPath, argvPath, envPath };
}

function writeControlledStubPgRestore(
  root: string,
  name: string,
  tocSchemas: readonly string[],
  restoreExitCode: number,
): { stubPath: string; logPath: string } {
  const stubPath = join(root, `stub-pg-restore-${name}.sh`);
  const logPath = join(root, `pg-restore-${name}.log`);
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--list" ]; then',
      `  schemas="${tocSchemas.join(' ')}"`,
      '  id=1',
      '  for schema in $schemas; do',
      '    printf "%s; 2615 0 SCHEMA - %s postgres\\n" "$id" "$schema"',
      '    id=$((id + 1))',
      '    printf "%s; 1259 0 TABLE %s restore_probe postgres\\n" "$id" "$schema"',
      '    id=$((id + 1))',
      '  done',
      '  exit 0',
      'fi',
      `printf '%s\\n' "$*" >> '${logPath}'`,
      `exit ${restoreExitCode}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { stubPath, logPath };
}

function writeCredentialRecordingStubPgRestore(root: string, restoreExitCode = 0): {
  stubPath: string;
  argvPath: string;
  passwordPath: string;
  envPath: string;
} {
  const stubPath = join(root, 'stub-pg-restore-credentials.sh');
  const argvPath = join(root, 'pg-restore-credentials.argv');
  const passwordPath = join(root, 'pg-restore-credentials.password');
  const envPath = join(root, 'pg-restore-credentials.env');
  writeFileSync(stubPath, [
    '#!/bin/sh',
    'if [ "$1" = "--list" ]; then',
    '  printf "1; 2615 0 SCHEMA - companion_alpha postgres\\n"',
    '  printf "2; 1259 0 TABLE companion_alpha restore_probe postgres\\n"',
    '  exit 0',
    'fi',
    `printf '%s\\n' "$*" > '${argvPath}'`,
    `printf '%s' "\${PGPASSWORD:-}" > '${passwordPath}'`,
    `printf 'PGPASSFILE=%s|PGSERVICE=%s|PGSERVICEFILE=%s|PGSSLKEY=%s|KRB5CCNAME=%s\\n' "$PGPASSFILE" "$PGSERVICE" "$PGSERVICEFILE" "$PGSSLKEY" "$KRB5CCNAME" > '${envPath}'`,
    ...(restoreExitCode === 0 ? [] : ['printf \'%s\' "${PGPASSWORD:-}" >&2']),
    `exit ${restoreExitCode}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { stubPath, argvPath, passwordPath, envPath };
}

function writeRacingSchemaStateStubPsql(root: string): string {
  const stubPath = join(root, 'stub-psql-racing-schema.sh');
  const stateReadPath = `${stubPath}.state-read`;
  writeFileSync(stubPath, [
    '#!/bin/sh',
    'command=""',
    'previous=""',
    'for arg in "$@"; do',
    '  if [ "$previous" = "--command" ]; then command="$arg"; fi',
    '  previous="$arg"',
    'done',
    'case "$command" in',
    '  *"restore_marker_inspect"*)',
    '    printf "absent\\n"',
    '    ;;',
    '  *)',
    `    if [ -f '${stateReadPath}' ]; then`,
    '      printf "companion_alpha\\t1\\npublic\\t0\\n"',
    '    else',
    `      : > '${stateReadPath}'`,
    '      printf "public\\t0\\n"',
    '    fi',
    '    ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  return stubPath;
}

function writeDestinationCollisionStubPsql(root: string, destination: string): string {
  const stubPath = join(root, 'stub-psql-destination-collision.sh');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      `mkdir -p '${destination}'`,
      `printf 'concurrent\\n' > '${join(destination, 'owner.txt')}'`,
      "printf 'public\\t0\\n'",
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return stubPath;
}

function writeStatefulRestoreStubs(root: string): {
  pgRestoreBinary: string;
  psqlBinary: string;
  statePath: string;
} {
  const statePath = join(root, 'restore-schema-state.txt');
  const markerPath = join(root, 'restore-operation-marker.txt');
  const pgRestoreBinary = join(root, 'stub-pg-restore-stateful.sh');
  const psqlBinary = join(root, 'stub-psql-stateful.sh');
  writeFileSync(pgRestoreBinary, [
    '#!/bin/sh',
    'if [ "$1" = "--list" ]; then',
    '  printf "1; 2615 0 SCHEMA - companion_alpha postgres\\n"',
    '  printf "2; 1259 0 TABLE companion_alpha restore_probe postgres\\n"',
    '  exit 0',
    'fi',
    `printf 'companion_alpha\\t1\\npublic\\t0\\n' > '${statePath}'`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(psqlBinary, [
    '#!/bin/sh',
    'command=""',
    'previous=""',
    'for arg in "$@"; do',
    '  if [ "$previous" = "--command" ]; then command="$arg"; fi',
    '  previous="$arg"',
    'done',
    'case "$command" in',
    '  *"restore_marker_inspect"*)',
    `    if [ -f '${markerPath}' ]; then cat '${markerPath}'; else printf 'absent\\n'; fi`,
    '    ;;',
    '  *"restore_marker_prepare"*)',
    `    printf 'prepared\\n' > '${markerPath}'`,
    '    ;;',
    '  *"restore_marker_commit"*)',
    `    printf 'committed\\n' > '${markerPath}'`,
    '    ;;',
    '  *"restore_marker_remove"*)',
    `    rm -f '${markerPath}'`,
    '    ;;',
    '  *"DROP SCHEMA"*)',
    `    printf 'public\\t0\\n' > '${statePath}'`,
    '    ;;',
    '  *)',
    `    if [ -f '${statePath}' ]; then cat '${statePath}'; else printf 'public\\t0\\n'; fi`,
    '    ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  return { pgRestoreBinary, psqlBinary, statePath };
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

function writeTestHelmChart(root: string): KubernetesHelmBackupConfig {
  const chartSourceDir = join(root, 'helm-chart');
  mkdirSync(join(chartSourceDir, 'templates'), { recursive: true });
  writeFileSync(
    join(chartSourceDir, 'Chart.yaml'),
    'apiVersion: v2\nname: psfn\nversion: 0.1.0\nappVersion: 0.1.0-kube\n',
    'utf-8',
  );
  writeFileSync(join(chartSourceDir, 'values.yaml'), 'apiKey: CHANGE_ME_API_KEY\n', 'utf-8');
  writeFileSync(join(chartSourceDir, 'templates', 'deployment.yaml'), 'kind: Deployment\n', 'utf-8');
  const chartContentSha256 = inspectKubernetesHelmRecoveryChart(chartSourceDir).contentSha256;
  writeFileSync(
    join(chartSourceDir, KUBERNETES_HELM_CHART_DIGEST_FILE_NAME),
    `${chartContentSha256}\n`,
    'utf-8',
  );
  const image = {
    repository: 'localhost/psfn-framework',
    tag: '0.1.0-kube-ae758a4f',
  };
  return {
    chartSourceDir,
    releaseName: 'psfn',
    namespace: 'psfn',
    revision: 33,
    chartName: 'psfn',
    chartVersion: '0.1.0',
    appVersion: '0.1.0-kube',
    chartContentSha256,
    images: {
      agent: image,
      gateway: image,
      garden: image,
    },
  };
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
  const personalWorkspacePath = join(root, 'workspaces', 'personal', companionId);
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(join(companionDataDir, 'vault'), { recursive: true });
  mkdirSync(join(personalWorkspacePath, 'journal'), { recursive: true });
  writeFileSync(join(companionDataDir, 'companion.json'), `{"id":"${companionId}"}\n`, 'utf-8');
  writeFileSync(join(companionDataDir, 'vault', 'note.md'), `note for ${companionId}\n`, 'utf-8');
  writeFileSync(join(sessionsDir, 'channel.jsonl'), '{"id":1}\n', 'utf-8');
  writeFileSync(join(personalWorkspacePath, 'journal', 'personal.md'), `private ${companionId}\n`, 'utf-8');
  return { companionId, postgresSchema, companionDataDir, sessionsDir, personalWorkspacePath };
}

function makeSharedWorkspace(root: string): string {
  const sharedWorkspacePath = join(root, 'workspaces', 'shared');
  mkdirSync(join(sharedWorkspacePath, 'artifacts'), { recursive: true });
  writeFileSync(join(sharedWorkspacePath, 'artifacts', 'world.md'), 'shared world\n', 'utf-8');
  return sharedWorkspacePath;
}

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

async function createPerCompanionTestBackup(root: string) {
  const systemDataDir = join(root, 'system-data');
  writeSystemOwnerFiles(systemDataDir);
  const { stubPath: pgDumpBinary } = writeSchemaLoggingStubPgDump(root);
  return await runFleetBackupCycle({
    postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn', pgDumpBinary },
    companions: [
      makeCompanion(root, COMPANION_A, 'companion_alpha'),
      makeCompanion(root, COMPANION_B, 'companion_beta'),
    ],
    systemDataDir,
    sharedWorkspacePath: makeSharedWorkspace(root),
    backupRootDir: join(root, 'backups'),
    now: FIXED_NOW,
  });
}

describe('runFleetBackupCycle', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
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
    const kubernetesHelm = writeTestHelmChart(root);

    const companions = [
      makeCompanion(root, COMPANION_A, 'companion_alpha'),
      makeCompanion(root, COMPANION_B, 'companion_beta'),
    ];
    const sharedWorkspacePath = makeSharedWorkspace(root);

    const result = await runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn', pgDumpBinary: stubPath },
      companions,
      systemDataDir,
      sharedWorkspacePath,
      kubernetesHelm,
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
      expect(existsSync(join(artifactDir, 'workspace-tree', 'journal', 'personal.md'))).toBe(true);
      expect(existsSync(join(artifactDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME))).toBe(false);
    }

    // Cluster artifact holds the shared dump + system tree, no companion tree.
    const clusterArtifact = result.units.find(u => u.kind === 'cluster')?.artifactDir;
    const clusterDir = join(backupRootDir, clusterArtifact!);
    expect(existsSync(join(clusterDir, 'database', 'psfn.shared.dump'))).toBe(true);
    expect(existsSync(join(clusterDir, 'system-config', 'settings.json'))).toBe(true);
    expect(existsSync(join(clusterDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME))).toBe(true);
    expect(existsSync(join(clusterDir, 'companion-tree'))).toBe(false);
    expect(existsSync(join(clusterDir, 'workspace-tree', 'artifacts', 'world.md'))).toBe(true);

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
    const kubernetesHelm = writeTestHelmChart(root);

    const companions = [
      makeCompanion(root, COMPANION_A, 'companion_alpha'),
      makeCompanion(root, COMPANION_B, 'companion_beta'),
    ];
    const sharedWorkspacePath = makeSharedWorkspace(root);

    const result = await runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn', pgDumpBinary: stubPath },
      companions,
      systemDataDir,
      sharedWorkspacePath,
      kubernetesHelm,
      backupRootDir,
      groupMode: true,
      groupCompanionDataDir: join(root, 'companion-data'),
      groupWorkspacesRoot: join(root, 'workspaces'),
      now: FIXED_NOW,
    });

    expect(result.mode).toBe('group');
    expect(result.overallStatus).toBe('success');
    expect(result.units).toHaveLength(1);
    expect(result.units[0].kind).toBe('group');
    expect(result.units[0].postgresSchemas).toEqual(['companion_alpha', 'companion_beta', 'shared']);

    const groupDir = join(backupRootDir, result.units[0].artifactDir!);
    // Whole-database dump (no schema qualifier).
    expect(existsSync(join(groupDir, 'database', 'psfn.dump'))).toBe(true);
    // Every companion's files land in the single family tree.
    expect(existsSync(join(groupDir, 'companion-tree', COMPANION_A, 'vault', 'note.md'))).toBe(true);
    expect(existsSync(join(groupDir, 'companion-tree', COMPANION_B, 'vault', 'note.md'))).toBe(true);
    expect(existsSync(join(groupDir, 'system-config', 'settings.json'))).toBe(true);
    expect(existsSync(join(groupDir, 'workspace-tree', 'personal', COMPANION_A, 'journal', 'personal.md'))).toBe(true);
    expect(existsSync(join(groupDir, 'workspace-tree', 'shared', 'artifacts', 'world.md'))).toBe(true);
    expect(existsSync(join(groupDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME))).toBe(true);

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
    const sharedWorkspacePath = makeSharedWorkspace(root);
    // Second companion's data dir is never created — its tree capture must fail.
    const broken: FleetBackupCompanionUnit = {
      companionId: COMPANION_B,
      postgresSchema: 'companion_beta',
      companionDataDir: join(root, 'companion-data', COMPANION_B),
      sessionsDir: join(root, 'companion-data', COMPANION_B, 'state', 'sessions'),
      personalWorkspacePath: join(root, 'workspaces', 'personal', COMPANION_B),
    };

    await expect(runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn', pgDumpBinary: stubPath },
      companions: [good, broken],
      systemDataDir,
      sharedWorkspacePath,
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
      sharedWorkspacePath: join(root, 'workspaces', 'shared'),
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
      sharedWorkspacePath: makeSharedWorkspace(root),
      backupRootDir: join(root, 'backups'),
      groupMode: true,
      now: FIXED_NOW,
    })).rejects.toThrow('groupCompanionDataDir');
  });

  it('restores one companion slice and the shared cluster artifact without cross-contamination', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    writeSystemOwnerFiles(systemDataDir);
    const backupRootDir = join(root, 'backups');
    const { stubPath: pgDumpBinary } = writeSchemaLoggingStubPgDump(root);
    const { stubPath: pgRestoreBinary, logPath } = writeLoggingStubPgRestore(root);
    const psqlBinary = writeTargetStateStubPsql(root);
    const companions = [
      makeCompanion(root, COMPANION_A, 'companion_alpha'),
      makeCompanion(root, COMPANION_B, 'companion_beta'),
    ];
    const result = await runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn', pgDumpBinary },
      companions,
      systemDataDir,
      sharedWorkspacePath: makeSharedWorkspace(root),
      backupRootDir,
      now: FIXED_NOW,
    });

    const companionDataDir = join(root, 'restore', 'companion-a');
    const personalWorkspacePath = join(root, 'restore', 'workspace-a');
    const overlappingDestination = join(root, 'restore-overlap', 'same-root');
    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations: {
        companionDataDir: overlappingDestination,
        personalWorkspacePath: overlappingDestination,
      },
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary,
      },
    })).rejects.toThrow(/distinct, non-overlapping roots/);
    expect(existsSync(join(root, 'restore-overlap'))).toBe(false);
    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations: {
        companionDataDir: join(backupRootDir, 'forbidden-restore-target'),
        personalWorkspacePath: join(root, 'unused-restore-target'),
      },
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary,
      },
    })).rejects.toThrow(/overlaps its immutable backup root/);
    expect(existsSync(join(backupRootDir, 'forbidden-restore-target'))).toBe(false);
    const backupAlias = join(root, 'backup-alias');
    symlinkSync(backupRootDir, backupAlias, 'dir');
    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations: {
        companionDataDir: join(backupAlias, 'symlinked-restore-target'),
        personalWorkspacePath: join(root, 'unused-symlink-restore-target'),
      },
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary,
      },
    })).rejects.toThrow(/overlaps its immutable backup root/);
    expect(existsSync(join(backupRootDir, 'symlinked-restore-target'))).toBe(false);

    await restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations: { companionDataDir, personalWorkspacePath },
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary,
      },
    });
    expect(readFileSync(join(companionDataDir, 'vault/note.md'), 'utf8')).toContain(COMPANION_A);
    expect(readFileSync(join(companionDataDir, 'state/sessions/channel.jsonl'), 'utf8')).toContain('"id":1');
    expect(readFileSync(join(personalWorkspacePath, 'journal/personal.md'), 'utf8')).toContain(COMPANION_A);
    expect(existsSync(join(companionDataDir, COMPANION_B))).toBe(false);
    expect(existsSync(join(personalWorkspacePath, COMPANION_B))).toBe(false);

    const restoredSystemDataDir = join(root, 'restore', 'system');
    const restoredSharedWorkspace = join(root, 'restore', 'shared');
    await restoreFleetClusterArtifact({
      fleetManifestPath: result.fleetManifestPath,
      destinations: {
        systemDataDir: restoredSystemDataDir,
        sharedWorkspacePath: restoredSharedWorkspace,
      },
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary,
      },
    });
    expect(existsSync(join(restoredSystemDataDir, 'settings.json'))).toBe(true);
    expect(readFileSync(join(restoredSharedWorkspace, 'artifacts/world.md'), 'utf8')).toBe('shared world\n');
    expect(existsSync(join(restoredSharedWorkspace, 'personal'))).toBe(false);

    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(logPath, 'utf8')).toContain('--single-transaction');
    expect(readFileSync(logPath, 'utf8')).not.toContain('secret');
    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations: { companionDataDir, personalWorkspacePath: join(root, 'restore', 'other') },
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary,
      },
    })).rejects.toThrow(/no-overwrite policy refuses collision/);
    expect(readFileSync(join(companionDataDir, 'vault/note.md'), 'utf8')).toContain(COMPANION_A);
  });

  it('rejects a dump whose TOC crosses the manifest schema scope before touching Postgres', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-scope-${Date.now()}`);
    roots.push(root);
    const result = await createPerCompanionTestBackup(root);
    const { stubPath: pgRestoreBinary, logPath } = writeControlledStubPgRestore(
      root,
      'scope-mismatch',
      ['companion_alpha', 'companion_beta'],
      0,
    );
    const destinations = {
      companionDataDir: join(root, 'restore', 'companion'),
      personalWorkspacePath: join(root, 'restore', 'workspace'),
    };

    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations,
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary: writeTargetStateStubPsql(root),
      },
    })).rejects.toThrow(/dump schema scope mismatch/);
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(destinations.companionDataDir)).toBe(false);
    expect(existsSync(destinations.personalWorkspacePath)).toBe(false);
  });

  it('rejects companion manifest entries whose artifact and schema were swapped', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-identity-swap-${Date.now()}`);
    roots.push(root);
    const result = await createPerCompanionTestBackup(root);
    const manifest = JSON.parse(readFileSync(result.fleetManifestPath, 'utf8')) as {
      units: Array<{
        kind: string;
        companionId?: string;
        postgresSchema?: string;
        artifactDir?: string;
      }>;
    };
    const alpha = manifest.units.find(unit => unit.companionId === COMPANION_A)!;
    const beta = manifest.units.find(unit => unit.companionId === COMPANION_B)!;
    [alpha.artifactDir, beta.artifactDir] = [beta.artifactDir, alpha.artifactDir];
    [alpha.postgresSchema, beta.postgresSchema] = [beta.postgresSchema, alpha.postgresSchema];
    writeFileSync(result.fleetManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations: {
        companionDataDir: join(root, 'restore', 'data'),
        personalWorkspacePath: join(root, 'restore', 'workspace'),
      },
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary: writeLoggingStubPgRestore(root).stubPath,
        psqlBinary: writeTargetStateStubPsql(root),
      },
    })).rejects.toThrow(/canonical layout|artifact identity/);
  });

  it('rejects an existing target schema before filesystem publication or pg_restore', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-schema-collision-${Date.now()}`);
    roots.push(root);
    const result = await createPerCompanionTestBackup(root);
    const { stubPath: pgRestoreBinary, logPath } = writeControlledStubPgRestore(
      root,
      'schema-collision',
      ['companion_alpha'],
      0,
    );
    const destinations = {
      companionDataDir: join(root, 'restore', 'companion'),
      personalWorkspacePath: join(root, 'restore', 'workspace'),
    };

    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations,
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary: writeTargetStateStubPsql(root, 'companion_alpha\\t1\\npublic\\t0\\n'),
      },
    })).rejects.toThrow(/schema already exists: companion_alpha/);
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(destinations.companionDataDir)).toBe(false);
    expect(existsSync(destinations.personalWorkspacePath)).toBe(false);
  });

  it('preserves a concurrent filesystem collision and does not run pg_restore', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-fs-collision-${Date.now()}`);
    roots.push(root);
    const result = await createPerCompanionTestBackup(root);
    const { stubPath: pgRestoreBinary, logPath } = writeControlledStubPgRestore(
      root,
      'fs-collision',
      ['companion_alpha'],
      0,
    );
    const destinations = {
      companionDataDir: join(root, 'restore', 'companion'),
      personalWorkspacePath: join(root, 'restore', 'workspace'),
    };

    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations,
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary: writeDestinationCollisionStubPsql(root, destinations.personalWorkspacePath),
      },
    })).rejects.toThrow();
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(destinations.companionDataDir)).toBe(false);
    expect(readFileSync(join(destinations.personalWorkspacePath, 'owner.txt'), 'utf8')).toBe('concurrent\n');
  });

  it('rolls back published filesystem trees when transactional pg_restore fails', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-pg-failure-${Date.now()}`);
    roots.push(root);
    const result = await createPerCompanionTestBackup(root);
    const { stubPath: pgRestoreBinary, logPath } = writeControlledStubPgRestore(
      root,
      'restore-failure',
      ['companion_alpha'],
      17,
    );
    const destinations = {
      companionDataDir: join(root, 'restore', 'companion'),
      personalWorkspacePath: join(root, 'restore', 'workspace'),
    };

    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations,
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary: writeTargetStateStubPsql(root),
      },
    })).rejects.toThrow(/pg_restore failed/);
    expect(readFileSync(logPath, 'utf8')).toContain('--single-transaction');
    expect(existsSync(destinations.companionDataDir)).toBe(false);
    expect(existsSync(destinations.personalWorkspacePath)).toBe(false);
  });

  it('never claims unrelated schemas observed by a fresh journal as its own restore', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-unowned-schema-${Date.now()}`);
    roots.push(root);
    const result = await createPerCompanionTestBackup(root);
    const { stubPath: pgRestoreBinary, logPath } = writeControlledStubPgRestore(
      root,
      'unowned-schema',
      ['companion_alpha'],
      0,
    );
    const destinations = {
      companionDataDir: join(root, 'restore', 'companion'),
      personalWorkspacePath: join(root, 'restore', 'workspace'),
    };

    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations,
      postgres: {
        databaseUrl: 'postgresql://restore@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary: writeRacingSchemaStateStubPsql(root),
      },
    })).rejects.toThrow(/unrelated database state/);

    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(destinations.companionDataDir)).toBe(false);
    expect(existsSync(destinations.personalWorkspacePath)).toBe(false);
    const restoreEntries = readdirSync(join(root, 'restore'));
    expect(restoreEntries.filter(name => name.startsWith('.restore-operation-'))).toHaveLength(1);
    expect(restoreEntries.filter(name => (
      name.startsWith('.companion.restore-') || name.startsWith('.workspace.restore-')
    ))).toHaveLength(2);
  });

  it('keeps query-string Postgres passwords only in child environments and out of restore journals', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-query-password-${Date.now()}`);
    roots.push(root);
    const result = await createPerCompanionTestBackup(root);
    const {
      stubPath: pgRestoreBinary,
      argvPath,
      passwordPath,
      envPath: pgRestoreEnvPath,
    } = writeCredentialRecordingStubPgRestore(root);
    const psql = writeCredentialRecordingTargetStateStubPsql(root);
    vi.stubEnv('PGPASSWORD', 'ambient-password');
    vi.stubEnv('PGPASSFILE', '/secret/ambient.pgpass');
    vi.stubEnv('PGSERVICE', 'production');
    vi.stubEnv('PGSERVICEFILE', '/secret/pg_service.conf');
    vi.stubEnv('PGSSLKEY', '/secret/client.key');
    vi.stubEnv('KRB5CCNAME', 'FILE:/secret/krb5-cache');
    const destinations = {
      companionDataDir: join(root, 'restore', 'companion'),
      personalWorkspacePath: join(root, 'restore', 'workspace'),
    };
    let journalSnapshot = '';

    await restoreFleetCompanionSlice({
      fleetManifestPath: result.fleetManifestPath,
      companionId: COMPANION_A,
      destinations,
      postgres: {
        databaseUrl: 'postgresql://restore@127.0.0.1:5432/restore?sslmode=disable&password=query-secret',
        pgRestoreBinary,
        psqlBinary: psql.stubPath,
      },
      faultInjection: (stage) => {
        if (stage !== 'after_journal') return;
        const journalName = readdirSync(join(root, 'restore'))
          .find(name => name.startsWith('.restore-operation-'));
        if (!journalName) throw new Error('Expected restore journal at fault seam');
        journalSnapshot = readFileSync(join(root, 'restore', journalName), 'utf8');
      },
    });

    const argv = readFileSync(argvPath, 'utf8');
    expect(argv).not.toContain('query-secret');
    expect(argv).not.toContain('password=');
    expect(argv).toContain('sslmode=disable');
    expect(readFileSync(passwordPath, 'utf8')).toBe('query-secret');
    const psqlArgv = readFileSync(psql.argvPath, 'utf8');
    expect(psqlArgv).not.toContain('query-secret');
    expect(psqlArgv).not.toContain('password=');
    for (const childEnv of [
      readFileSync(psql.envPath, 'utf8'),
      readFileSync(pgRestoreEnvPath, 'utf8'),
    ]) {
      expect(childEnv).toContain(`PGPASSFILE=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`);
      expect(childEnv).toContain('PGSERVICE=|PGSERVICEFILE=|PGSSLKEY=');
      expect(childEnv).not.toContain('ambient-password');
      expect(childEnv).not.toContain('/secret/');
    }
    expect(journalSnapshot).not.toContain('query-secret');
    expect(journalSnapshot).not.toContain('password=');
  });

  it('keeps passwords out of failed child errors, journals, argv, and stable operation ids', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-redacted-error-${Date.now()}`);
    roots.push(root);
    const result = await createPerCompanionTestBackup(root);
    const { stubPath: pgRestoreBinary, argvPath, passwordPath } = writeCredentialRecordingStubPgRestore(root, 17);
    const destinations = {
      companionDataDir: join(root, 'restore', 'companion'),
      personalWorkspacePath: join(root, 'restore', 'workspace'),
    };
    const operationJournalNames: string[] = [];

    for (const secret of ['first+secret', 'second+secret']) {
      let journalSnapshot = '';
      let error: unknown;
      try {
        await restoreFleetCompanionSlice({
          fleetManifestPath: result.fleetManifestPath,
          companionId: COMPANION_A,
          destinations,
          postgres: {
            databaseUrl: `postgresql://restore@127.0.0.1:5432/restore?password=${secret}`,
            pgRestoreBinary,
            psqlBinary: writeTargetStateStubPsql(root),
          },
          faultInjection: (stage) => {
            if (stage !== 'after_journal') return;
            const journalName = readdirSync(join(root, 'restore'))
              .find(name => name.startsWith('.restore-operation-'));
            if (!journalName) throw new Error('Expected restore journal at fault seam');
            operationJournalNames.push(journalName);
            journalSnapshot = readFileSync(join(root, 'restore', journalName), 'utf8');
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('[redacted]');
      expect((error as Error).message).not.toContain(secret);
      expect(readFileSync(argvPath, 'utf8')).not.toContain(secret);
      expect(readFileSync(argvPath, 'utf8')).not.toContain('password=');
      expect(readFileSync(passwordPath, 'utf8')).toBe(secret);
      expect(journalSnapshot).not.toContain(secret);
      expect(journalSnapshot).not.toContain('password=');
      expect(operationJournalNames.at(-1)).not.toContain(secret);
    }

    expect(operationJournalNames).toHaveLength(2);
    expect(operationJournalNames[0]).toBe(operationJournalNames[1]);
  });

  it.each([
    ['after_journal', 0, 0],
    ['after_database_commit', 0, 0],
    ['after_tree_publish', 1, 1],
    ['after_tree_publish', 2, 2],
  ] as const)(
    'recovers a SIGKILL at %s (published tree %i) without a mixed final restore',
    async (faultStage, publishedTreeCount, expectedPublishedDestinations) => {
      const root = join(
        tmpdir(),
        `psfn-fleet-restore-sigkill-${faultStage}-${publishedTreeCount}-${Date.now()}`,
      );
      roots.push(root);
      const result = await createPerCompanionTestBackup(root);
      const { pgRestoreBinary, psqlBinary, statePath } = writeStatefulRestoreStubs(root);
      const destinations = {
        companionDataDir: join(root, 'restore', 'companion'),
        personalWorkspacePath: join(root, 'restore', 'workspace'),
      };
      const worker = fileURLToPath(new URL(
        './test-fixtures/fleet-restore-kill-worker.ts',
        import.meta.url,
      ));
      const child = spawn(process.execPath, [
        '--import',
        'tsx',
        worker,
        result.fleetManifestPath,
        COMPANION_A,
        destinations.companionDataDir,
        destinations.personalWorkspacePath,
        'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary,
        faultStage,
        String(publishedTreeCount),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit, rejectExit) => {
          child.once('error', rejectExit);
          child.once('exit', (code, signal) => resolveExit({ code, signal }));
        },
      );
      expect(outcome).toEqual({ code: null, signal: 'SIGKILL' });
      expect([
        existsSync(destinations.companionDataDir),
        existsSync(destinations.personalWorkspacePath),
      ].filter(Boolean)).toHaveLength(expectedPublishedDestinations);
      expect(existsSync(statePath)).toBe(faultStage !== 'after_journal');
      expect(readdirSync(join(root, 'restore')).some(name => name.startsWith('.restore-operation-')))
        .toBe(true);

      await restoreFleetCompanionSlice({
        fleetManifestPath: result.fleetManifestPath,
        companionId: COMPANION_A,
        destinations,
        postgres: {
          databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
          pgRestoreBinary,
          psqlBinary,
        },
      });

      expect(readFileSync(join(destinations.companionDataDir, 'vault/note.md'), 'utf8'))
        .toContain(COMPANION_A);
      expect(readFileSync(join(destinations.personalWorkspacePath, 'journal/personal.md'), 'utf8'))
        .toContain(COMPANION_A);
      const restoreEntries = readdirSync(join(root, 'restore'));
      expect(restoreEntries.some(name => name.startsWith('.restore-operation-'))).toBe(false);
      expect(restoreEntries.some(name => name.includes('.restore-'))).toBe(false);
    },
  );

  it('restores a group artifact only into explicit whole-fleet destinations', async () => {
    const root = join(tmpdir(), `psfn-fleet-group-restore-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    writeSystemOwnerFiles(systemDataDir);
    const backupRootDir = join(root, 'backups');
    const { stubPath: pgDumpBinary } = writeSchemaLoggingStubPgDump(root);
    const { stubPath: pgRestoreBinary } = writeLoggingStubPgRestore(root);
    const psqlBinary = writeTargetStateStubPsql(root);
    const companions = [
      makeCompanion(root, COMPANION_A, 'companion_alpha'),
      makeCompanion(root, COMPANION_B, 'companion_beta'),
    ];
    const result = await runFleetBackupCycle({
      postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn', pgDumpBinary },
      companions,
      systemDataDir,
      sharedWorkspacePath: makeSharedWorkspace(root),
      backupRootDir,
      groupMode: true,
      groupCompanionDataDir: join(root, 'companion-data'),
      groupWorkspacesRoot: join(root, 'workspaces'),
      now: FIXED_NOW,
    });
    const destinations = {
      groupCompanionDataDir: join(root, 'restore', 'companions'),
      groupWorkspacesRoot: join(root, 'restore', 'workspaces'),
      systemDataDir: join(root, 'restore', 'system'),
    };
    await restoreFleetGroupArtifact({
      fleetManifestPath: result.fleetManifestPath,
      destinations,
      postgres: {
        databaseUrl: 'postgresql://restore:secret@127.0.0.1:5432/restore',
        pgRestoreBinary,
        psqlBinary,
      },
    });
    expect(existsSync(join(destinations.groupCompanionDataDir, COMPANION_A, 'vault/note.md'))).toBe(true);
    expect(existsSync(join(destinations.groupCompanionDataDir, COMPANION_B, 'vault/note.md'))).toBe(true);
    expect(existsSync(join(destinations.groupWorkspacesRoot, 'personal', COMPANION_A, 'journal/personal.md'))).toBe(true);
    expect(existsSync(join(destinations.groupWorkspacesRoot, 'shared', 'artifacts/world.md'))).toBe(true);
    expect(existsSync(join(destinations.systemDataDir, 'settings.json'))).toBe(true);
  });
});
