import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveCompanionAuthToken } from '../../../boundary/gateway/companion-auth.js';

const repoRoot = process.cwd();
const runtimeEnvPath = join(repoRoot, 'scripts/system/runtime-env.sh');

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

  it('re-execs the repo launcher for lifecycle restart exit codes', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('PSFN_LIFECYCLE_RESTART_EXIT_CODE="${PSFN_LIFECYCLE_RESTART_EXIT_CODE:-75}"');
    expect(launcher).toContain('wait -n "${GATEWAY_PID}" "${AGENT_PID}" "${OPERATOR_PID}"');
    expect(launcher).toContain('lifecycle restart requested; stopping children and re-execing launcher');
    expect(launcher).toContain('exec "$0" "$@"');
  });

  it('waits briefly for the agent restart exit when a sibling child exits first', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('wait_for_lifecycle_restart_child');
    expect(launcher).toContain('wait_for_exited_pid_status');
    expect(launcher).toContain('if [ "${EXIT_STATUS}" -ne "${PSFN_LIFECYCLE_RESTART_EXIT_CODE}" ]; then');
    expect(launcher).toContain('EXIT_STATUS="${PSFN_LIFECYCLE_RESTART_EXIT_CODE}"');
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
        'echo "[${MODE_LABEL}] verifying startup owner files..."',
      ].join('\n'),
    );
    expect(launcher).toContain(
      [
        'echo "[${MODE_LABEL}] verifying startup owner files..."',
        'if [ -x "./node_modules/.bin/tsx" ]; then',
        '  ./node_modules/.bin/tsx scripts/verify-startup-owner-files.ts',
        'else',
        '  npm run verify:startup-owner-files',
        'fi',
        '',
        'echo "[${MODE_LABEL}] starting gateway..."',
      ].join('\n'),
    );
    expect(launcher).toContain(
      [
        'echo "[${MODE_LABEL}] lifecycle restart requested; stopping children and re-execing launcher"',
        '  cleanup_children',
        '  trap - INT TERM EXIT',
        '  exec "$0" "$@"',
      ].join('\n'),
    );
  });

  it('normalizes expected SIGTERM shutdown to exit 0 after cleanup', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-sigterm-'));
    const scriptsDir = join(workDir, 'scripts');
    const systemDir = join(scriptsDir, 'system');
    const tsxDir = join(workDir, 'node_modules/.bin');
    const fakeBinDir = join(workDir, 'fake-bin');
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
        '  scripts/verify-startup-owner-files.ts) exit 0 ;;',
        '  scripts/resolve-single-companion-auth.ts) printf "v1.agent-proof\\tv1.worker-proof\\n"; exit 0 ;;',
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
        '  printf "22\\n"',
        'else',
        '  printf "v22.22.3\\n"',
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
            'PSFN_SKIP_DOTENV=true',
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
    expect(agentAllowlist).not.toMatch(/\n\s*API_KEY\s*\\/);
    expect(agentAllowlist).not.toMatch(/\n\s*ADMIN_TOKEN\s*\\/);
    expect(agentAllowlist).not.toMatch(/\n\s*OPENROUTER_API_KEY\s*\\/);
    expect(agentAllowlist).not.toMatch(/\n\s*LITELLM_API_KEY\s*\\/);
    expect(agentAllowlist).not.toMatch(/\n\s*FAL_API_KEY\s*\\/);
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
          COMPANION_ID: 'operator-probe',
        },
      });

      expect(JSON.parse(output.trim())).toEqual({});
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('checks Node.js before running TypeScript entrypoints', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('psfn_require_node_major 22');
    expect(launcher.indexOf('psfn_require_node_major 22')).toBeLessThan(
      launcher.indexOf('scripts/verify-startup-owner-files.ts'),
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
    companions: [
      {
        companionId: '11111111-1111-4111-8111-111111111111',
        companionDataDir: 'alpha',
        characterCardPath: 'alpha/card.json',
        postgresSchema: 'companion_alpha',
        gardenPort: 10061,
      },
      {
        companionId: '22222222-2222-4222-8222-222222222222',
        companionDataDir: 'beta',
        characterCardPath: 'beta/card.json',
        postgresSchema: 'companion_beta',
      },
    ],
  });

  it('keeps the single-companion process topology when the flag is absent', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    // The helper is only invoked when the topology flag is present at all.
    expect(launcher).toContain('if [ -z "${PSFN_MULTI_COMPANION:-}" ]; then');
    // Supervisor branch never runs unless the flag resolved a fleet.
    expect(launcher).toContain('if [ "${SUPERVISOR_MODE}" -eq 1 ]; then');
    // The normal topology still derives a separate proof for its isolated
    // session-integrity worker before either child receives scrubbed env.
    expect(launcher).toContain('scripts/resolve-single-companion-auth.ts');
    expect(launcher).toContain('resolve_single_companion_auth');
  });

  it('delegates all fleet validation to the canonical TS helper', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('./node_modules/.bin/tsx scripts/resolve-companion-fleet.ts');
    expect(launcher).toContain('npm run --silent resolve:companion-fleet');
    expect(launcher).toContain('failed to resolve companion fleet from companions.json; refusing to start');
  });

  it('passes the companion-scoped and topology env through the scrubbed allowlist', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('COMPANION_PG_SCHEMA \\');
    expect(launcher).toContain('GATEWAY_COMPANION_AUTH_TOKEN \\');
    expect(launcher).toContain('GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN \\');
    expect(launcher).toContain('PSFN_MULTI_COMPANION \\');
    expect(launcher).toContain('export COMPANION_ID="${companion_id}"');
    expect(launcher).toContain('export COMPANION_DATA_DIR="${companion_data_dir}"');
    expect(launcher).toContain('export CHARACTER_CARD_PATH="${character_card_path}"');
    expect(launcher).toContain('export COMPANION_PG_SCHEMA="${postgres_schema}"');
  });

  it('supervises the fleet with shared-fate shutdown and no silent restart', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain(
      'wait -n "${GATEWAY_PID}" "${AGENT_PIDS[@]}" ${OPERATOR_PIDS[@]+"${OPERATOR_PIDS[@]}"}',
    );
    expect(launcher).toContain('shutting down the whole fleet (shared-fate)');
    // The supervisor path must tear down the whole set, not re-exec/auto-restart.
    expect(launcher).toContain('cleanup_children');
  });

  it('spawns one scrubbed operator per fleet entry with a gardenPort (W4)', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    // Operator spawns run through env -i with the operator allowlist, after the
    // companion's agent, only when companions.json assigns a gardenPort.
    expect(launcher).toContain(
      'launch_background env -i "${OPERATOR_ENV[@]}" ./node_modules/.bin/tsx src/app/operator/main.ts',
    );
    expect(launcher).toContain('build_operator_env');
    expect(launcher).toContain('start_companion_operator');
    expect(launcher).toContain('export ADMIN_TRANSPORT_SOCKET="${admin_transport_socket}"');
    expect(launcher).toContain('export ADMIN_PORT="${garden_port}"');
    expect(launcher.indexOf('start_companion_agent "${companion_id}"')).toBeLessThan(
      launcher.indexOf('start_companion_operator "${companion_id}"'),
    );
    // The operator allowlist may carry its own admin auth material but never
    // upstream provider secrets.
    const operatorAllowlist = launcher.slice(
      launcher.indexOf('build_operator_env()'),
      launcher.indexOf('launch_background()'),
    );
    expect(operatorAllowlist).toContain('ADMIN_TOKEN \\');
    for (const secret of [
      'OPENROUTER_API_KEY',
      'LITELLM_API_KEY',
      'FAL_API_KEY',
      'DISCORD_TOKEN',
      'TELEGRAM_BOT_TOKEN',
      'POSTGRES_DATABASE_URL',
      'GATEWAY_COMPANION_AUTH_TOKEN',
      'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN',
      'GATEWAY_SESSION_HMAC_KEY',
    ]) {
      expect(operatorAllowlist).not.toContain(secret);
    }
    expect(launcher).toContain(
      'launch_background env -i "${OPERATOR_ENV[@]}" ./node_modules/.bin/tsx src/app/operator/main.ts',
    );
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
          PSFN_MULTI_COMPANION: '1',
          PSFN_RUNTIME_ROOT: workDir,
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
          GATEWAY_SESSION_HMAC_KEY: 'test-session-secret',
          ADMIN_TRANSPORT_SOCKET: join(workDir, 'run', 'garden-admin.sock'),
        },
      });
      const socketDir = join(workDir, 'run');
      const keyring = { activeVersion: 'v1', keys: { v1: 'test-session-secret' } };
      expect(output).toBe(
        [
          `11111111-1111-4111-8111-111111111111\t${workDir}/alpha\t${workDir}/alpha/card.json\tcompanion_alpha`
          + `\t${deriveCompanionAuthToken('11111111-1111-4111-8111-111111111111', 'agent', keyring)}`
          + `\t${deriveCompanionAuthToken('11111111-1111-4111-8111-111111111111', 'internal_session_integrity', keyring)}`
          + `\t${socketDir}/garden-admin-11111111-1111-4111-8111-111111111111.sock\t10061`,
          `22222222-2222-4222-8222-222222222222\t${workDir}/beta\t${workDir}/beta/card.json\tcompanion_beta`
          + `\t${deriveCompanionAuthToken('22222222-2222-4222-8222-222222222222', 'agent', keyring)}`
          + `\t${deriveCompanionAuthToken('22222222-2222-4222-8222-222222222222', 'internal_session_integrity', keyring)}`
          + `\t${socketDir}/garden-admin-22222222-2222-4222-8222-222222222222.sock\t-`,
          '',
        ].join('\n'),
      );
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
          PSFN_MULTI_COMPANION: '1',
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
      'Multi-companion mode requires ADMIN_TRANSPORT_MODE=socket',
    );
  });

  it('prints nothing for single-companion topology (empty fleet signal)', () => {
    const { workDir, systemDataDir, companionDataDir } = makeFleetWorkspace(undefined);
    try {
      const output = execFileSync(tsxBin, ['scripts/resolve-companion-fleet.ts'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
        },
      });
      expect(output).toBe('');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the flag is on but companions.json is missing', () => {
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
          PSFN_MULTI_COMPANION: '1',
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
    expect(String((error as { stderr?: Buffer }).stderr)).toContain('the fleet manifest is missing');
  });

  it('fails closed when companions.json is present but the flag is off', () => {
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
      'A fleet manifest is present',
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
          PSFN_MULTI_COMPANION: '1',
          PSFN_RUNTIME_ROOT: workDir,
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
          GATEWAY_SESSION_HMAC_KEY: 'test-session-secret',
          XDG_RUNTIME_DIR: join(workDir, 'run'),
        },
        timeout: 30000,
      });
      expect(output).toContain('dry-run spawn plan (2 companion(s))');
      expect(output).toContain('companionId=11111111-1111-4111-8111-111111111111 schema=companion_alpha');
      expect(output).toContain('companionId=22222222-2222-4222-8222-222222222222 schema=companion_beta');
      // W4: the plan enumerates one operator per companion with a gardenPort,
      // each bound to its companion's own admin transport socket.
      expect(output).toContain(
        'operator: companionId=11111111-1111-4111-8111-111111111111 gardenPort=10061',
      );
      expect(output).toContain('garden-admin-11111111-1111-4111-8111-111111111111.sock');
      expect(output).toContain(
        'operator: companionId=22222222-2222-4222-8222-222222222222 (none — no gardenPort in companions.json)',
      );
      expect(output).not.toContain('starting gateway');
      expect(output).not.toContain('starting agent');
      expect(output).not.toContain('starting operator');
      expect(output).not.toContain('test-session-secret');
      expect(output).not.toMatch(/v1\.[a-f0-9]{64}/u);
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
          PSFN_MULTI_COMPANION: '1',
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
          `export DATABASE_PATH=/explicit/db.sqlite`,
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
      '/explicit/db.sqlite',
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

  it('fails clearly when the launcher sees an unsupported Node.js version', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-node-'));
    tempDirs.push(workDir);
    const fakeNode = join(workDir, 'node');
    writeFileSync(
      fakeNode,
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "-p" ]; then',
        '  printf "20\\n"',
        'else',
        '  printf "v20.19.2\\n"',
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
            'psfn_require_node_major 22',
          ].join('; '),
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(String((error as { stderr?: Buffer }).stderr)).toContain('Node.js 22+ is required; found v20.19.2');
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
});
