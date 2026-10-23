import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMap, isScalar, parse, parseAllDocuments } from 'yaml';
import { extractContainerEnv, findContainer, parseManifest } from './verify-chart-render.js';
import { isRecord } from '../src/shared/utils/types.js';

const chart = resolve('deploy/helm/psfn');
const keyMappings: Record<string, string> = parse(readFileSync(join(chart, 'values.yaml'), 'utf8')).secrets.keys;
// Derive the regression cases from actual bindings, so a new chart-managed
// variable cannot silently escape the credential-name authority check.
const literalManagedEnvNames = [...new Set(readdirSync(join(chart, 'templates'))
  .filter(name => /\.(?:ya?ml|tpl)$/u.test(name))
  .flatMap(name => [...readFileSync(join(chart, 'templates', name), 'utf8')
    .matchAll(/^\s*- name: ([A-Z][A-Z0-9_]*)\s*$/gmu)].map(match => match[1]!)))];
const securitySensitiveEnvNames = ['ADMIN_PUBLIC_ORIGIN', 'ADMIN_TRUSTED_PROXY_ADDRESSES', 'ADMIN_ALLOW_INSECURE',
  'ALLOW_INSECURE_LOCAL_API', 'API_TRUSTED_PROXY_CLIENT_CERT_TOKEN', 'GATEWAY_SESSION_HMAC_KEYS',
  'GATEWAY_SESSION_HMAC_ACTIVE_VERSION', 'POSTGRES_DATABASE_URL_FD', 'PSFN_SHARED_MIGRATION_DATABASE_URL',
  'HUB_DEVELOPER_MODE', 'HUB_ALLOWED_ORIGINS', 'VOXTA_FACADE_ENABLED', 'VOXTA_AUTH_TOKEN',
  'VOXTA_AUTH_USERNAME', 'VOXTA_AUTH_PASSWORD', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD',
  'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'PATH', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE',
  'SSLKEYLOGFILE', 'EIDOVERSE_JOIN_TOKEN'];
const roles = ['apiKey', 'adminToken', 'gatewaySessionHmacKey', 'gatewaySessionIntegrityAuthToken',
  'gatewayCompanionAuthToken', 'backupEncryptionKey', 'satelliteHubApiKey', 'satelliteHubControlToken',
  'homeAssistantToken', 'eidoverseJoinToken', 'providerApiKey', 'openRouterApiKey', 'openAiApiKey',
  'embeddingApiKey', 'hfToken', 'discordToken', 'deepgramApiKey', 'elevenLabsApiKey', 'falApiKey', 'ntfyToken'];

