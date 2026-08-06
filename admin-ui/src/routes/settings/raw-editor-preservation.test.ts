import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildBackupSettingsPayload,
  buildRawEditorJsonMap,
  buildUnifiedSaveSkipNote,
  listDirtyRawEditorKeys,
  listUnifiedSaveSkippedOwnerFiles,
  loadRawEditorConfigs,
  planUnifiedOwnerConfigSaves,
  RAW_EDITORS,
  rebaselineRawJsonByKey,
  resolveReloadedRawJsonByKey,
  resolveUnifiedSaveSettingsJsonConflict,
  UNIFIED_SAVE_OWNER_FILE_KEYS,
  UNIFIED_SAVE_SETTINGS_JSON_CONFLICT_MESSAGE,
  type UnifiedOwnerConfigSaveEntry,
} from './settings-page-helpers';

test('owner-file fetch failure is retained as an error instead of an empty JSON document', async () => {
  const requestedKeys: string[] = [];
  const results = await loadRawEditorConfigs(async (key) => {
    requestedKeys.push(key);
    if (key === 'trust-policy') {
      throw new Error('503 Service Unavailable');
    }
    return JSON.stringify({ owner: key });
  });

  assert.deepEqual(requestedKeys, RAW_EDITORS.map(({ key }) => key));
  assert.deepEqual(results['trust-policy'], {
    status: 'error',
    message: '503 Service Unavailable',
  });
  assert.equal(
    'json' in results['trust-policy'],
    false,
    'a failed fetch must not manufacture an editable empty-object document',
  );
  assert.deepEqual(results.channels, {
    status: 'loaded',
    json: '{"owner":"channels"}',
  });
});

// The four owner-file save entries the unified save always constructs, keyed to
// the real write surface. Tests build on this to exercise skip / drop behavior.
function buildOwnerConfigEntries(
  overrides: Partial<Record<UnifiedOwnerConfigSaveEntry['key'], { nextJson: string; currentJson: string }>> = {},
): UnifiedOwnerConfigSaveEntry[] {
  return UNIFIED_SAVE_OWNER_FILE_KEYS.map((key) => ({
    key,
    // Default: no pending form change (next === current).
    nextJson: overrides[key]?.nextJson ?? JSON.stringify({ owner: key, form: 1 }),
    currentJson: overrides[key]?.currentJson ?? JSON.stringify({ owner: key, form: 1 }),
  }));
}

// Regression coverage for the 9lxg dual-review data-loss blockers: a staged
// (dirty) raw owner-file edit must survive the unified saveSettings ->
// saveSettingsContract -> reloadSettingsState path, must keep comparing dirty
// afterwards, and its owner file must be excluded from the structured saves.
test('unified save preserves dirty raw editors across reload and skips their owner files', () => {
  // Server baseline: every owner file has some on-disk content.
  const serverJsonByKey = buildRawEditorJsonMap((key) =>
    JSON.stringify({ owner: key, revision: 1 }, null, 2),
  );
  // Initial page load: editors match server, nothing dirty.
  const initialRawJsonByKey = { ...serverJsonByKey };
  let currentRawJsonByKey = { ...serverJsonByKey };

  // User types unsaved edits into the raw scheduler editor (Blocker repro also
  // uses channels.json; scheduler is one of the files the unified save writes).
  const stagedSchedulerJson = JSON.stringify({ owner: 'scheduler', revision: 1, handEdit: true }, null, 2);
  currentRawJsonByKey = { ...currentRawJsonByKey, scheduler: stagedSchedulerJson };

  const dirtyKeys = listDirtyRawEditorKeys(currentRawJsonByKey, initialRawJsonByKey);
  assert.deepEqual(dirtyKeys, ['scheduler']);

  // Blocker 2: the dirty owner file must be excluded from the unified save's
  // structured ownerConfigSaves (no form-derived JSON stomp on disk).
  const skippedOwnerFiles = listUnifiedSaveSkippedOwnerFiles(dirtyKeys);
  assert.deepEqual(skippedOwnerFiles, ['scheduler']);
  const saveableOwnerFiles = UNIFIED_SAVE_OWNER_FILE_KEYS.filter(
    (key) => !skippedOwnerFiles.includes(key),
  );
  assert.deepEqual(saveableOwnerFiles, ['providers', 'capabilities', 'backup']);

  // Blocker 1: the post-save reload must keep the staged editor content for
  // the dirty key while refreshing clean keys from the server.
  const serverAfterSave = buildRawEditorJsonMap((key) =>
    JSON.stringify({ owner: key, revision: 2 }, null, 2),
  );
  const reloaded = resolveReloadedRawJsonByKey({
    serverJsonByKey: serverAfterSave,
    stagedJsonByKey: currentRawJsonByKey,
    dirtyKeys,
  });
  assert.equal(
    reloaded.scheduler,
    stagedSchedulerJson,
    'dirty raw editor content must be preserved across the reload',
  );
  assert.equal(
    reloaded.channels,
    serverAfterSave.channels,
    'clean raw editors refresh from the server',
  );

  // Blocker 1 (masking half): rebaselining must NOT mark the preserved dirty
  // editor clean — rawDirty and the tab badge keep reflecting the staged edit.
  const rebaselined = rebaselineRawJsonByKey({
    currentJsonByKey: reloaded,
    initialJsonByKey: initialRawJsonByKey,
    preservedKeys: dirtyKeys,
  });
  const dirtyAfterSave = listDirtyRawEditorKeys(reloaded, rebaselined);
  assert.deepEqual(
    dirtyAfterSave,
    ['scheduler'],
    'preserved raw editor stays dirty after the unified save',
  );
});

