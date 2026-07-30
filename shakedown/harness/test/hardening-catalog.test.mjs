import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HARDENING_CASE_IDS,
  buildModelLaneExpectations,
  buildHardeningCases,
} from '../cases/hardening.mjs';

const context = {
  runToken: '2026-07-18T12-00-00',
  primaryApiUserId: 'api-key-fixture',
};

const services = {
  apiBase: 'http://127.0.0.1:10153',
  apiUrl: 'http://127.0.0.1:10153/v1/chat/completions',
  adminBase: 'http://127.0.0.1:10154',
  apiKey: 'fixture-api-key',
  companionDataDir: '/round/companion-data',
  systemDataDir: '/round/system-data',
  fetchJson: async () => ({ ok: true, status: 200, body: {} }),
  pgAll: async () => [],
  pgScalar: async () => 0,
  readJsonIfExists: () => null,
  readJsonl: () => [],
  waitForTurnRecord: async () => null,
};

// A valid on-disk backup.json for the save-path tests: every required field plus
// the mandatory encryption block.
function backupOwnerFile() {
  return {
    intervalHours: 6,
    maxRotatingBackups: 5,
    maxWeeklyBackups: 4,
    maxMonthlyBackups: 12,
    mirrorDir: '',
    verifyRestore: true,
    encryption: { mode: 'required', keyRef: { kind: 'env', envName: 'PSFN_BACKUP_ENCRYPTION_KEY' } },
  };
}

// Services stub that models the real backup save route: it holds an in-memory
// backup.json on disk, serves it via readJsonIfExists, and mimics POST
// /api/admin/settings/backup (form-urlencoded configJson) including the
// fail-closed rejection of an encryption-stripped payload.
function backupServices(diskBackup) {
  const state = { disk: diskBackup ? { ...diskBackup } : null };
  const calls = [];
  return {
    calls,
    state,
    apiUrl: 'http://127.0.0.1:10153/v1/chat/completions',
    adminBase: 'http://127.0.0.1:10154',
    apiKey: 'fixture-api-key',
    systemDataDir: '/round/system-data',
    companionDataDir: '/round/companion-data',
    readJsonIfExists: () => (state.disk ? { ...state.disk } : null),
    fetchJson: async (url, init = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ?? null });
      if (url.endsWith('/api/admin/settings/backup') && method === 'POST') {
        const configJson = new URLSearchParams(init.body).get('configJson');
        const parsed = JSON.parse(configJson);
        if (!parsed.encryption) {
          return { ok: false, status: 400, body: { error: 'Invalid backup config: encryption must be an object' } };
        }
        state.disk = parsed;
        return { ok: true, status: 200, body: { rawText: 'backup.json saved' } };
      }
      return { ok: true, status: 200, body: {} };
    },
    pgAll: async () => [],
    pgScalar: async () => 0,
    waitForTurnRecord: async () => ({ turnId: 'turn-x', status: 'completed', assistantMessage: { content: 'ok' } }),
  };
}

function backupCase(svc) {
  return buildHardeningCases(context, svc).find((entry) => entry.id === 'backup_encryption_roundtrip');
}

test('hardening catalog has stable unique IDs and complete execution metadata', () => {
  const cases = buildHardeningCases(context, services);
  assert.deepEqual(cases.map((entry) => entry.id), [...HARDENING_CASE_IDS]);
  assert.equal(new Set(HARDENING_CASE_IDS).size, HARDENING_CASE_IDS.length);

  for (const entry of cases) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(['nursery', 'apprentice', 'autonomous', 'all'].includes(entry.tier));
    assert.ok(Array.isArray(entry.variants) && entry.variants.length > 0);
    assert.match(entry.feature, /^psfn-framework-/u);
    assert.equal(typeof entry.proof?.source, 'string');
    assert.equal(typeof entry.proof?.assertion, 'string');
    assert.equal(typeof entry.execute, 'function');
    assert.equal(typeof entry.validatePersistedProof, 'function');
  }
});

test('hardening catalog authors only the probe-supported hardening rows', () => {
  const ids = new Set(buildHardeningCases(context, services).map((entry) => entry.id));
  assert.ok(ids.has('model_lane_attribution'), 'boundary spend / model-lane attribution (mmo9.7.3)');
  assert.ok(ids.has('backup_encryption_roundtrip'), 'backup.json encryption round-trip (irzz.1)');
  // Voice, PWA, and the DNLL migration path stay operator-eyes / staged-session
  // dispositions, never authored cases. The passkey ceremony surface was deleted
  // outright by the Discord-SSO-only rebuild and must never be re-authored.
  assert.ok(!ids.has('voice_reply_streaming'), 'voice stays operator-eyes');
  assert.ok(!ids.has('fleet_passkey_ceremony'), 'passkey ceremony no longer exists');
  assert.ok(!ids.has('dnll_owner_migration'), 'DNLL migration is a staged session, not a case');
});

