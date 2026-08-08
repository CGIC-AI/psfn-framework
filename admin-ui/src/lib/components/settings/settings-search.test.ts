import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GardenSettingsSectionId } from '../../../../../src/shared/contracts/settings-garden-contract.ts';
import {
  SETTINGS_GARDEN_FIELD_EXPOSURE,
  SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS,
} from '../../../../../src/shared/contracts/settings-garden-contract.ts';
import {
  SETTINGS_SIMPLE_SECTIONS,
} from './navigation.ts';
import {
  ADVANCED_FIELDS_SECTION_TITLE,
  CURATED_RENDERED_FIELD_KEYS,
  GARDEN_SECTION_TO_SIMPLE_SECTION,
  SETTINGS_SECTION_COLLAPSE_KEY,
  buildSettingsSearchEntries,
  filterSettingsSearchEntries,
  humanizeSettingFieldKey,
  resolveSettingsFieldRoute,
  settingsSearchResultKey,
  type SettingsSearchFieldEntry,
  type SettingsSearchResult,
} from './settings-search.ts';

const SIMPLE_SECTION_IDS = new Set(SETTINGS_SIMPLE_SECTIONS.map((s) => s.id));

const FIELD_ENTRIES = buildSettingsSearchEntries().filter(
  (e): e is SettingsSearchFieldEntry => e.kind === 'field',
);

// Fields the router deliberately drops (custom-surface, rendered nowhere on the
// Settings page). Kept explicit so adding a new such field to the contract forces
// a conscious classification here rather than silently vanishing or misrouting.
const EXPECTED_EXCLUDED_FIELD_KEYS = new Set([
  'modelCatalog',
  // Edited through the scheduler raw editor; the Autonomy Control Plane page
  // owns the effective-vs-on-disk view (authority.ts detail for this key).
  'icpAutonomyEnabled',
  'episodicProcessingEnabled',
  'episodicProcessingRestWindowStartLocalTime',
  'episodicProcessingRestWindowEndLocalTime',
  'episodicProcessingRestWindowTimeZone',
  'episodicProcessingInactivityThresholdMinutes',
]);

// The five curated panels whose bindings back CURATED_RENDERED_FIELD_KEYS.
const CURATED_PANEL_SOURCES = [
  'SettingsMemoryPanels.svelte',
  'SettingsRuntimePanels.svelte',
  'SettingsIntegrationsPanels.svelte',
  'SettingsTrustBackupPanels.svelte',
  'SettingsDelegatedPanels.svelte',
].map((name) =>
  readFileSync(
    fileURLToPath(new URL(`../../../routes/settings/${name}`, import.meta.url)),
    'utf8',
  ),
);

