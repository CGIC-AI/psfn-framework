import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fromPartial } from '@total-typescript/shoehorn';
import { describe, expect, it } from 'vitest';
import { ApiServer, type ApiServerConfig } from '../../channels/api/server.js';
import { EventBus } from '../../shared/event-bus.js';
import { GardenOperatorSurface } from '../../operator/garden/operator-surface.js';
import type { SubstrateConfig } from './runtime-config-contracts.js';
import { createSessionHmacBoundaryService } from '../../persistence/journals/hmac-boundary.js';
import { clearDiagnosticLogRingBufferForTests, getRecentDiagnosticLogRecords } from '../../shared/logger.js';

const weakCredentials = ['CHANGE_ME_API_KEY', 'CHANGE_ME_ADMIN_TOKEN', 'short-private-value', 'a'.repeat(64),
  '0123456789abcdef'.repeat(4)];

function api(apiKey: string, adminToken?: string) {
  return new ApiServer(fromPartial<ApiServerConfig>({
    port: 0,
    companionId: '11111111-1111-4111-8111-111111111111',
    eventBus: new EventBus(),
    apiKey,
    adminToken,
  }));
}

async function stop(surface: { stop(): Promise<void> }) {
  try { await surface.stop(); } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Server is not running')) throw error;
  }
}