test('model attribution scopes chat, vision, and background to case-owned turns', () => {
  assert.deepEqual(
    buildModelLaneExpectations({
      interactiveTurnId: 'turn-chat',
      visionTurnId: 'turn-vision',
      backgroundTurnId: 'turn-background',
    }),
    [
      { turnId: 'turn-chat', purpose: 'chat' },
      { turnId: 'turn-vision', purpose: 'vision' },
      {
        lane: 'background',
        turnId: 'turn-background',
        originStage: 'emotion.appraisal',
        purpose: 'background',
      },
    ],
  );
});

test('the backup round-trip case self-derives a benign scalar flip and full payloads from backup.json', async () => {
  const svc = backupServices(backupOwnerFile());
  const beforeChecks = await backupCase(svc).before({ ctx: context });
  // The route/method are pinned; only the harmless payload is self-derived — a
  // pure retention-count +1, with every other field (and the encryption block)
  // preserved.
  assert.equal(beforeChecks.field, 'maxMonthlyBackups');
  assert.equal(beforeChecks.flipFrom, 12);
  assert.equal(beforeChecks.flipTo, 13);
  assert.equal(beforeChecks.flippedPayload.maxMonthlyBackups, 13);
  assert.deepEqual(beforeChecks.flippedPayload.encryption, backupOwnerFile().encryption);
  // The negative-probe payload strips only the encryption block.
  assert.ok(!('encryption' in beforeChecks.strippedPayload));
  assert.equal(beforeChecks.strippedPayload.maxMonthlyBackups, 12);
  // before() derives purely from disk — no route call needed.
  assert.equal(svc.calls.length, 0);
});

test('the backup round-trip case fails closed when backup.json is absent or has no encryption block', async () => {
  await assert.rejects(
    () => backupCase(backupServices(null)).before({ ctx: context }),
    /could not read a backup\.json/u,
  );
  const noBlock = backupOwnerFile();
  delete noBlock.encryption;
  await assert.rejects(
    () => backupCase(backupServices(noBlock)).before({ ctx: context }),
    /no encryption block to protect/u,
  );
});

test('the backup round-trip case fails closed when backup.json exposes no benign retention scalar', async () => {
  const noScalar = backupOwnerFile();
  delete noScalar.maxMonthlyBackups;
  delete noScalar.maxWeeklyBackups;
  delete noScalar.maxRotatingBackups;
  await assert.rejects(
    () => backupCase(backupServices(noScalar)).before({ ctx: context }),
    /no benign numeric retention field to flip/u,
  );
});

test('the backup case execute drives the real save path, restores, and probes the fail-closed guard', async () => {
  const svc = backupServices(backupOwnerFile());
  const backup = backupCase(svc);
  const beforeChecks = await backup.before({ ctx: context });
  const outcome = await backup.execute({
    ctx: context,
    sessionId: 'hardening-backup-fixture',
    apiUserId: context.primaryApiUserId,
    beforeChecks,
  });
  const sc = outcome.sideChecks.backup;
  // Positive round-trip landed the flip with the encryption block intact.
  assert.equal(sc.save.ok, true);
  assert.equal(sc.afterWrite.maxMonthlyBackups, 13);
  assert.deepEqual(sc.afterWrite.encryption, backupOwnerFile().encryption);
  // Restore returned the original scalar.
  assert.equal(sc.restore.ok, true);
  assert.equal(sc.afterRestore.maxMonthlyBackups, 12);
  assert.equal(sc.restored, true);
  // Negative probe was rejected fail-closed and left disk unchanged.
  assert.equal(sc.reject.ok, false);
  assert.equal(sc.reject.status, 400);
  assert.deepEqual(sc.afterReject, sc.afterRestore);
  // The persisted-proof validator passes on this clean outcome.
  assert.deepEqual(backup.validatePersistedProof({ outcome }), []);
  // The route was actually driven three times (save, restore, reject).
  const posts = svc.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/admin/settings/backup'));
  assert.equal(posts.length, 3);
});

test('the backup case exposes an idempotent top-level cleanup that restores via the backup route', async () => {
  const svc = backupServices(backupOwnerFile());
  const backup = backupCase(svc);
  // Cleanup before before(): nothing derived, so it is a no-op.
  const clean = await backup.cleanup();
  assert.deepEqual(clean.cleanupErrors, []);
  assert.equal(clean.cleanup.backup.alreadyClean, true);
  // After before() seeds the original payload, simulate a mutated disk (a flip
  // that was never restored) and confirm cleanup POSTs the original back.
  await backup.before({ ctx: context });
  svc.state.disk = { ...backupOwnerFile(), maxMonthlyBackups: 13 };
  const restored = await backup.cleanup();
  assert.deepEqual(restored.cleanupErrors, []);
  assert.equal(restored.cleanup.backup.restored, true);
  assert.equal(svc.state.disk.maxMonthlyBackups, 12);
  assert.ok(
    svc.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/admin/settings/backup')),
    'cleanup POSTs the pinned backup save route to restore the original',
  );
});
