import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractContainerEnv } from './verify-chart-render.js';

// Only the Kubernetes/cert-manager infrastructure is substituted. The public
// lifecycle executable, cryptographic generation and Helm renderer are real.
const realHelm = spawnSync('which', ['helm'], { encoding: 'utf8' }).stdout.trim();
const kubernetesBoundary = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const dir = process.env.CREDENTIAL_TEST_ROOT;
if (args.includes('get') && args.includes('secret')) {
  if (process.env.CREDENTIAL_TEST_SCENARIO === 'read-failure') { process.stderr.write('private infrastructure failure'); process.exit(1); }
  if (process.env.CREDENTIAL_TEST_SCENARIO === 'bad-json') { process.stdout.write('{"private":"' + process.env.CREDENTIAL_TEST_SENTINEL); process.exit(0); }
  const name = args[args.indexOf('secret') + 1]; const file = path.join(dir, name + '.json');
  if (!fs.existsSync(file)) { process.stdout.write(''); process.exit(args.includes('--ignore-not-found') ? 0 : 1); }
  const data = JSON.parse(fs.readFileSync(file));
  process.stdout.write(JSON.stringify({ data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, Buffer.from(v).toString('base64')])) }));
} else if (args.includes('apply')) {
  const object = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (object.kind === 'Secret' && process.env.CREDENTIAL_TEST_SCENARIO === 'apply-failure') { process.stderr.write(JSON.stringify(object)); process.exit(1); }
  if (object.kind === 'Secret') fs.writeFileSync(path.join(dir, object.metadata.name + '.json'), JSON.stringify(object.stringData));
} else if (args.includes('create')) process.stdout.write(JSON.stringify({apiVersion:'v1',kind:'Namespace',metadata:{name:'credential-test'}}));
`;
const helmBoundary = `#!/usr/bin/env node
const cp = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'get') process.exit(1);
if (args[0] === 'upgrade' && args[2] === 'credential-test') {
  const settings = [];
  for (let i = 4; i < args.length; i++) if (['--set', '--set-string', '--set-json'].includes(args[i])) settings.push(args[i], args[++i]);
  const result = cp.spawnSync(process.env.CREDENTIAL_TEST_HELM, ['template', 'credential-test', args[3], ...settings], {encoding:'utf8'});
  fs.writeFileSync(path.join(process.env.CREDENTIAL_TEST_ROOT, 'render-result.json'), JSON.stringify({ ...result, settings }));
  process.stderr.write('Stopped after real Helm rendering at the external install boundary'); process.exit(43);
}
`;

function lifecycle(existing: Record<string, Record<string, string>> = {}, scenario = '') {
  const root = mkdtempSync(join(tmpdir(), 'psfn-credential-lifecycle-'));
  const bin = join(root, 'bin'); const system = join(root, 'system'); const companion = join(root, 'companion', 'main');
  for (const dir of [bin, system, companion]) mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(existing)) writeFileSync(join(root, `${name}.json`), JSON.stringify(data));
  for (const name of ['settings', 'models', 'trust-policy', 'intake-policy', 'backup', 'mcp-servers', 'automata-policy', 'places', 'runtime-prompt-layers']) {
    writeFileSync(join(system, `${name}.json`), '{}');
  }
  writeFileSync(join(system, 'companions.json'), JSON.stringify({ postgres: { sharedMigrationRole: 'shared_schema_migration' }, companions: [{ companionId: '11111111-1111-4111-8111-111111111111', postgresSchema: 'companion_main', postgresRole: 'companion_main_runtime' }] }));
  writeFileSync(join(system, 'providers.json'), JSON.stringify({ providers: [{ enabled: true, apiKeyRef: { kind: 'env', envName: 'CREDENTIAL_TEST_PROVIDER' } }] }));
  for (const name of ['companion', 'scheduler', 'capability-tier', 'charge-policy', 'skills', 'partner-affect-shadow']) writeFileSync(join(companion, `${name}.json`), '{}');
  writeFileSync(join(bin, 'kubectl'), kubernetesBoundary, { mode: 0o700 });
  writeFileSync(join(bin, 'helm'), helmBoundary, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYSTEM_DATA_DIR: system,
      COMPANION_DATA_DIR: join(root, 'companion'), PSFN_KUBE_CONTEXT: 'credential-test', PSFN_HELM_RELEASE: 'credential-test',
      PSFN_HELM_NAMESPACE: 'credential-test', PSFN_IMAGE: 'registry.example/psfn:1.2.3',
      ADMIN_PUBLIC_ORIGIN: 'https://garden.example.test', ADMIN_TRUSTED_PROXY_ADDRESSES: '192.0.2.0/24',
      CREDENTIAL_TEST_ROOT: root, CREDENTIAL_TEST_HELM: realHelm,
      CREDENTIAL_TEST_SCENARIO: scenario, CREDENTIAL_TEST_SENTINEL: 'private-response-sentinel-0123456789',
      CREDENTIAL_TEST_PROVIDER: existing['credential-test-runtime-secrets']?.['provider-api-key'] ?? randomBytes(32).toString('hex') };
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/helm-lifecycle.ts'), 'up'], {
    encoding: 'utf8', env,
  });
  return { root, result, env, read: (name: string) => JSON.parse(readFileSync(join(root, `${name}.json`), 'utf8')) as Record<string, string>,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('public Helm lifecycle credential staging', () => {
  it('forwards structured Helm settings to the real renderer without dropping key mappings', () => {
    const run = lifecycle();
    try {
      const setting = 'secrets.keys={"apiKey":"STRUCTURED_API_KEY","adminToken":"STRUCTURED_ADMIN_TOKEN"}';
      spawnSync(join(run.root, 'bin', 'helm'), ['upgrade', '--install', 'credential-test', resolve('deploy/helm/psfn'),
        '--set', 'secrets.create=false', '--set-string', 'secrets.existingSecret=external-app',
        '--set-string', 'postgres.auth.existingSecret=external-postgres', '--set-json', setting,
        '--set-string', 'gardenBrowser.publicOrigin=https://garden.example.test',
        '--set-json', 'gardenBrowser.trustedProxyAddresses=["192.0.2.0/24"]'], {
        env: run.env, encoding: 'utf8',
      });
      const result = JSON.parse(readFileSync(join(run.root, 'render-result.json'), 'utf8'));
      expect(result.status).toBe(0);
      const env = extractContainerEnv(result.stdout, 'credential-test-psfn-gateway', 'gateway');
      expect(env.get('API_KEY')?.secretKeyRef?.key).toBe('STRUCTURED_API_KEY');
      expect(env.get('ADMIN_TOKEN')?.secretKeyRef?.key).toBe('STRUCTURED_ADMIN_TOKEN');
      expect(result.settings).toContain(setting);
    } finally { run.cleanup(); }
  });
  it('generates independent random credentials and preserves them exactly on upgrade through real Helm', () => {
    const first = lifecycle();
    try {
      const app = first.read('credential-test-runtime-secrets');
      const postgres = first.read('credential-test-postgres-secrets');
      const values = [app.API_KEY, app.ADMIN_TOKEN, app.GATEWAY_SESSION_HMAC_KEY, app.PSFN_BACKUP_ENCRYPTION_KEY,
        postgres['postgres-password'], postgres['companion-database-password'], postgres['shared-migration-database-password']];
      expect(values.every(value => /^[a-f0-9]{64}$/u.test(value!))).toBe(true);
      expect(new Set(values).size).toBe(values.length);
      const render = JSON.parse(readFileSync(join(first.root, 'render-result.json'), 'utf8'));
      expect(render.status).toBe(0);
      expect(first.result.stdout + first.result.stderr).not.toContain(app.ADMIN_TOKEN);
      const upgrade = lifecycle({ 'credential-test-runtime-secrets': app, 'credential-test-postgres-secrets': postgres });
      try {
        expect(upgrade.read('credential-test-runtime-secrets')).toEqual(app);
        expect(upgrade.read('credential-test-postgres-secrets')).toEqual(postgres);
      } finally { upgrade.cleanup(); }
    } finally { first.cleanup(); }
  });

  it('refuses an existing weak credential without rotating it or leaking the value', () => {
    const value = 'CHANGE_ME_existing-private-credential-0123456789';
    const run = lifecycle({ 'credential-test-runtime-secrets': { API_KEY: value } });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toMatch(/credential/u);
      expect(run.result.stdout + run.result.stderr).not.toContain(value);
      expect(run.read('credential-test-runtime-secrets')).toEqual({ API_KEY: value });
    } finally { run.cleanup(); }
  });

  it('retains valid PostgreSQL passwords with URI delimiters without changing database credentials', () => {
    const password = `${randomBytes(32).toString('hex')}:@/#?%&=`;
    const run = lifecycle({ 'credential-test-postgres-secrets': { 'postgres-password': password } });
    try {
      const postgres = run.read('credential-test-postgres-secrets');
      expect(postgres['postgres-password']).toBe(password);
      expect(decodeURIComponent(new URL(postgres['postgres-admin-database-url']!).password)).toBe(password);
    } finally { run.cleanup(); }
  });

  it.each(['read-failure', 'bad-json', 'apply-failure'])('fails closed on %s without exposing Kubernetes response data', scenario => {
    const token = randomBytes(32).toString('hex');
    const run = lifecycle({ 'credential-test-runtime-secrets': { API_KEY: token } }, scenario);
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toMatch(/credentials|suppressed/u);
      expect(run.result.stdout + run.result.stderr).not.toContain(token);
      expect(run.result.stdout + run.result.stderr).not.toContain('private-response-sentinel');
      expect(run.read('credential-test-runtime-secrets')).toEqual({ API_KEY: token });
    } finally { run.cleanup(); }
  });
});
