// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SETTINGS_GARDEN_FIELD_EXPOSURE,
} from '../../../../../src/shared/contracts/settings-garden-contract.ts';
import {
  SETTINGS_SIMPLE_SECTIONS,
} from './navigation.ts';
import {
  GARDEN_SECTION_TO_SIMPLE_SECTION,
  SETTINGS_SECTION_COLLAPSE_KEY,
  buildSettingsSearchEntries,
  filterSettingsSearchEntries,
  humanizeSettingFieldKey,
  settingsSearchResultKey,
} from './settings-search.ts';

const SIMPLE_SECTION_IDS = new Set(SETTINGS_SIMPLE_SECTIONS.map((s) => s.id));

test('every Garden field-exposure section maps to a real simple section', () => {
  const gardenSectionIds = new Set(
    Object.values(SETTINGS_GARDEN_FIELD_EXPOSURE).map((e) => e.sectionId),
  );
  for (const gardenId of gardenSectionIds) {
    const simpleId = GARDEN_SECTION_TO_SIMPLE_SECTION[gardenId];
    assert.ok(simpleId, `garden section ${gardenId} has no mapping`);
    assert.ok(
      SIMPLE_SECTION_IDS.has(simpleId),
      `garden section ${gardenId} maps to unknown simple section ${simpleId}`,
    );
  }
});

test('collapse keys only reference real simple sections', () => {
  for (const sectionId of Object.keys(SETTINGS_SECTION_COLLAPSE_KEY)) {
    assert.ok(
      SIMPLE_SECTION_IDS.has(sectionId),
      `collapse key references unknown simple section ${sectionId}`,
    );
  }
});

test('humanizeSettingFieldKey spaces and title-cases keys', () => {
  assert.equal(
    humanizeSettingFieldKey('sessionHistoryBudgetPct'),
    'Session History Budget Pct',
  );
  assert.equal(
    humanizeSettingFieldKey('webFetchAllowHttp'),
    'Web Fetch Allow Http',
  );
  assert.equal(
    humanizeSettingFieldKey('memoryExtractionMinImportance'),
    'Memory Extraction Min Importance',
  );
});

test('index contains one entry per section plus one per exposed field', () => {
  const entries = buildSettingsSearchEntries();
  const sectionEntries = entries.filter((e) => e.kind === 'section');
  const fieldEntries = entries.filter((e) => e.kind === 'field');
  assert.equal(sectionEntries.length, SETTINGS_SIMPLE_SECTIONS.length);
  assert.equal(
    fieldEntries.length,
    Object.keys(SETTINGS_GARDEN_FIELD_EXPOSURE).length,
  );
});

test('empty or whitespace query returns no results', () => {
  assert.deepEqual(filterSettingsSearchEntries(''), []);
  assert.deepEqual(filterSettingsSearchEntries('   '), []);
});

test('field key search resolves to its owning section', () => {
  const results = filterSettingsSearchEntries('webFetchAllowHttp');
  const field = results.find(
    (r) => r.kind === 'field' && r.fieldKey === 'webFetchAllowHttp',
  );
  assert.ok(field, 'expected webFetchAllowHttp field result');
  assert.equal(field.sectionId, 'runtime-fetch');
  assert.equal(field.sectionTitle, 'Web Fetch Policy');
});

test('field label words match (humanized), not just raw keys', () => {
  const results = filterSettingsSearchEntries('importance');
  const keys = results
    .filter((r) => r.kind === 'field')
    .map((r) => r.fieldKey);
  assert.ok(keys.includes('memoryExtractionMinImportance'));
  assert.ok(keys.includes('profileSynthesisMinImportance'));
});

test('section title search surfaces the section entry', () => {
  const results = filterSettingsSearchEntries('profile synthesis');
  const section = results.find(
    (r) => r.kind === 'section' && r.sectionId === 'memory-profile',
  );
  assert.ok(section, 'expected the Profile Synthesis section');
});

test('multi-term query requires every term to match (AND semantics)', () => {
  // "voice" matches voice fields; "zzznope" matches nothing → no results.
  const results = filterSettingsSearchEntries('voice zzznope');
  assert.equal(results.length, 0);
});

test('results are ranked, deduped by kind on ties, and capped by limit', () => {
  const results = filterSettingsSearchEntries('memory', undefined, 5);
  assert.ok(results.length > 0);
  assert.ok(results.length <= 5);
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(results[i - 1].score >= results[i].score, 'scores are descending');
  }
});

test('compositional-only fields fall back to the All Fields section', () => {
  const results = filterSettingsSearchEntries('subagentMaxConcurrent');
  const field = results.find(
    (r) => r.kind === 'field' && r.fieldKey === 'subagentMaxConcurrent',
  );
  assert.ok(field, 'expected subagentMaxConcurrent result');
  assert.equal(field.sectionId, 'advanced-fields');
});

test('result keys are stable and disambiguate kind', () => {
  assert.equal(
    settingsSearchResultKey({
      kind: 'section',
      sectionId: 'memory-budget',
      title: 'Context Budget',
      description: '',
    }),
    'section:memory-budget',
  );
  assert.equal(
    settingsSearchResultKey({
      kind: 'field',
      fieldKey: 'ttsProvider',
      fieldLabel: 'Tts Provider',
      sectionId: 'integrations-voice',
      sectionTitle: 'Voice & TTS',
    }),
    'field:ttsProvider',
  );
});