test('every Garden field-exposure section maps to a real simple section', () => {
  const gardenSectionIds = new Set<GardenSettingsSectionId>(
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
  for (const sectionId of Object.keys(SETTINGS_SECTION_COLLAPSE_KEY) as Array<keyof typeof SETTINGS_SECTION_COLLAPSE_KEY>) {
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

test('index has one entry per section plus one per routable (non-excluded) field', () => {
  const entries = buildSettingsSearchEntries();
  const sectionEntries = entries.filter((e) => e.kind === 'section');
  const fieldEntries = entries.filter((e) => e.kind === 'field');
  assert.equal(sectionEntries.length, SETTINGS_SIMPLE_SECTIONS.length);
  const routableFieldCount = Object.entries(SETTINGS_GARDEN_FIELD_EXPOSURE).filter(
    ([key, exposure]) => resolveSettingsFieldRoute(key, exposure).kind !== 'excluded',
  ).length;
  assert.equal(fieldEntries.length, routableFieldCount);
  // Excluded fields must not leak into the index.
  const indexedKeys = new Set(fieldEntries.map((e) => e.fieldKey));
  for (const excluded of EXPECTED_EXCLUDED_FIELD_KEYS) {
    assert.ok(!indexedKeys.has(excluded), `${excluded} must not be searchable`);
  }
});

test('empty or whitespace query returns no results', () => {
  assert.deepEqual(filterSettingsSearchEntries(''), []);
  assert.deepEqual(filterSettingsSearchEntries('   '), []);
});

test('field key search resolves to its owning section', () => {
  const results = filterSettingsSearchEntries('webFetchAllowHttp');
  const field = results.find(
    (r): r is Extract<SettingsSearchResult, { kind: 'field' }> =>
      r.kind === 'field' && r.fieldKey === 'webFetchAllowHttp',
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
    (r): r is Extract<SettingsSearchResult, { kind: 'field' }> =>
      r.kind === 'field' && r.fieldKey === 'subagentMaxConcurrent',
  );
  assert.ok(field, 'expected subagentMaxConcurrent result');
  assert.equal(field.sectionId, 'advanced-fields');
});

// ── Drift guards: every jump target must actually contain the field ──

test('every field entry jumps to a target that actually renders the field', () => {
  for (const entry of FIELD_ENTRIES) {
    const exposure =
      SETTINGS_GARDEN_FIELD_EXPOSURE[entry.fieldKey as keyof typeof SETTINGS_GARDEN_FIELD_EXPOSURE];
    assert.ok(exposure, `entry ${entry.fieldKey} has no contract exposure`);
    if (entry.sectionId === 'advanced-fields') {
      // Advanced editor renders every advanced-surface field of a section.
      assert.equal(
        exposure.surface,
        'advanced',
        `${entry.fieldKey} routed to advanced editor but is surface ${exposure.surface}`,
      );
      assert.equal(entry.sectionTitle, ADVANCED_FIELDS_SECTION_TITLE);
      assert.equal(
        entry.advancedGroupId,
        exposure.sectionId,
        `${entry.fieldKey} must expand its owning advanced group`,
      );
      assert.ok(
        SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS[exposure.sectionId].includes(
          entry.fieldKey,
        ),
        `advanced editor group ${exposure.sectionId} does not render ${entry.fieldKey}`,
      );
    } else {
      // Curated target: the field must be one a curated panel actually renders,
      // and the section must be that panel's home for the field's Garden section.
      assert.ok(
        CURATED_RENDERED_FIELD_KEYS.has(entry.fieldKey),
        `${entry.fieldKey} jumps to curated section ${entry.sectionId} but no curated panel renders it`,
      );
      assert.equal(
        entry.sectionId,
        GARDEN_SECTION_TO_SIMPLE_SECTION[exposure.sectionId],
        `${entry.fieldKey} curated jump target disagrees with its Garden section home`,
      );
      assert.ok(entry.advancedGroupId === undefined);
    }
  }
});

test('custom-surface fields with no on-page editor are excluded, never misrouted', () => {
  const excluded = new Set(
    Object.entries(SETTINGS_GARDEN_FIELD_EXPOSURE)
      .filter(([key, exposure]) => resolveSettingsFieldRoute(key, exposure).kind === 'excluded')
      .map(([key]) => key),
  );
  assert.deepEqual(
    [...excluded].sort(),
    [...EXPECTED_EXCLUDED_FIELD_KEYS].sort(),
    'excluded field set drifted — a new custom-surface field needs a routing decision',
  );
  for (const key of excluded) {
    const exposure =
      SETTINGS_GARDEN_FIELD_EXPOSURE[key as keyof typeof SETTINGS_GARDEN_FIELD_EXPOSURE];
    assert.equal(
      exposure.surface,
      'custom',
      `${key} was excluded but is not custom-surface`,
    );
    assert.ok(
      !CURATED_RENDERED_FIELD_KEYS.has(key),
      `${key} is excluded yet a curated panel renders it`,
    );
  }
});

test('every contract field is routed or explicitly excluded (fail closed on new fields)', () => {
  for (const [key, exposure] of Object.entries(SETTINGS_GARDEN_FIELD_EXPOSURE)) {
    const route = resolveSettingsFieldRoute(key, exposure);
    assert.ok(
      ['curated', 'advanced', 'excluded'].includes(route.kind),
      `${key} has no routing decision`,
    );
    if (route.kind === 'excluded') {
      assert.ok(
        EXPECTED_EXCLUDED_FIELD_KEYS.has(key),
        `${key} is silently excluded without an approved home`,
      );
    }
  }
});

test('curated allowlist is backed by a real binding in a curated panel', () => {
  for (const key of CURATED_RENDERED_FIELD_KEYS) {
    const bound = CURATED_PANEL_SOURCES.some((src) =>
      new RegExp(`\\b${key}\\b`).test(src),
    );
    assert.ok(
      bound,
      `${key} is allowlisted as curated-rendered but no curated panel references it`,
    );
  }
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
