import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveCompanionAuthToken } from '../../../boundary/gateway/companion-auth.js';
import { PER_COMPANION_OWNER_FILES } from '../../../system/config/settings-contract.js';

const repoRoot = process.cwd();
const runtimeEnvPath = join(repoRoot, 'scripts/system/runtime-env.sh');

const startupOwnerSeeds = [
  ['settings.seed.json', 'settings.json'],
  ['models.seed.json', 'models.json'],
  ['providers.seed.json', 'providers.json'],
  ['trust-policy.seed.json', 'trust-policy.json'],
  ['scheduler.seed.json', 'scheduler.json'],
  ['capability-tier.seed.json', 'capability-tier.json'],
  ['charge-policy.seed.json', 'charge-policy.json'],
  ['backup.seed.json', 'backup.json'],
  ['mcp-servers.seed.json', 'mcp-servers.json'],
  ['skills.seed.json', 'skills.json'],
  ['intake-policy.seed.json', 'intake-policy.json'],
  ['partner-affect-shadow.seed.json', 'partner-affect-shadow.json'],
] as const;

/**
 * Provision a loadable enabled fleet-auth.json from the canonical seed. The
 * distributed seed fails closed under an enabled runtime (placeholder key ids
 * and known-unsafe fixture keys), so swap in fresh, distinct Ed25519 verifier
 * and hub-assertion keys with real key ids.
 */
function writeFleetAuthOwnerFile(systemDataDir: string): void {
  const exportPublicKey = (): string => generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const config = JSON.parse(readFileSync(join(repoRoot, 'config/fleet-auth.seed.json'), 'utf8'));
  config.verifierKeys[0].kid = '2026-07-primary';
  config.verifierKeys[0].publicKeyPem = exportPublicKey();
  config.hubDeviceAssertions.keys[0].kid = 'hub-2026-07';
  config.hubDeviceAssertions.keys[0].publicKeyPem = exportPublicKey();
  writeFileSync(
    join(systemDataDir, 'fleet-auth.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
}

function seedStartupOwnerRoots(systemDataDir: string, companionDataDirs: readonly string[]): void {
  const companionDataDir = companionDataDirs[0];
  if (!companionDataDir) {
    throw new Error('At least one companion owner root is required');
  }
  mkdirSync(systemDataDir, { recursive: true });
  for (const companionDataDir of companionDataDirs) {
    mkdirSync(companionDataDir, { recursive: true });
  }
  for (const [seedFile, ownerFile] of startupOwnerSeeds) {
    const roots = PER_COMPANION_OWNER_FILES.has(ownerFile)
      ? companionDataDirs
      : [systemDataDir];
    for (const root of roots) {
      copyFileSync(join(repoRoot, 'config', seedFile), join(root, ownerFile));
    }
  }
  // The companions.json fleet manifest is mandatory. Seed a one-entry
  // (single-companion) manifest by default; fleet tests overwrite it with a
  // multi-entry manifest after calling this helper.
  const runtimeRoot = dirname(systemDataDir);
  const relativeCompanionDataDir = relative(runtimeRoot, companionDataDir);
  writeFileSync(
    join(systemDataDir, 'companions.json'),
    `${JSON.stringify({
      postgres: {
        sharedMigrationRole: 'shared_schema_migration',
        sharedMigrationDatabaseUrlRef: {
          kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
        },
      },
      companions: [{
        companionId: '11111111-1111-4111-8111-111111111111',
        companionDataDir: relativeCompanionDataDir,
        characterCardPath: join(relativeCompanionDataDir, 'companion.json'),
        postgresSchema: 'public',
        postgresRole: 'companion_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_DATABASE_URL' },
      }],
    }, null, 2)}\n`,
    'utf8',
  );
  writeFleetAuthOwnerFile(systemDataDir);
}

function makeRealPreflightLauncher(): {
  gatewayStartedPath: string;
  run(env: NodeJS.ProcessEnv): { output: string; status: number };
  workDir: string;
} {
  const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-real-preflight-'));
  const scriptsDir = join(workDir, 'scripts');
  const systemScriptsDir = join(scriptsDir, 'system');
  const tsxDir = join(workDir, 'node_modules/.bin');
  const fakeBinDir = join(workDir, 'fake-bin');
  const gatewayStartedPath = join(workDir, 'gateway-started');
  mkdirSync(systemScriptsDir, { recursive: true });
  mkdirSync(tsxDir, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), join(scriptsDir, 'start-gateway-agent.sh'));
  chmodSync(join(scriptsDir, 'start-gateway-agent.sh'), 0o755);
  copyFileSync(runtimeEnvPath, join(systemScriptsDir, 'runtime-env.sh'));
  const realTsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  writeFileSync(join(tsxDir, 'tsx'), [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  scripts/preflight-startup-owner-files.ts)',
    `    exec ${JSON.stringify(process.execPath)} ${JSON.stringify(realTsxCli)} ${JSON.stringify(join(repoRoot, 'scripts/preflight-startup-owner-files.ts'))}`,
    '    ;;',
    '  scripts/resolve-companion-fleet.ts)',
    `    exec ${JSON.stringify(process.execPath)} ${JSON.stringify(realTsxCli)} ${JSON.stringify(join(repoRoot, 'scripts/resolve-companion-fleet.ts'))}`,
    '    ;;',
    '  scripts/provision-companion-fleet.ts) exit 0 ;;',
    '  scripts/resolve-single-companion-auth.ts) printf "v1.agent-proof\\tv1.worker-proof\\n" ;;',
    '  src/app/gateway/main.ts)',
    `    printf "started\\n" > ${JSON.stringify(gatewayStartedPath)}`,
    '    exit 23',
    '    ;;',
    '  *) exit 97 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(fakeBinDir, 'node'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = "-p" ]; then printf "24\\n"; else printf "v24.19.0\\n"; fi',
  ].join('\n'), { mode: 0o755 });

  return {
    gatewayStartedPath,
    workDir,
    run(env) {
      const output = execFileSync('bash', ['-c', [
        'set +e',
        './scripts/start-gateway-agent.sh >launcher.out 2>&1',
        'status=$?',
        'set -e',
        'cat launcher.out',
        'printf "\\nlauncher_status=%s\\n" "$status"',
      ].join('\n')], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          PATH: `${fakeBinDir}:/usr/bin:/bin`,
          HOME: process.env.HOME,
          PSFN_SKIP_DOTENV: 'true',
          XDG_RUNTIME_DIR: join(workDir, 'run'),
          GATEWAY_SOCKET: join(workDir, 'run', 'gateway.sock'),
          CONFIG_DIR: join(repoRoot, 'config'),
          COMPANION_ID: '11111111-1111-4111-8111-111111111111',
          COMPANION_PG_SCHEMA: 'public',
          GATEWAY_SESSION_HMAC_KEY: 'test-session-secret',
          POSTGRES_DATABASE_URL:
            'postgres://companion_runtime:verification@127.0.0.1/verification',
          COMPANION_DATABASE_URL:
            'postgres://companion_runtime:verification@127.0.0.1/verification',
          SHARED_SCHEMA_MIGRATION_DATABASE_URL:
            'postgres://shared_schema_migration:migration@127.0.0.1/verification',
          PSFN_FLEET_AUTH: '1',
          ...env,
        },
      });
      const match = /launcher_status=(\d+)/u.exec(output);
      return { output, status: Number(match?.[1] ?? -1) };
    },
  };
}

