import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const runtimeEnvPath = join(repoRoot, 'scripts/system/runtime-env.sh');

describe('start-gateway-agent launcher supervision', () => {
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

  it('keeps the live user unit pointed at the launcher instead of npm', () => {
    const unit = readFileSync(join(repoRoot, 'scripts/system/user/purrsephone.service'), 'utf8');
    expect(unit).toContain('ExecStart=/bin/bash /mnt/samesung/ai/psfn-live/scripts/start-gateway-agent.sh --yolo');
    expect(unit).not.toContain('ExecStart=%h/.nvm/versions/node/v22.21.1/bin/npm run yolo');
  });

  it('keeps user-local tools visible to the live user unit', () => {
    const unit = readFileSync(join(repoRoot, 'scripts/system/user/purrsephone.service'), 'utf8');
    expect(unit).toMatch(/^Environment=PATH=%h\/\.local\/bin:%h\/\.nvm\/versions\/node\/v22\.21\.1\/bin:/m);
  });

  it('points the live user unit at separate personal and runtime roots', () => {
    const unit = readFileSync(join(repoRoot, 'scripts/system/user/purrsephone.service'), 'utf8');
    expect(unit).toContain('Environment=DATA_DIR=/mnt/samesung/ai/psfn-live/data');
    expect(unit).toContain('Environment=WORKSPACE_PATH=/mnt/samesung/ai/psfn-live/purrsephone');
    expect(unit).toContain('Environment=CHARACTER_CARD_PATH=/mnt/samesung/ai/psfn-live/data/companion.json');
    expect(unit).not.toContain('Environment=WORKSPACE_PATH=/mnt/samesung/ai/psfn-live/workspace');
    expect(unit).not.toContain('Environment=CHARACTER_CARD_PATH=/mnt/samesung/ai/psfn-live/purrsephone/purrsephone.json');
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
    expect(launcher).toContain('launch_background env -i "${AGENT_ENV[@]}" ./node_modules/.bin/tsx src/app/agent/main.ts');
    expect(launcher).toContain('build_agent_env');
    expect(launcher).toContain('GATEWAY_SOCKET');
    expect(launcher).toContain('SYSTEM_DATA_DIR');
    expect(launcher).toContain('COMPANION_DATA_DIR');
    expect(launcher).not.toMatch(/\n\s*API_KEY\s*\\/);
    expect(launcher).not.toMatch(/\n\s*ADMIN_TOKEN\s*\\/);
    expect(launcher).not.toMatch(/\n\s*OPENROUTER_API_KEY\s*\\/);
    expect(launcher).not.toMatch(/\n\s*LITELLM_API_KEY\s*\\/);
    expect(launcher).not.toMatch(/\n\s*FAL_API_KEY\s*\\/);
  });

  it('does not inject npm run split as an unsafe lifecycle restart command', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).not.toContain('export LIFECYCLE_RESTART_COMMAND="npm run');
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
