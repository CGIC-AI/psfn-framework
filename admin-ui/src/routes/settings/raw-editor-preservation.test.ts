import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRawEditorJsonMap,
  listDirtyRawEditorKeys,
  listUnifiedSaveSkippedOwnerFiles,
  rebaselineRawJsonByKey,
  resolveReloadedRawJsonByKey,
  UNIFIED_SAVE_OWNER_FILE_KEYS,
} from './settings-page-helpers';

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
