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
import { verifyStartupOwnerFiles } from '../../src/system/config/startup-owner-files.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const scriptPath = join(repoRoot, 'scripts/ops/setup-local-artemis-shakedown.sh');
const validatorPath = join(repoRoot, 'scripts/ops/validate-kube-rollout.sh');
const companionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerDiscordId = '123456789012345678';
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
      role: 'owner',
    }]);
    expect(fleetAuth.accountRosterSatisfiesStepUp).toBe(true);
    expect(fleetAuth.canonicalOrigin).toBe('https://psfn-gateway.local');
    expect(fleetAuth.hubDeviceAssertions.audience).toBe('https://psfn-gateway.local');
    expect(fleetAuth.verifierKeys[0].kid).not.toBe('replace-before-enable');

    expect(readJson(join(outputRoot, 'companion-data/companion.json')).data.name)
      .toBe('Test Artemis');
    for (const owner of ['capability-tier', 'scheduler', 'charge-policy', 'skills']) {
      expect(readJson(join(outputRoot, `companion-data/${owner}.json`))).toBeTruthy();
      expect(() => readFileSync(join(outputRoot, `system-data/${owner}.json`), 'utf8')).toThrow();
    }
    expect(readFileSync(join(outputRoot, 'fleet-auth-assertion-private.pem'), 'utf8'))
      .toContain('BEGIN PRIVATE KEY');
  });

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
    delete fleetAuth.accountRosterSatisfiesStepUp;
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
      accountRosterSatisfiesStepUp: true,
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
    expect(script).toContain('ALTER ROLE shared_schema_migration WITH LOGIN NOINHERIT');
    expect(script).toContain('CONNECTION LIMIT 60');
    expect(script).toContain('\\connect psfn\nCREATE SCHEMA IF NOT EXISTS extensions');
    expect(script).toContain('ALTER EXTENSION vector SET SCHEMA extensions');
    expect(script).toContain('CREATE SCHEMA companion_default AUTHORIZATION companion_default_runtime');
    expect(script).toContain(
      'provision_fleet_auth_database_roles\nreplace_postgres_runtime_database_url\ncreate_local_app_secret',
    );
    expect(script).toContain('kind: Certificate');
    expect(script).not.toContain('PSFN_MULTI_COMPANION');
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
});