test('clean raw editors are not skipped and rebaseline cleanly', () => {
  const serverJsonByKey = buildRawEditorJsonMap((key) =>
    JSON.stringify({ owner: key, revision: 1 }, null, 2),
  );
  const initialRawJsonByKey = { ...serverJsonByKey };
  const currentRawJsonByKey = { ...serverJsonByKey };

  const dirtyKeys = listDirtyRawEditorKeys(currentRawJsonByKey, initialRawJsonByKey);
  assert.deepEqual(dirtyKeys, []);
  assert.deepEqual(listUnifiedSaveSkippedOwnerFiles(dirtyKeys), []);

  const reloaded = resolveReloadedRawJsonByKey({
    serverJsonByKey,
    stagedJsonByKey: currentRawJsonByKey,
    dirtyKeys,
  });
  const rebaselined = rebaselineRawJsonByKey({
    currentJsonByKey: reloaded,
    initialJsonByKey: initialRawJsonByKey,
    preservedKeys: dirtyKeys,
  });
  assert.deepEqual(listDirtyRawEditorKeys(reloaded, rebaselined), []);
});

test('dirty raw editors outside the unified-save owner files are preserved but skip nothing', () => {
  const serverJsonByKey = buildRawEditorJsonMap((key) =>
    JSON.stringify({ owner: key, revision: 1 }, null, 2),
  );
  const initialRawJsonByKey = { ...serverJsonByKey };
  const stagedChannelsJson = JSON.stringify({ owner: 'channels', handEdit: true }, null, 2);
  const currentRawJsonByKey = { ...serverJsonByKey, channels: stagedChannelsJson };

  const dirtyKeys = listDirtyRawEditorKeys(currentRawJsonByKey, initialRawJsonByKey);
  assert.deepEqual(dirtyKeys, ['channels']);
  // channels.json is never written by the unified save's ownerConfigSaves, so
  // the skip list stays empty — but the reload still preserves the staged edit.
  assert.deepEqual(listUnifiedSaveSkippedOwnerFiles(dirtyKeys), []);

  const reloaded = resolveReloadedRawJsonByKey({
    serverJsonByKey,
    stagedJsonByKey: currentRawJsonByKey,
    dirtyKeys,
  });
  assert.equal(reloaded.channels, stagedChannelsJson);
});