describe('start-gateway-agent launcher supervision', () => {
  it('has valid bash syntax', () => {
    execFileSync('bash', ['-n', join(repoRoot, 'scripts/start-gateway-agent.sh')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  });

  it('starts children in dedicated sessions and kills process groups on shutdown', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('setsid "$@" &');
    expect(launcher).toContain('kill -TERM -- "-${pgid}"');
    expect(launcher).toContain('kill -KILL -- "-${pgid}"');
  });

  it('hands the agent database credential through an inherited pipe, not a here-string file', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain(
      'exec {postgres_database_url_fd}< <(printf \'%s\\n\' "${database_url}")',
    );
    expect(launcher).not.toContain('exec {postgres_database_url_fd}<<<');
  });

  it('refuses duplicate launcher starts with a socket-scoped launcher lock', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('LAUNCHER_LOCK_DIR="${socket_dir}/launcher.lock"');
    expect(launcher).toContain('launcher lock held by pid ${existing_pid}; refusing to start another launcher');
    expect(launcher).toContain('release_launcher_lock');
    expect(launcher).toContain('cleanup_children');
    expect(launcher).toContain(
      [
        "trap 'handle_shutdown_signal INT' INT",
        "trap 'handle_shutdown_signal TERM' TERM",
        'trap cleanup EXIT',
        '',
        'acquire_launcher_lock',
        '',
        'provision_companion_fleet',
        '',
        'echo "[${MODE_LABEL}] verifying startup owner files..."',
      ].join('\n'),
    );
    expect(launcher).not.toContain('migrate-scheduler-owner');
    expect(launcher).not.toContain('migrate:scheduler-owner');
    expect(launcher).not.toContain('scripts/verify-startup-owner-files.ts');
    expect(launcher).not.toContain('npm run verify:startup-owner-files');
    expect(launcher).toContain(
      [
        'echo "[${MODE_LABEL}] verifying startup owner files..."',
        'if [ -x "./node_modules/.bin/tsx" ]; then',
        '  ./node_modules/.bin/tsx scripts/preflight-startup-owner-files.ts',
        'else',
        '  npm run preflight:startup-owner-files',
        'fi',
        '',
        'echo "[${MODE_LABEL}] starting gateway..."',
      ].join('\n'),
    );
    const runtimePreflight = readFileSync(
      join(repoRoot, 'scripts/preflight-startup-owner-files.ts'),
      'utf8',
    );
    const gateway = readFileSync(join(repoRoot, 'src/app/gateway/main.ts'), 'utf8');
    // Operator-mode loading resolves the identical system/companion/fleet roots
    // as the gateway while accepting secret-safe database wiring
    // (POSTGRES_DATABASE_URL_FILE/_FD) in agent-derived maintenance pods.
    expect(runtimePreflight).toContain('const config = loadOperatorConfig();');
    expect(gateway).toContain('const config = loadConfig();');
  });

  it('keeps the alpha scheduler migration manual and exact-companion-root only', () => {
    const migration = readFileSync(
      join(repoRoot, 'src/app/maintenance/migrate-scheduler-owner.ts'),
      'utf8',
    );
    expect(migration).toContain(
      "throw new Error('--data-dir is required; pass the exact companion owner-file directory')",
    );
    expect(migration).not.toContain('resolveConfiguredSystemDataDir');
    expect(migration).not.toContain('SYSTEM_DATA_DIR');
    expect(migration).not.toContain('process.env.DATA_DIR');
  });

  it('runs the real runtime preflight against legal no-root defaults used by the gateway', () => {
    const launcher = makeRealPreflightLauncher();
    const systemDataDir = join(launcher.workDir, 'data');
    const companionDataDir = join(launcher.workDir, 'companion');
    seedStartupOwnerRoots(systemDataDir, [companionDataDir]);
    try {
      const result = launcher.run({});
      expect(result.output).toContain(
        `system=./data fleet=1 companionRoots=${companionDataDir}`,
      );
      expect(readFileSync(launcher.gatewayStartedPath, 'utf8')).toBe('started\n');
    } finally {
      rmSync(launcher.workDir, { recursive: true, force: true });
    }
  });

  it('runs the real runtime preflight against the gateway explicit split roots', () => {
    const launcher = makeRealPreflightLauncher();
    const systemDataDir = join(launcher.workDir, 'explicit-system');
    const companionDataDir = join(launcher.workDir, 'explicit-companion');
    seedStartupOwnerRoots(systemDataDir, [companionDataDir]);
    try {
      const result = launcher.run({ SYSTEM_DATA_DIR: systemDataDir, COMPANION_DATA_DIR: companionDataDir });
      expect(result.output).toContain(
        `system=${systemDataDir} fleet=1 companionRoots=${companionDataDir}`,
      );
      expect(readFileSync(launcher.gatewayStartedPath, 'utf8')).toBe('started\n');
    } finally {
      rmSync(launcher.workDir, { recursive: true, force: true });
    }
  });

  it('runs the real runtime preflight across every gateway-resolved fleet root', () => {
    const launcher = makeRealPreflightLauncher();
    const runtimeRoot = join(launcher.workDir, 'runtime');
    const systemDataDir = join(runtimeRoot, 'system-data');
    const companionA = join(runtimeRoot, 'companions/a');
    const companionB = join(runtimeRoot, 'companions/b');
    const companionAId = '11111111-1111-4111-8111-111111111111';
    seedStartupOwnerRoots(systemDataDir, [companionA, companionB]);
    writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify({
      postgres: {
        sharedMigrationRole: 'shared_schema_migration',
        sharedMigrationDatabaseUrlRef: {
          kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
        },
      },
      companions: [
        {
          companionId: companionAId,
          companionDataDir: 'companions/a',
          characterCardPath: 'companions/a/card.json',
          postgresSchema: 'companion_a',
          postgresRole: 'companion_a_runtime',
          postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_A_DATABASE_URL' },
        },
        {
          companionId: '22222222-2222-4222-8222-222222222222',
          companionDataDir: 'companions/b',
          characterCardPath: 'companions/b/card.json',
          postgresSchema: 'companion_b',
          postgresRole: 'companion_b_runtime',
          postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_B_DATABASE_URL' },
        },
      ],
    }, null, 2)}\n`, 'utf8');
    // The consolidated topology requires PSFN_FLEET_AUTH for the one fleet Garden
    // (docs/garden-control-plane.md), so the gateway startup preflight enforces the
    // strict fleet-auth flag/file matrix: with the flag enabled the system-owned
    // fleet-auth.json owner file must be present AND loadable. The distributed
    // seed is deliberately rejected when enabled (placeholder key ids / known
    // unsafe fixture keys), so provision a valid owner file built from the seed
    // with fresh Ed25519 verifier/hub keys and real key ids.
    writeFleetAuthOwnerFile(systemDataDir);
    try {
      const result = launcher.run({
        PSFN_FLEET_AUTH: '1',
        PSFN_RUNTIME_ROOT: runtimeRoot,
        SYSTEM_DATA_DIR: systemDataDir,
        COMPANION_DATA_DIR: companionA,
        COMPANION_ID: companionAId,
        COMPANION_PG_SCHEMA: 'companion_a',
        CHARACTER_CARD_PATH: join(companionA, 'card.json'),
        GATEWAY_SESSION_HMAC_KEY: 'test-session-secret',
        POSTGRES_DATABASE_URL:
          'postgres://companion_a_runtime:a@127.0.0.1/verification',
        COMPANION_A_DATABASE_URL:
          'postgres://companion_a_runtime:a@127.0.0.1/verification',
        COMPANION_B_DATABASE_URL:
          'postgres://companion_b_runtime:b@127.0.0.1/verification',
        SHARED_SCHEMA_MIGRATION_DATABASE_URL:
          'postgres://shared_schema_migration:migration@127.0.0.1/verification',
      });
      expect(result.output).toContain(
        `system=${systemDataDir} fleet=2 companionRoots=${companionA},${companionB}`,
      );
      expect(readFileSync(launcher.gatewayStartedPath, 'utf8')).toBe('started\n');
    } finally {
      rmSync(launcher.workDir, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'malformed'] as const)(
    'refuses launcher startup when the real companion owner is %s despite a system decoy',
    (failureMode) => {
      const launcher = makeRealPreflightLauncher();
      const systemDataDir = join(launcher.workDir, 'explicit-system');
      const companionDataDir = join(launcher.workDir, 'explicit-companion');
      seedStartupOwnerRoots(systemDataDir, [companionDataDir]);
      copyFileSync(
        join(repoRoot, 'config/scheduler.seed.json'),
        join(systemDataDir, 'scheduler.json'),
      );
      if (failureMode === 'missing') {
        rmSync(join(companionDataDir, 'scheduler.json'));
      } else {
        writeFileSync(join(companionDataDir, 'scheduler.json'), '{"tickIntervalMs":"invalid"}\n', 'utf8');
      }
      try {
        const result = launcher.run({ SYSTEM_DATA_DIR: systemDataDir, COMPANION_DATA_DIR: companionDataDir });
        expect(result.status).not.toBe(0);
        expect(result.output).toContain('Runtime startup owner-file preflight failed');
        expect(result.output).toContain(join(companionDataDir, 'scheduler.json'));
        expect(existsSync(launcher.gatewayStartedPath)).toBe(false);
      } finally {
        rmSync(launcher.workDir, { recursive: true, force: true });
      }
    },
  );

  it('prevents a concurrent launcher from mutating fleet workspaces', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-concurrent-'));
    const scriptsDir = join(workDir, 'scripts');
    const systemDir = join(scriptsDir, 'system');
    const tsxDir = join(workDir, 'node_modules/.bin');
    const fakeBinDir = join(workDir, 'fake-bin');
    const runtimeDir = join(workDir, 'runtime');
    const markerPath = join(workDir, 'provision-invocations.txt');
    mkdirSync(systemDir, { recursive: true });
    mkdirSync(tsxDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, 'start-gateway-agent.sh'),
      readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8'),
      { mode: 0o755 },
    );
    writeFileSync(join(systemDir, 'runtime-env.sh'), readFileSync(runtimeEnvPath, 'utf8'));
    const fakeTsx = join(tsxDir, 'tsx');
    writeFileSync(fakeTsx, [
      '#!/usr/bin/env bash',
      'case "$1" in',
      '  scripts/resolve-companion-fleet.ts)',
      `    printf '11111111-1111-4111-8111-111111111111\\t${workDir}/data\\t${workDir}/card.json\\tcompanion_a\\t${workDir}/workspace\\tproof-a\\tproof-b\\t${runtimeDir}/garden.sock\\n'`,
      '    ;;',
      '  scripts/provision-companion-fleet.ts)',
      `    printf 'provisioned\\n' >> '${markerPath}'`,
      '    ;;',
      '  src/app/maintenance/migrate-scheduler-owner.ts) exit 97 ;;',
      '  scripts/preflight-startup-owner-files.ts) exit 0 ;;',
      '  *) sleep 30 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    const fakeNode = join(fakeBinDir, 'node');
    writeFileSync(fakeNode, [
      '#!/usr/bin/env bash',
      'if [ "$1" = "-p" ]; then printf "24\\n"; else printf "v24.19.0\\n"; fi',
    ].join('\n'), { mode: 0o755 });

    try {
      const output = execFileSync('bash', ['-lc', [
        'set -euo pipefail',
        'export PSFN_SKIP_DOTENV=true',
        `export PATH=${JSON.stringify(`${fakeBinDir}:/usr/bin:/bin`)}`,
        `export GATEWAY_SOCKET=${JSON.stringify(join(runtimeDir, 'gateway.sock'))}`,
        './scripts/start-gateway-agent.sh >first.out 2>&1 &',
        'first_pid=$!',
        `for _ in $(seq 1 100); do [ -f ${JSON.stringify(markerPath)} ] && break; sleep 0.05; done`,
        `test -f ${JSON.stringify(markerPath)}`,
        'set +e',
        './scripts/start-gateway-agent.sh >second.out 2>&1',
        'second_status=$?',
        'set -e',
        'kill -TERM "$first_pid"',
        'wait "$first_pid"',
        `printf 'second_status=%s provisions=%s\\n' "$second_status" "$(wc -l < ${JSON.stringify(markerPath)})"`,
        'grep "launcher lock held" second.out',
      ].join('\n')], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(output).toContain('second_status=1 provisions=1');
      expect(output).toContain('launcher lock held');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('normalizes expected SIGTERM shutdown to exit 0 after cleanup', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-sigterm-'));
    const scriptsDir = join(workDir, 'scripts');
    const systemDir = join(scriptsDir, 'system');
    const tsxDir = join(workDir, 'node_modules/.bin');
    const fakeBinDir = join(workDir, 'fake-bin');
    const companionId = '11111111-1111-4111-8111-111111111111';
    const adminSocket = join(workDir, 'runtime', `garden-admin-${companionId}.sock`);
    mkdirSync(systemDir, { recursive: true });
    mkdirSync(tsxDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });

    const launcherPath = join(scriptsDir, 'start-gateway-agent.sh');
    writeFileSync(launcherPath, readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8'), 'utf8');
    chmodSync(launcherPath, 0o755);
    writeFileSync(join(systemDir, 'runtime-env.sh'), readFileSync(runtimeEnvPath, 'utf8'), 'utf8');

    const fakeTsxPath = join(tsxDir, 'tsx');
    writeFileSync(
      fakeTsxPath,
      [
        '#!/usr/bin/env bash',
        'case "$1" in',
        '  src/app/maintenance/migrate-scheduler-owner.ts) exit 97 ;;',
        '  scripts/preflight-startup-owner-files.ts) exit 0 ;;',
        '  scripts/provision-companion-fleet.ts) exit 0 ;;',
        '  scripts/resolve-companion-fleet.ts)',
        `    printf '${companionId}\\t${workDir}/companion\\t${workDir}/companion/card.json\\tpublic\\t${workDir}/workspace\\tproof-a\\tproof-b\\t${adminSocket}\\n'`,
        '    ;;',
        '  *) sleep 30 ;;',
        'esac',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeTsxPath, 0o755);

    const fakeNodePath = join(fakeBinDir, 'node');
    writeFileSync(
      fakeNodePath,
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "-p" ]; then',
        '  printf "24\\n"',
        'else',
        '  printf "v24.19.0\\n"',
        'fi',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeNodePath, 0o755);

    try {
      const output = execFileSync(
        'bash',
        [
          '-lc',
          [
            'set -euo pipefail',
            'export PSFN_SKIP_DOTENV=true',
            'export PSFN_FLEET_AUTH=1',
            `PATH=${JSON.stringify(`${fakeBinDir}:/usr/bin:/bin`)}`,
            `XDG_RUNTIME_DIR=${JSON.stringify(join(workDir, 'runtime'))}`,
            `GATEWAY_SOCKET=${JSON.stringify(join(workDir, 'runtime/gateway.sock'))}`,
            './scripts/start-gateway-agent.sh >launcher.out 2>&1 &',
            'launcher_pid=$!',
            'sleep 0.5',
            'kill -TERM "${launcher_pid}"',
            'set +e',
            'wait "${launcher_pid}"',
            'status=$?',
            'set -e',
            'printf "status=%s\\n" "${status}"',
            'grep -E "starting gateway|starting agent|starting operator" launcher.out || true',
            'test ! -d "$(dirname "${GATEWAY_SOCKET}")/launcher.lock"',
          ].join('\n'),
        ],
        { cwd: workDir, encoding: 'utf8', timeout: 10000 },
      );

      expect(output).toContain('status=0');
      expect(output).toContain('starting gateway');
      expect(output).not.toContain('starting agent');
      expect(output).not.toContain('starting operator');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('keeps the user unit pointed at the launcher instead of npm', () => {
    const unit = readFileSync(join(repoRoot, 'scripts/system/user/purrsephone.service'), 'utf8');
    expect(unit).toContain('ExecStart=/bin/bash %h/psfn-framework/scripts/start-gateway-agent.sh --yolo');
    expect(unit).not.toContain('ExecStart=%h/.nvm/versions/node/v22.21.1/bin/npm run yolo');
  });

  it('keeps user-local tools visible without pinning a host-local Node install', () => {
    const unit = readFileSync(join(repoRoot, 'scripts/system/user/purrsephone.service'), 'utf8');
    expect(unit).toMatch(/^Environment=PATH=%h\/\.local\/bin:/m);
    expect(unit).not.toContain('%h/.nvm/versions/node/');
  });

  it('keeps host-specific runtime paths out of the repo-owned user unit', () => {
    const unit = readFileSync(join(repoRoot, 'scripts/system/user/purrsephone.service'), 'utf8');
    expect(unit).toContain('WorkingDirectory=%h/psfn-framework');
    expect(unit).toContain('Environment=PSFN_DOTENV_FILE=.env');
    expect(unit).not.toContain('/mnt/samesung/ai/psfn-live');
    expect(unit).not.toContain('Environment=DATA_DIR=');
    expect(unit).not.toContain('Environment=DATABASE_PATH=');
    expect(unit).not.toContain('Environment=WORKSPACE_PATH=');
    expect(unit).not.toContain('Environment=CHARACTER_CARD_PATH=');
    expect(unit).not.toContain('purrsephone.db');
    expect(unit).not.toContain('purrsephone.json');
  });

  it('does not ambiently opt the agent into outbound network access', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).not.toContain('export ALLOW_AGENT_OUTBOUND_NETWORK=true');
    expect(launcher).not.toMatch(/ALLOW_AGENT_OUTBOUND_NETWORK[^\\n]+:-[^\\n]*true/);
  });

  it('still sources dotenv before launch so operators can explicitly opt in there', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('psfn_source_dotenv_preserving_existing_env "${RESOLVED_DOTENV_FILE}"');
    expect(launcher).toContain('source "${ROOT_DIR}/scripts/system/runtime-env.sh"');
  });

  it('scrubs legacy admin credentials from fleet-auth gateway and operator processes', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('env -u ADMIN_TOKEN -u ADMIN_ALLOW_INSECURE');
    expect(launcher).toContain('ADMIN_ALLOW_INSECURE|ADMIN_TOKEN)');
  });

  it('keeps proxy trust and the raw loopback status listener gateway-owned', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    const agentAllowlist = launcher.slice(
      launcher.indexOf('build_agent_env()'),
      launcher.indexOf('# Operator processes receive only'),
    );
    const operatorAllowlist = launcher.slice(
      launcher.indexOf('build_operator_env()'),
      launcher.indexOf('launch_background()'),
    );
    for (const childAllowlist of [agentAllowlist, operatorAllowlist]) {
      expect(childAllowlist).not.toMatch(/\n\s*FLEET_SSO_TRUST_PROXY\s*\\/u);
      expect(childAllowlist).not.toMatch(/\n\s*FLEET_STATUS_(?:HOST|PORT)\s*\\/u);
    }
    expect(agentAllowlist).not.toMatch(/\n\s*ADMIN_(?:ALLOW_INSECURE|TOKEN)\s*\\/u);
  });

  it('launches the agent with a non-secret environment allowlist', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    const agentAllowlist = launcher.slice(
      launcher.indexOf('build_agent_env()'),
      launcher.indexOf('# Operator processes receive only'),
    );
    expect(launcher).toContain('launch_background env -i "${AGENT_ENV[@]}" ./node_modules/.bin/tsx src/app/agent/main.ts');
    expect(agentAllowlist).toContain('GATEWAY_SOCKET');
    expect(agentAllowlist).toContain('SYSTEM_DATA_DIR');
    expect(agentAllowlist).toContain('COMPANION_DATA_DIR');
    expect(agentAllowlist).toContain('PSFN_FLEET_AUTH \\');
    expect(agentAllowlist).toContain('VAULT_TOOLS_ENABLED \\');
    expect(agentAllowlist).not.toMatch(/\n\s*API_KEY\s*\\/);
    expect(agentAllowlist).not.toMatch(/\n\s*ADMIN_TOKEN\s*\\/);
    expect(agentAllowlist).not.toMatch(/\n\s*OPENROUTER_API_KEY\s*\\/);
    expect(agentAllowlist).not.toMatch(/\n\s*LITELLM_API_KEY\s*\\/);
    expect(agentAllowlist).not.toMatch(/\n\s*FAL_API_KEY\s*\\/);
    expect(agentAllowlist).not.toMatch(/\n\s*POSTGRES_DATABASE_URL\s*\\/);
    expect(agentAllowlist).toMatch(/\n\s*POSTGRES_DATABASE_URL_FD\s*\\/);
  });

  it('scrubs root secrets while handing scoped dependencies to the local agent', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-postgres-credential-'));
    const scriptsDir = join(workDir, 'scripts');
    const systemDir = join(scriptsDir, 'system');
    const tsxDir = join(workDir, 'node_modules/.bin');
    const fakeBinDir = join(workDir, 'fake-bin');
    const auditProbePath = join(workDir, 'audit-keyring-probe.ts');
    const companionId = '11111111-1111-4111-8111-111111111111';
    const adminSocket = join(workDir, 'runtime', `garden-admin-${companionId}.sock`);
    mkdirSync(systemDir, { recursive: true });
    mkdirSync(tsxDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });

    const launcherPath = join(scriptsDir, 'start-gateway-agent.sh');
    writeFileSync(launcherPath, readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8'), 'utf8');
    chmodSync(launcherPath, 0o755);
    writeFileSync(join(systemDir, 'runtime-env.sh'), readFileSync(runtimeEnvPath, 'utf8'), 'utf8');
    writeFileSync(
      auditProbePath,
      [
        "import { writeFileSync } from 'node:fs';",
        `import { requireAuditOpaqueIdKeyring } from ${JSON.stringify(join(
          repoRoot,
          'src/operator/garden/audit-opaque-id-keyring.ts',
        ))};`,
        "writeFileSync('agent.audit-keyring', JSON.stringify(requireAuditOpaqueIdKeyring(process.env.GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN)));",
      ].join('\n'),
      'utf8',
    );

    const fakeTsxPath = join(tsxDir, 'tsx');
    writeFileSync(
      fakeTsxPath,
      [
        '#!/usr/bin/env bash',
        'case "$1" in',
        '  src/app/maintenance/migrate-scheduler-owner.ts) exit 97 ;;',
        '  scripts/preflight-startup-owner-files.ts) exit 0 ;;',
        '  scripts/provision-companion-fleet.ts) exit 0 ;;',
        '  scripts/resolve-companion-fleet.ts)',
        `    printf '${companionId}\\t${workDir}/companion\\t${workDir}/companion/card.json\\tpublic\\t${workDir}/workspace\\tv1.${'a'.repeat(64)}\\tv1.${'b'.repeat(64)}\\tpostgresql://psfn:split-secret@postgres/psfn\\t${adminSocket}\\n'`,
        '    ;;',
        '  src/app/gateway/main.ts)',
        '    python3 - "$GATEWAY_SOCKET" <<\'PY\'',
        'import os, socket, sys, time',
        'path = sys.argv[1]',
        'os.makedirs(os.path.dirname(path), exist_ok=True)',
        'server = socket.socket(socket.AF_UNIX)',
        'server.bind(path)',
        'server.listen(1)',
        'time.sleep(30)',
        'PY',
        '    ;;',
        '  src/app/agent/main.ts)',
        '    env | sort > agent.env',
        '    if [ -p "/proc/self/fd/${POSTGRES_DATABASE_URL_FD:-999}" ]; then printf "pipe\\n" > agent.credential-kind; fi',
        '    cat "/proc/self/fd/${POSTGRES_DATABASE_URL_FD:-999}" > agent.database-url 2>/dev/null || true',
        `    ${JSON.stringify(process.execPath)} ${JSON.stringify(join(
          repoRoot,
          'node_modules/tsx/dist/cli.mjs',
        ))} ${JSON.stringify(auditProbePath)}`,
        '    kill -TERM "$PPID"',
        '    sleep 2',
        '    ;;',
        '  *) sleep 30 ;;',
        'esac',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeTsxPath, 0o755);

    const fakeNodePath = join(fakeBinDir, 'node');
    writeFileSync(
      fakeNodePath,
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "-p" ]; then',
        '  printf "24\\n"',
        'else',
        '  printf "v24.19.0\\n"',
        'fi',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeNodePath, 0o755);

    try {
      const output = execFileSync(
        'bash',
        [
          '-lc',
          [
            'set -euo pipefail',
            'export PSFN_SKIP_DOTENV=true',
            'export PSFN_FLEET_AUTH=1',
            `export PATH=${JSON.stringify(`${fakeBinDir}:/usr/bin:/bin`)}`,
            `export XDG_RUNTIME_DIR=${JSON.stringify(join(workDir, 'runtime'))}`,
            `export GATEWAY_SOCKET=${JSON.stringify(join(workDir, 'runtime/gateway.sock'))}`,
            'export POSTGRES_DATABASE_URL=postgresql://psfn:split-secret@postgres/psfn',
            'export GATEWAY_SESSION_HMAC_KEY=gateway-root-sentinel',
            'set +e',
            './scripts/start-gateway-agent.sh >launcher.out 2>&1',
            'status=$?',
            'set -e',
            'printf "status=%s\\n" "$status"',
          ].join('\n'),
        ],
        { cwd: workDir, encoding: 'utf8', timeout: 15000 },
      );

      expect(output).toContain('status=0');
      const agentEnv = readFileSync(join(workDir, 'agent.env'), 'utf8');
      expect(agentEnv).not.toContain('POSTGRES_DATABASE_URL=');
      expect(agentEnv).not.toContain('split-secret');
      expect(agentEnv).toMatch(/^POSTGRES_DATABASE_URL_FD=[0-9]+$/m);
      expect(agentEnv).toContain(`GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN=v1.${'b'.repeat(64)}`);
      expect(agentEnv).not.toContain('GATEWAY_SESSION_HMAC_KEY=');
      expect(agentEnv).not.toContain('gateway-root-sentinel');
      expect(
        existsSync(join(workDir, 'agent.audit-keyring')),
        readFileSync(join(workDir, 'launcher.out'), 'utf8'),
      ).toBe(true);
      expect(JSON.parse(readFileSync(join(workDir, 'agent.audit-keyring'), 'utf8'))).toEqual({
        activeVersion: 'v1',
        keys: {
          v1: 'IHuMF5zXad9vrTAYLNI8o5El4ghNG4GVXjUL7wbhOfE',
        },
      });
      expect(readFileSync(join(workDir, 'agent.database-url'), 'utf8').trim())
        .toBe('postgresql://psfn:split-secret@postgres/psfn');
      expect(readFileSync(join(workDir, 'agent.credential-kind'), 'utf8').trim()).toBe('pipe');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('does not inject npm run split as an unsafe lifecycle restart command', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).not.toContain('export LIFECYCLE_RESTART_COMMAND="npm run');
  });

  it('does not load repo dotenv secrets into an operator config process', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-operator-secret-probe-'));
    writeFileSync(join(workDir, '.env'), [
      'OPENROUTER_API_KEY=sentinel-openrouter',
      'DISCORD_TOKEN=sentinel-discord',
      'POSTGRES_DATABASE_URL=postgres://sentinel@localhost/db',
    ].join('\n'), 'utf8');
    // loadOperatorConfig requires the mandatory companions.json manifest at the
    // resolved systemDataDir (default './data' relative to cwd).
    mkdirSync(join(workDir, 'data'), { recursive: true });
    writeFileSync(join(workDir, 'data', 'companions.json'), `${JSON.stringify({
      postgres: {
        sharedMigrationRole: 'shared_schema_migration',
        sharedMigrationDatabaseUrlRef: {
          kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
        },
      },
      companions: [{
        companionId: '22222222-2222-4222-8222-222222222222',
        companionDataDir: 'companion',
        characterCardPath: 'companion/companion.json',
        postgresSchema: 'public',
        postgresRole: 'companion_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_DATABASE_URL' },
      }],
    })}\n`, 'utf8');
    const loaderPath = join(repoRoot, 'src/system/config/load-config.ts');
    try {
      const output = execFileSync(join(repoRoot, 'node_modules/.bin/tsx'), [
        '--eval',
        [
          `import(${JSON.stringify(loaderPath)}).then(({ loadOperatorConfig }) => {`,
          '  const config = loadOperatorConfig();',
          '  console.log(JSON.stringify({',
          '    processOpenrouter: process.env.OPENROUTER_API_KEY,',
          '    processDiscord: process.env.DISCORD_TOKEN,',
          '    processPostgres: process.env.POSTGRES_DATABASE_URL,',
          '    configOpenrouter: config.openRouterApiKey,',
          '    configDiscord: config.discordToken,',
          '    configPostgres: config.postgresDatabaseUrl,',
          '  }));',
          '});',
        ].join('\n'),
      ], {
        cwd: workDir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          COMPANION_ID: '22222222-2222-4222-8222-222222222222',
        },
      });

      expect(JSON.parse(output.trim())).toEqual({});
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('checks Node.js before running TypeScript entrypoints', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('psfn_require_node_major 24');
    expect(launcher.indexOf('psfn_require_node_major 24')).toBeLessThan(
      launcher.indexOf('scripts/preflight-startup-owner-files.ts'),
    );
  });

  it('delegates gateway socket selection to the runtime-env guard', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('psfn_resolve_gateway_socket_path "${DEFAULT_SOCKET_PATH}" "${FALLBACK_SOCKET_PATH}"');
    expect(launcher).not.toContain('if mkdir -p "${default_dir}"');
  });

  it('checks the production launcher environment before injecting local defaults', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('psfn_require_production_launcher_env');
    expect(launcher.indexOf('psfn_require_production_launcher_env')).toBeLessThan(
      launcher.indexOf('# Local-dev defaults so split/yolo mode is one-command.'),
    );
  });

  it('refuses to start the agent without a gateway socket in production', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('if psfn_is_production_runtime; then');
    expect(launcher).toContain('gateway socket not detected; refusing to start agent in production');
    expect(launcher.indexOf('gateway socket not detected; refusing to start agent in production')).toBeLessThan(
      launcher.indexOf('warning: gateway socket not detected yet, starting agent anyway'),
    );
  });
});

describe('start-gateway-agent multi-companion supervisor', () => {
  const tsxBin = join(repoRoot, 'node_modules/.bin/tsx');

  function makeFleetWorkspace(companionsJson: string | undefined): {
    workDir: string;
    systemDataDir: string;
    companionDataDir: string;
  } {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-supervisor-'));
    const systemDataDir = join(workDir, 'system-data');
    const companionDataDir = join(workDir, 'companion-data');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    if (companionsJson !== undefined) {
      writeFileSync(join(systemDataDir, 'companions.json'), companionsJson, 'utf8');
    }
    return { workDir, systemDataDir, companionDataDir };
  }

  const twoCompanionFleet = JSON.stringify({
    postgres: {
      sharedMigrationRole: 'shared_schema_migration',
      sharedMigrationDatabaseUrlRef: {
        kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
      },
    },
    companions: [
      {
        companionId: '11111111-1111-4111-8111-111111111111',
        companionDataDir: 'alpha',
        characterCardPath: 'alpha/card.json',
        postgresSchema: 'companion_alpha',
        postgresRole: 'companion_alpha_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_ALPHA_DATABASE_URL' },
      },
      {
        companionId: '22222222-2222-4222-8222-222222222222',
        companionDataDir: 'beta',
        characterCardPath: 'beta/card.json',
        postgresSchema: 'companion_beta',
        postgresRole: 'companion_beta_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_BETA_DATABASE_URL' },
      },
    ],
  });

  const oneCompanionFleet = JSON.stringify({
    postgres: {
      sharedMigrationRole: 'shared_schema_migration',
      sharedMigrationDatabaseUrlRef: {
        kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
      },
    },
    companions: [
      {
        companionId: '11111111-1111-4111-8111-111111111111',
        companionDataDir: 'alpha',
        characterCardPath: 'alpha/card.json',
        postgresSchema: 'public',
        postgresRole: 'companion_alpha_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_ALPHA_DATABASE_URL' },
      },
    ],
  });

  const topologyDatabaseEnv = {
    POSTGRES_DATABASE_URL:
      'postgres://companion_alpha_runtime:alpha@db.example.test/psfn',
    COMPANION_ALPHA_DATABASE_URL:
      'postgres://companion_alpha_runtime:alpha@db.example.test/psfn',
    COMPANION_BETA_DATABASE_URL:
      'postgres://companion_beta_runtime:beta@db.example.test/psfn',
    SHARED_SCHEMA_MIGRATION_DATABASE_URL:
      'postgres://shared_schema_migration:migration@db.example.test/psfn',
  };

  it('uses the fleet supervisor process topology for every roster size', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('resolve_companion_fleet');
    expect(launcher).toContain('start_companion_agents');
    expect(launcher).toContain('start_fleet_garden');
    expect(launcher).not.toContain('resolve_single_companion_auth');
    expect(launcher).not.toContain('start_agent()');
  });

  it('delegates all fleet validation to the canonical TS helper', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('./node_modules/.bin/tsx scripts/resolve-companion-fleet.ts');
    expect(launcher).toContain('npm run --silent resolve:companion-fleet');
    expect(launcher).toContain('failed to resolve companion fleet from companions.json; refusing to start');
  });

  it('keeps fleet resolution and dry-run mutation-free, then provisions only under the launcher lock', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    const dryRunExit = launcher.indexOf('if [ "${DRY_RUN_MODE}" -eq 1 ]; then');
    const lock = launcher.lastIndexOf('\nacquire_launcher_lock\n');
    const provision = launcher.lastIndexOf('\nprovision_companion_fleet\n');
    expect(dryRunExit).toBeGreaterThan(0);
    expect(dryRunExit).toBeLessThan(lock);
    expect(lock).toBeLessThan(provision);
    expect(launcher).toContain('./node_modules/.bin/tsx scripts/provision-companion-fleet.ts');
  });

  it('passes the companion-scoped env through the scrubbed allowlist', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('COMPANION_PG_SCHEMA \\');
    expect(launcher).toContain('GATEWAY_COMPANION_AUTH_TOKEN \\');
    expect(launcher).toContain('GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN \\');
    // The retired PSFN_MULTI_COMPANION flag must not appear in any allowlist.
    expect(launcher).not.toContain('PSFN_MULTI_COMPANION');
    expect(launcher).toContain('export COMPANION_ID="${companion_id}"');
    expect(launcher).toContain('export COMPANION_DATA_DIR="${companion_data_dir}"');
    expect(launcher).toContain('export CHARACTER_CARD_PATH="${character_card_path}"');
    expect(launcher).toContain('export COMPANION_PG_SCHEMA="${postgres_schema}"');
  });

  it('supervises the fleet with shared-fate shutdown and no silent restart', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain(
      'wait -n "${GATEWAY_PID}" "${AGENT_PIDS[@]}" "${OPERATOR_PID}"',
    );
    expect(launcher).toContain('shutting down the whole fleet (shared-fate)');
    // The supervisor path must tear down the whole set, not re-exec/auto-restart.
    expect(launcher).toContain('cleanup_children');
  });

  it('starts exactly one scrubbed fleet Garden after every agent admin transport is ready', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain(
      'launch_background env -i "${OPERATOR_ENV[@]}" ./node_modules/.bin/tsx src/app/operator/main.ts',
    );
    expect(launcher).toContain('build_operator_env');
    expect(launcher).toContain('start_fleet_operator');
    expect(launcher).not.toContain('start_companion_operator');
    expect(launcher).toContain('export ADMIN_TRANSPORT_SOCKET="${admin_transport_socket}"');
    expect(launcher).toContain('export ADMIN_PORT="${LAUNCHER_ADMIN_PORT}"');
    expect(launcher).toContain(
      'unset COMPANION_ID CHARACTER_CARD_PATH COMPANION_PG_SCHEMA WORKSPACE_PATH',
    );
    expect(launcher).toContain('start_fleet_operator\n');
    expect(launcher.indexOf('\nprepare_fleet_admin_transports\n')).toBeLessThan(
      launcher.indexOf('\nstart_companion_agents\n'),
    );
    expect(launcher.indexOf('\nstart_companion_agents\n')).toBeLessThan(
      launcher.indexOf('\nwait_for_fleet_admin_transports\n'),
    );
    expect(launcher.indexOf('\nwait_for_fleet_admin_transports\n')).toBeLessThan(
      launcher.indexOf('\nprobe_fleet_admin_transports\n'),
    );
    expect(launcher.indexOf('\nprobe_fleet_admin_transports\n')).toBeLessThan(
      launcher.indexOf('\nstart_fleet_garden\n'),
    );
    // The operator allowlist may carry its own admin auth material but never
    // upstream provider secrets.
    const operatorAllowlist = launcher.slice(
      launcher.indexOf('build_operator_env()'),
      launcher.indexOf('launch_background()'),
    );
    expect(operatorAllowlist).toContain('ADMIN_TOKEN \\');
    expect(operatorAllowlist).toContain('PSFN_FLEET_AUTH \\');
    expect(operatorAllowlist).toContain('POSTGRES_DATABASE_URL \\');
    expect(launcher).toContain(
      'if [ "${name}" = "POSTGRES_DATABASE_URL" ] \\\n'
      + '    && [ "${SUPERVISOR_MODE}" -ne 1 ]; then',
    );
    for (const secret of [
      'OPENROUTER_API_KEY',
      'LITELLM_API_KEY',
      'FAL_API_KEY',
      'DISCORD_TOKEN',
      'TELEGRAM_BOT_TOKEN',
      'GATEWAY_COMPANION_AUTH_TOKEN',
      'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN',
      'GATEWAY_SESSION_HMAC_KEY',
    ]) {
      expect(operatorAllowlist).not.toContain(secret);
    }
    expect(launcher).toContain(
      'launch_background env -i "${OPERATOR_ENV[@]}" ./node_modules/.bin/tsx src/app/operator/main.ts',
    );
    expect(launcher).not.toMatch(/start_fleet_operator "\$\{companion_id\}"/gu);
    expect(launcher).toContain('refusing to replace non-socket admin transport path');
    expect(launcher).toContain('agent admin transport missing for ${companion_id}');
    expect(launcher).toContain('gateway exited before fleet admin transports became ready');
    expect(launcher).toContain('gateway exited before the fleet Garden could start');
  });

  it('keeps the operator entrypoint independent of the repo dotenv and gateway loader', () => {
    const entrypoint = readFileSync(join(repoRoot, 'src/app/operator/main.ts'), 'utf8');
    expect(entrypoint).not.toContain('load-dotenv');
    expect(entrypoint).not.toMatch(/\bloadConfig\b/u);
    expect(entrypoint).toContain('loadOperatorConfig');
  });

  it('emits a tab-delimited spawn plan from the canonical fleet validator', () => {
    const { workDir, systemDataDir, companionDataDir } = makeFleetWorkspace(twoCompanionFleet);
    try {
      const output = execFileSync(tsxBin, ['scripts/resolve-companion-fleet.ts'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PSFN_FLEET_AUTH: '1',
          PSFN_RUNTIME_ROOT: workDir,
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
          GATEWAY_SESSION_HMAC_KEY: 'test-session-secret',
          ADMIN_TRANSPORT_SOCKET: join(workDir, 'run', 'garden-admin.sock'),
          ...topologyDatabaseEnv,
        },
      });
      const socketDir = join(workDir, 'run');
      const keyring = { activeVersion: 'v1', keys: { v1: 'test-session-secret' } };
      expect(output).toBe(
        [
          `11111111-1111-4111-8111-111111111111\t${workDir}/alpha\t${workDir}/alpha/card.json\tcompanion_alpha`
          + `\t${workDir}/workspaces/personal/11111111-1111-4111-8111-111111111111`
          + `\t${deriveCompanionAuthToken('11111111-1111-4111-8111-111111111111', 'agent', keyring)}`
          + `\t${deriveCompanionAuthToken('11111111-1111-4111-8111-111111111111', 'internal_session_integrity', keyring)}`
          + `\t${topologyDatabaseEnv.COMPANION_ALPHA_DATABASE_URL}`
          + `\t${socketDir}/garden-admin-11111111-1111-4111-8111-111111111111.sock`,
          `22222222-2222-4222-8222-222222222222\t${workDir}/beta\t${workDir}/beta/card.json\tcompanion_beta`
          + `\t${workDir}/workspaces/personal/22222222-2222-4222-8222-222222222222`
          + `\t${deriveCompanionAuthToken('22222222-2222-4222-8222-222222222222', 'agent', keyring)}`
          + `\t${deriveCompanionAuthToken('22222222-2222-4222-8222-222222222222', 'internal_session_integrity', keyring)}`
          + `\t${topologyDatabaseEnv.COMPANION_BETA_DATABASE_URL}`
          + `\t${socketDir}/garden-admin-22222222-2222-4222-8222-222222222222.sock`,
          '',
        ].join('\n'),
      );
      expect(existsSync(join(workDir, 'workspaces'))).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('delivers the validated distinct database credential to each production-shaped agent spawn', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-supervisor-database-fanout-'));
    const scriptsDir = join(workDir, 'scripts');
    const systemDir = join(scriptsDir, 'system');
    const tsxDir = join(workDir, 'node_modules/.bin');
    const fakeBinDir = join(workDir, 'fake-bin');
    const runtimeDir = join(workDir, 'runtime');
    mkdirSync(systemDir, { recursive: true });
    mkdirSync(tsxDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, 'start-gateway-agent.sh'),
      readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8'),
      'utf8',
    );
    chmodSync(join(scriptsDir, 'start-gateway-agent.sh'), 0o755);
    writeFileSync(join(systemDir, 'runtime-env.sh'), readFileSync(runtimeEnvPath, 'utf8'), 'utf8');
    const alphaId = '11111111-1111-4111-8111-111111111111';
    const betaId = '22222222-2222-4222-8222-222222222222';
    const alphaUrl = 'postgres://companion_alpha_runtime:alpha@postgres/psfn';
    const betaUrl = 'postgres://companion_beta_runtime:beta@postgres/psfn';
    writeFileSync(join(tsxDir, 'tsx'), [
      '#!/usr/bin/env bash',
      'case "$1" in',
      '  scripts/resolve-companion-fleet.ts)',
      `    printf '${alphaId}\\t${workDir}/alpha\\t${workDir}/alpha/card.json\\tcompanion_alpha\\t${workDir}/workspaces/alpha\\tv1.${'a'.repeat(64)}\\tv1.${'b'.repeat(64)}\\t${alphaUrl}\\t${runtimeDir}/alpha.sock\\n'`,
      `    printf '${betaId}\\t${workDir}/beta\\t${workDir}/beta/card.json\\tcompanion_beta\\t${workDir}/workspaces/beta\\tv1.${'c'.repeat(64)}\\tv1.${'d'.repeat(64)}\\t${betaUrl}\\t${runtimeDir}/beta.sock\\n'`,
      '    ;;',
      '  scripts/provision-companion-fleet.ts|scripts/preflight-startup-owner-files.ts) exit 0 ;;',
      '  src/app/gateway/main.ts)',
      '    python3 - "$GATEWAY_SOCKET" <<\'PY\'',
      'import os, socket, sys, time',
      'path = sys.argv[1]',
      'os.makedirs(os.path.dirname(path), exist_ok=True)',
      'server = socket.socket(socket.AF_UNIX)',
      'server.bind(path)',
      'server.listen(1)',
      'time.sleep(30)',
      'PY',
      '    ;;',
      '  src/app/agent/main.ts)',
      '    cat "/proc/self/fd/${POSTGRES_DATABASE_URL_FD}" > "agent-${COMPANION_ID}.database-url"',
      '    env | sort > "agent-${COMPANION_ID}.env"',
      `    for _ in $(seq 1 100); do [ -f 'agent-${alphaId}.database-url' ] && [ -f 'agent-${betaId}.database-url' ] && kill -TERM "$PPID" && exit 0; sleep 0.05; done`,
      '    exit 1',
      '    ;;',
      '  *) sleep 30 ;;',
      'esac',
    ].join('\n'), 'utf8');
    chmodSync(join(tsxDir, 'tsx'), 0o755);
    writeFileSync(join(fakeBinDir, 'node'), [
      '#!/usr/bin/env bash',
      'if [ "$1" = "-p" ]; then printf "24\\n"; else printf "v24.19.0\\n"; fi',
    ].join('\n'), 'utf8');
    chmodSync(join(fakeBinDir, 'node'), 0o755);
    try {
      const output = execFileSync('bash', ['-lc', [
        'set -euo pipefail',
        'export PSFN_SKIP_DOTENV=true',
        'export PSFN_MULTI_COMPANION=1',
        `export PATH=${JSON.stringify(`${fakeBinDir}:/usr/bin:/bin`)}`,
        `export GATEWAY_SOCKET=${JSON.stringify(join(runtimeDir, 'gateway.sock'))}`,
        `export ADMIN_TRANSPORT_SOCKET=${JSON.stringify(join(runtimeDir, 'garden-admin.sock'))}`,
        `export POSTGRES_DATABASE_URL=${JSON.stringify(alphaUrl)}`,
        'export GATEWAY_SESSION_HMAC_KEY=gateway-root-sentinel',
        'set +e',
        './scripts/start-gateway-agent.sh >launcher.out 2>&1',
        'status=$?',
        'set -e',
        'printf "status=%s\\n" "$status"',
      ].join('\n')], { cwd: workDir, encoding: 'utf8', timeout: 15000 });
      expect(output).toContain('status=0');
      expect(readFileSync(join(workDir, `agent-${alphaId}.database-url`), 'utf8').trim())
        .toBe(alphaUrl);
      expect(readFileSync(join(workDir, `agent-${betaId}.database-url`), 'utf8').trim())
        .toBe(betaUrl);
      expect(readFileSync(join(workDir, `agent-${alphaId}.env`), 'utf8'))
        .not.toContain(betaUrl);
      expect(readFileSync(join(workDir, `agent-${betaId}.env`), 'utf8'))
        .not.toContain(alphaUrl);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('derives role-bound credentials for the single-companion launcher', () => {
    const keyring = { activeVersion: 'v1', keys: { v1: 'test-session-secret' } };
    const companionId = 'single-companion';
    const output = execFileSync(tsxBin, ['scripts/resolve-single-companion-auth.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        COMPANION_ID: companionId,
        GATEWAY_SESSION_HMAC_KEY: 'test-session-secret',
      },
    });

    expect(output).toBe(
      `${deriveCompanionAuthToken(companionId, 'agent', keyring)}\t`
      + `${deriveCompanionAuthToken(companionId, 'internal_session_integrity', keyring)}\n`,
    );
  });

  it('fails closed when multi-companion is combined with network admin transport', () => {
    const { workDir, systemDataDir, companionDataDir } = makeFleetWorkspace(twoCompanionFleet);
    let error: unknown;
    try {
      execFileSync(tsxBin, ['scripts/resolve-companion-fleet.ts'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PSFN_FLEET_AUTH: '1',
          PSFN_RUNTIME_ROOT: workDir,
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
          ADMIN_TRANSPORT_MODE: 'network',
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
    expect(error).toBeDefined();
    expect(String((error as { stderr?: Buffer }).stderr)).toContain(
      'Local startup requires ADMIN_TRANSPORT_MODE=socket',
    );
  });

  it('prints one supervisor record for a one-entry fleet', () => {
    const { workDir, systemDataDir, companionDataDir } = makeFleetWorkspace(oneCompanionFleet);
    try {
      const output = execFileSync(tsxBin, ['scripts/resolve-companion-fleet.ts'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PSFN_FLEET_AUTH: '1',
          PSFN_RUNTIME_ROOT: workDir,
          GATEWAY_SESSION_HMAC_KEY: 'test-session-secret',
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
          ADMIN_TRANSPORT_SOCKET: join(workDir, 'run', 'garden-admin.sock'),
          ...topologyDatabaseEnv,
        },
      });
      const keyring = { activeVersion: 'v1', keys: { v1: 'test-session-secret' } };
      expect(output).toBe(
        `11111111-1111-4111-8111-111111111111\t${workDir}/alpha\t`
        + `${workDir}/alpha/card.json\tpublic\t`
        + `${workDir}/workspaces/personal/11111111-1111-4111-8111-111111111111\t`
        + `${deriveCompanionAuthToken('11111111-1111-4111-8111-111111111111', 'agent', keyring)}\t`
        + `${deriveCompanionAuthToken('11111111-1111-4111-8111-111111111111', 'internal_session_integrity', keyring)}\t`
        + `${topologyDatabaseEnv.COMPANION_ALPHA_DATABASE_URL}\t`
        + `${workDir}/run/garden-admin-11111111-1111-4111-8111-111111111111.sock\n`,
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('fails closed when companions.json is missing (manifest is mandatory)', () => {
    const { workDir, systemDataDir, companionDataDir } = makeFleetWorkspace(undefined);
    let error: unknown;
    try {
      execFileSync(tsxBin, ['scripts/resolve-companion-fleet.ts'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PSFN_FLEET_AUTH: '1',
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
    expect(error).toBeDefined();
    expect(String((error as { stderr?: Buffer }).stderr)).toContain(
      'fleet manifest is required but missing',
    );
  });

  it('prints the supervisor spawn plan on --dry-run without starting anything', () => {
    const { workDir, systemDataDir, companionDataDir } = makeFleetWorkspace(twoCompanionFleet);
    try {
      const output = execFileSync('bash', ['scripts/start-gateway-agent.sh', '--dry-run'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PSFN_SKIP_DOTENV: 'true',
          PSFN_FLEET_AUTH: '1',
          PSFN_RUNTIME_ROOT: workDir,
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
          GATEWAY_SESSION_HMAC_KEY: 'test-session-secret',
          XDG_RUNTIME_DIR: join(workDir, 'run'),
          ...topologyDatabaseEnv,
        },
        timeout: 30000,
      });
      expect(output).toContain('dry-run spawn plan (2 companion(s))');
      expect(output).toContain('companionId=11111111-1111-4111-8111-111111111111 schema=companion_alpha');
      expect(output).toContain('companionId=22222222-2222-4222-8222-222222222222 schema=companion_beta');
      expect(output).toContain(
        'Garden: one fleet operator port=10054 targets=2',
      );
      expect(output).toContain('garden-admin-11111111-1111-4111-8111-111111111111.sock');
      expect(output.match(/Garden: one fleet operator/gu)).toHaveLength(1);
      expect(output).not.toContain('gardenPort');
      expect(output).not.toContain('starting gateway');
      expect(output).not.toContain('starting agent');
      expect(output).not.toContain('starting operator');
      expect(output).not.toContain('test-session-secret');
      expect(output).not.toContain('companion_alpha_runtime');
      expect(output).not.toMatch(/v1\.[a-f0-9]{64}/u);
      expect(existsSync(join(workDir, 'workspaces'))).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('runtime starts N agents, waits for every admin socket, then starts exactly one fleet Garden', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-fleet-runtime-'));
    const scriptsDir = join(workDir, 'scripts');
    const systemDir = join(scriptsDir, 'system');
    const tsxDir = join(workDir, 'node_modules/.bin');
    const fakeBinDir = join(workDir, 'fake-bin');
    const runtimeDir = join(workDir, 'run');
    const eventsPath = join(workDir, 'events.log');
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    const socketA = join(runtimeDir, `garden-admin-${companionA}.sock`);
    const socketB = join(runtimeDir, `garden-admin-${companionB}.sock`);
    mkdirSync(systemDir, { recursive: true });
    mkdirSync(tsxDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, 'start-gateway-agent.sh'),
      readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8'),
      { mode: 0o755 },
    );
    writeFileSync(join(systemDir, 'runtime-env.sh'), readFileSync(runtimeEnvPath, 'utf8'));
    writeFileSync(join(tsxDir, 'tsx'), [
      '#!/usr/bin/env bash',
      'case "$1" in',
      '  scripts/resolve-companion-fleet.ts)',
      '    if [ "${2:-}" = "--probe-ready" ]; then',
      `      test -S ${JSON.stringify(socketA)} && test -S ${JSON.stringify(socketB)}`,
      `      printf 'probe\\n' >> ${JSON.stringify(eventsPath)}`,
      '      exit 0',
      '    fi',
      `    printf '${companionA}\\t${workDir}/a\\t${workDir}/a/card.json\\tcompanion_a\\t${workDir}/workspaces/a\\tproof-a\\tsession-a\\tpostgres://companion_a:a@localhost/psfn\\t${socketA}\\n'`,
      `    printf '${companionB}\\t${workDir}/b\\t${workDir}/b/card.json\\tcompanion_b\\t${workDir}/workspaces/b\\tproof-b\\tsession-b\\tpostgres://companion_b:b@localhost/psfn\\t${socketB}\\n'`,
      '    ;;',
      '  scripts/provision-companion-fleet.ts|scripts/preflight-startup-owner-files.ts) exit 0 ;;',
      '  src/app/gateway/main.ts)',
      '    python3 - "$GATEWAY_SOCKET" <<\'PY\'',
      'import os, socket, sys, time',
      'path = sys.argv[1]',
      'os.makedirs(os.path.dirname(path), exist_ok=True)',
      'server = socket.socket(socket.AF_UNIX)',
      'server.bind(path)',
      'server.listen(1)',
      'time.sleep(30)',
      'PY',
      '    ;;',
      '  src/app/agent/main.ts)',
      `    printf 'agent:%s\\n' "$COMPANION_ID" >> ${JSON.stringify(eventsPath)}`,
      '    python3 - "$ADMIN_TRANSPORT_SOCKET" <<\'PY\'',
      'import os, socket, sys, time',
      'path = sys.argv[1]',
      'os.makedirs(os.path.dirname(path), exist_ok=True)',
      'server = socket.socket(socket.AF_UNIX)',
      'server.bind(path)',
      'server.listen(1)',
      'time.sleep(30)',
      'PY',
      '    ;;',
      '  src/app/operator/main.ts)',
      `    test -S ${JSON.stringify(socketA)} && test -S ${JSON.stringify(socketB)}`,
      '    test -z "${COMPANION_ID+x}"',
      '    test -z "${COMPANION_PG_SCHEMA+x}"',
      '    test -z "${WORKSPACE_PATH+x}"',
      `    printf 'garden\\n' >> ${JSON.stringify(eventsPath)}`,
      '    kill -TERM "$PPID"',
      '    sleep 2',
      '    ;;',
      '  *) exit 97 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(fakeBinDir, 'node'), [
      '#!/usr/bin/env bash',
      'if [ "$1" = "-p" ]; then printf "24\\n"; else printf "v24.19.0\\n"; fi',
    ].join('\n'), { mode: 0o755 });

    try {
      const output = execFileSync('bash', ['scripts/start-gateway-agent.sh'], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: `${fakeBinDir}:/usr/bin:/bin`,
          HOME: process.env.HOME,
          PSFN_SKIP_DOTENV: 'true',
          PSFN_FLEET_AUTH: '1',
          GATEWAY_SOCKET: join(runtimeDir, 'gateway.sock'),
          POSTGRES_DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
        },
      });
      const events = readFileSync(eventsPath, 'utf8').trim().split('\n');
      expect(events.filter(event => event.startsWith('agent:')).sort()).toEqual([
        `agent:${companionA}`,
        `agent:${companionB}`,
      ]);
      expect(events.filter(event => event === 'garden')).toHaveLength(1);
      expect(events.filter(event => event === 'probe')).toHaveLength(1);
      expect(events.indexOf('probe')).toBeLessThan(events.indexOf('garden'));
      expect(events.at(-1)).toBe('garden');
      expect(output).toContain('all validated agent admin transports are ready');
      expect(output).toContain('starting one fleet Garden');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('refuses to start the fleet on --dry-run when companions.json is missing', () => {
    const { workDir, systemDataDir, companionDataDir } = makeFleetWorkspace(undefined);
    let error: unknown;
    try {
      execFileSync('bash', ['scripts/start-gateway-agent.sh', '--dry-run'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PSFN_SKIP_DOTENV: 'true',
          PSFN_FLEET_AUTH: '1',
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
          XDG_RUNTIME_DIR: join(workDir, 'run'),
        },
        timeout: 30000,
      });
    } catch (caught) {
      error = caught;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
    expect(error).toBeDefined();
    const combined =
      String((error as { stdout?: Buffer }).stdout ?? '')
      + String((error as { stderr?: Buffer }).stderr ?? '');
    expect(combined).toContain('refusing to start');
    expect(combined).not.toContain('starting gateway');
  });
});

describe('psfn_source_dotenv_preserving_existing_env', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('keeps explicit env values while still loading missing dotenv values', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-env-'));
    tempDirs.push(workDir);

    const dotenvPath = join(workDir, '.env');
    writeFileSync(
      dotenvPath,
      [
        'DATA_DIR=./dotenv-data',
        'DATABASE_PATH=./dotenv.db',
        'WORKSPACE_PATH=./dotenv-workspace',
        'CHARACTER_CARD_PATH=./dotenv-card.json',
        'NEW_DOTENV_ONLY=loaded',
      ].join('\n'),
      'utf8',
    );

    const output = execFileSync(
      'bash',
      [
        '-lc',
        [
          `source ${JSON.stringify(runtimeEnvPath)}`,
          `export DATA_DIR=/explicit/data`,
          `export DATABASE_PATH=/explicit/companion.db`,
          `export WORKSPACE_PATH=/explicit/workspace`,
          `export CHARACTER_CARD_PATH=/explicit/card.json`,
          `psfn_source_dotenv_preserving_existing_env ${JSON.stringify(dotenvPath)}`,
          'printf "%s\\n" "$DATA_DIR" "$DATABASE_PATH" "$WORKSPACE_PATH" "$CHARACTER_CARD_PATH" "$NEW_DOTENV_ONLY"',
        ].join('; '),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim().split('\n');

    expect(output).toEqual([
      '/explicit/data',
      '/explicit/companion.db',
      '/explicit/workspace',
      '/explicit/card.json',
      'loaded',
    ]);
  });

  it('defaults the runtime workspace to a separate personal workspace root', () => {
    const output = execFileSync(
      'bash',
      [
        '-lc',
        [
          `source ${JSON.stringify(runtimeEnvPath)}`,
          'unset WORKSPACE_PATH DATA_DIR SYSTEM_DATA_DIR COMPANION_DATA_DIR PSFN_RUNTIME_ROOT PSFN_RUNTIME_LAYOUT_MODE',
          'psfn_resolve_runtime_workspace_path',
          'export SYSTEM_DATA_DIR=./system-data',
          'export COMPANION_DATA_DIR=./companion-data',
          'psfn_resolve_runtime_workspace_path',
        ].join('; '),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim().split('\n');

    expect(output).toEqual([
      './workspace',
      './workspace',
    ]);
  });

  it.each([
    [20, 'v20.19.2'],
    [25, 'v25.9.0'],
  ])('fails clearly when the launcher sees unsupported Node.js %s', (major, version) => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-node-'));
    tempDirs.push(workDir);
    const fakeNode = join(workDir, 'node');
    writeFileSync(
      fakeNode,
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "-p" ]; then',
        `  printf "${major}\\n"`,
        'else',
        `  printf "${version}\\n"`,
        'fi',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeNode, 0o755);

    let error: unknown;
    try {
      execFileSync(
        'bash',
        [
          '-lc',
          [
            `source ${JSON.stringify(runtimeEnvPath)}`,
            `PATH=${JSON.stringify(`${workDir}:/usr/bin:/bin`)}`,
            'psfn_require_node_major 24',
          ].join('; '),
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(String((error as { stderr?: Buffer }).stderr)).toContain(
      `Node.js 24.x is required; found ${version}`,
    );
  });

  it('fails closed instead of using the fallback socket in production mode', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-socket-'));
    tempDirs.push(workDir);
    const fallbackDir = join(workDir, 'fallback');
    const fallbackSocket = join(fallbackDir, 'gateway.sock');

    let error: unknown;
    try {
      execFileSync(
        'bash',
        [
          '-lc',
          [
            `source ${JSON.stringify(runtimeEnvPath)}`,
            'unset GATEWAY_SOCKET',
            'export PSFN_RUNTIME_LAYOUT_MODE=production',
            `psfn_resolve_gateway_socket_path /proc/psfn-denied/gateway.sock ${JSON.stringify(fallbackSocket)}`,
          ].join('; '),
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(String((error as { stderr?: Buffer }).stderr)).toContain(
      'Production runtime requires an explicit writable GATEWAY_SOCKET',
    );
    expect(existsSync(fallbackDir)).toBe(false);
  });

  it('keeps the fallback socket available for local continuous launches', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-socket-'));
    tempDirs.push(workDir);
    const fallbackDir = join(workDir, 'fallback');
    const fallbackSocket = join(fallbackDir, 'gateway.sock');

    const output = execFileSync(
      'bash',
      [
        '-lc',
        [
          `source ${JSON.stringify(runtimeEnvPath)}`,
          'unset GATEWAY_SOCKET PSFN_RUNTIME_LAYOUT_MODE NODE_ENV',
          `psfn_resolve_gateway_socket_path /proc/psfn-denied/gateway.sock ${JSON.stringify(fallbackSocket)}`,
        ].join('; '),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();

    expect(output).toBe(fallbackSocket);
    expect(existsSync(fallbackDir)).toBe(true);
  });

  it('requires explicit production API, admin, and session auth config', () => {
    let error: unknown;
    try {
      execFileSync(
        'bash',
        [
          '-lc',
          [
            `source ${JSON.stringify(runtimeEnvPath)}`,
            'export PSFN_RUNTIME_LAYOUT_MODE=production',
            'psfn_require_production_launcher_env',
          ].join('; '),
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(String((error as { stderr?: Buffer }).stderr)).toContain(
      'Production runtime requires API_HOST',
    );
  });

  it('rejects insecure production API and admin overrides', () => {
    let error: unknown;
    try {
      execFileSync(
        'bash',
        [
          '-lc',
          [
            `source ${JSON.stringify(runtimeEnvPath)}`,
            'export PSFN_RUNTIME_LAYOUT_MODE=production',
            'export API_HOST=0.0.0.0 API_PORT=10053 API_KEY=test-api-key',
            'export ADMIN_HOST=0.0.0.0 ADMIN_PORT=10054 ADMIN_TOKEN=test-admin-token',
            'export WORKSPACE_PATH=/srv/psfn/purrsephone',
            'export GATEWAY_SESSION_HMAC_KEYS=test-keyring',
            'export ALLOW_INSECURE_LOCAL_API=true',
            'psfn_require_production_launcher_env',
          ].join('; '),
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(String((error as { stderr?: Buffer }).stderr)).toContain(
      'Production runtime forbids ALLOW_INSECURE_LOCAL_API=true',
    );
  });

  it('requires an explicit production workspace path', () => {
    let error: unknown;
    try {
      execFileSync(
        'bash',
        [
          '-lc',
          [
            `source ${JSON.stringify(runtimeEnvPath)}`,
            'export PSFN_RUNTIME_LAYOUT_MODE=production',
            'export API_HOST=0.0.0.0 API_PORT=10053 API_KEY=test-api-key',
            'export ADMIN_HOST=0.0.0.0 ADMIN_PORT=10054 ADMIN_TOKEN=test-admin-token',
            'export GATEWAY_SESSION_HMAC_KEYS=test-keyring',
            'psfn_require_production_launcher_env',
          ].join('; '),
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(String((error as { stderr?: Buffer }).stderr)).toContain(
      'Production runtime requires WORKSPACE_PATH',
    );
  });

  it('rejects the default dev session HMAC key in production', () => {
    let error: unknown;
    try {
      execFileSync(
        'bash',
        [
          '-lc',
          [
            `source ${JSON.stringify(runtimeEnvPath)}`,
            'export PSFN_RUNTIME_LAYOUT_MODE=production',
            'export API_HOST=0.0.0.0 API_PORT=10053 API_KEY=test-api-key',
            'export ADMIN_HOST=0.0.0.0 ADMIN_PORT=10054 ADMIN_TOKEN=test-admin-token',
            'export WORKSPACE_PATH=/srv/psfn/purrsephone',
            'export GATEWAY_SESSION_HMAC_KEY=psfn-dev-session-hmac',
            'psfn_require_production_launcher_env',
          ].join('; '),
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(String((error as { stderr?: Buffer }).stderr)).toContain(
      'Production runtime forbids the default dev GATEWAY_SESSION_HMAC_KEY',
    );
  });

  it('accepts explicit production API, admin, and session auth config', () => {
    const output = execFileSync(
      'bash',
      [
        '-lc',
        [
          `source ${JSON.stringify(runtimeEnvPath)}`,
          'export PSFN_RUNTIME_LAYOUT_MODE=production',
          'export API_HOST=0.0.0.0 API_PORT=10053 API_KEY=test-api-key',
          'export ADMIN_HOST=0.0.0.0 ADMIN_PORT=10054 ADMIN_TOKEN=test-admin-token',
          'export WORKSPACE_PATH=/srv/psfn/purrsephone',
          'export GATEWAY_SESSION_HMAC_KEYS=test-keyring',
          'psfn_require_production_launcher_env',
          'printf ok',
        ].join('; '),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(output).toBe('ok');
  });

  it('does not require a legacy ADMIN_TOKEN for production fleet authentication', () => {
    const output = execFileSync(
      'bash',
      [
        '-lc',
        [
          `source ${JSON.stringify(runtimeEnvPath)}`,
          'export PSFN_RUNTIME_LAYOUT_MODE=production PSFN_FLEET_AUTH=1',
          'export API_HOST=0.0.0.0 API_PORT=10053 API_KEY=test-api-key',
          'export ADMIN_HOST=0.0.0.0 ADMIN_PORT=10054',
          'export WORKSPACE_PATH=/srv/psfn/purrsephone',
          'export GATEWAY_SESSION_HMAC_KEYS=test-keyring',
          'unset ADMIN_TOKEN',
          'psfn_require_production_launcher_env',
          'printf ok',
        ].join('; '),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(output).toBe('ok');
  });
});
