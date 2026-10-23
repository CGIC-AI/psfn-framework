import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest } from './verify-chart-render.js';
import { isRecord } from '../src/shared/utils/types.js';

const chart = resolve('deploy/helm/psfn');
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
    gardenBrowser: {
      publicOrigin: 'https://garden.credential-test.invalid',
      trustedProxyAddresses: ['192.0.2.0/24'],
    },
  };
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
      gardenBrowser: {
        publicOrigin: 'https://garden.credential-test.invalid',
        trustedProxyAddresses: ['192.0.2.0/24'],
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/^kind: Secret$/mu);
  });

  it('rejects invalid existing Secret references and aliased role keys', () => {
    expect(render({ secrets: { existingSecret: ' ' }, postgres: { auth: { existingSecret: 'external-db' } } }).status).not.toBe(0);
    const values = validValues();
    expect(render({ ...values, secrets: { ...values.secrets, keys: { apiKey: 'SAME_KEY', adminToken: 'SAME_KEY' } } }).status).not.toBe(0);
  });
});