// ── Blocker 1: a dirty settings.json raw editor must FAIL the unified save ──
// closed, before any write. settings.json is the runtime payload target, so it
// can never be "skipped" — writing the runtime payload would clobber it.
test('dirty settings.json raw editor blocks the unified save before any write', () => {
  // Clean: unified save may proceed.
  assert.equal(resolveUnifiedSaveSettingsJsonConflict([]), null);
  assert.equal(resolveUnifiedSaveSettingsJsonConflict(['scheduler', 'backup']), null);

  // Dirty settings.json: unified save is refused with the explicit message.
  assert.equal(
    resolveUnifiedSaveSettingsJsonConflict(['settings']),
    UNIFIED_SAVE_SETTINGS_JSON_CONFLICT_MESSAGE,
  );
  assert.equal(
    resolveUnifiedSaveSettingsJsonConflict(['settings', 'scheduler']),
    UNIFIED_SAVE_SETTINGS_JSON_CONFLICT_MESSAGE,
  );
  assert.match(
    UNIFIED_SAVE_SETTINGS_JSON_CONFLICT_MESSAGE,
    /settings\.json .*save or discard them there/,
  );

  // Modelling the controller's fail-closed ordering: because the conflict is
  // non-null, updateSettings and the owner-file saves must NOT run. The plan is
  // only reached when the conflict check passes; assert it is never consulted
  // by proving the guard short-circuits.
  const dirtyKeys = ['settings'] as const;
  const conflict = resolveUnifiedSaveSettingsJsonConflict(dirtyKeys);
  assert.ok(conflict, 'a dirty settings.json editor must yield a blocking conflict');
});

// ── Blocker 2(a): the skip set must exactly equal the write surface ──
test('unified owner-config plan enforces write-surface == skip-set invariant', () => {
  // Entries covering exactly the skip-set keys are accepted.
  const plan = planUnifiedOwnerConfigSaves({
    entries: buildOwnerConfigEntries(),
    dirtyRawEditorKeys: [],
  });
  assert.deepEqual(
    plan.saves.map((entry) => entry.key),
    [],
    'no pending form changes -> nothing written',
  );
  assert.deepEqual(plan.skippedOwnerFiles, []);
  assert.deepEqual(plan.skippedWithPendingChanges, []);

  // Missing a write-surface key (drift) must fail closed.
  assert.throws(
    () =>
      planUnifiedOwnerConfigSaves({
        entries: buildOwnerConfigEntries().filter((entry) => entry.key !== 'backup'),
        dirtyRawEditorKeys: [],
      }),
    /must equal the skip set/,
  );

  // A duplicate key must fail closed.
  assert.throws(
    () =>
      planUnifiedOwnerConfigSaves({
        entries: [...buildOwnerConfigEntries(), {
          key: 'scheduler',
          nextJson: '{}',
          currentJson: '{}',
        }],
        dirtyRawEditorKeys: [],
      }),
    /duplicate keys/,
  );

  // Only changed, non-skipped entries are written.
  const withChanges = planUnifiedOwnerConfigSaves({
    entries: buildOwnerConfigEntries({
      scheduler: { nextJson: '{"a":2}', currentJson: '{"a":1}' },
      backup: { nextJson: '{"b":2}', currentJson: '{"b":1}' },
    }),
    dirtyRawEditorKeys: [],
  });
  assert.deepEqual(withChanges.saves.map((entry) => entry.key), ['scheduler', 'backup']);
});