describe('public credential startup boundaries', () => {
  it.each(['API_KEY', 'ADMIN_TOKEN', 'GATEWAY_COMPANION_AUTH_TOKEN', 'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN',
    'PSFN_BACKUP_ENCRYPTION_KEY', 'PSFN_API_KEY', 'HUB_CONTROL_TOKEN', 'API_SATELLITE_KEYS'])(
    'rejects effective HMAC rotation reuse with %s in the executable gateway before owner hydration', role => {
    const directory = mkdtempSync(join(tmpdir(), 'psfn-startup-hmac-rotation-'));
    const apiKey = randomBytes(32).toString('hex');
    try {
      const result = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/app/gateway/main.ts')], {
        cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, TZ: 'UTC', [role]: apiKey,
          GATEWAY_SESSION_HMAC_KEY: randomBytes(32).toString('hex'),
          GATEWAY_SESSION_HMAC_KEYS: `v1:${apiKey},v2=${randomBytes(32).toString('hex')}`,
          GATEWAY_SESSION_HMAC_ACTIVE_VERSION: 'v2' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('must not reuse');
      expect(result.stdout + result.stderr).not.toContain(apiKey);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['fresh', 'retained'] as const)('preserves a valid %s HMAC rotation at executable startup', mode => {
    const directory = mkdtempSync(join(tmpdir(), 'psfn-startup-valid-rotation-'));
    const single = randomBytes(32).toString('hex');
    const current = mode === 'retained' ? single : randomBytes(32).toString('hex');
    const env = { PATH: process.env.PATH, TZ: 'UTC', API_KEY: randomBytes(32).toString('hex'),
      GATEWAY_SESSION_HMAC_KEY: single, GATEWAY_SESSION_HMAC_KEYS: `v1:${single},v2=${current}`,
      GATEWAY_SESSION_HMAC_ACTIVE_VERSION: 'v2' };
    try {
      const keyring = createSessionHmacBoundaryService({ env }).requireKeyring('missing');
      expect(keyring.activeVersion).toBe('v2');
      expect(keyring.keys.v2 === current && keyring.keys.v1 === single).toBe(true);
      const result = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/app/gateway/main.ts')], {
        cwd: directory, encoding: 'utf8', env,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('The fleet manifest is required but missing');
      expect(result.stdout + result.stderr).not.toContain(single);
      expect(result.stdout + result.stderr).not.toContain(current);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(['__proto__', 'constructor', 'prototype', 'has space', 'v1=alias'])(
    'rejects an unsafe HMAC rotation version label (%#) without disclosing key material', version => {
      const key = randomBytes(32).toString('hex');
      const service = createSessionHmacBoundaryService({ env: { GATEWAY_SESSION_HMAC_KEYS: `${version}:${key}` } });
      expect(() => service.requireKeyring('missing')).toThrow(/malformed|credential/u);
      try { service.requireKeyring('missing'); } catch (error) { expect(String(error)).not.toContain(key); }
    },
  );
  it.each(['password', '%70assword', 'pass%77ord'])('rejects a PostgreSQL %s query override in the executable gateway before owner hydration', parameter => {
    const directory = mkdtempSync(join(tmpdir(), 'psfn-startup-pg-override-'));
    const password = randomBytes(32).toString('hex');
    const override = 'weak-query-credential-probe';
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:5432/psfn?${parameter}=${override}`;
    try {
      const result = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/app/gateway/main.ts')], {
        cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, TZ: 'UTC', POSTGRES_DATABASE_URL: databaseUrl },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('routing or authentication query override');
      expect(result.stdout + result.stderr).not.toContain(password);
      expect(result.stdout + result.stderr).not.toContain(override);
      expect(result.stdout + result.stderr).not.toContain(databaseUrl);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([['gateway', 'API_KEY'], ['operator', 'ADMIN_TOKEN'], ['agent', 'GATEWAY_SESSION_HMAC_KEY']])(
    'rejects weak credentials in the executable %s entrypoint before owner-file hydration', (component, role) => {
      const directory = mkdtempSync(join(tmpdir(), 'psfn-startup-credentials-'));
      const value = 'CHANGE_ME_nonsecret-startup-probe-0123456789';
      try {
        const result = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve(`src/app/${component}/main.ts`)], {
          cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, TZ: 'UTC', [role!]: value },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('credential must be');
        expect(result.stdout + result.stderr).not.toContain(value);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
  );
  it.each(weakCredentials)('refuses weak API credentials before listening (%#)', async value => {
    clearDiagnosticLogRingBufferForTests();
    const server = api(value);
    try {
      const startup = server.start();
      await expect(startup).rejects.toThrow(/credential/u);
      await expect(startup).rejects.not.toThrow(value);
      expect(JSON.stringify(getRecentDiagnosticLogRecords())).not.toContain(value);
    } finally {
      await stop(server);
    }
  });

  it.each(weakCredentials)('refuses weak Garden credentials before listening (%#)', async value => {
    clearDiagnosticLogRingBufferForTests();
    const surface = new GardenOperatorSurface({
      port: 0,
      token: value,
      config: fromPartial<SubstrateConfig>({}),
      transportEndpoint: { mode: 'socket', socketPath: '/tmp/psfn-unused-startup.sock', requestTimeoutMs: 1000 },
    });
    try {
      const startup = surface.start();
      await expect(startup).rejects.toThrow(/credential/u);
      await expect(startup).rejects.not.toThrow(value);
      expect(JSON.stringify(getRecentDiagnosticLogRecords())).not.toContain(value);
    } finally {
      await stop(surface);
    }
  });

  it('starts the Garden with a freshly generated credential', async () => {
    const surface = new GardenOperatorSurface({
      port: 0, token: randomBytes(32).toString('hex'), config: fromPartial<SubstrateConfig>({}),
      transportEndpoint: { mode: 'socket', socketPath: '/tmp/psfn-unused-startup.sock', requestTimeoutMs: 1000 },
    });
    try { await surface.start(); } finally { await surface.stop(); }
  });

  it('accepts fresh role-distinct API credentials and refuses role reuse', async () => {
    const token = randomBytes(32).toString('hex');
    const server = api(token, randomBytes(32).toString('hex'));
    try { await server.start(); } finally { await server.stop(); }
    const reused = api(token, token);
    try { await expect(reused.start()).rejects.toThrow(/reuse/u); } finally { await stop(reused); }
  });

  it.each(weakCredentials)('refuses weak journal HMAC keys, including inactive rotation keys (%#)', value => {
    const service = createSessionHmacBoundaryService({ env: {
      GATEWAY_SESSION_HMAC_KEYS: `old:${value},current:${randomBytes(32).toString('hex')}`,
      GATEWAY_SESSION_HMAC_ACTIVE_VERSION: 'current',
    } });
    expect(() => service.requireIntegrityProvider('missing key')).toThrow(/credential/u);
  });

  it('rejects malformed and shadowed HMAC credentials instead of silently ignoring them', () => {
    const strong = randomBytes(32).toString('hex');
    for (const serialized of [`v1:weak-private-key,v1:${strong}`, `v1:${strong},unparsed-private-key`, `v1:${strong},v2:`]) {
      const service = createSessionHmacBoundaryService({ env: { GATEWAY_SESSION_HMAC_KEYS: serialized } });
      expect(() => service.requireKeyring('missing')).toThrow(/credential/u);
    }
  });
});