function render(values: unknown, command = 'template') {
  const directory = mkdtempSync(join(tmpdir(), 'helm-credentials-'));
  try {
    const path = join(directory, 'values.json');
    writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
    return spawnSync('helm', [command, 'credential-test', chart, '-f', path], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validValues() {
  return {
    secrets: { values: Object.fromEntries(roles.map(role => [role, randomBytes(32).toString('hex')])) },
    postgres: { auth: { password: randomBytes(32).toString('hex') } },
    redis: { enabled: true, auth: { password: randomBytes(32).toString('hex') } },
  };
}

function appSecretEntries(manifest: string): Array<[string, string]> {
  // Preserve duplicate YAML pairs: converting straight to an object would
  // silently discard precisely the credential overwrite this test detects.
  const secret = parseAllDocuments(manifest, { uniqueKeys: false }).find(document =>
    document.get('kind') === 'Secret' && document.getIn(['metadata', 'name']) === 'credential-test-psfn-app');
  const data = secret?.get('stringData', true);
  if (!isMap(data)) throw new Error('Expected the rendered application Secret data');
  return data.items.map(pair => {
    if (!isScalar(pair.key) || !isScalar(pair.value)) throw new Error('Expected scalar Secret data entries');
    return [String(pair.key.value), String(pair.value.value)];
  });
}

function hubValues() {
  return {
    enabled: true, textOnly: true,
    image: { repository: 'registry.example/psfn-hub', tag: '1.2.3' },
    identity: { satelliteId: 'hub-example', endpointId: 'endpoint-example', claimType: 'satellite.endpoint' },
    eidoverse: { enabled: true, command: '/usr/local/bin/eidoverse-mcp', args: ['--stdio'],
      worldUrl: 'wss://world.example.net/socket', worldName: 'demo-world', agentName: 'companion',
      egressCIDRs: ['192.0.2.30/32'], egressPort: 443 },
  };
}

function fleetAuthValues(credentialEnv: unknown[]) {
  return { fleetAuth: { enabled: true, credentialEnv },
    ingress: { enabled: true, gateway: { enabled: true, host: 'gateway.example.test',
      path: '/', pathType: 'Prefix', tls: { enabled: true, secretName: 'gateway-tls' } } } };
}

describe('Helm credential installation boundary', () => {
  it('rejects direct installation using production defaults without rendering credentials', () => {
    const result = spawnSync('helm', ['template', 'credential-test', chart], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/credential|secrets.existingSecret/u);
    expect(result.stdout).toBe('');
  });

  it('rejects a real Helm client install with production defaults', () => {
    const result = spawnSync('helm', ['install', 'credential-test', chart, '--dry-run=client', '--kubeconfig', '/dev/null'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('credential must be');
    expect(result.stdout).toBe('');
  });

  it('lints only with the explicit non-production external-secret fixture', () => {
    const result = spawnSync('helm', ['lint', chart, '-f', 'scripts/fixtures/helm-nonproduction-values.yaml'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  it('renders generated role-distinct credentials', () => {
    expect(render(validValues()).status).toBe(0);
  });

  it('preserves valid PostgreSQL passwords containing URI delimiters', () => {
    const values = validValues();
    const password = `${randomBytes(32).toString('hex')}:@/#?%&=`;
    values.postgres.auth.password = password;
    const result = render(values);
    expect(result.status).toBe(0);
    const secret = parseManifest(result.stdout).find(object => isRecord(object.stringData)
      && object.stringData['postgres-password'] === password);
    const data = isRecord(secret?.stringData) ? secret.stringData : {};
    expect(decodeURIComponent(new URL(String(data['postgres-database-url'])).password)).toBe(password);
  });

  it.each(roles)('rejects placeholder, short and repeated %s without disclosing its value', role => {
    for (const value of ['CHANGE_ME_published-credential-0123456789', 'short-private-value', 'a'.repeat(64), '0123456789abcdef'.repeat(4)]) {
      const values = validValues();
      values.secrets.values[role] = value;
      const result = render(values);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it('rejects credential reuse across all chart-controlled roles', () => {
    const values = validValues();
    values.secrets.values.adminToken = values.secrets.values.apiKey!;
    expect(render(values).status).not.toBe(0);
    const postgres = validValues();
    postgres.postgres.auth.password = postgres.secrets.values.backupEncryptionKey!;
    expect(render(postgres).status).not.toBe(0);
  });

  it.each(roles)('rejects %s reused by another chart-controlled role', role => {
    const values = validValues();
    values.secrets.values[role === 'apiKey' ? 'adminToken' : role] = values.secrets.values.apiKey!;
    expect(render(values).status).not.toBe(0);
  });

  it.each(['postgres', 'redis'] as const)('rejects weak %s passwords', role => {
    for (const password of ['CHANGE_ME_private-database-credential', 'short', 'abcd'.repeat(16)]) {
      const values = validValues();
      values[role].auth.password = password;
      const result = render(values);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(password);
    }
  });

  it('cannot disable validation with allowMissingRequired or create=false', () => {
    expect(render({ secrets: { allowMissingRequired: true } }).status).not.toBe(0);
    expect(render({ secrets: { create: false } }).status).not.toBe(0);
  });

  it('renders an external-secret installation without materializing any Secret', () => {
    const result = render({
      secrets: { create: false, existingSecret: 'external-app' },
      postgres: { auth: { existingSecret: 'external-postgres' } },
      redis: { enabled: true, auth: { existingSecret: 'external-redis' } },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/^kind: Secret$/mu);
  });

  it('rejects invalid existing Secret references and aliased role keys', () => {
    expect(render({ secrets: { existingSecret: ' ' }, postgres: { auth: { existingSecret: 'external-db' } } }).status).not.toBe(0);
    const values = validValues();
    expect(render({ ...values, secrets: { ...values.secrets, keys: { apiKey: 'SAME_KEY', adminToken: 'SAME_KEY' } } }).status).not.toBe(0);
  });

  it('prevents an optional provider mapping from overwriting the rendered administrator credential', () => {
    const values = validValues();
    const result = render({ ...values, secrets: { ...values.secrets, keys: { providerApiKey: keyMappings.adminToken } } });
    if (result.status === 0) {
      const entries = appSecretEntries(result.stdout);
      const administrator = entries.filter(([key]) => key === keyMappings.adminToken);
      expect(administrator.length === 1 && administrator[0]?.[1] === values.secrets.values.adminToken).toBe(true);
      expect(new Set(entries.map(([key]) => key)).size === entries.length).toBe(true);
    }
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('distinct Secret data key');
    expect(result.stderr).not.toContain(values.secrets.values.adminToken);
    expect(result.stderr).not.toContain(values.secrets.values.providerApiKey);
  });

  it.each(Object.keys(keyMappings))('rejects cross-role aliases for secrets.keys.%s, including external-secret references', role => {
    const target = role === 'adminToken' ? keyMappings.apiKey : keyMappings.adminToken;
    const values = validValues();
    values.secrets.values.discordBotId = '123456789012345678';
    values.secrets.values.extraSatelliteApiKeys = randomBytes(32).toString('hex');
    const keys = { [role]: target };
    expect(render({ ...values, secrets: { ...values.secrets, keys } }).status).not.toBe(0);
    expect(render({
      secrets: { create: false, existingSecret: 'external-app', keys },
      postgres: { auth: { existingSecret: 'external-postgres' } },
    }).status).not.toBe(0);
  });

  it.each(Object.keys(keyMappings))('rejects removed secrets.keys.%s even with an existing Secret', role => {
    const result = render({ secrets: { create: false, existingSecret: 'external-app', keys: { [role]: null } },
      postgres: { auth: { existingSecret: 'external-postgres' } } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Secret data key');
  });

  it('preserves every distinct custom mapping and the aggregated satellite data in the rendered Secret', () => {
    const values = validValues();
    const keys = Object.fromEntries(Object.keys(keyMappings).map(role => [role, `custom-${role}`]));
    values.secrets.values.discordBotId = '123456789012345678';
    values.secrets.values.extraSatelliteApiKeys = randomBytes(32).toString('hex');
    const result = render({ ...values, secrets: { ...values.secrets, keys } });
    expect(result.status).toBe(0);
    const entries = appSecretEntries(result.stdout);
    const expected = roles.map(role => [keys[role], values.secrets.values[role]]);
    expected.push([keys.discordBotId, values.secrets.values.discordBotId]);
    expected.push([keys.satelliteApiKeys, `${values.secrets.values.satelliteHubApiKey},${values.secrets.values.extraSatelliteApiKeys}`]);
    expect(entries.length).toBe(expected.length);
    expect(new Set(entries.map(([key]) => key)).size).toBe(entries.length);
    expect(expected.every(([key, value]) => entries.some(entry => entry[0] === key && entry[1] === value))).toBe(true);
    const env = extractContainerEnv(result.stdout, 'credential-test-psfn-gateway', 'gateway');
    expect(env.get('TESTING_HARNESS_API_KEY')?.secretKeyRef?.key).toBe(keys.testingHarnessApiKey);
  });

  it('prevents provider.envName from duplicating the gateway administrator environment binding', () => {
    const result = render({ ...validValues(), provider: { envName: 'ADMIN_TOKEN' } });
    if (result.status === 0) {
      const gateway = findContainer(result.stdout, 'credential-test-psfn-gateway', 'gateway');
      const env = Array.isArray(gateway?.env) ? gateway.env : [];
      expect(env.filter(entry => isRecord(entry) && entry.name === 'ADMIN_TOKEN').length).toBe(1);
    }
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('managed environment');
  });

  it.each([...new Set([...literalManagedEnvNames, ...securitySensitiveEnvNames])])('rejects provider credential aliases to managed environment %s', name => {
    const result = render({ ...validValues(), provider: { envName: name } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('managed environment');
  });

  it('accepts a distinct custom provider environment name through an existing Secret', () => {
    const result = render({ provider: { envName: 'CUSTOM_PROVIDER_CREDENTIAL' },
      secrets: { create: false, existingSecret: 'external-app', keys: { providerApiKey: 'custom-provider-key' } },
      postgres: { auth: { existingSecret: 'external-postgres' } } });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/^kind: Secret$/mu);
    const env = extractContainerEnv(result.stdout, 'credential-test-psfn-gateway', 'gateway');
    expect(env.get('CUSTOM_PROVIDER_CREDENTIAL')?.secretKeyRef).toEqual({ name: 'external-app', key: 'custom-provider-key' });
  });

  it('rejects a matching Eidoverse tokenRef and Secret key when they shadow a managed Hub environment name', () => {
    const values = validValues();
    const result = render({ ...values, secrets: { ...values.secrets, keys: { eidoverseJoinToken: 'PSFN_API_KEY' } },
      satelliteHub: { ...hubValues(), eidoverse: { ...hubValues().eidoverse, tokenRef: 'PSFN_API_KEY' } } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('managed environment');
  });

  it('preserves a custom Eidoverse tokenRef that matches its distinct Secret data key', () => {
    const values = validValues();
    const result = render({ ...values, secrets: { ...values.secrets, keys: { eidoverseJoinToken: 'CUSTOM_WORLD_CREDENTIAL' } },
      satelliteHub: { ...hubValues(), eidoverse: { ...hubValues().eidoverse, tokenRef: 'CUSTOM_WORLD_CREDENTIAL' } } });
    expect(result.status).toBe(0);
    const env = extractContainerEnv(result.stdout, 'credential-test-psfn-satellite-hub', 'satellite-hub');
    expect(env.get('CUSTOM_WORLD_CREDENTIAL')?.secretKeyRef?.key).toBe('CUSTOM_WORLD_CREDENTIAL');
  });

  it('rejects a Fleet Auth credential environment entry that shadows administrator authority', () => {
    const result = render({ ...validValues(), ...fleetAuthValues([
      { name: 'ADMIN_TOKEN', secretRef: { name: 'external-fleet', key: 'fleet-client-secret' } },
    ]) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('managed environment');
  });

  it('preserves distinct Fleet Auth environment references and rejects collisions with a custom provider', () => {
    const settings = fleetAuthValues([{ name: 'FLEET_AUTH_CLIENT_SECRET', secretRef: { name: 'external-fleet', key: 'client-secret' } }]);
    expect(render({ ...validValues(), ...settings }).status).toBe(0);
    const result = render({ ...validValues(), ...settings, provider: { envName: 'FLEET_AUTH_CLIENT_SECRET' } });
    expect(result.status).not.toBe(0);
  });

  it.each(['provider', 'eidoverse', 'fleet'] as const)('rejects extraEnv shadowing a custom %s credential binding', role => {
    const values = validValues();
    const name = 'CUSTOM_ROLE_CREDENTIAL';
    const settings = role === 'provider' ? { provider: { envName: name } }
      : role === 'fleet' ? fleetAuthValues([{ name, secretRef: { name: 'external-fleet', key: 'client-secret' } }])
        : { secrets: { ...values.secrets, keys: { eidoverseJoinToken: name } },
          satelliteHub: { ...hubValues(), eidoverse: { ...hubValues().eidoverse, tokenRef: name } } };
    const result = render({ ...values, ...settings,
      workloads: { gateway: { extraEnv: [{ name, value: 'override' }] } } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('managed by the chart');
  });

  it('rejects duplicate extraEnv bindings while preserving a distinct custom flag', () => {
    const entry = { name: 'CUSTOM_OPERATOR_FLAG', value: 'enabled' };
    expect(render({ ...validValues(), workloads: { gateway: { extraEnv: [entry] } } }).status).toBe(0);
    expect(render({ ...validValues(), workloads: { gateway: { extraEnv: [entry, entry] } } }).status).not.toBe(0);
  });
});