// ── Blocker 2(b): a skipped owner file with pending FORM changes must be ──
// reported as NOT saved, not merely "preserved".
test('unified save note is honest about dropped form changes on skipped owner files', () => {
  // scheduler.json is dirty in its raw editor AND has a pending form change
  // (backgroundMaintenanceIntervalMs routes only there). backup.json is dirty
  // in its raw editor with no pending form change.
  const plan = planUnifiedOwnerConfigSaves({
    entries: buildOwnerConfigEntries({
      scheduler: { nextJson: '{"intervalMs":2}', currentJson: '{"intervalMs":1}' },
      // backup unchanged (default next === current).
    }),
    dirtyRawEditorKeys: ['scheduler', 'backup'],
  });
  assert.deepEqual(plan.skippedOwnerFiles, ['scheduler', 'backup']);
  assert.deepEqual(
    plan.skippedWithPendingChanges,
    ['scheduler'],
    'only the skipped file with a real pending form change is flagged',
  );
  assert.deepEqual(plan.saves, [], 'skipped files are never written');

  const note = buildUnifiedSaveSkipNote({
    skippedOwnerFiles: plan.skippedOwnerFiles,
    skippedWithPendingChanges: plan.skippedWithPendingChanges,
    ownerFileLabel: (key) => `${key}.json`,
  });
  // Dropped form change must be reported as NOT saved.
  assert.match(note, /Form changes to scheduler\.json were NOT saved/);
  // The purely-preserved file keeps the softer "preserved" wording.
  assert.match(note, /Skipped backup\.json — staged raw edits .* are preserved/);

  // No skips -> no note.
  assert.equal(
    buildUnifiedSaveSkipNote({
      skippedOwnerFiles: [],
      skippedWithPendingChanges: [],
      ownerFileLabel: (key) => `${key}.json`,
    }),
    '',
  );

  // Sanity: skip-set listing helper still agrees with the plan's skip set.
  assert.deepEqual(
    listUnifiedSaveSkippedOwnerFiles(['scheduler', 'backup']),
    plan.skippedOwnerFiles,
  );
});

// Regression for irzz.1: the unified save's backup payload dropped every
// owner-file field the curated form does not surface (encryption, groupMode,
// maxDailyBackups). backup.json requires `encryption`, so the stripped payload
// failed validateBackupConfig server-side and Save Settings errored on every
// real deployment. The builder must overlay only the curated fields onto the
// loaded config.
const REALISTIC_BACKUP_CONFIG = {
  intervalHours: 12,
  maxRotatingBackups: 9,
  maxDailyBackups: 7,
  maxWeeklyBackups: 2,
  maxMonthlyBackups: 1,
  mirrorDir: '/mnt/backup',
  verifyRestore: true,
  groupMode: 'per-companion',
  encryption: { mode: 'required', keyRef: { kind: 'env', envName: 'PSFN_BACKUP_KEY' } },
};

test('backup payload preserves non-curated owner fields and overlays curated changes', () => {
  const payload = buildBackupSettingsPayload(REALISTIC_BACKUP_CONFIG, {
    backupIntervalHours: 24,
    backupMaxRotating: 4,
    backupMaxWeekly: 4,
    backupMaxMonthly: 12,
    backupMirrorDir: '/mnt/backup',
    backupVerifyRestore: false,
  });

  // The blocks that were dropped survive byte-for-byte.
  assert.deepEqual(payload.encryption, REALISTIC_BACKUP_CONFIG.encryption);
  assert.equal(payload.groupMode, REALISTIC_BACKUP_CONFIG.groupMode);
  assert.equal(payload.maxDailyBackups, REALISTIC_BACKUP_CONFIG.maxDailyBackups);

  // Curated fields overlay the loaded values.
  assert.equal(payload.intervalHours, 24);
  assert.equal(payload.maxRotatingBackups, 4);
  assert.equal(payload.maxWeeklyBackups, 4);
  assert.equal(payload.maxMonthlyBackups, 12);
  assert.equal(payload.verifyRestore, false);
});

test('backup payload with no curated change round-trips the loaded config unchanged', () => {
  const payload = buildBackupSettingsPayload(REALISTIC_BACKUP_CONFIG, {
    backupIntervalHours: REALISTIC_BACKUP_CONFIG.intervalHours,
    backupMaxRotating: REALISTIC_BACKUP_CONFIG.maxRotatingBackups,
    backupMaxWeekly: REALISTIC_BACKUP_CONFIG.maxWeeklyBackups,
    backupMaxMonthly: REALISTIC_BACKUP_CONFIG.maxMonthlyBackups,
    backupMirrorDir: REALISTIC_BACKUP_CONFIG.mirrorDir,
    backupVerifyRestore: REALISTIC_BACKUP_CONFIG.verifyRestore,
  });

  // Semantic identity: an untouched backup form must not diverge from the
  // loaded owner file, so the unified save leaves backup.json alone.
  assert.deepEqual(payload, REALISTIC_BACKUP_CONFIG);
});
