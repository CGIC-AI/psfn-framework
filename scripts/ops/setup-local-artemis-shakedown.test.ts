import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGatewayMultiCompanionConfig } from '../../src/boundary/gateway/multi-companion.js';
import { loadRuntimeChannelsConfig } from '../../src/channels/backplane/config.js';
import { verifyStartupOwnerFiles } from '../../src/system/config/startup-owner-files.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const scriptPath = join(repoRoot, 'scripts/ops/setup-local-artemis-shakedown.sh');
const validatorPath = join(repoRoot, 'scripts/ops/validate-kube-rollout.sh');
const companionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerDiscordId = '123456789012345678';
const canonicalTestingHarness = {
  principalId: 'testing-harness',
  tokenRef: {
    kind: 'env',
    envName: 'TESTING_HARNESS_API_KEY',
  },
};
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-artemis-bootstrap-test-'));
  temporaryRoots.push(root);
  return root;
}

function runScript(args: string[]) {
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PSFN_ARTEMIS_OWNER_DISCORD_ID: ownerDiscordId,
    },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function assertCanonicalTestingHarnessOwner(channels: Record<string, any>): void {
  expect(channels.api?.testingHarness).toEqual(canonicalTestingHarness);
}

function assertTestingHarnessSecret(secret: Record<string, any>): string {
  const encoded = secret.data?.TESTING_HARNESS_API_KEY;
  expect(typeof encoded).toBe('string');
  if (typeof encoded !== 'string') {
    throw new Error('Secret data must include TESTING_HARNESS_API_KEY');
  }
  const value = Buffer.from(encoded, 'base64').toString('utf8');
  expect(value.length).toBeGreaterThanOrEqual(16);
  return value;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('local Artemis always-fleet bootstrap fixtures', () => {
  it('generates a complete one-entry fleet when the fixture root is absent', () => {
    const root = temporaryRoot();
    const missingFixtureRoot = join(root, 'missing-input');
    const outputRoot = join(root, 'prepared');

    runScript([
      '--shakedown-root', missingFixtureRoot,
      '--companion-id', companionId,
      '--companion-name', 'Test Artemis',
      '--prepare-seed-only', outputRoot,
    ]);

    const companions = readJson(join(outputRoot, 'system-data/companions.json'));
    expect(companions.companions).toEqual([expect.objectContaining({
      companionId,
      companionDataDir: `companions/${companionId}`,
      characterCardPath: `companions/${companionId}/companion.json`,
      postgresSchema: 'companion_default',
      postgresRole: 'companion_default_runtime',
    })]);

    const fleetAuth = readJson(join(outputRoot, 'system-data/fleet-auth.json'));
    expect(fleetAuth.accountRoster).toEqual([{
      providerSubjectId: ownerDiscordId,
      companionId,
      contactId: `fleet-owner-${companionId}`,
      role: 'owner',
    }]);
    expect(fleetAuth.canonicalOrigin).toBe('https://psfn-gateway.local');
    expect(fleetAuth.hubDeviceAssertions.audience).toBe('https://psfn-gateway.local');
    expect(fleetAuth.verifierKeys[0].kid).not.toBe('replace-before-enable');

    const channels = readJson(join(outputRoot, 'system-data/channels.json'));
    expect(channels).toMatchObject({
      discord: { companionId },
      telegram: { enabled: false, companionId },
      api: {
        companionId,
        testingHarness: canonicalTestingHarness,
      },
    });
    assertCanonicalTestingHarnessOwner(channels);
    const channelsConfig = loadRuntimeChannelsConfig(join(outputRoot, 'system-data'), {});
    const fleetRouting = resolveGatewayMultiCompanionConfig({
      multiCompanion: true,
      companionFleet: {
        postgres: {
          sharedMigrationRole: 'shared_schema_migration',
          sharedMigrationDatabaseUrlRef: {
            kind: 'env',
            envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
          },
        },
        persistenceRoot: '/runtime',
        workspacesRoot: '/runtime/workspaces',
        sharedWorkspacePath: '/runtime/workspaces/shared',
        companions: [{
          companionId,
          companionDataDir: `/runtime/companions/${companionId}`,
          characterCardPath: `/runtime/companions/${companionId}/companion.json`,
          postgresSchema: 'companion_default',
          postgresRole: 'companion_default_runtime',
          postgresDatabaseUrlRef: {
            kind: 'env',
            envName: 'COMPANION_DEFAULT_DATABASE_URL',
          },
          personalWorkspacePath: `/runtime/workspaces/personal/${companionId}`,
        }],
      },
    }, channelsConfig, {
      schemaVersion: 1,
      enabled: false,
      satellites: [],
    });
    expect(fleetRouting.channelRouting).toEqual({
      discord: companionId,
      telegram: companionId,
      api: companionId,
    });

    expect(readJson(join(outputRoot, 'companion-data/companion.json')).data.name)
      .toBe('Test Artemis');
    for (const owner of ['capability-tier', 'scheduler', 'charge-policy', 'skills']) {
      expect(readJson(join(outputRoot, `companion-data/${owner}.json`))).toBeTruthy();
      expect(() => readFileSync(join(outputRoot, `system-data/${owner}.json`), 'utf8')).toThrow();
    }
    expect(readFileSync(join(outputRoot, 'fleet-auth-assertion-private.pem'), 'utf8'))
      .toContain('BEGIN PRIVATE KEY');
  });

  it('preserves an operator-provided testing-harness principal override', () => {
    const root = temporaryRoot();
    const fixtureRoot = join(root, 'fixture');
    const outputRoot = join(root, 'prepared');
    const testingHarness = {
      principalId: 'testing-harness',
      tokenRef: {
        kind: 'env',
        envName: 'TESTING_HARNESS_API_KEY',
      },
    };
    mkdirSync(join(fixtureRoot, 'system-data'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, 'system-data/channels.json'),
      JSON.stringify({ api: { testingHarness } }),
    );

    runScript([
      '--shakedown-root', fixtureRoot,
      '--companion-id', companionId,
      '--prepare-seed-only', outputRoot,
    ]);

    expect(readJson(join(outputRoot, 'system-data/channels.json')).api)
      .toEqual({ testingHarness, companionId });
  });

  it('preserves a malformed nested testing-harness section so parsing fails closed', () => {
    const root = temporaryRoot();
    const fixtureRoot = join(root, 'fixture');
    const outputRoot = join(root, 'prepared');
    mkdirSync(join(fixtureRoot, 'system-data'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, 'system-data/channels.json'),
      JSON.stringify({ api: { testingHarness: 'invalid' } }),
    );

    runScript([
      '--shakedown-root', fixtureRoot,
      '--companion-id', companionId,
      '--prepare-seed-only', outputRoot,
    ]);

    expect(() => loadRuntimeChannelsConfig(join(outputRoot, 'system-data'), {}))
      .toThrow('channels.json.testingHarness must be an object');
  });

  it('distinguishes the pre-door owner and Secret fixture shapes from the required pair', () => {
    expect(() => assertCanonicalTestingHarnessOwner({ api: { companionId } })).toThrow();
    expect(() => assertTestingHarnessSecret({
      data: { API_KEY: Buffer.from('legacy-api-key').toString('base64') },
    })).toThrow();
  });

  it.each(['discord', 'telegram', 'api'])(
    'rejects a malformed %s channel section instead of silently replacing it',
    (section) => {
      const root = temporaryRoot();
      const fixtureRoot = join(root, 'fixture');
      const outputRoot = join(root, 'prepared');
      mkdirSync(join(fixtureRoot, 'system-data'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'system-data/channels.json'),
        JSON.stringify({ [section]: 'invalid' }),
      );

      const result = spawnSync('bash', [
        scriptPath,
        '--shakedown-root', fixtureRoot,
        '--companion-id', companionId,
        '--prepare-seed-only', outputRoot,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PSFN_ARTEMIS_OWNER_DISCORD_ID: ownerDiscordId,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `local channels owner ${section} section must be an object`,
      );
    },
  );

  it('splices missing owner keys without replacing existing scalar, object, or array values', () => {
    const root = temporaryRoot();
    const targetRoot = join(root, 'target');
    const seedRoot = join(root, 'seed');
    mkdirSync(targetRoot, { recursive: true });
    mkdirSync(seedRoot, { recursive: true });
    writeFileSync(join(targetRoot, 'settings.json'), JSON.stringify({
      nested: { tuned: 99 },
      roster: ['live'],
      entries: [{ tuned: 42 }],
      operatorOnly: true,
    }));
    writeFileSync(join(seedRoot, 'settings.json'), JSON.stringify({
      nested: { tuned: 1, newlyOwned: 2 },
      roster: ['seed'],
      entries: [{ tuned: 1, newlyOwned: 'default' }],
      newTopLevel: 'default',
    }));
    writeFileSync(join(seedRoot, 'new-owner.json'), JSON.stringify({ enabled: true }));

    runScript(['--splice-owner-files', targetRoot, seedRoot]);

    expect(readJson(join(targetRoot, 'settings.json'))).toEqual({
      nested: { tuned: 99, newlyOwned: 2 },
      roster: ['live'],
      entries: [{ tuned: 42, newlyOwned: 'default' }],
      operatorOnly: true,
      newTopLevel: 'default',
    });
    expect(readJson(join(targetRoot, 'new-owner.json'))).toEqual({ enabled: true });
    const backups = readdirSync(targetRoot).filter(name => name.startsWith('settings.json.bak-'));
    expect(backups).toHaveLength(1);
    expect(readJson(join(targetRoot, backups[0]))).toEqual({
      nested: { tuned: 99 },
      roster: ['live'],
      entries: [{ tuned: 42 }],
      operatorOnly: true,
    });
  });

  it('migrates a preserved split-root fixture while retaining tuned values and fleet keys', () => {
    const root = temporaryRoot();
    const preservedRoot = join(root, 'preserved');
    const seedRoot = join(root, 'seed');
    runScript([
      '--shakedown-root', join(root, 'missing-preserved-input'),
      '--companion-id', companionId,
      '--prepare-seed-only', preservedRoot,
    ]);
    runScript([
      '--shakedown-root', join(root, 'missing-seed-input'),
      '--companion-id', companionId,
      '--prepare-seed-only', seedRoot,
    ]);

    const settingsPath = join(preservedRoot, 'system-data/settings.json');
    const settings = readJson(settingsPath);
    settings.activeTimezone = 'America/Los_Angeles';
    delete settings.uiThemeId;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    const schedulerPath = join(preservedRoot, 'companion-data/scheduler.json');
    const scheduler = readJson(schedulerPath);
    scheduler.tickIntervalMs = 120_000;
    writeFileSync(schedulerPath, `${JSON.stringify(scheduler, null, 2)}\n`);

    const fleetAuthPath = join(preservedRoot, 'system-data/fleet-auth.json');
    const fleetAuth = readJson(fleetAuthPath);
    const retainedVerifierKey = fleetAuth.verifierKeys[0].publicKeyPem;
    delete fleetAuth.accountRoster;
    writeFileSync(fleetAuthPath, `${JSON.stringify(fleetAuth, null, 2)}\n`);

    runScript([
      '--splice-owner-files',
      join(preservedRoot, 'system-data'),
      join(seedRoot, 'system-data'),
    ]);
    runScript([
      '--splice-owner-files',
      join(preservedRoot, 'companion-data'),
      join(seedRoot, 'companion-data'),
    ]);

    expect(readJson(settingsPath)).toEqual(expect.objectContaining({
      activeTimezone: 'America/Los_Angeles',
      uiThemeId: 'garden',
    }));
    expect(readJson(schedulerPath).tickIntervalMs).toBe(120_000);
    expect(readJson(fleetAuthPath)).toEqual(expect.objectContaining({
      accountRoster: [{
        providerSubjectId: ownerDiscordId,
        companionId,
        contactId: `fleet-owner-${companionId}`,
        role: 'owner',
      }],
      verifierKeys: [expect.objectContaining({ publicKeyPem: retainedVerifierKey })],
    }));
    expect(verifyStartupOwnerFiles({
      dataDir: join(preservedRoot, 'system-data'),
      companionDataDir: join(preservedRoot, 'companion-data'),
      seedDir: join(repoRoot, 'config'),
      fleetAuth: true,
    })).toEqual({ ok: true, errors: [] });
  });

  it('pins the rendered install to fleet auth, dedicated floor storage, and gateway TLS', () => {
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('--set fleet.enabled=true');
    expect(script).toContain('--set fleetAuth.enabled=true');
    expect(script).toContain('--set-string fleetAuth.authorityFloor.existingClaim=');
    expect(script).toContain('--set fleetAuth.authorityFloor.size=64Mi');
    expect(script).toContain('--set ingress.gateway.tls.enabled=true');
    expect(script).not.toContain('secrets.values.gatewayCompanionAuthToken');
    expect(script).toContain('fleetAuth.credentialEnv[8].name=SHARED_SCHEMA_MIGRATION_DATABASE_URL');
    expect(script).toContain('fleetAuth.credentialEnv[9].name=COMPANION_DEFAULT_DATABASE_URL');
    expect(script).toContain('--set postgres.auth.existingSecret=psfn-postgres');
    expect(script).toContain('write_local_postgres_secret "$password" "$COMPANION_DATABASE_URL_VALUE"');
    expect(script).not.toContain('postgresql://psfn:${password}');
    expect(script).toContain("printf 'SHARED_SCHEMA_MIGRATION_DATABASE_URL=%s\\n'");
    expect(script).toContain("printf 'COMPANION_DEFAULT_DATABASE_URL=%s\\n'");
    expect(script).toContain('ALTER ROLE companion_default_runtime WITH LOGIN NOINHERIT');
    expect(script).toContain(
      'ALTER ROLE companion_default_runtime IN DATABASE psfn SET search_path TO companion_default, extensions',
    );
    expect(script).toContain('ALTER ROLE shared_schema_migration WITH LOGIN NOINHERIT');
    expect(script).toContain('CONNECTION LIMIT 60');
    expect(script).toContain('\\connect psfn\nCREATE SCHEMA IF NOT EXISTS extensions');
    expect(script).toContain('ALTER EXTENSION vector SET SCHEMA extensions');
    expect(script).toContain('CREATE SCHEMA companion_default AUTHORIZATION companion_default_runtime');
    expect(script).toContain(
      'GRANT CONNECT, CREATE ON DATABASE psfn_restore_verify TO fleet_auth_migration, fleet_auth_backup, companion_default_runtime, shared_schema_migration',
    );
    expect(script).toContain('\\connect psfn_restore_verify');
    expect(script).toContain('CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION psfn');
    expect(script).toContain('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
    expect(script).toContain('ALTER SCHEMA extensions OWNER TO psfn');
    expect(script).toContain('ALTER EXTENSION vector SET SCHEMA extensions');
    expect(script).toContain('REVOKE ALL ON SCHEMA extensions FROM PUBLIC');
    expect(script).toContain(
      'GRANT USAGE ON SCHEMA extensions TO fleet_auth_backup, companion_default_runtime, shared_schema_migration',
    );
    expect(script).toContain(
      'ALTER ROLE companion_default_runtime IN DATABASE psfn_restore_verify SET search_path TO companion_default, extensions',
    );
    const provisioningStart = script.indexOf('provision_fleet_auth_database_roles() {');
    const provisioningEnd = script.indexOf('\n}\n\nstart_port_forward()', provisioningStart);
    expect(provisioningStart).toBeGreaterThanOrEqual(0);
    expect(provisioningEnd).toBeGreaterThan(provisioningStart);
    expect(script.slice(provisioningStart, provisioningEnd)).not.toMatch(
      /if \(\(RETAINED_FLEET_AUTH_OWNER\)\); then[\s\S]*?\breturn\b/u,
    );
    expect(script).not.toMatch(/GRANT\s+CREATE\s+ON\s+SCHEMA\s+public/i);
    expect(script).toContain(
      'provision_fleet_auth_database_roles\nreplace_postgres_runtime_database_url\ncreate_local_app_secret',
    );
    expect(script).toContain('kind: Certificate');
    expect(script).not.toContain('PSFN_MULTI_COMPANION');
  });

  it('repairs restore-verify prerequisites without rotating retained role credentials', () => {
    const root = temporaryRoot();
    const binRoot = join(root, 'bin');
    const capturedSql = join(root, 'postgres-provisioning.sql');
    mkdirSync(binRoot);

    const script = readFileSync(scriptPath, 'utf8');
    const functionStart = script.indexOf('provision_fleet_auth_database_roles() {');
    const functionEnd = script.indexOf('\n}\n\nstart_port_forward()', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = script.slice(functionStart, functionEnd + 2);

    const kubectl = join(binRoot, 'kubectl');
    writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" wait "* ]]; then
  exit 0
fi
if [[ " $* " == *" exec -i "* ]]; then
  cat >"$POSTGRES_PROVISIONING_CAPTURE"
  exit 0
fi
echo "unexpected kubectl arguments: $*" >&2
exit 64
`);
    chmodSync(kubectl, 0o755);

    const harness = join(root, 'run-retained-postgres-provisioning.sh');
    writeFileSync(harness, `#!/usr/bin/env bash
set -euo pipefail
NAMESPACE=psfn-test
RELEASE=psfn
RETAINED_FLEET_AUTH_OWNER=1
FLEET_AUTH_RUNTIME_PASSWORD=
FLEET_AUTH_MIGRATION_PASSWORD=
FLEET_AUTH_BACKUP_PASSWORD=
COMPANION_DATABASE_PASSWORD=
SHARED_SCHEMA_MIGRATION_PASSWORD=
${functionSource}
provision_fleet_auth_database_roles
`);
    chmodSync(harness, 0o755);

    const result = spawnSync('bash', [harness], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH}`,
        POSTGRES_PROVISIONING_CAPTURE: capturedSql,
      },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('retaining existing fleet-auth database roles and credentials');
    const sql = readFileSync(capturedSql, 'utf8');
    expect(sql).not.toContain('PASSWORD');
    expect(sql).toContain('GRANT CONNECT, CREATE ON DATABASE psfn_restore_verify');
    expect(sql).toContain('\\connect psfn_restore_verify');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
    expect(sql).toContain(
      'GRANT USAGE ON SCHEMA extensions TO fleet_auth_backup, companion_default_runtime, shared_schema_migration',
    );
  });

  it('builds the app Secret without mixing incompatible kubectl input modes', () => {
    const root = temporaryRoot();
    const binRoot = join(root, 'bin');
    const assertionKey = join(root, 'assertion-private.pem');
    const capturedSecret = join(root, 'secret.json');
    const kubectlArguments = join(root, 'kubectl-arguments.txt');
    mkdirSync(binRoot);

    const scalarSecret = 'scalar-secret=with-equals';
    const testingHarnessSecret = 'testing-harness-secret=with-equals';
    const databaseUrl = 'postgresql://user:password@postgres:5432/psfn?sslmode=disable';
    const privateKey = '-----BEGIN PRIVATE KEY-----\nline-one\nline-two\n-----END PRIVATE KEY-----\n';
    writeFileSync(assertionKey, privateKey, { mode: 0o600 });

    const kubectl = join(binRoot, 'kubectl');
    writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$KUBECTL_ARGUMENTS_FILE"
if [[ " $* " == *" create secret generic psfn-app "* ]]; then
  env_file=""
  mixed_input=0
  for argument in "$@"; do
    case "$argument" in
      --from-env-file=*) env_file="\${argument#*=}" ;;
      --from-file=*|--from-literal=*) mixed_input=1 ;;
    esac
  done
  if ((mixed_input)); then
    echo "from-env-file cannot be combined with from-file or from-literal" >&2
    exit 1
  fi
  [[ -n "$env_file" ]]
  [[ "$(stat -c '%a' "$env_file")" == "600" ]] || {
    echo "app Secret env file must use mode 0600" >&2
    exit 1
  }
  node -e '
    const fs = require("node:fs");
    const data = {};
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\\n")) {
      if (line.length === 0) continue;
      const separator = line.indexOf("=");
      if (separator < 1) process.exit(2);
      data[line.slice(0, separator)] =
        Buffer.from(line.slice(separator + 1), "utf8").toString("base64");
    }
    process.stdout.write(JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "psfn-app" },
      data,
    }));
  ' "$env_file"
  exit 0
