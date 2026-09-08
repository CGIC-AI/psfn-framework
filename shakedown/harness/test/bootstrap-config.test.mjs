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
import { fileURLToPath } from 'node:url';
import { resolveBootstrapConfig } from '../lib/bootstrap-config.mjs';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'psfn-bootstrap-config-'));

try {
  const repoRoot = join(fixtureRoot, 'repo');
  const roundRoot = join(fixtureRoot, 'round');
  const liveRoot = join(fixtureRoot, 'live');
  mkdirSync(join(repoRoot, 'config'), { recursive: true });
  mkdirSync(join(repoRoot, 'shakedown', 'companion'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), '{}\n');
  writeFileSync(join(repoRoot, 'shakedown', 'companion', 'REFERENCE-COMPANION.png'), 'card');

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
    POSTGRES_DATABASE_URL: 'postgresql://round:test@127.0.0.1:5432/psfn_shakedown_round',
    PSFN_LIVE_POSTGRES_DATABASE_URL: 'postgresql://live:test@127.0.0.1:5432/psfn_live',
    PSFN_SHAKEDOWN_POSTGRES_DATABASE: 'psfn_shakedown_round',
    COMPANION_PG_SCHEMA: 'shakedown_companion',
    PSFN_SHAKEDOWN_EXTERNAL_CHANNELS: 'false',
    PSFN_API_BASE: 'http://127.0.0.1:10153',
    PSFN_ADMIN_BASE: 'http://127.0.0.1:10154',
    API_HOST: '127.0.0.1',
    API_PORT: '10153',
    ADMIN_HOST: '127.0.0.1',
    ADMIN_PORT: '10154',
    API_CORS_ALLOWLIST: 'http://127.0.0.1:10154',
    API_KEY: 'test-api-key',
    TESTING_HARNESS_API_KEY: 'dedicated-testing-harness-key',
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

  const safeEnv = {
    ...env,
    COMPANION_DATA_DIR: join(roundRoot, 'companion-data'),
    CHARACTER_CARD_PATH: join(roundRoot, 'companion-data', 'companion.json'),
  };
  const safe = resolveBootstrapConfig(safeEnv);
  assert.equal(safe.externalChannelsEnabled, false);

  for (const apiBase of [
    'http://example.test:10153',
    'http://localhost:10153',
    'http://user:secret@127.0.0.1:10153',
    'http://127.0.0.1:10153/v1',
    'http://127.0.0.1:10153?redirect=example.test',
    'http://127.0.0.1:10153#fragment',
    'http://127.0.0.1:10154',
  ]) {
    assert.throws(
      () => resolveBootstrapConfig({ ...safeEnv, PSFN_API_BASE: apiBase }),
      /PSFN_API_BASE.*exact loopback origin/u,
      `hostile or mismatched API origin must fail: ${apiBase}`,
    );
  }
  assert.throws(
    () => resolveBootstrapConfig({
      ...safeEnv,
      PSFN_ADMIN_BASE: 'http://127.0.0.1:10154/admin?token=leak',
    }),
    /PSFN_ADMIN_BASE.*exact loopback origin/u,
  );
  assert.throws(
    () => resolveBootstrapConfig({
      ...safeEnv,
      DISCORD_TOKEN: 'live-discord-token-must-not-cross',
    }),
    /external-channel credential DISCORD_TOKEN.*disabled/u,
  );
  assert.throws(
    () => resolveBootstrapConfig({
      ...safeEnv,
      PSFN_SHAKEDOWN_EXTERNAL_CHANNELS: 'true',
      PSFN_SHAKEDOWN_EXTERNAL_CHANNEL_CONFIRM: '',
    }),
    /PSFN_SHAKEDOWN_EXTERNAL_CHANNEL_CONFIRM/u,
  );
  assert.throws(
    () => resolveBootstrapConfig({
      ...safeEnv,
      PSFN_SHAKEDOWN_EXTERNAL_CHANNELS: 'true',
      PSFN_SHAKEDOWN_EXTERNAL_CHANNEL_CONFIRM: 'dedicated-shakedown-accounts',
    }),
    /requires dedicated external-channel credentials/u,
  );

  const shippedTemplate = readFileSync(
    join(process.cwd(), 'shakedown', 'companion', 'shakedown.env.template'),
    'utf8',
  );
  assert.match(
    shippedTemplate,
    /^COMPANION_ID=a7100000-0000-4000-8000-000000000001$/mu,
    'single-companion bootstrap must share the canonical synthetic companion UUID with support fixtures',
  );
  assert.match(shippedTemplate, /^PSFN_LIVE_DATA_ROOTS=$/mu);
  assert.match(shippedTemplate, /^CONFIG_DIR=\$PSFN_REPO_ROOT\/config$/mu);
  assert.match(shippedTemplate, /^PSFN_SHAKEDOWN_EXTERNAL_CHANNELS=false$/mu);
  for (const name of [
    'DISCORD_TOKEN',
    'DISCORD_BOT_ID',
    'DISCORD_HEARTBEAT_CHANNEL',
    'TELEGRAM_BOT_TOKEN',
    'PRIMARY_TELEGRAM_USER_ID',
    'NTFY_BASE_URL',
    'NTFY_TOPIC',
    'NTFY_TOKEN',
    'CONFIRMATION_NTFY_TOPIC',
  ]) {
    assert.match(
      shippedTemplate,
      new RegExp(`^${name}=$`, 'mu'),
      `${name} must be cleared by default instead of inherited from live`,
    );
  }

  console.log('bootstrap config safety test passed');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

// ── Reference companion card guard (psfn-framework-p2jr0 (4)) ──
// The public sanitizer treats .png as binary and skips it, and
// shakedown/companion/ is a subtree exemption on top of that, so nothing in the
// repository reads the card the harness actually copies into every round.
// bootstrap-config.mjs only proves the file exists. A future card swap could
// therefore reintroduce a private persona — name, system prompt, or example
// dialogue — with no gate objecting. This reads the real card's embedded
// metadata and pins it to the generic reference persona.

/** Extract the base64 `chara` tEXt chunk from a v2/v3 character card PNG. */
function readCharacterCardMetadata(pngPath) {
  const buffer = readFileSync(pngPath);
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE), `${pngPath} is not a PNG`);
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IEND') break;
    if (type === 'tEXt') {
      const data = buffer.subarray(offset + 8, offset + 8 + length);
      const separator = data.indexOf(0);
      if (separator > 0 && data.toString('latin1', 0, separator) === 'chara') {
        const encoded = data.subarray(separator + 1).toString('latin1');
        return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      }
    }
    offset += 12 + length;
  }
  throw new Error(`${pngPath} carries no embedded character card metadata`);
}

const referenceCardPath = fileURLToPath(
  new URL('../../companion/REFERENCE-COMPANION.png', import.meta.url),
);
const referenceCard = readCharacterCardMetadata(referenceCardPath);
assert.equal(referenceCard.spec, 'chara_card_v3', 'reference card must stay a v3 character card');
const referenceData = referenceCard.data;
assert.ok(referenceData, 'reference card must carry a data object');
assert.equal(
  referenceData.name,
  'Reference Companion',
  'the shipped shakedown card must stay the generic reference persona, not a real companion',
);
for (const field of ['system_prompt', 'mes_example', 'first_mes', 'post_history_instructions']) {
  assert.equal(
    referenceData[field] ?? '',
    '',
    `reference card ${field} must stay empty; a populated one would ship a private persona`,
  );
}
assert.deepEqual(
  referenceData.alternate_greetings ?? [],
  [],
  'reference card must ship no alternate greetings',
);
assert.equal(referenceData.nickname ?? '', '', 'reference card must ship no nickname');

console.log('reference companion card guard passed');
