import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isRecord } from '../src/shared/utils/types.js';
import { extractContainerEnv, parseManifest } from './verify-chart-render.js';

const chart = resolve('deploy/helm/psfn');
const fixture = resolve('scripts/fixtures/helm-nonproduction-values.yaml');
const defaults = parse(readFileSync(join(chart, 'values.yaml'), 'utf8'));
const appName = 'psfn-render-fixture-app';
const postgresName = 'psfn-render-fixture-postgres';
const primary = '11111111-1111-4111-8111-111111111111';
const follower = '22222222-2222-4222-8222-222222222222';

function hub(ref = { name: 'external-voxta', key: 'auth-token' }) {
  return { enabled: true, textOnly: true,
    image: { repository: 'registry.example/psfn-hub', tag: '1.2.3' },
    identity: { satelliteId: 'hub-example', endpointId: 'endpoint-example', claimType: 'satellite.endpoint' },
    voxta: { enabled: true, authTokenSecretRef: ref } };
}

function fleet() {
  return { fleetAuth: { enabled: true, credentialEnv: [
    { name: 'FLEET_AUTH_CLIENT_SECRET', secretRef: { name: 'external-fleet', key: 'oauth-secret' } },
  ] }, ingress: { enabled: true, gateway: { enabled: true, host: 'gateway.example.test',
    path: '/', pathType: 'Prefix', tls: { enabled: true, secretName: 'gateway-tls' } } },
  bootstrap: { seedOwnerFiles: false },
  fleet: { enabled: true, companions: [
    { companionId: primary, postgresSchema: 'companion_main', authSecret: {} },
    { companionId: follower, postgresSchema: 'companion_other', databaseUrlSecretKey: 'follower-url',
      companionDataClaim: 'follower-data', workspaceClaim: 'follower-workspace',
      authSecret: { name: 'external-agent', sessionIntegrityKey: 'integrity', companionAuthKey: 'auth' } },
  ] }, runtime: { companionId: primary, companionDataDir: `/runtime/companions/${primary}`,
    characterCardPath: `/runtime/companions/${primary}/companion.json`, workspacePath: `/runtime/workspaces/personal/${primary}` } };
}

