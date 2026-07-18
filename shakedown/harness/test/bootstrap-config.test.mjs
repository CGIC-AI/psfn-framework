#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBootstrapConfig } from '../lib/bootstrap-config.mjs';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'psfn-bootstrap-config-'));

try {
  const repoRoot = join(fixtureRoot, 'repo');
  const roundRoot = join(fixtureRoot, 'round');
  const liveRoot = join(fixtureRoot, 'live');
  mkdirSync(join(repoRoot, 'config'), { recursive: true });
  mkdirSync(join(repoRoot, 'shakedown', 'artie'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), '{}\n');
  writeFileSync(join(repoRoot, 'shakedown', 'artie', 'ARTIE.png'), 'card');

  const env = {
    PSFN_REPO_ROOT: repoRoot,
    CONFIG_DIR: join(repoRoot, 'config'),
    SHAKEDOWN_ROOT: roundRoot,
    PSFN_SHAKEDOWN_ROOT: roundRoot,
    PSFN_RUNTIME_ROOT: roundRoot,
    PSFN_RUNTIME_MODE: 'split',
    PSFN_RUNTIME_LAYOUT_MODE: 'production',
    WORKSPACE_PATH: join(roundRoot, 'workspace'),
    DATA_DIR: join(roundRoot, 'legacy-empty'),
    SYSTEM_DATA_DIR: join(roundRoot, 'system-data'),
    COMPANION_DATA_DIR: join(repoRoot, 'bad-companion-data'),
    CHARACTER_CARD_PATH: join(repoRoot, 'bad-companion-data', 'companion.json'),
    PSFN_LOGS_DIR: join(roundRoot, 'logs'),
    PSFN_TEMP_DIR: join(roundRoot, 'tmp'),
    BACKUP_ROOT_DIR: join(roundRoot, 'backups'),
    POSTGRES_DATABASE_URL: 'postgresql://test.invalid/shakedown',
    PSFN_API_BASE: 'http://127.0.0.1:10153',
    PSFN_ADMIN_BASE: 'http://127.0.0.1:10154',
    API_HOST: '127.0.0.1',
    API_PORT: '10153',
    ADMIN_HOST: '127.0.0.1',
    ADMIN_PORT: '10154',
    API_CORS_ALLOWLIST: 'http://127.0.0.1:10154',
    API_KEY: 'test-api-key',
    ADMIN_TOKEN: 'test-admin-token',
    GATEWAY_SESSION_HMAC_KEY: 'test-hmac-key-that-is-long-enough',
    COMPANION_ID: 'a7100000-0000-4000-8000-000000000001',
    PSFN_LIVE_DATA_ROOTS: liveRoot,
  };

  assert.throws(
    () => resolveBootstrapConfig(env),
    /COMPANION_DATA_DIR.*overlaps the repository root/u,
  );
  assert.equal(
    await import('node:fs').then(({ existsSync }) => existsSync(roundRoot)),
    false,
    'configuration validation must not create the round root',
  );

  const shippedTemplate = readFileSync(
    join(process.cwd(), 'shakedown', 'artie', 'shakedown.env.template'),
    'utf8',
  );
  assert.match(
    shippedTemplate,
    /^COMPANION_ID=a7100000-0000-4000-8000-000000000001$/mu,
    'single-companion bootstrap must share the canonical synthetic Artie UUID with support fixtures',
  );
  assert.match(shippedTemplate, /^PSFN_LIVE_DATA_ROOTS=$/mu);
  assert.match(shippedTemplate, /^CONFIG_DIR=\$PSFN_REPO_ROOT\/config$/mu);

  console.log('bootstrap config safety test passed');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