fi
if [[ " $* " == *" apply -f - "* ]]; then
  cat >"$KUBECTL_CAPTURE_FILE"
  echo "secret/psfn-app configured"
  exit 0
fi
echo "unexpected kubectl arguments" >&2
exit 64
`);
    chmodSync(kubectl, 0o755);

    const script = readFileSync(scriptPath, 'utf8');
    const functionStart = script.indexOf('create_local_app_secret() {');
    const functionEnd = script.indexOf('\n}\n\nwrite_local_postgres_secret()', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = script.slice(functionStart, functionEnd + 2);
    const writerStart = script.indexOf('write_app_secret_env() {');
    const writerEnd = script.indexOf('\n}\n\ncapture_preserved_fleet_auth_credentials()', writerStart);
    expect(writerStart).toBeGreaterThanOrEqual(0);
    expect(writerEnd).toBeGreaterThan(writerStart);
    const writerSource = script.slice(writerStart, writerEnd + 2);
    const harness = join(root, 'run-create-local-app-secret.sh');
    writeFileSync(harness, `#!/usr/bin/env bash
set -euo pipefail
NAMESPACE=psfn-test
FLEET_AUTH_ASSERTION_PRIVATE_KEY_FILE="$ASSERTION_KEY_FILE"
SECRET_ENV_FILE=""
GATEWAY_SESSION_HMAC_KEY_VALUE=test-hmac-key
COMPANION_AUTH_TOKEN=test-companion-token
SESSION_INTEGRITY_AUTH_TOKEN=test-integrity-token
FLEET_AUTH_DISCORD_CLIENT_SECRET_VALUE=test-discord-secret
FLEET_AUTH_TOKEN_ENCRYPTION_KEY_VALUE=test-encryption-key
FLEET_AUTH_SESSION_PEPPER_VALUE=test-session-pepper
FLEET_AUTH_RECOVERY_CREDENTIAL_VALUE=test-recovery-credential
FLEET_AUTH_RUNTIME_DATABASE_URL_VALUE=postgresql://fleet-runtime
FLEET_AUTH_MIGRATION_DATABASE_URL_VALUE=postgresql://fleet-migration
FLEET_AUTH_BACKUP_DATABASE_URL_VALUE=postgresql://fleet-backup
COMPANION_DATABASE_URL_VALUE="$DATABASE_URL_FIXTURE"
SHARED_SCHEMA_MIGRATION_DATABASE_URL_VALUE=postgresql://shared-migration
prepare_gateway_credentials() { :; }
random_secret() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
}
${writerSource}
${functionSource}
create_local_app_secret
`);
    chmodSync(harness, 0o755);

    const result = spawnSync('bash', [harness], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        API_KEY: scalarSecret,
        TESTING_HARNESS_API_KEY: testingHarnessSecret,
        ASSERTION_KEY_FILE: assertionKey,
        DATABASE_URL_FIXTURE: databaseUrl,
        KUBECTL_ARGUMENTS_FILE: kubectlArguments,
        KUBECTL_CAPTURE_FILE: capturedSecret,
        OPENROUTER_API_KEY: '',
        PATH: `${binRoot}:${process.env.PATH}`,
        TMPDIR: root,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).not.toContain(scalarSecret);
    expect(result.stderr).not.toContain(scalarSecret);
    expect(result.stdout).not.toContain(testingHarnessSecret);
    expect(result.stderr).not.toContain(testingHarnessSecret);
    expect(result.stdout).not.toContain(privateKey);
    expect(result.stderr).not.toContain(privateKey);

    const args = readFileSync(kubectlArguments, 'utf8');
    expect(args).toContain('--from-env-file=');
    expect(args).not.toContain('--from-file=');
    expect(args).not.toContain('--from-literal=');
    expect(args).not.toContain(scalarSecret);
    expect(args).not.toContain(testingHarnessSecret);
    expect(args).not.toContain(privateKey);

    const secret = readJson(capturedSecret);
    expect(Buffer.from(secret.data.API_KEY, 'base64').toString('utf8')).toBe(scalarSecret);
    const testingHarnessApiKey = assertTestingHarnessSecret(secret);
    expect(testingHarnessApiKey).toBe(testingHarnessSecret);
    expect(Buffer.from(secret.data.OPENROUTER_API_KEY, 'base64').toString('utf8')).toBe('');
    expect(Buffer.from(secret.data.COMPANION_DEFAULT_DATABASE_URL, 'base64').toString('utf8'))
      .toBe(databaseUrl);
    expect(Buffer.from(
      secret.data.FLEET_AUTH_ASSERTION_PRIVATE_KEY,
      'base64',
    ).toString('utf8')).toBe(privateKey);

    const generatedResult = spawnSync('bash', [harness], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        API_KEY: scalarSecret,
        TESTING_HARNESS_API_KEY: '',
        ASSERTION_KEY_FILE: assertionKey,
        DATABASE_URL_FIXTURE: databaseUrl,
        KUBECTL_ARGUMENTS_FILE: kubectlArguments,
        KUBECTL_CAPTURE_FILE: capturedSecret,
        OPENROUTER_API_KEY: '',
        PATH: `${binRoot}:${process.env.PATH}`,
        TMPDIR: root,
      },
    });
    expect(generatedResult.status, generatedResult.stderr || generatedResult.stdout).toBe(0);
    const generatedSecret = readJson(capturedSecret);
    const generatedTestingHarnessApiKey = assertTestingHarnessSecret(generatedSecret);
    expect(generatedTestingHarnessApiKey).toMatch(/^[a-f0-9]{64}$/);
    expect(generatedTestingHarnessApiKey).not.toBe(
      Buffer.from(generatedSecret.data.ADMIN_TOKEN, 'base64').toString('utf8'),
    );
    expect(generatedResult.stdout).not.toContain(generatedTestingHarnessApiKey);
    expect(generatedResult.stderr).not.toContain(generatedTestingHarnessApiKey);
    expect(readFileSync(kubectlArguments, 'utf8')).not.toContain(generatedTestingHarnessApiKey);
    expect(readdirSync(root).filter(name => name.startsWith('psfn-artemis-secret.')))
      .toEqual([]);
  });

  it('discovers the fleet agent deployment used by the post-rollout validator', () => {
    const root = temporaryRoot();
    const binRoot = join(root, 'bin');
    mkdirSync(binRoot);
    const kubectl = join(binRoot, 'kubectl');
    writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" != *"get deployments"* ]]; then
  echo "unexpected kubectl arguments: $*" >&2
  exit 64
fi
selector=""
while (($# > 0)); do
  if [[ "$1" == "-l" ]]; then
    selector="$2"
    break
  fi
  shift
done
SELECTOR="$selector" node <<'NODE'
const deployments = [
  {
    metadata: {
      name: 'psfn-agent-${companionId}',
      labels: { 'psfn.io/fleet-target': 'registered' },
    },
  },
  {
    metadata: {
      name: 'psfn-unregistered-decoy',
      labels: { 'app.kubernetes.io/component': 'agent' },
    },
  },
];
const requirements = (process.env.SELECTOR ?? '').split(',').filter(Boolean).map(entry => {
  const separator = entry.indexOf('=');
  return [entry.slice(0, separator), entry.slice(separator + 1)];
});
const items = deployments.filter(deployment => requirements.every(
  ([key, value]) => deployment.metadata.labels[key] === value,
));
process.stdout.write(JSON.stringify({ items }));
NODE
`);
    chmodSync(kubectl, 0o755);

    const result = spawnSync('bash', [
      validatorPath,
      '--local',
      '--namespace', 'psfn-test',
      '--list-app-deployments',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binRoot}:${process.env.PATH}` },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(validatorPath, 'utf8')).toContain("-l 'psfn.io/fleet-target=registered'");
    expect(result.stdout.trim().split('\n')).toEqual([
      'psfn-gateway',
      'psfn-garden',
      `psfn-agent-${companionId}`,
    ]);
  });

  it('uses honestly labelled pod readiness for the fleet Garden TLS listener', () => {
    const validator = readFileSync(validatorPath, 'utf8');

    expect(validator).toContain('https-garden)');
    expect(validator).toContain('GARDEN_HEALTH_CHECK_LABEL="garden health (pod readiness)"');
    expect(validator).toContain("get pods -l 'app.kubernetes.io/component=garden'");
    expect(validator).toContain('condition.type === "Ready" && condition.status === "True"');
    expect(validator).toContain('http-garden)');
  });
});