function render(values: unknown, inspect = false, mutate?: (path: string) => void, probeSource = true) {
  const directory = mkdtempSync(join(tmpdir(), 'helm-role-inventory-'));
  try {
    const target = inspect || mutate ? join(directory, 'chart') : chart;
    if (target !== chart) cpSync(chart, target, { recursive: true });
    if (mutate) mutate(target);
    if (inspect) {
      writeFileSync(join(target, 'templates/role-inventory.yaml'), `apiVersion: v1
kind: ConfigMap
metadata: {name: role-inventory}
data:
  inventory: {{ include "psfn.secretCredentialInventory" . | quote }}
---
${probeSource ? sourceReferenceProbe() : ''}`);
    }
    const path = join(directory, 'values.json');
    writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
    return spawnSync('helm', ['template', 'credential-test', target, '-f', fixture, '-f', path], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Exercise every literal Secret selector in template source, even inside disabled
// branches. Dynamic Fleet selectors retain their original iteration context.
// An unrecognised source shape fails this test instead of silently skipping it.
function sourceReferenceProbe() {
  const selectors = readdirSync(join(chart, 'templates')).flatMap(name => {
    const source = readFileSync(join(chart, 'templates', name), 'utf8');
    const matches = [...source.matchAll(/secretKeyRef:\s*\n\s+name: ([^\n]+)\n\s+key: ([^\n]+)/gu)];
    expect(matches.length, `${name}: every Secret selector must be exercised`).toBe(
      [...source.matchAll(/\bsecretKeyRef:/gu)].length,
    );
    const volumeSelectors = [...source.matchAll(/secret:\s*\n\s+secretName: ([^\n]+)\n\s+items:\s*\n\s+- key: ([^\n]+)/gu)];
    return [...matches, ...volumeSelectors].map(match => ({ name, secret: match[1]!, key: match[2]! }));
  });
  const env = selectors.map((selector, index) => {
    let block = `- name: SOURCE_${index}\n  valueFrom:\n    secretKeyRef:\n      name: ${selector.secret}\n      key: ${selector.key}\n`;
    if (block.includes('.secretRef.')) {
      return `{{ range .Values.fleetAuth.credentialEnv }}{{ if .secretRef }}\n${block}{{ end }}{{ end }}\n`;
    }
    if (block.includes('$authSecretName')) {
      return `{{ range .Values.fleet.companions }}
{{ $authSecretName := default (include "psfn.appSecretName" $) .authSecret.name }}
{{ $sessionIntegrityKey := default $.Values.secrets.keys.gatewaySessionIntegrityAuthToken .authSecret.sessionIntegrityKey }}
{{ $companionAuthKey := default $.Values.secrets.keys.gatewayCompanionAuthToken .authSecret.companionAuthKey }}
${block}{{ end }}\n`;
    }
    block = block.replaceAll('$root', '$');
    expect(block, `${selector.name}: source reference needs a coverage context`).not.toMatch(/\$[A-Za-z_]|\{\{\s*\.(?!Values\.)/u);
    return block;
  }).join('');
  return `apiVersion: v1\nkind: Pod\nmetadata: {name: source-reference-probe}\nspec:\n  containers:\n    - name: probe\n      image: registry.example/probe:1.2.3\n      env:\n${env.split('\n').map(line => `        ${line}`).join('\n')}`;
}

function missingReferences(manifest: string) {
  const objects = parseManifest(manifest);
  const diagnostic = objects.find(object => isRecord(object.metadata) && object.metadata.name === 'role-inventory');
  if (!isRecord(diagnostic?.data) || typeof diagnostic.data.inventory !== 'string') throw new Error('Missing physical role inventory');
  const inventory: unknown = JSON.parse(diagnostic.data.inventory);
  if (!isRecord(inventory)) throw new Error('Invalid physical role inventory');
  const missing: string[] = [];
  function check(name: unknown, key: unknown) {
    const tuple = `${String(name)}/${String(key)}`;
    if (typeof inventory[tuple] !== 'string') missing.push(tuple);
  }
  function visit(value: unknown) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isRecord(value)) return;
    if (isRecord(value.secretKeyRef)) check(value.secretKeyRef.name, value.secretKeyRef.key);
    if (isRecord(value.secret) && Array.isArray(value.secret.items)) {
      for (const item of value.secret.items) if (isRecord(item)) check(value.secret.secretName, item.key);
    }
    // cert-manager's generated private keys back the unfiltered TLS volumes.
    if (value.kind === 'Certificate' && isRecord(value.spec)) check(value.spec.secretName, 'tls.key');
    if (value.kind === 'Ingress' && isRecord(value.spec) && Array.isArray(value.spec.tls)) {
      for (const tls of value.spec.tls) if (isRecord(tls)) check(tls.secretName, 'tls.key');
    }
    Object.values(value).forEach(visit);
  }
  objects.forEach(visit);
  return missing;
}

function coverageValues() {
  return { satelliteHub: { ...hub(), deviceAssertion: { privateKeySecretRef: { name: 'external-device', key: 'private.pem' } } }, redis: { enabled: true, auth: { existingSecret: 'external-redis' } },
    hubDeviceAssertions: { auditPepperSecretRef: { name: 'external-audit', key: 'pepper' } },
    workloads: { gateway: { extraEnv: [{ name: 'CUSTOM_SECRET', valueFrom: { secretKeyRef: { name: 'external-custom', key: 'secret' } } }] } } };
}

describe('Helm physical credential role inventory', () => {
  it.each(['standalone', 'bootstrap-disabled', 'fleet', 'external-databases'])(
    'covers every rendered and source-derived credential selector with %s', scenario => {
      const values = coverageValues();
      const options = scenario === 'fleet' ? fleet()
        : scenario === 'bootstrap-disabled' ? { runtimeBootstrap: { enabled: false } }
          : scenario === 'external-databases' ? { postgres: { external: { enabled: true, databaseUrlSecret: { name: 'external-db', key: 'url' } } },
            redis: { enabled: true, mode: 'external', external: { url: 'rediss://cache.example.test:6380', passwordSecret: { name: 'external-cache', key: 'password' } } } }
            : {};
      // Inactive internal database branches are probed by the standalone case.
      const result = render({ ...values, ...options }, true, undefined, scenario !== 'external-databases');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(missingReferences(result.stdout)).toEqual([]);
    },
  );

  it('detects a workload reference omitted from the authoritative inventory', () => {
    const result = render(coverageValues(), true, target => {
      const path = join(target, 'templates/_secret-key-validation.tpl');
      writeFileSync(path, readFileSync(path, 'utf8').replace(/^.*\(dict "label" "satelliteHub.voxta.authTokenSecretRef".*\n/mu, ''));
    });
    expect(result.status).toBe(0);
    expect(missingReferences(result.stdout)).toContain('external-voxta/auth-token');
  });

  it.each(Object.keys(defaults.secrets.keys).filter(role => role !== 'voxtaAuthToken'))(
    'rejects Voxta reuse of the effective app %s tuple after key overrides', role => {
      const key = 'private-key-name-sentinel';
      const result = render({ satelliteHub: hub({ name: appName, key }), secrets: { keys: { [role]: key } } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('credential role');
      expect(result.stderr).toContain('voxtaAuthToken');
      expect(result.stdout + result.stderr).not.toContain(key);
      expect(result.stdout).toBe('');
    },
  );

  it.each([
    { name: postgresName, key: 'postgres-password' },
    { name: postgresName, key: 'postgres-database-url' },
    { name: postgresName, key: 'postgres-admin-database-url' },
    { name: postgresName, key: 'shared-migration-database-url' },
    { name: postgresName, key: 'companion-database-password' },
    { name: 'external-redis', key: 'redis-password' },
    { name: 'external-agent', key: 'integrity' },
    { name: 'external-fleet', key: 'oauth-secret' },
    { name: 'external-audit', key: 'pepper' },
    { name: 'external-custom', key: 'secret' },
    { name: 'external-embedding', key: 'embedding' },
    { name: 'external-device', key: 'private.pem' },
    { name: 'gateway-tls', key: 'tls.key' },
    { name: 'credential-test-psfn-gateway-rpc-tls', key: 'tls.key' },
  ])('rejects Voxta sharing incompatible physical role $name/$key', ref => {
    const result = render({ ...coverageValues(), ...fleet(), satelliteHub: { ...hub(ref),
      deviceAssertion: { privateKeySecretRef: { name: 'external-device', key: 'private.pem' } } },
    embeddings: { api: { apiKeySecret: { name: 'external-embedding', key: 'embedding' } } } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('credential role');
    expect(result.stdout).toBe('');
  });

  it.each(['postgres-url', 'redis-password', 'redis-ca'])(
    'rejects Voxta aliases of overridden external %s tuples', role => {
      const ref = { name: 'external-subordinate', key: 'custom-private-key' };
      const settings = role === 'postgres-url'
        ? { postgres: { external: { enabled: true, databaseUrlSecret: ref } } }
        : { redis: { enabled: true, mode: 'external', external: { url: 'rediss://cache.example.test:6380',
          passwordSecret: role === 'redis-password' ? ref : { name: 'external-cache', key: 'password' },
          tls: { enabled: true, ...(role === 'redis-ca' ? { caSecret: ref } : {}) } } } };
      const result = render({ ...settings, satelliteHub: hub(ref) });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('credential role');
      expect(result.stdout + result.stderr).not.toContain(ref.key);
      expect(result.stdout).toBe('');
    },
  );

  it.each(['name', 'key'])('rejects malformed Voxta Secret %s without leaking input', field => {
    const sentinel = 'private/input-sentinel';
    const result = render({ satelliteHub: hub({ name: 'external-voxta', key: 'auth-token', [field]: sentinel }) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('satelliteHub.voxta.authTokenSecretRef');
    expect(result.stdout + result.stderr).not.toContain(sentinel);
  });

  it.each(['gateway', 'agent', 'garden', 'satelliteHub'])('rejects %s extraEnv credential aliases', surface => {
    const extraEnv = [{ name: 'CUSTOM_SECRET', valueFrom: { secretKeyRef: { name: appName, key: 'ADMIN_TOKEN' } } }];
    const result = render(surface === 'satelliteHub' ? { satelliteHub: { ...hub(), extraEnv } }
      : { workloads: { [surface]: { extraEnv } } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('credential role');
    expect(result.stdout).toBe('');
  });

  it('rejects enabled Voxta without a token reference even when device signing is configured', () => {
    const result = render({ satelliteHub: { ...hub({ name: '', key: '' }), deviceRegistry: { enabled: true, devices: [{ deviceId: 'example-device' }] },
    deviceAssertion: { enabled: true, kid: 'example-key', audience: 'https://gateway.example.test',
      privateKeySecretRef: { name: 'external-device', key: 'private.pem' } } } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('satelliteHub.voxta.enabled requires');
  });

  it('rejects the reviewed fixture ADMIN_TOKEN bypass', () => {
    const result = render({ satelliteHub: hub({ name: appName, key: 'ADMIN_TOKEN' }) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('satelliteHub.voxta.authTokenSecretRef');
  });

  it.each(['internal', 'external', 'disabled'])(
    'rejects effective %s database URL overrides reusing administrator authority', scenario => {
      const result = render({ postgres: { enabled: scenario !== 'disabled',
        auth: { existingSecret: appName, keys: { databaseUrl: 'ADMIN_TOKEN' } },
        ...(scenario === 'external' ? { external: { enabled: true, databaseUrlSecret: { name: appName, key: 'ADMIN_TOKEN' } } } : {}) },
      runtimeBootstrap: { enabled: false } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('credential role');
      expect(result.stdout).toBe('');
    },
  );

  it('rejects follower database URL overrides reusing a password credential', () => {
    const values = fleet();
    values.fleet.companions[1]!.databaseUrlSecretKey = 'postgres-password';
    expect(render(values).status).not.toBe(0);
  });

  it('rejects a chart-owned Voxta value reusing the composed PostgreSQL URL without disclosure', () => {
    const password = randomBytes(32).toString('hex');
    const databaseUrl = `postgresql://postgres:${password}@credential-test-psfn-postgres:5432/psfn`;
    const values = Object.fromEntries(['apiKey', 'adminToken', 'gatewaySessionHmacKey', 'gatewaySessionIntegrityAuthToken',
      'gatewayCompanionAuthToken', 'backupEncryptionKey', 'satelliteHubApiKey'].map(role => [role, randomBytes(32).toString('hex')]));
    const result = render({ secrets: { create: true, existingSecret: '', values: { ...values, voxtaAuthToken: databaseUrl } },
      postgres: { auth: { existingSecret: '', password } },
      satelliteHub: hub({ name: 'credential-test-psfn-app', key: 'VOXTA_AUTH_TOKEN' }) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('postgres database URL credential must not reuse');
    expect(result.stdout + result.stderr).not.toContain(databaseUrl);
    expect(result.stdout + result.stderr).not.toContain(password);
  });

  it.each(['missing-value', 'unmapped-key'])('rejects %s in a chart-owned Voxta reference', scenario => {
    const values = Object.fromEntries(['apiKey', 'adminToken', 'gatewaySessionHmacKey', 'gatewaySessionIntegrityAuthToken',
      'gatewayCompanionAuthToken', 'backupEncryptionKey', 'satelliteHubApiKey', 'voxtaAuthToken']
      .map(role => [role, randomBytes(32).toString('hex')]));
    if (scenario === 'missing-value') values.voxtaAuthToken = '';
    const key = scenario === 'unmapped-key' ? 'unmapped-voxta' : 'VOXTA_AUTH_TOKEN';
    const result = render({ secrets: { create: true, existingSecret: '', values },
      satelliteHub: hub({ name: 'credential-test-psfn-app', key }) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('satelliteHub.voxta.authTokenSecretRef must select');
    for (const value of Object.values(values).filter(Boolean)) expect(result.stdout + result.stderr).not.toContain(value);
  });

  it.each(['distinct-external', 'same-spelling-different-secret', 'existing-app', 'chart-owned'])(
    'preserves %s dedicated Voxta credentials', scenario => {
      const token = randomBytes(32).toString('hex');
      const ref = scenario === 'same-spelling-different-secret' ? { name: 'external-voxta', key: 'ADMIN_TOKEN' }
        : scenario === 'distinct-external' ? { name: 'external-voxta', key: 'auth-token' }
          : { name: scenario === 'chart-owned' ? 'credential-test-psfn-app' : appName, key: 'custom-voxta-key' };
      const values = scenario === 'chart-owned'
        ? { secrets: { create: true, existingSecret: '', keys: { voxtaAuthToken: ref.key }, values: {
          ...Object.fromEntries(['apiKey', 'adminToken', 'gatewaySessionHmacKey', 'gatewaySessionIntegrityAuthToken',
            'gatewayCompanionAuthToken', 'backupEncryptionKey', 'satelliteHubApiKey'].map(role => [role, randomBytes(32).toString('hex')])), voxtaAuthToken: token } } }
        : { secrets: { keys: { voxtaAuthToken: 'custom-voxta-key' } } };
      const result = render({ ...values, satelliteHub: hub(ref) });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const env = extractContainerEnv(result.stdout, 'credential-test-psfn-satellite-hub', 'satellite-hub');
      expect(env.get('VOXTA_AUTH_TOKEN')?.secretKeyRef).toEqual(ref);
    },
  );
});
